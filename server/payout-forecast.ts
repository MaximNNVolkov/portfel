// Плановые выплаты по вкладам (§15) и облигациям (§14, §22) — чистый модуль без БД и сети,
// по образцу portfolio-engine.ts/recommendations.ts: на вход параметры инструмента и позиции,
// на выход список будущих выплат. Всё, что связано с записью в базу и дедупликацией,
// живёт в server/daily-tasks.ts.
//
// Упрощения расчёта допущены разделом §10 SPEC («на MVP допустима упрощённая формула»):
// проценты считаются по фактическому числу дней периода к 365 без учёта високосных лет,
// без НКД и без налога.
import type { Instrument, PayoutType, PositionRecord } from './repository.ts'

export type ForecastPayout = {
  date: string
  type: PayoutType
  amount: number
  currency: string
  description: string
}

const DAY_MS = 86_400_000
// Купонная периодичность по умолчанию: два раза в год (см. «решено автономно» в плане —
// частота купона нигде не хранится, а без какого-либо допущения купоны в принципе
// непрогнозируемы; допущение проговаривается в описании самой выплаты).
const COUPONS_PER_YEAR = 2
// Предохранитель от бесконечного цикла при заведомо некорректных датах инструмента.
const MAX_PERIODS = 600

function toTime(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

function daysBetween(from: string, to: string): number {
  return Math.round((toTime(to) - toTime(from)) / DAY_MS)
}

// Сдвиг на целое число месяцев с прижатием к последнему дню месяца: 31 января + 1 месяц
// даёт 28/29 февраля, а не 3 марта, как дал бы наивный setMonth.
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.toISOString().slice(0, 10)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// Периодичность выплаты процентов хранится свободным текстом (§15, значения задаёт форма
// ручного ввода). Не распознанное значение считается выплатой в конце срока — то есть
// единственным периодом на весь вклад, а не поводом отказаться от прогноза.
function monthsPerPeriod(frequency: string | undefined): number | null {
  if (!frequency) return null
  if (/ежемесяч/i.test(frequency)) return 1
  if (/ежекварталь/i.test(frequency)) return 3
  return null
}

// Границы процентных периодов: [дата открытия, ...промежуточные, дата окончания].
function periodBounds(start: string, end: string, months: number | null): string[] {
  const bounds = [start]
  if (months) {
    for (let index = 1; index < MAX_PERIODS; index += 1) {
      const next = addMonths(start, months * index)
      if (daysBetween(next, end) <= 0) break
      bounds.push(next)
    }
  }
  bounds.push(end)
  return bounds
}

// §15: проценты по вкладу и возврат тела вклада. Капитализация не выплачивается по периодам,
// а увеличивает базу начисления и уходит одной суммой в конце срока — поэтому оба режима
// используют одни и те же границы периодов и отличаются только моментом выплаты.
function forecastDeposit(position: PositionRecord, instrument: Instrument, today: string): ForecastPayout[] {
  const principal = position.invested
  const rate = instrument.rate ?? instrument.effectiveRate
  const start = position.openedOn
  const end = instrument.termEndDate
  if (!start || !end || !rate || rate <= 0 || principal <= 0) return []
  if (daysBetween(start, end) <= 0) return []

  const currency = instrument.currency
  const bounds = periodBounds(start, end, monthsPerPeriod(instrument.interestPayoutFrequency))
  const payouts: ForecastPayout[] = []
  let balance = principal
  let capitalized = 0

  for (let index = 1; index < bounds.length; index += 1) {
    const from = bounds[index - 1]
    const to = bounds[index]
    const interest = balance * (rate / 100) * (daysBetween(from, to) / 365)
    if (instrument.capitalization) {
      balance += interest
      capitalized += interest
    } else if (daysBetween(today, to) > 0) {
      payouts.push({
        date: to,
        type: 'INTEREST',
        amount: round2(interest),
        currency,
        description: `Проценты по вкладу «${instrument.name}»`,
      })
    }
  }

  if (instrument.capitalization && capitalized > 0 && daysBetween(today, end) > 0) {
    payouts.push({
      date: end,
      type: 'INTEREST',
      amount: round2(capitalized),
      currency,
      description: `Проценты по вкладу «${instrument.name}» с капитализацией`,
    })
  }
  if (daysBetween(today, end) > 0) {
    payouts.push({
      date: end,
      type: 'DEPOSIT_PRINCIPAL',
      amount: round2(principal),
      currency,
      description: `Возврат вклада «${instrument.name}»`,
    })
  }
  return payouts
}

// §14/§22: купоны и погашение номинала. Номинал и количество обязательны — без них сумма
// выплаты неизвестна, а подставлять вместо неё ноль запрещено (§7.3).
function forecastBond(position: PositionRecord, instrument: Instrument, today: string): ForecastPayout[] {
  const quantity = position.quantity
  const nominal = instrument.nominal
  if (!quantity || quantity <= 0 || !nominal || nominal <= 0) return []
  const currency = instrument.currency
  const payouts: ForecastPayout[] = []
  const faceValue = nominal * quantity
  // Оферта раньше погашения означает, что дальше этой даты выплаты не гарантированы —
  // прогноз обрывается на ней, а не продолжается до формального погашения.
  const horizon = [instrument.ofertaDate, instrument.maturityDate].filter(Boolean).sort()[0]

  if (instrument.couponRate && instrument.couponRate > 0 && instrument.couponDate) {
    const amount = round2((faceValue * (instrument.couponRate / 100)) / COUPONS_PER_YEAR)
    const step = 12 / COUPONS_PER_YEAR
    for (let index = 0; index < MAX_PERIODS; index += 1) {
      const date = addMonths(instrument.couponDate, step * index)
      if (horizon && daysBetween(date, horizon) < 0) break
      if (!horizon && index > 0) break
      if (daysBetween(today, date) > 0) {
        payouts.push({
          date,
          type: 'COUPON',
          amount,
          currency,
          description: `Купон «${instrument.name}» (прогноз, ${COUPONS_PER_YEAR} раза в год)`,
        })
      }
    }
  }

  if (instrument.maturityDate && daysBetween(today, instrument.maturityDate) > 0) {
    payouts.push({
      date: instrument.maturityDate,
      type: 'REDEMPTION',
      amount: round2(faceValue),
      currency,
      description: instrument.amortization
        ? `Погашение номинала «${instrument.name}» (амортизация не учтена в прогнозе)`
        : `Погашение номинала «${instrument.name}»`,
    })
  }
  return payouts
}

// Прогноз считается только для вкладов и облигаций: у акций и фондов будущие выплаты
// (дивиденды) не выводятся из параметров самого инструмента.
export function forecastPayouts(
  position: PositionRecord,
  instrument: Instrument,
  today: string,
): ForecastPayout[] {
  if (instrument.groupType === 'deposit') return forecastDeposit(position, instrument, today)
  if (instrument.groupType === 'bond') return forecastBond(position, instrument, today)
  return []
}

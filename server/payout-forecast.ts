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
  // Английские значения приходят через API и распознавание (monthly, quarterly).
  if (/ежемесяч|month/i.test(frequency)) return 1
  if (/ежекварталь|quarter/i.test(frequency)) return 3
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
//
// Прогноз строится на весь срок вклада, от даты открытия, включая уже прошедшие даты
// (Замечание 20, решение Р-1 в docs/FIX_PLAN.md): вклад с истёкшим сроком иначе молча
// терял и проценты, и возврат тела. Прошедшие выплаты приходят как «ожидается» и в
// календаре попадают в группу «Просрочено» — пользователь отмечает их полученными.
function forecastDeposit(position: PositionRecord, instrument: Instrument): ForecastPayout[] {
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
    } else {
      payouts.push({
        date: to,
        type: 'INTEREST',
        amount: round2(interest),
        currency,
        description: `Проценты по вкладу «${instrument.name}»`,
      })
    }
  }

  if (instrument.capitalization && capitalized > 0) {
    payouts.push({
      date: end,
      type: 'INTEREST',
      amount: round2(capitalized),
      currency,
      description: `Проценты по вкладу «${instrument.name}» с капитализацией`,
    })
  }
  payouts.push({
    date: end,
    type: 'DEPOSIT_PRINCIPAL',
    amount: round2(principal),
    currency,
    description: `Возврат вклада «${instrument.name}»`,
  })
  return payouts
}

// Начисленные, но ещё не выплаченные проценты по вкладу на дату (критик К2) — аналог НКД
// облигации: без них вклад под 16% весь срок показывал «доход 0» и «+0,0%». Считается по
// тем же периодам, что и прогноз выплат: проценты прошедших периодов уже ушли выплатами,
// поэтому начислено только за текущий период; при капитализации — всё накопленное с
// открытия, потому что выплачивается оно одной суммой в конце срока. После окончания
// срока начисленного нет: проценты и тело — это уже выплаты из календаря.
export function depositAccruedInterest(position: PositionRecord, instrument: Instrument, today: string): number | null {
  const principal = position.invested
  const rate = instrument.rate ?? instrument.effectiveRate
  const start = position.openedOn
  const end = instrument.termEndDate
  if (!start || !end || !rate || rate <= 0 || !(principal > 0)) return null
  if (daysBetween(start, today) <= 0 || daysBetween(today, end) <= 0) return 0
  const bounds = periodBounds(start, end, monthsPerPeriod(instrument.interestPayoutFrequency))
  let balance = principal
  let capitalized = 0
  for (let index = 1; index < bounds.length; index += 1) {
    const from = bounds[index - 1]
    const to = bounds[index]
    if (daysBetween(to, today) < 0) {
      return round2(capitalized + balance * (rate / 100) * (daysBetween(from, today) / 365))
    }
    if (instrument.capitalization) {
      const interest = balance * (rate / 100) * (daysBetween(from, to) / 365)
      balance += interest
      capitalized += interest
    }
  }
  return 0
}

// Даты купонов при двух выплатах в год. Если дата выплаты купона задана — ряд идёт
// вперёд от неё, как и раньше. Если нет (BUG-20: поле спрятано в доп. деталях и его
// почти никто не заполняет) — даты выводятся с проговорённым в описании допущением:
// решено автономно: от чего отсчитывать купоны без «Даты выплаты купона» → сначала назад
// от даты погашения, и только без неё — вперёд от даты покупки → купонный график ОФЗ
// и корпоративных выпусков привязан к погашению (последний купон приходит в день
// погашения), поэтому такой ряд почти всегда совпадает с настоящим; ряд от даты покупки
// (вариант из плана) верен лишь случайно и остаётся запасным.
type CouponSchedule = { dates: string[]; basis: 'coupon-date' | 'maturity' | 'purchase' }
function couponSchedule(position: PositionRecord, instrument: Instrument, horizon: string | undefined, today: string): CouponSchedule | null {
  const step = 12 / COUPONS_PER_YEAR
  const forward = (anchor: string, firstIndex: number) => {
    const dates: string[] = []
    for (let index = firstIndex; index < MAX_PERIODS; index += 1) {
      const date = addMonths(anchor, step * index)
      if (horizon && daysBetween(date, horizon) < 0) break
      if (!horizon && index > firstIndex) break
      dates.push(date)
    }
    return dates
  }
  if (instrument.couponDate) return { dates: forward(instrument.couponDate, 0), basis: 'coupon-date' }
  if (instrument.maturityDate) {
    // Назад от погашения, но не раньше покупки: купоны до неё получал прежний владелец.
    const floor = position.openedOn && daysBetween(position.openedOn, today) > 0 ? position.openedOn : today
    const dates: string[] = []
    for (let index = 0; index < MAX_PERIODS; index += 1) {
      const date = addMonths(instrument.maturityDate, -step * index)
      if (daysBetween(floor, date) <= 0) break
      if (!horizon || daysBetween(date, horizon) >= 0) dates.unshift(date)
    }
    return { dates, basis: 'maturity' }
  }
  if (position.openedOn) return { dates: forward(position.openedOn, 1), basis: 'purchase' }
  return null
}

const COUPON_BASIS_NOTE: Record<CouponSchedule['basis'], string> = {
  'coupon-date': '',
  maturity: ', даты отсчитаны от даты погашения — уточните дату выплаты купона',
  purchase: ', даты отсчитаны от даты покупки — уточните дату выплаты купона',
}

// Почему по облигации не посчитаны купоны — для честной пометки на карточке и в
// календаре (§7.3: ноль без объяснения запрещён). null — прогноз купонов строится
// или купонов у инструмента нет по определению (не облигация).
export function couponForecastGap(position: PositionRecord, instrument: Instrument): string | null {
  if (instrument.groupType !== 'bond') return null
  if (!instrument.couponRate || instrument.couponRate <= 0) return 'Купоны не рассчитаны: не указана ставка купона'
  if (!position.quantity || position.quantity <= 0) return 'Купоны не рассчитаны: не указано количество облигаций'
  if (!instrument.nominal || instrument.nominal <= 0) return 'Купоны не рассчитаны: не указан номинал'
  if (!instrument.couponDate && !instrument.maturityDate && !position.openedOn) {
    return 'Купоны не рассчитаны: не указана дата выплаты купона'
  }
  return null
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

  const schedule = instrument.couponRate && instrument.couponRate > 0
    ? couponSchedule(position, instrument, horizon, today)
    : null
  if (schedule) {
    const amount = round2((faceValue * (instrument.couponRate! / 100)) / COUPONS_PER_YEAR)
    for (const date of schedule.dates) {
      if (daysBetween(today, date) > 0) {
        payouts.push({
          date,
          type: 'COUPON',
          amount,
          currency,
          description: `Купон «${instrument.name}» (прогноз, ${COUPONS_PER_YEAR} раза в год${COUPON_BASIS_NOTE[schedule.basis]})`,
        })
      }
    }
  }

  // Погашение приходит и задним числом (тестировщик Т8): бумага с прошедшей датой
  // погашения иначе висела в портфеле вечно — ни строки «Просрочено», ни способа её
  // закрыть. Как у вклада (Р-1), прошедшая выплата ждёт отметки «Деньги пришли», которая
  // и закрывает позицию. Брокерские бумаги не трогаем: их погашение приносит синхронизация,
  // а бумагу, купленную уже после даты погашения, считаем ошибкой ввода, а не долгом.
  const maturityPassedButOwed = instrument.maturityDate
    && position.source !== 'broker'
    && (!position.openedOn || daysBetween(position.openedOn, instrument.maturityDate) > 0)
  if (instrument.maturityDate && (daysBetween(today, instrument.maturityDate) > 0 || maturityPassedButOwed)) {
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
  if (instrument.groupType === 'deposit') return forecastDeposit(position, instrument)
  if (instrument.groupType === 'bond') return forecastBond(position, instrument, today)
  return []
}

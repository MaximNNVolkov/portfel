// Прогноз поступлений по инструменту (§15, §22) — чистый модуль без БД, как
// payout-forecast.ts: на вход выплаты календаря (фактические и прогнозные строки),
// на выход — сколько дохода уже пришло, сколько ещё придёт, что вернётся телом и
// ближайшая выплата. Суммы в базовой валюте портфеля: пересчёт делает вызывающий
// (convert), складывать рубли с долларами здесь нельзя (§13). Считается на бэкенде
// один раз, а показывается и в карточке инструмента, и в других экранах (§10).
import type { MoneyRow, PayoutStatus, PayoutType } from './repository.ts'

export type OutlookPayout = {
  date: string
  type: PayoutType
  amount: number
  currency: string
  status: PayoutStatus
  source: string
  instrumentId?: string
  accountId: string
}

export type InstrumentOutlook = {
  /** Полученный доход: купоны, проценты, дивиденды. Возврат тела доходом не является. */
  receivedIncome: number | null
  /** Ожидаемый доход с сегодняшнего дня до конца графика. */
  expectedIncome: number | null
  /** Ожидаемый возврат вложенного: тело вклада, погашение номинала. */
  expectedPrincipal: number | null
  /** Возврат вложенного с прошедшей датой, ещё не отмеченный полученным. */
  overduePrincipal: number | null
  /** Ближайшая ожидаемая выплата: все строки одной даты одной суммой. */
  next: { date: string; types: PayoutType[]; amount: number | null; forecast: boolean } | null
  /** Дата последней ожидаемой выплаты — конец графика. */
  lastDate: string | null
  /** Число ожидаемых строк дохода — для подписи «ещё N купонов». */
  expectedCount: number
}

export const PRINCIPAL_TYPES: ReadonlySet<PayoutType> = new Set<PayoutType>(['DEPOSIT_PRINCIPAL', 'REDEMPTION'])

export function outlookKey(instrumentId: string | undefined, accountId: string): string {
  return `${instrumentId ?? ''}|${accountId}`
}

// Сумма в базовой валюте; хотя бы одна строка без курса — итог неизвестен (null, §7.3).
function total(rows: OutlookPayout[], convert: (amount: number, currency: string) => number | null): number | null {
  let sum = 0
  for (const row of rows) {
    const value = convert(row.amount, row.currency)
    if (value === null) return null
    sum += value
  }
  return Math.round(sum * 100) / 100
}

// Итоги выплат по портфелю (§7.1) — те же определения, что у прогноза по инструменту:
// доход отдельно от возврата вложенного, «ожидается» — с сегодняшнего дня. Суммы по
// валютам, пересчёт в базовую делает движок (sumInBase).
export type PayoutSums = { expected: MoneyRow[]; expectedPrincipal: MoneyRow[]; overdue: MoneyRow[]; received: MoneyRow[] }

export function payoutSums(payouts: OutlookPayout[], today: string): PayoutSums {
  const byCurrency = (rows: OutlookPayout[]): MoneyRow[] => {
    const totals = new Map<string, number>()
    for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount)
    return [...totals].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
  }
  const upcoming = payouts.filter((row) => row.status === 'expected' && row.date >= today)
  return {
    expected: byCurrency(upcoming.filter((row) => !PRINCIPAL_TYPES.has(row.type))),
    expectedPrincipal: byCurrency(upcoming.filter((row) => PRINCIPAL_TYPES.has(row.type))),
    // Дата прошла, а отметки нет: возврат вложенного или брокерская выплата до синхронизации.
    overdue: byCurrency(payouts.filter((row) => row.status === 'expected' && row.date < today)),
    received: byCurrency(payouts.filter((row) => row.status === 'received' && !PRINCIPAL_TYPES.has(row.type))),
  }
}

export function payoutOutlook(
  payouts: OutlookPayout[],
  today: string,
  convert: (amount: number, currency: string) => number | null,
): Map<string, InstrumentOutlook> {
  const groups = new Map<string, OutlookPayout[]>()
  for (const payout of payouts) {
    if (!payout.instrumentId) continue
    const key = outlookKey(payout.instrumentId, payout.accountId)
    const list = groups.get(key)
    if (list) list.push(payout)
    else groups.set(key, [payout])
  }
  const result = new Map<string, InstrumentOutlook>()
  for (const [key, rows] of groups) {
    const income = rows.filter((row) => !PRINCIPAL_TYPES.has(row.type))
    const principal = rows.filter((row) => PRINCIPAL_TYPES.has(row.type))
    const upcoming = rows.filter((row) => row.status === 'expected' && row.date >= today).sort((a, b) => a.date.localeCompare(b.date))
    const upcomingIncome = income.filter((row) => row.status === 'expected' && row.date >= today)
    const nextDate = upcoming[0]?.date
    const nextRows = nextDate ? upcoming.filter((row) => row.date === nextDate) : []
    result.set(key, {
      receivedIncome: total(income.filter((row) => row.status === 'received'), convert),
      expectedIncome: total(upcomingIncome, convert),
      expectedPrincipal: total(principal.filter((row) => row.status === 'expected' && row.date >= today), convert),
      overduePrincipal: total(principal.filter((row) => row.status === 'expected' && row.date < today), convert),
      next: nextDate
        ? {
            date: nextDate,
            types: [...new Set(nextRows.map((row) => row.type))],
            amount: total(nextRows, convert),
            forecast: nextRows.some((row) => row.source === 'forecast'),
          }
        : null,
      lastDate: upcoming.length ? upcoming[upcoming.length - 1].date : null,
      expectedCount: upcomingIncome.length,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// Суммы по периодам для календаря «Выплаты» (§22): плитки трёх ближайших месяцев и
// 12 месяцев вперёд, сетка из 12 шагов (дни, месяцы, годы). Раньше эти суммы складывал
// фронт; теперь их считает бэкенд, а клиент только показывает (§10).
// ---------------------------------------------------------------------------

export type PeriodLevel = 'day' | 'month' | 'year'
export const PERIOD_CELLS = 12

export type PeriodTotals = {
  /** Доход: купоны, проценты, дивиденды, прочие выплаты. */
  income: number
  /** Возврат вложенного: тело вклада, погашение номинала. */
  principal: number
  total: number
  count: number
  /** Валюты без курса ЦБ: их строки в суммы не вошли (§7.3, §13), count их учитывает. */
  unconverted: string[]
}

const pad = (value: number) => String(value).padStart(2, '0')
const isoDate = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`

export function periodKey(date: string, level: PeriodLevel): string {
  return level === 'day' ? date.slice(0, 10) : level === 'month' ? date.slice(0, 7) : date.slice(0, 4)
}

export function shiftPeriod(key: string, level: PeriodLevel, steps: number): string {
  if (level === 'year') return String(Number(key) + steps)
  if (level === 'month') {
    const [year, month] = key.split('-').map(Number)
    return isoDate(new Date(Date.UTC(year, month - 1 + steps, 1))).slice(0, 7)
  }
  const [year, month, day] = key.split('-').map(Number)
  return isoDate(new Date(Date.UTC(year, month - 1, day + steps)))
}

/** Первый и последний день периода — включительно. */
export function periodRange(key: string, level: PeriodLevel): { from: string; to: string } {
  if (level === 'day') return { from: key, to: key }
  if (level === 'year') return { from: `${key}-01-01`, to: `${key}-12-31` }
  const [year, month] = key.split('-').map(Number)
  return { from: `${key}-01`, to: isoDate(new Date(Date.UTC(year, month, 0))) }
}

export const PERIOD_KEY_PATTERN: Record<PeriodLevel, RegExp> = {
  day: /^\d{4}-\d{2}-\d{2}$/,
  month: /^\d{4}-\d{2}$/,
  year: /^\d{4}$/,
}

export function sumPeriod(rows: OutlookPayout[], convert: (amount: number, currency: string) => number | null): PeriodTotals {
  let income = 0
  let principal = 0
  const unconverted = new Set<string>()
  for (const row of rows) {
    const value = convert(row.amount, row.currency)
    if (value === null) { unconverted.add(row.currency); continue }
    if (PRINCIPAL_TYPES.has(row.type)) principal += value
    else income += value
  }
  const round = (value: number) => Math.round(value * 100) / 100
  return { income: round(income), principal: round(principal), total: round(income + principal), count: rows.length, unconverted: [...unconverted].sort() }
}

export type PeriodCell = {
  key: string
  from: string
  to: string
  /** Ещё ожидаются. */
  expected: PeriodTotals
  /** Уже получены (выплата с сегодняшней или будущей датой, отмеченная заранее). */
  received: PeriodTotals
  /** Всё вместе — главная цифра ячейки. */
  all: PeriodTotals
}

export type PayoutPeriods = {
  level: PeriodLevel
  /** Начало окна: не раньше текущего периода — экран про то, что ещё придёт. */
  start: string
  current: string
  /** Текущий и два следующих месяца плюс 12 месяцев с текущего — только ожидаемое. */
  summary: { key: string; from: string; to: string; totals: PeriodTotals }[]
  cells: PeriodCell[]
  window: PeriodTotals
}

// В календарь попадают выплаты с сегодняшнего дня: прошедшие на экране не показываются
// (П27), неотмеченный возврат вложенного живёт в «Требует внимания» и карточке.
export function payoutPeriods(
  payouts: OutlookPayout[],
  options: { today: string; level: PeriodLevel; start?: string },
  convert: (amount: number, currency: string) => number | null,
): PayoutPeriods {
  const { today, level } = options
  const current = periodKey(today, level)
  const start = options.start && PERIOD_KEY_PATTERN[level].test(options.start) && options.start > current ? options.start : current
  const calendar = payouts.filter((row) => row.date >= today)
  const upcoming = calendar.filter((row) => row.status === 'expected')
  const within = (rows: OutlookPayout[], from: string, to: string) => rows.filter((row) => row.date >= from && row.date <= to)

  const thisMonth = periodKey(today, 'month')
  const months = [0, 1, 2].map((offset) => shiftPeriod(thisMonth, 'month', offset))
  const yearAhead = { from: `${thisMonth}-01`, to: periodRange(shiftPeriod(thisMonth, 'month', 11), 'month').to }
  const summary = [
    ...months.map((key) => ({ key, ...periodRange(key, 'month') })),
    { key: '12m', ...yearAhead },
  ].map((period) => ({ ...period, totals: sumPeriod(within(upcoming, period.from, period.to), convert) }))

  const cells = Array.from({ length: PERIOD_CELLS }, (_, index) => {
    const key = shiftPeriod(start, level, index)
    const range = periodRange(key, level)
    const items = within(calendar, range.from, range.to)
    return {
      key,
      ...range,
      expected: sumPeriod(items.filter((row) => row.status === 'expected'), convert),
      received: sumPeriod(items.filter((row) => row.status === 'received'), convert),
      all: sumPeriod(items, convert),
    }
  })
  const windowRange = { from: cells[0].from, to: cells[cells.length - 1].to }
  return { level, start, current, summary, cells, window: sumPeriod(within(calendar, windowRange.from, windowRange.to), convert) }
}

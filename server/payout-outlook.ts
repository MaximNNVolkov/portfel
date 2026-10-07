// Прогноз поступлений по инструменту (§15, §22) — чистый модуль без БД, как
// payout-forecast.ts: на вход выплаты календаря (фактические и прогнозные строки),
// на выход — сколько дохода уже пришло, сколько ещё придёт, что вернётся телом и
// ближайшая выплата. Суммы в базовой валюте портфеля: пересчёт делает вызывающий
// (convert), складывать рубли с долларами здесь нельзя (§13). Считается на бэкенде
// один раз, а показывается и в карточке инструмента, и в других экранах (§10).
import type { PayoutStatus, PayoutType } from './repository.ts'

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

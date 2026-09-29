// Доходность за период (§23: день, месяц, год, весь период) по ежедневным снимкам
// портфеля (§21). Чистый модуль, как portfolio-engine.ts: без БД и Express.
//
// Упрощение MVP (§10: «допустима упрощённая формула простой доходности без учёта таймингов
// пополнений»): результат периода — изменение нереализованного результата (стоимость минус
// вложено) между снимками, поэтому покупки и пополнения не выдаются за рост; процент —
// к стоимости на начало периода. Выплаты за период в эту цифру не входят — это сказано
// в подписи на экране.

export type ReturnSnapshot = { date: string; value: number; invested: number | null }
export type PeriodKey = 'day' | 'month' | 'year' | 'all'
export type PeriodReturn = {
  period: PeriodKey
  /** Дата снимка, от которого считается период (самый ранний не позже начала периода). */
  from: string
  result: number
  /** null — стоимость на начало периода нулевая, процент не определён. */
  percent: number | null
}

const DAYS: Record<Exclude<PeriodKey, 'all'>, number> = { day: 1, month: 30, year: 365 }
// Насколько снимок может быть старше начала периода: снимки пишутся раз в сутки и при
// открытии портфеля, в них бывают пропуски. Старее — период не показывается, чтобы
// «за день» не оказалось на деле «за девять дней».
const TOLERANCE: Record<Exclude<PeriodKey, 'all'>, number> = { day: 3, month: 10, year: 30 }

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)
}

export function periodReturns(snapshots: ReturnSnapshot[], today: string): PeriodReturn[] {
  const usable = snapshots
    .filter((item) => item.invested !== null && Number.isFinite(item.value) && item.date <= today)
    .sort((left, right) => left.date.localeCompare(right.date))
  if (usable.length < 2) return []
  const last = usable[usable.length - 1]
  const gain = (item: ReturnSnapshot) => item.value - (item.invested ?? 0)
  const result: PeriodReturn[] = []
  for (const period of ['day', 'month', 'year', 'all'] as PeriodKey[]) {
    let base = usable[0]
    if (period !== 'all') {
      const start = shiftDays(last.date, DAYS[period])
      // Снимок на начало периода — последний не позже его начала. История короче периода
      // даёт только «за всё время»: подменять год месяцем нельзя.
      const found = [...usable].reverse().find((item) => item.date <= start)
      if (!found || found.date < shiftDays(start, TOLERANCE[period])) continue
      base = found
    }
    if (base.date === last.date) continue
    const change = gain(last) - gain(base)
    result.push({
      period,
      from: base.date,
      result: Math.round(change * 100) / 100,
      percent: base.value > 0 ? Math.round((change / base.value) * 10_000) / 100 : null,
    })
  }
  return result
}

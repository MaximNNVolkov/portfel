// Доходность за период (§23: день, месяц, год, весь период) по ежедневным снимкам
// портфеля (§21). Чистый модуль, как portfolio-engine.ts: без БД и Express.
//
// Упрощение MVP (§10: «допустима упрощённая формула простой доходности без учёта таймингов
// пополнений»): результат периода — изменение финансового результата портфеля (§10.6:
// изменение стоимости + выплаты + реализованное − комиссии − налоги) между снимками.
// Пополнения и покупки его не меняют, продажа с прибылью не превращается в «убыток»
// (критик К38: раньше считалась разница «стоимость − вложено»). Старые снимки без сохранённого результата в расчёт не берутся.
//
// Процент — к среднему капиталу периода, а не к стоимости на его начало (тестер Т34): с
// пополнениями результат зарабатывали и новые деньги, и «+9,1% с начала истории» рядом с
// «+1,4% за всё время» вводило в заблуждение. Капитал на дату снимка — стоимость минус
// заработанное с начала периода (то есть стоимость на начало плюс внесённое после);
// среднее взвешено по дням между снимками (модифицированный метод Дитца). Без пополнений
// капитал постоянен, и процент совпадает с прежним — к стоимости на начало.

export type ReturnSnapshot = { date: string; value: number; invested: number | null; result: number | null }
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

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

// Средний капитал периода: капитал снимка держится до следующего снимка.
function averageCapital(period: ReturnSnapshot[], baseResult: number): number {
  let weighted = 0
  let days = 0
  for (let index = 0; index < period.length - 1; index += 1) {
    const span = daysBetween(period[index].date, period[index + 1].date)
    weighted += (period[index].value - ((period[index].result ?? 0) - baseResult)) * span
    days += span
  }
  return days > 0 ? weighted / days : period[0].value
}

export function periodReturns(snapshots: ReturnSnapshot[], today: string): PeriodReturn[] {
  const usable = snapshots
    .filter((item) => item.result !== null && Number.isFinite(item.result) && Number.isFinite(item.value) && item.date <= today)
    .sort((left, right) => left.date.localeCompare(right.date))
  if (usable.length < 2) return []
  const last = usable[usable.length - 1]
  const gain = (item: ReturnSnapshot) => item.result ?? 0
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
    const capital = averageCapital(usable.filter((item) => item.date >= base.date), gain(base))
    result.push({
      period,
      from: base.date,
      result: Math.round(change * 100) / 100,
      percent: capital > 0 ? Math.round((change / capital) * 10_000) / 100 : null,
    })
  }
  return result
}

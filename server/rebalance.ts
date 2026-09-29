// Целевая структура и ребалансировка: пользователь задаёт желаемые доли категорий
// (вклады, облигации, акции…), а система показывает, насколько портфель от них отошёл
// и на какую сумму докупить или сократить каждую категорию, чтобы вернуться к цели.
// Модуль чистый, как portfolio-engine.ts и recommendations.ts: без БД и Express.
//
// Подсказка — арифметика «цель × стоимость портфеля − текущая стоимость категории»,
// а не совет что-то продавать: как и остальные рекомендации (§24), она информационная.

import type { Recommendation } from './recommendations.ts'

export const TARGET_GROUPS = ['Вклады', 'Облигации', 'Акции', 'Фонды', 'Деньги', 'Прочее'] as const

/** Отклонение в процентных пунктах, начиная с которого категория выносится в «Требует внимания». */
export const REBALANCE_THRESHOLD_PP = 5

export type RebalanceRow = {
  group: string
  /** Целевая доля, %. */
  target: number
  /** Текущая доля, %. */
  actual: number
  /** Текущая доля минус целевая, п. п. */
  deviation: number
  /** Сколько докупить (> 0) или на сколько категория больше цели (< 0), в базовой валюте. */
  toTarget: number
}

// Проверка ввода из настроек: только известные категории, доли от 0 до 100, в сумме 100%.
// Пустой объект снимает цель.
export function parseTargetAllocation(raw: unknown): Record<string, number> {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Целевая структура должна быть объектом «категория → доля»')
  const result: Record<string, number> = {}
  for (const [group, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(TARGET_GROUPS as readonly string[]).includes(group)) throw new Error(`Неизвестная категория «${group}»`)
    if (value === null || value === '' || value === undefined) continue
    const share = Number(value)
    if (!Number.isFinite(share) || share < 0 || share > 100) throw new Error(`Доля «${group}» должна быть от 0 до 100%`)
    if (share > 0) result[group] = Math.round(share * 100) / 100
  }
  const total = Object.values(result).reduce((sum, share) => sum + share, 0)
  if (Object.keys(result).length && Math.abs(total - 100) > 0.5) {
    throw new Error(`Сумма целевых долей — ${String(Math.round(total * 10) / 10).replace('.', ',')}%, а должна быть 100%`)
  }
  return result
}

export function buildRebalance(
  groups: { group: string; value: number }[],
  totalValue: number,
  targets: Record<string, number>,
): RebalanceRow[] {
  if (!Object.keys(targets).length || !(totalValue > 0)) return []
  const valueByGroup = new Map(groups.map((item) => [item.group, item.value]))
  const names = [...new Set([...Object.keys(targets), ...groups.filter((item) => item.value > 0).map((item) => item.group)])]
  return names
    .map((group) => {
      const value = valueByGroup.get(group) ?? 0
      const target = targets[group] ?? 0
      const actual = (value / totalValue) * 100
      return {
        group,
        target,
        actual: round2(actual),
        deviation: round2(actual - target),
        toTarget: Math.round((target / 100) * totalValue - value),
      }
    })
    .sort((left, right) => Math.abs(right.deviation) - Math.abs(left.deviation))
}

export function rebalanceRecommendations(rows: RebalanceRow[], currency = 'RUB', thresholdPp = REBALANCE_THRESHOLD_PP): Recommendation[] {
  return rows
    .filter((row) => Math.abs(row.deviation) >= thresholdPp)
    .map((row) => ({
      ruleType: 'rebalance' as const,
      text: row.toTarget > 0
        ? `«${row.group}» — ${percent(row.actual)}% портфеля при цели ${percent(row.target)}%: до цели не хватает ${money(row.toTarget, currency)}`
        : `«${row.group}» — ${percent(row.actual)}% портфеля при цели ${percent(row.target)}%: выше цели на ${money(-row.toTarget, currency)}`,
      payload: { group: row.group, target: row.target, actual: row.actual, toTarget: row.toTarget },
    }))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function percent(value: number): string {
  return String(Math.round(value * 10) / 10).replace('.', ',')
}

const CURRENCY_SIGNS: Record<string, string> = { RUB: '₽', USD: '$', CNY: '¥' }
function money(value: number, currency: string): string {
  return `${Math.round(value).toLocaleString('ru-RU')} ${CURRENCY_SIGNS[currency] ?? currency}`
}

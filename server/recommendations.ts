// Рекомендации (SPEC §24, Этап 5) — 4 базовых MVP-правила. Модуль чистый, как и
// portfolio-engine.ts: без БД, без Express, без сети — принимает уже готовые данные портфеля
// и отдаёт список текстовых уведомлений. Рекомендации являются аналитическими уведомлениями
// и не являются индивидуальной инвестиционной рекомендацией (формулировка самого SPEC §24).
//
// Правило «Валюта» (концентрация по валютам) сюда намеренно не входит — в SPEC §24 оно
// помечено [v2].
//
// решено автономно: считать рекомендации на лету при каждом запросе (по аналогии с
// /api/portfolio/summary), не персистить их в portfolio.recommendations и не реализовывать
// пока read/dismissed-статусы → обоснование: SPEC §24 требует только показать пользователю
// актуальные текстовые уведомления, персистентная история с ручным dismiss нигде в SPEC для
// MVP не описана как обязательная (в отличие от, например, подтверждения удаления в §40.7);
// таблица portfolio.recommendations уже существует в схеме и остаётся зарезервированной под
// это расширение, если оно понадобится после MVP — добавить персистентность позже не потребует
// пересмотра самой логики правил в этом файле, только новый слой поверх неё.

import type { AssetGroup } from './portfolio-engine.ts'

export type RecommendationRuleType = 'concentration' | 'maturity' | 'drawdown' | 'payout_gap'

export type Recommendation = {
  ruleType: RecommendationRuleType
  text: string
  payload: Record<string, unknown>
}

/** Всё, что правилам нужно знать про позицию — не зависит от репозитория/БД напрямую. */
export type PositionSnapshot = {
  id: string
  name: string
  group: AssetGroup
  issuer?: string
  maturityDate?: string
  /** Стоимость в базовой валюте портфеля; null — оценка недоступна (§7.3), позиция пропускается. */
  valueBase: number | null
  pnlPercent: number | null
}

export type PayoutSnapshot = {
  date: string
  amount: number
  status: 'expected' | 'received'
}

export type RecommendationRules = {
  /** §24: порог доли портфеля для инструмента/группы/эмитента. SPEC задаёт диапазон 20-25%. */
  concentrationThresholdPercent: number
  /**
   * решено автономно: чем измерять «крупную позицию» для правила погашения → долей от
   * портфеля, а не абсолютной суммой в рублях → обоснование: абсолютный порог был бы
   * бессмысленным сразу для двух разных портфелей — то, что крупно для портфеля в 50 тысяч,
   * ничтожно для портфеля в 50 миллионов. Используется половина порога концентрации: позиция,
   * которая одна не дотягивает до статуса «слишком много портфеля», но всё равно заметна.
   */
  maturityMinSharePercent: number
  maturityWithinDays: number
  /** §24: «значительное снижение» — порог в процентах от цены покупки. */
  drawdownThresholdPercent: number
  /** решено автономно: горизонт анализа календаря выплат → обоснование ниже, у DEFAULT_RULES. */
  payoutGapMonths: number
  /** решено автономно: месяц считается «просевшим», если он не набирает эту долю от среднего. */
  payoutGapMaxShareOfAverage: number
}

export const DEFAULT_RULES: RecommendationRules = {
  concentrationThresholdPercent: 25,
  maturityMinSharePercent: 12.5,
  maturityWithinDays: 30,
  drawdownThresholdPercent: 10,
  // решено автономно: 6 месяцев вперёд → обоснование: достаточно, чтобы заметить сезонный
  // разрыв (например, полугодовые купоны), но не настолько далеко, чтобы прогноз потерял
  // смысл — календарь выплат (§22) сам по себе не строит прогноз дальше известных дат.
  payoutGapMonths: 6,
  // решено автономно: месяц считается «низким», если его сумма не набирает 20% от среднего
  // месяца среди месяцев с ненулевыми выплатами → обоснование: порог должен быть заметно ниже
  // среднего, чтобы не реагировать на обычные колебания календаря купонов, но не только на
  // полный ноль — SPEC явно требует ловить и «низкие», а не только нулевые периоды.
  payoutGapMaxShareOfAverage: 0.2,
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

const MONTH_NAMES_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function formatMoney(value: number): string {
  return `${Math.round(value).toLocaleString('ru-RU')} ₽`
}

function daysWord(days: number): string {
  const mod100 = days % 100
  const mod10 = days % 10
  if (mod100 >= 11 && mod100 <= 14) return 'дней'
  if (mod10 === 1) return 'день'
  if (mod10 >= 2 && mod10 <= 4) return 'дня'
  return 'дней'
}

function monthKey(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Концентрация (§24) — доля инструмента, эмитента или группы активов в портфеле.
// ---------------------------------------------------------------------------

export function detectConcentration(
  positions: PositionSnapshot[],
  totalValue: number,
  rules: RecommendationRules = DEFAULT_RULES,
): Recommendation[] {
  if (totalValue <= 0) return []
  const results: Recommendation[] = []

  for (const position of positions) {
    if (position.valueBase === null) continue
    const share = (position.valueBase / totalValue) * 100
    if (share <= rules.concentrationThresholdPercent) continue
    results.push({
      ruleType: 'concentration',
      text: `«${position.name}» занимает ${round1(share)}% портфеля`,
      payload: { kind: 'instrument', id: position.id, name: position.name, sharePercent: round1(share) },
    })
  }

  const byIssuer = new Map<string, number>()
  for (const position of positions) {
    if (!position.issuer || position.valueBase === null) continue
    byIssuer.set(position.issuer, (byIssuer.get(position.issuer) ?? 0) + position.valueBase)
  }
  for (const [issuer, value] of byIssuer) {
    const share = (value / totalValue) * 100
    if (share <= rules.concentrationThresholdPercent) continue
    results.push({
      ruleType: 'concentration',
      text: `Эмитент «${issuer}» занимает ${round1(share)}% портфеля`,
      payload: { kind: 'issuer', issuer, sharePercent: round1(share) },
    })
  }

  const byGroup = new Map<AssetGroup, number>()
  for (const position of positions) {
    if (position.valueBase === null) continue
    byGroup.set(position.group, (byGroup.get(position.group) ?? 0) + position.valueBase)
  }
  for (const [group, value] of byGroup) {
    const share = (value / totalValue) * 100
    if (share <= rules.concentrationThresholdPercent) continue
    results.push({
      ruleType: 'concentration',
      text: `Группа «${group}» занимает ${round1(share)}% портфеля`,
      payload: { kind: 'group', group, sharePercent: round1(share) },
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Погашение (§24) — крупная позиция гасится в ближайшие N дней.
// ---------------------------------------------------------------------------

export function detectMaturity(
  positions: PositionSnapshot[],
  totalValue: number,
  rules: RecommendationRules = DEFAULT_RULES,
  today: Date = new Date(),
): Recommendation[] {
  if (totalValue <= 0) return []
  const results: Recommendation[] = []
  const todayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())

  for (const position of positions) {
    if (!position.maturityDate || position.valueBase === null) continue
    const share = (position.valueBase / totalValue) * 100
    if (share < rules.maturityMinSharePercent) continue
    const maturity = new Date(`${position.maturityDate}T00:00:00Z`)
    if (Number.isNaN(maturity.getTime())) continue
    const daysLeft = Math.round((maturity.getTime() - todayStart) / MS_PER_DAY)
    if (daysLeft < 0 || daysLeft > rules.maturityWithinDays) continue
    results.push({
      ruleType: 'maturity',
      text: `Через ${daysLeft} ${daysWord(daysLeft)} погашается «${position.name}» на ${formatMoney(position.valueBase)}`,
      payload: { id: position.id, name: position.name, daysLeft, valueBase: position.valueBase, maturityDate: position.maturityDate },
    })
  }

  return results.sort((a, b) => (a.payload.daysLeft as number) - (b.payload.daysLeft as number))
}

// ---------------------------------------------------------------------------
// Просадка (§24) — значимое снижение стоимости относительно цены покупки. Без рекомендации
// продавать — только констатация факта (явное требование SPEC §24).
// ---------------------------------------------------------------------------

export function detectDrawdown(
  positions: PositionSnapshot[],
  rules: RecommendationRules = DEFAULT_RULES,
): Recommendation[] {
  const results: Recommendation[] = []
  for (const position of positions) {
    if (position.pnlPercent === null || position.pnlPercent >= -rules.drawdownThresholdPercent) continue
    const dropPercent = round1(Math.abs(position.pnlPercent))
    results.push({
      ruleType: 'drawdown',
      text: `Стоимость «${position.name}» снизилась на ${dropPercent}% относительно цены покупки`,
      payload: { id: position.id, name: position.name, dropPercent },
    })
  }
  return results.sort((a, b) => (b.payload.dropPercent as number) - (a.payload.dropPercent as number))
}

// ---------------------------------------------------------------------------
// Выплаты (§24) — периоды с низкими/нулевыми ожидаемыми выплатами в календаре.
// ---------------------------------------------------------------------------

export function detectPayoutGaps(
  payouts: PayoutSnapshot[],
  rules: RecommendationRules = DEFAULT_RULES,
  today: Date = new Date(),
): Recommendation[] {
  const startYear = today.getUTCFullYear()
  const startMonth = today.getUTCMonth()
  const months: { key: string; label: string; total: number }[] = []
  for (let offset = 0; offset < rules.payoutGapMonths; offset += 1) {
    const monthIndex = startMonth + offset
    const year = startYear + Math.floor(monthIndex / 12)
    const normalizedMonth = ((monthIndex % 12) + 12) % 12
    months.push({ key: monthKey(year, normalizedMonth), label: `${MONTH_NAMES_GENITIVE[normalizedMonth]} ${year}`, total: 0 })
  }
  const byKey = new Map(months.map((month) => [month.key, month]))

  for (const payout of payouts) {
    if (payout.status !== 'expected') continue
    const date = new Date(`${payout.date}T00:00:00Z`)
    if (Number.isNaN(date.getTime())) continue
    const bucket = byKey.get(monthKey(date.getUTCFullYear(), date.getUTCMonth()))
    if (bucket) bucket.total += payout.amount
  }

  const nonZeroTotals = months.map((month) => month.total).filter((total) => total > 0)
  // Нечего сравнивать — без ненулевых месяцев «разрыв» не с чем контрастировать (не поднимать
  // ложную тревогу на портфеле, у которого выплат нет вовсе).
  if (nonZeroTotals.length === 0) return []

  const average = nonZeroTotals.reduce((sum, total) => sum + total, 0) / nonZeroTotals.length
  const gapMonths = months.filter((month) => month.total <= average * rules.payoutGapMaxShareOfAverage)
  if (!gapMonths.length) return []

  const label = gapMonths.map((month) => month.label).join(', ')
  const text = gapMonths.length === 1
    ? `В ${gapMonths[0].label} ожидаются низкие или нулевые выплаты (в среднем портфель приносит ${formatMoney(average)} в месяц)`
    : `Низкие или нулевые выплаты ожидаются в: ${label} (в среднем портфель приносит ${formatMoney(average)} в месяц)`

  return [{
    ruleType: 'payout_gap',
    text,
    payload: { months: gapMonths.map((month) => ({ key: month.key, total: month.total })), averageMonthly: Math.round(average) },
  }]
}

// ---------------------------------------------------------------------------
// Свод всех правил MVP (§24, Этап 5).
// ---------------------------------------------------------------------------

export function buildRecommendations(
  positions: PositionSnapshot[],
  totalValue: number,
  payouts: PayoutSnapshot[],
  rules: RecommendationRules = DEFAULT_RULES,
  today: Date = new Date(),
): Recommendation[] {
  return [
    ...detectConcentration(positions, totalValue, rules),
    ...detectMaturity(positions, totalValue, rules, today),
    ...detectDrawdown(positions, rules),
    ...detectPayoutGaps(payouts, rules, today),
  ]
}

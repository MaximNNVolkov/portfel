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

export type RecommendationRuleType = 'concentration' | 'maturity' | 'drawdown' | 'payout_gap' | 'rebalance'

export type Recommendation = {
  ruleType: RecommendationRuleType
  text: string
  payload: Record<string, unknown>
}

/** Всё, что правилам нужно знать про позицию — не зависит от репозитория/БД напрямую. */
export type PositionSnapshot = {
  id: string
  /** Одна бумага на нескольких счетах брокера — несколько позиций с общим инструментом. */
  instrumentId?: string
  name: string
  group: AssetGroup
  issuer?: string
  maturityDate?: string
  /**
   * Сколько придёт в дату погашения по календарю выплат (номинал + последний купон), в базовой
   * валюте. Без неё правило называло рыночную стоимость — третью сумму для того же погашения
   * рядом с номиналом и прогнозом (критик К6).
   */
  maturityAmount?: number
  /** Стоимость в базовой валюте портфеля; null — оценка недоступна (§7.3), позиция пропускается. */
  valueBase: number | null
  pnlPercent: number | null
}

export type PayoutSnapshot = {
  date: string
  amount: number
  status: 'expected' | 'received'
  /** Тип выплаты (§22). Возврат тела вклада и погашение номинала — не доход. */
  type?: string
}

// Возврат своих денег (тело вклада, номинал облигации) доходом не считается: иначе один
// крупный возврат задирает «средний доход в месяц», и все обычные месяцы выглядят разрывом.
const PRINCIPAL_PAYOUT_TYPES = new Set(['DEPOSIT_PRINCIPAL', 'REDEMPTION'])

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

// «в сентябре», «в ноябре» — предложный падеж для фразы «ожидаются в …».
const MONTH_NAMES_PREPOSITIONAL = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
]

// Доля для текста — с запятой, как принято в русском: «37,2%», а не «37.2%».
function percentLabel(value: number): string {
  return String(round1(value)).replace('.', ',')
}

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

  // Доля инструмента — по всем его позициям: бумага, разложенная по двум счетам, не должна
  // проскакивать под порог только потому, что на каждом счёте её меньше.
  const byInstrument = new Map<string, { position: PositionSnapshot; value: number }>()
  for (const position of positions) {
    if (position.valueBase === null) continue
    const key = position.instrumentId ?? position.id
    const entry = byInstrument.get(key)
    if (entry) entry.value += position.valueBase
    else byInstrument.set(key, { position, value: position.valueBase })
  }
  // Стоимость уже названных инструментов по эмитенту и группе: если эмитент или группа
  // крупны только из-за них, второй пункт повторяет первый (критик К8) и не выводится.
  const flaggedByIssuer = new Map<string, number>()
  const flaggedByGroup = new Map<AssetGroup, number>()
  for (const { position, value } of byInstrument.values()) {
    const share = (value / totalValue) * 100
    if (share <= rules.concentrationThresholdPercent) continue
    if (position.issuer) flaggedByIssuer.set(position.issuer, (flaggedByIssuer.get(position.issuer) ?? 0) + value)
    flaggedByGroup.set(position.group, (flaggedByGroup.get(position.group) ?? 0) + value)
    results.push({
      ruleType: 'concentration',
      text: `Инструмент «${position.name}» (группа «${position.group}») занимает ${percentLabel(share)}% портфеля`,
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
    if (explainedByInstruments(flaggedByIssuer.get(issuer), value)) continue
    results.push({
      ruleType: 'concentration',
      text: `Эмитент «${issuer}» занимает ${percentLabel(share)}% портфеля`,
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
    if (explainedByInstruments(flaggedByGroup.get(group), value)) continue
    results.push({
      ruleType: 'concentration',
      text: `Группа «${group}» занимает ${percentLabel(share)}% портфеля`,
      payload: { kind: 'group', group, sharePercent: round1(share) },
    })
  }

  return results
}

// Эмитент или группа «объяснены» инструментами, если на уже названные крупные позиции
// приходится 90% и больше их стоимости.
function explainedByInstruments(flagged: number | undefined, total: number): boolean {
  return flagged !== undefined && flagged >= total * 0.9
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
      text: position.maturityAmount
        ? `Через ${daysLeft} ${daysWord(daysLeft)} погашается «${position.name}»: придёт ${formatMoney(position.maturityAmount)}`
        : `Через ${daysLeft} ${daysWord(daysLeft)} погашается «${position.name}» на ${formatMoney(position.valueBase)}`,
      payload: { id: position.id, name: position.name, daysLeft, valueBase: position.valueBase, maturityAmount: position.maturityAmount, maturityDate: position.maturityDate },
    })
  }

  return results.sort((a, b) => (a.payload.daysLeft as number) - (b.payload.daysLeft as number))
}

// ---------------------------------------------------------------------------
// Просадка (§24) — значимое снижение стоимости относительно цены покупки. Без рекомендации
// продавать — только констатация факта (явное требование SPEC §24).
// ---------------------------------------------------------------------------

// Облигация, которая скоро погасится, вернётся по номиналу — её «просадка» к цене покупки
// не сигнал, а шум рядом с напоминанием о погашении (критик К6).
const DRAWDOWN_MATURITY_GRACE_DAYS = 180

export function detectDrawdown(
  positions: PositionSnapshot[],
  rules: RecommendationRules = DEFAULT_RULES,
  today: Date = new Date(),
): Recommendation[] {
  const results: Recommendation[] = []
  const graceEnd = new Date(today.getTime() + DRAWDOWN_MATURITY_GRACE_DAYS * MS_PER_DAY).toISOString().slice(0, 10)
  for (const position of positions) {
    if (position.pnlPercent === null || position.pnlPercent >= -rules.drawdownThresholdPercent) continue
    if (position.group === 'Облигации' && position.maturityDate && position.maturityDate <= graceEnd) continue
    const dropPercent = round1(Math.abs(position.pnlPercent))
    results.push({
      ruleType: 'drawdown',
      text: `Стоимость «${position.name}» снизилась на ${percentLabel(dropPercent)}% относительно цены покупки`,
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
    months.push({ key: monthKey(year, normalizedMonth), label: `${MONTH_NAMES_PREPOSITIONAL[normalizedMonth]} ${year}`, total: 0 })
  }
  const byKey = new Map(months.map((month) => [month.key, month]))

  for (const payout of payouts) {
    if (payout.status !== 'expected') continue
    if (payout.type && PRINCIPAL_PAYOUT_TYPES.has(payout.type)) continue
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

  const labels = gapMonths.map((month) => month.label)
  const label = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} и ${labels.at(-1)}`
  const text = `Мало выплат в ${label} — в среднем портфель приносит ${formatMoney(average)} в месяц`

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
    ...detectDrawdown(positions, rules, today),
    ...detectPayoutGaps(payouts, rules, today),
  ]
}

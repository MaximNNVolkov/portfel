// Portfolio Engine (SPEC §10) — единственное место расчётов P&L, доходности и агрегаций.
// Модуль намеренно чистый: без БД, без Express, без сети и без глобального состояния,
// чтобы одни и те же формулы использовались API, фоновыми задачами и тестами.
//
// Ключевое правило §7.3: отсутствие цены никогда не превращается в 0. Там, где оценка
// невозможна, возвращается null и выставляется явный флаг priceUnavailable с причиной.

// ---------------------------------------------------------------------------
// Группы активов (§7.2) — список расширяемый, неизвестный тип попадает в «Прочее».
// ---------------------------------------------------------------------------

export type AssetGroup = 'Вклады' | 'Облигации' | 'Акции' | 'Фонды' | 'Деньги' | 'Прочее'

export const ASSET_GROUPS: readonly AssetGroup[] = ['Вклады', 'Облигации', 'Акции', 'Фонды', 'Деньги', 'Прочее']

const GROUP_ALIASES: Record<string, AssetGroup> = {
  'вклад': 'Вклады', 'вклады': 'Вклады', 'депозит': 'Вклады', 'депозиты': 'Вклады',
  'облигация': 'Облигации', 'облигации': 'Облигации', 'офз': 'Облигации', 'bond': 'Облигации',
  'акция': 'Акции', 'акции': 'Акции', 'share': 'Акции', 'stock': 'Акции',
  'фонд': 'Фонды', 'фонды': 'Фонды', 'пиф': 'Фонды', 'етф': 'Фонды', 'etf': 'Фонды',
  'деньги': 'Деньги', 'денежные средства': 'Деньги', 'валюта': 'Деньги', 'cash': 'Деньги',
}

export function resolveAssetGroup(type: string | undefined | null): AssetGroup {
  if (!type) return 'Прочее'
  const key = type.trim().toLowerCase()
  return GROUP_ALIASES[key] ?? (ASSET_GROUPS.includes(type.trim() as AssetGroup) ? (type.trim() as AssetGroup) : 'Прочее')
}

// ---------------------------------------------------------------------------
// Валюты (§13). Курс — стоимость одной единицы валюты в базовой валюте таблицы.
// Источник на MVP — ЦБ РФ; для каждой валюты храним курс, дату и источник.
// ---------------------------------------------------------------------------

export type CurrencyRate = { rate: number; date: string; source: string }
export type RateTable = { base: string; rates: Record<string, CurrencyRate> }

export const CBR_SOURCE = 'ЦБ РФ'

/** Таблица курсов ЦБ РФ: значения — сколько рублей стоит одна единица валюты. */
export function cbrRateTable(rates: Record<string, number>, date: string): RateTable {
  const table: RateTable = { base: 'RUB', rates: {} }
  for (const [currency, rate] of Object.entries(rates)) {
    if (Number.isFinite(rate) && rate > 0) table.rates[currency.toUpperCase()] = { rate, date, source: CBR_SOURCE }
  }
  return table
}

function rateToBase(currency: string, table: RateTable): number | null {
  const code = currency.trim().toUpperCase()
  if (code === table.base.toUpperCase()) return 1
  const entry = table.rates[code]
  return entry && Number.isFinite(entry.rate) && entry.rate > 0 ? entry.rate : null
}

/**
 * Конверсия суммы между валютами по таблице курсов (§13).
 * Возвращает null, если курс неизвестен — вызывающий код обязан показать это
 * как «оценка недоступна», а не как 0 (§7.3).
 */
export function convertCurrency(amount: number | null | undefined, from: string, to: string, table?: RateTable): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null
  const source = (from || '').trim().toUpperCase()
  const target = (to || '').trim().toUpperCase()
  if (!source || !target) return null
  if (source === target) return amount
  if (!table) return null
  const fromRate = rateToBase(source, table)
  const toRate = rateToBase(target, table)
  if (fromRate === null || toRate === null) return null
  return (amount * fromRate) / toRate
}

// ---------------------------------------------------------------------------
// Оценка позиции (§9, §10.1, §14)
// ---------------------------------------------------------------------------

export type PositionInput = {
  id: string
  name?: string
  /** Тип инструмента как он хранится в продукте; маппится в группу через resolveAssetGroup. */
  type?: string
  currency: string
  /** Вложено (cost basis) в валюте инструмента. Если не задано — считается из quantity × averagePrice. */
  invested?: number | null
  /** Готовая текущая оценка позиции, если цена за единицу неизвестна (вклады, ручной ввод). */
  value?: number | null
  quantity?: number | null
  averagePrice?: number | null
  currentPrice?: number | null
  /** НКД по всей позиции целиком, в валюте инструмента (§14). Источники данных о цене за штуку нормализуют его сами. */
  accruedInterest?: number | null
}

export type PriceUnavailableReason = 'no-price' | 'no-rate'

// Группы, у которых есть биржевая котировка. Без неё сохранённая сумма (обычно цена
// покупки) — лишь приблизительная оценка, и P&L от неё не считается (§7.3, BUG-09).
// У вкладов, денег и «Прочего» котировок нет — введённая сумма и есть оценка.
const QUOTED_GROUPS: ReadonlySet<AssetGroup> = new Set(['Облигации', 'Акции', 'Фонды'])

export type PositionValuation = {
  id: string
  name: string
  group: AssetGroup
  currency: string
  quantity: number | null
  /** Вложено в валюте инструмента. */
  invested: number | null
  /** Рыночная стоимость без НКД (§14). null, если цены нет — никогда не 0 (§7.3). */
  marketValue: number | null
  accruedInterest: number | null
  /** Полная стоимость позиции: рыночная стоимость + НКД (§14). */
  fullValue: number | null
  /** Те же величины, пересчитанные в базовую валюту портфеля (§13). */
  investedBase: number | null
  valueBase: number | null
  /** Нереализованный результат (§10.1) в базовой валюте. */
  pnl: number | null
  pnlPercent: number | null
  priceUnavailable: boolean
  priceUnavailableReason: PriceUnavailableReason | null
  /** Котируемый инструмент без котировки: стоимость — введённая сумма, P&L не считается (§7.3). */
  estimated: boolean
}

export type EngineContext = { baseCurrency: string; rates?: RateTable }

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function round2(value: number | null): number | null {
  return value === null ? null : Math.round((value + Number.EPSILON) * 100) / 100
}

function round4(value: number | null): number | null {
  return value === null ? null : Math.round((value + Number.EPSILON) * 10000) / 10000
}

/**
 * Оценка одной позиции: рыночная стоимость, НКД, полная стоимость, P&L.
 * Порядок определения рыночной стоимости: quantity × currentPrice → готовое value → недоступно.
 * P&L считается от полной стоимости (рыночная + НКД), потому что НКД — уже заработанный
 * по позиции доход, который будет получен при продаже или выплате купона.
 */
export function evaluatePosition(position: PositionInput, context?: EngineContext): PositionValuation {
  const baseCurrency = context?.baseCurrency || position.currency
  const group = resolveAssetGroup(position.type)
  const quantity = finite(position.quantity)
  const currentPrice = finite(position.currentPrice)
  const averagePrice = finite(position.averagePrice)

  const invested = finite(position.invested) ?? (quantity !== null && averagePrice !== null ? quantity * averagePrice : null)

  const quoted = quantity !== null && currentPrice !== null
  const marketValue = quoted ? quantity * currentPrice : finite(position.value)
  const accruedInterest = marketValue === null ? null : finite(position.accruedInterest)
  const fullValue = marketValue === null ? null : marketValue + (accruedInterest ?? 0)

  const valueBase = convertCurrency(fullValue, position.currency, baseCurrency, context?.rates)
  const investedBase = convertCurrency(invested, position.currency, baseCurrency, context?.rates)

  // Курс не нашёлся, хотя цена известна — оценка в базовой валюте так же недоступна (§7.3).
  const priceUnavailable = valueBase === null
  const reason: PriceUnavailableReason | null = !priceUnavailable ? null : fullValue === null ? 'no-price' : 'no-rate'

  const estimated = !quoted && valueBase !== null && QUOTED_GROUPS.has(group)
  const pnl = !estimated && valueBase !== null && investedBase !== null ? valueBase - investedBase : null
  const pnlPercent = pnl !== null && investedBase !== null && investedBase > 0 ? (pnl / investedBase) * 100 : null

  return {
    id: position.id,
    name: position.name || '',
    group,
    currency: position.currency,
    quantity,
    invested: round2(invested),
    marketValue: round2(marketValue),
    accruedInterest: round2(accruedInterest),
    fullValue: round2(fullValue),
    investedBase: round2(investedBase),
    valueBase: round2(valueBase),
    pnl: round2(pnl),
    pnlPercent: round4(pnlPercent),
    priceUnavailable,
    priceUnavailableReason: reason,
    estimated,
  }
}

// ---------------------------------------------------------------------------
// Агрегация по группам (§7.2, §8)
// ---------------------------------------------------------------------------

export type GroupAggregate = {
  group: AssetGroup
  invested: number
  value: number
  pnl: number
  pnlPercent: number | null
  /** Доля группы в портфеле, % от суммарной стоимости. null, если стоимость портфеля неизвестна. */
  share: number | null
  positions: number
  /** Сколько позиций группы не удалось оценить — их суммы не входят в value (§7.3). */
  priceUnavailable: number
  /** Сколько позиций оценено приблизительно — они в value, но не в pnl (§7.3). */
  estimated: number
}

export type PortfolioAggregate = {
  baseCurrency: string
  groups: GroupAggregate[]
  invested: number
  value: number
  /** Сумма P&L позиций, у которых он известен; pnlPercent — к их же вложениям. */
  pnl: number
  pnlPercent: number | null
  /** Вложено и стоимость только по позициям с известным P&L — база для доходности (§10.6). */
  pnlInvested: number
  pnlValue: number
  positions: PositionValuation[]
  /** true, если хотя бы одну позицию не удалось оценить: итог неполный и помечается в UI (§7.3, §40.2). */
  valuationIncomplete: boolean
  unavailable: { id: string; name: string; group: AssetGroup; reason: PriceUnavailableReason }[]
}

/**
 * Агрегация позиций по группам активов. Позиции без оценки не подмешиваются в
 * суммы нулями — они считаются отдельно и поднимают флаг valuationIncomplete.
 */
export function aggregateByGroup(positions: PositionInput[], context: EngineContext): PortfolioAggregate {
  const valuations = positions.map((position) => evaluatePosition(position, context))
  const buckets = new Map<AssetGroup, GroupAggregate>()
  let totalValue = 0
  let totalInvested = 0
  const unavailable: PortfolioAggregate['unavailable'] = []
  // P&L складывается только из позиций, где он известен: позиция без цены или с
  // приблизительной оценкой не должна давать ни «−вложено», ни «+0» (§7.3).
  const pnlBase = new Map<AssetGroup, { invested: number; value: number }>()
  const totalPnlBase = { invested: 0, value: 0 }

  for (const item of valuations) {
    const bucket = buckets.get(item.group) ?? { group: item.group, invested: 0, value: 0, pnl: 0, pnlPercent: null, share: null, positions: 0, priceUnavailable: 0, estimated: 0 }
    bucket.positions += 1
    if (item.estimated) bucket.estimated += 1
    if (item.pnl !== null && item.investedBase !== null && item.valueBase !== null) {
      const base = pnlBase.get(item.group) ?? { invested: 0, value: 0 }
      base.invested += item.investedBase; base.value += item.valueBase
      pnlBase.set(item.group, base)
      totalPnlBase.invested += item.investedBase; totalPnlBase.value += item.valueBase
    }
    // Вложено известно всегда, когда есть cost basis, даже если текущей цены нет.
    if (item.investedBase !== null) { bucket.invested += item.investedBase; totalInvested += item.investedBase }
    if (item.valueBase !== null) { bucket.value += item.valueBase; totalValue += item.valueBase }
    if (item.priceUnavailable) {
      bucket.priceUnavailable += 1
      unavailable.push({ id: item.id, name: item.name, group: item.group, reason: item.priceUnavailableReason ?? 'no-price' })
    }
    buckets.set(item.group, bucket)
  }

  const groups = [...buckets.values()].map((bucket) => {
    const base = pnlBase.get(bucket.group) ?? { invested: 0, value: 0 }
    const pnl = base.value - base.invested
    return {
      ...bucket,
      invested: round2(bucket.invested) as number,
      value: round2(bucket.value) as number,
      pnl: round2(pnl) as number,
      pnlPercent: base.invested > 0 ? round4((pnl / base.invested) * 100) : null,
      share: totalValue > 0 ? round4((bucket.value / totalValue) * 100) : null,
    }
  })
  groups.sort((left, right) => right.value - left.value || ASSET_GROUPS.indexOf(left.group) - ASSET_GROUPS.indexOf(right.group))

  const pnl = totalPnlBase.value - totalPnlBase.invested
  return {
    baseCurrency: context.baseCurrency,
    groups,
    invested: round2(totalInvested) as number,
    value: round2(totalValue) as number,
    pnl: round2(pnl) as number,
    pnlPercent: totalPnlBase.invested > 0 ? round4((pnl / totalPnlBase.invested) * 100) : null,
    pnlInvested: round2(totalPnlBase.invested) as number,
    pnlValue: round2(totalPnlBase.value) as number,
    positions: valuations,
    valuationIncomplete: unavailable.length > 0,
    unavailable,
  }
}

// ---------------------------------------------------------------------------
// Произвольные разрезы структуры портфеля (§23): по валютам, брокерам, банкам,
// инструментам, эмитентам. По классам активов — уже покрыто aggregateByGroup выше.
// ---------------------------------------------------------------------------

export type KeyedValuation = { key: string; investedBase: number | null; valueBase: number | null; priceUnavailable: boolean }

export type Breakdown = {
  key: string
  invested: number
  value: number
  pnl: number
  pnlPercent: number | null
  /** Доля разреза в портфеле, % от суммарной оценённой стоимости. null, если стоимость неизвестна. */
  share: number | null
  positions: number
  priceUnavailable: number
}

/**
 * Группировка уже оценённых позиций (§10.1) по произвольному ключу (валюта, эмитент,
 * провайдер и т.п.) — та же арифметика сумм/долей, что и aggregateByGroup, но без
 * привязки к группам активов, чтобы не дублировать её для каждого нового разреза §23.
 */
export function aggregateByKey(items: KeyedValuation[]): Breakdown[] {
  const buckets = new Map<string, Breakdown>()
  let totalValue = 0
  for (const item of items) {
    const bucket = buckets.get(item.key) ?? { key: item.key, invested: 0, value: 0, pnl: 0, pnlPercent: null, share: null, positions: 0, priceUnavailable: 0 }
    bucket.positions += 1
    if (item.investedBase !== null) bucket.invested += item.investedBase
    if (item.valueBase !== null) { bucket.value += item.valueBase; totalValue += item.valueBase }
    if (item.priceUnavailable) bucket.priceUnavailable += 1
    buckets.set(item.key, bucket)
  }
  const list = [...buckets.values()].map((bucket) => {
    const pnl = bucket.value - bucket.invested
    return {
      ...bucket,
      invested: round2(bucket.invested) as number,
      value: round2(bucket.value) as number,
      pnl: round2(pnl) as number,
      pnlPercent: bucket.invested > 0 ? round4((pnl / bucket.invested) * 100) : null,
    }
  })
  for (const bucket of list) bucket.share = totalValue > 0 ? round4((bucket.value / totalValue) * 100) : null
  list.sort((left, right) => right.value - left.value)
  return list
}

// ---------------------------------------------------------------------------
// Финансовый результат и доходность (§10.6)
// ---------------------------------------------------------------------------

export type ReturnsInput = {
  /** Текущая стоимость активов в базовой валюте; null, если оценка недоступна (§7.3). */
  currentValue: number | null
  /** Вложено (cost basis) в базовой валюте. */
  invested: number | null
  /** Полученные выплаты: купоны, дивиденды, проценты по вкладам (§10.3). */
  payoutsReceived?: number
  /** Комиссии брокера и биржи (§10.4). */
  commissions?: number
  /** Налоги, если известны из источника данных (§10.5). */
  taxes?: number
}

export type Returns = {
  valueChange: number | null
  payoutsReceived: number
  commissions: number
  taxes: number
  /** изменение стоимости + выплаты − комиссии − налоги (§10.6). */
  financialResult: number | null
  /** Простая доходность к вложенной сумме, %. XIRR — v2 (§10). */
  returnPercent: number | null
  /** База расчёта доходности. */
  basis: number | null
  method: 'simple'
  /** true, если часть данных недоступна и результат неполный. */
  incomplete: boolean
}

export function calculateReturns(input: ReturnsInput): Returns {
  const invested = finite(input.invested)
  const currentValue = finite(input.currentValue)
  const payoutsReceived = finite(input.payoutsReceived) ?? 0
  const commissions = finite(input.commissions) ?? 0
  const taxes = finite(input.taxes) ?? 0

  const valueChange = currentValue !== null && invested !== null ? currentValue - invested : null
  const financialResult = valueChange !== null ? valueChange + payoutsReceived - commissions - taxes : null
  const basis = invested !== null && invested > 0 ? invested : null
  const returnPercent = financialResult !== null && basis !== null ? (financialResult / basis) * 100 : null

  return {
    valueChange: round2(valueChange),
    payoutsReceived: round2(payoutsReceived) as number,
    commissions: round2(commissions) as number,
    taxes: round2(taxes) as number,
    financialResult: round2(financialResult),
    returnPercent: round4(returnPercent),
    basis: round2(basis),
    method: 'simple',
    incomplete: financialResult === null || basis === null,
  }
}

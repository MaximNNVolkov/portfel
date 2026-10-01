// Рыночные данные (§20) — курсы валют (§13). Источник на MVP — официальный XML ЦБ РФ,
// используется только для конвертации валют (RUB/USD/CNY), не для цен ценных бумаг
// (MOEX ISS для котировок — отдельный, ещё не реализованный источник, см. план).
//
// Решено автономно (см. план, «MOEX ISS/CBR — источники рыночных данных»): ЦБ РФ выбран
// как источник курсов валют, а не курс из данных брокера, — CLAUDE.md прямо требует именно
// ЦБ РФ («Курсы валют на MVP — ЦБ РФ»), это не открытый вопрос, а уже принятое решение,
// которое до этого момента просто не было реализовано кодом (только зарезервировано типом
// RateTable в portfolio-engine.ts).
import type { Pool } from 'pg'
import { cbrRateTable, type RateTable } from './portfolio-engine.ts'
import { logError } from './logger.ts'

const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp'
// ЦБ публикует курс раз в сутки — кэш держится дольше одного запроса, чтобы не дёргать
// источник на каждый вызов /api/portfolio/summary, но короче суток, чтобы новый курс
// подхватывался в течение дня без перезапуска сервера.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
// MVP §13: только RUB (база, не нужен в таблице), USD, CNY.
const TRACKED_CURRENCIES = ['USD', 'CNY']

// После сбоя ЦБ не спрашиваем его заново на каждый запрос: иначе каждый вызов сводки
// ждал бы таймаут в 5 секунд, пока источник лежит.
const FAILURE_BACKOFF_MS = 10 * 60 * 1000

let cache: { table: RateTable; fetchedAt: number } | null = null
let lastFailureAt = 0
// §13: курс, дата и источник хранятся в portfolio.currency_rates. Хранилище подключается
// процессом (API, планировщик) при старте; без него модуль работает только с памятью.
let store: Pool | null = null

export function configureRateStore(pool: Pool) {
  store = pool
}

async function saveRates(table: RateTable) {
  if (!store) return
  for (const [currency, entry] of Object.entries(table.rates)) {
    await store.query(
      `INSERT INTO portfolio.currency_rates (currency, base_currency, rate_date, rate, source)
       VALUES ($1, $2, $3, $4, 'cbr')
       ON CONFLICT (currency, base_currency, rate_date) DO UPDATE SET rate = EXCLUDED.rate, fetched_at = NOW()`,
      [currency, table.base, entry.date, entry.rate],
    )
  }
}

/** Последний сохранённый курс по каждой валюте — запас на случай, когда ЦБ недоступен после перезапуска. */
async function loadStoredRates(): Promise<RateTable | null> {
  if (!store) return null
  const result = await store.query(
    `SELECT DISTINCT ON (currency) currency, rate, rate_date::text AS rate_date
       FROM portfolio.currency_rates WHERE base_currency = 'RUB'
      ORDER BY currency, rate_date DESC`,
  )
  if (!result.rows.length) return null
  const table: RateTable = { base: 'RUB', rates: {} }
  for (const row of result.rows) {
    const rate = Number(row.rate)
    if (Number.isFinite(rate) && rate > 0) table.rates[row.currency] = { rate, date: row.rate_date, source: 'ЦБ РФ' }
  }
  return table
}

function parseCbrXml(xml: string, date: string): RateTable {
  const rates: Record<string, number> = {}
  const valuteRegex = /<Valute[^>]*>([\s\S]*?)<\/Valute>/g
  let match: RegExpExecArray | null
  while ((match = valuteRegex.exec(xml))) {
    const block = match[1]
    const codeMatch = /<CharCode>([A-Z]{3})<\/CharCode>/.exec(block)
    const rateMatch = /<VunitRate>([\d,.]+)<\/VunitRate>/.exec(block)
    if (!codeMatch || !rateMatch) continue
    if (!TRACKED_CURRENCIES.includes(codeMatch[1])) continue
    const rate = Number(rateMatch[1].replace(',', '.'))
    if (Number.isFinite(rate) && rate > 0) rates[codeMatch[1]] = rate
  }
  return cbrRateTable(rates, date)
}

async function fetchFreshRates(): Promise<RateTable> {
  const response = await fetch(CBR_URL, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`CBR ответил ${response.status}`)
  // Ответ в windows-1251; нужные поля (CharCode, VunitRate, Date) — чистый ASCII,
  // поэтому побайтовое чтение как latin1 корректно извлекает их без полноценного
  // декодирования кириллицы (которая тут и не используется).
  const xml = Buffer.from(await response.arrayBuffer()).toString('latin1')
  const dateMatch = /Date="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml)
  const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : new Date().toISOString().slice(0, 10)
  return parseCbrXml(xml, date)
}

/**
 * Таблица курсов ЦБ РФ с кэшем в памяти процесса (§13). При недоступности источника
 * отдаёт последний успешно полученный кэш — деградация, а не падение расчёта портфеля
 * (§40.2); если кэша ещё не было вовсе, отдаёт пустую таблицу — конвертация вернёт null,
 * и позиция уйдёт в уже существующую ветку «оценка недоступна» (§7.3), как и раньше,
 * до появления этого модуля.
 */
export async function getCbrRateTable(): Promise<RateTable> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.table
  if (Date.now() - lastFailureAt >= FAILURE_BACKOFF_MS) {
    try {
      const table = await fetchFreshRates()
      cache = { table, fetchedAt: Date.now() }
      await saveRates(table).catch((error) => logError('cbr-rates.save', error))
      return table
    } catch (error) {
      lastFailureAt = Date.now()
      logError('cbr-rates', error)
    }
  }
  if (cache) return cache.table
  // Процесс только что перезапустился, а ЦБ недоступен: последний сохранённый курс лучше,
  // чем «оценка недоступна» по всем валютным позициям. Дата курса остаётся в таблице.
  const stored = await loadStoredRates().catch((error) => { logError('cbr-rates.load', error); return null })
  if (stored) {
    // Кэш из базы живёт только до конца паузы после сбоя — затем снова спрашиваем ЦБ.
    cache = { table: stored, fetchedAt: Date.now() - CACHE_TTL_MS + FAILURE_BACKOFF_MS }
    return stored
  }
  return { base: 'RUB', rates: {} }
}

// ---------------------------------------------------------------------------
// Котировки MOEX ISS (§20) — текущая цена акций, фондов и облигаций.
//
// Решено автономно (см. план, «MOEX ISS — коммерческие ограничения»): открытый вопрос
// CLAUDE.md о лицензионных условиях MOEX ISS при публичном/многопользовательском сценарии
// не блокирует MVP — SPEC §4 явно фиксирует однопользовательский режим для MVP (то же
// рассуждение уже применялось к лимитам Tinkoff Invest API, см. Пункт 5); переиспользуются
// только публичные бесплатные JSON-эндпоинты ISS, без служебных/платных продуктов вроде
// Algopack. Вопрос переоткрывается перед любым переходом к многопользовательскому v2.
//
// Облигации (BUG-19): MOEX отдаёт их цену в процентах от номинала, поэтому цена
// в валюте позиции — процент × FACEVALUE / 100 (номинал берётся с биржи, а не из карточки:
// у амортизируемых выпусков он уменьшается), а НКД на одну бумагу — ACCRUEDINT (§14).
const MOEX_PRICE_CACHE_TTL_MS = 15 * 60 * 1000
const moexQuoteCache = new Map<string, { quote: MoexQuote; fetchedAt: number }>()

type MoexBoardRef = { engine: string; market: string; boardid: string; group?: string }

// Итог запроса котировки. Причина отказа возвращается явно, чтобы пользователь видел,
// почему цена не обновилась, а не безликое «0 из 1» (BUG-19).
export type MoexQuote =
  | { status: 'ok'; price: number; accruedInterest: number | null }
  | { status: 'not_found' }
  | { status: 'no_price' }
  | { status: 'unavailable' }

async function findPrimaryBoard(secid: string): Promise<MoexBoardRef | null> {
  const url = `https://iss.moex.com/iss/securities/${encodeURIComponent(secid)}.json?iss.meta=off&iss.only=boards,description&boards.columns=secid,boardid,market,engine,is_primary&description.columns=name,value`
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`MOEX ISS (securities) ответил ${response.status}`)
  const body = await response.json() as { boards?: { columns: string[]; data: unknown[][] }; description?: { data: unknown[][] } }
  // GROUP из описания бумаги — то, что отличает пай фонда от акции на одном рынке shares.
  const group = body.description?.data?.find((row) => row[0] === 'GROUP')?.[1]
  const rows = body.boards?.data ?? []
  const columns = body.boards?.columns ?? []
  const idx = (name: string) => columns.indexOf(name)
  for (const row of rows) {
    if (row[idx('is_primary')] === 1) {
      return {
        engine: String(row[idx('engine')]), market: String(row[idx('market')]), boardid: String(row[idx('boardid')]),
        group: typeof group === 'string' ? group : undefined,
      }
    }
  }
  return null
}

function positive(value: unknown): number | null {
  const number = Number(value)
  return value !== null && Number.isFinite(number) && number > 0 ? number : null
}

type IssBlock = { columns: string[]; data: unknown[][] }
const issField = (block: IssBlock | undefined, name: string) => {
  const row = block?.data?.[0]
  const index = (block?.columns ?? []).indexOf(name)
  return row && index >= 0 ? row[index] : null
}
// «0000-00-00» у бессрочных выпусков и пустые даты — это отсутствие даты, а не дата.
const issDate = (value: unknown) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000') ? value : undefined
// SUR/RUR — так ISS называет рубль.
const issCurrency = (value: unknown) => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return !code || code === 'SUR' || code === 'RUR' ? 'RUB' : code
}

/** Группа портфеля, к которой относится бумага MOEX (§7.2). */
export type MoexSecurityGroup = 'share' | 'bond' | 'fund'
// Группы ISS: акции, депозитарные расписки, облигации, паи ПИФ и биржевые фонды.
const ISS_GROUPS: Record<string, MoexSecurityGroup> = {
  stock_shares: 'share', stock_dr: 'share', stock_foreign_shares: 'share',
  stock_bonds: 'bond', stock_eurobond: 'bond',
  stock_ppif: 'fund', stock_etf: 'fund', stock_mpif: 'fund', stock_rpif: 'fund', stock_qnv: 'fund',
}

/** Описание бумаги MOEX для автозаполнения карточки: всё, что пользователю не нужно вводить руками. */
export type MoexSecurity = {
  secid: string
  name: string
  shortName: string
  isin?: string
  group: MoexSecurityGroup
  currency: string
  /** Цена одной бумаги в валюте бумаги (у облигаций — уже в деньгах, не в % от номинала). */
  price: number | null
  /** НКД на одну облигацию. */
  accruedInterest: number | null
  nominal?: number
  couponRate?: number
  nextCouponDate?: string
  maturityDate?: string
  offerDate?: string
}

async function fetchMoexSecurity(secid: string): Promise<MoexSecurity | null> {
  const board = await findPrimaryBoard(secid)
  if (!board) return null
  const url = `https://iss.moex.com/iss/engines/${board.engine}/markets/${board.market}/boards/${board.boardid}/securities/${encodeURIComponent(secid)}.json`
    + '?iss.meta=off&iss.only=marketdata,securities'
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`MOEX ISS (marketdata) ответил ${response.status}`)
  const body = await response.json() as { marketdata?: IssBlock; securities?: IssBlock }
  const securities = body.securities
  const isBond = board.market === 'bonds'
  // Сделок сегодня может не быть (выходной, до открытия) — тогда рыночная цена,
  // а за ней цена закрытия прошлой сессии: это тоже рыночная оценка, не цена покупки.
  const quoted = positive(issField(body.marketdata, 'LAST'))
    ?? positive(issField(body.marketdata, 'MARKETPRICE'))
    ?? positive(issField(securities, 'PREVPRICE'))
  const faceValue = positive(issField(securities, 'FACEVALUE'))
  const accrued = Number(issField(securities, 'ACCRUEDINT'))
  const price = quoted === null ? null : isBond ? (faceValue === null ? null : quoted * faceValue / 100) : quoted
  const couponRate = positive(issField(securities, 'COUPONPERCENT'))
  const name = String(issField(securities, 'SECNAME') ?? '').trim()
  const shortName = String(issField(securities, 'SHORTNAME') ?? '').trim()
  const isin = String(issField(securities, 'ISIN') ?? '').trim()
  return {
    secid: String(issField(securities, 'SECID') ?? secid),
    name: name || shortName || secid,
    shortName: shortName || name || secid,
    isin: isin || undefined,
    group: (board.group ? ISS_GROUPS[board.group] : undefined) ?? (isBond ? 'bond' : 'share'),
    currency: issCurrency(isBond ? (issField(securities, 'FACEUNIT') ?? issField(securities, 'CURRENCYID')) : issField(securities, 'CURRENCYID')),
    price,
    accruedInterest: isBond && Number.isFinite(accrued) ? accrued : null,
    nominal: isBond ? faceValue ?? undefined : undefined,
    couponRate: isBond ? couponRate ?? undefined : undefined,
    nextCouponDate: isBond ? issDate(issField(securities, 'NEXTCOUPON')) : undefined,
    maturityDate: isBond ? issDate(issField(securities, 'MATDATE')) : undefined,
    offerDate: isBond ? issDate(issField(securities, 'OFFERDATE')) : undefined,
  }
}

async function fetchMoexQuote(secid: string): Promise<MoexQuote> {
  const security = await fetchMoexSecurity(secid)
  if (!security) return { status: 'not_found' }
  if (security.price === null) return { status: 'no_price' }
  return { status: 'ok', price: security.price, accruedInterest: security.accruedInterest }
}

export type MoexLookup<T> = { status: 'ok'; value: T } | { status: 'not_found' } | { status: 'unavailable' }

/**
 * Полное описание бумаги по коду MOEX (тикер или SECID облигации) для ручного ввода:
 * пользователь вводит только тикер и количество, остальное берётся отсюда (§17, §20).
 */
export async function getMoexSecurity(secid: string): Promise<MoexLookup<MoexSecurity>> {
  const key = secid.trim().toUpperCase()
  if (!key) return { status: 'not_found' }
  try {
    const security = await fetchMoexSecurity(key)
    return security ? { status: 'ok', value: security } : { status: 'not_found' }
  } catch (error) {
    logError('moex-security', error)
    return { status: 'unavailable' }
  }
}

/** Строка подсказки поиска: что найдено и в какую группу портфеля попадёт. */
export type MoexSearchItem = { secid: string; shortName: string; name: string; isin?: string; group: MoexSecurityGroup }

/**
 * Поиск бумаг MOEX по тикеру, названию или ISIN (подсказки в форме ввода). Только бумаги,
 * которые сейчас торгуются, и только акции, облигации и фонды — другие группы ISS
 * (индексы, фьючерсы, валюта) в портфель как бумага не добавляются.
 */
export async function searchMoexSecurities(query: string): Promise<MoexLookup<MoexSearchItem[]>> {
  const q = query.trim()
  if (q.length < 2) return { status: 'ok', value: [] }
  try {
    const url = `https://iss.moex.com/iss/securities.json?iss.meta=off&limit=20&q=${encodeURIComponent(q)}`
      + '&securities.columns=secid,shortname,name,isin,group,is_traded'
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`MOEX ISS (search) ответил ${response.status}`)
    const body = await response.json() as { securities?: IssBlock }
    const columns = body.securities?.columns ?? []
    const at = (row: unknown[], name: string) => row[columns.indexOf(name)]
    const items: MoexSearchItem[] = []
    for (const row of body.securities?.data ?? []) {
      const group = ISS_GROUPS[String(at(row, 'group'))]
      if (!group || Number(at(row, 'is_traded')) !== 1) continue
      const isin = String(at(row, 'isin') ?? '').trim()
      items.push({
        secid: String(at(row, 'secid')),
        shortName: String(at(row, 'shortname') ?? at(row, 'secid')),
        name: String(at(row, 'name') ?? at(row, 'shortname') ?? ''),
        isin: isin || undefined,
        group,
      })
    }
    return { status: 'ok', value: items.slice(0, 10) }
  } catch (error) {
    logError('moex-search', error)
    return { status: 'unavailable' }
  }
}

/**
 * Котировка бумаги по коду MOEX (тикер акции/фонда или SECID облигации, §20), с кэшем
 * 15 минут в памяти процесса. Сбой источника не превращается в ошибку вызывающего кода
 * (§7.3/§40.2): возвращается status 'unavailable' (или прошлая удачная котировка из кэша).
 */
export async function getMoexQuote(secid: string): Promise<MoexQuote> {
  const key = secid.trim().toUpperCase()
  if (!key) return { status: 'not_found' }
  const cached = moexQuoteCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < MOEX_PRICE_CACHE_TTL_MS) return cached.quote
  try {
    const quote = await fetchMoexQuote(key)
    moexQuoteCache.set(key, { quote, fetchedAt: Date.now() })
    return quote
  } catch (error) {
    logError('moex-price', error)
    return cached?.quote.status === 'ok' ? cached.quote : { status: 'unavailable' }
  }
}

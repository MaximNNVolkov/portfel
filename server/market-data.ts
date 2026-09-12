// Рыночные данные (§20) — курсы валют (§13). Источник на MVP — официальный XML ЦБ РФ,
// используется только для конвертации валют (RUB/USD/CNY), не для цен ценных бумаг
// (MOEX ISS для котировок — отдельный, ещё не реализованный источник, см. план).
//
// Решено автономно (см. план, «MOEX ISS/CBR — источники рыночных данных»): ЦБ РФ выбран
// как источник курсов валют, а не курс из данных брокера, — CLAUDE.md прямо требует именно
// ЦБ РФ («Курсы валют на MVP — ЦБ РФ»), это не открытый вопрос, а уже принятое решение,
// которое до этого момента просто не было реализовано кодом (только зарезервировано типом
// RateTable в portfolio-engine.ts).
import { cbrRateTable, type RateTable } from './portfolio-engine.ts'
import { logError } from './logger.ts'

const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp'
// ЦБ публикует курс раз в сутки — кэш держится дольше одного запроса, чтобы не дёргать
// источник на каждый вызов /api/portfolio/summary, но короче суток, чтобы новый курс
// подхватывался в течение дня без перезапуска сервера.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
// MVP §13: только RUB (база, не нужен в таблице), USD, CNY.
const TRACKED_CURRENCIES = ['USD', 'CNY']

let cache: { table: RateTable; fetchedAt: number } | null = null

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
  try {
    const table = await fetchFreshRates()
    cache = { table, fetchedAt: Date.now() }
    return table
  } catch (error) {
    logError('cbr-rates', error)
    return cache ? cache.table : { base: 'RUB', rates: {} }
  }
}

// ---------------------------------------------------------------------------
// Котировки MOEX ISS (§20) — только текущая цена акций/фондов по тикеру.
//
// Решено автономно (см. план, «MOEX ISS — коммерческие ограничения»): открытый вопрос
// CLAUDE.md о лицензионных условиях MOEX ISS при публичном/многопользовательском сценарии
// не блокирует MVP — SPEC §4 явно фиксирует однопользовательский режим для MVP (то же
// рассуждение уже применялось к лимитам Tinkoff Invest API, см. Пункт 5); переиспользуются
// только публичные бесплатные JSON-эндпоинты ISS, без служебных/платных продуктов вроде
// Algopack. Вопрос переоткрывается перед любым переходом к многопользовательскому v2.
//
// Решено автономно: цена — только для «Акции»/«Фонды», не для облигаций → обоснование:
// у облигаций MOEX отдаёт цену в процентах от номинала, а не в валюте позиции напрямую —
// корректный пересчёт требует отдельной, более сложной логики (номинал + НКД, §14),
// которую нецелесообразно смешивать с этим более простым и самодостаточным пунктом;
// зафиксировано как известное ограничение, а не потерянный без объяснения кейс.
const MOEX_PRICE_CACHE_TTL_MS = 15 * 60 * 1000
const moexPriceCache = new Map<string, { price: number | null; fetchedAt: number }>()

type MoexBoardRef = { engine: string; market: string; boardid: string }

async function findPrimaryBoard(ticker: string): Promise<MoexBoardRef | null> {
  const url = `https://iss.moex.com/iss/securities/${encodeURIComponent(ticker)}.json?iss.only=boards&boards.columns=secid,boardid,market,engine,is_primary`
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`MOEX ISS (securities) ответил ${response.status}`)
  const body = await response.json() as { boards?: { columns: string[]; data: unknown[][] } }
  const rows = body.boards?.data ?? []
  const columns = body.boards?.columns ?? []
  const idx = (name: string) => columns.indexOf(name)
  for (const row of rows) {
    if (row[idx('is_primary')] === 1) {
      return { engine: String(row[idx('engine')]), market: String(row[idx('market')]), boardid: String(row[idx('boardid')]) }
    }
  }
  return null
}

async function fetchMoexLastPrice(ticker: string): Promise<number | null> {
  const board = await findPrimaryBoard(ticker)
  if (!board) return null
  const url = `https://iss.moex.com/iss/engines/${board.engine}/markets/${board.market}/boards/${board.boardid}/securities/${encodeURIComponent(ticker)}.json?iss.only=marketdata&marketdata.columns=SECID,LAST,MARKETPRICE`
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`MOEX ISS (marketdata) ответил ${response.status}`)
  const body = await response.json() as { marketdata?: { columns: string[]; data: unknown[][] } }
  const columns = body.marketdata?.columns ?? []
  const row = body.marketdata?.data?.[0]
  if (!row) return null
  const idx = (name: string) => columns.indexOf(name)
  const last = Number(row[idx('LAST')])
  if (Number.isFinite(last) && last > 0) return last
  const marketPrice = Number(row[idx('MARKETPRICE')])
  return Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : null
}

/**
 * Текущая цена акции/фонда по тикеру (§20), с кэшем 15 минут в памяти процесса.
 * Возвращает null, если тикер не найден или источник недоступен — вызывающий код
 * обязан просто пропустить обновление этой позиции, а не превращать это в ошибку (§7.3/§40.2).
 */
export async function getMoexLastPrice(ticker: string): Promise<number | null> {
  const key = ticker.trim().toUpperCase()
  if (!key) return null
  const cached = moexPriceCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < MOEX_PRICE_CACHE_TTL_MS) return cached.price
  try {
    const price = await fetchMoexLastPrice(key)
    moexPriceCache.set(key, { price, fetchedAt: Date.now() })
    return price
  } catch (error) {
    logError('moex-price', error)
    return cached ? cached.price : null
  }
}

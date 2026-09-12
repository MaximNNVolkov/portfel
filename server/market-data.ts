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

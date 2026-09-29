// Импорт банковской выписки из CSV (§27, запрошено владельцем раньше v2). Чистый модуль:
// разбор файла, угадывание колонок и превращение строк в денежные операции. Запись в
// базу и поиск дубликатов — в server/index.ts.
//
// Выписки у банков разные, поэтому формат не зашит: колонки угадываются по заголовкам
// («Дата операции», «Сумма», «Описание»…), а пользователь может их поправить. Приход и
// расход бывают одной колонкой со знаком или двумя отдельными — поддержаны оба варианта.
import { createHash } from 'node:crypto'

export type StatementMapping = {
  date: number | null
  /** Одна колонка суммы со знаком: плюс — приход, минус — расход. */
  amount: number | null
  /** Или две колонки: приход и расход (обе без знака). */
  income: number | null
  expense: number | null
  description: number | null
  currency: number | null
  /** Статус операции (у Т-Банка — OK/FAILED): непроведённые не загружаются. */
  status: number | null
}
export type StatementRowType = 'DEPOSIT' | 'WITHDRAW' | 'INTEREST'
export type StatementRow = {
  /** Номер строки в файле, с 1 (заголовок — строка 1). */
  line: number
  date?: string
  amount?: number
  type?: StatementRowType
  currency: string
  description: string
  error?: string
  externalId?: string
}
export type ParsedStatement = { headers: string[]; records: string[][] }

export const SUPPORTED_CURRENCIES = ['RUB', 'USD', 'CNY']
const CURRENCY_ALIASES: Record<string, string> = {
  RUB: 'RUB', RUR: 'RUB', '₽': 'RUB', 'РУБ': 'RUB', 'РУБ.': 'RUB', 'РУБЛЬ': 'RUB',
  USD: 'USD', '$': 'USD', 'ДОЛЛ': 'USD', CNY: 'CNY', '¥': 'CNY', 'ЮАНЬ': 'CNY',
}

// Разделитель — тот из «;», «,», табуляции, что чаще встречается в заголовке вне кавычек.
function detectDelimiter(firstLine: string): string {
  const counts = [';', ',', '\t'].map((delimiter) => {
    let count = 0
    let quoted = false
    for (const char of firstLine) {
      if (char === '"') quoted = !quoted
      else if (!quoted && char === delimiter) count += 1
    }
    return { delimiter, count }
  })
  counts.sort((left, right) => right.count - left.count)
  return counts[0].count > 0 ? counts[0].delimiter : ';'
}

// CSV по RFC 4180: кавычки, удвоенные кавычки, переводы строк внутри кавычек.
export function parseCsv(text: string): ParsedStatement {
  const source = text.replace(/^﻿/, '')
  const delimiter = detectDelimiter(source.split(/\r?\n/, 1)[0] ?? '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1 }
      else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) { row.push(cell); cell = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += char
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  const nonEmpty = rows.filter((item) => item.some((value) => value.trim() !== ''))
  // Над таблицей у многих банков шапка («Выписка по счёту…», «Период…», критик К26):
  // заголовок — первая строка минимум из двух колонок, где одна из них про дату.
  const headerIndex = nonEmpty.findIndex((item) =>
    item.filter((value) => value.trim()).length >= 2 && item.some((value) => /дата|date/i.test(value)))
  const [headers = [], ...records] = headerIndex > 0 ? nonEmpty.slice(headerIndex) : nonEmpty
  return { headers: headers.map((value) => value.trim()), records }
}

function findColumn(headers: string[], patterns: RegExp[], exclude: Set<number>): number | null {
  for (const pattern of patterns) {
    const index = headers.findIndex((header, position) => !exclude.has(position) && pattern.test(header))
    if (index >= 0) return index
  }
  return null
}

export function guessMapping(headers: string[]): StatementMapping {
  const used = new Set<number>()
  const take = (index: number | null) => { if (index !== null) used.add(index); return index }
  const date = take(findColumn(headers, [/дата\s*операц/i, /дата\s*проводк/i, /^дата$/i, /дата/i, /date/i], used))
  const income = take(findColumn(headers, [/приход/i, /зачислен/i, /поступлен/i, /^кредит/i, /credit/i], used))
  const expense = take(findColumn(headers, [/расход/i, /списан/i, /^дебет/i, /debit/i], used))
  const amount = income !== null && expense !== null
    ? null
    // Сумма в валюте счёта важнее суммы в валюте покупки (критик К24): покупка за 50 USD
    // по рублёвой карте списала рубли, а не доллары.
    : take(findColumn(headers, [/сумма\s*платеж/i, /сумма\s*в\s*валюте\s*сч/i, /в\s*валюту\s*сч/i, /сумма\s*операц/i, /^сумма$/i, /сумма/i, /amount/i], used))
  const currency = take(findColumn(headers, [/валюта\s*платеж/i, /валюта\s*сч/i, /валюта\s*операц/i, /валюта/i, /currency/i], used))
  const status = take(findColumn(headers, [/статус/i, /status/i], used))
  const description = take(findColumn(headers, [/описани/i, /назначени/i, /комментар/i, /категори/i, /контрагент/i, /description/i], used))
  return {
    date,
    amount,
    income: amount === null ? income : null,
    expense: amount === null ? expense : null,
    description,
    currency,
    status,
  }
}

// «31.12.2025», «31.12.2025 14:05», «2025-12-31», «31/12/2025», «31.12.25».
export function parseStatementDate(value: string): string | null {
  const text = value.trim()
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]))
  match = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/.exec(text)
  if (match) {
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])
    return validDate(year, Number(match[2]), Number(match[1]))
  }
  return null
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

// «−1 234,56 ₽», «1 234.56», «-1234,56», «+500», «(1 000,00)» — пробелы (в т.ч. неразрывные),
// знак валюты и разделитель тысяч убираются; запятая — десятичный разделитель.
export function parseStatementAmount(value: string): number | null {
  let text = value.trim().replace(/[\s  ]/g, '').replace(/[₽$¥€]|руб\.?|RUB|USD|CNY/gi, '')
  if (!text) return null
  let negative = false
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1) }
  if (/^[-−–]/.test(text)) { negative = true; text = text.slice(1) }
  else if (text.startsWith('+')) text = text.slice(1)
  // Если есть и точка, и запятая — последний из них десятичный, другой — разделитель тысяч.
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '')
  } else text = text.replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const number = Number(text)
  return negative ? -number : number
}

// Доход — только начисление процентов на остаток или вклад. «Процент» в описании бывает
// и у кредита («возврат переплаты процентов по кредиту», критик К27) — это не доход.
const INTEREST_PATTERN = /(выплат\S*|начислен\S*|капитализац\S*)\s+(процент|%)|процент\S*\s+(на\s+остаток|по\s+(вклад|депозит|сч[её]т|накопит))|капитализац|interest/i
const NOT_INTEREST_PATTERN = /кредит|займ|ипотек|переплат|возврат|штраф|пени/i
// Непроведённые операции: отказ, отмена, холд (у Альфы — референс HOLD, критик К23, К25).
const NOT_POSTED_PATTERN = /^(failed|declined|cancel+ed|rejected|hold|отклон\S*|отмен\S*|не\s+проведен\S*|ошибка|в\s+обработке)$/i

function cellAt(record: string[], index: number | null): string {
  return index === null ? '' : (record[index] ?? '').trim()
}

export function statementRows(parsed: ParsedStatement, mapping: StatementMapping): StatementRow[] {
  const seen = new Map<string, number>()
  return parsed.records.map((record, position) => {
    const line = position + 2
    const description = cellAt(record, mapping.description)
    const currencyText = cellAt(record, mapping.currency).toUpperCase()
    const currency = currencyText ? CURRENCY_ALIASES[currencyText] ?? currencyText : 'RUB'
    const row: StatementRow = { line, currency, description }
    if (mapping.date === null) return { ...row, error: 'Не выбрана колонка с датой' }
    if (NOT_POSTED_PATTERN.test(cellAt(record, mapping.status)) || record.some((cell) => /^hold$/i.test(cell.trim()))) {
      return { ...row, error: 'Операция не проведена банком (отказ или холд)' }
    }
    const date = parseStatementDate(cellAt(record, mapping.date))
    if (!date) return { ...row, error: `Не распознана дата «${cellAt(record, mapping.date)}»` }

    let signed: number | null = null
    if (mapping.amount !== null) {
      signed = parseStatementAmount(cellAt(record, mapping.amount))
      if (signed === null) return { ...row, date, error: `Не распознана сумма «${cellAt(record, mapping.amount)}»` }
    } else if (mapping.income !== null || mapping.expense !== null) {
      const income = cellAt(record, mapping.income) ? parseStatementAmount(cellAt(record, mapping.income)) : 0
      const expense = cellAt(record, mapping.expense) ? parseStatementAmount(cellAt(record, mapping.expense)) : 0
      if (income === null || expense === null) return { ...row, date, error: 'Не распознана сумма прихода или расхода' }
      signed = Math.abs(income) - Math.abs(expense)
    } else return { ...row, date, error: 'Не выбрана колонка с суммой' }

    if (signed === 0) return { ...row, date, error: 'Нулевая сумма' }
    if (!SUPPORTED_CURRENCIES.includes(currency)) return { ...row, date, amount: Math.abs(signed), error: `Валюта «${currency}» не поддерживается` }
    const type: StatementRowType = signed < 0
      ? 'WITHDRAW'
      : INTEREST_PATTERN.test(description) && !NOT_INTEREST_PATTERN.test(description) ? 'INTEREST' : 'DEPOSIT'
    // Ключ повторной загрузки — сама строка файла, а не выбранные колонки: смена колонки
    // «Описание» не делает ту же выписку новой (критик К29). Две одинаковые строки в одном
    // файле (две покупки кофе за день) остаются двумя.
    const base = record.map((cell) => cell.trim()).join('\u0001')
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    const externalId = `import:${createHash('sha256').update(`${base}|${occurrence}`).digest('hex').slice(0, 32)}`
    return { ...row, date, amount: Math.round(Math.abs(signed) * 100) / 100, type, externalId }
  })
}

export function parseMapping(raw: unknown, headers: string[]): StatementMapping {
  const guess = guessMapping(headers)
  if (!raw || typeof raw !== 'object') return guess
  const source = raw as Record<string, unknown>
  const column = (key: keyof StatementMapping): number | null => {
    if (!(key in source)) return guess[key]
    const value = source[key]
    if (value === null || value === '' || value === undefined) return null
    const index = Number(value)
    if (!Number.isInteger(index) || index < 0 || index >= headers.length) throw new Error('Колонка выбрана неверно')
    return index
  }
  return {
    date: column('date'), amount: column('amount'), income: column('income'), expense: column('expense'),
    description: column('description'), currency: column('currency'), status: column('status'),
  }
}

// OCR-конвейер (§18) и его фоновый воркер (§34). Раньше распознавание выполнялось прямо
// внутри HTTP-запроса POST /api/ocr/upload: пользователь ждал tesseract, а §34 требует
// выполнять тяжёлые операции асинхронно и показывать статус. Теперь запрос только кладёт
// документ в очередь (portfolio.uploaded_documents, §11 UploadedDocument), а обработкой
// занимается воркер внутри server/scheduler.ts — по тому же принципу отдельного процесса,
// что и остальные фоновые задачи (см. §32 и комментарий в scheduler.ts).
//
// Разбор текста ниже — чистые функции без БД и сети, поэтому покрыты server/ocr.test.ts.
import { unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorker } from 'tesseract.js'
import { logError } from './logger.ts'
import { GROUP_LABELS, recordSnapshot, regenerateForecastPayouts } from './daily-tasks.ts'
import { createPosition, positionToWire } from './positions.ts'
import { type AssetGroup } from './portfolio-engine.ts'
import {
  claimPendingDocument, completeUploadedDocument, listPositions, withTransaction,
  type Db, type Pool, type Position, type UploadedDocument,
} from './repository.ts'

export function normalizeCurrency(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (/RUB|₽|РУБ/.test(normalized)) return 'RUB'
  if (/USD|\$/.test(normalized)) return 'USD'
  if (/EUR|€/.test(normalized)) return 'EUR'
  return 'RUB'
}
export function parseNumber(value: string): number {
  const sanitized = value.replace(/\s+/g, '').replace(/ /g, '').replace(/[^\d,.-]/g, '')
  if (!sanitized || sanitized === '-' || sanitized === '.') return 0
  const numeric = sanitized.replace(/,/g, '.')
  const result = Number(numeric)
  return Number.isFinite(result) ? result : 0
}
export function inferAssetType(text: string): AssetGroup {
  const haystack = text.toLowerCase()
  if (/(офз|облигац|bond|coupon|coupon)/.test(haystack)) return 'Облигации'
  if (/(акц|share|stock|sber|gazp|yandex|aapl|msft|nvda|tsla)/.test(haystack)) return 'Акции'
  if (/(вклад|депозит|deposit|срок)/.test(haystack)) return 'Вклады'
  if (/(фонд|etf|fund|пай|paй)/.test(haystack)) return 'Фонды'
  if (/(деньг|cash|налич|остаток)/.test(haystack)) return 'Деньги'
  return 'Прочее'
}
// BUG-12: идентификаторы инструмента внутри строки — номер выпуска ОФЗ («ОФЗ 26238»,
// «ОФЗ-ПД 26238»), ISIN («RU000A0JX0J2», «SU26238RMFS4») и номер через «№». Это часть
// названия, а не деньги: без их исключения «ОФЗ 26238» распознавалась как 26 238 ₽.
const IDENTIFIER_PATTERN = /(?:офз|ofz)(?:[\s-]*пд)?[\s-]*\d{5}|\b[A-Z]{2}[A-Z0-9]{9}\d\b|№\s*\d+/giu
export function stripIdentifiers(line: string): string {
  return line.replace(IDENTIFIER_PATTERN, ' ')
}
// Итоговые строки приложений банков/брокеров — сумма уже учтённых активов, а не актив:
// сохранённая как есть (§40.4), такая строка удваивала бы стоимость портфеля (BUG-12).
const TOTAL_LINE_PATTERN = /^[\s*•·-]*(?:итого|всего|баланс|total|сумма портфеля)(?![а-яёa-z])/iu
export function isTotalLine(line: string): boolean {
  return TOTAL_LINE_PATTERN.test(line)
}
// Есть ли в строке название, а не только количество/цена/сумма: слова из двух и более
// букв, кроме единиц и валют («шт», «руб», «RUB»…). OCR часто читает «₽» как «Р»/«P» —
// одиночные буквы названием не считаются.
const UNIT_WORDS = new Set(['шт', 'штук', 'лот', 'лотов', 'pcs', 'руб', 'rub', 'usd', 'eur', 'cny'])
export function hasNameText(line: string): boolean {
  const words = line.match(/[a-zа-яё]{2,}/giu) ?? []
  return words.some((word) => !UNIT_WORDS.has(word.toLowerCase()))
}
export function toCandidateName(raw: string): string {
  // Идентификаторы прячутся на время чистки, иначе хвостовая чистка сумм отрезала бы
  // номер выпуска от «ОФЗ 26238» вместе с суммой.
  const identifiers: string[] = []
  const masked = raw.replace(IDENTIFIER_PATTERN, (match) => `\u0000${identifiers.push(match) - 1}\u0000`)
  const cleaned = masked
    .replace(/^(название|инструмент|product|asset|сумма|стоимость|цена)\s*[:\-]*/i, '')
    .replace(/\s*(?:₽|руб|RUB|USD|EUR|%|\d[\d\s.,]*)+$/g, '')
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => identifiers[Number(index)])
    .replace(/[|•\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned.slice(0, 120) || 'Распознанный продукт'
}
// §18 дедупликация: единственные поля, которые эвристический OCR-парсер извлекает надёжно —
// название и сумма (без ISIN/тикера/даты погашения/банка) — см. Пункт 14 плана.
export function normalizeOcrName(name: string): string {
  return name.trim().toLowerCase()
}
// Числа в строке скриншота. Разряды разделяются пробелом («350 000»), поэтому просто взять
// всё подряд идущее из цифр и пробелов нельзя: в «ОФЗ 26238 120 000» это склеилось бы
// в 26 миллиардов. Группа разрядов — ровно три цифры, всё остальное считается отдельным
// числом (номер выпуска, год, количество).
const NUMBER_PATTERN = /\d{1,3}(?:[ \u00a0\u2009]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g
export function extractNumbers(block: string): number[] {
  return [...block.matchAll(NUMBER_PATTERN)].map((match) => parseNumber(match[0]))
}
// Строки скриншота → блоки «название + цифры». Приложения часто выводят название
// инструмента отдельной строкой, а количество/цену/сумму — следующей («ОФЗ 26238» /
// «120 шт · 567,30 ₽ · 68 076 ₽»): такая пара склеивается в один блок (BUG-12).
// Итоговые строки отбрасываются вовсе.
export type OcrBlock = { text: string; name?: string }
export function groupOcrLines(text: string): OcrBlock[] {
  const lines = text
    .split(/\n|\r|\|\s*\|/)
    .map((line) => line.trim())
    .filter((line) => line.length > 1)
  const blocks: OcrBlock[] = []
  let pendingName: string | null = null
  for (const line of lines) {
    if (isTotalLine(line)) { pendingName = null; continue }
    const hasAmount = /\d/.test(stripIdentifiers(line))
    if (!hasAmount) {
      // Строка без сумм — кандидат в название для следующей строки с цифрами.
      pendingName = hasNameText(line) ? line : null
      continue
    }
    if (pendingName && !hasNameText(stripIdentifiers(line))) {
      // Название — из строки-названия: в строке с цифрами его нет, а чистка хвоста
      // склеенного блока оставила бы в названии количество и цену.
      blocks.push({ text: `${pendingName} ${line}`, name: pendingName })
    } else {
      blocks.push({ text: line })
    }
    pendingName = null
  }
  return blocks
}

export function buildOcrCandidates(text: string) {
  const blocks = groupOcrLines(text).filter((block) => block.text.length > 4)

  const candidates: Array<{ name: string; type: AssetGroup; amount: number; invested: number; currency: string; deltaPercent: number; confidence: number; missingFields: string[] }> = []

  for (const { text: block, name: blockName } of blocks) {
    // Суммы ищутся в строке без идентификаторов: номер выпуска не сумма (BUG-12).
    const amountText = stripIdentifiers(block)
    const hasNumbers = /\d/.test(amountText)
    const hasMoney = /(₽|руб|RUB|USD|EUR|\$|€)/i.test(amountText) || /\d{2,}.*\d{2,}/.test(amountText)
    if (!hasNumbers || !hasMoney) continue

    const digits = extractNumbers(amountText)
    if (!digits.length) continue

    const amount = digits.filter((value) => value > 0).sort((a, b) => b - a)[0] || 0
    // Второе число строки считается «вложено» только если оно того же порядка, что и сумма.
    // В строке вида «ОФЗ 26238 120 000 ₽» меньшее число — часть названия выпуска, а не
    // сумма вложения, и подставлять его означало бы нарисовать несуществующую доходность
    // (§7.3: лучше честное «результат неизвестен», чем выдуманная цифра).
    const candidateInvested = digits.filter((value) => value > 0 && value !== amount).sort((a, b) => b - a)[0]
    const invested = candidateInvested !== undefined && candidateInvested >= amount * 0.5 ? candidateInvested : amount
    const name = toCandidateName(blockName ?? block)
    const type = inferAssetType(block)
    const currency = normalizeCurrency(block)
    const deltaPercent = amount > 0 && invested > 0 ? ((amount - invested) / invested) * 100 : 0
    const missingFields: string[] = []
    if (!name || name === 'Распознанный продукт') missingFields.push('name')
    if (!(amount > 0)) missingFields.push('amount')
    if (!(invested > 0)) missingFields.push('invested')
    if (type === 'Прочее') missingFields.push('type')

    candidates.push({
      name,
      type,
      amount,
      invested,
      currency,
      deltaPercent,
      confidence: amount > 0 ? 0.7 : 0.4,
      missingFields,
    })
  }

  const unique = candidates.filter((candidate, index, list) => {
    const sameName = list.findIndex((item) => item.name === candidate.name && item.amount === candidate.amount)
    return sameName === index
  })

  if (!unique.length) {
    // Итоговые строки не должны вернуться через запасной путь разбора всего текста.
    text = text.split(/\n|\r/).filter((line) => !isTotalLine(line.trim())).join('\n')
    const amountMatch = text.match(/(?:₽|руб(?:лей|\.)?|RUB|USD|EUR)\s*([\d\s,\.]+)/i) || text.match(/([\d\s]{3,}(?:[.,]\d{1,2})?)\s*(?:₽|руб|RUB|USD|EUR)/i)
    const amount = amountMatch ? parseNumber(amountMatch[1]) : 0
    return [{
      name: toCandidateName(text),
      type: inferAssetType(text),
      amount,
      invested: amount,
      currency: normalizeCurrency(text),
      deltaPercent: 0,
      confidence: amount > 0 ? 0.55 : 0.3,
      missingFields: amount > 0 ? ['invested'] : ['name', 'amount', 'invested'],
    }]
  }

  return unique.sort((a, b) => b.confidence - a.confidence).slice(0, 6)
}
// Результат обработки документа — то же тело, что раньше отдавал синхронный ответ
// POST /api/ocr/upload: дата, сохранённые записи и нераспознанные файлы (§40.4).
export type OcrFailure = { filename: string; reason: string }
export type OcrResult = {
  date: string
  positions: Position[]
  duplicates: boolean[]
  failures: OcrFailure[]
}

// P0-2 (§18/§37): в образе backend нет исходящего доступа к интернету, поэтому tesseract.js
// не может скачать rus.traineddata/eng.traineddata при первом запуске (как он делает по
// умолчанию). Файлы лежат в tessdata/ рядом с репозиторием (COPY tessdata ./tessdata в
// Dockerfile.backend) и читаются с диска напрямую. Путь считается от расположения этого
// файла, а не CWD/абсолютной константы — работает одинаково и в dev (server/ocr.ts →
// ../tessdata), и в образе (/app/server/ocr.ts → /app/tessdata).
const TESSDATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tessdata')

async function recognizeText(filePath: string): Promise<string> {
  // gzip: false — файлы лежат как plain .traineddata, а не .traineddata.gz (дефолт
  // tesseract.js — gzip: true, при нём загрузчик искал бы несуществующий .gz-файл).
  // cacheMethod: 'none' — каждый вызов создаёт и сразу завершает воркер (см. finally
  // ниже), поэтому кэш между вызовами не даёт выигрыша, а только пишет лишние файлы.
  const worker = await createWorker('rus+eng', undefined, {
    langPath: TESSDATA_DIR,
    gzip: false,
    cacheMethod: 'none',
  })
  try {
    const result = await worker.recognize(filePath)
    // Схлопываем только горизонтальные пробелы: переводы строк — единственная разметка,
    // по которой buildOcrCandidates отделяет один продукт от другого (§18 «несколько
    // продуктов на одном изображении»), и стирать их означает склеить весь скриншот
    // в одну запись с бессмысленной суммой.
    return result.data.text.replace(/[^\S\n]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
  } finally {
    await worker.terminate()
  }
}

// Пометка «похоже на дубль» на сводке OCR (§18, BUG-13). Сравниваются только позиции,
// существовавшие до этой обработки: строки одного скриншота друг другу не дубли. Совпасть
// должны название, группа (если OCR её определил — «Прочее» значит «не понял») и сумма —
// текущая стоимость или вложенное, смотря что пользователь видел в приложении банка.
export function isPossibleDuplicate(
  candidate: { name: string; type: AssetGroup; amount: number },
  existing: Array<Pick<Position, 'value' | 'invested'> & { instrument: Pick<Position['instrument'], 'name' | 'groupType'> }>,
): boolean {
  const key = normalizeOcrName(candidate.name)
  return existing.some((position) =>
    normalizeOcrName(position.instrument.name) === key
    && (candidate.type === 'Прочее' || GROUP_LABELS[position.instrument.groupType] === candidate.type)
    && [position.value, position.invested].some((amount) => amount !== undefined && Math.abs(amount - candidate.amount) < 0.01),
  )
}

// §40.4: распознанное сохраняется как есть, без шага подтверждения полей.
// §18 дедупликация (решено автономно: вариант А — см. план) — совпадение по названию+сумме
// не блокирует сохранение, а лишь помечается, чтобы пользователь заметил его сам
// на экране-сводке (что и так требуется читать по §40.4).
export async function processDocument(db: Pool, document: UploadedDocument): Promise<OcrResult> {
  const text = document.filePath ? await recognizeText(document.filePath) : ''
  const candidates = buildOcrCandidates(text)
  const recognized = candidates.filter((candidate) => candidate.amount > 0 && candidate.name && candidate.name !== 'Распознанный продукт')
  const date = new Date().toISOString().slice(0, 10)
  const duplicates: boolean[] = []
  const positions = recognized.length
    ? await withTransaction(db, async (client: Db) => {
        const existing = await listPositions(client, document.userId)
        const created: Position[] = []
        for (const candidate of recognized) {
          duplicates.push(isPossibleDuplicate(candidate, existing))
          const position = await createPosition(client, document.userId, {
            name: candidate.name,
            type: candidate.type,
            amount: candidate.amount,
            invested: candidate.invested > 0 ? candidate.invested : candidate.amount,
            date,
            institution: 'Проверьте источник',
            currency: candidate.currency,
          }, 'ocr')
          created.push(position)
        }
        await regenerateForecastPayouts(client, document.userId)
        await recordSnapshot(client, document.userId)
        return created
      })
    : []
  const unrecognizedCount = candidates.length - recognized.length
  const failures: OcrFailure[] = unrecognizedCount > 0
    ? [{
        filename: document.fileName,
        reason: positions.length === 0
          ? 'Не удалось распознать данные на изображении'
          : `Не удалось распознать ${unrecognizedCount} из ${candidates.length} позиций`,
      }]
    : []
  return { date, positions, duplicates, failures }
}

// Тело, которое видит фронтенд: та же форма, что раньше возвращал синхронный
// POST /api/ocr/upload ({date, items, failures}) — экран-сводка (§40.4) не переписывается
// под очередь, он просто получает этот же JSON позже, из статуса документа.
export function ocrResultToWire(result: OcrResult) {
  return {
    date: result.date,
    items: result.positions.map((position, index) => ({
      ...positionToWire(position),
      possibleDuplicate: result.duplicates[index] ?? false,
    })),
    failures: result.failures,
  }
}

// Один шаг очереди: взять ближайший ожидающий документ (SKIP LOCKED — параллельные воркеры
// не возьмут один и тот же), обработать, записать результат. Возвращает false, когда
// очередь пуста, чтобы вызывающий цикл заснул до следующего опроса.
export async function processNextDocument(db: Pool): Promise<boolean> {
  const document = await claimPendingDocument(db)
  if (!document) return false
  try {
    const result = await processDocument(db, document)
    await completeUploadedDocument(db, document.id, {
      status: 'done',
      extractedJson: ocrResultToWire(result),
      instrumentId: result.positions[0]?.instrumentId,
    })
  } catch (error) {
    // §28/§30: наружу уходит общий текст, детали остаются в логе сервера.
    logError('ocr.process', error)
    await completeUploadedDocument(db, document.id, {
      status: 'failed',
      errorMessage: 'Не удалось распознать изображение',
    }).catch((updateError) => logError('ocr.process.status', updateError))
  } finally {
    // Файл нужен только распознаванию: дальше он занимал бы место без всякой пользы,
    // а в нём — скриншот банковского приложения пользователя (§28).
    if (document.filePath) await unlink(document.filePath).catch(() => undefined)
  }
  return true
}

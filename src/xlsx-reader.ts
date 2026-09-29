// Чтение первого листа XLSX в текст с табуляцией — чтобы Excel-выписки банков (ВТБ, Альфа,
// Т-Банк отдают их наравне с CSV) шли тем же разбором и предпросмотром, что и CSV.
// Без сторонних библиотек: XLSX — это zip с XML внутри; zip разбирается по центральному
// каталогу, сжатые записи распаковываются DecompressionStream (есть в браузерах и Node 18+),
// XML читается регулярными выражениями — структура листа простая и стабильная.

type ZipEntry = { name: string; method: number; compressedSize: number; offset: number }

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) { end = index; break }
  }
  if (end < 0) throw new Error('Файл не похож на Excel (XLSX): не удалось его открыть')
  const count = view.getUint16(end + 10, true)
  let pointer = view.getUint32(end + 16, true)
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break
    const method = view.getUint16(pointer + 10, true)
    const compressedSize = view.getUint32(pointer + 20, true)
    const nameLength = view.getUint16(pointer + 28, true)
    const extraLength = view.getUint16(pointer + 30, true)
    const commentLength = view.getUint16(pointer + 32, true)
    const offset = view.getUint32(pointer + 42, true)
    const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength))
    entries.push({ name, method, compressedSize, offset })
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function readZipText(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const data = bytes.slice(start, start + entry.compressedSize)
  if (entry.method === 0) return new TextDecoder().decode(data)
  if (entry.method !== 8) throw new Error('Excel-файл сжат неизвестным способом — сохраните выписку в CSV')
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new TextDecoder().decode(await new Response(stream).arrayBuffer())
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

// Текст узла: все <t>…</t> внутри (у строки с форматированием их несколько).
function textRuns(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => unescapeXml(match[1])).join('')
}

// Встроенные форматы дат Excel (14–22, 45–47) и свои форматы с д/м/г, но не время одно.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
function dateStyles(stylesXml: string | undefined): Set<number> {
  const result = new Set<number>()
  if (!stylesXml) return result
  const custom = new Map<number, string>()
  for (const match of stylesXml.matchAll(/<numFmt\s+[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    custom.set(Number(match[1]), unescapeXml(match[2]))
  }
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? ''
  let index = 0
  for (const match of cellXfs.matchAll(/<xf\s[^>]*?(?:\/>|>)/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(match[0])?.[1] ?? 0)
    const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g, '') ?? ''
    if (BUILTIN_DATE_FORMATS.has(id) || /[dy]/i.test(code)) result.add(index)
    index += 1
  }
  return result
}

// Дата Excel — число дней от 30.12.1899.
function excelDate(serial: number): string {
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000))
  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${day}.${month}.${date.getUTCFullYear()}`
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? 'A'
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

function tsvCell(value: string): string {
  return /[\t"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export async function xlsxToText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer)
  const entries = readZipEntries(bytes)
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const read = async (name: string) => { const entry = byName.get(name); return entry ? readZipText(bytes, entry) : undefined }

  // Первый лист книги — по порядку в workbook.xml, а не по имени файла.
  const workbook = await read('xl/workbook.xml') ?? ''
  const relations = await read('xl/_rels/workbook.xml.rels') ?? ''
  const firstSheetId = /<sheet\s[^>]*r:id="([^"]+)"/.exec(workbook)?.[1]
  const target = firstSheetId
    ? new RegExp(`<Relationship\\s[^>]*Id="${firstSheetId}"[^>]*Target="([^"]+)"`).exec(relations)?.[1]
      ?? new RegExp(`<Relationship\\s[^>]*Target="([^"]+)"[^>]*Id="${firstSheetId}"`).exec(relations)?.[1]
    : undefined
  const sheetName = target
    ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
    : entries.map((entry) => entry.name).filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name)).sort()[0]
  const sheet = sheetName ? await read(sheetName) : undefined
  if (!sheet) throw new Error('В Excel-файле не найден лист с данными')

  const sharedXml = await read('xl/sharedStrings.xml') ?? ''
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1]))
  const dates = dateStyles(await read('xl/styles.xml'))

  const lines: string[] = []
  for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1]
      const body = cell[2] ?? ''
      const reference = /\br="([A-Z]+\d+)"/.exec(attributes)?.[1]
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1] ?? 'n'
      const style = Number(/\bs="(\d+)"/.exec(attributes)?.[1] ?? -1)
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let value = ''
      if (type === 's') value = raw === undefined ? '' : shared[Number(raw)] ?? ''
      else if (type === 'inlineStr') value = textRuns(body)
      else if (type === 'str' || type === 'e') value = raw === undefined ? '' : unescapeXml(raw)
      else if (type === 'b') value = raw === '1' ? 'ИСТИНА' : 'ЛОЖЬ'
      else if (raw !== undefined) value = dates.has(style) && Number.isFinite(Number(raw)) ? excelDate(Number(raw)) : raw
      const index = reference ? columnIndex(reference) : cells.length
      while (cells.length < index) cells.push('')
      cells[index] = value
    }
    lines.push(cells.map(tsvCell).join('\t'))
  }
  return lines.join('\r\n')
}

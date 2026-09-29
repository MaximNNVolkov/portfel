// Ad-hoc проверка чтения Excel-выписки. Запуск: `npx tsx server/xlsx-reader.test.ts`.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { xlsxToText } from '../src/xlsx-reader.ts'
import { guessMapping, parseCsv, statementRows } from './statement-import.ts'

let failed = 0
async function test(name: string, run: () => Promise<void>) {
  try {
    await run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(String(error instanceof Error ? error.message : error).split('\n').map((line) => `       ${line}`).join('\n'))
  }
}

const fixture = readFileSync(new URL('./fixtures/statement.xlsx', import.meta.url))
const buffer = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength)

await test('XLSX: первый лист книги, общие строки, даты Excel, числа', async () => {
  const text = await xlsxToText(buffer)
  const parsed = parseCsv(text)
  assert.deepEqual(parsed.headers, ['Дата операции', 'Сумма операции', 'Валюта', 'Описание'])
  assert.deepEqual(parsed.records[0], ['10.03.2026', '50000', 'RUB', 'Пополнение "вклада" & перевод'])
  assert.deepEqual(parsed.records[1], ['11.03.2026', '-1500.5', 'RUB', 'Снятие'])
  assert.deepEqual(parsed.records[2], ['31.03.2026', '321.45', '', 'Выплата процентов'])
})

await test('XLSX идёт тем же разбором, что и CSV', async () => {
  const parsed = parseCsv(await xlsxToText(buffer))
  const rows = statementRows(parsed, guessMapping(parsed.headers))
  assert.deepEqual(rows.map((row) => [row.type, row.amount, row.date]), [
    ['DEPOSIT', 50000, '2026-03-10'], ['WITHDRAW', 1500.5, '2026-03-11'], ['INTEREST', 321.45, '2026-03-31'],
  ])
})

await test('не XLSX — понятная ошибка', async () => {
  await assert.rejects(() => xlsxToText(new TextEncoder().encode('Дата;Сумма').buffer), /не похож на Excel/)
})

console.log(failed ? `\n${failed} тест(ов) провалено` : '\nВсе тесты прошли')
process.exit(failed ? 1 : 0)

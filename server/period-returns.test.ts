// Ad-hoc проверка доходности за период (§23). Запуск: `npx tsx server/period-returns.test.ts`.

import assert from 'node:assert/strict'
import { periodReturns } from './period-returns.ts'

let failed = 0
function test(name: string, run: () => void) {
  try {
    run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(String(error instanceof Error ? error.message : error).split('\n').map((line) => `       ${line}`).join('\n'))
  }
}

test('меньше двух снимков — доходности за период нет', () => {
  assert.deepEqual(periodReturns([{ date: '2026-09-01', value: 100, invested: 100, result: 0 }], '2026-09-29'), [])
})

test('результат периода — изменение финансового результата между снимками', () => {
  const rows = periodReturns([
    { date: '2026-08-28', value: 1000, invested: 1000, result: 0 },
    { date: '2026-09-28', value: 1100, invested: 1000, result: 100 },
    { date: '2026-09-29', value: 2150, invested: 2000, result: 150 },
  ], '2026-09-29')
  const day = rows.find((row) => row.period === 'day')!
  assert.equal(day.from, '2026-09-28')
  assert.equal(day.result, 50)
  assert.equal(day.percent, 4.55)
  const month = rows.find((row) => row.period === 'month')!
  assert.equal(month.from, '2026-08-28')
  assert.equal(month.result, 150)
  assert.equal(month.percent, 15)
})

test('период длиннее истории или без снимка рядом с его началом не показывается', () => {
  const rows = periodReturns([
    { date: '2026-09-20', value: 1000, invested: 1000, result: 0 },
    { date: '2026-09-29', value: 1010, invested: 1000, result: 10 },
  ], '2026-09-29')
  // Снимок девятидневной давности — не «за день», а месяца и года истории ещё нет.
  assert.deepEqual(rows.map((row) => row.period), ['all'])
})

test('нулевая стоимость на начало — процент не определён, а не бесконечность', () => {
  const rows = periodReturns([
    { date: '2026-09-01', value: 0, invested: 0, result: 0 },
    { date: '2026-09-29', value: 500, invested: 400, result: 100 },
  ], '2026-09-29')
  assert.equal(rows[0].percent, null)
  assert.equal(rows[0].result, 100)
})

test('продажа с прибылью не выглядит убытком: результат не меняется, если стоимость та же (К38)', () => {
  const rows = periodReturns([
    { date: '2026-09-28', value: 350_000, invested: 300_000, result: 50_000 },
    // Бумага продана: деньги стали «вложено = остаток», а результат остался прежним.
    { date: '2026-09-29', value: 350_000, invested: 350_000, result: 50_000 },
  ], '2026-09-29')
  assert.equal(rows.find((row) => row.period === 'day')!.result, 0)
})

test('снимки без сохранённого результата не участвуют', () => {
  assert.deepEqual(periodReturns([
    { date: '2026-09-28', value: 100, invested: 100, result: null },
    { date: '2026-09-29', value: 110, invested: 100, result: 10 },
  ], '2026-09-29'), [])
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

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
  assert.deepEqual(periodReturns([{ date: '2026-09-01', value: 100, invested: 100 }], '2026-09-29'), [])
})

test('покупка не выдаётся за рост: считается изменение «стоимость − вложено»', () => {
  const rows = periodReturns([
    { date: '2026-08-28', value: 1000, invested: 1000 },
    { date: '2026-09-28', value: 1100, invested: 1000 },
    { date: '2026-09-29', value: 2150, invested: 2000 },
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
    { date: '2026-09-20', value: 1000, invested: 1000 },
    { date: '2026-09-29', value: 1010, invested: 1000 },
  ], '2026-09-29')
  // Снимок девятидневной давности — не «за день», а месяца и года истории ещё нет.
  assert.deepEqual(rows.map((row) => row.period), ['all'])
})

test('нулевая стоимость на начало — процент не определён, а не бесконечность', () => {
  const rows = periodReturns([
    { date: '2026-09-01', value: 0, invested: 0 },
    { date: '2026-09-29', value: 500, invested: 400 },
  ], '2026-09-29')
  assert.equal(rows[0].percent, null)
  assert.equal(rows[0].result, 100)
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

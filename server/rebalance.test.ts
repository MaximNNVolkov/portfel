// Целевая структура и ребалансировка — тот же ad-hoc паттерн, что и остальные *.test.ts.
import assert from 'node:assert/strict'
import { buildRebalance, parseTargetAllocation, rebalanceRecommendations } from './rebalance.ts'

let failed = 0
function test(name: string, run: () => void) {
  try {
    run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\nЦелевая структура')

test('доли по известным категориям в сумме 100% принимаются, нули отбрасываются', () => {
  assert.deepEqual(parseTargetAllocation({ Облигации: 50, Акции: '30', Вклады: 20, Фонды: 0, Прочее: '' }), { Облигации: 50, Акции: 30, Вклады: 20 })
})

test('пустой объект снимает цель', () => {
  assert.deepEqual(parseTargetAllocation({}), {})
  assert.deepEqual(parseTargetAllocation(null), {})
})

test('сумма не 100% — понятная ошибка', () => {
  assert.throws(() => parseTargetAllocation({ Облигации: 50, Акции: 30 }), /Сумма целевых долей — 80%/)
})

test('неизвестная категория и доля вне 0-100 отклоняются', () => {
  assert.throws(() => parseTargetAllocation({ Крипта: 100 }), /Неизвестная категория/)
  assert.throws(() => parseTargetAllocation({ Акции: 120 }), /от 0 до 100/)
  assert.throws(() => parseTargetAllocation([50, 50]), /объектом/)
})

console.log('\nРебалансировка')

test('отклонение и сумма до цели по каждой категории', () => {
  const rows = buildRebalance(
    [{ group: 'Облигации', value: 300000 }, { group: 'Акции', value: 500000 }, { group: 'Деньги', value: 200000 }],
    1000000,
    { Облигации: 50, Акции: 40, Деньги: 10 },
  )
  const byGroup = Object.fromEntries(rows.map((row) => [row.group, row]))
  assert.equal(byGroup['Облигации'].deviation, -20)
  assert.equal(byGroup['Облигации'].toTarget, 200000)
  assert.equal(byGroup['Акции'].toTarget, -100000)
  assert.equal(byGroup['Деньги'].toTarget, -100000)
  // Самое большое отклонение — первым.
  assert.equal(rows[0].group, 'Облигации')
})

test('категория в портфеле без цели — цель 0%, вся сумма «выше цели»', () => {
  const rows = buildRebalance([{ group: 'Прочее', value: 100000 }, { group: 'Акции', value: 100000 }], 200000, { Акции: 100 })
  const other = rows.find((row) => row.group === 'Прочее')!
  assert.equal(other.target, 0)
  assert.equal(other.toTarget, -100000)
})

test('без цели или пустого портфеля — строк нет', () => {
  assert.deepEqual(buildRebalance([{ group: 'Акции', value: 1 }], 1, {}), [])
  assert.deepEqual(buildRebalance([], 0, { Акции: 100 }), [])
})

test('подсказки только при отклонении от 5 п. п., с запятой и знаком валюты', () => {
  const rows = buildRebalance(
    [{ group: 'Облигации', value: 425000 }, { group: 'Акции', value: 575000 }],
    1000000,
    { Облигации: 45.5, Акции: 54.5 },
  )
  assert.deepEqual(rebalanceRecommendations(rows), [])
  const far = buildRebalance([{ group: 'Облигации', value: 300000 }, { group: 'Акции', value: 700000 }], 1000000, { Облигации: 50, Акции: 50 })
  const texts = rebalanceRecommendations(far).map((item) => item.text)
  assert.equal(texts.length, 2)
  assert.ok(texts.some((text) => /«Облигации» — 30% портфеля при цели 50%: до цели не хватает 200\s000 ₽/.test(text)), texts.join('\n'))
  assert.ok(rebalanceRecommendations(far, 'USD').some((item) => item.text.endsWith('$')))
})

console.log(failed ? `\n${failed} тест(ов) не прошли` : '\nВсе тесты прошли')
if (failed) process.exit(1)

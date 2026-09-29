// Ad-hoc проверка ленты «Требует внимания» (docs/CLIENT_FLOW_PLAN.md §4.4). Тот же паттерн,
// что и recommendations.test.ts: без фреймворка — `npx tsx server/attention.test.ts`.

import assert from 'node:assert/strict'
import { buildAttention, type AttentionPayout, type AttentionPosition } from './attention.ts'

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

const today = '2026-09-29'
function position(overrides: Partial<AttentionPosition> & Pick<AttentionPosition, 'id' | 'name'>): AttentionPosition {
  return { institution: 'ВТБ', isCash: false, priceUnavailable: false, source: 'manual', ...overrides }
}
function payout(overrides: Partial<AttentionPayout> & Pick<AttentionPayout, 'id' | 'date'>): AttentionPayout {
  return { title: 'Выплата', type: 'COUPON', amount: 1000, currency: 'RUB', status: 'expected', ...overrides }
}
function build(positions: AttentionPosition[], payouts: AttentionPayout[] = []) {
  return buildAttention({ today, positions, payouts, brokers: [], recommendations: [] })
}

console.log('\nВыплаты')

test('просроченная выплата — срочно, с действием «отметить»', () => {
  const items = build([position({ id: 'p1', instrumentId: 'i1', name: 'ОФЗ 26238' })], [payout({ id: 'x', instrumentId: 'i1', date: '2026-09-20' })])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'payout_overdue')
  assert.equal(items[0].severity, 1)
  assert.equal(items[0].action, 'mark_received')
  assert.equal(items[0].title, 'ОФЗ 26238')
  assert.equal(items[0].institution, 'ВТБ')
  assert.deepEqual(items[0].payoutIds, ['x'])
})

test('выплата в горизонте 14 дней попадает, за горизонтом — нет', () => {
  const items = build([], [payout({ id: 'a', date: '2026-10-05' }), payout({ id: 'b', date: '2026-10-20' })])
  assert.deepEqual(items.map((item) => item.payoutIds), [['a']])
  assert.equal(items[0].kind, 'payout_soon')
})

test('купон и погашение в один день — одно событие суммой, важнее купона', () => {
  const items = build(
    [position({ id: 'p1', instrumentId: 'i1', name: 'Газпром БО', maturityDate: '2026-10-05' })],
    [
      payout({ id: 'c', instrumentId: 'i1', date: '2026-10-05', amount: 500 }),
      payout({ id: 'r', instrumentId: 'i1', date: '2026-10-05', type: 'REDEMPTION', amount: 100000 }),
    ],
  )
  // Погашение уже есть выплатой — отдельного сигнала «погашение скоро» нет.
  assert.equal(items.length, 1)
  assert.equal(items[0].amount, 100500)
  assert.equal(items[0].severity, 2)
  assert.match(items[0].text, /вернётся/)
})

test('недавно полученная выплата — напоминание реинвестировать', () => {
  const items = build([], [
    payout({ id: 'new', date: '2026-09-25', status: 'received' }),
    payout({ id: 'old', date: '2026-09-01', status: 'received' }),
  ])
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'payout_received')
  assert.equal(items[0].action, 'reinvest')
})

console.log('\nПозиции')

test('вклад заканчивается в пределах 30 дней', () => {
  const items = build([
    position({ id: 'd', name: 'Вклад «Надёжный»', termEndDate: '2026-10-20' }),
    position({ id: 'far', name: 'Дальний', termEndDate: '2027-01-01' }),
    position({ id: 'closed', name: 'Закрытый', termEndDate: '2026-10-01', closedOn: '2026-09-10' }),
  ])
  assert.deepEqual(items.map((item) => item.positionId), ['d'])
  assert.match(items[0].text, /Вклад заканчивается через 21 день/)
})

test('нет цены и нет данных для прогноза — к сведению', () => {
  const items = build([position({ id: 's', name: 'Акция', priceUnavailable: true, forecastNote: 'Не указана ставка купона' })])
  assert.deepEqual(items.map((item) => item.kind).sort(), ['forecast_missing', 'price_unavailable'])
  assert.ok(items.every((item) => item.severity === 3))
})

test('денежный остаток не даёт сигналов', () => {
  assert.equal(build([position({ id: 'cash', name: 'Деньги', isCash: true, priceUnavailable: true })]).length, 0)
})

console.log('\nПорядок и прочее')

test('сортировка: срочность, затем дата', () => {
  const items = buildAttention({
    today,
    positions: [],
    payouts: [
      payout({ id: 'soon2', date: '2026-10-10' }),
      payout({ id: 'soon1', date: '2026-10-01' }),
      payout({ id: 'overdue', date: '2026-09-28' }),
    ],
    brokers: [{ name: 'Т-Инвестиции', status: 'error', lastSyncAt: '2026-09-26T10:00:00Z' }],
    recommendations: [],
  })
  assert.deepEqual(items.map((item) => item.id.split(':')[0]), ['overdue', 'broker', 'soon', 'soon'])
  assert.deepEqual(items.slice(2).map((item) => item.date), ['2026-10-01', '2026-10-10'])
})

test('рекомендация о погашении не дублируется, остальные — как «к сведению»', () => {
  const items = buildAttention({
    today,
    positions: [position({ id: 'p1', name: 'ОФЗ' })],
    payouts: [],
    brokers: [],
    recommendations: [
      { ruleType: 'maturity', text: 'Погашается', payload: { id: 'p1' } },
      { ruleType: 'drawdown', text: 'Снизилась на 12%', payload: { id: 'p1' } },
      { ruleType: 'concentration', text: 'Облигации 60%', payload: { kind: 'group' } },
    ],
  })
  assert.deepEqual(items.map((item) => item.action), ['open_position', 'open_analytics'])
  assert.equal(items[0].title, 'ОФЗ')
})

if (failed > 0) {
  console.log(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log('\nall passed')

// Ad-hoc проверка правил рекомендаций (SPEC §24). Тот же паттерн, что и
// portfolio-engine.test.ts: без фреймворка, запускается напрямую —
// `npx tsx server/recommendations.test.ts`. Ненулевой код возврата = провал.

import assert from 'node:assert/strict'
import {
  buildRecommendations,
  detectConcentration,
  detectDrawdown,
  detectMaturity,
  detectPayoutGaps,
  type PayoutSnapshot,
  type PositionSnapshot,
} from './recommendations.ts'

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

function position(overrides: Partial<PositionSnapshot> & Pick<PositionSnapshot, 'id' | 'name'>): PositionSnapshot {
  return { group: 'Облигации', valueBase: 0, pnlPercent: null, ...overrides }
}

console.log('\nКонцентрация (§24)')

test('инструмент выше порога — рекомендация с реальной долей', () => {
  const positions: PositionSnapshot[] = [
    position({ id: 'ofz', name: 'ОФЗ 26238', group: 'Облигации', valueBase: 310000 }),
    position({ id: 'rest', name: 'Остальное', group: 'Акции', valueBase: 690000 }),
  ]
  const result = detectConcentration(positions, 1000000)
  const instrumentRec = result.find((rec) => rec.payload.kind === 'instrument')
  assert.ok(instrumentRec, 'должна быть рекомендация по инструменту')
  assert.equal(instrumentRec!.payload.sharePercent, 31)
  assert.match(instrumentRec!.text, /^Инструмент «ОФЗ 26238» \(группа «Облигации»\) занимает 31% портфеля$/)
})

test('одна бумага на двух счетах брокера — одна рекомендация с суммарной долей', () => {
  const positions: PositionSnapshot[] = [
    position({ id: 'tpay-1', instrumentId: 'tpay', name: 'Пассивный доход', group: 'Фонды', valueBase: 200000 }),
    position({ id: 'tpay-2', instrumentId: 'tpay', name: 'Пассивный доход', group: 'Фонды', valueBase: 100000 }),
    position({ id: 'rest', name: 'Остальное', group: 'Акции', valueBase: 700000 }),
  ]
  const instrumentRecs = detectConcentration(positions, 1000000)
    .filter((rec) => rec.payload.kind === 'instrument' && rec.payload.name === 'Пассивный доход')
  assert.equal(instrumentRecs.length, 1)
  assert.equal(instrumentRecs[0].payload.sharePercent, 30)
})

test('ниже порога — рекомендаций нет', () => {
  const positions: PositionSnapshot[] = [
    position({ id: 'a', name: 'A', group: 'Облигации', valueBase: 200000 }),
    position({ id: 'b', name: 'B', group: 'Акции', valueBase: 200000 }),
  ]
  assert.deepEqual(detectConcentration(positions, 1000000), [])
})

test('эмитент считается суммой по всем его инструментам, даже если каждый по отдельности мал', () => {
  const positions: PositionSnapshot[] = [
    position({ id: 'a', name: 'Бонд A', group: 'Облигации', issuer: 'Минфин', valueBase: 150000 }),
    position({ id: 'b', name: 'Бонд B', group: 'Акции', issuer: 'Минфин', valueBase: 150000 }),
  ]
  const result = detectConcentration(positions, 1000000)
  assert.equal(result.some((rec) => rec.payload.kind === 'instrument'), false)
  const issuerRec = result.find((rec) => rec.payload.kind === 'issuer')
  assert.ok(issuerRec)
  assert.equal(issuerRec!.payload.sharePercent, 30)
})

test('группа считается суммой по инструментам группы', () => {
  const positions: PositionSnapshot[] = [
    position({ id: 'a', name: 'Акция A', group: 'Акции', valueBase: 150000 }),
    position({ id: 'b', name: 'Акция B', group: 'Акции', valueBase: 150000 }),
    position({ id: 'c', name: 'Вклад', group: 'Вклады', valueBase: 700000 }),
  ]
  const result = detectConcentration(positions, 1000000)
  const groupRec = result.find((rec) => rec.payload.kind === 'group')
  assert.ok(groupRec)
  assert.equal(groupRec!.payload.group, 'Акции')
})

test('позиция без оценки (§7.3) не попадает в сумму эмитента и не даёт NaN', () => {
  const positions: PositionSnapshot[] = [
    position({ id: 'unknown', name: 'Без цены', valueBase: null, issuer: 'Минфин' }),
    position({ id: 'known', name: 'С ценой', group: 'Акции', valueBase: 300, issuer: 'Минфин' }),
  ]
  // Если бы null считался как 0 (или портил сумму до NaN), эмитентская доля не равнялась бы
  // ровно доле единственной оценённой позиции — 30% (300 из 1000).
  const result = detectConcentration(positions, 1000)
  const issuerRec = result.find((rec) => rec.payload.kind === 'issuer')
  assert.ok(issuerRec, 'сумма по эмитенту не должна превращаться в NaN из-за null-позиции')
  assert.equal(issuerRec!.payload.sharePercent, 30)
  assert.equal(result.some((rec) => rec.payload.id === 'unknown'), false)
})

test('пустой портфель (totalValue=0) не делит на ноль', () => {
  assert.deepEqual(detectConcentration([], 0), [])
})

console.log('\nПогашение (§24)')

test('крупная позиция гасится в пределах горизонта — рекомендация с числом дней', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  const maturityDate = '2026-10-05' // 23 дня вперёд
  const positions: PositionSnapshot[] = [
    position({ id: 'ofz', name: 'Облигация', valueBase: 350000, maturityDate }),
    position({ id: 'rest', name: 'Остальное', valueBase: 650000 }),
  ]
  const result = detectMaturity(positions, 1000000, undefined, today)
  assert.equal(result.length, 1)
  assert.equal(result[0].payload.daysLeft, 23)
  assert.match(result[0].text, /Через 23 дня погашается «Облигация» на 350\s?000 ₽/)
})

test('мелкая позиция (ниже доли) не считается «крупной» — рекомендации нет', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  const positions: PositionSnapshot[] = [
    position({ id: 'small', name: 'Мелкая', valueBase: 10000, maturityDate: '2026-09-20' }),
    position({ id: 'rest', name: 'Остальное', valueBase: 990000 }),
  ]
  assert.deepEqual(detectMaturity(positions, 1000000, undefined, today), [])
})

test('погашение за пределами горизонта не всплывает раньше времени', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  const positions: PositionSnapshot[] = [
    position({ id: 'far', name: 'Далёкая', valueBase: 500000, maturityDate: '2027-09-12' }),
  ]
  assert.deepEqual(detectMaturity(positions, 1000000, undefined, today), [])
})

test('уже прошедшая дата погашения не порождает отрицательные дни', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  const positions: PositionSnapshot[] = [
    position({ id: 'past', name: 'Прошлая', valueBase: 500000, maturityDate: '2026-01-01' }),
  ]
  assert.deepEqual(detectMaturity(positions, 1000000, undefined, today), [])
})

console.log('\nПросадка (§24)')

test('значительное снижение — рекомендация без совета продавать', () => {
  const positions: PositionSnapshot[] = [
    position({ id: 'x', name: 'Актив X', pnlPercent: -12 }),
  ]
  const result = detectDrawdown(positions)
  assert.equal(result.length, 1)
  assert.match(result[0].text, /снизилась на 12% относительно цены покупки/)
  assert.doesNotMatch(result[0].text.toLowerCase(), /продать|продавать/)
})

test('рост или небольшая просадка не порождают рекомендацию', () => {
  const positions: PositionSnapshot[] = [
    position({ id: 'up', name: 'Растёт', pnlPercent: 15 }),
    position({ id: 'small-drop', name: 'Чуть просел', pnlPercent: -3 }),
  ]
  assert.deepEqual(detectDrawdown(positions), [])
})

test('позиция без оценки P&L (null) не считается просадкой', () => {
  const positions: PositionSnapshot[] = [
    position({ id: 'unknown', name: 'Неизвестно', pnlPercent: null }),
  ]
  assert.deepEqual(detectDrawdown(positions), [])
})

test('облигация, погашаемая в ближайшие полгода, просадкой не считается', () => {
  const today = new Date('2026-09-10T00:00:00Z')
  const positions: PositionSnapshot[] = [
    position({ id: 'soon', name: 'Скоро погасится', pnlPercent: -12, maturityDate: '2026-10-01' }),
    position({ id: 'far', name: 'Далеко', pnlPercent: -12, maturityDate: '2030-01-01' }),
    position({ id: 'share', name: 'Акция', group: 'Акции', pnlPercent: -12, maturityDate: '2026-10-01' }),
  ]
  assert.deepEqual(detectDrawdown(positions, undefined, today).map((item) => item.payload.id), ['far', 'share'])
})

test('погашение называет сумму из календаря выплат, а не рыночную стоимость', () => {
  const today = new Date('2026-09-10T00:00:00Z')
  const result = detectMaturity([
    position({ id: 'ofz', name: 'ОФЗ 26207', valueBase: 310000, maturityAmount: 517750, maturityDate: '2026-10-01' }),
  ], 1000000, undefined, today)
  assert.match(result[0].text, /придёт 517\s750/)
})

console.log('\nВыплаты (§24)')

function payout(date: string, amount: number, status: PayoutSnapshot['status'] = 'expected'): PayoutSnapshot {
  return { date, amount, status }
}

test('месяц без выплат среди активного календаря помечается как разрыв', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  const payouts: PayoutSnapshot[] = [
    payout('2026-09-15', 10000),
    payout('2026-10-15', 10000),
    // 2026-11 — пусто
    payout('2026-12-15', 10000),
  ]
  const result = detectPayoutGaps(payouts, { ...defaultRulesFor(3) }, today)
  assert.equal(result.length, 1)
  assert.match(result[0].text, /ноябр/i)
})

test('только полученные (received) выплаты не считаются календарём ожиданий', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  const payouts: PayoutSnapshot[] = [payout('2026-09-15', 10000, 'received')]
  assert.deepEqual(detectPayoutGaps(payouts, undefined, today), [])
})

test('совсем без выплат — не с чем сравнивать, рекомендации нет', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  assert.deepEqual(detectPayoutGaps([], undefined, today), [])
})

test('возврат тела вклада и погашение номинала не считаются доходом', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  const payouts: PayoutSnapshot[] = [
    payout('2026-09-15', 10000),
    { ...payout('2026-10-15', 500000), type: 'REDEMPTION' },
    payout('2026-10-20', 10000),
    { ...payout('2026-11-10', 300000), type: 'DEPOSIT_PRINCIPAL' },
    payout('2026-11-15', 10000),
  ]
  // Без фильтра средняя ~277 тыс., и 10 тыс. в сентябре выглядели бы разрывом.
  assert.deepEqual(detectPayoutGaps(payouts, { ...defaultRulesFor(3) }, today), [])
})

test('процент просадки пишется с запятой', () => {
  const result = detectDrawdown([position({ id: 'gazp', name: 'Газпром', pnlPercent: -14.67 })])
  assert.match(result[0].text, /снизилась на 14,7%/)
})

test('равномерный календарь без просевших месяцев — рекомендаций нет', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  const payouts: PayoutSnapshot[] = [
    payout('2026-09-15', 10000),
    payout('2026-10-15', 10000),
    payout('2026-11-15', 10000),
  ]
  assert.deepEqual(detectPayoutGaps(payouts, { ...defaultRulesFor(3) }, today), [])
})

function defaultRulesFor(months: number) {
  return {
    concentrationThresholdPercent: 25,
    maturityMinSharePercent: 12.5,
    maturityWithinDays: 30,
    drawdownThresholdPercent: 10,
    payoutGapMonths: months,
    payoutGapMaxShareOfAverage: 0.2,
  }
}

console.log('\nСвод правил (buildRecommendations)')

test('все 4 правила собираются в один список', () => {
  const today = new Date('2026-09-12T00:00:00Z')
  const positions: PositionSnapshot[] = [
    position({ id: 'concentrated', name: 'Концентрат', valueBase: 400000 }),
    position({ id: 'maturing', name: 'Гасится', valueBase: 200000, maturityDate: '2026-09-20' }),
    position({ id: 'dropped', name: 'Просело', valueBase: 200000, pnlPercent: -20 }),
    position({ id: 'rest', name: 'Остальное', valueBase: 200000 }),
  ]
  const payouts: PayoutSnapshot[] = [payout('2026-09-15', 5000)]
  const result = buildRecommendations(positions, 1000000, payouts, defaultRulesFor(2), today)
  const types = new Set(result.map((rec) => rec.ruleType))
  assert.ok(types.has('concentration'))
  assert.ok(types.has('maturity'))
  assert.ok(types.has('drawdown'))
  assert.ok(types.has('payout_gap'))
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

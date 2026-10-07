// Прогноз поступлений по инструменту (payout-outlook.ts). Запуск:
// `npx tsx server/payout-outlook.test.ts`. Ненулевой код возврата = провал.

import assert from 'node:assert/strict'
import { outlookKey, payoutOutlook, payoutPeriods, payoutSums, periodRange, shiftPeriod, type OutlookPayout } from './payout-outlook.ts'

let failed = 0
function test(name: string, run: () => void) {
  try { run(); console.log(`  ok   ${name}`) } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : error}`)
  }
}

const TODAY = '2026-10-07'
const rub = (amount: number, currency: string) => (currency === 'RUB' ? amount : currency === 'USD' ? amount * 90 : null)
function payout(overrides: Partial<OutlookPayout>): OutlookPayout {
  return { date: TODAY, type: 'COUPON', amount: 100, currency: 'RUB', status: 'expected', source: 'forecast', instrumentId: 'i1', accountId: 'a1', ...overrides }
}

console.log('\nПрогноз поступлений по инструменту')
test('доход пришедший и ожидаемый считаются отдельно от возврата тела', () => {
  const outlook = payoutOutlook([
    payout({ date: '2026-08-15', status: 'received', amount: 15000, type: 'INTEREST' }),
    payout({ date: '2026-11-15', amount: 15000, type: 'INTEREST' }),
    payout({ date: '2027-03-15', amount: 15000, type: 'INTEREST' }),
    payout({ date: '2027-03-15', amount: 1000000, type: 'DEPOSIT_PRINCIPAL' }),
  ], TODAY, rub).get(outlookKey('i1', 'a1'))!
  assert.equal(outlook.receivedIncome, 15000)
  assert.equal(outlook.expectedIncome, 30000)
  assert.equal(outlook.expectedPrincipal, 1000000)
  assert.equal(outlook.expectedCount, 2)
  assert.equal(outlook.lastDate, '2027-03-15')
  assert.deepEqual(outlook.next, { date: '2026-11-15', types: ['INTEREST'], amount: 15000, forecast: true })
})

test('ближайшая выплата складывает все строки одной даты', () => {
  const outlook = payoutOutlook([
    payout({ date: '2026-12-01', amount: 350 }),
    payout({ date: '2026-12-01', amount: 10000, type: 'REDEMPTION', source: 'manual' }),
  ], TODAY, rub).get(outlookKey('i1', 'a1'))!
  assert.deepEqual(outlook.next, { date: '2026-12-01', types: ['COUPON', 'REDEMPTION'], amount: 10350, forecast: true })
})

test('просроченный возврат тела не попадает в ожидаемое', () => {
  const outlook = payoutOutlook([payout({ date: '2026-09-01', amount: 5000, type: 'REDEMPTION' })], TODAY, rub).get(outlookKey('i1', 'a1'))!
  assert.equal(outlook.expectedPrincipal, 0)
  assert.equal(outlook.overduePrincipal, 5000)
  assert.equal(outlook.next, null)
})

test('валюта без курса даёт неизвестную сумму, а не ноль (§7.3)', () => {
  const outlook = payoutOutlook([
    payout({ date: '2026-12-01', amount: 10, currency: 'USD' }),
    payout({ date: '2027-01-01', amount: 10, currency: 'CNY' }),
  ], TODAY, rub).get(outlookKey('i1', 'a1'))!
  assert.equal(outlook.expectedIncome, null)
  assert.equal(outlook.next?.amount, 900)
})

test('разные счета одного инструмента не смешиваются, выплаты без инструмента пропускаются', () => {
  const result = payoutOutlook([
    payout({ accountId: 'a1', amount: 1 }),
    payout({ accountId: 'a2', amount: 2 }),
    payout({ instrumentId: undefined, amount: 3 }),
  ], TODAY, rub)
  assert.equal(result.size, 2)
  assert.equal(result.get(outlookKey('i1', 'a2'))!.expectedIncome, 2)
})


console.log('\nСуммы по периодам для календаря выплат')
test('границы и сдвиг периодов: конец месяца, переход через год', () => {
  assert.deepEqual(periodRange('2027-02', 'month'), { from: '2027-02-01', to: '2027-02-28' })
  assert.equal(shiftPeriod('2026-11', 'month', 2), '2027-01')
  assert.equal(shiftPeriod('2026-12-31', 'day', 1), '2027-01-01')
  assert.equal(shiftPeriod('2026', 'year', -1), '2025')
})

test('плитки считают только ожидаемое, доход отдельно от возврата, прошедшее не входит', () => {
  const periods = payoutPeriods([
    payout({ date: '2026-10-01', amount: 999 }),
    payout({ date: '2026-10-20', amount: 100 }),
    payout({ date: '2026-10-25', amount: 50, status: 'received' }),
    payout({ date: '2026-11-15', amount: 10000, type: 'DEPOSIT_PRINCIPAL' }),
    payout({ date: '2027-09-30', amount: 7 }),
    payout({ date: '2027-10-01', amount: 1000 }),
  ], { today: TODAY, level: 'month' }, rub)
  assert.deepEqual(periods.summary.map((card) => card.key), ['2026-10', '2026-11', '2026-12', '12m'])
  assert.equal(periods.summary[0].totals.total, 100)
  assert.equal(periods.summary[1].totals.principal, 10000)
  assert.equal(periods.summary[1].totals.income, 0)
  assert.equal(periods.summary[3].totals.total, 10107)
  assert.equal(periods.summary[3].totals.count, 3)
})

test('сетка: 12 ячеек с текущего периода, полученное и ожидаемое раздельно, окно не уходит в прошлое', () => {
  const rows = [
    payout({ date: '2026-10-20', amount: 100 }),
    payout({ date: '2026-10-25', amount: 50, status: 'received' }),
    payout({ date: '2027-02-01', amount: 30, currency: 'CNY' }),
  ]
  const periods = payoutPeriods(rows, { today: TODAY, level: 'month', start: '2025-01' }, rub)
  assert.equal(periods.start, '2026-10')
  assert.equal(periods.cells.length, 12)
  assert.equal(periods.cells[0].expected.total, 100)
  assert.equal(periods.cells[0].received.total, 50)
  assert.equal(periods.cells[0].all.total, 150)
  assert.deepEqual(periods.cells[4].all.unconverted, ['CNY'])
  assert.equal(periods.cells[4].all.count, 1)
  assert.equal(periods.window.total, 150)
  const years = payoutPeriods(rows, { today: TODAY, level: 'year', start: '2027' }, rub)
  assert.equal(years.cells[0].key, '2027')
  assert.equal(years.cells[0].all.count, 1)
})

console.log('\nИтоги выплат по портфелю')
test('доход и возврат вложенного раздельно, по валютам, просроченное отдельно', () => {
  const sums = payoutSums([
    payout({ date: '2026-08-15', status: 'received', amount: 150 }),
    payout({ date: '2026-08-15', status: 'received', amount: 5000, type: 'REDEMPTION' }),
    payout({ date: '2026-11-15', amount: 100 }),
    payout({ date: '2026-11-15', amount: 10, currency: 'USD' }),
    payout({ date: '2027-03-15', amount: 1000, type: 'DEPOSIT_PRINCIPAL' }),
    payout({ date: '2026-09-01', amount: 700, type: 'DEPOSIT_PRINCIPAL' }),
  ], TODAY)
  assert.deepEqual(sums.received, [{ currency: 'RUB', amount: 150 }])
  assert.deepEqual(sums.expected, [{ currency: 'RUB', amount: 100 }, { currency: 'USD', amount: 10 }])
  assert.deepEqual(sums.expectedPrincipal, [{ currency: 'RUB', amount: 1000 }])
  assert.deepEqual(sums.overdue, [{ currency: 'RUB', amount: 700 }])
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

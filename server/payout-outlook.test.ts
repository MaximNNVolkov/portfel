// Прогноз поступлений по инструменту (payout-outlook.ts). Запуск:
// `npx tsx server/payout-outlook.test.ts`. Ненулевой код возврата = провал.

import assert from 'node:assert/strict'
import { outlookKey, payoutOutlook, type OutlookPayout } from './payout-outlook.ts'

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

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

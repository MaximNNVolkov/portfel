// Ad-hoc проверка прогноза выплат (SPEC §15, §22). Тот же паттерн, что и
// recommendations.test.ts: без фреймворка, запускается напрямую —
// `npx tsx server/payout-forecast.test.ts`. Ненулевой код возврата = провал.

import assert from 'node:assert/strict'
import { addMonths, forecastPayouts } from './payout-forecast.ts'
import type { Instrument, PositionRecord } from './repository.ts'

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

const TODAY = '2026-09-13'

function instrument(overrides: Partial<Instrument>): Instrument {
  return {
    id: 'i1', groupType: 'deposit', instrumentType: 'deposit', name: 'Тест',
    currency: 'RUB', source: 'manual', ...overrides,
  }
}
function position(overrides: Partial<PositionRecord>): PositionRecord {
  return { id: 'p1', accountId: 'a1', instrumentId: 'i1', invested: 100000, source: 'manual', ...overrides }
}

test('addMonths прижимает к последнему дню месяца', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
  assert.equal(addMonths('2026-03-15', 6), '2026-09-15')
  assert.equal(addMonths('2026-12-31', 2), '2027-02-28')
})

test('вклад в конце срока: одни проценты и возврат тела', () => {
  const result = forecastPayouts(
    position({ openedOn: '2026-09-01', invested: 100000 }),
    instrument({ rate: 12, termEndDate: '2027-09-01', interestPayoutFrequency: 'В конце срока' }),
    TODAY,
  )
  assert.equal(result.length, 2)
  assert.equal(result[0].type, 'INTEREST')
  assert.equal(result[0].date, '2027-09-01')
  assert.equal(result[0].amount, 12000)
  assert.equal(result[1].type, 'DEPOSIT_PRINCIPAL')
  assert.equal(result[1].amount, 100000)
})

test('вклад с ежемесячной выплатой: 12 процентных выплат за год плюс тело', () => {
  const result = forecastPayouts(
    position({ openedOn: '2026-09-01', invested: 120000 }),
    instrument({ rate: 12, termEndDate: '2027-09-01', interestPayoutFrequency: 'Ежемесячно' }),
    TODAY,
  )
  assert.equal(result.filter((payout) => payout.type === 'INTEREST').length, 12)
  assert.equal(result.filter((payout) => payout.type === 'DEPOSIT_PRINCIPAL').length, 1)
  const total = result.filter((payout) => payout.type === 'INTEREST').reduce((sum, payout) => sum + payout.amount, 0)
  assert.ok(Math.abs(total - 14400) < 1, `сумма процентов ${total}`)
})

test('капитализация: одна выплата процентов в конце срока и она больше простой', () => {
  const compound = forecastPayouts(
    position({ openedOn: '2026-09-01', invested: 100000 }),
    instrument({ rate: 12, termEndDate: '2027-09-01', interestPayoutFrequency: 'Ежемесячно', capitalization: true }),
    TODAY,
  )
  const interest = compound.filter((payout) => payout.type === 'INTEREST')
  assert.equal(interest.length, 1)
  assert.equal(interest[0].date, '2027-09-01')
  assert.ok(interest[0].amount > 12000, `капитализация должна дать больше простых процентов: ${interest[0].amount}`)
})

test('прошедшие периоды в прогноз не попадают', () => {
  const result = forecastPayouts(
    position({ openedOn: '2025-09-01', invested: 100000 }),
    instrument({ rate: 12, termEndDate: '2026-12-01', interestPayoutFrequency: 'Ежемесячно' }),
    TODAY,
  )
  assert.ok(result.every((payout) => payout.date > TODAY), 'все выплаты должны быть в будущем')
})

test('вклад без ставки или без даты окончания не прогнозируется', () => {
  assert.deepEqual(forecastPayouts(position({ openedOn: '2026-09-01' }), instrument({ termEndDate: '2027-09-01' }), TODAY), [])
  assert.deepEqual(forecastPayouts(position({ openedOn: '2026-09-01' }), instrument({ rate: 12 }), TODAY), [])
  assert.deepEqual(forecastPayouts(position({}), instrument({ rate: 12, termEndDate: '2027-09-01' }), TODAY), [])
})

test('облигация: полугодовые купоны до погашения и номинал', () => {
  const result = forecastPayouts(
    position({ quantity: 10, invested: 9500 }),
    instrument({
      groupType: 'bond', name: 'ОФЗ 26238', nominal: 1000, couponRate: 7,
      couponDate: '2026-10-01', maturityDate: '2027-10-01',
    }),
    TODAY,
  )
  const coupons = result.filter((payout) => payout.type === 'COUPON')
  assert.equal(coupons.length, 3)
  assert.deepEqual(coupons.map((payout) => payout.date), ['2026-10-01', '2027-04-01', '2027-10-01'])
  assert.equal(coupons[0].amount, 350)
  const redemption = result.filter((payout) => payout.type === 'REDEMPTION')
  assert.equal(redemption.length, 1)
  assert.equal(redemption[0].amount, 10000)
  assert.equal(redemption[0].date, '2027-10-01')
})

test('оферта обрывает купонный ряд раньше погашения', () => {
  const result = forecastPayouts(
    position({ quantity: 10 }),
    instrument({
      groupType: 'bond', nominal: 1000, couponRate: 7,
      couponDate: '2026-10-01', maturityDate: '2029-10-01', ofertaDate: '2027-04-01',
    }),
    TODAY,
  )
  assert.deepEqual(result.filter((payout) => payout.type === 'COUPON').map((payout) => payout.date), ['2026-10-01', '2027-04-01'])
})

test('облигация без количества или номинала не прогнозируется', () => {
  const noQuantity = forecastPayouts(
    position({}),
    instrument({ groupType: 'bond', nominal: 1000, couponRate: 7, couponDate: '2026-10-01', maturityDate: '2027-10-01' }),
    TODAY,
  )
  assert.deepEqual(noQuantity, [])
  const noNominal = forecastPayouts(
    position({ quantity: 10 }),
    instrument({ groupType: 'bond', couponRate: 7, couponDate: '2026-10-01', maturityDate: '2027-10-01' }),
    TODAY,
  )
  assert.deepEqual(noNominal, [])
})

test('акции и фонды не прогнозируются', () => {
  assert.deepEqual(forecastPayouts(position({ quantity: 10 }), instrument({ groupType: 'share' }), TODAY), [])
  assert.deepEqual(forecastPayouts(position({ quantity: 10 }), instrument({ groupType: 'fund' }), TODAY), [])
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

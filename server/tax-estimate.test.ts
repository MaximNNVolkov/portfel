// Ad-hoc проверка оценки НДФЛ. Запуск: `npx tsx server/tax-estimate.test.ts`.

import assert from 'node:assert/strict'
import { estimateTax, taxIncomeRows, taxRowsToCsv } from './tax-estimate.ts'
import type { Transaction } from './repository.ts'

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

let seq = 0
function tx(overrides: Partial<Transaction>): Transaction {
  seq += 1
  return { id: `t${seq}`, accountId: 'a1', type: 'INTEREST', date: '2025-05-01', amount: 0, currency: 'RUB', commission: 0, tax: 0, source: 'manual', ...overrides }
}
const rub = (amount: number, currency: string) => (currency === 'RUB' ? amount : currency === 'USD' ? amount * 90 : null)

test('проценты по вкладам облагаются только сверх 1 млн × ключевая ставка', () => {
  const result = estimateTax([tx({ amount: 250_000 }), tx({ amount: 5_000, date: '2024-12-31' })], 2025, rub)
  const deposit = result.lines.find((line) => line.key === 'deposit_interest')!
  assert.equal(deposit.income, 250_000)
  assert.equal(deposit.exempt, 210_000)
  assert.equal(deposit.taxBase, 40_000)
  assert.equal(result.tax, 5_200)
})

test('продажа: прибыль минус себестоимость и комиссия, убыток уменьшает прибыль года', () => {
  const result = estimateTax([
    tx({ type: 'SELL', amount: 150_000, costBasis: 100_000, commission: 100 }),
    tx({ type: 'SELL', amount: 20_000, costBasis: 30_000 }),
    tx({ type: 'SELL', amount: 99_000 }),
  ], 2025, rub)
  const sales = result.lines.find((line) => line.key === 'sales')!
  assert.equal(sales.taxBase, 39_900)
})

test('валюта пересчитывается, без курса — в списке непересчитанных; удержанное вычитается', () => {
  const result = estimateTax([
    tx({ type: 'DIVIDEND', amount: 100, currency: 'USD', tax: 10 }),
    tx({ type: 'COUPON', amount: 1000, currency: 'CNY' }),
  ], 2025, rub)
  assert.equal(result.lines.find((line) => line.key === 'dividends')!.income, 9_000)
  assert.deepEqual(result.unconverted, ['CNY'])
  assert.equal(result.tax, 1_170)
  assert.equal(result.withheld, 900)
  assert.equal(result.toPay, 270)
})

test('прогрессивная шкала: 15% сверх 2,4 млн ₽ с 2025 года', () => {
  const result = estimateTax([tx({ type: 'COUPON', amount: 3_400_000 })], 2025, rub)
  assert.equal(result.tax, 2_400_000 * 0.13 + 1_000_000 * 0.15)
})

test('год без известной ключевой ставки помечается допущением', () => {
  const result = estimateTax([], 2027, rub)
  assert.equal(result.keyRateAssumed, true)
  assert.equal(result.tax, 0)
})

test('CSV: BOM, точка с запятой, запятая в дробях, экранирование', () => {
  const rows = taxIncomeRows([tx({ type: 'COUPON', amount: 1234.5, description: 'x' })], 2025, rub, () => 'ОФЗ; 26238')
  const csv = taxRowsToCsv(rows)
  assert.ok(csv.startsWith('﻿Дата;Вид дохода'))
  assert.match(csv, /2025-05-01;Купон;"ОФЗ; 26238";1234,5;RUB;1234,5;0;Вручную/)
})

test('убыток от продаж уменьшает купоны, но не дивиденды (К32)', () => {
  const result = estimateTax([
    tx({ type: 'SELL', amount: 100_000, costBasis: 200_000 }),
    tx({ type: 'COUPON', amount: 60_000 }),
    tx({ type: 'DIVIDEND', amount: 10_000 }),
  ], 2025, rub)
  assert.equal(result.lines.find((line) => line.key === 'sales')!.taxBase, -60_000)
  assert.equal(result.taxBase, 10_000)
  assert.equal(result.tax, 1_300)
})

test('погашение выше цены покупки — доход, продажа без себестоимости считается отдельно (К33, К35)', () => {
  const result = estimateTax(
    [tx({ type: 'REDEMPTION', amount: 10_000, instrumentId: 'b1' }), tx({ type: 'SELL', amount: 5_000 })],
    2025, rub, (item) => (item.instrumentId === 'b1' ? 9_500 : undefined),
  )
  assert.equal(result.lines.find((line) => line.key === 'sales')!.taxBase, 500)
  assert.equal(result.salesWithoutCost, 1)
})

test('проценты 2021–2022 не облагаются, валютные вклады 2024 — тоже (К34, К37)', () => {
  const exempt = estimateTax([tx({ amount: 900_000, date: '2022-05-01' })], 2022, rub)
  assert.equal(exempt.tax, 0)
  assert.equal(exempt.keyRateAssumed, false)
  const currency = estimateTax([tx({ amount: 5_000, currency: 'USD', date: '2024-05-01' })], 2024, rub)
  assert.equal(currency.lines.find((line) => line.key === 'deposit_interest')!.income, 0)
  assert.equal(estimateTax([], 2026, rub, undefined, '2026-09-29').keyRateAssumed, true)
})

test('уплаченный налог в CSV — в колонке налога, продажа без себестоимости — выручкой (К35, К36)', () => {
  const rows = taxIncomeRows([tx({ type: 'TAX', amount: 700 }), tx({ type: 'SELL', amount: 5_000 })], 2025, rub, () => 'x')
  assert.deepEqual([rows[0].amount, rows[0].withheld], [0, 700])
  assert.match(rows[1].kind, /Выручка/)
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

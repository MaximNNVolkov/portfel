// Ad-hoc проверка Portfolio Engine (SPEC §10). Фреймворк тестов в проект не вводим —
// скрипт запускается напрямую: `npx tsx server/portfolio-engine.test.ts`.
// Ненулевой код возврата = провал, чтобы скрипт можно было воткнуть в CI как есть.

import assert from 'node:assert/strict'
import {
  aggregateByGroup,
  calculateReturns,
  cbrRateTable,
  convertCurrency,
  evaluatePosition,
  resolveAssetGroup,
  type PositionInput,
} from './portfolio-engine.ts'

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

// Курсы ЦБ РФ (§13): сколько рублей стоит одна единица валюты.
const rates = cbrRateTable({ USD: 80, CNY: 11 }, '2026-09-11')
const rub = { baseCurrency: 'RUB', rates }

console.log('\nОценка позиции (§9, §10.1, §14)')

test('обычная позиция: стоимость, P&L и доходность в базовой валюте', () => {
  const result = evaluatePosition(
    { id: 'sber', name: 'Сбербанк', type: 'Акции', currency: 'RUB', quantity: 100, averagePrice: 250, currentPrice: 310 },
    rub,
  )
  assert.equal(result.group, 'Акции')
  assert.equal(result.invested, 25000)
  assert.equal(result.marketValue, 31000)
  assert.equal(result.valueBase, 31000)
  assert.equal(result.pnl, 6000)
  assert.equal(result.pnlPercent, 24)
  assert.equal(result.priceUnavailable, false)
  assert.equal(result.priceUnavailableReason, null)
})

test('облигация: НКД учитывается отдельно и входит в полную стоимость (§14)', () => {
  const result = evaluatePosition(
    { id: 'ofz', name: 'ОФЗ 26241', type: 'Облигации', currency: 'RUB', quantity: 10, averagePrice: 900, currentPrice: 950, accruedInterest: 320 },
    rub,
  )
  assert.equal(result.group, 'Облигации')
  assert.equal(result.marketValue, 9500)
  assert.equal(result.accruedInterest, 320)
  assert.equal(result.fullValue, 9820)
  assert.equal(result.pnl, 820) // 9820 − 9000
})

test('вклад: готовая оценка value без цены за единицу', () => {
  const result = evaluatePosition(
    { id: 'vklad', name: 'Вклад в банке', type: 'вклад', currency: 'RUB', invested: 500000, value: 521000 },
    rub,
  )
  assert.equal(result.group, 'Вклады')
  assert.equal(result.valueBase, 521000)
  assert.equal(result.pnl, 21000)
  assert.equal(result.priceUnavailable, false)
})

console.log('\nОтсутствие цены никогда не равно 0 (§7.3)')

test('нет цены → priceUnavailable=no-price, стоимость null, а не 0', () => {
  const result = evaluatePosition(
    { id: 'x', name: 'Неизвестный', type: 'Акции', currency: 'RUB', quantity: 5, averagePrice: 100, currentPrice: null },
    rub,
  )
  assert.equal(result.marketValue, null)
  assert.equal(result.fullValue, null)
  assert.equal(result.valueBase, null)
  assert.equal(result.pnl, null)
  assert.equal(result.pnlPercent, null)
  assert.equal(result.priceUnavailable, true)
  assert.equal(result.priceUnavailableReason, 'no-price')
  assert.equal(result.invested, 500) // вложено известно даже без текущей цены
})

test('цена есть, но курса валюты нет → priceUnavailable=no-rate', () => {
  const result = evaluatePosition(
    { id: 'hkd', name: 'Гонконгская бумага', type: 'Акции', currency: 'HKD', quantity: 10, averagePrice: 50, currentPrice: 60 },
    rub,
  )
  assert.equal(result.marketValue, 600) // в валюте инструмента цена известна
  assert.equal(result.valueBase, null) // а в рублях — нет
  assert.equal(result.priceUnavailable, true)
  assert.equal(result.priceUnavailableReason, 'no-rate')
})

test('нулевая цена — это цена 0, а не отсутствие цены', () => {
  const result = evaluatePosition(
    { id: 'zero', name: 'Обесценилось', type: 'Акции', currency: 'RUB', quantity: 10, averagePrice: 100, currentPrice: 0 },
    rub,
  )
  assert.equal(result.valueBase, 0)
  assert.equal(result.priceUnavailable, false)
  assert.equal(result.pnl, -1000)
})

console.log('\nКонверсия валют (§13)')

test('USD → RUB по курсу ЦБ', () => {
  assert.equal(convertCurrency(100, 'USD', 'RUB', rates), 8000)
})

test('RUB → USD (обратное направление)', () => {
  assert.equal(convertCurrency(8000, 'RUB', 'USD', rates), 100)
})

test('CNY → USD (кросс-курс через рубль)', () => {
  assert.equal(convertCurrency(80, 'CNY', 'USD', rates), 11)
})

test('одна и та же валюта не требует таблицы курсов', () => {
  assert.equal(convertCurrency(1234.56, 'RUB', 'RUB'), 1234.56)
})

test('неизвестная валюта → null, а не 0', () => {
  assert.equal(convertCurrency(100, 'JPY', 'RUB', rates), null)
  assert.equal(convertCurrency(null, 'USD', 'RUB', rates), null)
})

test('валютная позиция пересчитывается в базовую валюту', () => {
  const result = evaluatePosition(
    { id: 'aapl', name: 'Apple', type: 'Акции', currency: 'USD', quantity: 10, averagePrice: 150, currentPrice: 200 },
    rub,
  )
  assert.equal(result.invested, 1500) // в валюте инструмента
  assert.equal(result.investedBase, 120000) // 1500 × 80
  assert.equal(result.valueBase, 160000) // 2000 × 80
  assert.equal(result.pnl, 40000)
  assert.equal(result.pnlPercent, 33.3333)
})

console.log('\nАгрегация по группам (§7.2, §8)')

const portfolio: PositionInput[] = [
  { id: 'sber', name: 'Сбербанк', type: 'Акции', currency: 'RUB', quantity: 100, averagePrice: 250, currentPrice: 310 },
  { id: 'aapl', name: 'Apple', type: 'Акции', currency: 'USD', quantity: 10, averagePrice: 150, currentPrice: 200 },
  { id: 'ofz', name: 'ОФЗ 26241', type: 'Облигации', currency: 'RUB', quantity: 10, averagePrice: 900, currentPrice: 950, accruedInterest: 320 },
  { id: 'vklad', name: 'Вклад', type: 'Вклады', currency: 'RUB', invested: 500000, value: 521000 },
  { id: 'ghost', name: 'Без цены', type: 'Акции', currency: 'RUB', quantity: 5, averagePrice: 1000 },
]

test('суммы по группам и доли считаются от оценённой части', () => {
  const result = aggregateByGroup(portfolio, rub)
  const stocks = result.groups.find((group) => group.group === 'Акции')!
  assert.equal(stocks.positions, 3)
  assert.equal(stocks.invested, 150000) // 25 000 + 120 000 + 5 000 (вложено в позицию без цены известно)
  assert.equal(stocks.value, 191000) // 31 000 + 160 000, позиция без цены не подмешивается нулём
  assert.equal(stocks.pnl, 46000) // только оценённые позиции: без цены — не «−5 000» (§7.3)
  assert.equal(stocks.pnlPercent, 31.7241) // 46 000 / 145 000
  assert.equal(stocks.priceUnavailable, 1)

  const bonds = result.groups.find((group) => group.group === 'Облигации')!
  assert.equal(bonds.value, 9820)

  const deposits = result.groups.find((group) => group.group === 'Вклады')!
  assert.equal(deposits.value, 521000)

  const shareSum = result.groups.reduce((sum, group) => sum + (group.share ?? 0), 0)
  assert.ok(Math.abs(shareSum - 100) < 0.01, `сумма долей должна быть 100%, получено ${shareSum}`)
})

test('итог портфеля и флаг неполной оценки (§7.3, §40.2)', () => {
  const result = aggregateByGroup(portfolio, rub)
  assert.equal(result.value, 721820) // 191 000 + 9 820 + 521 000
  assert.equal(result.invested, 659000) // 150 000 + 9 000 + 500 000
  assert.equal(result.pnl, 67820) // 46 000 + 820 + 21 000; позиция без цены не даёт «−вложено»
  assert.equal(result.pnlInvested, 654000)
  assert.equal(result.valuationIncomplete, true)
  assert.deepEqual(result.unavailable, [{ id: 'ghost', name: 'Без цены', group: 'Акции', reason: 'no-price' }])
})

// BUG-09: акция без котировки, но с введённой суммой — стоимость есть (приблизительная),
// P&L нет. Вклад с той же формой ввода остаётся точной оценкой.
test('котируемый инструмент без котировки оценивается приблизительно, без P&L', () => {
  const share = evaluatePosition({ id: 's', type: 'Акции', currency: 'RUB', invested: 100000, value: 100000, quantity: 10 }, rub)
  assert.equal(share.valueBase, 100000)
  assert.equal(share.estimated, true)
  assert.equal(share.priceUnavailable, false)
  assert.equal(share.pnl, null)
  assert.equal(share.pnlPercent, null)
  const deposit = evaluatePosition({ id: 'd', type: 'Вклады', currency: 'RUB', invested: 100000, value: 100000 }, rub)
  assert.equal(deposit.estimated, false)
  assert.equal(deposit.pnl, 0)
  const result = aggregateByGroup([{ id: 's', type: 'Акции', currency: 'RUB', invested: 100000, value: 100000, quantity: 10 }], rub)
  assert.equal(result.value, 100000)
  assert.equal(result.groups[0].estimated, 1)
  assert.equal(result.pnlPercent, null) // нечем мерить — не «+0,0%»
})

test('группы отсортированы по стоимости, неизвестный тип попадает в «Прочее»', () => {
  const result = aggregateByGroup([...portfolio, { id: 'misc', name: 'Что-то', type: 'крипта', currency: 'RUB', invested: 1000, value: 1500 }], rub)
  assert.deepEqual(result.groups.map((group) => group.group), ['Вклады', 'Акции', 'Облигации', 'Прочее'])
  assert.equal(resolveAssetGroup('крипта'), 'Прочее')
  assert.equal(resolveAssetGroup(undefined), 'Прочее')
})

test('пустой портфель: нули без падений и без ложного «неполно»', () => {
  const result = aggregateByGroup([], rub)
  assert.equal(result.value, 0)
  assert.equal(result.invested, 0)
  assert.equal(result.pnlPercent, null)
  assert.equal(result.groups.length, 0)
  assert.equal(result.valuationIncomplete, false)
})

console.log('\nФинансовый результат и доходность (§10.6)')

test('изменение стоимости + выплаты − комиссии − налоги', () => {
  const result = calculateReturns({ currentValue: 721820, invested: 659000, payoutsReceived: 12480, commissions: 350, taxes: 1620 })
  assert.equal(result.valueChange, 62820)
  assert.equal(result.financialResult, 73330) // 62 820 + 12 480 − 350 − 1 620
  assert.equal(result.returnPercent, 11.1275) // 73 330 / 659 000
  assert.equal(result.method, 'simple')
  assert.equal(result.incomplete, false)
})

test('нет оценки стоимости → результат null и incomplete, а не 0', () => {
  const result = calculateReturns({ currentValue: null, invested: 659000, payoutsReceived: 12480 })
  assert.equal(result.valueChange, null)
  assert.equal(result.financialResult, null)
  assert.equal(result.returnPercent, null)
  assert.equal(result.incomplete, true)
})

test('нулевая база: доходность не считается (без деления на ноль)', () => {
  const result = calculateReturns({ currentValue: 5000, invested: 0, payoutsReceived: 5000 })
  assert.equal(result.financialResult, 10000)
  assert.equal(result.returnPercent, null)
  assert.equal(result.basis, null)
  assert.equal(result.incomplete, true)
})

test('агрегация и доходность стыкуются между собой', () => {
  const aggregate = aggregateByGroup(portfolio, rub)
  const result = calculateReturns({ currentValue: aggregate.pnlValue, invested: aggregate.pnlInvested, payoutsReceived: 0 })
  assert.equal(result.valueChange, aggregate.pnl)
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

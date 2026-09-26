// Ad-hoc проверка разбора OCR-текста (SPEC §18). Тот же паттерн, что и
// payout-forecast.test.ts: без фреймворка, запускается напрямую —
// `npx tsx server/ocr.test.ts`. Ненулевой код возврата = провал.
//
// Покрываются только чистые функции модуля: сам воркер (processNextDocument) ходит
// в БД и в tesseract, поэтому проверяется вручную на живом стенде.

import assert from 'node:assert/strict'
import { buildOcrCandidates, extractNumbers, groupOcrLines, hasNameText, inferAssetType, isTotalLine, normalizeCurrency, normalizeOcrName, parseNumber, stripIdentifiers, toCandidateName } from './ocr.ts'

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

test('parseNumber понимает пробелы-разделители и запятую', () => {
  assert.equal(parseNumber('1 250 000,50'), 1250000.5)
  assert.equal(parseNumber('350000'), 350000)
})

test('parseNumber не падает на мусоре', () => {
  assert.equal(parseNumber(''), 0)
  assert.equal(parseNumber('—'), 0)
  assert.equal(parseNumber('₽'), 0)
})

test('normalizeCurrency распознаёт символы и коды', () => {
  assert.equal(normalizeCurrency('1 000 ₽'), 'RUB')
  assert.equal(normalizeCurrency('120.5 USD'), 'USD')
  assert.equal(normalizeCurrency('$120'), 'USD')
  // Неизвестная валюта не должна ронять разбор: рубль — базовая валюта MVP (§12/§13).
  assert.equal(normalizeCurrency('120 GBP'), 'RUB')
})

test('inferAssetType раскладывает строки по группам §7.2', () => {
  assert.equal(inferAssetType('ОФЗ 26238'), 'Облигации')
  assert.equal(inferAssetType('Акции Сбербанк'), 'Акции')
  assert.equal(inferAssetType('Вклад Надёжный'), 'Вклады')
  assert.equal(inferAssetType('Фонд Ликвидность'), 'Фонды')
  assert.equal(inferAssetType('Остаток на счёте'), 'Деньги')
  assert.equal(inferAssetType('Непонятная строка'), 'Прочее')
})

test('toCandidateName отрезает суммы и подписи полей', () => {
  assert.equal(toCandidateName('Название: Вклад Надёжный 350 000 ₽'), 'Вклад Надёжный')
  // Пустое имя недопустимо — запись всё равно сохраняется (§40.4), пользователь правит потом.
  assert.equal(toCandidateName('   '), 'Распознанный продукт')
})

test('normalizeOcrName приводит названия к общему ключу дедупликации §18', () => {
  assert.equal(normalizeOcrName('  Вклад Надёжный '), normalizeOcrName('вклад надёжный'))
})

test('extractNumbers различает разряды и отдельные числа', () => {
  assert.deepEqual(extractNumbers('350 000 ₽'), [350000])
  assert.deepEqual(extractNumbers('1 250 000,50 ₽'), [1250000.5])
  // Номер выпуска облигации не должен склеиваться с суммой в одно число.
  assert.deepEqual(extractNumbers('ОФЗ 26238 120 000 ₽'), [26238, 120000])
})

test('число из названия выпуска не подставляется как «вложено» (§7.3)', () => {
  const [bond] = buildOcrCandidates('ОФЗ 26238 120 000 ₽')
  assert.equal(bond.amount, 120000)
  assert.equal(bond.invested, 120000)
  assert.equal(bond.deltaPercent, 0)
})

test('вложено берётся, когда обе суммы одного порядка', () => {
  const [share] = buildOcrCandidates('Акции Сбербанк 120 000 ₽ вложено 100 000 ₽')
  assert.equal(share.amount, 120000)
  assert.equal(share.invested, 100000)
})

test('buildOcrCandidates находит несколько продуктов на одном скриншоте', () => {
  const candidates = buildOcrCandidates([
    'Вклад Надёжный 350 000 ₽',
    'ОФЗ 26238 120 000 ₽',
    'Акции Сбербанк 45 000 ₽',
  ].join('\n'))
  assert.equal(candidates.length, 3)
  const deposit = candidates.find((candidate) => candidate.type === 'Вклады')
  assert.ok(deposit, 'вклад должен быть распознан')
  assert.equal(deposit.amount, 350000)
  assert.equal(deposit.currency, 'RUB')
  assert.equal(candidates.some((candidate) => candidate.type === 'Облигации'), true)
  assert.equal(candidates.some((candidate) => candidate.type === 'Акции'), true)
})

test('buildOcrCandidates пропускает строки без чисел', () => {
  const candidates = buildOcrCandidates('Мои инвестиции\nВклад Надёжный 350 000 ₽')
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].amount, 350000)
})

test('buildOcrCandidates схлопывает повтор одной и той же строки', () => {
  const candidates = buildOcrCandidates('Вклад Надёжный 350 000 ₽\nВклад Надёжный 350 000 ₽')
  assert.equal(candidates.length, 1)
})

test('buildOcrCandidates отдаёт не больше 6 записей', () => {
  const text = Array.from({ length: 12 }, (_unused, index) => `Вклад №${index} ${100000 + index} ₽`).join('\n')
  assert.equal(buildOcrCandidates(text).length, 6)
})

test('нераспознаваемый текст помечается недостающими полями, а не нулевой суммой (§7.3)', () => {
  const [candidate] = buildOcrCandidates('какой-то текст без цифр')
  assert.equal(candidate.amount, 0)
  assert.deepEqual(candidate.missingFields, ['name', 'amount', 'invested'])
})

// BUG-12: текст скриншота из отчёта тестировщика (прогон 17.09.2026), включая
// типичные ошибки OCR — «Р»/«P» вместо «₽».
const BROKER_SCREEN = [
  'Мои активы',
  'Вклад Надёжный 450 000 ₽',
  'ОФЗ 26238',
  '120 шт · 567,30 Р · 68 076,00 Р',
  'SBER',
  '50 шт -312,45P - 15 622,50 Р',
  'Итого: 533 698,50 Р',
].join('\n')

test('итоговые строки не считаются активом', () => {
  assert.equal(isTotalLine('Итого: 533 698,50 ₽'), true)
  assert.equal(isTotalLine('Всего 10 000'), true)
  assert.equal(isTotalLine('Total 1 000 USD'), true)
  assert.equal(isTotalLine('Сумма портфеля 1 000 ₽'), true)
  assert.equal(isTotalLine('Баланс: 12 000 ₽'), true)
  assert.equal(isTotalLine('Вклад Итоговый 10 000 ₽'), false)
  assert.equal(isTotalLine('Итоговая доходность 12%'), false)
  const [only] = buildOcrCandidates('Итого: 533 698,50 ₽')
  assert.equal(only.amount, 0, 'запасной разбор всего текста тоже не должен подхватить итог')
})

test('номер выпуска и ISIN не принимаются за сумму', () => {
  assert.deepEqual(extractNumbers(stripIdentifiers('ОФЗ 26238')), [])
  assert.deepEqual(extractNumbers(stripIdentifiers('ОФЗ-ПД 26238 120 000 ₽')), [120000])
  assert.deepEqual(extractNumbers(stripIdentifiers('SU26238RMFS4 68 076 ₽')), [68076])
  assert.equal(toCandidateName('ОФЗ 26238 120 000 ₽'), 'ОФЗ 26238')
})

test('строка из одних цифр и единиц названием не считается', () => {
  assert.equal(hasNameText('120 шт · 567,30 Р · 68 076,00 Р'), false)
  assert.equal(hasNameText('50 шт -312,45P - 15 622,50 Р'), false)
  assert.equal(hasNameText('SBER'), true)
})

test('название склеивается со следующей строкой количества и цены', () => {
  assert.deepEqual(groupOcrLines(BROKER_SCREEN), [
    { text: 'Вклад Надёжный 450 000 ₽' },
    { text: 'ОФЗ 26238 120 шт · 567,30 Р · 68 076,00 Р', name: 'ОФЗ 26238' },
    { text: 'SBER 50 шт -312,45P - 15 622,50 Р', name: 'SBER' },
  ])
})

test('скриншот из отчёта BUG-12 даёт ровно три актива с верными суммами', () => {
  const candidates = buildOcrCandidates(BROKER_SCREEN)
  assert.equal(candidates.length, 3)
  const byType = Object.fromEntries(candidates.map((candidate) => [candidate.type, candidate]))
  assert.equal(byType['Вклады'].amount, 450000)
  assert.equal(byType['Облигации'].amount, 68076)
  assert.equal(byType['Облигации'].name, 'ОФЗ 26238')
  assert.equal(byType['Облигации'].invested, 68076)
  assert.equal(byType['Акции'].amount, 15622.5)
  assert.equal(byType['Акции'].name, 'SBER')
  assert.equal(candidates.some((candidate) => /итого/i.test(candidate.name)), false)
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

// Ad-hoc проверка разбора OCR-текста (SPEC §18). Тот же паттерн, что и
// payout-forecast.test.ts: без фреймворка, запускается напрямую —
// `npx tsx server/ocr.test.ts`. Ненулевой код возврата = провал.
//
// Покрываются только чистые функции модуля: сам воркер (processNextDocument) ходит
// в БД и в tesseract, поэтому проверяется вручную на живом стенде.

import assert from 'node:assert/strict'
import { buildOcrCandidates, extractNumbers, inferAssetType, normalizeCurrency, normalizeOcrName, parseNumber, toCandidateName } from './ocr.ts'

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

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

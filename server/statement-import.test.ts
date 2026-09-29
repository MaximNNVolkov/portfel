// Ad-hoc проверка импорта выписки. Запуск: `npx tsx server/statement-import.test.ts`.

import assert from 'node:assert/strict'
import { guessMapping, parseCsv, parseMapping, parseStatementAmount, parseStatementDate, statementRows } from './statement-import.ts'

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

test('CSV: точка с запятой, кавычки, перевод строки внутри кавычек, BOM', () => {
  const parsed = parseCsv('﻿Дата;Сумма;Описание\r\n01.02.2026;"1 000,50";"Перевод ""от мамы""\nс карты"\r\n\r\n')
  assert.deepEqual(parsed.headers, ['Дата', 'Сумма', 'Описание'])
  assert.deepEqual(parsed.records, [['01.02.2026', '1 000,50', 'Перевод "от мамы"\nс карты']])
})

test('CSV с запятой-разделителем определяется по заголовку', () => {
  assert.deepEqual(parseCsv('date,amount\n2026-01-01,5\n').records, [['2026-01-01', '5']])
})

test('даты и суммы в банковских форматах', () => {
  assert.equal(parseStatementDate('31.12.2025 14:05'), '2025-12-31')
  assert.equal(parseStatementDate('2025-12-31'), '2025-12-31')
  assert.equal(parseStatementDate('01/02/26'), '2026-02-01')
  assert.equal(parseStatementDate('31.02.2026'), null)
  assert.equal(parseStatementAmount('−1 234,56 ₽'), -1234.56)
  assert.equal(parseStatementAmount('1 234.56'), 1234.56)
  assert.equal(parseStatementAmount('1.234,56'), 1234.56)
  assert.equal(parseStatementAmount('+500'), 500)
  assert.equal(parseStatementAmount('(1 000,00)'), -1000)
  assert.equal(parseStatementAmount('abc'), null)
})

test('колонки угадываются по заголовкам выписки', () => {
  assert.deepEqual(guessMapping(['Дата операции', 'Дата платежа', 'Статус', 'Сумма операции', 'Валюта операции', 'Категория', 'Описание']), {
    date: 0, amount: 3, income: null, expense: null, description: 6, currency: 4, status: 2,
  })
  const split = guessMapping(['Дата', 'Приход', 'Расход', 'Назначение платежа'])
  assert.equal(split.amount, null)
  assert.equal(split.income, 1)
  assert.equal(split.expense, 2)
  assert.equal(split.description, 3)
})

test('строки: приход, расход, проценты, ошибки и ключ повторной загрузки', () => {
  const parsed = parseCsv([
    'Дата;Сумма;Валюта;Описание',
    '01.03.2026;100000;RUB;Пополнение',
    '02.03.2026;-2500,5;RUB;Перевод',
    '31.03.2026;1234,56;руб.;Выплата процентов',
    'вчера;10;RUB;x',
    '01.04.2026;10;EUR;евро',
    '02.03.2026;-2500,5;RUB;Перевод',
  ].join('\n'))
  const rows = statementRows(parsed, guessMapping(parsed.headers))
  assert.deepEqual(rows.slice(0, 3).map((row) => [row.type, row.amount, row.currency]), [
    ['DEPOSIT', 100000, 'RUB'], ['WITHDRAW', 2500.5, 'RUB'], ['INTEREST', 1234.56, 'RUB'],
  ])
  assert.match(rows[3].error!, /дата/)
  assert.match(rows[4].error!, /EUR/)
  // Две одинаковые строки в одном файле — две операции с разными ключами, а тот же файл
  // повторно даёт те же ключи.
  assert.notEqual(rows[1].externalId, rows[5].externalId)
  assert.deepEqual(statementRows(parsed, guessMapping(parsed.headers)).map((row) => row.externalId), rows.map((row) => row.externalId))
})

test('приход и расход в двух колонках', () => {
  const parsed = parseCsv('Дата;Приход;Расход;Назначение\n01.03.2026;;1 000;Снятие\n02.03.2026;500;;Возврат\n')
  const rows = statementRows(parsed, guessMapping(parsed.headers))
  assert.deepEqual(rows.map((row) => [row.type, row.amount]), [['WITHDRAW', 1000], ['DEPOSIT', 500]])
})

test('выбор колонок пользователем проверяется', () => {
  assert.equal(parseMapping({ description: '' }, ['Дата', 'Сумма', 'Описание']).description, null)
  assert.throws(() => parseMapping({ date: 7 }, ['Дата', 'Сумма']), /Колонка/)
})

test('шапка над таблицей пропускается, заголовок — строка с датой (К26)', () => {
  const parsed = parseCsv('Выписка по счёту 40817…\nПериод: 01.03.2026 — 31.03.2026\n\nДата;Сумма;Описание\n01.03.2026;100;x\n')
  assert.deepEqual(parsed.headers, ['Дата', 'Сумма', 'Описание'])
  assert.equal(parsed.records.length, 1)
})

test('Т-Банк: сумма платежа важнее суммы операции, FAILED не загружается (К23, К24)', () => {
  const parsed = parseCsv([
    'Дата операции;Дата платежа;Номер карты;Статус;Сумма операции;Валюта операции;Сумма платежа;Валюта платежа;Категория;Описание',
    '05.03.2026 12:00:00;05.03.2026;*1234;OK;-50,00;USD;-4100,00;RUB;Сервисы;Подписка',
    '06.03.2026 12:00:00;06.03.2026;*1234;FAILED;-99999,00;RUB;-99999,00;RUB;Переводы;Перевод',
  ].join('\n'))
  const rows = statementRows(parsed, guessMapping(parsed.headers))
  assert.deepEqual([rows[0].type, rows[0].amount, rows[0].currency], ['WITHDRAW', 4100, 'RUB'])
  assert.match(rows[1].error!, /не проведена/)
})

test('холд Альфы не загружается (К25)', () => {
  const parsed = parseCsv('Дата;Референс;Описание;Сумма\n05.03.2026;HOLD;Покупка;-500\n06.03.2026;CRD_1;Покупка;-500\n')
  const rows = statementRows(parsed, guessMapping(parsed.headers))
  assert.ok(rows[0].error)
  assert.equal(rows[1].type, 'WITHDRAW')
})

test('проценты по кредиту — не доход, проценты на остаток — доход (К27)', () => {
  const parsed = parseCsv('Дата;Сумма;Описание\n01.03.2026;120;Возврат переплаты процентов по кредиту\n31.03.2026;340;Выплата процентов на остаток\n31.03.2026;50;Капитализация\n')
  assert.deepEqual(statementRows(parsed, guessMapping(parsed.headers)).map((row) => row.type), ['DEPOSIT', 'INTEREST', 'INTEREST'])
})

test('смена колонки описания не меняет ключ повторной загрузки (К29)', () => {
  const parsed = parseCsv('Дата;Сумма;Категория;Описание\n01.03.2026;100;Прочее;Перевод\n')
  const mapping = guessMapping(parsed.headers)
  const first = statementRows(parsed, mapping)[0].externalId
  assert.equal(statementRows(parsed, { ...mapping, description: 2 })[0].externalId, first)
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

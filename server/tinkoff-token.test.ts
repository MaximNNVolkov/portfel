// Ad-hoc проверка очистки токена Т-Инвестиций перед заголовком Authorization. Тот же паттерн,
// что и ocr.test.ts: без фреймворка, `npx tsx server/tinkoff-token.test.ts`.
// Ненулевой код возврата = провал.

import assert from 'node:assert/strict'
import { normalizeTinkoffToken } from './brokers/tinkoff.ts'

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

const TOKEN = 't.AbC-12_xyZ'

test('чистый токен не меняется', () => {
  assert.equal(normalizeTinkoffToken(TOKEN), TOKEN)
})

test('убирает пробелы и переносы строк по краям и внутри', () => {
  assert.equal(normalizeTinkoffToken(`  ${TOKEN}\n`), TOKEN)
  assert.equal(normalizeTinkoffToken('t.AbC-12\r\n_xyZ'), TOKEN)
})

test('убирает неразрывный пробел и невидимые символы', () => {
  assert.equal(normalizeTinkoffToken(` ${TOKEN}​`), TOKEN)
  assert.equal(normalizeTinkoffToken(`﻿${TOKEN}⁠`), TOKEN)
})

test('кириллица и кавычки-«ёлочки» — не токен', () => {
  assert.equal(normalizeTinkoffToken('t.АbC'), null)
  assert.equal(normalizeTinkoffToken(`«${TOKEN}»`), null)
})

test('пустая строка после очистки — не токен', () => {
  assert.equal(normalizeTinkoffToken(' ​\n'), null)
})

if (failed) {
  console.log(`\n${failed} проверок провалено`)
  process.exitCode = 1
}

// Ad-hoc проверка логики восстановления пароля — тот же паттерн, что и
// payout-forecast.test.ts/recommendations.test.ts: без фреймворка, без БД,
// запускается напрямую: `npx tsx server/password-reset.test.ts`.
// Ненулевой код возврата = провал.
//
// Отсутствие перебора аккаунтов (§28 — forgot-password не должен позволять узнать,
// зарегистрирован ли email) — свойство HTTP-хендлера (всегда 200 с одним и тем же
// текстом), а не чистых функций этого модуля; проверено живым e2e-прогоном на стенде
// (см. отчёт о раунде), не здесь.

import assert from 'node:assert/strict'
import {
  EmailRateLimiter, generateResetToken, hashResetToken, isTokenExpired, validateResetToken,
} from './password-reset.ts'

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

test('isTokenExpired: будущая дата ещё не просрочена', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  assert.equal(isTokenExpired(new Date('2026-09-28T13:00:00Z'), now), false)
})

test('isTokenExpired: прошедшая дата просрочена', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  assert.equal(isTokenExpired(new Date('2026-09-28T11:59:59Z'), now), true)
})

test('isTokenExpired: граница (истекает ровно сейчас) считается просроченной', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  assert.equal(isTokenExpired(new Date('2026-09-28T12:00:00Z'), now), true)
})

test('validateResetToken: несуществующий токен', () => {
  assert.equal(validateResetToken(undefined), 'not_found')
})

test('validateResetToken: срок истёк', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  const record = { id: 't1', userId: 'u1', expiresAt: '2026-09-28T11:00:00Z', usedAt: null }
  assert.equal(validateResetToken(record, now), 'expired')
})

test('validateResetToken: уже использован — повторное использование запрещено', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  const record = { id: 't1', userId: 'u1', expiresAt: '2026-09-28T13:00:00Z', usedAt: '2026-09-28T11:30:00Z' }
  assert.equal(validateResetToken(record, now), 'used')
})

test('validateResetToken: использованный токен приоритетнее просроченного (оба сразу)', () => {
  // Не должно молча превращаться в "expired" — пользователь должен понять, что ссылку
  // уже применяли, а не просто "поздно спохватился".
  const now = new Date('2026-09-28T12:00:00Z')
  const record = { id: 't1', userId: 'u1', expiresAt: '2020-01-01T00:00:00Z', usedAt: '2026-09-28T11:30:00Z' }
  assert.equal(validateResetToken(record, now), 'used')
})

test('validateResetToken: валидный неиспользованный токен в пределах срока', () => {
  const now = new Date('2026-09-28T12:00:00Z')
  const record = { id: 't1', userId: 'u1', expiresAt: '2026-09-28T13:00:00Z', usedAt: null }
  assert.equal(validateResetToken(record, now), 'ok')
})

test('hashResetToken: детерминирован и не совпадает для разных токенов', () => {
  const tokenA = generateResetToken()
  const tokenB = generateResetToken()
  assert.notEqual(tokenA, tokenB)
  assert.equal(hashResetToken(tokenA), hashResetToken(tokenA))
  assert.notEqual(hashResetToken(tokenA), hashResetToken(tokenB))
  // В базе хранится только хэш — сам токен по хэшу восстановить нельзя, поэтому хэш
  // не должен просто повторять исходную строку.
  assert.notEqual(hashResetToken(tokenA), tokenA)
})

test('generateResetToken: достаточная энтропия (32 байта base64url — не короче 40 символов)', () => {
  const token = generateResetToken()
  assert.ok(token.length >= 40, `длина токена: ${token.length}`)
  assert.match(token, /^[A-Za-z0-9_-]+$/)
})

test('EmailRateLimiter: не чаще 1 письма в минуту на email', () => {
  const limiter = new EmailRateLimiter()
  const t0 = 1_000_000
  assert.equal(limiter.allow('a@test.local', t0), true)
  assert.equal(limiter.allow('a@test.local', t0 + 1000), false)
  // Через минуту — снова можно.
  assert.equal(limiter.allow('a@test.local', t0 + 61_000), true)
})

test('EmailRateLimiter: не больше 5 писем в час на email, даже если реже раза в минуту', () => {
  const limiter = new EmailRateLimiter()
  const t0 = 1_000_000
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.allow('b@test.local', t0 + i * 61_000), true, `попытка ${i}`)
  }
  assert.equal(limiter.allow('b@test.local', t0 + 5 * 61_000), false)
})

test('EmailRateLimiter: счётчик per-email, лимит одного адреса не блокирует другой', () => {
  const limiter = new EmailRateLimiter()
  const t0 = 1_000_000
  assert.equal(limiter.allow('c@test.local', t0), true)
  assert.equal(limiter.allow('c@test.local', t0 + 1000), false)
  assert.equal(limiter.allow('d@test.local', t0 + 1000), true)
})

test('EmailRateLimiter: старые попытки выпадают из часового окна', () => {
  const limiter = new EmailRateLimiter()
  const t0 = 1_000_000
  for (let i = 0; i < 5; i += 1) limiter.allow('e@test.local', t0 + i * 61_000)
  // Час и одна минута спустя после первой попытки — она уже вне окна, есть место для новой.
  assert.equal(limiter.allow('e@test.local', t0 + 61 * 60_000), true)
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

// Восстановление пароля по почте: генерация/проверка одноразовых токенов сброса и
// ограничение частоты писем на один email. Вынесено из index.ts в отдельный модуль,
// чтобы логику токенов можно было юнит-тестировать без поднятия HTTP-сервера/БД
// (см. password-reset.test.ts) — тот же приём, что и payout-forecast.ts/recommendations.ts.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Db } from './repository.ts'

// SPEC не фиксирует срок жизни ссылки восстановления явно — час выбран как обычный для
// подобных писем компромисс: достаточно, чтобы дойти до почты и перейти по ссылке, но
// не настолько долго, чтобы забытое в инбоксе письмо оставалось рабочим ключом от аккаунта.
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000

export function generateResetToken(): string {
  // 32 байта — тот же объём энтропии, что и у токена сессии (createSession в index.ts).
  return randomBytes(32).toString('base64url')
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isTokenExpired(expiresAt: Date | string, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() <= now.getTime()
}

// Ограничение частоты писем на конкретный email (§28: без этого forgot-password — готовый
// инструмент для спама чужого почтового ящика). Отдельно от лимита по IP (authLimiter в
// index.ts, тот же общий лимитер, что у /login и /register) — этот бьёт по адресату
// независимо от того, с одного IP пришли запросы или с разных.
export class EmailRateLimiter {
  private readonly attempts = new Map<string, number[]>()
  constructor(private readonly maxPerMinute = 1, private readonly maxPerHour = 5) {}

  // true - можно отправлять письмо; сама же фиксирует попытку (вызывающий код не должен
  // отдельно записывать факт отправки). now — параметр ради тестируемости без реального
  // ожидания времени (см. password-reset.test.ts).
  allow(email: string, now: number = Date.now()): boolean {
    const hourAgo = now - 60 * 60 * 1000
    const minuteAgo = now - 60 * 1000
    const recent = (this.attempts.get(email) ?? []).filter((timestamp) => timestamp > hourAgo)
    const withinLastMinute = recent.filter((timestamp) => timestamp > minuteAgo).length
    if (withinLastMinute >= this.maxPerMinute || recent.length >= this.maxPerHour) {
      this.attempts.set(email, recent)
      return false
    }
    recent.push(now)
    this.attempts.set(email, recent)
    return true
  }
}

export type ResetTokenRecord = { id: string; userId: string; expiresAt: string; usedAt: string | null }
export type ResetTokenValidation = 'ok' | 'not_found' | 'used' | 'expired'

// Единая точка решения «можно ли по этому токену менять пароль» — используется и
// HTTP-хендлером (index.ts), и юнит-тестами (password-reset.test.ts), чтобы поведение
// для просроченной/уже использованной/несуществующей ссылки было проверяемо без БД.
export function validateResetToken(record: ResetTokenRecord | undefined, now: Date = new Date()): ResetTokenValidation {
  if (!record) return 'not_found'
  if (record.usedAt) return 'used'
  if (isTokenExpired(record.expiresAt, now)) return 'expired'
  return 'ok'
}

export async function createPasswordResetToken(db: Db, userId: string): Promise<string> {
  const token = generateResetToken()
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS)
  await db.query(
    'INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [randomUUID(), userId, hashResetToken(token), expiresAt],
  )
  return token
}

export async function findResetToken(db: Db, token: string): Promise<ResetTokenRecord | undefined> {
  const result = await db.query(
    'SELECT id, user_id as "userId", expires_at as "expiresAt", used_at as "usedAt" FROM password_reset_tokens WHERE token_hash = $1',
    [hashResetToken(token)],
  )
  return result.rows[0]
}

// Помечает использованным не только сам применённый токен, но и все остальные ещё не
// использованные токены того же пользователя одним запросом — если письмо запрашивали
// несколько раз, старые ссылки не должны продолжать работать после того, как пароль уже
// сменили по одной из них.
export async function invalidateUserResetTokens(db: Db, userId: string): Promise<void> {
  await db.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [userId])
}

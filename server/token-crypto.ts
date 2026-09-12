// Шифрование токенов брокеров at-rest (§28: «Токены брокеров — только в зашифрованном
// виде, никогда в логах»). AES-256-GCM: ключ выводится из TOKEN_ENCRYPTION_KEY один раз
// при старте процесса, каждый токен получает свой случайный IV.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const rawKey = process.env.TOKEN_ENCRYPTION_KEY
const isProduction = process.env.NODE_ENV === 'production'
const MIN_KEY_LENGTH = 32

// В production подстановка dev-ключа недопустима: токены брокеров лежали бы в базе
// зашифрованными общеизвестной строкой из репозитория, то есть фактически открыто (§28).
// Поэтому процесс падает на старте — это заметно сразу, в отличие от предупреждения
// в логе, которое легко пропустить при деплое.
if (isProduction) {
  if (!rawKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY не задан. В production запуск без ключа шифрования токенов брокеров запрещён (§28). Сгенерировать: openssl rand -hex 32')
  }
  if (rawKey.length < MIN_KEY_LENGTH) {
    throw new Error(`TOKEN_ENCRYPTION_KEY короче ${MIN_KEY_LENGTH} символов. Сгенерировать полноценный ключ: openssl rand -hex 32`)
  }
} else if (!rawKey) {
  console.warn('[token-crypto] TOKEN_ENCRYPTION_KEY не задан — используется небезопасный ключ для разработки. В production такой запуск завершится ошибкой.')
}

const KEY = scryptSync(rawKey || 'dev-only-insecure-key-change-me', 'portfel-broker-token', 32)

export function encryptToken(token: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString('base64')
}

export function decryptToken(payload: string): string {
  const buffer = Buffer.from(payload, 'base64')
  const iv = buffer.subarray(0, 12)
  const authTag = buffer.subarray(12, 28)
  const encrypted = buffer.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export function maskToken(token: string): string {
  if (token.length <= 8) return '••••'
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}

// Шифрование токенов брокеров at-rest (§28: «Токены брокеров — только в зашифрованном
// виде, никогда в логах»). AES-256-GCM: ключ выводится из TOKEN_ENCRYPTION_KEY один раз
// при старте процесса, каждый токен получает свой случайный IV.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const rawKey = process.env.TOKEN_ENCRYPTION_KEY
if (!rawKey) {
  console.warn('[token-crypto] TOKEN_ENCRYPTION_KEY не задан — используется небезопасный ключ для разработки. Не использовать в production.')
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

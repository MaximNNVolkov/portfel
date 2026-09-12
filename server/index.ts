import 'dotenv/config'
import express, { type Request, type Response } from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import multer from 'multer'
import { Pool, types } from 'pg'
import { createWorker } from 'tesseract.js'
import { runMigrations } from './migrations.ts'
import { logError } from './logger.ts'
import { decryptToken, encryptToken, maskToken } from './token-crypto.ts'
import { tinkoffConnector } from './brokers/tinkoff.ts'
import { getCbrRateTable, getMoexLastPrice } from './market-data.ts'
import {
  aggregateByGroup, calculateReturns, resolveAssetGroup,
  type AssetGroup, type EngineContext, type PositionInput,
} from './portfolio-engine.ts'
import { buildRecommendations, type PayoutSnapshot, type PositionSnapshot } from './recommendations.ts'
import {
  deleteOrphanInstrument, deletePayout, deletePayoutsForTransaction, deletePosition,
  deleteTransaction, deleteUserData, ensureAccount, ensurePortfolio, findBrokerConnection,
  findCashPosition, findInstrumentByKey, findPayout, findPortfolio, findPosition,
  findPositionByAccountInstrument, findTransaction, findTransactionByExternalId,
  insertInstrument, insertPayout, insertPosition, insertTransaction,
  listAccounts, listInstruments, listPayouts, listPositions, listSnapshots, listTransactions,
  sumPayouts, sumTransactionCosts, updateBrokerConnectionSync, updateInstrument, updatePayout,
  updatePosition, updatePositionMarketPrice, updatePositionValue, updateTransaction, upsertBrokerConnection, upsertSnapshot,
  withTransaction,
  type AccountType, type AssetGroupType, type DataSource, type Db, type Instrument,
  type ListOptions, type Payout, type PayoutStatus, type PayoutType, type Position,
  type PositionRecord, type Transaction, type TransactionType,
} from './repository.ts'

// DATE OID: return the raw "YYYY-MM-DD" text instead of letting node-pg parse it into a
// JS Date (which JSON.stringify then turns into a full ISO datetime with a time/Z suffix,
// breaking every frontend helper that expects a plain date string).
types.setTypeParser(1082, (value) => value)

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function optionalBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
type Snapshot = { date: string; value: number; invested: number | null }
type User = { id: string; email: string; passwordHash: string; salt: string }

const app = express()
const port = Number(process.env.PORT || 3001)
const databaseUrl = process.env.DATABASE_URL || 'postgresql://portfel:portfel@localhost:5432/portfel'
const db = new Pool({ connectionString: databaseUrl, max: 10 })
const users = new Map<string, User>()
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60 * 1000
const upload = multer({ dest: resolve(process.cwd(), 'server/uploads'), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (_request, file, callback) => callback(null, ['image/png', 'image/jpeg'].includes(file.mimetype)) })

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false })
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много попыток, повторите позже' } })

app.use(helmet())
app.use(express.json())
app.use('/api', apiLimiter)
app.use('/uploads', express.static(resolve(process.cwd(), 'server/uploads')))

// Portfolio Engine (§10) — единственное место расчётов. Сервер только раскладывает
// позиции в вход движка и отдаёт его результат наружу, ничего не считая сам.
const BASE_CURRENCY = 'RUB'

// Курсы ЦБ РФ (§13) подгружаются с кэшем в market-data.ts; без них позиции в валютах,
// отличных от базовой, движок помечает как неоценённые (reason 'no-rate') и не подмешивает
// их в итог нулями (§7.3) — это уже деградация, а не отсутствие функциональности.
async function engineContext(): Promise<EngineContext> {
  return { baseCurrency: BASE_CURRENCY, rates: await getCbrRateTable() }
}

// Машинный ключ группы активов (portfolio.asset_groups.type) ↔ подпись группы, которой
// оперируют движок (§7.2) и интерфейс. В базе хранится ключ, наружу отдаётся подпись.
const GROUP_LABELS: Record<AssetGroupType, AssetGroup> = {
  deposit: 'Вклады', bond: 'Облигации', share: 'Акции', fund: 'Фонды', cash: 'Деньги', other: 'Прочее',
}
const GROUP_TYPES: Record<AssetGroup, AssetGroupType> = {
  'Вклады': 'deposit', 'Облигации': 'bond', 'Акции': 'share', 'Фонды': 'fund', 'Деньги': 'cash', 'Прочее': 'other',
}
const MANUAL_PROVIDER = 'Ручной ввод'

function toGroupType(value: unknown): AssetGroupType {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw in GROUP_LABELS) return raw as AssetGroupType
  return GROUP_TYPES[resolveAssetGroup(typeof value === 'string' ? value : null)]
}
// Тип счёта выводится так же, как при бэкфилле: ручные записи — прочий счёт,
// вклады — банковский, остальное — брокерский (§11 Account).
function accountTypeFor(provider: string, groupType: AssetGroupType): AccountType {
  if (provider === MANUAL_PROVIDER) return 'other'
  if (groupType === 'deposit') return 'bank'
  return 'broker'
}

// Позиция наружу — плоская запись: поля позиции (§11 Position) вместе с параметрами
// её инструмента (§11 Instrument) и названием счёта, чтобы карточка инструмента (§9)
// собиралась одним запросом.
function positionToWire(position: Position) {
  const instrument = position.instrument
  return {
    id: position.id,
    accountId: position.accountId,
    instrumentId: position.instrumentId,
    name: instrument.name,
    type: GROUP_LABELS[instrument.groupType] ?? 'Прочее',
    instrumentType: instrument.instrumentType,
    // Текущая стоимость. null = актуальной цены нет; ноль вместо неё не подставляется (§7.3).
    amount: position.value ?? null,
    invested: position.invested,
    ticker: instrument.ticker ?? '',
    date: position.openedOn ?? '',
    institution: position.account.provider,
    currency: instrument.currency,
    source: position.source,
    isin: instrument.isin,
    issuer: instrument.issuer,
    quantity: position.quantity,
    averagePrice: position.averagePrice,
    currentPrice: position.currentPrice,
    accruedInterest: position.accruedInterest,
    nominal: instrument.nominal,
    couponRate: instrument.couponRate,
    couponDate: instrument.couponDate,
    maturityDate: instrument.maturityDate,
    ofertaDate: instrument.ofertaDate,
    amortization: instrument.amortization,
    rate: instrument.rate,
    effectiveRate: instrument.effectiveRate,
    capitalization: instrument.capitalization,
    termEndDate: instrument.termEndDate,
    interestPayoutFrequency: instrument.interestPayoutFrequency,
    replenishable: instrument.replenishable,
    partialWithdrawal: instrument.partialWithdrawal,
    autoProlongation: instrument.autoProlongation,
  }
}
function instrumentToWire(instrument: Instrument) {
  return { ...instrument, type: GROUP_LABELS[instrument.groupType] ?? 'Прочее' }
}
function transactionToWire(transaction: Transaction) {
  return {
    id: transaction.id,
    type: transaction.type,
    title: transaction.description ?? '',
    amount: transaction.amount,
    date: transaction.date,
    currency: transaction.currency,
    commission: transaction.commission,
    tax: transaction.tax,
    positionId: transaction.positionId,
    instrumentId: transaction.instrumentId,
    accountId: transaction.accountId,
    source: transaction.source,
  }
}
function payoutToWire(payout: Payout) {
  return {
    id: payout.id,
    title: payout.description ?? '',
    amount: payout.amount,
    date: payout.date,
    type: payout.type,
    status: payout.status,
    currency: payout.currency,
    instrumentId: payout.instrumentId,
    accountId: payout.accountId,
    transactionId: payout.transactionId,
  }
}

function toEngineInput(position: Position): PositionInput {
  return {
    id: position.id,
    name: position.instrument.name,
    type: GROUP_LABELS[position.instrument.groupType],
    currency: position.instrument.currency || BASE_CURRENCY,
    invested: position.invested,
    value: position.value ?? null,
    quantity: position.quantity ?? null,
    averagePrice: position.averagePrice ?? null,
    currentPrice: position.currentPrice ?? null,
    accruedInterest: position.accruedInterest ?? null,
  }
}

// Снимок дня (§21) считается по фактическому составу портфеля, поэтому вызывается
// уже после точечной записи и внутри той же транзакции, что и само изменение.
async function recordSnapshot(client: Db, userId: string, date = new Date().toISOString().slice(0, 10)) {
  const portfolio = await findPortfolio(client, userId)
  if (!portfolio) return
  const positions = await listPositions(client, userId)
  if (!positions.length) return
  const aggregate = aggregateByGroup(positions.map(toEngineInput), await engineContext())
  await upsertSnapshot(client, portfolio.id, randomUUID(), date, aggregate.value, aggregate.invested)
}
async function loadUsers() {
  const result = await db.query('SELECT id, email, password_hash as "passwordHash", salt FROM users')
  for (const row of result.rows) {
    users.set(row.id, { id: row.id, email: row.email, passwordHash: row.passwordHash, salt: row.salt })
  }
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}
function listOptions(request: Request): ListOptions | undefined {
  const limit = optionalNumber(request.query.limit)
  const offset = optionalNumber(request.query.offset)
  if (limit === undefined && offset === undefined) return undefined
  return {
    limit: limit !== undefined ? Math.min(Math.max(Math.trunc(limit), 1), 500) : undefined,
    offset: offset !== undefined ? Math.max(Math.trunc(offset), 0) : undefined,
  }
}
function decodeUploadName(value: string) {
  try {
    return Buffer.from(value, 'latin1').toString('utf8')
  } catch {
    return value
  }
}
function normalizeCurrency(value: string): string {
  const normalized = value.trim().toUpperCase()
  if (/RUB|₽|РУБ/.test(normalized)) return 'RUB'
  if (/USD|\$/.test(normalized)) return 'USD'
  if (/EUR|€/.test(normalized)) return 'EUR'
  return 'RUB'
}
function parseNumber(value: string): number {
  const sanitized = value.replace(/\s+/g, '').replace(/ /g, '').replace(/[^\d,.-]/g, '')
  if (!sanitized || sanitized === '-' || sanitized === '.') return 0
  const numeric = sanitized.replace(/,/g, '.')
  const result = Number(numeric)
  return Number.isFinite(result) ? result : 0
}
function inferAssetType(text: string): AssetGroup {
  const haystack = text.toLowerCase()
  if (/(офз|облигац|bond|coupon|coupon)/.test(haystack)) return 'Облигации'
  if (/(акц|share|stock|sber|gazp|yandex|aapl|msft|nvda|tsla)/.test(haystack)) return 'Акции'
  if (/(вклад|депозит|deposit|срок)/.test(haystack)) return 'Вклады'
  if (/(фонд|etf|fund|пай|paй)/.test(haystack)) return 'Фонды'
  if (/(деньг|cash|налич|остаток)/.test(haystack)) return 'Деньги'
  return 'Прочее'
}
function toCandidateName(raw: string): string {
  const cleaned = raw
    .replace(/^(название|инструмент|product|asset|сумма|стоимость|цена)\s*[:\-]*/i, '')
    .replace(/\s*(?:₽|руб|RUB|USD|EUR|%|\d[\d\s.,]*)+$/g, '')
    .replace(/[|•\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return cleaned.slice(0, 120) || 'Распознанный продукт'
}
// §18 дедупликация: единственные поля, которые эвристический OCR-парсер извлекает надёжно —
// название и сумма (без ISIN/тикера/даты погашения/банка) — см. Пункт 14 плана.
function normalizeOcrName(name: string): string {
  return name.trim().toLowerCase()
}
function buildOcrCandidates(text: string) {
  const blocks = text
    .split(/\n|\r|\|\s*\|/)
    .map((line) => line.trim())
    .filter((line) => line.length > 4)

  const candidates: Array<{ name: string; type: AssetGroup; amount: number; invested: number; currency: string; deltaPercent: number; confidence: number; missingFields: string[] }> = []

  for (const block of blocks) {
    const hasNumbers = /\d/.test(block)
    const hasMoney = /(₽|руб|RUB|USD|EUR|\$|€)/i.test(block) || /\d{2,}.*\d{2,}/.test(block)
    if (!hasNumbers || !hasMoney) continue

    const digits = [...block.matchAll(/\d[\d\s.,]{2,}/g)].map((match) => parseNumber(match[0]))
    if (!digits.length) continue

    const amount = digits.filter((value) => value > 0).sort((a, b) => b - a)[0] || 0
    const invested = digits.filter((value) => value > 0 && value !== amount).sort((a, b) => a - b)[0] || amount
    const name = toCandidateName(block)
    const type = inferAssetType(block)
    const currency = normalizeCurrency(block)
    const deltaPercent = amount > 0 && invested > 0 ? ((amount - invested) / invested) * 100 : 0
    const missingFields: string[] = []
    if (!name || name === 'Распознанный продукт') missingFields.push('name')
    if (!(amount > 0)) missingFields.push('amount')
    if (!(invested > 0)) missingFields.push('invested')
    if (type === 'Прочее') missingFields.push('type')

    candidates.push({
      name,
      type,
      amount,
      invested,
      currency,
      deltaPercent,
      confidence: amount > 0 ? 0.7 : 0.4,
      missingFields,
    })
  }

  const unique = candidates.filter((candidate, index, list) => {
    const sameName = list.findIndex((item) => item.name === candidate.name && item.amount === candidate.amount)
    return sameName === index
  })

  if (!unique.length) {
    const amountMatch = text.match(/(?:₽|руб(?:лей|\.)?|RUB|USD|EUR)\s*([\d\s,\.]+)/i) || text.match(/([\d\s]{3,}(?:[.,]\d{1,2})?)\s*(?:₽|руб|RUB|USD|EUR)/i)
    const amount = amountMatch ? parseNumber(amountMatch[1]) : 0
    return [{
      name: toCandidateName(text),
      type: inferAssetType(text),
      amount,
      invested: amount,
      currency: normalizeCurrency(text),
      deltaPercent: 0,
      confidence: amount > 0 ? 0.55 : 0.3,
      missingFields: amount > 0 ? ['invested'] : ['name', 'amount', 'invested'],
    }]
  }

  return unique.sort((a, b) => b.confidence - a.confidence).slice(0, 6)
}
function positiveNumber(value: unknown, field: string): number {
  const result = Number(value)
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${field} must be positive`)
  return result
}
function hashPassword(password: string, salt: string) { return scryptSync(password, salt, 64).toString('hex') }
function authToken(request: Request) { const value = request.headers.authorization; return value?.startsWith('Bearer ') ? value.slice(7) : '' }
function hashToken(token: string) { return createHash('sha256').update(token).digest('hex') }
async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.query('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [randomUUID(), userId, hashToken(token), expiresAt])
  return token
}
async function currentUserId(request: Request, response: Response): Promise<string | undefined> {
  const token = authToken(request)
  const result = token ? await db.query('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > NOW()', [hashToken(token)]) : undefined
  const userId = result?.rows[0]?.user_id as string | undefined
  if (!userId) { response.status(401).json({ error: 'Authentication required' }); return undefined }
  return userId
}

app.post('/api/auth/register', authLimiter, async (request, response) => {
  try {
    const email = requiredText(request.body?.email, 'email').toLowerCase()
    const password = requiredText(request.body?.password, 'password')
    if (password.length < 8) return response.status(400).json({ error: 'Password must contain at least 8 characters' })
    const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email])
    if (existing.rowCount) return response.status(409).json({ error: 'Email already registered' })
    const salt = randomBytes(16).toString('hex'); const user = { id: randomUUID(), email, passwordHash: hashPassword(password, salt), salt }
    await db.query('INSERT INTO users (id, email, password_hash, salt) VALUES ($1, $2, $3, $4)', [user.id, user.email, user.passwordHash, user.salt])
    users.set(user.id, user); const token = await createSession(user.id)
    response.status(201).json({ token, user: { id: user.id, email: user.email } })
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid credentials' }) }
})
app.post('/api/auth/login', authLimiter, async (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.toLowerCase().trim() : ''
  const password = typeof request.body?.password === 'string' ? request.body.password : ''
  const result = await db.query('SELECT id, email, password_hash as "passwordHash", salt FROM users WHERE email = $1', [email])
  const user = result.rows[0] as User | undefined
  if (!user || !timingSafeEqual(Buffer.from(user.passwordHash, 'hex'), Buffer.from(hashPassword(password, user.salt), 'hex'))) return response.status(401).json({ error: 'Invalid email or password' })
  const token = await createSession(user.id); response.json({ token, user: { id: user.id, email: user.email } })
})
app.post('/api/auth/logout', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(authToken(request))])
  response.status(204).send()
})
app.get('/api/auth/me', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  response.json({ authenticated: true, email: users.get(userId)?.email ?? null })
})
app.delete('/api/auth/me', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await withTransaction(db, (client) => deleteUserData(client, userId))
  users.delete(userId)
  response.status(204).send()
})

// §11 BrokerConnection: статус подключения живёт в базе, а не в памяти процесса, иначе
// перезапуск сервера «отключал» бы брокера. Токен хранится только зашифрованным (§28,
// server/token-crypto.ts) — расшифровывается на секунду вызова коннектора и никогда не логируется.
const TINKOFF_PROVIDER = 'Т-Инвестиции'
const BROKER_GROUP_TYPE: Record<'bond' | 'share' | 'fund' | 'deposit' | 'other', AssetGroupType> = {
  bond: 'bond', share: 'share', fund: 'fund', deposit: 'deposit', other: 'other',
}

// Синхронизация (§19): позиции ставятся из ответа брокера целиком (количество/цены/стоимость
// перезаписываются как авторитетные), а не разносятся через applyTransactionEffect — тот
// путь предназначен для ручного/OCR-ввода и задвоил бы результат поверх уже готового снимка
// брокера. Операции добавляются с дедупликацией по external_id, чтобы повторный запуск
// не плодил дубликаты; связанные выплаты заводятся тем же syncPayoutForTransaction,
// что и для ручных операций — у него нет побочных эффектов на позиции.
async function performTinkoffSync(client: Db, userId: string, token: string): Promise<void> {
  const data = await tinkoffConnector.fetchSyncData(token)
  const portfolio = await ensurePortfolio(client, userId, randomUUID())
  const instrumentIdByExternal = new Map<string, string>()

  for (const brokerPosition of data.positions) {
    let instrument = await findInstrumentByKey(client, userId, {
      isin: brokerPosition.instrument.isin, ticker: brokerPosition.instrument.ticker,
    })
    if (!instrument) {
      instrument = {
        id: randomUUID(),
        groupType: BROKER_GROUP_TYPE[brokerPosition.instrument.assetType] ?? 'other',
        instrumentType: brokerPosition.instrument.assetType,
        name: brokerPosition.instrument.name,
        currency: brokerPosition.instrument.currency,
        source: 'broker',
        ticker: brokerPosition.instrument.ticker,
        isin: brokerPosition.instrument.isin,
        nominal: brokerPosition.instrument.nominal,
        maturityDate: brokerPosition.instrument.maturityDate,
        couponRate: brokerPosition.instrument.couponRate,
      }
      await insertInstrument(client, userId, instrument)
    }
    instrumentIdByExternal.set(brokerPosition.instrument.externalId, instrument.id)

    const account = await ensureAccount(client, portfolio.id, randomUUID(), {
      type: 'broker', provider: TINKOFF_PROVIDER, currency: instrument.currency,
    })
    const existing = await findPositionByAccountInstrument(client, userId, account.id, instrument.id)
    const invested = brokerPosition.averagePrice !== null
      ? brokerPosition.averagePrice * brokerPosition.quantity
      : (existing?.invested ?? 0)
    const record: PositionRecord = {
      id: existing?.id ?? randomUUID(),
      accountId: account.id,
      instrumentId: instrument.id,
      quantity: brokerPosition.quantity,
      averagePrice: brokerPosition.averagePrice ?? undefined,
      currentPrice: brokerPosition.currentPrice ?? undefined,
      value: brokerPosition.currentValue ?? undefined,
      invested,
      source: 'broker',
      openedOn: existing?.openedOn,
    }
    if (existing) await updatePosition(client, userId, record)
    else await insertPosition(client, record)
  }

  for (const operation of data.operations) {
    if (await findTransactionByExternalId(client, userId, operation.externalId)) continue
    const account = await ensureAccount(client, portfolio.id, randomUUID(), {
      type: 'broker', provider: TINKOFF_PROVIDER, currency: operation.currency,
    })
    const transaction: Transaction = {
      id: randomUUID(),
      accountId: account.id,
      type: operation.type,
      date: operation.date.slice(0, 10),
      amount: operation.amount,
      currency: operation.currency,
      commission: operation.commission ?? 0,
      tax: 0,
      source: 'broker',
      instrumentId: operation.instrumentExternalId ? instrumentIdByExternal.get(operation.instrumentExternalId) : undefined,
      quantity: operation.quantity,
      price: operation.price,
      description: operation.description,
      externalId: operation.externalId,
    }
    await insertTransaction(client, transaction)
    await syncPayoutForTransaction(client, transaction)
  }

  await recordSnapshot(client, userId)
}

app.get('/api/brokers/tinkoff', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const connection = await findBrokerConnection(db, userId, 'tinkoff')
  if (!connection) return response.json({ provider: 'tinkoff', status: 'disconnected' })
  response.json({
    provider: connection.brokerType,
    status: connection.status,
    maskedToken: connection.tokenMasked,
    connectedAt: connection.createdAt,
    lastSyncAt: connection.lastSyncAt,
    lastError: connection.lastError,
  })
})
app.post('/api/brokers/tinkoff/connect', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const token = requiredText(request.body?.token, 'token')
    const valid = await tinkoffConnector.validateToken(token)
    if (!valid) {
      return response.status(400).json({ error: 'Токен не подошёл. Проверьте, что он скопирован полностью и относится к боевому контуру Т-Инвестиций.' })
    }
    const connection = await upsertBrokerConnection(db, userId, randomUUID(), {
      brokerType: 'tinkoff',
      tokenMasked: maskToken(token),
      encryptedToken: encryptToken(token),
      status: 'connected',
    })
    response.status(200).json({
      provider: connection.brokerType,
      status: connection.status,
      maskedToken: connection.tokenMasked,
      connectedAt: connection.createdAt,
      message: 'Токен подтверждён. Запустите синхронизацию, чтобы загрузить портфель.',
    })
  } catch (error) {
    logError('brokers.tinkoff.connect', error)
    response.status(400).json({ error: 'Не удалось подключить Т-Инвестиции. Проверьте токен и повторите попытку.' })
  }
})
app.post('/api/brokers/tinkoff/sync', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const connection = await findBrokerConnection(db, userId, 'tinkoff')
  if (!connection || !connection.encryptedToken) {
    return response.status(409).json({ error: 'Брокер не подключён. Введите токен на странице интеграций.' })
  }
  try {
    const token = decryptToken(connection.encryptedToken)
    await withTransaction(db, (client) => performTinkoffSync(client, userId, token))
    await updateBrokerConnectionSync(db, userId, 'tinkoff', {
      status: 'connected', lastSyncAt: new Date().toISOString(), lastError: null,
    })
    response.json({ status: 'connected', message: 'Синхронизация завершена.' })
  } catch (error) {
    // §40.2 B/C: ошибка синхронизации не должна стирать ранее загруженные данные — здесь
    // меняется только статус подключения, positions/transactions уже сохранённой части
    // синхронизации из этого withTransaction не применяются целиком (транзакция откатилась),
    // но всё, что было загружено предыдущими успешными запусками, остаётся нетронутым.
    logError('brokers.tinkoff.sync', error)
    await updateBrokerConnectionSync(db, userId, 'tinkoff', {
      status: 'error', lastError: 'Не удалось получить данные от Т-Инвестиций',
    })
    response.status(502).json({ status: 'error', error: 'Не удалось синхронизироваться с Т-Инвестициями. Ранее загруженные данные сохранены.' })
  }
})

// §20: обновление текущей цены акций/фондов по данным MOEX ISS — явное действие
// пользователя (кнопка «Обновить цены»), а не фоновая задача (в проекте нет Celery/Redis,
// см. решение по стеку в начале плана) и не побочный эффект каждого GET (непредсказуемые
// записи в БД на чтении — хуже, чем явная кнопка с понятным результатом).
app.post('/api/market-data/refresh', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const positions = await listPositions(db, userId)
  const eligible = positions.filter((position) =>
    position.source !== 'broker'
    && Boolean(position.quantity)
    && Boolean(position.instrument.ticker)
    && (position.instrument.groupType === 'share' || position.instrument.groupType === 'fund'),
  )
  let updated = 0
  await withTransaction(db, async (client) => {
    for (const position of eligible) {
      const price = await getMoexLastPrice(position.instrument.ticker!)
      if (price === null) continue
      await updatePositionMarketPrice(client, userId, { id: position.id, currentPrice: price, value: price * position.quantity! })
      updated += 1
    }
    if (updated > 0) await recordSnapshot(client, userId)
  })
  response.json({ checked: eligible.length, updated })
})

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'portfolio-api' }))

// ---------------------------------------------------------------------------
// Позиции и инструменты (§8, §9, §11)
// ---------------------------------------------------------------------------

type PositionBody = Record<string, unknown>

function instrumentFromBody(body: PositionBody, id: string, source: DataSource): Instrument {
  const groupType = toGroupType(body.type)
  return {
    id,
    groupType,
    instrumentType: optionalText(body.instrumentType) || groupType,
    name: requiredText(body.name, 'name'),
    currency: optionalText(body.currency) || 'RUB',
    source,
    ticker: optionalText(body.ticker),
    isin: optionalText(body.isin),
    issuer: optionalText(body.issuer),
    nominal: optionalNumber(body.nominal),
    maturityDate: optionalText(body.maturityDate),
    couponRate: optionalNumber(body.couponRate),
    couponDate: optionalText(body.couponDate),
    ofertaDate: optionalText(body.ofertaDate),
    amortization: optionalBool(body.amortization),
    rate: optionalNumber(body.rate),
    effectiveRate: optionalNumber(body.effectiveRate),
    capitalization: optionalBool(body.capitalization),
    termEndDate: optionalText(body.termEndDate),
    interestPayoutFrequency: optionalText(body.interestPayoutFrequency),
    replenishable: optionalBool(body.replenishable),
    partialWithdrawal: optionalBool(body.partialWithdrawal),
    autoProlongation: optionalBool(body.autoProlongation),
  }
}
function mergeInstrument(existing: Instrument, body: PositionBody): Instrument {
  const groupType = body.type !== undefined ? toGroupType(body.type) : existing.groupType
  return {
    ...existing,
    groupType,
    instrumentType: body.instrumentType !== undefined
      ? (optionalText(body.instrumentType) || groupType)
      : (body.type !== undefined ? groupType : existing.instrumentType),
    name: body.name !== undefined ? requiredText(body.name, 'name') : existing.name,
    currency: body.currency !== undefined ? (optionalText(body.currency) || 'RUB') : existing.currency,
    ticker: body.ticker !== undefined ? optionalText(body.ticker) : existing.ticker,
    isin: body.isin !== undefined ? optionalText(body.isin) : existing.isin,
    issuer: body.issuer !== undefined ? optionalText(body.issuer) : existing.issuer,
    nominal: body.nominal !== undefined ? optionalNumber(body.nominal) : existing.nominal,
    maturityDate: body.maturityDate !== undefined ? optionalText(body.maturityDate) : existing.maturityDate,
    couponRate: body.couponRate !== undefined ? optionalNumber(body.couponRate) : existing.couponRate,
    couponDate: body.couponDate !== undefined ? optionalText(body.couponDate) : existing.couponDate,
    ofertaDate: body.ofertaDate !== undefined ? optionalText(body.ofertaDate) : existing.ofertaDate,
    amortization: body.amortization !== undefined ? optionalBool(body.amortization) : existing.amortization,
    rate: body.rate !== undefined ? optionalNumber(body.rate) : existing.rate,
    effectiveRate: body.effectiveRate !== undefined ? optionalNumber(body.effectiveRate) : existing.effectiveRate,
    capitalization: body.capitalization !== undefined ? optionalBool(body.capitalization) : existing.capitalization,
    termEndDate: body.termEndDate !== undefined ? optionalText(body.termEndDate) : existing.termEndDate,
    interestPayoutFrequency: body.interestPayoutFrequency !== undefined ? optionalText(body.interestPayoutFrequency) : existing.interestPayoutFrequency,
    replenishable: body.replenishable !== undefined ? optionalBool(body.replenishable) : existing.replenishable,
    partialWithdrawal: body.partialWithdrawal !== undefined ? optionalBool(body.partialWithdrawal) : existing.partialWithdrawal,
    autoProlongation: body.autoProlongation !== undefined ? optionalBool(body.autoProlongation) : existing.autoProlongation,
  }
}

// Создание позиции — единая точка для ручного ввода (§17) и распознанных со скриншота
// записей (§18): заводит портфель и счёт, если их ещё нет, затем инструмент и позицию.
async function createPosition(client: Db, userId: string, body: PositionBody, source: DataSource): Promise<Position> {
  const instrument = instrumentFromBody(body, randomUUID(), source)
  const value = positiveNumber(body.amount, 'amount')
  const invested = positiveNumber(body.invested ?? body.amount, 'invested')
  const openedOn = requiredText(body.date, 'date')
  const provider = optionalText(body.institution) || MANUAL_PROVIDER

  const portfolio = await ensurePortfolio(client, userId, randomUUID())
  const account = await ensureAccount(client, portfolio.id, randomUUID(), {
    type: accountTypeFor(provider, instrument.groupType),
    provider,
    currency: instrument.currency,
  })
  await insertInstrument(client, userId, instrument)
  const record = {
    id: randomUUID(),
    accountId: account.id,
    instrumentId: instrument.id,
    invested,
    source,
    value,
    quantity: optionalNumber(body.quantity),
    averagePrice: optionalNumber(body.averagePrice),
    currentPrice: optionalNumber(body.currentPrice),
    accruedInterest: optionalNumber(body.accruedInterest),
    openedOn,
  }
  await insertPosition(client, record)
  return {
    ...record,
    instrument,
    account: { id: account.id, type: account.type, provider: account.provider, currency: account.currency },
  }
}

app.get('/api/positions', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const positions = await listPositions(db, userId, listOptions(request))
  response.json(positions.map(positionToWire))
})
app.get('/api/positions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const position = await findPosition(db, userId, request.params.id)
  if (!position) return response.status(404).json({ error: 'Position not found' })
  response.json(positionToWire(position))
})
app.post('/api/positions', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const position = await withTransaction(db, async (client) => {
      const created = await createPosition(client, userId, request.body ?? {}, 'manual')
      await recordSnapshot(client, userId)
      return created
    })
    response.status(201).json(positionToWire(position))
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid position' }) }
})
app.patch('/api/positions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const existing = await findPosition(db, userId, request.params.id)
    if (!existing) return response.status(404).json({ error: 'Position not found' })
    const body = (request.body ?? {}) as PositionBody
    const instrument = mergeInstrument(existing.instrument, body)
    const provider = body.institution !== undefined
      ? (optionalText(body.institution) || MANUAL_PROVIDER)
      : existing.account.provider

    const updated = await withTransaction(db, async (client) => {
      // Счёт определяется парой (учреждение, валюта): если изменилось любое из них,
      // позиция переезжает на соответствующий счёт, заводя его при необходимости.
      const portfolio = await ensurePortfolio(client, userId, randomUUID())
      const account = await ensureAccount(client, portfolio.id, randomUUID(), {
        type: accountTypeFor(provider, instrument.groupType),
        provider,
        currency: instrument.currency,
      })
      const record = {
        id: existing.id,
        accountId: account.id,
        instrumentId: existing.instrumentId,
        invested: body.invested !== undefined ? positiveNumber(body.invested, 'invested') : existing.invested,
        source: existing.source,
        value: body.amount !== undefined ? positiveNumber(body.amount, 'amount') : existing.value,
        quantity: body.quantity !== undefined ? optionalNumber(body.quantity) : existing.quantity,
        averagePrice: body.averagePrice !== undefined ? optionalNumber(body.averagePrice) : existing.averagePrice,
        currentPrice: body.currentPrice !== undefined ? optionalNumber(body.currentPrice) : existing.currentPrice,
        accruedInterest: body.accruedInterest !== undefined ? optionalNumber(body.accruedInterest) : existing.accruedInterest,
        openedOn: body.date !== undefined ? requiredText(body.date, 'date') : existing.openedOn,
      }
      await updateInstrument(client, userId, instrument)
      await updatePosition(client, userId, record)
      await recordSnapshot(client, userId)
      return {
        ...record,
        instrument,
        account: { id: account.id, type: account.type, provider: account.provider, currency: account.currency },
      } satisfies Position
    })
    response.json(positionToWire(updated))
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid position' }) }
})
app.delete('/api/positions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const existing = await findPosition(db, userId, request.params.id)
  if (!existing) return response.status(404).json({ error: 'Position not found' })
  await withTransaction(db, async (client) => {
    await deletePosition(client, userId, existing.id)
    // Инструмент, заведённый вручную или со скриншота, без позиций и истории больше не нужен.
    await deleteOrphanInstrument(client, userId, existing.instrumentId)
    await recordSnapshot(client, userId)
  })
  response.status(204).send()
})

app.get('/api/accounts', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  response.json(await listAccounts(db, userId))
})
app.get('/api/instruments', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const instruments = await listInstruments(db, userId, listOptions(request))
  response.json(instruments.map(instrumentToWire))
})

app.post('/api/ocr/upload', upload.single('image'), async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  if (!request.file) return response.status(400).json({ error: 'Изображение не загружено или имеет неподдерживаемый формат' })
  const filename = decodeUploadName(request.file.originalname)
  const worker = await createWorker('rus+eng')
  try {
    const result = await worker.recognize(request.file.path)
    const text = result.data.text.replace(/\s+/g, ' ').trim()
    const candidates = buildOcrCandidates(text)
    const recognized = candidates.filter((candidate) => candidate.amount > 0 && candidate.name && candidate.name !== 'Распознанный продукт')
    const date = new Date().toISOString().slice(0, 10)
    // §40.4: распознанное сохраняется как есть, без шага подтверждения полей.
    // §18 дедупликация (решено автономно: вариант А — см. план) — совпадение по названию+сумме
    // не блокирует сохранение, а лишь помечается в ответе, чтобы пользователь заметил его сам
    // на экране-сводке (что и так требуется читать по §40.4).
    const duplicateFlags: boolean[] = []
    const created = recognized.length
      ? await withTransaction(db, async (client) => {
          const existing = await listPositions(client, userId)
          const knownAmounts = new Map<string, number>(
            existing.map((position) => [normalizeOcrName(position.instrument.name), position.value ?? position.invested]),
          )
          const positions: Position[] = []
          for (const candidate of recognized) {
            const key = normalizeOcrName(candidate.name)
            const knownAmount = knownAmounts.get(key)
            duplicateFlags.push(knownAmount !== undefined && Math.abs(knownAmount - candidate.amount) < 0.01)
            const position = await createPosition(client, userId, {
              name: candidate.name,
              type: candidate.type,
              amount: candidate.amount,
              invested: candidate.invested > 0 ? candidate.invested : candidate.amount,
              date,
              institution: 'Проверьте источник',
              currency: candidate.currency,
            }, 'ocr')
            positions.push(position)
            knownAmounts.set(key, position.value ?? position.invested)
          }
          await recordSnapshot(client, userId)
          return positions
        })
      : []
    const unrecognizedCount = candidates.length - recognized.length
    const failures = unrecognizedCount > 0
      ? [{
          filename,
          reason: created.length === 0
            ? 'Не удалось распознать данные на изображении'
            : `Не удалось распознать ${unrecognizedCount} из ${candidates.length} позиций`,
        }]
      : []
    const items = created.map((position, index) => ({ ...positionToWire(position), possibleDuplicate: duplicateFlags[index] }))
    response.status(created.length ? 201 : 200).json({ date, items, failures })
  } finally {
    await worker.terminate()
    await unlink(request.file.path).catch(() => undefined)
  }
})

app.get('/api/portfolio/summary', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const positions = await listPositions(db, userId)
  const [payouts, costs, context] = await Promise.all([sumPayouts(db, userId), sumTransactionCosts(db, userId), engineContext()])
  const portfolio = aggregateByGroup(positions.map(toEngineInput), context)
  const returns = calculateReturns({
    currentValue: portfolio.value,
    invested: portfolio.invested,
    payoutsReceived: payouts.received,
    commissions: costs.commissions,
    taxes: costs.taxes,
  })
  response.json({
    total: portfolio.value,
    invested: portfolio.invested,
    profit: portfolio.pnl,
    profitPercent: portfolio.pnlPercent,
    expected: payouts.expected,
    paid: payouts.received,
    positions: positions.length,
    baseCurrency: portfolio.baseCurrency,
    // §10.6: изменение стоимости + выплаты − комиссии − налоги, и простая доходность к нему.
    financialResult: returns.financialResult,
    returnPercent: returns.returnPercent,
    returnMethod: returns.method,
    commissions: returns.commissions,
    taxes: returns.taxes,
    groups: portfolio.groups,
    // §7.3 / §40.2: итог неполный — UI обязан пометить это, а не показывать цифру как точную.
    valuation: { incomplete: portfolio.valuationIncomplete, unavailable: portfolio.unavailable },
  })
})
app.get('/api/portfolio/history', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await withTransaction(db, (client) => recordSnapshot(client, userId))
  const snapshots: Snapshot[] = await listSnapshots(db, userId)
  response.json(snapshots)
})

// §24 (Этап 5): 4 базовых правила рекомендаций. Считаются на лету из текущего состояния
// портфеля — как и /api/portfolio/summary, а не персистятся (см. обоснование в recommendations.ts).
app.get('/api/recommendations', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const [positions, payouts, context] = await Promise.all([listPositions(db, userId), listPayouts(db, userId), engineContext()])
  const aggregate = aggregateByGroup(positions.map(toEngineInput), context)
  const valuationById = new Map(aggregate.positions.map((valuation) => [valuation.id, valuation]))
  const positionSnapshots: PositionSnapshot[] = positions.map((position) => {
    const valuation = valuationById.get(position.id)
    return {
      id: position.id,
      name: position.instrument.name,
      group: valuation?.group ?? GROUP_LABELS[position.instrument.groupType] ?? 'Прочее',
      issuer: position.instrument.issuer,
      maturityDate: position.instrument.maturityDate,
      valueBase: valuation?.valueBase ?? null,
      pnlPercent: valuation?.pnlPercent ?? null,
    }
  })
  const payoutSnapshots: PayoutSnapshot[] = payouts.map((payout) => ({ date: payout.date, amount: payout.amount, status: payout.status }))
  response.json(buildRecommendations(positionSnapshots, aggregate.value, payoutSnapshots))
})

// ---------------------------------------------------------------------------
// Выплаты (§22)
// ---------------------------------------------------------------------------

const PAYOUT_TYPES: PayoutType[] = ['COUPON', 'DIVIDEND', 'INTEREST', 'DEPOSIT_PRINCIPAL', 'REDEMPTION', 'OTHER']
const PAYOUT_STATUSES: PayoutStatus[] = ['expected', 'received']

function payoutType(value: unknown, fallback: PayoutType): PayoutType {
  const raw = optionalText(value)?.toUpperCase()
  if (!raw) return fallback
  if (!PAYOUT_TYPES.includes(raw as PayoutType)) throw new Error('Unsupported payout type')
  return raw as PayoutType
}
function payoutStatus(value: unknown, fallback: PayoutStatus): PayoutStatus {
  const raw = optionalText(value)?.toLowerCase()
  if (!raw) return fallback
  if (!PAYOUT_STATUSES.includes(raw as PayoutStatus)) throw new Error('Unsupported payout status')
  return raw as PayoutStatus
}
// Счёт для записей, не привязанных к конкретной позиции (выплата заведена вручную).
async function defaultAccountId(client: Db, userId: string, currency = 'RUB'): Promise<string> {
  const cash = await findCashPosition(client, userId)
  if (cash) return cash.accountId
  const portfolio = await ensurePortfolio(client, userId, randomUUID())
  const account = await ensureAccount(client, portfolio.id, randomUUID(), { type: 'other', provider: MANUAL_PROVIDER, currency })
  return account.id
}

app.get('/api/payouts', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const payouts = await listPayouts(db, userId, listOptions(request))
  response.json(payouts.map(payoutToWire))
})
app.post('/api/payouts', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const body = (request.body ?? {}) as PositionBody
    const title = requiredText(body.title, 'title')
    const amount = positiveNumber(body.amount, 'amount')
    const date = requiredText(body.date, 'date')
    const type = payoutType(body.type, 'OTHER')
    const status = payoutStatus(body.status, 'expected')
    const payout = await withTransaction(db, async (client) => {
      const position = optionalText(body.positionId) ? await findPosition(client, userId, String(body.positionId)) : undefined
      const record: Payout = {
        id: randomUUID(),
        accountId: position?.accountId ?? await defaultAccountId(client, userId),
        instrumentId: position?.instrumentId,
        date,
        type,
        amount,
        currency: position?.instrument.currency ?? 'RUB',
        status,
        description: title,
      }
      await insertPayout(client, record)
      return record
    })
    response.status(201).json(payoutToWire(payout))
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid payout' }) }
})
app.patch('/api/payouts/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const existing = await findPayout(db, userId, request.params.id)
    if (!existing) return response.status(404).json({ error: 'Payout not found' })
    const body = (request.body ?? {}) as PositionBody
    const updated: Payout = {
      ...existing,
      description: body.title !== undefined ? requiredText(body.title, 'title') : existing.description,
      amount: body.amount !== undefined ? positiveNumber(body.amount, 'amount') : existing.amount,
      date: body.date !== undefined ? requiredText(body.date, 'date') : existing.date,
      type: body.type !== undefined ? payoutType(body.type, existing.type) : existing.type,
      status: body.status !== undefined ? payoutStatus(body.status, existing.status) : existing.status,
    }
    await updatePayout(db, userId, updated)
    response.json(payoutToWire(updated))
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid payout' }) }
})
app.delete('/api/payouts/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  if (!(await deletePayout(db, userId, request.params.id))) return response.status(404).json({ error: 'Payout not found' })
  response.status(204).send()
})

// ---------------------------------------------------------------------------
// Операции (§11 Transaction)
// ---------------------------------------------------------------------------

const TRANSACTION_TYPES: TransactionType[] = ['BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'COUPON', 'DIVIDEND', 'INTEREST', 'FEE', 'TAX', 'REDEMPTION', 'OTHER']
// Операции, деньги по которым зачисляются на денежную позицию или списываются с неё (§12).
const CASH_CREDIT: TransactionType[] = ['DEPOSIT', 'COUPON', 'DIVIDEND', 'INTEREST', 'REDEMPTION']
const CASH_DEBIT: TransactionType[] = ['WITHDRAW', 'FEE', 'TAX']
const POSITION_TYPES: TransactionType[] = ['BUY', 'SELL']
// Операции, которые одновременно являются полученной выплатой и попадают в календарь (§22).
const PAYOUT_BY_TRANSACTION: Partial<Record<TransactionType, PayoutType>> = {
  COUPON: 'COUPON', DIVIDEND: 'DIVIDEND', INTEREST: 'INTEREST', REDEMPTION: 'REDEMPTION',
}

function transactionType(value: unknown): TransactionType {
  const raw = requiredText(value, 'type').toUpperCase()
  if (!TRANSACTION_TYPES.includes(raw as TransactionType)) throw new Error('Unsupported transaction type')
  return raw as TransactionType
}

// Позиции, затронутые одной операцией. Откат старого эффекта и применение нового
// обязаны попасть в один и тот же объект в памяти (иначе вторая запись затрёт первую),
// поэтому позиции кэшируются по id, а в БД уходят одним UPDATE на позицию в flush().
function createPositionCache(client: Db, userId: string) {
  const loaded = new Map<string, Position>()
  const touched = new Set<string>()
  let cashId: string | null | undefined
  return {
    async byId(id: string): Promise<Position | undefined> {
      const cached = loaded.get(id)
      if (cached) return cached
      const position = await findPosition(client, userId, id)
      if (position) loaded.set(id, position)
      return position
    },
    // Денежная позиция, на которую ложатся пополнения и выплаты (§12).
    async cash(): Promise<Position | undefined> {
      if (cashId === undefined) {
        const position = await findCashPosition(client, userId)
        cashId = position ? position.id : null
        if (position && !loaded.has(position.id)) loaded.set(position.id, position)
      }
      return cashId ? loaded.get(cashId) : undefined
    },
    mark(position: Position) { touched.add(position.id) },
    async flush() {
      for (const id of touched) {
        const position = loaded.get(id)
        if (position) await updatePositionValue(client, userId, position)
      }
    },
  }
}
type PositionCache = ReturnType<typeof createPositionCache>

// Стоимость меняется только у позиции, у которой она вообще известна: позиция без цены
// остаётся неоценённой, а не получает выдуманную сумму (§7.3).
function shiftPosition(position: Position, delta: number) {
  if (position.value !== undefined) position.value = position.value + delta
  position.invested = Math.max(0, position.invested + delta)
}

async function applyTransactionEffect(positions: PositionCache, transaction: Pick<Transaction, 'type' | 'amount' | 'positionId'>, direction: 1 | -1) {
  const amount = transaction.amount * direction
  const position = transaction.positionId ? await positions.byId(transaction.positionId) : undefined
  if (transaction.type === 'BUY' && position) { shiftPosition(position, amount); positions.mark(position) }
  if (transaction.type === 'SELL' && position) { shiftPosition(position, -amount); positions.mark(position) }
  // Выплата зачисляется на денежную позицию вместе с вложенной суммой: сам доход уже
  // учтён в финансовом результате как полученные выплаты (§10.3, §10.6), и рост остатка
  // не должен посчитать его второй раз как прибыль денежной позиции.
  if (CASH_CREDIT.includes(transaction.type)) {
    const cash = await positions.cash()
    if (cash) { shiftPosition(cash, amount); positions.mark(cash) }
  }
  if (CASH_DEBIT.includes(transaction.type)) {
    const cash = await positions.cash()
    if (cash) { shiftPosition(cash, -amount); positions.mark(cash) }
  }
}

// Полученная выплата (купон, дивиденд, проценты, погашение) попадает и в операции, и в
// календарь выплат (§22): календарная запись создаётся вместе с операцией и живёт ровно
// столько же, поэтому в сводке она считается один раз.
async function syncPayoutForTransaction(client: Db, transaction: Transaction) {
  await deletePayoutsForTransaction(client, transaction.id)
  const type = PAYOUT_BY_TRANSACTION[transaction.type]
  if (!type) return
  await insertPayout(client, {
    id: randomUUID(),
    accountId: transaction.accountId,
    instrumentId: transaction.instrumentId,
    transactionId: transaction.id,
    date: transaction.date,
    type,
    amount: transaction.amount,
    currency: transaction.currency,
    status: 'received',
    description: transaction.description,
  })
}

async function buildTransaction(client: Db, userId: string, id: string, body: PositionBody, existing?: Transaction): Promise<Transaction> {
  const type = body.type !== undefined || !existing ? transactionType(body.type) : existing.type
  const amount = body.amount !== undefined || !existing ? positiveNumber(body.amount, 'amount') : existing.amount
  const date = body.date !== undefined || !existing ? requiredText(body.date, 'date') : existing.date
  const description = body.title !== undefined ? optionalText(body.title) : existing?.description
  // Операции с деньгами не привязаны к инструменту: они меняют денежную позицию (§12).
  const positionId = POSITION_TYPES.includes(type)
    ? (body.positionId !== undefined ? optionalText(body.positionId) : existing?.positionId)
    : undefined
  const position = positionId ? await findPosition(client, userId, positionId) : undefined
  if (POSITION_TYPES.includes(type) && !position) throw new Error('positionId is required for BUY or SELL')

  return {
    id,
    accountId: position?.accountId ?? existing?.accountId ?? await defaultAccountId(client, userId),
    instrumentId: position?.instrumentId,
    positionId: position?.id,
    type,
    date,
    amount,
    currency: position?.instrument.currency ?? existing?.currency ?? 'RUB',
    commission: optionalNumber(body.commission) ?? existing?.commission ?? 0,
    tax: optionalNumber(body.tax) ?? existing?.tax ?? 0,
    description: description ?? type,
    source: existing?.source ?? 'manual',
  }
}

app.get('/api/transactions', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const transactions = await listTransactions(db, userId, listOptions(request))
  response.json(transactions.map(transactionToWire))
})
app.post('/api/transactions', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const transaction = await withTransaction(db, async (client) => {
      const created = await buildTransaction(client, userId, randomUUID(), (request.body ?? {}) as PositionBody)
      const positions = createPositionCache(client, userId)
      const position = created.positionId ? await positions.byId(created.positionId) : undefined
      if (created.type === 'SELL' && position && (position.value ?? 0) < created.amount) throw new Error('Sale exceeds current position')
      await applyTransactionEffect(positions, created, 1)
      await positions.flush()
      await insertTransaction(client, created)
      await syncPayoutForTransaction(client, created)
      await recordSnapshot(client, userId)
      return created
    })
    response.status(201).json(transactionToWire(transaction))
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid transaction' }) }
})
app.patch('/api/transactions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const existing = await findTransaction(db, userId, request.params.id)
    if (!existing) return response.status(404).json({ error: 'Transaction not found' })
    const updated = await withTransaction(db, async (client) => {
      const next = await buildTransaction(client, userId, existing.id, (request.body ?? {}) as PositionBody, existing)
      const positions = createPositionCache(client, userId)
      // Сначала снимаем эффект прежней версии операции, потом проверяем и накладываем новую;
      // при ошибке транзакция откатывается, поэтому возвращать эффект вручную не нужно.
      await applyTransactionEffect(positions, existing, -1)
      const position = next.positionId ? await positions.byId(next.positionId) : undefined
      if (next.type === 'SELL' && position && (position.value ?? 0) < next.amount) throw new Error('Sale exceeds current position')
      await applyTransactionEffect(positions, next, 1)
      await positions.flush()
      await updateTransaction(client, userId, next)
      await syncPayoutForTransaction(client, next)
      await recordSnapshot(client, userId)
      return next
    })
    response.json(transactionToWire(updated))
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid transaction' }) }
})
app.delete('/api/transactions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const existing = await findTransaction(db, userId, request.params.id)
  if (!existing) return response.status(404).json({ error: 'Transaction not found' })
  await withTransaction(db, async (client) => {
    const positions = createPositionCache(client, userId)
    await applyTransactionEffect(positions, existing, -1)
    await positions.flush()
    await deletePayoutsForTransaction(client, existing.id)
    await deleteTransaction(client, userId, existing.id)
    await recordSnapshot(client, userId)
  })
  response.status(204).send()
})

app.use((error: Error, request: Request, response: Response, _next: express.NextFunction) => {
  logError(`${request.method} ${request.path}`, error)
  response.status(500).json({ error: 'Внутренняя ошибка сервера' })
})
async function bootstrap() {
  try {
    await db.query('SELECT 1')
    await runMigrations(db)
    await loadUsers()
    app.listen(port, () => console.log(`Portfolio API listening on http://localhost:${port}`))
  } catch (error) {
    logError('bootstrap', error)
    process.exit(1)
  }
}

void bootstrap()

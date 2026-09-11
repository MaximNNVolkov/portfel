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
import { aggregateByGroup, calculateReturns, type EngineContext, type PositionInput } from './portfolio-engine.ts'
import {
  deletePayment, deleteProduct, deleteTransaction, deleteUserData,
  findCashProduct, findPayment, findProduct, findTransaction,
  insertPayment, insertProduct, insertTransaction,
  listPayments, listProducts, listSnapshots, listTransactions, loadStore,
  updatePayment, updateProduct, updateProductPosition, updateTransaction,
  upsertSnapshot, withTransaction,
  type Db, type Payment, type Product, type Store, type Transaction,
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
type AssetType = 'Облигации' | 'Акции' | 'Вклады' | 'Фонды' | 'Деньги' | 'Прочее'
type Snapshot = { date: string; value: number }
type User = { id: string; email: string; passwordHash: string; salt: string }
type BrokerConnection = { provider: 'tinkoff'; connectedAt: string; maskedToken: string; status: 'connected' | 'pending' }

const app = express()
const port = Number(process.env.PORT || 3001)
const databaseUrl = process.env.DATABASE_URL || 'postgresql://portfel:portfel@localhost:5432/portfel'
const db = new Pool({ connectionString: databaseUrl, max: 10 })
const users = new Map<string, User>()
const brokerConnections = new Map<string, BrokerConnection>()
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60 * 1000
const upload = multer({ dest: resolve(process.cwd(), 'server/uploads'), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (_request, file, callback) => callback(null, ['image/png', 'image/jpeg'].includes(file.mimetype)) })

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false })
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много попыток, повторите позже' } })

app.use(helmet())
app.use(express.json())
app.use('/api', apiLimiter)
app.use('/uploads', express.static(resolve(process.cwd(), 'server/uploads')))

// Portfolio Engine (§10) — единственное место расчётов. Сервер только раскладывает
// продукты в вход движка и отдаёт его результат наружу, ничего не считая сам.
//
// Таблица курсов на MVP ещё не подключена (источник — ЦБ РФ, §13), поэтому позиции
// в валютах, отличных от базовой, движок помечает как неоценённые (reason 'no-rate')
// и не подмешивает их в итог нулями (§7.3). Как только появится загрузчик курсов,
// его результат передаётся сюда через поле rates — остальной код не меняется.
const ENGINE_CONTEXT: EngineContext = { baseCurrency: 'RUB' }

function toPosition(product: Product): PositionInput {
  return {
    id: product.id,
    name: product.name,
    type: product.type,
    currency: product.currency || ENGINE_CONTEXT.baseCurrency,
    invested: product.invested,
    value: product.amount,
    quantity: product.quantity ?? null,
    averagePrice: product.averagePrice ?? null,
    currentPrice: product.currentPrice ?? null,
    accruedInterest: product.accruedInterest ?? null,
  }
}

function evaluateStore(store: Store) {
  const portfolio = aggregateByGroup(store.products.map(toPosition), ENGINE_CONTEXT)
  const expected = store.payments.reduce((sum, item) => sum + item.amount, 0)
  const paid = store.transactions.filter((item) => item.kind === 'Выплата').reduce((sum, item) => sum + item.amount, 0)
  // Комиссии и налоги (§10.4, §10.5) появятся вместе с соответствующими типами операций —
  // движок их уже принимает, пока источника данных нет.
  const returns = calculateReturns({ currentValue: portfolio.value, invested: portfolio.invested, payoutsReceived: paid })
  return { portfolio, returns, expected, paid }
}

// Снимок дня (§21) считается по фактическому составу портфеля, поэтому вызывается
// уже после точечной записи и внутри той же транзакции, что и само изменение.
async function recordSnapshot(client: Db, userId: string, date = new Date().toISOString().slice(0, 10)) {
  const products = await listProducts(client, userId)
  if (!products.length) return
  const value = aggregateByGroup(products.map(toPosition), ENGINE_CONTEXT).value
  await upsertSnapshot(client, userId, randomUUID(), date, value)
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
  const sanitized = value.replace(/\s+/g, '').replace(/\u00A0/g, '').replace(/[^\d,.-]/g, '')
  if (!sanitized || sanitized === '-' || sanitized === '.') return 0
  const numeric = sanitized.replace(/,/g, '.')
  const result = Number(numeric)
  return Number.isFinite(result) ? result : 0
}
function inferAssetType(text: string): AssetType {
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
function buildOcrCandidates(text: string) {
  const blocks = text
    .split(/\n|\r|\|\s*\|/)
    .map((line) => line.trim())
    .filter((line) => line.length > 4)

  const candidates: Array<{ name: string; type: AssetType; amount: number; invested: number; currency: string; deltaPercent: number; confidence: number; missingFields: string[] }> = []

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
app.get('/api/auth/me', async (request, response) => { if (!(await currentUserId(request, response))) return; response.json({ authenticated: true }) })
app.delete('/api/auth/me', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await withTransaction(db, (client) => deleteUserData(client, userId))
  users.delete(userId)
  brokerConnections.delete(userId)
  response.status(204).send()
})
app.get('/api/brokers/tinkoff', async (request, response) => { const userId = await currentUserId(request, response); if (!userId) return; response.json(brokerConnections.get(userId) || { status: 'disconnected', provider: 'tinkoff' }) })
app.post('/api/brokers/tinkoff/connect', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const token = requiredText(request.body?.token, 'token')
  const connection: BrokerConnection = { provider: 'tinkoff', connectedAt: new Date().toISOString(), maskedToken: `${token.slice(0, 4)}••••${token.slice(-4)}`, status: 'pending' }
  brokerConnections.set(userId, connection)
  response.status(202).json({ ...connection, message: 'Токен принят. Синхронизация будет запущена после настройки Tinkoff Invest API.' })
})
app.post('/api/brokers/tinkoff/sync', async (request, response) => { const userId = await currentUserId(request, response); if (!userId) return; const connection = brokerConnections.get(userId); if (!connection) return response.status(409).json({ error: 'Broker is not connected' }); response.status(202).json({ status: 'pending', message: 'Синхронизация ожидает подключения провайдера рыночных данных.' }) })

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'portfolio-api' }))
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
    const created: Product[] = recognized.map((candidate) => ({
      id: randomUUID(),
      name: candidate.name,
      type: candidate.type,
      amount: candidate.amount,
      invested: candidate.invested > 0 ? candidate.invested : candidate.amount,
      ticker: '',
      date,
      institution: 'Проверьте источник',
      currency: candidate.currency,
      source: 'ocr',
    }))
    if (created.length) {
      await withTransaction(db, async (client) => {
        for (const product of created) await insertProduct(client, userId, product)
        await recordSnapshot(client, userId)
      })
    }
    const unrecognizedCount = candidates.length - recognized.length
    const failures = unrecognizedCount > 0
      ? [{
          filename,
          reason: created.length === 0
            ? 'Не удалось распознать данные на изображении'
            : `Не удалось распознать ${unrecognizedCount} из ${candidates.length} позиций`,
        }]
      : []
    response.status(created.length ? 201 : 200).json({ date, items: created, failures })
  } finally {
    await worker.terminate()
    await unlink(request.file.path).catch(() => undefined)
  }
})
app.get('/api/portfolio/summary', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const store = await loadStore(db, userId)
  const { portfolio, returns, expected, paid } = evaluateStore(store)
  response.json({
    total: portfolio.value,
    invested: portfolio.invested,
    profit: portfolio.pnl,
    profitPercent: portfolio.pnlPercent,
    expected,
    paid,
    products: store.products.length,
    baseCurrency: portfolio.baseCurrency,
    // §10.6: изменение стоимости + выплаты − комиссии − налоги, и простая доходность к нему.
    financialResult: returns.financialResult,
    returnPercent: returns.returnPercent,
    returnMethod: returns.method,
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

app.get('/api/products', async (request, response) => { const userId = await currentUserId(request, response); if (!userId) return; response.json(await listProducts(db, userId)) })
app.post('/api/products', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const body = request.body as Partial<Product>
    const product: Product = {
      id: randomUUID(), name: requiredText(body.name, 'name'), type: requiredText(body.type, 'type'),
      amount: positiveNumber(body.amount, 'amount'), invested: positiveNumber(body.invested ?? body.amount, 'invested'),
      ticker: typeof body.ticker === 'string' ? body.ticker.trim() : '', date: requiredText(body.date, 'date'),
      institution: typeof body.institution === 'string' ? body.institution.trim() : 'Ручной ввод', currency: typeof body.currency === 'string' ? body.currency : 'RUB',
      source: 'manual',
      isin: optionalText(body.isin), quantity: optionalNumber(body.quantity), averagePrice: optionalNumber(body.averagePrice), currentPrice: optionalNumber(body.currentPrice),
      nominal: optionalNumber(body.nominal), accruedInterest: optionalNumber(body.accruedInterest), couponRate: optionalNumber(body.couponRate),
      couponDate: optionalText(body.couponDate), maturityDate: optionalText(body.maturityDate), ofertaDate: optionalText(body.ofertaDate), amortization: optionalBool(body.amortization),
      rate: optionalNumber(body.rate), effectiveRate: optionalNumber(body.effectiveRate), capitalization: optionalBool(body.capitalization),
      termEndDate: optionalText(body.termEndDate), interestPayoutFrequency: optionalText(body.interestPayoutFrequency),
      replenishable: optionalBool(body.replenishable), partialWithdrawal: optionalBool(body.partialWithdrawal), autoProlongation: optionalBool(body.autoProlongation),
    }
    await withTransaction(db, async (client) => {
      await insertProduct(client, userId, product)
      await recordSnapshot(client, userId)
    })
    response.status(201).json(product)
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid product' }) }
})
app.patch('/api/products/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const existing = await findProduct(db, userId, request.params.id)
    if (!existing) return response.status(404).json({ error: 'Product not found' })
    const body = request.body as Partial<Product>
    const updated: Product = {
      ...existing,
      name: body.name !== undefined ? requiredText(body.name, 'name') : existing.name,
      type: body.type !== undefined ? requiredText(body.type, 'type') : existing.type,
      amount: body.amount !== undefined ? positiveNumber(body.amount, 'amount') : existing.amount,
      invested: body.invested !== undefined ? positiveNumber(body.invested, 'invested') : existing.invested,
      ticker: body.ticker !== undefined ? String(body.ticker).trim() : existing.ticker,
      date: body.date !== undefined ? requiredText(body.date, 'date') : existing.date,
      institution: body.institution !== undefined ? (String(body.institution).trim() || 'Ручной ввод') : existing.institution,
      currency: body.currency !== undefined ? String(body.currency) : existing.currency,
      isin: body.isin !== undefined ? optionalText(body.isin) : existing.isin,
      quantity: body.quantity !== undefined ? optionalNumber(body.quantity) : existing.quantity,
      averagePrice: body.averagePrice !== undefined ? optionalNumber(body.averagePrice) : existing.averagePrice,
      currentPrice: body.currentPrice !== undefined ? optionalNumber(body.currentPrice) : existing.currentPrice,
      nominal: body.nominal !== undefined ? optionalNumber(body.nominal) : existing.nominal,
      accruedInterest: body.accruedInterest !== undefined ? optionalNumber(body.accruedInterest) : existing.accruedInterest,
      couponRate: body.couponRate !== undefined ? optionalNumber(body.couponRate) : existing.couponRate,
      couponDate: body.couponDate !== undefined ? optionalText(body.couponDate) : existing.couponDate,
      maturityDate: body.maturityDate !== undefined ? optionalText(body.maturityDate) : existing.maturityDate,
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
    await withTransaction(db, async (client) => {
      await updateProduct(client, userId, updated)
      await recordSnapshot(client, userId)
    })
    response.json(updated)
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid product' }) }
})
app.delete('/api/products/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const removed = await withTransaction(db, async (client) => {
    if (!(await deleteProduct(client, userId, request.params.id))) return false
    await recordSnapshot(client, userId)
    return true
  })
  if (!removed) return response.status(404).json({ error: 'Product not found' })
  response.status(204).send()
})

app.get('/api/payments', async (request, response) => { const userId = await currentUserId(request, response); if (!userId) return; response.json(await listPayments(db, userId)) })
app.post('/api/payments', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const body = request.body as Partial<Payment>
    const payment: Payment = { id: randomUUID(), title: requiredText(body.title, 'title'), amount: positiveNumber(body.amount, 'amount'), date: requiredText(body.date, 'date'), type: requiredText(body.type || 'Прочее', 'type') }
    await insertPayment(db, userId, payment); response.status(201).json(payment)
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid payment' }) }
})
app.patch('/api/payments/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const existing = await findPayment(db, userId, request.params.id)
    if (!existing) return response.status(404).json({ error: 'Payment not found' })
    const body = request.body as Partial<Payment>
    const updated: Payment = {
      ...existing,
      title: body.title !== undefined ? requiredText(body.title, 'title') : existing.title,
      amount: body.amount !== undefined ? positiveNumber(body.amount, 'amount') : existing.amount,
      date: body.date !== undefined ? requiredText(body.date, 'date') : existing.date,
      type: body.type !== undefined ? requiredText(body.type, 'type') : existing.type,
    }
    await updatePayment(db, userId, updated); response.json(updated)
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid payment' }) }
})
app.delete('/api/payments/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  if (!(await deletePayment(db, userId, request.params.id))) return response.status(404).json({ error: 'Payment not found' })
  response.status(204).send()
})

// Позиции, затронутые одной операцией. Откат старого эффекта и применение нового
// обязаны попасть в один и тот же объект в памяти (иначе вторая запись затрёт первую),
// поэтому продукты кэшируются по id, а в БД уходят одним UPDATE на позицию в flush().
function createPositionCache(client: Db, userId: string) {
  const loaded = new Map<string, Product>()
  const touched = new Set<string>()
  let cashId: string | null | undefined
  return {
    async byId(id: string): Promise<Product | undefined> {
      const cached = loaded.get(id)
      if (cached) return cached
      const product = await findProduct(client, userId, id)
      if (product) loaded.set(id, product)
      return product
    },
    // Денежный счёт, на который ложатся пополнения и выплаты (§12).
    async cash(): Promise<Product | undefined> {
      if (cashId === undefined) {
        const product = await findCashProduct(client, userId)
        cashId = product ? product.id : null
        if (product && !loaded.has(product.id)) loaded.set(product.id, product)
      }
      return cashId ? loaded.get(cashId) : undefined
    },
    mark(product: Product) { touched.add(product.id) },
    async flush() {
      for (const id of touched) {
        const product = loaded.get(id)
        if (product) await updateProductPosition(client, userId, product)
      }
    },
  }
}
type PositionCache = ReturnType<typeof createPositionCache>

async function applyTransactionEffect(positions: PositionCache, transaction: Pick<Transaction, 'kind' | 'amount' | 'productId'>, direction: 1 | -1) {
  const amount = transaction.amount * direction
  const product = transaction.productId ? await positions.byId(transaction.productId) : undefined
  if (transaction.kind === 'Покупка' && product) { product.amount += amount; product.invested += amount; positions.mark(product) }
  if (transaction.kind === 'Продажа' && product) { product.amount -= amount; product.invested = Math.max(0, product.invested - amount); positions.mark(product) }
  if (transaction.kind === 'Пополнение' || transaction.kind === 'Выплата') {
    const cash = await positions.cash()
    if (cash) { cash.amount += amount; cash.invested += amount; positions.mark(cash) }
  }
}

app.get('/api/transactions', async (request, response) => { const userId = await currentUserId(request, response); if (!userId) return; response.json(await listTransactions(db, userId)) })
app.post('/api/transactions', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const body = request.body as Partial<Transaction>
    const kind = requiredText(body.kind, 'kind')
    if (!['Пополнение', 'Покупка', 'Продажа', 'Выплата'].includes(kind)) throw new Error('Unsupported transaction kind')
    const amount = positiveNumber(body.amount, 'amount')
    const transaction: Transaction = { id: randomUUID(), title: requiredText(body.title, 'title'), amount, date: requiredText(body.date, 'date'), kind, productId: body.productId }
    await withTransaction(db, async (client) => {
      const positions = createPositionCache(client, userId)
      const product = transaction.productId ? await positions.byId(transaction.productId) : undefined
      if (['Покупка', 'Продажа'].includes(kind) && !product) throw new Error('productId is required for buy or sell')
      if (kind === 'Продажа' && product && product.amount < amount) throw new Error('Sale exceeds current position')
      await applyTransactionEffect(positions, transaction, 1)
      await positions.flush()
      await insertTransaction(client, userId, transaction)
      await recordSnapshot(client, userId)
    })
    response.status(201).json(transaction)
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid transaction' }) }
})
app.patch('/api/transactions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const existing = await findTransaction(db, userId, request.params.id)
    if (!existing) return response.status(404).json({ error: 'Transaction not found' })
    const body = request.body as Partial<Transaction>
    const kind = body.kind !== undefined ? requiredText(body.kind, 'kind') : existing.kind
    if (!['Пополнение', 'Покупка', 'Продажа', 'Выплата'].includes(kind)) throw new Error('Unsupported transaction kind')
    const amount = body.amount !== undefined ? positiveNumber(body.amount, 'amount') : existing.amount
    const productId = ['Пополнение', 'Выплата'].includes(kind)
      ? undefined
      : (body.productId !== undefined ? body.productId : existing.productId)
    if (['Покупка', 'Продажа'].includes(kind) && !productId) throw new Error('productId is required for buy or sell')
    const updated: Transaction = {
      ...existing,
      title: body.title !== undefined ? requiredText(body.title, 'title') : existing.title,
      amount,
      date: body.date !== undefined ? requiredText(body.date, 'date') : existing.date,
      kind,
      productId,
    }
    await withTransaction(db, async (client) => {
      const positions = createPositionCache(client, userId)
      const product = productId ? await positions.byId(productId) : undefined
      if (['Покупка', 'Продажа'].includes(kind) && !product) throw new Error('Unknown productId')
      // Сначала снимаем эффект прежней версии операции, потом проверяем и накладываем новую;
      // при ошибке транзакция откатывается, поэтому возвращать эффект вручную не нужно.
      await applyTransactionEffect(positions, existing, -1)
      if (kind === 'Продажа' && product && product.amount < amount) throw new Error('Sale exceeds current position')
      await applyTransactionEffect(positions, updated, 1)
      await positions.flush()
      await updateTransaction(client, userId, updated)
      await recordSnapshot(client, userId)
    })
    response.json(updated)
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

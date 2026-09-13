import 'dotenv/config'
import express, { type Request, type Response } from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import multer from 'multer'
import { Pool, types } from 'pg'
import { runMigrations } from './migrations.ts'
import { logError } from './logger.ts'
import { decryptToken, encryptToken, maskToken } from './token-crypto.ts'
import { tinkoffConnector } from './brokers/tinkoff.ts'
import {
  aggregateByGroup, aggregateByKey, calculateReturns,
  type Breakdown, type KeyedValuation,
} from './portfolio-engine.ts'
import { buildRecommendations, type PayoutSnapshot, type PositionSnapshot } from './recommendations.ts'
import {
  accountTypeFor, createPosition, mergeInstrument, optionalNumber, optionalText,
  positionToWire, positiveNumber, requiredText, MANUAL_PROVIDER, type PositionBody,
} from './positions.ts'
import {
  DEFAULT_BASE_CURRENCY, GROUP_LABELS, engineContext, toEngineInput, recordSnapshot,
  performTinkoffSync, syncPayoutForTransaction, refreshMarketPrices, regenerateForecastPayouts,
} from './daily-tasks.ts'
import {
  deleteOrphanInstrument, deletePayout, deletePayoutsForTransaction, deletePosition,
  deleteTransaction, deleteUserData, ensureAccount, ensurePortfolio, findBrokerConnection,
  findCashPosition, findPayout, findPortfolio, findPosition,
  findTransaction,
  findUploadedDocument, insertUploadedDocument,
  insertPayout, insertTransaction,
  listAccounts, listInstruments, listPayouts, listPositions, listSnapshots, listTransactions,
  sumPayouts, sumTransactionCosts, updateBrokerConnectionSync, updateInstrument, updatePayout,
  updatePortfolio, updatePosition, updatePositionValue, updateTransaction, upsertBrokerConnection,
  withTransaction,
  type Db, type Instrument,
  type ListOptions, type Payout, type PayoutStatus, type PayoutType, type Position,
  type Transaction, type TransactionType,
} from './repository.ts'

// DATE OID: return the raw "YYYY-MM-DD" text instead of letting node-pg parse it into a
// JS Date (which JSON.stringify then turns into a full ISO datetime with a time/Z suffix,
// breaking every frontend helper that expects a plain date string).
types.setTypeParser(1082, (value) => value)

type Snapshot = { date: string; value: number; invested: number | null }
type User = { id: string; email: string; passwordHash: string; salt: string }

const app = express()
const port = Number(process.env.PORT || 3001)
// Дефолт с логином и паролем из репозитория годится только для локальной разработки:
// в production молчаливый откат на него означал бы подключение не к той базе или
// работу с учётной записью, пароль которой известен всем (§28).
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL не задан. В production запуск с параметрами подключения по умолчанию запрещён (§28)')
}
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
// engineContext/DEFAULT_BASE_CURRENCY/GROUP_LABELS/toEngineInput/recordSnapshot общие
// с планировщиком (server/scheduler.ts, §19/§21/§32) — вынесены в daily-tasks.ts.
const SUPPORTED_BASE_CURRENCIES = ['RUB', 'USD', 'CNY']

// Портфель заводится лениво (см. ensurePortfolio) — у аккаунта без единой сохранённой
// записи его ещё может не быть, тогда используем дефолт, а не падаем.
async function resolveBaseCurrency(client: Db, userId: string): Promise<string> {
  const portfolio = await findPortfolio(client, userId)
  return portfolio?.baseCurrency ?? DEFAULT_BASE_CURRENCY
}

// GROUP_LABELS — импортирован из daily-tasks.ts (используется и планировщиком).
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
    source: payout.source,
    instrumentId: payout.instrumentId,
    accountId: payout.accountId,
    transactionId: payout.transactionId,
  }
}

async function loadUsers() {
  const result = await db.query('SELECT id, email, password_hash as "passwordHash", salt FROM users')
  for (const row of result.rows) {
    users.set(row.id, { id: row.id, email: row.email, passwordHash: row.passwordHash, salt: row.salt })
  }
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

// §13, §6 п.10: настройки портфеля — базовая валюта (используется Portfolio Engine для
// всех расчётов, см. resolveBaseCurrency/engineContext выше) и название портфеля.
// Портфель заводится лениво (ensurePortfolio) — сохранить настройки можно и до первой
// сохранённой позиции, без ожидания, пока портфель появится сам собой.
app.get('/api/settings', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const portfolio = await findPortfolio(db, userId)
  response.json({
    portfolioName: portfolio?.name ?? 'Основной портфель',
    baseCurrency: portfolio?.baseCurrency ?? DEFAULT_BASE_CURRENCY,
    availableCurrencies: SUPPORTED_BASE_CURRENCIES,
  })
})
app.patch('/api/settings', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const name = optionalText(request.body?.portfolioName)
  const baseCurrencyRaw = optionalText(request.body?.baseCurrency)?.toUpperCase()
  if (baseCurrencyRaw && !SUPPORTED_BASE_CURRENCIES.includes(baseCurrencyRaw)) {
    return response.status(400).json({ error: 'Неподдерживаемая базовая валюта' })
  }
  const portfolio = await ensurePortfolio(db, userId, randomUUID())
  const updated = await updatePortfolio(db, userId, portfolio.id, { name, baseCurrency: baseCurrencyRaw })
  response.json({ portfolioName: updated.name, baseCurrency: updated.baseCurrency, availableCurrencies: SUPPORTED_BASE_CURRENCIES })
})

// §11 BrokerConnection: статус подключения живёт в базе, а не в памяти процесса, иначе
// перезапуск сервера «отключал» бы брокера. Токен хранится только зашифрованным (§28,
// server/token-crypto.ts) — расшифровывается на секунду вызова коннектора и никогда не логируется.
// performTinkoffSync — импортирован из daily-tasks.ts (используется и планировщиком).

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

// §20: обновление текущей цены акций/фондов по данным MOEX ISS — раньше было исключительно
// явным действием пользователя (кнопка «Обновить цены»); теперь та же логика (daily-tasks.ts)
// используется и планировщиком (§19/§21/§32), кнопка вызывает тот же код внутри транзакции.
app.post('/api/market-data/refresh', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const result = await withTransaction(db, (client) => refreshMarketPrices(client, userId))
  response.json(result)
})

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'portfolio-api' }))

// ---------------------------------------------------------------------------
// Позиции и инструменты (§8, §9, §11)
// ---------------------------------------------------------------------------


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
      await regenerateForecastPayouts(client, userId)
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
      // Ставка, срок, купон или количество могли измениться — плановые выплаты по этому
      // инструменту больше не соответствуют его параметрам и считаются заново (§15).
      await regenerateForecastPayouts(client, userId)
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
    // Порядок важен: сначала пересчёт (он убирает прогнозные выплаты удалённой позиции),
    // и только потом удаление инструмента — иначе оставшиеся ссылки из portfolio.payouts
    // заставили бы deleteOrphanInstrument считать инструмент всё ещё используемым.
    await regenerateForecastPayouts(client, userId)
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
  // §34: тяжёлая операция не выполняется внутри запроса — документ только встаёт в очередь
  // (portfolio.uploaded_documents), распознаванием займётся воркер планировщика, а клиент
  // опрашивает статус через GET /api/ocr/documents/:id.
  const document = await insertUploadedDocument(db, userId, {
    id: randomUUID(),
    fileName: decodeUploadName(request.file.originalname),
    filePath: request.file.path,
    mimeType: request.file.mimetype,
  })
  response.status(202).json({ documentId: document.id, status: document.status })
})

app.get('/api/ocr/documents/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const document = await findUploadedDocument(db, userId, request.params.id)
  if (!document) return response.status(404).json({ error: 'Документ не найден' })
  response.json({
    documentId: document.id,
    status: document.status,
    fileName: document.fileName,
    createdAt: document.createdAt,
    processedAt: document.processedAt,
    // Тело результата — то же {date, items, failures}, что раньше приходило синхронным
    // ответом на загрузку: экран-сводка (§40.4) читает его без изменений.
    result: document.status === 'done' ? document.extractedJson : undefined,
    error: document.errorMessage,
  })
})

app.get('/api/portfolio/summary', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const positions = await listPositions(db, userId)
  const [payouts, costs, baseCurrency] = await Promise.all([sumPayouts(db, userId), sumTransactionCosts(db, userId), resolveBaseCurrency(db, userId)])
  const aggregate = aggregateByGroup(positions.map(toEngineInput), await engineContext(baseCurrency))
  const returns = calculateReturns({
    currentValue: aggregate.value,
    invested: aggregate.invested,
    payoutsReceived: payouts.received,
    commissions: costs.commissions,
    taxes: costs.taxes,
  })
  response.json({
    total: aggregate.value,
    invested: aggregate.invested,
    profit: aggregate.pnl,
    profitPercent: aggregate.pnlPercent,
    expected: payouts.expected,
    paid: payouts.received,
    positions: positions.length,
    baseCurrency: aggregate.baseCurrency,
    // §10.6: изменение стоимости + выплаты − комиссии − налоги, и простая доходность к нему.
    financialResult: returns.financialResult,
    returnPercent: returns.returnPercent,
    returnMethod: returns.method,
    commissions: returns.commissions,
    taxes: returns.taxes,
    groups: aggregate.groups,
    // §7.3 / §40.2: итог неполный — UI обязан пометить это, а не показывать цифру как точную.
    valuation: { incomplete: aggregate.valuationIncomplete, unavailable: aggregate.unavailable },
  })
})
app.get('/api/portfolio/history', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await withTransaction(db, (client) => recordSnapshot(client, userId))
  const snapshots: Snapshot[] = await listSnapshots(db, userId)
  response.json(snapshots)
})

// §23: структура портфеля по разрезам, отличным от класса активов (тот уже отдаёт
// /api/portfolio/summary как groups). Провайдер счёта (§11 Account.type) разводит
// «по брокерам» и «по банкам» на два независимых разреза одних и тех же provider-имён.
app.get('/api/portfolio/structure', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const positions = await listPositions(db, userId)
  const context = await engineContext(await resolveBaseCurrency(db, userId))
  const aggregate = aggregateByGroup(positions.map(toEngineInput), context)
  const valuationById = new Map(aggregate.positions.map((valuation) => [valuation.id, valuation]))
  const keyed = (keyOf: (position: Position) => string | null): KeyedValuation[] =>
    positions
      .map((position) => ({ key: keyOf(position), valuation: valuationById.get(position.id) }))
      .filter((item): item is { key: string; valuation: typeof item.valuation } => item.key !== null)
      .map(({ key, valuation }) => ({
        key,
        investedBase: valuation?.investedBase ?? null,
        valueBase: valuation?.valueBase ?? null,
        priceUnavailable: valuation?.priceUnavailable ?? true,
      }))
  const breakdown = (keyOf: (position: Position) => string | null): Breakdown[] => aggregateByKey(keyed(keyOf))
  response.json({
    byCurrency: breakdown((position) => position.instrument.currency || 'RUB'),
    byBroker: breakdown((position) => (position.account.type === 'broker' ? position.account.provider : null)),
    byBank: breakdown((position) => (position.account.type === 'bank' ? position.account.provider : null)),
    byInstrument: breakdown((position) => position.instrument.name),
    byIssuer: breakdown((position) => position.instrument.issuer || null),
  })
})

// §24 (Этап 5): 4 базовых правила рекомендаций. Считаются на лету из текущего состояния
// портфеля — как и /api/portfolio/summary, а не персистятся (см. обоснование в recommendations.ts).
app.get('/api/recommendations', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const [positions, payouts, baseCurrency] = await Promise.all([listPositions(db, userId), listPayouts(db, userId), resolveBaseCurrency(db, userId)])
  const aggregate = aggregateByGroup(positions.map(toEngineInput), await engineContext(baseCurrency))
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
        // Выплата, заведённая пользователем, никогда не считается прогнозом — иначе
        // ближайший пересчёт (§15) удалил бы её как собственную строку.
        source: 'manual',
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
      // Правка прогнозной строки означает, что пользователь взял её под свой контроль:
      // дальше она живёт как ручная и переживает пересчёт, а прогноз на ту же дату/тип
      // повторно не создаётся благодаря дедупликации по (инструмент, дата, тип).
      source: existing.source === 'forecast' ? 'manual' : existing.source,
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

// syncPayoutForTransaction — импортирован из daily-tasks.ts (используется и планировщиком).

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
      await regenerateForecastPayouts(client, userId)
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
      await regenerateForecastPayouts(client, userId)
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
    await regenerateForecastPayouts(client, userId)
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

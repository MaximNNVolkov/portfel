import 'dotenv/config'
import express, { type Request, type Response } from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import multer from 'multer'
import { Pool, types } from 'pg'
import { runMigrations } from './migrations.ts'
import { logError } from './logger.ts'
import { decryptToken, encryptToken, maskToken } from './token-crypto.ts'
import {
  EmailRateLimiter, createPasswordResetToken, findResetToken, invalidateUserResetTokens, validateResetToken,
} from './password-reset.ts'
import { sendPasswordResetEmail } from './mailer.ts'
import { configureRateStore, getMoexSecurity, searchMoexSecurities } from './market-data.ts'
import { fillSecurityFromMoex } from './security-lookup.ts'
import { normalizeTinkoffToken, tinkoffConnector } from './brokers/tinkoff.ts'
import {
  aggregateByGroup, aggregateByKey, convertCurrency, evaluatePosition, sumInBase,
  type Breakdown, type EngineContext, type KeyedValuation,
} from './portfolio-engine.ts'
import { buildRecommendations, type PayoutSnapshot, type PositionSnapshot } from './recommendations.ts'
import { buildAttention } from './attention.ts'
import { couponForecastGap } from './payout-forecast.ts'
import {
  accountTypeFor, createPosition, mergeInstrument, optionalNumber, optionalText,
  checkNonNegative, notInFuture, positionToWire, positiveNumber, reconcileInvested, requiredDate, requiredText, validateHolding, MANUAL_PROVIDER, type PositionBody,
} from './positions.ts'
import { buildRebalance, parseTargetAllocation, rebalanceRecommendations } from './rebalance.ts'
import {
  DEFAULT_BASE_CURRENCY, GROUP_LABELS, engineContext, toEngineInput, recordSnapshot,
  portfolioEngineInputs, isCashInput, closedPositionResult,
  performTinkoffSync, syncPayoutForTransaction, refreshMarketPrices, regenerateForecastPayouts, localDate, portfolioResult,
  isAutoReceived, settleDuePayouts, syncTransactionForPayout,
} from './daily-tasks.ts'
import { outlookKey, payoutOutlook, payoutPeriods, type PeriodLevel } from './payout-outlook.ts'
import { periodReturns } from './period-returns.ts'
import { estimateTax, taxIncomeRows, taxRowsToCsv } from './tax-estimate.ts'
import { parseCsv, parseMapping, statementRows, type StatementRow } from './statement-import.ts'
import {
  deleteOrphanInstrument, deletePayout, deletePayoutsForTransaction, deletePosition,
  deleteTransaction, deleteUserData, ensureAccount, ensurePortfolio, findBrokerConnection,
  findCashPosition, findPayout, findPortfolio, findPosition,
  findTransaction,
  findProcessedDocumentByHash, findUploadedDocument, insertUploadedDocument,
  insertPayout, insertTransaction,
  listAccounts, listInstruments, listPayouts, listPositions, listSnapshots, listTransactions,
  sumCashBalances, insertTransactions, deleteTransactionsByExternalPrefix, updateBrokerConnectionSync, updateInstrument, updatePayout,
  updatePortfolio, updatePosition, updatePositionValue, updateTransaction, upsertBrokerConnection,
  withTransaction,
  type Db, type Instrument,
  type ListOptions, type Payout, type PayoutStatus, type PayoutType, type Position,
  type Transaction, type TransactionType,
  updatePositionMarketPrice,
  recordInstrumentPrice,
} from './repository.ts'

// DATE OID: return the raw "YYYY-MM-DD" text instead of letting node-pg parse it into a
// JS Date (which JSON.stringify then turns into a full ISO datetime with a time/Z suffix,
// breaking every frontend helper that expects a plain date string).
types.setTypeParser(1082, (value) => value)

type Snapshot = { date: string; value: number; invested: number | null; result: number | null }
type User = { id: string; email: string; passwordHash: string; salt: string }

const app = express()
// За nginx (стенд и production) все запросы приходят с адреса прокси. Без этого
// express-rate-limit считает всех пользователей одним клиентом, и лимит в 10 попыток
// входа за 15 минут становится общим на всех сразу (§28).
app.set('trust proxy', 1)
const port = Number(process.env.PORT || 3001)
// Дефолт с логином и паролем из репозитория годится только для локальной разработки:
// в production молчаливый откат на него означал бы подключение не к той базе или
// работу с учётной записью, пароль которой известен всем (§28).
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL не задан. В production запуск с параметрами подключения по умолчанию запрещён (§28)')
}
const databaseUrl = process.env.DATABASE_URL || 'postgresql://portfel:portfel@localhost:5432/portfel'
const db = new Pool({ connectionString: databaseUrl, max: 10 })
configureRateStore(db)
const users = new Map<string, User>()
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60 * 1000
const upload = multer({ dest: resolve(process.cwd(), 'server/uploads'), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (_request, file, callback) => callback(null, ['image/png', 'image/jpeg'].includes(file.mimetype)) })

// Одна загрузка приложения — около 9 запросов; прежние 300 за 15 минут кончались после
// ~30 обновлений страницы (меньше — для семьи за одним NAT), и все экраны получали 429.
// Настраивается через API_RATE_LIMIT.
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.API_RATE_LIMIT) || 1500, standardHeaders: true, legacyHeaders: false })
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Слишком много попыток, повторите позже' } })
// Отдельные корзины для восстановления пароля: общий authLimiter с /login съедал попытки, и
// после пары запросов письма пользователь не мог ни сбросить пароль, ни войти.
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много попыток, повторите позже' } })
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Слишком много попыток, повторите позже' } })
// Восстановление пароля: IP ограничен forgotLimiter/resetLimiter выше.
// Этот лимитер — отдельно по email, чтобы нельзя было засыпать письмами один и тот же ящик
// с разных IP (§28).
const forgotPasswordEmailLimiter = new EmailRateLimiter()

app.use(helmet())
// Выписка из банка приходит текстом в JSON и бывает больше стандартных 100 КБ — лимит
// поднят только для импорта, остальным запросам большие тела не нужны.
const STATEMENT_IMPORT_PATH = /^\/api\/imports\/statement/
const defaultJson = express.json()
// 10 МБ: выписка в windows-1251 после перекодировки и упаковки в JSON растёт в ~1,4 раза,
// а nginx пропускает тело до 12 МБ.
const STATEMENT_LIMIT_MB = 10
const statementJson = express.json({ limit: `${STATEMENT_LIMIT_MB}mb` })
app.use((request, response, next) => (STATEMENT_IMPORT_PATH.test(request.path) ? statementJson : defaultJson)(request, response, next))
app.use('/api', apiLimiter)
// CSRF (§28): cookie браузер прикладывает сам, поэтому изменяющий запрос без Bearer обязан
// нести заголовок X-Requested-With. Чужой сайт не может выставить его без CORS-preflight,
// а CORS сервер не разрешает. Вторая линия — SameSite=Strict у самой cookie.
app.use('/api', (request, response, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || bearerToken(request)) return next()
  if (request.get('x-requested-with') !== 'portfel') return response.status(403).json({ error: 'Запрос отклонён: нет заголовка X-Requested-With' })
  next()
})
// Идентификаторы записей — UUID: «/api/positions/abc» — это «не найдено», а не падение
// запроса к базе с ответом 500 (тестер, Т11).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
app.param('id', (_request, response, next, id) => {
  if (typeof id === 'string' && UUID_PATTERN.test(id)) return next()
  response.status(404).json({ error: 'Запись не найдена' })
})
// Скриншоты банковских приложений раньше раздавались статикой по /uploads без авторизации.
// Клиенту они не нужны (распознанный результат приходит через /api/ocr/documents/:id),
// а после распознавания воркер файл удаляет — поэтому публичной раздачи нет вовсе (§28).

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
// Ошибки проверки ввода (throw new Error('…') в разборе тела) показываются пользователю как
// есть. Ошибка самой базы (у неё есть SQLSTATE в code) — нет: английский текст Postgres
// вроде «numeric field overflow» пользователю ничего не говорит (прогон 01.10, П15).
function clientError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    logError('validation', error)
    return code.startsWith('22') ? 'Некорректное значение в одном из полей' : fallback
  }
  return error.message
}

// Операция без описания хранит в нём код типа («DEPOSIT»), и он показывался в списке
// как есть (П21): наружу отдаём русское название типа.
const TRANSACTION_TITLES: Record<string, string> = {
  BUY: 'Покупка', SELL: 'Продажа', DEPOSIT: 'Пополнение', WITHDRAW: 'Вывод средств', COUPON: 'Купон',
  DIVIDEND: 'Дивиденды', INTEREST: 'Проценты по вкладу', FEE: 'Комиссия', TAX: 'Налог', REDEMPTION: 'Погашение', OTHER: 'Прочее',
}
function transactionTitle(transaction: Transaction): string {
  const description = transaction.description?.trim()
  if (!description || description === transaction.type) return TRANSACTION_TITLES[transaction.type] ?? transaction.type
  return description
}

function transactionToWire(transaction: Transaction) {
  return {
    id: transaction.id,
    type: transaction.type,
    title: transactionTitle(transaction),
    amount: transaction.amount,
    date: transaction.date,
    currency: transaction.currency,
    commission: transaction.commission,
    tax: transaction.tax,
    quantity: transaction.quantity ?? null,
    price: transaction.price ?? null,
    positionId: transaction.positionId,
    instrumentId: transaction.instrumentId,
    accountId: transaction.accountId,
    source: transaction.source,
    institution: transaction.institution,
  }
}
// «Сегодня» по местным часам сервера — граница между ожидаемыми и просроченными
// выплатами (BUG-22). Не toISOString: в UTC после полуночи по Москве ещё «вчера».
function localToday(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
// context — для amountBase: сумма в базовой валюте портфеля (§13), чтобы клиент складывал
// выплаты в разных валютах по курсу ЦБ, а не amount напрямую. null — курса нет (§7.3).
function payoutToWire(payout: Payout, context?: EngineContext, today = localToday()) {
  return {
    id: payout.id,
    title: payout.description ?? '',
    amount: payout.amount,
    amountBase: context ? convertCurrency(payout.amount, payout.currency, context.baseCurrency, context.rates) : null,
    baseCurrency: context?.baseCurrency ?? null,
    date: payout.date,
    type: payout.type,
    status: payout.status,
    currency: payout.currency,
    source: payout.source,
    instrumentId: payout.instrumentId,
    accountId: payout.accountId,
    transactionId: payout.transactionId,
    institution: payout.institution,
    // Ожидалась, но дата уже прошла (§22, BUG-22) — отдельная группа «Просрочено».
    overdue: payout.status === 'expected' && payout.date < today,
    // Пришедшие деньги уже вложены — напоминание «Реинвестировать» не показывается.
    reinvested: Boolean(payout.reinvestedAt),
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
// Сессия (§28): браузер держит токен в httpOnly-cookie — скрипт страницы его не видит,
// поэтому XSS не может унести сессию. Заголовок Authorization: Bearer остаётся для
// API-клиентов и smoke-теста (server/smoke-test.ts).
const SESSION_COOKIE = 'portfel_session'
function bearerToken(request: Request) { const value = request.headers.authorization; return value?.startsWith('Bearer ') ? value.slice(7) : '' }
function cookieToken(request: Request) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return ''
}
function authToken(request: Request) { return bearerToken(request) || cookieToken(request) }
function setSessionCookie(request: Request, response: Response, token: string) {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // За nginx request.secure берётся из X-Forwarded-Proto (trust proxy выше).
    secure: request.secure || process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api',
    maxAge: SESSION_TTL_MS,
  })
}
function clearSessionCookie(response: Response) { response.clearCookie(SESSION_COOKIE, { path: '/api' }) }
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
  if (!userId) { response.status(401).json({ error: 'Нужно войти в аккаунт' }); return undefined }
  return userId
}

// §28: на публичном стенде регистрация не должна быть открыта всему интернету —
// чужой аккаунт означает чужие персональные и финансовые данные в нашей базе.
// Если REGISTRATION_INVITE_CODE задан, регистрация требует совпадающий код; если
// переменная пуста (локальная разработка) — поведение прежнее.
const registrationInviteCode = (process.env.REGISTRATION_INVITE_CODE || '').trim()

app.post('/api/auth/register', authLimiter, async (request, response) => {
  try {
    if (registrationInviteCode) {
      const provided = typeof request.body?.inviteCode === 'string' ? request.body.inviteCode.trim() : ''
      if (provided !== registrationInviteCode) {
        return response.status(403).json({ error: 'Неверный код приглашения', field: 'inviteCode' })
      }
    }
    // Тексты ошибок показываются на экране входа под соответствующим полем (BUG-03),
    // поэтому они русские и указывают поле.
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : ''
    const password = typeof request.body?.password === 'string' ? request.body.password : ''
    if (!email) return response.status(400).json({ error: 'Укажите email', field: 'email' })
    if (password.length < 8) return response.status(400).json({ error: 'Пароль должен быть не короче 8 символов', field: 'password' })
    const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email])
    if (existing.rowCount) return response.status(409).json({ error: 'Аккаунт с таким email уже зарегистрирован', field: 'email' })
    const salt = randomBytes(16).toString('hex'); const user = { id: randomUUID(), email, passwordHash: hashPassword(password, salt), salt }
    await db.query('INSERT INTO users (id, email, password_hash, salt) VALUES ($1, $2, $3, $4)', [user.id, user.email, user.passwordHash, user.salt])
    users.set(user.id, user); const token = await createSession(user.id)
    setSessionCookie(request, response, token)
    response.status(201).json({ token, user: { id: user.id, email: user.email } })
  } catch (error) { response.status(400).json({ error: clientError(error, 'Не удалось зарегистрироваться') }) }
})
app.post('/api/auth/login', authLimiter, async (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.toLowerCase().trim() : ''
  const password = typeof request.body?.password === 'string' ? request.body.password : ''
  const result = await db.query('SELECT id, email, password_hash as "passwordHash", salt FROM users WHERE email = $1', [email])
  const user = result.rows[0] as User | undefined
  if (!user || !timingSafeEqual(Buffer.from(user.passwordHash, 'hex'), Buffer.from(hashPassword(password, user.salt), 'hex'))) return response.status(401).json({ error: 'Неверный email или пароль', field: 'password' })
  const token = await createSession(user.id); setSessionCookie(request, response, token)
  response.json({ token, user: { id: user.id, email: user.email } })
})
app.post('/api/auth/logout', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(authToken(request))])
  clearSessionCookie(response)
  response.status(204).send()
})
app.get('/api/auth/me', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  response.json({ authenticated: true, email: users.get(userId)?.email ?? null })
})
// Восстановление пароля по почте. Ответ всегда 200 с одинаковым текстом независимо от
// того, существует ли аккаунт с таким email, — иначе форма превращается в оракул,
// позволяющий перебором узнавать зарегистрированные адреса.
const FORGOT_PASSWORD_MESSAGE = 'Если аккаунт с таким email существует, мы отправили на него письмо со ссылкой для восстановления пароля.'
app.post('/api/auth/forgot-password', forgotLimiter, async (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : ''
  if (email && forgotPasswordEmailLimiter.allow(email)) {
    const result = await db.query('SELECT id FROM users WHERE email = $1', [email])
    const userId = result.rows[0]?.id as string | undefined
    if (userId) {
      const token = await createPasswordResetToken(db, userId)
      await sendPasswordResetEmail(email, token)
    }
  }
  response.json({ message: FORGOT_PASSWORD_MESSAGE })
})
app.post('/api/auth/reset-password', resetLimiter, async (request, response) => {
  const token = typeof request.body?.token === 'string' ? request.body.token : ''
  const password = typeof request.body?.password === 'string' ? request.body.password : ''
  if (!token) return response.status(400).json({ error: 'Ссылка для восстановления пароля недействительна' })
  // Те же правила, что и при регистрации (см. /api/auth/register выше).
  if (password.length < 8) return response.status(400).json({ error: 'Пароль должен быть не короче 8 символов', field: 'password' })
  const record = await findResetToken(db, token)
  const validation = validateResetToken(record)
  if (validation === 'not_found') return response.status(400).json({ error: 'Ссылка для восстановления пароля недействительна' })
  if (validation === 'used') return response.status(400).json({ error: 'Эта ссылка уже использована. Запросите новую на странице входа' })
  if (validation === 'expired') return response.status(400).json({ error: 'Срок действия ссылки истёк. Запросите новую на странице входа' })
  if (!record) return response.status(400).json({ error: 'Ссылка для восстановления пароля недействительна' })
  const salt = randomBytes(16).toString('hex')
  const passwordHash = hashPassword(password, salt)
  await withTransaction(db, async (client) => {
    await client.query('UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3', [passwordHash, salt, record.userId])
    // Обесценивает и сам применённый токен, и все прочие ещё не использованные ссылки
    // этого пользователя — старое письмо не должно оставаться рабочим после смены пароля.
    await invalidateUserResetTokens(client, record.userId)
    // Разлогинить пользователя везде: если аккаунт скомпрометирован, старые сессии не
    // должны переживать смену пароля.
    await client.query('DELETE FROM sessions WHERE user_id = $1', [record.userId])
  })
  const existing = users.get(record.userId)
  if (existing) users.set(record.userId, { ...existing, passwordHash, salt })
  response.status(204).send()
})
app.delete('/api/auth/me', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const pendingFiles = await withTransaction(db, (client) => deleteUserData(client, userId))
  await Promise.all(pendingFiles.map((path) => unlink(path).catch(() => {})))
  users.delete(userId)
  clearSessionCookie(response)
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
    targetAllocation: portfolio?.targetAllocation ?? {},
  })
})
app.patch('/api/settings', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const name = optionalText(request.body?.portfolioName)
  const baseCurrencyRaw = optionalText(request.body?.baseCurrency)?.toUpperCase()
  if (baseCurrencyRaw && !SUPPORTED_BASE_CURRENCIES.includes(baseCurrencyRaw)) {
    return response.status(400).json({ error: 'Неподдерживаемая базовая валюта' })
  }
  let targetAllocation: Record<string, number> | undefined
  try {
    if (request.body?.targetAllocation !== undefined) targetAllocation = parseTargetAllocation(request.body.targetAllocation)
  } catch (error) {
    return response.status(400).json({ error: clientError(error, 'Неверная целевая структура'), field: 'targetAllocation' })
  }
  const portfolio = await ensurePortfolio(db, userId, randomUUID())
  const updated = await updatePortfolio(db, userId, portfolio.id, { name, baseCurrency: baseCurrencyRaw, targetAllocation })
  response.json({ portfolioName: updated.name, baseCurrency: updated.baseCurrency, availableCurrencies: SUPPORTED_BASE_CURRENCIES, targetAllocation: updated.targetAllocation })
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
    const token = normalizeTinkoffToken(requiredText(request.body?.token, 'token'))
    if (!token) {
      return response.status(400).json({ error: 'В токене есть посторонние символы. Скопируйте его заново из приложения Т-Инвестиций — целиком, без кавычек и пояснений.' })
    }
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
    // Неверный токен отсекается выше (401/403 → «Токен не подошёл»). Сюда попадают сбои связи
    // и ответы 5xx: советовать «проверьте токен» здесь — отправлять пользователя не туда.
    logError('brokers.tinkoff.connect', error)
    response.status(502).json({ error: 'Не удалось связаться с Т-Инвестициями. Токен не сохранён — повторите попытку позже.' })
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

// §17, §20: поиск бумаги по тикеру, названию или ISIN для формы ручного ввода и её
// описание с MOEX — пользователь вводит тикер и количество, остальное подставляется.
app.get('/api/market-data/search', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const query = typeof request.query.q === 'string' ? request.query.q.slice(0, 64) : ''
  const result = await searchMoexSecurities(query)
  if (result.status !== 'ok') return response.status(502).json({ error: 'Московская биржа не отвечает. Попробуйте позже' })
  response.json(result.value)
})
app.get('/api/market-data/securities/:secid', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const result = await getMoexSecurity(String(request.params.secid).slice(0, 64))
  if (result.status === 'not_found') return response.status(404).json({ error: 'Бумага не найдена на Московской бирже' })
  if (result.status !== 'ok') return response.status(502).json({ error: 'Московская биржа не отвечает. Попробуйте позже' })
  response.json(result.value)
})

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'portfolio-api' }))

// ---------------------------------------------------------------------------
// Позиции и инструменты (§8, §9, §11)
// ---------------------------------------------------------------------------


// Каждая позиция уходит наружу вместе с оценкой Portfolio Engine (§10) — тем же
// evaluatePosition, по которому считаются сводка и структура. Иначе список и карточка
// показывали бы сохранённое при вводе значение, а сводка — quantity × currentPrice (BUG-17).
async function valuedPositions(userId: string, positions: Position[]) {
  const [context, payouts] = await Promise.all([engineContext(await resolveBaseCurrency(db, userId)), listPayouts(db, userId)])
  // Прогноз поступлений по инструменту (payout-outlook.ts): что пришло, что ещё придёт,
  // что вернётся телом — в базовой валюте, одним расчётом для карточки и списков.
  const outlooks = payoutOutlook(payouts, localToday(), (amount, currency) => convertCurrency(amount, currency, context.baseCurrency, context.rates))
  return positions.map((position) => {
    const outlook = outlooks.get(outlookKey(position.instrumentId, position.accountId)) ?? null
    const valuation = evaluatePosition(toEngineInput(position), context)
    if (!position.closedOn) return { ...positionToWire(position, valuation), outlook }
    // Закрытая позиция стоит ноль — деньги уже вернулись; результат по ней реализованный.
    const result = closedPositionResult(position, context)
    return { outlook, ...positionToWire(position, {
      ...valuation,
      valueBase: 0,
      fullValue: 0,
      marketValue: 0,
      accruedInterest: null,
      pnl: result,
      pnlPercent: result !== null && valuation.investedBase ? (result / valuation.investedBase) * 100 : null,
      priceUnavailable: false,
      priceUnavailableReason: null,
      estimated: false,
    }) }
  })
}
// Наступившие купоны, проценты и дивиденды переводятся в «получено» до любого чтения,
// где они видны (выплаты, сводка, позиции, внимание): планировщик делает это раз в сутки,
// а между его запусками дата успевает пройти.
async function settlePayouts(userId: string) {
  await withTransaction(db, (client) => settleDuePayouts(client, userId, localToday()))
}

app.get('/api/positions', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await settlePayouts(userId)
  const positions = await listPositions(db, userId, listOptions(request))
  response.json(await valuedPositions(userId, positions))
})
app.get('/api/positions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const position = await findPosition(db, userId, request.params.id)
  if (!position) return response.status(404).json({ error: 'Инструмент не найден' })
  response.json((await valuedPositions(userId, [position]))[0])
})
app.post('/api/positions', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    // Бумага по тикеру: недостающее берётся с MOEX до транзакции — запрос к бирже
    // не должен держать соединение с базой.
    const fill = await fillSecurityFromMoex((request.body ?? {}) as PositionBody)
    const position = await withTransaction(db, async (client) => {
      const body = fill.body
      const created = await createPosition(client, userId, body, 'manual')
      if (fill.quoted && fill.price !== null) {
        // Цена с биржи — котировка с датой, как после «Обновить цены», а не введённое число.
        await updatePositionMarketPrice(client, userId, {
          id: created.id, currentPrice: created.currentPrice, value: created.value, accruedInterest: created.accruedInterest,
        })
        await recordInstrumentPrice(client, created.instrumentId, localToday(), fill.price)
        created.priceUpdatedAt = new Date().toISOString()
      }
      if (body.fromCash === true) await payFromCash(client, userId, created)
      await regenerateForecastPayouts(client, userId)
      await recordSnapshot(client, userId)
      return created
    })
    response.status(201).json((await valuedPositions(userId, [position]))[0])
  } catch (error) { response.status(400).json({ error: clientError(error, 'Не удалось сохранить инструмент') }) }
})
// Реинвестирование (критик К4): новый продукт покупается на пришедшие деньги, а не
// появляется в портфеле поверх них. Покупка проводится операцией BUY — свободные деньги
// уменьшаются на ту же сумму (sumCashBalances), итог портфеля не удваивается, а удаление
// операции возвращает деньги и уменьшает продукт, как у любой покупки.
async function payFromCash(client: Db, userId: string, position: Position) {
  const amount = position.invested ?? position.value
  if (!amount || amount <= 0) throw new Error('Не указана сумма покупки')
  const currency = position.instrument.currency
  const balance = (await sumCashBalances(client, userId)).find((row) => row.currency === currency)?.balance ?? 0
  if (balance + 0.005 < amount) {
    throw new Error(`Свободных денег в ${currency} не хватает: есть ${Math.max(0, Math.round(balance * 100) / 100)}, нужно ${amount}`)
  }
  await insertTransaction(client, {
    id: randomUUID(),
    accountId: position.accountId,
    instrumentId: position.instrumentId,
    type: 'BUY',
    date: position.openedOn ?? localToday(),
    amount,
    currency,
    commission: 0,
    tax: 0,
    quantity: position.quantity,
    price: position.averagePrice,
    source: 'manual',
    description: 'Покупка из свободных денег',
  })
}

app.patch('/api/positions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const existing = await findPosition(db, userId, request.params.id)
    if (!existing) return response.status(404).json({ error: 'Инструмент не найден' })
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
      const quantity = body.quantity !== undefined ? optionalNumber(body.quantity) : existing.quantity
      const averagePrice = body.averagePrice !== undefined ? optionalNumber(body.averagePrice) : existing.averagePrice
      // Новое количество или цена без нового «вложено» — вложено выводится заново из них (BUG-08).
      const investedInput = body.invested !== undefined
        ? positiveNumber(body.invested, 'invested')
        : (body.quantity !== undefined || body.averagePrice !== undefined ? undefined : existing.invested)
      const record = {
        id: existing.id,
        accountId: account.id,
        instrumentId: existing.instrumentId,
        // Правка, не касающаяся этих трёх полей, старые записи не перепроверяет.
        invested: body.invested === undefined && body.quantity === undefined && body.averagePrice === undefined
          ? existing.invested
          : reconcileInvested(quantity, averagePrice, investedInput) ?? existing.invested,
        source: existing.source,
        value: body.amount !== undefined ? positiveNumber(body.amount, 'amount') : existing.value,
        quantity,
        averagePrice,
        currentPrice: body.currentPrice !== undefined ? optionalNumber(body.currentPrice) : existing.currentPrice,
        accruedInterest: body.accruedInterest !== undefined ? optionalNumber(body.accruedInterest) : existing.accruedInterest,
        openedOn: body.date !== undefined ? requiredDate(body.date, 'date') : existing.openedOn,
      }
      validateHolding(instrument, record)
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
    response.json((await valuedPositions(userId, [updated]))[0])
  } catch (error) { response.status(400).json({ error: clientError(error, 'Не удалось сохранить инструмент') }) }
})
app.delete('/api/positions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const existing = await findPosition(db, userId, request.params.id)
  if (!existing) return response.status(404).json({ error: 'Инструмент не найден' })
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
  // BUG-15 (§18): тот же файл, загруженный повторно, не обрабатывается ещё раз — иначе
  // каждая загрузка заново заводит полный комплект записей и умножает портфель. Клиент
  // получает прошлый документ и показывает его экран-сводку с пометкой о повторе.
  const contentHash = createHash('sha256').update(await readFile(request.file.path)).digest('hex')
  const previous = await findProcessedDocumentByHash(db, userId, contentHash)
  if (previous) {
    await unlink(request.file.path).catch(() => {})
    return response.status(200).json({
      documentId: previous.id,
      status: previous.status,
      alreadyUploadedAt: previous.createdAt,
    })
  }
  // §34: тяжёлая операция не выполняется внутри запроса — документ только встаёт в очередь
  // (portfolio.uploaded_documents), распознаванием займётся воркер планировщика, а клиент
  // опрашивает статус через GET /api/ocr/documents/:id.
  const document = await insertUploadedDocument(db, userId, {
    id: randomUUID(),
    fileName: decodeUploadName(request.file.originalname),
    filePath: request.file.path,
    mimeType: request.file.mimetype,
    contentHash,
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
  await settlePayouts(userId)
  const positions = await listPositions(db, userId)
  const baseCurrency = await resolveBaseCurrency(db, userId)
  const context = await engineContext(baseCurrency)
  const aggregate = aggregateByGroup(await portfolioEngineInputs(db, userId, positions), context)
  const { payouts, received, commissions, taxes, returns } = await portfolioResult(db, userId, positions, aggregate, context)
  const expected = sumInBase(payouts.expected, context)
  const expectedPrincipal = sumInBase(payouts.expectedPrincipal, context)
  const overdue = sumInBase(payouts.overdue, context)
  const unconverted = [...new Set([expected, expectedPrincipal, overdue, received, commissions, taxes].flatMap((sum) => sum.unconverted))].sort()
  // «Свободные деньги» (§7.1, §12) — оценка движком денежного остатка в базовой валюте.
  // null — остаток есть, но курса его валюты нет: не ноль (§7.3).
  const cashValuations = aggregate.positions.filter((item) => isCashInput(item.id))
  const cash = cashValuations.some((item) => item.valueBase === null)
    ? null
    : cashValuations.reduce((sum, item) => sum + (item.valueBase ?? 0), 0)
  const targets = (await findPortfolio(db, userId))?.targetAllocation ?? {}
  // Расходов в операциях больше, чем поступлений (типично для выписки по карте, Т19):
  // минус в стоимость не идёт, но и молчать о нём нельзя — экран просит начальный остаток.
  const cashShortfall = (await sumCashBalances(db, userId))
    .filter((item) => item.shortfall >= 0.005)
    .map((item) => ({ currency: item.currency, amount: Math.round(item.shortfall * 100) / 100 }))
  response.json({
    cashShortfall,
    total: aggregate.value,
    invested: aggregate.invested,
    profit: aggregate.pnl,
    profitPercent: aggregate.pnlPercent,
    expected: expected.total,
    expectedPrincipal: expectedPrincipal.total,
    overdue: overdue.total,
    paid: received.total,
    cash,
    positions: positions.length,
    baseCurrency: aggregate.baseCurrency,
    // §10.6: изменение стоимости + выплаты − комиссии − налоги, и простая доходность к нему.
    financialResult: returns.financialResult,
    returnPercent: returns.returnPercent,
    // Изменение цены позиций (стоимость − вложено) — одна из составляющих результата.
    valueChange: returns.valueChange,
    // «Внесено своих денег»: итог минус результат. Пришедшие купоны и дивиденды лежат в
    // свободных деньгах, но своими вложениями не являются — иначе «вложено» росло бы от
    // каждой выплаты, а результат их не показывал.
    contributed: returns.financialResult !== null ? Math.round((aggregate.value - returns.financialResult) * 100) / 100 : null,
    returnMethod: returns.method,
    commissions: returns.commissions,
    taxes: returns.taxes,
    groups: aggregate.groups,
    // Целевая структура: по категории — цель, текущая доля и сумма до цели. [] — цель не задана.
    rebalance: buildRebalance(aggregate.groups, aggregate.value, targets),
    // §7.3 / §40.2: итог неполный — UI обязан пометить это, а не показывать цифру как точную.
    valuation: {
      incomplete: aggregate.valuationIncomplete,
      unavailable: aggregate.unavailable,
      estimated: aggregate.positions.filter((item) => item.estimated).map((item) => ({ id: item.id, name: item.name, group: item.group })),
      // Валюты выплат/комиссий без курса ЦБ: их суммы в expected/paid/commissions не вошли.
      unconvertedCurrencies: unconverted,
    },
  })
})
app.get('/api/portfolio/history', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await withTransaction(db, (client) => recordSnapshot(client, userId))
  const snapshots: Snapshot[] = await listSnapshots(db, userId)
  response.json(snapshots)
})
// Импорт банковской выписки (§27): предпросмотр показывает, что найдено, что с ошибкой и
// что уже загружалось, — и ничего не пишет; загрузка заводит денежные операции
// (пополнение, снятие, проценты) с ключом повторной загрузки, так что тот же файл
// второй раз ничего не задваивает.
async function statementInputs(client: Db, userId: string, body: unknown) {
  const { text, mapping, exclude, only } = (body ?? {}) as { text?: unknown; mapping?: unknown; exclude?: unknown; only?: unknown }
  if (typeof text !== 'string' || !text.trim()) throw new Error('Файл выписки пустой')
  const parsed = parseCsv(text)
  if (!parsed.headers.length || !parsed.records.length) throw new Error('В файле нет строк с операциями')
  const chosen = parseMapping(mapping, parsed.headers)
  // Выписка по карте — это ещё и бытовые траты (критик К22): их можно снять галочками или
  // загрузить только поступления и проценты.
  const excluded = new Set(Array.isArray(exclude) ? exclude.map(Number).filter(Number.isInteger) : [])
  const incomeOnly = only === 'income'
  // Ключ импорта — «import:<загрузка>:<строка>» (старые — «import:<строка>»): дубликат ищется
  // по последней части, чтобы загрузку можно было отменить целиком (критик К28).
  const known = new Set((await listTransactions(client, userId)).map((item) => item.externalId?.split(':').pop()).filter(Boolean))
  const rows = statementRows(parsed, chosen).map((row) => ({
    ...row,
    duplicate: Boolean(row.externalId && known.has(row.externalId.split(':').pop())),
    skipped: excluded.has(row.line) || (incomeOnly && row.type === 'WITHDRAW'),
  }))
  return { headers: parsed.headers, mapping: chosen, rows }
}
type ImportRow = StatementRow & { duplicate: boolean; skipped: boolean }
const importable = (row: ImportRow) => !row.error && !row.duplicate && !row.skipped
const importCounts = (rows: ImportRow[]) => ({
  found: rows.length,
  errors: rows.filter((row) => row.error).length,
  duplicates: rows.filter((row) => !row.error && row.duplicate).length,
  skipped: rows.filter((row) => !row.error && !row.duplicate && row.skipped).length,
  toImport: rows.filter(importable).length,
  // Сколько придёт и уйдёт по загружаемым строкам, в рублях — чтобы было видно, что выписка
  // по карте вот-вот обнулит свободные деньги.
  incomeRub: rows.filter((row) => importable(row) && row.type !== 'WITHDRAW' && row.currency === 'RUB').reduce((sum, row) => sum + (row.amount ?? 0), 0),
  expenseRub: rows.filter((row) => importable(row) && row.type === 'WITHDRAW' && row.currency === 'RUB').reduce((sum, row) => sum + (row.amount ?? 0), 0),
})
app.post('/api/imports/statement/preview', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const result = await statementInputs(db, userId, request.body)
    response.json({ ...result, counts: importCounts(result.rows) })
  } catch (error) { response.status(400).json({ error: clientError(error, 'Не удалось прочитать выписку') }) }
})
app.post('/api/imports/statement', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const counts = await withTransaction(db, async (client) => {
      // Два одновременных импорта одного файла не должны оба пройти проверку дубликатов
      // (критик К30): импорт одного пользователя выполняется по очереди.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`statement-import:${userId}`])
      const { rows } = await statementInputs(client, userId, request.body)
      // Банк из выписки — отдельный счёт, чтобы «Где хранится» показывал, откуда деньги.
      const institution = optionalText((request.body as { institution?: unknown } | undefined)?.institution)
      const accountId = institution
        ? (await ensureAccount(client, (await ensurePortfolio(client, userId, randomUUID())).id, randomUUID(), { type: 'bank', provider: institution, currency: 'RUB' })).id
        : await defaultAccountId(client, userId)
      const batch = randomUUID().slice(0, 8)
      const transactions: Transaction[] = []
      for (const row of rows) {
        if (!importable(row) || !row.type || !row.date || row.amount === undefined || !row.externalId) continue
        transactions.push({
          id: randomUUID(), accountId, type: row.type, date: row.date, amount: row.amount, currency: row.currency,
          commission: 0, tax: 0, source: 'manual', externalId: `import:${batch}:${row.externalId.split(':').pop()}`,
          description: row.description || (row.type === 'WITHDRAW' ? 'Списание по выписке' : row.type === 'INTEREST' ? 'Проценты по выписке' : 'Зачисление по выписке'),
        })
      }
      await insertTransactions(client, transactions)
      // Выплата нужна только процентам; пополнения и снятия её не порождают.
      for (const transaction of transactions) {
        if (transaction.type === 'INTEREST') await syncPayoutForTransaction(client, transaction)
      }
      await recordSnapshot(client, userId)
      return { ...importCounts(rows), batch }
    })
    response.status(201).json({ imported: counts.toImport, duplicates: counts.duplicates, errors: counts.errors, skipped: counts.skipped, batch: counts.batch })
  } catch (error) { response.status(400).json({ error: clientError(error, 'Не удалось загрузить выписку') }) }
})

// Отмена загрузки целиком: удаляются операции этой загрузки и их выплаты.
app.delete('/api/imports/statement/:batch', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const batch = String(request.params.batch)
  if (!/^[0-9a-f]{8}$/.test(batch)) return response.status(404).json({ error: 'Загрузка не найдена' })
  const deleted = await withTransaction(db, async (client) => {
    const count = await deleteTransactionsByExternalPrefix(client, userId, `import:${batch}:`)
    if (count) await recordSnapshot(client, userId)
    return count
  })
  if (!deleted) return response.status(404).json({ error: 'Загрузка не найдена' })
  response.json({ deleted })
})

// Оценка НДФЛ за год и доходы для 3-НДФЛ. Налог считается в рублях при любой базовой
// валюте портфеля; валюта пересчитывается по текущему курсу ЦБ (исторические — v2).
async function taxInputs(request: Request, userId: string) {
  const current = new Date().getFullYear()
  const year = Number(request.query.year ?? current)
  if (!Number.isInteger(year) || year < 2000 || year > current) throw new Error('Год указан неверно')
  const [transactions, positions, context] = await Promise.all([listTransactions(db, userId), listPositions(db, userId), engineContext('RUB')])
  const names = new Map(positions.map((position) => [position.instrumentId, position.instrument.name]))
  const toRub = (amount: number, currency: string) => convertCurrency(amount, currency, 'RUB', context.rates)
  const nameOf = (transaction: Transaction) =>
    (transaction.instrumentId && names.get(transaction.instrumentId))
    || (transaction.description !== transaction.type ? transaction.description : undefined)
    || transaction.institution || '—'
  // Себестоимость погашенной облигации — вложенное в позицию (§10.2): погашение выше цены
  // покупки облагается как доход по бумагам. Возврат тела вклада доходом не является.
  const bondInvested = new Map(positions.filter((position) => position.instrument.groupType === 'bond')
    .map((position) => [`${position.accountId}|${position.instrumentId}`, position.invested]))
  const redemptionCost = (transaction: Transaction) =>
    transaction.instrumentId ? bondInvested.get(`${transaction.accountId}|${transaction.instrumentId}`) : undefined
  return { year, transactions, toRub, nameOf, redemptionCost }
}
app.get('/api/tax/estimate', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const { year, transactions, toRub, redemptionCost } = await taxInputs(request, userId)
    response.json(estimateTax(transactions, year, toRub, redemptionCost, localDate()))
  } catch (error) { response.status(400).json({ error: clientError(error, 'Некорректный запрос') }) }
})
app.get('/api/tax/export', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const { year, transactions, toRub, nameOf } = await taxInputs(request, userId)
    response.setHeader('Content-Type', 'text/csv; charset=utf-8')
    response.setHeader('Content-Disposition', `attachment; filename="dohody-${year}.csv"`)
    response.send(taxRowsToCsv(taxIncomeRows(transactions, year, toRub, nameOf)))
  } catch (error) { response.status(400).json({ error: clientError(error, 'Некорректный запрос') }) }
})

// §23: доходность за день, месяц, год и всё время — по тем же снимкам, что и график.
app.get('/api/portfolio/returns', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await withTransaction(db, (client) => recordSnapshot(client, userId))
  const snapshots: Snapshot[] = await listSnapshots(db, userId)
  response.json(periodReturns(snapshots, localDate()))
})

// §23: структура портфеля по разрезам, отличным от класса активов (тот уже отдаёт
// /api/portfolio/summary как groups). Провайдер счёта (§11 Account.type) разводит
// «по брокерам» и «по банкам» на два независимых разреза одних и тех же provider-имён.
app.get('/api/portfolio/structure', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const positions = await listPositions(db, userId)
  const context = await engineContext(await resolveBaseCurrency(db, userId))
  const aggregate = aggregateByGroup(await portfolioEngineInputs(db, userId, positions), context)
  // Денежный остаток не принадлежит ни брокеру, ни банку, ни эмитенту — входит
  // только в разрезы по валютам и по инструментам (§12, §23).
  const cashKeyed = (keyOf: (currency: string) => string): KeyedValuation[] => aggregate.positions
    .filter((valuation) => isCashInput(valuation.id))
    .map((valuation) => ({ key: keyOf(valuation.currency), investedBase: valuation.investedBase, valueBase: valuation.valueBase, priceUnavailable: valuation.priceUnavailable, estimated: valuation.estimated }))
  const valuationById = new Map(aggregate.positions.map((valuation) => [valuation.id, valuation]))
  // Закрытые позиции (погашенные, вклады с истёкшим сроком) в портфеле уже не лежат —
  // движок их не оценивает, и без фильтра они попадали в разрезы как «цена недоступна».
  const keyed = (keyOf: (position: Position) => string | null): KeyedValuation[] =>
    positions
      // Полностью проданная позиция (количество 0) — тоже уже не в портфеле (тестировщик Т27).
      .filter((position) => !position.closedOn && position.quantity !== 0)
      .map((position) => ({ key: keyOf(position), valuation: valuationById.get(position.id) }))
      .filter((item): item is { key: string; valuation: typeof item.valuation } => item.key !== null)
      .map(({ key, valuation }) => ({
        key,
        investedBase: valuation?.investedBase ?? null,
        valueBase: valuation?.valueBase ?? null,
        priceUnavailable: valuation?.priceUnavailable ?? true,
        estimated: valuation?.estimated ?? false,
      }))
  const breakdown = (keyOf: (position: Position) => string | null): Breakdown[] => aggregateByKey(keyed(keyOf), aggregate.value)
  response.json({
    byCurrency: aggregateByKey([...keyed((position) => position.instrument.currency || 'RUB'), ...cashKeyed((currency) => currency)]),
    byBroker: breakdown((position) => (position.account.type === 'broker' ? position.account.provider : null)),
    byBank: breakdown((position) => (position.account.type === 'bank' ? position.account.provider : null)),
    // «Где хранится» (CLIENT_FLOW_PLAN §4.1): банки и брокеры одним списком, включая
    // записи без банка («Ручной ввод»). Свободные деньги — отдельной строкой (критик К5):
    // к банку они не привязаны (пополнение вводится без счёта), но без них строки не
    // складывались в итог портфеля.
    byProvider: aggregateByKey([...keyed((position) => position.account.provider), ...cashKeyed(() => 'Свободные деньги')], aggregate.value),
    byInstrument: aggregateByKey([...keyed((position) => position.instrument.name), ...cashKeyed((currency) => `Денежные средства, ${currency}`)]),
    byIssuer: breakdown((position) => position.instrument.issuer || null),
  })
})

// §24 (Этап 5): 4 базовых правила рекомендаций. Считаются на лету из текущего состояния
// портфеля — как и /api/portfolio/summary, а не персистятся (см. обоснование в recommendations.ts).
async function recommendationsFor(userId: string, positions: Position[], payouts: Payout[]) {
  const baseCurrency = await resolveBaseCurrency(db, userId)
  // Доли считаются от всего портфеля, включая свободные деньги (§12); правила
  // применяются к инструментам — сам денежный остаток инструментом не является.
  const context = await engineContext(baseCurrency)
  const aggregate = aggregateByGroup(await portfolioEngineInputs(db, userId, positions), context)
  const valuationById = new Map(aggregate.positions.map((valuation) => [valuation.id, valuation]))
  // Сумма к погашению — из календаря: всё ожидаемое по бумаге в дату погашения (номинал и
  // последний купон), в базовой валюте. Так правило, «Требует внимания» и календарь называют
  // одну и ту же сумму.
  const maturityAmountFor = (position: Position): number | undefined => {
    const date = position.instrument.maturityDate
    if (!date) return undefined
    const due = payouts.filter((payout) => payout.status === 'expected' && payout.instrumentId === position.instrumentId
      && payout.accountId === position.accountId && payout.date === date)
    if (!due.some((payout) => payout.type === 'REDEMPTION')) return undefined
    const amounts = due.map((payout) => convertCurrency(payout.amount, payout.currency, context.baseCurrency, context.rates))
    return amounts.some((amount) => amount === null) ? undefined : amounts.reduce((sum: number, amount) => sum + (amount ?? 0), 0)
  }
  const positionSnapshots: PositionSnapshot[] = positions.filter((position) => !position.closedOn).map((position) => {
    const valuation = valuationById.get(position.id)
    return {
      id: position.id,
      instrumentId: position.instrumentId,
      name: position.instrument.name,
      group: valuation?.group ?? GROUP_LABELS[position.instrument.groupType] ?? 'Прочее',
      issuer: position.instrument.issuer,
      maturityDate: position.instrument.maturityDate,
      maturityAmount: maturityAmountFor(position),
      valueBase: valuation?.valueBase ?? null,
      pnlPercent: valuation?.pnlPercent ?? null,
    }
  })
  // Разрывы в выплатах ищутся по суммам в базовой валюте: 100 USD и 100 ₽ — не одно и то же.
  const payoutSnapshots: PayoutSnapshot[] = payouts.flatMap((payout) => {
    const amount = convertCurrency(payout.amount, payout.currency, context.baseCurrency, context.rates)
    return amount === null ? [] : [{ date: payout.date, amount, status: payout.status, type: payout.type }]
  })
  // Целевая структура задана — отклонение от неё заменяет общее правило «группа занимает
  // больше 25%»: 45% во вкладах при цели 45% — не проблема.
  const targets = (await findPortfolio(db, userId))?.targetAllocation ?? {}
  const hasTargets = Object.keys(targets).length > 0
  const rebalance = rebalanceRecommendations(buildRebalance(aggregate.groups, aggregate.value, targets), context.baseCurrency)
  const recommendations = buildRecommendations(positionSnapshots, aggregate.value, payoutSnapshots)
    .filter((item) => !(hasTargets && item.ruleType === 'concentration' && item.payload.kind === 'group'))
  return { recommendations: [...rebalance, ...recommendations], valuationById }
}
app.get('/api/recommendations', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const [positions, payouts] = await Promise.all([listPositions(db, userId), listPayouts(db, userId)])
  response.json((await recommendationsFor(userId, positions, payouts)).recommendations)
})

// «Требует внимания» (CLIENT_FLOW_PLAN §4.4): одна лента сигналов — просроченные и скорые
// выплаты, деньги к реинвестированию, окончание вкладов, нет цены, ошибка брокера, правила §24.
app.get('/api/attention', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await settlePayouts(userId)
  const [positions, payouts, tinkoff] = await Promise.all([
    listPositions(db, userId), listPayouts(db, userId), findBrokerConnection(db, userId, 'tinkoff'),
  ])
  const { recommendations, valuationById } = await recommendationsFor(userId, positions, payouts)
  response.json(buildAttention({
    today: localToday(),
    positions: positions.map((position) => ({
      id: position.id,
      instrumentId: position.instrumentId,
      accountId: position.accountId,
      name: position.instrument.name,
      institution: position.account.provider,
      isCash: position.instrument.groupType === 'cash',
      maturityDate: position.instrument.maturityDate,
      termEndDate: position.instrument.termEndDate,
      closedOn: position.closedOn,
      priceUnavailable: valuationById.get(position.id)?.priceUnavailable ?? false,
      forecastNote: couponForecastGap(position, position.instrument) ?? undefined,
      source: position.source,
    })),
    payouts: payouts.map((payout) => ({
      id: payout.id,
      instrumentId: payout.instrumentId,
      accountId: payout.accountId,
      title: payout.description ?? '',
      date: payout.date,
      type: payout.type,
      amount: payout.amount,
      currency: payout.currency,
      status: payout.status,
      institution: payout.institution,
      reinvested: Boolean(payout.reinvestedAt),
    })),
    brokers: tinkoff ? [{ name: 'Т-Инвестиции', status: tinkoff.status, lastSyncAt: tinkoff.lastSyncAt }] : [],
    recommendations,
  }))
})

// ---------------------------------------------------------------------------
// Выплаты (§22)
// ---------------------------------------------------------------------------

const PAYOUT_TYPES: PayoutType[] = ['COUPON', 'DIVIDEND', 'INTEREST', 'DEPOSIT_PRINCIPAL', 'REDEMPTION', 'OTHER']
const PAYOUT_STATUSES: PayoutStatus[] = ['expected', 'received']

function payoutType(value: unknown, fallback: PayoutType): PayoutType {
  const raw = optionalText(value)?.toUpperCase()
  if (!raw) return fallback
  if (!PAYOUT_TYPES.includes(raw as PayoutType)) throw new Error('Неизвестный тип выплаты')
  return raw as PayoutType
}
function payoutStatus(value: unknown, fallback: PayoutStatus): PayoutStatus {
  const raw = optionalText(value)?.toLowerCase()
  if (!raw) return fallback
  if (!PAYOUT_STATUSES.includes(raw as PayoutStatus)) throw new Error('Неизвестный статус выплаты')
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

// Суммы календаря выплат по периодам (§22): плитки ближайших месяцев и сетка из 12 шагов.
// Фильтры экрана (тип, инструмент, банк) применяются здесь же — клиент ничего не складывает (§10).
app.get('/api/payouts/outlook', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await settlePayouts(userId)
  const by = optionalText(request.query.by)
  const level: PeriodLevel = by === 'day' || by === 'year' ? by : 'month'
  const type = optionalText(request.query.type)
  const instrument = optionalText(request.query.instrument)
  const institution = optionalText(request.query.institution)
  const [payouts, positions] = await Promise.all([listPayouts(db, userId), institution ? listPositions(db, userId) : Promise.resolve([])])
  // Банк выплаты — её счёт; у выплаты на ручном счёте — банк позиции того же инструмента.
  const positionBank = new Map(positions.filter((item) => item.account.provider !== MANUAL_PROVIDER).map((item) => [item.instrumentId, item.account.provider]))
  const bankOf = (payout: Payout) =>
    payout.institution && payout.institution !== MANUAL_PROVIDER ? payout.institution : (payout.instrumentId ? positionBank.get(payout.instrumentId) : undefined)
  const matching = payouts.filter((payout) =>
    (!type || payout.type === type) && (!instrument || payout.instrumentId === instrument) && (!institution || bankOf(payout) === institution))
  const context = await engineContext(await resolveBaseCurrency(db, userId))
  response.json(payoutPeriods(matching, { today: localToday(), level, start: optionalText(request.query.start) }, (amount, currency) =>
    convertCurrency(amount, currency, context.baseCurrency, context.rates)))
})
app.get('/api/payouts', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await settlePayouts(userId)
  const payouts = await listPayouts(db, userId, listOptions(request))
  const context = await engineContext(await resolveBaseCurrency(db, userId))
  response.json(payouts.map((payout) => payoutToWire(payout, context)))
})
// Привязка выплаты к инструменту (§22, BUG-23): клиент передаёт позицию, из неё берутся
// инструмент, счёт и валюта. undefined — поле не прислано; null — выплата «ничья».
// Несуществующая или чужая позиция — ошибка, а не молчаливая выплата без инструмента.
async function payoutPosition(client: Db, userId: string, value: unknown) {
  if (value === undefined) return undefined
  const positionId = optionalText(value)
  if (!positionId) return null
  const position = await findPosition(client, userId, positionId)
  if (!position) throw new Error('Инструмент для выплаты не найден')
  return position
}
app.post('/api/payouts', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const body = (request.body ?? {}) as PositionBody
    const title = requiredText(body.title, 'title')
    const amount = positiveNumber(body.amount, 'amount')
    const date = requiredDate(body.date, 'date')
    const type = payoutType(body.type, 'OTHER')
    const status = payoutStatus(body.status, 'expected')
    const payout = await withTransaction(db, async (client) => {
      const position = await payoutPosition(client, userId, body.positionId) ?? undefined
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
        institution: position?.account.provider,
      }
      if (isAutoReceived(record, localToday())) record.status = 'received'
      await syncTransactionForPayout(client, userId, record, false)
      await insertPayout(client, record)
      return record
    })
    response.status(201).json(payoutToWire(payout, await engineContext(await resolveBaseCurrency(db, userId))))
  } catch (error) { response.status(400).json({ error: clientError(error, 'Не удалось сохранить выплату') }) }
})
// Отметка «уже реинвестировано» (снимает напоминание в «Требует внимания»). Сохраняется
// время первой отметки; повторная отметка его не сдвигает.
function reinvestedAt(value: unknown, current: string | undefined): string | undefined {
  if (value === undefined) return current
  if (typeof value !== 'boolean') throw new Error('reinvested: ожидается true или false')
  return value ? current ?? new Date().toISOString() : undefined
}
app.patch('/api/payouts/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const existing = await findPayout(db, userId, request.params.id)
    if (!existing) return response.status(404).json({ error: 'Выплата не найдена' })
    const body = (request.body ?? {}) as PositionBody
    const position = await payoutPosition(db, userId, body.positionId)
    const link = position === undefined ? {}
      : position === null ? { instrumentId: undefined }
      : { instrumentId: position.instrumentId, accountId: position.accountId, currency: position.instrument.currency }
    const updated: Payout = {
      ...existing,
      ...link,
      description: body.title !== undefined ? requiredText(body.title, 'title') : existing.description,
      amount: body.amount !== undefined ? positiveNumber(body.amount, 'amount') : existing.amount,
      date: body.date !== undefined ? requiredDate(body.date, 'date') : existing.date,
      type: body.type !== undefined ? payoutType(body.type, existing.type) : existing.type,
      status: body.status !== undefined ? payoutStatus(body.status, existing.status) : existing.status,
      reinvestedAt: reinvestedAt((request.body as { reinvested?: unknown }).reinvested, existing.reinvestedAt),
      // Правка прогнозной строки означает, что пользователь взял её под свой контроль:
      // дальше она живёт как ручная и переживает пересчёт, а прогноз на ту же дату/тип
      // повторно не создаётся благодаря дедупликации по (инструмент, дата, тип).
      source: existing.source === 'forecast' ? 'manual' : existing.source,
    }
    // Доход с прошедшей датой не бывает «ожидается»: он уже получен (settleDuePayouts).
    if (isAutoReceived(updated, localToday())) updated.status = 'received'
    await withTransaction(db, async (client) => {
      await syncTransactionForPayout(client, userId, updated)
      await updatePayout(client, userId, updated)
    })
    response.json(payoutToWire(updated, await engineContext(await resolveBaseCurrency(db, userId))))
  } catch (error) { response.status(400).json({ error: clientError(error, 'Не удалось сохранить выплату') }) }
})
app.delete('/api/payouts/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const existing = await findPayout(db, userId, request.params.id)
  if (!existing) return response.status(404).json({ error: 'Выплата не найдена' })
  // Выплата и её операция — одни и те же деньги (как в syncPayoutForTransaction):
  // удалённая выплата не оставляет в свободных деньгах сумму, которой больше нет.
  await withTransaction(db, async (client) => {
    await deletePayout(client, userId, existing.id)
    if (existing.transactionId && existing.source !== 'broker') await deleteTransaction(client, userId, existing.transactionId)
  })
  response.status(204).send()
})

// ---------------------------------------------------------------------------
// Операции (§11 Transaction)
// ---------------------------------------------------------------------------

const TRANSACTION_TYPES: TransactionType[] = ['BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'COUPON', 'DIVIDEND', 'INTEREST', 'FEE', 'TAX', 'REDEMPTION', 'OTHER']
// Денежные операции позиции не меняют: остаток считается из самих операций
// (sumCashBalances → portfolioEngineInputs, §12, BUG-05).
const POSITION_TYPES: TransactionType[] = ['BUY', 'SELL']
// Доход можно привязать к инструменту (необязательно): выплата попадёт в его карточку (§9).
// На денежный остаток привязка не влияет — он считается по валюте, а не по счёту (§12).
const INCOME_TYPES: TransactionType[] = ['COUPON', 'DIVIDEND', 'INTEREST']

function transactionType(value: unknown): TransactionType {
  const raw = requiredText(value, 'type').toUpperCase()
  if (!TRANSACTION_TYPES.includes(raw as TransactionType)) throw new Error('Неизвестный тип операции')
  return raw as TransactionType
}

// Позиции, затронутые одной операцией. Откат старого эффекта и применение нового
// обязаны попасть в один и тот же объект в памяти (иначе вторая запись затрёт первую),
// поэтому позиции кэшируются по id, а в БД уходят одним UPDATE на позицию в flush().
function createPositionCache(client: Db, userId: string) {
  const loaded = new Map<string, Position>()
  const touched = new Set<string>()
  return {
    async byId(id: string): Promise<Position | undefined> {
      const cached = loaded.get(id)
      if (cached) return cached
      // Блокировка строки до конца транзакции: параллельные операции по одной позиции
      // (двойной клик, несколько вкладок) иначе читали одно и то же количество и
      // затирали друг друга — 5 покупок давали прирост как от одной (тестер, P1).
      await client.query('SELECT 1 FROM portfolio.positions WHERE id = $1 FOR UPDATE', [id])
      const position = await findPosition(client, userId, id)
      if (position) loaded.set(id, position)
      return position
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
function shiftPosition(position: Position, delta: number, quantityDelta: number | undefined, investedDelta = delta) {
  if (position.value !== undefined) position.value = position.value + delta
  position.invested = Math.max(0, position.invested + investedDelta)
  // Количество меняется только у позиции, которая вообще учитывается в штуках.
  if (position.quantity !== undefined && quantityDelta !== undefined) {
    position.quantity = Math.max(0, position.quantity + quantityDelta)
    if (position.quantity > 0) position.averagePrice = Math.round(position.invested / position.quantity * 1e6) / 1e6
  }
}

// Продажа списывает с «вложено» не выручку, а себестоимость проданного по средней цене
// (тестер, P1): иначе продажа с прибылью обнуляла результат, а удаление продажи оставляло
// позицию с лишним «вложено». Себестоимость запоминается в самой операции (costBasis) —
// из неё считается реализованный результат (§10.2), и ровно она возвращается при откате.
function saleCostBasis(position: Position, transaction: Pick<Transaction, 'amount' | 'quantity'>): number {
  const share = position.quantity && transaction.quantity !== undefined
    ? transaction.quantity / position.quantity
    : position.value ? transaction.amount / position.value : 1
  return Math.round(position.invested * Math.min(1, Math.max(0, share)) * 100) / 100
}

async function applyTransactionEffect(positions: PositionCache, transaction: Pick<Transaction, 'type' | 'amount' | 'positionId' | 'quantity' | 'costBasis'>, direction: 1 | -1) {
  const amount = transaction.amount * direction
  const quantity = transaction.quantity !== undefined ? transaction.quantity * direction : undefined
  const position = transaction.positionId ? await positions.byId(transaction.positionId) : undefined
  if (transaction.type === 'BUY' && position) { shiftPosition(position, amount, quantity); positions.mark(position) }
  if (transaction.type === 'SELL' && position) {
    if (direction === 1) transaction.costBasis = saleCostBasis(position, transaction)
    // Продажа до миграции 012 себестоимости не знает — откатывается как раньше, по выручке.
    const cost = (transaction.costBasis ?? transaction.amount) * direction
    shiftPosition(position, -amount, quantity === undefined ? undefined : -quantity, -cost)
    positions.mark(position)
  }
}

// Продать можно не больше, чем есть: по сумме у позиции без количества, по штукам — у бумаг.
function assertSaleFits(transaction: Transaction, position: Position | undefined) {
  if (transaction.type !== 'SELL' || !position) return
  if (position.quantity !== undefined && transaction.quantity !== undefined) {
    if (transaction.quantity > position.quantity) throw new Error(`Нельзя продать больше, чем есть: в позиции ${position.quantity} шт.`)
    return
  }
  if ((position.value ?? 0) < transaction.amount) throw new Error('Нельзя продать больше, чем есть: сумма продажи больше стоимости позиции')
}

// Количество бумаг в операции. Если пользователь его не указал, а позиция учитывается
// в штуках, выводим из цены операции, иначе — из текущей или средней цены позиции:
// сохраняется в самой операции, чтобы удаление и правка отменяли ровно то же количество.
function transactionQuantity(body: PositionBody, amount: number, position: Position | undefined, existing?: Transaction): number | undefined {
  const explicit = optionalNumber(body.quantity)
  if (explicit !== undefined) {
    if (explicit <= 0) throw new Error('Количество должно быть больше нуля')
    return explicit
  }
  // Правка без количества и цены: сумма та же — количество то же; сумма другая —
  // пересчитываем по цене исходной операции, а не по сегодняшней котировке.
  if (existing?.quantity !== undefined && optionalNumber(body.price) === undefined) {
    if (amount === existing.amount) return existing.quantity
    if (existing.price) return amount / existing.price
  }
  // Старая операция, проведённая без количества, количества и не меняла — правка это сохраняет.
  if (existing && existing.quantity === undefined && optionalNumber(body.price) === undefined) return undefined
  if (position?.quantity === undefined) return undefined
  const price = optionalNumber(body.price) ?? position.currentPrice ?? position.averagePrice
  return price && price > 0 ? amount / price : undefined
}

// syncPayoutForTransaction — импортирован из daily-tasks.ts (используется и планировщиком).

async function buildTransaction(client: Db, userId: string, id: string, body: PositionBody, existing?: Transaction): Promise<Transaction> {
  const type = body.type !== undefined || !existing ? transactionType(body.type) : existing.type
  const amount = body.amount !== undefined || !existing ? positiveNumber(body.amount, 'amount') : existing.amount
  const date = body.date !== undefined || !existing ? requiredDate(body.date, 'date') : existing.date
  if (body.date !== undefined) notInFuture(date, 'date')
  const commission = optionalNumber(body.commission)
  const tax = optionalNumber(body.tax)
  checkNonNegative(commission, 'commission')
  checkNonNegative(tax, 'tax')
  const description = body.title !== undefined ? optionalText(body.title) : existing?.description
  // Операции с деньгами не привязаны к инструменту: они меняют денежную позицию (§12).
  const positionId = POSITION_TYPES.includes(type) || INCOME_TYPES.includes(type)
    ? (body.positionId !== undefined ? optionalText(body.positionId) : existing?.positionId)
    : undefined
  const position = positionId ? await findPosition(client, userId, positionId) : undefined
  if (POSITION_TYPES.includes(type) && !position) throw new Error('Для покупки и продажи выберите инструмент')
  if (positionId && !position) throw new Error('Инструмент не найден')
  const quantity = POSITION_TYPES.includes(type) ? transactionQuantity(body, amount, position, existing) : undefined
  const price = POSITION_TYPES.includes(type)
    ? (optionalNumber(body.price) ?? (quantity ? amount / quantity : undefined))
    : undefined

  return {
    id,
    accountId: position?.accountId ?? existing?.accountId ?? await defaultAccountId(client, userId),
    instrumentId: position?.instrumentId,
    positionId: position?.id,
    type,
    date,
    amount,
    currency: position?.instrument.currency ?? existing?.currency ?? 'RUB',
    quantity,
    price,
    commission: commission ?? existing?.commission ?? 0,
    tax: tax ?? existing?.tax ?? 0,
    description: description ?? type,
    source: existing?.source ?? 'manual',
  }
}

app.get('/api/transactions', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  await settlePayouts(userId)
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
      assertSaleFits(created, position)
      await applyTransactionEffect(positions, created, 1)
      await positions.flush()
      await insertTransaction(client, created)
      await syncPayoutForTransaction(client, created)
      await regenerateForecastPayouts(client, userId)
      await recordSnapshot(client, userId)
      return created
    })
    response.status(201).json(transactionToWire(transaction))
  } catch (error) { response.status(400).json({ error: clientError(error, 'Не удалось сохранить операцию') }) }
})
app.patch('/api/transactions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  try {
    const existing = await findTransaction(db, userId, request.params.id)
    if (!existing) return response.status(404).json({ error: 'Операция не найдена' })
    const updated = await withTransaction(db, async (client) => {
      const next = await buildTransaction(client, userId, existing.id, (request.body ?? {}) as PositionBody, existing)
      const positions = createPositionCache(client, userId)
      // Сначала снимаем эффект прежней версии операции, потом проверяем и накладываем новую;
      // при ошибке транзакция откатывается, поэтому возвращать эффект вручную не нужно.
      await applyTransactionEffect(positions, existing, -1)
      const position = next.positionId ? await positions.byId(next.positionId) : undefined
      assertSaleFits(next, position)
      await applyTransactionEffect(positions, next, 1)
      await positions.flush()
      await updateTransaction(client, userId, next)
      await syncPayoutForTransaction(client, next)
      await regenerateForecastPayouts(client, userId)
      await recordSnapshot(client, userId)
      return next
    })
    response.json(transactionToWire(updated))
  } catch (error) { response.status(400).json({ error: clientError(error, 'Не удалось сохранить операцию') }) }
})
app.delete('/api/transactions/:id', async (request, response) => {
  const userId = await currentUserId(request, response); if (!userId) return
  const existing = await findTransaction(db, userId, request.params.id)
  if (!existing) return response.status(404).json({ error: 'Операция не найдена' })
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

// Неизвестный адрес API — JSON, как и остальные ответы, а не HTML-страница Express (П17).
app.use('/api', (_request, response) => { response.status(404).json({ error: 'Нет такого метода API' }) })

app.use((error: Error, request: Request, response: Response, _next: express.NextFunction) => {
  // Слишком большое тело — не «внутренняя ошибка», а понятная просьба (тестировщик Т16).
  if ((error as { type?: string }).type === 'entity.too.large') {
    return response.status(413).json({
      error: STATEMENT_IMPORT_PATH.test(request.path)
        ? `Файл выписки слишком большой (больше ${STATEMENT_LIMIT_MB} МБ). Выгрузите выписку за более короткий период.`
        : 'Запрос слишком большой',
    })
  }
  // Битый JSON в теле — ошибка запроса, а не сервера (П16).
  if ((error as { type?: string }).type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Некорректный JSON в теле запроса' })
  }
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

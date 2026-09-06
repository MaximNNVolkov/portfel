import cors from 'cors'
import express, { type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

type Product = { id: string; name: string; type: string; amount: number; invested: number; ticker: string; date: string; institution: string; currency: string }
type Payment = { id: string; title: string; amount: number; date: string; type: string }
type Transaction = { id: string; title: string; amount: number; date: string; kind: string; productId?: string }
type Store = { products: Product[]; payments: Payment[]; transactions: Transaction[] }
type User = { id: string; email: string; passwordHash: string; salt: string }
type BrokerConnection = { provider: 'tinkoff'; connectedAt: string; maskedToken: string; status: 'connected' | 'pending' }

const app = express()
const port = Number(process.env.PORT || 3001)
const dataPath = resolve(process.cwd(), 'server/data.json')
const usersPath = resolve(process.cwd(), 'server/users.json')
const users = new Map<string, User>()
const sessions = new Set<string>()
const brokerConnections = new Map<string, BrokerConnection>()

app.use(cors())
app.use(express.json())
app.use('/uploads', express.static(resolve(process.cwd(), 'server/uploads')))

async function readStore(): Promise<Store> {
  return JSON.parse(await readFile(dataPath, 'utf8')) as Store
}
async function loadUsers() {
  const saved = JSON.parse(await readFile(usersPath, 'utf8')) as User[]
  for (const user of saved) users.set(user.id, user)
}
async function saveUsers() { await writeFile(usersPath, `${JSON.stringify([...users.values()], null, 2)}\n`) }
async function writeStore(store: Store) {
  await writeFile(dataPath, `${JSON.stringify(store, null, 2)}\n`)
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}
function positiveNumber(value: unknown, field: string): number {
  const result = Number(value)
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${field} must be positive`)
  return result
}
function hashPassword(password: string, salt: string) { return scryptSync(password, salt, 64).toString('hex') }
function authToken(request: Request) { const value = request.headers.authorization; return value?.startsWith('Bearer ') ? value.slice(7) : '' }
function requireAuth(request: Request, response: Response): boolean { if (!sessions.has(authToken(request))) { response.status(401).json({ error: 'Authentication required' }); return false } return true }

app.post('/api/auth/register', async (request, response) => {
  try {
    const email = requiredText(request.body?.email, 'email').toLowerCase()
    const password = requiredText(request.body?.password, 'password')
    if (password.length < 8) return response.status(400).json({ error: 'Password must contain at least 8 characters' })
    if ([...users.values()].some((user) => user.email === email)) return response.status(409).json({ error: 'Email already registered' })
    const salt = randomBytes(16).toString('hex'); const user = { id: randomUUID(), email, passwordHash: hashPassword(password, salt), salt }
    users.set(user.id, user); await saveUsers(); const token = randomBytes(32).toString('hex'); sessions.add(token)
    response.status(201).json({ token, user: { id: user.id, email: user.email } })
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid credentials' }) }
})
app.post('/api/auth/login', (request, response) => {
  const email = typeof request.body?.email === 'string' ? request.body.email.toLowerCase().trim() : ''
  const password = typeof request.body?.password === 'string' ? request.body.password : ''
  const user = [...users.values()].find((item) => item.email === email)
  if (!user || !timingSafeEqual(Buffer.from(user.passwordHash, 'hex'), Buffer.from(hashPassword(password, user.salt), 'hex'))) return response.status(401).json({ error: 'Invalid email or password' })
  const token = randomBytes(32).toString('hex'); sessions.add(token); response.json({ token, user: { id: user.id, email: user.email } })
})
app.get('/api/auth/me', (request, response) => { if (!requireAuth(request, response)) return; response.json({ authenticated: true }) })
app.get('/api/brokers/tinkoff', (request, response) => { if (!requireAuth(request, response)) return; response.json(brokerConnections.get(authToken(request)) || { status: 'disconnected', provider: 'tinkoff' }) })
app.post('/api/brokers/tinkoff/connect', (request, response) => {
  if (!requireAuth(request, response)) return
  const token = requiredText(request.body?.token, 'token')
  const connection: BrokerConnection = { provider: 'tinkoff', connectedAt: new Date().toISOString(), maskedToken: `${token.slice(0, 4)}••••${token.slice(-4)}`, status: 'pending' }
  brokerConnections.set(authToken(request), connection)
  response.status(202).json({ ...connection, message: 'Токен принят. Синхронизация будет запущена после настройки Tinkoff Invest API.' })
})
app.post('/api/brokers/tinkoff/sync', (request, response) => { if (!requireAuth(request, response)) return; const connection = brokerConnections.get(authToken(request)); if (!connection) return response.status(409).json({ error: 'Broker is not connected' }); response.status(202).json({ status: 'pending', message: 'Синхронизация ожидает подключения провайдера рыночных данных.' }) })

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'portfolio-api' }))
app.post('/api/ocr/preview', async (request, response) => {
  if (!requireAuth(request, response)) return
  const filename = requiredText(request.body?.filename, 'filename')
  response.status(202).json({ status: 'needs_confirmation', source: filename, items: [{ name: 'Распознанный продукт', type: 'Облигации', amount: 0, institution: 'Проверьте источник', confidence: 0.62 }], message: 'Результат подготовлен для проверки. OCR-провайдер подключается отдельно.' })
})
app.get('/api/portfolio/summary', async (_request, response) => {
  if (!requireAuth(_request, response)) return
  const store = await readStore()
  const total = store.products.reduce((sum, item) => sum + item.amount, 0)
  const invested = store.products.reduce((sum, item) => sum + item.invested, 0)
  const expected = store.payments.reduce((sum, item) => sum + item.amount, 0)
  const paid = store.transactions.filter((item) => item.kind === 'Выплата').reduce((sum, item) => sum + item.amount, 0)
  response.json({ total, invested, profit: total - invested, expected, paid, products: store.products.length })
})

app.get('/api/products', async (request, response) => { if (!requireAuth(request, response)) return; response.json((await readStore()).products) })
app.post('/api/products', async (request, response) => {
  if (!requireAuth(request, response)) return
  try {
    const body = request.body as Partial<Product>
    const product: Product = {
      id: randomUUID(), name: requiredText(body.name, 'name'), type: requiredText(body.type, 'type'),
      amount: positiveNumber(body.amount, 'amount'), invested: positiveNumber(body.invested ?? body.amount, 'invested'),
      ticker: typeof body.ticker === 'string' ? body.ticker.trim() : '', date: requiredText(body.date, 'date'),
      institution: typeof body.institution === 'string' ? body.institution.trim() : 'Ручной ввод', currency: typeof body.currency === 'string' ? body.currency : 'RUB',
    }
    const store = await readStore(); store.products.push(product); await writeStore(store); response.status(201).json(product)
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid product' }) }
})
app.delete('/api/products/:id', async (request, response) => {
  if (!requireAuth(request, response)) return
  const store = await readStore(); const before = store.products.length; store.products = store.products.filter((item) => item.id !== request.params.id)
  if (store.products.length === before) return response.status(404).json({ error: 'Product not found' })
  await writeStore(store); response.status(204).send()
})

app.get('/api/payments', async (request, response) => { if (!requireAuth(request, response)) return; response.json((await readStore()).payments) })
app.post('/api/payments', async (request, response) => {
  if (!requireAuth(request, response)) return
  try {
    const body = request.body as Partial<Payment>
    const payment: Payment = { id: randomUUID(), title: requiredText(body.title, 'title'), amount: positiveNumber(body.amount, 'amount'), date: requiredText(body.date, 'date'), type: requiredText(body.type || 'Прочее', 'type') }
    const store = await readStore(); store.payments.push(payment); await writeStore(store); response.status(201).json(payment)
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid payment' }) }
})
app.get('/api/transactions', async (request, response) => { if (!requireAuth(request, response)) return; response.json((await readStore()).transactions) })
app.post('/api/transactions', async (request, response) => {
  if (!requireAuth(request, response)) return
  try {
    const body = request.body as Partial<Transaction>
    const kind = requiredText(body.kind, 'kind')
    if (!['Пополнение', 'Покупка', 'Продажа', 'Выплата'].includes(kind)) throw new Error('Unsupported transaction kind')
    const amount = positiveNumber(body.amount, 'amount')
    const store = await readStore()
    const product = body.productId ? store.products.find((item) => item.id === body.productId) : undefined
    if (['Покупка', 'Продажа'].includes(kind) && !product) throw new Error('productId is required for buy or sell')
    if (kind === 'Покупка' && product) { product.amount += amount; product.invested += amount }
    if (kind === 'Продажа' && product) { if (product.amount < amount) throw new Error('Sale exceeds current position'); product.amount -= amount; product.invested = Math.max(0, product.invested - amount) }
    if (kind === 'Пополнение' || kind === 'Выплата') {
      const cash = store.products.find((item) => item.type === 'Деньги')
      if (cash) { cash.amount += amount; cash.invested += amount }
    }
    const transaction: Transaction = { id: randomUUID(), title: requiredText(body.title, 'title'), amount, date: requiredText(body.date, 'date'), kind, productId: body.productId }
    store.transactions.push(transaction); await writeStore(store); response.status(201).json(transaction)
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid transaction' }) }
})

app.use((error: Error, _request: Request, response: Response, _next: express.NextFunction) => response.status(500).json({ error: error.message }))
void loadUsers().then(() => app.listen(port, () => console.log(`Portfolio API listening on http://localhost:${port}`)))

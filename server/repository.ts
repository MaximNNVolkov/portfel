// Репозиторий доступа к данным пользователя (§11).
//
// Ранее любое изменение переписывало весь портфель: DELETE всех строк пользователя
// + массовый INSERT. При 10 000 инструментов и 100 000 операций (§34) это неприемлемо,
// плюс каждая правка переписывала created_at и ломала любые внешние ссылки на строки.
// Здесь — точечные INSERT/UPDATE/DELETE по одной записи, вызывающий код сам решает,
// что именно изменилось.
import type { Pool, PoolClient } from 'pg'

// Любой исполнитель запроса: пул (автокоммит) или клиент внутри транзакции.
export type Db = Pool | PoolClient

export type Product = {
  id: string; name: string; type: string; amount: number; invested: number; ticker: string; date: string; institution: string; currency: string; source: string
  isin?: string; quantity?: number; averagePrice?: number; currentPrice?: number
  nominal?: number; accruedInterest?: number; couponRate?: number; couponDate?: string; maturityDate?: string; ofertaDate?: string; amortization?: boolean
  rate?: number; effectiveRate?: number; capitalization?: boolean; termEndDate?: string; interestPayoutFrequency?: string; replenishable?: boolean; partialWithdrawal?: boolean; autoProlongation?: boolean
}
export type Payment = { id: string; title: string; amount: number; date: string; type: string }
export type Transaction = { id: string; title: string; amount: number; date: string; kind: string; productId?: string }
export type Store = { products: Product[]; payments: Payment[]; transactions: Transaction[] }

const PRODUCT_COLUMNS = [
  'id', 'user_id', 'name', 'type', 'amount', 'invested', 'ticker', 'purchase_date', 'institution', 'currency', 'source',
  'isin', 'quantity', 'average_price', 'current_price',
  'nominal', 'accrued_interest', 'coupon_rate', 'coupon_date', 'maturity_date', 'oferta_date', 'amortization',
  'rate', 'effective_rate', 'capitalization', 'term_end_date', 'interest_payout_frequency', 'replenishable', 'partial_withdrawal', 'auto_prolongation',
] as const
// Всё, кроме id и user_id: они попадают в WHERE, а не в SET.
const PRODUCT_VALUE_COLUMNS = PRODUCT_COLUMNS.slice(2)

function productRowValues(product: Product, userId: string): unknown[] {
  return [
    product.id, userId, product.name, product.type, product.amount, product.invested,
    product.ticker || null, product.date, product.institution || 'Ручной ввод', product.currency || 'RUB', product.source || 'manual',
    product.isin || null, product.quantity ?? null, product.averagePrice ?? null, product.currentPrice ?? null,
    product.nominal ?? null, product.accruedInterest ?? null, product.couponRate ?? null, product.couponDate || null, product.maturityDate || null, product.ofertaDate || null, product.amortization ?? null,
    product.rate ?? null, product.effectiveRate ?? null, product.capitalization ?? null, product.termEndDate || null, product.interestPayoutFrequency || null, product.replenishable ?? null, product.partialWithdrawal ?? null, product.autoProlongation ?? null,
  ]
}

function mapProduct(row: any): Product {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    amount: Number(row.amount),
    invested: Number(row.invested),
    ticker: row.ticker || '',
    date: row.purchase_date,
    institution: row.institution || 'Ручной ввод',
    currency: row.currency || 'RUB',
    source: row.source || 'manual',
    isin: row.isin || undefined,
    quantity: row.quantity !== null ? Number(row.quantity) : undefined,
    averagePrice: row.average_price !== null ? Number(row.average_price) : undefined,
    currentPrice: row.current_price !== null ? Number(row.current_price) : undefined,
    nominal: row.nominal !== null ? Number(row.nominal) : undefined,
    accruedInterest: row.accrued_interest !== null ? Number(row.accrued_interest) : undefined,
    couponRate: row.coupon_rate !== null ? Number(row.coupon_rate) : undefined,
    couponDate: row.coupon_date || undefined,
    maturityDate: row.maturity_date || undefined,
    ofertaDate: row.oferta_date || undefined,
    amortization: row.amortization ?? undefined,
    rate: row.rate !== null ? Number(row.rate) : undefined,
    effectiveRate: row.effective_rate !== null ? Number(row.effective_rate) : undefined,
    capitalization: row.capitalization ?? undefined,
    termEndDate: row.term_end_date || undefined,
    interestPayoutFrequency: row.interest_payout_frequency || undefined,
    replenishable: row.replenishable ?? undefined,
    partialWithdrawal: row.partial_withdrawal ?? undefined,
    autoProlongation: row.auto_prolongation ?? undefined,
  }
}
function mapPayment(row: any): Payment {
  return { id: row.id, title: row.title, amount: Number(row.amount), date: row.payment_date, type: row.type }
}
function mapTransaction(row: any): Transaction {
  return { id: row.id, title: row.title, amount: Number(row.amount), date: row.tx_date, kind: row.kind, productId: row.product_id || undefined }
}

// Порядок строк общий для всех выборок: он же определяет, какой продукт считается
// «первым денежным счётом» при разноске пополнений и выплат.
const PRODUCT_ORDER = 'ORDER BY purchase_date ASC, name ASC'

export async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function listProducts(db: Db, userId: string): Promise<Product[]> {
  const result = await db.query(`SELECT * FROM products WHERE user_id = $1 ${PRODUCT_ORDER}`, [userId])
  return result.rows.map(mapProduct)
}
export async function listPayments(db: Db, userId: string): Promise<Payment[]> {
  const result = await db.query('SELECT * FROM payments WHERE user_id = $1 ORDER BY payment_date ASC, title ASC', [userId])
  return result.rows.map(mapPayment)
}
export async function listTransactions(db: Db, userId: string): Promise<Transaction[]> {
  const result = await db.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY tx_date ASC, title ASC', [userId])
  return result.rows.map(mapTransaction)
}
export async function loadStore(db: Db, userId: string): Promise<Store> {
  const [products, payments, transactions] = await Promise.all([
    listProducts(db, userId),
    listPayments(db, userId),
    listTransactions(db, userId),
  ])
  return { products, payments, transactions }
}

export async function findProduct(db: Db, userId: string, id: string): Promise<Product | undefined> {
  const result = await db.query('SELECT * FROM products WHERE id = $1 AND user_id = $2', [id, userId])
  return result.rows[0] ? mapProduct(result.rows[0]) : undefined
}
// Денежный счёт, на который ложатся пополнения и выплаты (§12).
export async function findCashProduct(db: Db, userId: string): Promise<Product | undefined> {
  const result = await db.query(`SELECT * FROM products WHERE user_id = $1 AND type = 'Деньги' ${PRODUCT_ORDER} LIMIT 1`, [userId])
  return result.rows[0] ? mapProduct(result.rows[0]) : undefined
}
export async function insertProduct(db: Db, userId: string, product: Product): Promise<void> {
  const placeholders = PRODUCT_COLUMNS.map((_column, index) => `$${index + 1}`).join(', ')
  await db.query(`INSERT INTO products (${PRODUCT_COLUMNS.join(', ')}) VALUES (${placeholders})`, productRowValues(product, userId))
}
export async function updateProduct(db: Db, userId: string, product: Product): Promise<boolean> {
  // Значения идут в том же порядке, что и при вставке: $1 = id, $2 = user_id уходят в WHERE.
  const assignments = PRODUCT_VALUE_COLUMNS.map((column, index) => `${column} = $${index + 3}`).join(', ')
  const result = await db.query(`UPDATE products SET ${assignments} WHERE id = $1 AND user_id = $2`, productRowValues(product, userId))
  return (result.rowCount ?? 0) > 0
}
// Точечная разноска операции по позиции: трогаем только стоимость и вложенную сумму.
export async function updateProductPosition(db: Db, userId: string, product: Product): Promise<void> {
  await db.query('UPDATE products SET amount = $3, invested = $4 WHERE id = $1 AND user_id = $2', [product.id, userId, product.amount, product.invested])
}
export async function deleteProduct(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM products WHERE id = $1 AND user_id = $2', [id, userId])
  return (result.rowCount ?? 0) > 0
}

export async function findPayment(db: Db, userId: string, id: string): Promise<Payment | undefined> {
  const result = await db.query('SELECT * FROM payments WHERE id = $1 AND user_id = $2', [id, userId])
  return result.rows[0] ? mapPayment(result.rows[0]) : undefined
}
export async function insertPayment(db: Db, userId: string, payment: Payment): Promise<void> {
  await db.query(
    'INSERT INTO payments (id, user_id, title, amount, payment_date, type) VALUES ($1, $2, $3, $4, $5, $6)',
    [payment.id, userId, payment.title, payment.amount, payment.date, payment.type],
  )
}
export async function updatePayment(db: Db, userId: string, payment: Payment): Promise<boolean> {
  const result = await db.query(
    'UPDATE payments SET title = $3, amount = $4, payment_date = $5, type = $6 WHERE id = $1 AND user_id = $2',
    [payment.id, userId, payment.title, payment.amount, payment.date, payment.type],
  )
  return (result.rowCount ?? 0) > 0
}
export async function deletePayment(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM payments WHERE id = $1 AND user_id = $2', [id, userId])
  return (result.rowCount ?? 0) > 0
}

export async function findTransaction(db: Db, userId: string, id: string): Promise<Transaction | undefined> {
  const result = await db.query('SELECT * FROM transactions WHERE id = $1 AND user_id = $2', [id, userId])
  return result.rows[0] ? mapTransaction(result.rows[0]) : undefined
}
export async function insertTransaction(db: Db, userId: string, transaction: Transaction): Promise<void> {
  await db.query(
    'INSERT INTO transactions (id, user_id, title, amount, kind, tx_date, product_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [transaction.id, userId, transaction.title, transaction.amount, transaction.kind, transaction.date, transaction.productId || null],
  )
}
export async function updateTransaction(db: Db, userId: string, transaction: Transaction): Promise<boolean> {
  const result = await db.query(
    'UPDATE transactions SET title = $3, amount = $4, kind = $5, tx_date = $6, product_id = $7 WHERE id = $1 AND user_id = $2',
    [transaction.id, userId, transaction.title, transaction.amount, transaction.kind, transaction.date, transaction.productId || null],
  )
  return (result.rowCount ?? 0) > 0
}
export async function deleteTransaction(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [id, userId])
  return (result.rowCount ?? 0) > 0
}

export async function upsertSnapshot(db: Db, userId: string, id: string, date: string, value: number): Promise<void> {
  await db.query(
    `INSERT INTO portfolio_snapshots (id, user_id, snapshot_date, total_value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, snapshot_date) DO UPDATE SET total_value = EXCLUDED.total_value`,
    [id, userId, date, value],
  )
}
export async function listSnapshots(db: Db, userId: string): Promise<Array<{ date: string; value: number }>> {
  const result = await db.query('SELECT snapshot_date, total_value FROM portfolio_snapshots WHERE user_id = $1 ORDER BY snapshot_date ASC', [userId])
  return result.rows.map((row) => ({ date: row.snapshot_date, value: Number(row.total_value) }))
}

// Полное удаление аккаунта (§28): пользователь должен иметь возможность стереть себя целиком.
export async function deleteUserData(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM products WHERE user_id = $1', [userId])
  await db.query('DELETE FROM payments WHERE user_id = $1', [userId])
  await db.query('DELETE FROM transactions WHERE user_id = $1', [userId])
  await db.query('DELETE FROM portfolio_snapshots WHERE user_id = $1', [userId])
  await db.query('DELETE FROM broker_connections WHERE user_id = $1', [userId])
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId])
  await db.query('DELETE FROM users WHERE id = $1', [userId])
}

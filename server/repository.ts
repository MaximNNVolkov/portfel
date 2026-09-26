// Репозиторий доступа к данным пользователя — целевая схема §11 (схема БД `portfolio`).
//
// В public остались только users и sessions (§5): legacy-таблицы старой версии перенесены
// в схему `portfolio` миграцией 003_new_schema.sql и удалены 005_drop_legacy.sql.
//
// Изменения точечные (INSERT/UPDATE/DELETE по одной записи): полная перезапись портфеля
// при каждой правке неприемлема на объёмах §34 (10 000 инструментов, 100 000 операций).
import type { Pool, PoolClient } from 'pg'

// Любой исполнитель запроса: пул (автокоммит) или клиент внутри транзакции.
export type Db = Pool | PoolClient
// Пул реэкспортируется, чтобы фоновые модули (server/ocr.ts) могли типизировать свой
// параметр без прямого импорта 'pg' — очередь работает только на пуле, не на клиенте
// внутри транзакции: она сама открывает транзакцию на каждый шаг.
export type { Pool }

export type DataSource = 'manual' | 'ocr' | 'broker'
export type AssetGroupType = 'deposit' | 'bond' | 'share' | 'fund' | 'cash' | 'other'
export type AccountType = 'broker' | 'bank' | 'cash' | 'other'
export type TransactionType =
  | 'BUY' | 'SELL' | 'DEPOSIT' | 'WITHDRAW' | 'COUPON' | 'DIVIDEND'
  | 'INTEREST' | 'FEE' | 'TAX' | 'REDEMPTION' | 'OTHER'
export type PayoutType = 'COUPON' | 'DIVIDEND' | 'INTEREST' | 'DEPOSIT_PRINCIPAL' | 'REDEMPTION' | 'OTHER'
export type PayoutStatus = 'expected' | 'received'
// Происхождение выплаты: 'forecast' — рассчитана системой из параметров инструмента (§15, §22)
// и пересоздаётся при каждом пересчёте; остальные источники пересчёт никогда не трогает.
export type PayoutSource = 'manual' | 'forecast' | 'broker'
export type BrokerStatus = 'disconnected' | 'pending' | 'connected' | 'error'

export type Portfolio = { id: string; name: string; baseCurrency: string }
export type Account = {
  id: string; portfolioId: string; type: AccountType; provider: string
  accountNumberMasked?: string; currency: string; status: string
}

// §11 Instrument + параметры облигаций (§14) и вкладов (§15).
export type Instrument = {
  id: string
  groupType: AssetGroupType
  instrumentType: string
  name: string
  currency: string
  source: DataSource
  ticker?: string
  isin?: string
  issuer?: string
  nominal?: number
  maturityDate?: string
  couponRate?: number
  couponDate?: string
  ofertaDate?: string
  amortization?: boolean
  rate?: number
  effectiveRate?: number
  capitalization?: boolean
  termEndDate?: string
  interestPayoutFrequency?: string
  replenishable?: boolean
  partialWithdrawal?: boolean
  autoProlongation?: boolean
}

// §11 Position. value (current_value) необязателен: отсутствие цены не подменяется нулём (§7.3).
export type PositionRecord = {
  id: string
  accountId: string
  instrumentId: string
  invested: number
  source: DataSource
  value?: number
  quantity?: number
  averagePrice?: number
  currentPrice?: number
  accruedInterest?: number
  openedOn?: string
}
export type Position = PositionRecord & {
  instrument: Instrument
  account: { id: string; type: AccountType; provider: string; currency: string }
}

export type Transaction = {
  id: string
  accountId: string
  type: TransactionType
  date: string
  amount: number
  currency: string
  commission: number
  tax: number
  source: DataSource
  instrumentId?: string
  /** Позиция (счёт + инструмент), которой касается операция. В таблице не хранится — выводится джойном. */
  positionId?: string
  quantity?: number
  price?: number
  description?: string
  /** Идентификатор операции у брокера — ключ идемпотентности повторной синхронизации. */
  externalId?: string
}

export type Payout = {
  id: string
  accountId: string
  date: string
  type: PayoutType
  amount: number
  currency: string
  status: PayoutStatus
  source: PayoutSource
  instrumentId?: string
  transactionId?: string
  description?: string
}

export type BrokerConnection = {
  id: string
  brokerType: string
  tokenMasked?: string
  /** Токен в зашифрованном виде (§28) — расшифровывается только на момент вызова коннектора. */
  encryptedToken?: string
  status: BrokerStatus
  lastSyncAt?: string
  lastError?: string
  createdAt: string
}

function num(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value)
}
function text(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value)
}
function flag(value: unknown): boolean | undefined {
  return value === null || value === undefined ? undefined : Boolean(value)
}

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

// Пагинация списков (§33). Ограничение применяется к выборке, а не к уже полученным строкам.
export type ListOptions = { limit?: number; offset?: number }
function paginate(options: ListOptions | undefined, nextParam: number): { clause: string; values: number[] } {
  const values: number[] = []
  let clause = ''
  if (options?.limit !== undefined) { clause += ` LIMIT $${nextParam + values.length}`; values.push(options.limit) }
  if (options?.offset !== undefined) { clause += ` OFFSET $${nextParam + values.length}`; values.push(options.offset) }
  return { clause, values }
}

// ---------------------------------------------------------------------------
// Портфель и счета (§11 Portfolio, Account)
// ---------------------------------------------------------------------------

function mapPortfolio(row: any): Portfolio {
  return { id: row.id, name: row.name, baseCurrency: row.base_currency }
}

export async function findPortfolio(db: Db, userId: string): Promise<Portfolio | undefined> {
  const result = await db.query(
    'SELECT id, name, base_currency FROM portfolio.portfolios WHERE user_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1',
    [userId],
  )
  return result.rows[0] ? mapPortfolio(result.rows[0]) : undefined
}

// Перечисление всех портфелей всех пользователей — нужно только планировщику фоновых задач
// (§19/§21/§32): единственное место, которому требуется работать «поперёк» пользователей,
// а не в рамках одной сессии, поэтому нет обычной проверки владения.
export async function listAllPortfolios(db: Db): Promise<Array<{ userId: string; portfolioId: string }>> {
  const result = await db.query('SELECT user_id, id FROM portfolio.portfolios')
  return result.rows.map((row) => ({ userId: row.user_id, portfolioId: row.id }))
}

// Портфель заводится лениво, при первом сохранении данных: у пустого аккаунта строки нет.
// Мультипортфельность (§4, §13) схема поддерживает, UI на MVP работает с первым портфелем.
export async function ensurePortfolio(db: Db, userId: string, id: string, baseCurrency = 'RUB'): Promise<Portfolio> {
  const existing = await findPortfolio(db, userId)
  if (existing) return existing
  const result = await db.query(
    `INSERT INTO portfolio.portfolios (id, user_id, name, base_currency) VALUES ($1, $2, 'Основной портфель', $3)
     RETURNING id, name, base_currency`,
    [id, userId, baseCurrency],
  )
  return mapPortfolio(result.rows[0])
}

// §13/§6.10: настройки портфеля (название, базовая валюта) — правит уже существующие
// колонки Portfolio, а не отдельное JSONB-хранилище, чтобы не заводить второй источник
// истины для полей, для которых схема §11 уже даёт первоклассные колонки.
export async function updatePortfolio(db: Db, userId: string, portfolioId: string, patch: { name?: string; baseCurrency?: string }): Promise<Portfolio> {
  const result = await db.query(
    `UPDATE portfolio.portfolios SET name = COALESCE($3, name), base_currency = COALESCE($4, base_currency)
     WHERE id = $1 AND user_id = $2 RETURNING id, name, base_currency`,
    [portfolioId, userId, patch.name ?? null, patch.baseCurrency ?? null],
  )
  return mapPortfolio(result.rows[0])
}

function mapAccount(row: any): Account {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    type: row.type,
    provider: row.provider || 'Ручной ввод',
    accountNumberMasked: text(row.account_number_masked),
    currency: row.currency,
    status: row.status,
  }
}

export async function listAccounts(db: Db, userId: string): Promise<Account[]> {
  const result = await db.query(
    `SELECT a.id, a.portfolio_id, a.type, a.provider, a.account_number_masked, a.currency, a.status
       FROM portfolio.accounts a
       JOIN portfolio.portfolios f ON f.id = a.portfolio_id
      WHERE f.user_id = $1
      ORDER BY a.provider ASC, a.currency ASC`,
    [userId],
  )
  return result.rows.map(mapAccount)
}

// Счёт определяется парой (учреждение, валюта) — тем же ключом, которым пользовался бэкфилл,
// поэтому повторное сохранение в тот же банк/брокер не плодит счета-дубликаты.
export async function ensureAccount(
  db: Db,
  portfolioId: string,
  id: string,
  account: { type: AccountType; provider: string; currency: string },
): Promise<Account> {
  const existing = await db.query(
    `SELECT id, portfolio_id, type, provider, account_number_masked, currency, status
       FROM portfolio.accounts WHERE portfolio_id = $1 AND provider = $2 AND currency = $3
       ORDER BY created_at ASC LIMIT 1`,
    [portfolioId, account.provider, account.currency],
  )
  if (existing.rows[0]) return mapAccount(existing.rows[0])
  const result = await db.query(
    `INSERT INTO portfolio.accounts (id, portfolio_id, type, provider, currency) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, portfolio_id, type, provider, account_number_masked, currency, status`,
    [id, portfolioId, account.type, account.provider, account.currency],
  )
  return mapAccount(result.rows[0])
}

// ---------------------------------------------------------------------------
// Инструменты (§11 Instrument)
// ---------------------------------------------------------------------------

const INSTRUMENT_FIELDS = `
  i.id AS instrument_id, g.type AS group_type, i.instrument_type, i.name, i.ticker, i.isin,
  i.currency AS instrument_currency, i.issuer, i.nominal, i.maturity_date, i.coupon_rate,
  i.coupon_date, i.oferta_date, i.amortization, i.rate, i.effective_rate, i.capitalization,
  i.term_end_date, i.interest_payout_frequency, i.replenishable, i.partial_withdrawal,
  i.auto_prolongation, i.source AS instrument_source`

const INSTRUMENT_FROM = `
  FROM portfolio.instruments i
  JOIN portfolio.asset_groups g ON g.id = i.asset_group_id`

function mapInstrument(row: any): Instrument {
  return {
    id: row.instrument_id,
    groupType: row.group_type,
    instrumentType: row.instrument_type,
    name: row.name,
    currency: row.instrument_currency || 'RUB',
    source: row.instrument_source || 'manual',
    ticker: text(row.ticker),
    isin: text(row.isin),
    issuer: text(row.issuer),
    nominal: num(row.nominal),
    maturityDate: text(row.maturity_date),
    couponRate: num(row.coupon_rate),
    couponDate: text(row.coupon_date),
    ofertaDate: text(row.oferta_date),
    amortization: flag(row.amortization),
    rate: num(row.rate),
    effectiveRate: num(row.effective_rate),
    capitalization: flag(row.capitalization),
    termEndDate: text(row.term_end_date),
    interestPayoutFrequency: text(row.interest_payout_frequency),
    replenishable: flag(row.replenishable),
    partialWithdrawal: flag(row.partial_withdrawal),
    autoProlongation: flag(row.auto_prolongation),
  }
}

function instrumentValues(instrument: Instrument): unknown[] {
  return [
    instrument.instrumentType, instrument.name, instrument.ticker ?? null, instrument.isin ?? null,
    instrument.currency || 'RUB', instrument.issuer ?? null, instrument.nominal ?? null,
    instrument.maturityDate ?? null, instrument.couponRate ?? null, instrument.couponDate ?? null,
    instrument.ofertaDate ?? null, instrument.amortization ?? null, instrument.rate ?? null,
    instrument.effectiveRate ?? null, instrument.capitalization ?? null, instrument.termEndDate ?? null,
    instrument.interestPayoutFrequency ?? null, instrument.replenishable ?? null,
    instrument.partialWithdrawal ?? null, instrument.autoProlongation ?? null,
  ]
}

export async function listInstruments(db: Db, userId: string, options?: ListOptions): Promise<Instrument[]> {
  const page = paginate(options, 2)
  const result = await db.query(
    `SELECT ${INSTRUMENT_FIELDS} ${INSTRUMENT_FROM} WHERE i.owner_user_id = $1 ORDER BY i.name ASC${page.clause}`,
    [userId, ...page.values],
  )
  return result.rows.map(mapInstrument)
}

export async function findInstrument(db: Db, userId: string, id: string): Promise<Instrument | undefined> {
  const result = await db.query(
    `SELECT ${INSTRUMENT_FIELDS} ${INSTRUMENT_FROM} WHERE i.id = $1 AND i.owner_user_id = $2`,
    [id, userId],
  )
  return result.rows[0] ? mapInstrument(result.rows[0]) : undefined
}

// Сопоставление инструмента брокера с уже существующим у пользователя — по ISIN, затем
// по тикеру (ISIN однозначнее и не пересекается между инструментами разных типов).
export async function findInstrumentByKey(
  db: Db, userId: string, key: { isin?: string; ticker?: string },
): Promise<Instrument | undefined> {
  if (!key.isin && !key.ticker) return undefined
  const result = await db.query(
    `SELECT ${INSTRUMENT_FIELDS} ${INSTRUMENT_FROM}
      WHERE i.owner_user_id = $1 AND ((i.isin = $2 AND $2 IS NOT NULL) OR (i.ticker = $3 AND $3 IS NOT NULL))
      LIMIT 1`,
    [userId, key.isin ?? null, key.ticker ?? null],
  )
  return result.rows[0] ? mapInstrument(result.rows[0]) : undefined
}

export async function insertInstrument(db: Db, userId: string, instrument: Instrument): Promise<void> {
  await db.query(
    `INSERT INTO portfolio.instruments (
       id, asset_group_id, owner_user_id, source,
       instrument_type, name, ticker, isin, currency, issuer, nominal, maturity_date, coupon_rate,
       coupon_date, oferta_date, amortization, rate, effective_rate, capitalization, term_end_date,
       interest_payout_frequency, replenishable, partial_withdrawal, auto_prolongation
     ) VALUES (
       $1, (SELECT id FROM portfolio.asset_groups WHERE type = $2), $3, $4,
       $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
     )`,
    [instrument.id, instrument.groupType, userId, instrument.source, ...instrumentValues(instrument)],
  )
}

// source не меняется при правке: запись, добавленная со скриншота, остаётся помеченной
// как распознанная и после ручного редактирования (§40.4).
export async function updateInstrument(db: Db, userId: string, instrument: Instrument): Promise<boolean> {
  const result = await db.query(
    `UPDATE portfolio.instruments SET
       asset_group_id = (SELECT id FROM portfolio.asset_groups WHERE type = $3),
       instrument_type = $4, name = $5, ticker = $6, isin = $7, currency = $8, issuer = $9,
       nominal = $10, maturity_date = $11, coupon_rate = $12, coupon_date = $13, oferta_date = $14,
       amortization = $15, rate = $16, effective_rate = $17, capitalization = $18, term_end_date = $19,
       interest_payout_frequency = $20, replenishable = $21, partial_withdrawal = $22, auto_prolongation = $23
     WHERE id = $1 AND owner_user_id = $2`,
    [instrument.id, userId, instrument.groupType, ...instrumentValues(instrument)],
  )
  return (result.rowCount ?? 0) > 0
}

// Инструмент пользователя удаляется вместе с последней ссылающейся на него строкой.
// Инструменты общего справочника (owner_user_id IS NULL) и те, на которые ещё ссылаются
// операции или выплаты, остаются на месте.
export async function deleteOrphanInstrument(db: Db, userId: string, id: string): Promise<void> {
  await db.query(
    `DELETE FROM portfolio.instruments i
      WHERE i.id = $1 AND i.owner_user_id = $2
        AND NOT EXISTS (SELECT 1 FROM portfolio.positions p WHERE p.instrument_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM portfolio.transactions t WHERE t.instrument_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM portfolio.payouts o WHERE o.instrument_id = i.id)`,
    [id, userId],
  )
}

// ---------------------------------------------------------------------------
// Позиции (§11 Position)
// ---------------------------------------------------------------------------

const POSITION_FIELDS = `
  p.id, p.account_id, p.quantity, p.average_price, p.current_price, p.current_value,
  p.invested, p.accrued_interest, p.opened_on, p.source,
  a.type AS account_type, a.provider AS account_provider, a.currency AS account_currency,
  ${INSTRUMENT_FIELDS}`

const POSITION_FROM = `
  FROM portfolio.positions p
  JOIN portfolio.accounts a ON a.id = p.account_id
  JOIN portfolio.portfolios f ON f.id = a.portfolio_id
  JOIN portfolio.instruments i ON i.id = p.instrument_id
  JOIN portfolio.asset_groups g ON g.id = i.asset_group_id`

// Порядок общий для всех выборок позиций: он же определяет, какая позиция считается
// «первым денежным счётом» при разноске пополнений и выплат (§12).
const POSITION_ORDER = 'ORDER BY p.opened_on ASC NULLS LAST, i.name ASC, p.id ASC'

function mapPosition(row: any): Position {
  return {
    id: row.id,
    accountId: row.account_id,
    instrumentId: row.instrument_id,
    invested: Number(row.invested),
    source: row.source || 'manual',
    value: num(row.current_value),
    quantity: num(row.quantity),
    averagePrice: num(row.average_price),
    currentPrice: num(row.current_price),
    accruedInterest: num(row.accrued_interest),
    openedOn: text(row.opened_on),
    instrument: mapInstrument(row),
    account: {
      id: row.account_id,
      type: row.account_type,
      provider: row.account_provider || 'Ручной ввод',
      currency: row.account_currency,
    },
  }
}

export async function listPositions(db: Db, userId: string, options?: ListOptions): Promise<Position[]> {
  const page = paginate(options, 2)
  const result = await db.query(
    `SELECT ${POSITION_FIELDS} ${POSITION_FROM} WHERE f.user_id = $1 ${POSITION_ORDER}${page.clause}`,
    [userId, ...page.values],
  )
  return result.rows.map(mapPosition)
}

export async function findPosition(db: Db, userId: string, id: string): Promise<Position | undefined> {
  const result = await db.query(
    `SELECT ${POSITION_FIELDS} ${POSITION_FROM} WHERE p.id = $1 AND f.user_id = $2`,
    [id, userId],
  )
  return result.rows[0] ? mapPosition(result.rows[0]) : undefined
}

// Позиция по паре (счёт, инструмент) — естественный ключ (UNIQUE в БД), используется для
// upsert позиций, синхронизированных из брокера напрямую (без разноски операций).
export async function findPositionByAccountInstrument(db: Db, userId: string, accountId: string, instrumentId: string): Promise<Position | undefined> {
  const result = await db.query(
    `SELECT ${POSITION_FIELDS} ${POSITION_FROM} WHERE p.account_id = $1 AND p.instrument_id = $2 AND f.user_id = $3`,
    [accountId, instrumentId, userId],
  )
  return result.rows[0] ? mapPosition(result.rows[0]) : undefined
}

// Денежная позиция, на которую ложатся пополнения, выводы и полученные выплаты (§12).
export async function findCashPosition(db: Db, userId: string): Promise<Position | undefined> {
  const result = await db.query(
    `SELECT ${POSITION_FIELDS} ${POSITION_FROM} WHERE f.user_id = $1 AND g.type = 'cash' ${POSITION_ORDER} LIMIT 1`,
    [userId],
  )
  return result.rows[0] ? mapPosition(result.rows[0]) : undefined
}

export async function insertPosition(db: Db, position: PositionRecord): Promise<void> {
  await db.query(
    `INSERT INTO portfolio.positions (
       id, account_id, instrument_id, quantity, average_price, current_price, current_value,
       invested, accrued_interest, opened_on, source
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      position.id, position.accountId, position.instrumentId, position.quantity ?? null,
      position.averagePrice ?? null, position.currentPrice ?? null, position.value ?? null,
      position.invested, position.accruedInterest ?? null, position.openedOn ?? null, position.source,
    ],
  )
}

const OWNED_POSITION = `p.account_id IN (
  SELECT a.id FROM portfolio.accounts a JOIN portfolio.portfolios f ON f.id = a.portfolio_id WHERE f.user_id = $2
)`

export async function updatePosition(db: Db, userId: string, position: PositionRecord): Promise<boolean> {
  const result = await db.query(
    `UPDATE portfolio.positions p SET
       account_id = $3, quantity = $4, average_price = $5, current_price = $6, current_value = $7,
       invested = $8, accrued_interest = $9, opened_on = $10, updated_at = NOW()
     WHERE p.id = $1 AND ${OWNED_POSITION}`,
    [
      position.id, userId, position.accountId, position.quantity ?? null, position.averagePrice ?? null,
      position.currentPrice ?? null, position.value ?? null, position.invested,
      position.accruedInterest ?? null, position.openedOn ?? null,
    ],
  )
  return (result.rowCount ?? 0) > 0
}

// Точечная разноска операции по позиции: трогаем только стоимость и вложенную сумму.
export async function updatePositionValue(db: Db, userId: string, position: Pick<PositionRecord, 'id' | 'value' | 'invested'>): Promise<void> {
  await db.query(
    `UPDATE portfolio.positions p SET current_value = $3, invested = $4, updated_at = NOW()
      WHERE p.id = $1 AND ${OWNED_POSITION}`,
    [position.id, userId, position.value ?? null, position.invested],
  )
}

// Обновление котировки (§20): трогает только цену и пересчитанную от неё стоимость —
// не задевает invested/quantity/остальные поля, которые сюда не относятся.
export async function updatePositionMarketPrice(db: Db, userId: string, position: Pick<PositionRecord, 'id' | 'currentPrice' | 'value'>): Promise<void> {
  await db.query(
    `UPDATE portfolio.positions p SET current_price = $3, current_value = $4, updated_at = NOW()
      WHERE p.id = $1 AND ${OWNED_POSITION}`,
    [position.id, userId, position.currentPrice ?? null, position.value ?? null],
  )
}

export async function deletePosition(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM portfolio.positions p
      WHERE p.id = $1 AND ${OWNED_POSITION}`,
    [id, userId],
  )
  return (result.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Операции (§11 Transaction)
// ---------------------------------------------------------------------------

const TRANSACTION_FIELDS = `
  t.id, t.account_id, t.instrument_id, t.type, t.tx_date, t.quantity, t.price, t.amount,
  t.currency, t.commission, t.tax, t.description, t.source, t.external_id, p.id AS position_id`

const TRANSACTION_FROM = `
  FROM portfolio.transactions t
  JOIN portfolio.accounts a ON a.id = t.account_id
  JOIN portfolio.portfolios f ON f.id = a.portfolio_id
  LEFT JOIN portfolio.positions p ON p.account_id = t.account_id AND p.instrument_id = t.instrument_id`

function mapTransaction(row: any): Transaction {
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    date: row.tx_date,
    amount: Number(row.amount),
    currency: row.currency,
    commission: Number(row.commission),
    tax: Number(row.tax),
    source: row.source || 'manual',
    instrumentId: text(row.instrument_id),
    positionId: text(row.position_id),
    quantity: num(row.quantity),
    price: num(row.price),
    description: text(row.description),
    externalId: text(row.external_id),
  }
}

export async function listTransactions(db: Db, userId: string, options?: ListOptions): Promise<Transaction[]> {
  const page = paginate(options, 2)
  const result = await db.query(
    `SELECT ${TRANSACTION_FIELDS} ${TRANSACTION_FROM}
      WHERE f.user_id = $1 ORDER BY t.tx_date ASC, t.created_at ASC${page.clause}`,
    [userId, ...page.values],
  )
  return result.rows.map(mapTransaction)
}

export async function findTransaction(db: Db, userId: string, id: string): Promise<Transaction | undefined> {
  const result = await db.query(
    `SELECT ${TRANSACTION_FIELDS} ${TRANSACTION_FROM} WHERE t.id = $1 AND f.user_id = $2`,
    [id, userId],
  )
  return result.rows[0] ? mapTransaction(result.rows[0]) : undefined
}

// Идемпотентность синхронизации с брокером: перед вставкой операции проверяем, не заведена
// ли она уже по её внешнему id (§19 — повторная синхронизация не должна плодить дубликаты).
export async function findTransactionByExternalId(db: Db, userId: string, externalId: string): Promise<Transaction | undefined> {
  const result = await db.query(
    `SELECT ${TRANSACTION_FIELDS} ${TRANSACTION_FROM} WHERE t.external_id = $1 AND f.user_id = $2`,
    [externalId, userId],
  )
  return result.rows[0] ? mapTransaction(result.rows[0]) : undefined
}

function transactionValues(transaction: Transaction): unknown[] {
  return [
    transaction.accountId, transaction.instrumentId ?? null, transaction.type, transaction.date,
    transaction.quantity ?? null, transaction.price ?? null, transaction.amount, transaction.currency,
    transaction.commission, transaction.tax, transaction.description ?? null,
  ]
}

export async function insertTransaction(db: Db, transaction: Transaction): Promise<void> {
  await db.query(
    `INSERT INTO portfolio.transactions (
       id, account_id, instrument_id, type, tx_date, quantity, price, amount, currency,
       commission, tax, description, source, external_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [transaction.id, ...transactionValues(transaction), transaction.source, transaction.externalId ?? null],
  )
}

const OWNED_TRANSACTION = `t.account_id IN (
  SELECT a.id FROM portfolio.accounts a JOIN portfolio.portfolios f ON f.id = a.portfolio_id WHERE f.user_id = $2
)`

export async function updateTransaction(db: Db, userId: string, transaction: Transaction): Promise<boolean> {
  const result = await db.query(
    `UPDATE portfolio.transactions t SET
       account_id = $3, instrument_id = $4, type = $5, tx_date = $6, quantity = $7, price = $8,
       amount = $9, currency = $10, commission = $11, tax = $12, description = $13
     WHERE t.id = $1 AND ${OWNED_TRANSACTION}`,
    [transaction.id, userId, ...transactionValues(transaction)],
  )
  return (result.rowCount ?? 0) > 0
}

export async function deleteTransaction(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM portfolio.transactions t WHERE t.id = $1 AND ${OWNED_TRANSACTION}`,
    [id, userId],
  )
  return (result.rowCount ?? 0) > 0
}

// Комиссии (§10.4) и налоги (§10.5) портфеля: и отдельные операции FEE/TAX, и поля
// commission/tax внутри обычных операций. Считаются в базе, а не переносом всех строк в Node.
export async function sumTransactionCosts(db: Db, userId: string): Promise<{ commissions: number; taxes: number }> {
  const result = await db.query(
    `SELECT
       COALESCE(SUM(t.commission), 0) + COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'FEE'), 0) AS commissions,
       COALESCE(SUM(t.tax), 0) + COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'TAX'), 0) AS taxes
     FROM portfolio.transactions t
     JOIN portfolio.accounts a ON a.id = t.account_id
     JOIN portfolio.portfolios f ON f.id = a.portfolio_id
     WHERE f.user_id = $1`,
    [userId],
  )
  return { commissions: Number(result.rows[0]?.commissions ?? 0), taxes: Number(result.rows[0]?.taxes ?? 0) }
}

// Денежный остаток (§12, BUG-05): сальдо денежных движений по операциям, по валютам.
// Пополнения, продажи и выплаты зачисляются, выводы, покупки, комиссии и налоги
// списываются. Брокерские операции не учитываются: состояние брокерского счёта целиком
// приходит из его позиций при синхронизации, и сальдо по ним посчитало бы деньги дважды.
export async function sumCashBalances(db: Db, userId: string): Promise<{ currency: string; balance: number }[]> {
  const result = await db.query(
    `SELECT t.currency,
       COALESCE(SUM(t.amount) FILTER (WHERE t.type IN ('DEPOSIT', 'SELL', 'COUPON', 'DIVIDEND', 'INTEREST', 'REDEMPTION')), 0)
       - COALESCE(SUM(t.amount) FILTER (WHERE t.type IN ('WITHDRAW', 'BUY', 'FEE', 'TAX')), 0)
       - COALESCE(SUM(t.commission), 0) - COALESCE(SUM(t.tax), 0) AS balance
     FROM portfolio.transactions t
     JOIN portfolio.accounts a ON a.id = t.account_id
     JOIN portfolio.portfolios f ON f.id = a.portfolio_id
     WHERE f.user_id = $1 AND t.source <> 'broker'
     GROUP BY t.currency
     ORDER BY t.currency`,
    [userId],
  )
  return result.rows.map((row) => ({ currency: row.currency as string, balance: Number(row.balance) }))
}

// ---------------------------------------------------------------------------
// Выплаты (§11 Payout, §22 календарь выплат)
// ---------------------------------------------------------------------------

const PAYOUT_FIELDS = `
  o.id, o.account_id, o.instrument_id, o.transaction_id, o.payout_date, o.type,
  o.amount, o.currency, o.status, o.source, o.description`

const PAYOUT_FROM = `
  FROM portfolio.payouts o
  JOIN portfolio.accounts a ON a.id = o.account_id
  JOIN portfolio.portfolios f ON f.id = a.portfolio_id`

function mapPayout(row: any): Payout {
  return {
    id: row.id,
    accountId: row.account_id,
    date: row.payout_date,
    type: row.type,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    source: row.source,
    instrumentId: text(row.instrument_id),
    transactionId: text(row.transaction_id),
    description: text(row.description),
  }
}

export async function listPayouts(db: Db, userId: string, options?: ListOptions): Promise<Payout[]> {
  const page = paginate(options, 2)
  const result = await db.query(
    `SELECT ${PAYOUT_FIELDS} ${PAYOUT_FROM}
      WHERE f.user_id = $1 ORDER BY o.payout_date ASC, o.created_at ASC${page.clause}`,
    [userId, ...page.values],
  )
  return result.rows.map(mapPayout)
}

export async function findPayout(db: Db, userId: string, id: string): Promise<Payout | undefined> {
  const result = await db.query(
    `SELECT ${PAYOUT_FIELDS} ${PAYOUT_FROM} WHERE o.id = $1 AND f.user_id = $2`,
    [id, userId],
  )
  return result.rows[0] ? mapPayout(result.rows[0]) : undefined
}

function payoutValues(payout: Payout): unknown[] {
  return [
    payout.accountId, payout.instrumentId ?? null, payout.transactionId ?? null, payout.date,
    payout.type, payout.amount, payout.currency, payout.status, payout.source, payout.description ?? null,
  ]
}

export async function insertPayout(db: Db, payout: Payout): Promise<void> {
  await db.query(
    `INSERT INTO portfolio.payouts (
       id, account_id, instrument_id, transaction_id, payout_date, type, amount, currency, status, source, description
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [payout.id, ...payoutValues(payout)],
  )
}

const OWNED_PAYOUT = `o.account_id IN (
  SELECT a.id FROM portfolio.accounts a JOIN portfolio.portfolios f ON f.id = a.portfolio_id WHERE f.user_id = $2
)`

export async function updatePayout(db: Db, userId: string, payout: Payout): Promise<boolean> {
  const result = await db.query(
    `UPDATE portfolio.payouts o SET
       account_id = $3, instrument_id = $4, transaction_id = $5, payout_date = $6, type = $7,
       amount = $8, currency = $9, status = $10, source = $11, description = $12
     WHERE o.id = $1 AND ${OWNED_PAYOUT}`,
    [payout.id, userId, ...payoutValues(payout)],
  )
  return (result.rowCount ?? 0) > 0
}

export async function deletePayout(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM portfolio.payouts o WHERE o.id = $1 AND ${OWNED_PAYOUT}`,
    [id, userId],
  )
  return (result.rowCount ?? 0) > 0
}

// Выплата, созданная вместе с операцией (купон, дивиденд, проценты), живёт ровно столько,
// сколько живёт сама операция: иначе после удаления операции в календаре остался бы
// «полученный» доход без движения денег.
export async function deletePayoutsForTransaction(db: Db, transactionId: string): Promise<void> {
  await db.query('DELETE FROM portfolio.payouts WHERE transaction_id = $1', [transactionId])
}

// Плановые выплаты (§15, §22) пересчитываются целиком: собственные строки прогноза удаляются,
// затем генерируются заново из текущих параметров инструментов. Ручные и брокерские выплаты
// под условие не попадают и переживают любое число пересчётов.
export async function deleteForecastPayouts(db: Db, userId: string): Promise<void> {
  await db.query(
    `DELETE FROM portfolio.payouts o WHERE o.source = 'forecast' AND o.account_id IN (
       SELECT a.id FROM portfolio.accounts a
       JOIN portfolio.portfolios f ON f.id = a.portfolio_id WHERE f.user_id = $1
     )`,
    [userId],
  )
}

// Полученные и ожидаемые выплаты (§7.1). Мультивалютные выплаты суммируются как есть —
// конверсия появится вместе с таблицей курсов ЦБ РФ (§13).
// BUG-22 (§22): ожидаемая выплата с датой в прошлом — не «ожидается», а «просрочено»:
// деньги либо пришли и не отмечены, либо не пришли вовсе. Считается отдельно и в
// «Ожидается» не складывается. today — дата «сегодня» по часам сервера (YYYY-MM-DD).
export async function sumPayouts(db: Db, userId: string, today: string): Promise<{ expected: number; overdue: number; received: number }> {
  const result = await db.query(
    `SELECT
       COALESCE(SUM(o.amount) FILTER (WHERE o.status = 'expected' AND o.payout_date >= $2::date), 0) AS expected,
       COALESCE(SUM(o.amount) FILTER (WHERE o.status = 'expected' AND o.payout_date < $2::date), 0) AS overdue,
       COALESCE(SUM(o.amount) FILTER (WHERE o.status = 'received'), 0) AS received
     ${PAYOUT_FROM} WHERE f.user_id = $1`,
    [userId, today],
  )
  return {
    expected: Number(result.rows[0]?.expected ?? 0),
    overdue: Number(result.rows[0]?.overdue ?? 0),
    received: Number(result.rows[0]?.received ?? 0),
  }
}

// ---------------------------------------------------------------------------
// История портфеля (§21) и подключения брокеров (§11 BrokerConnection)
// ---------------------------------------------------------------------------

export async function upsertSnapshot(
  db: Db, portfolioId: string, id: string, date: string, value: number, invested: number | null,
): Promise<void> {
  await db.query(
    `INSERT INTO portfolio.portfolio_snapshots (id, portfolio_id, snapshot_date, total_value, invested)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (portfolio_id, snapshot_date)
     DO UPDATE SET total_value = EXCLUDED.total_value, invested = EXCLUDED.invested`,
    [id, portfolioId, date, value, invested],
  )
}

export async function listSnapshots(db: Db, userId: string): Promise<Array<{ date: string; value: number; invested: number | null }>> {
  const result = await db.query(
    `SELECT s.snapshot_date, s.total_value, s.invested
       FROM portfolio.portfolio_snapshots s
       JOIN portfolio.portfolios f ON f.id = s.portfolio_id
      WHERE f.user_id = $1 ORDER BY s.snapshot_date ASC`,
    [userId],
  )
  return result.rows.map((row) => ({
    date: row.snapshot_date,
    value: Number(row.total_value),
    invested: row.invested === null ? null : Number(row.invested),
  }))
}

function mapBrokerConnection(row: any): BrokerConnection {
  return {
    id: row.id,
    brokerType: row.broker_type,
    tokenMasked: text(row.token_masked),
    encryptedToken: text(row.encrypted_token),
    status: row.status,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : undefined,
    lastError: text(row.last_error),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

const BROKER_CONNECTION_FIELDS = 'id, broker_type, token_masked, encrypted_token, status, last_sync_at, last_error, created_at'

// Перечисление всех подключений всех пользователей — только для планировщика (§19/§32),
// который должен раз в сутки пройтись по каждому подключённому брокеру каждого пользователя.
export async function listAllBrokerConnections(db: Db): Promise<Array<{ userId: string; brokerType: string }>> {
  const result = await db.query('SELECT user_id, broker_type FROM portfolio.broker_connections')
  return result.rows.map((row) => ({ userId: row.user_id, brokerType: row.broker_type }))
}

export async function findBrokerConnection(db: Db, userId: string, brokerType: string): Promise<BrokerConnection | undefined> {
  const result = await db.query(
    `SELECT ${BROKER_CONNECTION_FIELDS}
       FROM portfolio.broker_connections WHERE user_id = $1 AND broker_type = $2`,
    [userId, brokerType],
  )
  return result.rows[0] ? mapBrokerConnection(result.rows[0]) : undefined
}

// Токен хранится только в зашифрованном виде (§28) — encryptedToken шифрует вызывающий код
// (server/token-crypto.ts) до попадания сюда; в базе никогда не оказывается открытый текст.
export async function upsertBrokerConnection(
  db: Db, userId: string, id: string,
  connection: { brokerType: string; tokenMasked: string; encryptedToken: string; status: BrokerStatus },
): Promise<BrokerConnection> {
  const result = await db.query(
    `INSERT INTO portfolio.broker_connections (id, user_id, broker_type, token_masked, encrypted_token, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, broker_type)
     DO UPDATE SET token_masked = EXCLUDED.token_masked, encrypted_token = EXCLUDED.encrypted_token,
       status = EXCLUDED.status, last_error = NULL
     RETURNING ${BROKER_CONNECTION_FIELDS}`,
    [id, userId, connection.brokerType, connection.tokenMasked, connection.encryptedToken, connection.status],
  )
  return mapBrokerConnection(result.rows[0])
}

// Обновление результата синхронизации (§30): статус/дата/ошибка — без прикосновения к токену.
// Деградация (§40.2 B/C) требует не стирать раннее сохранённые данные при ошибке — этот вызов
// не трогает ни positions, ни transactions, только состояние самого подключения.
export async function updateBrokerConnectionSync(
  db: Db, userId: string, brokerType: string,
  update: { status: BrokerStatus; lastSyncAt?: string; lastError?: string | null },
): Promise<void> {
  await db.query(
    `UPDATE portfolio.broker_connections SET
       status = $3, last_sync_at = COALESCE($4, last_sync_at), last_error = $5
     WHERE user_id = $1 AND broker_type = $2`,
    [userId, brokerType, update.status, update.lastSyncAt ?? null, update.lastError ?? null],
  )
}

// ---------------------------------------------------------------------------
// Очередь загруженных документов (§11 UploadedDocument, §18/§34)
// ---------------------------------------------------------------------------

export type UploadedDocumentStatus = 'pending' | 'processing' | 'done' | 'failed'
export type UploadedDocument = {
  id: string
  userId: string
  fileName: string
  filePath?: string
  mimeType?: string
  status: UploadedDocumentStatus
  extractedJson?: unknown
  instrumentId?: string
  errorMessage?: string
  createdAt: string
  processedAt?: string
  contentHash?: string
}

const DOCUMENT_FIELDS = `id, user_id, file_name, file_path, mime_type, processing_status,
  extracted_json, instrument_id, error_message, created_at, processed_at, claimed_at, content_hash`

function mapUploadedDocument(row: any): UploadedDocument {
  return {
    id: row.id,
    userId: row.user_id,
    fileName: row.file_name,
    filePath: text(row.file_path),
    mimeType: text(row.mime_type),
    status: row.processing_status,
    extractedJson: row.extracted_json ?? undefined,
    instrumentId: text(row.instrument_id),
    errorMessage: text(row.error_message),
    createdAt: new Date(row.created_at).toISOString(),
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : undefined,
    contentHash: text(row.content_hash),
  }
}

export async function insertUploadedDocument(
  db: Db, userId: string, document: { id: string; fileName: string; filePath: string; mimeType?: string; contentHash?: string },
): Promise<UploadedDocument> {
  const result = await db.query(
    `INSERT INTO portfolio.uploaded_documents (id, user_id, file_name, file_path, mime_type, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${DOCUMENT_FIELDS}`,
    [document.id, userId, document.fileName, document.filePath, document.mimeType ?? null, document.contentHash ?? null],
  )
  return mapUploadedDocument(result.rows[0])
}

// BUG-15 (§18): ранее загруженный документ с тем же содержимым. Упавшие обработки
// не считаются — такой файл пользователь вправе загрузить ещё раз. Если от прошлой
// обработки не осталось ни одной позиции (пользователь всё удалил), файл тоже
// обрабатывается заново: показывать сводку из удалённых записей бессмысленно.
export async function findProcessedDocumentByHash(db: Db, userId: string, contentHash: string): Promise<UploadedDocument | undefined> {
  const result = await db.query(
    `SELECT ${DOCUMENT_FIELDS} FROM portfolio.uploaded_documents d
      WHERE d.user_id = $1 AND d.content_hash = $2
        AND (
          d.processing_status IN ('pending', 'processing')
          OR (d.processing_status = 'done' AND EXISTS (
            SELECT 1 FROM portfolio.positions p
              JOIN portfolio.accounts a ON a.id = p.account_id
              JOIN portfolio.portfolios pf ON pf.id = a.portfolio_id
             WHERE pf.user_id = d.user_id
               AND p.id::text IN (SELECT jsonb_array_elements(d.extracted_json->'items')->>'id')
          ))
        )
      ORDER BY d.created_at DESC
      LIMIT 1`,
    [userId, contentHash],
  )
  return result.rows[0] ? mapUploadedDocument(result.rows[0]) : undefined
}

export async function findUploadedDocument(db: Db, userId: string, id: string): Promise<UploadedDocument | undefined> {
  const result = await db.query(
    `SELECT ${DOCUMENT_FIELDS} FROM portfolio.uploaded_documents WHERE user_id = $1 AND id = $2`,
    [userId, id],
  )
  return result.rows[0] ? mapUploadedDocument(result.rows[0]) : undefined
}

// Забор задачи из очереди. FOR UPDATE SKIP LOCKED — чтобы второй воркер (или второй прогон
// цикла, пока первый ещё занят) не взял тот же документ: строка помечается 'processing'
// в той же атомарной операции, которой она выбирается.
export async function claimPendingDocument(db: Db): Promise<UploadedDocument | undefined> {
  const result = await db.query(
    `UPDATE portfolio.uploaded_documents SET processing_status = 'processing', claimed_at = NOW()
      WHERE id = (
        SELECT id FROM portfolio.uploaded_documents
         WHERE processing_status = 'pending'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING ${DOCUMENT_FIELDS}`,
  )
  return result.rows[0] ? mapUploadedDocument(result.rows[0]) : undefined
}

// BUG-10: если процесс воркера падает между захватом документа (claimPendingDocument)
// и его завершением (completeUploadedDocument) — например, необработанное исключение
// из внутреннего обработчика события tesseract.js, минующее try/catch, — строка
// остаётся в processing навсегда и блокирует очередь для всех пользователей, потому что
// claimPendingDocument выбирает только pending. Эта функция находит такие зависшие строки
// по claimed_at и переводит их в failed, чтобы пользователь увидел ошибку вместо вечного
// «В очереди на распознавание…».
export async function failStaleProcessingDocuments(db: Db, timeoutMinutes: number): Promise<number> {
  const result = await db.query(
    `UPDATE portfolio.uploaded_documents SET
       processing_status = 'failed', error_message = $1, processed_at = NOW(), file_path = NULL
     WHERE processing_status = 'processing' AND claimed_at < NOW() - ($2 || ' minutes')::INTERVAL`,
    ['Обработка изображения заняла слишком много времени', timeoutMinutes],
  )
  return result.rowCount ?? 0
}

export async function completeUploadedDocument(
  db: Db, id: string,
  update: { status: UploadedDocumentStatus; extractedJson?: unknown; instrumentId?: string; errorMessage?: string },
): Promise<void> {
  await db.query(
    `UPDATE portfolio.uploaded_documents SET
       processing_status = $2, extracted_json = $3, instrument_id = $4,
       error_message = $5, processed_at = NOW(), file_path = NULL
     WHERE id = $1`,
    [
      id, update.status,
      update.extractedJson === undefined ? null : JSON.stringify(update.extractedJson),
      update.instrumentId ?? null, update.errorMessage ?? null,
    ],
  )
}

// Полное удаление аккаунта (§28): пользователь должен иметь возможность стереть себя целиком.
// Возвращает пути ещё не обработанных загрузок: файлы на диске тоже данные пользователя,
// вызывающий удаляет их после коммита транзакции.
export async function deleteUserData(db: Db, userId: string): Promise<string[]> {
  const files = await db.query(
    'SELECT file_path FROM portfolio.uploaded_documents WHERE user_id = $1 AND file_path IS NOT NULL',
    [userId],
  )
  // Каскад по portfolios снимает счета, позиции, операции, выплаты и снимки портфеля.
  await db.query('DELETE FROM portfolio.portfolios WHERE user_id = $1', [userId])
  await db.query('DELETE FROM portfolio.instruments WHERE owner_user_id = $1', [userId])
  await db.query('DELETE FROM portfolio.broker_connections WHERE user_id = $1', [userId])
  await db.query('DELETE FROM portfolio.uploaded_documents WHERE user_id = $1', [userId])
  await db.query('DELETE FROM portfolio.recommendations WHERE user_id = $1', [userId])
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId])
  await db.query('DELETE FROM users WHERE id = $1', [userId])
  return files.rows.map((row) => row.file_path as string)
}

// Логика, общая для HTTP-хендлеров (server/index.ts) и планировщика фоновых задач
// (server/scheduler.ts, §19/§21/§32) — вынесена сюда, чтобы CLAUDE.md §10 («Portfolio Engine
// на бэкенде — единственное место расчётов», распространяется и на смежную бизнес-логику,
// а не только на сам движок) не нарушался дублированием между явным действием пользователя
// и ежедневным автоматическим запуском одной и той же операции.
import { randomUUID } from 'node:crypto'
import { tinkoffConnector } from './brokers/tinkoff.ts'
import { getCbrRateTable, getMoexQuote } from './market-data.ts'
import { aggregateByGroup, calculateReturns, convertCurrency, sumInBase, type AssetGroup, type EngineContext, type PositionInput } from './portfolio-engine.ts'
import { depositAccruedInterest, forecastPayouts } from './payout-forecast.ts'
import {
  deleteEmptyLegacyBrokerAccounts, deleteStaleBrokerPositions, ensureBrokerAccount, ensurePortfolio, moveTransactionToAccount, findInstrumentByKey, findPortfolio, findPositionByAccountInstrument,
  findTransactionByExternalId, insertInstrument, updateInstrument, sumCashBalances, insertPayout, insertPosition, insertTransaction,
  deleteForecastPayouts, deletePayoutsForTransaction, listPayouts, listPositions, updatePosition,
  recordInstrumentPrice, updatePositionMarketPrice, upsertSnapshot, sumPayouts, sumRealizedSales, sumTransactionCosts,
  deleteTransaction, findPayout, findTransaction, updatePayout, updateTransaction,
  type AssetGroupType, type Db, type Payout, type PayoutType, type Position, type PositionRecord, type Transaction, type TransactionType,
} from './repository.ts'

// Базовая валюта — настраиваемое поле портфеля (§13, §6.10), RUB — только дефолт для
// только что созданного портфеля.
export const DEFAULT_BASE_CURRENCY = 'RUB'

// Машинный ключ группы активов (portfolio.asset_groups.type) ↔ подпись группы, которой
// оперируют движок (§7.2) и интерфейс. В базе хранится ключ, наружу отдаётся подпись.
export const GROUP_LABELS: Record<AssetGroupType, AssetGroup> = {
  deposit: 'Вклады', bond: 'Облигации', share: 'Акции', fund: 'Фонды', cash: 'Деньги', other: 'Прочее',
}

// Курсы ЦБ РФ (§13) подгружаются с кэшем в market-data.ts; без них позиции в валютах,
// отличных от базовой, движок помечает как неоценённые (reason 'no-rate') и не подмешивает
// их в итог нулями (§7.3) — это уже деградация, а не отсутствие функциональности.
export async function engineContext(baseCurrency: string): Promise<EngineContext> {
  return { baseCurrency, rates: await getCbrRateTable() }
}

export function toEngineInput(position: Position): PositionInput {
  return {
    id: position.id,
    name: position.instrument.name,
    type: GROUP_LABELS[position.instrument.groupType],
    currency: position.instrument.currency || DEFAULT_BASE_CURRENCY,
    invested: position.invested,
    value: position.value ?? null,
    quantity: position.quantity ?? null,
    averagePrice: position.averagePrice ?? null,
    currentPrice: position.currentPrice ?? null,
    // Начисленное по вкладу добавляется, только если текущая сумма не введена отдельно:
    // сумма из приложения банка (ручной ввод, скриншот) уже включает проценты.
    accruedInterest: position.accruedInterest ?? (position.instrument.groupType === 'deposit'
      && (position.value === undefined || Math.abs(position.value - position.invested) < 0.005)
      ? depositAccruedInterest(position, position.instrument, localDate())
      : null),
  }
}
// «Сегодня» по местным часам сервера, как граница просроченных выплат в server/index.ts.
export function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// Свободные деньги (§12, §7.1, BUG-05; решение Р-2 в docs/FIX_PLAN.md) — часть портфеля:
// сальдо денежных операций подаётся в Portfolio Engine отдельной позицией группы «Деньги»
// на каждую валюту, поэтому входит в общую стоимость, структуру и снимки истории наравне
// с остальными активами. Вложено = остатку: сами деньги не приносят P&L, а доход, который
// в них превратился, уже учтён в финансовом результате как полученные выплаты (§10.3).
export const CASH_POSITION_PREFIX = 'cash:'
export const CASH_POSITION_NAME = 'Денежные средства'
export function isCashInput(id: string): boolean {
  return id.startsWith(CASH_POSITION_PREFIX)
}
// решено автономно: отрицательное сальдо (покупки записаны, а пополнения — нет) → в портфель
// не попадает → такие покупки оплачены деньгами, о которых система не знает; «минус» в
// свободных деньгах уменьшил бы стоимость портфеля на сумму, которой пользователь не должен.
export function cashEngineInputs(balances: { currency: string; balance: number }[]): PositionInput[] {
  return balances
    .filter((item) => item.balance >= 0.005)
    .map((item) => ({
      id: `${CASH_POSITION_PREFIX}${item.currency}`,
      name: CASH_POSITION_NAME,
      type: GROUP_LABELS.cash,
      currency: item.currency,
      value: item.balance,
      invested: item.balance,
    }))
}
// Полный вход движка: позиции плюс денежный остаток. Все расчёты портфеля целиком
// (сводка, структура, рекомендации, снимки) идут через эту функцию.
// Закрытая позиция (тело вклада вернулось, бумага погашена) в текущий портфель не входит:
// иначе вернувшиеся деньги считались бы дважды — стоимостью позиции и выплатой.
export async function portfolioEngineInputs(client: Db, userId: string, positions: Position[]): Promise<PositionInput[]> {
  return [
    ...positions.filter((position) => !position.closedOn).map(toEngineInput),
    ...cashEngineInputs(await sumCashBalances(client, userId)),
  ]
}

// Реализованный результат закрытых позиций (§10.2): вернувшееся тело минус вложенное.
// У вклада обычно ноль (доход пришёл процентами), у облигации — разница между номиналом
// и ценой покупки. Возвращается null, если у позиции нет курса к базовой валюте (§7.3).
export function closedPositionResult(position: Position, context: EngineContext): number | null {
  if (!position.closedOn) return null
  const currency = position.instrument.currency || DEFAULT_BASE_CURRENCY
  const returned = convertCurrency(position.principalReturned ?? 0, currency, context.baseCurrency, context.rates)
  const invested = convertCurrency(position.invested, currency, context.baseCurrency, context.rates)
  return returned === null || invested === null ? null : returned - invested
}

// Снимок дня (§21) считается по фактическому составу портфеля, поэтому вызывается
// уже после точечной записи и внутри той же транзакции, что и само изменение —
// либо, для планировщика, как самостоятельный ежедневный шаг.
// Финансовый результат портфеля (§10.6) — одна формула для сводки и для ежедневного снимка:
// изменение стоимости + полученные выплаты + реализованный результат − комиссии − налоги.
export async function portfolioResult(
  client: Db, userId: string, positions: Position[], aggregate: ReturnType<typeof aggregateByGroup>, context: EngineContext,
) {
  const [payouts, costs, sales] = await Promise.all([sumPayouts(client, userId, localDate()), sumTransactionCosts(client, userId), sumRealizedSales(client, userId)])
  // Реализованный результат (§10.2): закрытые вклады и погашенные бумаги плюс продажи.
  const realized = positions.reduce((sum, position) => sum + (closedPositionResult(position, context) ?? 0), 0)
    + sumInBase(sales, context).total
  // Выплаты, комиссии и налоги бывают в разных валютах — складываются после пересчёта (§13).
  const received = sumInBase(payouts.received, context)
  const commissions = sumInBase(costs.commissions, context)
  const taxes = sumInBase(costs.taxes, context)
  // База доходности — позиции с известным P&L: приблизительная оценка без котировки
  // не должна выдавать себя за «0% изменения» (§7.3, BUG-09).
  const returns = calculateReturns({
    currentValue: aggregate.pnlValue,
    invested: aggregate.pnlInvested,
    payoutsReceived: received.total + realized,
    commissions: commissions.total,
    taxes: taxes.total,
  })
  return { payouts, received, commissions, taxes, returns }
}

export async function recordSnapshot(client: Db, userId: string, date = new Date().toISOString().slice(0, 10)) {
  const portfolio = await findPortfolio(client, userId)
  if (!portfolio) return
  const positions = await listPositions(client, userId)
  const inputs = await portfolioEngineInputs(client, userId, positions)
  if (!inputs.length) return
  const context = await engineContext(portfolio.baseCurrency)
  const aggregate = aggregateByGroup(inputs, context)
  const { returns } = await portfolioResult(client, userId, positions, aggregate, context)
  await upsertSnapshot(client, portfolio.id, randomUUID(), date, aggregate.value, aggregate.invested, returns.financialResult)
}

// §11 BrokerConnection: статус подключения живёт в базе, а не в памяти процесса, иначе
// перезапуск сервера «отключал» бы брокера. Токен хранится только зашифрованным (§28,
// server/token-crypto.ts) — расшифровывается на секунду вызова коннектора и никогда не логируется.
export const TINKOFF_PROVIDER = 'Т-Инвестиции'
export const BROKER_GROUP_TYPE: Record<'bond' | 'share' | 'fund' | 'deposit' | 'other', AssetGroupType> = {
  bond: 'bond', share: 'share', fund: 'fund', deposit: 'deposit', other: 'other',
}

// Операции, которые одновременно являются полученной выплатой и попадают в календарь (§22).
const PAYOUT_BY_TRANSACTION: Partial<Record<Transaction['type'], PayoutType>> = {
  COUPON: 'COUPON', DIVIDEND: 'DIVIDEND', INTEREST: 'INTEREST', REDEMPTION: 'REDEMPTION',
}

// Полученная выплата (купон, дивиденд, проценты, погашение) попадает и в операции, и в
// календарь выплат (§22): календарная запись создаётся вместе с операцией и живёт ровно
// столько же, поэтому в сводке она считается один раз. Используется и ручными/OCR-операциями
// (server/index.ts), и брокерской синхронизацией (performTinkoffSync ниже).
export async function syncPayoutForTransaction(client: Db, transaction: Transaction) {
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
    // Выплата наследует происхождение своей операции: пришедшая от брокера остаётся
    // брокерской, введённая руками/через OCR — ручной. Прогнозом такая строка не является
    // никогда, поэтому пересчёт (regenerateForecastPayouts) её не тронет.
    source: transaction.source === 'broker' ? 'broker' : 'manual',
    description: transaction.description,
  } satisfies Payout)
}

// §15 («система должна рассчитывать ожидаемые проценты и формировать будущие выплаты»)
// и §22 (календарь показывает ожидаемые купоны, проценты, возврат тела и погашение).
// Прогноз — производная от параметров инструментов, а не самостоятельные данные, поэтому
// пересчитывается целиком при каждом изменении состава портфеля и раз в сутки планировщиком:
// свои прошлые строки удаляются, новые считаются из текущих параметров. Чужие строки
// (ручные, брокерские) не удаляются и не задваиваются — совпадение по инструменту, дате и
// типу означает, что выплата уже учтена фактическими данными, и прогноз для неё не нужен.
export async function regenerateForecastPayouts(
  client: Db, userId: string, today = new Date().toISOString().slice(0, 10),
): Promise<number> {
  await deleteForecastPayouts(client, userId)
  const [positions, existing] = await Promise.all([listPositions(client, userId), listPayouts(client, userId)])
  const taken = new Set(existing.map((payout) => `${payout.instrumentId ?? ''}|${payout.date}|${payout.type}`))
  // Прошедшая выплата по графику станет «полученной» с деньгами (settleDuePayouts), поэтому
  // она не заводится, если пользователь уже внёс такую выплату сам, пусть и другим числом:
  // купон, записанный на день позже графика, — те же деньги, а не второй купон.
  const recorded = existing.filter((payout) => payout.status === 'received')
  const alreadyRecorded = (instrumentId: string, date: string, type: PayoutType) =>
    recorded.some((payout) => payout.instrumentId === instrumentId && payout.type === type
      && Math.abs(Date.parse(payout.date) - Date.parse(date)) <= RECORDED_PAYOUT_WINDOW_MS)
  let created = 0
  for (const position of positions) {
    for (const forecast of forecastPayouts(position, position.instrument, today)) {
      const key = `${position.instrumentId}|${forecast.date}|${forecast.type}`
      if (taken.has(key)) continue
      if (forecast.date < today && alreadyRecorded(position.instrumentId, forecast.date, forecast.type)) continue
      taken.add(key)
      await insertPayout(client, {
        id: randomUUID(),
        accountId: position.accountId,
        instrumentId: position.instrumentId,
        date: forecast.date,
        type: forecast.type,
        amount: forecast.amount,
        currency: forecast.currency,
        status: 'expected',
        source: 'forecast',
        description: forecast.description,
      } satisfies Payout)
      created += 1
    }
  }
  await settleDuePayouts(client, userId)
  return created
}
// Окно совпадения прошедшей выплаты по графику с уже внесённой пользователем.
const RECORDED_PAYOUT_WINDOW_MS = 20 * 86_400_000

// Полученная выплата — это пришедшие деньги (критик К3): отметка «получена» заводит
// связанную операцию, и сумма попадает в свободные деньги. Без неё погашение закрывало
// позицию, а деньги не появлялись нигде — портфель «терял» всю сумму. Снятие отметки
// операцию удаляет, правка суммы и даты — переносит в неё. Брокерские выплаты не трогаем:
// их деньги приходят синхронизацией.
const TRANSACTION_BY_PAYOUT: Partial<Record<PayoutType, TransactionType>> = {
  COUPON: 'COUPON', DIVIDEND: 'DIVIDEND', INTEREST: 'INTEREST', REDEMPTION: 'REDEMPTION', DEPOSIT_PRINCIPAL: 'REDEMPTION',
}
export async function syncTransactionForPayout(client: Db, userId: string, payout: Payout, stored = true) {
  if (payout.source === 'broker' || payout.institution === TINKOFF_PROVIDER) return
  const type = TRANSACTION_BY_PAYOUT[payout.type]
  if (payout.status !== 'received' || !type) {
    if (!payout.transactionId) return
    const linked = payout.transactionId
    payout.transactionId = undefined
    if (stored) await updatePayout(client, userId, payout)
    await deleteTransaction(client, userId, linked)
    return
  }
  const transaction: Transaction = {
    id: payout.transactionId ?? randomUUID(),
    accountId: payout.accountId,
    instrumentId: payout.instrumentId,
    type,
    date: payout.date,
    amount: payout.amount,
    currency: payout.currency,
    commission: 0,
    tax: 0,
    source: 'manual',
    description: payout.description,
  }
  if (payout.transactionId) {
    const existing = await findTransaction(client, userId, payout.transactionId)
    if (existing) {
      await updateTransaction(client, userId, { ...existing, date: payout.date, amount: payout.amount, currency: payout.currency })
      return
    }
  }
  await insertTransaction(client, transaction)
  payout.transactionId = transaction.id
}


// Купоны, проценты и дивиденды с прошедшей датой считаются полученными (решение владельца,
// docs/UI_UNIFICATION_PLAN.md): отмечать каждую выплату руками не нужно, кнопки «Получена»
// для дохода нет. Возврат тела вклада и погашение номинала по-прежнему ждут отметки —
// они закрывают позицию, и дату фактического возврата знает только пользователь.
// Брокерские выплаты не трогаем: их деньги и даты приходят синхронизацией (§19).
export const AUTO_RECEIVED_TYPES: PayoutType[] = ['COUPON', 'DIVIDEND', 'INTEREST']

export function isAutoReceived(payout: Pick<Payout, 'type' | 'date' | 'source' | 'institution'>, today = localDate()): boolean {
  return AUTO_RECEIVED_TYPES.includes(payout.type) && payout.date < today
    && payout.source !== 'broker' && payout.institution !== TINKOFF_PROVIDER
}

// Перевод наступивших выплат дохода в «получено» с заведением операции — как при ручной
// отметке: деньги попадают в свободные (критик К3). Прогнозная строка становится ручной,
// иначе следующий пересчёт прогноза удалил бы уже пришедшие деньги. UPDATE ... RETURNING
// с условием на статус делает шаг идемпотентным: параллельные запросы одну и ту же
// выплату дважды не проведут.
export async function settleDuePayouts(client: Db, userId: string, today = localDate()): Promise<number> {
  const result = await client.query(
    `UPDATE portfolio.payouts o
        SET status = 'received', source = CASE WHEN o.source = 'forecast' THEN 'manual' ELSE o.source END
       FROM portfolio.accounts a JOIN portfolio.portfolios f ON f.id = a.portfolio_id
      WHERE a.id = o.account_id AND f.user_id = $1 AND o.status = 'expected' AND o.payout_date < $2::date
        AND o.type = ANY($3::text[]) AND o.source <> 'broker' AND a.provider IS DISTINCT FROM $4
      RETURNING o.id`,
    [userId, today, AUTO_RECEIVED_TYPES, TINKOFF_PROVIDER],
  )
  for (const row of result.rows) {
    const payout = await findPayout(client, userId, row.id)
    if (!payout) continue
    await syncTransactionForPayout(client, userId, payout)
    await updatePayout(client, userId, payout)
  }
  return result.rows.length
}

// Синхронизация (§19): позиции ставятся из ответа брокера целиком (количество/цены/стоимость
// перезаписываются как авторитетные), а не разносятся через applyTransactionEffect — тот
// путь предназначен для ручного/OCR-ввода и задвоил бы результат поверх уже готового снимка
// брокера. Операции добавляются с дедупликацией по external_id, чтобы повторный запуск
// не плодил дубликаты; связанные выплаты заводятся тем же syncPayoutForTransaction,
// что и для ручных операций — у него нет побочных эффектов на позиции.
// Вызывается и по кнопке «Запустить синхронизацию» (server/index.ts), и раз в сутки
// планировщиком (server/scheduler.ts) — единственное место, где эта логика реализована.
export async function performTinkoffSync(client: Db, userId: string, token: string): Promise<void> {
  const data = await tinkoffConnector.fetchSyncData(token)
  const portfolio = await ensurePortfolio(client, userId, randomUUID())
  const instrumentIdByExternal = new Map<string, string>()
  // Каждый счёт брокера — отдельный счёт в портфеле: одна бумага на двух счетах — две позиции.
  const accountIdByExternal = new Map<string, string>()
  for (const brokerAccount of data.accounts) {
    const account = await ensureBrokerAccount(client, portfolio.id, randomUUID(), {
      provider: TINKOFF_PROVIDER, externalId: brokerAccount.externalId, name: brokerAccount.name, currency: brokerAccount.currency,
    })
    accountIdByExternal.set(brokerAccount.externalId, account.id)
  }
  const brokerAccountId = (externalId: string): string => {
    const id = accountIdByExternal.get(externalId)
    if (!id) throw new Error(`T-Invest: счёт ${externalId} не пришёл в списке счетов`)
    return id
  }
  const syncedPositionIds: string[] = []

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
    } else if (instrument.source === 'broker') {
      // Справочные поля брокерской бумаги — за брокером: так ранее загруженные позиции
      // получают название вместо тикера и заглавный код валюты при следующей синхронизации.
      const fresh = brokerPosition.instrument
      const updated = { ...instrument, name: fresh.name, isin: fresh.isin ?? instrument.isin, currency: fresh.currency }
      if (updated.name !== instrument.name || updated.isin !== instrument.isin || updated.currency !== instrument.currency) {
        await updateInstrument(client, userId, updated)
        instrument = updated
      }
    }
    instrumentIdByExternal.set(brokerPosition.instrument.externalId, instrument.id)

    const accountId = brokerAccountId(brokerPosition.accountExternalId)
    const existing = await findPositionByAccountInstrument(client, userId, accountId, instrument.id)
    const invested = brokerPosition.averagePrice !== null
      ? brokerPosition.averagePrice * brokerPosition.quantity
      : (existing?.invested ?? 0)
    const record: PositionRecord = {
      id: existing?.id ?? randomUUID(),
      accountId,
      instrumentId: instrument.id,
      quantity: brokerPosition.quantity,
      averagePrice: brokerPosition.averagePrice ?? undefined,
      currentPrice: brokerPosition.currentPrice ?? undefined,
      value: brokerPosition.currentValue ?? undefined,
      accruedInterest: brokerPosition.accruedInterest ?? undefined,
      invested,
      source: 'broker',
      openedOn: existing?.openedOn,
    }
    if (existing) await updatePosition(client, userId, record)
    else await insertPosition(client, record)
    syncedPositionIds.push(record.id)
  }
  await deleteStaleBrokerPositions(client, portfolio.id, TINKOFF_PROVIDER, syncedPositionIds)

  for (const operation of data.operations) {
    const accountId = brokerAccountId(operation.accountExternalId)
    const known = await findTransactionByExternalId(client, userId, operation.externalId)
    if (known) {
      // Операция загружена ещё в склеенный счёт прежней схемы — переносим на её настоящий счёт.
      if (known.accountId !== accountId) await moveTransactionToAccount(client, known.id, accountId)
      continue
    }
    const transaction: Transaction = {
      id: randomUUID(),
      accountId,
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

  await regenerateForecastPayouts(client, userId)
  await deleteEmptyLegacyBrokerAccounts(client, portfolio.id, TINKOFF_PROVIDER)
  await recordSnapshot(client, userId)
}

// §20: обновление текущей цены акций, фондов и облигаций по данным MOEX ISS. Раньше было
// исключительно явным действием пользователя (кнопка «Обновить цены») именно потому, что
// в проекте сознательно нет Celery/Redis (см. «Решение (контекст)» в истории плана) — теперь
// эта же логика используется и планировщиком (§19/§21/§32), и осталась доступна по кнопке:
// оба пути вызывают одну и ту же функцию, а не два независимых куска кода.
//
// По каждой бумаге возвращается итог и время последнего удачного обновления (BUG-19):
// «Обновлено цен: 0 из 1» без причины не отличает закрытую биржу от опечатки в тикере.
export type PriceRefreshStatus = 'updated' | 'not_found' | 'no_price' | 'unavailable' | 'no_quantity'
export type PriceRefreshItem = {
  positionId: string
  name: string
  code: string
  status: PriceRefreshStatus
  priceUpdatedAt?: string
}
const QUOTED_GROUPS: AssetGroupType[] = ['share', 'fund', 'bond']

export async function refreshMarketPrices(client: Db, userId: string): Promise<{ checked: number; updated: number; items: PriceRefreshItem[] }> {
  const positions = await listPositions(client, userId)
  // Облигацию на MOEX ищем по тикеру, а если его нет — по ISIN: у ОФЗ и большинства
  // корпоративных выпусков SECID совпадает с ISIN-подобным кодом (SU26241RMFS8).
  const eligible = positions.filter((position) =>
    position.source !== 'broker'
    && QUOTED_GROUPS.includes(position.instrument.groupType)
    && Boolean(position.instrument.ticker || (position.instrument.groupType === 'bond' && position.instrument.isin)),
  )
  const items: PriceRefreshItem[] = []
  let updated = 0
  for (const position of eligible) {
    const code = (position.instrument.ticker || position.instrument.isin)!
    const item: PriceRefreshItem = {
      positionId: position.id, name: position.instrument.name, code, status: 'no_quantity',
      priceUpdatedAt: position.priceUpdatedAt,
    }
    items.push(item)
    // Без количества цену за бумагу не во что умножить — спрашивать биржу незачем.
    if (!position.quantity) continue
    const quote = await getMoexQuote(code)
    if (quote.status !== 'ok') {
      item.status = quote.status
      continue
    }
    await updatePositionMarketPrice(client, userId, {
      id: position.id,
      currentPrice: quote.price,
      value: quote.price * position.quantity,
      accruedInterest: quote.accruedInterest === null ? undefined : quote.accruedInterest * position.quantity,
    })
    await recordInstrumentPrice(client, position.instrumentId, new Date().toISOString().slice(0, 10), quote.price)
    item.status = 'updated'
    item.priceUpdatedAt = new Date().toISOString()
    updated += 1
  }
  if (updated > 0) await recordSnapshot(client, userId)
  return { checked: eligible.length, updated, items }
}

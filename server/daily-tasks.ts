// Логика, общая для HTTP-хендлеров (server/index.ts) и планировщика фоновых задач
// (server/scheduler.ts, §19/§21/§32) — вынесена сюда, чтобы CLAUDE.md §10 («Portfolio Engine
// на бэкенде — единственное место расчётов», распространяется и на смежную бизнес-логику,
// а не только на сам движок) не нарушался дублированием между явным действием пользователя
// и ежедневным автоматическим запуском одной и той же операции.
import { randomUUID } from 'node:crypto'
import { tinkoffConnector } from './brokers/tinkoff.ts'
import { getCbrRateTable, getMoexQuote } from './market-data.ts'
import { aggregateByGroup, convertCurrency, type AssetGroup, type EngineContext, type PositionInput } from './portfolio-engine.ts'
import { forecastPayouts } from './payout-forecast.ts'
import {
  ensureAccount, ensurePortfolio, findInstrumentByKey, findPortfolio, findPositionByAccountInstrument,
  findTransactionByExternalId, insertInstrument, sumCashBalances, insertPayout, insertPosition, insertTransaction,
  deleteForecastPayouts, deletePayoutsForTransaction, listPayouts, listPositions, updatePosition,
  updatePositionMarketPrice, upsertSnapshot,
  type AssetGroupType, type Db, type Payout, type PayoutType, type Position, type PositionRecord, type Transaction,
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
    accruedInterest: position.accruedInterest ?? null,
  }
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
export async function recordSnapshot(client: Db, userId: string, date = new Date().toISOString().slice(0, 10)) {
  const portfolio = await findPortfolio(client, userId)
  if (!portfolio) return
  const inputs = await portfolioEngineInputs(client, userId, await listPositions(client, userId))
  if (!inputs.length) return
  const aggregate = aggregateByGroup(inputs, await engineContext(portfolio.baseCurrency))
  await upsertSnapshot(client, portfolio.id, randomUUID(), date, aggregate.value, aggregate.invested)
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
  let created = 0
  for (const position of positions) {
    for (const forecast of forecastPayouts(position, position.instrument, today)) {
      const key = `${position.instrumentId}|${forecast.date}|${forecast.type}`
      if (taken.has(key)) continue
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
  return created
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

  await regenerateForecastPayouts(client, userId)
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
    item.status = 'updated'
    item.priceUpdatedAt = new Date().toISOString()
    updated += 1
  }
  if (updated > 0) await recordSnapshot(client, userId)
  return { checked: eligible.length, updated, items }
}

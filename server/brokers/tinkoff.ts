// Коннектор Т-Инвестиций (T-Invest API v2, REST-JSON шлюз). SPEC §19.
//
// ВАЖНО: точные названия полей ответов (GetPortfolio/GetOperations/GetAccounts) взяты из
// документированной, но не проверенной вживую схемы контрактов T-Invest API — Swagger/Redocly
// на developer.tbank.ru рендерится через JS и недоступен для автоматического чтения в этой
// среде. Основа: публично известные типы `MoneyValue {currency, units, nano}` и
// `Quotation {units, nano}`, а также стандартные методы `UsersService.GetAccounts`,
// `OperationsService.GetPortfolio`, `OperationsService.GetOperations`,
// `InstrumentsService.GetInstrumentBy`. Требуется подтверждение реальным токеном перед тем,
// как считать интеграцию окончательно проверенной (см. план, пункт 5).
//
// Решено автономно (продолжение пункта 5, по прямому указанию пользователя): пока у пользователя
// нет готового боевого токена, коннектор по умолчанию работает через песочницу T-Invest API
// (`SandboxService` — тот же хост, отдельные sandbox-методы `GetSandboxAccounts`/
// `GetSandboxPortfolio`/`GetSandboxOperations`, подтверждено поиском по developer.tbank.ru).
// Режим переключается переменной окружения `TINKOFF_API_MODE` (`sandbox` по умолчанию,
// `production` — боевой контур), без единой правки бизнес-логики выше этого файла: и
// `performTinkoffSync` в server/index.ts, и интерфейс `BrokerConnector` не знают о режиме
// вообще. Когда пользователь пришлёт боевой токен — переключение делается одной переменной
// в `.env`, без переделки кода. Автосоздание sandbox-счёта (`OpenSandboxAccount`) сознательно
// не реализовано: пустой sandbox-портфель у свежего токена — валидное состояние (см. SPEC §40.2),
// а наполнить его тестовыми позициями пользователь может через собственный интерфейс
// Т-Инвестиций в режиме песочницы — это находится за пределами задачи «синхронизировать
// существующий портфель».
import type { BrokerConnector, BrokerInstrument, BrokerOperation, BrokerPosition, BrokerSyncResult } from './types.ts'

const BASE_URL = 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1'
const API_MODE: 'sandbox' | 'production' = process.env.TINKOFF_API_MODE === 'production' ? 'production' : 'sandbox'

class TinkoffApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

async function call<T>(service: string, method: string, token: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}.${service}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new TinkoffApiError(response.status, `T-Invest API ${service}/${method}: ${response.status} ${text.slice(0, 200)}`)
  }
  return (await response.json()) as T
}

interface Quotation { units?: string | number; nano?: number }
interface MoneyValue extends Quotation { currency?: string }

function quotationToNumber(value: Quotation | undefined | null): number | null {
  if (!value) return null
  const units = Number(value.units ?? 0)
  const nano = Number(value.nano ?? 0)
  return units + nano / 1e9
}

interface TinkoffAccount { id: string; name?: string }
interface TinkoffPortfolioPosition {
  figi?: string
  instrumentUid?: string
  instrumentType?: string
  quantity?: Quotation
  averagePositionPrice?: MoneyValue
  currentPrice?: MoneyValue
  currentValue?: MoneyValue
  ticker?: string
  name?: string
  isin?: string
}
interface TinkoffOperation {
  id?: string
  parentOperationId?: string
  currency?: string
  payment?: MoneyValue
  price?: MoneyValue
  quantity?: string | number
  date?: string
  operationType?: string
  instrumentUid?: string
  description?: string
  commission?: MoneyValue
}

const ASSET_TYPE_MAP: Record<string, BrokerInstrument['assetType']> = {
  bond: 'bond',
  share: 'share',
  etf: 'fund',
  currency: 'other',
  futures: 'other',
}

const OPERATION_TYPE_MAP: Record<string, BrokerOperation['type']> = {
  OPERATION_TYPE_BUY: 'BUY',
  OPERATION_TYPE_BUY_CARD: 'BUY',
  OPERATION_TYPE_SELL: 'SELL',
  OPERATION_TYPE_INPUT: 'DEPOSIT',
  OPERATION_TYPE_OUTPUT: 'WITHDRAW',
  OPERATION_TYPE_COUPON: 'COUPON',
  OPERATION_TYPE_DIVIDEND: 'DIVIDEND',
  OPERATION_TYPE_INTEREST: 'INTEREST',
  OPERATION_TYPE_BROKER_FEE: 'FEE',
  OPERATION_TYPE_SERVICE_FEE: 'FEE',
  OPERATION_TYPE_TAX: 'TAX',
  OPERATION_TYPE_TAX_CORRECTION: 'TAX',
  OPERATION_TYPE_BOND_REPAYMENT: 'REDEMPTION',
  OPERATION_TYPE_BOND_REPAYMENT_FULL: 'REDEMPTION',
  OPERATION_TYPE_BOND_REPAYMENT_PARTIAL: 'REDEMPTION',
}

const ACCOUNTS_SERVICE = API_MODE === 'sandbox' ? 'SandboxService' : 'UsersService'
const ACCOUNTS_METHOD = API_MODE === 'sandbox' ? 'GetSandboxAccounts' : 'GetAccounts'
const PORTFOLIO_SERVICE = API_MODE === 'sandbox' ? 'SandboxService' : 'OperationsService'
const PORTFOLIO_METHOD = API_MODE === 'sandbox' ? 'GetSandboxPortfolio' : 'GetPortfolio'
const OPERATIONS_SERVICE = API_MODE === 'sandbox' ? 'SandboxService' : 'OperationsService'
const OPERATIONS_METHOD = API_MODE === 'sandbox' ? 'GetSandboxOperations' : 'GetOperations'

export const tinkoffConnector: BrokerConnector = {
  providerId: 'tinkoff',

  async validateToken(token: string): Promise<boolean> {
    try {
      await call<{ accounts?: TinkoffAccount[] }>(ACCOUNTS_SERVICE, ACCOUNTS_METHOD, token)
      return true
    } catch (error) {
      if (error instanceof TinkoffApiError && (error.status === 401 || error.status === 403)) return false
      throw error
    }
  },

  async fetchSyncData(token: string): Promise<BrokerSyncResult> {
    const { accounts: rawAccounts } = await call<{ accounts?: TinkoffAccount[] }>(ACCOUNTS_SERVICE, ACCOUNTS_METHOD, token)
    const accounts = rawAccounts ?? []

    const positions: BrokerPosition[] = []
    const operations: BrokerOperation[] = []

    for (const account of accounts) {
      const portfolio = await call<{ positions?: TinkoffPortfolioPosition[] }>(PORTFOLIO_SERVICE, PORTFOLIO_METHOD, token, {
        accountId: account.id,
      })
      for (const raw of portfolio.positions ?? []) {
        const instrumentExternalId = raw.instrumentUid || raw.figi || raw.ticker || ''
        if (!instrumentExternalId) continue
        const instrument: BrokerInstrument = {
          externalId: instrumentExternalId,
          isin: raw.isin,
          ticker: raw.ticker,
          name: raw.name || raw.ticker || instrumentExternalId,
          currency: raw.averagePositionPrice?.currency || raw.currentPrice?.currency || 'RUB',
          assetType: ASSET_TYPE_MAP[raw.instrumentType || ''] || 'other',
        }
        positions.push({
          accountExternalId: account.id,
          instrument,
          quantity: quotationToNumber(raw.quantity) ?? 0,
          averagePrice: quotationToNumber(raw.averagePositionPrice),
          currentPrice: quotationToNumber(raw.currentPrice),
          currentValue: quotationToNumber(raw.currentValue),
        })
      }

      const now = new Date()
      const from = new Date(now)
      from.setFullYear(from.getFullYear() - 1)
      const { operations: rawOperations } = await call<{ operations?: TinkoffOperation[] }>(OPERATIONS_SERVICE, OPERATIONS_METHOD, token, {
        accountId: account.id,
        from: from.toISOString(),
        to: now.toISOString(),
        state: 'OPERATION_STATE_EXECUTED',
      })
      for (const raw of rawOperations ?? []) {
        if (!raw.id || !raw.date) continue
        const mappedType = OPERATION_TYPE_MAP[raw.operationType || '']
        if (!mappedType) continue
        operations.push({
          externalId: raw.id,
          accountExternalId: account.id,
          instrumentExternalId: raw.instrumentUid,
          type: mappedType,
          date: raw.date,
          quantity: raw.quantity !== undefined ? Number(raw.quantity) : undefined,
          price: quotationToNumber(raw.price) ?? undefined,
          amount: Math.abs(quotationToNumber(raw.payment) ?? 0),
          currency: raw.currency || raw.payment?.currency || 'RUB',
          commission: raw.commission ? Math.abs(quotationToNumber(raw.commission) ?? 0) : undefined,
          description: raw.description,
        })
      }
    }

    return {
      accounts: accounts.map((account) => ({ externalId: account.id, name: account.name, currency: 'RUB' })),
      positions,
      operations,
    }
  },
}

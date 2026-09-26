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
import { readFileSync } from 'node:fs'
import { request } from 'node:https'
import { rootCertificates } from 'node:tls'
import type { BrokerConnector, BrokerInstrument, BrokerOperation, BrokerPosition, BrokerSyncResult } from './types.ts'

const BASE_URL = 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1'
const API_MODE: 'sandbox' | 'production' = process.env.TINKOFF_API_MODE === 'production' ? 'production' : 'sandbox'

class TinkoffApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

// Сертификат invest-public-api.tbank.ru выпущен Russian Trusted Root CA (Минцифры), которого нет
// в наборе корневых сертификатов Node.js: без него любой запрос падал с «fetch failed» ещё до
// проверки токена, и пользователь видел «Проверьте токен». Корень доверяем только здесь, а не
// всему процессу (NODE_EXTRA_CA_CERTS), — остальные исходящие запросы проверяются как раньше.
// Файл взят с gosuslugi.ru, SHA-256 D2:6D:2D:02:…:CA:8E:CF:31 совпал с цепочкой сервера Т-Банка.
const TRUSTED_CA = [
  ...rootCertificates,
  readFileSync(new URL('./certs/russian_trusted_root_ca.pem', import.meta.url), 'utf8'),
]
const REQUEST_TIMEOUT_MS = 30_000

function post(url: string, token: string, payload: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      ca: TRUSTED_CA,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`T-Invest API: нет ответа за ${REQUEST_TIMEOUT_MS / 1000} с`)))
    req.on('error', reject)
    req.end(payload)
  })
}

// Токен вставляют из приложения Т-Банка, часто с телефона: вместе с ним приезжают переносы
// строк, пробелы, неразрывный пробел или невидимые символы форматирования (U+200B и т.п.).
// Node отказывается ставить такое в заголовок Authorization (ERR_INVALID_CHAR), и раньше это
// выглядело как «не удалось связаться». Настоящий токен — «t.» и base64url, без пробелов,
// поэтому всё пробельное и невидимое вырезаем; если осталось что-то кроме печатного ASCII —
// это не токен, и вызывающий код отвечает понятной ошибкой, не ходя в API.
export function normalizeTinkoffToken(raw: string): string | null {
  const token = raw.replace(/[\s\p{Cf}]/gu, '')
  return /^[\x21-\x7e]+$/.test(token) ? token : null
}

async function call<T>(service: string, method: string, token: string, body: Record<string, unknown> = {}): Promise<T> {
  const { status, text } = await post(`${BASE_URL}.${service}/${method}`, token, JSON.stringify(body))
  if (status < 200 || status >= 300) {
    throw new TinkoffApiError(status, `T-Invest API ${service}/${method}: ${status} ${text.slice(0, 200)}`)
  }
  return JSON.parse(text) as T
}

interface Quotation { units?: string | number; nano?: number }
interface MoneyValue extends Quotation { currency?: string }

function quotationToNumber(value: Quotation | undefined | null): number | null {
  if (!value) return null
  const units = Number(value.units ?? 0)
  const nano = Number(value.nano ?? 0)
  return units + nano / 1e9
}

// Цену 0 брокер отдаёт у бумаг, которые не торгуются: заблокированные активы, делистинг,
// дефолт. Это не стоимость 0, а её отсутствие — портфель должен показать «Актуальная цена
// недоступна» (§7.3), а не обнулить позицию. Так же Т-Инвестиции и не включают их в итог.
function knownPrice(value: number | null): number | null {
  return value !== null && value > 0 ? value : null
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
  currentNkd?: MoneyValue
  ticker?: string
  name?: string
  isin?: string
}
// InstrumentsService.GetInstrumentBy — GetPortfolio не отдаёт ни названия, ни ISIN бумаги,
// только тикер (у облигаций он совпадает с ISIN): без этого запроса в портфеле стояли «MOEX»
// и «RU000A1075S4» вместо «Московская Биржа» и названия выпуска.
interface TinkoffInstrumentInfo { name?: string; ticker?: string; isin?: string; currency?: string }

async function fetchInstrumentInfo(token: string, uid: string): Promise<TinkoffInstrumentInfo | undefined> {
  try {
    const { instrument } = await call<{ instrument?: TinkoffInstrumentInfo }>('InstrumentsService', 'GetInstrumentBy', token, {
      idType: 'INSTRUMENT_ID_TYPE_UID',
      id: uid,
    })
    return instrument
  } catch (error) {
    // Справка об инструменте — украшение, а не данные портфеля: при сбое остаётся тикер,
    // но протухший токен должен ронять синхронизацию, как и остальные вызовы.
    if (error instanceof TinkoffApiError && (error.status === 401 || error.status === 403)) throw error
    return undefined
  }
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
    const instrumentInfo = new Map<string, TinkoffInstrumentInfo | undefined>()

    for (const account of accounts) {
      const portfolio = await call<{ positions?: TinkoffPortfolioPosition[] }>(PORTFOLIO_SERVICE, PORTFOLIO_METHOD, token, {
        accountId: account.id,
      })
      for (const raw of portfolio.positions ?? []) {
        const instrumentExternalId = raw.instrumentUid || raw.figi || raw.ticker || ''
        if (!instrumentExternalId) continue
        if (raw.instrumentUid && !instrumentInfo.has(raw.instrumentUid)) {
          instrumentInfo.set(raw.instrumentUid, await fetchInstrumentInfo(token, raw.instrumentUid))
        }
        const info = raw.instrumentUid ? instrumentInfo.get(raw.instrumentUid) : undefined
        const instrument: BrokerInstrument = {
          externalId: instrumentExternalId,
          isin: raw.isin || info?.isin || undefined,
          ticker: raw.ticker || info?.ticker,
          name: raw.name || info?.name || raw.ticker || instrumentExternalId,
          // API отдаёт код валюты строчными («rub»), остальное приложение — ISO-заглавными.
          currency: (raw.averagePositionPrice?.currency || raw.currentPrice?.currency || info?.currency || 'RUB').toUpperCase(),
          assetType: ASSET_TYPE_MAP[raw.instrumentType || ''] || 'other',
        }
        const quantity = quotationToNumber(raw.quantity) ?? 0
        const nkd = quotationToNumber(raw.currentNkd)
        positions.push({
          accountExternalId: account.id,
          instrument,
          quantity,
          averagePrice: quotationToNumber(raw.averagePositionPrice),
          currentPrice: knownPrice(quotationToNumber(raw.currentPrice)),
          currentValue: knownPrice(quotationToNumber(raw.currentValue)),
          accruedInterest: nkd === null ? null : nkd * quantity,
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
          currency: (raw.currency || raw.payment?.currency || 'RUB').toUpperCase(),
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

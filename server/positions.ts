// Создание позиции и разбор её тела запроса — общий модуль между HTTP-хендлерами
// (server/index.ts, ручной ввод §17) и асинхронным OCR-воркером (server/ocr.ts, §18/§34).
// Вынесено сюда по тому же принципу, что и daily-tasks.ts: CLAUDE.md §10 запрещает
// дублировать бизнес-логику между явным действием пользователя и фоновым процессом.
import { randomUUID } from 'node:crypto'
import { resolveAssetGroup, type AssetGroup, type PositionValuation } from './portfolio-engine.ts'
import { GROUP_LABELS } from './daily-tasks.ts'
import { couponForecastGap } from './payout-forecast.ts'
import {
  ensureAccount, ensurePortfolio, insertInstrument, insertPosition,
  type AccountType, type AssetGroupType, type DataSource, type Db, type Instrument, type Position,
} from './repository.ts'

// Тело запроса на создание/правку позиции приходит из HTTP как произвольный JSON —
// каждое поле приводится к типу отдельно, ниже, а не доверяется как есть.
export type PositionBody = Record<string, unknown>

export function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}
export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
export function optionalBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

// Сообщения об ошибках доходят до пользователя (тестер, Т11) — по-русски и с названием поля.
const FIELD_LABELS: Record<string, string> = {
  name: 'Название', title: 'Название', amount: 'Сумма', date: 'Дата', invested: 'Вложено', type: 'Тип',
  token: 'Токен', quantity: 'Количество', averagePrice: 'Средняя цена', currentPrice: 'Текущая цена',
  accruedInterest: 'НКД', nominal: 'Номинал', couponRate: 'Купон', rate: 'Ставка', effectiveRate: 'Эффективная ставка',
  maturityDate: 'Дата погашения', termEndDate: 'Дата окончания', couponDate: 'Дата купона', ofertaDate: 'Дата оферты',
  commission: 'Комиссия', tax: 'Налог',
}
const label = (field: string) => FIELD_LABELS[field] ?? field

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Не заполнено поле «${label(field)}»`)
  return value.trim()
}

// Верхняя граница сумм: больше не помещается в numeric базы, и Postgres отвечал
// пользователю «numeric field overflow» (прогон 01.10, П15).
const MAX_AMOUNT = 1e12
export function positiveNumber(value: unknown, field: string): number {
  const result = Number(value)
  if (!Number.isFinite(result) || result <= 0) throw new Error(`«${label(field)}» должно быть больше нуля`)
  if (result >= MAX_AMOUNT) throw new Error(`«${label(field)}» слишком большое число`)
  return result
}

// Дата обязательна и существует в календаре: 2026-02-30 раньше доходила до Postgres
// и возвращалась пользователю как «date/time field value out of range» (П15).
export function requiredDate(value: unknown, field: string): string {
  const text = requiredText(value, field)
  checkDate(text, field)
  return text
}

// Операция или открытие позиции не могут быть в будущем (П20). Запас в один день:
// «сегодня» сервера считается в UTC, а у пользователя в Москве уже может быть завтра.
export function notInFuture(date: string, field: string, now = new Date()) {
  const limit = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  if (date > limit) throw new Error(`«${label(field)}» не может быть в будущем`)
}

// Валюты MVP (§12, §13): для остальных нет курса, и позиция показывалась «Оценка недоступна».
export const SUPPORTED_CURRENCIES = ['RUB', 'USD', 'CNY']
const MAX_NAME_LENGTH = 200
const MAX_RATE = 100

// Проверка параметров инструмента и позиции (тестер, Т12): отрицательные количество и
// ставка, дата окончания раньше открытия и даты не в формате ГГГГ-ММ-ДД сохранялись и
// потом ломали прогноз выплат и доходность.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
function checkDate(value: string | undefined, field: string) {
  if (value === undefined) return
  const parsed = new Date(`${value}T00:00:00Z`)
  if (!ISO_DATE.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`«${label(field)}»: нет такой даты или она не в формате ГГГГ-ММ-ДД`)
}
export function checkNonNegative(value: number | undefined, field: string) {
  if (value !== undefined && value < 0) throw new Error(`«${label(field)}» не может быть отрицательным`)
}
export function validateHolding(instrument: Instrument, position: { openedOn?: string; quantity?: number; averagePrice?: number; currentPrice?: number; accruedInterest?: number }) {
  for (const field of ['maturityDate', 'termEndDate', 'couponDate', 'ofertaDate'] as const) checkDate(instrument[field], field)
  checkDate(position.openedOn, 'date')
  if (position.openedOn) notInFuture(position.openedOn, 'date')
  if (instrument.name.length > MAX_NAME_LENGTH) throw new Error(`«Название» длиннее ${MAX_NAME_LENGTH} символов`)
  if (instrument.source === 'manual' && !SUPPORTED_CURRENCIES.includes(instrument.currency)) throw new Error(`Валюта ${instrument.currency} пока не поддерживается: доступны ${SUPPORTED_CURRENCIES.join(', ')}`)
  for (const field of ['nominal', 'couponRate', 'rate', 'effectiveRate'] as const) checkNonNegative(instrument[field], field)
  for (const field of ['couponRate', 'rate', 'effectiveRate'] as const) {
    if ((instrument[field] ?? 0) > MAX_RATE) throw new Error(`«${label(field)}» не может быть больше ${MAX_RATE}% годовых`)
  }
  for (const field of ['averagePrice', 'currentPrice', 'accruedInterest'] as const) checkNonNegative(position[field], field)
  if (position.quantity !== undefined && position.quantity <= 0) throw new Error('«Количество» должно быть больше нуля')
  const end = instrument.termEndDate ?? instrument.maturityDate
  if (end && position.openedOn && end <= position.openedOn) {
    throw new Error(`«${label(instrument.termEndDate ? 'termEndDate' : 'maturityDate')}» должна быть позже даты открытия`)
  }
}

// BUG-08 (§17, §28 серверная валидация): «вложено» обязано сходиться с количеством ×
// средней ценой, если заданы оба. Не задано вложено — оно выводится из них; задано и
// расходится — запрос отклоняется, а не сохраняет два противоречащих числа в одной карточке.
// Допуск — 1 ₽ или 0,1%: средняя цена брокера бывает с копейками и дробями копеек.
export function reconcileInvested(quantity: number | undefined, averagePrice: number | undefined, invested: number | undefined): number | undefined {
  if (!(quantity !== undefined && quantity > 0 && averagePrice !== undefined && averagePrice > 0)) return invested
  const expected = Math.round(quantity * averagePrice * 100) / 100
  if (invested === undefined) return expected
  if (Math.abs(invested - expected) > Math.max(1, expected * 0.001)) {
    throw new Error(`Вложено (${invested}) не совпадает с количеством × средней ценой (${quantity} × ${averagePrice} = ${expected})`)
  }
  return invested
}

export const GROUP_TYPES: Record<AssetGroup, AssetGroupType> = {
  'Вклады': 'deposit', 'Облигации': 'bond', 'Акции': 'share', 'Фонды': 'fund', 'Деньги': 'cash', 'Прочее': 'other',
}
export const MANUAL_PROVIDER = 'Ручной ввод'

export function toGroupType(value: unknown): AssetGroupType {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw in GROUP_LABELS) return raw as AssetGroupType
  return GROUP_TYPES[resolveAssetGroup(typeof value === 'string' ? value : null)]
}
// Тип счёта выводится так же, как при бэкфилле: ручные записи — прочий счёт,
// вклады — банковский, остальное — брокерский (§11 Account).
export function accountTypeFor(provider: string, groupType: AssetGroupType): AccountType {
  if (provider === MANUAL_PROVIDER) return 'other'
  if (groupType === 'deposit') return 'bank'
  return 'broker'
}

export function instrumentFromBody(body: PositionBody, id: string, source: DataSource): Instrument {
  const groupType = toGroupType(body.type)
  return {
    id,
    groupType,
    instrumentType: optionalText(body.instrumentType) || groupType,
    name: requiredText(body.name, 'name'),
    currency: (optionalText(body.currency) || 'RUB').toUpperCase(),
    source,
    ticker: optionalText(body.ticker),
    isin: optionalText(body.isin),
    issuer: optionalText(body.issuer),
    nominal: optionalNumber(body.nominal),
    maturityDate: optionalText(body.maturityDate),
    couponRate: optionalNumber(body.couponRate),
    couponDate: optionalText(body.couponDate),
    ofertaDate: optionalText(body.ofertaDate),
    amortization: optionalBool(body.amortization),
    rate: optionalNumber(body.rate),
    effectiveRate: optionalNumber(body.effectiveRate),
    capitalization: optionalBool(body.capitalization),
    termEndDate: optionalText(body.termEndDate),
    interestPayoutFrequency: optionalText(body.interestPayoutFrequency),
    replenishable: optionalBool(body.replenishable),
    partialWithdrawal: optionalBool(body.partialWithdrawal),
    autoProlongation: optionalBool(body.autoProlongation),
  }
}
export function mergeInstrument(existing: Instrument, body: PositionBody): Instrument {
  const groupType = body.type !== undefined ? toGroupType(body.type) : existing.groupType
  return {
    ...existing,
    groupType,
    instrumentType: body.instrumentType !== undefined
      ? (optionalText(body.instrumentType) || groupType)
      : (body.type !== undefined ? groupType : existing.instrumentType),
    name: body.name !== undefined ? requiredText(body.name, 'name') : existing.name,
    currency: body.currency !== undefined ? (optionalText(body.currency) || 'RUB').toUpperCase() : existing.currency,
    ticker: body.ticker !== undefined ? optionalText(body.ticker) : existing.ticker,
    isin: body.isin !== undefined ? optionalText(body.isin) : existing.isin,
    issuer: body.issuer !== undefined ? optionalText(body.issuer) : existing.issuer,
    nominal: body.nominal !== undefined ? optionalNumber(body.nominal) : existing.nominal,
    maturityDate: body.maturityDate !== undefined ? optionalText(body.maturityDate) : existing.maturityDate,
    couponRate: body.couponRate !== undefined ? optionalNumber(body.couponRate) : existing.couponRate,
    couponDate: body.couponDate !== undefined ? optionalText(body.couponDate) : existing.couponDate,
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
}

// Создание позиции — единая точка для ручного ввода (§17) и распознанных со скриншота
// записей (§18): заводит портфель и счёт, если их ещё нет, затем инструмент и позицию.
export async function createPosition(client: Db, userId: string, body: PositionBody, source: DataSource): Promise<Position> {
  const instrument = instrumentFromBody(body, randomUUID(), source)
  const value = positiveNumber(body.amount, 'amount')
  const quantity = optionalNumber(body.quantity)
  const averagePrice = optionalNumber(body.averagePrice)
  const invested = reconcileInvested(
    quantity, averagePrice,
    body.invested !== undefined && body.invested !== null && body.invested !== '' ? positiveNumber(body.invested, 'invested') : undefined,
  ) ?? value
  const openedOn = requiredText(body.date, 'date')
  const provider = optionalText(body.institution) || MANUAL_PROVIDER
  // Распознанное со скриншота сохраняется как есть (§40.4) и правится постфактум — там
  // проверка сработает при сохранении правки.
  if (source !== 'ocr') validateHolding(instrument, { openedOn, quantity, averagePrice, currentPrice: optionalNumber(body.currentPrice), accruedInterest: optionalNumber(body.accruedInterest) })

  const portfolio = await ensurePortfolio(client, userId, randomUUID())
  const account = await ensureAccount(client, portfolio.id, randomUUID(), {
    type: accountTypeFor(provider, instrument.groupType),
    provider,
    currency: instrument.currency,
  })
  await insertInstrument(client, userId, instrument)
  const record = {
    id: randomUUID(),
    accountId: account.id,
    instrumentId: instrument.id,
    invested,
    source,
    value,
    quantity,
    averagePrice,
    currentPrice: optionalNumber(body.currentPrice),
    accruedInterest: optionalNumber(body.accruedInterest),
    openedOn,
  }
  await insertPosition(client, record)
  return {
    ...record,
    instrument,
    account: { id: account.id, type: account.type, provider: account.provider, currency: account.currency },
  }
}

// Позиция наружу — плоская запись: поля позиции (§11 Position) вместе с параметрами
// её инструмента (§11 Instrument) и названием счёта, чтобы карточка инструмента (§9)
// собиралась одним запросом.
//
// valuation — оценка Portfolio Engine (§10) в базовой валюте портфеля: единственный
// источник стоимости и P&L для списка и карточки. Сырое amount — это введённое
// пользователем значение (его правит форма редактирования), а не рыночная оценка:
// на экранах показывается valuation.value, иначе список и сводка расходятся (BUG-17).
export function positionToWire(position: Position, valuation?: PositionValuation) {
  const instrument = position.instrument
  return {
    id: position.id,
    accountId: position.accountId,
    instrumentId: position.instrumentId,
    name: instrument.name,
    type: GROUP_LABELS[instrument.groupType] ?? 'Прочее',
    instrumentType: instrument.instrumentType,
    // Текущая стоимость. null = актуальной цены нет; ноль вместо неё не подставляется (§7.3).
    amount: position.value ?? null,
    invested: position.invested,
    ticker: instrument.ticker ?? '',
    date: position.openedOn ?? '',
    institution: position.account.provider,
    currency: instrument.currency,
    source: position.source,
    isin: instrument.isin,
    issuer: instrument.issuer,
    quantity: position.quantity,
    averagePrice: position.averagePrice,
    currentPrice: position.currentPrice,
    priceUpdatedAt: position.priceUpdatedAt,
    accruedInterest: position.accruedInterest,
    nominal: instrument.nominal,
    couponRate: instrument.couponRate,
    couponDate: instrument.couponDate,
    maturityDate: instrument.maturityDate,
    ofertaDate: instrument.ofertaDate,
    amortization: instrument.amortization,
    rate: instrument.rate,
    effectiveRate: instrument.effectiveRate,
    capitalization: instrument.capitalization,
    termEndDate: instrument.termEndDate,
    interestPayoutFrequency: instrument.interestPayoutFrequency,
    replenishable: instrument.replenishable,
    partialWithdrawal: instrument.partialWithdrawal,
    autoProlongation: instrument.autoProlongation,
    // Почему по облигации нет прогноза купонов (BUG-20, §7.3) — показывается на карточке
    // и в календаре вместо молчаливого отсутствия выплат.
    forecastNote: couponForecastGap(position, instrument) ?? undefined,
    // Дата возврата тела вклада / погашения бумаги: позиция закрыта и в стоимость не входит.
    closedOn: position.closedOn,
    valuation: valuation ? {
      // null = оценки нет (нет цены или курса); ноль вместо неё не подставляется (§7.3).
      value: valuation.valueBase,
      invested: valuation.investedBase,
      pnl: valuation.pnl,
      pnlPercent: valuation.pnlPercent,
      priceUnavailable: valuation.priceUnavailable,
      priceUnavailableReason: valuation.priceUnavailableReason,
      estimated: valuation.estimated,
      // НКД облигации или начисленные проценты вклада (оценка движка) в валюте инструмента.
      accruedInterest: valuation.accruedInterest,
    } : undefined,
  }
}

// Ручной ввод ценной бумаги (§17, §20): пользователь называет только тикер и количество,
// всё остальное — название, ISIN, валюта, номинал, купон, погашение, оферта и текущая
// цена — берётся с MOEX ISS. Цена покупки необязательна: без неё вложено считается по
// текущей цене, то есть результат на дату ввода нулевой, а не выдуманный.

import { getMoexSecurity, type MoexLookup, type MoexSecurity } from './market-data.ts'
import { optionalNumber, optionalText, toGroupType, type PositionBody } from './positions.ts'

const SECURITY_GROUPS = ['bond', 'share', 'fund']

/** Что выяснено на MOEX при сохранении: цену надо записать как котировку с датой. */
export type MoexFill = { body: PositionBody; quoted: boolean; price: number | null }

const filled = (value: unknown) => value !== undefined && value !== null && value !== ''

/**
 * Дополняет тело запроса создания позиции данными MOEX. Срабатывает только для бумаг
 * (облигации, акции, фонды), у которых указан тикер и не указана сумма: старый формат
 * запроса (сумма передана явно, как у OCR и прежней формы) не меняется.
 */
export async function fillSecurityFromMoex(
  body: PositionBody,
  lookup: (secid: string) => Promise<MoexLookup<MoexSecurity>> = getMoexSecurity,
): Promise<MoexFill> {
  const ticker = optionalText(body.ticker)
  if (!SECURITY_GROUPS.includes(toGroupType(body.type)) || !ticker || filled(body.amount)) {
    return { body, quoted: false, price: null }
  }
  const quantity = optionalNumber(body.quantity)
  if (quantity === undefined || quantity <= 0) throw new Error('«Количество» должно быть больше нуля')
  const purchasePrice = optionalNumber(body.averagePrice)
  if (purchasePrice !== undefined && purchasePrice <= 0) throw new Error('«Цена покупки» должна быть больше нуля')

  const result = await lookup(ticker)
  if (result.status === 'not_found') throw new Error(`Бумага «${ticker}» не найдена на Московской бирже`)
  if (result.status === 'unavailable') {
    // Биржа не ответила: сохранить можно, если пользователь знает цену покупки, —
    // цену подтянет обновление котировок (кнопка или планировщик).
    if (purchasePrice === undefined) {
      throw new Error('Не удалось получить цену с Московской биржи. Попробуйте позже или укажите цену покупки')
    }
    return {
      body: { ...body, ticker: ticker.toUpperCase(), name: optionalText(body.name) ?? ticker.toUpperCase(), amount: quantity * purchasePrice },
      quoted: false,
      price: null,
    }
  }

  const security = result.value
  const averagePrice = purchasePrice ?? security.price ?? undefined
  if (averagePrice === undefined) {
    throw new Error(`На Московской бирже нет цены «${security.shortName}». Укажите цену покупки`)
  }
  const price = security.price
  const keep = <T>(field: string, value: T) => (filled(body[field]) ? body[field] : value)
  return {
    body: {
      ...body,
      ticker: security.secid,
      name: keep('name', security.shortName),
      isin: keep('isin', security.isin),
      currency: keep('currency', security.currency),
      nominal: keep('nominal', security.nominal),
      couponRate: keep('couponRate', security.couponRate),
      couponDate: keep('couponDate', security.nextCouponDate),
      maturityDate: keep('maturityDate', security.maturityDate),
      ofertaDate: keep('ofertaDate', security.offerDate),
      averagePrice,
      currentPrice: price ?? undefined,
      accruedInterest: security.accruedInterest !== null ? security.accruedInterest * quantity : undefined,
      amount: quantity * (price ?? averagePrice),
    },
    quoted: price !== null,
    price,
  }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getMoexSecurity, searchMoexSecurities } from './market-data.ts'
import { fillSecurityFromMoex } from './security-lookup.ts'

// MOEX ISS подменяется ответами в формате биржи: тесты не ходят в сеть.
function stubIss(routes: Record<string, unknown>) {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    const key = Object.keys(routes).find((part) => url.includes(part))
    if (!key) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

const OFZ_BOARDS = {
  boards: { columns: ['secid', 'boardid', 'market', 'engine', 'is_primary'], data: [['SU26238RMFS4', 'TQOB', 'bonds', 'stock', 1]] },
  description: { columns: ['name', 'value'], data: [['GROUP', 'stock_bonds']] },
}
const OFZ_BOARD = {
  securities: {
    columns: ['SECID', 'SHORTNAME', 'SECNAME', 'ISIN', 'FACEVALUE', 'FACEUNIT', 'COUPONPERCENT', 'NEXTCOUPON', 'MATDATE', 'OFFERDATE', 'ACCRUEDINT', 'PREVPRICE'],
    data: [['SU26238RMFS4', 'ОФЗ 26238', 'ОФЗ-ПД 26238 15/05/41', 'RU000A1038V6', 1000, 'SUR', 7.1, '2026-12-02', '2041-05-15', '0000-00-00', 12.5, 60]],
  },
  marketdata: { columns: ['LAST', 'MARKETPRICE'], data: [[61.5, 61.4]] },
}

test('описание облигации: цена в деньгах, рубль вместо SUR, нулевая оферта — отсутствие даты', async () => {
  const restore = stubIss({ '/securities/SU26238RMFS4.json?iss.meta=off&iss.only=boards': OFZ_BOARDS, 'boards/TQOB/securities': OFZ_BOARD })
  try {
    const result = await getMoexSecurity('su26238rmfs4')
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.value.price, 615)
    assert.equal(result.value.currency, 'RUB')
    assert.equal(result.value.group, 'bond')
    assert.equal(result.value.nominal, 1000)
    assert.equal(result.value.couponRate, 7.1)
    assert.equal(result.value.nextCouponDate, '2026-12-02')
    assert.equal(result.value.maturityDate, '2041-05-15')
    assert.equal(result.value.offerDate, undefined)
    assert.equal(result.value.accruedInterest, 12.5)
  } finally { restore() }
})

test('поиск оставляет только торгуемые акции, облигации и фонды', async () => {
  const restore = stubIss({
    'iss/securities.json': {
      securities: {
        columns: ['secid', 'shortname', 'name', 'isin', 'group', 'is_traded'],
        data: [
          ['SBER', 'Сбербанк', 'Сбербанк России ПАО ао', 'RU0009029540', 'stock_shares', 1],
          ['SBERP', 'Сбербанк-п', 'Сбербанк России ПАО ап', 'RU0009029557', 'stock_shares', 1],
          ['SBRF', 'SBRF', 'Фьючерс', '', 'futures_forts', 1],
          ['RU000OLD', 'Старая', 'Погашенная облигация', 'RU000OLD', 'stock_bonds', 0],
          ['TMOS', 'TMOS', 'Тинькофф iMOEX', 'RU000A101X76', 'stock_ppif', 1],
        ],
      },
    },
  })
  try {
    const result = await searchMoexSecurities('сбер')
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.deepEqual(result.value.map((item) => [item.secid, item.group]), [['SBER', 'share'], ['SBERP', 'share'], ['TMOS', 'fund']])
    assert.deepEqual(await searchMoexSecurities('с'), { status: 'ok', value: [] })
  } finally { restore() }
})

const sber = { status: 'ok' as const, value: {
  secid: 'SBER', name: 'Сбербанк России ПАО ао', shortName: 'Сбербанк', isin: 'RU0009029540', group: 'share' as const,
  currency: 'RUB', price: 300, accruedInterest: null,
} }

test('бумага по тикеру и количеству: остальное с MOEX, без цены покупки вложено по текущей', async () => {
  const fill = await fillSecurityFromMoex({ type: 'Акции', ticker: 'sber', quantity: 10, date: '2026-09-01' }, async () => sber)
  assert.equal(fill.quoted, true)
  assert.equal(fill.body.name, 'Сбербанк')
  assert.equal(fill.body.ticker, 'SBER')
  assert.equal(fill.body.isin, 'RU0009029540')
  assert.equal(fill.body.averagePrice, 300)
  assert.equal(fill.body.currentPrice, 300)
  assert.equal(fill.body.amount, 3000)
})

test('цена покупки пользователя сохраняется, стоимость — по текущей цене', async () => {
  const fill = await fillSecurityFromMoex({ type: 'Акции', ticker: 'SBER', quantity: 10, averagePrice: 250, date: '2026-09-01' }, async () => sber)
  assert.equal(fill.body.averagePrice, 250)
  assert.equal(fill.body.amount, 3000)
})

test('биржа недоступна: без цены покупки — понятная ошибка, с ней — сохраняем', async () => {
  const down = async () => ({ status: 'unavailable' as const })
  await assert.rejects(fillSecurityFromMoex({ type: 'Акции', ticker: 'SBER', quantity: 10 }, down), /Московской биржи/)
  const fill = await fillSecurityFromMoex({ type: 'Акции', ticker: 'SBER', quantity: 10, averagePrice: 250 }, down)
  assert.equal(fill.quoted, false)
  assert.equal(fill.body.amount, 2500)
  await assert.rejects(fillSecurityFromMoex({ type: 'Акции', ticker: 'NOPE', quantity: 1 }, async () => ({ status: 'not_found' as const })), /не найдена/)
  await assert.rejects(fillSecurityFromMoex({ type: 'Акции', ticker: 'SBER' }, async () => sber), /Количество/)
})

test('вклады и запросы с явной суммой не трогаются', async () => {
  const never = async () => { throw new Error('MOEX не должен вызываться') }
  const deposit = { type: 'Вклады', name: 'Вклад', amount: 100000, date: '2026-09-01' }
  assert.equal((await fillSecurityFromMoex(deposit, never)).body, deposit)
  const legacy = { type: 'Акции', ticker: 'SBER', amount: 3000, name: 'Сбер', date: '2026-09-01' }
  assert.equal((await fillSecurityFromMoex(legacy, never)).body, legacy)
})

// Сквозной смоук-тест API (§37, RELEASE_PLAN.md P0-7): регистрация → вход →
// добавление позиции → сводка портфеля → удаление аккаунта, плюс проверка,
// что чужие данные недоступны. Тот же ad-hoc паттерн, что и остальные *.test.ts
// (без фреймворка), но с async-вариантом test() — сценарий целиком состоит
// из последовательных HTTP-вызовов к реально поднятому серверу.
//
// Запускается: `npx tsx server/smoke-test.ts` (или `npm test`). Сам поднимает
// `server/index.ts` на отдельном порту поверх текущей DATABASE_URL (та же база,
// что использует `npm run dev:full`), дожидается `/api/health`, прогоняет
// сценарий через fetch, останавливает процесс сервера. Тестовые пользователи
// удаляют себя сами через DELETE /api/auth/me — тест самоочищается и его можно
// гонять повторно (например, перед каждым деплоем), не оставляя мусора в БД.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'

const PORT = Number(process.env.SMOKE_TEST_PORT || 3091)
const BASE_URL = `http://localhost:${PORT}`
const STARTUP_TIMEOUT_MS = 20_000

let failed = 0
async function test(name: string, run: () => Promise<void>) {
  try {
    await run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(String(error instanceof Error ? error.message : error).split('\n').map((line) => `       ${line}`).join('\n'))
  }
}

function startServer(): ChildProcess {
  // Спавним tsx напрямую (не через npx) — иначе получаем цепочку
  // npx → sh -c → tsx-обёртка → настоящий node-процесс, и SIGTERM,
  // посланный верхнему ChildProcess, до реального процесса не доходит:
  // он остаётся висеть на порту даже после успешного завершения теста.
  return spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), REGISTRATION_INVITE_CODE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForHealth(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let exited = false
  child.once('exit', () => { exited = true })
  while (Date.now() < deadline) {
    if (exited) throw new Error('Сервер завершился до готовности /api/health')
    try {
      const response = await fetch(`${BASE_URL}/api/health`)
      if (response.ok) return
    } catch {
      // сервер ещё не слушает порт — пробуем снова
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('Не дождались готовности /api/health')
}

function uniqueEmail(label: string): string {
  return `smoke-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`
}

async function api(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  // Без Bearer изменяющие запросы (регистрация, вход) проходят CSRF-проверку только с этим заголовком.
  const headers: Record<string, string> = { 'X-Requested-With': 'portfel' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : undefined
  return { status: response.status, json }
}

async function run() {
  const server = startServer()
  server.stdout?.on('data', () => {})
  server.stderr?.on('data', (chunk) => process.stderr.write(chunk))

  try {
    await waitForHealth(server)

    let tokenA = ''
    let tokenB = ''
    let positionId = ''
    const emailA = uniqueEmail('a')
    const emailB = uniqueEmail('b')
    const password = 'smoke-test-password-1'

    await test('регистрация пользователя A', async () => {
      const { status, json } = await api('/api/auth/register', { method: 'POST', body: { email: emailA, password } })
      assert.equal(status, 201)
      assert.ok(json.token)
      assert.equal(json.user.email, emailA)
    })

    await test('вход пользователем A', async () => {
      const { status, json } = await api('/api/auth/login', { method: 'POST', body: { email: emailA, password } })
      assert.equal(status, 200)
      assert.ok(json.token)
      tokenA = json.token
    })

    await test('добавление позиции', async () => {
      const { status, json } = await api('/api/positions', {
        method: 'POST',
        token: tokenA,
        body: { name: 'Смоук-тест вклад', type: 'Вклад', amount: 100000, date: '2026-01-15' },
      })
      assert.equal(status, 201)
      assert.ok(json.id)
      assert.equal(json.name, 'Смоук-тест вклад')
      assert.equal(json.amount, 100000)
      positionId = json.id
    })

    await test('сводка портфеля отражает добавленную позицию', async () => {
      const { status, json } = await api('/api/portfolio/summary', { token: tokenA })
      assert.equal(status, 200)
      assert.equal(json.invested, 100000)
      assert.equal(json.total, 100000)
    })

    // BUG-17 (FIX_PLAN 2.2): список и карточка обязаны показывать оценку Portfolio Engine
    // (quantity × currentPrice), а не сумму, сохранённую при вводе.
    let sharePositionId = ''
    await test('позиция отдаёт оценку движка, а не сохранённую сумму', async () => {
      const created = await api('/api/positions', {
        method: 'POST',
        token: tokenA,
        body: { name: 'Смоук-тест акция', type: 'Акция', amount: 28000, date: '2026-01-15', quantity: 10, averagePrice: 2800, currentPrice: 3100 },
      })
      assert.equal(created.status, 201)
      sharePositionId = created.json.id
      assert.equal(created.json.valuation.value, 31000)
      assert.equal(created.json.valuation.pnl, 3000)
      const list = await api('/api/positions', { token: tokenA })
      const share = list.json.find((item: { id: string }) => item.id === sharePositionId)
      assert.equal(share.valuation.value, 31000)
      assert.equal(share.valuation.priceUnavailable, false)
      const single = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      assert.equal(single.json.valuation.pnl, 3000)
      const summary = await api('/api/portfolio/summary', { token: tokenA })
      assert.equal(summary.json.total, 100000 + 31000)
    })

    // BUG-08 (FIX_PLAN 2.5): вложено сходится с количеством × средней ценой.
    await test('вложено выводится из количества × средней цены и не расходится с ними', async () => {
      const derived = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест сверка', type: 'Акция', amount: 100000, date: '2026-01-15', quantity: 100, averagePrice: 800 },
      })
      assert.equal(derived.status, 201)
      assert.equal(derived.json.invested, 80000)
      const conflicting = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест сверка 2', type: 'Акция', amount: 100000, invested: 100000, date: '2026-01-15', quantity: 100, averagePrice: 800 },
      })
      assert.equal(conflicting.status, 400)
      assert.match(conflicting.json.error, /не совпадает/)
      const patched = await api(`/api/positions/${derived.json.id}`, { method: 'PATCH', token: tokenA, body: { quantity: 50 } })
      assert.equal(patched.status, 200)
      assert.equal(patched.json.invested, 40000)
      const badPatch = await api(`/api/positions/${derived.json.id}`, { method: 'PATCH', token: tokenA, body: { invested: 12345 } })
      assert.equal(badPatch.status, 400)
      assert.equal((await api(`/api/positions/${derived.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // Покупка и продажа бумаг меняют количество, а не только вложенную сумму: иначе
    // докупка у позиции «количество × цена» выглядела убытком на всю сумму покупки.
    await test('покупка и продажа меняют количество бумаг', async () => {
      const buy = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'BUY', amount: 15000, quantity: 5, price: 3000, date: '2026-02-01', positionId: sharePositionId },
      })
      assert.equal(buy.status, 201)
      assert.equal(buy.json.quantity, 5)
      let share = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      assert.equal(share.json.quantity, 15)
      assert.equal(share.json.invested, 43000)
      assert.equal(share.json.valuation.value, 46500)

      // Без количества — выводится из текущей цены позиции и сохраняется в операции.
      const implicit = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'BUY', amount: 6200, date: '2026-02-02', positionId: sharePositionId },
      })
      assert.equal(implicit.status, 201)
      assert.equal(implicit.json.quantity, 2)
      share = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      assert.equal(share.json.quantity, 17)

      const oversell = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'SELL', amount: 3100, quantity: 18, date: '2026-02-03', positionId: sharePositionId },
      })
      assert.equal(oversell.status, 400)

      // Правка названия не меняет количество; удаление возвращает позицию как было.
      const renamed = await api(`/api/transactions/${buy.json.id}`, { method: 'PATCH', token: tokenA, body: { title: 'Докупка', amount: 15000 } })
      assert.equal(renamed.status, 200)
      assert.equal(renamed.json.quantity, 5)
      share = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      assert.equal(share.json.quantity, 17)
      for (const id of [buy.json.id, implicit.json.id]) {
        assert.equal((await api(`/api/transactions/${id}`, { method: 'DELETE', token: tokenA })).status, 204)
      }
      share = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      assert.equal(share.json.quantity, 10)
      assert.equal(share.json.invested, 28000)
      assert.equal(share.json.valuation.value, 31000)
    })

    // Продажа списывает себестоимость по средней цене, а не выручку: прибыль от продажи
    // остаётся в результате, удаление продажи возвращает позицию ровно как была.
    await test('продажа с прибылью даёт реализованный результат и откатывается точно', async () => {
      const before = (await api('/api/portfolio/summary', { token: tokenA })).json
      const sale = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'SELL', amount: 14000, quantity: 4, date: '2026-02-04', positionId: sharePositionId },
      })
      assert.equal(sale.status, 201)
      let share = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      assert.equal(share.json.quantity, 6)
      assert.equal(share.json.invested, 16800)
      assert.equal(share.json.averagePrice, 2800)
      let after = (await api('/api/portfolio/summary', { token: tokenA })).json
      // 4 бумаги проданы по 3 500 при текущей 3 100: +400 × 4 к результату, а проданные
      // бумаги (4 × 3 100 по текущей цене) из стоимости портфеля уходят.
      assert.equal(Math.round(after.financialResult), Math.round(before.financialResult + 1600))
      assert.equal(Math.round(after.total), Math.round(before.total - 12400))
      await api(`/api/transactions/${sale.json.id}`, { method: 'PATCH', token: tokenA, body: { amount: 12400, quantity: 4, price: 3100 } })
      after = (await api('/api/portfolio/summary', { token: tokenA })).json
      assert.equal(Math.round(after.financialResult), Math.round(before.financialResult))
      assert.equal((await api(`/api/transactions/${sale.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
      share = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      assert.equal(share.json.quantity, 10)
      assert.equal(share.json.invested, 28000)
      assert.equal(share.json.averagePrice, 2800)
    })

    // Параллельные покупки по одной позиции не затирают друг друга (двойной клик, вкладки).
    await test('параллельные покупки складываются', async () => {
      const buys = await Promise.all([1, 2, 3, 4, 5].map(() => api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'BUY', amount: 3100, quantity: 1, date: '2026-02-05', positionId: sharePositionId },
      })))
      assert.deepEqual(buys.map((buy) => buy.status), [201, 201, 201, 201, 201])
      const share = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      assert.equal(share.json.quantity, 15)
      for (const buy of buys) await api(`/api/transactions/${buy.json.id}`, { method: 'DELETE', token: tokenA })
      assert.equal((await api(`/api/positions/${sharePositionId}`, { token: tokenA })).json.quantity, 10)
    })

    // Тестер Т11/Т12: понятные ошибки по-русски, нечисловой id — 404, бессмысленные
    // параметры не сохраняются.
    await test('проверка параметров и понятные ошибки', async () => {
      assert.equal((await api('/api/positions/abc', { token: tokenA })).status, 404)
      const negative = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест кривой', type: 'Вклады', amount: 1000, date: '2026-05-01', rate: -5 },
      })
      assert.equal(negative.status, 400)
      assert.match(negative.json.error, /Ставка/)
      const backwards = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест кривой', type: 'Вклады', amount: 1000, date: '2026-05-01', termEndDate: '2026-01-01' },
      })
      assert.equal(backwards.status, 400)
      assert.match(backwards.json.error, /позже даты открытия/)
      const oversell = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'SELL', amount: 1, quantity: 1000, date: '2026-02-03', positionId: sharePositionId },
      })
      assert.match(oversell.json.error, /Нельзя продать больше/)
    })

    // Купон, проведённый операцией, можно привязать к бумаге — выплата попадает в её карточку.
    await test('доходная операция привязывается к инструменту и отвязывается', async () => {
      const share = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      const coupon = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'DIVIDEND', amount: 700, date: '2026-02-10', positionId: sharePositionId },
      })
      assert.equal(coupon.status, 201)
      assert.equal(coupon.json.positionId, sharePositionId)
      assert.equal(coupon.json.quantity, null)
      const payouts = await api('/api/payouts', { token: tokenA })
      const linked = payouts.json.find((item: { transactionId?: string }) => item.transactionId === coupon.json.id)
      assert.equal(linked.instrumentId, share.json.instrumentId)
      const unlinked = await api(`/api/transactions/${coupon.json.id}`, { method: 'PATCH', token: tokenA, body: { positionId: null } })
      assert.equal(unlinked.status, 200)
      assert.equal(unlinked.json.positionId, undefined)
      const missing = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'COUPON', amount: 1, date: '2026-02-10', positionId: '00000000-0000-0000-0000-000000000000' },
      })
      assert.equal(missing.status, 400)
      assert.equal((await api(`/api/transactions/${coupon.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // Главный результат (§10.6) учитывает выплаты; пришедший дивиденд вложенное не меняет.
    await test('дивиденд увеличивает результат, но не «вложено»', async () => {
      const before = (await api('/api/portfolio/summary', { token: tokenA })).json
      const dividend = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'DIVIDEND', amount: 1000, date: '2026-02-11', positionId: sharePositionId },
      })
      const after = (await api('/api/portfolio/summary', { token: tokenA })).json
      assert.equal(after.invested, before.invested)
      assert.equal(after.financialResult, before.financialResult + 1000)
      assert.equal(after.valueChange, before.valueChange)
      assert.equal((await api(`/api/transactions/${dividend.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // Критик К3: полученная выплата — это пришедшие деньги: отметка «получена» заводит
    // связанную операцию и попадает в «Получено выплат», снятие отметки всё возвращает.
    await test('выплата «получена» заводит операцию и учитывается в полученных', async () => {
      const summaryOf = async () => (await api('/api/portfolio/summary', { token: tokenA })).json
      const start = await summaryOf()
      const payout = await api('/api/payouts', {
        method: 'POST', token: tokenA,
        body: { title: 'Смоук-тест купон', amount: 5000, date: '2026-03-02', type: 'COUPON', positionId: sharePositionId },
      })
      assert.equal((await summaryOf()).paid, start.paid, 'ожидаемая выплата ещё не получена')
      await api(`/api/payouts/${payout.json.id}`, { method: 'PATCH', token: tokenA, body: { status: 'received' } })
      assert.equal((await summaryOf()).paid, start.paid + 5000)
      await api(`/api/payouts/${payout.json.id}`, { method: 'PATCH', token: tokenA, body: { amount: 6000 } })
      const received = await summaryOf()
      assert.equal(received.paid, start.paid + 6000)
      assert.equal(received.invested, start.invested, 'пришедший купон — не вложения')
      const linked = (await api('/api/payouts', { token: tokenA })).json.find((item: { id: string }) => item.id === payout.json.id)
      assert.ok(linked.transactionId, 'полученная выплата видна в операциях')

      await api(`/api/payouts/${payout.json.id}`, { method: 'PATCH', token: tokenA, body: { status: 'expected' } })
      assert.equal((await summaryOf()).paid, start.paid, 'снятая отметка убирает выплату из полученных')
      assert.equal((await api(`/api/payouts/${payout.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // Прогон 01.10 (П15–П21): ошибки ввода — по-русски и без текста Postgres.
    await test('проверка ввода: даты, суммы, ставка, валюта, JSON и неизвестный адрес', async () => {
      const position = (body: Record<string, unknown>) => api('/api/positions', {
        method: 'POST', token: tokenA, body: { name: 'Смоук-проверка', type: 'Вклад', amount: 1000, date: '2026-01-10', ...body },
      })
      const rejected = async (body: Record<string, unknown>, message: RegExp) => {
        const response = await position(body)
        assert.equal(response.status, 400, JSON.stringify(body))
        assert.match(response.json.error, message)
      }
      await rejected({ amount: 1e16 }, /слишком большое/)
      await rejected({ date: '2026-02-30' }, /нет такой даты/)
      await rejected({ date: '2999-01-01' }, /не может быть в будущем/)
      await rejected({ name: 'а'.repeat(201) }, /длиннее 200/)
      await rejected({ rate: 500, termEndDate: '2027-01-10' }, /больше 100%/)
      await rejected({ type: 'Деньги', currency: 'EUR' }, /EUR пока не поддерживается/)

      const future = await api('/api/transactions', { method: 'POST', token: tokenA, body: { type: 'FEE', amount: 5, date: '2999-01-01' } })
      assert.equal(future.status, 400)
      const negativeFee = await api('/api/transactions', { method: 'POST', token: tokenA, body: { type: 'FEE', amount: 5, date: '2026-01-10', commission: -1 } })
      assert.equal(negativeFee.status, 400)
      // Пополнения и снятия убраны: новые операции этих типов не принимаются.
      for (const type of ['DEPOSIT', 'WITHDRAW']) {
        const legacy = await api('/api/transactions', { method: 'POST', token: tokenA, body: { type, amount: 5, date: '2026-01-10' } })
        assert.equal(legacy.status, 400, type)
      }
      const untitled = await api('/api/transactions', { method: 'POST', token: tokenA, body: { type: 'FEE', amount: 5, date: '2026-01-10' } })
      assert.equal(untitled.json.title, 'Комиссия', 'без описания — русское название типа, а не FEE')
      assert.equal((await api(`/api/transactions/${untitled.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
      // Т36: операция без инструмента — в выбранной валюте, неподдерживаемая отклоняется.
      const euro = await api('/api/transactions', { method: 'POST', token: tokenA, body: { type: 'FEE', amount: 5, date: '2026-01-10', currency: 'EUR' } })
      assert.equal(euro.status, 400)
      const dollars = await api('/api/transactions', { method: 'POST', token: tokenA, body: { type: 'FEE', amount: 5, date: '2026-01-10', currency: 'usd' } })
      assert.equal(dollars.json.currency, 'USD')
      const edited = await api(`/api/transactions/${dollars.json.id}`, { method: 'PATCH', token: tokenA, body: { amount: 7 } })
      assert.equal(edited.json.currency, 'USD', 'правка суммы валюту не сбрасывает')
      assert.equal((await api(`/api/transactions/${dollars.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
      // Т35: фонд, которого нет на бирже, сохраняется по названию и сумме, без похода на MOEX.
      const unlisted = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { type: 'Фонды', name: 'ЗПИФ Недвижимость', date: '2026-01-10', quantity: 2, averagePrice: 1500, amount: 3000, invested: 3000, currency: 'RUB', source: 'manual' },
      })
      assert.equal(unlisted.status, 201)
      assert.equal(unlisted.json.name, 'ЗПИФ Недвижимость')
      assert.equal(unlisted.json.amount, 3000)
      assert.equal((await api(`/api/positions/${unlisted.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)

      const broken = await fetch(`${BASE_URL}/api/positions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` }, body: '{bad',
      })
      assert.equal(broken.status, 400)
      const unknown = await api('/api/no-such-route', { token: tokenA })
      assert.equal(unknown.status, 404)
      assert.equal(unknown.json.error, 'Нет такого метода API')
    })

    // BUG-23 (FIX_PLAN 3.7): ручную выплату можно привязать к инструменту и отвязать.
    await test('ручная выплата привязывается к инструменту', async () => {
      const share = await api(`/api/positions/${sharePositionId}`, { token: tokenA })
      const created = await api('/api/payouts', {
        method: 'POST', token: tokenA,
        body: { title: 'Смоук-тест дивиденд', amount: 3400, date: '2026-03-01', type: 'DIVIDEND', status: 'received', positionId: sharePositionId },
      })
      assert.equal(created.status, 201)
      assert.equal(created.json.instrumentId, share.json.instrumentId)
      const unknown = await api('/api/payouts', {
        method: 'POST', token: tokenA,
        body: { title: 'Смоук-тест дивиденд', amount: 1, date: '2026-03-01', positionId: '00000000-0000-0000-0000-000000000000' },
      })
      assert.equal(unknown.status, 400)
      const untouched = await api(`/api/payouts/${created.json.id}`, { method: 'PATCH', token: tokenA, body: { amount: 3500 } })
      assert.equal(untouched.json.instrumentId, share.json.instrumentId)
      const unlinked = await api(`/api/payouts/${created.json.id}`, { method: 'PATCH', token: tokenA, body: { positionId: '' } })
      assert.equal(unlinked.status, 200)
      assert.equal(unlinked.json.instrumentId, undefined)
      const relinked = await api(`/api/payouts/${created.json.id}`, { method: 'PATCH', token: tokenA, body: { positionId: sharePositionId } })
      assert.equal(relinked.json.instrumentId, share.json.instrumentId)
      assert.equal((await api(`/api/payouts/${created.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    await test('удаление второй позиции', async () => {
      const { status } = await api(`/api/positions/${sharePositionId}`, { method: 'DELETE', token: tokenA })
      assert.equal(status, 204)
    })

    // BUG-20 (FIX_PLAN 2.7): облигация без «Даты выплаты купона» получает прогноз купонов.
    await test('купоны облигации прогнозируются без даты купона', async () => {
      const bond = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест ОФЗ', type: 'Облигация', amount: 120000, date: '2026-09-01', quantity: 120, nominal: 1000, couponRate: 9.5, maturityDate: '2032-05-19' },
      })
      assert.equal(bond.status, 201)
      assert.equal(bond.json.forecastNote, undefined)
      const payouts = await api('/api/payouts', { token: tokenA })
      const coupons = payouts.json.filter((payout: { instrumentId: string; type: string }) => payout.instrumentId === bond.json.instrumentId && payout.type === 'COUPON')
      assert.ok(coupons.length >= 11, `купонов: ${coupons.length}`)
      assert.equal(coupons[0].amount, 5700)
      const noCoupon = await api(`/api/positions/${bond.json.id}`, { method: 'PATCH', token: tokenA, body: { couponRate: '' } })
      assert.match(noCoupon.json.forecastNote, /ставка купона/)
      assert.equal((await api(`/api/positions/${bond.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // П32 (решение владельца 15.10): вклад с истёкшим сроком закрывается сам — возврат тела
    // и проценты отмечаются полученными, позиция закрыта и не входит в стоимость портфеля; тело не считается доходом — в результат идут только проценты.
    await test('вклад с истёкшим сроком закрывается сам без двойного счёта', async () => {
      const before = await api('/api/portfolio/summary', { token: tokenA })
      const deposit = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест закрытый вклад', type: 'Вклад', amount: 200000, date: '2020-01-01', rate: 10, termEndDate: '2021-01-01', interestPayoutFrequency: 'В конце срока' },
      })
      assert.equal(deposit.status, 201)
      assert.equal(deposit.json.closedOn, '2021-01-01', 'ответ на создание сообщает, что запись сразу закрыта (Т40)')
      const own = (await api('/api/payouts', { token: tokenA })).json.filter((payout: { instrumentId: string }) => payout.instrumentId === deposit.json.instrumentId)
      assert.deepEqual(own.map((payout: { type: string }) => payout.type).sort(), ['DEPOSIT_PRINCIPAL', 'INTEREST'])
      assert.ok(own.every((payout: { status: string }) => payout.status === 'received'))
      const interest = own.find((payout: { type: string }) => payout.type === 'INTEREST').amount
      const closed = await api(`/api/positions/${deposit.json.id}`, { token: tokenA })
      assert.equal(closed.json.closedOn, '2021-01-01')
      assert.equal(closed.json.valuation.value, 0)
      assert.equal(closed.json.valuation.pnl, 0)
      const summary = await api('/api/portfolio/summary', { token: tokenA })
      // Вклад закрыт: в стоимость не входит, доход учитывается один раз.
      assert.equal(Math.round(summary.json.total), Math.round(before.json.total))
      assert.equal(summary.json.paid, before.json.paid + interest)
      assert.equal(Math.round(summary.json.financialResult), Math.round(before.json.financialResult + interest))
      // Повторный пересчёт (правка, суточный цикл) не задваивает выплаты.
      await api(`/api/positions/${deposit.json.id}`, { method: 'PATCH', token: tokenA, body: { rate: 10 } })
      const again = (await api('/api/payouts', { token: tokenA })).json.filter((payout: { instrumentId: string }) => payout.instrumentId === deposit.json.instrumentId)
      assert.equal(again.length, 2)
      assert.equal((await api('/api/portfolio/summary', { token: tokenA })).json.paid, summary.json.paid)
      for (const payout of own) {
        await api(`/api/payouts/${payout.id}`, { method: 'PATCH', token: tokenA, body: { status: 'expected' } })
      }
      assert.equal((await api(`/api/positions/${deposit.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // Т29: правка закрытого вклада пересчитывает выплаты при закрытии из новых параметров,
    // продление срока открывает его снова. Т28: удаление убирает его выплаты из результата.
    await test('правка и удаление закрытого вклада пересчитывают выплаты', async () => {
      const before = (await api('/api/portfolio/summary', { token: tokenA })).json
      const deposit = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест правка закрытого', type: 'Вклад', amount: 100000, date: '2020-01-01', rate: 10, termEndDate: '2021-01-01', interestPayoutFrequency: 'В конце срока' },
      })
      assert.equal(deposit.status, 201)
      const own = async () => (await api('/api/payouts', { token: tokenA })).json
        .filter((payout: { instrumentId: string }) => payout.instrumentId === deposit.json.instrumentId)
        .map((payout: { type: string; amount: number; status: string }) => [payout.type, payout.amount, payout.status])
        .sort()
      const interest = (await own()).find(([type]: [string]) => type === 'INTEREST')[1]

      const edited = await api(`/api/positions/${deposit.json.id}`, { method: 'PATCH', token: tokenA, body: { invested: 200000 } })
      assert.equal(edited.status, 200)
      assert.equal(edited.json.closedOn, '2021-01-01')
      const recomputed = await own()
      assert.deepEqual(recomputed[0], ['DEPOSIT_PRINCIPAL', 200000, 'received'])
      assert.equal(recomputed[1][0], 'INTEREST')
      assert.ok(Math.abs(recomputed[1][1] - interest * 2) < 0.05)
      let summary = (await api('/api/portfolio/summary', { token: tokenA })).json
      assert.equal(Math.round(summary.financialResult), Math.round(before.financialResult + interest * 2))
      assert.equal(Math.round(summary.paid), Math.round(before.paid + interest * 2))

      const extended = await api(`/api/positions/${deposit.json.id}`, { method: 'PATCH', token: tokenA, body: { termEndDate: '2099-01-01' } })
      assert.equal(extended.json.closedOn, undefined)
      assert.ok((await own()).every(([, , status]: [string, number, string]) => status === 'expected'))
      summary = (await api('/api/portfolio/summary', { token: tokenA })).json
      assert.equal(Math.round(summary.paid), Math.round(before.paid))

      await api(`/api/positions/${deposit.json.id}`, { method: 'PATCH', token: tokenA, body: { termEndDate: '2021-01-01' } })
      assert.equal((await api(`/api/positions/${deposit.json.id}`, { token: tokenA })).json.closedOn, '2021-01-01')

      assert.equal((await api(`/api/positions/${deposit.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
      summary = (await api('/api/portfolio/summary', { token: tokenA })).json
      assert.equal(Math.round(summary.paid), Math.round(before.paid))
      assert.equal(Math.round(summary.financialResult), Math.round(before.financialResult))
      const left = (await api('/api/transactions', { token: tokenA })).json
        .filter((item: { instrumentId?: string }) => item.instrumentId === deposit.json.instrumentId)
      assert.equal(left.length, 0)
    })

    // Вклад без ставки прогноза не получает — при истёкшем сроке возвращается сумма вложения.
    // Вклад с автопролонгацией продлевается, а не закрывается.
    await test('вклад без ставки закрывается возвратом вложения, с пролонгацией — нет', async () => {
      const plain = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест вклад без ставки', type: 'Вклад', amount: 70000, date: '2020-01-01', termEndDate: '2021-01-01' },
      })
      const prolonged = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест вклад с пролонгацией', type: 'Вклад', amount: 50000, date: '2020-01-01', rate: 8, termEndDate: '2021-01-01', autoProlongation: true },
      })
      assert.equal(plain.status, 201)
      assert.equal(prolonged.status, 201)
      const payouts = (await api('/api/payouts', { token: tokenA })).json
      const plainOwn = payouts.filter((payout: { instrumentId: string }) => payout.instrumentId === plain.json.instrumentId)
      assert.deepEqual(plainOwn.map((payout: { type: string; amount: number; status: string }) => [payout.type, payout.amount, payout.status]), [['DEPOSIT_PRINCIPAL', 70000, 'received']])
      assert.equal((await api(`/api/positions/${plain.json.id}`, { token: tokenA })).json.closedOn, '2021-01-01')
      const prolongedPosition = await api(`/api/positions/${prolonged.json.id}`, { token: tokenA })
      assert.equal(prolongedPosition.json.closedOn, undefined)
      // Т30: пролонгируемый вклад не ждёт возврата тела — только проценты по срокам.
      const prolongedOwn = payouts.filter((payout: { instrumentId: string }) => payout.instrumentId === prolonged.json.instrumentId)
      assert.ok(prolongedOwn.length > 0)
      assert.ok(prolongedOwn.every((payout: { type: string }) => payout.type === 'INTEREST'))
      for (const payout of plainOwn) {
        await api(`/api/payouts/${payout.id}`, { method: 'PATCH', token: tokenA, body: { status: 'expected' } })
      }
      assert.equal((await api(`/api/positions/${plain.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
      assert.equal((await api(`/api/positions/${prolonged.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // П33 (решение владельца 15.10): облигация с прошедшим погашением закрывается сама —
    // погашение отмечается полученным. Без номинала
    // погашение заводится на сумму вложения.
    await test('погашенная облигация закрывается сама', async () => {
      const before = await api('/api/portfolio/summary', { token: tokenA })
      const bond = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест погашенная ОФЗ', type: 'Облигация', amount: 9800, date: '2024-01-10', quantity: 10, nominal: 1000, maturityDate: '2025-06-01' },
      })
      const bare = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест облигация без номинала', type: 'Облигация', amount: 5000, date: '2024-01-10', maturityDate: '2025-06-01' },
      })
      assert.equal(bond.status, 201)
      assert.equal(bare.status, 201)
      const payouts = (await api('/api/payouts', { token: tokenA })).json
      const own = payouts.filter((payout: { instrumentId: string }) => payout.instrumentId === bond.json.instrumentId)
      assert.deepEqual(own.map((payout: { type: string; amount: number; status: string }) => [payout.type, payout.amount, payout.status]), [['REDEMPTION', 10000, 'received']])
      const bareOwn = payouts.filter((payout: { instrumentId: string }) => payout.instrumentId === bare.json.instrumentId)
      assert.deepEqual(bareOwn.map((payout: { type: string; amount: number; status: string }) => [payout.type, payout.amount, payout.status]), [['REDEMPTION', 5000, 'received']])
      assert.equal((await api(`/api/positions/${bond.json.id}`, { token: tokenA })).json.closedOn, '2025-06-01')
      assert.equal((await api(`/api/positions/${bare.json.id}`, { token: tokenA })).json.closedOn, '2025-06-01')
      const summary = await api('/api/portfolio/summary', { token: tokenA })
      assert.equal(Math.round(summary.json.total), Math.round(before.json.total))
      for (const payout of [...own, ...bareOwn]) {
        await api(`/api/payouts/${payout.id}`, { method: 'PATCH', token: tokenA, body: { status: 'expected' } })
      }
      assert.equal((await api(`/api/positions/${bond.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
      assert.equal((await api(`/api/positions/${bare.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)

      // Т38: последний купон, отмеченный при автозакрытии, — уже факт, без «(прогноз, …)».
      const coupon = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест купонная ОФЗ', type: 'Облигация', amount: 1000, date: '2024-01-10', quantity: 1, nominal: 1000, couponRate: 10, maturityDate: '2025-06-01' },
      })
      assert.equal(coupon.status, 201)
      const couponOwn = (await api('/api/payouts', { token: tokenA })).json.filter((payout: { instrumentId: string }) => payout.instrumentId === coupon.json.instrumentId)
      const last = couponOwn.find((payout: { type: string; date: string }) => payout.type === 'COUPON' && payout.date === '2025-06-01')
      assert.ok(last, 'последний купон в дату погашения есть')
      assert.equal(last.status, 'received')
      assert.doesNotMatch(last.title, /прогноз/)
      for (const payout of couponOwn) {
        await api(`/api/payouts/${payout.id}`, { method: 'PATCH', token: tokenA, body: { status: 'expected' } })
      }
      assert.equal((await api(`/api/positions/${coupon.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    await test('доходность за периоды отдаётся списком (§23)', async () => {
      const returns = await api('/api/portfolio/returns', { token: tokenA })
      assert.equal(returns.status, 200)
      assert.ok(Array.isArray(returns.json))
    })

    // BUG-22 (FIX_PLAN 2.6): ожидаемая выплата с прошедшей датой — «просрочено»,
    // в «Ожидается» не входит.
    await test('просроченная выплата отделена от ожидаемых', async () => {
      const before = await api('/api/portfolio/summary', { token: tokenA })
      const past = await api('/api/payouts', { method: 'POST', token: tokenA, body: { title: 'Смоук-тест прошлый купон', amount: 1234, date: '2020-04-05', type: 'COUPON' } })
      assert.equal(past.status, 201)
      assert.equal(past.json.overdue, true)
      const future = await api('/api/payouts', { method: 'POST', token: tokenA, body: { title: 'Смоук-тест будущий купон', amount: 777, date: '2099-01-01', type: 'COUPON' } })
      assert.equal(future.json.overdue, false)
      const summary = await api('/api/portfolio/summary', { token: tokenA })
      assert.equal(summary.json.overdue, before.json.overdue + 1234)
      assert.equal(summary.json.expected, before.json.expected + 777)
      const received = await api(`/api/payouts/${past.json.id}`, { method: 'PATCH', token: tokenA, body: { status: 'received' } })
      assert.equal(received.json.overdue, false)
      for (const id of [past.json.id, future.json.id]) {
        assert.equal((await api(`/api/payouts/${id}`, { method: 'DELETE', token: tokenA })).status, 204)
      }
    })

    // CLIENT_FLOW_PLAN §4.1: банк у выплат и разрез «Где хранится».
    await test('у выплаты есть банк, «Где хранится» складывается в итог', async () => {
      const past = await api('/api/payouts', { method: 'POST', token: tokenA, body: { title: 'Смоук-тест банк выплаты', amount: 4321, date: '2020-05-06', type: 'COUPON' } })
      assert.equal(past.status, 201)
      const listed = (await api('/api/payouts', { token: tokenA })).json.find((payout: { id: string }) => payout.id === past.json.id)
      assert.equal(typeof listed.institution, 'string')
      const structure = await api('/api/portfolio/structure', { token: tokenA })
      assert.ok(Array.isArray(structure.json.byProvider))
      // «Где хранится» складывается в итог портфеля.
      const summary = (await api('/api/portfolio/summary', { token: tokenA })).json
      const stored = structure.json.byProvider.reduce((sum: number, row: { value: number }) => sum + row.value, 0)
      assert.equal(Math.round(stored), Math.round(summary.total))
      assert.equal((await api(`/api/payouts/${past.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // BUG-15 (FIX_PLAN 2.3): тот же файл повторно не обрабатывается — сервер возвращает
    // прошлый документ. Воркер OCR в тесте не запущен, первый документ остаётся в очереди,
    // этого достаточно: совпадение ищется и среди ещё не обработанных загрузок.
    await test('повторная загрузка того же скриншота не создаёт новый документ', async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
      const upload = async () => {
        const form = new FormData()
        form.append('image', new Blob([png], { type: 'image/png' }), 'smoke.png')
        const response = await fetch(`${BASE_URL}/api/ocr/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form })
        return { status: response.status, json: (await response.json()) as Record<string, unknown> }
      }
      const first = await upload()
      assert.equal(first.status, 202)
      assert.ok(first.json.documentId)
      assert.equal(first.json.alreadyUploadedAt, undefined)
      const second = await upload()
      assert.equal(second.status, 200)
      assert.equal(second.json.documentId, first.json.documentId)
      assert.ok(second.json.alreadyUploadedAt)
    })

    await test('регистрация пользователя B (для проверки изоляции)', async () => {
      const { status, json } = await api('/api/auth/register', { method: 'POST', body: { email: emailB, password } })
      assert.equal(status, 201)
      tokenB = json.token
    })

    await test('чужие позиции не видны через список', async () => {
      const { status, json } = await api('/api/positions', { token: tokenB })
      assert.equal(status, 200)
      assert.deepEqual(json, [])
    })

    await test('чужая позиция недоступна по прямому id', async () => {
      const { status } = await api(`/api/positions/${positionId}`, { token: tokenB })
      assert.equal(status, 404)
    })

    await test('чужая сводка портфеля не содержит чужих данных', async () => {
      const { status, json } = await api('/api/portfolio/summary', { token: tokenB })
      assert.equal(status, 200)
      assert.equal(json.invested, 0)
    })

    await test('ключ Hermes: читает, добавляет вклад, больше ничего; отзыв ключа', async () => {
      const created = await api('/api/integrations/hermes/keys', { method: 'POST', token: tokenA, body: { name: 'Hermes' } })
      assert.equal(created.status, 201)
      const key = created.json.key as string
      assert.match(key, /^pfk_[0-9a-f]{64}$/)
      assert.ok(!created.json.preview.includes(key.slice(4, 20)), 'в превью нет тела ключа')
      // Ключ — без X-Requested-With: это внешний клиент, а не браузер.
      const asKey = async (path: string, method = 'GET', body?: unknown) => {
        const response = await fetch(`${BASE_URL}${path}`, {
          method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        })
        const text = await response.text()
        return { status: response.status, json: text ? JSON.parse(text) : undefined }
      }
      assert.equal((await asKey('/api/portfolio/summary')).status, 200)
      assert.equal((await asKey('/api/recommendations')).status, 200)
      const deposit = await asKey('/api/positions', 'POST', {
        type: 'deposit', name: 'Вклад от Hermes', institution: 'Альфа-Банк', amount: 100000, date: '2026-01-15',
        rate: 18, termEndDate: '2027-01-15', interestPayoutFrequency: 'monthly',
      })
      assert.equal(deposit.status, 201, JSON.stringify(deposit.json))
      assert.equal(deposit.json.institution, 'Альфа-Банк')
      // Правка, удаление, настройки, управление ключами и выход — только из сессии.
      for (const [path, method] of [
        [`/api/positions/${deposit.json.id}`, 'DELETE'], [`/api/positions/${deposit.json.id}`, 'PATCH'],
        ['/api/transactions', 'POST'], ['/api/settings', 'PATCH'], ['/api/integrations/hermes', 'GET'],
        ['/api/integrations/hermes/keys', 'POST'], ['/api/auth/me', 'GET'], ['/api/auth/me', 'DELETE'],
      ] as const) {
        const { status } = await asKey(path, method, method === 'GET' || method === 'DELETE' ? undefined : {})
        assert.equal(status, 403, `${method} ${path}`)
      }
      const list = await api('/api/integrations/hermes', { token: tokenA })
      assert.equal(list.json.keys.length, 1)
      assert.ok(list.json.keys[0].lastUsedAt, 'отмечено последнее использование')
      assert.equal((await api(`/api/positions/${deposit.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
      assert.equal((await api(`/api/integrations/hermes/keys/${created.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
      assert.equal((await asKey('/api/portfolio/summary')).status, 401)
    })

    await test('вебхук Hermes: подписанная проверка доходит, неверный адрес — понятная ошибка', async () => {
      const { createServer } = await import('node:http')
      const { createHmac } = await import('node:crypto')
      const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = []
      const hook = createServer((request, response) => {
        let body = ''
        request.on('data', (chunk) => { body += chunk })
        request.on('end', () => { received.push({ headers: request.headers, body }); response.writeHead(202).end('{}') })
      })
      await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve))
      const port = (hook.address() as { port: number }).port
      const secret = 'smoke-secret-0123456789'
      try {
        const noSecret = await api('/api/integrations/hermes/webhook', { method: 'PUT', token: tokenA, body: { url: `http://127.0.0.1:${port}/webhooks/portfel` } })
        assert.equal(noSecret.status, 400)
        const saved = await api('/api/integrations/hermes/webhook', { method: 'PUT', token: tokenA, body: { url: `http://127.0.0.1:${port}/webhooks/portfel`, secret } })
        assert.equal(saved.status, 200, JSON.stringify(saved.json))
        const sent = await api('/api/integrations/hermes/webhook/test', { method: 'POST', token: tokenA })
        assert.equal(sent.status, 200, JSON.stringify(sent.json))
        assert.equal(received.length, 1)
        const { headers, body } = received[0]
        const expected = createHmac('sha256', secret).update(`${headers['x-webhook-timestamp']}.${body}`).digest('hex')
        assert.equal(headers['x-webhook-signature-v2'], expected)
        assert.equal(JSON.parse(body).event, 'portfel.test')
        const state = await api('/api/integrations/hermes', { token: tokenA })
        assert.ok(state.json.webhook.lastSentAt)
        assert.equal(state.json.webhook.lastError, null)
        assert.equal(JSON.stringify(state.json).includes(secret), false, 'секрет наружу не отдаётся')
        // Адрес без слушателя: ошибка по-русски и сохраняется для экрана.
        await api('/api/integrations/hermes/webhook', { method: 'PUT', token: tokenA, body: { url: 'http://127.0.0.1:9/webhooks/portfel' } })
        const failedSend = await api('/api/integrations/hermes/webhook/test', { method: 'POST', token: tokenA })
        assert.equal(failedSend.status, 400)
        assert.match(failedSend.json.error, /не отвечает/)
        assert.equal((await api('/api/integrations/hermes/webhook', { method: 'DELETE', token: tokenA })).status, 204)
        assert.equal((await api('/api/integrations/hermes', { token: tokenA })).json.webhook, null)
      } finally {
        hook.close()
      }
    })

    await test('удаление аккаунта пользователя A', async () => {
      const { status } = await api('/api/auth/me', { method: 'DELETE', token: tokenA })
      assert.equal(status, 204)
    })

    await test('токен удалённого аккаунта больше не действует', async () => {
      const { status } = await api('/api/auth/me', { token: tokenA })
      assert.equal(status, 401)
    })

    await test('очистка: удаление аккаунта пользователя B', async () => {
      const { status } = await api('/api/auth/me', { method: 'DELETE', token: tokenB })
      assert.equal(status, 204)
    })
  } finally {
    server.kill('SIGTERM')
    await new Promise((resolve) => server.once('exit', resolve))
  }
}

await run()
console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)

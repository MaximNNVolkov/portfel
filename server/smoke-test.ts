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
      // 4 бумаги проданы по 3 500 при текущей 3 100: +400 × 4 к результату.
      assert.equal(Math.round(after.financialResult), Math.round(before.financialResult + 1600))
      assert.equal(Math.round(after.total), Math.round(before.total + 1600))
      assert.equal(Math.round(after.contributed), Math.round(before.contributed))
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

    // Покупка без записанного пополнения оплачена деньгами извне: остаток не уходит в
    // скрытый минус, и пришедший потом дивиденд виден в свободных деньгах.
    await test('покупка без пополнения не съедает следующий доход', async () => {
      const start = (await api('/api/portfolio/summary', { token: tokenA })).json.cash
      const buy = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'BUY', amount: start + 3100, date: '2026-02-06', positionId: sharePositionId },
      })
      const dividend = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'DIVIDEND', amount: 500, date: '2026-02-07', positionId: sharePositionId },
      })
      assert.equal((await api('/api/portfolio/summary', { token: tokenA })).json.cash, 500)
      for (const id of [dividend.json.id, buy.json.id]) await api(`/api/transactions/${id}`, { method: 'DELETE', token: tokenA })
      assert.equal((await api('/api/portfolio/summary', { token: tokenA })).json.cash, start)
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

    // Главный результат (§10.6) учитывает выплаты; «внесено своих» = итог − результат,
    // пришедший дивиденд его не увеличивает.
    await test('дивиденд увеличивает результат, но не «внесено своих»', async () => {
      const before = (await api('/api/portfolio/summary', { token: tokenA })).json
      assert.equal(before.contributed, Math.round((before.total - before.financialResult) * 100) / 100)
      const dividend = await api('/api/transactions', {
        method: 'POST', token: tokenA,
        body: { type: 'DIVIDEND', amount: 1000, date: '2026-02-11', positionId: sharePositionId },
      })
      const after = (await api('/api/portfolio/summary', { token: tokenA })).json
      assert.equal(after.contributed, before.contributed)
      assert.equal(after.financialResult, before.financialResult + 1000)
      assert.equal(after.valueChange, before.valueChange)
      assert.equal((await api(`/api/transactions/${dividend.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // Критик К3/К4: полученная выплата — это пришедшие деньги, реинвестирование их тратит.
    await test('выплата «получена» зачисляет деньги, реинвестирование их списывает', async () => {
      const cashOf = async () => (await api('/api/portfolio/summary', { token: tokenA })).json
      const start = await cashOf()
      const payout = await api('/api/payouts', {
        method: 'POST', token: tokenA,
        body: { title: 'Смоук-тест купон', amount: 5000, date: '2026-03-02', type: 'COUPON', positionId: sharePositionId },
      })
      assert.equal((await cashOf()).cash, start.cash, 'ожидаемая выплата денег не приносит')
      await api(`/api/payouts/${payout.json.id}`, { method: 'PATCH', token: tokenA, body: { status: 'received' } })
      assert.equal((await cashOf()).cash, start.cash + 5000)
      await api(`/api/payouts/${payout.json.id}`, { method: 'PATCH', token: tokenA, body: { amount: 6000 } })
      const received = await cashOf()
      assert.equal(received.cash, start.cash + 6000)
      assert.equal(received.contributed, start.contributed, 'пришедший купон — не свои вложения')

      const tooMuch = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест реинвест', type: 'Вклады', amount: received.cash + 100000, date: '2026-03-03', fromCash: true },
      })
      assert.equal(tooMuch.status, 400)
      assert.match(tooMuch.json.error, /не хватает/)
      const reinvested = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест реинвест', type: 'Вклады', amount: 6000, date: '2026-03-03', fromCash: true },
      })
      assert.equal(reinvested.status, 201)
      const after = await cashOf()
      assert.equal(after.cash, start.cash)
      assert.equal(after.total, received.total, 'деньги превратились во вклад, итог не удвоился')
      const buy = (await api('/api/transactions', { token: tokenA })).json
        .find((item: { positionId?: string; type: string }) => item.type === 'BUY' && item.positionId === reinvested.json.id)
      assert.ok(buy, 'покупка из свободных денег видна в операциях')
      assert.equal((await api(`/api/transactions/${buy.id}`, { method: 'DELETE', token: tokenA })).status, 204)
      assert.equal((await api(`/api/positions/${reinvested.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)

      await api(`/api/payouts/${payout.json.id}`, { method: 'PATCH', token: tokenA, body: { status: 'expected' } })
      assert.equal((await cashOf()).cash, start.cash, 'снятая отметка возвращает деньги назад')
      assert.equal((await api(`/api/payouts/${payout.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // Целевая структура: сохраняется в настройках, сводка показывает сумму до цели.
    await test('целевая структура: проверка, сохранение, сумма до цели, снятие', async () => {
      const bad = await api('/api/settings', { method: 'PATCH', token: tokenA, body: { targetAllocation: { Акции: 50, Вклады: 30 } } })
      assert.equal(bad.status, 400)
      assert.match(bad.json.error, /должна быть 100%/)
      const saved = await api('/api/settings', { method: 'PATCH', token: tokenA, body: { targetAllocation: { Акции: 50, Вклады: 50 } } })
      assert.equal(saved.status, 200)
      assert.deepEqual(saved.json.targetAllocation, { Акции: 50, Вклады: 50 })
      const summary = await api('/api/portfolio/summary', { token: tokenA })
      const deposits = summary.json.rebalance.find((row: { group: string }) => row.group === 'Вклады')
      assert.equal(deposits.target, 50)
      assert.equal(deposits.toTarget, Math.round(summary.json.total / 2 - 100000))
      const cleared = await api('/api/settings', { method: 'PATCH', token: tokenA, body: { targetAllocation: {} } })
      assert.deepEqual(cleared.json.targetAllocation, {})
      assert.deepEqual((await api('/api/portfolio/summary', { token: tokenA })).json.rebalance, [])
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

    // BUG-05 (FIX_PLAN 2.4): пополнение — часть портфеля, покупка перекладывает деньги
    // в бумагу, не меняя общую стоимость.
    await test('пополнение попадает в свободные деньги и общую стоимость', async () => {
      const deposit = await api('/api/transactions', { method: 'POST', token: tokenA, body: { type: 'DEPOSIT', amount: 500000, date: '2026-02-01' } })
      assert.equal(deposit.status, 201)
      let summary = await api('/api/portfolio/summary', { token: tokenA })
      assert.equal(summary.json.cash, 500000)
      assert.equal(summary.json.total, 600000)
      assert.ok(summary.json.groups.some((group: { group: string; value: number }) => group.group === 'Деньги' && group.value === 500000))
      const buy = await api('/api/transactions', { method: 'POST', token: tokenA, body: { type: 'BUY', amount: 50000, date: '2026-02-02', positionId } })
      assert.equal(buy.status, 201)
      summary = await api('/api/portfolio/summary', { token: tokenA })
      assert.equal(summary.json.cash, 450000)
      assert.equal(summary.json.total, 600000)
      for (const id of [deposit.json.id, buy.json.id]) {
        assert.equal((await api(`/api/transactions/${id}`, { method: 'DELETE', token: tokenA })).status, 204)
      }
      summary = await api('/api/portfolio/summary', { token: tokenA })
      assert.equal(summary.json.cash, 0)
      assert.equal(summary.json.total, 100000)
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

    // Замечание 20 (FIX_PLAN 2.8): вклад с истёкшим сроком даёт проценты и возврат тела,
    // и они приходят просроченными, а не пропадают.
    await test('вклад с истёкшим сроком попадает в календарь просроченными выплатами', async () => {
      const deposit = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест старый вклад', type: 'Вклад', amount: 500000, date: '2020-01-01', rate: 16, termEndDate: '2021-01-01', interestPayoutFrequency: 'В конце срока' },
      })
      assert.equal(deposit.status, 201)
      const payouts = await api('/api/payouts', { token: tokenA })
      const own = payouts.json.filter((payout: { instrumentId: string }) => payout.instrumentId === deposit.json.instrumentId)
      assert.deepEqual(own.map((payout: { type: string }) => payout.type).sort(), ['DEPOSIT_PRINCIPAL', 'INTEREST'])
      assert.ok(own.every((payout: { overdue: boolean; status: string }) => payout.overdue && payout.status === 'expected'))
      assert.equal((await api(`/api/positions/${deposit.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
    })

    // Вклад, тело которого отмечено полученным, закрыт: не входит в стоимость портфеля,
    // а тело не считается доходом — в результат идут только проценты.
    await test('полученный возврат тела закрывает вклад без двойного счёта', async () => {
      const before = await api('/api/portfolio/summary', { token: tokenA })
      const deposit = await api('/api/positions', {
        method: 'POST', token: tokenA,
        body: { name: 'Смоук-тест закрытый вклад', type: 'Вклад', amount: 200000, date: '2020-01-01', rate: 10, termEndDate: '2021-01-01', interestPayoutFrequency: 'В конце срока' },
      })
      assert.equal(deposit.status, 201)
      const own = (await api('/api/payouts', { token: tokenA })).json.filter((payout: { instrumentId: string }) => payout.instrumentId === deposit.json.instrumentId)
      const open = await api('/api/portfolio/summary', { token: tokenA })
      assert.equal(open.json.total, before.json.total + 200000)
      for (const payout of own) {
        assert.equal((await api(`/api/payouts/${payout.id}`, { method: 'PATCH', token: tokenA, body: { status: 'received' } })).status, 200)
      }
      const interest = own.find((payout: { type: string }) => payout.type === 'INTEREST').amount
      const closed = await api(`/api/positions/${deposit.json.id}`, { token: tokenA })
      assert.equal(closed.json.closedOn, '2021-01-01')
      assert.equal(closed.json.valuation.value, 0)
      assert.equal(closed.json.valuation.pnl, 0)
      const summary = await api('/api/portfolio/summary', { token: tokenA })
      // Вклад закрыт, а тело и проценты вернулись в свободные деньги (критик К3):
      // итог не теряет 200 000 ₽, а доход учитывается один раз.
      assert.equal(Math.round(summary.json.total), Math.round(before.json.total + 200000 + interest))
      assert.equal(Math.round(summary.json.cash), Math.round(before.json.cash + 200000 + interest))
      assert.equal(summary.json.paid, before.json.paid + interest)
      assert.equal(Math.round(summary.json.financialResult), Math.round(before.json.financialResult + interest))
      assert.equal(Math.round(summary.json.contributed), Math.round(before.json.contributed + 200000))
      for (const payout of own) {
        await api(`/api/payouts/${payout.id}`, { method: 'PATCH', token: tokenA, body: { status: 'expected' } })
      }
      assert.equal((await api(`/api/positions/${deposit.json.id}`, { method: 'DELETE', token: tokenA })).status, 204)
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

    // CLIENT_FLOW_PLAN §4.4: лента «Требует внимания» и банк у выплат и в структуре.
    await test('просроченная выплата попадает в «Требует внимания», у выплаты есть банк', async () => {
      const past = await api('/api/payouts', { method: 'POST', token: tokenA, body: { title: 'Смоук-тест внимание', amount: 4321, date: '2020-05-06', type: 'COUPON' } })
      assert.equal(past.status, 201)
      const attention = await api('/api/attention', { token: tokenA })
      assert.equal(attention.status, 200)
      const item = attention.json.find((entry: { payoutIds?: string[] }) => entry.payoutIds?.includes(past.json.id))
      assert.equal(item?.kind, 'payout_overdue')
      assert.equal(item?.action, 'mark_received')
      const listed = (await api('/api/payouts', { token: tokenA })).json.find((payout: { id: string }) => payout.id === past.json.id)
      assert.equal(typeof listed.institution, 'string')
      const structure = await api('/api/portfolio/structure', { token: tokenA })
      assert.ok(Array.isArray(structure.json.byProvider))
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

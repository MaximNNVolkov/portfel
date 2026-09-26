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
  const headers: Record<string, string> = {}
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

    // BUG-15 (FIX_PLAN 2.3): тот же файл повторно не обрабатывается — сервер возвращает
    // прошлый документ. Воркер OCR в тесте не запущен, первый документ остаётся в очереди,
    // этого достаточно: совпадение ищется и среди ещё не обработанных загрузок.
    await test('повторная загрузка того же скриншота не создаёт новый документ', async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
      const upload = async () => {
        const form = new FormData()
        form.append('image', new Blob([png], { type: 'image/png' }), 'smoke.png')
        const response = await fetch(`${BASE_URL}/api/ocr/upload`, { method: 'POST', headers: { Authorization: `Bearer ${tokenA}` }, body: form })
        return { status: response.status, json: await response.json() }
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

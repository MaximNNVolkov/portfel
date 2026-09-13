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

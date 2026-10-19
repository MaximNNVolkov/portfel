// Ad-hoc проверка уведомлений для Hermes (docs/HERMES.md). Тот же паттерн, что и
// у остальных server/*.test.ts: без фреймворка — `npx tsx server/notifications.test.ts`.

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildNotificationItems, digestText, signatureHeaders, validateWebhookUrl } from './notifications.ts'
import type { Instrument, Payout, Position } from './repository.ts'

let failed = 0
function test(name: string, run: () => void) {
  try {
    run()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(String(error instanceof Error ? error.message : error).split('\n').map((line) => `       ${line}`).join('\n'))
  }
}

const today = '2026-10-18'
function position(id: string, name: string, overrides: Partial<Position> = {}, instrument: Partial<Instrument> = {}): Position {
  return {
    id, accountId: 'acc', instrumentId: `i-${id}`, invested: 100000, source: 'manual',
    instrument: { id: `i-${id}`, groupType: 'deposit', instrumentType: 'deposit', name, currency: 'RUB', source: 'manual', ...instrument },
    account: { id: 'acc', type: 'bank', provider: 'ВТБ', currency: 'RUB' },
    ...overrides,
  }
}
function payout(id: string, overrides: Partial<Payout>): Payout {
  return { id, accountId: 'acc', date: today, type: 'COUPON', amount: 1000, currency: 'RUB', status: 'expected', source: 'forecast', ...overrides }
}

console.log('\nСобытия')
test('выплата в ближайшие три дня — событие; через неделю — нет', () => {
  const items = buildNotificationItems({
    today,
    positions: [position('a', 'ОФЗ 26238', {}, { groupType: 'bond' })],
    payouts: [
      payout('p1', { instrumentId: 'i-a', date: '2026-10-20', amount: 35500 }),
      payout('p2', { instrumentId: 'i-a', date: '2026-10-25' }),
    ],
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'payout_soon')
  assert.match(items[0].text, /^ОФЗ 26238: купон 35 500 ₽ — 20\.10\.2026, через 2 дня$/)
  assert.equal(items[0].key, 'soon:i-a@acc:2026-10-20')
})
test('купон и погашение в один день — одно событие с суммой', () => {
  const items = buildNotificationItems({
    today,
    positions: [position('a', 'ОФЗ', {}, { groupType: 'bond' })],
    payouts: [
      payout('p1', { instrumentId: 'i-a', date: '2026-10-19', amount: 17750 }),
      payout('p2', { instrumentId: 'i-a', date: '2026-10-19', type: 'REDEMPTION', amount: 500000 }),
    ],
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].amount, 517750)
  assert.match(items[0].text, /купон и погашение 517 750 ₽ — завтра/)
})
test('ключ не зависит от id выплаты — прогноз пересоздаётся', () => {
  const build = (id: string) => buildNotificationItems({ today, positions: [], payouts: [payout(id, { instrumentId: 'i-x', date: today })] })
  assert.equal(build('one')[0].key, build('two')[0].key)
})
test('неотмеченная выплата — за последние две недели, старее — нет', () => {
  const items = buildNotificationItems({
    today,
    positions: [],
    payouts: [
      payout('p1', { date: '2026-10-10', description: 'Купон' }),
      payout('p2', { date: '2026-09-01', description: 'Старый купон' }),
      payout('p3', { date: '2026-10-11', status: 'received' }),
    ],
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'payout_overdue')
  assert.match(items[0].text, /^Купон: купон 1 000 ₽ — ожидалось 10\.10\.2026/)
})
test('вклад, закрытый на этой неделе, — событие с суммой возврата', () => {
  const items = buildNotificationItems({
    today,
    positions: [
      position('d', 'Вклад Надёжный', { closedOn: '2026-10-15' }),
      position('old', 'Старый вклад', { closedOn: '2026-09-01' }),
      position('br', 'Брокерская облигация', { closedOn: '2026-10-16', source: 'broker' }, { groupType: 'bond' }),
    ],
    payouts: [
      payout('p1', { instrumentId: 'i-d', date: '2026-10-15', type: 'DEPOSIT_PRINCIPAL', amount: 300000, status: 'received' }),
      payout('p2', { instrumentId: 'i-d', date: '2026-10-15', type: 'INTEREST', amount: 12500, status: 'received' }),
    ],
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].key, 'closed:d')
  assert.equal(items[0].text, 'Вклад Надёжный: вклад закрыт 15.10.2026, вернулось 312 500 ₽')
})
test('ошибка брокера — одно событие в день', () => {
  const items = buildNotificationItems({ today, positions: [], payouts: [], broker: { name: 'Т-Инвестиции', status: 'error' } })
  assert.deepEqual(items.map((item) => item.key), ['broker-error:2026-10-18'])
  assert.equal(buildNotificationItems({ today, positions: [], payouts: [], broker: { name: 'Т-Инвестиции', status: 'connected' } }).length, 0)
})

console.log('\nТекст и подпись')
test('сводка разбита по разделам, закрытое — первым', () => {
  const text = digestText([
    { key: 'a', kind: 'payout_soon', text: 'ОФЗ: купон 1 000 ₽ — завтра' },
    { key: 'b', kind: 'position_closed', text: 'Вклад: вклад закрыт' },
  ])
  assert.equal(text, 'Портфель: новости\n\nЗакрыто:\n• Вклад: вклад закрыт\n\nСкоро придёт:\n• ОФЗ: купон 1 000 ₽ — завтра')
})
test('подпись — Generic V2 Hermes: HMAC-SHA256 hex от «timestamp.тело»', () => {
  const headers = signatureHeaders('secret-secret-secret', '{"a":1}', 1760000000)
  assert.equal(headers['X-Webhook-Timestamp'], '1760000000')
  assert.equal(headers['X-Webhook-Signature-V2'], createHmac('sha256', 'secret-secret-secret').update('1760000000.{"a":1}').digest('hex'))
})
test('адрес вебхука: только http(s), без логина в адресе', () => {
  assert.equal(validateWebhookUrl(' http://127.0.0.1:8644/webhooks/portfel '), 'http://127.0.0.1:8644/webhooks/portfel')
  assert.throws(() => validateWebhookUrl('ftp://host/x'), /http/)
  assert.throws(() => validateWebhookUrl('not a url'), /http/)
  assert.throws(() => validateWebhookUrl('https://user:pass@host/x'), /Логин/)
  assert.throws(() => validateWebhookUrl(''), /Укажите/)
})

if (failed) {
  console.log(`\n${failed} проверок не прошло`)
  process.exit(1)
}
console.log('\nВсе проверки прошли')

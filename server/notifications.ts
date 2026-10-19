// Уведомления во внешний вебхук — на MVP это Hermes, ИИ-агент владельца (docs/HERMES.md).
// «Портфель» сам ничего не пишет в Telegram: он шлёт подписанный JSON, а Hermes доставляет
// текст туда, где его читают. Сообщение собирается из уже посчитанных данных (выплаты,
// закрытые позиции, статус брокера) — новых расчётов здесь нет (§10).
import { createHmac, randomUUID } from 'node:crypto'
import { decryptToken } from './token-crypto.ts'
import { findBrokerConnection, listPayouts, listPositions, type Db, type Payout, type Position } from './repository.ts'

/** Сколько дней вперёд предупреждать о выплате. */
export const SOON_DAYS = 3
/** Старше этого непришедшая выплата уже не повод для уведомления — она остаётся в календаре выплат как просроченная. */
const OVERDUE_LOOKBACK_DAYS = 14
/** Позиция, закрытая автоматически позже этого срока, — уже не новость. */
const CLOSED_LOOKBACK_DAYS = 7
const TIMEOUT_MS = 10_000

export type NotificationItem = {
  /** Ключ события: одно и то же событие уходит один раз (notification_log). */
  key: string
  kind: 'payout_soon' | 'payout_overdue' | 'position_closed' | 'broker_error'
  text: string
  date?: string
  amount?: number
  currency?: string
}

export type NotificationPayload = {
  event: 'portfel.digest' | 'portfel.test'
  text: string
  items: Array<Omit<NotificationItem, 'key'>>
  sentAt: string
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
export function formatMoney(amount: number, currency: string): string {
  const rounded = Math.round(amount * 100) / 100
  const text = rounded.toLocaleString('ru-RU', { maximumFractionDigits: Number.isInteger(rounded) ? 0 : 2 }).replace(/ /g, ' ')
  return `${text} ${currency === 'RUB' ? '₽' : currency}`
}
function formatDate(date: string): string {
  const [year, month, day] = date.split('-')
  return `${day}.${month}.${year}`
}
function whenText(today: string, date: string): string {
  const days = daysBetween(today, date)
  if (days === 0) return 'сегодня'
  if (days === 1) return 'завтра'
  return `${formatDate(date)}, через ${days} ${days < 5 ? 'дня' : 'дней'}`
}

const PAYOUT_KIND: Record<string, string> = {
  COUPON: 'купон', DIVIDEND: 'дивиденды', INTEREST: 'проценты', DEPOSIT_PRINCIPAL: 'возврат вклада',
  REDEMPTION: 'погашение', OTHER: 'выплата',
}

type PayoutGroup = { instrumentKey: string; date: string; title: string; amounts: Map<string, number>; kinds: Set<string> }

// Выплаты одной бумаги в один день (купон и погашение, проценты и тело вклада) — одно событие.
// Ключ не содержит id выплаты: прогноз пересоздаётся при каждой правке портфеля и id меняются.
function groupPayouts(payouts: Payout[], nameByInstrument: Map<string, string>): PayoutGroup[] {
  const groups = new Map<string, PayoutGroup>()
  for (const payout of payouts) {
    const instrumentKey = payout.instrumentId ? `${payout.instrumentId}@${payout.accountId}` : `payout:${payout.id}`
    const id = `${instrumentKey}:${payout.date}`
    const group = groups.get(id) ?? {
      instrumentKey, date: payout.date,
      title: (payout.instrumentId && nameByInstrument.get(payout.instrumentId)) || payout.description || 'Выплата',
      amounts: new Map(), kinds: new Set(),
    }
    group.amounts.set(payout.currency, (group.amounts.get(payout.currency) ?? 0) + payout.amount)
    group.kinds.add(PAYOUT_KIND[payout.type] ?? 'выплата')
    groups.set(id, group)
  }
  return [...groups.values()]
}
function amountsText(amounts: Map<string, number>): string {
  return [...amounts].map(([currency, amount]) => formatMoney(amount, currency)).join(' + ')
}
function singleAmount(amounts: Map<string, number>): { amount?: number; currency?: string } {
  if (amounts.size !== 1) return {}
  const [[currency, amount]] = [...amounts]
  return { amount: Math.round(amount * 100) / 100, currency }
}

export function buildNotificationItems(input: {
  today: string
  positions: Position[]
  payouts: Payout[]
  broker?: { name: string; status: string; lastError?: string }
}): NotificationItem[] {
  const { today } = input
  const nameByInstrument = new Map(input.positions.map((position) => [position.instrumentId, position.instrument.name]))
  const items: NotificationItem[] = []

  const expected = input.payouts.filter((payout) => payout.status === 'expected')
  const soon = expected.filter((payout) => payout.date >= today && payout.date <= addDays(today, SOON_DAYS))
  for (const group of groupPayouts(soon, nameByInstrument)) {
    items.push({
      key: `soon:${group.instrumentKey}:${group.date}`,
      kind: 'payout_soon',
      text: `${group.title}: ${[...group.kinds].join(' и ')} ${amountsText(group.amounts)} — ${whenText(today, group.date)}`,
      date: group.date,
      ...singleAmount(group.amounts),
    })
  }
  const overdue = expected.filter((payout) => payout.date < today && payout.date >= addDays(today, -OVERDUE_LOOKBACK_DAYS))
  for (const group of groupPayouts(overdue, nameByInstrument)) {
    items.push({
      key: `overdue:${group.instrumentKey}:${group.date}`,
      kind: 'payout_overdue',
      text: `${group.title}: ${[...group.kinds].join(' и ')} ${amountsText(group.amounts)} — ожидалось ${formatDate(group.date)}; если пришло, отметьте в «Портфеле»`,
      date: group.date,
      ...singleAmount(group.amounts),
    })
  }

  // Закрытые автоматически вклады и погашенные облигации (autoCloseMaturedPositions):
  // деньги вернулись — повод решить, куда их вложить.
  for (const position of input.positions) {
    if (!position.closedOn || position.source === 'broker') continue
    if (position.closedOn > today || position.closedOn < addDays(today, -CLOSED_LOOKBACK_DAYS)) continue
    const returned = input.payouts.filter((payout) => payout.status === 'received' && payout.date === position.closedOn
      && payout.instrumentId === position.instrumentId && payout.accountId === position.accountId)
    const amounts = new Map<string, number>()
    for (const payout of returned) amounts.set(payout.currency, (amounts.get(payout.currency) ?? 0) + payout.amount)
    const what = position.instrument.groupType === 'deposit' ? 'Вклад закрыт' : 'Облигация погашена'
    items.push({
      key: `closed:${position.id}`,
      kind: 'position_closed',
      text: `${position.instrument.name}: ${what.toLowerCase()} ${formatDate(position.closedOn)}${amounts.size ? `, вернулось ${amountsText(amounts)}` : ''}`,
      date: position.closedOn,
      ...singleAmount(amounts),
    })
  }

  // Ошибка брокера — раз в день, пока не починится.
  if (input.broker?.status === 'error') {
    items.push({
      key: `broker-error:${today}`,
      kind: 'broker_error',
      text: `${input.broker.name}: ${input.broker.lastError || 'не удалось обновить данные'}`,
    })
  }
  return items
}

const SECTION_TITLES: Record<NotificationItem['kind'], string> = {
  position_closed: 'Закрыто',
  payout_soon: 'Скоро придёт',
  payout_overdue: 'Не отмечено полученным',
  broker_error: 'Брокер',
}

export function digestText(items: NotificationItem[]): string {
  const lines = ['Портфель: новости']
  for (const kind of Object.keys(SECTION_TITLES) as Array<NotificationItem['kind']>) {
    const section = items.filter((item) => item.kind === kind)
    if (!section.length) continue
    lines.push('', `${SECTION_TITLES[kind]}:`)
    for (const item of section) lines.push(`• ${item.text}`)
  }
  return lines.join('\n')
}

// Подпись в формате Generic V2 вебхуков Hermes: HMAC-SHA256 в hex от «<timestamp>.<тело>»,
// метка времени — секунды Unix, Hermes отвергает расхождение больше 5 минут.
export function signatureHeaders(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return { 'X-Webhook-Timestamp': String(timestamp), 'X-Webhook-Signature-V2': signature }
}

export function validateWebhookUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : ''
  if (!url) throw new Error('Укажите адрес вебхука')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('Адрес вебхука должен начинаться с http:// или https://') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Адрес вебхука должен начинаться с http:// или https://')
  if (parsed.username || parsed.password) throw new Error('Логин и пароль в адресе вебхука не нужны — подпись идёт секретом')
  return parsed.toString()
}

/** Отправка. Ошибка — русский текст для экрана «Интеграции» и колонки last_error. */
export async function postWebhook(url: string, secret: string, payload: NotificationPayload): Promise<void> {
  const body = JSON.stringify(payload)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Request-Id': randomUUID(), ...signatureHeaders(secret, body) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Вебхук не отвечает — проверьте адрес и что Hermes запущен')
  }
  if (response.ok) return
  if (response.status === 401 || response.status === 403) throw new Error(`Вебхук отклонил подпись (${response.status}) — проверьте секрет`)
  if (response.status === 404) throw new Error('Вебхук не найден (404) — проверьте имя маршрута в адресе')
  throw new Error(`Вебхук ответил ошибкой ${response.status}`)
}

type WebhookRow = { url: string; encrypted_secret: string; enabled: boolean }

async function findWebhook(db: Db, userId: string): Promise<WebhookRow | undefined> {
  const result = await db.query('SELECT url, encrypted_secret, enabled FROM notification_webhooks WHERE user_id = $1', [userId])
  return result.rows[0] as WebhookRow | undefined
}
export async function listWebhookUsers(db: Db): Promise<string[]> {
  const result = await db.query('SELECT user_id FROM notification_webhooks WHERE enabled')
  return result.rows.map((row) => row.user_id as string)
}
async function recordResult(db: Db, userId: string, error: string | null) {
  await db.query(
    `UPDATE notification_webhooks SET last_error = $2, last_sent_at = CASE WHEN $2::text IS NULL THEN NOW() ELSE last_sent_at END
      WHERE user_id = $1`,
    [userId, error],
  )
}

export async function sendTestNotification(db: Db, userId: string): Promise<void> {
  const webhook = await findWebhook(db, userId)
  if (!webhook) throw new Error('Сначала сохраните адрес вебхука')
  try {
    await postWebhook(webhook.url, decryptToken(webhook.encrypted_secret), {
      event: 'portfel.test',
      text: 'Портфель: проверка связи. Уведомления о выплатах и закрытых вкладах будут приходить сюда.',
      items: [],
      sentAt: new Date().toISOString(),
    })
    await recordResult(db, userId, null)
  } catch (error) {
    await recordResult(db, userId, (error as Error).message)
    throw error
  }
}

/**
 * Отправляет события, которых ещё не было. Возвращает число отправленных.
 * Неудачная отправка ничего не пишет в notification_log — те же события уйдут в следующий раз.
 */
export async function sendPendingNotifications(db: Db, userId: string, today: string): Promise<number> {
  const webhook = await findWebhook(db, userId)
  if (!webhook?.enabled) return 0
  const [positions, payouts, tinkoff] = await Promise.all([
    listPositions(db, userId), listPayouts(db, userId), findBrokerConnection(db, userId, 'tinkoff'),
  ])
  const items = buildNotificationItems({
    today, positions, payouts,
    broker: tinkoff ? { name: 'Т-Инвестиции', status: tinkoff.status, lastError: tinkoff.lastError } : undefined,
  })
  if (!items.length) return 0
  const sent = await db.query('SELECT event_key FROM notification_log WHERE user_id = $1 AND event_key = ANY($2)', [userId, items.map((item) => item.key)])
  const sentKeys = new Set(sent.rows.map((row) => row.event_key as string))
  const fresh = items.filter((item) => !sentKeys.has(item.key))
  if (!fresh.length) return 0
  try {
    await postWebhook(webhook.url, decryptToken(webhook.encrypted_secret), {
      event: 'portfel.digest',
      text: digestText(fresh),
      items: fresh.map((item) => ({ kind: item.kind, text: item.text, date: item.date, amount: item.amount, currency: item.currency })),
      sentAt: new Date().toISOString(),
    })
  } catch (error) {
    await recordResult(db, userId, (error as Error).message)
    throw error
  }
  await db.query(
    'INSERT INTO notification_log (user_id, event_key) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
    [userId, fresh.map((item) => item.key)],
  )
  await recordResult(db, userId, null)
  return fresh.length
}

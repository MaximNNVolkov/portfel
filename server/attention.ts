// «Требует внимания» (docs/CLIENT_FLOW_PLAN.md §4.4) — одна лента сигналов по портфелю:
// что клиенту стоит сделать сейчас. Модуль чистый, как portfolio-engine.ts и
// recommendations.ts: без БД и Express — принимает готовые данные и отдаёт список.
//
// Сигналы уже существуют по отдельности (просроченные выплаты, прогноз выплат, правила §24,
// позиции без цены, ошибка синхронизации брокера); здесь они сводятся в одно место и
// сортируются по срочности. Фронтенд ничего не досчитывает — только показывает (§10).

import type { Recommendation } from './recommendations.ts'

export type AttentionKind =
  | 'payout_overdue'
  | 'payout_received'
  | 'payout_soon'
  | 'maturity_soon'
  | 'broker_error'
  | 'price_unavailable'
  | 'forecast_missing'
  | 'insight'

/** Что предлагается сделать. Маршрут строит фронтенд по kind и id записи. */
export type AttentionAction =
  | 'mark_received'
  | 'reinvest'
  | 'open_position'
  | 'edit_position'
  | 'refresh_prices'
  | 'open_integrations'
  | 'open_payments'
  | 'open_analytics'

export type AttentionItem = {
  id: string
  kind: AttentionKind
  /** 1 — срочно, 2 — важно, 3 — к сведению. */
  severity: 1 | 2 | 3
  title: string
  text: string
  action: AttentionAction
  date?: string
  amount?: number
  currency?: string
  institution?: string
  positionId?: string
  payoutIds?: string[]
}

export type AttentionPosition = {
  id: string
  instrumentId?: string
  /** Счёт (банк/брокер): один инструмент может лежать в двух местах — это разные деньги. */
  accountId?: string
  name: string
  institution: string
  isCash: boolean
  maturityDate?: string
  termEndDate?: string
  closedOn?: string
  priceUnavailable: boolean
  forecastNote?: string
  source: string
}

export type AttentionPayout = {
  id: string
  instrumentId?: string
  accountId?: string
  title: string
  date: string
  type: 'COUPON' | 'DIVIDEND' | 'INTEREST' | 'DEPOSIT_PRINCIPAL' | 'REDEMPTION' | 'OTHER'
  amount: number
  currency: string
  status: 'expected' | 'received'
  institution?: string
}

export type AttentionBroker = { name: string; status: string; lastSyncAt?: string }

export type AttentionRules = {
  /** Выплата «скоро» — в пределах стольких дней вперёд. */
  payoutSoonDays: number
  /** Окончание вклада / погашение «скоро». */
  maturitySoonDays: number
  /** Сколько дней после прихода выплаты напоминать её реинвестировать. */
  reinvestReminderDays: number
}

export const DEFAULT_ATTENTION_RULES: AttentionRules = {
  payoutSoonDays: 14,
  maturitySoonDays: 30,
  reinvestReminderDays: 7,
}

const PRINCIPAL_TYPES = new Set(['DEPOSIT_PRINCIPAL', 'REDEMPTION'])

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000)
}

function formatMoney(value: number, currency = 'RUB'): string {
  const sign = currency === 'RUB' ? '₽' : currency
  return `${Math.round(value).toLocaleString('ru-RU')} ${sign}`
}

function inDays(days: number): string {
  if (days === 0) return 'сегодня'
  if (days === 1) return 'завтра'
  const mod100 = days % 100
  const mod10 = days % 10
  const word = mod100 >= 11 && mod100 <= 14 ? 'дней' : mod10 === 1 ? 'день' : mod10 >= 2 && mod10 <= 4 ? 'дня' : 'дней'
  return `через ${days} ${word}`
}

// Инструмент на конкретном счёте: выплаты одного ОФЗ в двух банках не сливаются, иначе
// «Реинвестировать» подставит общую сумму в чужой банк.
function holdingKey(instrumentId: string | undefined, accountId: string | undefined): string {
  return `${instrumentId ?? ''}@${accountId ?? ''}`
}

// Несколько строк выплаты на одну дату по одному инструменту (купон + погашение, проценты +
// тело вклада) — одно событие для клиента: показываем суммой, как строка инструмента.
type PayoutGroup = { key: string; payouts: AttentionPayout[]; date: string; amount: number; principal: boolean }
function groupPayouts(payouts: AttentionPayout[]): PayoutGroup[] {
  const groups = new Map<string, PayoutGroup>()
  for (const payout of payouts) {
    const key = `${payout.instrumentId ? holdingKey(payout.instrumentId, payout.accountId) : payout.id}:${payout.date}:${payout.currency}`
    const group = groups.get(key)
    if (group) {
      group.payouts.push(payout)
      group.amount += payout.amount
      group.principal ||= PRINCIPAL_TYPES.has(payout.type)
    } else {
      groups.set(key, { key, payouts: [payout], date: payout.date, amount: payout.amount, principal: PRINCIPAL_TYPES.has(payout.type) })
    }
  }
  return [...groups.values()]
}

type PositionLookup = (payout: AttentionPayout) => AttentionPosition | undefined
function payoutSubject(group: PayoutGroup, positionOf: PositionLookup): { name: string; position?: AttentionPosition } {
  const first = group.payouts[0]
  const position = positionOf(first)
  return { name: position?.name ?? first.title ?? 'Выплата', position }
}

export function buildAttention(
  input: {
    today: string
    positions: AttentionPosition[]
    payouts: AttentionPayout[]
    brokers: AttentionBroker[]
    recommendations: Recommendation[]
  },
  rules: AttentionRules = DEFAULT_ATTENTION_RULES,
): AttentionItem[] {
  const { today } = input
  const items: AttentionItem[] = []
  const positionsByHolding = new Map<string, AttentionPosition>()
  const positionsByInstrument = new Map<string, AttentionPosition>()
  for (const position of input.positions) {
    if (!position.instrumentId) continue
    positionsByHolding.set(holdingKey(position.instrumentId, position.accountId), position)
    if (!positionsByInstrument.has(position.instrumentId)) positionsByInstrument.set(position.instrumentId, position)
  }
  const positionOf: PositionLookup = (payout) => payout.instrumentId
    ? positionsByHolding.get(holdingKey(payout.instrumentId, payout.accountId)) ?? positionsByInstrument.get(payout.instrumentId)
    : undefined
  const soonEnd = addDays(today, rules.payoutSoonDays)
  const reinvestStart = addDays(today, -rules.reinvestReminderDays)

  // Просроченные: дата прошла, а выплата не отмечена — самое срочное, иначе итоги врут.
  // Вклад, заведённый задним числом, приносит пачку прошедших выплат — по одному
  // инструменту это одно дело «отметить полученными», а не десяток строк.
  const overdueByInstrument = new Map<string, AttentionPayout[]>()
  for (const payout of input.payouts) {
    if (payout.status !== 'expected' || payout.date >= today) continue
    const key = `${payout.instrumentId ? holdingKey(payout.instrumentId, payout.accountId) : payout.id}:${payout.currency}`
    overdueByInstrument.set(key, [...(overdueByInstrument.get(key) ?? []), payout])
  }
  for (const [key, payouts] of overdueByInstrument) {
    payouts.sort((left, right) => left.date.localeCompare(right.date))
    const amount = payouts.reduce((sum, payout) => sum + payout.amount, 0)
    const first = payouts[0]
    const position = positionOf(first)
    const dates = new Set(payouts.map((payout) => payout.date))
    items.push({
      id: `overdue:${key}`,
      kind: 'payout_overdue',
      // Непришедший возврат тела или погашение — срочно: крупная сумма, и итог без отметки
      // её не видит. Неотмеченный купон — важно, но не выше скорого погашения (критик К8).
      severity: payouts.some((payout) => PRINCIPAL_TYPES.has(payout.type)) ? 1 : 2,
      title: position?.name ?? (first.title || 'Выплата'),
      text: dates.size > 1
        ? `${dates.size} ${paymentsWord(dates.size)} на ${formatMoney(amount, first.currency)} не отмечены полученными — отметьте, если деньги пришли`
        : `Выплата ${formatMoney(amount, first.currency)} ожидалась ${inDaysAgo(daysBetween(first.date, today))} — отметьте, если деньги пришли`,
      action: 'mark_received',
      date: first.date,
      amount,
      currency: first.currency,
      institution: first.institution ?? position?.institution,
      positionId: position?.id,
      payoutIds: payouts.map((payout) => payout.id),
    })
  }

  // Пришедшие недавно: деньги лежат свободными — пора решить, куда их вложить.
  for (const group of groupPayouts(input.payouts.filter((payout) => payout.status === 'received' && payout.date >= reinvestStart && payout.date <= today))) {
    const { name, position } = payoutSubject(group, positionOf)
    items.push({
      id: `received:${group.key}`,
      kind: 'payout_received',
      severity: group.principal ? 1 : 2,
      title: name,
      text: group.principal
        ? `Вернулось ${formatMoney(group.amount, group.payouts[0].currency)} — решите, куда их вложить`
        : `Пришло ${formatMoney(group.amount, group.payouts[0].currency)} — можно реинвестировать`,
      action: 'reinvest',
      date: group.date,
      amount: group.amount,
      currency: group.payouts[0].currency,
      institution: group.payouts[0].institution ?? position?.institution,
      positionId: position?.id,
      payoutIds: group.payouts.map((payout) => payout.id),
    })
  }

  // Скорые выплаты. Возврат тела вклада и погашение важнее купона: это крупная сумма,
  // для которой нужно заранее выбрать, куда её вложить.
  const principalSoon = new Set<string>()
  for (const group of groupPayouts(input.payouts.filter((payout) => payout.status === 'expected' && payout.date >= today && payout.date <= soonEnd))) {
    const { name, position } = payoutSubject(group, positionOf)
    if (group.principal && group.payouts[0].instrumentId) principalSoon.add(holdingKey(group.payouts[0].instrumentId, group.payouts[0].accountId))
    const days = daysBetween(today, group.date)
    items.push({
      id: `soon:${group.key}`,
      kind: 'payout_soon',
      severity: group.principal ? 2 : 3,
      title: name,
      text: group.principal
        ? `${inDays(days)[0].toUpperCase()}${inDays(days).slice(1)} вернётся ${formatMoney(group.amount, group.payouts[0].currency)} — подумайте, куда их вложить`
        : `${inDays(days)[0].toUpperCase()}${inDays(days).slice(1)} выплата ${formatMoney(group.amount, group.payouts[0].currency)}`,
      action: position ? 'open_position' : 'open_payments',
      date: group.date,
      amount: group.amount,
      currency: group.payouts[0].currency,
      institution: group.payouts[0].institution ?? position?.institution,
      positionId: position?.id,
      payoutIds: group.payouts.map((payout) => payout.id),
    })
  }

  const maturityEnd = addDays(today, rules.maturitySoonDays)
  for (const position of input.positions) {
    if (position.isCash) continue
    // Закрытая позиция уже вернула деньги — о её окончании напоминать нечего.
    if (!position.closedOn) {
      const end = position.termEndDate ?? position.maturityDate
      const alreadyAsPayout = position.instrumentId && principalSoon.has(holdingKey(position.instrumentId, position.accountId))
      if (end && end >= today && end <= maturityEnd && !alreadyAsPayout) {
        const isDeposit = Boolean(position.termEndDate)
        items.push({
          id: `maturity:${position.id}`,
          kind: 'maturity_soon',
          severity: 2,
          title: position.name,
          text: `${isDeposit ? 'Вклад заканчивается' : 'Погашение'} ${inDays(daysBetween(today, end))} — решите, куда вложить деньги`,
          action: 'open_position',
          date: end,
          institution: position.institution,
          positionId: position.id,
        })
      }
      if (position.priceUnavailable) {
        items.push({
          id: `price:${position.id}`,
          kind: 'price_unavailable',
          severity: 3,
          title: position.name,
          text: 'Актуальная цена недоступна — стоимость не входит в итог портфеля',
          action: 'refresh_prices',
          institution: position.institution,
          positionId: position.id,
        })
      }
      if (position.forecastNote) {
        items.push({
          id: `forecast:${position.id}`,
          kind: 'forecast_missing',
          severity: 3,
          title: position.name,
          text: `${position.forecastNote} — выплаты по нему не прогнозируются`,
          action: position.source === 'broker' ? 'open_position' : 'edit_position',
          institution: position.institution,
          positionId: position.id,
        })
      }
    }
  }

  for (const broker of input.brokers) {
    if (broker.status !== 'error') continue
    items.push({
      id: `broker:${broker.name}`,
      kind: 'broker_error',
      severity: 2,
      title: broker.name,
      text: 'Не удалось обновить данные брокера — показаны последние сохранённые',
      action: 'open_integrations',
      date: broker.lastSyncAt?.slice(0, 10),
      institution: broker.name,
    })
  }

  // Правила §24, кроме погашения: оно уже покрыто сигналом выше для любой позиции, а не
  // только для крупной.
  input.recommendations.forEach((recommendation, index) => {
    if (recommendation.ruleType === 'maturity') return
    const positionId = typeof recommendation.payload.id === 'string' ? recommendation.payload.id : undefined
    const position = positionId ? input.positions.find((item) => item.id === positionId) : undefined
    items.push({
      id: `insight:${recommendation.ruleType}:${index}`,
      kind: 'insight',
      severity: 3,
      title: position?.name ?? insightTitles[recommendation.ruleType],
      text: recommendation.text,
      action: position ? 'open_position' : recommendation.ruleType === 'payout_gap' ? 'open_payments' : 'open_analytics',
      institution: position?.institution,
      positionId: position?.id,
    })
  })

  // Сначала срочное; внутри одной срочности — по ближайшей дате, без даты — в конце.
  return items.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity - right.severity
    if (left.date && right.date) return left.date.localeCompare(right.date)
    if (left.date) return -1
    if (right.date) return 1
    return 0
  })
}

const insightTitles: Record<string, string> = {
  concentration: 'Концентрация',
  drawdown: 'Просадка',
  payout_gap: 'Разрыв в выплатах',
  rebalance: 'Целевая структура',
}

function inDaysAgo(days: number): string {
  if (days === 1) return 'вчера'
  const mod100 = days % 100
  const mod10 = days % 10
  const word = mod100 >= 11 && mod100 <= 14 ? 'дней' : mod10 === 1 ? 'день' : mod10 >= 2 && mod10 <= 4 ? 'дня' : 'дней'
  return `${days} ${word} назад`
}

function paymentsWord(count: number): string {
  const mod100 = count % 100
  const mod10 = count % 10
  if (mod100 >= 11 && mod100 <= 14) return 'выплат'
  if (mod10 === 1) return 'выплата'
  if (mod10 >= 2 && mod10 <= 4) return 'выплаты'
  return 'выплат'
}

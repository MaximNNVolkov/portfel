// Оценка НДФЛ за год и выгрузка доходов для 3-НДФЛ. Чистый модуль, как portfolio-engine.ts:
// на вход операции года и перевод в рубли, на выход строки оценки. Без БД и Express.
//
// Это оценка, а не расчёт налогового агента: курс валют — текущий ЦБ (исторические курсы —
// v2, §13), убытки прошлых лет, ИИС, льгота долгосрочного владения и зачёт иностранного
// налога не учитываются. Экран говорит об этом прямо.
import type { Transaction } from './repository.ts'

export type TaxLineKey = 'deposit_interest' | 'coupons' | 'dividends' | 'sales'
export type TaxLine = {
  key: TaxLineKey
  label: string
  /** Доход до вычетов, ₽. У продаж — прибыль минус убытки года (не меньше нуля). */
  income: number
  /** Необлагаемая часть, ₽ (у вкладов — 1 млн ₽ × максимальная ключевая ставка года). */
  exempt: number
  taxBase: number
  /** Как платится налог по этой строке. */
  how: string
}
export type TaxEstimate = {
  year: number
  lines: TaxLine[]
  /** Налоговая база по всем инвестиционным доходам вместе, ₽. */
  taxBase: number
  /** Оценка налога за год по прогрессивной шкале, ₽. */
  tax: number
  /** Налог, уже удержанный по операциям (поле «налог» и операции TAX), ₽. */
  withheld: number
  /** Оценка к доплате, ₽: налог минус удержанное, не меньше нуля. */
  toPay: number
  /** Максимальная ключевая ставка года, которой считан необлагаемый процент по вкладам. */
  keyRate: number
  /** true — ставки года нет в таблице, взята последняя известная. */
  keyRateAssumed: boolean
  /** Валюты операций без курса ЦБ: их суммы в оценку не вошли. */
  unconverted: string[]
  /** Продажи без себестоимости (например, из синхронизации брокера): в оценку не вошли. */
  salesWithoutCost: number
}
export type TaxIncomeRow = {
  date: string
  kind: string
  instrument: string
  amount: number
  currency: string
  amountRub: number | null
  withheld: number
  source: string
}

// Максимальная ключевая ставка ЦБ на 1-е число месяцев года, % (ст. 214.2 НК РФ).
// За 2021–2022 годы проценты по вкладам не облагаются вовсе (ФЗ № 67-ФЗ от 26.03.2022),
// поэтому для них лимит не нужен. 2026 — ставка на 1 января; до конца года это нижняя
// оценка лимита, и экран помечает её допущением (критик К34).
const MAX_KEY_RATE: Record<number, number> = { 2023: 15, 2024: 21, 2025: 21, 2026: 16 }
const LAST_KNOWN_YEAR = Math.max(...Object.keys(MAX_KEY_RATE).map(Number))
const DEPOSIT_INTEREST_EXEMPT_YEARS = new Set([2021, 2022])

// Шкала для инвестиционных доходов: с 2025 года 13% до 2,4 млн ₽ и 15% сверху, до 2025 —
// 13% до 5 млн ₽.
function progressiveTax(base: number, year: number): number {
  const threshold = year >= 2025 ? 2_400_000 : 5_000_000
  if (base <= threshold) return base * 0.13
  return threshold * 0.13 + (base - threshold) * 0.15
}

const KIND_LABELS: Partial<Record<Transaction['type'], string>> = {
  INTEREST: 'Проценты', COUPON: 'Купон', DIVIDEND: 'Дивиденды', SELL: 'Продажа', TAX: 'Налог',
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function estimateTax(
  transactions: Transaction[],
  year: number,
  toRub: (amount: number, currency: string) => number | null,
  /** Себестоимость погашенной облигации: погашение выше цены покупки — доход (критик К33). */
  redemptionCost: (transaction: Transaction) => number | undefined = () => undefined,
  today = new Date().toISOString().slice(0, 10),
): TaxEstimate {
  const inYear = transactions.filter((item) => item.date.startsWith(`${year}-`))
  const unconverted = new Set<string>()
  const rub = (amount: number, currency: string) => {
    const value = toRub(amount, currency)
    if (value === null) unconverted.add(currency)
    return value ?? 0
  }

  let depositInterest = 0
  let coupons = 0
  let dividends = 0
  let salesResult = 0
  let salesWithoutCost = 0
  let withheld = 0
  for (const item of inYear) {
    withheld += rub(item.tax || 0, item.currency)
    if (item.type === 'TAX') withheld += rub(item.amount, item.currency)
    // Проценты на брокерском счёте облагаются как проценты по вкладам только в банке;
    // у брокера это доход с удержанием агентом — он ближе к купонам.
    if (item.type === 'INTEREST') {
      if (item.source === 'broker') coupons += rub(item.amount, item.currency)
      // Проценты по валютным вкладам за 2023–2024 годы освобождены (ФЗ № 323-ФЗ, критик К37).
      else if (item.currency !== 'RUB' && (year === 2023 || year === 2024)) continue
      else depositInterest += rub(item.amount, item.currency)
    }
    if (item.type === 'REDEMPTION') {
      const cost = redemptionCost(item)
      if (cost !== undefined) salesResult += rub(item.amount - cost, item.currency)
    }
    if (item.type === 'SELL' && item.costBasis === undefined) salesWithoutCost += 1
    if (item.type === 'COUPON') coupons += rub(item.amount, item.currency)
    if (item.type === 'DIVIDEND') dividends += rub(item.amount, item.currency)
    // Прибыль продажи — выручка минус себестоимость проданного и комиссия. Продажа без
    // себестоимости (старые записи, брокерские без неё) в оценку не входит: иначе вся
    // выручка стала бы «прибылью».
    if (item.type === 'SELL' && item.costBasis !== undefined) {
      salesResult += rub(item.amount - item.costBasis - (item.commission || 0), item.currency)
    }
  }

  const exemptYear = DEPOSIT_INTEREST_EXEMPT_YEARS.has(year)
  // Год ещё не закончился — максимальная ставка за год ещё может вырасти.
  const keyRateAssumed = !exemptYear && (MAX_KEY_RATE[year] === undefined || `${year}-12-01` > today)
  const keyRate = exemptYear ? 0 : MAX_KEY_RATE[year] ?? MAX_KEY_RATE[LAST_KNOWN_YEAR]
  const depositExempt = exemptYear ? depositInterest : Math.min(depositInterest, 1_000_000 * (keyRate / 100))
  // Купоны и результат операций с бумагами — одна налоговая база (п. 7 ст. 214.1 НК РФ):
  // убыток от продаж уменьшает купоны того же года, но не ниже нуля (критик К32).
  // Дивиденды — отдельная база, убыток их не уменьшает.
  const salesBase = Math.max(salesResult, -coupons)
  const draft: TaxLine[] = [
    {
      key: 'deposit_interest', label: 'Проценты по вкладам', income: depositInterest, exempt: depositExempt,
      taxBase: depositInterest - depositExempt,
      how: exemptYear
        ? 'Проценты за 2021–2022 годы налогом не облагаются'
        : 'Банк сообщает в ФНС сам, налог приходит уведомлением до 1 декабря следующего года — декларация не нужна',
    },
    {
      key: 'coupons', label: 'Купоны и проценты у брокера', income: coupons, exempt: 0, taxBase: coupons,
      how: 'Российский брокер удерживает налог сам; в 3-НДФЛ — только выплаты без удержания',
    },
    {
      key: 'dividends', label: 'Дивиденды', income: dividends, exempt: 0, taxBase: dividends,
      how: 'По российским акциям налог удерживает брокер; иностранные дивиденды декларируются в 3-НДФЛ',
    },
    {
      key: 'sales', label: 'Продажи и погашения бумаг', income: salesResult, exempt: 0, taxBase: salesBase,
      how: salesResult < 0
        ? 'Убыток уменьшает купоны того же года (одна база по бумагам); перенос на следующие годы — через 3-НДФЛ'
        : 'Брокер удерживает при выводе денег или в конце года; убыток уменьшает прибыль того же года',
    },
  ]
  const lines = draft.map((line) => ({ ...line, income: round2(line.income), exempt: round2(line.exempt), taxBase: round2(line.taxBase) }))

  const taxBase = round2(lines.reduce((sum, line) => sum + line.taxBase, 0))
  const tax = Math.round(progressiveTax(taxBase, year))
  return {
    year,
    lines,
    taxBase,
    tax,
    withheld: Math.round(withheld),
    toPay: Math.max(0, tax - Math.round(withheld)),
    keyRate,
    keyRateAssumed,
    unconverted: [...unconverted].sort(),
    salesWithoutCost,
  }
}

// Доходы года построчно — то, что переносится в 3-НДФЛ (лист доходов) или сверяется
// со справкой брокера.
export function taxIncomeRows(
  transactions: Transaction[],
  year: number,
  toRub: (amount: number, currency: string) => number | null,
  nameOf: (transaction: Transaction) => string,
): TaxIncomeRow[] {
  return transactions
    .filter((item) => item.date.startsWith(`${year}-`) && KIND_LABELS[item.type])
    .map((item) => {
      // Продажа без себестоимости выгружается выручкой, а не «результатом» на всю сумму
      // (критик К35); уплаченный налог — в колонку налога, а не дохода (К36).
      const withCost = item.type === 'SELL' && item.costBasis !== undefined
      const amount = item.type === 'TAX' ? 0 : withCost ? item.amount - item.costBasis! - (item.commission || 0) : item.amount
      const kind = item.type === 'SELL'
        ? (withCost ? 'Результат продажи' : 'Выручка от продажи (себестоимость не указана)')
        : item.type === 'TAX' ? 'Налог уплачен/удержан' : KIND_LABELS[item.type]!
      return {
        date: item.date,
        kind,
        instrument: nameOf(item),
        amount: round2(amount),
        currency: item.currency,
        amountRub: (() => { const value = toRub(amount, item.currency); return value === null ? null : round2(value) })(),
        withheld: round2((item.tax || 0) + (item.type === 'TAX' ? item.amount : 0)),
        source: item.source === 'broker' ? 'Брокер' : item.source === 'ocr' ? 'Скриншот' : 'Вручную',
      }
    })
}

// CSV для Excel: точка с запятой и BOM, иначе русская Excel открывает кракозябры в одну колонку.
export function taxRowsToCsv(rows: TaxIncomeRow[]): string {
  const cell = (value: string | number | null) => {
    if (value === null) return ''
    const text = typeof value === 'number' ? String(value).replace('.', ',') : value
    return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = ['Дата', 'Вид дохода', 'Инструмент', 'Сумма', 'Валюта', 'Сумма в рублях', 'Налог удержан', 'Источник']
  const lines = rows.map((row) => [row.date, row.kind, row.instrument, row.amount, row.currency, row.amountRub, row.withheld, row.source].map(cell).join(';'))
  return `﻿${[header.join(';'), ...lines].join('\r\n')}\r\n`
}

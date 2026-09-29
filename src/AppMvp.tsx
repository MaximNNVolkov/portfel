import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import "./App.css";
import "./client-flow.css";

type AssetType =
  "Облигации" | "Акции" | "Вклады" | "Фонды" | "Деньги" | "Прочее";
type Product = {
  id: string;
  name: string;
  type: AssetType;
  amount: number;
  invested: number;
  ticker: string;
  date: string;
  institution: string;
  currency: string;
  source: string;
  isin?: string;
  quantity?: number;
  averagePrice?: number;
  currentPrice?: number;
  priceUpdatedAt?: string;
  nominal?: number;
  accruedInterest?: number;
  couponRate?: number;
  couponDate?: string;
  maturityDate?: string;
  ofertaDate?: string;
  amortization?: boolean;
  rate?: number;
  effectiveRate?: number;
  capitalization?: boolean;
  termEndDate?: string;
  interestPayoutFrequency?: string;
  replenishable?: boolean;
  partialWithdrawal?: boolean;
  autoProlongation?: boolean;
  accountId?: string;
  instrumentId?: string;
  // Оценка Portfolio Engine (§10) в базовой валюте — приходит с каждой позицией
  // из /api/positions. amount — введённая сумма (её правит форма), а не оценка.
  valuation?: ProductValuation;
  // Почему прогноз купонов не построен (BUG-20) — текст приходит с бэкенда.
  forecastNote?: string;
  // Тело вклада вернулось / бумага погашена: позиция закрыта и в стоимость не входит.
  closedOn?: string;
};
type ProductValuation = {
  value: number | null;
  invested: number | null;
  pnl: number | null;
  pnlPercent: number | null;
  priceUnavailable: boolean;
  priceUnavailableReason: string | null;
  /** Котируемый инструмент без котировки: стоимость — введённая сумма, P&L нет (§7.3, BUG-09). */
  estimated?: boolean;
};
type ProductDetails = {
  isin: string;
  ticker: string;
  quantity: string;
  averagePrice: string;
  currentPrice: string;
  nominal: string;
  accruedInterest: string;
  couponRate: string;
  couponDate: string;
  maturityDate: string;
  ofertaDate: string;
  amortization: boolean;
  rate: string;
  effectiveRate: string;
  capitalization: boolean;
  termEndDate: string;
  interestPayoutFrequency: string;
  replenishable: boolean;
  partialWithdrawal: boolean;
  autoProlongation: boolean;
};
const emptyProductDetails: ProductDetails = {
  isin: "",
  ticker: "",
  quantity: "",
  averagePrice: "",
  currentPrice: "",
  nominal: "",
  accruedInterest: "",
  couponRate: "",
  couponDate: "",
  maturityDate: "",
  ofertaDate: "",
  amortization: false,
  rate: "",
  effectiveRate: "",
  capitalization: false,
  termEndDate: "",
  interestPayoutFrequency: "",
  replenishable: false,
  partialWithdrawal: false,
  autoProlongation: false,
};
function productToDetails(product?: Product): ProductDetails {
  return {
    isin: product?.isin || "",
    ticker: product?.ticker || "",
    quantity: product?.quantity !== undefined ? String(product.quantity) : "",
    averagePrice: product?.averagePrice !== undefined ? String(product.averagePrice) : "",
    currentPrice: product?.currentPrice !== undefined ? String(product.currentPrice) : "",
    nominal: product?.nominal !== undefined ? String(product.nominal) : "",
    accruedInterest: product?.accruedInterest !== undefined ? String(product.accruedInterest) : "",
    couponRate: product?.couponRate !== undefined ? String(product.couponRate) : "",
    couponDate: product?.couponDate || "",
    maturityDate: product?.maturityDate || "",
    ofertaDate: product?.ofertaDate || "",
    amortization: product?.amortization || false,
    rate: product?.rate !== undefined ? String(product.rate) : "",
    effectiveRate: product?.effectiveRate !== undefined ? String(product.effectiveRate) : "",
    capitalization: product?.capitalization || false,
    termEndDate: product?.termEndDate || "",
    interestPayoutFrequency: product?.interestPayoutFrequency || "",
    replenishable: product?.replenishable || false,
    partialWithdrawal: product?.partialWithdrawal || false,
    autoProlongation: product?.autoProlongation || false,
  };
}
// BUG-08 (§17): «вложено» должно сходиться с количеством × средней ценой. Это проверка
// ввода, а не расчёт портфеля — сервер делает ту же проверку (reconcileInvested) и
// отклоняет расхождение; здесь она нужна, чтобы показать его до сохранения.
function investedCheck(details: ProductDetails, investedInput: string) {
  const quantity = Number(details.quantity);
  const averagePrice = Number(details.averagePrice);
  if (!details.quantity.trim() || !details.averagePrice.trim()) return null;
  if (!(quantity > 0 && averagePrice > 0)) return null;
  const expected = Math.round(quantity * averagePrice * 100) / 100;
  const typed = investedInput.trim() ? Number(investedInput) : null;
  const mismatch =
    typed !== null && Math.abs(typed - expected) > Math.max(1, expected * 0.001);
  return { quantity, averagePrice, expected, typed, mismatch };
}
function InvestedCheckNote({
  check,
  amount,
}: {
  check: ReturnType<typeof investedCheck>;
  amount: string;
}) {
  if (!check) return null;
  if (check.mismatch) {
    return (
      <small className="form-error">
        ⚠ Вложено {money(check.typed ?? 0)} не совпадает с количеством × средней ценой:{" "}
        {check.quantity} × {money(check.averagePrice)} = {money(check.expected)}. Исправьте
        одно из значений.
      </small>
    );
  }
  const amountValue = Number(amount);
  const amountDiffers =
    check.typed === null &&
    amountValue > 0 &&
    Math.abs(amountValue - check.expected) > Math.max(1, check.expected * 0.001);
  return (
    <small className={amountDiffers ? "danger-text" : "muted"}>
      Вложено: {check.quantity} × {money(check.averagePrice)} = {money(check.expected)}
      {amountDiffers
        ? ` — отличается от введённой суммы ${money(amountValue)}. Вложенной суммой будет сохранено ${money(check.expected)}, текущей стоимостью — ${money(amountValue)}.`
        : ""}
    </small>
  );
}
function detailsToPayload(details: ProductDetails) {
  return {
    isin: details.isin.trim() || undefined,
    ticker: details.ticker.trim(),
    quantity: details.quantity.trim() ? Number(details.quantity) : undefined,
    averagePrice: details.averagePrice.trim() ? Number(details.averagePrice) : undefined,
    currentPrice: details.currentPrice.trim() ? Number(details.currentPrice) : undefined,
    nominal: details.nominal.trim() ? Number(details.nominal) : undefined,
    accruedInterest: details.accruedInterest.trim() ? Number(details.accruedInterest) : undefined,
    couponRate: details.couponRate.trim() ? Number(details.couponRate) : undefined,
    couponDate: details.couponDate || undefined,
    maturityDate: details.maturityDate || undefined,
    ofertaDate: details.ofertaDate || undefined,
    amortization: details.amortization || undefined,
    rate: details.rate.trim() ? Number(details.rate) : undefined,
    effectiveRate: details.effectiveRate.trim() ? Number(details.effectiveRate) : undefined,
    capitalization: details.capitalization || undefined,
    termEndDate: details.termEndDate || undefined,
    interestPayoutFrequency: details.interestPayoutFrequency || undefined,
    replenishable: details.replenishable || undefined,
    partialWithdrawal: details.partialWithdrawal || undefined,
    autoProlongation: details.autoProlongation || undefined,
  };
}
type PayoutType =
  | "COUPON"
  | "DIVIDEND"
  | "INTEREST"
  | "DEPOSIT_PRINCIPAL"
  | "REDEMPTION"
  | "OTHER";
type PayoutStatus = "expected" | "received";
type PayoutSource = "manual" | "forecast" | "broker";
type Payment = {
  id: string;
  title: string;
  amount: number;
  date: string;
  type: PayoutType;
  status: PayoutStatus;
  currency: string;
  /** 'forecast' — строка рассчитана системой из параметров инструмента (§15) и пересчитывается автоматически. */
  source?: PayoutSource;
  instrumentId?: string;
  accountId?: string;
  transactionId?: string;
  /** Только в запросе: позиция, к инструменту которой привязать выплату; "" — отвязать (BUG-23). */
  positionId?: string;
  /** Ожидалась, но дата уже прошла (BUG-22) — считается на бэкенде по его часам. */
  overdue?: boolean;
  /** Банк или брокер счёта — приходит с бэкенда, только для показа. */
  institution?: string;
  /** Сумма в базовой валюте портфеля по курсу ЦБ (§13); null — курса нет. */
  amountBase?: number | null;
};
type TransactionType =
  | "BUY"
  | "SELL"
  | "DEPOSIT"
  | "WITHDRAW"
  | "COUPON"
  | "DIVIDEND"
  | "INTEREST"
  | "FEE"
  | "TAX"
  | "REDEMPTION"
  | "OTHER";
type Transaction = {
  id: string;
  title: string;
  amount: number;
  date: string;
  type: TransactionType;
  positionId?: string;
  accountId?: string;
  instrumentId?: string;
  currency?: string;
  commission?: number;
  tax?: number;
  source?: string;
  /** Количество бумаг в покупке/продаже; без него сервер выводит его из цены. */
  quantity?: number | null;
  price?: number | null;
  /** Банк или брокер счёта — приходит с бэкенда, только для показа. */
  institution?: string;
};
type Snapshot = { date: string; value: number; invested: number | null };
type OcrFailure = { filename: string; reason: string };
// possibleDuplicate — транзиентный флаг только этого ответа (§18, вариант А: запись всё
// равно сохраняется, пользователь сам решает на экране-сводке), не персистится как поле Product.
type OcrItem = Product & { possibleDuplicate?: boolean };
type OcrUploadResult = {
  // Документ очереди OCR — по нему сводка открывается по прямой ссылке (BUG-18).
  documentId?: string;
  date: string;
  items: OcrItem[];
  failures: OcrFailure[];
  // Тот же файл уже загружался (BUG-15): показывается сводка прошлой обработки.
  alreadyUploadedAt?: string;
};
// Зеркалит GroupAggregate/PortfolioAggregate из server/portfolio-engine.ts — расчёт
// (§10) целиком на бэкенде, фронт только отображает уже готовый результат.
type GroupSummary = {
  group: string;
  invested: number;
  value: number;
  pnl: number;
  pnlPercent: number | null;
  share: number | null;
  positions: number;
  priceUnavailable: number;
};
type PortfolioSummary = {
  total: number;
  invested: number;
  profit: number;
  profitPercent: number | null;
  expected: number;
  // Ожидались, но дата прошла — в «Ожидается» не входят (BUG-22).
  overdue: number;
  paid: number;
  // Свободные деньги (§7.1, §12) — сальдо денежных операций, посчитанное на бэкенде.
  // null — остаток есть, но оценить его в базовой валюте нельзя (нет курса, §7.3).
  cash: number | null;
  groups: GroupSummary[];
  valuation: {
    incomplete: boolean;
    unavailable: { id: string; name: string; group: string; reason: string }[];
    /** Позиции с приблизительной оценкой: в стоимости есть, в P&L нет (BUG-09). */
    estimated?: { id: string; name: string; group: string }[];
    /** Валюты выплат/расходов без курса ЦБ — их суммы не вошли в итоги (§7.3, §13). */
    unconvertedCurrencies?: string[];
  };
};
type BrokerStatus = {
  status: string;
  lastSyncAt?: string;
  lastError?: string;
};
// Офлайн-фолбэк (нет сети/бэкенда недоступен) — единственное место, где допустимо
// пересчитывать эти показатели на фронте, поскольку Portfolio Engine недоступен вовсе.
function localSummary(products: Product[], payments: Payment[]): PortfolioSummary {
  const total = products.reduce((sum, product) => sum + product.amount, 0);
  const invested = products.reduce((sum, product) => sum + product.invested, 0);
  const profit = total - invested;
  const groupTotals = products.reduce<Record<string, number>>((result, product) => {
    result[product.type] = (result[product.type] || 0) + product.amount;
    return result;
  }, {});
  return {
    total,
    invested,
    profit,
    profitPercent: invested > 0 ? (profit / invested) * 100 : null,
    expected: payments
      .filter(isUpcoming)
      .reduce((sum, payment) => sum + payment.amount, 0),
    overdue: payments
      .filter(isOverdue)
      .reduce((sum, payment) => sum + payment.amount, 0),
    paid: payments
      .filter((item) => item.status === "received")
      .reduce((sum, item) => sum + item.amount, 0),
    cash: products
      .filter((product) => product.type === "Деньги")
      .reduce((sum, product) => sum + product.amount, 0),
    groups: Object.entries(groupTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([group, value]) => ({
        group,
        invested: 0,
        value,
        pnl: 0,
        pnlPercent: null,
        share: total > 0 ? (value / total) * 100 : null,
        positions: products.filter((product) => product.type === group).length,
        priceUnavailable: 0,
      })),
    valuation: { incomplete: false, unavailable: [] },
  };
}

// Итог «Обновить цены» по каждой бумаге (BUG-19): без причины «0 из 1» ничего не объясняет.
type PriceRefreshItem = {
  positionId: string;
  name: string;
  code: string;
  status: "updated" | "not_found" | "no_price" | "unavailable" | "no_quantity";
  priceUpdatedAt?: string;
};
type PriceRefreshResult = { checked: number; updated: number; items: PriceRefreshItem[] };
const priceRefreshReasons: Record<Exclude<PriceRefreshItem["status"], "updated">, string> = {
  not_found: "Мосбиржа не знает такого тикера, проверьте тикер или ISIN",
  no_price: "на Мосбирже нет цены: по бумаге не было сделок",
  unavailable: "Мосбиржа не ответила, попробуйте позже",
  no_quantity: "не указано количество бумаг, цену не на что умножить",
};

const storageKey = "capital-mvp-state";
const apiUrl = "/api";
// BUG-11: при обрыве связи fetch бросает TypeError с текстом браузера («Failed to fetch»,
// «Load failed» в Safari) — в русском интерфейсе его показывать нельзя.
class NetworkError extends Error {}
const networkErrorText = "Нет связи с сервером. Проверьте подключение и попробуйте ещё раз";
// Сессия живёт в httpOnly-cookie (§28): браузер прикладывает её сам, а скрипт страницы
// токена не видит. Authorization, который по старинке собирают вызовы ниже, здесь
// выкидывается; X-Requested-With — обязательный для сервера признак «запрос из нашего
// приложения» (защита от CSRF).
async function apiFetch(input: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.delete("Authorization");
  headers.set("X-Requested-With", "portfel");
  try {
    return await fetch(input, { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new NetworkError(networkErrorText);
  }
}
// Текст ошибки для пользователя. Свои ошибки фронт бросает по-русски; всё остальное
// (сбой разбора JSON, внутренние исключения браузера) заменяется на понятный fallback.
function errorText(error: unknown, fallback: string) {
  if (error instanceof Error && /[а-яё]/i.test(error.message)) return error.message;
  return fallback;
}
// Опрос статуса OCR (§34): интервал заметно больше такта воркера (OCR_POLL_SECONDS),
// чтобы страница не долбила API, но результат появлялся почти сразу после обработки.
const OCR_POLL_INTERVAL_MS = 1500;
const OCR_WAIT_LIMIT_MS = 3 * 60 * 1000;
const tokenKey = "capital-api-token";
// В localStorage хранится только признак «вход выполнен», а не сам токен. Всё остальное
// под этим ключом — токен из версии до cookie-сессий: его стираем, пользователь входит заново.
const SESSION_MARKER = "cookie-session";
const themeKey = "capital-theme-preference";
type ThemePreference = "light" | "dark" | "system";
const initialProducts: Product[] = [
  {
    id: "ofz",
    name: "ОФЗ 26241",
    type: "Облигации",
    amount: 540200,
    invested: 502000,
    ticker: "SU26241RMFS8",
    date: "2026-02-12",
    institution: "Т-Инвестиции",
    currency: "RUB",
    source: "manual",
  },
  {
    id: "sber",
    name: "Сбербанк",
    type: "Акции",
    amount: 342380,
    invested: 303500,
    ticker: "SBER",
    date: "2026-03-18",
    institution: "Т-Инвестиции",
    currency: "RUB",
    source: "manual",
  },
  {
    id: "deposit",
    name: "Надёжный доход",
    type: "Вклады",
    amount: 420000,
    invested: 400000,
    ticker: "",
    date: "2026-01-05",
    institution: "Т-Банк",
    currency: "RUB",
    source: "manual",
  },
  {
    id: "fund",
    name: "Фонд ликвидности",
    type: "Фонды",
    amount: 111740,
    invested: 107240,
    ticker: "LQDT",
    date: "2026-04-21",
    institution: "Т-Инвестиции",
    currency: "RUB",
    source: "manual",
  },
  {
    id: "cash",
    name: "Свободные деньги",
    type: "Деньги",
    amount: 136100,
    invested: 136100,
    ticker: "",
    date: "2026-09-06",
    institution: "Т-Инвестиции",
    currency: "RUB",
    source: "manual",
  },
];
const initialPayments: Payment[] = [
  {
    id: "p1",
    title: "Купон ОФЗ 26241",
    amount: 12480,
    date: "2026-09-20",
    type: "COUPON",
    status: "expected",
    currency: "RUB",
  },
  {
    id: "p2",
    title: "Дивиденд Сбера",
    amount: 8920,
    date: "2026-09-27",
    type: "DIVIDEND",
    status: "expected",
    currency: "RUB",
  },
  {
    id: "p3",
    title: "Проценты по вкладу",
    amount: 17100,
    date: "2026-10-10",
    type: "INTEREST",
    status: "expected",
    currency: "RUB",
  },
];
const initialTransactions: Transaction[] = [
  {
    id: "t1",
    title: "Покупка ОФЗ 26241",
    amount: 502000,
    date: "2026-02-12",
    type: "BUY",
    positionId: "ofz",
  },
  {
    id: "t2",
    title: "Пополнение брокерского счёта",
    amount: 250000,
    date: "2026-03-18",
    type: "DEPOSIT",
  },
  {
    id: "t3",
    title: "Купон ОФЗ 26241",
    amount: 12480,
    date: "2026-08-20",
    type: "COUPON",
  },
];

const navItems = [
  ["Портфель", "◈", "/portfolio", false],
  ["Инструменты", "▦", "/products", false],
  ["Операции", "↕", "/transactions", false],
  ["Выплаты", "◷", "/payments", false],
  ["Аналитика", "⌁", "/analytics", false],
  ["Рекомендации", "✦", "/recommendations", false],
  ["Отчёты", "▤", "/reports", true],
  ["Интеграции", "⇄", "/integrations", false],
  ["Импорт", "⇩", "/import", true],
] as const;
const typeColors: Record<AssetType, string> = {
  Облигации: "teal",
  Акции: "coral",
  Вклады: "amber",
  Фонды: "indigo",
  Деньги: "slate",
  Прочее: "pink",
};
// Те же цвета, что и .legend.* в App.css — держим строки в одном месте, чтобы сектор
// диаграммы всегда совпадал по цвету с квадратом легенды (§7.2).
const legendHexColors: Record<AssetType, string> = {
  Облигации: "#65c4b1",
  Акции: "#e7a05b",
  Вклады: "#ebc677",
  Фонды: "#7787ba",
  Деньги: "#93a1a6",
  Прочее: "#d98bbd",
};
// Строит conic-gradient из реальных долей групп (число секторов = числу групп, цвет —
// как в легенде). Остаток до 100% (доли не покрывают весь портфель из-за недоступных
// цен, §7.3) закрашивается нейтральным серым, а не растягивает реальные доли на весь круг.
function donutGradient(groups: GroupSummary[]): string {
  let cursor = 0;
  const stops: string[] = [];
  for (const groupSummary of groups) {
    const share = Math.max(0, groupSummary.share ?? 0);
    if (share <= 0) continue;
    const start = cursor;
    const end = Math.min(100, cursor + share);
    const color = legendHexColors[groupSummary.group as AssetType] ?? "#93a1a6";
    stops.push(`${color} ${start}% ${end}%`);
    cursor = end;
  }
  if (cursor < 100) {
    stops.push(`#e8edeb ${cursor}% 100%`);
  }
  return stops.length > 0 ? `conic-gradient(${stops.join(", ")})` : "conic-gradient(#e8edeb 0 100%)";
}
const payoutTypeLabels: Record<PayoutType, string> = {
  COUPON: "Купон",
  DIVIDEND: "Дивиденды",
  INTEREST: "Проценты",
  DEPOSIT_PRINCIPAL: "Возврат вклада",
  REDEMPTION: "Погашение",
  OTHER: "Прочее",
};
// Цвет точки выплаты — из палитры .legend.*: купон и погашение — цвета облигаций,
// дивиденды — акций, проценты — вкладов, чтобы строка читалась так же, как в «Инструментах».
const payoutTypeColors: Record<PayoutType, string> = {
  COUPON: "teal",
  REDEMPTION: "indigo",
  DIVIDEND: "coral",
  INTEREST: "amber",
  DEPOSIT_PRINCIPAL: "slate",
  OTHER: "pink",
};
const payoutStatusLabels: Record<PayoutStatus, string> = {
  expected: "Ожидается",
  received: "Получено",
};
const transactionTypeLabels: Record<TransactionType, string> = {
  BUY: "Покупка",
  SELL: "Продажа",
  DEPOSIT: "Пополнение",
  WITHDRAW: "Вывод средств",
  COUPON: "Купон",
  DIVIDEND: "Дивиденды",
  INTEREST: "Проценты по вкладу",
  FEE: "Комиссия",
  TAX: "Налог",
  REDEMPTION: "Погашение",
  OTHER: "Прочее",
};
// Цвет точки операции — из той же палитры .legend.*, что и typeColors: покупка/продажа,
// движение денег, выплаты и расходы различимы в списке «Операций» с первого взгляда.
const transactionTypeColors: Record<TransactionType, string> = {
  BUY: "indigo",
  SELL: "coral",
  DEPOSIT: "teal",
  WITHDRAW: "slate",
  COUPON: "amber",
  DIVIDEND: "amber",
  INTEREST: "amber",
  REDEMPTION: "amber",
  FEE: "pink",
  TAX: "pink",
  OTHER: "slate",
};
const POSITION_TRANSACTION_TYPES: TransactionType[] = ["BUY", "SELL"];
const CASH_CREDIT_TYPES: TransactionType[] = [
  "DEPOSIT",
  "COUPON",
  "DIVIDEND",
  "INTEREST",
  "REDEMPTION",
];
const CASH_DEBIT_TYPES: TransactionType[] = ["WITHDRAW", "FEE", "TAX"];
function applyLocalTransactionEffect(
  products: Product[],
  transaction: Transaction,
  direction: 1 | -1,
): Product[] {
  const amount = transaction.amount * direction;
  let next = products;
  const shift = (id: string | undefined, delta: number) => {
    if (!id) return;
    next = next.map((product) =>
      product.id === id
        ? {
            ...product,
            amount: product.amount + delta,
            invested: Math.max(0, product.invested + delta),
          }
        : product,
    );
  };
  const cashId = next.find((product) => product.type === "Деньги")?.id;
  if (transaction.type === "BUY") shift(transaction.positionId, amount);
  if (transaction.type === "SELL") shift(transaction.positionId, -amount);
  if (CASH_CREDIT_TYPES.includes(transaction.type)) shift(cashId, amount);
  if (CASH_DEBIT_TYPES.includes(transaction.type)) shift(cashId, -amount);
  return next;
}
const money = (value: number) =>
  `₽ ${Math.round(value).toLocaleString("ru-RU")}`;
// Единая точка разбора даты (баг со скриншота владельца, iPhone/Safari, 390px): пустая
// или невалидная строка — законный случай (необязательное поле, повреждённые данные
// со скриншота), а не повод показывать "Invalid Date"/ронять страницу на
// Intl.DateTimeFormat. Все форматтеры дат идут через эту функцию.
function parseIsoDate(date: string | undefined | null): Date | null {
  if (!date) return null;
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
// Короткие даты. Год добавляется, когда дата не в текущем году (BUG-07): иначе
// полугодовые купоны на годы вперёд читались как одна выплата, повторённая 12 раз.
// Фиксированный трёхбуквенный список, а не Intl.DateTimeFormat: ICU-сокращения
// для русского в разных браузерах/ОС не одной длины («окт» — 3 буквы, «нояб» — 4),
// из-за чего «1 окт»/«1 нояб» выглядели непарно — фиксированный список даёт
// единообразный формат везде, независимо от движка.
const RU_SHORT_MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const shortMonth = (date: string) => {
  const parsed = parseIsoDate(date);
  return parsed ? RU_SHORT_MONTHS[parsed.getMonth()] : "";
};
const isCurrentYear = (date: string) => date.slice(0, 4) === todayIsoDate().slice(0, 4);
const dateLabel = (date: string) => {
  const parsed = parseIsoDate(date);
  if (!parsed) return "—";
  // Без ведущего нуля («1 окт», не «01 окт») — единый короткий формат дат в карточке
  // продукта и в остальных местах, где нужна не полная дата, а «день месяц[, год]».
  return `${parsed.getDate()} ${shortMonth(date)}${isCurrentYear(date) ? "" : ` ${date.slice(0, 4)}`}`;
};
// Сегодня по местному времени (toISOString дал бы дату по UTC — ночью это «вчера»).
function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
// Просроченная выплата (§22, BUG-22). Флаг приходит с бэкенда; вычисление по дате —
// только для офлайн-режима, где бэкенда нет.
const isOverdue = (payment: Payment) =>
  payment.overdue ??
  (payment.status === "expected" && payment.date < todayIsoDate());
// Группы с биржевой котировкой (зеркалит QUOTED_GROUPS движка). У вклада и «Прочего»
// рыночной цены не бывает вовсе — строка «Актуальная цена недоступна» там только путает.
const quotedTypes = new Set<AssetType>(["Облигации", "Акции", "Фонды"]);
// Возврат тела вклада и погашение номинала — возврат вложенного, не доход (§10.3).
const isPrincipalPayout = (payment: Payment) =>
  payment.type === "DEPOSIT_PRINCIPAL" || payment.type === "REDEMPTION";
const isUpcoming = (payment: Payment) =>
  payment.status === "expected" && !isOverdue(payment);
// Выплаты бывают в разных валютах: складываются только суммы в базовой валюте, которые
// посчитал бэкенд (amountBase). Без неё (офлайн) рублёвая сумма берётся как есть.
const payoutBase = (payment: Payment): number | null =>
  payment.amountBase !== undefined
    ? payment.amountBase
    : (payment.currency || "RUB") === "RUB" ? payment.amount : null;
function sumPayoutsBase(list: Payment[]) {
  let total = 0;
  let partial = false;
  for (const payment of list) {
    const value = payoutBase(payment);
    if (value === null) partial = true;
    else total += value;
  }
  return { total, partial };
}
// Сумма одной выплаты — в её собственной валюте.
const payoutMoney = (payment: Payment) =>
  payment.currency && payment.currency !== "RUB"
    ? `${payment.amount.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${payment.currency}`
    : money(payment.amount);
// Главная цифра группы в календаре выплат (BUG-21): раздел — «Календарь ожидаемых
// доходов», поэтому крупно идёт ожидаемое; полученное — подписью и только если оно есть.
// Иначе у нового пользователя весь календарь состоял из строк «+₽ 0».
function pluralPayouts(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "выплата";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "выплаты";
  return "выплат";
}
function payoutGroupValue(expected: number, received: number, overdue: number) {
  if (expected > 0)
    return {
      amount: `+${money(expected)}`,
      note: received > 0 ? `ожидается · получено ${money(received)}` : "ожидается",
    };
  if (received > 0)
    return {
      amount: `+${money(received)}`,
      note: overdue > 0 ? `получено · не отмечено ${money(overdue)}` : "получено",
    };
  return { amount: money(overdue), note: "не отмечено полученным" };
}
const fullDate = (date: string) => {
  const parsed = parseIsoDate(date);
  return parsed ? parsed.toLocaleDateString("ru-RU") : "—";
};
// Как fullDate, но для полных ISO-таймстемпов с сервера (синхронизация брокера,
// дата обновления цены, повторная загрузка скриншота), а не даты без времени — та же
// защита от "Invalid Date"/падения на некорректном или отсутствующем значении.
function formatDateTime(value: string | undefined | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("ru-RU");
}
// Показ готового P&L из Portfolio Engine (§10): фронт ничего не вычитает сам.
// null — результат неизвестен (нет цены или курса), выводится «—», а не «+0,0%» (§7.3).
function pnlDisplay(pnl: number | null, pnlPercent: number | null) {
  if (pnl === null) {
    return { className: "muted", amountText: "—", percentText: "—" };
  }
  const positive = pnl >= 0;
  const sign = positive ? "+" : "";
  return {
    className: positive ? "teal-text" : "danger-text",
    amountText: `${sign}${money(pnl)}`,
    percentText:
      pnlPercent === null
        ? "—"
        : `${sign}${pnlPercent.toFixed(1).replace(".", ",")}%`,
  };
}
// Оценка позиции для экранов. При живом API — valuation из ответа бэкенда. Без неё
// (офлайн-режим, см. localSummary) — единственный случай, когда сохранённая сумма
// показывается как есть, потому что Portfolio Engine недоступен вовсе.
function valuationOf(product: Product): ProductValuation {
  if (product.valuation) return product.valuation;
  const pnl = product.amount - product.invested;
  return {
    value: product.amount,
    invested: product.invested,
    pnl,
    pnlPercent: product.invested > 0 ? (pnl / product.invested) * 100 : null,
    priceUnavailable: false,
    priceUnavailableReason: null,
  };
}
// Стоимость без оценки не выводится нулём (§7.3).
const valueText = (value: number | null) =>
  value === null ? "Оценка недоступна" : money(value);
// Пометка к стоимости без котировки (§7.3, BUG-09): сумма совпадает с вложенным — значит,
// это цена покупки, а не рынок; иначе — введённая оценка (например, со скриншота).
const estimateNote = (valuation: ProductValuation) =>
  !valuation.estimated
    ? null
    : valuation.value !== null && valuation.value === valuation.invested
      ? "по цене покупки"
      : "оценка приблизительна";
const sourceLabels: Record<string, string> = {
  manual: "Ручной ввод",
  ocr: "Со скриншота",
  broker: "Т-Инвестиции",
};
function usePagedList<T>(items: T[], initial = 20) {
  const [visibleCount, setVisibleCount] = useState(initial);
  return {
    visible: items.slice(0, visibleCount),
    hasMore: items.length > visibleCount,
    loadMore: () => setVisibleCount((count) => count + 20),
    pageSize: visibleCount,
    setPageSize: setVisibleCount,
  };
}
function ListPagination({
  hasMore,
  onLoadMore,
  pageSize,
  onPageSizeChange,
}: {
  hasMore: boolean;
  onLoadMore: () => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
}) {
  const bucket = pageSize <= 20 ? 20 : pageSize <= 50 ? 50 : 100;
  // Короткий список целиком на экране — переключатель под ним только шумит.
  if (!hasMore && bucket === 20) return null;
  return (
    <div className="list-pagination">
      {hasMore ? (
        <button className="outline-button" type="button" onClick={onLoadMore}>
          Загрузить ещё
        </button>
      ) : (
        <span />
      )}
      <label className="page-size-select">
        <span>Показывать по</span>
        <select
          value={bucket}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </label>
    </div>
  );
}
// «Требует внимания» (CLIENT_FLOW_PLAN §4.4) — лента собирается на бэкенде
// (server/attention.ts, GET /api/attention); фронт только показывает и ведёт к действию.
type AttentionItem = {
  id: string;
  kind: string;
  severity: 1 | 2 | 3;
  title: string;
  text: string;
  action:
    | "mark_received"
    | "reinvest"
    | "open_position"
    | "edit_position"
    | "refresh_prices"
    | "open_integrations"
    | "open_payments"
    | "open_analytics";
  date?: string;
  amount?: number;
  currency?: string;
  institution?: string;
  positionId?: string;
  payoutIds?: string[];
};
const attentionSeverityLabels: Record<AttentionItem["severity"], string> = {
  1: "Срочно",
  2: "Важно",
  3: "К сведению",
};
const attentionSeverityColors: Record<AttentionItem["severity"], string> = {
  1: "coral",
  2: "amber",
  3: "slate",
};
// Реинвестирование на MVP — переход к добавлению продукта с подставленной суммой и
// банком, без отдельной сущности «деньги к вложению» (CLIENT_FLOW_PLAN §6, вопрос 1).
function reinvestLink(amount: number | undefined, institution: string | undefined, from: string, currency?: string) {
  const params = new URLSearchParams();
  if (amount) params.set("amount", String(Math.round(amount * 100) / 100));
  // Сумма передаётся в валюте выплаты: купон в USD не должен лечь в форму как рубли.
  if (currency && currency !== "RUB") params.set("currency", currency);
  if (institution && institution !== "Ручной ввод") params.set("institution", institution);
  params.set("reinvest", from);
  return `/products/new?${params.toString()}`;
}
function attentionLink(item: AttentionItem): { to: string; label: string } | null {
  switch (item.action) {
    case "reinvest":
      return { to: reinvestLink(item.amount, item.institution, item.title, item.currency), label: "Реинвестировать" };
    case "open_position":
      return item.positionId ? { to: `/products/${item.positionId}`, label: "Открыть" } : null;
    case "edit_position":
      return item.positionId ? { to: `/products/${item.positionId}/edit`, label: "Заполнить" } : null;
    case "refresh_prices":
      return { to: "/products", label: "Обновить цены" };
    case "open_integrations":
      return { to: "/integrations", label: "Повторить" };
    case "open_payments":
      return { to: "/payments", label: "Выплаты" };
    case "open_analytics":
      return { to: "/analytics", label: "Аналитика" };
    default:
      return null;
  }
}
function AttentionList({
  items,
  payments,
  onMarkReceived,
}: {
  items: AttentionItem[];
  payments: Payment[];
  onMarkReceived: (payment: Payment) => Promise<void>;
}) {
  const [markingId, setMarkingId] = useState<string | null>(null);
  async function markReceived(item: AttentionItem) {
    setMarkingId(item.id);
    try {
      for (const id of item.payoutIds ?? []) {
        const payment = payments.find((entry) => entry.id === id);
        if (payment) await onMarkReceived(payment);
      }
    } finally {
      setMarkingId(null);
    }
  }
  return (
    <div className="product-list attention-list">
      {items.map((item) => {
        const link = attentionLink(item);
        const meta = [item.institution, item.date ? dateLabel(item.date) : null].filter(Boolean).join(" · ");
        return (
          <div className="list-row attention-row" key={item.id}>
            <div className="product-row-summary product-row-static">
              <span className="product-row-line1">
                <span className="product-row-name">
                  <i
                    className={`legend type-dot ${attentionSeverityColors[item.severity]}`}
                    title={attentionSeverityLabels[item.severity]}
                  />
                  <strong>{item.title}</strong>
                </span>
                {meta && <span className="muted attention-meta">{meta}</span>}
              </span>
              <span className="attention-text">{item.text}</span>
            </div>
            <div className="attention-actions">
              {item.action === "mark_received" ? (
                <button
                  type="button"
                  className="outline-button"
                  disabled={markingId !== null}
                  onClick={() => void markReceived(item)}
                >
                  {markingId === item.id ? "Сохраняем..." : "Отметить полученной"}
                </button>
              ) : (
                link && (
                  <Link className="outline-button" to={link.to}>
                    {link.label}
                  </Link>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
// Разрез «Где хранится» (CLIENT_FLOW_PLAN §4.1) — byProvider из /api/portfolio/structure.
function StorageList({ items, display }: { items: StructureBreakdown[]; display: (value: number) => string }) {
  return (
    <div className="product-list">
      {items.map((item) => {
        const pnl = pnlDisplay(item.pnl, item.pnlPercent);
        return (
          <div className="list-row" key={item.key}>
            <Link className="product-row-summary" to={`/products?bank=${encodeURIComponent(item.key)}`}>
              <span className="product-row-line1">
                <span className="product-row-name">
                  <strong>{item.key}</strong>
                </span>
                <span className="product-row-sum">{display(item.value)}</span>
              </span>
              <span className="product-row-line2 product-row-line2-flush">
                <span className="muted product-row-meta">
                  {item.positions} {pluralInstruments(item.positions)} · {Math.round(item.share ?? 0)}% портфеля
                  {item.priceUnavailable > 0 && <span className="danger-text"> · без цены: {item.priceUnavailable}</span>}
                </span>
                <span className={pnl.className}>{pnl.percentText}</span>
              </span>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
// «для 1 инструмента», «для 3 инструментов» — родительный падеж после предлога.
function instrumentsGenitive(count: number) {
  return count % 10 === 1 && count % 100 !== 11 ? "инструмента" : "инструментов";
}
function pluralInstruments(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "инструмент";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "инструмента";
  return "инструментов";
}
type PaymentViewMode = "day" | "month" | "year";
function periodKey(date: string, mode: PaymentViewMode): string {
  return mode === "year" ? date.slice(0, 4) : date.slice(0, 7);
}
function periodLabel(key: string, mode: PaymentViewMode): string {
  if (mode === "year") return key;
  const [year, month] = key.split("-").map(Number);
  const formatted = new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, 1));
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}
function chartPath(history: Snapshot[], close = false) {
  if (!history.length) return "";
  const max = Math.max(...history.map((point) => point.value), 1);
  const min = Math.min(...history.map((point) => point.value), 0);
  const range = Math.max(max - min, 1);
  const coordinates = history.map(
    (point, index) =>
      `${(index / Math.max(history.length - 1, 1)) * 700} ${135 - ((point.value - min) / range) * 120}`,
  );
  const line = `M${coordinates.join(" L")}`;
  return close ? `${line} L700 150 L0 150Z` : line;
}

function AppMvp() {
  const navigate = useNavigate();
  const location = useLocation();
  // Выдвижное меню на мобильном (§40.1, BUG-25): тот же сайдбар, что и на десктопе,
  // показывается поверх страницы по кнопке-гамбургеру.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [payments, setPayments] = useState<Payment[]>(initialPayments);
  const [transactions, setTransactions] =
    useState<Transaction[]>(initialTransactions);
  const [toast, setToast] = useState("");
  const [priceRefresh, setPriceRefresh] = useState<PriceRefreshResult | null>(null);
  const [hideAmounts, setHideAmounts] = useState(false);
  const [token, setToken] = useState(() => {
    const saved = localStorage.getItem(tokenKey);
    if (saved && saved !== SESSION_MARKER) localStorage.removeItem(tokenKey);
    return saved === SESSION_MARKER ? SESSION_MARKER : "";
  });
  const [apiOnline, setApiOnline] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [brokerStatus, setBrokerStatus] = useState<BrokerStatus | null>(null);
  // Лента «Требует внимания» и разрез «Где хранится» считаются на бэкенде; null — ещё не
  // загружены или нет связи (тогда блоки на главной не показываются, а не врут пустотой).
  const [loadedAttention, setAttention] = useState<AttentionItem[] | null>(null);
  const [loadedStorage, setStorage] = useState<StructureBreakdown[] | null>(null);
  const attention = apiOnline ? loadedAttention : null;
  const storage = apiOnline ? loadedStorage : null;
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [ocrSummary, setOcrSummary] = useState<OcrUploadResult | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>(
    () => (localStorage.getItem(themeKey) as ThemePreference | null) || "system",
  );

  useEffect(() => {
    localStorage.setItem(themeKey, themePreference);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
      const resolved =
        themePreference === "system"
          ? media.matches
            ? "dark"
            : "light"
          : themePreference;
      document.documentElement.dataset.theme = resolved;
    }
    applyTheme();
    if (themePreference !== "system") return;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themePreference]);

  function expireSession() {
    localStorage.removeItem(tokenKey);
    setToken("");
    setApiOnline(false);
    setOcrSummary(null);
    setUserEmail(null);
    setBrokerStatus(null);
    setToast("Сессия закончилась. Войдите снова.");
  }

  useEffect(() => {
    async function loadPortfolio() {
      try {
        if (!token) return;
        const headers = { Authorization: `Bearer ${token}` };
        const [
          productsResponse,
          paymentsResponse,
          transactionsResponse,
          historyResponse,
          summaryResponse,
          meResponse,
          brokerResponse,
        ] = await Promise.all([
          apiFetch(`${apiUrl}/positions`, { headers }),
          apiFetch(`${apiUrl}/payouts`, { headers }),
          apiFetch(`${apiUrl}/transactions`, { headers }),
          apiFetch(`${apiUrl}/portfolio/history`, { headers }),
          apiFetch(`${apiUrl}/portfolio/summary`, { headers }),
          apiFetch(`${apiUrl}/auth/me`, { headers }),
          apiFetch(`${apiUrl}/brokers/tinkoff`, { headers }),
        ]);
        if (
          productsResponse.status === 401 ||
          paymentsResponse.status === 401 ||
          transactionsResponse.status === 401 ||
          historyResponse.status === 401 ||
          summaryResponse.status === 401 ||
          meResponse.status === 401 ||
          brokerResponse.status === 401
        ) {
          expireSession();
          return;
        }
        if (
          !productsResponse.ok ||
          !paymentsResponse.ok ||
          !transactionsResponse.ok ||
          !historyResponse.ok ||
          !summaryResponse.ok ||
          !meResponse.ok ||
          !brokerResponse.ok
        )
          throw new Error("API unavailable");
        setProducts((await productsResponse.json()) as Product[]);
        setPayments((await paymentsResponse.json()) as Payment[]);
        setTransactions((await transactionsResponse.json()) as Transaction[]);
        setHistory((await historyResponse.json()) as Snapshot[]);
        setSummary((await summaryResponse.json()) as PortfolioSummary);
        setUserEmail((await meResponse.json()).email as string | null);
        setBrokerStatus((await brokerResponse.json()) as BrokerStatus);
        setApiOnline(true);
        setDataLoaded(true);
      } catch {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const state = JSON.parse(saved) as {
            products: Product[];
            payments: Payment[];
            transactions: Transaction[];
          };
          setProducts(state.products);
          setPayments(state.payments);
          setTransactions(state.transactions);
        }
        // Офлайн-фолбэк тоже окончательный ответ: дальше данных не прибавится.
        setDataLoaded(true);
      }
    }
    void loadPortfolio();
  }, [token]);
  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ products, payments, transactions }),
    );
  }, [products, payments, transactions]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);
  // Любая правка позиций, выплат или статуса брокера меняет ленту внимания и разрез по
  // банкам — перезапрашиваем их вслед за основными данными.
  useEffect(() => {
    if (!apiOnline || !token) return;
    let cancelled = false;
    const headers = { Authorization: `Bearer ${token}` };
    void Promise.all([
      apiFetch(`${apiUrl}/attention`, { headers }),
      apiFetch(`${apiUrl}/portfolio/structure`, { headers }),
    ])
      .then(async ([attentionResponse, structureResponse]) => {
        if (cancelled) return;
        setAttention(attentionResponse.ok ? ((await attentionResponse.json()) as AttentionItem[]) : null);
        setStorage(structureResponse.ok ? ((await structureResponse.json()) as PortfolioStructure).byProvider ?? null : null);
      })
      .catch(() => {
        if (cancelled) return;
        setAttention(null);
        setStorage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apiOnline, token, products, payments, brokerStatus]);
  // Офлайн-режим не имеет доступа к Portfolio Engine на бэкенде — единственный случай,
  // когда сводные показатели допустимо пересчитывать на фронте (см. localSummary выше).
  useEffect(() => {
    if (apiOnline) return;
    setSummary(localSummary(products, payments));
  }, [apiOnline, products, payments]);

  const authHeaders = {
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  // Страницы вызывают эти действия без своего try/catch: без обёртки сетевая ошибка
  // уходит в unhandled rejection, и пользователь не видит вообще ничего (BUG-11).
  function withErrorToast<A extends unknown[]>(
    action: (...args: A) => Promise<void>,
    fallback: string,
  ) {
    return async (...args: A) => {
      try {
        await action(...args);
      } catch (error) {
        setToast(errorText(error, fallback));
      }
    };
  }
  async function refreshSummary() {
    const response = await apiFetch(`${apiUrl}/portfolio/summary`, {
      headers: authHeaders,
    });
    if (response.ok) setSummary((await response.json()) as PortfolioSummary);
  }
  async function refreshBrokerStatus() {
    const response = await apiFetch(`${apiUrl}/brokers/tinkoff`, {
      headers: authHeaders,
    });
    if (response.ok) setBrokerStatus((await response.json()) as BrokerStatus);
  }
  // Синхронизация брокера меняет состав портфеля целиком: без перезагрузки
  // всех наборов «Портфель» оставался пустым до F5, хотя Аналитика (своя загрузка) уже
  // показывала импортированные позиции.
  async function refreshAfterBrokerSync() {
    const [transactionsResponse, historyResponse] = await Promise.all([
      apiFetch(`${apiUrl}/transactions`, { headers: authHeaders }),
      apiFetch(`${apiUrl}/portfolio/history`, { headers: authHeaders }),
      refreshProducts(),
      refreshSummary(),
      refreshPayments(),
      refreshBrokerStatus(),
    ]);
    if (transactionsResponse.ok) setTransactions((await transactionsResponse.json()) as Transaction[]);
    if (historyResponse.ok) setHistory((await historyResponse.json()) as Snapshot[]);
  }
  async function addProduct(product: Product) {
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/positions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(product),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(result.error || "Не удалось сохранить продукт");
      }
      product = (await response.json()) as Product;
      await refreshSummary();
    }
    setProducts((current) => [...current, product]);
    setToast("Продукт добавлен в портфель");
  }
  async function addPayment(payment: Payment) {
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/payouts`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(payment),
      });
      if (!response.ok) throw new Error("Не удалось сохранить выплату");
      payment = (await response.json()) as Payment;
      await refreshSummary();
    }
    setPayments((current) => [...current, payment]);
    setToast("Выплата добавлена в календарь");
    navigate("/payments");
  }
  async function updatePayment(payment: Payment) {
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/payouts/${payment.id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify(payment),
      });
      if (!response.ok) throw new Error("Не удалось сохранить изменения");
      payment = (await response.json()) as Payment;
      await refreshSummary();
    }
    setPayments((current) =>
      current.map((item) => (item.id === payment.id ? payment : item)),
    );
    setToast("Изменения сохранены");
    navigate(-1);
  }
  // Отметка просроченной выплаты полученной прямо из календаря (BUG-22) — без перехода
  // на страницу правки: это смена статуса, а не редактирование содержимого.
  async function markPaymentReceived(payment: Payment) {
    let updated: Payment = { ...payment, status: "received", overdue: false };
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/payouts/${payment.id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ status: "received" }),
      });
      if (!response.ok) {
        setToast("Не удалось отметить выплату полученной");
        return;
      }
      updated = (await response.json()) as Payment;
      await refreshSummary();
      // Вернувшееся тело закрывает позицию — её стоимость и P&L пересчитаны на бэкенде.
      if (isPrincipalPayout(payment)) await refreshProducts();
    }
    setPayments((current) =>
      current.map((item) => (item.id === payment.id ? updated : item)),
    );
    setToast("Выплата отмечена полученной");
  }
  async function removePayment(id: string) {
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/payouts/${id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!response.ok) throw new Error("Не удалось удалить выплату");
      await refreshSummary();
    }
    setPayments((current) => current.filter((payment) => payment.id !== id));
    setToast("Выплата удалена");
    navigate("/payments");
  }
  // Прогнозные выплаты пересчитываются на бэкенде при любом изменении состава портфеля —
  // после удаления позиции календарь нужно забрать заново.
  async function refreshPayments() {
    const response = await apiFetch(`${apiUrl}/payouts`, { headers: authHeaders });
    if (response.ok) setPayments((await response.json()) as Payment[]);
  }
  async function refreshProducts() {
    const response = await apiFetch(`${apiUrl}/positions`, {
      headers: authHeaders,
    });
    if (response.ok) setProducts((await response.json()) as Product[]);
  }
  async function refreshMarketPrices() {
    const response = await apiFetch(`${apiUrl}/market-data/refresh`, {
      method: "POST",
      headers: authHeaders,
    });
    if (!response.ok) {
      setToast("Не удалось обновить цены");
      return;
    }
    const result = (await response.json()) as PriceRefreshResult;
    setPriceRefresh(result);
    await refreshProducts();
    await refreshSummary();
    setToast(
      result.checked === 0
        ? "Нет акций, фондов или облигаций с тикером для обновления цены"
        : `Обновлено цен: ${result.updated} из ${result.checked}`,
    );
  }
  async function deleteProductRecord(id: string) {
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/positions/${id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!response.ok) throw new Error("Не удалось удалить продукт");
    }
    setProducts((current) => current.filter((product) => product.id !== id));
  }
  async function removeProduct(id: string, returnTo = "/products") {
    try {
      await deleteProductRecord(id);
      if (apiOnline) {
        await refreshSummary();
        await refreshPayments();
      }
      setToast("Продукт удалён");
      navigate(returnTo);
    } catch (error) {
      setToast(errorText(error, "Не удалось удалить продукт"));
    }
  }
  // «Удалить всё распознанное» со сводки OCR (BUG-14).
  async function removeProducts(ids: string[], returnTo: string) {
    let removed = 0;
    try {
      for (const id of ids) {
        await deleteProductRecord(id);
        removed += 1;
      }
      setToast(`Удалено записей: ${removed}`);
    } catch {
      setToast(`Удалено ${removed} из ${ids.length} — остальные удалить не удалось`);
    }
    if (apiOnline) {
      await refreshSummary();
      await refreshPayments();
    }
    navigate(returnTo);
  }
  async function updateProduct(product: Product) {
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/positions/${product.id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify(product),
      });
      if (!response.ok) {
        // Страница правки остаётся открытой: пользователь видит причину и исправляет ввод.
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        setToast(result.error || "Не удалось сохранить изменения");
        return;
      }
      product = (await response.json()) as Product;
      await refreshSummary();
    }
    setProducts((current) =>
      current.map((item) => (item.id === product.id ? product : item)),
    );
    setToast("Изменения сохранены");
    navigate(-1);
  }
  function applyOcrResult(result: OcrUploadResult) {
    setOcrSummary(result);
    // Записи из результата OCR — снимок на момент распознавания, без оценки движка:
    // список позиций перечитывается с бэкенда, чтобы стоимость пришла из Portfolio Engine.
    if (result.alreadyUploadedAt) {
      // Повторная загрузка того же файла ничего не создала — записи уже в списке.
      if (apiOnline) void refreshProducts();
    } else if (apiOnline && result.items.length > 0) {
      void refreshProducts();
      void refreshSummary();
    } else {
      setProducts((current) => [...current, ...result.items]);
    }
    navigate(result.documentId ? `/ocr-summary/${result.documentId}` : "/ocr-summary");
  }
  async function addTransaction(transaction: Transaction) {
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/transactions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(transaction),
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Не удалось сохранить операцию");
      }
      transaction = (await response.json()) as Transaction;
    }
    setTransactions((current) => [...current, transaction]);
    if (apiOnline) {
      await refreshProducts();
      await refreshSummary();
    } else {
      setProducts((current) =>
        applyLocalTransactionEffect(current, transaction, 1),
      );
    }
    setToast("Операция проведена");
    navigate("/transactions");
  }
  async function updateTransaction(transaction: Transaction) {
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/transactions/${transaction.id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify(transaction),
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        throw new Error(result.error || "Не удалось сохранить изменения");
      }
      transaction = (await response.json()) as Transaction;
      await refreshProducts();
      await refreshSummary();
    }
    setTransactions((current) =>
      current.map((item) => (item.id === transaction.id ? transaction : item)),
    );
    setToast("Изменения сохранены");
    navigate(-1);
  }
  async function removeTransaction(id: string) {
    if (apiOnline) {
      const response = await apiFetch(`${apiUrl}/transactions/${id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!response.ok) throw new Error("Не удалось удалить операцию");
      await refreshProducts();
      await refreshSummary();
    }
    setTransactions((current) =>
      current.filter((transaction) => transaction.id !== id),
    );
    setToast("Операция удалена");
    navigate("/transactions");
  }
  // Возвращает ошибку для показа на самом экране входа (BUG-03): тост рендерится внутри
  // app-shell, которого до входа нет, и раньше ошибка просто терялась.
  async function signIn(
    form: FormData,
    mode: "login" | "register",
  ): Promise<LoginError | null> {
    let response: Response;
    try {
      response = await apiFetch(`${apiUrl}/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          // Код приглашения нужен только при регистрации и только если сервер его
          // требует (REGISTRATION_INVITE_CODE, §28) — при входе поле не отправляется.
          ...(mode === "register" ? { inviteCode: form.get("inviteCode") } : {}),
        }),
      });
    } catch {
      return { field: "form", message: "Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз." };
    }
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as { error?: string; field?: LoginField };
      return {
        field: result.field ?? "form",
        message:
          result.error ||
          (mode === "register" ? "Не удалось создать аккаунт" : "Не удалось войти"),
      };
    }
    localStorage.setItem(tokenKey, SESSION_MARKER);
    setToken(SESSION_MARKER);
    setToast(
      mode === "register" ? "Аккаунт создан" : "Добро пожаловать в Капитал",
    );
    return null;
  }
  async function signOut() {
    if (apiOnline) {
      await apiFetch(`${apiUrl}/auth/logout`, {
        method: "POST",
        headers: authHeaders,
      }).catch(() => undefined);
    }
    localStorage.removeItem(tokenKey);
    setToken("");
    setApiOnline(false);
    setOcrSummary(null);
    setUserEmail(null);
  }
  async function deleteAccount() {
    const response = await apiFetch(`${apiUrl}/auth/me`, {
      method: "DELETE",
      headers: authHeaders,
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setToast(result.error || "Не удалось удалить аккаунт");
      return;
    }
    localStorage.removeItem(tokenKey);
    setToken("");
    setApiOnline(false);
    setOcrSummary(null);
    setUserEmail(null);
    navigate("/portfolio");
  }

  // Ссылка из письма восстановления пароля должна работать независимо от того, есть ли
  // в этом браузере ещё активная сессия (например, письмо открыто на другом устройстве),
  // поэтому маршрут проверяется до проверки токена, а не только в неавторизованной ветке.
  // Бейдж у колокольчика — только срочное и важное: «к сведению» не должно висеть вечно.
  const urgentCount = attention?.filter((item) => item.severity <= 2).length ?? 0;
  if (location.pathname === "/reset-password") return <ResetPasswordPage />;
  if (!token) {
    if (location.pathname === "/forgot-password") return <ForgotPasswordPage />;
    return <Login onSubmit={signIn} />;
  }

  return (
    <DataLoadedContext.Provider value={dataLoaded}>
    <div className="app-shell">
      {menuOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={`sidebar ${menuOpen ? "open" : ""}`}
        id="main-navigation"
        onClick={(event) => {
          // Выбор пункта меню закрывает выдвижную панель (на десктопе ни на что не влияет).
          if ((event.target as HTMLElement).closest("a")) setMenuOpen(false);
        }}
      >
        <div className="brand">
          <span className="brand-mark">✳</span>
          <span>Капитал</span>
        </div>
        <div className="portfolio-switcher">
          <span className="switcher-label">ПОРТФЕЛЬ</span>
          <strong>Основной</strong>
          <span className="chevron">⌄</span>
        </div>
        <nav className="nav-list" aria-label="Основная навигация">
          {navItems.map(([label, icon, path, isV2]) => (
            <NavLink
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
              key={label}
              to={path}
            >
              <span className="nav-icon">{icon}</span>
              {label}
              {isV2 && <span className="v2-badge">v2</span>}
              {label === "Рекомендации" && attention?.some((item) => item.kind === "insight") && (
                <span className="notification-dot" />
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <NavLink
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
            to="/settings"
          >
            <span className="nav-icon">⚙</span>Настройки
          </NavLink>
          <div className="profile">
            <span className="avatar">М</span>
            <span>
              <strong>{userEmail?.split("@")[0] || "Пользователь"}</strong>
              <small>{userEmail || "Личный аккаунт"}</small>
            </span>
            <button className="logout-button" onClick={signOut} type="button">
              Выйти
            </button>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand">
            <span className="brand-mark">✳</span> Капитал
          </div>
          <div className="top-actions">
            <span className="sync-status">
              <span className="sync-dot" />{" "}
              {apiOnline
                ? "Синхронизировано с API"
                : "Офлайн-режим · локальные данные"}
            </span>
            <Link
              className="icon-button"
              aria-label={
                urgentCount > 0 ? `Требует внимания: ${urgentCount}` : "Требует внимания"
              }
              to="/attention"
            >
              <svg className="bell-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  d="M12 3a6 6 0 0 0-6 6v3.6l-1.6 2.9A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.5L18 12.6V9a6 6 0 0 0-6-6Zm-2.3 15.5a2.4 2.4 0 0 0 4.6 0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {urgentCount > 0 && <span className="attention-badge">{urgentCount}</span>}
            </Link>
            <button
              className="mobile-menu"
              aria-label={menuOpen ? "Закрыть меню" : "Открыть меню"}
              aria-expanded={menuOpen}
              aria-controls="main-navigation"
              onClick={() => setMenuOpen((open) => !open)}
              type="button"
            >
              {menuOpen ? "✕" : "☰"}
            </button>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<Navigate to="/portfolio" replace />} />
          <Route
            path="/portfolio"
            element={
              <Dashboard
                summary={summary}
                products={products}
                payments={payments}
                history={history}
                hideAmounts={hideAmounts}
                onHide={() => setHideAmounts(!hideAmounts)}
                apiOnline={apiOnline}
                brokerStatus={brokerStatus}
                attention={attention}
                storage={storage}
                onMarkReceived={withErrorToast(markPaymentReceived, "Не удалось отметить выплату полученной")}
              />
            }
          />
          <Route
            path="/products"
            element={<ProductsPage products={products} payments={payments} summary={summary} storage={storage} lastRefresh={priceRefresh} onRefreshPrices={withErrorToast(refreshMarketPrices, "Не удалось обновить цены")} />}
          />
          <Route
            path="/products/:id"
            element={
              <ProductDetailPage
                products={products}
                transactions={transactions}
                payments={payments}
                onMarkReceived={withErrorToast(markPaymentReceived, "Не удалось отметить выплату полученной")}
              />
            }
          />
          <Route
            path="/products/new"
            element={
              <ProductFormPage
                token={token}
                onUnauthorized={expireSession}
                onSubmit={addProduct}
                onOcrComplete={applyOcrResult}
              />
            }
          />
          <Route
            path="/products/:id/edit"
            element={<EditProductPage products={products} onSubmit={withErrorToast(updateProduct, "Не удалось сохранить изменения")} />}
          />
          <Route
            path="/products/:id/delete"
            element={
              <DeleteProductPage products={products} onConfirm={removeProduct} />
            }
          />
          <Route
            path="/transactions"
            element={
              <TransactionsPage transactions={transactions} products={products} />
            }
          />
          <Route
            path="/transactions/new"
            element={
              <TransactionFormPage products={products} onSubmit={withErrorToast(addTransaction, "Не удалось сохранить операцию")} />
            }
          />
          <Route
            path="/transactions/:id/edit"
            element={
              <EditTransactionPage
                transactions={transactions}
                products={products}
                onSubmit={withErrorToast(updateTransaction, "Не удалось сохранить изменения")}
              />
            }
          />
          <Route
            path="/transactions/:id/delete"
            element={
              <DeleteTransactionPage
                transactions={transactions}
                onConfirm={withErrorToast(removeTransaction, "Не удалось удалить операцию")}
              />
            }
          />
          <Route
            path="/payments"
            element={
              <PaymentsPage
                payments={payments}
                products={products}
                onMarkReceived={withErrorToast(markPaymentReceived, "Не удалось отметить выплату полученной")}
              />
            }
          />
          <Route
            path="/payments/new"
            element={<PaymentFormPage products={products} onSubmit={withErrorToast(addPayment, "Не удалось сохранить выплату")} />}
          />
          <Route
            path="/payments/:id/edit"
            element={
              <EditPaymentPage payments={payments} products={products} onSubmit={withErrorToast(updatePayment, "Не удалось сохранить изменения")} />
            }
          />
          <Route
            path="/payments/:id/delete"
            element={
              <DeletePaymentPage payments={payments} onConfirm={withErrorToast(removePayment, "Не удалось удалить выплату")} />
            }
          />
          <Route
            path="/analytics"
            element={
              <AnalyticsPage summary={summary} token={token} />
            }
          />
          <Route
            path="/recommendations"
            element={<Recommendations token={token} />}
          />
          <Route
            path="/attention"
            element={
              <AttentionPage
                attention={attention}
                payments={payments}
                onMarkReceived={withErrorToast(markPaymentReceived, "Не удалось отметить выплату полученной")}
              />
            }
          />
          <Route
            path="/integrations"
            element={
              <Integrations token={token} onStatusChange={withErrorToast(refreshBrokerStatus, "Не удалось обновить статус брокера")} onDataChange={withErrorToast(refreshAfterBrokerSync, "Не удалось обновить данные портфеля")} />
            }
          />
          <Route
            path="/reports"
            element={
              <ComingSoonPage
                title="Отчёты"
                text="PDF-отчёты по портфелю появятся в следующей версии приложения."
              />
            }
          />
          <Route
            path="/import"
            element={
              <ComingSoonPage
                title="Импорт"
                text="Импорт из Excel/CSV появится в следующей версии приложения. Сейчас добавить активы можно вручную, со скриншота или через Т-Инвестиции."
              />
            }
          />
          <Route
            path="/settings"
            element={
              <Settings
                token={token}
                themePreference={themePreference}
                onThemeChange={setThemePreference}
              />
            }
          />
          <Route
            path="/settings/delete-account"
            element={<DeleteAccountPage onConfirm={deleteAccount} />}
          />
          <Route
            path="/ocr-summary"
            element={<OcrSummaryPage summary={ocrSummary} products={products} token={token} />}
          />
          <Route
            path="/ocr-summary/:documentId"
            element={<OcrSummaryPage summary={ocrSummary} products={products} token={token} />}
          />
          <Route
            path="/ocr-summary/:documentId/delete-all"
            element={
              <DeleteOcrItemsPage
                summary={ocrSummary}
                products={products}
                token={token}
                onConfirm={withErrorToast(removeProducts, "Не удалось удалить записи")}
              />
            }
          />
          <Route path="*" element={<Navigate to="/portfolio" replace />} />
        </Routes>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
    </DataLoadedContext.Provider>
  );
}

// Главный экран по сценарию клиента (CLIENT_FLOW_PLAN §4.1): итог → что требует внимания →
// из каких категорий состоит портфель → где что хранится → динамика.
function Dashboard({
  summary,
  products,
  payments,
  history,
  hideAmounts,
  onHide,
  apiOnline,
  brokerStatus,
  attention,
  storage,
  onMarkReceived,
}: {
  summary: PortfolioSummary | null;
  products: Product[];
  payments: Payment[];
  history: Snapshot[];
  hideAmounts: boolean;
  onHide: () => void;
  apiOnline: boolean;
  brokerStatus: BrokerStatus | null;
  attention: AttentionItem[] | null;
  storage: StructureBreakdown[] | null;
  onMarkReceived: (payment: Payment) => Promise<void>;
}) {
  const display = (value: number) => (hideAmounts ? "••••••" : money(value));
  const linePath = chartPath(history);
  const areaPath = chartPath(history, true);
  const lastSnapshot = history.at(-1);
  // Кратковременный зазор до первого ответа /api/portfolio/summary (или офлайн-эффекта) —
  // не пересчитываем показатели порталу целиком, просто не даём странице упасть.
  const { total, invested, profit, profitPercent, paid, overdue, cash, groups, valuation } =
    summary ?? localSummary(products, payments);
  const brokerDegraded = brokerStatus?.status === "error";
  const brokerHasCache = brokerDegraded && Boolean(brokerStatus?.lastSyncAt);
  // Портфель из одних свободных денег (пополнение без покупок) не пуст (§12, BUG-05).
  if (products.length === 0 && !cash) {
    return (
      <div className="content-wrap">
        <section className="empty-portfolio">
          <p className="eyebrow">ПОРТФЕЛЬ</p>
          <h1>Ваш портфель пуст. Добавьте первый актив:</h1>
          <div className="empty-options">
            <Link className="empty-option" to="/products/new?mode=screenshot">
              <span className="empty-option-icon">📷</span>
              <div>
                <strong>Загрузить скриншот из приложения банка/брокера</strong>
                <small>Распознаем данные автоматически</small>
              </div>
            </Link>
            <Link className="empty-option" to="/integrations">
              <span className="empty-option-icon">🔗</span>
              <div>
                <strong>Подключить брокера по API</strong>
                <small>Т-Инвестиции — данные обновляются автоматически</small>
              </div>
            </Link>
            <Link className="empty-option" to="/products/new">
              <span className="empty-option-icon">✍️</span>
              <div>
                <strong>Ввести вручную</strong>
                <small>Если у вас нет скриншота под рукой</small>
              </div>
            </Link>
            <Link className="empty-option" to="/import">
              <span className="empty-option-icon">⇩</span>
              <div>
                <strong>
                  Импортировать Excel / CSV <span className="v2-badge">v2</span>
                </strong>
                <small>Пока недоступно, появится в следующей версии</small>
              </div>
            </Link>
          </div>
        </section>
      </div>
    );
  }
  const topAttention = attention?.slice(0, 4) ?? [];
  return (
    <div className="content-wrap">
      <section className="page-heading">
        <div>
          <h1>Портфель</h1>
        </div>
        <Link className="primary-button" to="/products/new">
          <span className="label-full"><span>＋</span> Добавить продукт</span>
          <span className="label-short">＋ Добавить продукт</span>
        </Link>
      </section>
      <article className="total-card portfolio-total">
        <div className="card-label">
          ОБЩАЯ СТОИМОСТЬ{" "}
          <button
            className="tiny-button"
            aria-label={hideAmounts ? "Показать суммы" : "Скрыть суммы"}
            onClick={onHide}
            type="button"
          >
            {hideAmounts ? "◎" : "◉"}
          </button>
        </div>
        <div className="total-value">
          {display(total)}
          <span className="total-currency">RUB</span>
        </div>
        <div className="profit-line">
          <span className={profit > 0 ? "positive-pill" : profit < 0 ? "negative-pill" : "neutral-pill"}>
            {profit > 0 ? "↗ +" : profit < 0 ? "↘ " : ""}
            {display(profit)}
          </span>
          <strong className={profitPercent === null ? "muted" : profit < 0 ? "danger-text" : ""}>
            {profitPercent === null
              ? "—"
              : `${profitPercent > 0 ? "+" : ""}${profitPercent.toFixed(2).replace(".", ",")}%`}
          </strong>
          <span className="muted">за всё время</span>
        </div>
        <div className="total-stats">
          <div>
            <span>Вложено</span>
            <strong>{display(invested)}</strong>
          </div>
          <div>
            <span>Получено выплат</span>
            <strong>{display(paid)}</strong>
          </div>
          <Link to="/transactions">
            <span>Свободные деньги</span>
            <strong>{cash === null ? "Оценка недоступна" : display(cash)}</strong>
          </Link>
        </div>
        {brokerHasCache && (
          <div className="demo-note">
            ⚠ Данные неполные: брокер «Т-Инвестиции» показан по состоянию на{" "}
            {formatDateTime(brokerStatus!.lastSyncAt)}.{" "}
            <Link to="/integrations">Повторить попытку</Link>
          </div>
        )}
        {brokerDegraded && !brokerHasCache && (
          <div className="demo-note">
            ⚠ Не удалось загрузить данные от брокера «Т-Инвестиции». Показана только доступная
            часть портфеля. <Link to="/integrations">Повторить подключение</Link>
          </div>
        )}
        {valuation.incomplete && (
          <div className="demo-note">
            ⚠ Актуальная цена недоступна для {valuation.unavailable.length}{" "}
            {instrumentsGenitive(valuation.unavailable.length)} — их стоимость не включена в общую сумму.
          </div>
        )}
        {(valuation.estimated?.length ?? 0) > 0 && (
          <div className="demo-note">
            ⓘ Нет котировки для {valuation.estimated!.length} {instrumentsGenitive(valuation.estimated!.length)}:
            стоимость по введённой
            сумме, оценка приблизительна.
          </div>
        )}
        {(valuation.unconvertedCurrencies?.length ?? 0) > 0 && (
          <div className="demo-note">
            ⓘ Выплаты и расходы без учёта сумм в {valuation.unconvertedCurrencies!.join(", ")}: курса ЦБ
            для них нет.
          </div>
        )}
        {!attention && overdue > 0 && (
          <div className="demo-note">
            ⚠ Не отмечено полученными {display(overdue)}. <Link to="/payments">Отметить</Link>
          </div>
        )}
      </article>
      {attention && (
        <>
          <section className="section-heading">
            <div>
              <h2>Требует внимания{attention.length > 0 ? ` · ${attention.length}` : ""}</h2>
            </div>
            {attention.length > topAttention.length && (
              <Link className="outline-button" to="/attention">
                Все <span>→</span>
              </Link>
            )}
          </section>
          {topAttention.length === 0 ? (
            <p className="muted">Всё в порядке: ни выплат к отметке, ни сроков на ближайшие недели.</p>
          ) : (
            <AttentionList items={topAttention} payments={payments} onMarkReceived={onMarkReceived} />
          )}
        </>
      )}
      <section className="section-heading">
        <div>
          <h2>Категории</h2>
        </div>
        <Link className="outline-button" to="/products">
          Все инструменты <span>→</span>
        </Link>
      </section>
      <div className="category-block">
        <div className="donut-wrap">
          <div className="donut" style={{ background: donutGradient(groups) }}>
            <div>
              <strong>{groups.length}</strong>
              <small>{groups.length === 1 ? "категория" : groups.length < 5 ? "категории" : "категорий"}</small>
            </div>
          </div>
        </div>
        <div className="product-list category-list">
          {groups.map((groupSummary) => {
            const pnl = pnlDisplay(groupSummary.pnl, groupSummary.pnlPercent);
            const isCash = groupSummary.group === "Деньги";
            return (
              <div className="list-row" key={groupSummary.group}>
                <Link
                  className="product-row-summary"
                  to={isCash ? "/transactions" : `/products?group=${encodeURIComponent(groupSummary.group)}`}
                >
                  <span className="product-row-line1">
                    <span className="product-row-name">
                      <i className={`legend type-dot ${typeColors[groupSummary.group as AssetType] ?? "slate"}`} />
                      <strong>{groupSummary.group}</strong>
                    </span>
                    <span className="product-row-sum">{display(groupSummary.value)}</span>
                  </span>
                  <span className="product-row-line2">
                    <span className="muted product-row-meta">
                      {isCash
                        ? `${Math.round(groupSummary.share ?? 0)}% портфеля`
                        : `${groupSummary.positions} ${pluralInstruments(groupSummary.positions)} · ${Math.round(groupSummary.share ?? 0)}% портфеля`}
                    </span>
                    {!isCash && <span className={pnl.className}>{pnl.percentText}</span>}
                  </span>
                </Link>
              </div>
            );
          })}
        </div>
      </div>
      {storage && storage.length > 0 && (
        <>
          <section className="section-heading">
            <div>
              <h2>Где хранится</h2>
            </div>
          </section>
          <StorageList items={storage} display={display} />
        </>
      )}
      <section className="section-heading">
        <div>
          <h2>Динамика стоимости</h2>
        </div>
      </section>
      <article className="total-card chart-card">
        <div className="chart">
          {history.length > 1 ? (
            <>
              <div className="chart-grid">
                <span />
                <span />
                <span />
                <span />
              </div>
              <svg
                viewBox="0 0 700 150"
                preserveAspectRatio="none"
                role="img"
                aria-label="Динамика стоимости портфеля"
              >
                <defs>
                  <linearGradient id="area" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#83d8ca" stopOpacity=".35" />
                    <stop offset="100%" stopColor="#83d8ca" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={areaPath} fill="url(#area)" />
                <path d={linePath} fill="none" stroke="#279b89" strokeWidth="3" />
              </svg>
            </>
          ) : (
            // Одна точка — не динамика: линия из неё рисовала ложное «падение» к правому краю.
            <div className="chart-empty">
              {lastSnapshot
                ? `Стоимость записывается раз в сутки — график появится со второго дня. Сейчас: ${money(lastSnapshot.value)}.`
                : "История появится после первого изменения портфеля"}
            </div>
          )}
        </div>
        {history.length > 1 && (
          <div className="chart-footer">
            <span>{dateLabel(history[0].date)}</span>
            <span>{lastSnapshot ? dateLabel(lastSnapshot.date) : "—"}</span>
          </div>
        )}
      </article>
      {!apiOnline && (
        <div className="demo-note">
          <span>✦</span> Нет связи с сервером — данные сохраняются только
          в этом браузере. Подключение API брокера и загрузка скриншотов
          станут доступны снова после восстановления связи.
        </div>
      )}
    </div>
  );
}

const PRODUCT_SORT_OPTIONS = {
  value: "По стоимости",
  return: "По доходности",
  pnl: "По P&L",
  maturity: "По дате погашения",
  nearestPayout: "По ближайшей выплате",
} as const;
type ProductSortKey = keyof typeof PRODUCT_SORT_OPTIONS;

function sortProducts(
  products: Product[],
  sortBy: ProductSortKey,
  nearestPayoutByInstrument: Map<string, NearestPayout>,
): Product[] {
  const withIndex = products.map((product, index) => ({ product, index }));
  // Позиции без оценки (null) уходят в конец списка, а не сортируются как нулевые (§7.3).
  const byNumber = (left: number | null, right: number | null, leftIndex: number, rightIndex: number) => {
    if (left === null && right === null) return leftIndex - rightIndex;
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  };
  withIndex.sort((a, b) => {
    const left = valuationOf(a.product);
    const right = valuationOf(b.product);
    if (sortBy === "value") return byNumber(left.value, right.value, a.index, b.index);
    if (sortBy === "return") return byNumber(left.pnlPercent, right.pnlPercent, a.index, b.index);
    if (sortBy === "pnl") return byNumber(left.pnl, right.pnl, a.index, b.index);
    if (sortBy === "nearestPayout") {
      // Без ближайшей выплаты — в конец, как и у остальных сортировок с "нет данных" (§7.3).
      const leftDate = a.product.instrumentId ? nearestPayoutByInstrument.get(a.product.instrumentId)?.date ?? null : null;
      const rightDate = b.product.instrumentId ? nearestPayoutByInstrument.get(b.product.instrumentId)?.date ?? null : null;
      if (leftDate === null && rightDate === null) return a.index - b.index;
      if (leftDate === null) return 1;
      if (rightDate === null) return -1;
      return leftDate.localeCompare(rightDate);
    }
    // maturity: с ближайшей датой погашения впереди, без даты — в конец, исходный порядок сохраняется
    if (!a.product.maturityDate && !b.product.maturityDate) return a.index - b.index;
    if (!a.product.maturityDate) return 1;
    if (!b.product.maturityDate) return -1;
    return a.product.maturityDate.localeCompare(b.product.maturityDate);
  });
  return withIndex.map((entry) => entry.product);
}
// Ближайшая будущая выплата по инструменту (тот же источник, что и календарь выплат,
// §22 — прогноз уже посчитан бэкендом в payments, см. server/payout-forecast.ts).
// На одну дату бывает несколько строк: в конце срока вклада — тело (DEPOSIT_PRINCIPAL)
// и проценты (INTEREST), у облигации — последний купон и погашение. Показываем их
// суммой, а в деталях — по частям; раньше бралась одна случайная строка из нескольких.
type NearestPayout = { date: string; total: number; parts: Payment[] };
const payoutPartOrder: PayoutType[] = ["DEPOSIT_PRINCIPAL", "REDEMPTION", "INTEREST", "COUPON", "DIVIDEND", "OTHER"];
function nearestPayoutMap(payments: Payment[]): Map<string, NearestPayout> {
  const map = new Map<string, NearestPayout>();
  for (const payment of payments) {
    if (!payment.instrumentId || payment.status !== "expected" || isOverdue(payment)) continue;
    const current = map.get(payment.instrumentId);
    if (!current || payment.date < current.date) {
      map.set(payment.instrumentId, { date: payment.date, total: payoutBase(payment) ?? 0, parts: [payment] });
    } else if (payment.date === current.date) {
      current.total += payoutBase(payment) ?? 0;
      current.parts.push(payment);
    }
  }
  for (const entry of map.values()) {
    entry.parts.sort((left, right) => payoutPartOrder.indexOf(left.type) - payoutPartOrder.indexOf(right.type));
  }
  return map;
}
// Цена с копейками — количество × цена должно давать ровно показанную сумму покупки
// (иначе на маленьких суммах видно расхождение из-за округления money() до рублей).
function preciseMoney(value: number): string {
  return `₽ ${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Ближайшее событие инструмента для строки списка: закрыт / ближайшая выплата / окончание.
function productEvent(product: Product, nextPayout: NearestPayout | undefined): React.ReactNode {
  if (product.closedOn) {
    return parseIsoDate(product.closedOn) ? `закрыт ${dateLabel(product.closedOn)}` : "закрыт";
  }
  if (nextPayout) {
    const principal = nextPayout.parts.some(isPrincipalPayout);
    const label = principal
      ? product.type === "Вклады" ? "возврат" : "погашение"
      : payoutTypeLabels[nextPayout.parts[0].type].toLowerCase();
    return (
      <>
        {label} {dateLabel(nextPayout.date)} ·{" "}
        <span className="product-row-meta-amount">{money(nextPayout.total)}</span>
      </>
    );
  }
  const end = product.termEndDate || product.maturityDate;
  if (end && parseIsoDate(end)) return `до ${dateLabel(end)}`;
  return null;
}
// Строка инструмента (CLIENT_FLOW_PLAN §4.2): тап открывает карточку — раскрытие на месте
// дублировало бы её. Снизу — где хранится и ближайшее событие.
function ProductRow({
  product,
  nextPayout,
  showInstitution,
}: {
  product: Product;
  nextPayout: NearestPayout | undefined;
  showInstitution: boolean;
}) {
  const valuation = valuationOf(product);
  const pnl = pnlDisplay(valuation.pnl, valuation.pnlPercent);
  const event = productEvent(product, nextPayout);
  const institution = showInstitution && product.institution ? product.institution : null;
  return (
    <div className="list-row">
      <Link className="product-row-summary" to={`/products/${product.id}`}>
        <span className="product-row-line1">
          <span className="product-row-name">
            <i className={`legend type-dot ${typeColors[product.type]}`} title={product.type} />
            <strong>{product.name}</strong>
          </span>
          <span className="product-row-sum">{valueText(valuation.value)}</span>
        </span>
        <span className="product-row-line2">
          <span className="muted product-row-meta">
            {institution}
            {institution && event ? " · " : ""}
            {event}
            {!institution && !event ? product.type : null}
          </span>
          {estimateNote(valuation) ? (
            <span className="muted" title={`Нет котировки: ${estimateNote(valuation)}`}>≈</span>
          ) : (
            <span className={pnl.className} title={`Доход: ${pnl.amountText}`}>{pnl.percentText}</span>
          )}
        </span>
      </Link>
    </div>
  );
}

function ProductsPage({
  products,
  payments,
  summary,
  storage,
  lastRefresh,
  onRefreshPrices,
}: {
  products: Product[];
  payments: Payment[];
  summary: PortfolioSummary | null;
  storage: StructureBreakdown[] | null;
  lastRefresh: PriceRefreshResult | null;
  onRefreshPrices: () => Promise<void>;
}) {
  const failedRefresh = lastRefresh?.items.filter((item) => item.status !== "updated") ?? [];
  const [refreshing, setRefreshing] = useState(false);
  async function handleRefreshPrices() {
    setRefreshing(true);
    try {
      await onRefreshPrices();
    } finally {
      setRefreshing(false);
    }
  }
  // Категория и банк живут в адресе: на них ведут строки главного экрана, и «назад»
  // возвращает к тому же срезу (§40.7).
  const [searchParams, setSearchParams] = useSearchParams();
  const group = (searchParams.get("group") as AssetType | null) || null;
  const bank = searchParams.get("bank") || null;
  function setFilter(key: "group" | "bank", value: string) {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  }
  const [sortBy, setSortBy] = useState<ProductSortKey>("value");
  const nearestPayoutByInstrument = useMemo(() => nearestPayoutMap(payments), [payments]);
  const productTypes = Array.from(new Set(products.map((product) => product.type)));
  const banks = Array.from(new Set(products.map((product) => product.institution).filter(Boolean))).sort();
  const filtered = products.filter(
    (product) => (!group || product.type === group) && (!bank || product.institution === bank),
  );
  // Без выбранной категории список идёт блоками по категориям в порядке их веса в портфеле.
  const groupOrder = (summary?.groups ?? []).map((item) => item.group);
  const rank = (type: string) => {
    const index = groupOrder.indexOf(type);
    return index === -1 ? groupOrder.length : index;
  };
  const sorted = sortProducts(filtered, sortBy, nearestPayoutByInstrument);
  const ordered = group ? sorted : [...sorted].sort((left, right) => rank(left.type) - rank(right.type));
  const { visible, hasMore, loadMore, pageSize, setPageSize } = usePagedList(ordered);
  const sections: { type: AssetType; items: Product[] }[] = [];
  for (const product of visible) {
    const last = sections.at(-1);
    if (last && last.type === product.type) last.items.push(product);
    else sections.push({ type: product.type, items: [product] });
  }
  // Итоги среза — готовые цифры бэкенда (§8, §10): категория из сводки, банк из структуры.
  const groupTotals = group ? summary?.groups.find((item) => item.group === group) : undefined;
  const bankTotals = bank && !group ? storage?.find((item) => item.key === bank) : undefined;
  const totals = groupTotals
    ? { value: groupTotals.value, invested: groupTotals.invested, pnl: groupTotals.pnl, pnlPercent: groupTotals.pnlPercent, share: groupTotals.share }
    : bankTotals
      ? { value: bankTotals.value, invested: bankTotals.invested, pnl: bankTotals.pnl, pnlPercent: bankTotals.pnlPercent, share: bankTotals.share }
      : undefined;
  const totalsPnl = totals ? pnlDisplay(totals.pnl, totals.pnlPercent) : null;
  const title = group ?? bank ?? "Инструменты";
  const subtitle = group
    ? bank ? `Категория портфеля · ${bank}` : "Категория портфеля"
    : bank ? "Что хранится в этом банке" : "Все инструменты портфеля по категориям";
  return (
    <Page title={title} subtitle={subtitle} back={Boolean(group || bank)}>
      {totals && totalsPnl && (
        <div className="slice-totals">
          <div>
            <span>Стоимость</span>
            <strong>{money(totals.value)}</strong>
          </div>
          <div>
            <span>Вложено</span>
            <strong>{money(totals.invested)}</strong>
          </div>
          <div>
            <span>Доход</span>
            <strong className={totalsPnl.className}>
              {totals.pnlPercent === null ? totalsPnl.amountText : `${totalsPnl.amountText} · ${totalsPnl.percentText}`}
            </strong>
          </div>
          <div>
            <span>Доля портфеля</span>
            <strong>{Math.round(totals.share ?? 0)}%</strong>
          </div>
        </div>
      )}
      <div className="toolbar">
        <Link className="primary-button" to="/products/new">
          <span className="label-full">＋ Добавить продукт</span>
          <span className="label-short">＋ Добавить</span>
        </Link>
        <button
          type="button"
          className="outline-button"
          onClick={handleRefreshPrices}
          disabled={refreshing}
        >
          {refreshing ? (
            "Обновляем…"
          ) : (
            <>
              <span className="label-full">↻ Обновить цены (MOEX)</span>
              <span className="label-short">↻ Цены</span>
            </>
          )}
        </button>
      </div>
      <div className="filters-bar">
        <label className="inline-select">
          <span>Категория</span>
          <select value={group ?? "all"} onChange={(event) => setFilter("group", event.target.value)}>
            <option value="all">Все категории</option>
            {productTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </label>
        <label className="inline-select">
          <span>Банк / брокер</span>
          <select value={bank ?? "all"} onChange={(event) => setFilter("bank", event.target.value)}>
            <option value="all">Все</option>
            {banks.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        <label className="inline-select">
          <span>Сортировка</span>
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as ProductSortKey)}
          >
            {Object.entries(PRODUCT_SORT_OPTIONS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      {failedRefresh.length > 0 && (
        <div className="demo-note price-refresh-note">
          <strong>Не обновлено цен: {failedRefresh.length}</strong>
          <ul>
            {failedRefresh.map((item) => (
              <li key={item.positionId}>
                {item.name} ({item.code}) — {priceRefreshReasons[item.status as keyof typeof priceRefreshReasons]}.{" "}
                {item.priceUpdatedAt
                  ? `Последняя цена с биржи — ${formatDateTime(item.priceUpdatedAt)}.`
                  : "С биржи цена ещё ни разу не приходила."}
              </li>
            ))}
          </ul>
        </div>
      )}
      {ordered.length === 0 ? (
        <p className="muted">
          {products.length === 0
            ? "Пока нет добавленных инструментов."
            : "Нет инструментов, подходящих под выбранный фильтр."}
        </p>
      ) : (
        <>
          {sections.map((section, index) => (
            <section className="product-section" key={`${section.type}-${index}`}>
              {!group && (
                <h2 className="product-section-title">
                  <i className={`legend type-dot ${typeColors[section.type]}`} />
                  {section.type}
                </h2>
              )}
              <div className="product-list">
                {section.items.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    nextPayout={product.instrumentId ? nearestPayoutByInstrument.get(product.instrumentId) : undefined}
                    showInstitution={!bank}
                  />
                ))}
              </div>
            </section>
          ))}
          <ListPagination
            hasMore={hasMore}
            onLoadMore={loadMore}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
          />
        </>
      )}
    </Page>
  );
}
function TransactionsPage({
  transactions,
  products,
}: {
  transactions: Transaction[];
  products: Product[];
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TransactionType | "all">("all");
  const [bankFilter, setBankFilter] = useState("all");
  const positionById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const institutionOf = (transaction: Transaction) =>
    transaction.institution ?? (transaction.positionId ? positionById.get(transaction.positionId)?.institution : undefined);
  const banks = Array.from(new Set(transactions.map(institutionOf).filter((name): name is string => Boolean(name)))).sort();
  const types = Array.from(new Set(transactions.map((transaction) => transaction.type)));
  // Свежие сверху: клиент открывает операции, чтобы найти недавнее, а не первую покупку.
  const filtered = transactions
    .filter((transaction) => typeFilter === "all" || transaction.type === typeFilter)
    .filter((transaction) => bankFilter === "all" || institutionOf(transaction) === bankFilter)
    .sort((a, b) => b.date.localeCompare(a.date));
  const { visible, hasMore, loadMore, pageSize, setPageSize } = usePagedList(filtered);
  return (
    <Page title="Операции" subtitle="Покупки, продажи и движение денег">
      <div className="toolbar">
        <Link className="primary-button" to="/transactions/new">
          <span className="label-full">＋ Новая операция</span>
          <span className="label-short">＋ Операция</span>
        </Link>
      </div>
      {transactions.length > 0 && (
        <div className="filters-bar">
          <label className="inline-select">
            <span>Тип</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as TransactionType | "all")}>
              <option value="all">Все типы</option>
              {types.map((type) => (
                <option key={type} value={type}>{transactionTypeLabels[type]}</option>
              ))}
            </select>
          </label>
          {banks.length > 1 && (
            <label className="inline-select">
              <span>Банк / брокер</span>
              <select value={bankFilter} onChange={(event) => setBankFilter(event.target.value)}>
                <option value="all">Все</option>
                {banks.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {transactions.length === 0 ? (
        <p className="muted">Пока нет операций.</p>
      ) : filtered.length === 0 ? (
        <p className="muted">Нет операций, подходящих под выбранный фильтр.</p>
      ) : (
        <>
        <div className="product-list">
          {visible.map((transaction) => {
            const expanded = expandedId === transaction.id;
            const position = transaction.positionId ? positionById.get(transaction.positionId) : undefined;
            const typeLabel = transactionTypeLabels[transaction.type];
            // Название строки — инструмент; для денежной операции — её описание, если оно
            // говорит больше, чем тип (иначе «Покупка» и ниже снова «Покупка»).
            const name = position?.name || (transaction.title && transaction.title !== typeLabel ? transaction.title : typeLabel);
            const institution = institutionOf(transaction);
            const showTitle = transaction.title && transaction.title !== typeLabel && transaction.title !== name;
            const extras: [string, string][] = [];
            if (showTitle) extras.push(["Описание", transaction.title]);
            if (transaction.commission) extras.push(["Комиссия", money(transaction.commission)]);
            if (transaction.tax) extras.push(["Налог", money(transaction.tax)]);
            if (transaction.currency && transaction.currency !== "RUB") extras.push(["Валюта", transaction.currency]);
            if (transaction.source && transaction.source !== "manual") {
              extras.push(["Источник", sourceLabels[transaction.source] || transaction.source]);
            }
            return (
              <div className="list-row" key={transaction.id}>
                <button
                  type="button"
                  className="product-row-summary"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : transaction.id)}
                >
                  <span className="product-row-line1">
                    <span className="product-row-name">
                      <i
                        className={`legend type-dot ${transactionTypeColors[transaction.type]}`}
                        title={typeLabel}
                      />
                      <strong>{name}</strong>
                    </span>
                    <span className="product-row-sum">{signedTransactionAmount(transaction)}</span>
                  </span>
                  <span className="product-row-line2">
                    <span className="muted product-row-meta">
                      {name === typeLabel ? institution || typeLabel : [typeLabel, institution].filter(Boolean).join(" · ")}
                    </span>
                    <span className="muted">{dateLabel(transaction.date)}</span>
                  </span>
                </button>
                {expanded && (
                  <div className="list-row-details">
                    {extras.map(([label, value]) => (
                      <div className="detail-line" key={label}>
                        <span>{label}</span>
                        <span>{value}</span>
                      </div>
                    ))}
                    <div className="list-row-actions">
                      {position && (
                        <Link className="outline-button" to={`/products/${position.id}`}>
                          Инструмент →
                        </Link>
                      )}
                      <Link
                        className="outline-button"
                        to={`/transactions/${transaction.id}/edit`}
                      >
                        Редактировать
                      </Link>
                      <Link
                        className="delete-button"
                        to={`/transactions/${transaction.id}/delete`}
                      >
                        Удалить
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <ListPagination
          hasMore={hasMore}
          onLoadMore={loadMore}
          pageSize={pageSize}
          onPageSizeChange={setPageSize}
        />
        </>
      )}
    </Page>
  );
}
// Банк выплаты: с бэкенда (счёт выплаты), иначе — банк позиции того же инструмента.
function payoutInstitution(payment: Payment, products: Product[]): string | undefined {
  if (payment.institution && payment.institution !== "Ручной ввод") return payment.institution;
  const product = payment.instrumentId ? products.find((item) => item.instrumentId === payment.instrumentId) : undefined;
  return product?.institution && product.institution !== "Ручной ввод" ? product.institution : undefined;
}
function PaymentRow({
  payment,
  products,
  expanded,
  onToggle,
  onMarkReceived,
  marking,
}: {
  payment: Payment;
  products: Product[];
  expanded: boolean;
  onToggle: () => void;
  onMarkReceived: (payment: Payment) => void;
  marking: boolean;
}) {
  const product = payment.instrumentId ? products.find((item) => item.instrumentId === payment.instrumentId) : undefined;
  const institution = payoutInstitution(payment, products);
  const typeLabel = payoutTypeLabels[payment.type];
  // Название — инструмент, тип выплаты — в подписи: серверные заголовки прогноза
  // («Купон «ОФЗ 26238» (прогноз, …)») повторяют и то и другое и не влезают в строку.
  const title = product?.name || payment.title || typeLabel;
  const meta = [
    product ? (payment.type === "DEPOSIT_PRINCIPAL" ? "Возврат вклада" : typeLabel) : null,
    institution,
    payment.source === "forecast" && payment.status === "expected" ? "прогноз" : null,
    payment.status === "received" ? "получено" : null,
  ].filter(Boolean);
  return (
    <div className="list-row">
      <button
        type="button"
        className="product-row-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="product-row-line1">
          <span className="product-row-name">
            <i
              className={`legend type-dot ${payoutTypeColors[payment.type]}`}
              title={typeLabel}
            />
            <strong>{title}</strong>
          </span>
          <span className="product-row-sum">+{payoutMoney(payment)}</span>
        </span>
        <span className="product-row-line2">
          <span className="muted product-row-meta">{meta.length ? meta.join(" · ") : typeLabel}</span>
          <span className="muted">{dateLabel(payment.date)}</span>
        </span>
      </button>
      {expanded && (
        <div className="list-row-details">
          {payment.source === "forecast" && (
            <p className="muted payout-forecast-note">
              Рассчитано по параметрам инструмента и обновляется само. Правка сделает выплату ручной.
            </p>
          )}
          {payment.currency !== "RUB" && (
            <div className="detail-line">
              <span>Валюта</span>
              <span>{payment.currency}</span>
            </div>
          )}
          <div className="list-row-actions">
            {payment.status === "expected" && (
              <button type="button" className="outline-button" disabled={marking} onClick={() => onMarkReceived(payment)}>
                {marking ? "Сохраняем..." : "Отметить полученной"}
              </button>
            )}
            {payment.status === "received" && (
              <Link className="outline-button" to={reinvestLink(payment.amount, institution, title, payment.currency)}>
                Реинвестировать
              </Link>
            )}
            {product && (
              <Link className="outline-button" to={`/products/${product.id}`}>
                Инструмент →
              </Link>
            )}
            <Link className="outline-button" to={`/payments/${payment.id}/edit`}>
              Редактировать
            </Link>
            <Link className="delete-button" to={`/payments/${payment.id}/delete`}>
              Удалить
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
function PaymentsPage({
  payments,
  products,
  onMarkReceived,
}: {
  payments: Payment[];
  products: Product[];
  onMarkReceived: (payment: Payment) => Promise<void>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<PaymentViewMode>("day");
  const [typeFilter, setTypeFilter] = useState<PayoutType | "all">("all");
  // Из карточки инструмента «Все выплаты» открывает календарь уже отфильтрованным по нему.
  const [searchParams] = useSearchParams();
  const [instrumentFilter, setInstrumentFilter] = useState<string>(() => searchParams.get("instrument") || "all");
  const [bankFilter, setBankFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const instrumentOptions = useMemo(() => {
    const map = new Map<string, string>();
    payments.forEach((payment) => {
      if (!payment.instrumentId) return;
      const product = products.find((item) => item.instrumentId === payment.instrumentId);
      if (product) map.set(payment.instrumentId, product.name);
    });
    return Array.from(map.entries());
  }, [payments, products]);

  // Замечание 24: перепутанные «С» и «По» дают пустой список, который выглядит как
  // «выплаты пропали» — предупреждаем и предлагаем поменять границы местами.
  const rangeInverted = Boolean(dateFrom && dateTo && dateFrom > dateTo);
  const bankOptions = Array.from(
    new Set(payments.map((payment) => payoutInstitution(payment, products)).filter((name): name is string => Boolean(name))),
  ).sort();
  const activeFilters = [typeFilter !== "all", instrumentFilter !== "all", bankFilter !== "all", Boolean(dateFrom), Boolean(dateTo)]
    .filter(Boolean).length;
  const filtered = payments.filter((payment) => {
    if (typeFilter !== "all" && payment.type !== typeFilter) return false;
    if (instrumentFilter !== "all" && payment.instrumentId !== instrumentFilter) return false;
    if (bankFilter !== "all" && payoutInstitution(payment, products) !== bankFilter) return false;
    if (dateFrom && payment.date < dateFrom) return false;
    if (dateTo && payment.date > dateTo) return false;
    return true;
  });
  // Просроченные — отдельной группой над календарём (BUG-22): в общий список и в суммы
  // «ожидается» они не попадают, иначе прошедшие даты складываются с будущими.
  const overduePayments = filtered
    .filter(isOverdue)
    .sort((a, b) => a.date.localeCompare(b.date));
  const sorted = filtered
    .filter((payment) => !isOverdue(payment))
    .sort((a, b) => a.date.localeCompare(b.date));
  const [markingId, setMarkingId] = useState<string | null>(null);
  async function markReceived(payment: Payment) {
    setMarkingId(payment.id);
    try {
      await onMarkReceived(payment);
    } finally {
      setMarkingId(null);
    }
  }
  // Вклад, заведённый задним числом, приносит сразу пачку прошедших выплат (2.8) —
  // отмечать их по одной было бы наказанием.
  async function markAllReceived() {
    setMarkingId("all");
    try {
      for (const payment of overduePayments) await onMarkReceived(payment);
    } finally {
      setMarkingId(null);
    }
  }
  const overduePaging = usePagedList(overduePayments);

  const currentMonthKey = periodKey(todayIsoDate(), "month");
  const forecast = sumPayoutsBase(
    payments.filter((payment) => isUpcoming(payment) && periodKey(payment.date, "month") === currentMonthKey),
  );
  const forecastAmount = forecast.total;

  const groups = useMemo(() => {
    const map = new Map<string, Payment[]>();
    sorted.forEach((payment) => {
      const key = periodKey(payment.date, viewMode);
      const list = map.get(key) ?? [];
      list.push(payment);
      map.set(key, list);
    });
    return Array.from(map.entries()).map(([key, items]) => ({
      key,
      label: periodLabel(key, viewMode),
      items,
      expected: sumPayoutsBase(items.filter(isUpcoming)).total,
      received: sumPayoutsBase(items.filter((item) => item.status === "received")).total,
      overdue: sumPayoutsBase(items.filter(isOverdue)).total,
      partial: sumPayoutsBase(items).partial,
    }));
  }, [sorted, viewMode]);

  const dayPaging = usePagedList(sorted);
  const groupPaging = usePagedList(groups);

  return (
    <Page title="Выплаты" subtitle="Календарь ожидаемых доходов">
      {forecastAmount > 0 && (
        <div className="demo-note">
          📅 В {periodLabel(currentMonthKey, "month").toLowerCase()} ожидается {money(forecastAmount)}
          {forecast.partial && " — без выплат в валюте, для которой нет курса ЦБ"}
        </div>
      )}
      <div className="toolbar">
        <Link className="primary-button" to="/payments/new">
          <span className="label-full">＋ Добавить выплату</span>
          <span className="label-short">＋ Выплата</span>
        </Link>
        <div className="view-mode-switch">
          <button
            className={viewMode === "day" ? "selected" : ""}
            type="button"
            onClick={() => setViewMode("day")}
          >
            <span className="label-full">По дням</span>
            <span className="label-short">Дни</span>
          </button>
          <button
            className={viewMode === "month" ? "selected" : ""}
            type="button"
            onClick={() => setViewMode("month")}
          >
            <span className="label-full">По месяцам</span>
            <span className="label-short">Месяцы</span>
          </button>
          <button
            className={viewMode === "year" ? "selected" : ""}
            type="button"
            onClick={() => setViewMode("year")}
          >
            <span className="label-full">По годам</span>
            <span className="label-short">Годы</span>
          </button>
        </div>
      </div>
      <details className="filters-disclosure" open={activeFilters > 0 || undefined}>
        <summary>Фильтры{activeFilters > 0 ? ` · ${activeFilters}` : ""}</summary>
      <div className="filters-bar">
        <label className="inline-select">
          <span>Тип</span>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as PayoutType | "all")}
          >
            <option value="all">Все типы</option>
            {Object.entries(payoutTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        {instrumentOptions.length > 0 && (
          <label className="inline-select">
            <span>Инструмент</span>
            <select
              value={instrumentFilter}
              onChange={(event) => setInstrumentFilter(event.target.value)}
            >
              <option value="all">Все инструменты</option>
              {instrumentOptions.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          </label>
        )}
        {bankOptions.length > 1 && (
          <label className="inline-select">
            <span>Банк / брокер</span>
            <select value={bankFilter} onChange={(event) => setBankFilter(event.target.value)}>
              <option value="all">Все</option>
              {bankOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="inline-select">
          <span>С</span>
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className="inline-select">
          <span>По</span>
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
      </div>
      </details>
      {rangeInverted && (
        <div className="demo-note" role="alert">
          ⚠ Начало периода позже конца: {fullDate(dateFrom)} → {fullDate(dateTo)}. Под такие условия
          не попадёт ни одна выплата.{" "}
          <button
            type="button"
            className="inline-link-button"
            onClick={() => {
              setDateFrom(dateTo);
              setDateTo(dateFrom);
            }}
          >
            Поменять местами
          </button>
        </div>
      )}
      {products
        .filter((product) => product.forecastNote)
        .map((product) => (
          <div className="demo-note" key={product.id}>
            ⚠ «{product.name}»: {product.forecastNote?.toLowerCase()}.{" "}
            {product.source !== "broker" && (
              <Link to={`/products/${product.id}/edit`}>Заполнить</Link>
            )}
          </div>
        ))}
      {overduePayments.length > 0 && (
        <section className="overdue-block">
          <div className="section-heading compact">
            <div>
              <h2>Просрочено</h2>
              <p>Дата прошла — отметьте, если деньги пришли.</p>
            </div>
          </div>
          <div className="product-list">
            {overduePaging.visible.map((payment) => {
              const product = payment.instrumentId
                ? products.find((item) => item.instrumentId === payment.instrumentId)
                : undefined;
              const typeLabel = payment.type === "DEPOSIT_PRINCIPAL" ? "Возврат вклада" : payoutTypeLabels[payment.type];
              return (
                <div className="list-row attention-row attention-row-compact" key={payment.id}>
                  <Link className="product-row-summary" to={`/payments/${payment.id}/edit`}>
                    <span className="product-row-line1">
                      <span className="product-row-name">
                        <i className={`legend type-dot ${payoutTypeColors[payment.type]}`} title={typeLabel} />
                        <strong>{product?.name || payment.title || typeLabel}</strong>
                      </span>
                      <span className="product-row-sum">+{payoutMoney(payment)}</span>
                    </span>
                    <span className="product-row-line2">
                      <span className="muted product-row-meta">
                        {[typeLabel, payoutInstitution(payment, products)].filter(Boolean).join(" · ")}
                      </span>
                      <span className="danger-text">{dateLabel(payment.date)}</span>
                    </span>
                  </Link>
                  <div className="attention-actions">
                    <button
                      type="button"
                      className="outline-button"
                      disabled={markingId !== null}
                      onClick={() => void markReceived(payment)}
                    >
                      {markingId === payment.id ? "Сохраняем..." : "Получена"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <ListPagination
            hasMore={overduePaging.hasMore}
            onLoadMore={overduePaging.loadMore}
            pageSize={overduePaging.pageSize}
            onPageSizeChange={overduePaging.setPageSize}
          />
          {overduePayments.length > 1 && (
            <div className="list-row-actions">
              <button
                type="button"
                className="outline-button"
                disabled={markingId !== null}
                onClick={() => void markAllReceived()}
              >
                {markingId === "all" ? (
                  "Сохраняем..."
                ) : (
                  <>
                    <span className="label-full">Отметить все полученными ({overduePayments.length})</span>
                    <span className="label-short">Отметить все ({overduePayments.length})</span>
                  </>
                )}
              </button>
            </div>
          )}
        </section>
      )}
      {sorted.length === 0 ? (
        <p className="muted">
          {payments.length === 0
            ? "Пока нет добавленных выплат."
            : rangeInverted
              ? "Период задан наоборот — поменяйте «С» и «По» местами."
              : "Нет выплат, подходящих под выбранные условия."}
        </p>
      ) : viewMode === "day" ? (
        <>
          <div className="product-list">
            {dayPaging.visible.map((payment) => (
              <PaymentRow
                key={payment.id}
                payment={payment}
                products={products}
                expanded={expandedId === payment.id}
                onToggle={() => setExpandedId(expandedId === payment.id ? null : payment.id)}
                onMarkReceived={(item) => void markReceived(item)}
                marking={markingId !== null}
              />
            ))}
          </div>
          <ListPagination
            hasMore={dayPaging.hasMore}
            onLoadMore={dayPaging.loadMore}
            pageSize={dayPaging.pageSize}
            onPageSizeChange={dayPaging.setPageSize}
          />
        </>
      ) : (
        <>
          <div className="product-list">
            {groupPaging.visible.map((group) => {
              const expanded = expandedId === group.key;
              const value = payoutGroupValue(group.expected, group.received, group.overdue);
              return (
                <div className="list-row" key={group.key}>
                  <button
                    type="button"
                    className="product-row-summary"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : group.key)}
                  >
                    <span className="product-row-line1">
                      <span className="product-row-name">
                        <strong>{group.label}</strong>
                      </span>
                      <span className="product-row-sum">{value.amount}</span>
                    </span>
                    <span className="product-row-line2 product-row-line2-flush">
                      <span className="muted product-row-meta">
                        {group.items.length} {pluralPayouts(group.items.length)}
                      </span>
                      <span className="muted">
                        {value.note}
                        {group.partial && " · без части в валюте"}
                      </span>
                    </span>
                  </button>
                  {expanded && (
                    <div className="list-row-details">
                      {group.items.map((payment) => (
                        <div className="detail-line" key={payment.id}>
                          <span className="payout-detail-name">
                            <i
                              className={`legend type-dot ${payoutTypeColors[payment.type]}`}
                              title={payoutTypeLabels[payment.type]}
                            />
                            <span>
                              {payment.title}
                              <small className="muted">
                                {dateLabel(payment.date)} · {payoutTypeLabels[payment.type]} ·{" "}
                                {payoutStatusLabels[payment.status].toLowerCase()}
                              </small>
                            </span>
                          </span>
                          <span>+{payoutMoney(payment)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <ListPagination
            hasMore={groupPaging.hasMore}
            onLoadMore={groupPaging.loadMore}
            pageSize={groupPaging.pageSize}
            onPageSizeChange={groupPaging.setPageSize}
          />
        </>
      )}
    </Page>
  );
}
const yesNo = (value: boolean | undefined) => (value === undefined ? undefined : value ? "да" : "нет");
const percentText = (value: number | undefined) =>
  value === undefined ? undefined : `${value.toLocaleString("ru-RU", { maximumFractionDigits: 3 })}%`;
// Главные параметры инструмента по его типу (CLIENT_FLOW_PLAN §4.3): у вклада — ставка и
// срок, у облигации — купон и погашение, у акции — количество и цены. Пустые не выводятся.
function instrumentParams(product: Product): [string, React.ReactNode][] {
  const date = (value: string | undefined) => (value && parseIsoDate(value) ? fullDate(value) : undefined);
  const price = (value: number | undefined) => (value === undefined ? undefined : preciseMoney(value));
  const currentPrice = quotedTypes.has(product.type)
    ? product.currentPrice !== undefined
      ? `${preciseMoney(product.currentPrice)}${product.priceUpdatedAt ? ` · ${formatDateTime(product.priceUpdatedAt)}` : ""}`
      : "Актуальная цена недоступна"
    : undefined;
  const rows: [string, React.ReactNode | undefined][] =
    product.type === "Вклады"
      ? [
          ["Ставка", product.rate !== undefined ? `${percentText(product.rate)}${product.effectiveRate ? ` (эффективная ${percentText(product.effectiveRate)})` : ""}` : undefined],
          ["Открыт", date(product.date)],
          ["Окончание", date(product.termEndDate)],
          ["Выплата процентов", product.interestPayoutFrequency],
          ["Капитализация", yesNo(product.capitalization)],
          ["Пополнение", yesNo(product.replenishable)],
          ["Частичное снятие", yesNo(product.partialWithdrawal)],
          ["Автопролонгация", yesNo(product.autoProlongation)],
        ]
      : product.type === "Облигации"
        ? [
            ["Купон", percentText(product.couponRate)],
            ["Погашение", date(product.maturityDate)],
            ["Оферта", date(product.ofertaDate)],
            ["Количество", product.quantity],
            ["Номинал", price(product.nominal)],
            ["НКД", price(product.accruedInterest)],
            ["Средняя цена", price(product.averagePrice)],
            ["Текущая цена", currentPrice],
            ["Амортизация", product.amortization ? "да" : undefined],
          ]
        : [
            ["Количество", product.quantity],
            ["Средняя цена", price(product.averagePrice)],
            ["Текущая цена", currentPrice],
            ["Дата покупки", date(product.date)],
          ];
  return rows.filter((row): row is [string, React.ReactNode] => row[1] !== undefined && row[1] !== "");
}
// Направление денег операции для знака суммы в ленте: покупка и расходы уменьшают деньги.
const OUTGOING_TRANSACTION_TYPES: TransactionType[] = ["BUY", "WITHDRAW", "FEE", "TAX"];
function signedTransactionAmount(transaction: Transaction) {
  return `${OUTGOING_TRANSACTION_TYPES.includes(transaction.type) ? "−" : "+"}${money(transaction.amount)}`;
}

function ProductDetailPage({
  products,
  transactions,
  payments,
  onMarkReceived,
}: {
  products: Product[];
  transactions: Transaction[];
  payments: Payment[];
  onMarkReceived: (payment: Payment) => Promise<void>;
}) {
  const [markingId, setMarkingId] = useState<string | null>(null);
  const { id } = useParams();
  const product = products.find((item) => item.id === id);
  if (!product) return <MissingRecord to="/products" />;
  const relatedTransactions = transactions.filter(
    (transaction) => transaction.positionId === product.id,
  );
  const relatedPayments = product.instrumentId
    ? payments.filter((payment) => payment.instrumentId === product.instrumentId)
    : [];
  // Возврат тела и погашение — возврат вложенного, а не доход (§10.3): в «получено» не идут.
  const received = sumPayoutsBase(
    relatedPayments.filter((payment) => payment.status === "received" && !isPrincipalPayout(payment)),
  ).total;
  // Просроченные не складываются с будущими (§22, BUG-22) — как в разделе «Выплаты».
  const expected = sumPayoutsBase(
    relatedPayments.filter((payment) => isUpcoming(payment) && !isPrincipalPayout(payment)),
  ).total;
  const overduePayments = relatedPayments.filter(isOverdue).sort((a, b) => a.date.localeCompare(b.date));
  const nextPayout = nearestPayoutMap(relatedPayments).get(product.instrumentId ?? "");
  const end = product.termEndDate || product.maturityDate;
  async function markReceived(payment: Payment) {
    setMarkingId(payment.id);
    try {
      await onMarkReceived(payment);
    } finally {
      setMarkingId(null);
    }
  }
  const valuation = valuationOf(product);
  const pnl = pnlDisplay(valuation.pnl, valuation.pnlPercent);
  const params = instrumentParams(product);
  // История — одна лента событий по инструменту: операции и полученные выплаты.
  const history = [
    ...relatedTransactions.map((transaction) => ({
      id: `t-${transaction.id}`,
      date: transaction.date,
      label: transactionTypeLabels[transaction.type],
      color: transactionTypeColors[transaction.type],
      amount: signedTransactionAmount(transaction),
      to: `/transactions/${transaction.id}/edit`,
    })),
    ...relatedPayments
      .filter((payment) => payment.status === "received")
      .map((payment) => ({
        id: `p-${payment.id}`,
        date: payment.date,
        label: payment.type === "DEPOSIT_PRINCIPAL" ? "Возврат вклада" : payoutTypeLabels[payment.type],
        color: payoutTypeColors[payment.type],
        amount: `+${payoutMoney(payment)}`,
        to: `/payments/${payment.id}/edit`,
      })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const details: [string, string | undefined][] = [
    ["Тикер", product.ticker || undefined],
    ["ISIN", product.isin],
    ["Валюта", product.currency],
    ["Источник данных", sourceLabels[product.source] || product.source],
    ["Дата покупки / открытия", parseIsoDate(product.date) ? fullDate(product.date) : undefined],
  ];
  const nextIsPrincipal = nextPayout?.parts.some(isPrincipalPayout) ?? false;
  return (
    <Page
      title={product.name}
      subtitle={[product.type, product.institution].filter(Boolean).join(" · ")}
      back
    >
      {product.closedOn && (
        <div className="demo-note">
          {product.type === "Вклады" ? "Вклад закрыт" : "Позиция погашена"}{" "}
          {fullDate(product.closedOn)}: деньги вернулись, в стоимость портфеля позиция больше не входит.
        </div>
      )}
      <article className="total-card instrument-hero">
        <div className="card-label">{product.closedOn ? "ИТОГ" : "СТОИМОСТЬ"}</div>
        <div className="total-value">{valueText(valuation.value)}</div>
        {estimateNote(valuation) && <p className="muted">{estimateNote(valuation)}</p>}
        <div className="total-stats">
          <div>
            <span>Вложено</span>
            <strong>{money(product.invested)}</strong>
          </div>
          <div>
            <span>{product.closedOn ? "Результат" : "Доход сейчас"}</span>
            <strong className={pnl.className}>
              {valuation.pnl === null ? "—" : `${pnl.amountText} · ${pnl.percentText}`}
            </strong>
          </div>
          <div>
            <span>Получено выплат</span>
            <strong>{money(received)}</strong>
          </div>
          {expected > 0 && (
            <div>
              <span>Ожидается выплат</span>
              <strong className="teal-text">{money(expected)}</strong>
            </div>
          )}
        </div>
      </article>
      {!product.closedOn && (overduePayments.length > 0 || nextPayout || product.forecastNote || (end && parseIsoDate(end))) && (
        <>
          <section className="section-heading">
            <div>
              <h2>Что дальше</h2>
            </div>
          </section>
          <div className="product-list">
            {overduePayments.map((payment) => (
              <div className="list-row" key={payment.id}>
                <div className="product-row-summary product-row-static">
                  <span className="product-row-line1">
                    <span className="product-row-name">
                      <i className={`legend type-dot ${payoutTypeColors[payment.type]}`} />
                      <strong>{payment.type === "DEPOSIT_PRINCIPAL" ? "Возврат вклада" : payoutTypeLabels[payment.type]}</strong>
                    </span>
                    <span className="product-row-sum">+{payoutMoney(payment)}</span>
                  </span>
                  <span className="product-row-line2">
                    <span className="danger-text product-row-meta">{dateLabel(payment.date)} · не отмечена полученной</span>
                  </span>
                </div>
                <div className="attention-actions">
                  <button
                    type="button"
                    className="outline-button"
                    disabled={markingId !== null}
                    onClick={() => void markReceived(payment)}
                  >
                    {markingId === payment.id ? "Сохраняем..." : "Отметить полученной"}
                  </button>
                </div>
              </div>
            ))}
            {nextPayout && (
              <div className="list-row">
                <div className="product-row-summary product-row-static">
                  <span className="product-row-line1">
                    <span className="product-row-name">
                      <i className={`legend type-dot ${payoutTypeColors[nextPayout.parts[0].type]}`} />
                      <strong>
                        {nextIsPrincipal
                          ? product.type === "Вклады" ? "Возврат вклада" : "Погашение"
                          : `Ближайшая выплата: ${payoutTypeLabels[nextPayout.parts[0].type].toLowerCase()}`}
                      </strong>
                    </span>
                    <span className="product-row-sum">+{money(nextPayout.total)}</span>
                  </span>
                  <span className="product-row-line2">
                    <span className="muted product-row-meta">
                      {dateLabel(nextPayout.date)}
                      {nextPayout.parts.length > 1 &&
                        ` · ${nextPayout.parts
                          .map((part) => `${part.type === "DEPOSIT_PRINCIPAL" ? "тело вклада" : payoutTypeLabels[part.type].toLowerCase()} ${payoutMoney(part)}`)
                          .join(" + ")}`}
                      {nextPayout.parts.some((part) => part.source === "forecast") && " · прогноз"}
                    </span>
                  </span>
                </div>
                {nextIsPrincipal && (
                  <div className="attention-actions">
                    <Link
                      className="outline-button"
                      to={reinvestLink(nextPayout.total, product.institution, product.name)}
                    >
                      Реинвестировать
                    </Link>
                  </div>
                )}
              </div>
            )}
            {!nextIsPrincipal && end && parseIsoDate(end) && (
              <div className="list-row">
                <div className="product-row-summary product-row-static">
                  <span className="product-row-line1">
                    <span className="product-row-name">
                      <strong>{product.type === "Вклады" ? "Окончание вклада" : "Погашение"}</strong>
                    </span>
                    <span className="product-row-sum muted">{dateLabel(end)}</span>
                  </span>
                </div>
              </div>
            )}
            {product.forecastNote && (
              <div className="list-row">
                <div className="product-row-summary product-row-static">
                  <span className="attention-text">⚠ {product.forecastNote}.</span>
                </div>
                {product.source !== "broker" && (
                  <div className="attention-actions">
                    <Link className="outline-button" to={`/products/${product.id}/edit`}>
                      Заполнить
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
      {params.length > 0 && (
        <>
          <section className="section-heading">
            <div>
              <h2>Параметры</h2>
            </div>
          </section>
          <div className="confirm-card">
            {params.map(([label, value]) => (
              <div className="detail-line" key={label}>
                <span>{label}</span>
                <span>{value}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <section className="section-heading">
        <div>
          <h2>История</h2>
        </div>
        {relatedPayments.length > 0 && product.instrumentId && (
          <Link className="outline-button" to={`/payments?instrument=${encodeURIComponent(product.instrumentId)}`}>
            Все выплаты <span>→</span>
          </Link>
        )}
      </section>
      {history.length === 0 ? (
        <p className="muted">Операций и полученных выплат по этому инструменту пока нет.</p>
      ) : (
        <div className="product-list">
          {history.map((entry) => (
            <div className="list-row" key={entry.id}>
              <Link className="product-row-summary" to={entry.to}>
                <span className="product-row-line1">
                  <span className="product-row-name">
                    <i className={`legend type-dot ${entry.color}`} />
                    <strong>{entry.label}</strong>
                  </span>
                  <span className="product-row-sum">{entry.amount}</span>
                </span>
                <span className="product-row-line2">
                  <span className="muted product-row-meta">{dateLabel(entry.date)}</span>
                </span>
              </Link>
            </div>
          ))}
        </div>
      )}
      <details className="more-details">
        <summary>Подробности</summary>
        <div className="confirm-card">
          {details
            .filter((row): row is [string, string] => Boolean(row[1]))
            .map(([label, value]) => (
              <div className="detail-line" key={label}>
                <span>{label}</span>
                <span>{value}</span>
              </div>
            ))}
        </div>
      </details>
      <div className="list-row-actions detail-actions">
        {product.type !== "Деньги" && !product.closedOn && (
          <Link className="outline-button" to={`/payments/new?position=${encodeURIComponent(product.id)}`}>
            ＋ Выплата
          </Link>
        )}
        <Link className="outline-button" to={`/transactions/new?position=${encodeURIComponent(product.id)}`}>
          ＋ Операция
        </Link>
        {product.source !== "broker" && (
          <>
            <Link className="outline-button" to={`/products/${product.id}/edit`}>
              Редактировать
            </Link>
            <Link className="delete-button" to={`/products/${product.id}/delete`}>
              Удалить
            </Link>
          </>
        )}
      </div>
    </Page>
  );
}
// §23: разрезы структуры портфеля помимо класса активов (тот уже покрыт `groups` выше,
// приходит вместе с /api/portfolio/summary). Зеркалит Breakdown из server/portfolio-engine.ts.
type StructureBreakdown = {
  key: string;
  invested: number;
  value: number;
  pnl: number;
  pnlPercent: number | null;
  share: number | null;
  positions: number;
  priceUnavailable: number;
};
type PortfolioStructure = {
  byCurrency: StructureBreakdown[];
  byBroker: StructureBreakdown[];
  byBank: StructureBreakdown[];
  byInstrument: StructureBreakdown[];
  byIssuer: StructureBreakdown[];
  byProvider?: StructureBreakdown[];
};

function BreakdownList({
  title,
  items,
  emptyHint,
  linkOf,
}: {
  title: string;
  items: StructureBreakdown[];
  emptyHint: string;
  // Разрез, у которого есть свой список (категория, банк), — строка ведёт в него.
  linkOf?: (item: StructureBreakdown) => string;
}) {
  const { visible, hasMore, loadMore, pageSize, setPageSize } = usePagedList(items);
  return (
    <section className="breakdown-section">
      <div className="breakdown-heading">
        <h2>{title}</h2>
        {items.length === 0 && <span className="muted">{emptyHint}</span>}
      </div>
      {items.length > 0 && (
        <>
          <div className="product-list">
            {visible.map((item) => {
              const pnl = pnlDisplay(item.pnl, item.pnlPercent);
              const content = (
                <>
                      <span className="product-row-line1">
                        <span className="product-row-name">
                          <strong>{item.key}</strong>
                        </span>
                        <span className="product-row-sum">{money(item.value)}</span>
                      </span>
                      <span className="product-row-line2 product-row-line2-flush">
                        <span className="muted product-row-meta">
                          {Math.round(item.share ?? 0)}% портфеля
                          {item.priceUnavailable > 0 && (
                            <span className="danger-text"> · цена недоступна ({item.priceUnavailable})</span>
                          )}
                        </span>
                        <span className={pnl.className} title={`Прирост: ${pnl.amountText}`}>
                          {pnl.percentText}
                        </span>
                      </span>
                      <span className="share-bar" aria-hidden="true">
                        <i style={{ width: `${Math.min(100, Math.max(0, item.share ?? 0))}%` }} />
                      </span>
                </>
              );
              const href = linkOf?.(item);
              return (
                <div className="list-row" key={item.key}>
                  {href ? (
                    <Link className="product-row-summary" to={href}>
                      {content}
                    </Link>
                  ) : (
                    <div className="product-row-summary product-row-static">{content}</div>
                  )}
                </div>
              );
            })}
          </div>
          <ListPagination
            hasMore={hasMore}
            onLoadMore={loadMore}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
          />
        </>
      )}
    </section>
  );
}

function AnalyticsPage({
  summary,
  token,
}: {
  summary: PortfolioSummary | null;
  token: string;
}) {
  const { profit, profitPercent, groups } = summary ?? localSummary([], []);
  // Категории (классы активов) уже посчитаны в summary.groups — тем же движком (§10).
  const byGroup: StructureBreakdown[] = groups.map((group) => ({ ...group, key: group.group }));
  const [structure, setStructure] = useState<PortfolioStructure | null>(null);
  const [structureError, setStructureError] = useState("");
  const topInstrument = structure?.byInstrument.find((item) => !item.key.startsWith("Денежные средства"));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await apiFetch(`${apiUrl}/portfolio/structure`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error("Не удалось загрузить структуру портфеля");
        const result = (await response.json()) as PortfolioStructure;
        if (!cancelled) setStructure(result);
      } catch {
        if (!cancelled) setStructureError("Не удалось загрузить структуру портфеля");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <Page title="Аналитика" subtitle="Базовые показатели портфеля">
      <div className="stat-strip">
        <article className="stat-card">
          <span>Доходность</span>
          <strong className={(profitPercent ?? 0) < 0 ? "danger-text" : "teal-text"}>
            {(profitPercent ?? 0) < 0 ? "" : "+"}
            {(profitPercent ?? 0).toFixed(2).replace(".", ",")}%
          </strong>
          <small>простая, за всё время</small>
        </article>
        <article className="stat-card">
          <span>Результат</span>
          <strong className={profit < 0 ? "danger-text" : "teal-text"}>
            {Math.round(profit) === 0 ? "" : profit < 0 ? "−" : "+"}
            {money(Math.abs(profit))}
          </strong>
          <small>стоимость минус вложено</small>
        </article>
        <article className="stat-card">
          <span>Крупнейшая позиция</span>
          <strong>{topInstrument ? `${Math.round(topInstrument.share ?? 0)}%` : "—"}</strong>
          <small className="ellipsis-text">{topInstrument?.key ?? "нет данных"}</small>
        </article>
      </div>
      <BreakdownList
        title="По категориям"
        items={byGroup}
        emptyHint="Портфель пуст"
        linkOf={(item) => (item.key === "Деньги" ? "/transactions" : `/products?group=${encodeURIComponent(item.key)}`)}
      />
      {structureError && <p className="form-error">{structureError}</p>}
      {structure && (
        <>
          <BreakdownList
            title="По банкам и брокерам"
            items={structure.byProvider ?? [...structure.byBroker, ...structure.byBank]}
            emptyHint="Нет счетов"
            linkOf={(item) => `/products?bank=${encodeURIComponent(item.key)}`}
          />
          <BreakdownList title="По валютам" items={structure.byCurrency} emptyHint="Нет данных" />
          <BreakdownList title="По инструментам" items={structure.byInstrument} emptyHint="Нет данных" />
          <BreakdownList
            title="По эмитентам"
            items={structure.byIssuer}
            emptyHint="Эмитент не указан ни у одного инструмента"
          />
        </>
      )}
    </Page>
  );
}
type RecommendationRuleType =
  | "concentration"
  | "maturity"
  | "drawdown"
  | "payout_gap";
type RecommendationItem = {
  ruleType: RecommendationRuleType;
  text: string;
  payload: Record<string, unknown>;
};
// Иконка и стиль карточки по типу правила (§24) — просадка/концентрация/погашение
// требуют внимания в ближайшее время, разрыв в выплатах — нейтральная информация о прогнозе.
const RECOMMENDATION_STYLE: Record<
  RecommendationRuleType,
  { label: string; color: string; warning: boolean }
> = {
  concentration: { label: "Концентрация", color: "coral", warning: true },
  maturity: { label: "Погашение", color: "amber", warning: true },
  drawdown: { label: "Просадка", color: "pink", warning: true },
  payout_gap: { label: "Разрыв в выплатах", color: "slate", warning: false },
};

function Recommendations({ token }: { token: string }) {
  const [items, setItems] = useState<RecommendationItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await apiFetch(`${apiUrl}/recommendations`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error("Не удалось загрузить рекомендации");
        const result = (await response.json()) as RecommendationItem[];
        if (!cancelled) setItems(result);
      } catch {
        if (!cancelled) setError("Не удалось загрузить рекомендации");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <Page
      title="Рекомендации"
      subtitle="Аналитические уведомления на основе текущего портфеля — не являются индивидуальной инвестиционной рекомендацией"
    >
      {error && <p className="form-error">{error}</p>}
      {!error && items === null && <p>Загрузка…</p>}
      {!error && items !== null && items.length === 0 && (
        <p>Пока нет замечаний по портфелю.</p>
      )}
      {!error && items !== null && items.length > 0 && (
        <div className="product-list">
          {items.map((item, index) => {
            const style = RECOMMENDATION_STYLE[item.ruleType];
            return (
              <article className="list-row" key={`${item.ruleType}-${index}`}>
                <div className="product-row-summary product-row-static recommendation-row">
                  <i className={`legend type-dot ${style.color}`} title={style.label} />
                  <span>
                    <strong>{item.text}</strong>
                    <small className={style.warning ? "warning-text" : "muted"}>
                      {style.label}
                      {style.warning ? " · требует внимания" : ""}
                    </small>
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Page>
  );
}
const currencyLabels: Record<string, string> = {
  RUB: "RUB — российский рубль",
  USD: "USD — доллар США",
  CNY: "CNY — китайский юань",
};

function Settings({
  token,
  themePreference,
  onThemeChange,
}: {
  token: string;
  themePreference: ThemePreference;
  onThemeChange: (value: ThemePreference) => void;
}) {
  const [portfolioName, setPortfolioName] = useState("");
  const [baseCurrency, setBaseCurrency] = useState("RUB");
  const [availableCurrencies, setAvailableCurrencies] = useState<string[]>([
    "RUB",
    "USD",
    "CNY",
  ]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    (async () => {
      const response = await apiFetch(`${apiUrl}/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return;
      const result = (await response.json()) as {
        portfolioName?: string;
        baseCurrency?: string;
        availableCurrencies?: string[];
      };
      setPortfolioName(result.portfolioName || "");
      setBaseCurrency(result.baseCurrency || "RUB");
      if (result.availableCurrencies) {
        setAvailableCurrencies(result.availableCurrencies);
      }
    })().catch((error) => setMessage(errorText(error, "Не удалось загрузить настройки")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const response = await apiFetch(`${apiUrl}/settings`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ portfolioName, baseCurrency }),
      });
      const result = (await response.json()) as {
        portfolioName?: string;
        baseCurrency?: string;
        error?: string;
      };
      if (!response.ok) {
        setMessage(result.error || "Не удалось сохранить настройки");
        return;
      }
      setPortfolioName(result.portfolioName || "");
      setBaseCurrency(result.baseCurrency || "RUB");
      setMessage("Настройки сохранены");
    } catch (error) {
      setMessage(errorText(error, "Не удалось сохранить настройки"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page title="Настройки" subtitle="Параметры портфеля">
      <form className="settings-card" onSubmit={save}>
        <label>
          Базовая валюта
          <select
            value={baseCurrency}
            onChange={(event) => setBaseCurrency(event.target.value)}
          >
            {availableCurrencies.map((code) => (
              <option key={code} value={code}>
                {currencyLabels[code] || code}
              </option>
            ))}
          </select>
        </label>
        <label>
          Название портфеля
          <input
            value={portfolioName}
            onChange={(event) => setPortfolioName(event.target.value)}
          />
        </label>
        <label>
          Тема оформления
          <select
            value={themePreference}
            onChange={(event) =>
              onThemeChange(event.target.value as ThemePreference)
            }
          >
            <option value="system">Как в системе</option>
            <option value="light">Светлая</option>
            <option value="dark">Тёмная</option>
          </select>
        </label>
        {message && <p className="form-error">{message}</p>}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "Сохранение…" : "Сохранить"}
        </button>
        <Link className="delete-button" to="/settings/delete-account">
          Удалить аккаунт
        </Link>
      </form>
    </Page>
  );
}
function Integrations({
  token,
  onStatusChange,
  onDataChange,
}: {
  token: string;
  onStatusChange: () => void;
  onDataChange: () => Promise<void>;
}) {
  const [brokerToken, setBrokerToken] = useState("");
  const [status, setStatus] = useState("disconnected");
  const [maskedToken, setMaskedToken] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState<string | undefined>();
  const [lastError, setLastError] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState(false);

  const loadStatus = async () => {
    const response = await apiFetch(`${apiUrl}/brokers/tinkoff`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = (await response.json()) as {
      status?: string;
      maskedToken?: string;
      lastSyncAt?: string;
      lastError?: string;
    };
    setStatus(result.status || "disconnected");
    setMaskedToken(result.maskedToken || "");
    setLastSyncAt(result.lastSyncAt);
    setLastError(result.lastError);
    onStatusChange();
  };

  useEffect(() => {
    loadStatus().catch((error) =>
      setMessage(errorText(error, "Не удалось получить статус подключения")),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await connectBroker();
    } catch (error) {
      setMessage(errorText(error, "Не удалось подключить Т-Инвестиции"));
    }
  };
  const connectBroker = async () => {
    const response = await apiFetch(`${apiUrl}/brokers/tinkoff/connect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ token: brokerToken }),
    });
    const result = (await response.json()) as {
      status?: string;
      message?: string;
      error?: string;
    };
    setBrokerToken("");
    if (!response.ok) {
      setMessage(result.error || "Не удалось подключить Т-Инвестиции");
      return;
    }
    setMessage(result.message || "");
    await loadStatus();
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const response = await apiFetch(`${apiUrl}/brokers/tinkoff/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = (await response.json()) as {
        message?: string;
        error?: string;
      };
      setMessage(result.message || result.error || "");
      await loadStatus();
      if (response.ok) await onDataChange();
    } catch (error) {
      setMessage(errorText(error, "Не удалось синхронизировать портфель"));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Page title="Интеграции" subtitle="Источники портфеля и синхронизация">
      <div className="integration-card">
        <div className="integration-heading">
          <div className="broker-logo">Т</div>
          <div>
            <h2>Т-Инвестиции</h2>
            <p>Счета, позиции, операции и выплаты</p>
          </div>
          <span className={`connection-state ${status}`}>
            {status === "connected"
              ? "Подключено"
              : status === "error"
                ? "Ошибка синхронизации"
                : status === "pending"
                  ? "Ожидает настройки"
                  : "Не подключено"}
          </span>
        </div>
        {(maskedToken || lastSyncAt) && (
          <div className="integration-facts">
            {maskedToken && (
              <div className="detail-line">
                <span>Сохранённый токен</span>
                <span>{maskedToken}</span>
              </div>
            )}
            {lastSyncAt && (
              <div className="detail-line">
                <span>Последняя синхронизация</span>
                <span>{formatDateTime(lastSyncAt)}</span>
              </div>
            )}
          </div>
        )}
        {status === "error" && (
          <div className="demo-note">
            ⚠ {lastError || "Не удалось загрузить данные от брокера «Т-Инвестиции»."}{" "}
            Показана только доступная часть портфеля.
          </div>
        )}
        <form className="modal-form" onSubmit={connect}>
          <label>
            Токен Т-Инвестиций
            <input
              value={brokerToken}
              onChange={(event) => setBrokerToken(event.target.value)}
              type="password"
              placeholder="Вставьте токен подключения"
              required
            />
          </label>
          <small className="field-hint">
            Где взять: в настройках Т-Инвестиций, раздел «Токены T-Invest API»,
            выпустите токен с доступом «только чтение» — менять портфель приложению не нужно.
          </small>
          <small className="field-hint">
            Токен хранится на сервере в зашифрованном виде и никогда не показывается
            в интерфейсе.
          </small>
          <button className="primary-button" type="submit">
            {status === "disconnected" ? "Подключить Т-Инвестиции" : "Обновить токен"}
          </button>
        </form>
        {(status === "connected" || status === "error") && (
          <button
            className="outline-button sync-button"
            onClick={sync}
            type="button"
            disabled={syncing}
          >
            {syncing
              ? "Синхронизация…"
              : status === "error"
                ? "Повторить попытку"
                : "Запустить синхронизацию"}
          </button>
        )}
        {message && <div className="demo-note">{message}</div>}
      </div>
    </Page>
  );
}
function AttentionPage({
  attention,
  payments,
  onMarkReceived,
}: {
  attention: AttentionItem[] | null;
  payments: Payment[];
  onMarkReceived: (payment: Payment) => Promise<void>;
}) {
  const loaded = useContext(DataLoadedContext);
  const sections = ([1, 2, 3] as const)
    .map((severity) => ({ severity, items: (attention ?? []).filter((item) => item.severity === severity) }))
    .filter((section) => section.items.length > 0);
  return (
    <Page title="Требует внимания" subtitle="Выплаты, сроки и данные, которые стоит проверить" back>
      {attention === null ? (
        <p className="muted">
          {loaded ? "Список недоступен без связи с сервером." : "Загружаем…"}
        </p>
      ) : sections.length === 0 ? (
        <p className="muted">Всё в порядке: ни выплат к отметке, ни сроков на ближайшие недели.</p>
      ) : (
        sections.map((section) => (
          <section key={section.severity} className="attention-section">
            <h2 className="product-section-title">
              <i className={`legend type-dot ${attentionSeverityColors[section.severity]}`} />
              {attentionSeverityLabels[section.severity]} · {section.items.length}
            </h2>
            <AttentionList items={section.items} payments={payments} onMarkReceived={onMarkReceived} />
          </section>
        ))
      )}
    </Page>
  );
}
function ComingSoonPage({ title, text }: { title: string; text: string }) {
  return (
    <Page title={title} subtitle="Скоро">
      <div className="empty-portfolio">
        <p className="eyebrow">v2</p>
        <h1>Этот раздел появится в следующей версии</h1>
        <p>{text}</p>
      </div>
    </Page>
  );
}
// Загружены ли данные портфеля (BUG-18). Пока нет — страница записи по прямой ссылке
// или после F5 показывает «Загружаем…», а не уводит на список: пустой массив в первый
// момент означает «ещё не пришло», а не «такой записи нет».
const DataLoadedContext = createContext(false);
function MissingRecord({ to }: { to: string }) {
  const loaded = useContext(DataLoadedContext);
  if (loaded) return <Navigate to={to} replace />;
  return (
    <Page title="Загрузка…" subtitle="Получаем данные портфеля">
      <p className="muted">Загружаем данные…</p>
    </Page>
  );
}
function Page({
  title,
  subtitle,
  back,
  children,
}: {
  title: string;
  subtitle: string;
  back?: boolean;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="content-wrap inner-page">
      {back && (
        <button
          className="outline-button back-button"
          onClick={() => navigate(-1)}
          type="button"
        >
          ← Назад
        </button>
      )}
      <section className="page-heading">
        <div>
          <h1>{title}</h1>
          <p className="subtitle">{subtitle}</p>
        </div>
      </section>
      {children}
    </div>
  );
}
type LoginField = "email" | "password" | "inviteCode" | "form";
type LoginError = { field: LoginField; message: string };
function Login({
  onSubmit,
}: {
  onSubmit: (form: FormData, mode: "login" | "register") => Promise<LoginError | null>;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<LoginError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errorFor = (field: LoginField) =>
    error?.field === field ? (
      <small className="form-error" role="alert">
        {error.message}
      </small>
    ) : null;
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      setError(await onSubmit(new FormData(event.currentTarget), mode));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(event) => void handleSubmit(event)}>
        <div className="brand login-brand">
          <span className="brand-mark">✳</span> Капитал
        </div>
        <p className="eyebrow">ЛИЧНЫЙ ИНВЕСТИЦИОННЫЙ ПОРТФЕЛЬ</p>
        <h1>{mode === "login" ? "Войдите в аккаунт" : "Создайте аккаунт"}</h1>
        <label>
          Email
          <input
            name="email"
            type="email"
            placeholder="you@example.com"
            required
            aria-invalid={error?.field === "email"}
          />
          {errorFor("email")}
        </label>
        <label>
          Пароль
          <input
            name="password"
            type="password"
            placeholder="Минимум 8 символов"
            minLength={8}
            required
            aria-invalid={error?.field === "password"}
          />
          {errorFor("password")}
        </label>
        {mode === "register" && (
          <label>
            Код приглашения
            <input
              name="inviteCode"
              type="text"
              placeholder="Выдаётся владельцем стенда"
              autoComplete="off"
              aria-invalid={error?.field === "inviteCode"}
            />
            {errorFor("inviteCode")}
          </label>
        )}
        {errorFor("form")}
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting
            ? "Проверяем..."
            : mode === "login"
              ? "Войти в портфель"
              : "Зарегистрироваться"}
        </button>
        {mode === "login" && (
          <Link className="text-button auth-switch" to="/forgot-password">
            Забыли пароль?
          </Link>
        )}
        <button
          className="text-button auth-switch"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
          type="button"
        >
          {mode === "login"
            ? "Создать новый аккаунт"
            : "Уже есть аккаунт? Войти"}
        </button>
        <small>Пароль хранится на сервере в виде криптографического хеша</small>
      </form>
    </div>
  );
}
const FORGOT_PASSWORD_SENT_MESSAGE =
  "Если такой аккаунт есть, мы отправили письмо со ссылкой для восстановления пароля.";
function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await apiFetch(`${apiUrl}/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // §28: ответ одинаковый независимо от того, существует ли аккаунт — нечего
      // разбирать в теле ответа, кроме факта успеха запроса.
      if (!response.ok) throw new Error();
      setSent(true);
    } catch (submitError) {
      setError(errorText(submitError, "Не удалось отправить запрос. Попробуйте ещё раз"));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark">✳</span> Капитал
        </div>
        <p className="eyebrow">ВОССТАНОВЛЕНИЕ ПАРОЛЯ</p>
        {sent ? (
          <>
            <h1>Проверьте почту</h1>
            <p className="muted">{FORGOT_PASSWORD_SENT_MESSAGE}</p>
            <Link className="text-button auth-switch" to="/">
              Вернуться ко входу
            </Link>
          </>
        ) : (
          <form onSubmit={(event) => void handleSubmit(event)}>
            <h1>Забыли пароль?</h1>
            <p className="muted">
              Укажите email, указанный при регистрации — мы отправим на него
              ссылку для восстановления пароля.
            </p>
            <label>
              Email
              <input
                name="email"
                type="email"
                placeholder="you@example.com"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            {error && (
              <small className="form-error" role="alert">
                {error}
              </small>
            )}
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? "Отправляем..." : "Отправить ссылку"}
            </button>
            <Link className="text-button auth-switch" to="/">
              Вернуться ко входу
            </Link>
          </form>
        )}
      </div>
    </div>
  );
}
// Понятная причина недействительности ссылки (§40.4-подобный принцип: не «ошибка»
// без объяснения) плюс путь для повторной попытки — без этого просроченная ссылка
// из письма была бы тупиком.
function resetTokenErrorHint(message: string): boolean {
  return /недействительна|использован|истёк/i.test(message);
}
function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = (searchParams.get("token") ?? "").trim();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="brand login-brand">
            <span className="brand-mark">✳</span> Капитал
          </div>
          <h1>Ссылка недействительна</h1>
          <p className="muted">
            В ссылке не указан токен восстановления. Запросите новое письмо.
          </p>
          <Link className="primary-button" to="/forgot-password">
            Запросить новое письмо
          </Link>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="brand login-brand">
            <span className="brand-mark">✳</span> Капитал
          </div>
          <h1>Пароль изменён</h1>
          <p className="muted">Теперь можно войти в аккаунт с новым паролем.</p>
          <Link className="primary-button" to="/">
            Войти
          </Link>
        </div>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Пароль должен быть не короче 8 символов");
      return;
    }
    if (password !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }
    setSubmitting(true);
    try {
      const response = await apiFetch(`${apiUrl}/auth/reset-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        setError(result.error || "Не удалось изменить пароль. Попробуйте ещё раз");
        return;
      }
      setDone(true);
    } catch (submitError) {
      setError(errorText(submitError, "Не удалось изменить пароль. Попробуйте ещё раз"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(event) => void handleSubmit(event)}>
        <div className="brand login-brand">
          <span className="brand-mark">✳</span> Капитал
        </div>
        <p className="eyebrow">ВОССТАНОВЛЕНИЕ ПАРОЛЯ</p>
        <h1>Новый пароль</h1>
        <label>
          Новый пароль
          <input
            name="password"
            type="password"
            placeholder="Минимум 8 символов"
            minLength={8}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          Повторите пароль
          <input
            name="confirmPassword"
            type="password"
            placeholder="Ещё раз новый пароль"
            minLength={8}
            required
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </label>
        {error && (
          <small className="form-error" role="alert">
            {error}
          </small>
        )}
        {error && resetTokenErrorHint(error) && (
          <Link className="text-button auth-switch" to="/forgot-password">
            Запросить новое письмо
          </Link>
        )}
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? "Сохраняем..." : "Сохранить новый пароль"}
        </button>
      </form>
    </div>
  );
}
function InstrumentDetailsFields({
  type,
  details,
  onChange,
}: {
  type: AssetType;
  details: ProductDetails;
  onChange: <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) => void;
}) {
  const fieldset = InstrumentDetailsFieldset({ type, details, onChange });
  if (!fieldset) return null;
  return (
    <details className="details-block">
      <summary>Добавить дополнительные детали</summary>
      <div className="details-fields">{fieldset}</div>
    </details>
  );
}
function InstrumentDetailsFieldset({
  type,
  details,
  onChange,
}: {
  type: AssetType;
  details: ProductDetails;
  onChange: <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) => void;
}) {
  if (type === "Деньги" || type === "Прочее") return null;
  const showPosition = type === "Облигации" || type === "Акции" || type === "Фонды";
  return (
    <>
      {showPosition && (
          <>
            <label>
              ISIN
              <input
                value={details.isin}
                onChange={(event) => onChange("isin", event.target.value)}
                placeholder="Например, RU000A1038V6"
              />
            </label>
            <label>
              Тикер
              <input
                value={details.ticker}
                onChange={(event) => onChange("ticker", event.target.value.toUpperCase())}
                placeholder="Например, SBER"
              />
            </label>
            <label>
              Количество
              <input
                value={details.quantity}
                onChange={(event) => onChange("quantity", event.target.value)}
                type="number"
                min="0"
              />
            </label>
            <label>
              Средняя цена
              <input
                value={details.averagePrice}
                onChange={(event) => onChange("averagePrice", event.target.value)}
                type="number"
                min="0"
              />
            </label>
            <label>
              Текущая цена
              <input
                value={details.currentPrice}
                onChange={(event) => onChange("currentPrice", event.target.value)}
                type="number"
                min="0"
                placeholder="Оставьте пустым, если неизвестна"
              />
            </label>
          </>
        )}
        {type === "Облигации" && (
          <>
            <label>
              Номинал
              <input
                value={details.nominal}
                onChange={(event) => onChange("nominal", event.target.value)}
                type="number"
                min="0"
              />
            </label>
            <label>
              НКД
              <input
                value={details.accruedInterest}
                onChange={(event) => onChange("accruedInterest", event.target.value)}
                type="number"
                min="0"
              />
            </label>
            <label>
              Купон, %
              <input
                value={details.couponRate}
                onChange={(event) => onChange("couponRate", event.target.value)}
                type="number"
                min="0"
                step="0.01"
              />
            </label>
            <label>
              Дата выплаты купона
              <input
                value={details.couponDate}
                onChange={(event) => onChange("couponDate", event.target.value)}
                type="date"
              />
            </label>
            <label>
              Дата погашения
              <input
                value={details.maturityDate}
                onChange={(event) => onChange("maturityDate", event.target.value)}
                type="date"
              />
            </label>
            <label>
              Оферта
              <input
                value={details.ofertaDate}
                onChange={(event) => onChange("ofertaDate", event.target.value)}
                type="date"
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={details.amortization}
                onChange={(event) => onChange("amortization", event.target.checked)}
              />
              Амортизация номинала
            </label>
          </>
        )}
        {type === "Вклады" && (
          <>
            <label>
              Ставка, %
              <input
                value={details.rate}
                onChange={(event) => onChange("rate", event.target.value)}
                type="number"
                min="0"
                step="0.01"
              />
            </label>
            <label>
              Эффективная ставка, %
              <input
                value={details.effectiveRate}
                onChange={(event) => onChange("effectiveRate", event.target.value)}
                type="number"
                min="0"
                step="0.01"
              />
            </label>
            <label>
              Дата окончания
              <input
                value={details.termEndDate}
                onChange={(event) => onChange("termEndDate", event.target.value)}
                type="date"
              />
            </label>
            <label>
              Периодичность выплаты процентов
              <select
                value={details.interestPayoutFrequency}
                onChange={(event) => onChange("interestPayoutFrequency", event.target.value)}
              >
                <option value="">Не указано</option>
                <option value="Ежемесячно">Ежемесячно</option>
                <option value="Ежеквартально">Ежеквартально</option>
                <option value="В конце срока">В конце срока</option>
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={details.capitalization}
                onChange={(event) => onChange("capitalization", event.target.checked)}
              />
              Капитализация процентов
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={details.replenishable}
                onChange={(event) => onChange("replenishable", event.target.checked)}
              />
              Можно пополнять
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={details.partialWithdrawal}
                onChange={(event) => onChange("partialWithdrawal", event.target.checked)}
              />
              Частичное снятие без потери процентов
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={details.autoProlongation}
                onChange={(event) => onChange("autoProlongation", event.target.checked)}
              />
              Автопродление
            </label>
          </>
        )}
    </>
  );
}
const wizardTypeOptions: { value: AssetType; label: string; icon: string }[] = [
  { value: "Вклады", label: "Вклад", icon: "🏦" },
  { value: "Облигации", label: "Облигация", icon: "📜" },
  { value: "Акции", label: "Акция", icon: "📈" },
  { value: "Фонды", label: "ПИФ", icon: "🧺" },
  { value: "Прочее", label: "Прочее", icon: "▧" },
];


function ProductFormPage({
  token,
  onUnauthorized,
  onSubmit,
  onOcrComplete,
}: {
  token: string;
  onUnauthorized: () => void;
  onSubmit: (product: Product) => Promise<void>;
  onOcrComplete: (result: OcrUploadResult) => void;
}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<"manual" | "screenshot">(
    searchParams.get("mode") === "screenshot" ? "screenshot" : "manual",
  );
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [type, setType] = useState<AssetType | null>(null);
  const [name, setName] = useState("");
  // Реинвестирование (CLIENT_FLOW_PLAN §4.4): форма открывается с суммой пришедших денег
  // и банком, куда они пришли.
  const reinvestFrom = searchParams.get("reinvest");
  const [amount, setAmount] = useState(() => searchParams.get("amount") ?? "");
  const [date, setDate] = useState(todayIsoDate);
  const [invested, setInvested] = useState("");
  const [institution, setInstitution] = useState(() => searchParams.get("institution") ?? "");
  const [currency, setCurrency] = useState(() => {
    const fromQuery = searchParams.get("currency");
    return fromQuery && ["RUB", "USD", "CNY"].includes(fromQuery) ? fromQuery : "RUB";
  });
  const [details, setDetails] = useState<ProductDetails>(emptyProductDetails);
  const [file, setFile] = useState<File | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  // §34: статус асинхронной операции виден пользователю — очередь и распознавание
  // различаются, потому что документ может ждать освободившегося воркера.
  const [ocrStage, setOcrStage] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const updateDetail = <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) =>
    setDetails((current) => ({ ...current, [key]: value }));
  const resetWizard = () => {
    setStep(1);
    setType(null);
    setName("");
    setAmount("");
    setDate(todayIsoDate());
    setInvested("");
    setInstitution("");
    setCurrency("RUB");
    setDetails(emptyProductDetails);
    setError("");
    setSaved(false);
  };
  const selectType = (value: AssetType) => {
    setType(value);
    setStep(2);
  };
  const goToConfirm = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setStep(3);
  };
  const reconciled = investedCheck(details, invested);
  const submit = async () => {
    if (!type) return;
    if (reconciled?.mismatch) return;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        id: crypto.randomUUID(),
        name,
        type,
        amount: Number(amount),
        invested: reconciled
          ? (reconciled.typed ?? reconciled.expected)
          : Number(invested || amount),
        date,
        institution: institution || "Ручной ввод",
        currency,
        source: "manual",
        ...detailsToPayload(details),
      });
      setSaved(true);
    } catch (submitError) {
      setError(errorText(submitError, "Не удалось сохранить продукт"));
    } finally {
      setSaving(false);
    }
  };
  // §34: распознавание вынесено из HTTP-запроса в фоновый воркер, поэтому загрузка только
  // ставит документ в очередь и возвращает 202, а страница опрашивает его статус.
  async function recognizeScreenshot() {
    if (!file) return;
    setRecognizing(true);
    setOcrStage("Загружаем скриншот...");
    setError("");
    try {
      const uploadResponse = await apiFetch(`${apiUrl}/ocr/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: (() => { const formData = new FormData(); formData.append("image", file); return formData; })(),
      });
      if (uploadResponse.status === 401) {
        onUnauthorized();
        return;
      }
      const uploaded = (await uploadResponse.json()) as {
        error?: string;
        documentId?: string;
        alreadyUploadedAt?: string;
      };
      if (!uploadResponse.ok || !uploaded.documentId) {
        throw new Error(uploaded.error || "Не удалось загрузить изображение");
      }
      setOcrStage("В очереди на распознавание...");
      const result = await waitForOcrResult(uploaded.documentId);
      onOcrComplete({
        documentId: uploaded.documentId,
        date: result.date || new Date().toISOString().slice(0, 10),
        items: result.items || [],
        failures: result.failures || [],
        alreadyUploadedAt: uploaded.alreadyUploadedAt,
      });
    } catch (recognitionError) {
      setError(
        recognitionError instanceof NetworkError
          ? "Не удалось загрузить изображение, попробуйте ещё раз"
          : errorText(recognitionError, "Не удалось распознать изображение"),
      );
    } finally {
      setRecognizing(false);
      setOcrStage("");
    }
  }
  // Опрос статуса документа. Верхняя граница ожидания нужна, чтобы страница не висела
  // бесконечно, если воркер планировщика не запущен: пользователю честно говорим, что
  // обработка продолжается, а результат появится в портфеле сам.
  async function waitForOcrResult(documentId: string) {
    const deadline = Date.now() + OCR_WAIT_LIMIT_MS;
    for (;;) {
      await new Promise((wake) => setTimeout(wake, OCR_POLL_INTERVAL_MS));
      const response = await apiFetch(`${apiUrl}/ocr/documents/${documentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        onUnauthorized();
        throw new Error("Сессия истекла");
      }
      const status = (await response.json()) as {
        error?: string;
        status?: string;
        result?: { date?: string; items?: Product[]; failures?: OcrFailure[] };
      };
      if (!response.ok) throw new Error(status.error || "Не удалось получить статус распознавания");
      if (status.status === "processing") setOcrStage("Распознаём изображение...");
      if (status.status === "failed") throw new Error(status.error || "Не удалось распознать изображение");
      if (status.status === "done") return status.result || {};
      if (Date.now() > deadline) {
        throw new Error("Распознавание занимает дольше обычного. Записи появятся в портфеле, когда обработка завершится.");
      }
    }
  }
  return (
    <Page title="Добавить продукт" subtitle="Ручной ввод или распознавание скриншота" back>
      {reinvestFrom && (
        <div className="demo-note">
          Реинвестирование: «{reinvestFrom}»
          {amount ? ` · ${money(Number(amount))}` : ""}
          {institution ? ` · ${institution}` : ""}. Сумма и банк уже подставлены.
        </div>
      )}
      <div className="mode-switch">
        <button
          className={mode === "manual" ? "selected" : ""}
          onClick={() => setMode("manual")}
          type="button"
        >
          Ручной ввод
        </button>
        <button
          className={mode === "screenshot" ? "selected" : ""}
          onClick={() => setMode("screenshot")}
          type="button"
        >
          Скриншот
        </button>
      </div>
      {mode === "screenshot" && (
        <div className="upload-box">
          <span>▧</span>
          <strong>Загрузите скриншот</strong>
          <small>PNG, JPG до 10 МБ. Распознанные данные сохранятся сразу, без подтверждения — отредактировать их можно будет на экране-сводке.</small>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(event) => {
              setFile(event.target.files?.[0] || null);
              setError("");
            }}
          />
          {file && (
            <>
              <p>{file.name}</p>
              <button
                className="outline-button"
                onClick={() => void recognizeScreenshot()}
                disabled={recognizing}
                type="button"
              >
                {recognizing ? ocrStage || "Распознаём и сохраняем..." : error ? "Попробовать ещё раз" : "Распознать и сохранить"}
              </button>
            </>
          )}
          {error && <small className="form-error">{error}</small>}
        </div>
      )}
      {mode === "manual" && !saved && (
        <>
          <ol className="wizard-steps">
            <li className={step >= 1 ? "done" : ""}>1. Тип</li>
            <li className={step === 2 ? "active" : step > 2 ? "done" : ""}>2. Данные</li>
            <li className={step === 3 ? "active" : ""}>3. Подтверждение</li>
          </ol>
          {step === 1 && (
            <div className="type-grid">
              {wizardTypeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="empty-option type-card"
                  onClick={() => selectType(option.value)}
                >
                  <span className="empty-option-icon">{option.icon}</span>
                  <strong>{option.label}</strong>
                </button>
              ))}
            </div>
          )}
          {step === 2 && type && (
            <form className="modal-form" onSubmit={goToConfirm}>
              <label>
                Название
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Например, ОФЗ 26241"
                  autoFocus
                  required
                />
              </label>
              <label>
                Сумма
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  type="number"
                  min="1"
                  placeholder="100000"
                  required
                />
              </label>
              <label>
                Дата
                <input
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  type="date"
                  required
                />
              </label>
              <div className="wizard-actions">
                <button type="button" className="outline-button" onClick={() => setStep(1)}>
                  Назад
                </button>
                <button type="submit" className="primary-button">
                  Далее
                </button>
              </div>
            </form>
          )}
          {step === 3 && type && (
            <div className="confirm-card">
              <p>
                <strong>{name}</strong>
                <br />
                {wizardTypeOptions.find((option) => option.value === type)?.label ?? type} ·{" "}
                {amount} ₽ · {date}
              </p>
              <InvestedCheckNote check={reconciled} amount={amount} />
              <details className="details-block">
                <summary>Добавить дополнительные детали</summary>
                <div className="details-fields">
                  <label>
                    Банк или брокер
                    <input
                      value={institution}
                      onChange={(event) => setInstitution(event.target.value)}
                      placeholder="Необязательно"
                    />
                  </label>
                  <label>
                    Валюта
                    <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                      <option value="RUB">RUB</option>
                      <option value="USD">USD</option>
                      <option value="CNY">CNY</option>
                    </select>
                  </label>
                  <label>
                    Вложено (сумма покупки)
                    <input
                      value={invested}
                      onChange={(event) => setInvested(event.target.value)}
                      type="number"
                      min="1"
                      placeholder={reconciled ? String(reconciled.expected) : "100000"}
                    />
                  </label>
                  {InstrumentDetailsFieldset({ type, details, onChange: updateDetail })}
                </div>
              </details>
              {error && <small className="form-error">{error}</small>}
              <div className="wizard-actions">
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => setStep(2)}
                  disabled={saving}
                >
                  Назад
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void submit()}
                  disabled={saving || Boolean(reconciled?.mismatch)}
                >
                  {saving ? "Сохраняем..." : "Добавить"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {mode === "manual" && saved && (
        <div className="confirm-card">
          <p>
            <strong>Продукт добавлен в портфель.</strong>
          </p>
          <div className="confirm-actions">
            <button type="button" className="outline-button" onClick={resetWizard}>
              Добавить ещё один актив
            </button>
            <button type="button" className="primary-button" onClick={() => navigate("/portfolio")}>
              Перейти к портфелю
            </button>
          </div>
        </div>
      )}
    </Page>
  );
}
function EditProductPage({
  products,
  onSubmit,
}: {
  products: Product[];
  onSubmit: (product: Product) => void;
}) {
  const { id } = useParams();
  const product = products.find((item) => item.id === id);
  const [name, setName] = useState(product?.name || "");
  const [type, setType] = useState<AssetType>(product?.type || "Облигации");
  const [amount, setAmount] = useState(String(product?.amount || ""));
  const [invested, setInvested] = useState(String(product?.invested || ""));
  const [institution, setInstitution] = useState(product?.institution || "");
  const [currency, setCurrency] = useState(product?.currency || "RUB");
  const [details, setDetails] = useState<ProductDetails>(productToDetails(product));
  useEffect(() => {
    if (!product) return;
    setName(product.name);
    setType(product.type);
    setAmount(String(product.amount));
    setInvested(String(product.invested));
    setInstitution(product.institution);
    setCurrency(product.currency);
    setDetails(productToDetails(product));
    // Перезаполняется и когда запись пришла позже первого рендера (прямая ссылка, BUG-18).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, Boolean(product)]);
  if (!product) return <MissingRecord to="/products" />;
  const updateDetail = <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) =>
    setDetails((current) => ({ ...current, [key]: value }));
  const reconciled = investedCheck(details, invested);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reconciled?.mismatch) return;
    onSubmit({
      ...product,
      name,
      type,
      amount: Number(amount),
      invested: reconciled
        ? (reconciled.typed ?? reconciled.expected)
        : Number(invested || amount),
      institution: institution || "Ручной ввод",
      currency,
      ...detailsToPayload(details),
    });
  };
  return (
    <Page title="Редактировать инструмент" subtitle={product.name} back>
      <form className="modal-form" onSubmit={submit}>
        <label>
          Название
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        <label>
          Текущая стоимость
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            type="number"
            min="1"
            required
          />
        </label>
        <label>
          Вложено (сумма покупки)
          <input
            value={invested}
            onChange={(event) => setInvested(event.target.value)}
            type="number"
            min="1"
          />
        </label>
        <label>
          Банк или брокер
          <input
            value={institution}
            onChange={(event) => setInstitution(event.target.value)}
          />
        </label>
        <label>
          Валюта
          <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
            <option value="RUB">RUB</option>
            <option value="USD">USD</option>
            <option value="CNY">CNY</option>
          </select>
        </label>
        <label>
          Тип продукта
          <select
            value={type}
            onChange={(event) => setType(event.target.value as AssetType)}
          >
            {Object.keys(typeColors).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <InstrumentDetailsFields type={type} details={details} onChange={updateDetail} />
        <InvestedCheckNote check={reconciled} amount={amount} />
        <button className="primary-button" type="submit" disabled={Boolean(reconciled?.mismatch)}>
          Сохранить изменения
        </button>
      </form>
    </Page>
  );
}
function DeleteProductPage({
  products,
  onConfirm,
}: {
  products: Product[];
  onConfirm: (id: string, returnTo: string) => void;
}) {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  // Куда вернуться после удаления или отмены — например, на сводку OCR (BUG-14). Только
  // внутренние пути приложения: внешний адрес в параметре — открытый редирект.
  const requested = searchParams.get("return") || "";
  const returnTo = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/products";
  const product = products.find((item) => item.id === id);
  if (!product || !id) return <MissingRecord to={returnTo} />;
  return (
    <Page title="Удалить инструмент" subtitle="Это действие нельзя отменить" back>
      <div className="confirm-card">
        <p>
          Удалить <strong>{product.name}</strong> ({valueText(valuationOf(product).value)})
          из портфеля?
        </p>
        <div className="confirm-actions">
          <Link className="outline-button" to={returnTo}>
            Отмена
          </Link>
          <button
            className="delete-button primary"
            onClick={() => onConfirm(id, returnTo)}
            type="button"
          >
            Удалить безвозвратно
          </button>
        </div>
      </div>
    </Page>
  );
}
function DeleteAccountPage({ onConfirm }: { onConfirm: () => void }) {
  return (
    <Page title="Удалить аккаунт" subtitle="Это действие нельзя отменить" back>
      <div className="confirm-card">
        <p>
          Аккаунт и все связанные с ним данные (инструменты, операции,
          выплаты, история портфеля) будут удалены безвозвратно.
        </p>
        <div className="confirm-actions">
          <Link className="outline-button" to="/settings">
            Отмена
          </Link>
          <button
            className="delete-button primary"
            onClick={onConfirm}
            type="button"
          >
            Удалить аккаунт безвозвратно
          </button>
        </div>
      </div>
    </Page>
  );
}
// Сводка распознавания (§40.4). Сразу после загрузки берётся из памяти, по прямой ссылке
// или после F5 (BUG-18) перечитывается с бэкенда по id документа — тот же JSON результата.
function useOcrSummary(current: OcrUploadResult | null, token: string) {
  const { documentId } = useParams();
  const [loaded, setLoaded] = useState<OcrUploadResult | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "missing" | "pending">("idle");
  const inMemory = current && (!documentId || current.documentId === documentId) ? current : null;
  useEffect(() => {
    if (inMemory || !documentId) return;
    let cancelled = false;
    setLoadState("loading");
    void (async () => {
      try {
        const response = await apiFetch(`${apiUrl}/ocr/documents/${documentId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = (await response.json()) as { status?: string; result?: OcrUploadResult };
        if (cancelled) return;
        if (!response.ok || body.status === "failed") return setLoadState("missing");
        if (body.status !== "done" || !body.result) return setLoadState("pending");
        setLoaded({ ...body.result, documentId });
        setLoadState("idle");
      } catch {
        if (!cancelled) setLoadState("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, inMemory, token]);
  return { documentId, summary: inMemory ?? loaded, loadState };
}
function OcrSummaryPlaceholder({ documentId, loadState }: { documentId?: string; loadState: string }) {
  if (!documentId || loadState === "missing") return <Navigate to="/products" replace />;
  return (
    <Page title="Добавлено со скриншота" subtitle="Сводка распознавания" back>
      <p className="muted">
        {loadState === "pending"
          ? "Скриншот ещё обрабатывается — обновите страницу через несколько секунд."
          : "Загружаем результат распознавания…"}
      </p>
    </Page>
  );
}
// Записи сводки, которые всё ещё есть в портфеле, — в актуальном виде (после правки
// название и сумма уже другие, удалённые строки из списка уходят). До загрузки данных
// портфеля показываются как распознаны.
function currentOcrItems(summary: OcrUploadResult, products: Product[], loaded: boolean) {
  if (!loaded) return summary.items;
  return summary.items.flatMap((item) => {
    const product = products.find((candidate) => candidate.id === item.id);
    return product ? [{ ...product, possibleDuplicate: item.possibleDuplicate }] : [];
  });
}
function OcrSummaryPage({
  summary: current,
  products,
  token,
}: {
  summary: OcrUploadResult | null;
  products: Product[];
  token: string;
}) {
  const { documentId, summary, loadState } = useOcrSummary(current, token);
  const dataLoaded = useContext(DataLoadedContext);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const items = summary ? currentOcrItems(summary, products, dataLoaded) : [];
  const paging = usePagedList(items);
  if (!summary) return <OcrSummaryPlaceholder documentId={documentId} loadState={loadState} />;
  const formattedDate = fullDate(summary.date);
  const returnTo = documentId ? `/ocr-summary/${documentId}` : "/products";
  const removedCount = summary.items.length - items.length;
  return (
    <Page
      title={`Добавлено со скриншота от ${formattedDate}`}
      subtitle="Данные сохранены как распознаны. Проверьте каждую запись и поправьте при необходимости."
    >
      {summary.alreadyUploadedAt && (
        <div className="demo-note">
          ⚠ Этот скриншот уже загружался{" "}
          {formatDateTime(summary.alreadyUploadedAt)} — повторно
          он не обрабатывался, новые записи не созданы. Ниже — результат прошлой обработки.
        </div>
      )}
      {removedCount > 0 && (
        <p className="muted ocr-removed-note">
          Удалено из портфеля: {removedCount} из {summary.items.length} распознанных записей.
        </p>
      )}
      {paging.visible.length > 0 && (
        <>
          <div className="product-list">
            {paging.visible.map((item) => {
              const expanded = expandedId === item.id;
              return (
                <div className="list-row" key={item.id}>
                  <button
                    type="button"
                    className="product-row-summary"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : item.id)}
                  >
                    <span className="product-row-line1">
                      <span className="product-row-name">
                        <i className={`legend type-dot ${typeColors[item.type]}`} title={item.type} />
                        <strong>{item.name}</strong>
                      </span>
                      <span className="product-row-sum">{money(item.amount)}</span>
                    </span>
                    <span className="product-row-line2">
                      <span className="muted product-row-meta">
                        {item.institution ? `${item.type} · ${item.institution}` : item.type}
                      </span>
                      {item.possibleDuplicate ? (
                        <span className="danger-text">возможный дубликат</span>
                      ) : (
                        <span className="teal-text">со скриншота</span>
                      )}
                    </span>
                  </button>
                  {expanded && (
                    <div className="list-row-details">
                      {item.possibleDuplicate && (
                        <div className="detail-line">
                          <span className="danger-text">
                            ⚠ Похоже, такой инструмент уже есть в портфеле — проверьте, не дубликат ли это
                          </span>
                        </div>
                      )}
                      <div className="detail-line">
                        <span>Банк / брокер</span>
                        <span>{item.institution} · {item.currency}</span>
                      </div>
                      <div className="detail-line">
                        <span>Вложено</span>
                        <span>{money(item.invested)}</span>
                      </div>
                      <div className="list-row-actions">
                        <Link className="outline-button" to={`/products/${item.id}/edit`}>
                          Редактировать
                        </Link>
                        <Link
                          className="delete-button"
                          to={`/products/${item.id}/delete?return=${encodeURIComponent(returnTo)}`}
                        >
                          Удалить
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <ListPagination
            hasMore={paging.hasMore}
            onLoadMore={paging.loadMore}
            pageSize={paging.pageSize}
            onPageSizeChange={paging.setPageSize}
          />
        </>
      )}
      {summary.failures.length > 0 && (
        <div className="product-list ocr-failures">
          {summary.failures.map((failure) => (
            <div className="list-row" key={failure.filename}>
              <div className="product-row-summary product-row-static">
                <span className="product-row-line1">
                  <span className="product-row-name">
                    <i className="legend type-dot slate" />
                    <strong>Не удалось распознать {failure.filename}</strong>
                  </span>
                </span>
                <span className="product-row-line2">
                  <span className="muted product-row-meta">{failure.reason}</span>
                </span>
              </div>
              <div className="list-row-actions product-row-actions">
                <Link className="outline-button" to="/products/new">
                  Добавить вручную
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
      {!summary.items.length && !summary.failures.length && (
        <p>На этом скриншоте не найдено ни одной записи.</p>
      )}
      <div className="confirm-actions" style={{ marginTop: 24 }}>
        <Link className="primary-button" to="/portfolio">
          Перейти к портфелю
        </Link>
        {documentId && items.length > 0 && (
          <Link className="delete-button" to={`/ocr-summary/${documentId}/delete-all`}>
            Удалить всё распознанное
          </Link>
        )}
      </div>
    </Page>
  );
}
// Подтверждение массового удаления — отдельной страницей, без модалок (§40.7).
function DeleteOcrItemsPage({
  summary: current,
  products,
  token,
  onConfirm,
}: {
  summary: OcrUploadResult | null;
  products: Product[];
  token: string;
  onConfirm: (ids: string[], returnTo: string) => Promise<void>;
}) {
  const { documentId, summary, loadState } = useOcrSummary(current, token);
  const dataLoaded = useContext(DataLoadedContext);
  const [deleting, setDeleting] = useState(false);
  if (!summary || !dataLoaded) return <OcrSummaryPlaceholder documentId={documentId} loadState={loadState} />;
  const items = currentOcrItems(summary, products, true);
  const returnTo = `/ocr-summary/${documentId}`;
  if (!items.length) return <Navigate to={returnTo} replace />;
  return (
    <Page title="Удалить всё распознанное" subtitle="Это действие нельзя отменить" back>
      <div className="confirm-card">
        <p>
          Удалить из портфеля все записи, добавленные с этого скриншота ({items.length})?
        </p>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              {item.name} — {money(item.amount)}
            </li>
          ))}
        </ul>
        <div className="confirm-actions">
          <Link className="outline-button" to={returnTo}>
            Отмена
          </Link>
          <button
            className="delete-button primary"
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              void onConfirm(items.map((item) => item.id), returnTo).finally(() => setDeleting(false));
            }}
            type="button"
          >
            {deleting ? "Удаляем..." : `Удалить записи (${items.length})`}
          </button>
        </div>
      </div>
    </Page>
  );
}
function EditPaymentPage({
  payments,
  products,
  onSubmit,
}: {
  payments: Payment[];
  products: Product[];
  onSubmit: (payment: Payment) => void;
}) {
  const { id } = useParams();
  const payment = payments.find((item) => item.id === id);
  const [title, setTitle] = useState(payment?.title || "");
  const [amount, setAmount] = useState(String(payment?.amount || ""));
  const [date, setDate] = useState(payment?.date || "");
  const [type, setType] = useState<PayoutType>(payment?.type || "OTHER");
  const [status, setStatus] = useState<PayoutStatus>(
    payment?.status || "expected",
  );
  const [positionId, setPositionId] = useState(
    payment ? payoutPositionId(payment, products) : "",
  );
  useEffect(() => {
    if (!payment) return;
    setTitle(payment.title);
    setAmount(String(payment.amount));
    setDate(payment.date);
    setType(payment.type);
    setStatus(payment.status);
    setPositionId(payoutPositionId(payment, products));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, Boolean(payment)]);
  if (!payment) return <MissingRecord to="/payments" />;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Привязку отправляем, только если её поменяли: у выплаты по уже удалённой позиции
    // список показывает «Без привязки», и сохранение других полей не должно её отвязать.
    const linkChanged = positionId !== payoutPositionId(payment, products);
    onSubmit({
      ...payment,
      title,
      amount: Number(amount),
      date,
      type,
      status,
      ...(linkChanged ? payoutLinkFields(positionId, products) : {}),
    });
  };
  return (
    <Page title="Редактировать выплату" subtitle={payment.title} back>
      <form className="modal-form" onSubmit={submit}>
        <label>
          Название
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </label>
        <PayoutInstrumentField products={products} value={positionId} onChange={setPositionId} />
        <label>
          Сумма
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            type="number"
            min="1"
            required
          />
        </label>
        <label>
          Дата выплаты
          <input
            value={date}
            onChange={(event) => setDate(event.target.value)}
            type="date"
            required
          />
        </label>
        <label>
          Тип выплаты
          <select
            value={type}
            onChange={(event) => setType(event.target.value as PayoutType)}
          >
            {Object.entries(payoutTypeLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Статус
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as PayoutStatus)}
          >
            {Object.entries(payoutStatusLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="primary-button" type="submit">
          Сохранить изменения
        </button>
      </form>
    </Page>
  );
}
function DeletePaymentPage({
  payments,
  onConfirm,
}: {
  payments: Payment[];
  onConfirm: (id: string) => void;
}) {
  const { id } = useParams();
  const payment = payments.find((item) => item.id === id);
  if (!payment || !id) return <MissingRecord to="/payments" />;
  return (
    <Page title="Удалить выплату" subtitle="Это действие нельзя отменить" back>
      <div className="confirm-card">
        <p>
          Удалить <strong>{payment.title}</strong> ({payoutMoney(payment)}) из
          календаря выплат?
        </p>
        <div className="confirm-actions">
          <Link className="outline-button" to="/payments">
            Отмена
          </Link>
          <button
            className="delete-button primary"
            onClick={() => onConfirm(id)}
            type="button"
          >
            Удалить безвозвратно
          </button>
        </div>
      </div>
    </Page>
  );
}
// Выбор инструмента для выплаты (§22, BUG-23). Необязательный, но видимый: без него
// дивиденд по акции остаётся «ничьим» и не попадает ни в карточку, ни в фильтр.
function PayoutInstrumentField({
  products,
  value,
  onChange,
}: {
  products: Product[];
  value: string;
  onChange: (positionId: string) => void;
}) {
  return (
    <label>
      Инструмент
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Без привязки к инструменту</option>
        {products
          .filter((product) => product.type !== "Деньги")
          .map((product) => (
            <option value={product.id} key={product.id}>
              {product.name}
              {product.institution ? ` · ${product.institution}` : ""}
            </option>
          ))}
      </select>
    </label>
  );
}
// Позиция, к инструменту которой уже привязана выплата: на том же счёте, если такая есть.
function payoutPositionId(payment: Payment, products: Product[]) {
  if (!payment.instrumentId) return "";
  const candidates = products.filter((product) => product.instrumentId === payment.instrumentId);
  return (
    candidates.find((product) => product.accountId === payment.accountId) ?? candidates[0]
  )?.id ?? "";
}
// Поля привязки для запроса: positionId — бэкенду, instrumentId — офлайн-режиму без бэкенда.
function payoutLinkFields(positionId: string, products: Product[]) {
  return {
    positionId,
    instrumentId: products.find((product) => product.id === positionId)?.instrumentId,
  };
}
function PaymentFormPage({
  products,
  onSubmit,
}: {
  products: Product[];
  onSubmit: (payment: Payment) => void;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [type, setType] = useState<PayoutType>("OTHER");
  const [status, setStatus] = useState<PayoutStatus>("expected");
  // ?position= — переход «Добавить выплату» из карточки инструмента.
  const [searchParams] = useSearchParams();
  const [positionId, setPositionId] = useState(() => {
    const requested = searchParams.get("position") ?? "";
    return products.some((product) => product.id === requested) ? requested : "";
  });
  // Задним числом вводить выплаты законно — предупреждаем, но не запрещаем (BUG-22).
  const pastExpected = Boolean(date) && date < todayIsoDate() && status === "expected";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      id: crypto.randomUUID(),
      title,
      amount: Number(amount),
      date,
      type,
      status,
      currency: "RUB",
      ...payoutLinkFields(positionId, products),
    });
  };
  return (
    <Page title="Добавить выплату" subtitle="Купон, дивиденд или процент по вкладу" back>
      <form className="modal-form" onSubmit={submit}>
        <label>
          Название
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Купон или дивиденд"
            required
          />
        </label>
        <PayoutInstrumentField products={products} value={positionId} onChange={setPositionId} />
        <label>
          Сумма
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            type="number"
            min="1"
            required
          />
        </label>
        <label>
          Дата выплаты
          <input
            value={date}
            onChange={(event) => setDate(event.target.value)}
            type="date"
            required
          />
        </label>
        <label>
          Тип выплаты
          <select
            value={type}
            onChange={(event) => setType(event.target.value as PayoutType)}
          >
            {Object.entries(payoutTypeLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Статус
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as PayoutStatus)}
          >
            {Object.entries(payoutStatusLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {pastExpected && (
          <small className="danger-text">
            ⚠ Дата уже прошла. Выплата со статусом «Ожидается» попадёт в группу
            «Просрочено» и не войдёт в ожидаемые суммы. Если деньги уже пришли —
            выберите статус «Получено».
          </small>
        )}
        <button className="primary-button" type="submit">
          Добавить в календарь
        </button>
      </form>
    </Page>
  );
}
function TransactionFormPage({
  products,
  onSubmit,
}: {
  products: Product[];
  onSubmit: (transaction: Transaction) => void;
}) {
  const [searchParams] = useSearchParams();
  const [type, setType] = useState<TransactionType>("BUY");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  // Из карточки инструмента операция открывается уже привязанной к нему.
  const [positionId, setPositionId] = useState(
    () => products.find((product) => product.id === searchParams.get("position"))?.id || products[0]?.id || "",
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      id: crypto.randomUUID(),
      title: title || transactionTypeLabels[type],
      amount: Number(amount),
      date,
      type,
      positionId: tradesPosition ? positionId : undefined,
      quantity: tradesPosition && quantity ? Number(quantity) : undefined,
      price: tradesPosition && price ? Number(price) : undefined,
    });
  };
  const tradesPosition = POSITION_TRANSACTION_TYPES.includes(type);
  // Сумма покупки по умолчанию — количество × цена, пока пользователь не ввёл её сам.
  const suggestAmount = (nextQuantity: string, nextPrice: string) => {
    const total = Number(nextQuantity) * Number(nextPrice);
    if (total > 0) setAmount(String(Math.round(total * 100) / 100));
  };
  return (
    <Page title="Новая операция" subtitle="Покупка, продажа, пополнение или выплата" back>
      <form className="modal-form" onSubmit={submit}>
        <label>
          Тип операции
          <select
            value={type}
            onChange={(event) =>
              setType(event.target.value as TransactionType)
            }
          >
            {Object.entries(transactionTypeLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {POSITION_TRANSACTION_TYPES.includes(type) && (
          <label>
            Инструмент
            <select
              value={positionId}
              onChange={(event) => setPositionId(event.target.value)}
            >
              {products
                .filter((product) => product.type !== "Деньги")
                .map((product) => (
                  <option value={product.id} key={product.id}>
                    {product.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        {tradesPosition && (
          <div className="form-row">
            <label>
              Количество, шт.
              <input
                value={quantity}
                onChange={(event) => {
                  setQuantity(event.target.value);
                  suggestAmount(event.target.value, price);
                }}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="Необязательно"
              />
            </label>
            <label>
              Цена за штуку
              <input
                value={price}
                onChange={(event) => {
                  setPrice(event.target.value);
                  suggestAmount(quantity, event.target.value);
                }}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="Необязательно"
              />
            </label>
          </div>
        )}
        <label>
          Название
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Например, Покупка ОФЗ"
          />
        </label>
        <label>
          Сумма
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            type="number"
            min="1"
            step="any"
            required
          />
        </label>
        <label>
          Дата
          <input
            value={date}
            onChange={(event) => setDate(event.target.value)}
            type="date"
            required
          />
        </label>
        <button className="primary-button" type="submit">
          Провести операцию
        </button>
      </form>
    </Page>
  );
}
function EditTransactionPage({
  transactions,
  products,
  onSubmit,
}: {
  transactions: Transaction[];
  products: Product[];
  onSubmit: (transaction: Transaction) => void;
}) {
  const { id } = useParams();
  const transaction = transactions.find((item) => item.id === id);
  const [type, setType] = useState<TransactionType>(
    transaction?.type || "BUY",
  );
  const [title, setTitle] = useState(transaction?.title || "");
  const [amount, setAmount] = useState(String(transaction?.amount || ""));
  const [date, setDate] = useState(transaction?.date || "");
  const [positionId, setPositionId] = useState(
    transaction?.positionId || products[0]?.id || "",
  );
  useEffect(() => {
    if (!transaction) return;
    setType(transaction.type);
    setTitle(transaction.title);
    setAmount(String(transaction.amount));
    setDate(transaction.date);
    setPositionId(transaction.positionId || products[0]?.id || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, Boolean(transaction)]);
  if (!transaction) return <MissingRecord to="/transactions" />;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      ...transaction,
      title: title || transactionTypeLabels[type],
      amount: Number(amount),
      date,
      type,
      positionId: POSITION_TRANSACTION_TYPES.includes(type)
        ? positionId
        : undefined,
    });
  };
  return (
    <Page title="Редактировать операцию" subtitle={transaction.title} back>
      <form className="modal-form" onSubmit={submit}>
        <label>
          Тип операции
          <select
            value={type}
            onChange={(event) =>
              setType(event.target.value as TransactionType)
            }
          >
            {Object.entries(transactionTypeLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {POSITION_TRANSACTION_TYPES.includes(type) && (
          <label>
            Инструмент
            <select
              value={positionId}
              onChange={(event) => setPositionId(event.target.value)}
            >
              {products
                .filter((product) => product.type !== "Деньги")
                .map((product) => (
                  <option value={product.id} key={product.id}>
                    {product.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Название
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Например, Покупка ОФЗ"
          />
        </label>
        <label>
          Сумма
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            type="number"
            min="1"
            required
          />
        </label>
        <label>
          Дата
          <input
            value={date}
            onChange={(event) => setDate(event.target.value)}
            type="date"
            required
          />
        </label>
        <button className="primary-button" type="submit">
          Сохранить изменения
        </button>
      </form>
    </Page>
  );
}
function DeleteTransactionPage({
  transactions,
  onConfirm,
}: {
  transactions: Transaction[];
  onConfirm: (id: string) => void;
}) {
  const { id } = useParams();
  const transaction = transactions.find((item) => item.id === id);
  if (!transaction || !id) return <MissingRecord to="/transactions" />;
  return (
    <Page title="Удалить операцию" subtitle="Это действие нельзя отменить" back>
      <div className="confirm-card">
        <p>
          Удалить операцию <strong>{transaction.title}</strong> (
          {money(transaction.amount)})?
          {POSITION_TRANSACTION_TYPES.includes(transaction.type) &&
            " Позиция инструмента будет пересчитана."}
        </p>
        <div className="confirm-actions">
          <Link className="outline-button" to="/transactions">
            Отмена
          </Link>
          <button
            className="delete-button primary"
            onClick={() => onConfirm(id)}
            type="button"
          >
            Удалить безвозвратно
          </button>
        </div>
      </div>
    </Page>
  );
}

export default AppMvp;

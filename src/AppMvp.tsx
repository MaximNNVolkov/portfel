import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
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
  capitalization?: boolean;
  /** Вклад продлевается сам — не закрывается в дату окончания и не ждёт возврата тела (Т30). */
  autoProlongation?: boolean;
  termEndDate?: string;
  interestPayoutFrequency?: string;
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
  /** НКД облигации или начисленные, но не выплаченные проценты вклада. */
  accruedInterest?: number | null;
};
// Необязательные параметры вклада и параметры выпуска облигации. У бумаг остальное —
// название, ISIN, номинал, цена — приходит с MOEX и руками не вводится.
type ProductDetails = {
  rate: string;
  termEndDate: string;
  interestPayoutFrequency: string;
  capitalization: boolean;
  autoProlongation: boolean;
  couponRate: string;
  couponDate: string;
  maturityDate: string;
  ofertaDate: string;
};
const emptyProductDetails: ProductDetails = {
  rate: "",
  termEndDate: "",
  interestPayoutFrequency: "",
  capitalization: false,
  autoProlongation: false,
  couponRate: "",
  couponDate: "",
  maturityDate: "",
  ofertaDate: "",
};
function productToDetails(product?: Product): ProductDetails {
  return {
    rate: product?.rate !== undefined ? String(product.rate) : "",
    termEndDate: product?.termEndDate || "",
    interestPayoutFrequency: frequencyLabel(product?.interestPayoutFrequency) || "",
    capitalization: product?.capitalization || false,
    autoProlongation: product?.autoProlongation || false,
    couponRate: product?.couponRate !== undefined ? String(product.couponRate) : "",
    couponDate: product?.couponDate || "",
    maturityDate: product?.maturityDate || "",
    ofertaDate: product?.ofertaDate || "",
  };
}
const optionalNumberText = (value: string) => (value.trim() ? Number(value) : undefined);
// Пустая строка у даты — «очистить поле»: сервер превращает её в отсутствие даты.
function depositPayload(details: ProductDetails) {
  return {
    rate: optionalNumberText(details.rate),
    termEndDate: details.termEndDate,
    interestPayoutFrequency: details.interestPayoutFrequency,
    capitalization: details.capitalization,
    autoProlongation: details.autoProlongation,
  };
}
function bondPayload(details: ProductDetails) {
  return {
    couponRate: optionalNumberText(details.couponRate),
    couponDate: details.couponDate,
    maturityDate: details.maturityDate,
    ofertaDate: details.ofertaDate,
  };
}
// Бумага с Московской биржи (GET /market-data/securities/:secid): то, что пользователь
// не вводит руками. offline — биржа не ответила, известен только введённый тикер.
// unlisted — бумаги на бирже нет (внебиржевой ПИФ, частная облигация, Т35): запись
// сохраняется по названию, количеству и цене покупки, как ручной продукт.
type MoexSecurity = {
  secid: string;
  name: string;
  shortName: string;
  isin?: string;
  group: "share" | "bond" | "fund";
  currency: string;
  price: number | null;
  accruedInterest: number | null;
  nominal?: number;
  couponRate?: number;
  nextCouponDate?: string;
  maturityDate?: string;
  offerDate?: string;
  offline?: boolean;
  unlisted?: boolean;
};
type MoexSearchItem = Pick<MoexSecurity, "secid" | "shortName" | "name" | "isin" | "group">;
const moexGroupTypes: Record<MoexSecurity["group"], AssetType> = { share: "Акции", bond: "Облигации", fund: "Фонды" };
const moexGroupLabels: Record<MoexSecurity["group"], string> = { share: "акция", bond: "облигация", fund: "фонд" };
const securityPriceText = (value: number, currency: string) =>
  currency === "RUB"
    ? preciseMoney(value)
    : `${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
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
  positionId?: string | null;
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
  // Несколько скриншотов за раз (Т37) — их id через запятую в одном адресе.
  documentId?: string;
  // Сколько файлов в загрузке и какие из них уже загружались раньше (BUG-15).
  fileCount?: number;
  repeatedFiles?: string[];
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
  baseCurrency?: string;
  invested: number;
  profit: number;
  profitPercent: number | null;
  /** §10.6: изменение цены + полученные выплаты − комиссии − налоги. Главный результат. */
  financialResult?: number | null;
  returnPercent?: number | null;
  valueChange?: number | null;
  /** Реализованный результат: продажи и погашения минус вложенное в них (§10.2). */
  realized?: number;
  commissions?: number;
  taxes?: number;
  expected: number;
  // Ожидались, но дата прошла — в «Ожидается» не входят (BUG-22).
  overdue: number;
  paid: number;
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

const navItems = [
  ["Портфель", "◈", "/portfolio"],
  ["Инструменты", "▦", "/products"],
  ["Операции", "↕", "/transactions"],
  ["Выплаты", "◷", "/payments"],
  ["Аналитика", "⌁", "/analytics"],
  ["Интеграции", "⇄", "/integrations"],
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
// Пополнения и снятия больше не заводятся (docs/CLAUDE.md): старые записи этих типов
// показываются и удаляются, но в выборе типа новой операции их нет.
const LEGACY_TRANSACTION_TYPES: TransactionType[] = ["DEPOSIT", "WITHDRAW"];
const transactionTypeOptions = (current?: TransactionType) =>
  Object.entries(transactionTypeLabels)
    .filter(([value]) => value === current || !LEGACY_TRANSACTION_TYPES.includes(value as TransactionType))
    .map(([value, label]) => (
      <option value={value} key={value}>
        {label}
      </option>
    ));
const POSITION_TRANSACTION_TYPES: TransactionType[] = ["BUY", "SELL"];
// Доход можно (но не обязательно) привязать к инструменту — тогда он виден в его карточке.
const INCOME_TRANSACTION_TYPES: TransactionType[] = ["COUPON", "DIVIDEND", "INTEREST"];
const CASH_CREDIT_TYPES: TransactionType[] = [
  "COUPON",
  "DIVIDEND",
  "INTEREST",
  "REDEMPTION",
];
const CASH_DEBIT_TYPES: TransactionType[] = ["FEE", "TAX"];
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
  if (transaction.type === "BUY") shift(transaction.positionId ?? undefined, amount);
  if (transaction.type === "SELL") shift(transaction.positionId ?? undefined, -amount);
  if (CASH_CREDIT_TYPES.includes(transaction.type)) shift(cashId, amount);
  if (CASH_DEBIT_TYPES.includes(transaction.type)) shift(cashId, -amount);
  return next;
}
// Суммы портфеля приходят в базовой валюте (§13) — знак берётся из неё, а не всегда «₽»
// (тестер: портфель в USD показывался в рублях). Выставляется при каждой новой сводке.
const currencySigns: Record<string, string> = { RUB: "₽", USD: "$", CNY: "¥" };
let baseCurrencySign = "₽";
function setBaseCurrencySign(currency: string | undefined) {
  baseCurrencySign = (currency && currencySigns[currency]) || currency || "₽";
}
const money = (value: number) =>
  `${baseCurrencySign} ${Math.round(value).toLocaleString("ru-RU")}`;
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
const payoutMoney = (payment: { amount: number; currency?: string }) =>
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
  // Ноль — нейтральный: зелёный «+0,0%» читается как прибыль (§40.6).
  const zero = Math.round(pnl) === 0;
  const positive = pnl >= 0;
  const sign = positive && !zero ? "+" : "";
  return {
    className: zero ? "muted" : positive ? "teal-text" : "danger-text",
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
const signedMoney = (value: number, display: (value: number) => string) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${display(Math.abs(value))}`;
// Проценты везде с одним знаком после запятой (критик К19): рядом стояли «−3,98%» и «−11,4%».
// Меньше 0,05% — ноль без знака, чтобы не было «+0,0%».
const signedPercent = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(1).replace(".", ",")}%`;
};
// Главный результат портфеля (§10.6) вместо «стоимость минус вложено»: для портфеля на
// купонах и вкладах разница — всё равно что показать убыток вместо дохода.
function portfolioResult(summary: PortfolioSummary) {
  const result = summary.financialResult ?? summary.profit;
  const percent = summary.financialResult !== undefined ? summary.returnPercent ?? null : summary.profitPercent;
  const tone = Math.round(result) > 0 ? "positive" : Math.round(result) < 0 ? "negative" : "neutral";
  return { result, percent, tone, invested: summary.invested };
}
// Разрез, в котором ни одна позиция не оценена (например, только валюта без курса ЦБ),
// стоит «Оценка недоступна», а не «₽ 0 · 0% портфеля» (§7.3).
const unvalued = (item: { positions: number; priceUnavailable: number }) =>
  item.positions > 0 && item.priceUnavailable >= item.positions;
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
// Строки блока со своей пагинацией (20 + «Загрузить ещё», §40.3): у каждого блока
// свой счёт, свёрнутый сосед не съедает первые строки этого (П29).
function PagedRows<T>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const { visible, hasMore, loadMore, pageSize, setPageSize } = usePagedList(items);
  return (
    <>
      <div className="product-list">{visible.map(render)}</div>
      <ListPagination hasMore={hasMore} onLoadMore={loadMore} pageSize={pageSize} onPageSizeChange={setPageSize} />
    </>
  );
}
// Сворачиваемые блоки списков (П29): длинную категорию можно убрать, чтобы не листать.
// Свёрнутые блоки живут в адресе (?fold=…) — «назад» из карточки возвращает список
// в том же виде (§40.7).
function useFolded() {
  const [searchParams, setSearchParams] = useSearchParams();
  const folded = new Set((searchParams.get("fold") ?? "").split(",").filter(Boolean));
  function toggle(key: string) {
    const next = new Set(folded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    const params = new URLSearchParams(searchParams);
    if (next.size > 0) params.set("fold", [...next].join(","));
    else params.delete("fold");
    setSearchParams(params, { replace: true });
  }
  return { isFolded: (key: string) => folded.has(key), toggle };
}
function FoldSection({
  title,
  dot,
  count,
  total,
  folded,
  onToggle,
  className,
  children,
}: {
  title: string;
  dot?: string;
  count?: number;
  total?: ReactNode;
  folded: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`fold-section${className ? ` ${className}` : ""}${folded ? " folded" : ""}`}>
      <button type="button" className="fold-header" aria-expanded={!folded} onClick={onToggle}>
        <span className="fold-chevron" aria-hidden="true" />
        {dot && <i className={`legend type-dot ${dot}`} />}
        <span className="fold-title">
          {title}
          {count !== undefined && <span className="fold-count">{count}</span>}
        </span>
        {total !== undefined && <span className="fold-total">{total}</span>}
      </button>
      {!folded && <div className="fold-body">{children}</div>}
    </section>
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
                <span className="product-row-sum">{unvalued(item) ? "Оценка недоступна" : display(item.value)}</span>
              </span>
              <span className="product-row-line2 product-row-line2-flush">
                <span className="muted product-row-meta">
                  {`${item.positions} ${pluralInstruments(item.positions)}`}
                  {!unvalued(item) && ` · ${Math.round(item.share ?? 0)}% портфеля`}
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
const STRUCTURE_CUTS = { type: "По типам", bank: "По банкам", currency: "По валютам" } as const;
type StructureCut = keyof typeof STRUCTURE_CUTS;
const currencyNames: Record<string, string> = { RUB: "Рубли", USD: "Доллары", CNY: "Юани" };
// Разрез по валютам — byCurrency из /api/portfolio/structure; суммы уже в базовой валюте.
// Фильтра по валюте в списке инструментов нет, поэтому строки без перехода.
function CurrencyList({ items, display }: { items: StructureBreakdown[]; display: (value: number) => string }) {
  return (
    <div className="product-list">
      {items.map((item) => {
        const pnl = pnlDisplay(item.pnl, item.pnlPercent);
        return (
          <div className="list-row" key={item.key}>
            <div className="product-row-summary product-row-static">
              <span className="product-row-line1">
                <span className="product-row-name">
                  <strong>{currencyNames[item.key] ?? item.key}</strong>
                </span>
                <span className="product-row-sum">{unvalued(item) ? "Оценка недоступна" : display(item.value)}</span>
              </span>
              <span className="product-row-line2 product-row-line2-flush">
                <span className="muted product-row-meta">
                  {item.key} · {item.positions} {pluralPositions(item.positions)}
                  {!unvalued(item) && item.share !== null && ` · ${Math.round(item.share)}% портфеля`}
                  {item.priceUnavailable > 0 && <span className="danger-text"> · без цены: {item.priceUnavailable}</span>}
                </span>
                <span className={pnl.className}>{pnl.percentText}</span>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
function pluralPositions(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "позиция";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "позиции";
  return "позиций";
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
  // До ответа сервера портфель пуст, а не демонстрационный: выдуманные ₽ 1,5 млн при
  // сбое загрузки новый пользователь принимал за свои данные (тестер, P1).
  const [products, setProducts] = useState<Product[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
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
  // Разрез «Где хранится» считается на бэкенде; null — ещё не загружен или нет связи
  // (тогда блок на главной не показывается, а не врёт пустотой).
  const [loadedStructure, setStructure] = useState<PortfolioStructure | null>(null);
  const structure = apiOnline ? loadedStructure : null;
  const storage = structure?.byProvider ?? null;
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
        setLoadError(false);
        setDataLoaded(true);
      } catch {
        // Без сервера портфель не показывается и не правится: локальная копия в браузере
        // расходилась с сервером, а добавленное в ней пропадало (тестер, P1).
        setLoadError(true);
      }
    }
    void loadPortfolio();
  }, [token, reloadKey]);
  // Раньше портфель целиком копировался в localStorage и оставался там после выхода и
  // удаления аккаунта (тестер, P2) — стираем старую копию.
  useEffect(() => {
    localStorage.removeItem(storageKey);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);
  // Любая правка позиций, выплат или статуса брокера меняет разрез по банкам —
  // перезапрашиваем его вслед за основными данными.
  useEffect(() => {
    if (!apiOnline || !token) return;
    let cancelled = false;
    void apiFetch(`${apiUrl}/portfolio/structure`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (structureResponse) => {
        if (cancelled) return;
        setStructure(structureResponse.ok ? ((await structureResponse.json()) as PortfolioStructure) : null);
      })
      .catch(() => {
        if (!cancelled) setStructure(null);
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
  // Одно и то же сохранение не запускается повторно, пока первое не закончилось: двойной
  // клик по «Провести операцию» создавал две покупки (тестер, P1). Ключ — текст ошибки,
  // он у каждого действия свой, а сами функции пересоздаются на каждом рендере.
  const inFlight = useRef(new Set<string>());
  function withErrorToast<A extends unknown[]>(
    action: (...args: A) => Promise<void>,
    fallback: string,
  ) {
    return async (...args: A) => {
      if (inFlight.current.has(fallback)) return;
      inFlight.current.add(fallback);
      try {
        await action(...args);
      } catch (error) {
        setToast(errorText(error, fallback));
      } finally {
        inFlight.current.delete(fallback);
      }
    };
  }
  // Сводка и история меняются вместе: иначе под графиком оставалось старое «Сейчас»,
  // а общая стоимость уже новая (тестировщик Т21).
  async function refreshSummary() {
    const [response, historyResponse] = await Promise.all([
      apiFetch(`${apiUrl}/portfolio/summary`, { headers: authHeaders }),
      apiFetch(`${apiUrl}/portfolio/history`, { headers: authHeaders }),
    ]);
    if (response.ok) setSummary((await response.json()) as PortfolioSummary);
    if (historyResponse.ok) setHistory((await historyResponse.json()) as Snapshot[]);
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
      // Сервер при сохранении строит прогноз выплат (проценты и возврат вклада, купоны) —
      // без перечитывания «Выплаты» показывали старый список до перезагрузки страницы.
      await Promise.all([refreshSummary(), refreshPayments()]);
    }
    setProducts((current) => [...current, product]);
    setToast("Продукт добавлен в портфель");
    return product;
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
  async function refreshTransactions() {
    const response = await apiFetch(`${apiUrl}/transactions`, { headers: authHeaders });
    if (response.ok) setTransactions((await response.json()) as Transaction[]);
  }
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
        // Вместе с продуктом сервер удаляет его операции и выплаты (Т28).
        await Promise.all([refreshSummary(), refreshPayments(), refreshTransactions()]);
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
      // Новые ставка, срок, купон или количество — прогноз выплат пересчитан на сервере.
      // У закрытого продукта пересчитываются и выплаты при закрытии с их операциями (Т29).
      await Promise.all([refreshSummary(), refreshPayments(), refreshTransactions()]);
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
      void refreshPayments();
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
    // Экран входа после удаления подтверждает, что удаление прошло (тестер Т41).
    navigate("/portfolio", { state: { accountDeleted: true } });
  }

  // Ссылка из письма восстановления пароля должна работать независимо от того, есть ли
  // в этом браузере ещё активная сессия (например, письмо открыто на другом устройстве),
  // поэтому маршрут проверяется до проверки токена, а не только в неавторизованной ветке.
  setBaseCurrencySign(summary?.baseCurrency);
  if (location.pathname === "/reset-password") return <ResetPasswordPage />;
  if (!token) {
    if (location.pathname === "/forgot-password") return <ForgotPasswordPage />;
    const accountDeleted = Boolean((location.state as { accountDeleted?: boolean } | null)?.accountDeleted);
    return <Login onSubmit={signIn} notice={accountDeleted ? "Аккаунт и все его данные удалены." : undefined} />;
  }
  if (loadError) {
    return (
      <div className="content-wrap load-error">
        <p className="eyebrow">ПОРТФЕЛЬ</p>
        <h1>Не удалось загрузить портфель</h1>
        <p className="muted">Сервер не ответил. Данные хранятся на сервере и никуда не делись — попробуйте ещё раз.</p>
        <div className="wizard-actions">
          <button type="button" className="primary-button" onClick={() => { setLoadError(false); setReloadKey((key) => key + 1); }}>
            Повторить
          </button>
          <button type="button" className="outline-button" onClick={() => void signOut()}>
            Выйти
          </button>
        </div>
      </div>
    );
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
          {navItems.map(([label, icon, path]) => (
            <NavLink
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
              key={label}
              to={path}
            >
              <span className="nav-icon">{icon}</span>
              {label}
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
        {/* На десктопе без статуса брокера шапка пустая — скрываем; на мобильном в ней меню. */}
        <header className={`topbar${apiOnline && brokerStatus?.status !== "connected" && brokerStatus?.status !== "error" ? " topbar-empty" : ""}`}>
          <div className="mobile-brand">
            <span className="brand-mark">✳</span> Капитал
          </div>
          <div className="top-actions">
            {/* Статус в шапке — это статус брокера. Без подключённого брокера «Синхронизировано
                с API» читалось как его статус (П10), поэтому тогда индикатора нет. */}
            {!apiOnline ? (
              <span className="sync-status">
                <span className="sync-dot warn" /> Офлайн-режим · локальные данные
              </span>
            ) : brokerStatus?.status === "connected" || brokerStatus?.status === "error" ? (
              <Link className="sync-status" to="/integrations">
                <span className={`sync-dot${brokerStatus.status === "error" ? " warn" : ""}`} />{" "}
                {brokerStatus.status === "error"
                  ? "Т-Инвестиции · не удалось обновить"
                  : brokerStatus.lastSyncAt
                    ? `Т-Инвестиции · ${formatDateTime(brokerStatus.lastSyncAt)}`
                    : "Т-Инвестиции подключены"}
              </Link>
            ) : null}
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
                storage={storage}
                currencies={structure?.byCurrency ?? null}
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
            element={<EditProductPage
                products={products}
                token={token}
                onUnauthorized={expireSession}
                onSubmit={withErrorToast(updateProduct, "Не удалось сохранить изменения")}
              />}
          />
          <Route
            path="/products/:id/delete"
            element={
              <DeleteProductPage products={products} transactions={transactions} onConfirm={removeProduct} />
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
            path="/integrations"
            element={
              <Integrations token={token} onStatusChange={withErrorToast(refreshBrokerStatus, "Не удалось обновить статус брокера")} onDataChange={withErrorToast(refreshAfterBrokerSync, "Не удалось обновить данные портфеля")} />
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
          <Route path="*" element={<NotFoundPage />} />
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
  storage,
  currencies,
}: {
  summary: PortfolioSummary | null;
  products: Product[];
  payments: Payment[];
  history: Snapshot[];
  hideAmounts: boolean;
  onHide: () => void;
  apiOnline: boolean;
  brokerStatus: BrokerStatus | null;
  storage: StructureBreakdown[] | null;
  currencies: StructureBreakdown[] | null;
}) {
  const dataLoaded = useContext(DataLoadedContext);
  // Разрез структуры (П31): «Категории» и «Где хранится» — один блок с переключателем.
  // Выбор в адресе (?cut=), чтобы «назад» из списка инструментов возвращал тот же разрез.
  const [searchParams, setSearchParams] = useSearchParams();
  const cutParam = searchParams.get("cut");
  const cut: StructureCut =
    cutParam === "bank" && storage?.length ? "bank" : cutParam === "currency" && currencies?.length ? "currency" : "type";
  const availableCuts = (Object.keys(STRUCTURE_CUTS) as StructureCut[]).filter(
    (key) => key === "type" || (key === "bank" ? storage?.length : currencies?.length),
  );
  function selectCut(next: StructureCut) {
    const params = new URLSearchParams(searchParams);
    if (next === "type") params.delete("cut");
    else params.set("cut", next);
    setSearchParams(params, { replace: true });
  }
  const display = (value: number) => (hideAmounts ? "••••••" : money(value));
  const linePath = chartPath(history);
  const areaPath = chartPath(history, true);
  const lastSnapshot = history.at(-1);
  // Кратковременный зазор до первого ответа /api/portfolio/summary (или офлайн-эффекта) —
  // не пересчитываем показатели порталу целиком, просто не даём странице упасть.
  const { total, profit, paid, overdue, groups, valuation } =
    summary ?? localSummary(products, payments);
  const result = portfolioResult(summary ?? localSummary(products, payments));
  // Из чего сложился результат: цена, выплаты, комиссии и налоги — одной строкой.
  const summaryBreakdown = summary?.financialResult !== undefined && summary.financialResult !== null
    ? [
        `цена ${signedMoney(summary.valueChange ?? profit, display)}`,
        paid ? `выплаты ${signedMoney(paid, display)}` : null,
        // Без продаж и погашений слагаемые не сходились с итогом (Т33).
        Math.abs(summary.realized ?? 0) >= 0.5 ? `продажи и погашения ${signedMoney(summary.realized ?? 0, display)}` : null,
        summary.commissions ? `комиссии ${signedMoney(-summary.commissions, display)}` : null,
        summary.taxes ? `налоги ${signedMoney(-summary.taxes, display)}` : null,
      ].filter(Boolean).join(" · ")
    : "";
  const brokerDegraded = brokerStatus?.status === "error";
  const brokerHasCache = brokerDegraded && Boolean(brokerStatus?.lastSyncAt);
  if (!dataLoaded) {
    return (
      <div className="content-wrap">
        <p className="muted">Загружаем портфель…</p>
      </div>
    );
  }
  if (products.length === 0) {
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
          </div>
        </section>
      </div>
    );
  }
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
          {/* Ни одну позицию не удалось оценить (нет цены или курса ЦБ) — это не «0» (§7.3). */}
          {total === 0 && valuation.incomplete ? "Оценка недоступна" : display(total)}
        </div>
        <div className="profit-line">
          <span className={`${result.tone}-pill`}>
            {result.tone === "positive" ? "↗ " : result.tone === "negative" ? "↘ " : ""}
            {signedMoney(result.result, display)}
          </span>
          <strong className={result.percent === null ? "muted" : result.tone === "negative" ? "danger-text" : result.tone === "neutral" ? "muted" : ""}>
            {signedPercent(result.percent)}
          </strong>
          <span className="muted">за всё время</span>
        </div>
        {summaryBreakdown && <p className="muted result-breakdown">{summaryBreakdown}</p>}
        <div className="total-stats">
          <div>
            <span>Вложено</span>
            <strong>{display(result.invested)}</strong>
          </div>
          <div>
            <span>Получено выплат</span>
            <strong>{display(paid)}</strong>
          </div>
        </div>
        {brokerHasCache && (
          <div className="demo-note warn">
            ⚠ Данные неполные: брокер «Т-Инвестиции» показан по состоянию на{" "}
            {formatDateTime(brokerStatus!.lastSyncAt)}.{" "}
            <Link to="/integrations">Повторить попытку</Link>
          </div>
        )}
        {brokerDegraded && !brokerHasCache && (
          <div className="demo-note warn">
            ⚠ Не удалось загрузить данные от брокера «Т-Инвестиции». Показана только доступная
            часть портфеля. <Link to="/integrations">Повторить подключение</Link>
          </div>
        )}
        {valuation.incomplete && (
          <div className="demo-note warn">
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
        {overdue > 0 && (
          <div className="demo-note warn">
            ⚠ Не отмечено полученными {display(overdue)}. <Link to="/payments">Отметить</Link>
          </div>
        )}
      </article>
      <section className="section-heading">
        <div>
          <h2>Структура</h2>
        </div>
        <Link className="outline-button" to="/products">
          Все инструменты <span>→</span>
        </Link>
      </section>
      {availableCuts.length > 1 && (
        <div className="view-mode-switch structure-cut" role="group" aria-label="Разрез структуры">
          {availableCuts.map((key) => (
            <button
              key={key}
              type="button"
              className={cut === key ? "selected" : ""}
              aria-pressed={cut === key}
              onClick={() => selectCut(key)}
            >
              {STRUCTURE_CUTS[key]}
            </button>
          ))}
        </div>
      )}
      {cut === "bank" && storage ? (
        <StorageList items={storage} display={display} />
      ) : cut === "currency" && currencies ? (
        <CurrencyList items={currencies} display={display} />
      ) : (
        <>
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
                return (
                  <div className="list-row" key={groupSummary.group}>
                    <Link
                      className="product-row-summary"
                      to={`/products?group=${encodeURIComponent(groupSummary.group)}`}
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
                          {`${groupSummary.positions} ${pluralInstruments(groupSummary.positions)} · ${Math.round(groupSummary.share ?? 0)}% портфеля`}
                        </span>
                        <span className={pnl.className}>{pnl.percentText}</span>
                      </span>
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>
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
  pnl: "По прибыли в рублях",
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
            // Голый «≈» ничего не объяснял (критик К21): пишем словами, откуда сумма.
            <span className="muted" title="Нет биржевой котировки">≈ {estimateNote(valuation)}</span>
          ) : (
            <span className={pnl.className} title={`Доход: ${pnl.amountText}`}>{pnl.percentText}</span>
          )}
        </span>
      </Link>
    </div>
  );
}

// Строки одного блока «Инструментов» со своей пагинацией: свёрнутый соседний блок
// не должен съедать первые 20 строк этого (П29).
function ProductSectionList({
  items,
  nearestPayoutByInstrument,
  showInstitution,
}: {
  items: Product[];
  nearestPayoutByInstrument: Map<string, NearestPayout>;
  showInstitution: boolean;
}) {
  const { visible, hasMore, loadMore, pageSize, setPageSize } = usePagedList(items);
  return (
    <>
      <div className="product-list">
        {visible.map((product) => (
          <ProductRow
            key={product.id}
            product={product}
            nextPayout={product.instrumentId ? nearestPayoutByInstrument.get(product.instrumentId) : undefined}
            showInstitution={showInstitution}
          />
        ))}
      </div>
      <ListPagination hasMore={hasMore} onLoadMore={loadMore} pageSize={pageSize} onPageSizeChange={setPageSize} />
    </>
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
  // Закрытые вклады и погашенные бумаги в списке не показываем (П32, решение владельца):
  // в портфель они уже не входят, карточка открывается из операций и выплат.
  const active = products.filter((product) => !product.closedOn);
  const productTypes = Array.from(new Set(active.map((product) => product.type)));
  const banks = Array.from(new Set(active.map((product) => product.institution).filter(Boolean))).sort();
  const filtered = active.filter(
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
  const { isFolded, toggle } = useFolded();
  // Один блок на категорию, даже пока сводка с порядком категорий ещё не пришла.
  const sections: { type: AssetType; items: Product[] }[] = [];
  for (const product of ordered) {
    const section = sections.find((item) => item.type === product.type);
    if (section) section.items.push(product);
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
  // Сумма в заголовке блока: без фильтра по банку — итог категории из сводки Portfolio
  // Engine; со срезом по банку сводки по
  // категории внутри банка нет — складываем оценки строк, а бумаги без оценки называем.
  function sectionTotal(type: AssetType, items: Product[]) {
    const fromSummary = !bank ? summary?.groups.find((item) => item.group === type) : undefined;
    if (fromSummary) return money(fromSummary.value);
    const values = items.map((product) => product.valuation?.value ?? null);
    const known = values.filter((value): value is number => value !== null);
    const missing = values.length - known.length;
    if (known.length === 0) return missing > 0 ? "Оценка недоступна" : undefined;
    const sum = money(known.reduce((acc, value) => acc + value, 0));
    return missing > 0 ? `${sum} · без оценки: ${missing}` : sum;
  }
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
              <span className="label-short">↻ Обновить цены</span>
            </>
          )}
        </button>
      </div>
      <div className="filters-bar">
        {/* На странице категории выбор категории лишний — она в заголовке (критик К13). */}
        {!group && (
          <label className="inline-select">
            <span>Категория</span>
            <select value="all" onChange={(event) => setFilter("group", event.target.value)}>
              <option value="all">Все категории</option>
              {productTypes.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </label>
        )}
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
          {active.length === 0
            ? "Пока нет добавленных инструментов."
            : "Нет инструментов, подходящих под выбранный фильтр."}
        </p>
      ) : (
        sections.map((section) => {
          const list = (
            <ProductSectionList
              items={section.items}
              nearestPayoutByInstrument={nearestPayoutByInstrument}
              showInstitution={!bank}
            />
          );
          // На странице категории заголовок блока повторил бы заголовок страницы.
          if (group) return <div key={section.type}>{list}</div>;
          const count = section.items.length;
          return (
            <FoldSection
              key={section.type}
              className="product-section"
              title={section.type}
              dot={typeColors[section.type]}
              count={count}
              total={sectionTotal(section.type, section.items)}
              folded={isFolded(section.type)}
              onToggle={() => toggle(section.type)}
            >
              {list}
            </FoldSection>
          );
        })
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
  // Операции идут блоками по месяцам (П29): прошлые месяцы сворачиваются, чтобы не листать.
  const { isFolded, toggle } = useFolded();
  const months: { key: string; items: Transaction[] }[] = [];
  for (const transaction of filtered) {
    const key = transaction.date.slice(0, 7);
    const last = months.at(-1);
    if (last && last.key === key) last.items.push(transaction);
    else months.push({ key, items: [transaction] });
  }
  function renderTransaction(transaction: Transaction) {
    const expanded = expandedId === transaction.id;
    const position = transaction.positionId ? positionById.get(transaction.positionId) : undefined;
    const typeLabel = transactionLabel(transaction, position);
    // Название строки — инструмент; для денежной операции — её описание, если оно
    // говорит больше, чем тип (иначе «Покупка» и ниже снова «Покупка»).
    const name = position?.name || (transaction.title && transaction.title !== typeLabel ? transaction.title : typeLabel);
    const institution = institutionOf(transaction);
    const showTitle = transaction.title && transaction.title !== typeLabel && transaction.title !== name;
    const extras: [string, string][] = [];
    // Раскрытая покупка или продажа показывает «10 шт × 300 ₽» (критик К11).
    if (transaction.quantity) {
      const qty = transaction.quantity.toLocaleString("ru-RU", { maximumFractionDigits: 4 });
      extras.push(["Количество", transaction.price ? `${qty} шт × ${preciseMoney(transaction.price)}` : `${qty} шт`]);
    }
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
  }
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
        months.map((month) => (
          <FoldSection
            key={month.key}
            className="product-section"
            title={periodLabel(month.key, "month").replace(/ г\.$/, "")}
            count={month.items.length}
            folded={isFolded(month.key)}
            onToggle={() => toggle(month.key)}
          >
            <PagedRows items={month.items} render={renderTransaction} />
          </FoldSection>
        ))
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
    // Тип нужен и выплате без инструмента (купон, проведённый операцией), если он
    // уже не стоит в названии строки.
    product ? (payment.type === "DEPOSIT_PRINCIPAL" ? "Возврат вклада" : typeLabel) : title !== typeLabel ? typeLabel : null,
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
// Календарь выплат как инструмент планирования (§22): сверху свод «сколько придёт»,
// ниже — сетка из 12 дней, месяцев или лет с суммой выплат в каждом.
const isoOf = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function shiftIso(date: string, months: number, days = 0) {
  const parsed = new Date(`${date}T12:00:00`);
  parsed.setMonth(parsed.getMonth() + months, parsed.getDate() + days);
  return isoOf(parsed);
}
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const monthEnd = (date: string) => shiftIso(monthStart(date), 1, -1);
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
// Деньги, которые придут: доход отдельно от возврата вложений (критик К7) —
// «придёт 517 000» без оговорки обещало бы доход, которого нет.
function payoutTotals(list: Payment[]) {
  const income = sumPayoutsBase(list.filter((item) => !isPrincipalPayout(item)));
  const principal = sumPayoutsBase(list.filter(isPrincipalPayout));
  return {
    total: income.total + principal.total,
    income: income.total,
    principal: principal.total,
    partial: income.partial || principal.partial,
    count: list.length,
  };
}
function totalsNote(totals: ReturnType<typeof payoutTotals>) {
  return [
    totals.principal > 0 ? `доход ${money(totals.income)} · возврат вложений ${money(totals.principal)}` : null,
    totals.partial ? "без выплат в валюте без курса ЦБ" : null,
  ].filter(Boolean).join(" · ");
}
// Сетка из 12 периодов (П26): переключатель «дни / месяцы / годы» задаёт шаг, а сетка
// показывает 12 таких шагов с суммой в каждом. Начало окна, шаг и выбранная ячейка
// хранятся в адресе (?by=&start=&sel=), поэтому «назад» и ссылка работают.
const PAYOUT_CELLS = 12;
const SHORT_MONTHS = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
const START_PATTERN: Record<PaymentViewMode, RegExp> = {
  day: /^\d{4}-\d{2}-\d{2}$/,
  month: /^\d{4}-\d{2}$/,
  year: /^\d{4}$/,
};
function cellKeyOf(date: string, level: PaymentViewMode) {
  return level === "day" ? date.slice(0, 10) : level === "month" ? date.slice(0, 7) : date.slice(0, 4);
}
function shiftCell(key: string, level: PaymentViewMode, steps: number) {
  if (level === "day") return shiftIso(key, 0, steps);
  if (level === "month") return shiftIso(`${key}-01`, steps).slice(0, 7);
  return String(Number(key) + steps);
}
// Полный заголовок ячейки — для панели под сеткой и подписи окна.
function cellTitle(key: string, level: PaymentViewMode) {
  if (level === "year") return `${key} год`;
  if (level === "month") return periodLabel(key, "month");
  const parsed = parseIsoDate(key);
  return parsed ? `${fullDate(key)}, ${WEEKDAYS[parsed.getDay()]}` : key;
}
// В ячейке места мало (три колонки на телефоне): крупные суммы — в тысячах и миллионах,
// точная сумма — в панели выбранного периода.
function compactMoney(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1_000_000)
    return `${baseCurrencySign} ${(value / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`;
  if (abs >= 100_000) return `${baseCurrencySign} ${Math.round(value / 1000).toLocaleString("ru-RU")} тыс`;
  return money(value);
}
const LEVEL_LABELS: Record<PaymentViewMode, [string, string]> = {
  day: ["По дням", "Дни"],
  month: ["По месяцам", "Месяцы"],
  year: ["По годам", "Годы"],
};
function PaymentsPage({
  payments,
  products,
  onMarkReceived,
}: {
  payments: Payment[];
  products: Product[];
  onMarkReceived: (payment: Payment) => Promise<void>;
}) {
  const [innerId, setInnerId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<PayoutType | "all">("all");
  const [bankFilter, setBankFilter] = useState("all");
  const [searchParams, setSearchParams] = useSearchParams();
  // Из карточки инструмента «Все выплаты» открывает календарь уже отфильтрованным по нему.
  const instrumentFilter = searchParams.get("instrument") || "all";
  const today = todayIsoDate();
  const byParam = searchParams.get("by");
  // Без параметров — 12 месяцев начиная с текущего: самый частый вопрос «сколько придёт и когда».
  const level: PaymentViewMode = byParam === "day" || byParam === "year" ? byParam : "month";
  const currentKey = cellKeyOf(today, level);
  const startParam = searchParams.get("start") ?? "";
  // Окно не уходит в прошлое: экран — про то, что ещё придёт.
  const start = START_PATTERN[level].test(startParam) && startParam > currentKey ? startParam : currentKey;
  const keys = Array.from({ length: PAYOUT_CELLS }, (_, index) => shiftCell(start, level, index));
  const selParam = searchParams.get("sel") ?? "";
  const selected = keys.includes(selParam) ? selParam : null;

  // Каждый шаг (смена уровня, листание, выбор ячейки) — запись в истории:
  // «назад» в браузере возвращает к предыдущему виду, как требует §40.7.
  function go(next: { by?: PaymentViewMode; start?: string; sel?: string | null }) {
    const params = new URLSearchParams(searchParams);
    params.delete("from");
    params.delete("to");
    const by = next.by ?? level;
    params.set("by", by);
    params.set("start", next.start ?? start);
    if (next.sel) params.set("sel", next.sel);
    else params.delete("sel");
    setInnerId(null);
    setSearchParams(params);
  }
  function setInstrumentFilter(value: string) {
    const params = new URLSearchParams(searchParams);
    if (value === "all") params.delete("instrument");
    else params.set("instrument", value);
    setSearchParams(params, { replace: true });
  }

  const instrumentOptions = useMemo(() => {
    const map = new Map<string, string>();
    payments.forEach((payment) => {
      if (!payment.instrumentId) return;
      const product = products.find((item) => item.instrumentId === payment.instrumentId);
      if (product) map.set(payment.instrumentId, product.name);
    });
    return Array.from(map.entries());
  }, [payments, products]);
  const bankOptions = Array.from(
    new Set(payments.map((payment) => payoutInstitution(payment, products)).filter((name): name is string => Boolean(name))),
  ).sort();
  const activeFilters = [typeFilter !== "all", instrumentFilter !== "all", bankFilter !== "all"].filter(Boolean).length;
  // Фильтры по типу, инструменту и банку действуют на всё: свод, сетку, просроченные.
  const matching = payments.filter((payment) => {
    if (typeFilter !== "all" && payment.type !== typeFilter) return false;
    if (instrumentFilter !== "all" && payment.instrumentId !== instrumentFilter) return false;
    if (bankFilter !== "all" && payoutInstitution(payment, products) !== bankFilter) return false;
    return true;
  });
  // Прошедшие выплаты на экране не показываются (П27): он отвечает на вопрос «сколько
  // придёт». Неотмеченные прошедшие отмечаются в «Требует внимания» и карточке продукта.
  const calendar = matching
    .filter((payment) => payment.date >= today && !isOverdue(payment))
    .sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = calendar.filter(isUpcoming);

  const [markingId, setMarkingId] = useState<string | null>(null);
  async function markReceived(payment: Payment) {
    setMarkingId(payment.id);
    try {
      await onMarkReceived(payment);
    } finally {
      setMarkingId(null);
    }
  }

  // Свод: текущий и два следующих месяца плюс 12 полных месяцев (П28). Подписи — сами
  // месяцы, а не «этот / следующий»: так не нужно соображать, о каком месяце речь.
  // Прошедшие дни текущего месяца не входят — как и во всём экране (П27).
  const thisMonth = cellKeyOf(today, "month");
  const monthCards = [0, 1, 2].map((offset) => {
    const key = shiftCell(thisMonth, "month", offset);
    return { id: key, label: periodLabel(key, "month").replace(/ г\.$/, ""), from: `${key}-01`, to: monthEnd(`${key}-01`), sel: key };
  });
  const lastMonth = shiftCell(thisMonth, "month", 11);
  const shortMonth = (key: string) => `${periodLabel(key, "month").split(" ")[0]} ${key.slice(2, 4)}`;
  const summaryCards = [
    ...monthCards,
    { id: "12m", label: `${shortMonth(thisMonth)} — ${shortMonth(lastMonth)}`, from: `${thisMonth}-01`, to: monthEnd(`${lastMonth}-01`), sel: null },
  ].map((card) => ({
    ...card,
    target: { by: "month" as const, start: thisMonth, sel: card.sel },
    totals: payoutTotals(upcoming.filter((payment) => payment.date >= card.from && payment.date <= card.to)),
  }));

  // Ячейки сетки. Пустые тоже показываются: «в марте ничего не придёт» — такой же ответ
  // для планирования, как сумма. В прошедших ячейках — полученное.
  const cells = keys.map((key) => {
    const items = calendar.filter((payment) => cellKeyOf(payment.date, level) === key);
    const expected = payoutTotals(items.filter(isUpcoming));
    const received = payoutTotals(items.filter((item) => item.status === "received"));
    return { key, items, expected, received, amount: expected.total + received.total };
  });
  const maxAmount = Math.max(...cells.map((cell) => cell.amount), 0);
  const windowItems = cells.flatMap((cell) => cell.items);
  const windowTotals = payoutTotals(windowItems);
  const selectedCell = cells.find((cell) => cell.key === selected);

  function cellLabel(key: string): [string, string] {
    if (level === "year") return [key, ""];
    if (level === "month") return [SHORT_MONTHS[Number(key.slice(5, 7)) - 1], key.slice(0, 4)];
    const parsed = parseIsoDate(key);
    return [String(Number(key.slice(8, 10))) + " " + SHORT_MONTHS[Number(key.slice(5, 7)) - 1].toLowerCase(), parsed ? WEEKDAYS[parsed.getDay()] : ""];
  }
  // Переход на уровень ниже: год → его 12 месяцев, месяц → дни с его начала.
  function drillDown(key: string) {
    if (level === "year") go({ by: "month", start: `${key}-01`, sel: null });
    else if (level === "month") go({ by: "day", start: key === currentKey ? today : `${key}-01`, sel: null });
  }
  const windowEdge = (key: string) =>
    level === "year" ? key : level === "month" ? `${SHORT_MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` : dateLabel(key);
  const windowTitle = `${windowEdge(keys[0])} — ${windowEdge(keys[PAYOUT_CELLS - 1])}`;

  return (
    <Page title="Выплаты" subtitle="Сколько денег придёт и когда">
      <div className="payout-summary">
        {summaryCards.map((card) => (
          <button
            type="button"
            key={card.id}
            className="payout-summary-card"
            onClick={() => go(card.target)}
          >
            <span>{card.label}</span>
            <strong>{card.totals.total > 0 ? `+${money(card.totals.total)}` : "—"}</strong>
            <small>{card.totals.count > 0 ? `${card.totals.count} ${pluralPayouts(card.totals.count)}` : "выплат нет"}</small>
            {card.totals.principal > 0 && <small>в т.ч. возврат {money(card.totals.principal)}</small>}
          </button>
        ))}
      </div>

      <div className="toolbar payout-toolbar">
        <details className="filters-disclosure" open={activeFilters > 0 || undefined}>
          <summary>Фильтры{activeFilters > 0 ? ` · ${activeFilters}` : ""}</summary>
          <div className="filters-bar">
            <label className="inline-select">
              <span>Тип</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as PayoutType | "all")}>
                <option value="all">Все типы</option>
                {Object.entries(payoutTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            {instrumentOptions.length > 0 && (
              <label className="inline-select">
                <span>Инструмент</span>
                <select value={instrumentFilter} onChange={(event) => setInstrumentFilter(event.target.value)}>
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
          </div>
        </details>
        <Link className="outline-button" to="/payments/new">
          <span className="label-full">＋ Добавить выплату</span>
          <span className="label-short">＋ Выплата</span>
        </Link>
      </div>

      {calendar.length === 0 && activeFilters === 0 ? (
        <div className="payout-empty">
          <p className="muted">
            Впереди выплат нет. Они появятся сами, когда у вклада или облигации будут заполнены ставка и даты, — или
            добавьте выплату вручную.
          </p>
        </div>
      ) : (
        <section className="payout-grid-block" aria-label="Календарь выплат">
          <div className="view-mode-switch payout-level" role="group" aria-label="Шаг календаря">
            {(["day", "month", "year"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={level === mode ? "selected" : ""}
                aria-pressed={level === mode}
                onClick={() => go({ by: mode, start: cellKeyOf(today, mode), sel: null })}
              >
                <span className="label-full">{LEVEL_LABELS[mode][0]}</span>
                <span className="label-short">{LEVEL_LABELS[mode][1]}</span>
              </button>
            ))}
          </div>
          <div className="payout-window">
            <button
              type="button"
              className="outline-button payout-window-arrow"
              aria-label="Предыдущие 12"
              disabled={start === currentKey}
              onClick={() => go({ start: shiftCell(start, level, -PAYOUT_CELLS), sel: null })}
            >
              ←
            </button>
            <div className="payout-window-title">
              <span className="muted">{windowTitle}</span>
              <strong>{windowTotals.total > 0 ? `+${money(windowTotals.total)}` : "—"}</strong>
              <small className="muted">
                {[
                  windowTotals.count > 0 ? `${windowTotals.count} ${pluralPayouts(windowTotals.count)}` : "выплат нет",
                  totalsNote(windowTotals) || null,
                ].filter(Boolean).join(" · ")}
              </small>
            </div>
            <button
              type="button"
              className="outline-button payout-window-arrow"
              aria-label="Следующие 12"
              onClick={() => go({ start: shiftCell(start, level, PAYOUT_CELLS), sel: null })}
            >
              →
            </button>
          </div>
          {start !== currentKey && (
            <button type="button" className="inline-link-button payout-window-reset" onClick={() => go({ start: currentKey, sel: null })}>
              {level === "day" ? "К сегодняшнему дню" : level === "month" ? "К текущему месяцу" : "К текущему году"}
            </button>
          )}
          <div className="payout-grid">
            {cells.map((cell) => {
              const [label, sub] = cellLabel(cell.key);
              const principal = cell.expected.principal + cell.received.principal;
              return (
                <button
                  type="button"
                  key={cell.key}
                  className={[
                    "payout-cell",
                    cell.key === selected ? "selected" : "",
                    cell.key === currentKey ? "current" : "",
                    cell.amount > 0 ? "" : "empty",
                  ].filter(Boolean).join(" ")}
                  aria-pressed={cell.key === selected}
                  aria-label={`${cellTitle(cell.key, level)}: ${cell.amount > 0 ? money(cell.amount) : "выплат нет"}`}
                  onClick={() => go({ sel: cell.key === selected ? null : cell.key })}
                >
                  <span className="payout-cell-label">
                    {label}
                    {sub && <small>{sub}</small>}
                  </span>
                  <strong>{cell.amount > 0 ? `+${compactMoney(cell.amount)}` : "—"}</strong>
                  <span className="payout-bar" aria-hidden="true">
                    <i style={{ width: `${maxAmount > 0 ? Math.max((cell.amount / maxAmount) * 100, cell.amount > 0 ? 4 : 0) : 0}%` }} />
                  </span>
                  <small className="payout-cell-note">
                    {cell.items.length === 0
                      ? "нет выплат"
                      : principal > 0
                        ? `${cell.items.length} · в т.ч. возврат`
                        : `${cell.items.length} ${pluralPayouts(cell.items.length)}`}
                  </small>
                </button>
              );
            })}
          </div>

          {selectedCell ? (
            <div className="payout-selected">
              <div className="payout-selected-head">
                <div>
                  <span className="muted">{cellTitle(selectedCell.key, level)}</span>
                  <strong>{selectedCell.amount > 0 ? `+${money(selectedCell.amount)}` : "—"}</strong>
                  <small className="muted">
                    {[
                      selectedCell.items.length > 0
                        ? payoutGroupValue(selectedCell.expected.total, selectedCell.received.total, 0).note
                        : "выплат нет",
                      totalsNote(payoutTotals(selectedCell.items)) || null,
                    ].filter(Boolean).join(" · ")}
                  </small>
                </div>
                {level !== "day" && (
                  <button type="button" className="outline-button" onClick={() => drillDown(selectedCell.key)}>
                    {level === "year" ? `${selectedCell.key} по месяцам →` : "По дням →"}
                  </button>
                )}
              </div>
              {selectedCell.items.length > 0 && (
                <div className="product-list">
                  {selectedCell.items.map((payment) => (
                    <PaymentRow
                      key={payment.id}
                      payment={payment}
                      products={products}
                      expanded={innerId === payment.id || selectedCell.items.length === 1}
                      onToggle={() => setInnerId(innerId === payment.id ? null : payment.id)}
                      onMarkReceived={(item) => void markReceived(item)}
                      marking={markingId !== null}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="muted payout-hint">Нажмите на период, чтобы увидеть, какие выплаты в него входят.</p>
          )}
        </section>
      )}
    </Page>
  );
}
// Периодичность приходит и из формы («Ежемесячно»), и через API/OCR (monthly) — клиент
// видит её по-русски, а не сырым значением (критик К12).
const frequencyLabels: Record<string, string> = { monthly: "Ежемесячно", quarterly: "Ежеквартально", yearly: "Ежегодно", annually: "Ежегодно", "at maturity": "В конце срока", end: "В конце срока" };
const frequencyLabel = (value: string | undefined) => (value ? frequencyLabels[value.trim().toLowerCase()] ?? value : undefined);
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
  // Цена покупки и текущая цена — за одну бумагу: стоимость и вложено уже в шапке карточки.
  const rows: [string, React.ReactNode | undefined][] =
    product.type === "Вклады"
      ? [
          ["Ставка", percentText(product.rate)],
          ["Открыт", date(product.date)],
          ["Окончание", date(product.termEndDate)],
          ["Выплата процентов", frequencyLabel(product.interestPayoutFrequency)],
          ["Капитализация", product.capitalization ? "да" : undefined],
          ["Автопролонгация", product.autoProlongation ? "да" : undefined],
          [
            "Начислено, не выплачено",
            product.valuation?.accruedInterest ? `≈ ${preciseMoney(product.valuation.accruedInterest)} · оценка по ставке` : undefined,
          ],
        ]
      : quotedTypes.has(product.type)
        ? [
            ["Количество", product.quantity !== undefined ? `${product.quantity.toLocaleString("ru-RU")} шт.` : undefined],
            ["Цена покупки", price(product.averagePrice)],
            ["Текущая цена", currentPrice],
            ["Купон", percentText(product.couponRate)],
            ["Погашение", date(product.maturityDate)],
            ["Оферта", date(product.ofertaDate)],
            ["НКД", product.type === "Облигации" && product.accruedInterest ? price(product.accruedInterest) : undefined],
          ]
        : [["Дата", date(product.date)]];
  return rows.filter((row): row is [string, React.ReactNode] => row[1] !== undefined && row[1] !== "");
}
// Возврат тела вклада проводится операцией REDEMPTION, как погашение облигации, но
// подписывается по смыслу (тестер Т39): у вклада «погашения» нет.
function transactionLabel(transaction: Transaction, position?: Product) {
  if (transaction.type === "REDEMPTION" && (position?.type === "Вклады" || transaction.title.startsWith("Возврат вклада"))) {
    return "Возврат вклада";
  }
  return transactionTypeLabels[transaction.type];
}
// Направление денег операции для знака суммы в ленте: покупка и расходы уменьшают деньги.
const OUTGOING_TRANSACTION_TYPES: TransactionType[] = ["BUY", "WITHDRAW", "FEE", "TAX"];
function signedTransactionAmount(transaction: Transaction) {
  return `${OUTGOING_TRANSACTION_TYPES.includes(transaction.type) ? "−" : "+"}${payoutMoney(transaction)}`;
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
      label: transactionLabel(transaction, product),
      color: transactionTypeColors[transaction.type],
      amount: signedTransactionAmount(transaction),
      to: `/transactions/${transaction.id}/edit`,
    })),
    // Выплата, заведённая операцией (или операция, заведённая отметкой «получена»), —
    // одни и те же деньги: в ленте они показываются один раз, операцией (критик К10).
    ...relatedPayments
      .filter((payment) => payment.status === "received")
      .filter((payment) => !payment.transactionId || !relatedTransactions.some((transaction) => transaction.id === payment.transactionId))
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
  const { isFolded, toggle } = useFolded();
  if (items.length === 0) {
    return (
      <section className="breakdown-section">
        <div className="breakdown-heading">
          <h2>{title}</h2>
          <span className="muted">{emptyHint}</span>
        </div>
      </section>
    );
  }
  return (
    <FoldSection
      className="breakdown-section"
      title={title}
      count={items.length}
      folded={isFolded(title)}
      onToggle={() => toggle(title)}
    >
      <PagedRows
        items={items}
        render={(item) => {
          const pnl = pnlDisplay(item.pnl, item.pnlPercent);
          const content = (
            <>
                  <span className="product-row-line1">
                    <span className="product-row-name">
                      <strong>{item.key}</strong>
                    </span>
                    <span className="product-row-sum">{unvalued(item) ? "Оценка недоступна" : money(item.value)}</span>
                  </span>
                  <span className="product-row-line2 product-row-line2-flush">
                    <span className="muted product-row-meta">
                      {unvalued(item) ? (
                        <span className="danger-text">цена недоступна</span>
                      ) : (
                        <>
                          {Math.round(item.share ?? 0)}% портфеля
                          {item.priceUnavailable > 0 && (
                            <span className="danger-text"> · цена недоступна ({item.priceUnavailable})</span>
                          )}
                        </>
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
        }}
      />
    </FoldSection>
  );
}

function AnalyticsPage({
  summary,
  token,
}: {
  summary: PortfolioSummary | null;
  token: string;
}) {
  const current = summary ?? localSummary([], []);
  const { groups } = current;
  const result = portfolioResult(current);
  // Категории (классы активов) уже посчитаны в summary.groups — тем же движком (§10).
  const byGroup: StructureBreakdown[] = groups.map((group) => ({ ...group, key: group.group }));
  const [structure, setStructure] = useState<PortfolioStructure | null>(null);
  const [structureError, setStructureError] = useState("");
  const topInstrument = structure?.byInstrument[0];
  const [returns, setReturns] = useState<PeriodReturn[] | null>(null);
  const isEmpty = groups.length === 0;

  useEffect(() => {
    let cancelled = false;
    apiFetch(`${apiUrl}/portfolio/returns`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? (response.json() as Promise<PeriodReturn[]>) : []))
      .then((rows) => { if (!cancelled) setReturns(rows); })
      .catch(() => { if (!cancelled) setReturns([]); });
    return () => {
      cancelled = true;
    };
  }, [token]);

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
      {/* Пустой портфель — не «+0,00%» и «₽ 0» (критик К15), а приглашение добавить актив. */}
      {isEmpty ? (
        <div className="empty-state">
          <p>Аналитика появится, когда в портфеле будет хотя бы один актив.</p>
          <Link className="primary-button" to="/products/new">Добавить актив</Link>
        </div>
      ) : (
      <>
      <div className="stat-strip">
        <article className="stat-card">
          <span>Доходность</span>
          <strong className={result.tone === "negative" ? "danger-text" : result.tone === "positive" ? "teal-text" : "muted"}>
            {signedPercent(result.percent)}
          </strong>
          <small>простая, за всё время</small>
        </article>
        <article className="stat-card">
          <span>Результат</span>
          <strong className={result.tone === "negative" ? "danger-text" : result.tone === "positive" ? "teal-text" : "muted"}>
            {signedMoney(result.result, money)}
          </strong>
          <small>цена + выплаты + продажи − комиссии и налоги</small>
        </article>
        <article className="stat-card">
          <span>Крупнейшая позиция</span>
          <strong>{topInstrument ? `${Math.round(topInstrument.share ?? 0)}%` : "—"}</strong>
          <small className="ellipsis-text">{topInstrument?.key ?? "нет данных"}</small>
        </article>
      </div>
      <PeriodReturns rows={returns} />
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
      </>
      )}
    </Page>
  );
}
type PeriodReturn = { period: "day" | "month" | "year" | "all"; from: string; result: number; percent: number | null };
const PERIOD_LABELS: Record<PeriodReturn["period"], string> = {
  day: "За день",
  month: "За месяц",
  year: "За год",
  all: "С начала истории",
};
// §23: доходность за периоды считает бэкенд по ежедневным снимкам. Пока истории меньше
// двух дней — честно говорим, что считать не из чего, а не рисуем нули.
function PeriodReturns({ rows }: { rows: PeriodReturn[] | null }) {
  if (rows === null) return null;
  return (
    <section className="period-returns">
      <h2>Доходность по периодам</h2>
      {rows.length === 0 ? (
        <p className="muted">Появится со второго дня: считается по ежедневным снимкам портфеля.</p>
      ) : (
        <div className="stat-strip">
          {rows.map((row) => {
            const tone = Math.round(row.result) > 0 ? "teal-text" : Math.round(row.result) < 0 ? "danger-text" : "muted";
            return (
              <article className="stat-card" key={row.period}>
                <span>{PERIOD_LABELS[row.period]}</span>
                <strong className={tone}>{row.percent === null ? "—" : signedPercent(row.percent)}</strong>
                <small>
                  {signedMoney(row.result, money)} с {dateLabel(row.from)}
                </small>
              </article>
            );
          })}
        </div>
      )}
      <p className="muted small-note">Изменение результата портфеля за период: цена, выплаты и продажи. Покупки ростом не считаются, процент — к среднему вложенному за период.</p>
    </section>
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
          <div className="demo-note warn">
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
      <HermesIntegration />
    </Page>
  );
}
type HermesKey = { id: string; name: string; preview: string; createdAt: string; lastUsedAt: string | null };
type HermesWebhook = {
  url: string;
  enabled: boolean;
  events: string[];
  sendHour: number;
  lastSentAt: string | null;
  lastError: string | null;
};
// Что может прийти в ежедневной сводке (NOTIFICATION_KINDS в server/notifications.ts).
// Первые четыре включены по умолчанию — только важное.
const HERMES_EVENTS: Array<{ kind: string; title: string; hint: string }> = [
  { kind: "payout_received", title: "Пришли выплаты", hint: "купоны, дивиденды, проценты" },
  { kind: "position_closed", title: "Вклад закрыт, облигация погашена", hint: "и сколько вернулось" },
  { kind: "maturity_soon", title: "Скоро закончится срок", hint: "за неделю до окончания вклада или погашения облигации" },
  { kind: "broker_error", title: "Ошибка брокера", hint: "данные Т-Инвестиций не обновились" },
  { kind: "payout_soon", title: "Выплаты в ближайшие три дня", hint: "предупреждение заранее" },
  { kind: "payout_overdue", title: "Выплата не отмечена полученной", hint: "срок прошёл, а отметки нет" },
  { kind: "weekly_summary", title: "Недельная сводка", hint: "по понедельникам: стоимость и изменение за неделю" },
];
const HERMES_DEFAULT_EVENTS = ["payout_received", "position_closed", "maturity_soon", "broker_error"];
const HERMES_SEND_HOURS = Array.from({ length: 16 }, (_, index) => index + 6);
// Hermes — ИИ-агент владельца (docs/HERMES.md): по ключу управляет портфелем,
// а «Портфель» раз в день шлёт ему сводку в вебхук. Подключается одной ссылкой:
// установщик по ней сам получает ключ и заводит маршрут вебхука (server/hermes-connect.ts).
function HermesIntegration() {
  const [keys, setKeys] = useState<HermesKey[]>([]);
  const [webhook, setWebhook] = useState<HermesWebhook | null>(null);
  const [newKey, setNewKey] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [events, setEvents] = useState<string[]>(HERMES_DEFAULT_EVENTS);
  const [sendHour, setSendHour] = useState(10);
  const [link, setLink] = useState<{ link: string; expiresAt: string } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const request = async (path: string, init?: RequestInit) => {
    const response = await apiFetch(`${apiUrl}/integrations/hermes${path}`, {
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
    const result = response.status === 204 ? {} : ((await response.json()) as Record<string, unknown>);
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Не удалось выполнить действие");
    return result;
  };
  const load = async () => {
    const result = (await request("")) as { keys: HermesKey[]; webhook: HermesWebhook | null };
    setKeys(result.keys);
    setWebhook(result.webhook);
    if (result.webhook) {
      setUrl(result.webhook.url);
      setEnabled(result.webhook.enabled);
      setEvents(result.webhook.events);
      setSendHour(result.webhook.sendHour);
    }
  };
  useEffect(() => {
    load().catch((error) => setMessage(errorText(error, "Не удалось загрузить настройки Hermes")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(errorText(error, fallback));
    } finally {
      setBusy(false);
    }
  };
  const createKey = () =>
    run(async () => {
      const result = (await request("/keys", { method: "POST", body: JSON.stringify({ name: "Hermes" }) })) as { key: string };
      setNewKey(result.key);
      await load();
    }, "Не удалось выпустить ключ");
  const revokeKey = (id: string) =>
    run(async () => {
      await request(`/keys/${id}`, { method: "DELETE" });
      setConfirmRevoke("");
      await load();
    }, "Не удалось отозвать ключ");
  const saveWebhook = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      await request("/webhook", {
        method: "PUT",
        body: JSON.stringify({ url, secret: secret || undefined, ...(webhook ? {} : { events, sendHour }) }),
      });
      setSecret("");
      await load();
      setMessage("Вебхук сохранён");
    }, "Не удалось сохранить вебхук");
  };
  const testWebhook = () =>
    run(async () => {
      const result = (await request("/webhook/test", { method: "POST" })) as { message?: string };
      setMessage(result.message || "Проверочное сообщение отправлено");
      await load();
    }, "Не удалось отправить проверочное сообщение");
  const removeWebhook = () =>
    run(async () => {
      await request("/webhook", { method: "DELETE" });
      setUrl("");
      setSecret("");
      setEnabled(true);
      setEvents(HERMES_DEFAULT_EVENTS);
      setSendHour(10);
      await load();
    }, "Не удалось отключить уведомления");
  const toggleEvent = (kind: string, checked: boolean) =>
    setEvents((current) => (checked ? [...current, kind] : current.filter((item) => item !== kind)));
  const createLink = () =>
    run(async () => {
      const result = (await request("/connect", { method: "POST" })) as { link: string; expiresAt: string };
      setLink(result);
    }, "Не удалось получить ссылку");
  const copyLink = () =>
    navigator.clipboard
      ?.writeText(`Подключись к Портфелю: ${link?.link ?? ""}`)
      .then(() => setMessage("Сообщение скопировано"), () => undefined);
  const saveNotifications = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      await request("/notifications", { method: "PATCH", body: JSON.stringify({ enabled, events, sendHour }) });
      await load();
      setMessage("Настройки уведомлений сохранены");
    }, "Не удалось сохранить настройки уведомлений");
  };

  const state = keys.length || webhook ? "connected" : "disconnected";
  return (
    <div className="integration-card">
      <div className="integration-heading">
        <div className="broker-logo">H</div>
        <div>
          <h2>Hermes</h2>
          <p>ИИ-агент: отвечает про финансы, ведёт портфель, раз в день присылает сводку</p>
        </div>
        <span className={`connection-state ${state}`}>{state === "connected" ? "Подключено" : "Не подключено"}</span>
      </div>

      <h3 className="integration-subtitle">{state === "connected" ? "Переподключение" : "Подключение"}</h3>
      <small className="field-hint">
        Нажмите кнопку и отправьте ссылку Hermes в Telegram. Он сам поставит навык, получит доступ
        и настроит ежедневную сводку. Ссылка одноразовая и действует сутки. По ней Hermes полностью
        ведёт портфель, но не может менять аккаунт, ключи и токен брокера.
      </small>
      {link ? (
        <div className="demo-note">
          Отправьте Hermes это сообщение:
          <code className="secret-value">Подключись к Портфелю: {link.link}</code>
          <span className="inline-actions">
            <button className="primary-button" type="button" onClick={copyLink}>
              Скопировать
            </button>
            <small>Действует до {formatDateTime(link.expiresAt)}</small>
          </span>
        </div>
      ) : (
        <button className="primary-button" type="button" disabled={busy} onClick={createLink}>
          {state === "connected" ? "Получить новую ссылку" : "Подключить Hermes"}
        </button>
      )}

      {webhook && (
        <>
          <h3 className="integration-subtitle">Уведомления</h3>
          <small className="field-hint">
            Раз в день в выбранный час «Портфель» отправляет в Hermes сводку с новыми событиями.
            Нет событий — нет и сообщения. Каждое событие приходит один раз.
          </small>
          {webhook.lastSentAt && (
            <div className="integration-facts">
              <div className="detail-line">
                <span>Последняя отправка</span>
                <span>{formatDateTime(webhook.lastSentAt)}</span>
              </div>
            </div>
          )}
          {webhook.lastError && <div className="demo-note warn">⚠ {webhook.lastError}</div>}
          <form className="modal-form" onSubmit={saveNotifications}>
            <label className="checkbox-label">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              Присылать уведомления
            </label>
            <HermesEventOptions enabled={enabled} events={events} toggle={toggleEvent} sendHour={sendHour} setSendHour={setSendHour} />
            <button className="primary-button" type="submit" disabled={busy}>
              Сохранить
            </button>
          </form>
          <div className="inline-actions">
            <button className="outline-button" type="button" disabled={busy} onClick={testWebhook}>
              Отправить проверку
            </button>
            <button className="inline-link-button" type="button" disabled={busy} onClick={removeWebhook}>
              Отключить уведомления
            </button>
          </div>
        </>
      )}

      {keys.length > 0 && (
        <>
          <h3 className="integration-subtitle">Ключи доступа</h3>
          <small className="field-hint">Утёк ключ или Hermes больше не нужен — отзовите ключ.</small>
          <div className="integration-facts">
            {keys.map((key) => (
              <div className="detail-line" key={key.id}>
                <span>
                  {key.name} · {key.preview}
                  <br />
                  <small>
                    {key.lastUsedAt ? `Использован ${formatDateTime(key.lastUsedAt)}` : "Ещё не использовался"}
                  </small>
                </span>
                {confirmRevoke === key.id ? (
                  <span className="inline-actions">
                    <button className="outline-button danger-text" type="button" disabled={busy} onClick={() => revokeKey(key.id)}>
                      Отозвать
                    </button>
                    <button className="inline-link-button" type="button" onClick={() => setConfirmRevoke("")}>
                      Отмена
                    </button>
                  </span>
                ) : (
                  <button className="inline-link-button" type="button" onClick={() => setConfirmRevoke(key.id)}>
                    Отозвать…
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <details className="details-block">
        <summary>Настроить вручную</summary>
        <div className="details-fields">
          <small className="field-hint">
            Если Hermes не может выполнить команду из ссылки: ключ вписывается в ~/.hermes/.env
            как PORTFEL_API_KEY, вебхук — маршрут Hermes с тем же секретом (docs/HERMES.md).
          </small>
          {newKey && (
            <div className="demo-note">
              Скопируйте ключ сейчас — больше он показан не будет:
              <code className="secret-value">{newKey}</code>
              <button
                className="outline-button"
                type="button"
                onClick={() => navigator.clipboard?.writeText(newKey).then(() => setMessage("Ключ скопирован"), () => undefined)}
              >
                Скопировать
              </button>
            </div>
          )}
          <button className="outline-button" type="button" disabled={busy} onClick={createKey}>
            Выпустить ключ
          </button>
          <form className="modal-form" onSubmit={saveWebhook}>
            <label>
              Адрес вебхука Hermes
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://host.docker.internal:8644/webhooks/portfel"
                inputMode="url"
                required
              />
            </label>
            <label>
              Секрет подписи
              <input
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                type="password"
                placeholder={webhook ? "Сохранён — введите, чтобы заменить" : "Тот же, что в маршруте Hermes"}
                required={!webhook}
                minLength={16}
              />
            </label>
            {!webhook && (
              <HermesEventOptions enabled events={events} toggle={toggleEvent} sendHour={sendHour} setSendHour={setSendHour} />
            )}
            <button className="outline-button" type="submit" disabled={busy}>
              Сохранить вебхук
            </button>
          </form>
        </div>
      </details>
      {message && <div className="demo-note">{message}</div>}
    </div>
  );
}
function HermesEventOptions(props: {
  enabled: boolean;
  events: string[];
  toggle: (kind: string, checked: boolean) => void;
  sendHour: number;
  setSendHour: (hour: number) => void;
}) {
  return (
    <>
      <fieldset className="hermes-events" disabled={!props.enabled}>
        <legend>О чём сообщать</legend>
        {HERMES_EVENTS.map((item) => (
          <label className="checkbox-label" key={item.kind}>
            <input
              type="checkbox"
              checked={props.events.includes(item.kind)}
              onChange={(event) => props.toggle(item.kind, event.target.checked)}
            />
            <span>
              {item.title}
              <small>{item.hint}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        Время сводки (по Москве)
        <select value={props.sendHour} disabled={!props.enabled} onChange={(event) => props.setSendHour(Number(event.target.value))}>
          {HERMES_SEND_HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {String(hour).padStart(2, "0")}:00
            </option>
          ))}
        </select>
      </label>
    </>
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
// Неизвестный адрес раньше молча открывал «Портфель», и опечатка в ссылке была не видна (П12).
function NotFoundPage() {
  return (
    <Page title="Страница не найдена" subtitle="Такого адреса в приложении нет — возможно, ссылка устарела или в ней опечатка.">
      <div className="toolbar">
        <Link className="primary-button" to="/portfolio">Перейти к портфелю</Link>
      </div>
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
  notice,
}: {
  onSubmit: (form: FormData, mode: "login" | "register") => Promise<LoginError | null>;
  notice?: string;
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
        {notice && (
          <p className="demo-note" role="status">
            {notice}
          </p>
        )}
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
// Поиск бумаги на Московской бирже по тикеру, названию или ISIN (§17, §20): подсказки
// появляются по мере ввода, выбор подтягивает описание и текущую цену. Если биржа не
// отвечает, бумагу можно сохранить по введённому тикеру — цену подтянет обновление котировок.
function SecurityPicker({
  token,
  onUnauthorized,
  value,
  onPick,
  initialQuery = "",
  autoFocus,
  allowUnlisted,
}: {
  token: string;
  onUnauthorized: () => void;
  value: MoexSecurity | null;
  onPick: (security: MoexSecurity | null) => void;
  initialQuery?: string;
  autoFocus?: boolean;
  allowUnlisted?: boolean;
}) {
  const [query, setQuery] = useState(value ? value.secid || value.shortName : initialQuery);
  const [results, setResults] = useState<MoexSearchItem[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");
  const timer = useRef<number | undefined>(undefined);
  // Ответ на устаревший запрос (пользователь уже ввёл дальше) отбрасывается.
  const sequence = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  async function request<T>(path: string): Promise<T> {
    const response = await apiFetch(`${apiUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401) {
      onUnauthorized();
      throw new Error("Сессия истекла");
    }
    const body = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(body.error || "Московская биржа не отвечает. Попробуйте позже");
    return body;
  }
  function fail(error: unknown) {
    setResults([]);
    setStatus("error");
    setMessage(errorText(error, "Московская биржа не отвечает. Попробуйте позже"));
  }
  function search(text: string) {
    setQuery(text);
    if (value) onPick(null);
    setMessage("");
    window.clearTimeout(timer.current);
    const id = ++sequence.current;
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    setStatus("searching");
    timer.current = window.setTimeout(() => {
      request<MoexSearchItem[]>(`/market-data/search?q=${encodeURIComponent(trimmed)}`)
        .then((items) => {
          if (id !== sequence.current) return;
          setResults(items);
          setStatus("idle");
          if (items.length === 0) setMessage("На Московской бирже ничего не найдено — проверьте тикер или название");
        })
        .catch((error) => {
          if (id === sequence.current) fail(error);
        });
    }, 300);
  }
  async function pick(secid: string) {
    window.clearTimeout(timer.current);
    const id = ++sequence.current;
    setQuery(secid);
    setResults([]);
    setStatus("loading");
    setMessage("");
    try {
      const security = await request<MoexSecurity>(`/market-data/securities/${encodeURIComponent(secid)}`);
      if (id !== sequence.current) return;
      setStatus("idle");
      onPick(security);
    } catch (error) {
      if (id === sequence.current) fail(error);
    }
  }
  const typed = query.trim().toUpperCase();
  return (
    <div className="security-picker">
      <label>
        Тикер или название
        <input
          value={query}
          onChange={(event) => search(event.target.value)}
          placeholder="Например, SBER, ОФЗ 26238 или ISIN"
          autoComplete="off"
          autoFocus={autoFocus}
        />
      </label>
      {status === "searching" && <small className="muted">Ищем на Московской бирже…</small>}
      {status === "loading" && <small className="muted">Загружаем данные бумаги…</small>}
      {results.length > 0 && (
        <ul className="security-results">
          {results.map((item) => (
            <li key={item.secid}>
              <button type="button" onClick={() => void pick(item.secid)}>
                <span>
                  <strong>{item.shortName}</strong> <span className="muted">· {item.secid} · {moexGroupLabels[item.group]}</span>
                </span>
                <small className="muted">{item.name}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {value && (
        <div className="security-picked">
          <strong>{value.shortName}</strong>
          <span className="muted">
            {value.unlisted
              ? "Нет на Московской бирже — укажите количество и цену покупки, цену можно обновлять вручную"
              : value.offline
              ? "Данные биржи подтянутся позже — укажите цену покупки"
              : [
                  value.secid,
                  value.isin && value.isin !== value.secid ? value.isin : undefined,
                  value.price !== null ? `цена ${securityPriceText(value.price, value.currency)}` : "цены на бирже сейчас нет",
                  value.couponRate ? `купон ${percentText(value.couponRate)}` : undefined,
                  value.maturityDate ? `погашение ${fullDate(value.maturityDate)}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
        </div>
      )}
      {message && <small className={status === "error" ? "form-error" : "muted"}>{message}</small>}
      {status === "error" && typed.length >= 2 && !value && (
        <button
          type="button"
          className="outline-button"
          onClick={() =>
            onPick({ secid: typed, name: typed, shortName: typed, group: "share", currency: "RUB", price: null, accruedInterest: null, offline: true })
          }
        >
          Продолжить с тикером «{typed}»
        </button>
      )}
      {/* Поиск MOEX почти всегда возвращает похожие бумаги, поэтому выход «нет в списке» —
          под любым результатом, а не только при пустом (Т35). */}
      {allowUnlisted && (status === "idle" || status === "error") && query.trim().length >= 2 && !value && (
        <button
          type="button"
          className="outline-button"
          onClick={() => {
            const title = query.trim();
            onPick({ secid: "", name: title, shortName: title, group: "fund", currency: "RUB", price: null, accruedInterest: null, offline: true, unlisted: true });
          }}
        >
          Нет в списке — добавить «{query.trim()}» без биржи
        </button>
      )}
    </div>
  );
}
function DepositOptionalFields({
  details,
  onChange,
}: {
  details: ProductDetails;
  onChange: <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) => void;
}) {
  return (
    <>
      <label>
        Выплата процентов
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
          checked={details.autoProlongation}
          onChange={(event) => onChange("autoProlongation", event.target.checked)}
        />
        Автопролонгация — банк продлевает вклад сам
      </label>
    </>
  );
}
function BondIssueFields({
  details,
  onChange,
}: {
  details: ProductDetails;
  onChange: <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) => void;
}) {
  return (
    <>
      <label>
        Купон, %
        <input value={details.couponRate} onChange={(event) => onChange("couponRate", event.target.value)} type="number" min="0" step="0.01" />
      </label>
      <label>
        Дата ближайшего купона
        <input value={details.couponDate} onChange={(event) => onChange("couponDate", event.target.value)} type="date" />
      </label>
      <label>
        Дата погашения
        <input value={details.maturityDate} onChange={(event) => onChange("maturityDate", event.target.value)} type="date" />
      </label>
      <label>
        Оферта
        <input value={details.ofertaDate} onChange={(event) => onChange("ofertaDate", event.target.value)} type="date" />
      </label>
    </>
  );
}
const currencyOptions = (
  <>
    <option value="RUB">RUB</option>
    <option value="USD">USD</option>
    <option value="CNY">CNY</option>
  </>
);
const wizardTypeOptions: { value: AssetType; label: string; icon: string }[] = [
  { value: "Вклады", label: "Вклад", icon: "🏦" },
  { value: "Облигации", label: "Облигация", icon: "📜" },
  { value: "Акции", label: "Акция", icon: "📈" },
  { value: "Фонды", label: "ПИФ", icon: "🧺" },
  { value: "Прочее", label: "Прочее", icon: "▧" },
];
const typeOptionLabel = (type: AssetType) => wizardTypeOptions.find((option) => option.value === type)?.label ?? type;


function ProductFormPage({
  token,
  onUnauthorized,
  onSubmit,
  onOcrComplete,
}: {
  token: string;
  onUnauthorized: () => void;
  onSubmit: (product: Product) => Promise<Product | void>;
  onOcrComplete: (result: OcrUploadResult) => void;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [mode, setMode] = useState<"manual" | "screenshot">(
    searchParams.get("mode") === "screenshot" ? "screenshot" : "manual",
  );
  const [type, setType] = useState<AssetType | null>(null);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayIsoDate);
  // Бумага (§17, §20): тикер с биржи и количество; цена покупки необязательна.
  const [security, setSecurity] = useState<MoexSecurity | null>(null);
  const [quantity, setQuantity] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [institution, setInstitution] = useState("");
  const [currency, setCurrency] = useState("RUB");
  const [details, setDetails] = useState<ProductDetails>(emptyProductDetails);
  // Шаг мастера живёт в адресе (?step=2), а не только в памяти (тестировщик Т13, §40.7):
  // «Назад» в браузере возвращает на предыдущий шаг с уже введёнными данными, а не
  // уводит со страницы. Шаг, для которого ещё нет данных (перезагрузка на ?step=3),
  // откатывается к первому незаполненному.
  const requestedStep = Number(searchParams.get("step"));
  const isSecurity = type !== null && quotedTypes.has(type);
  const stepTwoReady = isSecurity
    ? Boolean(security) && Number(quantity) > 0
    : Boolean(name.trim() && amount && (type !== "Вклады" || details.rate.trim()));
  const step: 1 | 2 | 3 =
    requestedStep >= 2 && !type ? 1 : requestedStep === 3 && !stepTwoReady ? 2 : requestedStep === 3 ? 3 : requestedStep === 2 ? 2 : 1;
  const setStep = (next: 1 | 2 | 3) => {
    const params = new URLSearchParams(searchParams);
    if (next === 1) params.delete("step");
    else params.set("step", String(next));
    setSearchParams(params);
  };
  const [files, setFiles] = useState<File[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  // §34: статус асинхронной операции виден пользователю — очередь и распознавание
  // различаются, потому что документ может ждать освободившегося воркера.
  const [ocrStage, setOcrStage] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Дата закрытия, если срок записи уже прошёл и сервер закрыл её при сохранении (Т40).
  const [savedClosed, setSavedClosed] = useState<{ id: string; closedOn: string } | null>(null);
  const [error, setError] = useState("");
  const updateDetail = <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) =>
    setDetails((current) => ({ ...current, [key]: value }));
  const resetWizard = () => {
    setStep(1);
    setSavedClosed(null);
    setType(null);
    setName("");
    setAmount("");
    setDate(todayIsoDate());
    setSecurity(null);
    setQuantity("");
    setPurchasePrice("");
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
  // Выбор бумаги другой группы (искали «акцию», выбрали облигацию) переводит и тип.
  const pickSecurity = (picked: MoexSecurity | null) => {
    setSecurity(picked);
    setError("");
    if (picked && !picked.offline) setType(moexGroupTypes[picked.group]);
  };
  const goToConfirm = (event: FormEvent) => {
    event.preventDefault();
    if (isSecurity && !security) {
      setError("Выберите бумагу из списка подсказок");
      return;
    }
    setError("");
    setStep(3);
  };
  const submit = async () => {
    if (!type) return;
    setSaving(true);
    setError("");
    const common = { id: crypto.randomUUID(), type, date, institution: institution || "Ручной ввод", source: "manual" };
    // Бумага уходит без суммы: название, параметры выпуска и цену сервер берёт с MOEX.
    // У вклада и прочего одна сумма — она же вложенная.
    const payload = isSecurity && security && !security.unlisted
      ? {
          ...common,
          ticker: security.secid,
          ...(security.offline ? { name: security.shortName } : {}),
          quantity: Number(quantity),
          averagePrice: purchasePrice.trim() ? Number(purchasePrice) : undefined,
        }
      : isSecurity && security?.unlisted
      ? {
          // Бумаги нет на бирже: без тикера сервер не ходит на MOEX, сумма — по цене покупки.
          ...common,
          name: security.shortName,
          quantity: Number(quantity),
          averagePrice: Number(purchasePrice),
          amount: Number(quantity) * Number(purchasePrice),
          invested: Number(quantity) * Number(purchasePrice),
          currency,
        }
      : {
          ...common,
          name,
          amount: Number(amount),
          invested: Number(amount),
          currency,
          ...(type === "Вклады" ? depositPayload(details) : {}),
        };
    try {
      const created = await onSubmit(payload as unknown as Product);
      setSavedClosed(created?.closedOn ? { id: created.id, closedOn: created.closedOn } : null);
      setSaved(true);
    } catch (submitError) {
      setError(errorText(submitError, "Не удалось сохранить продукт"));
    } finally {
      setSaving(false);
    }
  };
  // §34: распознавание вынесено из HTTP-запроса в фоновый воркер, поэтому загрузка только
  // ставит документ в очередь и возвращает 202, а страница опрашивает его статус.
  // Скриншоты обрабатываются по одному (§18 — «один или несколько», Т37): сбой одного
  // файла не отменяет остальные, а попадает в сводку строкой «Не удалось распознать».
  async function recognizeScreenshot() {
    if (!files.length) return;
    setRecognizing(true);
    setError("");
    const documentIds: string[] = [];
    const combined: OcrUploadResult = { date: "", items: [], failures: [], fileCount: files.length, repeatedFiles: [] };
    try {
      for (const [index, file] of files.entries()) {
        const prefix = files.length > 1 ? `${index + 1} из ${files.length}: ` : "";
        setOcrStage(`${prefix}загружаем скриншот...`);
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
          setOcrStage(`${prefix}в очереди на распознавание...`);
          const result = await waitForOcrResult(uploaded.documentId, prefix);
          documentIds.push(uploaded.documentId);
          combined.date ||= result.date || "";
          combined.items.push(...((result.items || []) as OcrItem[]));
          combined.failures.push(...(result.failures || []));
          if (uploaded.alreadyUploadedAt) {
            combined.alreadyUploadedAt ||= uploaded.alreadyUploadedAt;
            combined.repeatedFiles!.push(file.name);
          }
        } catch (fileError) {
          // Единственный файл — ошибка остаётся на странице, как раньше: повторить можно сразу.
          if (files.length === 1) throw fileError;
          if (fileError instanceof Error && fileError.message === "Сессия истекла") return;
          combined.failures.push({
            filename: file.name,
            reason: fileError instanceof NetworkError ? "Не удалось загрузить изображение" : errorText(fileError, "Не удалось распознать изображение"),
          });
        }
      }
      onOcrComplete({
        ...combined,
        documentId: documentIds.length ? documentIds.join(",") : undefined,
        date: combined.date || new Date().toISOString().slice(0, 10),
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
  async function waitForOcrResult(documentId: string, prefix = "") {
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
      if (status.status === "processing") setOcrStage(prefix ? `${prefix}распознаём изображение...` : "Распознаём изображение...");
      if (status.status === "failed") throw new Error(status.error || "Не удалось распознать изображение");
      if (status.status === "done") return status.result || {};
      if (Date.now() > deadline) {
        throw new Error("Распознавание занимает дольше обычного. Записи появятся в портфеле, когда обработка завершится.");
      }
    }
  }
  return (
    <Page title="Добавить продукт" subtitle="Ручной ввод или распознавание скриншота" back>
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
          <strong>Загрузите скриншоты</strong>
          <small>Один или несколько файлов PNG, JPG, WebP до 10 МБ каждый. Распознанные данные сохранятся сразу, без подтверждения — отредактировать их можно будет на экране-сводке.</small>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(event) => {
              setFiles(Array.from(event.target.files ?? []));
              setError("");
            }}
          />
          {files.length > 0 && (
            <>
              <p>{files.map((file) => file.name).join(", ")}</p>
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
              {isSecurity ? (
                <>
                  <SecurityPicker
                    token={token}
                    onUnauthorized={onUnauthorized}
                    value={security}
                    onPick={pickSecurity}
                    autoFocus
                    allowUnlisted
                  />
                  <label>
                    Количество, шт.
                    <input
                      value={quantity}
                      onChange={(event) => setQuantity(event.target.value)}
                      type="number"
                      min="0"
                      step="any"
                      placeholder="10"
                      required
                    />
                  </label>
                  <label>
                    Дата покупки
                    <input value={date} onChange={(event) => setDate(event.target.value)} type="date" required />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Название
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={type === "Вклады" ? "Например, Вклад «Надёжный»" : "Например, доля в ООО"}
                      autoFocus
                      required
                    />
                  </label>
                  {type === "Вклады" && (
                    <label>
                      Банк
                      <input
                        value={institution}
                        onChange={(event) => setInstitution(event.target.value)}
                        placeholder="Например, Сбербанк"
                      />
                    </label>
                  )}
                  <label>
                    {type === "Вклады" ? "Сумма открытия" : "Сумма"}
                    <input
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      type="number"
                      min="0.01"
                      step="any"
                      placeholder="100000"
                      required
                    />
                  </label>
                  {type === "Вклады" && (
                    <label>
                      Ставка, % годовых
                      <input
                        value={details.rate}
                        onChange={(event) => updateDetail("rate", event.target.value)}
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="18"
                        required
                      />
                    </label>
                  )}
                  <label>
                    {type === "Вклады" ? "Дата открытия" : "Дата"}
                    <input value={date} onChange={(event) => setDate(event.target.value)} type="date" required />
                  </label>
                  {type === "Вклады" && (
                    <label>
                      Дата окончания
                      <input
                        value={details.termEndDate}
                        onChange={(event) => updateDetail("termEndDate", event.target.value)}
                        type="date"
                      />
                      <small className="muted">У накопительного счёта без срока оставьте пустым.</small>
                    </label>
                  )}
                </>
              )}
              {error && <small className="form-error">{error}</small>}
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
              {isSecurity && security ? (
                <p>
                  <strong>{security.shortName}</strong>
                  {!security.offline && <span className="muted"> · {security.secid}</span>}
                  <br />
                  {typeOptionLabel(type)} · {quantity} шт. · {fullDate(date)}
                  <br />
                  {security.price !== null ? (
                    <span className="muted">
                      Цена на бирже {securityPriceText(security.price, security.currency)} — стоимость ≈{" "}
                      {securityPriceText(security.price * Number(quantity), security.currency)}
                    </span>
                  ) : (
                    <span className="attention-text">
                      {security.unlisted
                        ? "Бумаги нет на бирже — укажите цену покупки, стоимость считается по ней."
                        : "Цены на бирже сейчас нет — укажите цену покупки."}
                    </span>
                  )}
                </p>
              ) : (
                <p>
                  <strong>{name}</strong>
                  <br />
                  {typeOptionLabel(type)} · {money(Number(amount))} · {fullDate(date)}
                  {type === "Вклады" && details.rate && ` · ${percentText(Number(details.rate))}`}
                  {type === "Вклады" && details.termEndDate && ` · до ${fullDate(details.termEndDate)}`}
                  {institution && (
                    <>
                      <br />
                      <span className="muted">{institution}</span>
                    </>
                  )}
                </p>
              )}
              {isSecurity && security?.price === null && (
                <label>
                  Цена покупки за 1 шт.
                  <input
                    value={purchasePrice}
                    onChange={(event) => setPurchasePrice(event.target.value)}
                    type="number"
                    min="0"
                    step="any"
                    required
                  />
                </label>
              )}
              <details className="details-block">
                <summary>Добавить дополнительные детали</summary>
                <div className="details-fields">
                  {isSecurity && security?.price !== null && (
                    <label>
                      Цена покупки за 1 шт.
                      <input
                        value={purchasePrice}
                        onChange={(event) => setPurchasePrice(event.target.value)}
                        type="number"
                        min="0"
                        step="any"
                        placeholder={security ? String(security.price) : ""}
                      />
                      <small className="muted">
                        Если не указать, вложенным считается стоимость по сегодняшней цене — доход начнёт
                        считаться с этого дня.
                      </small>
                    </label>
                  )}
                  {type !== "Вклады" && (
                    <label>
                      {isSecurity ? "Брокер" : "Банк или брокер"}
                      <input
                        value={institution}
                        onChange={(event) => setInstitution(event.target.value)}
                        placeholder="Необязательно"
                      />
                    </label>
                  )}
                  {type === "Вклады" && <DepositOptionalFields details={details} onChange={updateDetail} />}
                  {(!isSecurity || security?.unlisted) && (
                    <label>
                      Валюта
                      <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                        {currencyOptions}
                      </select>
                    </label>
                  )}
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
                  disabled={saving || (isSecurity && security?.price === null && !(Number(purchasePrice) > 0))}
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
          {savedClosed && (
            <p className="muted">
              Срок уже прошёл, поэтому запись сразу закрыта {fullDate(savedClosed.closedOn)}: вложенное
              и доход отмечены полученными. Закрытые записи в списке инструментов не
              показываются — её <Link to={`/products/${savedClosed.id}`}>карточка</Link> открывается
              по ссылке, а выплаты видны в «Выплатах» и «Операциях».
            </p>
          )}
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
// Правка инструмента (§9, §40.4): у вклада и прочего — одна сумма открытия, у бумаги —
// количество и необязательная цена покупки; стоимость бумаги считается по цене биржи.
function EditProductPage({
  products,
  token,
  onUnauthorized,
  onSubmit,
}: {
  products: Product[];
  token: string;
  onUnauthorized: () => void;
  onSubmit: (product: Product) => void;
}) {
  const { id } = useParams();
  const product = products.find((item) => item.id === id);
  const [name, setName] = useState(product?.name || "");
  const [type, setType] = useState<AssetType>(product?.type || "Облигации");
  const [amount, setAmount] = useState(String(product?.invested || product?.amount || ""));
  const [institution, setInstitution] = useState(product?.institution || "");
  const [currency, setCurrency] = useState(product?.currency || "RUB");
  const [date, setDate] = useState(product?.date || "");
  const [quantity, setQuantity] = useState(product?.quantity !== undefined ? String(product.quantity) : "");
  const [purchasePrice, setPurchasePrice] = useState(product?.averagePrice !== undefined ? String(product.averagePrice) : "");
  const [security, setSecurity] = useState<MoexSecurity | null>(null);
  const [details, setDetails] = useState<ProductDetails>(productToDetails(product));
  useEffect(() => {
    if (!product) return;
    setName(product.name);
    setType(product.type);
    setAmount(String(product.invested || product.amount));
    setInstitution(product.institution);
    setCurrency(product.currency);
    setDate(product.date || "");
    setQuantity(product.quantity !== undefined ? String(product.quantity) : "");
    setPurchasePrice(product.averagePrice !== undefined ? String(product.averagePrice) : "");
    setSecurity(null);
    setDetails(productToDetails(product));
    // Перезаполняется и когда запись пришла позже первого рендера (прямая ссылка, BUG-18).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, Boolean(product)]);
  if (!product) return <MissingRecord to="/products" />;
  const updateDetail = <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) =>
    setDetails((current) => ({ ...current, [key]: value }));
  const isSecurity = quotedTypes.has(type);
  const pickSecurity = (picked: MoexSecurity | null) => {
    setSecurity(picked);
    if (picked && !picked.offline) {
      setType(moexGroupTypes[picked.group]);
      setName(picked.shortName);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const base = { id: product.id, name, type, institution: institution || "Ручной ввод", ...(date ? { date } : {}) };
    if (!isSecurity) {
      // Одна сумма: сколько положено (§17). Текущая стоимость вклада — эта сумма плюс
      // начисленные проценты, их считает Portfolio Engine по ставке.
      onSubmit({
        ...base,
        amount: Number(amount),
        invested: Number(amount),
        currency,
        ...(type === "Вклады" ? depositPayload(details) : {}),
      } as unknown as Product);
      return;
    }
    const count = Number(quantity);
    const picked = security && !security.offline ? security : null;
    const marketPrice = picked ? picked.price : product.currentPrice ?? null;
    // Цена покупки не указана — вложено считается по текущей цене бумаги.
    const averagePrice = purchasePrice.trim() ? Number(purchasePrice) : marketPrice ?? undefined;
    const valuePrice = marketPrice ?? averagePrice;
    onSubmit({
      ...base,
      quantity: count,
      averagePrice,
      ...(valuePrice !== undefined ? { amount: count * valuePrice } : {}),
      ...(security
        ? {
            ticker: security.secid,
            ...(picked
              ? {
                  isin: picked.isin,
                  currency: picked.currency,
                  nominal: picked.nominal,
                  currentPrice: picked.price ?? undefined,
                  accruedInterest: picked.accruedInterest !== null ? picked.accruedInterest * count : undefined,
                  couponRate: picked.couponRate,
                  couponDate: picked.nextCouponDate,
                  maturityDate: picked.maturityDate,
                  ofertaDate: picked.offerDate,
                }
              : {}),
          }
        : {
            // НКД хранится на всю позицию — при новом количестве пересчитывается на него.
            ...(product.accruedInterest && product.quantity && count !== product.quantity
              ? { accruedInterest: (product.accruedInterest / product.quantity) * count }
              : {}),
            ...(type === "Облигации" ? bondPayload(details) : {}),
          }),
    } as unknown as Product);
  };
  const pickerBlock = (
    <SecurityPicker
      token={token}
      onUnauthorized={onUnauthorized}
      value={security}
      onPick={pickSecurity}
      initialQuery={product.ticker || ""}
    />
  );
  return (
    <Page title="Редактировать инструмент" subtitle={product.name} back>
      <form className="modal-form" onSubmit={submit}>
        <label>
          Тип продукта
          <select value={type} onChange={(event) => setType(event.target.value as AssetType)}>
            {Object.keys(typeColors).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        {isSecurity && !product.ticker && (
          <>
            <p className="muted">Укажите бумагу — название, купон и цену подставим с Московской биржи.</p>
            {pickerBlock}
          </>
        )}
        <label>
          Название
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        {isSecurity ? (
          <>
            <label>
              Количество, шт.
              <input value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" min="0" step="any" required />
            </label>
            <label>
              Цена покупки за 1 шт.
              <input
                value={purchasePrice}
                onChange={(event) => setPurchasePrice(event.target.value)}
                type="number"
                min="0"
                step="any"
                placeholder={product.currentPrice !== undefined ? String(product.currentPrice) : "Необязательно"}
              />
              <small className="muted">Пусто — вложенным считается стоимость по текущей цене.</small>
            </label>
            <label>
              Дата покупки
              <input value={date} onChange={(event) => setDate(event.target.value)} type="date" />
            </label>
            <label>
              Брокер
              <input value={institution} onChange={(event) => setInstitution(event.target.value)} />
            </label>
          </>
        ) : (
          <>
            {type === "Вклады" && (
              <label>
                Банк
                <input value={institution} onChange={(event) => setInstitution(event.target.value)} />
              </label>
            )}
            <label>
              {type === "Вклады" ? "Сумма открытия" : "Сумма"}
              <input value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min="0.01" step="any" required />
            </label>
            {type === "Вклады" && (
              <label>
                Ставка, % годовых
                <input value={details.rate} onChange={(event) => updateDetail("rate", event.target.value)} type="number" min="0" step="0.01" />
              </label>
            )}
            <label>
              {type === "Вклады" ? "Дата открытия" : "Дата"}
              <input value={date} onChange={(event) => setDate(event.target.value)} type="date" />
            </label>
            {type === "Вклады" && (
              <label>
                Дата окончания
                <input value={details.termEndDate} onChange={(event) => updateDetail("termEndDate", event.target.value)} type="date" />
              </label>
            )}
          </>
        )}
        <details className="details-block">
          <summary>Добавить дополнительные детали</summary>
          <div className="details-fields">
            {type === "Вклады" && <DepositOptionalFields details={details} onChange={updateDetail} />}
            {isSecurity && product.ticker && (
              <>
                <p className="muted">Другая бумага — найдите её на бирже:</p>
                {pickerBlock}
              </>
            )}
            {type === "Облигации" && !security && (
              <>
                <p className="muted">Параметры выпуска обычно приходят с биржи — правьте, только если там ошибка.</p>
                <BondIssueFields details={details} onChange={updateDetail} />
              </>
            )}
            {type !== "Вклады" && !isSecurity && (
              <label>
                Банк или брокер
                <input value={institution} onChange={(event) => setInstitution(event.target.value)} />
              </label>
            )}
            {!isSecurity && (
              <label>
                Валюта
                <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                  {currencyOptions}
                </select>
              </label>
            )}
          </div>
        </details>
        <button className="primary-button" type="submit">
          Сохранить изменения
        </button>
      </form>
    </Page>
  );
}
function DeleteProductPage({
  products,
  transactions,
  onConfirm,
}: {
  products: Product[];
  transactions: Transaction[];
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
  // Сервер удаляет вместе с продуктом его операции и выплаты (Т28) — пользователь должен
  // знать, что результат изменится.
  const operations = transactions.filter((item) => item.positionId === id && item.source !== "broker").length;
  return (
    <Page title="Удалить инструмент" subtitle="Это действие нельзя отменить" back>
      <div className="confirm-card">
        <p>
          Удалить <strong>{product.name}</strong>
          {product.closedOn ? ` (закрыт ${fullDate(product.closedOn)})` : ` (${valueText(valuationOf(product).value)})`}
          {" "}из портфеля?
        </p>
        {operations > 0 && (
          <p className="muted">
            Вместе с ним удалятся его операции ({operations}) и выплаты — финансовый
            результат пересчитается, как будто продукта не было.
          </p>
        )}
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
    // Загрузка из нескольких скриншотов (Т37): документы читаются по отдельности и
    // складываются в одну сводку; не найденный документ из списка пропускается.
    const ids = documentId.split(",").filter(Boolean);
    void (async () => {
      try {
        const bodies = await Promise.all(
          ids.map(async (id) => {
            const response = await apiFetch(`${apiUrl}/ocr/documents/${encodeURIComponent(id)}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const body = (await response.json().catch(() => ({}))) as { status?: string; result?: OcrUploadResult };
            return response.ok ? body : { status: "failed" };
          }),
        );
        if (cancelled) return;
        if (bodies.some((body) => body.status !== "done" && body.status !== "failed")) return setLoadState("pending");
        const results = bodies.flatMap((body) => (body.status === "done" && body.result ? [body.result] : []));
        if (!results.length) return setLoadState("missing");
        setLoaded({
          documentId,
          date: results[0].date,
          items: results.flatMap((result) => result.items || []),
          failures: results.flatMap((result) => result.failures || []),
          fileCount: ids.length,
        });
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
  if (!documentId) return <Navigate to="/products" replace />;
  // Неизвестный или чужой адрес сводки — честное «не найдено», а не молчаливый уход (Т42).
  if (loadState === "missing") {
    return (
      <Page title="Загрузка не найдена" subtitle="Сводка распознавания" back>
        <p className="muted">
          Такой загрузки скриншота нет — возможно, ссылка устарела или в ней опечатка. Все
          добавленные со скриншотов записи есть в списке инструментов.
        </p>
        <div className="confirm-actions">
          <Link className="primary-button" to="/products">
            К инструментам
          </Link>
          <Link className="outline-button" to="/products/new">
            Загрузить скриншот
          </Link>
        </div>
      </Page>
    );
  }
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
      title={`Добавлено ${(summary.fileCount ?? 1) > 1 ? `со скриншотов (${summary.fileCount})` : "со скриншота"} от ${formattedDate}`}
      subtitle="Данные сохранены как распознаны. Проверьте каждую запись и поправьте при необходимости."
    >
      {summary.alreadyUploadedAt && (summary.fileCount ?? 1) <= 1 && (
        <div className="demo-note warn">
          ⚠ Этот скриншот уже загружался{" "}
          {formatDateTime(summary.alreadyUploadedAt)} — повторно
          он не обрабатывался, новые записи не созданы. Ниже — результат прошлой обработки.
        </div>
      )}
      {(summary.fileCount ?? 1) > 1 && Boolean(summary.repeatedFiles?.length) && (
        <div className="demo-note warn">
          ⚠ Уже загружались раньше и повторно не обрабатывались: {summary.repeatedFiles!.join(", ")}.
          Их записи ниже — из прошлой обработки, новых не создано.
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
          {summary.failures.map((failure, index) => (
            <div className="list-row" key={`${failure.filename}-${index}`}>
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
            min="0.01"
            step="any"
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
            min="0.01"
            step="any"
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
const tradableProducts = (products: Product[]) => products.filter((product) => product.type !== "Деньги");
// Покупка и продажа всегда привязаны к инструменту (по умолчанию — к первому в списке),
// доход — только если пользователь выбрал инструмент, остальные операции — никогда.
function transactionPositionId(type: TransactionType, positionId: string, products: Product[]) {
  if (POSITION_TRANSACTION_TYPES.includes(type)) return positionId || tradableProducts(products)[0]?.id;
  // null, а не undefined: при правке пустое поле не уходит в JSON, и сервер оставил бы прежнюю привязку.
  if (INCOME_TRANSACTION_TYPES.includes(type)) return positionId || null;
  return null;
}
function TransactionInstrumentSelect({
  type,
  products,
  positionId,
  onChange,
}: {
  type: TransactionType;
  products: Product[];
  positionId: string;
  onChange: (positionId: string) => void;
}) {
  const trades = POSITION_TRANSACTION_TYPES.includes(type);
  if (!trades && !INCOME_TRANSACTION_TYPES.includes(type)) return null;
  return (
    <label>
      Инструмент
      <select
        value={trades ? transactionPositionId(type, positionId, products) || "" : positionId}
        onChange={(event) => onChange(event.target.value)}
      >
        {!trades && <option value="">Без привязки</option>}
        {tradableProducts(products).map((product) => (
          <option value={product.id} key={product.id}>
            {product.name}
          </option>
        ))}
      </select>
    </label>
  );
}
// Пополнение, вывод и выплата без инструмента бывают в USD и CNY (§12, Т36).
// У операции с инструментом валюта — его.
function TransactionCurrencySelect({
  type,
  positionId,
  currency,
  onChange,
}: {
  type: TransactionType;
  positionId: string;
  currency: string;
  onChange: (currency: string) => void;
}) {
  if (POSITION_TRANSACTION_TYPES.includes(type) || positionId) return null;
  return (
    <label>
      Валюта
      <select value={currency} onChange={(event) => onChange(event.target.value)}>
        {currencyOptions}
      </select>
    </label>
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
  const [currency, setCurrency] = useState("RUB");
  // Из карточки инструмента операция открывается уже привязанной к нему.
  const [positionId, setPositionId] = useState(
    () => products.find((product) => product.id === searchParams.get("position"))?.id || "",
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      id: crypto.randomUUID(),
      title: title || transactionTypeLabels[type],
      amount: Number(amount),
      date,
      type,
      positionId: transactionPositionId(type, positionId, products),
      quantity: tradesPosition && quantity ? Number(quantity) : undefined,
      price: tradesPosition && price ? Number(price) : undefined,
      currency,
    });
  };
  const tradesPosition = POSITION_TRANSACTION_TYPES.includes(type);
  // Сумма покупки по умолчанию — количество × цена, пока пользователь не ввёл её сам.
  const suggestAmount = (nextQuantity: string, nextPrice: string) => {
    const total = Number(nextQuantity) * Number(nextPrice);
    if (total > 0) setAmount(String(Math.round(total * 100) / 100));
  };
  return (
    <Page title="Новая операция" subtitle="Покупка, продажа, комиссия или выплата" back>
      <form className="modal-form" onSubmit={submit}>
        <label>
          Тип операции
          <select
            value={type}
            onChange={(event) =>
              setType(event.target.value as TransactionType)
            }
          >
            {transactionTypeOptions()}
          </select>
        </label>
        <TransactionInstrumentSelect
          type={type}
          products={products}
          positionId={positionId}
          onChange={setPositionId}
        />
        <TransactionCurrencySelect type={type} positionId={positionId} currency={currency} onChange={setCurrency} />
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
            min="0.01"
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
  const [positionId, setPositionId] = useState(transaction?.positionId || "");
  const [currency, setCurrency] = useState(transaction?.currency || "RUB");
  useEffect(() => {
    if (!transaction) return;
    setType(transaction.type);
    setTitle(transaction.title);
    setAmount(String(transaction.amount));
    setDate(transaction.date);
    setPositionId(transaction.positionId || "");
    setCurrency(transaction.currency || "RUB");
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
      positionId: transactionPositionId(type, positionId, products),
      currency,
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
            {transactionTypeOptions(type)}
          </select>
        </label>
        <TransactionInstrumentSelect
          type={type}
          products={products}
          positionId={positionId}
          onChange={setPositionId}
        />
        <TransactionCurrencySelect type={type} positionId={positionId} currency={currency} onChange={setCurrency} />
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
            min="0.01"
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
          {payoutMoney(transaction)})?
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

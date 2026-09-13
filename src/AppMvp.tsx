import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import "./App.css";

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
};
type Snapshot = { date: string; value: number; invested: number | null };
type OcrFailure = { filename: string; reason: string };
// possibleDuplicate — транзиентный флаг только этого ответа (§18, вариант А: запись всё
// равно сохраняется, пользователь сам решает на экране-сводке), не персистится как поле Product.
type OcrItem = Product & { possibleDuplicate?: boolean };
type OcrUploadResult = { date: string; items: OcrItem[]; failures: OcrFailure[] };
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
  paid: number;
  groups: GroupSummary[];
  valuation: {
    incomplete: boolean;
    unavailable: { id: string; name: string; group: string; reason: string }[];
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
      .filter((item) => item.status === "expected")
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

const storageKey = "capital-mvp-state";
const apiUrl = "/api";
// Опрос статуса OCR (§34): интервал заметно больше такта воркера (OCR_POLL_SECONDS),
// чтобы страница не долбила API, но результат появлялся почти сразу после обработки.
const OCR_POLL_INTERVAL_MS = 1500;
const OCR_WAIT_LIMIT_MS = 3 * 60 * 1000;
const tokenKey = "capital-api-token";
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
const payoutTypeLabels: Record<PayoutType, string> = {
  COUPON: "Купон",
  DIVIDEND: "Дивиденды",
  INTEREST: "Проценты",
  DEPOSIT_PRINCIPAL: "Возврат вклада",
  REDEMPTION: "Погашение",
  OTHER: "Прочее",
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
const pct = (numerator: number, denominator: number) =>
  denominator ? (numerator / denominator) * 100 : 0;
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" })
    .format(new Date(`${date}T12:00:00`))
    .replace(".", "");
const fullDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString("ru-RU");
function pnlDisplay(current: number, invested: number) {
  const diff = current - invested;
  const percent = pct(diff, invested);
  const positive = diff >= 0;
  const sign = positive ? "+" : "";
  return {
    className: positive ? "teal-text" : "danger-text",
    amountText: `${sign}${money(diff)}`,
    percentText: `${sign}${percent.toFixed(1).replace(".", ",")}%`,
  };
}
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
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [payments, setPayments] = useState<Payment[]>(initialPayments);
  const [transactions, setTransactions] =
    useState<Transaction[]>(initialTransactions);
  const [toast, setToast] = useState("");
  const [hideAmounts, setHideAmounts] = useState(false);
  const [token, setToken] = useState(
    () => localStorage.getItem(tokenKey) || "",
  );
  const [apiOnline, setApiOnline] = useState(false);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [brokerStatus, setBrokerStatus] = useState<BrokerStatus | null>(null);
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
          fetch(`${apiUrl}/positions`, { headers }),
          fetch(`${apiUrl}/payouts`, { headers }),
          fetch(`${apiUrl}/transactions`, { headers }),
          fetch(`${apiUrl}/portfolio/history`, { headers }),
          fetch(`${apiUrl}/portfolio/summary`, { headers }),
          fetch(`${apiUrl}/auth/me`, { headers }),
          fetch(`${apiUrl}/brokers/tinkoff`, { headers }),
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
  async function refreshSummary() {
    const response = await fetch(`${apiUrl}/portfolio/summary`, {
      headers: authHeaders,
    });
    if (response.ok) setSummary((await response.json()) as PortfolioSummary);
  }
  async function refreshBrokerStatus() {
    const response = await fetch(`${apiUrl}/brokers/tinkoff`, {
      headers: authHeaders,
    });
    if (response.ok) setBrokerStatus((await response.json()) as BrokerStatus);
  }
  async function addProduct(product: Product) {
    if (apiOnline) {
      const response = await fetch(`${apiUrl}/positions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(product),
      });
      if (!response.ok) throw new Error("Не удалось сохранить продукт");
      product = (await response.json()) as Product;
      await refreshSummary();
    }
    setProducts((current) => [...current, product]);
    setToast("Продукт добавлен в портфель");
  }
  async function addPayment(payment: Payment) {
    if (apiOnline) {
      const response = await fetch(`${apiUrl}/payouts`, {
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
      const response = await fetch(`${apiUrl}/payouts/${payment.id}`, {
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
  async function removePayment(id: string) {
    if (apiOnline) {
      const response = await fetch(`${apiUrl}/payouts/${id}`, {
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
  async function refreshProducts() {
    const response = await fetch(`${apiUrl}/positions`, {
      headers: authHeaders,
    });
    if (response.ok) setProducts((await response.json()) as Product[]);
  }
  async function refreshMarketPrices() {
    const response = await fetch(`${apiUrl}/market-data/refresh`, {
      method: "POST",
      headers: authHeaders,
    });
    if (!response.ok) {
      setToast("Не удалось обновить цены");
      return;
    }
    const result = (await response.json()) as { checked: number; updated: number };
    await refreshProducts();
    await refreshSummary();
    setToast(
      result.checked === 0
        ? "Нет инструментов с тикером для обновления цены"
        : `Обновлено цен: ${result.updated} из ${result.checked}`,
    );
  }
  async function removeProduct(id: string) {
    if (apiOnline) {
      const response = await fetch(`${apiUrl}/positions/${id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!response.ok) throw new Error("Не удалось удалить продукт");
      await refreshSummary();
    }
    setProducts((current) => current.filter((product) => product.id !== id));
    setToast("Продукт удалён");
    navigate("/products");
  }
  async function updateProduct(product: Product) {
    if (apiOnline) {
      const response = await fetch(`${apiUrl}/positions/${product.id}`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify(product),
      });
      if (!response.ok) throw new Error("Не удалось сохранить изменения");
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
    setProducts((current) => [...current, ...result.items]);
    setOcrSummary(result);
    if (result.items.length > 0) void refreshSummary();
    navigate("/ocr-summary");
  }
  async function addTransaction(transaction: Transaction) {
    if (apiOnline) {
      const response = await fetch(`${apiUrl}/transactions`, {
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
      const response = await fetch(`${apiUrl}/transactions/${transaction.id}`, {
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
      const response = await fetch(`${apiUrl}/transactions/${id}`, {
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
  async function signIn(
    event: FormEvent<HTMLFormElement>,
    mode: "login" | "register",
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch(`${apiUrl}/auth/${mode}`, {
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
    if (!response.ok) {
      const result = (await response.json()) as { error?: string };
      setToast(result.error || "Не удалось войти");
      return;
    }
    const result = (await response.json()) as { token: string };
    localStorage.setItem(tokenKey, result.token);
    setToken(result.token);
    setToast(
      mode === "register" ? "Аккаунт создан" : "Добро пожаловать в Капитал",
    );
  }
  async function signOut() {
    if (apiOnline) {
      await fetch(`${apiUrl}/auth/logout`, {
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
    const response = await fetch(`${apiUrl}/auth/me`, {
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

  if (!token) return <Login onSubmit={signIn} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
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
              {label === "Рекомендации" && (
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
              <strong>Пользователь</strong>
              <small>Личный аккаунт</small>
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
            <button
              className="icon-button"
              aria-label="Уведомления"
              type="button"
            >
              ♧<span className="alert-dot" />
            </button>
            <button
              className="mobile-menu"
              aria-label="Открыть меню"
              type="button"
            >
              ☰
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
                userEmail={userEmail}
                apiOnline={apiOnline}
                brokerStatus={brokerStatus}
              />
            }
          />
          <Route
            path="/products"
            element={<ProductsPage products={products} onRefreshPrices={refreshMarketPrices} />}
          />
          <Route
            path="/products/:id"
            element={
              <ProductDetailPage
                products={products}
                transactions={transactions}
                payments={payments}
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
            element={<EditProductPage products={products} onSubmit={updateProduct} />}
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
              <TransactionFormPage products={products} onSubmit={addTransaction} />
            }
          />
          <Route
            path="/transactions/:id/edit"
            element={
              <EditTransactionPage
                transactions={transactions}
                products={products}
                onSubmit={updateTransaction}
              />
            }
          />
          <Route
            path="/transactions/:id/delete"
            element={
              <DeleteTransactionPage
                transactions={transactions}
                onConfirm={removeTransaction}
              />
            }
          />
          <Route
            path="/payments"
            element={<PaymentsPage payments={payments} products={products} />}
          />
          <Route
            path="/payments/new"
            element={<PaymentFormPage onSubmit={addPayment} />}
          />
          <Route
            path="/payments/:id/edit"
            element={
              <EditPaymentPage payments={payments} onSubmit={updatePayment} />
            }
          />
          <Route
            path="/payments/:id/delete"
            element={
              <DeletePaymentPage payments={payments} onConfirm={removePayment} />
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
            path="/integrations"
            element={
              <Integrations token={token} onStatusChange={refreshBrokerStatus} />
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
            element={<OcrSummaryPage summary={ocrSummary} />}
          />
          <Route path="*" element={<Navigate to="/portfolio" replace />} />
        </Routes>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Dashboard({
  summary,
  products,
  payments,
  history,
  hideAmounts,
  onHide,
  userEmail,
  apiOnline,
  brokerStatus,
}: {
  summary: PortfolioSummary | null;
  products: Product[];
  payments: Payment[];
  history: Snapshot[];
  hideAmounts: boolean;
  onHide: () => void;
  userEmail: string | null;
  apiOnline: boolean;
  brokerStatus: BrokerStatus | null;
}) {
  const navigate = useNavigate();
  const display = (value: number) => (hideAmounts ? "••••••" : money(value));
  const linePath = chartPath(history);
  const areaPath = chartPath(history, true);
  const lastSnapshot = history.at(-1);
  // Кратковременный зазор до первого ответа /api/portfolio/summary (или офлайн-эффекта) —
  // не пересчитываем показатели порталу целиком, просто не даём странице упасть.
  const { total, invested, profit, profitPercent, paid, expected, groups, valuation } =
    summary ?? localSummary(products, payments);
  const todayLabel = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
    .format(new Date())
    .toUpperCase();
  const displayName = userEmail?.split("@")[0] || "";
  const brokerDegraded = brokerStatus?.status === "error";
  const brokerHasCache = brokerDegraded && Boolean(brokerStatus?.lastSyncAt);
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
  return (
    <div className="content-wrap">
      <section className="page-heading">
        <div>
          <p className="eyebrow">{todayLabel}</p>
          <h1>
            Добрый день{displayName ? `, ${displayName}` : ""} <span>✦</span>
          </h1>
          <p className="subtitle">
            Вот как чувствует себя ваш капитал сегодня.
          </p>
        </div>
        <Link className="primary-button" to="/products/new">
          <span>＋</span> Добавить продукт
        </Link>
      </section>
      <section className="hero-grid">
        <article className="total-card">
          <div className="card-label">
            ОБЩАЯ СТОИМОСТЬ{" "}
            <button
              className="tiny-button"
              aria-label="Скрыть сумму"
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
          {brokerHasCache && (
            <p className="muted">
              Данные неполные — показано по состоянию на{" "}
              {new Date(brokerStatus!.lastSyncAt!).toLocaleString("ru-RU")}.
            </p>
          )}
          {brokerDegraded && !brokerHasCache && (
            <p className="muted">Данные неполные — брокер недоступен.</p>
          )}
          <div className="profit-line">
            <span className="positive-pill">↗ {display(profit)}</span>
            <strong>+{(profitPercent ?? 0).toFixed(2).replace(".", ",")}%</strong>
            <span className="muted">за всё время</span>
          </div>
          {brokerHasCache && (
            <div className="demo-note">
              ⚠ Данные от брокера «Т-Инвестиции» по состоянию на{" "}
              {new Date(brokerStatus!.lastSyncAt!).toLocaleString("ru-RU")}.
              Не удалось обновить.{" "}
              <Link to="/integrations">Повторить попытку</Link>
            </div>
          )}
          {brokerDegraded && !brokerHasCache && (
            <div className="demo-note">
              ⚠ Не удалось загрузить данные от брокера «Т-Инвестиции».
              Показана только доступная часть портфеля.{" "}
              <Link to="/integrations">Повторить подключение</Link>
            </div>
          )}
          {valuation.incomplete && (
            <div className="demo-note">
              ⚠ Актуальная цена недоступна для {valuation.unavailable.length}{" "}
              инструмент(ов) — их стоимость не включена в общую сумму.
            </div>
          )}
          <div className="chart">
            {history.length ? (
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
              <div className="chart-empty">История появится после первого изменения портфеля</div>
            )}
          </div>
          <div className="chart-footer">
            <span>{history[0] ? dateLabel(history[0].date).split(" ")[1]?.toUpperCase() : "—"}</span>
            <span>{lastSnapshot ? dateLabel(lastSnapshot.date).split(" ")[1]?.toUpperCase() : "—"}</span>
            <div className="periods">
              <button className="selected" type="button">
                1Г
              </button>
              <button type="button">Всё время</button>
            </div>
          </div>
        </article>
        <article className="metrics-card">
          <div className="card-label">КРАТКО О ПОРТФЕЛЕ</div>
          <div className="metric-row">
            <span>Инвестировано</span>
            <strong>{display(invested)}</strong>
          </div>
          <div className="metric-row">
            <span>Выплаты получено</span>
            <strong>{display(paid)}</strong>
          </div>
          <div className="metric-row">
            <span>Ожидается</span>
            <strong className="teal-text">{display(expected)}</strong>
          </div>
          <div className="metric-row">
            <span>Свободные деньги</span>
            <strong>
              {display(
                products.find((product) => product.type === "Деньги")?.amount ||
                  0,
              )}
            </strong>
          </div>
          <button
            className="text-button"
            onClick={() => navigate("/products")}
            type="button"
          >
            Подробнее о портфеле <span>→</span>
          </button>
        </article>
      </section>
      <section className="section-heading">
        <div>
          <h2>Структура портфеля</h2>
          <p>Распределение по классам активов</p>
        </div>
        <button
          className="outline-button"
          onClick={() => navigate("/products")}
          type="button"
        >
          Все инструменты <span>→</span>
        </button>
      </section>
      <section className="lower-grid">
        <article className="allocation-card">
          <div className="donut-wrap">
            <div className="donut">
              <div>
                <strong>
                  {hideAmounts
                    ? "••"
                    : `₽ ${(total / 1000000).toFixed(2).replace(".", ",")}`}
                </strong>
                <small>млн всего</small>
              </div>
            </div>
          </div>
          <div className="holding-list">
            {groups.map((groupSummary) => (
              <div className="holding-row" key={groupSummary.group}>
                <span
                  className={`legend ${typeColors[groupSummary.group as AssetType]}`}
                />
                <div className="holding-name">
                  <strong>{groupSummary.group}</strong>
                  <small>{groupSummary.positions} продукт(а)</small>
                </div>
                <div className="holding-value">
                  <strong>{display(groupSummary.value)}</strong>
                  <small className="teal-text">
                    {(groupSummary.share ?? 0).toFixed(1).replace(".", ",")}%
                  </small>
                </div>
                <span className="share">{Math.round(groupSummary.share ?? 0)}%</span>
              </div>
            ))}
          </div>
        </article>
        <article className="payments-card">
          <div className="section-heading compact">
            <div>
              <h2>Ближайшие выплаты</h2>
              <p>Прогноз на 60 дней</p>
            </div>
            <button
              className="round-arrow"
              onClick={() => navigate("/payments")}
              aria-label="Открыть календарь выплат"
              type="button"
            >
              →
            </button>
          </div>
          <div className="payment-list">
            {payments.slice(0, 3).map((payment) => (
              <div className="payment-row" key={payment.id}>
                <div className="date-box">
                  <strong>{dateLabel(payment.date).split(" ")[0]}</strong>
                  <small>
                    {dateLabel(payment.date).split(" ")[1]?.toUpperCase()}
                  </small>
                </div>
                <div className="payment-info">
                  <strong>{payment.title}</strong>
                  <small>
                    {payoutTypeLabels[payment.type]} · {dateLabel(payment.date)}
                  </small>
                </div>
                <strong className="payment-value">
                  +{money(payment.amount)}
                </strong>
              </div>
            ))}
          </div>
          <button
            className="text-button full-width"
            onClick={() => navigate("/payments")}
            type="button"
          >
            Открыть календарь выплат <span>→</span>
          </button>
        </article>
      </section>
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
} as const;
type ProductSortKey = keyof typeof PRODUCT_SORT_OPTIONS;

function sortProducts(products: Product[], sortBy: ProductSortKey): Product[] {
  const withIndex = products.map((product, index) => ({ product, index }));
  withIndex.sort((a, b) => {
    if (sortBy === "value") return b.product.amount - a.product.amount;
    if (sortBy === "return") {
      return pct(b.product.amount - b.product.invested, b.product.invested) -
        pct(a.product.amount - a.product.invested, a.product.invested);
    }
    if (sortBy === "pnl") {
      return (b.product.amount - b.product.invested) - (a.product.amount - a.product.invested);
    }
    // maturity: с ближайшей датой погашения впереди, без даты — в конец, исходный порядок сохраняется
    if (!a.product.maturityDate && !b.product.maturityDate) return a.index - b.index;
    if (!a.product.maturityDate) return 1;
    if (!b.product.maturityDate) return -1;
    return a.product.maturityDate.localeCompare(b.product.maturityDate);
  });
  return withIndex.map((entry) => entry.product);
}

function ProductsPage({ products, onRefreshPrices }: { products: Product[]; onRefreshPrices: () => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  async function handleRefreshPrices() {
    setRefreshing(true);
    try {
      await onRefreshPrices();
    } finally {
      setRefreshing(false);
    }
  }
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<AssetType | "all">("all");
  const [sortBy, setSortBy] = useState<ProductSortKey>("value");
  const filtered = typeFilter === "all"
    ? products
    : products.filter((product) => product.type === typeFilter);
  const sorted = sortProducts(filtered, sortBy);
  const { visible, hasMore, loadMore, pageSize, setPageSize } = usePagedList(sorted);
  const productTypes = Array.from(new Set(products.map((product) => product.type)));
  return (
    <Page title="Инструменты" subtitle="Все продукты в вашем портфеле">
      <div className="toolbar">
        <Link className="primary-button" to="/products/new">
          ＋ Добавить продукт
        </Link>
        <button
          type="button"
          className="outline-button"
          onClick={handleRefreshPrices}
          disabled={refreshing}
        >
          {refreshing ? "Обновляем…" : "↻ Обновить цены (MOEX)"}
        </button>
        <label className="inline-select">
          <span>Фильтр</span>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as AssetType | "all")}
          >
            <option value="all">Все типы</option>
            {productTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
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
      {sorted.length === 0 ? (
        <p className="muted">
          {products.length === 0
            ? "Пока нет добавленных инструментов."
            : "Нет инструментов, подходящих под выбранный фильтр."}
        </p>
      ) : (
        <div className="list-card">
          {visible.map((product) => {
            const expanded = expandedId === product.id;
            const pnl = pnlDisplay(product.amount, product.invested);
            return (
              <div className="list-row" key={product.id}>
                <button
                  type="button"
                  className="list-row-summary"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : product.id)}
                >
                  <span className="list-row-main">
                    <strong>{product.name}</strong>
                    <span className={`type-tag ${typeColors[product.type]}`}>
                      {product.type}
                    </span>
                  </span>
                  <span className="list-row-value">
                    <strong>{money(product.amount)}</strong>
                    <small className={pnl.className}>{pnl.percentText}</small>
                  </span>
                  <span className="expand-caret">{expanded ? "▲" : "▼"}</span>
                </button>
                {expanded && (
                  <div className="list-row-details">
                    <div className="detail-line">
                      <span>Тикер / ISIN</span>
                      <span>
                        {product.ticker || "—"}
                        {product.isin ? ` · ${product.isin}` : ""}
                      </span>
                    </div>
                    <div className="detail-line">
                      <span>Банк / брокер</span>
                      <span>{product.institution || "—"} · {product.currency}</span>
                    </div>
                    <div className="detail-line">
                      <span>Дата открытия/покупки</span>
                      <span>{fullDate(product.date)}</span>
                    </div>
                    {product.type === "Облигации" &&
                      (product.maturityDate || product.couponRate !== undefined) && (
                        <div className="detail-line">
                          <span>Купон / погашение</span>
                          <span>
                            {product.maturityDate
                              ? `Погашение ${fullDate(product.maturityDate)}`
                              : ""}
                            {product.maturityDate && product.couponRate !== undefined
                              ? " · "
                              : ""}
                            {product.couponRate !== undefined
                              ? `купон ${product.couponRate}%`
                              : ""}
                          </span>
                        </div>
                      )}
                    {product.type === "Вклады" && product.rate !== undefined && (
                      <div className="detail-line">
                        <span>Ставка</span>
                        <span>
                          {product.rate}%
                          {product.termEndDate ? ` · до ${fullDate(product.termEndDate)}` : ""}
                        </span>
                      </div>
                    )}
                    {(product.type === "Акции" || product.type === "Фонды") &&
                      product.quantity !== undefined && (
                        <div className="detail-line">
                          <span>Количество / цена</span>
                          <span>
                            {product.quantity} шт.
                            {product.currentPrice !== undefined
                              ? ` · тек. цена ${money(product.currentPrice)}`
                              : " · текущая цена недоступна"}
                          </span>
                        </div>
                      )}
                    <div className="list-row-actions">
                      <Link className="outline-button" to={`/products/${product.id}`}>
                        Подробнее
                      </Link>
                      {product.source !== "broker" && (
                        <>
                          <Link
                            className="outline-button"
                            to={`/products/${product.id}/edit`}
                          >
                            Редактировать
                          </Link>
                          <Link
                            className="delete-button"
                            to={`/products/${product.id}/delete`}
                          >
                            Удалить
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <ListPagination
            hasMore={hasMore}
            onLoadMore={loadMore}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
          />
        </div>
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
  const { visible, hasMore, loadMore, pageSize, setPageSize } = usePagedList(transactions);
  return (
    <Page title="Операции" subtitle="История пополнений, покупок и выплат">
      <div className="toolbar">
        <Link className="primary-button" to="/transactions/new">
          ＋ Новая операция
        </Link>
      </div>
      {transactions.length === 0 ? (
        <p className="muted">Пока нет операций.</p>
      ) : (
        <div className="list-card">
          {visible.map((transaction) => {
            const expanded = expandedId === transaction.id;
            const position = products.find(
              (product) => product.id === transaction.positionId,
            );
            return (
              <div className="list-row" key={transaction.id}>
                <button
                  type="button"
                  className="list-row-summary"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : transaction.id)}
                >
                  <span className="list-row-main">
                    <strong>{transaction.title}</strong>
                    <span className="type-tag teal">
                      {transactionTypeLabels[transaction.type]}
                    </span>
                  </span>
                  <span className="list-row-value">
                    <strong>{money(transaction.amount)}</strong>
                    <small>{dateLabel(transaction.date)}</small>
                  </span>
                  <span className="expand-caret">{expanded ? "▲" : "▼"}</span>
                </button>
                {expanded && (
                  <div className="list-row-details">
                    <div className="detail-line">
                      <span>Инструмент</span>
                      <span>{position?.name || "Портфель Основной"}</span>
                    </div>
                    <div className="detail-line">
                      <span>Дата</span>
                      <span>{fullDate(transaction.date)}</span>
                    </div>
                    {transaction.currency && (
                      <div className="detail-line">
                        <span>Валюта</span>
                        <span>{transaction.currency}</span>
                      </div>
                    )}
                    <div className="list-row-actions">
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
          <ListPagination
            hasMore={hasMore}
            onLoadMore={loadMore}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}
    </Page>
  );
}
function PaymentRow({
  payment,
  expanded,
  onToggle,
}: {
  payment: Payment;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="list-row">
      <button
        type="button"
        className="list-row-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="list-row-main">
          <strong>{payment.title}</strong>
          <span className="type-tag teal">{payoutTypeLabels[payment.type]}</span>
          {payment.source === "forecast" && (
            <span className="type-tag slate">Прогноз</span>
          )}
        </span>
        <span className="list-row-value">
          <strong>+{money(payment.amount)}</strong>
          <small>{dateLabel(payment.date)}</small>
        </span>
        <span className="expand-caret">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="list-row-details">
          <div className="detail-line">
            <span>Статус</span>
            <span>{payoutStatusLabels[payment.status]}</span>
          </div>
          <div className="detail-line">
            <span>Дата</span>
            <span>{fullDate(payment.date)}</span>
          </div>
          <div className="detail-line">
            <span>Валюта</span>
            <span>{payment.currency}</span>
          </div>
          {payment.source === "forecast" && (
            <div className="detail-line">
              <span>Источник</span>
              <span>
                Расчёт по параметрам инструмента — обновляется автоматически. Правка
                переведёт выплату в ручные.
              </span>
            </div>
          )}
          <div className="list-row-actions">
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
}: {
  payments: Payment[];
  products: Product[];
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<PaymentViewMode>("day");
  const [typeFilter, setTypeFilter] = useState<PayoutType | "all">("all");
  const [instrumentFilter, setInstrumentFilter] = useState<string>("all");
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

  const filtered = payments.filter((payment) => {
    if (typeFilter !== "all" && payment.type !== typeFilter) return false;
    if (instrumentFilter !== "all" && payment.instrumentId !== instrumentFilter) return false;
    if (dateFrom && payment.date < dateFrom) return false;
    if (dateTo && payment.date > dateTo) return false;
    return true;
  });
  const sorted = [...filtered].sort((a, b) => a.date.localeCompare(b.date));

  const now = new Date();
  const currentMonthKey = periodKey(now.toISOString().slice(0, 10), "month");
  const forecastAmount = payments
    .filter((payment) => payment.status === "expected" && periodKey(payment.date, "month") === currentMonthKey)
    .reduce((sum, payment) => sum + payment.amount, 0);

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
      expected: items.filter((item) => item.status === "expected").reduce((sum, item) => sum + item.amount, 0),
      received: items.filter((item) => item.status === "received").reduce((sum, item) => sum + item.amount, 0),
    }));
  }, [sorted, viewMode]);

  const dayPaging = usePagedList(sorted);
  const groupPaging = usePagedList(groups);

  return (
    <Page title="Выплаты" subtitle="Календарь ожидаемых доходов">
      {forecastAmount > 0 && (
        <div className="demo-note">
          📅 В {periodLabel(currentMonthKey, "month").toLowerCase()} ожидается {money(forecastAmount)}
        </div>
      )}
      <div className="toolbar">
        <Link className="primary-button" to="/payments/new">
          ＋ Добавить выплату
        </Link>
        <div className="view-mode-switch">
          <button
            className={viewMode === "day" ? "selected" : ""}
            type="button"
            onClick={() => setViewMode("day")}
          >
            По дням
          </button>
          <button
            className={viewMode === "month" ? "selected" : ""}
            type="button"
            onClick={() => setViewMode("month")}
          >
            По месяцам
          </button>
          <button
            className={viewMode === "year" ? "selected" : ""}
            type="button"
            onClick={() => setViewMode("year")}
          >
            По годам
          </button>
        </div>
      </div>
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
        <label className="inline-select">
          <span>С</span>
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className="inline-select">
          <span>По</span>
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
      </div>
      {sorted.length === 0 ? (
        <p className="muted">
          {payments.length === 0
            ? "Пока нет добавленных выплат."
            : "Нет выплат, подходящих под выбранные условия."}
        </p>
      ) : viewMode === "day" ? (
        <div className="list-card">
          {dayPaging.visible.map((payment) => (
            <PaymentRow
              key={payment.id}
              payment={payment}
              expanded={expandedId === payment.id}
              onToggle={() => setExpandedId(expandedId === payment.id ? null : payment.id)}
            />
          ))}
          <ListPagination
            hasMore={dayPaging.hasMore}
            onLoadMore={dayPaging.loadMore}
            pageSize={dayPaging.pageSize}
            onPageSizeChange={dayPaging.setPageSize}
          />
        </div>
      ) : (
        <div className="list-card">
          {groupPaging.visible.map((group) => {
            const expanded = expandedId === group.key;
            return (
              <div className="list-row" key={group.key}>
                <button
                  type="button"
                  className="list-row-summary"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : group.key)}
                >
                  <span className="list-row-main">
                    <strong>{group.label}</strong>
                  </span>
                  <span className="list-row-value">
                    <strong>+{money(group.received)}</strong>
                    <small>ожидается {money(group.expected)}</small>
                  </span>
                  <span className="expand-caret">{expanded ? "▲" : "▼"}</span>
                </button>
                {expanded && (
                  <div className="list-row-details">
                    <div className="list-card">
                      {group.items.map((payment) => (
                        <div className="list-row" key={payment.id}>
                          <div className="list-row-summary list-row-static">
                            <span className="list-row-main">
                              <strong>{payment.title}</strong>
                              <span className="type-tag teal">
                                {payoutTypeLabels[payment.type]}
                              </span>
                            </span>
                            <span className="list-row-value">
                              <strong>+{money(payment.amount)}</strong>
                              <small>{dateLabel(payment.date)} · {payoutStatusLabels[payment.status]}</small>
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <ListPagination
            hasMore={groupPaging.hasMore}
            onLoadMore={groupPaging.loadMore}
            pageSize={groupPaging.pageSize}
            onPageSizeChange={groupPaging.setPageSize}
          />
        </div>
      )}
    </Page>
  );
}
function ProductDetailPage({
  products,
  transactions,
  payments,
}: {
  products: Product[];
  transactions: Transaction[];
  payments: Payment[];
}) {
  const { id } = useParams();
  const product = products.find((item) => item.id === id);
  if (!product) return <Navigate to="/products" replace />;
  const relatedTransactions = transactions.filter(
    (transaction) => transaction.positionId === product.id,
  );
  const relatedPayments = product.instrumentId
    ? payments.filter((payment) => payment.instrumentId === product.instrumentId)
    : [];
  const received = relatedPayments
    .filter((payment) => payment.status === "received")
    .reduce((sum, payment) => sum + payment.amount, 0);
  const expected = relatedPayments
    .filter((payment) => payment.status === "expected")
    .reduce((sum, payment) => sum + payment.amount, 0);
  const pnl = pnlDisplay(product.amount, product.invested);
  return (
    <Page title={product.name} subtitle="Карточка инструмента" back>
      <div className="confirm-card">
        <div className="detail-line">
          <span>Тип</span>
          <span className={`type-tag ${typeColors[product.type]}`}>{product.type}</span>
        </div>
        <div className="detail-line">
          <span>Тикер</span>
          <span>{product.ticker || "—"}</span>
        </div>
        <div className="detail-line">
          <span>ISIN</span>
          <span>{product.isin || "—"}</span>
        </div>
        <div className="detail-line">
          <span>Банк / брокер</span>
          <span>{product.institution || "—"}</span>
        </div>
        <div className="detail-line">
          <span>Валюта</span>
          <span>{product.currency}</span>
        </div>
        {product.quantity !== undefined && (
          <div className="detail-line">
            <span>Количество</span>
            <span>{product.quantity}</span>
          </div>
        )}
        <div className="detail-line">
          <span>Вложено</span>
          <span>{money(product.invested)}</span>
        </div>
        {product.averagePrice !== undefined && (
          <div className="detail-line">
            <span>Средняя цена</span>
            <span>{money(product.averagePrice)}</span>
          </div>
        )}
        <div className="detail-line">
          <span>Текущая цена</span>
          <span>
            {product.currentPrice !== undefined
              ? money(product.currentPrice)
              : "Актуальная цена недоступна"}
          </span>
        </div>
        <div className="detail-line">
          <span>Текущая стоимость</span>
          <span>{money(product.amount)}</span>
        </div>
        <div className="detail-line">
          <span>Нереализованный P&L</span>
          <span className={pnl.className}>
            {pnl.amountText} ({pnl.percentText})
          </span>
        </div>
        <div className="detail-line">
          <span>Выплаты получено</span>
          <span>{money(received)}</span>
        </div>
        <div className="detail-line">
          <span>Выплаты ожидается</span>
          <span>{money(expected)}</span>
        </div>
        <div className="detail-line">
          <span>Дата покупки / открытия</span>
          <span>{fullDate(product.date)}</span>
        </div>
        {product.maturityDate && (
          <div className="detail-line">
            <span>Дата погашения</span>
            <span>{fullDate(product.maturityDate)}</span>
          </div>
        )}
        {product.ofertaDate && (
          <div className="detail-line">
            <span>Оферта</span>
            <span>{fullDate(product.ofertaDate)}</span>
          </div>
        )}
        {product.termEndDate && (
          <div className="detail-line">
            <span>Окончание вклада</span>
            <span>{fullDate(product.termEndDate)}</span>
          </div>
        )}
        <div className="detail-line">
          <span>Источник данных</span>
          <span>{sourceLabels[product.source] || product.source}</span>
        </div>
        {product.source !== "broker" && (
          <div className="confirm-actions">
            <Link className="outline-button" to={`/products/${product.id}/edit`}>
              Редактировать
            </Link>
            <Link className="delete-button" to={`/products/${product.id}/delete`}>
              Удалить
            </Link>
          </div>
        )}
      </div>
      <div className="section-heading compact">
        <div>
          <h2>История операций</h2>
        </div>
      </div>
      {relatedTransactions.length === 0 ? (
        <p className="muted">Операций по этому инструменту пока нет.</p>
      ) : (
        <div className="list-card">
          {relatedTransactions.map((transaction) => (
            <div className="list-row" key={transaction.id}>
              <div className="list-row-summary list-row-static">
                <span className="list-row-main">
                  <strong>{transaction.title}</strong>
                  <span className="type-tag teal">
                    {transactionTypeLabels[transaction.type]}
                  </span>
                </span>
                <span className="list-row-value">
                  <strong>{money(transaction.amount)}</strong>
                  <small>{dateLabel(transaction.date)}</small>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="section-heading compact">
        <div>
          <h2>История выплат</h2>
        </div>
      </div>
      {relatedPayments.length === 0 ? (
        <p className="muted">Выплат по этому инструменту пока нет.</p>
      ) : (
        <div className="list-card">
          {relatedPayments.map((payment) => (
            <div className="list-row" key={payment.id}>
              <div className="list-row-summary list-row-static">
                <span className="list-row-main">
                  <strong>{payoutTypeLabels[payment.type]}</strong>
                  <span className="type-tag teal">
                    {payoutStatusLabels[payment.status]}
                  </span>
                </span>
                <span className="list-row-value">
                  <strong>+{money(payment.amount)}</strong>
                  <small>{dateLabel(payment.date)}</small>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
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
};

function BreakdownList({
  title,
  items,
  emptyHint,
}: {
  title: string;
  items: StructureBreakdown[];
  emptyHint: string;
}) {
  const { visible, hasMore, loadMore, pageSize, setPageSize } = usePagedList(items);
  return (
    <article className="allocation-card">
      <div className="section-heading compact">
        <div>
          <h2>{title}</h2>
          <p>{items.length === 0 ? emptyHint : `${items.length} позици${items.length === 1 ? "я" : "и"}`}</p>
        </div>
      </div>
      {items.length > 0 && (
        <div className="list-card">
          {visible.map((item) => {
            const pnl = pnlDisplay(item.value, item.invested);
            return (
              <div className="list-row" key={item.key}>
                <div className="list-row-summary list-row-static">
                  <div className="list-row-main">
                    <strong>{item.key}</strong>
                    {item.priceUnavailable > 0 && (
                      <small className="danger-text">
                        {" "}
                        · цена недоступна ({item.priceUnavailable})
                      </small>
                    )}
                  </div>
                  <div className="list-row-value">
                    <strong>{money(item.value)}</strong>
                    <small className={pnl.className}>
                      {Math.round(item.share ?? 0)}% · {pnl.percentText}
                    </small>
                  </div>
                </div>
              </div>
            );
          })}
          <ListPagination
            hasMore={hasMore}
            onLoadMore={loadMore}
            pageSize={pageSize}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}
    </article>
  );
}

function AnalyticsPage({
  summary,
  token,
}: {
  summary: PortfolioSummary | null;
  token: string;
}) {
  const { total, profitPercent, groups } = summary ?? localSummary([], []);
  const bonds = groups.find((groupSummary) => groupSummary.group === "Облигации");
  const [structure, setStructure] = useState<PortfolioStructure | null>(null);
  const [structureError, setStructureError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`${apiUrl}/portfolio/structure`, {
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
      <div className="analytics-grid">
        <article className="stat-card">
          <span>Доходность</span>
          <strong>+{(profitPercent ?? 0).toFixed(2).replace(".", ",")}%</strong>
          <small>простая доходность</small>
        </article>
        <article className="stat-card">
          <span>Классов активов</span>
          <strong>{groups.length}</strong>
          <small>в текущем портфеле</small>
        </article>
        <article className="stat-card">
          <span>Доля облигаций</span>
          <strong>{Math.round(bonds?.share ?? pct(bonds?.value ?? 0, total))}%</strong>
          <small>от общей стоимости</small>
        </article>
      </div>
      <div className="insight-box">
        <span>✦</span>
        <div>
          <strong>Распределение выглядит сбалансированным</strong>
          <p>
            Более половины капитала находится в инструментах с регулярными
            выплатами.
          </p>
        </div>
      </div>
      {structureError && <p className="form-error">{structureError}</p>}
      {structure && (
        <>
          <BreakdownList title="По валютам" items={structure.byCurrency} emptyHint="Нет данных" />
          <BreakdownList
            title="По брокерам"
            items={structure.byBroker}
            emptyHint="Нет счетов с типом «брокер»"
          />
          <BreakdownList
            title="По банкам"
            items={structure.byBank}
            emptyHint="Нет счетов с типом «банк»"
          />
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
  { icon: string; warning: boolean }
> = {
  concentration: { icon: "!", warning: true },
  maturity: { icon: "⏳", warning: true },
  drawdown: { icon: "↓", warning: true },
  payout_gap: { icon: "ℹ", warning: false },
};

function Recommendations({ token }: { token: string }) {
  const [items, setItems] = useState<RecommendationItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`${apiUrl}/recommendations`, {
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
        <div className="recommendation-list">
          {items.map((item, index) => {
            const style = RECOMMENDATION_STYLE[item.ruleType];
            return (
              <article
                key={`${item.ruleType}-${index}`}
                className={`recommendation${style.warning ? " warning" : ""}`}
              >
                <span className="rec-icon">{style.icon}</span>
                <div>
                  <p>{item.text}</p>
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
      const response = await fetch(`${apiUrl}/settings`, {
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
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(`${apiUrl}/settings`, {
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
}: {
  token: string;
  onStatusChange: () => void;
}) {
  const [brokerToken, setBrokerToken] = useState("");
  const [status, setStatus] = useState("disconnected");
  const [maskedToken, setMaskedToken] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState<string | undefined>();
  const [lastError, setLastError] = useState<string | undefined>();
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState(false);

  const loadStatus = async () => {
    const response = await fetch(`${apiUrl}/brokers/tinkoff`, {
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
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch(`${apiUrl}/brokers/tinkoff/connect`, {
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
      const response = await fetch(`${apiUrl}/brokers/tinkoff/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = (await response.json()) as {
        message?: string;
        error?: string;
      };
      setMessage(result.message || result.error || "");
      await loadStatus();
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
        {maskedToken && (
          <p className="field-hint">Сохранённый токен: {maskedToken}</p>
        )}
        {lastSyncAt && (
          <p className="field-hint">
            Последняя синхронизация: {new Date(lastSyncAt).toLocaleString("ru-RU")}
          </p>
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
            Токен передаётся только на backend, хранится в зашифрованном виде
            и никогда не показывается в интерфейсе.
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
          <p className="eyebrow">ПОРТФЕЛЬ · MVP</p>
          <h1>{title}</h1>
          <p className="subtitle">{subtitle}</p>
        </div>
      </section>
      {children}
    </div>
  );
}
function Login({
  onSubmit,
}: {
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
    mode: "login" | "register",
  ) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(event) => onSubmit(event, mode)}>
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
          />
        </label>
        <label>
          Пароль
          <input
            name="password"
            type="password"
            placeholder="Минимум 8 символов"
            minLength={8}
            required
          />
        </label>
        {mode === "register" && (
          <label>
            Код приглашения
            <input
              name="inviteCode"
              type="text"
              placeholder="Выдаётся владельцем стенда"
              autoComplete="off"
            />
          </label>
        )}
        <button className="primary-button" type="submit">
          {mode === "login" ? "Войти в портфель" : "Зарегистрироваться"}
        </button>
        <button
          className="text-button auth-switch"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
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

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

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
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayIsoDate);
  const [invested, setInvested] = useState("");
  const [institution, setInstitution] = useState("");
  const [currency, setCurrency] = useState("RUB");
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
  const submit = async () => {
    if (!type) return;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        id: crypto.randomUUID(),
        name,
        type,
        amount: Number(amount),
        invested: Number(invested || amount),
        date,
        institution: institution || "Ручной ввод",
        currency,
        source: "manual",
        ...detailsToPayload(details),
      });
      setSaved(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось сохранить продукт");
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
      const uploadResponse = await fetch(`${apiUrl}/ocr/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: (() => { const formData = new FormData(); formData.append("image", file); return formData; })(),
      });
      if (uploadResponse.status === 401) {
        onUnauthorized();
        return;
      }
      const uploaded = (await uploadResponse.json()) as { error?: string; documentId?: string };
      if (!uploadResponse.ok || !uploaded.documentId) {
        throw new Error(uploaded.error || "Не удалось загрузить изображение");
      }
      setOcrStage("В очереди на распознавание...");
      const result = await waitForOcrResult(uploaded.documentId);
      onOcrComplete({
        date: result.date || new Date().toISOString().slice(0, 10),
        items: result.items || [],
        failures: result.failures || [],
      });
    } catch (recognitionError) {
      setError(recognitionError instanceof Error ? recognitionError.message : "Не удалось распознать изображение");
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
      const response = await fetch(`${apiUrl}/ocr/documents/${documentId}`, {
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
                {recognizing ? ocrStage || "Распознаём и сохраняем..." : "Распознать и сохранить"}
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
                    Первичная цена
                    <input
                      value={invested}
                      onChange={(event) => setInvested(event.target.value)}
                      type="number"
                      min="1"
                      placeholder="100000"
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
                  disabled={saving}
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!product) return <Navigate to="/products" replace />;
  const updateDetail = <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) =>
    setDetails((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      ...product,
      name,
      type,
      amount: Number(amount),
      invested: Number(invested || amount),
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
          Первичная цена
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
        <button className="primary-button" type="submit">
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
  onConfirm: (id: string) => void;
}) {
  const { id } = useParams();
  const product = products.find((item) => item.id === id);
  if (!product || !id) return <Navigate to="/products" replace />;
  return (
    <Page title="Удалить инструмент" subtitle="Это действие нельзя отменить" back>
      <div className="confirm-card">
        <p>
          Удалить <strong>{product.name}</strong> ({money(product.amount)})
          из портфеля?
        </p>
        <div className="confirm-actions">
          <Link className="outline-button" to="/products">
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
function OcrSummaryPage({ summary }: { summary: OcrUploadResult | null }) {
  if (!summary) return <Navigate to="/products" replace />;
  const formattedDate = new Date(`${summary.date}T12:00:00`).toLocaleDateString("ru-RU");
  return (
    <Page
      title={`Добавлено со скриншота от ${formattedDate}`}
      subtitle="Данные сохранены как распознаны. Проверьте каждую запись и поправьте при необходимости."
    >
      <div className="table-card">
        {(summary.items.length > 0 || summary.failures.length > 0) && (
          <div className="table-head">
            <span>Название</span>
            <span>Тип</span>
            <span>Стоимость</span>
            <span>Источник</span>
            <span>Действия</span>
          </div>
        )}
        {summary.items.map((item) => (
          <div className="table-row" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <small>
                {item.institution} · {item.currency}
              </small>
              {item.possibleDuplicate && (
                <small className="danger-text">
                  ⚠ Похоже, такой инструмент уже есть в портфеле — проверьте, не дубликат ли это
                </small>
              )}
            </div>
            <span className={`type-tag ${typeColors[item.type]}`}>
              {item.type}
            </span>
            <strong>{money(item.amount)}</strong>
            <span className="teal-text">Со скриншота</span>
            <Link className="outline-button" to={`/products/${item.id}/edit`}>
              Редактировать
            </Link>
          </div>
        ))}
        {summary.failures.map((failure) => (
          <div className="table-row" key={failure.filename}>
            <div>
              <strong>Не удалось распознать {failure.filename}</strong>
              <small>{failure.reason}</small>
            </div>
            <span />
            <span />
            <span>Требует ввода</span>
            <Link className="outline-button" to="/products/new">
              Добавить вручную
            </Link>
          </div>
        ))}
        {!summary.items.length && !summary.failures.length && (
          <p>На этом скриншоте не найдено ни одной записи.</p>
        )}
      </div>
      <div style={{ marginTop: 24 }}>
        <Link className="primary-button" to="/portfolio">
          Перейти к портфелю
        </Link>
      </div>
    </Page>
  );
}
function EditPaymentPage({
  payments,
  onSubmit,
}: {
  payments: Payment[];
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
  useEffect(() => {
    if (!payment) return;
    setTitle(payment.title);
    setAmount(String(payment.amount));
    setDate(payment.date);
    setType(payment.type);
    setStatus(payment.status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!payment) return <Navigate to="/payments" replace />;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ ...payment, title, amount: Number(amount), date, type, status });
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
  if (!payment || !id) return <Navigate to="/payments" replace />;
  return (
    <Page title="Удалить выплату" subtitle="Это действие нельзя отменить" back>
      <div className="confirm-card">
        <p>
          Удалить <strong>{payment.title}</strong> ({money(payment.amount)}) из
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
function PaymentFormPage({
  onSubmit,
}: {
  onSubmit: (payment: Payment) => void;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [type, setType] = useState<PayoutType>("OTHER");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      id: crypto.randomUUID(),
      title,
      amount: Number(amount),
      date,
      type,
      status: "expected",
      currency: "RUB",
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
  const [type, setType] = useState<TransactionType>("BUY");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [positionId, setPositionId] = useState(products[0]?.id || "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      id: crypto.randomUUID(),
      title: title || transactionTypeLabels[type],
      amount: Number(amount),
      date: new Date().toISOString().slice(0, 10),
      type,
      positionId: POSITION_TRANSACTION_TYPES.includes(type)
        ? positionId
        : undefined,
    });
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
  }, [id]);
  if (!transaction) return <Navigate to="/transactions" replace />;
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
  if (!transaction || !id) return <Navigate to="/transactions" replace />;
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

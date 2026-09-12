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
type Payment = {
  id: string;
  title: string;
  amount: number;
  date: string;
  type: PayoutType;
  status: PayoutStatus;
  currency: string;
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
type OcrUploadResult = { date: string; items: Product[]; failures: OcrFailure[] };

const storageKey = "capital-mvp-state";
const apiUrl = "/api";
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
  ["Портфель", "◈", "/portfolio"],
  ["Инструменты", "▦", "/products"],
  ["Операции", "↕", "/transactions"],
  ["Выплаты", "◷", "/payments"],
  ["Аналитика", "⌁", "/analytics"],
  ["Рекомендации", "✦", "/recommendations"],
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
        ] = await Promise.all([
          fetch(`${apiUrl}/positions`, { headers }),
          fetch(`${apiUrl}/payouts`, { headers }),
          fetch(`${apiUrl}/transactions`, { headers }),
          fetch(`${apiUrl}/portfolio/history`, { headers }),
        ]);
        if (
          productsResponse.status === 401 ||
          paymentsResponse.status === 401 ||
          transactionsResponse.status === 401 ||
          historyResponse.status === 401
        ) {
          expireSession();
          return;
        }
        if (
          !productsResponse.ok ||
          !paymentsResponse.ok ||
          !transactionsResponse.ok ||
          !historyResponse.ok
        )
          throw new Error("API unavailable");
        setProducts((await productsResponse.json()) as Product[]);
        setPayments((await paymentsResponse.json()) as Payment[]);
        setTransactions((await transactionsResponse.json()) as Transaction[]);
        setHistory((await historyResponse.json()) as Snapshot[]);
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

  const total = products.reduce((sum, product) => sum + product.amount, 0);
  const invested = products.reduce((sum, product) => sum + product.invested, 0);
  const profit = total - invested;
  const expected = payments
    .filter((item) => item.status === "expected")
    .reduce((sum, payment) => sum + payment.amount, 0);
  const paid = payments
    .filter((item) => item.status === "received")
    .reduce((sum, item) => sum + item.amount, 0);
  const groups = useMemo(
    () =>
      Object.entries(
        products.reduce<Record<string, number>>((result, product) => {
          result[product.type] = (result[product.type] || 0) + product.amount;
          return result;
        }, {}),
      ).sort((a, b) => b[1] - a[1]),
    [products],
  );

  const authHeaders = {
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  async function addProduct(product: Product) {
    if (apiOnline) {
      const response = await fetch(`${apiUrl}/positions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(product),
      });
      if (!response.ok) throw new Error("Не удалось сохранить продукт");
      product = (await response.json()) as Product;
    }
    setProducts((current) => [...current, product]);
    setToast("Продукт добавлен в портфель");
    navigate("/products");
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
  async function removeProduct(id: string) {
    if (apiOnline) {
      const response = await fetch(`${apiUrl}/positions/${id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!response.ok) throw new Error("Не удалось удалить продукт");
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
                total={total}
                invested={invested}
                profit={profit}
                paid={paid}
                expected={expected}
                groups={groups}
                products={products}
                payments={payments}
                history={history}
                hideAmounts={hideAmounts}
                onHide={() => setHideAmounts(!hideAmounts)}
              />
            }
          />
          <Route
            path="/products"
            element={<ProductsPage products={products} />}
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
            element={<PaymentsPage payments={payments} />}
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
              <AnalyticsPage total={total} groups={groups} profit={profit} />
            }
          />
          <Route
            path="/recommendations"
            element={<Recommendations token={token} />}
          />
          <Route path="/integrations" element={<Integrations token={token} />} />
          <Route
            path="/settings"
            element={
              <Settings
                themePreference={themePreference}
                onThemeChange={setThemePreference}
                onReset={() => {
                  localStorage.removeItem(storageKey);
                  setProducts(initialProducts);
                  setPayments(initialPayments);
                  setTransactions(initialTransactions);
                  setToast("Демонстрационные данные восстановлены");
                }}
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
  total,
  invested,
  profit,
  paid,
  expected,
  groups,
  products,
  payments,
  history,
  hideAmounts,
  onHide,
}: {
  total: number;
  invested: number;
  profit: number;
  paid: number;
  expected: number;
  groups: [string, number][];
  products: Product[];
  payments: Payment[];
  history: Snapshot[];
  hideAmounts: boolean;
  onHide: () => void;
}) {
  const navigate = useNavigate();
  const display = (value: number) => (hideAmounts ? "••••••" : money(value));
  const linePath = chartPath(history);
  const areaPath = chartPath(history, true);
  const lastSnapshot = history.at(-1);
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
          <p className="eyebrow">СРЕДА, 6 СЕНТЯБРЯ 2026</p>
          <h1>
            Добрый день, Максим <span>✦</span>
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
          <div className="profit-line">
            <span className="positive-pill">↗ {display(profit)}</span>
            <strong>
              +{pct(profit, invested).toFixed(2).replace(".", ",")}%
            </strong>
            <span className="muted">за всё время</span>
          </div>
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
            {groups.map(([name, value]) => (
              <div className="holding-row" key={name}>
                <span className={`legend ${typeColors[name as AssetType]}`} />
                <div className="holding-name">
                  <strong>{name}</strong>
                  <small>
                    {products.filter((product) => product.type === name).length}{" "}
                    продукт(а)
                  </small>
                </div>
                <div className="holding-value">
                  <strong>{display(value)}</strong>
                  <small className="teal-text">
                    {pct(value, total).toFixed(1).replace(".", ",")}%
                  </small>
                </div>
                <span className="share">
                  {Math.round(pct(value, total))}%
                </span>
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
      <div className="demo-note">
        <span>✦</span> Данные сохраняются в браузере. Подключение API брокера и
        OCR добавим следующим техническим этапом.
      </div>
    </div>
  );
}

function ProductsPage({ products }: { products: Product[] }) {
  return (
    <Page title="Инструменты" subtitle="Все продукты в вашем портфеле">
      <div className="toolbar">
        <Link className="primary-button" to="/products/new">
          ＋ Добавить продукт
        </Link>
        <button className="outline-button" type="button">
          Фильтр: все типы⌄
        </button>
      </div>
      <div className="table-card">
        <div className="table-head">
          <span>Название</span>
          <span>Тип</span>
          <span>Стоимость</span>
          <span>Доходность</span>
          <span>Действия</span>
        </div>
        {products.map((product) => (
          <div className="table-row" key={product.id}>
            <div>
              <strong>{product.name}</strong>
              <small>
                {product.ticker || product.institution} · {product.currency}
              </small>
              {product.type === "Облигации" && (product.maturityDate || product.couponRate !== undefined) && (
                <small>
                  {product.maturityDate ? `Погашение ${fullDate(product.maturityDate)}` : ""}
                  {product.maturityDate && product.couponRate !== undefined ? " · " : ""}
                  {product.couponRate !== undefined ? `купон ${product.couponRate}%` : ""}
                </small>
              )}
              {product.type === "Вклады" && product.rate !== undefined && (
                <small>
                  Ставка {product.rate}%
                  {product.termEndDate ? ` · до ${fullDate(product.termEndDate)}` : ""}
                </small>
              )}
              {(product.type === "Акции" || product.type === "Фонды") && product.quantity !== undefined && (
                <small>
                  {product.quantity} шт.
                  {product.currentPrice !== undefined ? ` · тек. цена ${money(product.currentPrice)}` : " · текущая цена недоступна"}
                </small>
              )}
            </div>
            <span className={`type-tag ${typeColors[product.type]}`}>
              {product.type}
            </span>
            <strong>{money(product.amount)}</strong>
            <span className="teal-text">
              +
              {pct(product.amount - product.invested, product.invested)
                .toFixed(1)
                .replace(".", ",")}
              %
            </span>
            <div className="row-actions">
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
            </div>
          </div>
        ))}
      </div>
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
  return (
    <Page title="Операции" subtitle="История пополнений, покупок и выплат">
      <div className="toolbar">
        <Link className="primary-button" to="/transactions/new">
          ＋ Новая операция
        </Link>
      </div>
      <div className="table-card">
        <div className="table-head">
          <span>Операция</span>
          <span>Тип</span>
          <span>Сумма</span>
          <span>Дата</span>
          <span>Действия</span>
        </div>
        {transactions.map((transaction) => (
          <div className="table-row" key={transaction.id}>
            <div>
              <strong>{transaction.title}</strong>
              <small>
                {products.find(
                  (product) => product.id === transaction.positionId,
                )?.name || "Портфель Основной"}
              </small>
            </div>
            <span className="type-tag teal">
              {transactionTypeLabels[transaction.type]}
            </span>
            <strong>{money(transaction.amount)}</strong>
            <span>{dateLabel(transaction.date)}</span>
            <div className="row-actions">
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
        ))}
      </div>
    </Page>
  );
}
function PaymentsPage({ payments }: { payments: Payment[] }) {
  return (
    <Page title="Выплаты" subtitle="Календарь ожидаемых доходов">
      <div className="toolbar">
        <Link className="primary-button" to="/payments/new">
          ＋ Добавить выплату
        </Link>
      </div>
      <div className="payment-grid">
        {payments.map((payment) => (
          <article className="payment-large" key={payment.id}>
            <div className="date-box">
              <strong>{dateLabel(payment.date).split(" ")[0]}</strong>
              <small>
                {dateLabel(payment.date).split(" ")[1]?.toUpperCase()}
              </small>
            </div>
            <div>
              <strong>{payment.title}</strong>
              <p>
                {payoutTypeLabels[payment.type]} · {dateLabel(payment.date)}
              </p>
            </div>
            <b>+{money(payment.amount)}</b>
            <div className="row-actions">
              <Link className="outline-button" to={`/payments/${payment.id}/edit`}>
                Редактировать
              </Link>
              <Link className="delete-button" to={`/payments/${payment.id}/delete`}>
                Удалить
              </Link>
            </div>
          </article>
        ))}
      </div>
    </Page>
  );
}
function AnalyticsPage({
  total,
  groups,
  profit,
}: {
  total: number;
  groups: [string, number][];
  profit: number;
}) {
  return (
    <Page title="Аналитика" subtitle="Базовые показатели портфеля">
      <div className="analytics-grid">
        <article className="stat-card">
          <span>Доходность</span>
          <strong>
            +{pct(profit, total - profit).toFixed(2).replace(".", ",")}%
          </strong>
          <small>простая доходность</small>
        </article>
        <article className="stat-card">
          <span>Классов активов</span>
          <strong>{groups.length}</strong>
          <small>в текущем портфеле</small>
        </article>
        <article className="stat-card">
          <span>Доля облигаций</span>
          <strong>
            {Math.round(
              pct(groups.find(([name]) => name === "Облигации")?.[1] || 0, total),
            )}
            %
          </strong>
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
function Settings({
  themePreference,
  onThemeChange,
  onReset,
}: {
  themePreference: ThemePreference;
  onThemeChange: (value: ThemePreference) => void;
  onReset: () => void;
}) {
  return (
    <Page
      title="Настройки"
      subtitle="Параметры портфеля и демонстрационные данные"
    >
      <div className="settings-card">
        <label>
          Базовая валюта
          <select defaultValue="RUB">
            <option>RUB — российский рубль</option>
            <option>USD — доллар США</option>
            <option>CNY — китайский юань</option>
          </select>
        </label>
        <label>
          Название портфеля
          <input defaultValue="Основной" />
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
        <button className="outline-button" onClick={onReset} type="button">
          Восстановить демонстрационные данные
        </button>
        <Link className="delete-button" to="/settings/delete-account">
          Удалить аккаунт
        </Link>
      </div>
    </Page>
  );
}
function Integrations({ token }: { token: string }) {
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
  if (type === "Деньги" || type === "Прочее") return null;
  const showPosition = type === "Облигации" || type === "Акции" || type === "Фонды";
  return (
    <details className="details-block">
      <summary>Добавить дополнительные детали</summary>
      <div className="details-fields">
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
      </div>
    </details>
  );
}
function ProductFormPage({
  token,
  onUnauthorized,
  onSubmit,
  onOcrComplete,
}: {
  token: string;
  onUnauthorized: () => void;
  onSubmit: (product: Product) => void;
  onOcrComplete: (result: OcrUploadResult) => void;
}) {
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<"manual" | "screenshot">(
    searchParams.get("mode") === "screenshot" ? "screenshot" : "manual",
  );
  const [type, setType] = useState<AssetType>("Облигации");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [invested, setInvested] = useState("");
  const [institution, setInstitution] = useState("");
  const [details, setDetails] = useState<ProductDetails>(emptyProductDetails);
  const [file, setFile] = useState<File | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState("");
  const updateDetail = <K extends keyof ProductDetails>(key: K, value: ProductDetails[K]) =>
    setDetails((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      id: crypto.randomUUID(),
      name,
      type,
      amount: Number(amount),
      invested: Number(invested || amount),
      ticker: "",
      date: new Date().toISOString().slice(0, 10),
      institution: institution || "Ручной ввод",
      currency: "RUB",
      source: "manual",
      ...detailsToPayload(details),
    });
  };
  async function recognizeScreenshot() {
    if (!file) return;
    setRecognizing(true);
    setError("");
    try {
      const response = await fetch(`${apiUrl}/ocr/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: (() => { const formData = new FormData(); formData.append("image", file); return formData; })(),
      });
      const result = (await response.json()) as {
        error?: string;
        date?: string;
        items?: Product[];
        failures?: OcrFailure[];
      };
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(result.error || "Не удалось распознать изображение");
      onOcrComplete({
        date: result.date || new Date().toISOString().slice(0, 10),
        items: result.items || [],
        failures: result.failures || [],
      });
    } catch (recognitionError) {
      setError(recognitionError instanceof Error ? recognitionError.message : "Не удалось распознать изображение");
    } finally {
      setRecognizing(false);
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
                {recognizing ? "Распознаём и сохраняем..." : "Распознать и сохранить"}
              </button>
            </>
          )}
          {error && <small className="form-error">{error}</small>}
        </div>
      )}
      {mode === "manual" && (
        <form className="modal-form" onSubmit={submit}>
          <label>
            Название
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Например, ОФЗ 26241"
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
              placeholder="100000"
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
              placeholder="100000"
            />
          </label>
          <label>
            Банк или брокер
            <input
              value={institution}
              onChange={(event) => setInstitution(event.target.value)}
              placeholder="Необязательно"
            />
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
            Сохранить продукт
          </button>
        </form>
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
  const [details, setDetails] = useState<ProductDetails>(productToDetails(product));
  useEffect(() => {
    if (!product) return;
    setName(product.name);
    setType(product.type);
    setAmount(String(product.amount));
    setInvested(String(product.invested));
    setInstitution(product.institution);
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

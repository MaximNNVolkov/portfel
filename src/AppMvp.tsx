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
};
type Payment = {
  id: string;
  title: string;
  amount: number;
  date: string;
  type: AssetType;
};
type Transaction = {
  id: string;
  title: string;
  amount: number;
  date: string;
  kind: "Пополнение" | "Покупка" | "Продажа" | "Выплата";
  productId?: string;
};
type Snapshot = { date: string; value: number };
type OcrFailure = { filename: string; reason: string };
type OcrUploadResult = { date: string; items: Product[]; failures: OcrFailure[] };

const storageKey = "capital-mvp-state";
const apiUrl = "http://localhost:3001/api";
const tokenKey = "capital-api-token";
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
    type: "Облигации",
  },
  {
    id: "p2",
    title: "Дивиденд Сбера",
    amount: 8920,
    date: "2026-09-27",
    type: "Акции",
  },
  {
    id: "p3",
    title: "Проценты по вкладу",
    amount: 17100,
    date: "2026-10-10",
    type: "Вклады",
  },
];
const initialTransactions: Transaction[] = [
  {
    id: "t1",
    title: "Покупка ОФЗ 26241",
    amount: 502000,
    date: "2026-02-12",
    kind: "Покупка",
  },
  {
    id: "t2",
    title: "Пополнение брокерского счёта",
    amount: 250000,
    date: "2026-03-18",
    kind: "Пополнение",
  },
  {
    id: "t3",
    title: "Купон ОФЗ 26241",
    amount: 12480,
    date: "2026-08-20",
    kind: "Выплата",
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
const money = (value: number) =>
  `₽ ${Math.round(value).toLocaleString("ru-RU")}`;
const pct = (numerator: number, denominator: number) =>
  denominator ? (numerator / denominator) * 100 : 0;
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" })
    .format(new Date(`${date}T12:00:00`))
    .replace(".", "");
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
          fetch(`${apiUrl}/products`, { headers }),
          fetch(`${apiUrl}/payments`, { headers }),
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
  const expected = payments.reduce((sum, payment) => sum + payment.amount, 0);
  const paid = transactions
    .filter((item) => item.kind === "Выплата")
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
      const response = await fetch(`${apiUrl}/products`, {
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
      const response = await fetch(`${apiUrl}/payments`, {
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
  async function removeProduct(id: string) {
    if (apiOnline) {
      const response = await fetch(`${apiUrl}/products/${id}`, {
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
      const response = await fetch(`${apiUrl}/products/${product.id}`, {
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
    setProducts((current) =>
      current.map((product) =>
        product.id === transaction.productId
          ? {
              ...product,
              amount:
                transaction.kind === "Продажа"
                  ? product.amount - transaction.amount
                  : product.amount + transaction.amount,
              invested:
                transaction.kind === "Продажа"
                  ? Math.max(0, product.invested - transaction.amount)
                  : product.invested + transaction.amount,
            }
          : product,
      ),
    );
    setToast("Операция проведена");
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
            path="/payments"
            element={<PaymentsPage payments={payments} />}
          />
          <Route
            path="/payments/new"
            element={<PaymentFormPage onSubmit={addPayment} />}
          />
          <Route
            path="/analytics"
            element={
              <AnalyticsPage total={total} groups={groups} profit={profit} />
            }
          />
          <Route
            path="/recommendations"
            element={
              <Recommendations
                products={products}
                payments={payments}
                total={total}
              />
            }
          />
          <Route path="/integrations" element={<Integrations token={token} />} />
          <Route
            path="/settings"
            element={
              <Settings
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
                    {payment.type} · {dateLabel(payment.date)}
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
        </div>
        {transactions.map((transaction) => (
          <div className="table-row" key={transaction.id}>
            <div>
              <strong>{transaction.title}</strong>
              <small>
                {products.find(
                  (product) => product.id === transaction.productId,
                )?.name || "Портфель Основной"}
              </small>
            </div>
            <span className="type-tag teal">{transaction.kind}</span>
            <strong>{money(transaction.amount)}</strong>
            <span>{dateLabel(transaction.date)}</span>
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
                {payment.type} · {dateLabel(payment.date)}
              </p>
            </div>
            <b>+{money(payment.amount)}</b>
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
function Recommendations({
  products,
  payments,
  total,
}: {
  products: Product[];
  payments: Payment[];
  total: number;
}) {
  const cash =
    products.find((product) => product.type === "Деньги")?.amount || 0;
  return (
    <Page
      title="Рекомендации"
      subtitle="Простые правила на основе текущего портфеля"
    >
      <div className="recommendation-list">
        <article className="recommendation">
          <span className="rec-icon">✓</span>
          <div>
            <strong>Регулярные выплаты настроены</strong>
            <p>
              В календаре есть {payments.length} будущих выплат на сумму{" "}
              {money(
                payments.reduce((sum, payment) => sum + payment.amount, 0),
              )}
              .
            </p>
          </div>
        </article>
        <article className="recommendation">
          <span className="rec-icon">↗</span>
          <div>
            <strong>Свободные деньги работают</strong>
            <p>
              {pct(cash, total).toFixed(1).replace(".", ",")}% портфеля
              сейчас находится в денежных средствах.
            </p>
          </div>
        </article>
        <article className="recommendation warning">
          <span className="rec-icon">!</span>
          <div>
            <strong>Проверьте концентрацию</strong>
            <p>
              Перед покупкой нового продукта сравните его долю с текущей
              структурой портфеля.
            </p>
          </div>
        </article>
      </div>
    </Page>
  );
}
function Settings({ onReset }: { onReset: () => void }) {
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
        <button className="outline-button" onClick={onReset} type="button">
          Восстановить демонстрационные данные
        </button>
      </div>
    </Page>
  );
}
function Integrations({ token }: { token: string }) {
  const [brokerToken, setBrokerToken] = useState("");
  const [status, setStatus] = useState("disconnected");
  const [message, setMessage] = useState("");
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
    };
    setStatus(result.status || "error");
    setMessage(result.message || "");
    setBrokerToken("");
  };
  const sync = async () => {
    const response = await fetch(`${apiUrl}/brokers/tinkoff/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = (await response.json()) as { message?: string };
    setMessage(result.message || "Синхронизация поставлена в очередь");
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
              : status === "pending"
                ? "Ожидает настройки"
                : "Не подключено"}
          </span>
        </div>
        <form className="modal-form" onSubmit={connect}>
          <label>
            Токен Tinkoff Invest API
            <input
              value={brokerToken}
              onChange={(event) => setBrokerToken(event.target.value)}
              type="password"
              placeholder="Вставьте токен подключения"
              required
            />
          </label>
          <small className="field-hint">
            Токен передаётся только на backend и никогда не показывается в
            интерфейсе.
          </small>
          <button className="primary-button" type="submit">
            Подключить Т-Инвестиции
          </button>
        </form>
        {status === "pending" && (
          <button
            className="outline-button sync-button"
            onClick={sync}
            type="button"
          >
            Запустить синхронизацию
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
  const [file, setFile] = useState<File | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState("");
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
  useEffect(() => {
    if (!product) return;
    setName(product.name);
    setType(product.type);
    setAmount(String(product.amount));
    setInvested(String(product.invested));
    setInstitution(product.institution);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!product) return <Navigate to="/products" replace />;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      ...product,
      name,
      type,
      amount: Number(amount),
      invested: Number(invested || amount),
      institution: institution || "Ручной ввод",
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
function PaymentFormPage({
  onSubmit,
}: {
  onSubmit: (payment: Payment) => void;
}) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      id: crypto.randomUUID(),
      title,
      amount: Number(amount),
      date,
      type: "Прочее",
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
  const [kind, setKind] = useState<Transaction["kind"]>("Покупка");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [productId, setProductId] = useState(products[0]?.id || "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      id: crypto.randomUUID(),
      title: title || kind,
      amount: Number(amount),
      date: new Date().toISOString().slice(0, 10),
      kind,
      productId:
        kind === "Пополнение" || kind === "Выплата" ? undefined : productId,
    });
  };
  return (
    <Page title="Новая операция" subtitle="Покупка, продажа, пополнение или выплата" back>
      <form className="modal-form" onSubmit={submit}>
        <label>
          Тип операции
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as Transaction["kind"])
            }
          >
            <option>Покупка</option>
            <option>Продажа</option>
            <option>Пополнение</option>
            <option>Выплата</option>
          </select>
        </label>
        {(kind === "Покупка" || kind === "Продажа") && (
          <label>
            Инструмент
            <select
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
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

export default AppMvp;

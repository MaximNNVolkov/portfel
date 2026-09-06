import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
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
  ["Портфель", "◈"],
  ["Инструменты", "▦"],
  ["Операции", "↕"],
  ["Выплаты", "◷"],
  ["Аналитика", "⌁"],
  ["Рекомендации", "✦"],
  ["Интеграции", "⇄"],
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
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [payments, setPayments] = useState<Payment[]>(initialPayments);
  const [transactions, setTransactions] =
    useState<Transaction[]>(initialTransactions);
  const [activeNav, setActiveNav] = useState("Портфель");
  const [modal, setModal] = useState<
    "product" | "payment" | "transaction" | null
  >(null);
  const [toast, setToast] = useState("");
  const [hideAmounts, setHideAmounts] = useState(false);
  const [token, setToken] = useState(
    () => localStorage.getItem(tokenKey) || "",
  );
  const [apiOnline, setApiOnline] = useState(false);
  const [history, setHistory] = useState<Snapshot[]>([]);

  function expireSession() {
    localStorage.removeItem(tokenKey);
    setToken("");
    setApiOnline(false);
    setModal(null);
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
    setModal(null);
    setToast("Продукт добавлен в портфель");
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
    setModal(null);
    setToast("Выплата добавлена в календарь");
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
    setModal(null);
    setToast("Операция проведена");
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
  function signOut() {
    localStorage.removeItem(tokenKey);
    setToken("");
    setApiOnline(false);
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
          {navItems.map(([label, icon]) => (
            <button
              className={`nav-item ${activeNav === label ? "active" : ""}`}
              key={label}
              onClick={() => setActiveNav(label)}
              type="button"
            >
              <span className="nav-icon">{icon}</span>
              {label}
              {label === "Рекомендации" && (
                <span className="notification-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            onClick={() => setActiveNav("Настройки")}
            type="button"
          >
            <span className="nav-icon">⚙</span>Настройки
          </button>
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
        {activeNav === "Портфель" && (
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
            onAdd={() => setModal("product")}
            onOpen={setActiveNav}
          />
        )}
        {activeNav === "Инструменты" && (
          <ProductsPage
            products={products}
            onAdd={() => setModal("product")}
            onRemove={removeProduct}
          />
        )}
        {activeNav === "Операции" && (
          <TransactionsPage
            transactions={transactions}
            products={products}
            onAdd={() => setModal("transaction")}
          />
        )}
        {activeNav === "Выплаты" && (
          <PaymentsPage payments={payments} onAdd={() => setModal("payment")} />
        )}
        {activeNav === "Аналитика" && (
          <AnalyticsPage total={total} groups={groups} profit={profit} />
        )}
        {activeNav === "Рекомендации" && (
          <Recommendations
            products={products}
            payments={payments}
            total={total}
          />
        )}
        {activeNav === "Интеграции" && <Integrations token={token} />}
        {activeNav === "Настройки" && (
          <Settings
            onReset={() => {
              localStorage.removeItem(storageKey);
              setProducts(initialProducts);
              setPayments(initialPayments);
              setTransactions(initialTransactions);
              setToast("Демонстрационные данные восстановлены");
            }}
          />
        )}
      </main>
      {modal === "product" && (
        <ProductModal
          token={token}
          onUnauthorized={expireSession}
          onClose={() => setModal(null)}
          onSubmit={addProduct}
        />
      )}
      {modal === "payment" && (
        <PaymentModal onClose={() => setModal(null)} onSubmit={addPayment} />
      )}
      {modal === "transaction" && (
        <TransactionModal
          products={products}
          onClose={() => setModal(null)}
          onSubmit={addTransaction}
        />
      )}
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
  onAdd,
  onOpen,
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
  onAdd: () => void;
  onOpen: (page: string) => void;
}) {
  const display = (value: number) => (hideAmounts ? "••••••" : money(value));
  const linePath = chartPath(history);
  const areaPath = chartPath(history, true);
  const lastSnapshot = history.at(-1);
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
        <button className="primary-button" onClick={onAdd} type="button">
          <span>＋</span> Добавить продукт
        </button>
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
              +{((profit / invested) * 100).toFixed(2).replace(".", ",")}%
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
            onClick={() => onOpen("Инструменты")}
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
          onClick={() => onOpen("Инструменты")}
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
                    {((value / total) * 100).toFixed(1).replace(".", ",")}%
                  </small>
                </div>
                <span className="share">
                  {Math.round((value / total) * 100)}%
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
              onClick={() => onOpen("Выплаты")}
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
            onClick={() => onOpen("Выплаты")}
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

function ProductsPage({
  products,
  onAdd,
  onRemove,
}: {
  products: Product[];
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <Page title="Инструменты" subtitle="Все продукты в вашем портфеле">
      <div className="toolbar">
        <button className="primary-button" onClick={onAdd} type="button">
          ＋ Добавить продукт
        </button>
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
              {(((product.amount - product.invested) / product.invested) * 100)
                .toFixed(1)
                .replace(".", ",")}
              %
            </span>
            <button
              className="delete-button"
              onClick={() => onRemove(product.id)}
              type="button"
            >
              Удалить
            </button>
          </div>
        ))}
      </div>
    </Page>
  );
}
function TransactionsPage({
  transactions,
  products,
  onAdd,
}: {
  transactions: Transaction[];
  products: Product[];
  onAdd: () => void;
}) {
  return (
    <Page title="Операции" subtitle="История пополнений, покупок и выплат">
      <div className="toolbar">
        <button className="primary-button" onClick={onAdd} type="button">
          ＋ Новая операция
        </button>
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
function PaymentsPage({
  payments,
  onAdd,
}: {
  payments: Payment[];
  onAdd: () => void;
}) {
  return (
    <Page title="Выплаты" subtitle="Календарь ожидаемых доходов">
      <div className="toolbar">
        <button className="primary-button" onClick={onAdd} type="button">
          ＋ Добавить выплату
        </button>
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
            +{((profit / (total - profit)) * 100).toFixed(2).replace(".", ",")}%
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
              ((groups.find(([name]) => name === "Облигации")?.[1] || 0) /
                total) *
                100,
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
              {((cash / total) * 100).toFixed(1).replace(".", ",")}% портфеля
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
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="content-wrap inner-page">
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
function ProductModal({
  token,
  onUnauthorized,
  onClose,
  onSubmit,
}: {
  token: string;
  onUnauthorized: () => void;
  onClose: () => void;
  onSubmit: (product: Product) => void;
}) {
  const [mode, setMode] = useState<"manual" | "screenshot">("manual");
  const [type, setType] = useState<AssetType>("Облигации");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [institution, setInstitution] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      id: crypto.randomUUID(),
      name,
      type,
      amount: Number(amount),
      invested: Number(amount),
      ticker: "",
      date: new Date().toISOString().slice(0, 10),
      institution: institution || "Ручной ввод",
      currency: "RUB",
    });
  };
  async function recognizeScreenshot() {
    if (!file) return;
    setRecognizing(true);
    setError("");
    try {
      const response = await fetch(`${apiUrl}/ocr/preview`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: (() => { const formData = new FormData(); formData.append("image", file); return formData; })(),
      });
      const result = (await response.json()) as {
        error?: string;
        items?: Array<{ name: string; type: AssetType; amount: number; institution: string }>;
      };
      if (response.status === 401) {
        onUnauthorized();
        return;
      }
      if (!response.ok || !result.items?.length) throw new Error(result.error || "Не удалось распознать изображение");
      const item = result.items[0];
      setName(item.name);
      setType(item.type);
      setAmount(item.amount > 0 ? String(item.amount) : "");
      setInstitution(item.institution);
      setPreview(true);
    } catch (recognitionError) {
      setError(recognitionError instanceof Error ? recognitionError.message : "Не удалось распознать изображение");
    } finally {
      setRecognizing(false);
    }
  }
  return (
    <Modal title="Добавить продукт" onClose={onClose}>
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
      {mode === "screenshot" && !preview && (
        <div className="upload-box">
          <span>▧</span>
          <strong>Загрузите скриншот</strong>
          <small>PNG, JPG до 10 МБ</small>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={(event) => {
              const selected = event.target.files?.[0] || null;
              setFile(selected);
              setPreview(false);
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
                {recognizing ? "Распознаваем..." : "Распознать данные"}
              </button>
            </>
          )}
          {error && <small className="form-error">{error}</small>}
        </div>
      )}
      {mode === "screenshot" && preview && (
        <div className="ocr-confirm">
          <div className="ocr-status">
            <span>✓</span>
            <div>
              <strong>Проверьте распознанные данные</strong>
              <small>Результат нельзя сохранить без вашего подтверждения</small>
            </div>
          </div>
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
        </div>
      )}
      {(mode === "manual" || preview) && (
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
            Банк или брокер
            <input
              value={institution}
              onChange={(event) => setInstitution(event.target.value)}
              placeholder="Необязательно"
            />
          </label>
          <button className="primary-button" type="submit">
            {preview ? "Подтвердить и сохранить" : "Сохранить продукт"}
          </button>
        </form>
      )}
    </Modal>
  );
}
function PaymentModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
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
    <Modal title="Добавить выплату" onClose={onClose}>
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
    </Modal>
  );
}
function TransactionModal({
  products,
  onClose,
  onSubmit,
}: {
  products: Product[];
  onClose: () => void;
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
    <Modal title="Новая операция" onClose={onClose}>
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
    </Modal>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button onClick={onClose} aria-label="Закрыть" type="button">
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export default AppMvp;

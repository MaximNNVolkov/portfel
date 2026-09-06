import { useState } from 'react'
import './App.css'

const navigation = [
  { label: 'Портфель', icon: '◈' },
  { label: 'Инструменты', icon: '▦' },
  { label: 'Операции', icon: '↕' },
  { label: 'Выплаты', icon: '◷' },
  { label: 'Аналитика', icon: '⌁' },
  { label: 'Рекомендации', icon: '✦' },
]

const holdings = [
  { name: 'Облигации', detail: 'ОФЗ и корпоративные', value: '₽ 1 040 200', change: '+7,2%', share: 44, color: 'teal' },
  { name: 'Акции', detail: 'Российские и зарубежные', value: '₽ 642 380', change: '+12,8%', share: 27, color: 'coral' },
  { name: 'Вклады', detail: '2 банка', value: '₽ 420 000', change: '+6,4%', share: 18, color: 'amber' },
  { name: 'Фонды', detail: 'ПИФы и ETF', value: '₽ 111 740', change: '+4,1%', share: 5, color: 'indigo' },
]

const payments = [
  { date: '12', month: 'СЕН', title: 'Купон ОФЗ 26241', meta: 'Облигации · 14 дней', value: '+₽ 12 480' },
  { date: '19', month: 'СЕН', title: 'Дивиденд Сбера', meta: 'Акции · 21 день', value: '+₽ 8 920' },
  { date: '02', month: 'ОКТ', title: 'Проценты по вкладу', meta: 'Вклады · 34 дня', value: '+₽ 17 100' },
]

function App() {
  const [activeNav, setActiveNav] = useState('Портфель')
  const [showDetails, setShowDetails] = useState(false)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">✳</span><span>Капитал</span></div>
        <div className="portfolio-switcher"><span className="switcher-label">ПОРТФЕЛЬ</span><strong>Основной</strong><span className="chevron">⌄</span></div>
        <nav className="nav-list" aria-label="Основная навигация">
          {navigation.map((item) => (
            <button className={`nav-item ${activeNav === item.label ? 'active' : ''}`} key={item.label} onClick={() => setActiveNav(item.label)} type="button">
              <span className="nav-icon">{item.icon}</span>{item.label}
              {item.label === 'Рекомендации' && <span className="notification-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" type="button"><span className="nav-icon">⚙</span>Настройки</button>
          <div className="profile"><span className="avatar">М</span><span><strong>Максим</strong><small>Личный аккаунт</small></span><span className="more">•••</span></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar"><div className="mobile-brand"><span className="brand-mark">✳</span> Капитал</div><div className="top-actions"><span className="sync-status"><span className="sync-dot" /> Обновлено сегодня, 09:41</span><button className="icon-button" aria-label="Уведомления" type="button">♧<span className="alert-dot" /></button><button className="mobile-menu" aria-label="Открыть меню" type="button">☰</button></div></header>

        <div className="content-wrap">
          <section className="page-heading"><div><p className="eyebrow">СРЕДА, 6 СЕНТЯБРЯ 2026</p><h1>Добрый день, Максим <span>✦</span></h1><p className="subtitle">Вот как чувствует себя ваш капитал сегодня.</p></div><button className="primary-button" type="button" onClick={() => setShowDetails(!showDetails)}><span>＋</span> Добавить продукт</button></section>

          <section className="hero-grid">
            <article className="total-card"><div className="card-label">ОБЩАЯ СТОИМОСТЬ <button className="tiny-button" aria-label="Скрыть сумму" type="button">◉</button></div><div className="total-value">₽ 2 350 420<span className="total-currency">RUB</span></div><div className="profit-line"><span className="positive-pill">↗ +₽ 184 320</span><strong>+8,51%</strong><span className="muted">за всё время</span></div><div className="chart"><div className="chart-grid"><span /><span /><span /><span /></div><svg viewBox="0 0 700 150" preserveAspectRatio="none" role="img" aria-label="Рост стоимости портфеля"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#83d8ca" stopOpacity=".35" /><stop offset="100%" stopColor="#83d8ca" stopOpacity="0" /></linearGradient></defs><path d="M0 130 C35 128 45 108 75 115 S120 105 148 112 S190 75 220 91 S260 72 290 82 S340 70 365 76 S405 40 438 53 S480 66 510 42 S555 54 590 25 S640 34 700 4 L700 150 L0 150Z" fill="url(#area)" /><path d="M0 130 C35 128 45 108 75 115 S120 105 148 112 S190 75 220 91 S260 72 290 82 S340 70 365 76 S405 40 438 53 S480 66 510 42 S555 54 590 25 S640 34 700 4" fill="none" stroke="#279b89" strokeWidth="3" /></svg></div><div className="chart-footer"><span>ЯНВ</span><span>МАР</span><span>МАЙ</span><span>ИЮЛ</span><span>СЕН</span><div className="periods"><button className="selected" type="button">1Г</button><button type="button">Всё время</button></div></div></article>
            <article className="metrics-card"><div className="card-label">КРАТКО О ПОРТФЕЛЕ</div><div className="metric-row"><span>Инвестировано</span><strong>₽ 2 120 000</strong></div><div className="metric-row"><span>Выплаты получено</span><strong>₽ 94 320</strong></div><div className="metric-row"><span>Ожидается</span><strong className="teal-text">₽ 38 500</strong></div><div className="metric-row"><span>Свободные деньги</span><strong>₽ 136 100</strong></div><button className="text-button" type="button">Подробнее о портфеле <span>→</span></button></article>
          </section>

          <section className="section-heading"><div><h2>Структура портфеля</h2><p>Распределение по классам активов</p></div><button className="outline-button" type="button">Все инструменты <span>→</span></button></section>
          <section className="lower-grid"><article className="allocation-card"><div className="donut-wrap"><div className="donut"><div><strong>₽ 2,35</strong><small>млн всего</small></div></div></div><div className="holding-list">{holdings.map((holding) => <div className="holding-row" key={holding.name}><span className={`legend ${holding.color}`} /><div className="holding-name"><strong>{holding.name}</strong><small>{holding.detail}</small></div><div className="holding-value"><strong>{holding.value}</strong><small className="teal-text">{holding.change}</small></div><span className="share">{holding.share}%</span></div>)}</div></article><article className="payments-card"><div className="section-heading compact"><div><h2>Ближайшие выплаты</h2><p>Прогноз на 60 дней</p></div><button className="round-arrow" aria-label="Открыть календарь выплат" type="button">→</button></div><div className="payment-list">{payments.map((payment) => <div className="payment-row" key={payment.title}><div className="date-box"><strong>{payment.date}</strong><small>{payment.month}</small></div><div className="payment-info"><strong>{payment.title}</strong><small>{payment.meta}</small></div><strong className="payment-value">{payment.value}</strong></div>)}</div><button className="text-button full-width" type="button">Открыть календарь выплат <span>→</span></button></article></section>
          <div className="demo-note"><span>✦</span> Данные на экране демонстрационные. Подключите источник, чтобы увидеть свой портфель.</div>
          {showDetails && <div className="toast">Форма добавления продукта будет доступна на следующем шаге MVP.</div>}
        </div>
      </main>
    </div>
  )
}

export default App

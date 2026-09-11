-- Целевая схема портфеля (§11 SPEC.md) + бэкфилл данных из legacy-таблиц.
--
-- Почему отдельная схема `portfolio`, а не public:
-- имена `transactions` и `broker_connections` из §11 заняты legacy-таблицами
-- (001_init_legacy.sql), а legacy на этом шаге не трогаем — API по-прежнему читает и
-- пишет их. Отдельная схема позволяет дать новым таблицам канонические имена из §11
-- прямо сейчас. Когда API переключится на новую схему и legacy-таблицы будут удалены
-- отдельной миграцией, новые таблицы можно либо оставить в схеме `portfolio`, либо
-- перенести в public одной строкой на таблицу (ALTER TABLE ... SET SCHEMA public).
--
-- users остаётся общей таблицей в public: она не legacy, а часть §11 (User), ей
-- не хватает только поля settings.

CREATE SCHEMA IF NOT EXISTS portfolio;

-- §11 User: id, email, password_hash, created_at, settings
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Детерминированный UUID из произвольного ключа. Нужен только бэкфиллу: позволяет
-- связывать создаваемые строки между собой (портфель → счёт → инструмент → позиция),
-- не заводя временных таблиц с соответствиями. Удаляется в конце миграции.
CREATE FUNCTION portfolio.backfill_uuid(namespace TEXT, key TEXT) RETURNS UUID
  LANGUAGE sql IMMUTABLE AS $$ SELECT md5(namespace || ':' || key)::uuid $$;

-- ---------------------------------------------------------------------------
-- Схема
-- ---------------------------------------------------------------------------

-- §11 Portfolio. Схема сразу мультипортфельная (§4, §13): у пользователя может быть
-- несколько портфелей, UI на MVP показывает один.
CREATE TABLE portfolio.portfolios (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'RUB',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_portfolios_user_id ON portfolio.portfolios (user_id);

-- §11 Account: type, broker/bank, account_number (маскированный), currency, status.
-- provider — название банка или брокера; номер счёта хранится только маскированным (§28).
CREATE TABLE portfolio.accounts (
  id UUID PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES portfolio.portfolios (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('broker', 'bank', 'cash', 'other')),
  provider TEXT,
  account_number_masked TEXT,
  currency TEXT NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_accounts_portfolio_id ON portfolio.accounts (portfolio_id);

-- §11 AssetGroup, §7.2. Группы расширяемые: type — машинный ключ, name — подпись в UI.
CREATE TABLE portfolio.asset_groups (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO portfolio.asset_groups (id, name, type, sort_order) VALUES
  (portfolio.backfill_uuid('asset_group', 'deposit'), 'Вклады', 'deposit', 10),
  (portfolio.backfill_uuid('asset_group', 'bond'), 'Облигации', 'bond', 20),
  (portfolio.backfill_uuid('asset_group', 'share'), 'Акции', 'share', 30),
  (portfolio.backfill_uuid('asset_group', 'fund'), 'ПИФы и фонды', 'fund', 40),
  (portfolio.backfill_uuid('asset_group', 'cash'), 'Денежные средства', 'cash', 50),
  (portfolio.backfill_uuid('asset_group', 'other'), 'Прочее', 'other', 60);

-- §11 Instrument + параметры облигаций (§14) и вкладов (§15).
--
-- owner_user_id: §11 описывает инструмент как справочную сущность, но инструменты,
-- заведённые вручную или распознанные со скриншота, принадлежат конкретному пользователю
-- и не должны попадать в чужие выборки. NULL = общий справочник (MOEX/брокер),
-- заполненное поле = приватный инструмент пользователя.
CREATE TABLE portfolio.instruments (
  id UUID PRIMARY KEY,
  asset_group_id UUID NOT NULL REFERENCES portfolio.asset_groups (id),
  owner_user_id UUID REFERENCES users (id) ON DELETE CASCADE,
  instrument_type TEXT NOT NULL,
  name TEXT NOT NULL,
  ticker TEXT,
  isin TEXT,
  currency TEXT NOT NULL DEFAULT 'RUB',
  issuer TEXT,
  nominal NUMERIC(18, 2),
  maturity_date DATE,
  coupon_rate NUMERIC(6, 3),
  -- §14: облигации
  coupon_date DATE,
  oferta_date DATE,
  amortization BOOLEAN,
  -- §15: вклады
  rate NUMERIC(6, 3),
  effective_rate NUMERIC(6, 3),
  capitalization BOOLEAN,
  term_end_date DATE,
  interest_payout_frequency TEXT,
  replenishable BOOLEAN,
  partial_withdrawal BOOLEAN,
  auto_prolongation BOOLEAN,
  -- §9: источник данных
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ocr', 'broker')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_instruments_asset_group_id ON portfolio.instruments (asset_group_id);
CREATE INDEX idx_instruments_owner_user_id ON portfolio.instruments (owner_user_id);
CREATE INDEX idx_instruments_isin ON portfolio.instruments (isin) WHERE isin IS NOT NULL;
CREATE INDEX idx_instruments_ticker ON portfolio.instruments (ticker) WHERE ticker IS NOT NULL;

-- §11 Position.
--
-- current_value и current_price допускают NULL: отсутствие цены не подменяется нулём
-- (§7.3), UI показывает «Актуальная цена недоступна».
-- invested — вложенная сумма (§7.1, §10). В §11 поле не перечислено, но без него
-- бэкфилл потерял бы legacy products.invested: истории операций для его пересчёта нет.
-- accrued_interest — НКД облигации (§14): величина позиционная, а не справочная.
CREATE TABLE portfolio.positions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES portfolio.accounts (id) ON DELETE CASCADE,
  instrument_id UUID NOT NULL REFERENCES portfolio.instruments (id) ON DELETE CASCADE,
  quantity NUMERIC(24, 8),
  average_price NUMERIC(24, 8),
  current_price NUMERIC(24, 8),
  current_value NUMERIC(18, 2),
  invested NUMERIC(18, 2) NOT NULL DEFAULT 0,
  accrued_interest NUMERIC(18, 2),
  opened_on DATE,
  price_updated_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ocr', 'broker')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, instrument_id)
);
CREATE INDEX idx_positions_account_id ON portfolio.positions (account_id);
CREATE INDEX idx_positions_instrument_id ON portfolio.positions (instrument_id);

-- §11 Transaction. Типы операций — список из §11; 'OTHER' добавлен сверх него как
-- единственный допустимый фолбэк для бэкфилла: legacy-операция «Выплата» не сохраняла,
-- чем именно была выплата (купон, дивиденд, процент), и выдумывать тип нельзя.
CREATE TABLE portfolio.transactions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES portfolio.accounts (id) ON DELETE CASCADE,
  instrument_id UUID REFERENCES portfolio.instruments (id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN (
    'BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'COUPON', 'DIVIDEND',
    'INTEREST', 'FEE', 'TAX', 'REDEMPTION', 'OTHER'
  )),
  tx_date DATE NOT NULL,
  quantity NUMERIC(24, 8),
  price NUMERIC(24, 8),
  amount NUMERIC(18, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  commission NUMERIC(18, 2) NOT NULL DEFAULT 0,
  tax NUMERIC(18, 2) NOT NULL DEFAULT 0,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ocr', 'broker')),
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_transactions_account_date ON portfolio.transactions (account_id, tx_date);
CREATE INDEX idx_transactions_instrument_id ON portfolio.transactions (instrument_id);

-- §11 Payout, §22 календарь выплат.
-- account_id обязателен: он же связывает выплату с портфелем и пользователем.
-- instrument_id допускает NULL — выплата может быть заведена вручную без инструмента.
-- transaction_id связывает полученную выплату с движением денег, если оно записано.
CREATE TABLE portfolio.payouts (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES portfolio.accounts (id) ON DELETE CASCADE,
  instrument_id UUID REFERENCES portfolio.instruments (id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES portfolio.transactions (id) ON DELETE SET NULL,
  payout_date DATE NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'COUPON', 'DIVIDEND', 'INTEREST', 'DEPOSIT_PRINCIPAL', 'REDEMPTION', 'OTHER'
  )),
  amount NUMERIC(18, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'received')),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payouts_account_date ON portfolio.payouts (account_id, payout_date);
CREATE INDEX idx_payouts_instrument_id ON portfolio.payouts (instrument_id);
CREATE INDEX idx_payouts_status ON portfolio.payouts (status);

-- §11 BrokerConnection. Токен хранится только зашифрованным (§28), token_masked —
-- то, что можно показать в UI и записать в лог.
CREATE TABLE portfolio.broker_connections (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  broker_type TEXT NOT NULL,
  encrypted_token TEXT,
  token_masked TEXT,
  last_sync_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'pending', 'connected', 'error')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, broker_type)
);

-- §11 UploadedDocument, §18/§40.4 OCR.
CREATE TABLE portfolio.uploaded_documents (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_path TEXT,
  mime_type TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'done', 'failed')),
  extracted_json JSONB,
  instrument_id UUID REFERENCES portfolio.instruments (id) ON DELETE SET NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX idx_uploaded_documents_user_id ON portfolio.uploaded_documents (user_id, created_at DESC);

-- §11 Recommendation, §24. Правила MVP: концентрация, погашение, просадка, разрывы в
-- выплатах; валютное правило отнесено к v2, но тип заложен сразу.
CREATE TABLE portfolio.recommendations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL
    CHECK (rule_type IN ('concentration', 'maturity', 'drawdown', 'payout_gap', 'currency')),
  text TEXT NOT NULL,
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_recommendations_user_id ON portfolio.recommendations (user_id, created_at DESC);

-- §21 История портфеля. В перечне §11 сущности нет, но ежедневные снимки обязательны,
-- а legacy portfolio_snapshots будет удалён вместе с остальными legacy-таблицами.
CREATE TABLE portfolio.portfolio_snapshots (
  id UUID PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES portfolio.portfolios (id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  total_value NUMERIC(18, 2) NOT NULL,
  invested NUMERIC(18, 2),
  currency TEXT NOT NULL DEFAULT 'RUB',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (portfolio_id, snapshot_date)
);

-- §13 Курсы валют: курс, дата курса, источник. На MVP источник — ЦБ РФ.
CREATE TABLE portfolio.currency_rates (
  currency TEXT NOT NULL,
  base_currency TEXT NOT NULL DEFAULT 'RUB',
  rate_date DATE NOT NULL,
  rate NUMERIC(24, 8) NOT NULL,
  source TEXT NOT NULL DEFAULT 'cbr',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (currency, base_currency, rate_date)
);

-- §20 История котировок.
CREATE TABLE portfolio.instrument_prices (
  instrument_id UUID NOT NULL REFERENCES portfolio.instruments (id) ON DELETE CASCADE,
  price_date DATE NOT NULL,
  price NUMERIC(24, 8) NOT NULL,
  source TEXT NOT NULL DEFAULT 'moex',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (instrument_id, price_date)
);

-- ---------------------------------------------------------------------------
-- Бэкфилл из legacy-таблиц (products / payments / transactions /
-- portfolio_snapshots / broker_connections). Legacy-таблицы остаются на месте:
-- API продолжает работать с ними до отдельного шага переключения.
-- ---------------------------------------------------------------------------

-- Пользователи, у которых есть хоть какие-то данные. Пустым аккаунтам портфель заведёт
-- приложение при первом действии — фантомных строк здесь не создаём.
--
-- Этой же выборкой ограничен каждый INSERT ниже. На legacy-таблицах нет внешних ключей,
-- поэтому в них теоретически возможна строка с user_id несуществующего пользователя; в
-- новой схеме такая строка нарушила бы FK и уронила бы всю миграцию. Осиротевшие строки
-- остаются в legacy-таблицах (мы их не удаляем) — в новую схему они не переносятся, так
-- как без пользователя туда попасть не могут: портфеля у них нет и ни в одну выборку они
-- не попадут.
CREATE TEMP TABLE backfill_users AS
  SELECT id AS user_id FROM users u WHERE EXISTS (SELECT 1 FROM products WHERE user_id = u.id)
    OR EXISTS (SELECT 1 FROM payments WHERE user_id = u.id)
    OR EXISTS (SELECT 1 FROM transactions WHERE user_id = u.id)
    OR EXISTS (SELECT 1 FROM portfolio_snapshots WHERE user_id = u.id)
    OR EXISTS (SELECT 1 FROM broker_connections WHERE user_id = u.id);

INSERT INTO portfolio.portfolios (id, user_id, name, base_currency, created_at)
SELECT portfolio.backfill_uuid('portfolio', u.user_id::text), u.user_id, 'Основной портфель', 'RUB', NOW()
FROM backfill_users u;

-- Счёт = пара (учреждение, валюта) из legacy products: другого признака счёта в старой
-- схеме нет. Тип счёта выводим из состава продуктов: только вклады — банковский счёт,
-- иначе брокерский; продукты без указанного учреждения попадают на прочий счёт.
INSERT INTO portfolio.accounts (id, portfolio_id, type, provider, currency, status, created_at)
SELECT
  portfolio.backfill_uuid('account', p.user_id::text || '|' || p.provider || '|' || p.account_currency),
  portfolio.backfill_uuid('portfolio', p.user_id::text),
  CASE
    WHEN p.provider = 'Ручной ввод' THEN 'other'
    WHEN bool_and(p.type = 'Вклады') THEN 'bank'
    ELSE 'broker'
  END,
  p.provider,
  p.account_currency,
  'active',
  MIN(p.created_at)
FROM (
  SELECT
    user_id, type, created_at,
    COALESCE(NULLIF(institution, ''), 'Ручной ввод') AS provider,
    COALESCE(NULLIF(currency, ''), 'RUB') AS account_currency
  FROM products
  WHERE user_id IN (SELECT user_id FROM backfill_users)
) p
GROUP BY p.user_id, p.provider, p.account_currency;

-- Счёт по умолчанию для операций и выплат, не привязанных ни к одному продукту.
-- Совпадает по ключу со счётом «Ручной ввод»/RUB выше, если он уже создан.
INSERT INTO portfolio.accounts (id, portfolio_id, type, provider, currency, status)
SELECT
  portfolio.backfill_uuid('account', u.user_id::text || '|Ручной ввод|RUB'),
  portfolio.backfill_uuid('portfolio', u.user_id::text),
  'other', 'Ручной ввод', 'RUB', 'active'
FROM backfill_users u
WHERE EXISTS (SELECT 1 FROM payments WHERE user_id = u.user_id)
   OR EXISTS (SELECT 1 FROM transactions WHERE user_id = u.user_id)
ON CONFLICT (id) DO NOTHING;

-- Инструмент на каждый legacy-продукт. Дедупликация по ISIN/тикеру здесь намеренно не
-- делается: старые записи заводились вручную и со скриншотов, склейка разных позиций в
-- один инструмент потеряла бы данные.
INSERT INTO portfolio.instruments (
  id, asset_group_id, owner_user_id, instrument_type, name, ticker, isin, currency,
  nominal, maturity_date, coupon_rate, coupon_date, oferta_date, amortization,
  rate, effective_rate, capitalization, term_end_date, interest_payout_frequency,
  replenishable, partial_withdrawal, auto_prolongation, source, created_at
)
SELECT
  portfolio.backfill_uuid('instrument', p.id::text),
  portfolio.backfill_uuid('asset_group', g.type),
  p.user_id,
  g.type,
  p.name,
  NULLIF(p.ticker, ''),
  NULLIF(p.isin, ''),
  COALESCE(NULLIF(p.currency, ''), 'RUB'),
  p.nominal, p.maturity_date, p.coupon_rate, p.coupon_date, p.oferta_date, p.amortization,
  p.rate, p.effective_rate, p.capitalization, p.term_end_date, p.interest_payout_frequency,
  p.replenishable, p.partial_withdrawal, p.auto_prolongation,
  CASE WHEN p.source IN ('manual', 'ocr', 'broker') THEN p.source ELSE 'manual' END,
  p.created_at
FROM products p
JOIN backfill_users u ON u.user_id = p.user_id
CROSS JOIN LATERAL (
  SELECT CASE p.type
    WHEN 'Облигации' THEN 'bond'
    WHEN 'Акции' THEN 'share'
    WHEN 'Вклады' THEN 'deposit'
    WHEN 'Фонды' THEN 'fund'
    WHEN 'Деньги' THEN 'cash'
    ELSE 'other'
  END AS type
) g;

INSERT INTO portfolio.positions (
  id, account_id, instrument_id, quantity, average_price, current_price, current_value,
  invested, accrued_interest, opened_on, source, created_at, updated_at
)
SELECT
  portfolio.backfill_uuid('position', p.id::text),
  portfolio.backfill_uuid('account', p.user_id::text || '|' || COALESCE(NULLIF(p.institution, ''), 'Ручной ввод') || '|' || COALESCE(NULLIF(p.currency, ''), 'RUB')),
  portfolio.backfill_uuid('instrument', p.id::text),
  p.quantity, p.average_price, p.current_price, p.amount,
  p.invested, p.accrued_interest, p.purchase_date,
  CASE WHEN p.source IN ('manual', 'ocr', 'broker') THEN p.source ELSE 'manual' END,
  p.created_at, p.created_at
FROM products p
JOIN backfill_users u ON u.user_id = p.user_id;

-- Операции. Legacy-вид «Выплата» не хранил, чем именно была выплата, поэтому переносится
-- как 'OTHER' — пользователь уточнит тип при редактировании.
INSERT INTO portfolio.transactions (
  id, account_id, instrument_id, type, tx_date, amount, currency, description, source, created_at
)
SELECT
  t.id,
  -- операция без продукта попадает на счёт по умолчанию: COALESCE ниже даёт тот же ключ
  portfolio.backfill_uuid('account', t.user_id::text || '|' || COALESCE(NULLIF(p.institution, ''), 'Ручной ввод') || '|' || COALESCE(NULLIF(p.currency, ''), 'RUB')),
  CASE WHEN p.id IS NULL THEN NULL ELSE portfolio.backfill_uuid('instrument', p.id::text) END,
  CASE t.kind
    WHEN 'Покупка' THEN 'BUY'
    WHEN 'Продажа' THEN 'SELL'
    WHEN 'Пополнение' THEN 'DEPOSIT'
    ELSE 'OTHER'
  END,
  t.tx_date,
  t.amount,
  COALESCE(NULLIF(p.currency, ''), 'RUB'),
  t.title,
  'manual',
  t.created_at
FROM transactions t
JOIN backfill_users u ON u.user_id = t.user_id
LEFT JOIN products p ON p.id = t.product_id AND p.user_id = t.user_id;

-- Полученные выплаты (§22, статус «получено») — из операций вида «Выплата».
-- Инструмент не проставляем: legacy привязывал такую операцию к денежному счёту,
-- а не к источнику выплаты.
INSERT INTO portfolio.payouts (
  id, account_id, transaction_id, payout_date, type, amount, currency, status, description, created_at
)
SELECT
  portfolio.backfill_uuid('payout', t.id::text),
  nt.account_id,
  t.id,
  t.tx_date,
  'OTHER',
  t.amount,
  nt.currency,
  'received',
  t.title,
  t.created_at
FROM transactions t
JOIN portfolio.transactions nt ON nt.id = t.id
WHERE t.kind = 'Выплата';

-- Ожидаемые выплаты (§22, статус «ожидается») — из legacy payments. Тип выплаты
-- восстанавливается из класса актива, который хранился в payments.type.
INSERT INTO portfolio.payouts (
  id, account_id, payout_date, type, amount, currency, status, description, created_at
)
SELECT
  pay.id,
  portfolio.backfill_uuid('account', pay.user_id::text || '|Ручной ввод|RUB'),
  pay.payment_date,
  CASE pay.type
    WHEN 'Облигации' THEN 'COUPON'
    WHEN 'Акции' THEN 'DIVIDEND'
    WHEN 'Вклады' THEN 'INTEREST'
    ELSE 'OTHER'
  END,
  pay.amount,
  'RUB',
  'expected',
  pay.title,
  pay.created_at
FROM payments pay
JOIN backfill_users u ON u.user_id = pay.user_id;

INSERT INTO portfolio.portfolio_snapshots (id, portfolio_id, snapshot_date, total_value, currency, created_at)
SELECT s.id, portfolio.backfill_uuid('portfolio', s.user_id::text), s.snapshot_date, s.total_value, 'RUB', s.created_at
FROM portfolio_snapshots s
JOIN backfill_users u ON u.user_id = s.user_id;

-- Подключения брокеров. Зашифрованного токена в legacy не было — переносим только маску
-- и статус, токен пользователь вводит заново при переподключении (§28).
INSERT INTO portfolio.broker_connections (id, user_id, broker_type, token_masked, status, created_at)
SELECT DISTINCT ON (bc.user_id, bc.provider)
  bc.id, bc.user_id, bc.provider, bc.masked_token,
  CASE WHEN bc.connection_status IN ('disconnected', 'pending', 'connected', 'error') THEN bc.connection_status ELSE 'error' END,
  bc.created_at
FROM broker_connections bc
JOIN backfill_users u ON u.user_id = bc.user_id
ORDER BY bc.user_id, bc.provider, bc.created_at DESC;

DROP TABLE backfill_users;
DROP FUNCTION portfolio.backfill_uuid(TEXT, TEXT);

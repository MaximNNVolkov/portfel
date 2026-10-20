-- Hermes: полный доступ по ключу и уведомления раз в день (решение владельца 20.10.2026).
--
-- events — какие события присылать (ключи — NotificationKind в server/notifications.ts).
-- По умолчанию только важное: пришедшие выплаты, закрытые вклады и погашения, скорое
-- окончание срока, ошибка брокера. send_hour — час отправки сводки по NOTIFY_TIMEZONE,
-- last_digest_on — день, за который сводка уже ушла: больше одной в день не бывает.
ALTER TABLE notification_webhooks
  ADD COLUMN IF NOT EXISTS events TEXT[] NOT NULL
    DEFAULT ARRAY['payout_received', 'position_closed', 'maturity_soon', 'broker_error'],
  ADD COLUMN IF NOT EXISTS send_hour SMALLINT NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS last_digest_on DATE;

-- Одноразовые ссылки «Подключить Hermes» (server/hermes-connect.ts): по ссылке установщик
-- на сервере Hermes получает ключ API и сообщает адрес и секрет вебхука. Хранится только
-- sha256 ссылки; использованная или просроченная ссылка больше не работает.
CREATE TABLE IF NOT EXISTS hermes_connect_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hermes_connect_tokens_user_id ON hermes_connect_tokens (user_id);

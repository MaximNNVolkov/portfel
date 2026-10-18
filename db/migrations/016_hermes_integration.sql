-- Интеграция с Hermes (ИИ-агент владельца на том же VPS).
--
-- api_keys — ключи для внешних клиентов. Как и sessions, хранится только sha256 ключа:
-- утечка базы не даёт готового доступа. Права ключа ограничены на уровне API (только
-- чтение портфеля и добавление продуктов), поэтому отдельной колонки прав пока нет.
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_preview TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);

-- Куда «Портфель» шлёт уведомления: вебхук Hermes. Секрет подписи HMAC хранится
-- зашифрованным тем же ключом, что и токены брокеров (server/token-crypto.ts).
CREATE TABLE IF NOT EXISTS notification_webhooks (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Что уже отправлено: одно событие (выплата через 3 дня, закрытый вклад) уходит один раз,
-- сколько бы раз ни прошёл цикл планировщика.
CREATE TABLE IF NOT EXISTS notification_log (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, event_key)
);

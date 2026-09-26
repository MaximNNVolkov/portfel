-- Счёт брокера должен совпадать с его счётом у брокера. Раньше синхронизация Т-Инвестиций
-- искала счёт по паре (провайдер, валюта) и складывала все брокерские счета пользователя в
-- один: одна и та же бумага на двух счетах перезаписывала позицию последним счётом, и
-- портфель показывал вдвое меньше, чем у брокера. external_id — id счёта у брокера,
-- name — его название там же. Старый склеенный счёт (external_id IS NULL) разбирает
-- следующая синхронизация: переносит на новые счета операции и выплаты, удаляет позиции.
ALTER TABLE portfolio.accounts ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE portfolio.accounts ADD COLUMN IF NOT EXISTS name text;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_portfolio_provider_external_id_key
  ON portfolio.accounts (portfolio_id, provider, external_id) WHERE external_id IS NOT NULL;

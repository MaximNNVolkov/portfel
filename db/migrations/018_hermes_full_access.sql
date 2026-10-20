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

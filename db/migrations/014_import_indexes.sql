-- Отмена загрузки выписки удаляет десятки тысяч операций (тестировщик Т15): без индекса
-- по payouts.transaction_id каждое удаление проверяет внешний ключ полным просмотром выплат.
CREATE INDEX IF NOT EXISTS idx_payouts_transaction_id ON portfolio.payouts (transaction_id);
-- Поиск операций загрузки по префиксу внешнего идентификатора.
CREATE INDEX IF NOT EXISTS idx_transactions_external_id ON portfolio.transactions (external_id text_pattern_ops);

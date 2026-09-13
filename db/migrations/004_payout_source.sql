-- Происхождение выплаты (§15, §22): плановые выплаты по вкладам и облигациям система
-- считает сама из параметров инструмента и пересчитывает при каждом его изменении.
-- Чтобы пересчёт удалял только собственные строки и никогда не трогал введённые
-- пользователем или пришедшие от брокера, источник строки хранится явно.
ALTER TABLE portfolio.payouts
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'forecast', 'broker'));

CREATE INDEX idx_payouts_source ON portfolio.payouts (source);

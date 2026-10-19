-- Целевая структура портфеля (011) и отметка «реинвестировано» у выплат (015) убраны
-- вместе с ребалансировкой и лентой «Требует внимания» (решение владельца 19.10.2026).
ALTER TABLE portfolio.portfolios DROP COLUMN IF EXISTS target_allocation;
ALTER TABLE portfolio.payouts DROP COLUMN IF EXISTS reinvested_at;

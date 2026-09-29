-- Целевая структура портфеля: желаемая доля каждой категории в процентах
-- ({"Облигации": 40, "Акции": 30, ...}). Пустой объект — цель не задана.
ALTER TABLE portfolio.portfolios ADD COLUMN IF NOT EXISTS target_allocation JSONB NOT NULL DEFAULT '{}'::jsonb;

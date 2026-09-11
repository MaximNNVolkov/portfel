-- Bring products closer to SPEC §14 (bonds) and §15 (bank deposits): optional
-- per-instrument detail fields. All nullable — existing rows are unaffected,
-- and every field is filled in only via the "Добавить дополнительные детали"
-- section of the manual/edit forms.

ALTER TABLE products ADD COLUMN IF NOT EXISTS isin TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS quantity NUMERIC(18, 6);
ALTER TABLE products ADD COLUMN IF NOT EXISTS average_price NUMERIC(18, 6);
ALTER TABLE products ADD COLUMN IF NOT EXISTS current_price NUMERIC(18, 6);

-- Bonds (§14)
ALTER TABLE products ADD COLUMN IF NOT EXISTS nominal NUMERIC(18, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS accrued_interest NUMERIC(18, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS coupon_rate NUMERIC(6, 3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS coupon_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS maturity_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS oferta_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS amortization BOOLEAN;

-- Bank deposits (§15)
ALTER TABLE products ADD COLUMN IF NOT EXISTS rate NUMERIC(6, 3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS effective_rate NUMERIC(6, 3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS capitalization BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS term_end_date DATE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS interest_payout_frequency TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS replenishable BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS partial_withdrawal BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS auto_prolongation BOOLEAN;

-- Extend the transactions ledger from buy/sell to the full transaction taxonomy
-- (dividend, fee, split, isin_change). All columns nullable → backward compatible
-- with existing buy/sell rows, which leave them NULL.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee   NUMERIC; -- commission/fee on a buy/sell row
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tax   NUMERIC; -- withholding tax on a dividend row
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ratio NUMERIC; -- split / isin_change factor (newShares / oldShares)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note  TEXT;    -- free text (e.g. ISIN-change old→new mapping)

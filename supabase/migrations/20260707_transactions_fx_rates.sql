-- Trade-date FX rates per transaction: { "EUR": r, "USD": r } where r converts
-- 1 unit of the transaction's currency into that base, at the TRADE DATE
-- (ECB reference rates via Frankfurter; backfilled automatically by the app).
--
-- Why: the legacy `exchange_rate` column stored a single rate captured at
-- IMPORT time against whichever base currency happened to be active then, with
-- no record of which — making Total Invested / Income / Fees identical numbers
-- under both the EUR and USD toggles. `exchange_rate` is kept for one release
-- as rollback safety but is no longer read.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fx_rates JSONB DEFAULT NULL;

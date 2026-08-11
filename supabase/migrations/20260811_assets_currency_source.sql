-- Provenance for `assets.currency`, so a guess can never overwrite a fact.
--
-- Why: buildAssetRecord() infers a currency from the ticker suffix, and
-- fetchMarketPrices() rebuilds that record for EVERY position on EVERY price
-- refresh, then upserts it. That unconditional write clobbered the
-- provider-reported currency enrichUnknownAssets() had just stored, so
-- assets.currency oscillated between the real value and the suffix guess
-- depending on which write ran last — it was a race, not a source of truth.
--
-- Rank (highest wins, enforced in saveAssetsToDB via money-core.js):
--   user (4)  — manual override in the card UI
--   quote (3) — reported by the quote tier that actually returned the price
--   profile (2) — provider profile lookup (FMP / Alpha Vantage / Finnhub)
--   suffix (1)  — inferred from the ticker suffix; a last-resort guess
--
-- Existing rows are backfilled to 'suffix' (the weakest source) so that the
-- first genuine observation from a quote or profile is free to correct them.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS currency_source TEXT;

UPDATE assets SET currency_source = 'suffix'
 WHERE currency_source IS NULL AND currency IS NOT NULL;

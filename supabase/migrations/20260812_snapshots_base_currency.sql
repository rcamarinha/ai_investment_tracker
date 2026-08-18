-- Record WHICH currency a snapshot was taken in, plus a canonical EUR pair.
--
-- Why: savePortfolioSnapshot() computes totals in whatever base the currency
-- toggle happened to be on, and saveSnapshotToDB() never persisted which one.
-- The history chart therefore plotted EUR and USD points on a single axis and
-- labelled them all '€' (undefined currency → formatCurrency's default), so
-- every snapshot taken with the USD toggle on read ~8% high and nothing said so.
--
-- The EUR columns are the fix for the hub as well: it previously summed
-- shares x avg_price straight from `positions` (a table with NO currency
-- column) and stamped the result '€', adding pounds to euros. It now reads a
-- number the portfolio page already computed correctly, instead of keeping a
-- third independent copy of currency conversion.
--
-- Legacy rows keep NULL in all four columns. That is deliberate: a snapshot is
-- a record of what was true at capture time, and the rates, prices and currency
-- assignments of a past capture cannot be reconstructed. Assuming they were all
-- EUR would bake today's guess into the permanent record — exactly the failure
-- mode being fixed. Consumers must treat NULL as "base unknown", not as EUR.
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS base_currency TEXT;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS total_invested_eur NUMERIC;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS total_market_value_eur NUMERIC;
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS excluded_positions INTEGER DEFAULT 0;

-- ============================================
-- spend_categories.counts_as_savings
-- ============================================
-- Run in the Supabase SQL Editor. Safe to run more than once.
--
-- WHY: the ledger knew three states — spend, income, and transfer-between-my-
-- own-accounts. Money moved into a child's trust fund is none of them.
--
--   Calling it SPEND understates the savings rate: it was saved, not consumed.
--   Calling it a TRANSFER makes it vanish from both sides, which is also wrong —
--   it genuinely left the spendable pool, and detectInternalTransfers can never
--   pair it because the destination is not one of the user's own accounts.
--
-- Either answer makes the savings rate wrong in a consistent direction, and the
-- savings rate feeds projectScenario, the simulator and the hub's whole thesis.
-- So the outflow is recorded, and simply not counted as consumption.
--
-- Additive and default false, so every existing category and all existing rows
-- behave exactly as before. No backfill.
--
-- Deliberately NOT modelled yet: whether the money is still the user's (a
-- pension, a brokerage) or gone for good (a gift). Both are correctly excluded
-- from consumption by this one flag, and nothing downstream can consume the
-- distinction until net-worth reconciliation exists.
-- ============================================

ALTER TABLE spend_categories
    ADD COLUMN IF NOT EXISTS counts_as_savings BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN spend_categories.counts_as_savings IS
    'Outflow that is saved or invested rather than consumed. Excluded from spend in the savings rate, and reported on its own line.';

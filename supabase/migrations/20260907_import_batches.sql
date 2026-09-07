-- Tag every row with the import that created it, so an import can be undone as
-- a unit.
--
-- Without this, "undo that import" means finding and deleting rows one at a
-- time in the ledger — for a statement of 400 movements that is not a recovery
-- story, it is a punishment. The importer is careful, but care is not the same
-- as reversibility, and every guardrail so far assumes someone eventually gets
-- to correct a mistake.
--
-- A plain UUID rather than a batches table: nothing needs to be stored ABOUT an
-- import that the rows do not already carry between them (date, source, count),
-- and a second table would need its own lifecycle for no gain.
--
-- Idempotent: safe to run more than once.
ALTER TABLE spend_transactions
    ADD COLUMN IF NOT EXISTS import_id UUID;

CREATE INDEX IF NOT EXISTS idx_spend_transactions_import
    ON spend_transactions(user_id, import_id)
    WHERE import_id IS NOT NULL;

COMMENT ON COLUMN spend_transactions.import_id IS
    'The import that created this row. Null for rows entered by hand. Lets one import be undone as a unit.';

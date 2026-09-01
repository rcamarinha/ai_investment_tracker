-- The deployed transactions table carried a CHECK constraint limiting `type`
-- to buy/sell. The ledger now uses the full taxonomy (dividend, fee, split,
-- isin_change), so that constraint rejects the new rows (error 23514) and
-- aborts the entire transaction save. Replace it with a permissive allow-list
-- that still catches typos but accepts every current type.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

-- ADD CONSTRAINT has no IF NOT EXISTS, so a second run errors 42710 even though
-- the DROP above is guarded. Every other migration here is safe to re-run; an
-- odd one out is a trap for whoever replays the folder against a new project.
DO $$ BEGIN
    ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
      CHECK (type IN ('buy', 'sell', 'dividend', 'fee', 'split', 'isin_change'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

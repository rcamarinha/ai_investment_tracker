-- ============================================
-- Bank Holdings — bonds and funds held at retail banks
-- ============================================
-- Run this in your Supabase SQL Editor:
--   Dashboard > SQL Editor > New Query > Paste & Run
--
-- SAFE TO RUN MULTIPLE TIMES — IF NOT EXISTS / exception handlers throughout.
--
-- WHY this table exists rather than reusing `positions` or `spend_transactions`:
--
--   Not `positions`/`transactions`: those arrive from broker exports and are
--   priced by the 3-tier live quote APIs. A PT retail bond or fund arrives on a
--   BANK statement and is not quoted anywhere free. `transactions.type` is also
--   a CHECK enum guarding a well-tested average-cost engine — widening it for a
--   different asset class is high blast radius for low value.
--
--   Not `spend_*`: a bond is not an expense category and a coupon is not budget
--   income. Mixing them would corrupt the savings rate, and every projection
--   built on it. Holdings must stay OUT of spend rollups entirely.
--
-- VALUATION HONESTY: `current_value` is whatever the statement printed, or what
-- the user typed. `valuation_source` and `valued_as_of` are NOT NULL precisely
-- so the UI can never present a stale or hand-typed figure as though it were a
-- live market price. Every surface that shows a value must show its age too.
--
-- v1 is deliberately narrow: no coupon schedule, no accrued interest, no YTM,
-- no redemption events. Those are v2. See the roadmap.
-- ============================================

CREATE TABLE IF NOT EXISTS bank_holdings (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    bank_name         TEXT NOT NULL,
    name              TEXT NOT NULL,
    holding_type      TEXT NOT NULL DEFAULT 'other'
                      CHECK (holding_type IN ('bond','fund','deposit','structured','other')),
    isin              TEXT,
    currency          TEXT NOT NULL DEFAULT 'EUR',

    -- Funds are held in units; bonds in nominal (face) value. One or the other,
    -- and both are optional — a statement that only prints a total is still
    -- worth recording.
    units             NUMERIC,
    nominal           NUMERIC,

    cost_basis        NUMERIC,
    current_value     NUMERIC NOT NULL,
    valued_as_of      DATE    NOT NULL,
    valuation_source  TEXT    NOT NULL DEFAULT 'manual'
                      CHECK (valuation_source IN ('manual','statement')),

    maturity_date     DATE,          -- bonds; informational in v1
    note              TEXT,
    archived          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ DEFAULT now(),
    updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_holdings_user_id ON bank_holdings(user_id);

-- RLS: own rows only. Holdings data is as sensitive as the spend ledger — there
-- is no shared-catalog table here and no authenticated-wide read anywhere.
DO $$
BEGIN
    EXECUTE 'ALTER TABLE bank_holdings ENABLE ROW LEVEL SECURITY';

    DROP POLICY IF EXISTS "Users can view own bank_holdings"   ON bank_holdings;
    CREATE POLICY "Users can view own bank_holdings"   ON bank_holdings FOR SELECT USING (auth.uid() = user_id);

    DROP POLICY IF EXISTS "Users can insert own bank_holdings" ON bank_holdings;
    CREATE POLICY "Users can insert own bank_holdings" ON bank_holdings FOR INSERT WITH CHECK (auth.uid() = user_id);

    DROP POLICY IF EXISTS "Users can update own bank_holdings" ON bank_holdings;
    CREATE POLICY "Users can update own bank_holdings" ON bank_holdings FOR UPDATE USING (auth.uid() = user_id);

    DROP POLICY IF EXISTS "Users can delete own bank_holdings" ON bank_holdings;
    CREATE POLICY "Users can delete own bank_holdings" ON bank_holdings FOR DELETE USING (auth.uid() = user_id);
END $$;

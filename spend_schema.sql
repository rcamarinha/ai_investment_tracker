-- ============================================
-- Spend — cash-flow tracker baseline schema
-- ============================================
-- Run this in your Supabase SQL Editor:
--   Dashboard > SQL Editor > New Query > Paste & Run
--
-- SAFE TO RUN MULTIPLE TIMES — every statement uses IF NOT EXISTS or an
-- exception handler, so re-running on an existing database is harmless.
--
-- This ADDS the spend_* tables to the existing project. It does NOT touch
-- any existing table (positions, transactions, assets, wines, ...).
--
-- WHY these tables exist, beyond "a list of expenses":
--
--   spend_accounts        One row per bank account (plus MB WAY as a 'wallet').
--                         Imports are tagged to an account so dedupe is scoped
--                         per account and cross-bank transfers can be paired.
--
--   spend_bank_profiles   Five banks means five export formats, and formats
--                         change. Rather than five hardcoded parsers, the
--                         column mapping for a format is learned ONCE (auto or
--                         AI-inferred, user-confirmed) and replayed for free on
--                         every later import of that format.
--
--   spend_transactions    The ledger. `amount` is signed (negative = outflow).
--                         UNIQUE (user_id, account_id, fingerprint) makes
--                         re-importing an overlapping statement a no-op at the
--                         DB level, not just client-side.
--
--   spend_pending_details MB WAY / PayPal rows that describe a movement the
--                         bank has not posted yet. They are NOT transactions —
--                         promoting them would invent money that never moved.
--                         They wait here and re-match on the next import.
--
-- Reserved category: 'transfer' is always excluded from spend/income rollups,
-- the same discipline as the reserved CASH symbol in the stock ledger.
-- ============================================


-- ────────────────────────────────────────────
-- spend_accounts
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spend_accounts (
    id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    bank_name         TEXT NOT NULL,
    account_label     TEXT NOT NULL,
    account_type      TEXT NOT NULL DEFAULT 'checking'
                      CHECK (account_type IN ('checking','savings','card','wallet')),
    currency          TEXT NOT NULL DEFAULT 'EUR',

    -- MB WAY (and other wallets) charge against a funding account. Linking them
    -- is what lets the importer know a wallet row should enrich, not duplicate.
    linked_account_id UUID REFERENCES spend_accounts(id) ON DELETE SET NULL,

    colour            TEXT,               -- dot colour in the ledger, per-account provenance
    last_imported_at  TIMESTAMPTZ,
    archived          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spend_accounts_user_id ON spend_accounts(user_id);


-- ────────────────────────────────────────────
-- spend_bank_profiles — a learned statement format
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spend_bank_profiles (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES spend_accounts(id) ON DELETE CASCADE,

    label           TEXT,
    -- 'statement' = the ledger of record (a bank export).
    -- 'detail'    = a richer description of movements already on a statement
    --               (MB WAY, PayPal). Detail rows enrich; they never stand alone.
    source_role     TEXT NOT NULL DEFAULT 'statement'
                    CHECK (source_role IN ('statement','detail')),
    format_kind     TEXT NOT NULL DEFAULT 'csv' CHECK (format_kind IN ('csv','pdf')),

    -- Hash of the normalised header row — how an incoming file finds its profile.
    signature       TEXT NOT NULL,

    -- {date, description, amount} OR {date, description, debit, credit}.
    -- Two-column debit/credit is the norm in PT bank exports, not signed amounts.
    column_map      JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- dd-mm-yyyy is ambiguous against mm-dd-yyyy for any day <= 12, so the
    -- profile decides rather than the parser guessing per row.
    date_format     TEXT,
    decimal_style   TEXT DEFAULT 'eu' CHECK (decimal_style IN ('eu','us')),
    -- TRUE when debits arrive positive and must be negated.
    invert_sign     BOOLEAN NOT NULL DEFAULT FALSE,
    skip_rows       INTEGER NOT NULL DEFAULT 0,
    balance_col     TEXT,               -- present in most PT exports; must never be read as an amount
    value_date_col  TEXT,
    pdf_hint        TEXT,               -- layout hint passed to the AI extractor for PDF-only banks

    confirmed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spend_bank_profiles_user_id ON spend_bank_profiles(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_bank_profiles_sig
    ON spend_bank_profiles(user_id, signature);


-- ────────────────────────────────────────────
-- spend_categories
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spend_categories (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    icon        TEXT,
    colour      TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_income   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spend_categories_user_id ON spend_categories(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_categories_name ON spend_categories(user_id, name);


-- ────────────────────────────────────────────
-- spend_recurring — detected subscriptions
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spend_recurring (
    id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    merchant       TEXT NOT NULL,
    category       TEXT,
    amount         NUMERIC NOT NULL,
    currency       TEXT NOT NULL DEFAULT 'EUR',
    cadence_days   INTEGER NOT NULL,
    next_expected  DATE,
    status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','paused','cancelled')),
    confidence     NUMERIC,
    created_at     TIMESTAMPTZ DEFAULT now(),
    updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spend_recurring_user_id ON spend_recurring(user_id);


-- ────────────────────────────────────────────
-- spend_transactions — the ledger
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spend_transactions (
    id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_id          UUID NOT NULL REFERENCES spend_accounts(id) ON DELETE CASCADE,

    date                DATE NOT NULL,
    description         TEXT NOT NULL,
    -- Pre-enrichment bank text. Kept so a re-import can still match the row by
    -- its original opaque description after MB WAY has overwritten `description`.
    raw_description     TEXT,
    merchant            TEXT,

    amount              NUMERIC NOT NULL,          -- signed: negative = outflow
    currency            TEXT NOT NULL DEFAULT 'EUR',
    fx_rates            JSONB,                     -- {"EUR":r,"USD":r} at `date`

    category            TEXT,                      -- NULL = uncategorised; 'transfer' reserved
    category_source     TEXT CHECK (category_source IN ('rule','ai','manual')),
    category_confidence NUMERIC,

    enriched_from       TEXT,                      -- 'mbway' | NULL
    transfer_pair_id    UUID,                      -- links both sides of an internal transfer
    recurring_id        UUID REFERENCES spend_recurring(id) ON DELETE SET NULL,

    source              TEXT,                      -- profile label or 'manual'
    fingerprint         TEXT NOT NULL,
    note                TEXT,
    needs_review        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT now()
);

-- Re-importing an overlapping statement is a no-op, enforced by the DB rather
-- than trusted to the client.
CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_tx_fingerprint
    ON spend_transactions(user_id, account_id, fingerprint);

CREATE INDEX IF NOT EXISTS idx_spend_transactions_user_id ON spend_transactions(user_id);
-- First table in the suite with thousands of rows per user: every dashboard
-- query is a date-range scan, so this index is not optional.
CREATE INDEX IF NOT EXISTS idx_spend_transactions_user_date
    ON spend_transactions(user_id, date DESC);
-- NOTE: an earlier (user_id, category) index was dropped by
-- 20260828_spend_indexes.sql — all category filtering is client-side.
CREATE INDEX IF NOT EXISTS idx_spend_transactions_account
    ON spend_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_spend_transactions_recurring
    ON spend_transactions(recurring_id) WHERE recurring_id IS NOT NULL;


-- ────────────────────────────────────────────
-- spend_pending_details — detail rows with no statement match yet
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spend_pending_details (
    id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_id     UUID REFERENCES spend_accounts(id) ON DELETE CASCADE,
    date           DATE NOT NULL,
    description    TEXT NOT NULL,
    merchant       TEXT,
    amount         NUMERIC NOT NULL,
    currency       TEXT NOT NULL DEFAULT 'EUR',
    source         TEXT,
    fingerprint    TEXT NOT NULL,
    first_seen_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spend_pending_user_id ON spend_pending_details(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_pending_fingerprint
    ON spend_pending_details(user_id, fingerprint);


-- ────────────────────────────────────────────
-- spend_rules — merchant pattern → category
-- The cache in front of the AI categoriser. Every AI result and every manual
-- correction writes a rule back, so cost and latency fall over time.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spend_rules (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    match_type  TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains','regex')),
    pattern     TEXT NOT NULL,
    category    TEXT NOT NULL,
    merchant    TEXT,                   -- canonical merchant name to write onto matches
    priority    INTEGER NOT NULL DEFAULT 0,
    hit_count   INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spend_rules_user_id ON spend_rules(user_id);


-- ────────────────────────────────────────────
-- spend_scenarios — saved simulator scenarios
-- `levers` is JSONB so new lever types ship without a migration. Shape:
--   { "horizonMonths": 12,
--     "levers": [ {"type":"category_delta","category":"Dining",
--                  "mode":"percent","value":-30}, ... ] }
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spend_scenarios (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    levers      JSONB NOT NULL DEFAULT '{"horizonMonths":12,"levers":[]}'::jsonb,
    -- The month of ledger data the projection was built from. Surfaced as an
    -- age badge: a stale scenario silently showing old numbers is how trust dies.
    based_on    DATE,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spend_scenarios_user_id ON spend_scenarios(user_id);


-- ────────────────────────────────────────────
-- Row Level Security — four policies per table, own rows only.
-- Spending data is the most sensitive in the suite; there is no shared-catalog
-- table here and no authenticated-wide read anywhere.
-- ────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'spend_accounts', 'spend_bank_profiles', 'spend_categories',
        'spend_recurring', 'spend_transactions', 'spend_pending_details',
        'spend_rules', 'spend_scenarios'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

        EXECUTE format('DROP POLICY IF EXISTS "Users can view own %s" ON %I', t, t);
        EXECUTE format('CREATE POLICY "Users can view own %s" ON %I FOR SELECT USING (auth.uid() = user_id)', t, t);

        EXECUTE format('DROP POLICY IF EXISTS "Users can insert own %s" ON %I', t, t);
        EXECUTE format('CREATE POLICY "Users can insert own %s" ON %I FOR INSERT WITH CHECK (auth.uid() = user_id)', t, t);

        EXECUTE format('DROP POLICY IF EXISTS "Users can update own %s" ON %I', t, t);
        EXECUTE format('CREATE POLICY "Users can update own %s" ON %I FOR UPDATE USING (auth.uid() = user_id)', t, t);

        EXECUTE format('DROP POLICY IF EXISTS "Users can delete own %s" ON %I', t, t);
        EXECUTE format('CREATE POLICY "Users can delete own %s" ON %I FOR DELETE USING (auth.uid() = user_id)', t, t);
    END LOOP;
END $$;

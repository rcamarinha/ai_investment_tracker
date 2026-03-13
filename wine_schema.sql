-- ============================================
-- Supabase Schema — Wine Cellar Tracker v2
-- ============================================
-- Run this in your Supabase SQL Editor:
--   Dashboard > SQL Editor > New Query > Paste & Run
--
-- SAFE TO RUN MULTIPLE TIMES — all statements use IF NOT EXISTS /
-- exception handlers so re-running on an existing database is harmless.
--
-- This ADDS wine tables to your existing AI Investment Tracker project.
-- It does NOT modify any existing tables (positions, snapshots, assets, etc.)
--
-- Schema overview (mirrors the investment tracker pattern):
--   wines             — shared genetic catalog        (like assets for stocks)
--   user_wines        — per-user holdings              (like positions for stocks)
--   wine_price_history— AI valuation history per wine  (like price_history for stocks)
--   wine_snapshots    — cellar value history snapshots  (unchanged from v1)
--   asset_movements   — unified backlog of all asset movements (wine + stock)
--
-- UPGRADING from v1 (wine_bottles)? Also run:
--   supabase/migrations/20260225_wine_restructure.sql
-- That script migrates existing wine_bottles data into the new tables.
-- ============================================


-- ────────────────────────────────────────────
-- wines: genetic identity catalog (shared, no user_id)
-- One row per unique wine. All users who own the same wine
-- share one catalog entry, eliminating data duplication.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wines (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,

    -- Identity (genetic details — shared across all users)
    name            TEXT NOT NULL,
    winery          TEXT DEFAULT NULL,
    vintage         INTEGER DEFAULT NULL,
    region          TEXT DEFAULT NULL,
    appellation     TEXT DEFAULT NULL,
    varietal        TEXT DEFAULT NULL,
    country         TEXT DEFAULT NULL,
    alcohol         TEXT DEFAULT NULL,  -- stored as string, e.g. "13.5%"

    -- Drink window — updated by any valuation, shared best estimate
    drink_window    TEXT DEFAULT NULL,  -- e.g. "2025-2040"

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- RLS: shared catalog — all authenticated users can read; any authenticated
-- user can add/update (corrections benefit everyone, like the assets table)
ALTER TABLE wines ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Authenticated users can view wines"
        ON wines FOR SELECT USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "Authenticated users can insert wines"
        ON wines FOR INSERT WITH CHECK (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "Authenticated users can update wines"
        ON wines FOR UPDATE USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wines_name_vintage ON wines(LOWER(name), vintage);
CREATE INDEX IF NOT EXISTS idx_wines_vintage      ON wines(vintage);
CREATE INDEX IF NOT EXISTS idx_wines_region       ON wines(region);
CREATE INDEX IF NOT EXISTS idx_wines_varietal     ON wines(varietal);


-- ────────────────────────────────────────────
-- user_wines: per-user holdings
-- Each row = one purchase lot for one user.
-- Multiple lots of the same wine (different purchase dates/prices)
-- are separate rows, all pointing to the same wines row.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_wines (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    wine_id         UUID REFERENCES wines(id) ON DELETE CASCADE NOT NULL,

    -- Investment data (user-specific per lot)
    qty             INTEGER NOT NULL DEFAULT 1,
    bottle_size     TEXT DEFAULT '0.75L',        -- e.g. "0.75L", "1.5L" (Magnum), "3.0L" (Double Magnum)
    purchase_price  NUMERIC DEFAULT NULL,        -- per bottle, EUR
    purchase_date   DATE DEFAULT NULL,
    storage         TEXT DEFAULT NULL,           -- e.g. "Home cellar", "Cavissima"
    notes           TEXT DEFAULT NULL,

    -- AI valuation — latest estimate for this user's lot
    estimated_value     NUMERIC DEFAULT NULL,    -- per bottle, EUR
    estimated_value_usd NUMERIC DEFAULT NULL,    -- per bottle, USD (from AI)
    value_low           NUMERIC DEFAULT NULL,    -- Claude's low-end estimate (EUR)
    value_high          NUMERIC DEFAULT NULL,    -- Claude's high-end estimate (EUR)
    confidence          TEXT DEFAULT NULL,       -- "high" | "medium" | "low"
    valuation_note      TEXT DEFAULT NULL,       -- 1-2 sentence explanation
    valuation_sources   TEXT DEFAULT NULL,       -- brief citation of sources used
    last_valued_at      TIMESTAMPTZ DEFAULT NULL,

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE user_wines ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Users can view own user_wines"
        ON user_wines FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can insert own user_wines"
        ON user_wines FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can update own user_wines"
        ON user_wines FOR UPDATE USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can delete own user_wines"
        ON user_wines FOR DELETE USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_user_wines_user_id   ON user_wines(user_id);
CREATE INDEX IF NOT EXISTS idx_user_wines_wine_id   ON user_wines(wine_id);
CREATE INDEX IF NOT EXISTS idx_user_wines_user_wine ON user_wines(user_id, wine_id);


-- ────────────────────────────────────────────
-- wine_price_history: AI valuation history per wine
-- Every time a valuation runs, a row is appended here.
-- Enables tracking a wine's estimated value over time.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wine_price_history (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    wine_id         UUID REFERENCES wines(id) ON DELETE CASCADE NOT NULL,
    user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    price           NUMERIC NOT NULL,            -- estimated value per bottle, EUR
    value_low       NUMERIC DEFAULT NULL,
    value_high      NUMERIC DEFAULT NULL,
    valuation_note  TEXT DEFAULT NULL,
    drink_window    TEXT DEFAULT NULL,           -- drink window from this valuation run
    source          TEXT DEFAULT 'claude_ai',

    fetched_at      TIMESTAMPTZ DEFAULT now()
);

-- RLS: shared price data (same approach as stock price_history)
ALTER TABLE wine_price_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Authenticated users can view wine price history"
        ON wine_price_history FOR SELECT USING (auth.role() = 'authenticated');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can insert own wine price history"
        ON wine_price_history FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wine_price_history_wine_id      ON wine_price_history(wine_id);
CREATE INDEX IF NOT EXISTS idx_wine_price_history_wine_fetched ON wine_price_history(wine_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_wine_price_history_user_id      ON wine_price_history(user_id);


-- ────────────────────────────────────────────
-- wine_snapshots: cellar value history
-- Point-in-time aggregate snapshot of the whole cellar.
-- Used for the history chart. Unchanged from v1.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wine_snapshots (
    id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    timestamp             TIMESTAMPTZ NOT NULL,
    total_invested        NUMERIC NOT NULL,
    total_estimated_value NUMERIC NOT NULL,
    bottle_count          INTEGER NOT NULL DEFAULT 0,

    created_at            TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE wine_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Users can view own wine snapshots"
        ON wine_snapshots FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can insert own wine snapshots"
        ON wine_snapshots FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can delete own wine snapshots"
        ON wine_snapshots FOR DELETE USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wine_snapshots_user_id        ON wine_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_wine_snapshots_user_timestamp ON wine_snapshots(user_id, timestamp DESC);


-- ────────────────────────────────────────────
-- asset_movements: unified backlog for ALL asset movements
-- Covers both wine and stock assets.
-- Records every buy, sell, valuation update, transfer, and adjustment.
-- Provides a full audit trail and enables movement-level analysis.
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS asset_movements (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    -- Asset reference: asset_type determines which FK is relevant
    asset_type      TEXT NOT NULL CHECK (asset_type IN ('wine', 'stock')),
    wine_id         UUID REFERENCES wines(id) ON DELETE SET NULL,
    stock_ticker    TEXT DEFAULT NULL,           -- symbol from the positions table

    -- Movement classification
    movement_type   TEXT NOT NULL CHECK (movement_type IN (
        'buy',              -- asset purchased
        'sell',             -- asset sold or removed from portfolio
        'transfer_in',      -- received without a purchase (no cost basis change)
        'transfer_out',     -- sent out without a sale
        'valuation_update', -- AI re-valuation (wine) or price fetch (stock)
        'snapshot',         -- portfolio snapshot saved
        'adjustment'        -- manual quantity or cost correction
    )),

    -- Quantities and values (all optional — some movements are non-monetary)
    qty             NUMERIC DEFAULT NULL,        -- positive = in, negative = out
    price           NUMERIC DEFAULT NULL,        -- per-unit price at movement time
    total_value     NUMERIC DEFAULT NULL,        -- qty × price or total snapshot value

    notes           TEXT DEFAULT NULL,
    moved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when the real-world event occurred
    created_at      TIMESTAMPTZ DEFAULT now()            -- when the DB row was written
);

-- RLS
ALTER TABLE asset_movements ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "Users can view own movements"
        ON asset_movements FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can insert own movements"
        ON asset_movements FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_asset_movements_user_id  ON asset_movements(user_id);
CREATE INDEX IF NOT EXISTS idx_asset_movements_wine_id  ON asset_movements(wine_id);
CREATE INDEX IF NOT EXISTS idx_asset_movements_stock    ON asset_movements(stock_ticker);
CREATE INDEX IF NOT EXISTS idx_asset_movements_type     ON asset_movements(user_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_asset_movements_moved_at ON asset_movements(moved_at DESC);

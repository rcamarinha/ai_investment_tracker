-- ============================================
-- Supabase Schema — Wine Cellar Tracker
-- ============================================
-- Run this in your Supabase SQL Editor:
--   Dashboard > SQL Editor > New Query > Paste & Run
--
-- This ADDS wine tables to your existing AI Investment Tracker project.
-- It does NOT modify any existing tables (positions, snapshots, assets, etc.)
-- ============================================


-- ────────────────────────────────────────────
-- wine_bottles: individual bottles in the cellar
-- ────────────────────────────────────────────
CREATE TABLE wine_bottles (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    -- Identity
    name            TEXT NOT NULL,
    winery          TEXT DEFAULT NULL,
    vintage         INTEGER DEFAULT NULL,
    region          TEXT DEFAULT NULL,
    appellation     TEXT DEFAULT NULL,
    varietal        TEXT DEFAULT NULL,
    country         TEXT DEFAULT NULL,
    alcohol         TEXT DEFAULT NULL,    -- stored as string, e.g. "13.5%"

    -- Investment data
    qty             INTEGER NOT NULL DEFAULT 1,
    purchase_price  NUMERIC NOT NULL,     -- per bottle, in EUR
    purchase_date   DATE DEFAULT NULL,
    storage         TEXT DEFAULT NULL,    -- e.g. "Home cellar", "Cavissima"
    notes           TEXT DEFAULT NULL,

    -- AI valuation (updated when user clicks "Update Valuations")
    estimated_value NUMERIC DEFAULT NULL, -- per bottle, in EUR
    drink_window    TEXT DEFAULT NULL,    -- e.g. "2025-2035"
    last_valued_at  TIMESTAMPTZ DEFAULT NULL,

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE wine_bottles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own wine bottles"
    ON wine_bottles FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own wine bottles"
    ON wine_bottles FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own wine bottles"
    ON wine_bottles FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own wine bottles"
    ON wine_bottles FOR DELETE
    USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_wine_bottles_user_id ON wine_bottles(user_id);
CREATE INDEX idx_wine_bottles_vintage ON wine_bottles(vintage);
CREATE INDEX idx_wine_bottles_region  ON wine_bottles(region);


-- ────────────────────────────────────────────
-- wine_snapshots: cellar value history
-- ────────────────────────────────────────────
CREATE TABLE wine_snapshots (
    id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id               UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    timestamp             TIMESTAMPTZ NOT NULL,
    total_invested        NUMERIC NOT NULL,       -- total cost basis (qty × purchase_price)
    total_estimated_value NUMERIC NOT NULL,       -- total estimated market value
    bottle_count          INTEGER NOT NULL DEFAULT 0,

    created_at            TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE wine_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own wine snapshots"
    ON wine_snapshots FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own wine snapshots"
    ON wine_snapshots FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own wine snapshots"
    ON wine_snapshots FOR DELETE
    USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_wine_snapshots_user_id        ON wine_snapshots(user_id);
CREATE INDEX idx_wine_snapshots_user_timestamp ON wine_snapshots(user_id, timestamp DESC);

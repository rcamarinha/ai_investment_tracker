-- ============================================
-- Supabase Schema for AI Investment Tracker
-- ============================================
-- Run this in your Supabase SQL Editor:
-- Dashboard > SQL Editor > New Query > Paste & Run

-- Positions table: stores each user's portfolio positions
CREATE TABLE positions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    symbol TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'Unknown',
    shares NUMERIC NOT NULL,
    avg_price NUMERIC NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Snapshots table: stores portfolio history snapshots
CREATE TABLE snapshots (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    total_invested NUMERIC NOT NULL,
    total_market_value NUMERIC NOT NULL,
    position_count INTEGER NOT NULL,
    prices_available INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;

-- Positions policies: users can only access their own positions
CREATE POLICY "Users can view own positions"
    ON positions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own positions"
    ON positions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own positions"
    ON positions FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own positions"
    ON positions FOR DELETE
    USING (auth.uid() = user_id);

-- Snapshots policies: users can only access their own snapshots
CREATE POLICY "Users can view own snapshots"
    ON snapshots FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own snapshots"
    ON snapshots FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own snapshots"
    ON snapshots FOR DELETE
    USING (auth.uid() = user_id);

-- Performance indexes
CREATE INDEX idx_positions_user_id ON positions(user_id);
CREATE INDEX idx_snapshots_user_id ON snapshots(user_id);
CREATE INDEX idx_snapshots_user_timestamp ON snapshots(user_id, timestamp DESC);

-- ============================================
-- App Config: shared API keys (admin-managed)
-- ============================================
-- Only authenticated users can read. No frontend writes allowed.
-- Manage keys via Supabase Dashboard > Table Editor only.

CREATE TABLE app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read config"
    ON app_config FOR SELECT
    USING (auth.role() = 'authenticated');

-- Insert the shared API keys
INSERT INTO app_config (key, value) VALUES
    ('finnhubKey', 'd5u9b19r01qtjet2flngd5u9b19r01qtjet2flo0'),
    ('fmpKey', 'driWloMwwLkFzzcl4Gvgv1CXhXa7jy2l'),
    ('alphaVantageKey', 'ABF4HZSG0I50VGLP');

-- ============================================
-- Assets table: stores asset metadata (sector, exchange, ISIN mappings)
-- Ticker is the primary key — no UUID needed.
-- ============================================

CREATE TABLE assets (
    ticker TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    stock_exchange TEXT DEFAULT '',
    sector TEXT DEFAULT '',
    currency TEXT DEFAULT '',
    asset_type TEXT DEFAULT 'Stock',
    isin TEXT DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view assets"
    ON assets FOR SELECT
    USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert assets"
    ON assets FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update assets"
    ON assets FOR UPDATE
    USING (auth.role() = 'authenticated');

-- Index for ISIN lookups
CREATE INDEX idx_assets_isin ON assets(isin) WHERE isin IS NOT NULL;

-- ============================================
-- Price History table: stores fetched prices over time
-- References assets by ticker directly.
-- ============================================

CREATE TABLE price_history (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    ticker TEXT NOT NULL REFERENCES assets(ticker) ON DELETE CASCADE,
    price NUMERIC NOT NULL,
    currency TEXT DEFAULT 'USD',
    source TEXT DEFAULT '',
    fetched_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read price history (shared price cache)
CREATE POLICY "Authenticated users can view price history"
    ON price_history FOR SELECT
    USING (auth.role() = 'authenticated');

-- Users can only insert price history rows tagged with their own user_id
CREATE POLICY "Users can insert own price history"
    ON price_history FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_price_history_user_id ON price_history(user_id);
CREATE INDEX idx_price_history_ticker ON price_history(ticker);
CREATE INDEX idx_price_history_ticker_fetched ON price_history(ticker, fetched_at DESC);

-- ============================================
-- Admin Emails: comma-separated list of admin users
-- ============================================
-- Users whose email is in this list get the 'admin' role and can manage API keys.
-- All other authenticated users get the 'user' role (read-only for keys).
-- If this row doesn't exist, all users default to admin (backward-compatible).
INSERT INTO app_config (key, value) VALUES
    ('adminEmails', 'admin@example.com');

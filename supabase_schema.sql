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

-- Transactions table: records every buy/sell action for audit trail + P&L
CREATE TABLE transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('buy', 'sell')),
    shares NUMERIC NOT NULL,
    price NUMERIC NOT NULL,
    total_amount NUMERIC NOT NULL,
    date DATE NOT NULL,
    cost_basis NUMERIC,         -- avg cost at time of sale (sell only)
    realized_gain_loss NUMERIC, -- realized P&L (sell only)
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own transactions"
    ON transactions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own transactions"
    ON transactions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own transactions"
    ON transactions FOR DELETE
    USING (auth.uid() = user_id);

-- Performance indexes
CREATE INDEX idx_positions_user_id ON positions(user_id);
CREATE INDEX idx_snapshots_user_id ON snapshots(user_id);
CREATE INDEX idx_snapshots_user_timestamp ON snapshots(user_id, timestamp DESC);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_user_symbol ON transactions(user_id, symbol);

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

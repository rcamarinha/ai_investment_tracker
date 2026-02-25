-- ============================================
-- Migration v2.0 — Wine Cellar Restructure
-- ============================================
-- Splits the monolithic wine_bottles table into a normalised schema:
--
--   wines             — shared genetic/identity catalog (like assets for stocks)
--   user_wines        — per-user holdings (like positions for stocks)
--   wine_price_history— AI valuation history per wine (like price_history for stocks)
--   asset_movements   — unified backlog of all asset movements (wine + stock)
--
-- SAFE TO RUN MULTIPLE TIMES — all CREATE TABLE and CREATE POLICY statements
-- are guarded with IF NOT EXISTS / exception handlers.
--
-- Run in your Supabase SQL Editor:
--   Dashboard > SQL Editor > New Query > Paste & Run
-- ============================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1. wines — genetic identity catalog (shared, no user_id)
--    Mirrors the role of the assets table for stocks.
--    One row per unique wine (name + winery + vintage defines identity).
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wines (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,

    -- Identity (genetic details — shared across users)
    name            TEXT NOT NULL,
    winery          TEXT DEFAULT NULL,
    vintage         INTEGER DEFAULT NULL,
    region          TEXT DEFAULT NULL,
    appellation     TEXT DEFAULT NULL,
    varietal        TEXT DEFAULT NULL,
    country         TEXT DEFAULT NULL,
    alcohol         TEXT DEFAULT NULL,   -- e.g. "13.5%"

    -- Drink window — shared best estimate updated by any valuation
    drink_window    TEXT DEFAULT NULL,   -- e.g. "2025-2040"

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

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

CREATE INDEX IF NOT EXISTS idx_wines_name_vintage ON wines(LOWER(name), vintage);
CREATE INDEX IF NOT EXISTS idx_wines_vintage       ON wines(vintage);
CREATE INDEX IF NOT EXISTS idx_wines_region        ON wines(region);
CREATE INDEX IF NOT EXISTS idx_wines_varietal      ON wines(varietal);


-- ────────────────────────────────────────────────────────────────────────────
-- 2. user_wines — per-user holdings
--    Mirrors the role of the positions table for stocks.
--    Each row = one purchase lot (same wine bought at different times/prices
--    results in separate user_wines rows, all pointing to the same wines row).
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_wines (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    wine_id         UUID REFERENCES wines(id) ON DELETE CASCADE NOT NULL,

    -- Investment data (user-specific)
    qty             INTEGER NOT NULL DEFAULT 1,
    purchase_price  NUMERIC DEFAULT NULL,        -- per bottle, EUR
    purchase_date   DATE DEFAULT NULL,
    storage         TEXT DEFAULT NULL,           -- e.g. "Home cellar", "Cavissima"
    notes           TEXT DEFAULT NULL,

    -- AI valuation — latest estimate for this user's lot
    estimated_value NUMERIC DEFAULT NULL,        -- per bottle, EUR
    value_low       NUMERIC DEFAULT NULL,        -- Claude's low-end estimate
    value_high      NUMERIC DEFAULT NULL,        -- Claude's high-end estimate
    valuation_note  TEXT DEFAULT NULL,           -- 1-2 sentence explanation
    last_valued_at  TIMESTAMPTZ DEFAULT NULL,

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

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

CREATE INDEX IF NOT EXISTS idx_user_wines_user_id   ON user_wines(user_id);
CREATE INDEX IF NOT EXISTS idx_user_wines_wine_id   ON user_wines(wine_id);
CREATE INDEX IF NOT EXISTS idx_user_wines_user_wine ON user_wines(user_id, wine_id);


-- ────────────────────────────────────────────────────────────────────────────
-- 3. wine_price_history — AI valuation history per wine
--    Mirrors the role of the price_history table for stocks.
--    Each valuation run appends a row; allows tracking value over time.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wine_price_history (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    wine_id         UUID REFERENCES wines(id) ON DELETE CASCADE NOT NULL,
    user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    price           NUMERIC NOT NULL,            -- estimated value per bottle, EUR
    value_low       NUMERIC DEFAULT NULL,
    value_high      NUMERIC DEFAULT NULL,
    valuation_note  TEXT DEFAULT NULL,
    drink_window    TEXT DEFAULT NULL,
    source          TEXT DEFAULT 'claude_ai',    -- valuation source

    fetched_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE wine_price_history ENABLE ROW LEVEL SECURITY;

-- Price history is shared (any authenticated user can see all valuations,
-- consistent with how stock price_history works — public price data)
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

CREATE INDEX IF NOT EXISTS idx_wine_price_history_wine_id      ON wine_price_history(wine_id);
CREATE INDEX IF NOT EXISTS idx_wine_price_history_wine_fetched ON wine_price_history(wine_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_wine_price_history_user_id      ON wine_price_history(user_id);


-- ────────────────────────────────────────────────────────────────────────────
-- 4. asset_movements — unified backlog for ALL asset movements (wine + stock)
--    Records every buy, sell, valuation update, and adjustment.
--    Provides full audit trail and enables portfolio movement analysis.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS asset_movements (
    id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,

    -- Asset reference: exactly one of wine_id or stock_ticker should be set
    asset_type      TEXT NOT NULL CHECK (asset_type IN ('wine', 'stock')),
    wine_id         UUID REFERENCES wines(id) ON DELETE SET NULL,
    stock_ticker    TEXT DEFAULT NULL,           -- symbol from positions table

    -- Movement classification
    movement_type   TEXT NOT NULL CHECK (movement_type IN (
        'buy',              -- purchased asset
        'sell',             -- sold / removed asset
        'transfer_in',      -- received (no cost basis change)
        'transfer_out',     -- sent out (no proceeds)
        'valuation_update', -- AI re-valuation (wine) or price fetch (stock)
        'snapshot',         -- portfolio snapshot taken
        'adjustment'        -- quantity or cost correction
    )),

    -- Quantities and values
    qty             NUMERIC DEFAULT NULL,        -- positive = in, negative = out
    price           NUMERIC DEFAULT NULL,        -- per-unit price at movement time
    total_value     NUMERIC DEFAULT NULL,        -- qty × price (or total snapshot value)

    notes           TEXT DEFAULT NULL,
    moved_at        TIMESTAMPTZ NOT NULL DEFAULT now(),   -- when the real-world event occurred
    created_at      TIMESTAMPTZ DEFAULT now()             -- when the DB row was created
);

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

CREATE INDEX IF NOT EXISTS idx_asset_movements_user_id   ON asset_movements(user_id);
CREATE INDEX IF NOT EXISTS idx_asset_movements_wine_id   ON asset_movements(wine_id);
CREATE INDEX IF NOT EXISTS idx_asset_movements_stock     ON asset_movements(stock_ticker);
CREATE INDEX IF NOT EXISTS idx_asset_movements_type      ON asset_movements(user_id, asset_type);
CREATE INDEX IF NOT EXISTS idx_asset_movements_moved_at  ON asset_movements(moved_at DESC);


-- ════════════════════════════════════════════════════════════════════════════
-- DATA MIGRATION
-- Moves all data from wine_bottles → wines + user_wines + wine_price_history
-- + asset_movements, and seeds asset_movements from stock positions as well.
--
-- Guards:
--   • Skips if wine_bottles table does not exist (fresh install)
--   • Skips if user_wines already has rows (already migrated)
-- ════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    bottle_rec  RECORD;
    wine_uuid   UUID;
    uw_uuid     UUID;
BEGIN
    -- Guard: wine_bottles must exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'wine_bottles'
    ) THEN
        RAISE NOTICE 'wine_bottles table not found — fresh install, skipping wine data migration.';
        RETURN;
    END IF;

    -- Guard: skip if already migrated
    IF EXISTS (SELECT 1 FROM user_wines LIMIT 1) THEN
        RAISE NOTICE 'user_wines already contains rows — migration already ran, skipping to avoid duplicates.';
        RETURN;
    END IF;

    RAISE NOTICE 'Starting wine data migration from wine_bottles → new schema…';

    FOR bottle_rec IN
        SELECT * FROM wine_bottles ORDER BY created_at ASC
    LOOP
        -- ── Step 1: Find or create the shared wines catalog entry ──────────
        -- Deduplication key: LOWER(name) + winery (NULL-safe) + vintage (NULL-safe)
        SELECT id INTO wine_uuid
        FROM   wines
        WHERE  LOWER(name) = LOWER(bottle_rec.name)
          AND  (winery  IS NOT DISTINCT FROM bottle_rec.winery)
          AND  (vintage IS NOT DISTINCT FROM bottle_rec.vintage)
        LIMIT  1;

        IF wine_uuid IS NULL THEN
            -- Create new catalog entry
            INSERT INTO wines (
                name, winery, vintage, region, appellation,
                varietal, country, alcohol, drink_window,
                created_at, updated_at
            )
            VALUES (
                bottle_rec.name,
                bottle_rec.winery,
                bottle_rec.vintage,
                bottle_rec.region,
                bottle_rec.appellation,
                bottle_rec.varietal,
                bottle_rec.country,
                bottle_rec.alcohol,
                bottle_rec.drink_window,
                bottle_rec.created_at,
                bottle_rec.updated_at
            )
            RETURNING id INTO wine_uuid;

            RAISE NOTICE 'Created wines entry: % (vintage %)', bottle_rec.name, bottle_rec.vintage;
        ELSE
            -- Enrich existing entry with any non-null fields from this bottle
            UPDATE wines SET
                region       = COALESCE(region,       bottle_rec.region),
                appellation  = COALESCE(appellation,  bottle_rec.appellation),
                varietal     = COALESCE(varietal,     bottle_rec.varietal),
                country      = COALESCE(country,      bottle_rec.country),
                alcohol      = COALESCE(alcohol,      bottle_rec.alcohol),
                drink_window = COALESCE(drink_window, bottle_rec.drink_window),
                updated_at   = now()
            WHERE id = wine_uuid;

            RAISE NOTICE 'Reused wines entry for duplicate: % (vintage %)', bottle_rec.name, bottle_rec.vintage;
        END IF;

        -- ── Step 2: Create the user_wines holding ─────────────────────────
        INSERT INTO user_wines (
            user_id, wine_id,
            qty, purchase_price, purchase_date, storage, notes,
            estimated_value, value_low, value_high, valuation_note, last_valued_at,
            created_at, updated_at
        )
        VALUES (
            bottle_rec.user_id,
            wine_uuid,
            bottle_rec.qty,
            bottle_rec.purchase_price,
            bottle_rec.purchase_date,
            bottle_rec.storage,
            bottle_rec.notes,
            bottle_rec.estimated_value,
            bottle_rec.value_low,
            bottle_rec.value_high,
            bottle_rec.valuation_note,
            bottle_rec.last_valued_at,
            bottle_rec.created_at,
            bottle_rec.updated_at
        )
        RETURNING id INTO uw_uuid;

        -- ── Step 3: Seed wine_price_history for valuated bottles ──────────
        IF bottle_rec.estimated_value IS NOT NULL THEN
            INSERT INTO wine_price_history (
                wine_id, user_id,
                price, value_low, value_high, valuation_note, drink_window,
                source, fetched_at
            )
            VALUES (
                wine_uuid,
                bottle_rec.user_id,
                bottle_rec.estimated_value,
                bottle_rec.value_low,
                bottle_rec.value_high,
                bottle_rec.valuation_note,
                bottle_rec.drink_window,
                'claude_ai',
                COALESCE(bottle_rec.last_valued_at, bottle_rec.updated_at)
            );
        END IF;

        -- ── Step 4: Log the original buy in asset_movements ───────────────
        INSERT INTO asset_movements (
            user_id, asset_type, wine_id,
            movement_type, qty, price, total_value, notes, moved_at, created_at
        )
        VALUES (
            bottle_rec.user_id,
            'wine',
            wine_uuid,
            'buy',
            bottle_rec.qty,
            bottle_rec.purchase_price,
            bottle_rec.qty * COALESCE(bottle_rec.purchase_price, 0),
            'Migrated from wine_bottles (id: ' || bottle_rec.id || ')',
            COALESCE(bottle_rec.purchase_date::TIMESTAMPTZ, bottle_rec.created_at),
            bottle_rec.created_at
        );

    END LOOP;

    RAISE NOTICE 'Wine data migration complete.';
END $$;


-- ── Seed asset_movements from existing stock positions ────────────────────────
-- Creates one 'buy' movement per position row. Idempotent: skips positions that
-- already have a matching movement (matched on user_id + stock_ticker + 'buy').

DO $$
DECLARE
    pos_rec RECORD;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'positions'
    ) THEN
        RAISE NOTICE 'positions table not found — skipping stock movement migration.';
        RETURN;
    END IF;

    RAISE NOTICE 'Seeding asset_movements from stock positions…';

    FOR pos_rec IN
        SELECT p.*
        FROM   positions p
        WHERE  NOT EXISTS (
            SELECT 1 FROM asset_movements am
            WHERE  am.user_id      = p.user_id
              AND  am.stock_ticker = p.symbol
              AND  am.movement_type = 'buy'
        )
    LOOP
        INSERT INTO asset_movements (
            user_id, asset_type, stock_ticker,
            movement_type, qty, price, total_value, notes, moved_at, created_at
        )
        VALUES (
            pos_rec.user_id,
            'stock',
            pos_rec.symbol,
            'buy',
            pos_rec.shares,
            pos_rec.avg_price,
            pos_rec.shares * pos_rec.avg_price,
            'Migrated from positions: ' || pos_rec.name,
            pos_rec.created_at,
            pos_rec.created_at
        );
    END LOOP;

    RAISE NOTICE 'Stock position migration complete.';
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- OPTIONAL POST-MIGRATION CLEANUP
-- After verifying the migration is correct, you may rename the old table:
--
--   ALTER TABLE wine_bottles RENAME TO wine_bottles_backup_v1;
--
-- And eventually drop it:
--
--   DROP TABLE wine_bottles_backup_v1;
--
-- Do NOT drop it immediately — keep it as a safety net for a few days.
-- ════════════════════════════════════════════════════════════════════════════

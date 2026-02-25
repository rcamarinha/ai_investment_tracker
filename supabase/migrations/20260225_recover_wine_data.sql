-- ============================================
-- Recovery: wine_bottles_backup_v1 → new schema
-- ============================================
-- Run this if you renamed wine_bottles BEFORE the data migration ran,
-- so wine_bottles_backup_v1 still holds all your original cellar data
-- but the new tables (wines, user_wines, etc.) are empty.
--
-- SAFE TO RUN MULTIPLE TIMES — each bottle is tracked by its original UUID
-- in the asset_movements notes column, so re-running skips already-migrated
-- rows and won't create duplicates even if you've added new bottles via the
-- new UI in the meantime.
--
-- Run in Supabase SQL Editor:
--   Dashboard > SQL Editor > New Query > Paste & Run
-- ============================================

DO $$
DECLARE
    bottle_rec  RECORD;
    wine_uuid   UUID;
    uw_uuid     UUID;
    migration_tag TEXT;
    already_done  INT;
    skipped       INT := 0;
    migrated      INT := 0;
BEGIN
    -- ── Guard: backup table must exist ──────────────────────────────────────
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name   = 'wine_bottles_backup_v1'
    ) THEN
        RAISE EXCEPTION
            'wine_bottles_backup_v1 not found. '
            'If your table has a different name run: '
            'ALTER TABLE <your_table_name> RENAME TO wine_bottles_backup_v1;';
    END IF;

    -- ── Guard: new tables must already exist ────────────────────────────────
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'wines'
    ) THEN
        RAISE EXCEPTION
            'wines table not found. '
            'Run wine_schema.sql first to create the new tables.';
    END IF;

    RAISE NOTICE 'Starting recovery from wine_bottles_backup_v1…';

    FOR bottle_rec IN
        SELECT * FROM wine_bottles_backup_v1 ORDER BY created_at ASC
    LOOP
        -- Per-row idempotency: skip if this original bottle UUID was already
        -- migrated (identified by its UUID in the asset_movements notes).
        migration_tag := 'backup_id:' || bottle_rec.id::TEXT;

        SELECT COUNT(*) INTO already_done
        FROM   asset_movements
        WHERE  notes LIKE '%' || migration_tag || '%'
          AND  movement_type = 'buy'
          AND  asset_type    = 'wine';

        IF already_done > 0 THEN
            skipped := skipped + 1;
            CONTINUE;
        END IF;

        -- ── Step 1: Find or create the shared wines catalog entry ──────────
        -- Deduplication key: LOWER(name) + winery (NULL-safe) + vintage (NULL-safe)
        SELECT id INTO wine_uuid
        FROM   wines
        WHERE  LOWER(name) = LOWER(bottle_rec.name)
          AND  (winery  IS NOT DISTINCT FROM bottle_rec.winery)
          AND  (vintage IS NOT DISTINCT FROM bottle_rec.vintage)
        LIMIT  1;

        IF wine_uuid IS NULL THEN
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
        ELSE
            -- Enrich existing entry with any non-null fields from this backup row
            UPDATE wines SET
                region       = COALESCE(region,       bottle_rec.region),
                appellation  = COALESCE(appellation,  bottle_rec.appellation),
                varietal     = COALESCE(varietal,     bottle_rec.varietal),
                country      = COALESCE(country,      bottle_rec.country),
                alcohol      = COALESCE(alcohol,      bottle_rec.alcohol),
                drink_window = COALESCE(drink_window, bottle_rec.drink_window),
                updated_at   = now()
            WHERE id = wine_uuid;
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
        -- The migration_tag in notes is what makes this idempotent on re-run.
        INSERT INTO asset_movements (
            user_id, asset_type, wine_id,
            movement_type, qty, price, total_value,
            notes, moved_at, created_at
        )
        VALUES (
            bottle_rec.user_id,
            'wine',
            wine_uuid,
            'buy',
            bottle_rec.qty,
            bottle_rec.purchase_price,
            bottle_rec.qty * COALESCE(bottle_rec.purchase_price, 0),
            'Recovered from wine_bottles_backup_v1 (' || migration_tag || ')',
            COALESCE(bottle_rec.purchase_date::TIMESTAMPTZ, bottle_rec.created_at),
            bottle_rec.created_at
        );

        migrated := migrated + 1;
    END LOOP;

    RAISE NOTICE 'Wine recovery complete: % bottles migrated, % already done (skipped).',
        migrated, skipped;
END $$;


-- ── Seed asset_movements from existing stock positions ────────────────────────
-- Idempotent: skips any position that already has a matching buy movement.

DO $$
DECLARE
    pos_rec RECORD;
    n       INT := 0;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'positions'
    ) THEN
        RAISE NOTICE 'positions table not found — skipping stock movement seeding.';
        RETURN;
    END IF;

    FOR pos_rec IN
        SELECT p.*
        FROM   positions p
        WHERE  NOT EXISTS (
            SELECT 1 FROM asset_movements am
            WHERE  am.user_id       = p.user_id
              AND  am.stock_ticker  = p.symbol
              AND  am.movement_type = 'buy'
        )
    LOOP
        INSERT INTO asset_movements (
            user_id, asset_type, stock_ticker,
            movement_type, qty, price, total_value,
            notes, moved_at, created_at
        )
        VALUES (
            pos_rec.user_id,
            'stock',
            pos_rec.symbol,
            'buy',
            pos_rec.shares,
            pos_rec.avg_price,
            pos_rec.shares * pos_rec.avg_price,
            'Seeded from positions: ' || pos_rec.name,
            pos_rec.created_at,
            pos_rec.created_at
        );
        n := n + 1;
    END LOOP;

    RAISE NOTICE 'Stock seeding complete: % position(s) added to asset_movements.', n;
END $$;


-- ── Verification queries ──────────────────────────────────────────────────────
-- Run these after the migration to confirm everything looks right:
--
--   SELECT COUNT(*) FROM wines;
--   SELECT COUNT(*) FROM user_wines;
--   SELECT COUNT(*) FROM wine_price_history;
--   SELECT COUNT(*) FROM asset_movements WHERE asset_type = 'wine';
--
-- Compare wines count with:
--   SELECT COUNT(*) FROM wine_bottles_backup_v1;
--
-- If they match, your data is fully recovered.

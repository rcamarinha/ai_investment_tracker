-- Migration: a person's pricing choices stop being everybody's.
--
-- `assets` is a SHARED catalogue with no owner column, and any authenticated
-- account may update any row. Two of its columns are not catalogue facts at all:
--
--   untracked       "keep at cost" — one person disabling pricing for a ticker
--                   disabled it for EVERY account holding that ticker
--   pricing_ticker  the learned symbol that actually returns a price; it is what
--                   services/pricing.js queries for a holding, so repointing it
--                   silently re-priced that holding for every holder, and the
--                   wrong figure flowed into snapshots and the hub's net worth
--
-- Both are personal choices living in shared data. No amount of validation fixes
-- that, so they move to a per-user table. The catalogue keeps the objective
-- facts (name, sector, exchange, currency, type, ISIN), which are meant to be
-- shared, and a trigger bounds what a browser may do to them.
--
-- BACKFILL, deliberately: a row is created for EVERY user currently holding a
-- ticker that carries one of these settings. Nobody can know who originally set
-- them, so this preserves exactly today's behaviour for everyone. Someone who
-- was affected by another person's choice can now undo it for themselves, with
-- the click-to-re-enable link the card already has.
--
-- The trigger applies to the BROWSER roles (authenticated, anon). The service
-- role and the SQL editor still write freely, so a wrong value stays repairable
-- from the server — and so this migration's own backfill can read what is there.
--
-- The trigger CLAMPS rather than raises. saveAssetsToDB upserts a batch and only
-- warns per row (services/storage.js), so a raising trigger would turn one long
-- sector name into a silently unsaved batch of metadata.
--
-- ORDER: run this BEFORE the client that reads the new table. The old client
-- keeps working: it reads assets.untracked / assets.pricing_ticker, which are
-- frozen at their current values, so behaviour is unchanged until the new
-- client ships.
--
-- Re-runnable: IF NOT EXISTS, DROP POLICY/TRIGGER IF EXISTS, ON CONFLICT.
-- Rollback: supabase/maintenance/rollback-20260921-per-user-asset-prefs.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.user_asset_prefs (
    user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ticker         TEXT NOT NULL CHECK (length(ticker) BETWEEN 1 AND 40),
    untracked      BOOLEAN NOT NULL DEFAULT false,
    pricing_ticker TEXT CHECK (pricing_ticker IS NULL OR length(pricing_ticker) BETWEEN 1 AND 40),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, ticker)
);

ALTER TABLE public.user_asset_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own asset prefs"   ON public.user_asset_prefs;
DROP POLICY IF EXISTS "Users insert own asset prefs" ON public.user_asset_prefs;
DROP POLICY IF EXISTS "Users update own asset prefs" ON public.user_asset_prefs;
DROP POLICY IF EXISTS "Users delete own asset prefs" ON public.user_asset_prefs;

CREATE POLICY "Users read own asset prefs"   ON public.user_asset_prefs FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own asset prefs" ON public.user_asset_prefs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own asset prefs" ON public.user_asset_prefs FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own asset prefs" ON public.user_asset_prefs FOR DELETE TO authenticated USING (auth.uid() = user_id);

REVOKE ALL ON public.user_asset_prefs FROM anon;

-- ── Backfill: keep today's behaviour for everyone who has it today ──────────
INSERT INTO public.user_asset_prefs (user_id, ticker, untracked, pricing_ticker)
SELECT DISTINCT p.user_id, upper(a.ticker), coalesce(a.untracked, false), a.pricing_ticker
FROM public.assets a
JOIN public.positions p ON upper(p.symbol) = upper(a.ticker)
WHERE coalesce(a.untracked, false) = true OR a.pricing_ticker IS NOT NULL
ON CONFLICT (user_id, ticker) DO NOTHING;

-- ── The catalogue keeps only facts, and only within bounds ──────────────────
CREATE OR REPLACE FUNCTION public.assets_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    -- Control characters (including newlines) are stripped: these values are
    -- rendered in other people's pages and concatenated into AI prompts.
    -- POSIX class, not a unicode escape: a plain SQL string does not interpret
    -- those, and writing them literally puts real control bytes in this file.
    clean CONSTANT text := '[[:cntrl:]]';
BEGIN
    -- Browser roles only. The service role and the SQL editor (owner) keep
    -- writing freely, so these columns stay repairable from the server and a
    -- maintenance script needs no ALTER TABLE ... DISABLE TRIGGER.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    -- Personal choices are no longer stored here. Freeze them: an old client
    -- writing them changes nothing, rather than changing everyone's pricing.
    IF TG_OP = 'UPDATE' THEN
        NEW.ticker         := OLD.ticker;
        NEW.untracked      := OLD.untracked;
        NEW.pricing_ticker := OLD.pricing_ticker;
        NEW.created_at     := OLD.created_at;
    ELSE
        -- A new row carries neither choice: both are personal now.
        NEW.untracked      := false;
        NEW.pricing_ticker := NULL;
    END IF;

    -- What a client MAY change, bounded. Enumerating what may change (rather
    -- than what may not) means a column added later is frozen by default — the
    -- earlier wine migration enumerated the other way and forgot five columns.
    NEW.name           := left(regexp_replace(coalesce(NEW.name, ''), clean, '', 'g'), 200);
    NEW.sector         := left(regexp_replace(coalesce(NEW.sector, ''), clean, '', 'g'), 80);
    NEW.stock_exchange := left(regexp_replace(coalesce(NEW.stock_exchange, ''), clean, '', 'g'), 80);
    NEW.currency       := left(regexp_replace(coalesce(NEW.currency, ''), clean, '', 'g'), 12);
    NEW.asset_type     := left(regexp_replace(coalesce(NEW.asset_type, ''), clean, '', 'g'), 40);
    NEW.isin           := left(regexp_replace(coalesce(NEW.isin, ''), clean, '', 'g'), 12);
    IF NEW.isin = '' THEN NEW.isin := NULL; END IF;
    NEW.updated_at     := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assets_guard ON public.assets;
CREATE TRIGGER assets_guard
    BEFORE INSERT OR UPDATE ON public.assets
    FOR EACH ROW EXECUTE FUNCTION public.assets_guard();

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- AFTER, read-only:
--   1. The backfill covered every holder (expect one row per holder per
--      affected ticker, and zero affected tickers with no rows):
--        SELECT count(*) FROM user_asset_prefs;
--        SELECT a.ticker, a.untracked, a.pricing_ticker,
--               (SELECT count(*) FROM user_asset_prefs u WHERE u.ticker = upper(a.ticker)) AS prefs
--        FROM assets a
--        WHERE coalesce(a.untracked,false) OR a.pricing_ticker IS NOT NULL;
--   2. The trigger exists and freezes the personal columns. From a SECOND
--      account's session — NOT the SQL editor, which runs as the table owner
--      and bypasses row security — try to repoint a ticker:
--        update assets set pricing_ticker = 'PENNY' where ticker = 'AAPL';
--      then check it did not change:
--        SELECT ticker, pricing_ticker, untracked FROM assets WHERE ticker = 'AAPL';
-- ════════════════════════════════════════════════════════════════════════════

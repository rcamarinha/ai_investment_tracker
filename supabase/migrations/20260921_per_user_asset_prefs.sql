-- Migration: a person's pricing choices stop being everybody's, and the shared
-- catalogue stops accepting changes that silently alter other people's money.
--
-- `assets` is a SHARED catalogue with no owner column, and any authenticated
-- account may update any row. It carried two things that were never catalogue
-- facts, and it accepted three changes that corrupted other accounts:
--
--   untracked       "keep at cost": one person disabling pricing for a ticker
--                   disabled it for EVERY account holding that ticker.
--   pricing_ticker  the learned symbol services/pricing.js queries: repointing
--                   it re-priced that holding for every holder, into their
--                   snapshots and the hub's net worth, with no trace.
--   isin            the ISIN->ticker mapping broker imports trust: attaching
--                   another company's ISIN filed the next person's imported
--                   trades under the wrong ticker, in their own ledger.
--   currency +      marking a currency 'user'-confirmed, the highest rank, made
--   currency_source it impossible for any honest client to correct, and it
--                   drives cost basis and market value for every holder.
--   ticker          any string inserted as a ticker, so junk rows could crowd
--                   real ones out of every client's catalogue load.
--
-- The first two are personal choices: they move to user_asset_prefs. The rest
-- are real shared facts: a trigger now decides what a browser may change.
--
-- THE TRIGGER IS AN ALLOW-LIST. On UPDATE it starts from the stored row and
-- copies across only the permitted fields, and only the ones the request
-- actually changed. A column added later is therefore frozen by default, and an
-- untouched value is never rewritten. It applies to every role except the
-- server's own (postgres, service_role, supabase_admin) — naming the exemptions
-- rather than the guarded roles, so a role nobody thought of is guarded.
-- It CLAMPS rather than raises, except for a malformed ticker on insert:
-- saveAssetsToDB upserts one row at a time and only warns, so a raise loses
-- only that row, while a clamp keeps the batch.
--
-- BACKFILL: a row for EVERY user currently holding a ticker that carries one of
-- the two choices — from positions AND the transaction ledger, since a holding
-- can exist in only one. Nobody can know who originally set them, so this keeps
-- exactly today's behaviour. It runs only while user_asset_prefs is still empty,
-- so pasting this file again later cannot re-copy the old shared values into new
-- holders' private rows.
--
-- ORDER, and it matters:
--   1. Run the PRE-FLIGHT queries at the foot of this file. Stop on any surprise.
--   2. Take the backup it names.
--   3. Run this file.
--   4. Merge the client within minutes. Until then the OLD client's choices
--      (keep at cost, re-enable pricing, learned remaps) are discarded by the
--      trigger without an error — nothing stored is lost, but a remap made in
--      that window is re-searched on each refresh.
--   NEVER merge the client first: it reads only the new table, so without it
--   every kept-at-cost holding gets priced and every remap is dropped, and those
--   figures are written into snapshots.
--
-- Rollback: supabase/maintenance/rollback-20260921-per-user-asset-prefs.sql
-- (revert the client FIRST).

BEGIN;

SET LOCAL lock_timeout = '3s';

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
-- Only while the table is empty: a later re-run must not revive shared values.
-- Empty or overlong pricing tickers are dropped rather than aborting the file.
-- Where two catalogue rows differ only by case, the canonical upper-case row wins.
INSERT INTO public.user_asset_prefs (user_id, ticker, untracked, pricing_ticker)
SELECT DISTINCT ON (h.user_id, upper(a.ticker))
       h.user_id,
       upper(a.ticker),
       coalesce(a.untracked, false),
       CASE WHEN length(btrim(a.pricing_ticker)) BETWEEN 1 AND 40 THEN btrim(a.pricing_ticker) END
FROM public.assets a
JOIN (
    SELECT user_id, upper(symbol) AS sym FROM public.positions
    UNION
    SELECT user_id, upper(symbol) AS sym FROM public.transactions
) h ON h.sym = upper(a.ticker)
WHERE length(a.ticker) BETWEEN 1 AND 40
  AND (coalesce(a.untracked, false)
       OR length(btrim(a.pricing_ticker)) BETWEEN 1 AND 40)
  AND NOT EXISTS (SELECT 1 FROM public.user_asset_prefs)
ORDER BY h.user_id, upper(a.ticker), (a.ticker = upper(a.ticker)) DESC
ON CONFLICT (user_id, ticker) DO NOTHING;

-- ── One ISIN, one catalogue row ─────────────────────────────────────────────
-- Stops a second row claiming an ISIN that is already mapped. Created only if
-- the catalogue has no duplicates today; if it has, the index is skipped (the
-- pre-flight lists them) rather than aborting the file.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.assets WHERE isin IS NOT NULL
        GROUP BY isin HAVING count(*) > 1
    ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS assets_isin_unique
            ON public.assets (isin) WHERE isin IS NOT NULL;
    ELSE
        RAISE NOTICE 'assets_isin_unique NOT created: duplicate ISINs exist (see pre-flight D).';
    END IF;
END $$;

-- ── What a browser may change in the shared catalogue ───────────────────────
CREATE OR REPLACE FUNCTION public.assets_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    incoming public.assets;
    -- POSIX class, not a unicode escape: a plain SQL string does not interpret
    -- those, and typing them literally puts real control bytes in the file.
    ctrl CONSTANT text := '[[:cntrl:]]';
    currency_ok CONSTANT text := '^([A-Z]{3}|GBp|GBX|ZAc|ZAC|ILA)$';
    isin_ok     CONSTANT text := '^[A-Z]{2}[A-Z0-9]{9}[0-9]$';
    ticker_ok   CONSTANT text := '^[A-Z0-9][A-Z0-9.=^:_-]{0,39}$';
BEGIN
    -- The server's own roles write freely, so a bad value stays repairable.
    IF current_user IN ('postgres', 'service_role', 'supabase_admin') THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.ticker IS NULL OR NEW.ticker !~ ticker_ok THEN
            RAISE EXCEPTION 'assets: malformed ticker %', left(coalesce(NEW.ticker, '(null)'), 40)
                USING ERRCODE = '22023';
        END IF;
        -- Personal choices never live here.
        NEW.untracked      := false;
        NEW.pricing_ticker := NULL;
        NEW.name           := left(regexp_replace(coalesce(NEW.name, ''), ctrl, '', 'g'), 200);
        NEW.sector         := left(regexp_replace(coalesce(NEW.sector, ''), ctrl, '', 'g'), 80);
        NEW.stock_exchange := left(regexp_replace(coalesce(NEW.stock_exchange, ''), ctrl, '', 'g'), 80);
        NEW.asset_type     := left(regexp_replace(coalesce(NEW.asset_type, ''), ctrl, '', 'g'), 40);
        IF NEW.isin IS NOT NULL AND upper(btrim(NEW.isin)) ~ isin_ok THEN
            NEW.isin := upper(btrim(NEW.isin));
        ELSE
            NEW.isin := NULL;
        END IF;
        IF NEW.currency IS NULL OR NEW.currency !~ currency_ok THEN
            NEW.currency := '';
            NEW.currency_source := NULL;
        ELSIF NEW.currency_source IS NOT NULL AND NEW.currency_source NOT IN ('suffix', 'profile', 'quote') THEN
            -- 'user' is the rank nothing can overwrite; a browser may not claim it.
            NEW.currency_source := 'profile';
        END IF;
        IF NEW.source IS NOT NULL AND NEW.source NOT IN ('api', 'user') THEN
            NEW.source := NULL;
        END IF;
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    -- UPDATE: start from what is stored; copy across only permitted, changed fields.
    incoming := NEW;
    NEW := OLD;

    IF incoming.name IS DISTINCT FROM OLD.name THEN
        NEW.name := left(regexp_replace(coalesce(incoming.name, ''), ctrl, '', 'g'), 200);
    END IF;
    IF incoming.sector IS DISTINCT FROM OLD.sector THEN
        NEW.sector := left(regexp_replace(coalesce(incoming.sector, ''), ctrl, '', 'g'), 80);
    END IF;
    IF incoming.stock_exchange IS DISTINCT FROM OLD.stock_exchange THEN
        NEW.stock_exchange := left(regexp_replace(coalesce(incoming.stock_exchange, ''), ctrl, '', 'g'), 80);
    END IF;
    IF incoming.asset_type IS DISTINCT FROM OLD.asset_type THEN
        NEW.asset_type := left(regexp_replace(coalesce(incoming.asset_type, ''), ctrl, '', 'g'), 40);
    END IF;

    -- An ISIN, once mapped, is fixed: the mapping is what imports trust.
    IF OLD.isin IS NULL AND incoming.isin IS NOT NULL AND upper(btrim(incoming.isin)) ~ isin_ok THEN
        NEW.isin := upper(btrim(incoming.isin));
    END IF;

    -- A currency may be improved from a suffix guess, never overwritten once a
    -- provider or quote has confirmed it, and never marked 'user' by a browser.
    IF (coalesce(OLD.currency, '') = '' OR coalesce(OLD.currency_source, 'suffix') = 'suffix')
       AND incoming.currency IS DISTINCT FROM OLD.currency
       AND incoming.currency ~ currency_ok THEN
        NEW.currency := incoming.currency;
        NEW.currency_source := CASE
            WHEN incoming.currency_source IN ('suffix', 'profile', 'quote') THEN incoming.currency_source
            ELSE 'profile' END;
    END IF;

    IF incoming.source IS DISTINCT FROM OLD.source AND incoming.source IN ('api', 'user') THEN
        NEW.source := incoming.source;
    END IF;

    NEW.updated_at := now();
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
-- PRE-FLIGHT — read-only, run BEFORE this file. Stop on any surprise.
--
-- A. Every column the trigger names exists. plpgsql only checks them when the
--    trigger fires, so a missing one would let this file succeed and then fail
--    every asset save afterwards. Expect 15 rows:
--      SELECT table_name, column_name, data_type FROM information_schema.columns
--      WHERE table_schema = 'public' AND (
--        (table_name = 'assets' AND column_name IN ('ticker','name','sector','stock_exchange',
--           'currency','currency_source','asset_type','isin','source','untracked',
--           'pricing_ticker','created_at','updated_at'))
--        OR (table_name IN ('positions','transactions') AND column_name = 'symbol'))
--      ORDER BY table_name, column_name;
--
-- B. Existing choices the backfill will copy into each holder's private row.
--    Look at every pricing_ticker: a wrong one would be copied, then private.
--      SELECT ticker, pricing_ticker, untracked FROM assets
--      WHERE coalesce(untracked, false) OR pricing_ticker IS NOT NULL ORDER BY ticker;
--
-- C. Currencies already marked 'user', or malformed (they will stay as they are;
--    fix any wrong one from the SQL editor, which the trigger lets through):
--      SELECT ticker, currency, currency_source FROM assets
--      WHERE currency_source = 'user'
--         OR (coalesce(currency, '') <> '' AND currency !~ '^([A-Z]{3}|GBp|GBX|ZAc|ZAC|ILA)$');
--
-- D. Duplicate ISINs (if any, the unique index is skipped until you resolve them):
--      SELECT isin, array_agg(ticker) FROM assets WHERE isin IS NOT NULL
--      GROUP BY isin HAVING count(*) > 1;
--
-- E. BACKUP, then run this file:
--      CREATE TABLE assets_bak_20260921 AS SELECT * FROM assets;
--      ALTER TABLE assets_bak_20260921 ENABLE ROW LEVEL SECURITY;
--
-- AFTER, read-only:
--   1. The backfill covered the holders:
--        SELECT count(*) FROM user_asset_prefs;
--   2. The browser path, as a signed-in role, in a transaction that is rolled
--      back: it must SUCCEED (a missing column would fail here) and leave
--      untracked / pricing_ticker as they were:
--        BEGIN;
--        SET LOCAL ROLE authenticated;
--        SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
--        INSERT INTO assets (ticker, name, untracked, pricing_ticker)
--          VALUES ('AAPL', 'Apple', true, 'PENNY')
--          ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name,
--             untracked = EXCLUDED.untracked, pricing_ticker = EXCLUDED.pricing_ticker;
--        SELECT ticker, name, untracked, pricing_ticker FROM assets WHERE ticker = 'AAPL';
--        ROLLBACK;
-- ════════════════════════════════════════════════════════════════════════════

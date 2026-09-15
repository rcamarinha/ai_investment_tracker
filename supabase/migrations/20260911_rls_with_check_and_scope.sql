-- Migration: close two cross-user reads. Plus audit hygiene on UPDATE policies.
--
-- Written against the LIVE policy set, read out of pg_policies on 2026-09-11,
-- not against the .sql files in this repo — they are a proposal, not a record,
-- because migrations are run by hand. Two things differed from the repo:
--
--   1. price_history's SELECT policy is `USING (true)`, not
--      `auth.role() = 'authenticated'`. Migration 20260217 fixed that table's
--      INSERT policy and left its SELECT policy alone, so the policy NAME still
--      says "readable by all authenticated users" while the CONDITION says
--      everyone. An anonymous probe returned no rows, so it appears to be role-
--      scoped in practice — but a policy whose name and condition disagree is
--      one dashboard edit from being wrong.
--
--   2. `transactions` has NO UPDATE policy in production, though the schema
--      file claims one. Nothing to add: the ledger save path is delete-then-
--      insert, so it never needed UPDATE. Left alone deliberately.
--
-- READ THIS BEFORE ASSUMING SECTION 2 IS A SECURITY FIX. It is not.
-- An earlier draft of this migration claimed that an UPDATE policy with only
-- USING leaves the NEW row unconstrained, so a user could reassign a row they
-- own to another user_id. That is FALSE. From the PostgreSQL CREATE POLICY
-- documentation: "For policies that can have both USING and WITH CHECK
-- expressions (ALL and UPDATE), if no WITH CHECK expression is defined, then
-- the USING expression will be used both to determine which rows are visible
-- (normal USING case) and which new rows will be allowed to be added
-- (WITH CHECK case)."
--
-- So `pg_policies.with_check` reads NULL because the catalog stores no SEPARATE
-- expression, not because no check is applied. Those rows were already safe.
-- Section 2 is kept for two honest reasons and no others:
--   (a) it makes the intent explicit, so a future edit that loosens USING does
--       not silently loosen the write side with it;
--   (b) it empties the audit query that found this class
--       (cmd='UPDATE' AND with_check IS NULL), so the next audit has no false
--       positives to wade through.
-- If you want the behaviour proven rather than argued, run the pre-flight
-- check at the bottom from a second account BEFORE running this file.

BEGIN;
-- Policy changes take ACCESS EXCLUSIVE. Fail fast rather than queue every
-- query on the table behind a waiting DDL lock.
SET LOCAL lock_timeout = '5s';

-- ── 1. Cross-user reads. THIS is the actual fix. ────────────────────────────
-- Both tables carry user_id beside the ticker or the bottle, so a shared read
-- is not a price cache — it is an inventory of who owns what.
--
-- No client path breaks. loadLatestPricesFromDB already filters by user_id and
-- bounds the read (services/storage.js). loadPriceHistoryForAsset is unscoped
-- but has zero callers. wine_price_history is WRITE-ONLY in the client: nothing
-- anywhere reads it, so scoping it is a no-op for the app today and closes the
-- leak ahead of the wine extraction.
--
-- Each DROP names the policy it is about to CREATE, so this file can be re-run.
-- That is the house pattern (see 20260901_app_errors.sql) and the previous
-- draft of this file got it wrong — it dropped only the OLD names, so a second
-- run aborted with 42710.

DROP POLICY IF EXISTS "Price history is readable by all authenticated users" ON public.price_history;
DROP POLICY IF EXISTS "Authenticated users can view price history"           ON public.price_history;
DROP POLICY IF EXISTS "Users can view own price history"                     ON public.price_history;
CREATE POLICY "Users can view own price history"
    ON public.price_history FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Authenticated users can view wine price history" ON public.wine_price_history;
DROP POLICY IF EXISTS "Users can view own wine price history"           ON public.wine_price_history;
CREATE POLICY "Users can view own wine price history"
    ON public.wine_price_history FOR SELECT
    USING (auth.uid() = user_id);

-- NOTE on legacy rows: 20260217 left price_history.user_id NULLABLE and its
-- backfill commented out, so some rows may have user_id IS NULL. They become
-- invisible here. That costs nothing in practice — the client has not read them
-- since it started filtering by user_id, and the table is a refetchable cache.
-- Count them with the pre-flight query at the bottom. There is no DELETE policy
-- on this table, so cleaning them up is a SQL-Editor job, and it is deliberately
-- NOT coupled to this migration: they are the only thing here a re-run cannot
-- recreate. Do not SET NOT NULL until they are gone.

-- ── 2. Explicit WITH CHECK on UPDATE policies (documentation, not a fix) ────
-- See the header. Postgres already applies USING to the new row. This only
-- makes it explicit and clears the audit query.

DO $$
DECLARE
    t TEXT;
    owner_scoped TEXT[] := ARRAY[
        'positions', 'bank_holdings', 'user_wines',
        'spend_accounts', 'spend_bank_profiles', 'spend_categories',
        'spend_pending_details', 'spend_recurring', 'spend_rules',
        'spend_scenarios', 'spend_transactions'
    ];
BEGIN
    FOREACH t IN ARRAY owner_scoped LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t
        ) THEN
            RAISE WARNING 'skipping %, not present in public schema', t;
            CONTINUE;
        END IF;

        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Users can update own ' || t, t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)',
            'Users can update own ' || t, t
        );
    END LOOP;
END $$;

-- wine_bottles_backup_v1 predates the naming convention: its policy is called
-- "Users can update own wine bottles". Handled separately rather than inside
-- the loop, because DROP POLICY drops by NAME regardless of command type, and
-- running that drop against eleven other tables is a way to remove a policy
-- nobody meant to touch. This table is a backup from the 2026-02 wine
-- restructure; it is in no schema file but it is in production, holding a copy
-- of cellar data, with RLS on and owner-scoped policies.
--
-- Guarded on the TABLE, not only the policy. `DROP POLICY IF EXISTS ... ON t`
-- guards the policy name; if table t itself is absent it still errors. An
-- earlier draft ran these three statements bare, so on any project without
-- this backup table — a fresh build, or the new project the wine launch
-- contemplates — the file failed, and because it is one transaction the
-- price-history scoping above rolled back with it. The security fix would have
-- silently not applied. Found by tests/migrations.test.js on its first run.
-- EXECUTE, so no statement references the table until it is known to exist.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'wine_bottles_backup_v1'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "Users can update own wine bottles" ON public.wine_bottles_backup_v1';
        EXECUTE 'DROP POLICY IF EXISTS "Users can update own wine_bottles_backup_v1" ON public.wine_bottles_backup_v1';
        EXECUTE 'CREATE POLICY "Users can update own wine_bottles_backup_v1" '
             || 'ON public.wine_bottles_backup_v1 FOR UPDATE '
             || 'USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)';
    END IF;
END $$;

-- ── 3. assets ───────────────────────────────────────────────────────────────
-- The catalogue stays SHARED on purpose. Scoping its reads would cost a new
-- user the first tier of identifier resolution; scoping its writes would fail
-- silently for most rows, because most tickers a second user holds already
-- exist. Both were considered and rejected.
--
-- This change is a NO-OP in effect: assets has no owner column, so USING and
-- WITH CHECK are the same row-independent predicate. Included only so the
-- with_check-is-null audit comes back empty.
--
-- The REAL assets exposure is content integrity — any authenticated user can
-- rewrite `currency` or `pricing_ticker` on a shared row, and a wrong currency
-- silently moves another user's totals through money-core. That needs a
-- BEFORE INSERT OR UPDATE trigger and is a later phase, not this one.

DROP POLICY IF EXISTS "Authenticated users can update assets" ON public.assets;
CREATE POLICY "Authenticated users can update assets"
    ON public.assets FOR UPDATE
    USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- PRE-FLIGHT (run BEFORE this file, in the SQL Editor)
--
--   -- 1. How many price rows have no owner? They go invisible above.
--   SELECT count(*) FILTER (WHERE user_id IS NULL) AS orphaned,
--          count(*) AS total FROM price_history;
--
--   -- 2. Informational only, no longer a reason to stop. The backup-table
--   --    block drops its policy ON that table alone, so a same-named policy
--   --    on any other table is never touched.
--   SELECT tablename, policyname, cmd FROM pg_policies
--   WHERE policyname = 'Users can update own wine bottles';
--
--   -- 3. Row counts, to prove afterwards that nothing was lost.
--   SELECT 'price_history' t, count(*) n FROM price_history
--   UNION ALL SELECT 'wine_price_history', count(*) FROM wine_price_history
--   UNION ALL SELECT 'positions',          count(*) FROM positions
--   UNION ALL SELECT 'spend_transactions', count(*) FROM spend_transactions
--   UNION ALL SELECT 'user_wines',         count(*) FROM user_wines
--   UNION ALL SELECT 'transactions',       count(*) FROM transactions
--   UNION ALL SELECT 'bank_holdings',      count(*) FROM bank_holdings;
--
-- AFTER (SQL Editor): re-run pre-flight #3 — every number must be identical.
--   SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
--   WHERE schemaname = 'public'
--     AND (tablename IN ('price_history','wine_price_history') OR cmd = 'UPDATE')
--   ORDER BY tablename, cmd;
--
-- AFTER, OPTIONAL: check the scoping as a signed-in user. Not in the SQL
-- Editor: it runs as `postgres`, the table owner, and bypasses row security, so
-- any count there shows every row and looks like the migration failed. And not
-- as SQL in the browser console: the console runs JavaScript. An earlier
-- version of this comment listed SQL beneath a mention of the console, and SQL
-- pasted there fails with a syntax error. Signed in, on the portfolio page, in
-- the browser console:
--
--   const s = (await import('/services/state.js')).default;
--   const r = await s.supabaseClient.from('price_history').select('user_id');
--   r.data.filter(x => x.user_id !== s.currentUser.id).length   // expect 0
--
-- Expect 0: no row owned by anyone else, and no row with no owner. This only
-- tells before from after if the table holds rows that are not yours. On a
-- project with one user, the pg_policies query above is the proof.
--
-- Then, as yourself, open portfolio.html and confirm the console still logs the
-- same number of cached prices loaded as before. That is the one user-visible
-- path through price_history and the only thing section 1 could have broken.
-- ════════════════════════════════════════════════════════════════════════════

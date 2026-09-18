-- Migration: an administrator's view of who uses the app, and which parts.
--
-- The admin page shows signups, active accounts and per-tool adoption. Nothing
-- a signed-in user can reach today answers that: every table is scoped to its
-- owner, and auth.users is not readable at all. So this is a function that
-- checks the caller is in admin_users and then reads across accounts.
--
-- It is a function and not a policy on purpose. An "admins may read every row"
-- policy would be permanent, invisible at every call site, and would widen what
-- an admin's session can fetch from every table — including every amount. This
-- widens nothing: it returns one fixed shape, and the shape is the contract.
--
-- THE RULE, for whoever edits this next:
--   1. It takes no parameters. The moment it accepts a user id it is a backdoor
--      into one person's data with an admin check in front of it.
--   2. It never returns an amount — no value, price, balance, cost or quantity
--      of money. Counts of rows and timestamps only. The per-tool "items" is a
--      COUNT of rows, never a sum of anything.
--   tests/admin-usage-report-db.test.js asserts both.
--
-- SECURITY DEFINER because it must read auth.users and other people's rows;
-- that is exactly why the admin check comes first and raises rather than
-- returning an empty report, and why every object is schema-qualified with
-- search_path pinned to pg_catalog, pg_temp — the form the Postgres docs give
-- for SECURITY DEFINER functions. pg_temp goes LAST so a temporary object can
-- never shadow a real one; an empty search_path would search pg_temp first for
-- types. A definer function that resolves names through a caller-controlled
-- search_path can be made to run someone else's code.
--
-- It relies on the owner (postgres, when run from the SQL Editor) bypassing
-- row-level security on the tables it reads. If it did not, the report would
-- fail CLOSED — every other account would show zero — not leak. The pre-flight
-- below checks this, because the test harness runs as a superuser and cannot.
--
-- Safe to run before the page change: nothing calls it until the admin page
-- does, and the page says "run the migration" if the function is missing.
-- Re-runnable: CREATE OR REPLACE, and grants are idempotent.
-- Rollback: supabase/maintenance/rollback-20260918-admin-usage-report.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.admin_usage_report()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    caller uuid        := auth.uid();
    since  timestamptz := now() - interval '30 days';
    report jsonb;
BEGIN
    IF caller IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = caller) THEN
        RAISE EXCEPTION 'admin_usage_report: administrators only'
            USING ERRCODE = '42501';
    END IF;

    -- Every account's activity, per request: never worth caching anywhere.
    PERFORM set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);

    SELECT jsonb_build_object(
        'generated_at', now(),
        'people', coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at), '[]'::jsonb)
    )
    INTO report
    FROM (
        SELECT
            u.id,
            u.email,
            u.created_at,
            u.last_sign_in_at,
            u.invited_at,
            u.email_confirmed_at AS confirmed_at,
            jsonb_build_object(
                -- A snapshot is written whenever prices refresh, so it records
                -- someone opening the portfolio, not only importing into it.
                --
                -- asset_movements is split by its own asset_type: it is a log of
                -- wine and stock movements only (its CHECK allows nothing else),
                -- written by the cellar pages. It is NOT bank activity, which is
                -- where the first draft wrongly counted it.
                'stocks', jsonb_build_object(
                    'items', (SELECT count(*) FROM public.positions x WHERE x.user_id = u.id),
                    'last',  greatest(
                        (SELECT max(x.created_at) FROM public.transactions    x WHERE x.user_id = u.id),
                        (SELECT max(x.created_at) FROM public.snapshots       x WHERE x.user_id = u.id),
                        (SELECT max(x.updated_at) FROM public.positions       x WHERE x.user_id = u.id),
                        (SELECT max(x.created_at) FROM public.asset_movements x
                          WHERE x.user_id = u.id AND x.asset_type = 'stock'))),
                'wine', jsonb_build_object(
                    'items', (SELECT count(*) FROM public.user_wines x WHERE x.user_id = u.id),
                    'last',  greatest(
                        (SELECT max(x.updated_at) FROM public.user_wines      x WHERE x.user_id = u.id),
                        (SELECT max(x.created_at) FROM public.user_wines      x WHERE x.user_id = u.id),
                        (SELECT max(x.created_at) FROM public.wine_snapshots  x WHERE x.user_id = u.id),
                        (SELECT max(x.created_at) FROM public.asset_movements x
                          WHERE x.user_id = u.id AND x.asset_type = 'wine'))),
                'spend', jsonb_build_object(
                    'items', (SELECT count(*) FROM public.spend_transactions x WHERE x.user_id = u.id),
                    'last',  (SELECT max(x.created_at) FROM public.spend_transactions x WHERE x.user_id = u.id)),
                'bank', jsonb_build_object(
                    'items', (SELECT count(*) FROM public.bank_holdings x WHERE x.user_id = u.id),
                    'last',  greatest(
                        (SELECT max(x.updated_at) FROM public.bank_holdings x WHERE x.user_id = u.id),
                        (SELECT max(x.created_at) FROM public.bank_holdings x WHERE x.user_id = u.id)))
            ) AS tools,
            -- Errors and handled failures, and separately the diagnostics that
            -- imports and valuations write when they run. Counts only: the
            -- messages themselves stay where they are.
            (SELECT count(*) FROM public.app_errors x
              WHERE x.user_id = u.id AND x.created_at >= since AND x.kind <> 'diagnostic') AS problems_30d,
            (SELECT count(*) FROM public.app_errors x
              WHERE x.user_id = u.id AND x.created_at >= since AND x.kind =  'diagnostic') AS operations_30d,
            (SELECT max(x.created_at) FROM public.app_errors x WHERE x.user_id = u.id)     AS last_report_at
        FROM auth.users u
    ) p;

    RETURN report;
END;
$$;

-- Functions are executable by PUBLIC by default. The anonymous role must not
-- reach this at all; a signed-in non-admin reaches it and is refused inside.
REVOKE ALL ON FUNCTION public.admin_usage_report() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_usage_report() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_usage_report() TO authenticated;

COMMIT;

-- Tell PostgREST the function exists now, so the admin page does not keep
-- seeing "function not found" until its schema cache notices on its own.
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- PRE-FLIGHT, read-only. Run BEFORE the migration.
--
-- 1. Every column the function reads exists in production, with the type it
--    assumes. plpgsql does not check table references at CREATE time, so a
--    missing one would surface only as an error on the admin page. Expect every
--    row to say ok:
--
--   WITH expected(rel, col) AS (VALUES
--     ('public.admin_users','user_id'),
--     ('public.positions','user_id'),('public.positions','updated_at'),
--     ('public.transactions','user_id'),('public.transactions','created_at'),
--     ('public.snapshots','user_id'),('public.snapshots','created_at'),
--     ('public.user_wines','user_id'),('public.user_wines','created_at'),('public.user_wines','updated_at'),
--     ('public.wine_snapshots','user_id'),('public.wine_snapshots','created_at'),
--     ('public.spend_transactions','user_id'),('public.spend_transactions','created_at'),
--     ('public.bank_holdings','user_id'),('public.bank_holdings','created_at'),('public.bank_holdings','updated_at'),
--     ('public.asset_movements','user_id'),('public.asset_movements','created_at'),('public.asset_movements','asset_type'),
--     ('public.app_errors','user_id'),('public.app_errors','created_at'),('public.app_errors','kind'),
--     ('auth.users','id'),('auth.users','email'),('auth.users','created_at'),
--     ('auth.users','last_sign_in_at'),('auth.users','invited_at'),('auth.users','email_confirmed_at'))
--   SELECT e.rel || '.' || e.col AS ref, format_type(a.atttypid, a.atttypmod) AS type,
--     CASE WHEN to_regclass(e.rel) IS NULL THEN 'TABLE MISSING'
--          WHEN a.attname IS NULL THEN 'COLUMN MISSING'
--          WHEN e.col IN ('id','user_id') AND a.atttypid <> 'uuid'::regtype THEN 'NOT UUID'
--          WHEN e.col LIKE '%\_at' AND a.atttypid <> 'timestamptz'::regtype THEN 'NOT TIMESTAMPTZ'
--          ELSE 'ok' END AS status
--   FROM expected e
--   LEFT JOIN pg_attribute a ON a.attrelid = to_regclass(e.rel) AND a.attname = e.col
--                           AND a.attnum > 0 AND NOT a.attisdropped
--   ORDER BY (a.attname IS NOT NULL), ref;
--
-- 2. The owner will see every account's rows. Expect postgres to own each
--    table (or rolbypassrls = true) and relforcerowsecurity = false throughout:
--
--   SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'postgres';
--   SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relforcerowsecurity
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public' AND c.relname IN ('admin_users','positions','transactions',
--     'snapshots','user_wines','wine_snapshots','spend_transactions','bank_holdings',
--     'asset_movements','app_errors');
--
-- RUN THE WHOLE FILE. The SQL Editor runs only the selected text when there is
-- a selection; running the CREATE alone would commit the function before the
-- REVOKE that keeps the anonymous role out.
--
-- AFTER, read-only:
--
-- 3. One function, owned by postgres, SECURITY DEFINER, no arguments, and the
--    anonymous role cannot execute it (expect false, true):
--
--   SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig
--   FROM pg_proc p WHERE p.proname = 'admin_usage_report';
--   SELECT has_function_privilege('anon', 'public.admin_usage_report()', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.admin_usage_report()', 'EXECUTE');
--
-- 4. Call it as a real signed-in user would, inside a transaction that is
--    rolled back. With a NON-admin id expect ERROR 42501; with your own id
--    expect other people's "items" to be non-zero. If every other account
--    shows zero, the owner is subject to row-level security — see pre-flight 2.
--
--   BEGIN;
--   SELECT set_config('request.jwt.claims',
--          json_build_object('sub', '<user uuid>', 'role', 'authenticated')::text, true);
--   SELECT set_config('request.jwt.claim.sub', '<user uuid>', true);  -- older auth.uid() reads this
--   SET LOCAL ROLE authenticated;
--   SELECT public.admin_usage_report();
--   ROLLBACK;
-- ════════════════════════════════════════════════════════════════════════════

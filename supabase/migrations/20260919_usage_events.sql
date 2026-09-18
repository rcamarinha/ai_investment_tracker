-- Migration: count what the server functions spend, per person.
--
-- Plan P5, "count, do not enforce". The AI functions and the quote proxy run
-- on shared keys, so every call costs the owner, and until now nothing
-- recorded who made it. This adds one row per upstream call — which person,
-- which function, which provider and model, whether it succeeded, and the
-- tokens it used — and an admin-only report over the last 30 days.
--
-- It records; it does not limit. Nothing reads this table to refuse a request.
-- Enforcing a quota is a later, separate decision.
--
-- WHO WRITES: only the edge functions, through the service role, via
-- supabase/functions/_shared/usage.ts. There is no insert policy and the API
-- roles have no write privilege, so a user cannot forge, inflate or erase their
-- own usage from the browser. (The service role bypasses row-level security.)
-- WHO READS: each person can read their own rows; the admin reads everyone's
-- only through admin_ai_usage_report(), which follows the same two rules as
-- admin_usage_report(): no parameters, and no amount. Tokens are counts;
-- turning them into money happens on the admin page, from a price table.
--
-- ORDER: run this BEFORE deploying the updated functions. If a function is
-- deployed first, its writes fail — and are only logged, never surfaced to the
-- user, because recording usage must never break the call it records.
--
-- NO FOREIGN KEY TO auth.users, deliberately. This is a record of money spent,
-- and it must outlive the account that spent it: with ON DELETE CASCADE,
-- removing a stranger who ran up costs would also erase the evidence of it,
-- and the test-account cleanup would delete an AI-only account's usage along
-- with the account. The only writer is the service role, using the id
-- auth.getUser just verified, so the key would protect very little. Leaving it
-- out also means neither this file nor its rollback locks auth.users.
-- Decided before the first run on purpose: CREATE TABLE IF NOT EXISTS cannot
-- change it afterwards; that would need its own ALTER migration.
--
-- Re-runnable: IF NOT EXISTS, DROP POLICY IF EXISTS, CREATE OR REPLACE.
-- Rollback: supabase/maintenance/rollback-20260919-usage-events.sql
-- (it deletes the recorded usage).

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.usage_events (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        UUID NOT NULL,                                          -- no FK: see header
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    fn             TEXT NOT NULL CHECK (length(fn) BETWEEN 1 AND 64),     -- edge function
    provider       TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32), -- anthropic | gemini | yahoo
    model          TEXT CHECK (model IS NULL OR length(model) <= 100),
    ok             BOOLEAN NOT NULL DEFAULT true,
    input_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens  >= 0),
    output_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    units          INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0)          -- non-token work, e.g. symbols quoted
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON public.usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_created      ON public.usage_events (created_at DESC);

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own usage" ON public.usage_events;
CREATE POLICY "Users can read own usage"
    ON public.usage_events FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Row security alone already refuses writes (no policy permits one). Revoking
-- the privileges as well means a policy added carelessly later still cannot
-- open the table to the browser.
REVOKE ALL ON public.usage_events FROM anon;
REVOKE ALL ON public.usage_events FROM authenticated;
GRANT SELECT ON public.usage_events TO authenticated;
REVOKE ALL ON SEQUENCE public.usage_events_id_seq FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_ai_usage_report()
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
        RAISE EXCEPTION 'admin_ai_usage_report: administrators only'
            USING ERRCODE = '42501';
    END IF;

    PERFORM set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);

    SELECT jsonb_build_object(
        'generated_at', now(),
        'since', since,
        'rows', coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.user_id, r.fn, r.model), '[]'::jsonb)
    )
    INTO report
    FROM (
        SELECT
            e.user_id,
            e.fn,
            e.provider,
            e.model,
            count(*)                                 AS calls,
            count(*) FILTER (WHERE NOT e.ok)         AS failures,
            coalesce(sum(e.input_tokens), 0)::bigint AS input_tokens,
            coalesce(sum(e.output_tokens), 0)::bigint AS output_tokens,
            coalesce(sum(e.units), 0)::bigint        AS units,
            max(e.created_at)                        AS last_at
        FROM public.usage_events e
        WHERE e.created_at >= since
        GROUP BY e.user_id, e.fn, e.provider, e.model
    ) r;

    RETURN report;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_ai_usage_report() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_ai_usage_report() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_ai_usage_report() TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- RUN THE WHOLE FILE, with nothing selected in the SQL Editor.
--
-- AFTER, read-only:
--   1. The table exists and the browser roles cannot write to it
--      (expect false, false, true):
--        SELECT has_table_privilege('authenticated', 'public.usage_events', 'INSERT'),
--               has_table_privilege('anon',          'public.usage_events', 'SELECT'),
--               has_table_privilege('authenticated', 'public.usage_events', 'SELECT');
--   2. The report function exists and anon cannot call it (expect false):
--        SELECT has_function_privilege('anon', 'public.admin_ai_usage_report()', 'EXECUTE');
--   3. Row security is on and not forced (expect true, false), and there is no
--      foreign key to auth.users (expect zero rows):
--        SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.usage_events'::regclass;
--        SELECT conname FROM pg_constraint WHERE conrelid = 'public.usage_events'::regclass AND contype = 'f';
--   4. The report as you, inside a transaction that is rolled back — expect a
--      report (empty "rows" until the functions are redeployed). With a
--      non-admin id instead, expect ERROR 42501:
--        BEGIN;
--        SELECT set_config('request.jwt.claims', json_build_object('sub', '<your user id>', 'role', 'authenticated')::text, true);
--        SELECT set_config('request.jwt.claim.sub', '<your user id>', true);
--        SET LOCAL ROLE authenticated;
--        SELECT public.admin_ai_usage_report();
--        ROLLBACK;
--   5. After the functions are redeployed and someone runs an analysis:
--        SELECT created_at, fn, provider, model, ok, input_tokens, output_tokens, units
--        FROM usage_events ORDER BY created_at DESC LIMIT 10;
-- ════════════════════════════════════════════════════════════════════════════

-- Migration: make the trade ledger save ATOMIC.
--
-- saveTransactionsToDB (services/storage.js) used to send two requests: a
-- DELETE of every row for the user, then one bulk INSERT. Postgres aborts the
-- whole INSERT on a single bad row — but the DELETE had already committed in
-- its own request. So one malformed row could leave the user with an EMPTY
-- ledger in the database. The client now reports that loudly (commit ec21d96),
-- but reporting a loss is not the same as preventing it.
--
-- This function does the delete and the insert inside ONE transaction. If any
-- row fails — a CHECK constraint, a NOT NULL, a bad date — the delete rolls
-- back with it and the ledger is exactly as it was before the save started.
--
-- SECURITY INVOKER, deliberately: row-level security applies to everything
-- this function does, exactly as it did to the two separate requests. It can
-- delete and insert only the caller's own rows. user_id is taken from
-- auth.uid() on the server and never from the payload, so the client cannot
-- write into another account even if it tried.
--
-- Safe to run before or after the client change: the client falls back to the
-- old two-request path when this function is missing (PostgREST PGRST202), and
-- nothing calls this function until the new client is live.
--
-- Re-runnable: CREATE OR REPLACE, and grants are idempotent.
--
-- DRIFT WARNING for whoever edits this next: jsonb_to_recordset silently
-- IGNORES any key it has no declared column for. A field added to the client's
-- row builder but not to the column list below is dropped on every save, with
-- no error. tests/ledger-save.test.js reads both files and fails if they
-- disagree — keep it green.

BEGIN;

CREATE OR REPLACE FUNCTION public.save_transactions(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    uid      uuid := auth.uid();
    inserted integer := 0;
BEGIN
    -- No session means no owner to scope to. Refuse rather than guess.
    IF uid IS NULL THEN
        RAISE EXCEPTION 'save_transactions: no authenticated user'
            USING ERRCODE = '42501';
    END IF;

    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'save_transactions: p_rows must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    DELETE FROM public.transactions WHERE user_id = uid;

    INSERT INTO public.transactions (
        user_id, symbol, type, shares, price, total_amount, date,
        cost_basis, realized_gain_loss, currency, exchange_rate, fx_rates,
        fee, tax, ratio, note
    )
    SELECT
        uid, r.symbol, r.type, r.shares, r.price, r.total_amount, r.date,
        r.cost_basis, r.realized_gain_loss, r.currency, r.exchange_rate, r.fx_rates,
        r.fee, r.tax, r.ratio, r.note
    FROM jsonb_to_recordset(p_rows) AS r(
        symbol text,
        type text,
        shares numeric,
        price numeric,
        total_amount numeric,
        date date,
        cost_basis numeric,
        realized_gain_loss numeric,
        currency text,
        exchange_rate numeric,
        fx_rates jsonb,
        fee numeric,
        tax numeric,
        ratio numeric,
        note text
    );

    GET DIAGNOSTICS inserted = ROW_COUNT;
    RETURN inserted;
END;
$$;

-- Functions are executable by PUBLIC by default. Only a signed-in user needs
-- this, and the function refuses a null auth.uid() anyway — this just keeps the
-- anonymous role from reaching it at all.
REVOKE ALL ON FUNCTION public.save_transactions(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_transactions(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_transactions(jsonb) TO authenticated;

COMMIT;

-- Tell PostgREST the function exists now, rather than waiting for its schema
-- cache to notice. Without this the client can keep seeing PGRST202 (function
-- not found) for a while and quietly stay on the non-atomic fallback.
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- PRE-FLIGHT, in the SQL Editor:
--   SELECT count(*) FROM transactions;   -- note the number
--
-- AFTER, in the SQL Editor — the function exists and is not callable by anon:
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'save_transactions';
--     -> one row, prosecdef = false  (false means SECURITY INVOKER)
--   SELECT has_function_privilege('anon', 'public.save_transactions(jsonb)', 'EXECUTE');
--     -> false
--
-- AFTER, in the app — see the verification steps given with this migration.
-- Do NOT test it from the SQL Editor: the editor has no auth.uid(), so the
-- function refuses to run there by design.
-- ════════════════════════════════════════════════════════════════════════════

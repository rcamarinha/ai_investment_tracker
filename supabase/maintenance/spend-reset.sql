-- ============================================================================
-- spend-reset.sql — clear imported Spend data so a statement can be re-imported
--                   from scratch.
--
-- NOT a migration. It lives outside supabase/migrations/ deliberately: nothing
-- here should ever run as part of a deploy.
--
-- Run it in the Supabase SQL editor. STEP 1 only reads; STEP 2 deletes.
--
-- Scoped to ONE user by email. The SQL editor runs as the service role, so
-- auth.uid() is null there and RLS is not in force — the user_id filter in
-- every statement below is the ONLY thing keeping this off other people's data.
-- Do not remove it, and do not "simplify" it to a bare DELETE.
--
-- bank_holdings is never touched: it is the Holdings module, entered by hand,
-- and re-typing it is not part of testing an import.
-- ============================================================================


-- ── STEP 1 — look before you delete ─────────────────────────────────────────
-- Read-only. Run this on its own first and check the numbers are the ones you
-- expect to lose.

SELECT
    t.label,
    t.rows
FROM (
    SELECT 1 AS ord, 'transactions'    AS label, count(*) AS rows FROM spend_transactions   WHERE user_id = (SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com')
    UNION ALL
    SELECT 2, 'pending details',  count(*) FROM spend_pending_details WHERE user_id = (SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com')
    UNION ALL
    SELECT 3, 'recurring',        count(*) FROM spend_recurring       WHERE user_id = (SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com')
    UNION ALL
    SELECT 4, 'bank profiles',    count(*) FROM spend_bank_profiles   WHERE user_id = (SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com')
    UNION ALL
    SELECT 5, 'rules',            count(*) FROM spend_rules           WHERE user_id = (SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com')
    UNION ALL
    SELECT 6, 'accounts   (kept by default)',   count(*) FROM spend_accounts   WHERE user_id = (SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com')
    UNION ALL
    SELECT 7, 'categories (kept by default)',   count(*) FROM spend_categories WHERE user_id = (SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com')
    UNION ALL
    SELECT 8, 'scenarios  (kept by default)',   count(*) FROM spend_scenarios  WHERE user_id = (SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com')
) t
ORDER BY t.ord;


-- ── STEP 2 — delete ─────────────────────────────────────────────────────────
-- Edit the settings at the top of the block, then run the whole block.
-- It is one statement, so it either all applies or none of it does.

DO $$
DECLARE
    ---------------------------------------------------------------- settings --
    target_email    TEXT    := 'rcamarinha@gmail.com';

    -- Leave NULL to clear every account. Set it to an account LABEL (exactly as
    -- it appears in the app) to clear only that one — for re-importing a single
    -- statement without losing the other banks. When this is set, the keep_*
    -- flags below are ignored: accounts, categories, rules, profiles and
    -- scenarios are ALL preserved, because they are not account-scoped.
    -- Recurring entries are the one exception; see the note at that delete.
    only_account    TEXT    := NULL;

    -- Defaults are tuned for "re-import a statement and watch categorisation
    -- run properly":
    --   profiles OFF — a learned CSV mapping would replay instead of being
    --                  re-learned, so an import bug would be replayed with it.
    --   rules    OFF — learned rules match before the AI is ever called, so
    --                  leaving them on means the AI path is not what you test.
    --   accounts, categories and scenarios ON — real configuration, tedious to
    --                  rebuild, and not what an import test exercises.
    keep_bank_profiles BOOLEAN := FALSE;
    keep_rules         BOOLEAN := FALSE;
    keep_accounts      BOOLEAN := TRUE;
    keep_categories    BOOLEAN := TRUE;
    keep_scenarios     BOOLEAN := TRUE;
    ----------------------------------------------------------------------------

    uid    UUID;
    acc_id UUID;
    n      BIGINT;
    total  BIGINT := 0;
BEGIN
    SELECT id INTO uid FROM auth.users WHERE email = target_email;
    IF uid IS NULL THEN
        RAISE EXCEPTION 'No user with email %. Nothing deleted.', target_email;
    END IF;

    IF only_account IS NOT NULL THEN
        SELECT count(*) INTO n
          FROM spend_accounts
         WHERE user_id = uid AND account_label = only_account;
        IF n = 0 THEN
            -- Falling through with a null acc_id would match "account_id IS NULL"
            -- rows and quietly delete the wrong thing.
            RAISE EXCEPTION 'No account labelled % for %. Nothing deleted.', only_account, target_email;
        ELSIF n > 1 THEN
            RAISE EXCEPTION '% accounts are labelled %. Rename one first — picking arbitrarily would delete the wrong account''s data.', n, only_account;
        END IF;
        SELECT id INTO acc_id
          FROM spend_accounts
         WHERE user_id = uid AND account_label = only_account;
        RAISE NOTICE 'Scoped to account "%" (%).', only_account, acc_id;
    END IF;

    -- Imported movements and everything derived from them. Always cleared:
    -- this is the point of the script.
    DELETE FROM spend_pending_details
     WHERE user_id = uid AND (acc_id IS NULL OR account_id = acc_id);
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE 'pending details : %', n;

    DELETE FROM spend_transactions
     WHERE user_id = uid AND (acc_id IS NULL OR account_id = acc_id);
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE 'transactions    : %', n;

    -- Not account-scoped in the schema, so a single-account run clears all of
    -- it. That is deliberate rather than sloppy: these rows are DERIVED from
    -- transactions and are rebuilt on the next detection pass, whereas leaving
    -- them would keep recurring entries whose underlying movements are gone.
    DELETE FROM spend_recurring WHERE user_id = uid;
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE 'recurring       : % (all accounts — derived data)', n;

    -- Everything past here is account-independent, so a single-account run
    -- must not touch it.
    IF acc_id IS NULL THEN
        IF NOT keep_bank_profiles THEN
            DELETE FROM spend_bank_profiles WHERE user_id = uid;
            GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
            RAISE NOTICE 'bank profiles   : %', n;
        END IF;

        IF NOT keep_rules THEN
            DELETE FROM spend_rules WHERE user_id = uid;
            GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
            RAISE NOTICE 'rules           : %', n;
        END IF;

        IF NOT keep_scenarios THEN
            DELETE FROM spend_scenarios WHERE user_id = uid;
            GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
            RAISE NOTICE 'scenarios       : %', n;
        END IF;

        -- Accounts last: spend_transactions.account_id and spend_scenarios
        -- cascade from here, so dropping accounts first would take rows with it
        -- before they were counted.
        IF NOT keep_accounts THEN
            DELETE FROM spend_accounts WHERE user_id = uid;
            GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
            RAISE NOTICE 'accounts        : %', n;
        END IF;

        -- Categories are referenced by name, not by id, so they are safe to
        -- drop at any point. Kept by default because custom ones (a child's
        -- trust fund, say) are real configuration and not import residue.
        IF NOT keep_categories THEN
            DELETE FROM spend_categories WHERE user_id = uid;
            GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
            RAISE NOTICE 'categories      : %', n;
        END IF;
    END IF;

    RAISE NOTICE '--------------------------------';
    RAISE NOTICE 'deleted % rows for %', total, target_email;
END $$;

-- ============================================================================
-- spend-clear-imports.sql — remove imported statement data, keeping anything
--                           entered by hand.
--
-- Narrower than spend-reset.sql: that one clears the module (including learned
-- profiles and rules); this one only removes transactions that came from a file.
-- Use this to re-import a statement after an import bug is fixed.
--
-- Run spend-sources.sql FIRST to see what is there and to pick a source.
--
-- NOT a migration. Never runs as part of a deploy.
--
-- The whole file is ONE statement. Paste all of it and run it — do not select
-- part of it. The semicolons inside belong to the block.
--
-- Scoped to ONE user by email. The SQL editor runs as the service role, so
-- auth.uid() is null and RLS is not in force — the user_id filter in every
-- statement below is the ONLY thing keeping this off other people's data.
--
-- WHY THIS EXISTS: re-importing a statement over old rows does not replace
-- them. Dedupe stops a row being added twice; it cannot remove a row the new
-- code no longer produces. A statement imported before card expansion wrote a
-- lump "PAG.CTA.CARTAO -725,02"; re-importing now writes the purchases that
-- replace it, and the old lump row stays — double-counting that money. Clearing
-- the previous import first is what makes the re-import correct.
-- ============================================================================

DO $$
DECLARE
    ---------------------------------------------------------------- settings --
    target_email  TEXT    := 'rcamarinha@gmail.com';

    -- NULL = every imported source. Otherwise the exact `source` value from
    -- spend-sources.sql (usually the file name) to clear just that import.
    only_source   TEXT    := NULL;

    -- NULL = every account. Otherwise an account_label, exactly as in the app.
    only_account  TEXT    := NULL;

    -- Rows you typed in yourself are not imports. Leave TRUE unless you really
    -- mean to delete hand-entered transactions too.
    keep_manual   BOOLEAN := TRUE;
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
            -- Falling through with a null acc_id would match rows whose
            -- account_id IS NULL and delete the wrong thing.
            RAISE EXCEPTION 'No account labelled % for %. Nothing deleted.', only_account, target_email;
        ELSIF n > 1 THEN
            RAISE EXCEPTION '% accounts are labelled %. Rename one first — picking arbitrarily would delete the wrong account''s data.', n, only_account;
        END IF;
        SELECT id INTO acc_id FROM spend_accounts
         WHERE user_id = uid AND account_label = only_account;
    END IF;

    IF only_source IS NOT NULL THEN
        SELECT count(*) INTO n
          FROM spend_transactions
         WHERE user_id = uid AND source = only_source;
        IF n = 0 THEN
            RAISE EXCEPTION 'No transactions with source %. Run spend-sources.sql to see the exact values. Nothing deleted.', only_source;
        END IF;
    END IF;

    -- Import artifacts: detail rows parked awaiting a matching bank movement.
    DELETE FROM spend_pending_details
     WHERE user_id = uid
       AND (acc_id IS NULL OR account_id = acc_id);
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE 'pending details : %', n;

    -- The imported movements themselves.
    --
    -- "source IS DISTINCT FROM 'manual'" rather than "<> 'manual'": <> is NULL
    -- for a NULL source, so those rows would silently survive a cleanup that
    -- claims to have removed every import. IS DISTINCT FROM treats NULL as a
    -- value, and a NULL source means "we do not know where this came from",
    -- which is not the same as "typed in by hand". spend-sources.sql shows any
    -- such rows as '(none)' so they can be checked before this runs.
    DELETE FROM spend_transactions
     WHERE user_id = uid
       AND (acc_id       IS NULL OR account_id = acc_id)
       AND (only_source  IS NULL OR source     = only_source)
       AND (NOT keep_manual OR source IS DISTINCT FROM 'manual');
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE 'transactions    : %', n;

    -- Derived from transactions and not account-scoped in the schema, so it is
    -- always cleared for the user and rebuilt by the next detection pass.
    -- Leaving it would keep recurring entries whose movements no longer exist.
    DELETE FROM spend_recurring WHERE user_id = uid;
    GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
    RAISE NOTICE 'recurring       : % (all accounts — derived data)', n;

    RAISE NOTICE '--------------------------------';
    RAISE NOTICE 'deleted % rows for %', total, target_email;
    RAISE NOTICE 'accounts, categories, rules and learned bank profiles were NOT touched.';
END $$;

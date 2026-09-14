-- ROLLBACK for migrations/20260911_rls_with_check_and_scope.sql
--
-- Restores the policy set exactly as measured in pg_policies on 2026-09-11.
-- Touches NO rows. Nothing in the forward migration is one-way: policies are
-- catalog objects, and the reverse is exact.
--
-- NEVER run this as a migration. It belongs here, beside the other operational
-- scripts, precisely so it cannot be mistaken for one.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Restore the two shared reads (this is the part that re-opens the leak —
--    only run it if the scoping actually broke something).
DROP POLICY IF EXISTS "Users can view own price history" ON public.price_history;
CREATE POLICY "Price history is readable by all authenticated users"
    ON public.price_history FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can view own wine price history" ON public.wine_price_history;
CREATE POLICY "Authenticated users can view wine price history"
    ON public.wine_price_history FOR SELECT USING (auth.role() = 'authenticated');

-- 2. Owner-scoped UPDATE policies back to USING-only.
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
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'Users can update own ' || t, t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR UPDATE USING (auth.uid() = user_id)',
            'Users can update own ' || t, t
        );
    END LOOP;
END $$;

-- 3. The backup table keeps its ORIGINAL policy name, not the generated one.
--    This is the step a naive rollback gets wrong, leaving production drifted
--    from what was measured.
--    Guarded on the table for the same reason as the forward migration: the
--    policy-level IF EXISTS does not protect against the table being absent.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'wine_bottles_backup_v1'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "Users can update own wine_bottles_backup_v1" ON public.wine_bottles_backup_v1';
        EXECUTE 'DROP POLICY IF EXISTS "Users can update own wine bottles" ON public.wine_bottles_backup_v1';
        EXECUTE 'CREATE POLICY "Users can update own wine bottles" '
             || 'ON public.wine_bottles_backup_v1 FOR UPDATE USING (auth.uid() = user_id)';
    END IF;
END $$;

-- 4. assets back to USING-only.
DROP POLICY IF EXISTS "Authenticated users can update assets" ON public.assets;
CREATE POLICY "Authenticated users can update assets"
    ON public.assets FOR UPDATE USING (auth.role() = 'authenticated');

COMMIT;

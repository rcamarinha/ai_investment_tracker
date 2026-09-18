-- Rollback for supabase/migrations/20260918_admin_usage_report.sql
--
-- Removes the admin usage report function. Nothing else depends on it: the
-- admin page shows "run the migration" when the function is missing, and no
-- data is stored by it, so nothing is lost by dropping it.
--
-- Re-runnable, and the migration re-applies cleanly afterwards
-- (tests/migrations.test.js checks both).

DROP FUNCTION IF EXISTS public.admin_usage_report();

NOTIFY pgrst, 'reload schema';

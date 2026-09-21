-- Rollback for supabase/migrations/20260921_per_user_asset_prefs.sql
--
-- ⚠ Drops every per-person "keep at cost" and learned-pricing-ticker choice
-- made since the migration ran. The shared assets columns still hold whatever
-- they held when the migration froze them, so an older client keeps working —
-- with the old behaviour, where one person's choice applies to everyone.
--
-- Export first if the choices matter:
--   COPY (SELECT * FROM user_asset_prefs) TO STDOUT WITH CSV HEADER;
--
-- Re-runnable, and the migration re-applies cleanly afterwards
-- (tests/migrations.test.js checks both).

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS assets_guard ON public.assets;
DROP FUNCTION IF EXISTS public.assets_guard();
DROP TABLE IF EXISTS public.user_asset_prefs;

COMMIT;

NOTIFY pgrst, 'reload schema';

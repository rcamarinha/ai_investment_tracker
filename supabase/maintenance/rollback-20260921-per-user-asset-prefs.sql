-- Rollback for supabase/migrations/20260921_per_user_asset_prefs.sql
--
-- REVERT THE CLIENT FIRST. The new client reads only user_asset_prefs; with the
-- table gone it would price every kept-at-cost holding and drop every learned
-- remap, and write those figures into snapshots.
--
-- ⚠ This drops every per-person "keep at cost" and learned-pricing-ticker choice
-- made since the migration ran. Keep a copy first (the SQL editor cannot COPY
-- TO STDOUT):
--   CREATE TABLE user_asset_prefs_bak AS SELECT * FROM user_asset_prefs;
--   ALTER TABLE user_asset_prefs_bak ENABLE ROW LEVEL SECURITY;
--
-- It cannot undo: values the trigger clamped, currencies it refused to
-- overwrite, or the unique ISIN index's refusals — those were the point.
--
-- Re-runnable, and the migration re-applies cleanly afterwards
-- (tests/migrations.test.js checks both).

BEGIN;
SET LOCAL lock_timeout = '3s';

DROP TRIGGER IF EXISTS assets_guard ON public.assets;
DROP FUNCTION IF EXISTS public.assets_guard();
DROP INDEX IF EXISTS public.assets_isin_unique;
DROP TABLE IF EXISTS public.user_asset_prefs;

COMMIT;

NOTIFY pgrst, 'reload schema';

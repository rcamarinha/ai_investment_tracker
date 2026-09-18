-- Rollback for supabase/migrations/20260919_usage_events.sql
--
-- ⚠ This DELETES every recorded usage event. Export first if you want them:
--     COPY (SELECT * FROM usage_events) TO STDOUT WITH CSV HEADER;   -- or the table editor's export
--
-- Safe with the functions still deployed: their usage writes start failing,
-- which they log and otherwise ignore — no user-facing request breaks. The
-- admin page shows "run the migration" for the AI panel.
--
-- Re-runnable, and the migration re-applies cleanly afterwards
-- (tests/migrations.test.js checks both).

-- One transaction, so a timeout cannot leave the function gone and the table
-- behind; and a lock timeout, so a busy table cannot hold the rollback — which
-- runs at the worst possible moment — waiting indefinitely.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.admin_ai_usage_report();
DROP TABLE IF EXISTS public.usage_events;
COMMIT;

NOTIFY pgrst, 'reload schema';

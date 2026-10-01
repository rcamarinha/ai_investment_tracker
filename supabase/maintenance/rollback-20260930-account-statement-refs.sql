-- Rollback for supabase/migrations/20260930_account_statement_refs.sql
--
-- Drops the column an account uses to recognise its own statements. What is
-- lost is the learned mapping — which references belong to which account — so
-- after a rollback the next statement from each account asks once again. No
-- transaction, account or category is touched.
--
-- Revert the client FIRST: it reads and writes statement_refs, and a page
-- writing a column that no longer exists fails the whole save of an account.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.spend_accounts DROP COLUMN IF EXISTS statement_refs;

COMMIT;

NOTIFY pgrst, 'reload schema';

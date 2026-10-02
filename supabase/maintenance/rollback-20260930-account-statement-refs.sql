-- Rollback for supabase/migrations/20260930_account_statement_refs.sql
--
-- Drops the column an account uses to recognise its own statements. What is
-- lost is the learned mapping — which IBAN or NIB belongs to which account —
-- so afterwards the next statement from each account asks once again. No
-- transaction, account or category is touched.
--
-- EXPORT FIRST. The mapping is in no other place: not in git, not derivable
-- from any API, and not rebuildable without re-reading the owner's statement
-- PDFs. Run this, save the result, and only then run the DROP below.
--
--   SELECT id, user_id, bank_name, account_label, statement_refs
--     FROM public.spend_accounts
--    WHERE statement_refs <> '{}'::text[];
--
-- Order against the client: free either way. Only rememberAccountRefs writes
-- this column, after the import is already saved and inside its own catch, so a
-- newer client on a rolled-back database simply asks which account each time
-- and records one diagnostic. Revert the client when convenient.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.spend_accounts DROP COLUMN IF EXISTS statement_refs;

COMMIT;

NOTIFY pgrst, 'reload schema';

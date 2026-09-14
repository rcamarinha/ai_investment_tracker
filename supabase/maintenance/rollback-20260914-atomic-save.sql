-- ROLLBACK for migrations/20260914_atomic_transactions_save.sql
--
-- Safe at any time once the matching client is live: saveTransactionsToDB
-- falls back to the old delete-then-insert path when this function is missing.
-- That fallback is NON-atomic, so only roll back if the function itself is the
-- problem. Touches no rows.
--
-- NEVER run this as a migration.

DROP FUNCTION IF EXISTS public.save_transactions(jsonb);
NOTIFY pgrst, 'reload schema';

-- Migration: an account remembers the references its statements print, so a
-- file can find its own account.
--
-- Importing a statement meant choosing the account from a dropdown BEFORE
-- choosing the file, and the learned layout hung off that choice. Two costs:
-- importing a folder of statements is a one-at-a-time job, and one wrong click
-- files a whole month against the wrong account, silently — the balance chain
-- still passes, because it only checks the statement against itself.
--
-- A statement already names its account: an IBAN, a NIB, or the account number
-- in the header ("CONTA BANKINTER Nº 301200073864"). None of that is new
-- information — it is in the document the owner just uploaded — and it is
-- stable month to month. The first import of a new account asks, once; after
-- that every file files itself (services/import-identity.js).
--
-- Matching is EXACT, which is why a list is stored rather than one value: a
-- statement prints several references, and a current account and its card share
-- most of their digits (301200073864 vs 3014A0073864), so "close enough" would
-- file a card statement into the current account.
--
-- Nothing is backfilled: no existing row can be given references without
-- reading someone's statements, and an absent list simply means "ask once".
-- Re-runnable, and the column is additive, so an older client ignores it.
-- Rollback: supabase/maintenance/rollback-20260930-account-statement-refs.sql

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.spend_accounts
    ADD COLUMN IF NOT EXISTS statement_refs TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.spend_accounts.statement_refs IS
    'Account references this account''s statements print (IBAN, NIB, account number), '
    'normalised to A-Z0-9. Matched EXACTLY to file a statement against its account.';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- AFTER, read-only:
--   1. The column exists and every existing account has an empty list:
--        SELECT count(*) FILTER (WHERE statement_refs = '{}') AS empty, count(*) AS total
--        FROM spend_accounts;
--   2. Row security is unchanged — an account's references are readable only by
--      its owner (expect only own-row policies):
--        SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'spend_accounts';
-- ════════════════════════════════════════════════════════════════════════════

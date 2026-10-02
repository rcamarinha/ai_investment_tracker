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
-- Only an IBAN or a NIB is learned, and matching is EXACT. A list, because a
-- statement prints both. Nothing looser: a review found that reading every long
-- number off a real statement collected the bank's company number, three branch
-- telephones and the account numbers of the card, deposit and fund printed in
-- their own sections — so the current account would have claimed the card's
-- number, and a card statement would have filed itself into the current
-- account (services/import-identity.js).
--
-- Nothing is backfilled: no existing row can be given references without
-- reading someone's statements, and an absent list simply means "ask once".
--
-- DEPLOY ORDER IS FREE, unlike 20260921. Only `rememberAccountRefs` sends this
-- column, after the transactions are already saved and inside its own catch, so
-- a client running against a database without it loses nothing and reports one
-- diagnostic: the symptom is being asked which account every time. The account
-- form and both import-time account creations never send the column at all.
-- Re-runnable, and the column is additive, so an older client ignores it.
-- Rollback: supabase/maintenance/rollback-20260930-account-statement-refs.sql

BEGIN;

SET LOCAL lock_timeout = '3s';

-- Convergent rather than one ADD COLUMN: IF NOT EXISTS checks the NAME, so a
-- column left nullable by a half-finished earlier attempt would be skipped in
-- silence, and nothing downstream would complain (the client reads a NULL as an
-- empty list). These four statements end in the same shape whatever they find.
-- On the normal path the UPDATE matches no rows and the whole thing stays a
-- metadata change: '{}' is a constant default, so no existing row is rewritten.
ALTER TABLE public.spend_accounts ADD COLUMN IF NOT EXISTS statement_refs TEXT[];
ALTER TABLE public.spend_accounts ALTER COLUMN statement_refs SET DEFAULT '{}'::text[];
UPDATE public.spend_accounts SET statement_refs = '{}'::text[] WHERE statement_refs IS NULL;
ALTER TABLE public.spend_accounts ALTER COLUMN statement_refs SET NOT NULL;

COMMENT ON COLUMN public.spend_accounts.statement_refs IS
    'The IBAN and NIB this account''s statements print, normalised to A-Z0-9. '
    'Matched EXACTLY to file a statement against its own account; nothing looser '
    'is learned, because other numbers on a statement belong to other products.';

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- AFTER, read-only:
--   1. The column exists, holds no NULL, and every existing account is empty.
--      The NULL count is the one that matters: it is how a skipped column shows.
--        SELECT count(*) AS accounts,
--               count(*) FILTER (WHERE statement_refs IS NULL)        AS nulls_must_be_zero,
--               count(*) FILTER (WHERE statement_refs = '{}'::text[]) AS empty_expect_all
--        FROM spend_accounts;
--   2. Row security is unchanged — an account's references are readable only by
--      its owner (expect only own-row policies):
--        SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'spend_accounts';
-- ════════════════════════════════════════════════════════════════════════════

-- Record how an import WENT, not only when it threw.
--
-- Every import defect found so far has been a silent wrong result: a mortgage
-- section imported as income, a card bill counted twice, a debit read as a
-- credit. None of them raised an error, so an error log was never going to show
-- any of them. What would have shown them is the quality signals the import
-- already computes and then discards — whether the statement's own balances
-- account for the rows, how much of it could be verified, how many lines were
-- read and left out.
--
-- Reuses app_errors rather than adding a table: same owner, same RLS, same
-- retention, and these belong beside the errors when someone is working out
-- what happened.
--
-- Idempotent: the constraint is dropped by name before being re-added.
ALTER TABLE app_errors DROP CONSTRAINT IF EXISTS app_errors_kind_check;

ALTER TABLE app_errors
    ADD CONSTRAINT app_errors_kind_check
    CHECK (kind IN ('error', 'rejection', 'handled', 'diagnostic'));

CREATE INDEX IF NOT EXISTS idx_app_errors_kind_created
    ON app_errors(user_id, kind, created_at DESC);

COMMENT ON COLUMN app_errors.kind IS
    'error/rejection = uncaught; handled = caught and reported; diagnostic = not a failure at all, but a record of how an operation went, so silent wrong results are visible without anyone having to notice a wrong number.';

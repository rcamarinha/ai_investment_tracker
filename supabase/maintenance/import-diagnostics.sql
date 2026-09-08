-- ============================================================================
-- import-diagnostics.sql — how recent imports actually went. READ ONLY.
--
-- The point of this is the silent case. Every import defect found so far —
-- a mortgage section imported as income, a card bill counted twice, a debit
-- read as a credit — raised no error at all, so an error log would have shown
-- nothing. What gives them away is a verdict: the statement's own balances not
-- accounting for the rows taken from it, or a document nothing could verify.
--
-- Run it and paste the result when asking someone to look at an import problem.
-- It contains counts and verdicts only: no descriptions, no merchants, no
-- amounts. `signature` identifies a statement LAYOUT, not a bank or a person.
--
-- One statement: paste the whole file and run it.
-- ============================================================================

WITH me AS (
    -- The only place the email appears. Edit it here.
    SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com'
)
SELECT
    to_char(created_at, 'YYYY-MM-DD HH24:MI')            AS at,
    app_version                                          AS version,
    context ->> 'format'                                 AS format,
    context ->> 'provider'                               AS provider,
    (context ->> 'parsed')::int                          AS rows_added,
    (context ->> 'duplicates')::int                      AS already_had,
    (context ->> 'skipped')::int                         AS read_not_imported,
    (context ->> 'flagged')::int                         AS flagged,

    -- The verdict that matters most: did the statement's own opening and
    -- closing balance account for everything taken from it?
    CASE context ->> 'totalOk'
        WHEN 'true'  THEN 'reconciles'
        WHEN 'false' THEN 'DOES NOT RECONCILE'
        ELSE 'not checkable'
    END                                                  AS whole_statement,
    context ->> 'totalReason'                            AS why_not,

    -- How much of it the per-row check could vouch for. "0 of 0" means the
    -- document prints no running balance and nothing was verified at all.
    coalesce(context ->> 'chainChecked', '0') || ' of ' ||
    coalesce(context ->> 'chainPairs',  '0')             AS rows_verified,

    (context ->> 'detailTotal')::int                     AS detail_lines,
    (context ->> 'detailItemised')::int                  AS card_itemised,
    (context ->> 'detailPromoted')::int                  AS card_imported,
    (context ->> 'settlementsLinked')::int               AS repayments_linked,
    (context ->> 'cardAccountsCreated')::int             AS card_accounts_made,
    context ->> 'rowOrder'                               AS row_order,
    (context ->> 'broadened')::boolean                   AS widened_net,
    left(coalesce(context ->> 'signature', ''), 14)      AS layout
FROM app_errors
WHERE user_id = (SELECT id FROM me)
  AND kind = 'diagnostic'
  AND message = 'spend-import'
ORDER BY created_at DESC
LIMIT 50;

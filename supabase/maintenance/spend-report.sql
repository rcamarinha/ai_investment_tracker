-- ============================================================================
-- spend-report.sql — what Spend data exists for one user. READ ONLY.
--
-- Run this on its own before spend-reset.sql and check the numbers are the
-- ones you expect to lose. Nothing here writes.
--
-- One statement, so paste the whole file and run it.
-- ============================================================================

WITH me AS (
    -- The only place the email appears. Edit it here.
    SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com'
)
SELECT 1 AS ord, 'transactions'                 AS what, count(*) AS row_count FROM spend_transactions   WHERE user_id = (SELECT id FROM me)
UNION ALL
SELECT 2, 'pending details',                    count(*) FROM spend_pending_details WHERE user_id = (SELECT id FROM me)
UNION ALL
SELECT 3, 'recurring',                          count(*) FROM spend_recurring       WHERE user_id = (SELECT id FROM me)
UNION ALL
SELECT 4, 'bank profiles  (cleared)',           count(*) FROM spend_bank_profiles   WHERE user_id = (SELECT id FROM me)
UNION ALL
SELECT 5, 'rules          (cleared)',           count(*) FROM spend_rules           WHERE user_id = (SELECT id FROM me)
UNION ALL
SELECT 6, 'accounts       (kept)',              count(*) FROM spend_accounts        WHERE user_id = (SELECT id FROM me)
UNION ALL
SELECT 7, 'categories     (kept)',              count(*) FROM spend_categories      WHERE user_id = (SELECT id FROM me)
UNION ALL
SELECT 8, 'scenarios      (kept)',              count(*) FROM spend_scenarios       WHERE user_id = (SELECT id FROM me)
ORDER BY ord;

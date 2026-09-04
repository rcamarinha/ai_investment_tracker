-- ============================================================================
-- spend-sources.sql — what has been imported, grouped by the file it came from.
-- READ ONLY. Run this before spend-clear-imports.sql to choose what to remove.
--
-- 'manual' is a real value, written to rows you typed in yourself — those are
-- NOT imports and spend-clear-imports.sql keeps them by default.
--
-- '(none)' means the row has no source recorded at all. Those are treated as
-- imported by the cleanup script, so if any appear here, check them before
-- running it.
--
-- One statement: paste the whole file and run it.
-- ============================================================================

WITH me AS (
    -- The only place the email appears. Edit it here.
    SELECT id FROM auth.users WHERE email = 'rcamarinha@gmail.com'
)
SELECT
    coalesce(t.source, '(none)')                    AS source,
    a.account_label                                 AS account,
    count(*)                                        AS rows,
    min(t.date)                                     AS first_date,
    max(t.date)                                     AS last_date,
    round(sum(t.amount) FILTER (WHERE t.amount < 0)::numeric, 2) AS money_out,
    round(sum(t.amount) FILTER (WHERE t.amount > 0)::numeric, 2) AS money_in,
    count(*) FILTER (WHERE t.enriched_from = 'card') AS from_card_detail
FROM spend_transactions t
LEFT JOIN spend_accounts a ON a.id = t.account_id
WHERE t.user_id = (SELECT id FROM me)
GROUP BY 1, 2
ORDER BY 1, 2;

-- ============================================================================
-- Clear the stray stock rows from two wine-only accounts
-- ============================================================================
--
-- jmvcamarinha@gmail.com  6ae01657-06a5-4356-a2ec-7b11b1180775  (599 wines, 1 position, 1 trade, 1 snapshot)
-- gaspar.camarinha@gmail.com  67d19fb1-140d-4221-b3ba-2fee1044dda7  (1 wine, 2 positions, 1 trade, 9 snapshots)
--
-- These rows are NOT copies of anyone else's ledger — checked, and no trade in
-- the database exists under two accounts. We never established what wrote
-- them; this only removes them.
--
-- Scope is deliberately narrow and literal: these two user ids, and only the
-- stock tables. Nothing here can touch wine, spend, bank holdings, any other
-- account, or the accounts themselves. Wine is listed in step 1 purely so you
-- can see it stays untouched across the before/after comparison.
--
-- Run step 1. Run step 2 (it prints what it deleted). Run step 3.

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1 — BEFORE
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
    u.email,
    (SELECT count(*) FROM positions      x WHERE x.user_id = u.id) AS positions,
    (SELECT count(*) FROM transactions   x WHERE x.user_id = u.id) AS transactions,
    (SELECT count(*) FROM snapshots      x WHERE x.user_id = u.id) AS snapshots,
    (SELECT count(*) FROM price_history  x WHERE x.user_id = u.id) AS price_history,
    (SELECT count(*) FROM asset_movements x WHERE x.user_id = u.id) AS asset_movements,
    (SELECT count(*) FROM user_wines     x WHERE x.user_id = u.id) AS wines_UNTOUCHED
FROM auth.users u
WHERE u.id IN (
    '6ae01657-06a5-4356-a2ec-7b11b1180775',
    '67d19fb1-140d-4221-b3ba-2fee1044dda7'
);

-- And the rows themselves, so there is a record of what was removed.
SELECT 'transaction' AS kind, t.user_id, t.symbol, t.type, t.shares, t.price, t.date, t.created_at
FROM transactions t
WHERE t.user_id IN ('6ae01657-06a5-4356-a2ec-7b11b1180775','67d19fb1-140d-4221-b3ba-2fee1044dda7')
UNION ALL
SELECT 'position', p.user_id, p.symbol, p.platform, p.shares, p.avg_price, NULL, p.created_at
FROM positions p
WHERE p.user_id IN ('6ae01657-06a5-4356-a2ec-7b11b1180775','67d19fb1-140d-4221-b3ba-2fee1044dda7')
ORDER BY created_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2 — DELETE (one transaction: all of it, or none of it)
-- ─────────────────────────────────────────────────────────────────────────────
-- Uncomment and run. Each statement prints what it removed.

-- BEGIN;
--
-- DELETE FROM transactions
--  WHERE user_id IN ('6ae01657-06a5-4356-a2ec-7b11b1180775','67d19fb1-140d-4221-b3ba-2fee1044dda7')
--  RETURNING user_id, symbol, type, shares, price, date;
--
-- DELETE FROM positions
--  WHERE user_id IN ('6ae01657-06a5-4356-a2ec-7b11b1180775','67d19fb1-140d-4221-b3ba-2fee1044dda7')
--  RETURNING user_id, symbol, shares, avg_price;
--
-- DELETE FROM snapshots
--  WHERE user_id IN ('6ae01657-06a5-4356-a2ec-7b11b1180775','67d19fb1-140d-4221-b3ba-2fee1044dda7')
--  RETURNING user_id, timestamp, total_market_value;
--
-- DELETE FROM price_history
--  WHERE user_id IN ('6ae01657-06a5-4356-a2ec-7b11b1180775','67d19fb1-140d-4221-b3ba-2fee1044dda7')
--  RETURNING user_id, ticker;
--
-- DELETE FROM asset_movements
--  WHERE user_id IN ('6ae01657-06a5-4356-a2ec-7b11b1180775','67d19fb1-140d-4221-b3ba-2fee1044dda7')
--  RETURNING user_id;
--
-- COMMIT;
-- -- ROLLBACK;  -- run this instead of COMMIT if anything above looks wrong

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3 — AFTER: stock columns zero, wine unchanged
-- ─────────────────────────────────────────────────────────────────────────────
-- Re-run step 1's first query. Expect zeros across the stock columns and the
-- SAME wine count as before: 599 and 1.
--
-- Then have each of them reload the app. The browser keeps its own copy of the
-- ledger, so if a stale copy is still in that browser it can write the rows
-- back on the next save. If they reappear, tell me — that tells us the local
-- copy is the source, which is a code fix, not a cleanup.

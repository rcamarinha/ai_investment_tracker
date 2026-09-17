-- ============================================================================
-- Remove the probe accounts left behind by security verification runs
-- ============================================================================
--
-- Between 26 July and 10 August 2026, verification sessions signed up throwaway
-- accounts to test row-level security from a second account — sec-review-*,
-- rlsprobe*, secscan*, secprobe*, seccheck*, cleanup-* — and never removed
-- them. They are the reason the user list looks duplicated. They are not
-- duplicates of anybody: every real address appears exactly once.
--
-- Signup is disabled now, so no more of these can appear.
--
-- ⚠ Deleting an account CASCADES to every table keyed by user_id. That is why
-- step 1 exists and why the delete in step 2 can only ever match an account
-- that owns nothing at all: the NOT EXISTS list below covers all 20 tables
-- that carry a user_id, plus admin_users. An account holding a single row of
-- anything is not a candidate and will not be deleted.
--
-- The five real addresses are named explicitly as well, so a real account
-- cannot be caught even if it somehow held nothing. Belt and braces, because
-- this is the one script in the repository that destroys accounts.
--
-- Run step 1. Read the list. Only then run step 2.

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1 — REVIEW: exactly which accounts would go
-- ─────────────────────────────────────────────────────────────────────────────

WITH protected AS (
    SELECT unnest(ARRAY[
        'rcamarinha@gmail.com',
        'jmvcamarinha@gmail.com',
        'gaspar.camarinha@gmail.com',
        'jmpcamarinha@gmail.com',
        'miguel_fontoura@hotmail.com'
    ]) AS email
),
candidates AS (
    SELECT u.id, u.email, u.created_at, u.last_sign_in_at
    FROM auth.users u
    WHERE lower(u.email) NOT IN (SELECT lower(email) FROM protected)
      AND (u.email LIKE '%@example.com' OR u.email LIKE '%@mailinator.com')
      AND NOT EXISTS (SELECT 1 FROM positions             x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM transactions          x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM snapshots             x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM price_history         x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM asset_movements       x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM app_config            x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM app_errors            x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM admin_users           x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM user_wines            x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM wine_price_history    x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM wine_snapshots        x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM bank_holdings         x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM spend_transactions    x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM spend_accounts        x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM spend_categories      x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM spend_rules           x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM spend_recurring       x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM spend_scenarios       x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM spend_bank_profiles   x WHERE x.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM spend_pending_details x WHERE x.user_id = u.id)
)
SELECT count(*) AS would_delete FROM candidates;
-- Then look at them one by one:
--   ...replace the last line above with:  SELECT * FROM candidates ORDER BY created_at;
--
-- Expect roughly 75 accounts, every address ending @example.com or
-- @mailinator.com, every one created between 26 July and 10 August 2026.
-- If ANY address you recognise appears, stop and say so.

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2 — DELETE, same conditions, nothing widened
-- ─────────────────────────────────────────────────────────────────────────────
-- RETURNING prints what went, so the output is the record of what happened.
-- If the count does not match step 1, something changed in between: stop.

-- WITH protected AS (
--     SELECT unnest(ARRAY[
--         'rcamarinha@gmail.com',
--         'jmvcamarinha@gmail.com',
--         'gaspar.camarinha@gmail.com',
--         'jmpcamarinha@gmail.com',
--         'miguel_fontoura@hotmail.com'
--     ]) AS email
-- ),
-- candidates AS (
--     SELECT u.id
--     FROM auth.users u
--     WHERE lower(u.email) NOT IN (SELECT lower(email) FROM protected)
--       AND (u.email LIKE '%@example.com' OR u.email LIKE '%@mailinator.com')
--       AND NOT EXISTS (SELECT 1 FROM positions             x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM transactions          x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM snapshots             x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM price_history         x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM asset_movements       x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM app_config            x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM app_errors            x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM admin_users           x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM user_wines            x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM wine_price_history    x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM wine_snapshots        x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM bank_holdings         x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM spend_transactions    x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM spend_accounts        x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM spend_categories      x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM spend_rules           x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM spend_recurring       x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM spend_scenarios       x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM spend_bank_profiles   x WHERE x.user_id = u.id)
--       AND NOT EXISTS (SELECT 1 FROM spend_pending_details x WHERE x.user_id = u.id)
-- )
-- DELETE FROM auth.users u
-- USING candidates c
-- WHERE u.id = c.id
-- RETURNING u.id, u.email;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3 — AFTER: the list should be the real people and nobody else
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT email, created_at, last_sign_in_at FROM auth.users ORDER BY created_at;

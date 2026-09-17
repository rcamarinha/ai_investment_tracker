-- ============================================================================
-- Diagnose duplicate accounts, and stock data appearing in the wrong account
-- ============================================================================
--
-- READ-ONLY. Every statement here is a SELECT. Nothing is created, changed or
-- deleted. Run the sections one at a time in the Supabase SQL Editor and keep
-- the output — the fix depends on what these say, and guessing at a fix here
-- would destroy data.
--
-- ⚠ BEFORE DELETING ANY ACCOUNT, READ THIS
-- Every table references auth.users(id) ON DELETE CASCADE. Deleting an account
-- deletes that account's positions, transactions, snapshots, wines, spend and
-- bank holdings with it, immediately and unrecoverably. Section 3 is what says
-- which of two look-alike accounts is the one holding the data.
--
-- Note the SQL Editor runs as the table owner and bypasses row-level security,
-- so these queries see every row regardless of policies. That is what we want
-- here, and it is also why this file can never be used to test scoping.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Every account, and how it was created
-- ─────────────────────────────────────────────────────────────────────────────
-- Look for the same email twice. `provider` tells you how each one was made:
-- "email" is a password account, "google" came from Sign in with Google. When
-- Supabase is set NOT to link accounts with the same email, signing in with
-- Google creates a SECOND account for an address that already has one.
-- `invited_at` non-null means the account came from an invitation.

SELECT
    u.id,
    u.email,
    u.created_at,
    u.last_sign_in_at,
    u.email_confirmed_at,
    u.invited_at,
    u.raw_app_meta_data->>'provider'  AS provider,
    u.raw_app_meta_data->'providers'  AS providers,
    u.raw_user_meta_data->>'full_name' AS full_name
FROM auth.users u
ORDER BY lower(u.email), u.created_at;

-- Same thing, condensed: which addresses have more than one account.
SELECT lower(email) AS email, count(*) AS accounts, array_agg(id ORDER BY created_at) AS ids
FROM auth.users
GROUP BY 1
HAVING count(*) > 1
ORDER BY 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Sign-in methods attached to each account
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per way of signing in. Two accounts for one address show up here as
-- two user_ids with the same email and different providers.

SELECT
    i.user_id,
    i.provider,
    i.identity_data->>'email' AS email,
    i.created_at,
    i.last_sign_in_at
FROM auth.identities i
ORDER BY lower(i.identity_data->>'email'), i.created_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. What each account actually holds  ← the one that decides everything
-- ─────────────────────────────────────────────────────────────────────────────
-- For two look-alike accounts, this says which one is the real one (it holds
-- the data and has signed in recently), which one is empty, and whether an
-- account that should only have wine now has stock rows.

SELECT
    u.email,
    u.id,
    u.last_sign_in_at,
    (SELECT count(*) FROM positions          p  WHERE p.user_id  = u.id) AS positions,
    (SELECT count(*) FROM transactions       t  WHERE t.user_id  = u.id) AS transactions,
    (SELECT count(*) FROM snapshots          s  WHERE s.user_id  = u.id) AS snapshots,
    (SELECT count(*) FROM user_wines         w  WHERE w.user_id  = u.id) AS wines,
    (SELECT count(*) FROM spend_transactions st WHERE st.user_id = u.id) AS spend_rows,
    (SELECT count(*) FROM bank_holdings      b  WHERE b.user_id  = u.id) AS holdings
FROM auth.users u
ORDER BY lower(u.email), u.created_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Is the same stock ledger sitting in two accounts?
-- ─────────────────────────────────────────────────────────────────────────────
-- The app keeps the working ledger in the browser's localStorage as well as in
-- the database, and clears it on sign-OUT only — not when a different account
-- signs in on the same browser. So one account's trades can be written into
-- another account under its own user_id. If that happened, the same trades
-- appear under two user_ids: identical symbol, date, shares and price.
--
-- Rows here are the proof. An empty result means the stock rows were NOT copied
-- from another account, and the cause is something else.

SELECT
    t.symbol, t.date, t.shares, t.price, t.type,
    count(DISTINCT t.user_id)                        AS accounts,
    array_agg(DISTINCT t.user_id)                    AS user_ids,
    array_agg(DISTINCT u.email)                      AS emails
FROM transactions t
JOIN auth.users u ON u.id = t.user_id
GROUP BY t.symbol, t.date, t.shares, t.price, t.type
HAVING count(DISTINCT t.user_id) > 1
ORDER BY t.date DESC, t.symbol
LIMIT 200;

-- Same question for positions, which are derived from the ledger.
SELECT
    p.symbol, p.shares, p.avg_price,
    count(DISTINCT p.user_id) AS accounts,
    array_agg(DISTINCT u.email) AS emails
FROM positions p
JOIN auth.users u ON u.id = p.user_id
GROUP BY p.symbol, p.shares, p.avg_price
HAVING count(DISTINCT p.user_id) > 1
ORDER BY p.symbol
LIMIT 200;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. When did the unexpected stock rows arrive?
-- ─────────────────────────────────────────────────────────────────────────────
-- `created_at` is when the row was written to the database, not the trade date.
-- Compare it with when things were deployed: a cluster in one minute is one
-- save, which is what a browser writing somebody else's ledger looks like.
-- Replace the email with the affected person's.

SELECT
    u.email,
    date_trunc('minute', t.created_at) AS written_at,
    count(*)                           AS rows_written,
    min(t.date)                        AS earliest_trade,
    max(t.date)                        AS latest_trade,
    array_agg(DISTINCT t.symbol)       AS symbols
FROM transactions t
JOIN auth.users u ON u.id = t.user_id
WHERE lower(u.email) = lower('REPLACE-WITH-THE-AFFECTED-EMAIL')
GROUP BY 1, 2
ORDER BY 2;

-- Everything that account holds in the stock tables, in full, so you can see
-- whether it is someone else's portfolio before deciding what to remove.
SELECT t.*
FROM transactions t
JOIN auth.users u ON u.id = t.user_id
WHERE lower(u.email) = lower('REPLACE-WITH-THE-AFFECTED-EMAIL')
ORDER BY t.created_at, t.date;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Which account id to make an administrator
-- ─────────────────────────────────────────────────────────────────────────────
-- Use section 3: pick the id that holds your data and has the most recent
-- sign-in. This shows who is already an admin — it changes nothing.

SELECT a.user_id, u.email, u.last_sign_in_at, u.raw_app_meta_data->>'provider' AS provider
FROM admin_users a
LEFT JOIN auth.users u ON u.id = a.user_id;

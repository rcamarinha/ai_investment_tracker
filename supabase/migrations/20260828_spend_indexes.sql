-- ============================================
-- Spend — index corrections
-- ============================================
-- Run in the Supabase SQL Editor. Safe to run more than once.
--
-- Follows a measured review of which indexes the code actually issues queries
-- against. Cheap to apply now while the tables are small; painful once a user
-- has years of history.
--
--   * spend_transactions(user_id, category) was never used. ALL category
--     filtering happens client-side in visibleTransactions(); nothing filters
--     by category in SQL. It only added write cost to every import.
--
--   * The bare user_id indexes are the leftmost prefix of a (user_id, X) index
--     sitting beside them, so Postgres can already serve those lookups.
--
--   * account_id and recurring_id carry FK constraints with ON DELETE CASCADE
--     and ON DELETE SET NULL. Postgres does NOT auto-index the referencing
--     column, so deleting an account was a full table scan of the ledger.
-- ============================================

DROP INDEX IF EXISTS idx_spend_transactions_category;
DROP INDEX IF EXISTS idx_spend_transactions_user_id;   -- prefix of (user_id, date DESC)
DROP INDEX IF EXISTS idx_spend_bank_profiles_user_id;  -- prefix of (user_id, signature)
DROP INDEX IF EXISTS idx_spend_categories_user_id;     -- prefix of (user_id, name)
DROP INDEX IF EXISTS idx_spend_pending_user_id;        -- prefix of (user_id, fingerprint)

-- Serve the cascading deletes.
CREATE INDEX IF NOT EXISTS idx_spend_transactions_account
    ON spend_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_spend_transactions_recurring
    ON spend_transactions(recurring_id) WHERE recurring_id IS NOT NULL;

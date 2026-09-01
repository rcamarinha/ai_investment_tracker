-- ============================================
-- Audit fixes for spend_baseline + bank_holdings migrations
-- ============================================
-- Addresses findings from the 2026-09-01 security audit:
--
--   F1  Cross-user FK references bypass RLS (HIGH)
--   F2  UPDATE policies missing explicit WITH CHECK (defense-in-depth)
--   F3  transfer_pair_id has no FK constraint
--   F4  Self-referential linked_account_id can point to itself
--   F5  Missing CHECK on cadence_days (allows zero/negative)
--   F6  Missing CHECK on confidence columns (no range)
--   F7  Missing CHECK on skip_rows (allows negative)
--   F8  No unique constraint on spend_rules per user+pattern
--   F10 Missing FK indexes for cascade deletes
--
-- SAFE TO RUN MULTIPLE TIMES — every DDL uses IF NOT EXISTS or a
-- DO-block exception handler, and policy DROPs precede CREATEs.
-- ============================================


-- ────────────────────────────────────────────
-- F1: Cross-user FK references bypass RLS
-- ────────────────────────────────────────────
-- PostgreSQL validates FKs as the table owner, bypassing RLS. A user who knows
-- another user's UUID can insert a row that references it. The composite FK
-- pattern (id, user_id) → (id, user_id) forces the referencing row's own
-- user_id to match the target, which RLS already pins to auth.uid().
--
-- Step 1: add UNIQUE(id, user_id) to every referenced user-owned table.
-- The PK already guarantees id uniqueness; this index adds the user_id column
-- so the composite FK can reference it.

CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_accounts_id_user
    ON spend_accounts(id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_recurring_id_user
    ON spend_recurring(id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_transactions_id_user
    ON spend_transactions(id, user_id);

-- Step 2: replace bare FKs with composite FKs.
-- ALTER TABLE ... ADD CONSTRAINT is not IF-NOT-EXISTS-able, so we wrap each in
-- a DO block that catches duplicate_object.

-- spend_accounts.linked_account_id → spend_accounts(id, user_id)
DO $$ BEGIN
    ALTER TABLE spend_accounts DROP CONSTRAINT IF EXISTS spend_accounts_linked_account_id_fkey;
    ALTER TABLE spend_accounts
        ADD CONSTRAINT spend_accounts_linked_account_user_fk
        FOREIGN KEY (linked_account_id, user_id)
        REFERENCES spend_accounts(id, user_id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- spend_bank_profiles.account_id → spend_accounts(id, user_id)
DO $$ BEGIN
    ALTER TABLE spend_bank_profiles DROP CONSTRAINT IF EXISTS spend_bank_profiles_account_id_fkey;
    ALTER TABLE spend_bank_profiles
        ADD CONSTRAINT spend_bank_profiles_account_user_fk
        FOREIGN KEY (account_id, user_id)
        REFERENCES spend_accounts(id, user_id)
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- spend_transactions.account_id → spend_accounts(id, user_id)
DO $$ BEGIN
    ALTER TABLE spend_transactions DROP CONSTRAINT IF EXISTS spend_transactions_account_id_fkey;
    ALTER TABLE spend_transactions
        ADD CONSTRAINT spend_transactions_account_user_fk
        FOREIGN KEY (account_id, user_id)
        REFERENCES spend_accounts(id, user_id)
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- spend_transactions.recurring_id → spend_recurring(id, user_id)
DO $$ BEGIN
    ALTER TABLE spend_transactions DROP CONSTRAINT IF EXISTS spend_transactions_recurring_id_fkey;
    ALTER TABLE spend_transactions
        ADD CONSTRAINT spend_transactions_recurring_user_fk
        FOREIGN KEY (recurring_id, user_id)
        REFERENCES spend_recurring(id, user_id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- spend_pending_details.account_id → spend_accounts(id, user_id)
DO $$ BEGIN
    ALTER TABLE spend_pending_details DROP CONSTRAINT IF EXISTS spend_pending_details_account_id_fkey;
    ALTER TABLE spend_pending_details
        ADD CONSTRAINT spend_pending_details_account_user_fk
        FOREIGN KEY (account_id, user_id)
        REFERENCES spend_accounts(id, user_id)
        ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ────────────────────────────────────────────
-- F2: Explicit WITH CHECK on UPDATE policies
-- ────────────────────────────────────────────
-- PostgreSQL implicitly uses USING as WITH CHECK when omitted, so this is not
-- a vulnerability — but explicit is safer against future edits.

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'spend_accounts', 'spend_bank_profiles', 'spend_categories',
        'spend_recurring', 'spend_transactions', 'spend_pending_details',
        'spend_rules', 'spend_scenarios', 'bank_holdings'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS "Users can update own %s" ON %I', t, t);
        EXECUTE format(
            'CREATE POLICY "Users can update own %s" ON %I FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)',
            t, t
        );
    END LOOP;
END $$;


-- ────────────────────────────────────────────
-- F3: transfer_pair_id FK + cross-user safety
-- ────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE spend_transactions
        ADD CONSTRAINT spend_transactions_transfer_pair_fk
        FOREIGN KEY (transfer_pair_id, user_id)
        REFERENCES spend_transactions(id, user_id)
        ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ────────────────────────────────────────────
-- F4: Prevent self-referential linked_account_id
-- ────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE spend_accounts
        ADD CONSTRAINT spend_accounts_no_self_link
        CHECK (linked_account_id IS NULL OR linked_account_id != id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ────────────────────────────────────────────
-- F5: cadence_days must be positive
-- ────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE spend_recurring
        ADD CONSTRAINT spend_recurring_cadence_positive
        CHECK (cadence_days > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ────────────────────────────────────────────
-- F6: Confidence columns bounded 0–1
-- ────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE spend_recurring
        ADD CONSTRAINT spend_recurring_confidence_range
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE spend_transactions
        ADD CONSTRAINT spend_transactions_confidence_range
        CHECK (category_confidence IS NULL OR (category_confidence >= 0 AND category_confidence <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ────────────────────────────────────────────
-- F7: skip_rows must be non-negative
-- ────────────────────────────────────────────
DO $$ BEGIN
    ALTER TABLE spend_bank_profiles
        ADD CONSTRAINT spend_bank_profiles_skip_nonneg
        CHECK (skip_rows >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ────────────────────────────────────────────
-- F8: Deduplicate spend_rules per user+pattern+match_type
-- ────────────────────────────────────────────
-- A rule is identified by its matching behaviour, not its UUID.
CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_rules_user_pattern
    ON spend_rules(user_id, match_type, pattern);


-- ────────────────────────────────────────────
-- F10: FK cascade indexes for small tables
-- ────────────────────────────────────────────
-- Without these, deleting an account triggers a sequential scan on the
-- referencing table. Low row counts today, but cheap insurance.
CREATE INDEX IF NOT EXISTS idx_spend_bank_profiles_account
    ON spend_bank_profiles(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_spend_pending_account
    ON spend_pending_details(account_id) WHERE account_id IS NOT NULL;

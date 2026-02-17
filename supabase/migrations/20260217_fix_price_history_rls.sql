-- Migration: Fix overly permissive RLS policy on price_history
-- Issue: INSERT policy used WITH CHECK (true) / auth.role() = 'authenticated',
--        which bypasses row-level security for all authenticated users.
-- Fix: Add user_id column and scope INSERT policy to auth.uid() = user_id.

-- 1. Add user_id column (nullable initially for existing rows)
ALTER TABLE price_history
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Backfill existing rows: assign to the first authenticated user, or leave NULL
--    (Adjust this if you have a specific user to assign orphaned rows to)
-- UPDATE price_history SET user_id = 'your-user-uuid' WHERE user_id IS NULL;

-- 3. Make user_id NOT NULL after backfill (skip if you have existing data without a user)
--    Uncomment after backfilling:
-- ALTER TABLE price_history ALTER COLUMN user_id SET NOT NULL;

-- 4. Drop the old overly permissive INSERT policy
DROP POLICY IF EXISTS "Authenticated users can insert price history" ON price_history;
DROP POLICY IF EXISTS "Price history is insertable by all authenticated users" ON price_history;

-- 5. Create the new scoped INSERT policy
CREATE POLICY "Users can insert own price history"
    ON price_history FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- 6. Add index on user_id for query performance
CREATE INDEX IF NOT EXISTS idx_price_history_user_id ON price_history(user_id);

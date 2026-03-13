-- ============================================================
-- Migration: Add bottle_size to user_wines
-- Date: 2026-03-12
-- ============================================================
-- Tracks the format of each bottle (e.g. 0.75L standard,
-- 1.5L Magnum, 3.0L Double Magnum …). Without this field
-- the AI valuation prompt always assumes a 750 ml bottle,
-- which gives incorrect estimates for larger formats that
-- command a significant price premium at auction.
--
-- Safe to re-run: uses IF NOT EXISTS / exception handlers.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE  table_name  = 'user_wines'
        AND    column_name = 'bottle_size'
    ) THEN
        ALTER TABLE user_wines
            ADD COLUMN bottle_size TEXT DEFAULT '0.75L';

        COMMENT ON COLUMN user_wines.bottle_size IS
            'Bottle format, e.g. "0.375L", "0.75L", "1.5L", "3.0L". '
            'Defaults to standard 750 ml. Used to adjust AI valuation prompts.';
    END IF;
END $$;

-- ============================================
-- Restrict wines table UPDATE policy
-- ============================================
-- The shared wines catalog previously allowed any authenticated user to
-- UPDATE any column on any row. This migration drops that overly broad
-- policy and replaces it with one that only allows updating drink_window
-- and type — the two fields that AI valuations and classification legitimately
-- update. Identity fields (name, winery, vintage, region, etc.) are now
-- immutable once inserted, preventing one user from corrupting shared data.
--
-- SAFE TO RUN MULTIPLE TIMES — uses exception handlers for idempotency.
-- ============================================

-- 1. Drop the old broad UPDATE policy
DO $$ BEGIN
    DROP POLICY "Authenticated users can update wines" ON wines;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- 2. Create a restricted UPDATE policy: only drink_window and type can change
-- The WITH CHECK ensures the identity columns remain unchanged.
DO $$ BEGIN
    CREATE POLICY "Authenticated users can update wine metadata only"
        ON wines FOR UPDATE
        USING (auth.role() = 'authenticated')
        WITH CHECK (
            name IS NOT DISTINCT FROM (SELECT w.name FROM wines w WHERE w.id = wines.id)
            AND winery IS NOT DISTINCT FROM (SELECT w.winery FROM wines w WHERE w.id = wines.id)
            AND vintage IS NOT DISTINCT FROM (SELECT w.vintage FROM wines w WHERE w.id = wines.id)
            AND region IS NOT DISTINCT FROM (SELECT w.region FROM wines w WHERE w.id = wines.id)
            AND country IS NOT DISTINCT FROM (SELECT w.country FROM wines w WHERE w.id = wines.id)
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

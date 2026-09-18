-- ============================================================================
-- Remove the probe accounts — STEP 2 of 2: DELETE.
-- ============================================================================
--
-- ⚠ Run step 1 (remove-test-accounts-1-review.sql) first and read its list.
--
-- This recomputes the candidates with exactly the same rules as step 1 — an
-- account qualifies only if it owns nothing in any table the live database
-- links to accounts — and deletes those, printing each one it removed.
--
-- Two guards, because this cannot be undone:
--   * It refuses to delete more than MAX_DELETE accounts. Step 1 found 57 on
--     18 September 2026; if the number has grown past the cap, something has
--     changed and it stops without deleting anything.
--   * Everything runs in one transaction: if anything fails, nothing is deleted.
--
-- HOW TO RUN: paste the WHOLE file into the SQL Editor and Run, with nothing
-- selected. The output lists every account deleted; its count should match
-- step 1's.
--
-- Tested against a real Postgres in tests/remove-test-accounts.test.js.

BEGIN;

DROP TABLE IF EXISTS pg_temp.cleanup_candidates;
DROP TABLE IF EXISTS pg_temp.cleanup_deleted;

CREATE TEMP TABLE cleanup_candidates AS
SELECT u.id, u.email, u.created_at
FROM auth.users u
WHERE lower(u.email) NOT IN (
        'rcamarinha@gmail.com',
        'jmvcamarinha@gmail.com',
        'gaspar.camarinha@gmail.com',
        'jmpcamarinha@gmail.com',
        'miguel_fontoura@hotmail.com')
  AND (u.email LIKE '%@example.com' OR u.email LIKE '%@mailinator.com');

DO $$
DECLARE
    MAX_DELETE constant integer := 60;
    r record;
    n integer;
BEGIN
    FOR r IN
        SELECT c.table_name AS tbl, c.column_name AS col
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.column_name = 'user_id'
        UNION
        SELECT cl.relname::text, a.attname::text
        FROM pg_constraint k
        JOIN pg_class cl      ON cl.oid = k.conrelid
        JOIN pg_namespace n   ON n.oid = cl.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a   ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
        WHERE k.contype = 'f' AND k.confrelid = 'auth.users'::regclass
    LOOP
        EXECUTE format(
            'DELETE FROM cleanup_candidates cc WHERE EXISTS (SELECT 1 FROM public.%I x WHERE x.%I = cc.id)',
            r.tbl, r.col);
    END LOOP;

    SELECT count(*) INTO n FROM cleanup_candidates;
    IF n > MAX_DELETE THEN
        RAISE EXCEPTION 'Refusing to delete % accounts (the cap is %). Re-run step 1 and check the list.',
            n, MAX_DELETE;
    END IF;
END $$;

-- Deleted rows are kept in a temporary table and printed AFTER the commit:
-- the SQL Editor shows only the last statement's result, and that must be the
-- record of what was removed, not the COMMIT.
CREATE TEMP TABLE cleanup_deleted (email text, created_at timestamptz);

WITH d AS (
    DELETE FROM auth.users u
    USING cleanup_candidates c
    WHERE u.id = c.id
    RETURNING u.email, u.created_at
)
INSERT INTO cleanup_deleted SELECT email, created_at FROM d;

COMMIT;

SELECT email, created_at FROM cleanup_deleted ORDER BY created_at;

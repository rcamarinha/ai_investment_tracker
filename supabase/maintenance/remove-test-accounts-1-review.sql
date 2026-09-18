-- ============================================================================
-- Remove the probe accounts — STEP 1 of 2: REVIEW. Deletes nothing.
-- ============================================================================
--
-- Between 26 July and 10 August 2026, verification sessions signed up throwaway
-- accounts to test row-level security — sec-review-*, rlsprobe*, secscan*,
-- secprobe*, seccheck*, cleanup-* — and never removed them.
--
-- Deleting an account CASCADES to every row linked to it, so an account is a
-- candidate only if it owns NOTHING, in ANY table. The first version of this
-- script checked a hand-written list of tables, and the list was wrong twice:
-- it named app_config, which has no user_id, and it missed a table that exists
-- only in production. So this version asks the live database, at the moment it
-- runs, for every table that can hold a row for an account:
--
--   * every column named user_id in a public table, and
--   * every column, whatever its name, with a foreign key to auth.users.
--
-- An account with a single row in any of those is not a candidate.
--
-- The five real addresses are also named explicitly, so a real account cannot
-- be caught even if it somehow owned nothing.
--
-- HOW TO RUN: paste the WHOLE file into the SQL Editor and Run, with nothing
-- selected. The result is the list of accounts step 2 would delete. The
-- temporary table lasts only for this session.
--
-- Tested against a real Postgres in tests/remove-test-accounts.test.js.

DROP TABLE IF EXISTS pg_temp.cleanup_candidates;

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
    r record;
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
END $$;

-- The accounts step 2 would delete. Expect only @example.com / @mailinator.com
-- addresses created 26 July – 10 August 2026. Note the count.
SELECT email, created_at, id
FROM cleanup_candidates
ORDER BY created_at;

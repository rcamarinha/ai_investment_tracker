/**
 * A real Postgres for the test suite — PGlite, which is PostgreSQL compiled to
 * WebAssembly and run inside Node. No Docker, no system install.
 *
 * Why this exists: migrations here are run BY HAND against production, so the
 * first execution of a new migration used to be the production one. Two
 * mistakes in one week would have been caught by a harness like this before
 * they reached the owner — a migration that could not be re-run, and a
 * security finding (row reassignment through UPDATE) that a single query would
 * have disproved.
 *
 * What it is faithful to, and what it is not:
 *
 *   - Faithful: real Postgres semantics. Constraints, plpgsql, jsonb, row-level
 *     security enforced for non-owner roles, transactions and rollback.
 *   - Faithful: Supabase's grant MODEL. Tables and functions are granted to
 *     `anon` and `authenticated` at creation through default privileges, exactly
 *     as a Supabase project does, so a migration's REVOKE is genuinely tested.
 *   - Simulated: auth. `auth.uid()` and `auth.role()` read session settings the
 *     test sets. This proves queries are scoped to the right user; it does NOT
 *     prove the gateway verifies a token.
 *   - Not production: the baseline is the repo's schema files, which have
 *     drifted from the live database. A green run means "correct against the
 *     schema we believe exists". Loading a schema-only dump of production
 *     instead would close that gap.
 *   - Version: whatever PGlite ships (18.x at the time of writing), not
 *     necessarily the server's.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export const ROOT = join(import.meta.dirname, '..', '..');

/** Loaded in this order: the stock schema first, since the others reference it. */
export const BASELINE = ['supabase_schema.sql', 'wine_schema.sql', 'spend_schema.sql', 'holdings_schema.sql'];

/**
 * Files that sit in supabase/migrations/ but are NOT migrations: conditional,
 * run-by-hand recovery procedures that refuse wherever their precondition does
 * not hold. A normal build skips them.
 *
 * This list is not a place to hide a broken migration. tests/migrations.test.js
 * asserts every entry still describes itself as conditional in its own words
 * (`mustSay`) and still refuses for the reason it gives (`refusesWith`). A file
 * that cannot pass both does not belong here.
 */
export const CONDITIONAL_SCRIPTS = new Map([
    ['20260225_recover_wine_data.sql', {
        why: 'Recovers cellar data from wine_bottles_backup_v1, which only ever existed in the original '
           + 'project after a manual rename. On any other project there is nothing to recover.',
        mustSay: 'Run this if you renamed wine_bottles BEFORE the data migration ran',
        refusesWith: /wine_bottles_backup_v1/,
    }],
]);

const SUPABASE_SHIMS = `
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;

    CREATE SCHEMA auth;
    -- The real auth.users has many more columns; these are the ones anything in
    -- this repository reads (admin_usage_report). All nullable, so a test that
    -- inserts only an id still works.
    CREATE TABLE auth.users (
        id                 uuid PRIMARY KEY,
        email              text,
        created_at         timestamptz DEFAULT now(),
        last_sign_in_at    timestamptz,
        invited_at         timestamptz,
        email_confirmed_at timestamptz
    );
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;

    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated;

    -- Supabase grants every new table, sequence and function to both API roles
    -- at creation. Declared BEFORE the schema loads so objects inherit it, and a
    -- later REVOKE in a migration removes it — which is what makes testing that
    -- REVOKE meaningful.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
`;

/** A fresh database with the Supabase roles and auth functions, and nothing else. */
export async function createDatabase() {
    const db = new PGlite();
    await db.waitReady;
    await db.exec(SUPABASE_SHIMS);
    return db;
}

/** Every migration, in the order its filename sorts. */
export function migrationFiles() {
    return readdirSync(join(ROOT, 'supabase', 'migrations'))
        .filter(name => name.endsWith('.sql'))
        .sort();
}

/**
 * Run one SQL file. Returns null on success, or the first line of the error.
 *
 * A multi-statement string runs as one implicit transaction, so a failure part
 * way through leaves nothing half-applied. The ROLLBACK clears an aborted
 * transaction left by a file that opened its own BEGIN.
 */
export async function applySql(db, relativePath) {
    try {
        await db.exec(readFileSync(join(ROOT, relativePath), 'utf8'));
        return null;
    } catch (err) {
        await db.exec('ROLLBACK').catch(() => {});
        return String(err.message).split('\n')[0];
    }
}

/**
 * Baseline schema files, then every migration once, skipping CONDITIONAL_SCRIPTS.
 * Throws on the first failure, naming the file.
 */
export async function buildMigratedDatabase() {
    const db = await createDatabase();
    for (const file of BASELINE) {
        const err = await applySql(db, file);
        if (err) throw new Error(`baseline ${file}: ${err}`);
    }
    for (const file of migrationFiles()) {
        if (CONDITIONAL_SCRIPTS.has(file)) continue;
        const err = await applySql(db, join('supabase', 'migrations', file));
        if (err) throw new Error(`migration ${file}: ${err}`);
    }
    return db;
}

const ROLES = new Set(['anon', 'authenticated']);

/**
 * Run `fn` as an API role, with `uid` as the signed-in user (or none).
 *
 * The role is checked against a fixed set before it reaches SET ROLE, which
 * takes an identifier and cannot be parameterised.
 */
export async function asUser(db, role, uid, fn) {
    if (!ROLES.has(role)) throw new Error(`asUser: unknown role ${role}`);
    await db.exec(`SET ROLE ${role}`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
    await db.query(`SELECT set_config('request.jwt.claim.role', $1, false)`, [role]);
    try {
        return await fn();
    } finally {
        await db.exec('RESET ROLE');
    }
}

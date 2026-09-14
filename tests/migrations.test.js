import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
    ROOT, BASELINE, CONDITIONAL_SCRIPTS,
    createDatabase, applySql, migrationFiles, asUser,
} from './helpers/pg-harness.js';

/**
 * Every migration, run through a real Postgres before anyone runs it by hand.
 *
 * Migrations here are pasted into the Supabase SQL editor against production,
 * so until this file existed the first execution of any migration WAS the
 * production one. On its very first run this harness found three problems:
 *
 *   - 20260911 failed on any project without wine_bottles_backup_v1, because
 *     `DROP POLICY IF EXISTS ... ON t` guards the policy, not the table — and
 *     since the file is one transaction, its price-history security fix rolled
 *     back with it. Production has the table, so it would have been invisible
 *     until the wine launch's fresh project.
 *   - 20260217 could not be re-run.
 *   - 20260225_recover_wine_data is a conditional recovery script filed among
 *     migrations, and sorts BEFORE the restructure that would create its table.
 *
 * One database is shared by the whole file, and the describes run in order:
 * baseline, then migrations, then rollbacks, then behaviour. Each step builds
 * on the state the previous one left.
 */

const MIGRATIONS = migrationFiles();
const REGULAR = MIGRATIONS.filter(f => !CONDITIONAL_SCRIPTS.has(f));
const ROLLBACKS = readdirSync(join(ROOT, 'supabase', 'maintenance'))
    .filter(f => /^rollback-\d{8}-.*\.sql$/.test(f))
    .sort();

const migration = f => join('supabase', 'migrations', f);

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

let db;

beforeAll(async () => { db = await createDatabase(); }, 60_000);
afterAll(async () => { await db?.close(); });

describe('the baseline schema files', () => {
    it.each(BASELINE)('%s loads', async (file) => {
        expect(await applySql(db, file)).toBeNull();
    });
});

describe('every migration', () => {
    it('is either a regular migration or a named conditional script', () => {
        expect(MIGRATIONS.length).toBeGreaterThan(0);
        for (const name of CONDITIONAL_SCRIPTS.keys()) {
            expect(MIGRATIONS, `${name} is listed as conditional but is not in supabase/migrations/`).toContain(name);
        }
    });

    it.each(REGULAR)('%s applies, and survives being run a second time', async (file) => {
        expect(await applySql(db, migration(file)), 'the first run failed').toBeNull();
        expect(
            await applySql(db, migration(file)),
            'a second run failed — these are pasted in by hand and must be safe to paste again',
        ).toBeNull();
    });
});

describe('conditional recovery scripts', () => {
    it.each([...CONDITIONAL_SCRIPTS.entries()])(
        '%s refuses on a project where it has nothing to recover',
        async (file, spec) => {
            const text = readFileSync(join(ROOT, migration(file)), 'utf8');
            expect(text, 'the file no longer describes itself as conditional, so it cannot stay excluded')
                .toContain(spec.mustSay);

            const err = await applySql(db, migration(file));
            expect(err, 'it must refuse here, not quietly succeed').not.toBeNull();
            expect(err).toMatch(spec.refusesWith);
        },
    );
});

describe('every rollback script', () => {
    it.each(ROLLBACKS)('%s applies, and its migration re-applies cleanly afterwards', async (rollback) => {
        // Rollbacks are the scripts run at the worst possible moment. A rollback
        // that errors, or leaves the database somewhere its own migration cannot
        // be re-run from, is worse than having none.
        const date = rollback.match(/^rollback-(\d{8})-/)[1];
        const forward = MIGRATIONS.filter(f => f.startsWith(date));
        expect(forward, `expected exactly one migration dated ${date}`).toHaveLength(1);

        expect(await applySql(db, join('supabase', 'maintenance', rollback)), 'the rollback failed').toBeNull();
        expect(await applySql(db, migration(forward[0])), 're-applying the migration after rollback failed').toBeNull();
    });
});

describe('the migrated database behaves as the migrations claim', () => {
    beforeAll(async () => {
        await db.exec(`INSERT INTO auth.users (id) VALUES ('${A}'), ('${B}') ON CONFLICT DO NOTHING`);
        await db.exec(`INSERT INTO assets (ticker, name) VALUES ('AAPL', 'Apple') ON CONFLICT DO NOTHING`);
        await db.exec(`INSERT INTO price_history (user_id, ticker, price) VALUES ('${A}', 'AAPL', 100), ('${B}', 'AAPL', 101)`);
    });

    const visiblePriceOwners = uid => asUser(db, 'authenticated', uid, async () =>
        (await db.query('SELECT user_id::text AS u FROM price_history ORDER BY u')).rows.map(r => r.u));

    it('shows each user only their own price history', async () => {
        // In production this table was readable by every account, and its rows
        // carry user_id beside ticker: an inventory of who holds what. A leftover
        // permissive SELECT policy would OR with the scoped one and keep the leak
        // open, which this would catch as a second owner's row.
        expect(await visiblePriceOwners(A)).toEqual([A]);
        expect(await visiblePriceOwners(B)).toEqual([B]);
    });

    it('shows an anonymous visitor no price history', async () => {
        const count = await asUser(db, 'anon', null, async () =>
            (await db.query('SELECT count(*)::int AS c FROM price_history')).rows[0].c);
        expect(count).toBe(0);
    });

    it('leaves exactly one SELECT policy on wine price history, scoped to the owner', async () => {
        // Exactly one: a second, permissive policy left behind would silently
        // re-open the table, since policies of the same command are OR-ed.
        const { rows } = await db.query(
            `SELECT qual FROM pg_policies WHERE tablename = 'wine_price_history' AND cmd = 'SELECT'`);
        expect(rows).toHaveLength(1);
        expect(rows[0].qual).toMatch(/auth\.uid\(\)\s*=\s*user_id/);
    });

    it('makes the new-row check explicit on every table 20260911 names', async () => {
        // The table list is read out of the migration itself, not restated here.
        const sql = readFileSync(join(ROOT, migration('20260911_rls_with_check_and_scope.sql')), 'utf8');
        const list = sql.match(/owner_scoped TEXT\[\] := ARRAY\[([\s\S]*?)\];/);
        expect(list, 'could not find the owner_scoped table list in 20260911').toBeTruthy();
        const tables = [...list[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
        expect(tables.length).toBeGreaterThanOrEqual(10);

        const { rows } = await db.query(
            `SELECT tablename FROM pg_policies
             WHERE schemaname = 'public' AND cmd = 'UPDATE' AND with_check IS NOT NULL
               AND tablename = ANY($1)`, [tables]);
        const covered = new Set(rows.map(r => r.tablename));
        expect(tables.filter(t => !covered.has(t)), 'these UPDATE policies still lack an explicit WITH CHECK').toEqual([]);
    });

    it('rejects reassigning a row to another user even when UPDATE has only USING', async () => {
        // A security review reported the opposite — that a USING-only UPDATE
        // policy leaves the new row unconstrained, so a user could move a row
        // into someone else's account — and that finding was passed on twice
        // before anyone checked it. Postgres applies USING to the new row when
        // WITH CHECK is absent. This keeps that fact proven rather than argued.
        await db.exec(`
            CREATE TABLE rls_semantics_probe (id int PRIMARY KEY, user_id uuid NOT NULL);
            ALTER TABLE rls_semantics_probe ENABLE ROW LEVEL SECURITY;
            CREATE POLICY probe_select ON rls_semantics_probe FOR SELECT USING (auth.uid() = user_id);
            CREATE POLICY probe_update ON rls_semantics_probe FOR UPDATE USING (auth.uid() = user_id);
            INSERT INTO rls_semantics_probe VALUES (1, '${A}');
        `);
        try {
            await asUser(db, 'authenticated', A, async () => {
                await expect(db.query(`UPDATE rls_semantics_probe SET user_id = '${B}' WHERE id = 1`))
                    .rejects.toThrow(/row-level security/i);
            });
            const { rows } = await db.query('SELECT user_id::text AS u FROM rls_semantics_probe');
            expect(rows).toEqual([{ u: A }]);
        } finally {
            await db.exec('DROP TABLE rls_semantics_probe');
        }
    });
});

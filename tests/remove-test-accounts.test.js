import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMigratedDatabase } from './helpers/pg-harness.js';

/**
 * The only scripts in the repository that delete accounts, run against a real
 * Postgres before anyone runs them on production.
 *
 * Deleting an account cascades to every row linked to it, so an account may be
 * removed only if it owns nothing anywhere. The first version checked a
 * hand-written list of tables and was wrong twice in production: it named a
 * table with no user_id, and missed one that exists only in production. These
 * tests plant exactly those shapes — a table no schema file knows, and a link
 * to auth.users under a column not called user_id — and check the scripts see
 * them anyway.
 */

const ROOT = join(import.meta.dirname, '..');
const REVIEW = readFileSync(join(ROOT, 'supabase/maintenance/remove-test-accounts-1-review.sql'), 'utf8');
const DELETE = readFileSync(join(ROOT, 'supabase/maintenance/remove-test-accounts-2-delete.sql'), 'utf8');

let db;
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

beforeEach(async () => {
    db = await buildMigratedDatabase();
    await db.exec(`
        INSERT INTO auth.users (id, email, created_at) VALUES
            ('${id(1)}', 'probe-empty@example.com',       now() - interval '50 days'),
            ('${id(2)}', 'probe-in-hidden@example.com',   now() - interval '50 days'),
            ('${id(3)}', 'probe-fk-owner@example.com',    now() - interval '50 days'),
            ('${id(4)}', 'probe-used-ai@mailinator.com',  now() - interval '50 days'),
            ('${id(5)}', 'rcamarinha@gmail.com',          now() - interval '200 days'),
            ('${id(6)}', 'a.real.person@gmail.com',       now() - interval '10 days'),
            ('${id(7)}', 'probe-positions@example.com',   now() - interval '50 days');

        -- A table no schema file knows about, like production's wine backup.
        CREATE TABLE public.wine_bottles_backup_v1 (id serial PRIMARY KEY, user_id uuid, name text);
        INSERT INTO public.wine_bottles_backup_v1 (user_id, name) VALUES ('${id(2)}', 'kept bottle');

        -- A link to an account under a column that is NOT called user_id.
        CREATE TABLE public.shared_notes (id serial PRIMARY KEY, owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
        INSERT INTO public.shared_notes (owner_id) VALUES ('${id(3)}');

        -- Only ever used the AI features: a usage row and nothing else.
        INSERT INTO usage_events (user_id, fn, provider) VALUES ('${id(4)}', 'wine-ai', 'gemini');

        INSERT INTO positions (user_id, symbol, shares, avg_price) VALUES ('${id(7)}', 'AAPL', 1, 1);
    `);
}, 60_000);

afterEach(async () => { await db?.close(); });

const lastRows = results => results[results.length - 1].rows;
const emails = rows => rows.map(r => r.email).sort();
const remaining = async () => emails((await db.query('SELECT email FROM auth.users')).rows);

describe('step 1 — review', () => {
    it('lists only a probe account that owns nothing anywhere', async () => {
        expect(emails(lastRows(await db.exec(REVIEW)))).toEqual(['probe-empty@example.com']);
    });

    it('sees a table that exists in no schema file, as production\'s backup table does', async () => {
        const listed = emails(lastRows(await db.exec(REVIEW)));
        expect(listed).not.toContain('probe-in-hidden@example.com');
    });

    it('sees a link to an account under a column not called user_id', async () => {
        expect(emails(lastRows(await db.exec(REVIEW)))).not.toContain('probe-fk-owner@example.com');
    });

    it('spares an account whose only trace is AI usage', async () => {
        expect(emails(lastRows(await db.exec(REVIEW)))).not.toContain('probe-used-ai@mailinator.com');
    });

    it('never lists a real address, even one that owns nothing', async () => {
        const listed = emails(lastRows(await db.exec(REVIEW)));
        expect(listed).not.toContain('rcamarinha@gmail.com');
        expect(listed).not.toContain('a.real.person@gmail.com');
    });

    it('deletes nothing, and can be run twice', async () => {
        await db.exec(REVIEW);
        await db.exec(REVIEW);
        expect(await remaining()).toHaveLength(7);
    });
});

describe('step 2 — delete', () => {
    it('deletes exactly what step 1 listed and prints it', async () => {
        const listed = emails(lastRows(await db.exec(REVIEW)));
        const deleted = emails(lastRows(await db.exec(DELETE)));
        expect(deleted).toEqual(listed);
        expect(await remaining()).not.toContain('probe-empty@example.com');
    });

    it('leaves every other account and all their data in place', async () => {
        await db.exec(DELETE);
        expect(await remaining()).toEqual([
            'a.real.person@gmail.com', 'probe-fk-owner@example.com', 'probe-in-hidden@example.com',
            'probe-positions@example.com', 'probe-used-ai@mailinator.com', 'rcamarinha@gmail.com',
        ]);
        const kept = await db.query('SELECT name FROM public.wine_bottles_backup_v1');
        expect(kept.rows).toEqual([{ name: 'kept bottle' }]);
    });

    it('refuses, and deletes nothing, when the count exceeds its cap', async () => {
        const values = Array.from({ length: 61 }, (_, i) => `('${id(100 + i)}', 'bulk${i}@example.com')`).join(',');
        await db.exec(`INSERT INTO auth.users (id, email) VALUES ${values}`);
        await expect(db.exec(DELETE)).rejects.toThrow(/Refusing to delete 62 accounts/);
        await db.exec('ROLLBACK').catch(() => {});
        expect((await db.query('SELECT count(*)::int AS c FROM auth.users')).rows[0].c).toBe(7 + 61);
    });
});

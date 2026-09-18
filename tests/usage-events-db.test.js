import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildMigratedDatabase, asUser } from './helpers/pg-harness.js';

/**
 * usage_events and admin_ai_usage_report, against a real Postgres.
 *
 * The table is a record of what each person's requests cost the owner, so the
 * properties that matter are about trust: nobody can write to it from a
 * browser — not even their own rows, or they could erase or forge usage — each
 * person sees only their own, and the admin report adds up correctly and
 * refuses everyone else.
 *
 * Writes here run as the harness owner, which stands in for the service role
 * the edge functions use: both bypass row-level security.
 */

const ADMIN = '11111111-1111-1111-1111-111111111111';
const ANA   = '22222222-2222-2222-2222-222222222222';
const BEN   = '33333333-3333-3333-3333-333333333333';

let db;

beforeAll(async () => {
    db = await buildMigratedDatabase();
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES
            ('${ADMIN}', 'admin@example.com'), ('${ANA}', 'ana@example.com'), ('${BEN}', 'ben@example.com');
        INSERT INTO admin_users (user_id) VALUES ('${ADMIN}');

        INSERT INTO usage_events (user_id, fn, provider, model, ok, input_tokens, output_tokens, created_at) VALUES
            ('${ANA}', 'wine-ai',          'anthropic', 'claude-opus-4-6',   true,  1000, 200, now() - interval '1 day'),
            ('${ANA}', 'wine-ai',          'anthropic', 'claude-opus-4-6',   true,  3000, 800, now() - interval '2 days'),
            ('${ANA}', 'wine-ai',          'anthropic', 'claude-opus-4-6',   false,    0,   0, now() - interval '2 days'),
            ('${ANA}', 'wine-ai',          'gemini',    'gemini-2.5-flash',  true,   500, 100, now() - interval '3 days'),
            ('${ANA}', 'wine-ai',          'anthropic', 'claude-opus-4-6',   true,  9999, 999, now() - interval '45 days'),
            ('${BEN}', 'analyze-portfolio','anthropic', 'claude-sonnet-4-6', true,  2000, 400, now() - interval '5 days');
        INSERT INTO usage_events (user_id, fn, provider, units) VALUES
            ('${BEN}', 'quote-proxy', 'yahoo', 25);
    `);
}, 60_000);

afterAll(async () => { await db?.close(); });

const report = () => db.query('SELECT public.admin_ai_usage_report() AS r').then(res => res.rows[0].r);
const row = (r, user, fn, model) => r.rows.find(x => x.user_id === user && x.fn === fn && x.model === model);

describe('who can write usage', () => {
    it('refuses a signed-in user writing a row, even their own', async () => {
        await expect(asUser(db, 'authenticated', ANA, () => db.query(
            `INSERT INTO usage_events (user_id, fn, provider) VALUES ('${ANA}', 'wine-ai', 'anthropic')`,
        ))).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses a user deleting or rewriting their own usage', async () => {
        await expect(asUser(db, 'authenticated', ANA, () =>
            db.query(`DELETE FROM usage_events WHERE user_id = '${ANA}'`))).rejects.toMatchObject({ code: '42501' });
        await expect(asUser(db, 'authenticated', ANA, () =>
            db.query(`UPDATE usage_events SET input_tokens = 0 WHERE user_id = '${ANA}'`))).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses the anonymous role entirely', async () => {
        await expect(asUser(db, 'anon', null, () =>
            db.query('SELECT count(*) FROM usage_events'))).rejects.toMatchObject({ code: '42501' });
    });

    it('rejects nonsense a buggy function might send', async () => {
        await expect(db.query(
            `INSERT INTO usage_events (user_id, fn, provider, input_tokens) VALUES ('${ANA}', 'x', 'anthropic', -1)`,
        )).rejects.toMatchObject({ code: '23514' });
        await expect(db.query(
            `INSERT INTO usage_events (user_id, fn, provider) VALUES ('${ANA}', '', 'anthropic')`,
        )).rejects.toMatchObject({ code: '23514' });
    });
});

describe('usage outlives the account', () => {
    it('keeps what a deleted account cost', async () => {
        // A record of money spent must survive removing the person who spent
        // it — that is exactly when the evidence matters. So no cascade.
        const GONE = '44444444-4444-4444-4444-444444444444';
        await db.exec(`
            INSERT INTO auth.users (id, email) VALUES ('${GONE}', 'gone@example.com');
            INSERT INTO usage_events (user_id, fn, provider, model, input_tokens) VALUES ('${GONE}', 'wine-ai', 'anthropic', 'claude-opus-4-6', 777);
            DELETE FROM auth.users WHERE id = '${GONE}';
        `);
        const res = await db.query(`SELECT input_tokens FROM usage_events WHERE user_id = '${GONE}'`);
        expect(res.rows).toEqual([{ input_tokens: 777 }]);
        await db.exec(`DELETE FROM usage_events WHERE user_id = '${GONE}'`);
    });
});

describe('who can read usage', () => {
    it('shows each person only their own rows', async () => {
        const owners = await asUser(db, 'authenticated', ANA, async () =>
            (await db.query('SELECT DISTINCT user_id FROM usage_events')).rows.map(r => r.user_id));
        expect(owners).toEqual([ANA]);
    });
});

describe('admin_ai_usage_report', () => {
    it('adds up calls, failures and tokens per person, function and model', async () => {
        const r = await asUser(db, 'authenticated', ADMIN, report);
        expect(row(r, ANA, 'wine-ai', 'claude-opus-4-6')).toMatchObject({
            provider: 'anthropic', calls: 3, failures: 1, input_tokens: 4000, output_tokens: 1000,
        });
        expect(row(r, ANA, 'wine-ai', 'gemini-2.5-flash')).toMatchObject({ calls: 1, input_tokens: 500 });
        expect(row(r, BEN, 'analyze-portfolio', 'claude-sonnet-4-6')).toMatchObject({ calls: 1, output_tokens: 400 });
    });

    it('carries non-token work, such as symbols quoted, as units', async () => {
        const r = await asUser(db, 'authenticated', ADMIN, report);
        expect(row(r, BEN, 'quote-proxy', null)).toMatchObject({ provider: 'yahoo', calls: 1, units: 25 });
    });

    it('covers the last 30 days only', async () => {
        // The 45-day-old call with 9999 tokens must not be in the Opus total.
        const r = await asUser(db, 'authenticated', ADMIN, report);
        expect(row(r, ANA, 'wine-ai', 'claude-opus-4-6').input_tokens).toBe(4000);
        expect(r.since).toBeTruthy();
    });

    it('carries exactly the agreed fields — counts, never money', async () => {
        const r = await asUser(db, 'authenticated', ADMIN, report);
        expect(Object.keys(r).sort()).toEqual(['generated_at', 'rows', 'since']);
        for (const x of r.rows) {
            expect(Object.keys(x).sort()).toEqual([
                'calls', 'failures', 'fn', 'input_tokens', 'last_at', 'model',
                'output_tokens', 'provider', 'units', 'user_id',
            ]);
        }
    });

    it('takes no parameters', async () => {
        const res = await db.query(`SELECT pronargs, prosecdef FROM pg_proc WHERE proname = 'admin_ai_usage_report'`);
        expect(res.rows).toEqual([{ pronargs: 0, prosecdef: true }]);
    });

    it('refuses a signed-in non-admin, a session with no user, and the anonymous role', async () => {
        await expect(asUser(db, 'authenticated', ANA, report)).rejects.toMatchObject({ code: '42501' });
        await expect(asUser(db, 'authenticated', null, report)).rejects.toMatchObject({ code: '42501' });
        await expect(asUser(db, 'anon', null, report)).rejects.toMatchObject({ code: '42501' });
    });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildMigratedDatabase, asUser } from './helpers/pg-harness.js';
import { ENDPOINTS } from '../supabase/functions/_shared/market-data-core.js';

/**
 * The shared price keys must never reach a browser again (plan P3 part 2).
 *
 * They used to sit in app_config under a policy every signed-in account could
 * read, and the portfolio page copied them into localStorage. Two halves hold
 * that shut: the database no longer serves them, and the client no longer
 * contains any route to a provider except through the market-data function.
 * Both are pinned here, the second by reading the source, because a single
 * "quick fix" that calls finnhub.io directly again would silently re-need a key
 * in the browser.
 */

const ROOT = join(import.meta.dirname, '..');
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

// src/portfolio.js is an old mirror kept only for tests/price-fetching.test.js;
// it is not shipped to users and is due for removal.
const BROWSER_FILES = [
    ...readdirSync(join(ROOT, 'services')).filter(f => f.endsWith('.js')).map(f => `services/${f}`),
    'portfolio.html', 'index.html', 'admin.html',
];

describe('the browser code', () => {
    it('never calls a keyed provider directly', () => {
        const direct = BROWSER_FILES.filter(f => /finnhub\.io|financialmodelingprep\.com|alphavantage\.co/.test(read(f)));
        expect(direct, 'call providers through keyedFetch() — the keys live only in market-data').toEqual([]);
    });

    it('holds no price key in state or localStorage', () => {
        const offenders = BROWSER_FILES.filter(f => {
            const s = read(f);
            return /state\.(finnhubKey|fmpKey|alphaVantageKey)\b/.test(s)
                || /localStorage\.setItem\(\s*['"](finnhubKey|fmpKey|alphaVantageKey)['"]/.test(s);
        });
        expect(offenders).toEqual([]);
    });

    it('asks market-data only for endpoints the function allows', () => {
        // A typo here would not fail loudly: the function answers 400, the call
        // site's catch reads it as "request failed", and a tier quietly dies.
        const calls = [];
        for (const f of BROWSER_FILES) {
            for (const m of read(f).matchAll(/keyedFetch\(\s*'([\w-]+)'\s*,\s*'([\w-]+)'/g)) calls.push({ f, provider: m[1], op: m[2] });
        }
        expect(calls.length).toBeGreaterThan(10);
        const unknown = calls.filter(c => !ENDPOINTS[c.provider]?.[c.op]);
        expect(unknown).toEqual([]);
    });

    it('clears any key an earlier version copied into localStorage', () => {
        expect(read('portfolio.html')).toMatch(/for \(const k of \['finnhubKey', 'fmpKey', 'alphaVantageKey'\]\)[\s\S]{0,80}localStorage\.removeItem\(k\)/);
    });
});

describe('the database', () => {
    const ADMIN = '11111111-1111-1111-1111-111111111111';
    const USER  = '22222222-2222-2222-2222-222222222222';
    let db;

    beforeAll(async () => {
        db = await buildMigratedDatabase();
        await db.exec(`
            INSERT INTO auth.users (id, email) VALUES ('${ADMIN}', 'admin@example.com'), ('${USER}', 'user@example.com');
            INSERT INTO admin_users (user_id) VALUES ('${ADMIN}');
        `);
    }, 60_000);
    afterAll(async () => { await db?.close(); });

    it('holds no price keys at all, so not even an admin\'s browser receives them', async () => {
        const res = await db.query(`SELECT key FROM app_config WHERE key IN ('finnhubKey', 'fmpKey', 'alphaVantageKey')`);
        expect(res.rows).toEqual([]);
    });

    it('no longer has the policy that let every account read them', async () => {
        const res = await db.query(`SELECT policyname FROM pg_policies WHERE tablename = 'app_config'`);
        expect(res.rows.map(r => r.policyname)).toEqual(['Admin users can read config']);
    });

    it('shows a signed-in non-admin nothing from app_config, even if a key row came back', async () => {
        await db.exec(`INSERT INTO app_config (key, value) VALUES ('finnhubKey', 'leaked') ON CONFLICT (key) DO NOTHING`);
        try {
            const rows = await asUser(db, 'authenticated', USER, async () =>
                (await db.query('SELECT key FROM app_config')).rows);
            expect(rows).toEqual([]);
        } finally {
            await db.exec(`DELETE FROM app_config WHERE key = 'finnhubKey'`);
        }
    });
});

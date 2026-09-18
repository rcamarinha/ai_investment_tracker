import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildMigratedDatabase, asUser } from './helpers/pg-harness.js';

/**
 * admin_usage_report, run against a real Postgres built from the repo's schema
 * and every migration.
 *
 * It is SECURITY DEFINER and reads across every account, so what matters is
 * who it refuses and what it will never return. Those are properties of the
 * database, not of any source file, which is why this runs the function rather
 * than reading it.
 */

const ADMIN  = '11111111-1111-1111-1111-111111111111';
const STOCKS = '22222222-2222-2222-2222-222222222222';
const WINE   = '33333333-3333-3333-3333-333333333333';
const IDLE   = '44444444-4444-4444-4444-444444444444';
const BANK   = '55555555-5555-5555-5555-555555555555';

let db;

beforeAll(async () => {
    db = await buildMigratedDatabase();
    await db.exec(`
        INSERT INTO auth.users (id, email, created_at, last_sign_in_at, invited_at, email_confirmed_at) VALUES
            ('${ADMIN}',  'admin@example.com',  now() - interval '200 days', now() - interval '1 day',  NULL,                      now() - interval '200 days'),
            ('${STOCKS}', 'stocks@example.com', now() - interval '100 days', now() - interval '60 days', NULL,                     now() - interval '100 days'),
            ('${WINE}',   'wine@example.com',   now() - interval '10 days',  now() - interval '10 days', now() - interval '11 days', now() - interval '10 days'),
            ('${IDLE}',   'idle@example.com',   now() - interval '5 days',   NULL,                       now() - interval '5 days',  NULL),
            ('${BANK}',   'bank@example.com',   now() - interval '50 days',  now() - interval '50 days', NULL,                      now() - interval '50 days');

        INSERT INTO admin_users (user_id) VALUES ('${ADMIN}');

        INSERT INTO positions (user_id, symbol, shares, avg_price) VALUES
            ('${STOCKS}', 'AAPL', 10, 150), ('${STOCKS}', 'MSFT', 5, 300);
        INSERT INTO snapshots (user_id, timestamp, total_invested, total_market_value, position_count, created_at)
            VALUES ('${STOCKS}', now() - interval '3 days', 3000, 3500, 2, now() - interval '3 days');

        INSERT INTO transactions (user_id, symbol, type, shares, price, created_at)
            VALUES ('${STOCKS}', 'AAPL', 'buy', 10, 150, now() - interval '90 days');
        INSERT INTO asset_movements (user_id, asset_type, stock_ticker, movement_type, created_at)
            VALUES ('${STOCKS}', 'stock', 'AAPL', 'buy', now() - interval '90 days');

        WITH a AS (INSERT INTO spend_accounts (user_id, bank_name, account_label)
                   VALUES ('${STOCKS}', 'CGD', 'Current') RETURNING id)
        INSERT INTO spend_transactions (user_id, account_id, date, description, amount, fingerprint, created_at)
            SELECT '${STOCKS}', id, current_date, 'Groceries', -42.10, 'fp-1', now() - interval '1 day' FROM a;

        WITH w AS (INSERT INTO wines (name) VALUES ('Barca Velha') RETURNING id)
        INSERT INTO user_wines (user_id, wine_id) SELECT '${WINE}', id FROM w;

        -- A cellar valuation writes a WINE movement. It must never read as bank activity.
        INSERT INTO asset_movements (user_id, asset_type, movement_type, created_at)
            VALUES ('${WINE}', 'wine', 'valuation_update', now() - interval '2 days');

        INSERT INTO bank_holdings (user_id, bank_name, name, current_value, valued_as_of, updated_at)
            VALUES ('${BANK}', 'BPI', 'Retail bond 2030', 25000, current_date, now() - interval '6 days');

        INSERT INTO app_errors (user_id, page, kind, message) VALUES
            ('${WINE}', 'wine', 'handled',    'valuation failed'),
            ('${WINE}', 'wine', 'diagnostic', 'wine-valuation');
    `);
}, 60_000);

afterAll(async () => { await db?.close(); });

const report = () => db.query('SELECT public.admin_usage_report() AS r').then(res => res.rows[0].r);
const person = (r, id) => r.people.find(p => p.id === id);

describe('admin_usage_report for an administrator', () => {
    it('returns every account, including ones that have done nothing', async () => {
        const r = await asUser(db, 'authenticated', ADMIN, report);
        expect(r.people.map(p => p.email).sort()).toEqual(
            ['admin@example.com', 'bank@example.com', 'idle@example.com', 'stocks@example.com', 'wine@example.com']);
        expect(r.generated_at).toBeTruthy();
    });

    it('counts rows per tool and dates the most recent activity in each', async () => {
        const r = await asUser(db, 'authenticated', ADMIN, report);
        const stocks = person(r, STOCKS).tools;
        expect(stocks.stocks.items).toBe(2);
        expect(stocks.stocks.last).toBeTruthy();
        expect(stocks.wine).toEqual({ items: 0, last: null });

        const wine = person(r, WINE).tools;
        expect(wine.wine.items).toBe(1);
        expect(wine.wine.last).toBeTruthy();
        expect(wine.stocks).toEqual({ items: 0, last: null });
    });

    it('counts every tool from its own table', async () => {
        const r = await asUser(db, 'authenticated', ADMIN, report);
        expect(person(r, STOCKS).tools.spend.items).toBe(1);
        expect(person(r, STOCKS).tools.spend.last).toBeTruthy();
        expect(person(r, BANK).tools.bank.items).toBe(1);
        expect(person(r, BANK).tools.bank.last).toBeTruthy();
    });

    it('credits a cellar movement to the cellar, never to bank holdings', async () => {
        // asset_movements holds wine and stock movements only. The first draft
        // of this function counted it as bank activity, so every cellar user
        // looked recently active in a tool they had never opened.
        const r = await asUser(db, 'authenticated', ADMIN, report);
        const wine = person(r, WINE).tools;
        expect(wine.bank).toEqual({ items: 0, last: null });
        expect(Date.now() - Date.parse(wine.wine.last)).toBeLessThan(3 * 864e5);
    });

    it('takes the latest of several signals for a tool, not only the ledger', async () => {
        // Nothing was imported recently, but prices were refreshed three days
        // ago — that snapshot is what shows the person still opens the page.
        const r = await asUser(db, 'authenticated', ADMIN, report);
        const last = Date.parse(person(r, STOCKS).tools.stocks.last);
        expect(Date.now() - last).toBeLessThan(4 * 864e5);
    });

    it('separates problems from routine diagnostics', async () => {
        const r = await asUser(db, 'authenticated', ADMIN, report);
        expect(person(r, WINE).problems_30d).toBe(1);
        expect(person(r, WINE).operations_30d).toBe(1);
        expect(person(r, IDLE).problems_30d).toBe(0);
    });

    it('reports an account that never signed in as exactly that', async () => {
        const r = await asUser(db, 'authenticated', ADMIN, report);
        const idle = person(r, IDLE);
        expect(idle.last_sign_in_at).toBeNull();
        expect(idle.confirmed_at).toBeNull();
        expect(idle.invited_at).toBeTruthy();
    });
});

describe('what admin_usage_report will never return', () => {
    it('carries exactly the agreed fields, so no amount can slip in unnoticed', async () => {
        // Adding a field here is a decision, not a detail: widen this list only
        // after checking the new field is not money.
        const r = await asUser(db, 'authenticated', ADMIN, report);
        expect(Object.keys(r).sort()).toEqual(['generated_at', 'people']);
        for (const p of r.people) {
            expect(Object.keys(p).sort()).toEqual([
                'confirmed_at', 'created_at', 'email', 'id', 'invited_at', 'last_report_at',
                'last_sign_in_at', 'operations_30d', 'problems_30d', 'tools',
            ]);
            expect(Object.keys(p.tools).sort()).toEqual(['bank', 'spend', 'stocks', 'wine']);
            for (const tool of Object.values(p.tools)) {
                expect(Object.keys(tool).sort()).toEqual(['items', 'last']);
            }
        }
    });

    it('reports a count of holdings, never their value', async () => {
        // Positions worth 3000, a 25000 bond, a 42.10 purchase: the report
        // carries the counts and none of the money.
        const r = await asUser(db, 'authenticated', ADMIN, report);
        expect(person(r, STOCKS).tools.stocks.items).toBe(2);
        expect(JSON.stringify(r)).not.toMatch(/3000|3500|25000|42\.1/);
    });

    it('takes no parameters, so it can never be pointed at one person', async () => {
        const res = await db.query(`SELECT pronargs, prosecdef FROM pg_proc WHERE proname = 'admin_usage_report'`);
        expect(res.rows).toEqual([{ pronargs: 0, prosecdef: true }]);
    });
});

describe('who admin_usage_report refuses', () => {
    it('refuses a signed-in account that is not an administrator', async () => {
        await expect(asUser(db, 'authenticated', STOCKS, report)).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses a session with no user at all', async () => {
        await expect(asUser(db, 'authenticated', null, report)).rejects.toMatchObject({ code: '42501' });
    });

    it('cannot be called by the anonymous role in the first place', async () => {
        await expect(asUser(db, 'anon', null, report)).rejects.toMatchObject({ code: '42501' });
        const res = await db.query(
            `SELECT has_function_privilege('anon', 'public.admin_usage_report()', 'EXECUTE') AS anon_can`);
        expect(res.rows[0].anon_can).toBe(false);
    });

    it('stops working the moment someone is removed from admin_users', async () => {
        await db.exec(`DELETE FROM admin_users WHERE user_id = '${ADMIN}'`);
        try {
            await expect(asUser(db, 'authenticated', ADMIN, report)).rejects.toMatchObject({ code: '42501' });
        } finally {
            await db.exec(`INSERT INTO admin_users (user_id) VALUES ('${ADMIN}')`);
        }
    });
});

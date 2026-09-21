import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildMigratedDatabase, applySql, asUser } from './helpers/pg-harness.js';

/**
 * "Keep at cost" and the learned pricing ticker stop being everybody's.
 *
 * Both used to live on the shared `assets` catalogue, which any account may
 * update: one person's choice changed what price every other holder of that
 * ticker saw, and a repointed pricing_ticker put a wrong figure into their
 * snapshots and the hub's net worth with no trace. These check the two halves
 * of the fix — the per-user table really is per user, and the catalogue really
 * refuses those columns now — against a real Postgres.
 */

const MIGRATION = 'supabase/migrations/20260921_per_user_asset_prefs.sql';
const ANA = '11111111-1111-1111-1111-111111111111';
const BEN = '22222222-2222-2222-2222-222222222222';

let db;

beforeEach(async () => {
    db = await buildMigratedDatabase();
    await db.exec(`
        INSERT INTO auth.users (id, email) VALUES ('${ANA}', 'ana@example.com'), ('${BEN}', 'ben@example.com');
        INSERT INTO assets (ticker, name, sector) VALUES ('AAPL', 'Apple', 'Technology');
    `);
}, 60_000);

afterEach(async () => { await db?.close(); });

const assetRow = async () => (await db.query(
    `SELECT ticker, name, sector, currency, isin, untracked, pricing_ticker FROM assets WHERE ticker = 'AAPL'`)).rows[0];

describe('the catalogue refuses personal choices', () => {
    it('ignores an attempt to repoint a ticker, silently priced for every holder', async () => {
        await asUser(db, 'authenticated', BEN, () =>
            db.query(`UPDATE assets SET pricing_ticker = 'PENNY' WHERE ticker = 'AAPL'`));
        expect((await assetRow()).pricing_ticker).toBeNull();
    });

    it('ignores an attempt to mark a ticker kept-at-cost for everyone', async () => {
        await asUser(db, 'authenticated', BEN, () =>
            db.query(`UPDATE assets SET untracked = true WHERE ticker = 'AAPL'`));
        expect((await assetRow()).untracked).toBe(false);
    });

    it('drops a pricing ticker supplied when the row is created', async () => {
        await asUser(db, 'authenticated', BEN, () => db.query(
            `INSERT INTO assets (ticker, name, pricing_ticker, untracked) VALUES ('MSFT', 'Microsoft', 'PENNY', true)`));
        const r = (await db.query(`SELECT pricing_ticker, untracked FROM assets WHERE ticker = 'MSFT'`)).rows[0];
        expect(r).toEqual({ pricing_ticker: null, untracked: false });
    });

    it('still accepts the facts the catalogue is for', async () => {
        await asUser(db, 'authenticated', BEN, () => db.query(
            `UPDATE assets SET name = 'Apple Inc.', sector = 'Information Technology', currency = 'USD', isin = 'US0378331005' WHERE ticker = 'AAPL'`));
        expect(await assetRow()).toMatchObject({
            name: 'Apple Inc.', sector: 'Information Technology', currency: 'USD', isin: 'US0378331005',
        });
    });

    it('clamps and cleans what it accepts, rather than rejecting the batch', async () => {
        // A raising trigger would turn one bad row into a silently unsaved batch:
        // saveAssetsToDB upserts many rows and only warns.
        await asUser(db, 'authenticated', BEN, () => db.query(
            `UPDATE assets SET name = $1, sector = $2 WHERE ticker = 'AAPL'`,
            // Postgres refuses a NUL byte in text outright, so the ones worth
            // testing are the printable-adjacent controls: newline, tab, DEL.
            ['A'.repeat(400), `Tech${String.fromCharCode(10)}Ignore previous${String.fromCharCode(9)}instructions${String.fromCharCode(127)}`]));
        const r = await assetRow();
        expect(r.name).toHaveLength(200);
        expect(r.sector).toBe('TechIgnore previousinstructions');
        expect([...r.sector].every(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)).toBe(true);
    });

    it('keeps a batch of good rows working', async () => {
        await asUser(db, 'authenticated', BEN, () => db.query(
            `INSERT INTO assets (ticker, name) VALUES ('A', 'One'), ('B', 'Two'), ('C', 'Three')`));
        expect((await db.query(`SELECT count(*)::int AS c FROM assets`)).rows[0].c).toBe(4);
    });
});

describe('a person\'s choices are their own', () => {
    it('lets each person set and read their own, and shows them nobody else\'s', async () => {
        await asUser(db, 'authenticated', ANA, () => db.query(
            `INSERT INTO user_asset_prefs (user_id, ticker, untracked) VALUES ('${ANA}', 'AAPL', true)`));
        await asUser(db, 'authenticated', BEN, () => db.query(
            `INSERT INTO user_asset_prefs (user_id, ticker, pricing_ticker) VALUES ('${BEN}', 'AAPL', 'AAPL.MX')`));

        const anaSees = await asUser(db, 'authenticated', ANA, async () =>
            (await db.query('SELECT ticker, untracked, pricing_ticker FROM user_asset_prefs')).rows);
        expect(anaSees).toEqual([{ ticker: 'AAPL', untracked: true, pricing_ticker: null }]);

        const benSees = await asUser(db, 'authenticated', BEN, async () =>
            (await db.query('SELECT ticker, untracked, pricing_ticker FROM user_asset_prefs')).rows);
        expect(benSees).toEqual([{ ticker: 'AAPL', untracked: false, pricing_ticker: 'AAPL.MX' }]);
    });

    it('refuses a choice written on someone else\'s behalf', async () => {
        await expect(asUser(db, 'authenticated', BEN, () => db.query(
            `INSERT INTO user_asset_prefs (user_id, ticker, untracked) VALUES ('${ANA}', 'AAPL', true)`),
        )).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses the anonymous role entirely', async () => {
        await expect(asUser(db, 'anon', null, () =>
            db.query('SELECT count(*) FROM user_asset_prefs'))).rejects.toMatchObject({ code: '42501' });
    });
});

describe('the backfill keeps today\'s behaviour', () => {
    it('gives every current holder of an affected ticker their own copy', async () => {
        // Two people hold a ticker somebody had marked kept-at-cost, and a third
        // ticker nobody holds. Re-applying the migration runs the backfill.
        await db.exec(`
            UPDATE assets SET untracked = true, pricing_ticker = 'AAPL.MX' WHERE ticker = 'AAPL';
            INSERT INTO assets (ticker, name, untracked) VALUES ('ORPHAN', 'Nobody holds this', true);
            INSERT INTO positions (user_id, symbol, shares, avg_price) VALUES
                ('${ANA}', 'AAPL', 10, 150), ('${BEN}', 'aapl', 5, 160);
        `);
        expect(await applySql(db, MIGRATION)).toBeNull();

        const rows = (await db.query(
            `SELECT user_id, ticker, untracked, pricing_ticker FROM user_asset_prefs ORDER BY user_id`)).rows;
        expect(rows).toEqual([
            { user_id: ANA, ticker: 'AAPL', untracked: true, pricing_ticker: 'AAPL.MX' },
            { user_id: BEN, ticker: 'AAPL', untracked: true, pricing_ticker: 'AAPL.MX' },
        ]);
    });

    it('can be re-run without duplicating or overwriting a changed choice', async () => {
        await db.exec(`
            UPDATE assets SET untracked = true WHERE ticker = 'AAPL';
            INSERT INTO positions (user_id, symbol, shares, avg_price) VALUES ('${ANA}', 'AAPL', 10, 150);
        `);
        await applySql(db, MIGRATION);
        // Ana re-enables pricing for herself, then the migration is pasted again.
        await asUser(db, 'authenticated', ANA, () => db.query(
            `UPDATE user_asset_prefs SET untracked = false WHERE ticker = 'AAPL'`));
        expect(await applySql(db, MIGRATION)).toBeNull();
        const rows = (await db.query(`SELECT untracked FROM user_asset_prefs`)).rows;
        expect(rows).toEqual([{ untracked: false }]);
    });
});

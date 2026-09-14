import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { buildMigratedDatabase, asUser } from './helpers/pg-harness.js';

/**
 * save_transactions, run against a real Postgres built from the repo's schema
 * and every migration.
 *
 * tests/ledger-save.test.js checks that the client and the migration AGREE, by
 * reading both files. This one checks that the function BEHAVES: that a bad row
 * really rolls the delete back, that row-level security really holds, and that
 * the owner really comes from the session. Those are properties of Postgres,
 * so no amount of reading source can prove them.
 */

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

let db;

beforeAll(async () => {
    db = await buildMigratedDatabase();
    await db.exec(`INSERT INTO auth.users (id) VALUES ('${A}'), ('${B}')`);
}, 60_000);

afterAll(async () => { await db?.close(); });

// Each test starts from an empty ledger. Run as the owner role, which is not
// subject to row-level security, so this really does clear every user.
beforeEach(async () => { await db.exec('TRUNCATE transactions'); });

const save = rows => db.query('SELECT public.save_transactions($1::jsonb) AS n', [JSON.stringify(rows)]);
const visibleCount = async () => (await db.query('SELECT count(*)::int AS c FROM transactions')).rows[0].c;

const buy = (symbol, overrides = {}) => ({
    symbol, type: 'buy', shares: 10, price: 100, total_amount: 1000,
    date: '2026-01-01', currency: 'USD', ...overrides,
});

async function seedTwoRowsForA() {
    await asUser(db, 'authenticated', A, () => save([buy('AAPL'), buy('MSFT')]));
}

describe('save_transactions against a real database', () => {
    it('inserts every row of a good save and returns the count', async () => {
        await asUser(db, 'authenticated', A, async () => {
            const res = await save([buy('AAPL'), buy('MSFT')]);
            expect(res.rows[0].n).toBe(2);
            expect(await visibleCount()).toBe(2);
        });
    });

    it('replaces the ledger rather than appending to it', async () => {
        await seedTwoRowsForA();
        await asUser(db, 'authenticated', A, async () => {
            await save([buy('NVDA')]);
            expect(await visibleCount()).toBe(1);
        });
    });

    it('rolls the delete back when one row violates NOT NULL', async () => {
        // The whole point. The old two-request save committed its DELETE before
        // the INSERT was even sent, so this exact input emptied the ledger.
        await seedTwoRowsForA();
        await asUser(db, 'authenticated', A, async () => {
            await expect(save([buy('AAPL'), buy(null)])).rejects.toThrow();
            expect(await visibleCount()).toBe(2);
        });
    });

    it('rolls the delete back when one row violates the type CHECK', async () => {
        await seedTwoRowsForA();
        await asUser(db, 'authenticated', A, async () => {
            await expect(save([buy('AAPL', { type: 'bogus' })])).rejects.toThrow();
            expect(await visibleCount()).toBe(2);
        });
    });

    it('rolls the delete back on a malformed date', async () => {
        await seedTwoRowsForA();
        await asUser(db, 'authenticated', A, async () => {
            await expect(save([buy('AAPL', { date: 'not-a-date' })])).rejects.toThrow();
            expect(await visibleCount()).toBe(2);
        });
    });

    it('never lets one user see another user\'s ledger', async () => {
        await seedTwoRowsForA();
        await asUser(db, 'authenticated', B, async () => {
            expect(await visibleCount()).toBe(0);
        });
    });

    it('never lets one user\'s save delete another user\'s ledger', async () => {
        await seedTwoRowsForA();
        await asUser(db, 'authenticated', B, () => save([buy('NVDA')]));
        await asUser(db, 'authenticated', A, async () => {
            expect(await visibleCount()).toBe(2);
        });
    });

    it('takes the owner from the session and ignores a user_id in the payload', async () => {
        // B tries to plant a row in A's account by naming A in the JSON.
        await asUser(db, 'authenticated', B, () => save([buy('NVDA', { user_id: A })]));
        const owners = (await db.query(
            'SELECT user_id::text AS u, count(*)::int AS c FROM transactions GROUP BY 1',
        )).rows;
        expect(owners).toEqual([{ u: B, c: 1 }]);
    });

    it('stores jsonb columns intact', async () => {
        await asUser(db, 'authenticated', A, () =>
            save([buy('AAPL', { fx_rates: { EUR: 0.9, USD: 1 } })]));
        const { fx_rates } = (await db.query(`SELECT fx_rates FROM transactions WHERE symbol = 'AAPL'`)).rows[0];
        expect(fx_rates).toEqual({ EUR: 0.9, USD: 1 });
    });

    it('treats an empty array as "the ledger is now empty"', async () => {
        await seedTwoRowsForA();
        await asUser(db, 'authenticated', A, async () => {
            const res = await save([]);
            expect(res.rows[0].n).toBe(0);
            expect(await visibleCount()).toBe(0);
        });
    });

    it('refuses the anonymous role outright', async () => {
        // Supabase would grant EXECUTE to anon at creation; the migration's
        // REVOKE removes it. The harness reproduces the grant, so this proves
        // the REVOKE actually took effect.
        await asUser(db, 'anon', null, async () => {
            await expect(save([buy('AAPL')])).rejects.toThrow(/permission denied/i);
        });
    });

    it('refuses a signed-in role with no user rather than guessing an owner', async () => {
        await asUser(db, 'authenticated', null, async () => {
            await expect(save([buy('AAPL')])).rejects.toThrow(/no authenticated user/);
        });
    });

    it('rejects a payload that is not an array', async () => {
        await asUser(db, 'authenticated', A, async () => {
            await expect(db.query(`SELECT public.save_transactions('{"symbol":"AAPL"}'::jsonb)`))
                .rejects.toThrow(/must be a JSON array/);
        });
    });
});

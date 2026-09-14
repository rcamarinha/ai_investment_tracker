import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The trade ledger save, and the contract between the client and the database
 * function that makes it atomic.
 *
 * saveTransactionsToDB used to send a DELETE of every row for the user, then a
 * bulk INSERT, as two requests. Postgres aborts the whole insert on one bad row
 * — but the delete had already committed. One malformed row could empty the
 * ledger. save_transactions (migration 20260914) does both inside one
 * transaction, so a failed insert rolls the delete back.
 *
 * Every check here reads the SOURCE of both sides rather than restating it,
 * because the dangerous failure is drift between two files that are edited
 * separately and deployed separately — one by Vercel on push, one by hand.
 */

const ROOT = join(import.meta.dirname, '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

const MIGRATION = 'supabase/migrations/20260914_atomic_transactions_save.sql';
const sql = read(MIGRATION);

function saveFunctionSource() {
    const src = read('services/storage.js');
    const start = src.indexOf('export async function saveTransactionsToDB()');
    const end = src.indexOf('export async function loadTransactionsFromDB');
    expect(start, 'saveTransactionsToDB must exist').toBeGreaterThan(-1);
    return src.slice(start, end);
}

// Keys of the object the client pushes for each transaction. Matches both
// `key: value,` and shorthand `key,` — the row builder writes `symbol,` with no
// colon, and a parser that required one silently missed it, which is exactly
// the kind of blind spot that would let a dropped column through.
function clientRowKeys(fnSrc) {
    const push = fnSrc.indexOf('rows.push({');
    const close = fnSrc.indexOf('});', push);
    return [...fnSrc.slice(push, close).matchAll(/^\s*([a-z_]+)\s*(?::|,|$)/gm)].map(m => m[1]);
}

// Columns the function declares for jsonb_to_recordset.
function recordsetColumns() {
    const m = sql.match(/jsonb_to_recordset\(p_rows\)\s+AS\s+r\(([\s\S]*?)\);/);
    expect(m, 'the migration must unpack p_rows with jsonb_to_recordset').toBeTruthy();
    return m[1].split(',').map(c => c.trim().split(/\s+/)[0]).filter(Boolean);
}

describe('save_transactions — the database side', () => {
    it('is SECURITY INVOKER, so row-level security applies to everything it does', () => {
        expect(sql).toMatch(/FUNCTION public\.save_transactions\(p_rows jsonb\)/);
        expect(sql).toMatch(/SECURITY INVOKER/);
        expect(sql, 'SECURITY DEFINER would bypass row-level security').not.toMatch(/SECURITY DEFINER/);
    });

    it('takes the owner from auth.uid(), never from the payload', () => {
        // If user_id were read from the JSON, a client could write into another
        // account. It must come from the session on the server.
        expect(recordsetColumns(), 'user_id must not be declared in the recordset').not.toContain('user_id');
        expect(sql).toMatch(/uid\s+uuid\s*:=\s*auth\.uid\(\)/);
        expect(sql).toMatch(/DELETE FROM public\.transactions WHERE user_id = uid/);
    });

    it('refuses to run without a session', () => {
        expect(sql).toMatch(/IF uid IS NULL THEN\s+RAISE EXCEPTION/);
    });

    it('keeps the anonymous role out entirely', () => {
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.save_transactions\(jsonb\) FROM anon/);
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.save_transactions\(jsonb\) TO authenticated/);
    });

    it('deletes and inserts inside the same function body', () => {
        const body = sql.slice(sql.indexOf('AS $$'), sql.lastIndexOf('$$;'));
        expect(body).toContain('DELETE FROM public.transactions');
        expect(body).toContain('INSERT INTO public.transactions');
    });
});

describe('saveTransactionsToDB — the client side', () => {
    const fn = saveFunctionSource();

    it('calls the function by the exact name and argument the migration defines', () => {
        expect(fn).toContain(".rpc('save_transactions', { p_rows: rows })");
    });

    it('builds every row before it touches the database', () => {
        // The old order deleted first and built second, so a throw while
        // building happened after the ledger was already gone.
        const built = fn.indexOf('rows.push(');
        expect(built).toBeGreaterThan(-1);
        expect(built, 'rows must be built before the rpc call').toBeLessThan(fn.indexOf('.rpc('));
        expect(built, 'rows must be built before any delete').toBeLessThan(fn.indexOf('.delete()'));
    });

    it('falls back to the non-atomic path ONLY when the function is missing', () => {
        // PGRST202 = function not found, i.e. the migration has not been run.
        // Any other error is a real failure of the atomic save; retrying it
        // non-atomically would bring back the exact loss this prevents.
        expect(fn).toMatch(/if \(rpcError\.code !== 'PGRST202'\) throw rpcError;/);
        expect(fn.indexOf("'PGRST202'"), 'the guard must come before the fallback delete')
            .toBeLessThan(fn.indexOf('.delete()'));
    });

    it('records when it had to use the non-atomic fallback', () => {
        expect(fn).toContain("reportDiagnostic('save-transactions-nonatomic'");
    });
});

describe('the two sides agree on every column', () => {
    // jsonb_to_recordset silently IGNORES keys it has no column for. A field
    // added to the client's row builder but not to the function is dropped on
    // every save with no error at all — a silent data loss that no runtime
    // check would ever surface. This is the only thing that catches it.
    const client = clientRowKeys(saveFunctionSource()).filter(k => k !== 'user_id');
    const database = recordsetColumns();

    it('declares a recordset column for every field the client sends', () => {
        const dropped = client.filter(k => !database.includes(k));
        expect(dropped, 'these fields would be silently discarded on every save — add them to the migration').toEqual([]);
    });

    it('sends every column the function inserts', () => {
        const alwaysNull = database.filter(c => !client.includes(c));
        expect(alwaysNull, 'these columns would be written as NULL on every save').toEqual([]);
    });

    it('found a plausible number of columns on both sides', () => {
        // Guards the parsers themselves: an empty match on both sides would make
        // the two checks above pass vacuously.
        expect(client.length).toBeGreaterThanOrEqual(10);
        expect(database.length).toBe(client.length);
    });
});

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// A CHECK constraint is enforced by Postgres, not by the code, so a value the
// app invents that the column does not allow fails at SAVE time — after the
// import has been parsed, verified and shown as ready. That is the worst place
// to find out. markCardSettlements shipped 'auto' against a column allowing
// only rule/ai/manual, and every import died on the last step.
//
// Reads the constraints out of the migrations rather than restating them, so
// this cannot drift from the schema it is protecting.
const root = join(import.meta.dirname, '..');
const sql = readdirSync(join(root, 'supabase/migrations'))
    .filter(f => f.endsWith('.sql'))
    .map(f => readFileSync(join(root, 'supabase/migrations', f), 'utf8'))
    .join('\n');

const src = ['services', 'spend']
    .flatMap(d => readdirSync(join(root, d)).filter(f => f.endsWith('.js'))
        .map(f => readFileSync(join(root, d, f), 'utf8')))
    .join('\n');

const allowedFor = column => {
    const m = new RegExp(`${column}\\s+TEXT[^,]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql);
    return m ? new Set([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])) : null;
};

const assigned = key =>
    [...src.matchAll(new RegExp(`${key}:\\s*'([a-z_]+)'`, 'g'))].map(m => m[1]);

describe('values the app writes satisfy the database CHECK constraints', () => {
    it('reads the constraint out of the migrations', () => {
        expect(allowedFor('category_source')).toEqual(new Set(['rule', 'ai', 'manual']));
    });

    it('never assigns a categorySource the column would reject', () => {
        const allowed = allowedFor('category_source');
        const bad = [...new Set(assigned('categorySource'))].filter(v => !allowed.has(v));
        expect(bad).toEqual([]);
    });

    it('never assigns a sourceRole the column would reject', () => {
        const allowed = allowedFor('source_role');
        if (!allowed) return;
        const bad = [...new Set(assigned('sourceRole'))].filter(v => !allowed.has(v));
        expect(bad).toEqual([]);
    });
});

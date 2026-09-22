import { describe, it, expect } from 'vitest';
import { compareExtraction, compareCategories } from '../services/model-trial.js';
import { __testing } from '../services/telemetry.js';

/**
 * A model on trial is compared with the one in use; only counts and verdicts
 * leave the page. These pin what the comparison counts, and that every figure
 * it reports is on the telemetry allow-list (pickContext drops anything else
 * silently, which would make the trial look healthy while recording nothing).
 */

const row = (date, amount, sourceRole = 'statement', description = 'x') => ({ date, amount, sourceRole, description });
const checked = (rows, chainValid = true, totalOk = true) =>
    ({ rows, chain: { valid: chainValid, checked: rows.length - 1 }, total: { ok: totalOk } });

describe('compareExtraction', () => {
    const real = [row('2026-09-01', -12.5), row('2026-09-02', 2000), row('2026-09-03', -40.1)];

    it('the same rows, worded differently, do not differ', () => {
        const cand = real.map(r => ({ ...r, description: r.description + ' (other wording)' }));
        expect(compareExtraction(checked(real), checked(cand))).toMatchObject({ rowsDiffer: 0, roleChanges: 0, rowsPrimary: 3, rowsCandidate: 3 });
    });

    it('counts a missing row, an extra row and a changed amount', () => {
        const cand = [row('2026-09-01', -12.5), row('2026-09-02', 2000.01), row('2026-09-04', -5)];
        // -40.10 missing, -5 extra, 2000 -> 2000.01 is one out and one in.
        expect(compareExtraction(checked(real), checked(cand)).rowsDiffer).toBe(4);
    });

    it('counts a row whose role changed — detail read as a movement counts money twice', () => {
        const cand = [row('2026-09-01', -12.5, 'detail'), row('2026-09-02', 2000), row('2026-09-03', -40.1)];
        expect(compareExtraction(checked(real), checked(cand))).toMatchObject({ rowsDiffer: 2, roleChanges: 1 });
    });

    it('carries each side\'s balance and total verdicts', () => {
        const r = compareExtraction(checked(real, true, true), checked(real, false, false));
        expect(r).toMatchObject({ chainValidPrimary: true, chainValidCandidate: false, totalOkPrimary: true, totalOkCandidate: false });
    });

    it('reports numbers and yes/no only — never a date, a description or an amount', () => {
        const r = compareExtraction(checked(real), checked(real));
        for (const [k, v] of Object.entries(r)) expect(['number', 'boolean'], k).toContain(typeof v);
        expect(JSON.stringify(r)).not.toMatch(/2026|12\.5|2000|40\.1/);
    });
});

describe('compareCategories', () => {
    it('agreement by id, not position; misses and off-list answers counted', () => {
        const real = [{ id: 'a', category: 'Groceries' }, { id: 'b', category: 'Salary' }, { id: 'c', category: 'Fuel' }];
        const cand = [{ id: 'b', category: 'Salary' }, { id: 'a', category: 'Restaurants' }, { id: 'z', category: 'Crypto' }];
        expect(compareCategories(real, cand, ['Groceries', 'Salary', 'Fuel', 'Restaurants']))
            .toEqual({ compared: 2, agree: 1, missing: 1, outOfList: 1 });
    });
});

describe('everything the trial reports survives the telemetry allow-list', () => {
    it('extraction and categorisation keys are all allowed', () => {
        const allowed = new Set(__testing.ALLOWED_CONTEXT_KEYS);
        const keys = [
            ...Object.keys(compareExtraction(checked([]), checked([]))),
            ...Object.keys(compareCategories([], [], [])),
            'action', 'provider', 'chunks', 'candidateFailed', 'msPrimary', 'msCandidate',
        ];
        for (const k of keys) expect(allowed.has(k), k).toBe(true);
    });
});

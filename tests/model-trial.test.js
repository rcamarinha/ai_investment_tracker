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

describe('compareExtraction edge cases', () => {
    const row = (date, amount, sourceRole = 'statement') => ({ date, amount, sourceRole });
    const checked = (rows, chainValid = true, totalOk = true, chainChecked) =>
        ({ rows, chain: { valid: chainValid, checked: chainChecked ?? rows.length - 1 }, total: { ok: totalOk } });

    it('a row that changes role AND amount is counted as a diff, not as a role change', () => {
        // Role change + amount change = two different keys in both dimensions;
        // the role-change formula (rowsDiffer - moneyDiff) cancels out.
        // This matters because roleChanges specifically catches "detail read as
        // a movement" — a row whose AMOUNT also changed is a plain mismatch.
        const a = [row('2026-09-01', -100, 'statement')];
        const b = [row('2026-09-01', -200, 'detail')];
        const r = compareExtraction(checked(a), checked(b));
        expect(r.rowsDiffer).toBe(2);  // each side has one unique key
        expect(r.roleChanges).toBe(0); // amount differs too — not a clean role change
    });

    it('two rows that swap roles without changing amounts report two role changes', () => {
        const a = [row('2026-09-01', -50, 'statement'), row('2026-09-02', -80, 'detail')];
        const b = [row('2026-09-01', -50, 'detail'), row('2026-09-02', -80, 'statement')];
        const r = compareExtraction(checked(a), checked(b));
        expect(r.rowsDiffer).toBe(4); // two pairs, each with mismatched roles
        expect(r.roleChanges).toBe(2);
    });

    it('reports chainChecked from both sides', () => {
        const rows = [row('2026-09-01', -100), row('2026-09-02', -50)];
        const r = compareExtraction(
            checked(rows, true, true, 2),
            checked(rows, true, true, 1),
        );
        expect(r.chainCheckedPrimary).toBe(2);
        expect(r.chainCheckedCandidate).toBe(1);
    });

    it('chainChecked defaults to 0 when absent, so a missing chain never looks verified', () => {
        // A candidate whose chain object has no "checked" field should NOT
        // inherit a nonzero count from somewhere else.
        const rows = [row('2026-09-01', -100)];
        const r = compareExtraction(
            { rows, chain: {}, total: { ok: true } },
            { rows, chain: undefined, total: { ok: true } },
        );
        expect(r.chainCheckedPrimary).toBe(0);
        expect(r.chainCheckedCandidate).toBe(0);
    });
});

describe('compareCategories edge cases', () => {
    it('empty primary returns all-zeros except outOfList for any out-of-list candidate', () => {
        const r = compareCategories([], [{ id: 'a', category: 'Unknown' }], ['Food']);
        expect(r).toEqual({ compared: 0, agree: 0, missing: 0, outOfList: 1 });
    });

    it('a candidate entirely in-list and an empty primary gives outOfList 0', () => {
        const r = compareCategories([], [{ id: 'a', category: 'Food' }], ['Food']);
        expect(r).toEqual({ compared: 0, agree: 0, missing: 0, outOfList: 0 });
    });

    it('candidate shorter than primary counts the missing rows', () => {
        const primary = [{ id: 'a', category: 'Food' }, { id: 'b', category: 'Salary' }, { id: 'c', category: 'Fuel' }];
        const cand = [{ id: 'a', category: 'Food' }];
        const r = compareCategories(primary, cand, ['Food', 'Salary', 'Fuel']);
        expect(r).toMatchObject({ compared: 1, agree: 1, missing: 2, outOfList: 0 });
    });
});

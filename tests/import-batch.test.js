import { describe, it, expect } from 'vitest';
import { importIsClean, importAddsNothing, summarizeBatch } from '../spend/importer.js';

/**
 * Importing a folder of statements only helps if nothing slips through while
 * nobody is looking. importIsClean is the whole of that judgement: a file that
 * passes saves itself, everything else stops the queue and waits for a person.
 *
 * Every guard here exists because the check it names is the only thing between
 * a wrong row and the ledger — see the import pitfalls in CLAUDE.md.
 */

const clean = () => ({
    isDetail: false,
    fresh: [{ id: 'a', amount: -12.5 }, { id: 'b', amount: 2000 }],
    errors: [],
    chunksFailed: 0,
    flagged: 0,
    cardPlan: [{ group: '042084', action: 'use', accountId: 'card' }],
    chain: { valid: true, checked: 18 },
    total: { ok: true },
    knownLayout: true,
    format: 'pdf',
});

describe('a file may save itself only when every check passed', () => {
    it('accepts a statement that reconciles row by row and as a whole', () => {
        expect(importIsClean(clean())).toBe(true);
    });

    it('stops when the statement does not add up — the check the per-row chain cannot make', () => {
        expect(importIsClean({ ...clean(), total: { ok: false, reason: 'no pair fits' } })).toBe(false);
        expect(importIsClean({ ...clean(), total: null })).toBe(false);
    });

    it('stops when a row failed the running balance, or nothing was checkable', () => {
        expect(importIsClean({ ...clean(), flagged: 1 })).toBe(false);
        expect(importIsClean({ ...clean(), chain: { valid: false, checked: 0 } })).toBe(false);
        expect(importIsClean({ ...clean(), chain: null })).toBe(false);
    });

    it('stops when a row is marked for review', () => {
        const r = clean();
        r.fresh[1].needsReview = true;
        expect(importIsClean(r)).toBe(false);
    });

    it('stops when the import would change the account setup', () => {
        expect(importIsClean({ ...clean(), cardPlan: [{ group: 'x', action: 'create', proposal: {} }] })).toBe(false);
        expect(importIsClean({ ...clean(), cardPlan: [{ group: 'x', action: 'ambiguous', candidates: ['a', 'b'] }] })).toBe(false);
    });

    it('stops on a section that failed or an error, however small', () => {
        expect(importIsClean({ ...clean(), errors: [{ reason: 'section 2 returned nothing' }] })).toBe(false);
        expect(importIsClean({ ...clean(), chunksFailed: 1 })).toBe(false);
    });

    it('stops on a PDF layout nobody has confirmed yet', () => {
        expect(importIsClean({ ...clean(), knownLayout: false })).toBe(false);
        // A CSV's layout was confirmed when its columns were mapped, so the
        // same rule would ask twice.
        expect(importIsClean({ ...clean(), format: 'csv', knownLayout: false })).toBe(true);
    });

    it('never saves a detail file silently: those enrich existing rows', () => {
        expect(importIsClean({ ...clean(), isDetail: true })).toBe(false);
    });

    it('treats an empty result as something to look at, not as success', () => {
        expect(importIsClean({ ...clean(), fresh: [] })).toBe(false);
        expect(importIsClean(null)).toBe(false);
    });
});

// ── What a batch says it did ────────────────────────────────────────────────
//
// The summary is the only thing a person has to go on for files that saved
// themselves, so every outcome has to appear in it — a failed save counted as
// "imported" would be worse than no summary at all.

describe('summarizeBatch', () => {
    const batch = (over = {}) => ({ total: 1, done: 0, rows: 0, already: 0, review: 0, skipped: 0, failed: 0, ...over });

    it('counts statements and the transactions they added', () => {
        expect(summarizeBatch(batch({ done: 9, rows: 412 }))).toBe('9 statements imported (412 transactions).');
        expect(summarizeBatch(batch({ done: 1, rows: 1 }))).toBe('1 statement imported (1 transaction).');
    });

    it('names every other outcome separately, never as "imported"', () => {
        expect(summarizeBatch(batch({ done: 7, rows: 300, already: 2, review: 1, skipped: 1, failed: 1 })))
            .toBe('7 statements imported (300 transactions), 2 already in the ledger, 1 needed a look, 1 skipped, 1 could not be saved or read.');
    });

    it('says plainly when nothing was imported', () => {
        expect(summarizeBatch(batch({ failed: 2 }))).toBe('2 could not be saved or read.');
        expect(summarizeBatch(batch())).toBe('Nothing was imported.');
    });
});

describe('importAddsNothing', () => {
    const base = { isDetail: false, fresh: [], errors: [], flagged: 0, chunksFailed: 0 };

    it('is true for a statement already imported in full — no reason to stop a batch', () => {
        expect(importAddsNothing(base)).toBe(true);
    });

    it('is false when anything happened that a person should see', () => {
        expect(importAddsNothing({ ...base, fresh: [{ id: 'a' }] })).toBe(false);
        expect(importAddsNothing({ ...base, errors: [{ reason: 'section 2 failed' }] })).toBe(false);
        expect(importAddsNothing({ ...base, flagged: 1 })).toBe(false);
        expect(importAddsNothing({ ...base, chunksFailed: 1 })).toBe(false);
        expect(importAddsNothing({ ...base, isDetail: true })).toBe(false);
        expect(importAddsNothing(null)).toBe(false);
    });
});

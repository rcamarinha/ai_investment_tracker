import { describe, it, expect } from 'vitest';
import {
    normalizeRow, validateRow, normalizeRows, isDetailRow,
    REQUIRED_FIELDS, CONTRACT_VERSION
} from '../services/import-contract.js';

const good = { date: '2026-03-05', description: 'Cafe', amount: -2.4, currency: 'EUR' };

describe('normalizeRow', () => {
    it('produces the canonical shape from a minimal row', () => {
        const r = normalizeRow(good);
        expect(r).toMatchObject({
            date: '2026-03-05', description: 'Cafe', rawDescription: 'Cafe',
            amount: -2.4, currency: 'EUR', sourceRole: 'statement',
            merchant: null, category: null, enrichedFrom: null, needsReview: false
        });
    });

    it('rounds amounts to cents', () => {
        expect(normalizeRow({ ...good, amount: -2.40000001 }).amount).toBe(-2.4);
        expect(normalizeRow({ ...good, amount: 1 / 3 }).amount).toBe(0.33);
    });

    it('uppercases and trims the currency', () => {
        expect(normalizeRow({ ...good, currency: ' usd ' }).currency).toBe('USD');
    });

    it('trims the date to 10 chars, so a timestamp becomes a date', () => {
        expect(normalizeRow({ ...good, date: '2026-03-05 09:12:00' }).date).toBe('2026-03-05');
    });

    it('seeds rawDescription from description when the adapter has only one', () => {
        expect(normalizeRow(good).rawDescription).toBe('Cafe');
    });

    it('keeps a distinct rawDescription when the adapter supplies one', () => {
        const r = normalizeRow({ ...good, description: 'Pingo Doce', rawDescription: 'COMPRA MBWAY' });
        expect(r).toMatchObject({ description: 'Pingo Doce', rawDescription: 'COMPRA MBWAY' });
    });

    it('leaves an unparseable amount as null rather than defaulting it', () => {
        // A silently defaulted amount is how wrong money enters a ledger.
        expect(normalizeRow({ ...good, amount: 'not a number' }).amount).toBeNull();
        expect(normalizeRow({ ...good, amount: undefined }).amount).toBeNull();
    });

    it('leaves a non-string date as null rather than coercing it', () => {
        expect(normalizeRow({ ...good, date: 20260305 }).date).toBeNull();
        expect(normalizeRow({ ...good, date: null }).date).toBeNull();
    });

    it('only accepts the two known source roles', () => {
        expect(normalizeRow({ ...good, sourceRole: 'detail' }).sourceRole).toBe('detail');
        expect(normalizeRow({ ...good, sourceRole: 'nonsense' }).sourceRole).toBe('statement');
        expect(normalizeRow(good).sourceRole).toBe('statement');
    });

    it('carries a running balance as optional transport', () => {
        expect(normalizeRow({ ...good, balance: '1200' }).balance).toBe(1200);
        expect(normalizeRow(good).balance).toBeNull();
    });

    it('keeps "no balance shown" distinct from "balance is zero"', () => {
        // Number(null) is 0 and passes isFinite, so an absent balance would
        // otherwise enter the continuity check as a real zero — raising false
        // alarms, or hiding a genuine break.
        expect(normalizeRow({ ...good, balance: null }).balance).toBeNull();
        expect(normalizeRow({ ...good, balance: undefined }).balance).toBeNull();
        expect(normalizeRow({ ...good, balance: '' }).balance).toBeNull();
        expect(normalizeRow({ ...good, balance: 0 }).balance).toBe(0);
    });

    it('applies defaults without letting them override the row', () => {
        const r = normalizeRow({ ...good, currency: 'GBP' }, { accountId: 'a1', currency: 'EUR' });
        expect(r.accountId).toBe('a1');
        expect(r.currency).toBe('GBP');
    });

    it('falls back to a placeholder description rather than an empty string', () => {
        expect(normalizeRow({ ...good, description: '   ' }).description).toBe('(no description)');
    });

    it('defaults detailGroup and expandedFrom to null', () => {
        const r = normalizeRow(good);
        expect(r.detailGroup).toBeNull();
        expect(r.expandedFrom).toBeNull();
    });

    it('passes through detailGroup and expandedFrom when supplied', () => {
        // These are set by the card-expansion path to track which settlement a
        // purchase came from. Losing them on normalisation would drop the
        // information needed to match a row back to its original card section.
        const r = normalizeRow({ ...good, detailGroup: 'bkcf', expandedFrom: 'Cartoes bkcf deb' });
        expect(r.detailGroup).toBe('bkcf');
        expect(r.expandedFrom).toBe('Cartoes bkcf deb');
    });
});

describe('validateRow', () => {
    it('accepts a well-formed row', () => {
        expect(validateRow(normalizeRow(good))).toEqual({ ok: true, errors: [] });
    });

    it('rejects a malformed or impossible date', () => {
        expect(validateRow(normalizeRow({ ...good, date: '05-03-2026' })).errors).toContain('date must be YYYY-MM-DD');
        expect(validateRow(normalizeRow({ ...good, date: '2026-02-31' })).ok).toBe(false);
        expect(validateRow(normalizeRow({ ...good, date: '2026-13-01' })).ok).toBe(false);
    });

    it('accepts a leap day in a leap year', () => {
        expect(validateRow(normalizeRow({ ...good, date: '2028-02-29' })).ok).toBe(true);
    });

    it('rejects a zero amount as a parse artefact', () => {
        // Almost always a mis-mapped column or a header read as data.
        expect(validateRow(normalizeRow({ ...good, amount: 0 })).errors).toContain('amount is zero');
    });

    it('rejects a non-ISO currency', () => {
        expect(validateRow(normalizeRow({ ...good, currency: 'Euro' })).ok).toBe(false);
        expect(validateRow(normalizeRow({ ...good, currency: '€' })).ok).toBe(false);
    });

    it('reports every problem at once, not just the first', () => {
        const r = validateRow(normalizeRow({ date: 'nope', amount: 'nope', currency: 'nope', description: '' }));
        expect(r.errors.length).toBeGreaterThanOrEqual(3);
    });
});

describe('normalizeRows', () => {
    it('partitions rather than failing the whole batch', () => {
        // One bad line in a 900-row statement must not cost the other 899.
        const { rows, rejected } = normalizeRows([
            good,
            { ...good, amount: 'x' },
            { ...good, description: 'Uber', amount: -8.9 }
        ]);
        expect(rows).toHaveLength(2);
        expect(rejected).toHaveLength(1);
    });

    it('reports the original index and reason for each reject', () => {
        const { rejected } = normalizeRows([good, { ...good, date: 'nope' }]);
        expect(rejected[0].index).toBe(1);
        expect(rejected[0].reasons).toContain('date must be YYYY-MM-DD');
        expect(rejected[0].source).toBeDefined();
    });

    it('applies shared defaults across the batch', () => {
        const { rows } = normalizeRows([good, good], { accountId: 'a1', source: 'ofx' });
        expect(rows.every(r => r.accountId === 'a1' && r.source === 'ofx')).toBe(true);
    });

    it('handles an empty batch', () => {
        expect(normalizeRows([])).toEqual({ rows: [], rejected: [] });
    });
});

describe('contract surface', () => {
    it('names the fields an adapter must supply', () => {
        expect(REQUIRED_FIELDS).toEqual(['date', 'description', 'amount', 'currency']);
        expect(CONTRACT_VERSION).toBe(1);
    });

    it('identifies enrichment rows', () => {
        expect(isDetailRow(normalizeRow({ ...good, sourceRole: 'detail' }))).toBe(true);
        expect(isDetailRow(normalizeRow(good))).toBe(false);
        expect(isDetailRow(null)).toBe(false);
    });
});

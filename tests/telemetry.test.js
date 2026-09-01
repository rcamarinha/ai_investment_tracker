import { describe, it, expect } from 'vitest';
import { redact, __testing } from '../services/telemetry.js';

describe('redact — no financial detail may leave the browser', () => {
    it('removes amounts in either decimal convention', () => {
        // Errors quote what they were processing, and what this app processes
        // is a ledger. Redaction happens before the string leaves the browser.
        expect(redact('Failed on 1.234,56')).toBe('Failed on «amount»');
        expect(redact('Failed on 1,234.56')).toBe('Failed on «amount»');
        expect(redact('charge of €12,40 rejected')).toContain('«amount»');
        expect(redact('charge of 12.40 rejected')).toContain('«amount»');
    });

    it('removes IBANs and long reference digits', () => {
        expect(redact('PT50 0033 0000 4567 8912 3456 7 failed')).toContain('«iban»');
        expect(redact('ref 4321987654 declined')).toContain('«digits»');
    });

    it('keeps the part that makes an error diagnosable', () => {
        const out = redact('Could not save: duplicate key on spend_transactions');
        expect(out).toContain('duplicate key');
        expect(out).toContain('spend_transactions');
    });

    it('truncates a runaway message', () => {
        expect(redact('x'.repeat(5000)).length).toBeLessThanOrEqual(500);
    });

    it('handles nothing at all', () => {
        expect(redact(null)).toBe('');
        expect(redact(undefined)).toBe('');
    });
});

describe('context is allow-listed, not free-form', () => {
    const { pickContext } = __testing;

    it('keeps only the declared diagnostic keys', () => {
        expect(pickContext({ action: 'import', chunks: 9, chunksFailed: 2 }))
            .toEqual({ action: 'import', chunks: 9, chunksFailed: 2 });
    });

    it('drops anything not on the list, however useful it looks', () => {
        // A caller passing a transaction would otherwise ship a bank
        // description and an amount into the errors table.
        expect(pickContext({ description: 'COMPRAS C.DEB UBER', amount: -8.9, iban: 'PT50…' }))
            .toEqual({});
    });

    it('refuses nested objects, which could carry a whole row', () => {
        expect(pickContext({ action: 'import', rows: { id: 1, amount: -8.9 } }))
            .toEqual({ action: 'import' });
    });

    it('survives junk input', () => {
        expect(pickContext(null)).toEqual({});
        expect(pickContext('nope')).toEqual({});
    });
});

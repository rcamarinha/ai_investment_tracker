import { describe, it, expect } from 'vitest';
import {
    normalizeCurrencyCode, normalizeQuote, convert,
    shouldOverwriteCurrency, MINOR_UNIT_CODES,
} from '../services/money-core.js';

// ECB/Frankfurter-shaped table: 1 EUR = X units of CUR
const TABLE = { USD: 1.10, GBP: 0.85, CHF: 0.95 };

describe('normalizeCurrencyCode', () => {
    // The case that mattered: providers send the LITERAL "GBp". The old code
    // uppercased first, turning pence into pounds at subunit 1 — a silent 100x.
    it('recognizes pence in every casing providers actually send', () => {
        for (const raw of ['GBp', 'GBX', 'gbx', 'gbp.', 'GBP.', 'GBPX']) {
            expect(normalizeCurrencyCode(raw)).toEqual({ iso: 'GBP', factor: 0.01 });
        }
    });

    it('recognizes other minor units', () => {
        expect(normalizeCurrencyCode('ZAc')).toEqual({ iso: 'ZAR', factor: 0.01 });
        expect(normalizeCurrencyCode('ILA')).toEqual({ iso: 'ILS', factor: 0.01 });
    });

    it('passes plain ISO codes through at factor 1, case-insensitively', () => {
        expect(normalizeCurrencyCode('EUR')).toEqual({ iso: 'EUR', factor: 1 });
        expect(normalizeCurrencyCode('usd')).toEqual({ iso: 'USD', factor: 1 });
        expect(normalizeCurrencyCode(' chf ')).toEqual({ iso: 'CHF', factor: 1 });
    });

    // "We don't know" must stay distinguishable from "it's fine".
    it('returns null for unknown/absent codes rather than guessing', () => {
        for (const bad of ['', '   ', null, undefined, 'EUROS', 'E', '12A', 0]) {
            expect(normalizeCurrencyCode(bad)).toBeNull();
        }
    });

    it('does not leak its internal table to callers', () => {
        const a = normalizeCurrencyCode('GBX');
        a.factor = 999;
        expect(MINOR_UNIT_CODES.GBX.factor).toBe(0.01);
    });
});

describe('normalizeQuote', () => {
    it('folds a London pence quote to pounds (the Yahoo "GBp" case)', () => {
        expect(normalizeQuote({ price: 5052, currency: 'GBp' }))
            .toEqual({ price: 50.52, currency: 'GBP' });
    });

    it('leaves major-unit quotes untouched', () => {
        expect(normalizeQuote({ price: 50.52, currency: 'EUR' }))
            .toEqual({ price: 50.52, currency: 'EUR' });
    });

    it('returns null when the currency is unusable or the price is not numeric', () => {
        expect(normalizeQuote({ price: 100, currency: 'EUROS' })).toBeNull();
        expect(normalizeQuote({ price: 100, currency: null })).toBeNull();
        expect(normalizeQuote({ price: 'abc', currency: 'EUR' })).toBeNull();
        expect(normalizeQuote(null)).toBeNull();
    });
});

describe('convert', () => {
    it('converts across currencies via the EUR-based table', () => {
        expect(convert(100, 'EUR', 'USD', TABLE)).toBeCloseTo(110, 10);
        expect(convert(110, 'USD', 'EUR', TABLE)).toBeCloseTo(100, 10);
        expect(convert(100, 'GBP', 'USD', TABLE)).toBeCloseTo(100 * (1.10 / 0.85), 10);
    });

    it('folds minor units before converting (pence, not pounds)', () => {
        // 100 pence = £1 = €1/0.85
        expect(convert(100, 'GBp', 'EUR', TABLE)).toBeCloseTo(1 / 0.85, 10);
        expect(convert(100, 'GBX', 'EUR', TABLE)).toBeCloseTo(convert(100, 'GBp', 'EUR', TABLE), 12);
    });

    it('is identity (after minor-unit folding) when source and target match', () => {
        expect(convert(42, 'EUR', 'EUR', TABLE)).toBe(42);
        expect(convert(500, 'GBp', 'GBP', TABLE)).toBeCloseTo(5, 10);
    });

    // THE regression test for the old `return amount` fallback in
    // toBaseCurrency: an unconvertible amount must never masquerade as converted.
    it('returns null — NOT the input — when the rate is missing', () => {
        const out = convert(100, 'GBP', 'EUR', {});
        expect(out).toBeNull();
        expect(out).not.toBe(100);
    });

    it('returns null for malformed codes on either side', () => {
        expect(convert(100, 'EUROS', 'EUR', TABLE)).toBeNull();
        expect(convert(100, 'EUR', 'EUROS', TABLE)).toBeNull();
        expect(convert(100, null, 'EUR', TABLE)).toBeNull();
    });

    // A well-formed but unrecognized code is accepted as ISO-shaped (we keep no
    // whitelist) and fails at the RATE lookup instead — still null, never a guess.
    it('returns null for a well-formed code with no rate', () => {
        expect(convert(100, 'WAT', 'EUR', TABLE)).toBeNull();
    });

    it('returns null for a non-numeric amount or a zero/negative rate', () => {
        expect(convert('abc', 'USD', 'EUR', TABLE)).toBeNull();
        expect(convert(100, 'USD', 'EUR', { USD: 0 })).toBeNull();
        expect(convert(100, 'USD', 'EUR', { USD: -1 })).toBeNull();
    });
});

describe('shouldOverwriteCurrency', () => {
    // The assets.currency race: buildAssetRecord infers from the ticker suffix
    // on EVERY refresh, and used to clobber the provider-reported value.
    it('never lets a suffix guess overwrite a better source', () => {
        expect(shouldOverwriteCurrency('suffix', 'quote')).toBe(false);
        expect(shouldOverwriteCurrency('suffix', 'profile')).toBe(false);
        expect(shouldOverwriteCurrency('suffix', 'user')).toBe(false);
    });

    it('lets a user override win over everything', () => {
        for (const stored of ['suffix', 'profile', 'quote', 'user']) {
            expect(shouldOverwriteCurrency('user', stored)).toBe(true);
        }
    });

    it('lets a quote beat a profile and a suffix', () => {
        expect(shouldOverwriteCurrency('quote', 'profile')).toBe(true);
        expect(shouldOverwriteCurrency('quote', 'suffix')).toBe(true);
        expect(shouldOverwriteCurrency('quote', 'user')).toBe(false);
    });

    it('allows a same-rank refresh and rejects unknown sources', () => {
        expect(shouldOverwriteCurrency('profile', 'profile')).toBe(true);
        expect(shouldOverwriteCurrency('nonsense', 'suffix')).toBe(false);
        expect(shouldOverwriteCurrency(undefined, 'suffix')).toBe(false);
    });
});

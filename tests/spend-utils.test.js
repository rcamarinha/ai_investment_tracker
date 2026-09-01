/**
 * Tests for spend/utils.js and holdings/utils.js — pure formatting utilities
 * shared across the Spend and Bank Holdings modules.
 *
 * Both files are intentionally identical copies (self-contained so each module
 * is independently extractable). We test spend/utils.js for coverage; the same
 * logic applies to holdings/utils.js.
 *
 * DOM-dependent exports (showToast, openModal, closeModal, showConfirm) are
 * excluded — they need a browser environment.
 */
import { describe, it, expect } from 'vitest';
import {
    escapeHTML, fmtMoney, fmtCompact, fmtPct, fmtDate, fmtPeriod,
    deltaClass, accountColour,
} from '../spend/utils.js';
import { typeColour } from '../holdings/utils.js';

// ── escapeHTML ────────────────────────────────────────────────────────────────

describe('escapeHTML', () => {
    it('returns an empty string for null or undefined', () => {
        expect(escapeHTML(null)).toBe('');
        expect(escapeHTML(undefined)).toBe('');
    });

    it('escapes the five dangerous characters', () => {
        expect(escapeHTML('<script>&"\'</script>')).toBe(
            '&lt;script&gt;&amp;&quot;&#x27;&lt;/script&gt;'
        );
    });

    it('leaves plain strings untouched', () => {
        expect(escapeHTML('hello world')).toBe('hello world');
    });

    it('coerces non-strings', () => {
        expect(escapeHTML(42)).toBe('42');
    });
});

// ── fmtMoney ─────────────────────────────────────────────────────────────────

describe('fmtMoney', () => {
    it('returns — for non-finite values', () => {
        expect(fmtMoney(NaN)).toBe('—');
        expect(fmtMoney(Infinity)).toBe('—');
        expect(fmtMoney(undefined)).toBe('—');
    });

    it('formats EUR with two decimal places (pt-PT locale)', () => {
        const result = fmtMoney(1234.56);
        expect(result).toContain('1');
        expect(result).toContain('234');
        expect(result).toContain('€');
    });

    it('respects the opts.decimals override', () => {
        const result = fmtMoney(10, 'EUR', { decimals: 0 });
        expect(result).not.toContain(',');  // no decimal separator
    });
});

// ── fmtCompact ───────────────────────────────────────────────────────────────

describe('fmtCompact', () => {
    it('returns — for non-finite input', () => {
        expect(fmtCompact(NaN)).toBe('—');
        expect(fmtCompact(Infinity)).toBe('—');
    });

    it('uses full fmtMoney formatting below 10 000', () => {
        // Under the threshold it delegates to fmtMoney (not k/M notation)
        const result = fmtCompact(9999, 'EUR');
        expect(result).not.toContain('k');
        expect(result).not.toContain('M');
        expect(result).toContain('€');
    });

    it('switches to k notation at exactly 10 000', () => {
        const result = fmtCompact(10000, 'EUR');
        expect(result).toContain('k');
    });

    it('uses one decimal for values 10 000–99 999', () => {
        // e.g. 16 000 → "16,0k €"
        const result = fmtCompact(16000, 'EUR');
        expect(result).toMatch(/\d+,\d+k/);
    });

    it('uses zero decimals for values 100 000–999 999', () => {
        // e.g. 150 000 → "150k €"
        const result = fmtCompact(150000, 'EUR');
        expect(result).toMatch(/\d+k/);
        expect(result).not.toMatch(/\d+,\d+k/);
    });

    it('switches to M notation from 1 000 000', () => {
        const result = fmtCompact(1500000, 'EUR');
        expect(result).toContain('M');
        expect(result).not.toContain('k');
    });

    it('preserves sign for negative values', () => {
        const result = fmtCompact(-50000, 'EUR');
        expect(result).toMatch(/^-/);
        expect(result).toContain('k');
    });

    it('uses the correct currency symbol', () => {
        expect(fmtCompact(20000, 'USD')).toContain('$');
        expect(fmtCompact(20000, 'GBP')).toContain('£');
    });
});

// ── fmtPct ────────────────────────────────────────────────────────────────────

describe('fmtPct', () => {
    it('returns — for non-finite values', () => {
        expect(fmtPct(NaN)).toBe('—');
    });

    it('formats a decimal fraction as a percentage string', () => {
        expect(fmtPct(0.15)).toBe('15%');
        expect(fmtPct(0.155)).toBe('15.5%');
    });

    it('strips trailing .0 from whole percentages', () => {
        expect(fmtPct(0.2)).toBe('20%');
    });

    it('prepends + for positive values when signed = true', () => {
        expect(fmtPct(0.05, { signed: true })).toBe('+5%');
        expect(fmtPct(-0.05, { signed: true })).toBe('-5%');
    });

    it('appends " pts" suffix when points = true', () => {
        expect(fmtPct(0.03, { points: true })).toBe('3 pts');
    });
});

// ── fmtDate ──────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
    it('converts ISO date to DD/MM', () => {
        expect(fmtDate('2026-08-15')).toBe('15/08');
    });

    it('trims a datetime string to the date portion', () => {
        expect(fmtDate('2026-08-15T14:30:00Z')).toBe('15/08');
    });

    it('returns the raw string when it is not an ISO date', () => {
        expect(fmtDate('invalid')).toBe('invalid');
    });

    it('handles null/undefined gracefully', () => {
        expect(fmtDate(null)).toBe('');
        expect(fmtDate(undefined)).toBe('');
    });
});

// ── fmtPeriod ────────────────────────────────────────────────────────────────

describe('fmtPeriod', () => {
    it('returns — for a falsy key', () => {
        expect(fmtPeriod(null)).toBe('—');
        expect(fmtPeriod('')).toBe('—');
    });

    it('formats a monthly key as "Mon YYYY"', () => {
        expect(fmtPeriod('2026-08')).toBe('Aug 2026');
        expect(fmtPeriod('2026-01')).toBe('Jan 2026');
    });

    it('formats a yearly key as the year itself', () => {
        expect(fmtPeriod('2026', 'year')).toBe('2026');
    });

    it('formats a quarterly key as "QN YYYY"', () => {
        expect(fmtPeriod('2026-Q3', 'quarter')).toBe('Q3 2026');
        expect(fmtPeriod('2025-Q1', 'quarter')).toBe('Q1 2025');
    });
});

// ── deltaClass ───────────────────────────────────────────────────────────────

describe('deltaClass', () => {
    it('returns "flat" for zero', () => {
        expect(deltaClass(0)).toBe('flat');
    });

    it('returns "flat" for non-finite values', () => {
        expect(deltaClass(NaN)).toBe('flat');
        expect(deltaClass(Infinity)).toBe('flat');
    });

    it('positive delta is "up" by default (higher earnings is good)', () => {
        expect(deltaClass(100)).toBe('up');
    });

    it('negative delta is "down" by default', () => {
        expect(deltaClass(-100)).toBe('down');
    });

    it('negative delta is "up" when lowerIsBetter (spending less is good)', () => {
        expect(deltaClass(-50, true)).toBe('up');
    });

    it('positive delta is "down" when lowerIsBetter (spending more is bad)', () => {
        expect(deltaClass(50, true)).toBe('down');
    });
});

// ── accountColour ─────────────────────────────────────────────────────────────

describe('accountColour', () => {
    it('returns a deterministic hex colour for a given account id', () => {
        const c1 = accountColour('acc-123');
        const c2 = accountColour('acc-123');
        expect(c1).toBe(c2);
    });

    it('returns a different colour for different account ids (most of the time)', () => {
        // Not 100% guaranteed by pigeonhole but very likely for distinct UUIDs
        const colours = new Set(
            Array.from({ length: 20 }, (_, i) => accountColour(`acc-${i}`))
        );
        expect(colours.size).toBeGreaterThan(1);
    });

    it('returns the first colour when accountId is falsy', () => {
        // Falsy → falls back to ACCOUNT_COLOURS[0]
        const fallback = accountColour('');
        const direct   = accountColour(null);
        expect(fallback).toBe(direct);
    });

    it('always returns a CSS hex colour', () => {
        expect(accountColour('any-id')).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
});

// ── typeColour (holdings/utils.js) ───────────────────────────────────────────

describe('typeColour', () => {
    it('returns a unique colour for each known holding type', () => {
        const types = ['bond', 'fund', 'deposit', 'structured', 'other'];
        const colours = types.map(typeColour);
        expect(new Set(colours).size).toBe(types.length);
    });

    it('falls back to the "other" colour for unknown types', () => {
        expect(typeColour('unknown')).toBe(typeColour('other'));
    });

    it('always returns a CSS hex colour', () => {
        expect(typeColour('bond')).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
});

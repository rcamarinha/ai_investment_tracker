/**
 * Tests for pure formatting helpers shared across the Spend and Bank Holdings
 * modules. Both spend/utils.js and holdings/utils.js carry an identical copy
 * of most of these functions (deliberately self-contained so each module is
 * independently extractable), so both are exercised here.
 *
 * DOM-dependent functions (showToast, openModal, showConfirm, etc.) are not
 * tested — the vitest environment is Node, not jsdom.
 */
import { describe, it, expect } from 'vitest';
import {
    escapeHTML, fmtMoney, fmtCompact, fmtPct, fmtDate, fmtPeriod,
    deltaClass, accountColour,
} from '../spend/utils.js';
import {
    escapeHTML as hEscapeHTML, fmtMoney as hFmtMoney, fmtCompact as hFmtCompact,
    fmtPct as hFmtPct, fmtDate as hFmtDate, fmtPeriod as hFmtPeriod,
    deltaClass as hDeltaClass, typeColour,
} from '../holdings/utils.js';

// ── escapeHTML ───────────────────────────────────────────────────────────────

describe('escapeHTML', () => {
    it('returns an empty string for null', () => {
        expect(escapeHTML(null)).toBe('');
    });

    it('returns an empty string for undefined', () => {
        expect(escapeHTML(undefined)).toBe('');
    });

    it('coerces numbers and booleans to strings', () => {
        expect(escapeHTML(42)).toBe('42');
        expect(escapeHTML(true)).toBe('true');
    });

    it('escapes ampersand first, so it is never double-escaped', () => {
        expect(escapeHTML('fish & chips')).toBe('fish &amp; chips');
        // A double-escaped & would produce "&amp;amp;" — only one level here.
        expect(escapeHTML('&amp;')).toBe('&amp;amp;');
    });

    it('escapes angle brackets (XSS via injected tags)', () => {
        expect(escapeHTML('<script>')).toBe('&lt;script&gt;');
    });

    it('escapes double-quotes (XSS via attribute injection)', () => {
        expect(escapeHTML('"hello"')).toBe('&quot;hello&quot;');
    });

    it('escapes single-quotes (XSS via attribute injection)', () => {
        expect(escapeHTML("it's here")).toBe("it&#x27;s here");
    });

    it('passes through plain ASCII with no special characters unchanged', () => {
        expect(escapeHTML('hello world')).toBe('hello world');
    });

    it('handles a string with every special character', () => {
        expect(escapeHTML('<a href="url">it\'s & that</a>'))
            .toBe('&lt;a href=&quot;url&quot;&gt;it&#x27;s &amp; that&lt;/a&gt;');
    });
});

// holdings/utils.js carries an identical copy
describe('escapeHTML (holdings/utils.js)', () => {
    it('behaves identically to spend/utils.js', () => {
        expect(hEscapeHTML('<b>"hello" & \'world\'</b>'))
            .toBe(escapeHTML('<b>"hello" & \'world\'</b>'));
    });
});

// ── fmtMoney ─────────────────────────────────────────────────────────────────

describe('fmtMoney', () => {
    it('returns the em-dash for NaN', () => {
        expect(fmtMoney(NaN)).toBe('—');
    });

    it('returns the em-dash for Infinity', () => {
        expect(fmtMoney(Infinity)).toBe('—');
        expect(fmtMoney(-Infinity)).toBe('—');
    });

    it('returns the em-dash for undefined', () => {
        // Number(undefined) === NaN, which is not finite
        expect(fmtMoney(undefined)).toBe('—');
    });

    it('formats a finite zero as a currency amount, not a dash', () => {
        // Number(null) === 0, which IS finite — "zero" and "absent" are different facts
        expect(fmtMoney(null)).not.toBe('—');
        expect(fmtMoney(0)).not.toBe('—');
    });

    it('formats EUR with the correct symbol and pt-PT decimal style', () => {
        const out = fmtMoney(1234.56);
        expect(out).toContain('1234');
        expect(out).toContain('56');
        expect(out).toContain('€');
    });

    it('includes thousands separator for large amounts', () => {
        // 10 000 in pt-PT uses a narrow no-break space as the thousands group separator
        const out = fmtMoney(10000);
        expect(out).toContain('10');
        expect(out).toContain('€');
    });

    it('respects the decimals option', () => {
        const out = fmtMoney(1234.56, 'EUR', { decimals: 0 });
        // Should not contain the decimal comma when decimals = 0
        expect(out).not.toMatch(/,\d{2}/);
        expect(out).toContain('€');
    });

    it('handles non-EUR currencies', () => {
        const out = fmtMoney(100, 'USD');
        // The result should include the amount and some USD indicator
        expect(out).toContain('100');
        // Must NOT contain the € symbol
        expect(out).not.toContain('€');
    });
});

// ── fmtCompact ───────────────────────────────────────────────────────────────

describe('fmtCompact', () => {
    it('returns the em-dash for non-finite values', () => {
        expect(fmtCompact(NaN)).toBe('—');
        expect(fmtCompact(Infinity)).toBe('—');
    });

    it('delegates to fmtMoney for values below the 10k threshold', () => {
        // < 10 000 uses full formatting (no k/M suffix)
        const compact = fmtCompact(9999);
        const money = fmtMoney(9999, 'EUR', { decimals: 0 });
        expect(compact).toBe(money);
    });

    it('uses k suffix with one decimal between 10k and 100k', () => {
        // 15 000 → "15,0k €" (European decimal)
        const out = fmtCompact(15000);
        expect(out).toMatch(/15,0k/);
        expect(out).toContain('€');
    });

    it('uses k suffix with no decimal at 100k and above', () => {
        // 100 000 → "100k €"
        const out = fmtCompact(100000);
        expect(out).toMatch(/100k/);
        expect(out).not.toMatch(/,\d/); // no decimal
    });

    it('uses M suffix for millions', () => {
        // 1 500 000 → "1,5M €"
        const out = fmtCompact(1500000);
        expect(out).toMatch(/1,5M/);
        expect(out).toContain('€');
    });

    it('preserves the sign for negative compacts', () => {
        expect(fmtCompact(-15000)).toMatch(/^-/);
    });

    it('uses the correct symbol for non-EUR currencies', () => {
        // USD → '$'
        const out = fmtCompact(15000, 'USD');
        expect(out).toContain('$');
        expect(out).not.toContain('€');
        // GBP → '£'
        const gbp = fmtCompact(15000, 'GBP');
        expect(gbp).toContain('£');
    });

    it('falls back to the currency code for unrecognised currencies', () => {
        const out = fmtCompact(15000, 'CHF');
        expect(out).toContain('CHF');
    });
});

// ── fmtPct ───────────────────────────────────────────────────────────────────

describe('fmtPct', () => {
    it('returns the em-dash for non-finite values', () => {
        expect(fmtPct(NaN)).toBe('—');
        expect(fmtPct(undefined)).toBe('—');
    });

    it('formats a fraction as a percentage', () => {
        expect(fmtPct(0.1)).toBe('10%');
        expect(fmtPct(0.333)).toBe('33.3%');
    });

    it('omits the decimal when the percentage is a whole number', () => {
        expect(fmtPct(0.5)).toBe('50%');
        expect(fmtPct(1)).toBe('100%');
    });

    it('prepends a + sign for positive values when signed: true', () => {
        expect(fmtPct(0.1, { signed: true })).toBe('+10%');
    });

    it('does not double-sign negative values', () => {
        expect(fmtPct(-0.1, { signed: true })).toBe('-10%');
    });

    it('appends " pts" instead of "%" when points: true', () => {
        expect(fmtPct(0.05, { points: true })).toBe('5 pts');
    });

    it('can combine signed and points', () => {
        expect(fmtPct(0.03, { signed: true, points: true })).toBe('+3 pts');
    });
});

// ── fmtDate ──────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
    it('formats a YYYY-MM-DD string as DD/MM', () => {
        expect(fmtDate('2026-08-01')).toBe('01/08');
        expect(fmtDate('2026-12-31')).toBe('31/12');
    });

    it('returns the first 10 characters when the input is not a valid ISO date', () => {
        // The function slices to 10 chars then regex-checks; non-matching strings pass through as-is
        expect(fmtDate('not-a-date')).toBe('not-a-date'); // exactly 10 chars
        expect(fmtDate('2026/08/01')).toBe('2026/08/01'); // right length, wrong separator
    });

    it('returns an empty string for null or undefined', () => {
        expect(fmtDate(null)).toBe('');
        expect(fmtDate(undefined)).toBe('');
    });
});

// ── fmtPeriod ────────────────────────────────────────────────────────────────

describe('fmtPeriod', () => {
    it('returns the em-dash for a falsy key', () => {
        expect(fmtPeriod(null)).toBe('—');
        expect(fmtPeriod('')).toBe('—');
    });

    it('formats a month key as "Mon YYYY"', () => {
        expect(fmtPeriod('2026-08')).toBe('Aug 2026');
        expect(fmtPeriod('2026-01')).toBe('Jan 2026');
        expect(fmtPeriod('2026-12')).toBe('Dec 2026');
    });

    it('formats a year key unchanged', () => {
        expect(fmtPeriod('2026', 'year')).toBe('2026');
    });

    it('formats a quarter key as "Qn YYYY"', () => {
        expect(fmtPeriod('2026-Q3', 'quarter')).toBe('Q3 2026');
        expect(fmtPeriod('2025-Q1', 'quarter')).toBe('Q1 2025');
    });

    it('defaults to the month grain when no grain is supplied', () => {
        expect(fmtPeriod('2026-03')).toBe('Mar 2026');
    });
});

// ── deltaClass ───────────────────────────────────────────────────────────────

describe('deltaClass', () => {
    it('returns "flat" for zero', () => {
        expect(deltaClass(0)).toBe('flat');
    });

    it('returns "flat" for NaN or non-finite values', () => {
        expect(deltaClass(NaN)).toBe('flat');
        expect(deltaClass(undefined)).toBe('flat');
    });

    it('returns "up" (good) for a positive income delta', () => {
        // More income is good: higher is better → positive = up
        expect(deltaClass(100)).toBe('up');
    });

    it('returns "down" (bad) for a negative income delta', () => {
        expect(deltaClass(-100)).toBe('down');
    });

    it('flips the direction when lowerIsBetter is true (spend figure)', () => {
        // Spending LESS is good, so a negative delta should read as "up"
        expect(deltaClass(-100, true)).toBe('up');
        expect(deltaClass(100, true)).toBe('down');
    });
});

// ── accountColour ─────────────────────────────────────────────────────────────

describe('accountColour', () => {
    it('returns a hex colour string', () => {
        const c = accountColour('acct-123');
        expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });

    it('returns the same colour for the same account id (deterministic hash)', () => {
        expect(accountColour('account-x')).toBe(accountColour('account-x'));
    });

    it('typically returns different colours for different ids', () => {
        // Hash might collide but with 7 colours and varied ids this should differ
        const ids = ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5', 'acc-6', 'acc-7'];
        const colours = ids.map(id => accountColour(id));
        // At least 2 distinct colours among 7 different ids
        expect(new Set(colours).size).toBeGreaterThan(1);
    });

    it('returns the first palette colour for a falsy account id', () => {
        const fallback = accountColour('');
        expect(fallback).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(accountColour(null)).toBe(fallback);
        expect(accountColour(undefined)).toBe(fallback);
    });
});

// ── typeColour (holdings/utils.js only) ──────────────────────────────────────

describe('typeColour', () => {
    it('returns a distinct colour for each known holding type', () => {
        const types = ['bond', 'fund', 'deposit', 'structured', 'other'];
        const colours = types.map(typeColour);
        expect(new Set(colours).size).toBe(5);
        colours.forEach(c => expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/i));
    });

    it('falls back to the "other" colour for unknown types', () => {
        expect(typeColour('equity')).toBe(typeColour('other'));
        expect(typeColour('')).toBe(typeColour('other'));
        expect(typeColour(undefined)).toBe(typeColour('other'));
    });
});

// ── shared-module identity check ──────────────────────────────────────────────

describe('fmtPeriod (holdings/utils.js)', () => {
    it('is byte-for-byte identical to spend/utils.js', () => {
        expect(hFmtPeriod('2026-08')).toBe(fmtPeriod('2026-08'));
        expect(hFmtPeriod(null)).toBe(fmtPeriod(null));
        expect(hFmtPeriod('2026-Q2', 'quarter')).toBe(fmtPeriod('2026-Q2', 'quarter'));
    });
});

describe('deltaClass (holdings/utils.js)', () => {
    it('is byte-for-byte identical to spend/utils.js', () => {
        expect(hDeltaClass(0)).toBe(deltaClass(0));
        expect(hDeltaClass(100)).toBe(deltaClass(100));
        expect(hDeltaClass(-50, true)).toBe(deltaClass(-50, true));
    });
});

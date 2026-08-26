import { describe, it, expect } from 'vitest';
import { detectCurrency, detectStockExchange } from '../services/utils.js';

/**
 * Regression guard for the quote-currency rule in pricing.js recordSuccess().
 *
 * v3.39 marked a holding's quote currency "unknown" whenever it was priced under
 * a different ticker than the one stored. The intent was to avoid assuming a US
 * ADR's USD quote was the EU listing's EUR. The effect was far worse: tiers 1-3
 * never report a currency, so EVERY holding with a learned pricingTicker was
 * excluded from the totals — and for an ISIN-keyed broker import, the resolver
 * is the reason prices work at all, so that is most of the portfolio.
 *
 * The fix: the quote's currency follows the ticker actually QUERIED. That single
 * rule resolves both cases correctly, so nothing has to be assumed or discarded.
 */

// Mirrors the branch in recordSuccess() for the "priced under another ticker" case.
const quoteCurrencyFor = (pricedAs) => detectCurrency(detectStockExchange(String(pricedAs)));

describe('quote currency follows the queried ticker', () => {
    it('an EU listing priced under its own suffixed ticker keeps its currency', () => {
        expect(quoteCurrencyFor('AIR.PA')).toBe('EUR');
        expect(quoteCurrencyFor('BMW.DE')).toBe('EUR');
        expect(quoteCurrencyFor('ASML.AS')).toBe('EUR');
    });

    it('a London listing resolves to GBP', () => {
        expect(quoteCurrencyFor('VOD.L')).toBe('GBP');
    });

    // The case the old code was trying to protect: a US ADR standing in for an
    // EU listing really is quoted in USD, and the queried ticker says so.
    it('a US ADR resolves to USD, not the EU listing currency', () => {
        expect(quoteCurrencyFor('EADSY')).toBe('USD');
        expect(quoteCurrencyFor('BMWYY')).toBe('USD');
    });

    it('other venues resolve to their own currency', () => {
        expect(quoteCurrencyFor('NESN.SW')).toBe('CHF');
        expect(quoteCurrencyFor('SHOP.TO')).toBe('CAD');
        expect(quoteCurrencyFor('7203.T')).toBe('JPY');
    });

    // The whole point: a resolver-priced holding must produce a usable currency,
    // because a null here removes it from every total.
    it('never returns null for a resolvable ticker', () => {
        for (const t of ['AIR.PA', 'VOD.L', 'EADSY', 'MSFT', 'NESN.SW']) {
            expect(quoteCurrencyFor(t)).toBeTruthy();
        }
    });
});

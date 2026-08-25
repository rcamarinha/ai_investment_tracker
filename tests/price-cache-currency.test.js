import { describe, it, expect } from 'vitest';
import { normalizeCurrencyCode } from '../services/money-core.js';

/**
 * Guards the price_history round-trip, which sits OUTSIDE the live pricing path
 * and so bypassed every guard added in v3.39.
 *
 * Two defects this locks down:
 *  1. loadLatestPricesFromDB SELECTed `currency` and then discarded it, so a
 *     restored price silently inherited whatever currency the asset claimed —
 *     reintroducing the pence/ADR mix-ups on every page load.
 *  2. savePriceHistoryToDB wrote `r.currency || 'USD'`, turning "we don't know"
 *     into a permanent false record that later reads trusted.
 *
 * The storage functions themselves need a live Supabase client, so these tests
 * exercise the exact transformation they now apply.
 */

// Mirrors the write path in savePriceHistoryToDB.
function priceRowForWrite(price, currency) {
    const norm = normalizeCurrencyCode(currency);
    return { price, currency: norm ? norm.iso : null };
}

// Mirrors the read path in loadLatestPricesFromDB.
function priceFromRow(row) {
    const norm = normalizeCurrencyCode(row.currency);
    return {
        price: Number(row.price) * (norm ? norm.factor : 1),
        currency: norm ? norm.iso : null,
    };
}

describe('price_history currency round-trip', () => {
    it('a pence quote survives the round-trip as pounds, not 100x', () => {
        // Yahoo hands us 5052 GBp; the live path folds it to £50.52 before it
        // ever reaches storage, so that is what must be persisted and restored.
        const written = priceRowForWrite(50.52, 'GBP');
        const restored = priceFromRow(written);
        expect(restored.price).toBeCloseTo(50.52, 10);
        expect(restored.currency).toBe('GBP');
    });

    it('a legacy row still holding raw pence is folded on read, not trusted', () => {
        const restored = priceFromRow({ price: 5052, currency: 'GBp' });
        expect(restored.price).toBeCloseTo(50.52, 10);
        expect(restored.currency).toBe('GBP');
    });

    it('an unknown currency is persisted as NULL, never defaulted to USD', () => {
        const row = priceRowForWrite(123.45, null);
        expect(row.currency).toBeNull();
        expect(row.currency).not.toBe('USD');
    });

    it('a NULL-currency row restores as unknown so the holding is excluded', () => {
        const restored = priceFromRow({ price: 123.45, currency: null });
        expect(restored.currency).toBeNull();
        // Price is still surfaced natively; it is the CURRENCY being unknown
        // that makes the totals exclude it.
        expect(restored.price).toBe(123.45);
    });

    it('a malformed stored code is treated as unknown rather than passed through', () => {
        expect(priceFromRow({ price: 10, currency: 'EUROS' }).currency).toBeNull();
        expect(priceRowForWrite(10, 'EUROS').currency).toBeNull();
    });

    it('ordinary major-unit currencies round-trip unchanged', () => {
        for (const cur of ['EUR', 'USD', 'CHF']) {
            const restored = priceFromRow(priceRowForWrite(99.99, cur));
            expect(restored.price).toBeCloseTo(99.99, 10);
            expect(restored.currency).toBe(cur);
        }
    });
});

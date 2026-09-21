import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The shape of a price refresh, pinned by reading the source.
 *
 * fetchMarketPrices is DOM- and network-coupled, so its ordering cannot be
 * exercised directly here. What matters is structural and easy to lose in an
 * edit: the keyless proxy goes first, a user with no keys is not turned away,
 * and a phase only drops symbols it actually priced this run.
 */

const src = readFileSync(join(import.meta.dirname, '..', 'services', 'pricing.js'), 'utf8');
const refresh = src.slice(src.indexOf('export async function fetchMarketPrices'));

describe('price refresh order', () => {
    it('waits to learn which keyed providers exist before planning the tiers', () => {
        // The page auto-refreshes a second after load, while the answer is still
        // in flight; without this wait every visit's first refresh ran keyless.
        const waitAt = refresh.indexOf('await keyedProvidersKnown()');
        expect(waitAt, 'fetchMarketPrices must await keyedProvidersKnown()').toBeGreaterThan(-1);
        expect(waitAt).toBeLessThan(refresh.indexOf('hasKeys'));
    });

    it('asks the keyless quote proxy before any keyed tier', () => {
        const proxy = refresh.indexOf('batchFetchViaProxy(toFetch');
        const fmpBatch = refresh.indexOf('batchFetchFMP([...new Set(toFetch');
        const perSymbol = refresh.indexOf('fetchStockPrice(queryOf(symbol))');
        expect(proxy, 'Phase 0 is missing').toBeGreaterThan(-1);
        expect(proxy).toBeLessThan(fmpBatch);
        expect(proxy).toBeLessThan(perSymbol);
    });

    it('does not turn away a signed-in user who has no API keys', () => {
        expect(refresh).toMatch(/if \(!canUseProxy && !hasKeys\)/);
        expect(refresh).not.toMatch(/if \(!state\.alphaVantageKey && !state\.finnhubKey && !state\.fmpKey\)/);
    });

    it('drops only the symbols the proxy priced this run', () => {
        // Filtering on priceMetadata.success would reuse stale cached successes
        // and skip the fallback tiers. That froze prices once before.
        const phase0 = refresh.slice(
            refresh.indexOf('batchFetchViaProxy(toFetch'),
            refresh.indexOf('batchFetchFMP([...new Set(toFetch'));
        expect(phase0).toContain('toFetch = toFetch.filter(s => !refreshedThisRun.has(s))');
    });

    it('sends proxy batches small enough to finish inside the function time limit', () => {
        const m = src.match(/const PROXY_BATCH_SIZE = (\d+);/);
        expect(m, 'PROXY_BATCH_SIZE not found').toBeTruthy();
        expect(Number(m[1])).toBeLessThanOrEqual(25);
    });
});

import { describe, it, expect } from 'vitest';
import { buildRawMaps, mapPricedToRaw, pooled, planProxyBatches, mapProxyResults, normalizeForPricing } from '../services/pricing-core.js';
import { normalizeQuote } from '../services/money-core.js';

describe('buildRawMaps', () => {
  it('maps raw symbols to their normalized query form and reverse indexes', () => {
    const { normToRaw, baseToRaw, normSyms } = buildRawMaps(['AEU.FRK', 'AAPL']);
    // .FRK normalizes to .DE
    expect(normSyms).toContain('AEU.DE');
    expect(normSyms).toContain('AAPL');
    expect(normToRaw['AEU.DE']).toEqual(['AEU.FRK']);
    expect(baseToRaw['AEU']).toEqual(['AEU.FRK']);
    expect(normToRaw['AAPL']).toEqual(['AAPL']);
  });

  it('uppercases and dedupes input', () => {
    const { normToRaw, normSyms } = buildRawMaps(['aapl', 'AAPL', 'Aapl']);
    expect(normSyms).toEqual(['AAPL']);
    expect(normToRaw['AAPL']).toEqual(['AAPL']);
  });

  it('groups multiple raws that normalize to the same base', () => {
    const { baseToRaw } = buildRawMaps(['TTE.PAR', 'TTE.PA']);
    // both normalize to TTE.PA, base TTE
    expect(baseToRaw['TTE'].sort()).toEqual(['TTE.PA', 'TTE.PAR']);
  });

  it('handles empty / nullish input', () => {
    expect(buildRawMaps([]).normSyms).toEqual([]);
    expect(buildRawMaps(undefined).normSyms).toEqual([]);
  });
});

describe('mapPricedToRaw', () => {
  it('matches an echoed normalized symbol back to its raw form', () => {
    const { normToRaw, baseToRaw } = buildRawMaps(['AEU.FRK']);
    const out = mapPricedToRaw({ 'AEU.DE': 12.5 }, normToRaw, baseToRaw);
    expect(out).toEqual({ 'AEU.FRK': 12.5 });
  });

  it('falls back to base match when FMP echoes a different suffix', () => {
    const { normToRaw, baseToRaw } = buildRawMaps(['AEU.FRK']);
    // FMP returned AEU.F (not the exact normalized AEU.DE) — base AEU still resolves
    const out = mapPricedToRaw({ 'AEU.F': 9 }, normToRaw, baseToRaw);
    expect(out).toEqual({ 'AEU.FRK': 9 });
  });

  it('fans one price onto every raw that asked for it', () => {
    const { normToRaw, baseToRaw } = buildRawMaps(['TTE.PAR', 'TTE.PA']);
    const out = mapPricedToRaw({ 'TTE.PA': 60 }, normToRaw, baseToRaw);
    expect(out).toEqual({ 'TTE.PAR': 60, 'TTE.PA': 60 });
  });

  it('passes an unknown symbol through as itself', () => {
    const out = mapPricedToRaw({ MSFT: 400 }, {}, {});
    expect(out).toEqual({ MSFT: 400 });
  });

  it('tolerates empty input', () => {
    expect(mapPricedToRaw(undefined, {}, {})).toEqual({});
  });
});

describe('pooled', () => {
  it('processes every item and preserves input order', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await pooled(items, async (x) => x * 2, 2);
    expect(results.map(r => r.value)).toEqual([2, 4, 6, 8, 10]);
  });

  it('never exceeds the concurrency limit of in-flight promises', async () => {
    let inFlight = 0, maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await pooled(items, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
    }, 3);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('does not reject when a factory throws — surfaces it as a rejected result', async () => {
    const results = await pooled([1, 2, 3], async (x) => {
      if (x === 2) throw new Error('boom');
      return x;
    }, 2);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: 1 });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect(results[2]).toMatchObject({ status: 'fulfilled', value: 3 });
  });

  it('treats concurrency < 1 as 1 (no infinite loop)', async () => {
    const results = await pooled([1, 2], async (x) => x, 0);
    expect(results.map(r => r.value)).toEqual([1, 2]);
  });
});

// ── quote proxy batching ─────────────────────────────────────────────────────
describe('planProxyBatches', () => {
    it('splits into requests of the given size', () => {
        const syms = Array.from({ length: 60 }, (_, i) => `S${i}`);
        expect(planProxyBatches(syms, 25).map(b => b.length)).toEqual([25, 25, 10]);
    });

    it('defaults to a batch size small enough to finish inside the function time limit', () => {
        const syms = Array.from({ length: 26 }, (_, i) => `S${i}`);
        expect(planProxyBatches(syms).map(b => b.length)).toEqual([25, 1]);
    });

    it('asks for each symbol once, in the upper-case form the proxy answers with', () => {
        expect(planProxyBatches(['aapl', 'AAPL', ' msft '])).toEqual([['AAPL', 'MSFT']]);
    });

    it('normalizes suffixes the same way the per-symbol tier does', () => {
        expect(planProxyBatches(['sap.frk'])).toEqual([[normalizeForPricing('sap.frk').toUpperCase()]]);
    });

    it('ignores blanks and returns nothing for nothing', () => {
        expect(planProxyBatches([null, undefined, '', '  '])).toEqual([]);
        expect(planProxyBatches([])).toEqual([]);
    });
});

describe('mapProxyResults', () => {
    it('keeps a good quote with its reported currency', () => {
        const out = mapProxyResults({ AAPL: { price: 326.57, currency: 'USD', exchange: 'NasdaqGS' } }, normalizeQuote);
        expect(out.AAPL).toMatchObject({ price: 326.57, currency: 'USD' });
        expect(out.AAPL.source).toContain('NasdaqGS');
    });

    it('folds a London pence quote into pounds', () => {
        // The per-symbol proxy tier already did this; the batch must not regress it.
        const out = mapProxyResults({ 'VOD.L': { price: 7250, currency: 'GBp' } }, normalizeQuote);
        expect(out['VOD.L'].currency).toBe('GBP');
        expect(out['VOD.L'].price).toBeCloseTo(72.5, 10);
    });

    it('skips a symbol the proxy could not price', () => {
        const out = mapProxyResults({ A: null, B: { price: 0 }, C: { price: -1 }, D: { price: 'x' }, E: { price: null } }, normalizeQuote);
        expect(out).toEqual({});
    });

    it('keeps the price but claims no currency when the code is unreadable', () => {
        const out = mapProxyResults({ X: { price: 10, currency: '??' } }, normalizeQuote);
        expect(out.X).toMatchObject({ price: 10, currency: null });
    });

    it('keys its answer in upper case', () => {
        expect(Object.keys(mapProxyResults({ msft: { price: 1, currency: 'USD' } }, normalizeQuote))).toEqual(['MSFT']);
    });
});

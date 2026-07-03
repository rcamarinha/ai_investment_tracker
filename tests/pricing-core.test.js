import { describe, it, expect } from 'vitest';
import { buildRawMaps, mapPricedToRaw, pooled } from '../services/pricing-core.js';

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

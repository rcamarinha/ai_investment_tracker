/**
 * Tests for hub dashboard pure-logic functions (src/hub.js).
 *
 * These functions are extracted mirrors of the inline script in index.html.
 *
 * Risky behaviours covered:
 *  - hubFmt: zero / null / sub-cent values must render '— —' so the UI never
 *    shows a confusing '€ 0' when data hasn't loaded yet.
 *  - computeStockValue: cost-basis arithmetic must handle empty arrays, null
 *    input, and multiple positions correctly.
 *  - computeWineValue / computeWineCost: default-to-1 qty and default-to-0
 *    price guards prevent NaN silently poisoning the totals.
 *  - computeWineDelta: the three-way branch (no value / value+cost / value only)
 *    drives the colour class and text shown on the hub card — wrong behaviour
 *    here produces visually misleading deltas.
 */

import { describe, it, expect } from 'vitest';
import { hubFmt, computeStockValue, computeWineValue, computeWineCost, computeWineDelta } from '../src/hub.js';

// ── hubFmt ───────────────────────────────────────────────────────────────────

describe('hubFmt', () => {
  it('returns — — for null', () => {
    expect(hubFmt(null)).toBe('— —');
  });

  it('returns — — for undefined', () => {
    expect(hubFmt(undefined)).toBe('— —');
  });

  it('returns — — for 0', () => {
    expect(hubFmt(0)).toBe('— —');
  });

  it('returns — — for negative values', () => {
    expect(hubFmt(-5)).toBe('— —');
  });

  it('returns — — for values below €0.01', () => {
    expect(hubFmt(0.005)).toBe('— —');
    expect(hubFmt(0.009)).toBe('— —');
  });

  it('formats a value of exactly €0.01 as a number', () => {
    expect(hubFmt(0.01)).toBe('€ 0');
  });

  it('rounds and formats a typical portfolio value', () => {
    expect(hubFmt(1234)).toBe('€ 1,234');
  });

  it('rounds fractional cents', () => {
    expect(hubFmt(999.6)).toBe('€ 1,000');
    expect(hubFmt(999.4)).toBe('€ 999');
  });

  it('handles large values with thousand separators', () => {
    expect(hubFmt(1000000)).toBe('€ 1,000,000');
  });
});

// ── computeStockValue ────────────────────────────────────────────────────────

describe('computeStockValue', () => {
  it('returns 0 for null', () => {
    expect(computeStockValue(null)).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(computeStockValue([])).toBe(0);
  });

  it('computes cost basis for a single position', () => {
    expect(computeStockValue([{ shares: 10, avg_price: 100 }])).toBe(1000);
  });

  it('sums multiple positions', () => {
    const positions = [
      { shares: 5, avg_price: 200 },
      { shares: 3, avg_price: 150 },
      { shares: 2, avg_price: 50 },
    ];
    expect(computeStockValue(positions)).toBe(1000 + 450 + 100);
  });

  it('handles fractional shares', () => {
    expect(computeStockValue([{ shares: 1.5, avg_price: 100 }])).toBeCloseTo(150);
  });

  it('handles zero shares', () => {
    expect(computeStockValue([{ shares: 0, avg_price: 200 }])).toBe(0);
  });
});

// ── computeWineValue ─────────────────────────────────────────────────────────

describe('computeWineValue', () => {
  it('returns 0 for null', () => {
    expect(computeWineValue(null)).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(computeWineValue([])).toBe(0);
  });

  it('computes value for a single bottle', () => {
    expect(computeWineValue([{ qty: 2, estimated_value: 50 }])).toBe(100);
  });

  it('defaults qty to 1 when missing', () => {
    expect(computeWineValue([{ estimated_value: 75 }])).toBe(75);
  });

  it('defaults estimated_value to 0 when missing', () => {
    expect(computeWineValue([{ qty: 3 }])).toBe(0);
  });

  it('sums multiple wine rows', () => {
    const wines = [
      { qty: 2, estimated_value: 50 },
      { qty: 1, estimated_value: 100 },
      { qty: 3, estimated_value: 25 },
    ];
    expect(computeWineValue(wines)).toBe(100 + 100 + 75);
  });

  it('treats null estimated_value as 0', () => {
    expect(computeWineValue([{ qty: 5, estimated_value: null }])).toBe(0);
  });

  it('treats null qty as 1', () => {
    expect(computeWineValue([{ qty: null, estimated_value: 60 }])).toBe(60);
  });
});

// ── computeWineCost ──────────────────────────────────────────────────────────

describe('computeWineCost', () => {
  it('returns 0 for null', () => {
    expect(computeWineCost(null)).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(computeWineCost([])).toBe(0);
  });

  it('computes cost for a single bottle', () => {
    expect(computeWineCost([{ qty: 2, purchase_price: 30 }])).toBe(60);
  });

  it('defaults qty to 1 when missing', () => {
    expect(computeWineCost([{ purchase_price: 40 }])).toBe(40);
  });

  it('defaults purchase_price to 0 when missing', () => {
    expect(computeWineCost([{ qty: 4 }])).toBe(0);
  });

  it('sums multiple wine rows', () => {
    const wines = [
      { qty: 6, purchase_price: 10 },
      { qty: 2, purchase_price: 20 },
    ];
    expect(computeWineCost(wines)).toBe(60 + 40);
  });
});

// ── computeWineDelta ─────────────────────────────────────────────────────────

describe('computeWineDelta', () => {
  // No wine value at all
  it('returns empty text and class when wineValue is 0', () => {
    const result = computeWineDelta(0, 0, []);
    expect(result.text).toBe('');
    expect(result.className).toBe('');
  });

  it('returns empty when wineValue is 0 even with rows', () => {
    const wines = [{ last_valued_at: '2026-01-01T00:00:00Z' }];
    const result = computeWineDelta(0, 100, wines);
    expect(result.text).toBe('');
  });

  // Gain / loss percentage path (wineValue > 0 && wineCost > 0)
  it('shows a positive percentage gain with + sign', () => {
    const result = computeWineDelta(1100, 1000, []);
    expect(result.text).toBe('+10.0%');
    expect(result.className).toBe('hub-card-delta up');
  });

  it('shows a negative percentage loss without + sign', () => {
    const result = computeWineDelta(900, 1000, []);
    expect(result.text).toBe('-10.0%');
    expect(result.className).toBe('hub-card-delta down');
  });

  it('shows +0.0% when value exactly equals cost', () => {
    const result = computeWineDelta(500, 500, []);
    expect(result.text).toBe('+0.0%');
    expect(result.className).toBe('hub-card-delta up');
  });

  it('formats percentage to one decimal place', () => {
    const result = computeWineDelta(1015, 1000, []);
    expect(result.text).toBe('+1.5%');
  });

  // Staleness label path (wineValue > 0, wineCost = 0)
  it('shows staleness label when wineValue > 0 but no cost', () => {
    const now = new Date('2026-06-01T00:00:00Z').getTime();
    const wines = [{ last_valued_at: '2026-05-25T00:00:00Z' }];
    const result = computeWineDelta(500, 0, wines, now);
    expect(result.text).toBe('valued 7d ago');
    expect(result.className).toBe('hub-card-delta neutral');
  });

  it('uses the most recent last_valued_at when multiple rows', () => {
    const now = new Date('2026-06-01T00:00:00Z').getTime();
    const wines = [
      { last_valued_at: '2026-05-20T00:00:00Z' },
      { last_valued_at: '2026-05-29T00:00:00Z' },
      { last_valued_at: '2026-05-15T00:00:00Z' },
    ];
    const result = computeWineDelta(800, 0, wines, now);
    expect(result.text).toBe('valued 3d ago');
  });

  it('rounds partial days to the nearest whole day', () => {
    const now = new Date('2026-06-01T12:00:00Z').getTime();
    const wines = [{ last_valued_at: '2026-05-31T00:00:00Z' }];
    const result = computeWineDelta(200, 0, wines, now);
    // 36 hours → rounds to 2 days
    expect(result.text).toBe('valued 2d ago');
  });

  it('returns empty text when wineValue > 0 but no last_valued_at on any row', () => {
    const wines = [{ last_valued_at: null }, { last_valued_at: null }];
    const result = computeWineDelta(300, 0, wines);
    expect(result.text).toBe('');
    expect(result.className).toBe('');
  });

  it('returns empty text when wineValue > 0 and wineRows is empty', () => {
    const result = computeWineDelta(300, 0, []);
    expect(result.text).toBe('');
    expect(result.className).toBe('');
  });
});

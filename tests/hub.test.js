/**
 * Tests for hub dashboard pure computation helpers.
 *
 * Functions live in index.html (inline) and are mirrored in src/hub.js for
 * testability. The hub dashboard is new code (commit 8b351d9) with no prior
 * test coverage; these tests guard against silent regressions in:
 *
 *  - hubFmt: edge cases around zero/null/sub-cent values, rounding, locale.
 *  - computeStockValue: null rows, zero shares/price, multi-position sum.
 *  - computeWineValue / computeWineCost: null qty fallback (defaults to 1),
 *    null estimated_value/purchase_price fallback.
 *  - computeWineDelta: three distinct display paths (% gain, staleness label,
 *    empty) and their CSS modifier class assignment.
 */

import { describe, it, expect } from 'vitest';
import {
  hubFmt,
  computeStockValue,
  computeWineValue,
  computeWineCost,
  computeWineDelta,
} from '../src/hub.js';

// ── hubFmt ───────────────────────────────────────────────────────────────────

describe('hubFmt', () => {
  it('returns placeholder for null', () => {
    expect(hubFmt(null)).toBe('— —');
  });

  it('returns placeholder for undefined', () => {
    expect(hubFmt(undefined)).toBe('— —');
  });

  it('returns placeholder for 0', () => {
    expect(hubFmt(0)).toBe('— —');
  });

  it('returns placeholder for negative value', () => {
    expect(hubFmt(-100)).toBe('— —');
  });

  it('returns placeholder for sub-cent value (< 0.01)', () => {
    expect(hubFmt(0.009)).toBe('— —');
  });

  it('formats 0.01 as € 0', () => {
    // Exactly 0.01 passes the threshold; Math.round(0.01) = 0
    expect(hubFmt(0.01)).toBe('€ 0');
  });

  it('formats integer value correctly', () => {
    expect(hubFmt(1000)).toBe('€ 1,000');
  });

  it('rounds fractional values to nearest integer', () => {
    expect(hubFmt(1234.56)).toBe('€ 1,235');
    expect(hubFmt(1234.49)).toBe('€ 1,234');
  });

  it('uses comma thousands separator (en-US locale)', () => {
    expect(hubFmt(1_000_000)).toBe('€ 1,000,000');
  });
});

// ── computeStockValue ─────────────────────────────────────────────────────────

describe('computeStockValue', () => {
  it('returns 0 for empty array', () => {
    expect(computeStockValue([])).toBe(0);
  });

  it('returns 0 for null/undefined', () => {
    expect(computeStockValue(null)).toBe(0);
    expect(computeStockValue(undefined)).toBe(0);
  });

  it('computes single position correctly', () => {
    expect(computeStockValue([{ shares: 10, avg_price: 50 }])).toBe(500);
  });

  it('sums multiple positions', () => {
    const positions = [
      { shares: 10, avg_price: 100 },
      { shares: 5,  avg_price: 200 },
    ];
    expect(computeStockValue(positions)).toBe(2000);
  });

  it('handles zero shares', () => {
    expect(computeStockValue([{ shares: 0, avg_price: 100 }])).toBe(0);
  });

  it('handles zero avg_price', () => {
    expect(computeStockValue([{ shares: 10, avg_price: 0 }])).toBe(0);
  });
});

// ── computeWineValue ──────────────────────────────────────────────────────────

describe('computeWineValue', () => {
  it('returns 0 for empty array', () => {
    expect(computeWineValue([])).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(computeWineValue(null)).toBe(0);
  });

  it('defaults qty to 1 when null', () => {
    expect(computeWineValue([{ estimated_value: 100, qty: null }])).toBe(100);
  });

  it('defaults qty to 1 when undefined', () => {
    expect(computeWineValue([{ estimated_value: 100 }])).toBe(100);
  });

  it('treats null estimated_value as 0', () => {
    expect(computeWineValue([{ estimated_value: null, qty: 3 }])).toBe(0);
  });

  it('multiplies value × qty correctly', () => {
    expect(computeWineValue([{ estimated_value: 50, qty: 6 }])).toBe(300);
  });

  it('sums multiple wine rows', () => {
    const wines = [
      { estimated_value: 100, qty: 2 },
      { estimated_value: 50,  qty: 4 },
    ];
    expect(computeWineValue(wines)).toBe(400);
  });
});

// ── computeWineCost ───────────────────────────────────────────────────────────

describe('computeWineCost', () => {
  it('returns 0 for empty array', () => {
    expect(computeWineCost([])).toBe(0);
  });

  it('defaults qty to 1 when null', () => {
    expect(computeWineCost([{ purchase_price: 80, qty: null }])).toBe(80);
  });

  it('treats null purchase_price as 0', () => {
    expect(computeWineCost([{ purchase_price: null, qty: 2 }])).toBe(0);
  });

  it('multiplies purchase_price × qty', () => {
    expect(computeWineCost([{ purchase_price: 20, qty: 5 }])).toBe(100);
  });

  it('sums multiple wine rows', () => {
    const wines = [
      { purchase_price: 40, qty: 3 },
      { purchase_price: 60, qty: 2 },
    ];
    expect(computeWineCost(wines)).toBe(240);
  });
});

// ── computeWineDelta ──────────────────────────────────────────────────────────

describe('computeWineDelta', () => {
  // ── Path 1: % gain/loss display ──────────────────────────────────────────

  it('shows positive gain percentage with + prefix', () => {
    const result = computeWineDelta(120, 100, []);
    expect(result.text).toBe('+20.0%');
    expect(result.cssClass).toBe('hub-card-delta up');
  });

  it('shows negative gain percentage without + prefix', () => {
    const result = computeWineDelta(80, 100, []);
    expect(result.text).toBe('-20.0%');
    expect(result.cssClass).toBe('hub-card-delta down');
  });

  it('shows +0.0% for break-even (wineValue == wineCost)', () => {
    const result = computeWineDelta(100, 100, []);
    expect(result.text).toBe('+0.0%');
    expect(result.cssClass).toBe('hub-card-delta up');
  });

  it('rounds percentage to one decimal place', () => {
    const result = computeWineDelta(110, 90, []);
    // (110-90)/90*100 = 22.222...% → rounds to 22.2%
    expect(result.text).toBe('+22.2%');
  });

  // ── Path 2: staleness label ───────────────────────────────────────────────

  it('shows staleness label when wineValue > 0 and wineCost is 0', () => {
    const now = new Date('2026-05-30T10:00:00Z').getTime();
    const valued = '2026-05-20T10:00:00Z'; // 10 days ago
    const result = computeWineDelta(100, 0, [{ last_valued_at: valued }], now);
    expect(result.text).toBe('valued 10d ago');
    expect(result.cssClass).toBe('hub-card-delta neutral');
  });

  it('uses the most-recent last_valued_at when multiple rows present', () => {
    const now = new Date('2026-05-30T00:00:00Z').getTime();
    const wines = [
      { last_valued_at: '2026-05-15T00:00:00Z' }, // 15 days ago
      { last_valued_at: '2026-05-25T00:00:00Z' }, // 5 days ago (most recent)
      { last_valued_at: '2026-05-01T00:00:00Z' }, // 29 days ago
    ];
    const result = computeWineDelta(100, 0, wines, now);
    expect(result.text).toBe('valued 5d ago');
  });

  it('returns empty text when wineValue > 0 and no last_valued_at present', () => {
    const result = computeWineDelta(100, 0, [{ last_valued_at: null }]);
    expect(result.text).toBe('');
    expect(result.cssClass).toBe('');
  });

  it('ignores rows with null last_valued_at when finding most recent date', () => {
    const now = new Date('2026-05-30T00:00:00Z').getTime();
    const wines = [
      { last_valued_at: null },
      { last_valued_at: '2026-05-28T00:00:00Z' }, // 2 days ago
    ];
    const result = computeWineDelta(100, 0, wines, now);
    expect(result.text).toBe('valued 2d ago');
  });

  // ── Path 3: empty (no wines valued) ──────────────────────────────────────

  it('returns empty when wineValue is 0', () => {
    const result = computeWineDelta(0, 0, []);
    expect(result.text).toBe('');
    expect(result.cssClass).toBe('');
  });

  it('returns empty when wineValue is negative (defensive)', () => {
    const result = computeWineDelta(-10, 100, []);
    expect(result.text).toBe('');
    expect(result.cssClass).toBe('');
  });

  // ── Edge: staleness rounds correctly ──────────────────────────────────────

  it('rounds daysAgo to nearest integer', () => {
    // 1.5 days = 36 hours → rounds to 2d
    const now  = new Date('2026-05-30T12:00:00Z').getTime();
    const valued = '2026-05-29T00:00:00Z'; // 36 hours ago
    const result = computeWineDelta(100, 0, [{ last_valued_at: valued }], now);
    expect(result.text).toBe('valued 2d ago');
  });

  it('shows 0d ago when valued today', () => {
    const now  = new Date('2026-05-30T12:00:00Z').getTime();
    const valued = '2026-05-30T10:00:00Z'; // 2 hours ago
    const result = computeWineDelta(100, 0, [{ last_valued_at: valued }], now);
    expect(result.text).toBe('valued 0d ago');
  });
});

import { describe, it, expect } from 'vitest';
import {
  hubFmt,
  computeStockValue,
  computeWineValue,
  computeWineCost,
  computeWineDelta,
} from '../src/hub.js';

// ── hubFmt ────────────────────────────────────────────────────────────────────

describe('hubFmt', () => {
  it('returns placeholder for undefined', () => {
    expect(hubFmt(undefined)).toBe('— —');
  });

  it('returns placeholder for null', () => {
    expect(hubFmt(null)).toBe('— —');
  });

  it('returns placeholder for 0', () => {
    expect(hubFmt(0)).toBe('— —');
  });

  it('returns placeholder for negative value', () => {
    expect(hubFmt(-1)).toBe('— —');
  });

  it('returns placeholder for value below 0.01', () => {
    expect(hubFmt(0.009)).toBe('— —');
  });

  it('returns placeholder for exactly 0.009', () => {
    expect(hubFmt(0.009)).toBe('— —');
  });

  it('formats value at exactly 0.01 (threshold)', () => {
    expect(hubFmt(0.01)).toBe('€ 0');
  });

  it('formats a simple integer', () => {
    expect(hubFmt(1000)).toBe('€ 1,000');
  });

  it('rounds to the nearest euro', () => {
    expect(hubFmt(1234.6)).toBe('€ 1,235');
    expect(hubFmt(1234.4)).toBe('€ 1,234');
  });

  it('formats a large value with thousands separator', () => {
    expect(hubFmt(1234567)).toBe('€ 1,234,567');
  });

  it('formats a small positive value', () => {
    expect(hubFmt(0.5)).toBe('€ 1'); // rounds up
  });

  it('formats an exact one-euro value', () => {
    expect(hubFmt(1)).toBe('€ 1');
  });
});

// ── computeStockValue ─────────────────────────────────────────────────────────

describe('computeStockValue', () => {
  it('returns 0 for an empty array', () => {
    expect(computeStockValue([])).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(computeStockValue(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(computeStockValue(undefined)).toBe(0);
  });

  it('computes shares × avg_price for a single position', () => {
    expect(computeStockValue([{ shares: 10, avg_price: 25 }])).toBe(250);
  });

  it('sums multiple positions', () => {
    const positions = [
      { shares: 10, avg_price: 100 },
      { shares: 5, avg_price: 200 },
    ];
    expect(computeStockValue(positions)).toBe(2000);
  });

  it('handles fractional shares and prices', () => {
    const positions = [{ shares: 2.5, avg_price: 100.4 }];
    expect(computeStockValue(positions)).toBeCloseTo(251);
  });

  it('includes positions with zero shares (contributes 0)', () => {
    const positions = [
      { shares: 0, avg_price: 100 },
      { shares: 5, avg_price: 50 },
    ];
    expect(computeStockValue(positions)).toBe(250);
  });

  it('handles zero price', () => {
    expect(computeStockValue([{ shares: 100, avg_price: 0 }])).toBe(0);
  });
});

// ── computeWineValue ──────────────────────────────────────────────────────────

describe('computeWineValue', () => {
  it('returns 0 for an empty array', () => {
    expect(computeWineValue([])).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(computeWineValue(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(computeWineValue(undefined)).toBe(0);
  });

  it('computes estimated_value × qty for a single row', () => {
    expect(computeWineValue([{ estimated_value: 30, qty: 3 }])).toBe(90);
  });

  it('treats missing qty as 1', () => {
    expect(computeWineValue([{ estimated_value: 50 }])).toBe(50);
  });

  it('treats missing estimated_value as 0', () => {
    expect(computeWineValue([{ qty: 5 }])).toBe(0);
  });

  it('treats null estimated_value as 0', () => {
    expect(computeWineValue([{ estimated_value: null, qty: 3 }])).toBe(0);
  });

  it('sums multiple rows', () => {
    const rows = [
      { estimated_value: 20, qty: 2 },
      { estimated_value: 50, qty: 1 },
      { estimated_value: 10, qty: 4 },
    ];
    expect(computeWineValue(rows)).toBe(130);
  });
});

// ── computeWineCost ───────────────────────────────────────────────────────────

describe('computeWineCost', () => {
  it('returns 0 for an empty array', () => {
    expect(computeWineCost([])).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(computeWineCost(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(computeWineCost(undefined)).toBe(0);
  });

  it('computes purchase_price × qty for a single row', () => {
    expect(computeWineCost([{ purchase_price: 15, qty: 6 }])).toBe(90);
  });

  it('treats missing qty as 1', () => {
    expect(computeWineCost([{ purchase_price: 25 }])).toBe(25);
  });

  it('treats missing purchase_price as 0', () => {
    expect(computeWineCost([{ qty: 3 }])).toBe(0);
  });

  it('treats null purchase_price as 0', () => {
    expect(computeWineCost([{ purchase_price: null, qty: 2 }])).toBe(0);
  });

  it('sums multiple rows', () => {
    const rows = [
      { purchase_price: 10, qty: 2 },
      { purchase_price: 20, qty: 3 },
    ];
    expect(computeWineCost(rows)).toBe(80);
  });
});

// ── computeWineDelta ──────────────────────────────────────────────────────────

describe('computeWineDelta', () => {
  // ── No wine ──────────────────────────────────────────────────────────────

  it('returns empty text and cssClass when wineValue is 0', () => {
    const result = computeWineDelta(0, 0, []);
    expect(result).toEqual({ text: '', cssClass: '' });
  });

  it('returns empty when wineValue is 0 regardless of wineCost', () => {
    const result = computeWineDelta(0, 500, []);
    expect(result).toEqual({ text: '', cssClass: '' });
  });

  // ── Percent gain/loss (wineValue > 0 and wineCost > 0) ───────────────────

  it('shows positive percentage with + sign and "up" class', () => {
    const result = computeWineDelta(1100, 1000, []);
    expect(result.text).toBe('+10.0%');
    expect(result.cssClass).toBe('hub-card-delta up');
  });

  it('shows negative percentage without + sign and "down" class', () => {
    const result = computeWineDelta(900, 1000, []);
    expect(result.text).toBe('-10.0%');
    expect(result.cssClass).toBe('hub-card-delta down');
  });

  it('shows exactly +0.0% when value equals cost (no gain)', () => {
    const result = computeWineDelta(500, 500, []);
    expect(result.text).toBe('+0.0%');
    expect(result.cssClass).toBe('hub-card-delta up');
  });

  it('formats percentage to one decimal place', () => {
    const result = computeWineDelta(1005, 1000, []);
    expect(result.text).toBe('+0.5%');
  });

  it('handles large percentage gain', () => {
    const result = computeWineDelta(5000, 1000, []);
    expect(result.text).toBe('+400.0%');
    expect(result.cssClass).toBe('hub-card-delta up');
  });

  // ── Staleness label (wineValue > 0, wineCost = 0, has last_valued_at) ───

  it('shows staleness label when wineValue > 0 and no cost', () => {
    const now = new Date('2026-01-10').getTime();
    const rows = [{ estimated_value: 100, qty: 1, last_valued_at: '2026-01-07T00:00:00Z' }];
    const result = computeWineDelta(100, 0, rows, now);
    expect(result.text).toBe('valued 3d ago');
    expect(result.cssClass).toBe('hub-card-delta neutral');
  });

  it('picks the most recent last_valued_at when multiple rows', () => {
    const now = new Date('2026-06-01').getTime();
    const rows = [
      { estimated_value: 50, qty: 1, last_valued_at: '2026-05-01T00:00:00Z' }, // 31d ago
      { estimated_value: 50, qty: 1, last_valued_at: '2026-05-25T00:00:00Z' }, // 7d ago
    ];
    const result = computeWineDelta(100, 0, rows, now);
    expect(result.text).toBe('valued 7d ago');
  });

  it('returns empty text when wineValue > 0 but no last_valued_at on any row', () => {
    const rows = [{ estimated_value: 100, qty: 1 }];
    const result = computeWineDelta(100, 0, rows);
    expect(result).toEqual({ text: '', cssClass: '' });
  });

  it('ignores rows with falsy last_valued_at when computing staleness', () => {
    const now = new Date('2026-01-15').getTime();
    const rows = [
      { estimated_value: 50, qty: 1, last_valued_at: null },
      { estimated_value: 50, qty: 1, last_valued_at: '2026-01-10T00:00:00Z' },
    ];
    const result = computeWineDelta(100, 0, rows, now);
    expect(result.text).toBe('valued 5d ago');
    expect(result.cssClass).toBe('hub-card-delta neutral');
  });

  it('returns empty text when wineRows is null and no cost', () => {
    const result = computeWineDelta(100, 0, null);
    expect(result).toEqual({ text: '', cssClass: '' });
  });

  it('staleness rounds fractional days', () => {
    // 1.5 days → rounds to 2
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const now = base + 1.5 * 86400000;
    const rows = [{ estimated_value: 100, qty: 1, last_valued_at: '2026-01-01T00:00:00Z' }];
    const result = computeWineDelta(100, 0, rows, now);
    expect(result.text).toBe('valued 2d ago');
  });

  it('shows "valued 0d ago" for same-day valuation', () => {
    const now = new Date('2026-01-01T12:00:00Z').getTime();
    const rows = [{ estimated_value: 100, qty: 1, last_valued_at: '2026-01-01T10:00:00Z' }];
    const result = computeWineDelta(100, 0, rows, now);
    expect(result.text).toBe('valued 0d ago');
    expect(result.cssClass).toBe('hub-card-delta neutral');
  });
});

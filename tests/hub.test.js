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
    it('formats a round number with EUR prefix', () => {
        expect(hubFmt(1000)).toBe('€ 1,000');
    });

    it('rounds to the nearest integer', () => {
        expect(hubFmt(1234.7)).toBe('€ 1,235');
        expect(hubFmt(999.2)).toBe('€ 999');
    });

    it('returns "— —" for 0', () => {
        expect(hubFmt(0)).toBe('— —');
    });

    it('returns "— —" for null', () => {
        expect(hubFmt(null)).toBe('— —');
    });

    it('returns "— —" for undefined', () => {
        expect(hubFmt(undefined)).toBe('— —');
    });

    it('returns "— —" for values below 0.01', () => {
        expect(hubFmt(0.005)).toBe('— —');
        expect(hubFmt(0.009)).toBe('— —');
    });

    it('formats exactly 0.01 (boundary)', () => {
        // val < 0.01 returns '— —'; 0.01 is not < 0.01 so it should format
        expect(hubFmt(0.01)).toBe('€ 0');
    });

    it('formats a large portfolio value with thousand separators', () => {
        expect(hubFmt(1500000)).toBe('€ 1,500,000');
    });

    it('returns "— —" for NaN', () => {
        expect(hubFmt(NaN)).toBe('— —');
    });
});

// ── computeStockValue ─────────────────────────────────────────────────────────

describe('computeStockValue', () => {
    it('sums shares × avg_price across all positions', () => {
        const positions = [
            { shares: 10, avg_price: 150 },
            { shares: 5,  avg_price: 300 },
        ];
        expect(computeStockValue(positions)).toBe(10 * 150 + 5 * 300); // 3000
    });

    it('returns 0 for an empty array', () => {
        expect(computeStockValue([])).toBe(0);
    });

    it('returns 0 for null', () => {
        expect(computeStockValue(null)).toBe(0);
    });

    it('handles a position with null avg_price', () => {
        const positions = [{ shares: 5, avg_price: null }];
        expect(computeStockValue(positions)).toBe(0);
    });

    it('handles a position with null shares', () => {
        const positions = [{ shares: null, avg_price: 100 }];
        expect(computeStockValue(positions)).toBe(0);
    });

    it('handles a single position', () => {
        expect(computeStockValue([{ shares: 100, avg_price: 50 }])).toBe(5000);
    });

    it('sums a large number of positions correctly', () => {
        const positions = Array.from({ length: 10 }, (_, i) => ({
            shares: 10,
            avg_price: (i + 1) * 10,
        }));
        // 10*(10+20+30+...+100) = 10*550 = 5500
        expect(computeStockValue(positions)).toBe(5500);
    });
});

// ── computeWineValue ──────────────────────────────────────────────────────────

describe('computeWineValue', () => {
    it('sums estimated_value × qty for each wine row', () => {
        const wines = [
            { qty: 6, estimated_value: 100, purchase_price: 80 },
            { qty: 3, estimated_value: 200, purchase_price: 150 },
        ];
        expect(computeWineValue(wines)).toBe(6 * 100 + 3 * 200); // 1200
    });

    it('returns 0 for an empty array', () => {
        expect(computeWineValue([])).toBe(0);
    });

    it('returns 0 for null', () => {
        expect(computeWineValue(null)).toBe(0);
    });

    it('treats null estimated_value as 0', () => {
        const wines = [{ qty: 5, estimated_value: null }];
        expect(computeWineValue(wines)).toBe(0);
    });

    it('defaults qty to 1 when qty is missing', () => {
        const wines = [{ estimated_value: 200 }];
        expect(computeWineValue(wines)).toBe(200);
    });

    it('handles a mix of valued and unvalued rows', () => {
        const wines = [
            { qty: 2, estimated_value: 150 },
            { qty: 3, estimated_value: null },
            { qty: 1, estimated_value: 200 },
        ];
        expect(computeWineValue(wines)).toBe(2 * 150 + 0 + 1 * 200); // 500
    });
});

// ── computeWineCost ───────────────────────────────────────────────────────────

describe('computeWineCost', () => {
    it('sums purchase_price × qty for each wine row', () => {
        const wines = [
            { qty: 6, purchase_price: 80  },
            { qty: 3, purchase_price: 150 },
        ];
        expect(computeWineCost(wines)).toBe(6 * 80 + 3 * 150); // 930
    });

    it('returns 0 for an empty array', () => {
        expect(computeWineCost([])).toBe(0);
    });

    it('returns 0 for null', () => {
        expect(computeWineCost(null)).toBe(0);
    });

    it('treats null purchase_price as 0', () => {
        const wines = [{ qty: 5, purchase_price: null }];
        expect(computeWineCost(wines)).toBe(0);
    });

    it('defaults qty to 1 when qty is missing', () => {
        const wines = [{ purchase_price: 80 }];
        expect(computeWineCost(wines)).toBe(80);
    });
});

// ── computeWineDelta ──────────────────────────────────────────────────────────

describe('computeWineDelta', () => {
    // Use midnight UTC so day differences are always exact integers (no rounding ambiguity)
    const NOW = new Date('2026-06-04T00:00:00.000Z').getTime();

    it('returns a positive percentage when wineValue > wineCost', () => {
        const result = computeWineDelta(1200, 1000, [], NOW);
        expect(result.text).toBe('+20.0%');
        expect(result.cls).toBe('up');
    });

    it('returns a negative percentage when wineValue < wineCost', () => {
        const result = computeWineDelta(800, 1000, [], NOW);
        expect(result.text).toBe('-20.0%');
        expect(result.cls).toBe('down');
    });

    it('returns +0.0% when wineValue equals wineCost', () => {
        const result = computeWineDelta(1000, 1000, [], NOW);
        expect(result.text).toBe('+0.0%');
        expect(result.cls).toBe('up');
    });

    it('returns staleness label when wineValue > 0 and wineCost is 0', () => {
        // 2026-06-01 is exactly 3 days before 2026-06-04
        const wines = [{ qty: 1, estimated_value: 150, last_valued_at: '2026-06-01T00:00:00.000Z' }];
        const result = computeWineDelta(150, 0, wines, NOW);
        expect(result.text).toBe('valued 3d ago');
        expect(result.cls).toBe('neutral');
    });

    it('picks the most recent last_valued_at when multiple rows exist', () => {
        const wines = [
            { qty: 3, estimated_value: 100, last_valued_at: '2026-05-21T00:00:00.000Z' }, // 14d ago
            { qty: 2, estimated_value: 100, last_valued_at: '2026-06-01T00:00:00.000Z' }, // 3d ago
        ];
        const result = computeWineDelta(500, 0, wines, NOW);
        // most recent = Jun 1, which is exactly 3 days before Jun 4
        expect(result.text).toBe('valued 3d ago');
    });

    it('returns empty string when no last_valued_at is set and no cost', () => {
        const wines = [{ qty: 1, estimated_value: 100, last_valued_at: null }];
        const result = computeWineDelta(100, 0, wines, NOW);
        expect(result.text).toBe('');
        expect(result.cls).toBe('neutral');
    });

    it('returns empty text when wineValue is 0', () => {
        const result = computeWineDelta(0, 0, [], NOW);
        expect(result.text).toBe('');
        expect(result.cls).toBe('neutral');
    });

    it('returns empty text when both wineValue and wineCost are 0', () => {
        const result = computeWineDelta(0, 500, [], NOW);
        expect(result.text).toBe('');
        expect(result.cls).toBe('neutral');
    });

    it('uses Date.now() default when now param is omitted (smoke test)', () => {
        const wines = [{ qty: 1, estimated_value: 150, last_valued_at: new Date().toISOString() }];
        const result = computeWineDelta(150, 0, wines); // no NOW param
        // Either "valued 0d ago" or "valued 1d ago" depending on clock; just check it returns a string
        expect(typeof result.text).toBe('string');
        expect(result.cls).toBe('neutral');
    });

    it('handles fractional percentage with correct decimal formatting', () => {
        const result = computeWineDelta(1050, 1000, [], NOW);
        expect(result.text).toBe('+5.0%');
    });
});

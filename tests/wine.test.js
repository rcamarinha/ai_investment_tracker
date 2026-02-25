import { describe, it, expect } from 'vitest';
import {
    computeCellarTotals,
    calculateBottleGain,
    groupBottlesByDimension,
    validateBottle,
    buildBottleFromScan,
    buildCellarSnapshot,
    getDrinkStatus,
    filterBottles,
    sortBottles,
} from '../src/wine.js';

// ── computeCellarTotals ───────────────────────────────────────────────────────

describe('computeCellarTotals', () => {
    it('returns all zeros for an empty cellar', () => {
        const result = computeCellarTotals([]);
        expect(result.totalInvested).toBe(0);
        expect(result.totalEstimated).toBe(0);
        expect(result.totalBottles).toBe(0);
        expect(result.valuedBottles).toBe(0);
    });

    it('returns zeros for null input', () => {
        const result = computeCellarTotals(null);
        expect(result.totalInvested).toBe(0);
        expect(result.totalBottles).toBe(0);
    });

    it('calculates totals for a single unvalued bottle (falls back to cost)', () => {
        const result = computeCellarTotals([{ qty: 6, purchasePrice: 100 }]);
        expect(result.totalInvested).toBe(600);
        expect(result.totalEstimated).toBe(600);
        expect(result.totalBottles).toBe(6);
        expect(result.valuedBottles).toBe(0);
    });

    it('uses estimatedValue when present', () => {
        const result = computeCellarTotals([{ qty: 6, purchasePrice: 100, estimatedValue: 150 }]);
        expect(result.totalInvested).toBe(600);
        expect(result.totalEstimated).toBe(900);
        expect(result.valuedBottles).toBe(1);
    });

    it('aggregates multiple bottles correctly', () => {
        const cellar = [
            { qty: 6,  purchasePrice: 100, estimatedValue: 150 },
            { qty: 12, purchasePrice: 50,  estimatedValue: 75  },
            { qty: 3,  purchasePrice: 200 }, // no valuation → fallback
        ];
        const result = computeCellarTotals(cellar);
        expect(result.totalInvested).toBe(6 * 100 + 12 * 50 + 3 * 200); // 1800
        expect(result.totalEstimated).toBe(6 * 150 + 12 * 75 + 3 * 200); // 900+900+600 = 2400
        expect(result.totalBottles).toBe(21);
        expect(result.valuedBottles).toBe(2);
    });

    it('handles missing qty and purchasePrice gracefully', () => {
        const result = computeCellarTotals([{ qty: null, purchasePrice: undefined }]);
        expect(result.totalInvested).toBe(0);
        expect(result.totalBottles).toBe(0);
    });

    it('ignores NaN estimatedValue (falls back to cost)', () => {
        const result = computeCellarTotals([{ qty: 2, purchasePrice: 50, estimatedValue: NaN }]);
        expect(result.totalEstimated).toBe(100);
        expect(result.valuedBottles).toBe(0);
    });
});

// ── calculateBottleGain ───────────────────────────────────────────────────────

describe('calculateBottleGain', () => {
    it('calculates a positive gain', () => {
        const result = calculateBottleGain(6, 100, 150);
        expect(result.totalInvested).toBe(600);
        expect(result.totalEstimated).toBe(900);
        expect(result.gain).toBe(300);
        expect(result.gainPct).toBeCloseTo(50, 1);
    });

    it('calculates a negative gain (loss)', () => {
        const result = calculateBottleGain(3, 200, 150);
        expect(result.gain).toBe(-150);
        expect(result.gainPct).toBeCloseTo(-25, 1);
    });

    it('returns zero gain when no estimated value provided', () => {
        const result = calculateBottleGain(6, 100, null);
        expect(result.gain).toBe(0);
        expect(result.gainPct).toBe(0);
    });

    it('returns gainPct of 0 when nothing invested', () => {
        const result = calculateBottleGain(0, 0, 100);
        expect(result.gainPct).toBe(0);
    });

    it('handles single bottle correctly', () => {
        const result = calculateBottleGain(1, 50, 75);
        expect(result.totalInvested).toBe(50);
        expect(result.totalEstimated).toBe(75);
        expect(result.gain).toBe(25);
        expect(result.gainPct).toBeCloseTo(50, 1);
    });
});

// ── groupBottlesByDimension ───────────────────────────────────────────────────

describe('groupBottlesByDimension', () => {
    const cellar = [
        { qty: 6,  purchasePrice: 100, estimatedValue: 150, region: 'Bordeaux',      varietal: 'Cabernet Sauvignon', country: 'France'    },
        { qty: 12, purchasePrice: 50,  estimatedValue: 80,  region: 'Bordeaux',      varietal: 'Merlot',             country: 'France'    },
        { qty: 3,  purchasePrice: 200,                       region: 'Barossa Valley', varietal: 'Shiraz',             country: 'Australia' },
    ];

    it('groups by region and sums bottles', () => {
        const groups = groupBottlesByDimension(cellar, 'region');
        expect(Object.keys(groups)).toHaveLength(2);
        expect(groups['Bordeaux'].bottles).toBe(18);
        expect(groups['Barossa Valley'].bottles).toBe(3);
    });

    it('groups by country', () => {
        const groups = groupBottlesByDimension(cellar, 'country');
        expect(groups['France'].bottles).toBe(18);
        expect(groups['Australia'].bottles).toBe(3);
    });

    it('groups by varietal', () => {
        const groups = groupBottlesByDimension(cellar, 'varietal');
        expect(Object.keys(groups)).toHaveLength(3);
        expect(groups['Cabernet Sauvignon'].bottles).toBe(6);
        expect(groups['Merlot'].bottles).toBe(12);
        expect(groups['Shiraz'].bottles).toBe(3);
    });

    it('uses "Unknown" for missing dimension values', () => {
        const groups = groupBottlesByDimension([{ qty: 1, purchasePrice: 100 }], 'region');
        expect(groups['Unknown']).toBeDefined();
        expect(groups['Unknown'].bottles).toBe(1);
    });

    it('falls back to invested when estimatedValue is absent', () => {
        const groups = groupBottlesByDimension([{ qty: 3, purchasePrice: 200, region: 'Barossa Valley' }], 'region');
        expect(groups['Barossa Valley'].estimated).toBe(600);
        expect(groups['Barossa Valley'].invested).toBe(600);
    });

    it('uses estimatedValue for estimated total', () => {
        const groups = groupBottlesByDimension([{ qty: 6, purchasePrice: 100, estimatedValue: 150, region: 'Bordeaux' }], 'region');
        expect(groups['Bordeaux'].estimated).toBe(900);
        expect(groups['Bordeaux'].invested).toBe(600);
    });

    it('handles an empty cellar', () => {
        const groups = groupBottlesByDimension([], 'region');
        expect(Object.keys(groups)).toHaveLength(0);
    });

    it('handles null cellar input', () => {
        const groups = groupBottlesByDimension(null, 'country');
        expect(Object.keys(groups)).toHaveLength(0);
    });

    it('returns "Unknown" for an unrecognised dimension key', () => {
        const groups = groupBottlesByDimension([{ qty: 1, purchasePrice: 10, region: 'Champagne' }], 'winemaker');
        expect(groups['Unknown']).toBeDefined();
    });
});

// ── validateBottle ────────────────────────────────────────────────────────────

describe('validateBottle', () => {
    const base = { name: 'Château Margaux', qty: 6, purchasePrice: 150 };

    it('accepts a valid bottle', () => {
        const { valid, errors } = validateBottle(base);
        expect(valid).toBe(true);
        expect(errors).toHaveLength(0);
    });

    it('accepts zero purchase price (gift / free sample)', () => {
        expect(validateBottle({ ...base, purchasePrice: 0 }).valid).toBe(true);
    });

    it('accepts null vintage (unknown year)', () => {
        expect(validateBottle({ ...base, vintage: null }).valid).toBe(true);
    });

    it('accepts a valid vintage year', () => {
        expect(validateBottle({ ...base, vintage: 2015 }).valid).toBe(true);
    });

    it('rejects empty name', () => {
        const { valid, errors } = validateBottle({ ...base, name: '' });
        expect(valid).toBe(false);
        expect(errors.some(e => e.toLowerCase().includes('name'))).toBe(true);
    });

    it('rejects whitespace-only name', () => {
        const { valid } = validateBottle({ ...base, name: '   ' });
        expect(valid).toBe(false);
    });

    it('rejects null name', () => {
        const { valid } = validateBottle({ ...base, name: null });
        expect(valid).toBe(false);
    });

    it('rejects zero quantity', () => {
        const { valid, errors } = validateBottle({ ...base, qty: 0 });
        expect(valid).toBe(false);
        expect(errors.some(e => e.toLowerCase().includes('quantity'))).toBe(true);
    });

    it('rejects fractional quantity', () => {
        const { valid } = validateBottle({ ...base, qty: 1.5 });
        expect(valid).toBe(false);
    });

    it('rejects negative quantity', () => {
        const { valid } = validateBottle({ ...base, qty: -3 });
        expect(valid).toBe(false);
    });

    it('rejects negative purchase price', () => {
        const { valid, errors } = validateBottle({ ...base, purchasePrice: -10 });
        expect(valid).toBe(false);
        expect(errors.some(e => e.toLowerCase().includes('price'))).toBe(true);
    });

    it('rejects vintage before 1800', () => {
        const { valid } = validateBottle({ ...base, vintage: 1799 });
        expect(valid).toBe(false);
    });

    it('rejects a future vintage beyond next year', () => {
        const { valid } = validateBottle({ ...base, vintage: new Date().getFullYear() + 5 });
        expect(valid).toBe(false);
    });

    it('rejects null data entirely', () => {
        const { valid } = validateBottle(null);
        expect(valid).toBe(false);
    });

    it('collects multiple errors at once', () => {
        const { errors } = validateBottle({ name: '', qty: 0, purchasePrice: -1 });
        expect(errors.length).toBeGreaterThanOrEqual(3);
    });
});

// ── buildBottleFromScan ───────────────────────────────────────────────────────

describe('buildBottleFromScan', () => {
    const fullScan = {
        name:        'Château Margaux',
        winery:      'Château Margaux',
        vintage:     2015,
        region:      'Bordeaux',
        appellation: 'Margaux AOC',
        varietal:    'Cabernet Sauvignon blend',
        country:     'France',
        alcohol:     '13.5%',
        notes:       'Grand Vin, 2nd largest first growth',
    };

    it('maps all recognised fields from a full scan result', () => {
        const bottle = buildBottleFromScan(fullScan);
        expect(bottle.name).toBe('Château Margaux');
        expect(bottle.winery).toBe('Château Margaux');
        expect(bottle.vintage).toBe(2015);
        expect(bottle.region).toBe('Bordeaux');
        expect(bottle.appellation).toBe('Margaux AOC');
        expect(bottle.varietal).toBe('Cabernet Sauvignon blend');
        expect(bottle.country).toBe('France');
        expect(bottle.alcohol).toBe('13.5%');
        expect(bottle.notes).toBe('Grand Vin, 2nd largest first growth');
    });

    it('converts string vintage to integer', () => {
        const bottle = buildBottleFromScan({ vintage: '2018' });
        expect(bottle.vintage).toBe(2018);
        expect(typeof bottle.vintage).toBe('number');
    });

    it('returns null for missing fields', () => {
        const bottle = buildBottleFromScan({ name: 'Some Wine' });
        expect(bottle.winery).toBeNull();
        expect(bottle.vintage).toBeNull();
        expect(bottle.region).toBeNull();
        expect(bottle.country).toBeNull();
    });

    it('returns empty object for null input', () => {
        expect(buildBottleFromScan(null)).toEqual({});
    });

    it('returns empty object for undefined input', () => {
        expect(buildBottleFromScan(undefined)).toEqual({});
    });

    it('returns empty object for a non-object string', () => {
        expect(buildBottleFromScan('not an object')).toEqual({});
    });

    it('returns empty object for an array', () => {
        expect(buildBottleFromScan(['a', 'b'])).toEqual({});
    });

    it('handles non-parseable vintage gracefully', () => {
        const bottle = buildBottleFromScan({ vintage: 'unknown' });
        expect(bottle.vintage).toBeNull();
    });

    it('does not include extra fields from the scan result', () => {
        const bottle = buildBottleFromScan({ ...fullScan, extraField: 'surprise', qty: 99 });
        expect(bottle.extraField).toBeUndefined();
        expect(bottle.qty).toBeUndefined();
    });
});

// ── buildCellarSnapshot ───────────────────────────────────────────────────────

describe('buildCellarSnapshot', () => {
    const cellar = [
        { qty: 6, purchasePrice: 100, estimatedValue: 150 },
        { qty: 3, purchasePrice: 200 },
    ];

    it('builds a snapshot with correct totals', () => {
        const snap = buildCellarSnapshot(cellar, '2025-01-15T10:00:00.000Z');
        expect(snap.timestamp).toBe('2025-01-15T10:00:00.000Z');
        expect(snap.totalInvested).toBe(6 * 100 + 3 * 200); // 1200
        expect(snap.totalEstimatedValue).toBe(6 * 150 + 3 * 200); // 900+600 = 1500
        expect(snap.bottleCount).toBe(9);
    });

    it('uses current time when no timestamp is provided', () => {
        const before = Date.now();
        const snap   = buildCellarSnapshot(cellar);
        const after  = Date.now();
        const snapMs = new Date(snap.timestamp).getTime();
        expect(snapMs).toBeGreaterThanOrEqual(before);
        expect(snapMs).toBeLessThanOrEqual(after);
    });

    it('builds a zero snapshot for an empty cellar', () => {
        const snap = buildCellarSnapshot([], '2025-01-01T00:00:00.000Z');
        expect(snap.totalInvested).toBe(0);
        expect(snap.totalEstimatedValue).toBe(0);
        expect(snap.bottleCount).toBe(0);
    });
});

// ── getDrinkStatus ────────────────────────────────────────────────────────────

describe('getDrinkStatus', () => {
    // Window "2024-2030" (start=2024, end=2030, mid=2027)

    it('returns not-ready when before the window', () => {
        expect(getDrinkStatus('2028-2035', 2025)).toBe('not-ready');
    });

    it('returns ready in the first half of the window', () => {
        // Window 2024-2030, mid=2027; year 2025 ≤ 2027 → ready
        expect(getDrinkStatus('2024-2030', 2025)).toBe('ready');
    });

    it('returns ready exactly at the midpoint', () => {
        // mid of 2024-2030 = floor((2030-2024)/2)+2024 = 3+2024 = 2027
        expect(getDrinkStatus('2024-2030', 2027)).toBe('ready');
    });

    it('returns at-peak in the second half of the window', () => {
        expect(getDrinkStatus('2024-2030', 2029)).toBe('at-peak');
    });

    it('returns past-peak after the window', () => {
        expect(getDrinkStatus('2020-2024', 2026)).toBe('past-peak');
    });

    it('handles a single-year window', () => {
        expect(getDrinkStatus('2026', 2025)).toBe('not-ready');
        expect(getDrinkStatus('2026', 2026)).toBe('ready');
        expect(getDrinkStatus('2026', 2027)).toBe('past-peak');
    });

    it('returns unknown for null input', () => {
        expect(getDrinkStatus(null)).toBe('unknown');
    });

    it('returns unknown for empty string', () => {
        expect(getDrinkStatus('')).toBe('unknown');
    });

    it('returns unknown for non-date strings', () => {
        expect(getDrinkStatus('Now onwards')).toBe('unknown');
    });

    it('handles en-dash separator', () => {
        expect(getDrinkStatus('2024–2030', 2029)).toBe('at-peak');
    });

    it('uses current year when no override provided', () => {
        // Use a window guaranteed to be in the future (≥ current year + 10)
        const far = (new Date().getFullYear() + 10).toString();
        expect(getDrinkStatus(`${far}-${Number(far) + 5}`)).toBe('not-ready');
    });
});

// ── filterBottles ─────────────────────────────────────────────────────────────

describe('filterBottles', () => {
    const cellar = [
        { name: 'Château Margaux', winery: 'Château Margaux', region: 'Bordeaux',
          varietal: 'Cabernet Sauvignon', country: 'France', appellation: 'Margaux AOC', vintage: 2018 },
        { name: 'Penfolds Grange', winery: 'Penfolds', region: 'Barossa Valley',
          varietal: 'Shiraz', country: 'Australia', appellation: null, vintage: 2017 },
        { name: 'Opus One', winery: 'Opus One Winery', region: 'Napa Valley',
          varietal: 'Cabernet Sauvignon', country: 'USA', appellation: null, vintage: 2019 },
    ];

    it('returns all bottles when term is empty', () => {
        expect(filterBottles(cellar, '')).toHaveLength(3);
    });

    it('returns all bottles when term is null', () => {
        expect(filterBottles(cellar, null)).toHaveLength(3);
    });

    it('returns empty array for empty cellar', () => {
        expect(filterBottles([], 'bordeaux')).toHaveLength(0);
    });

    it('returns empty array for null cellar', () => {
        expect(filterBottles(null, 'bordeaux')).toHaveLength(0);
    });

    it('matches by wine name (case-insensitive)', () => {
        const result = filterBottles(cellar, 'margaux');
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Château Margaux');
    });

    it('matches by region', () => {
        const result = filterBottles(cellar, 'napa');
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Opus One');
    });

    it('matches by varietal across multiple bottles', () => {
        const result = filterBottles(cellar, 'cabernet sauvignon');
        expect(result).toHaveLength(2);
    });

    it('matches by country', () => {
        const result = filterBottles(cellar, 'australia');
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Penfolds Grange');
    });

    it('matches by vintage string', () => {
        const result = filterBottles(cellar, '2019');
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Opus One');
    });

    it('returns no results for non-matching term', () => {
        expect(filterBottles(cellar, 'burgundy')).toHaveLength(0);
    });

    it('trims whitespace from search term', () => {
        const result = filterBottles(cellar, '  grange  ');
        expect(result).toHaveLength(1);
    });
});

// ── sortBottles ───────────────────────────────────────────────────────────────

describe('sortBottles', () => {
    const bottles = [
        { name: 'Zinfandel Reserve', vintage: 2015, estimatedValue: 80,  purchasePrice: 60 },
        { name: 'Château Petrus',    vintage: 2019, estimatedValue: 500, purchasePrice: 400 },
        { name: 'Barossa Shiraz',    vintage: 2012, estimatedValue: 120, purchasePrice: 90 },
    ];

    it('does not mutate the input array', () => {
        const copy = [...bottles];
        sortBottles(bottles, 'name');
        expect(bottles[0].name).toBe(copy[0].name); // original order preserved
    });

    it('sorts by name A-Z', () => {
        const result = sortBottles(bottles, 'name');
        expect(result[0].name).toBe('Barossa Shiraz');
        expect(result[1].name).toBe('Château Petrus');
        expect(result[2].name).toBe('Zinfandel Reserve');
    });

    it('sorts by vintage newest first', () => {
        const result = sortBottles(bottles, 'vintage-desc');
        expect(result[0].vintage).toBe(2019);
        expect(result[1].vintage).toBe(2015);
        expect(result[2].vintage).toBe(2012);
    });

    it('sorts by estimated value highest first', () => {
        const result = sortBottles(bottles, 'value-desc');
        expect(result[0].estimatedValue).toBe(500);
        expect(result[1].estimatedValue).toBe(120);
        expect(result[2].estimatedValue).toBe(80);
    });

    it('sorts by gain percentage highest first', () => {
        // Petrus: (500-400)/400 = 25%
        // Barossa: (120-90)/90  ≈ 33.3%
        // Zinfandel: (80-60)/60 ≈ 33.3%
        const result = sortBottles(bottles, 'gain-desc');
        expect(result[0].name).not.toBe('Château Petrus'); // Petrus lowest gain pct
    });

    it('preserves original order for "added" mode', () => {
        const result = sortBottles(bottles, 'added');
        expect(result[0].name).toBe(bottles[0].name);
        expect(result[1].name).toBe(bottles[1].name);
        expect(result[2].name).toBe(bottles[2].name);
    });

    it('preserves original order for unknown sort mode', () => {
        const result = sortBottles(bottles, 'unknown');
        expect(result[0].name).toBe(bottles[0].name);
    });

    it('returns empty array for empty input', () => {
        expect(sortBottles([], 'name')).toHaveLength(0);
    });

    it('returns empty array for null input', () => {
        expect(sortBottles(null, 'name')).toHaveLength(0);
    });

    it('handles missing estimatedValue gracefully (falls back to purchasePrice)', () => {
        const withNull = [
            { name: 'A', purchasePrice: 100, estimatedValue: null },
            { name: 'B', purchasePrice: 200, estimatedValue: null },
        ];
        const result = sortBottles(withNull, 'value-desc');
        expect(result[0].name).toBe('B');
    });
});

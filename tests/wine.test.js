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

// ── Shared test fixtures ──────────────────────────────────────────────────────
// Bottles now carry wineId (UUID FK to the wines catalog) alongside the flat
// fields that were previously all stored in wine_bottles. Identity fields
// (name, winery, vintage, region …) come from the shared wines table; holding
// fields (qty, purchasePrice, estimatedValue …) come from user_wines.

const WINE_ID_A = '11111111-1111-1111-1111-111111111111'; // Château Margaux 2018
const WINE_ID_B = '22222222-2222-2222-2222-222222222222'; // Penfolds Grange 2017
const WINE_ID_C = '33333333-3333-3333-3333-333333333333'; // Opus One 2019

const makeBottle = (overrides = {}) => ({
    id:             'uw-' + Math.random().toString(36).slice(2),
    wineId:         WINE_ID_A,
    name:           'Château Margaux',
    winery:         'Château Margaux',
    vintage:        2018,
    region:         'Bordeaux',
    appellation:    'Margaux AOC',
    varietal:       'Cabernet Sauvignon',
    country:        'France',
    alcohol:        '13.5%',
    drinkWindow:    '2025-2040',
    qty:            6,
    purchasePrice:  150,
    purchaseDate:   '2022-01-01',
    storage:        'Home cellar',
    notes:          null,
    estimatedValue: null,
    valueLow:       null,
    valueHigh:      null,
    valuationNote:  null,
    lastValuedAt:   null,
    ...overrides,
});

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
        const result = computeCellarTotals([makeBottle({ qty: 6, purchasePrice: 100 })]);
        expect(result.totalInvested).toBe(600);
        expect(result.totalEstimated).toBe(600);
        expect(result.totalBottles).toBe(6);
        expect(result.valuedBottles).toBe(0);
    });

    it('uses estimatedValue when present', () => {
        const result = computeCellarTotals([makeBottle({ qty: 6, purchasePrice: 100, estimatedValue: 150 })]);
        expect(result.totalInvested).toBe(600);
        expect(result.totalEstimated).toBe(900);
        expect(result.valuedBottles).toBe(1);
    });

    it('aggregates multiple bottles correctly', () => {
        const cellar = [
            makeBottle({ qty: 6,  purchasePrice: 100, estimatedValue: 150 }),
            makeBottle({ qty: 12, purchasePrice: 50,  estimatedValue: 75  }),
            makeBottle({ qty: 3,  purchasePrice: 200 }),  // no valuation → fallback
        ];
        const result = computeCellarTotals(cellar);
        expect(result.totalInvested).toBe(6 * 100 + 12 * 50 + 3 * 200); // 1800
        expect(result.totalEstimated).toBe(6 * 150 + 12 * 75 + 3 * 200); // 2400
        expect(result.totalBottles).toBe(21);
        expect(result.valuedBottles).toBe(2);
    });

    // New schema: same wine (same wineId) can have multiple user_wines rows
    // (bought at different times / prices). Each row is a separate holding;
    // computeCellarTotals must aggregate them all independently.
    it('aggregates two purchase lots of the same wine as separate holdings', () => {
        const lot1 = makeBottle({ wineId: WINE_ID_A, qty: 6, purchasePrice: 100, estimatedValue: 200 });
        const lot2 = makeBottle({ wineId: WINE_ID_A, qty: 3, purchasePrice: 150, estimatedValue: 200 });
        const result = computeCellarTotals([lot1, lot2]);
        expect(result.totalInvested).toBe(6 * 100 + 3 * 150);   // 1050
        expect(result.totalEstimated).toBe((6 + 3) * 200);        // 1800
        expect(result.totalBottles).toBe(9);
        expect(result.valuedBottles).toBe(2);
    });

    it('handles a bottle with null purchasePrice (no cost basis entered)', () => {
        const result = computeCellarTotals([makeBottle({ qty: 3, purchasePrice: null })]);
        expect(result.totalInvested).toBe(0);
        expect(result.totalBottles).toBe(3);
    });

    it('handles missing qty and purchasePrice gracefully', () => {
        const result = computeCellarTotals([makeBottle({ qty: null, purchasePrice: undefined })]);
        expect(result.totalInvested).toBe(0);
        expect(result.totalBottles).toBe(0);
    });

    it('ignores NaN estimatedValue (falls back to cost)', () => {
        const result = computeCellarTotals([makeBottle({ qty: 2, purchasePrice: 50, estimatedValue: NaN })]);
        expect(result.totalEstimated).toBe(100);
        expect(result.valuedBottles).toBe(0);
    });

    it('includes valueLow / valueHigh fields on bottles without affecting totals', () => {
        // These fields are now DB-persisted but are not used by computeCellarTotals —
        // the canonical estimated value is estimatedValue.
        const result = computeCellarTotals([
            makeBottle({ qty: 1, purchasePrice: 100, estimatedValue: 150, valueLow: 120, valueHigh: 180 }),
        ]);
        expect(result.totalEstimated).toBe(150); // uses estimatedValue, not valueLow/valueHigh
        expect(result.valuedBottles).toBe(1);
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
        makeBottle({ wineId: WINE_ID_A, qty: 6,  purchasePrice: 100, estimatedValue: 150, region: 'Bordeaux',       varietal: 'Cabernet Sauvignon', country: 'France'    }),
        makeBottle({ wineId: WINE_ID_A, qty: 12, purchasePrice: 50,  estimatedValue: 80,  region: 'Bordeaux',       varietal: 'Merlot',             country: 'France'    }),
        makeBottle({ wineId: WINE_ID_B, qty: 3,  purchasePrice: 200,                      region: 'Barossa Valley', varietal: 'Shiraz',             country: 'Australia' }),
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

    it('merges two purchase lots of the same wine into one regional group', () => {
        // Both lots share wineId WINE_ID_A and region 'Bordeaux' — they must land
        // in the same group (the grouping key is region, not wineId).
        const lot1 = makeBottle({ wineId: WINE_ID_A, qty: 6, purchasePrice: 100, region: 'Bordeaux' });
        const lot2 = makeBottle({ wineId: WINE_ID_A, qty: 3, purchasePrice: 150, region: 'Bordeaux' });
        const groups = groupBottlesByDimension([lot1, lot2], 'region');
        expect(Object.keys(groups)).toHaveLength(1);
        expect(groups['Bordeaux'].bottles).toBe(9);
        expect(groups['Bordeaux'].invested).toBe(6 * 100 + 3 * 150);
    });

    it('uses "Unknown" for missing dimension values', () => {
        const groups = groupBottlesByDimension([makeBottle({ region: undefined })], 'region');
        expect(groups['Unknown']).toBeDefined();
        expect(groups['Unknown'].bottles).toBe(6);
    });

    it('falls back to invested when estimatedValue is absent', () => {
        const groups = groupBottlesByDimension(
            [makeBottle({ qty: 3, purchasePrice: 200, estimatedValue: undefined, region: 'Barossa Valley' })],
            'region',
        );
        expect(groups['Barossa Valley'].estimated).toBe(600);
        expect(groups['Barossa Valley'].invested).toBe(600);
    });

    it('uses estimatedValue for estimated total', () => {
        const groups = groupBottlesByDimension(
            [makeBottle({ qty: 6, purchasePrice: 100, estimatedValue: 150, region: 'Bordeaux' })],
            'region',
        );
        expect(groups['Bordeaux'].estimated).toBe(900);
        expect(groups['Bordeaux'].invested).toBe(600);
    });

    it('handles an empty cellar', () => {
        expect(Object.keys(groupBottlesByDimension([], 'region'))).toHaveLength(0);
    });

    it('handles null cellar input', () => {
        expect(Object.keys(groupBottlesByDimension(null, 'country'))).toHaveLength(0);
    });

    it('returns "Unknown" for an unrecognised dimension key', () => {
        const groups = groupBottlesByDimension([makeBottle({ region: 'Champagne' })], 'winemaker');
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

    // New schema: purchase_price is nullable in user_wines — bottle may have no
    // cost basis (e.g. received as a gift before price was tracked).
    it('accepts null purchase price (no cost basis)', () => {
        expect(validateBottle({ ...base, purchasePrice: null }).valid).toBe(true);
    });

    it('accepts undefined purchase price (no cost basis)', () => {
        const { name, qty } = base;
        expect(validateBottle({ name, qty }).valid).toBe(true);
    });

    it('accepts null vintage (unknown year)', () => {
        expect(validateBottle({ ...base, vintage: null }).valid).toBe(true);
    });

    it('accepts a valid vintage year', () => {
        expect(validateBottle({ ...base, vintage: 2015 }).valid).toBe(true);
    });

    it('accepts a bottle with wineId set (existing catalog entry)', () => {
        expect(validateBottle({ ...base, wineId: WINE_ID_A }).valid).toBe(true);
    });

    it('rejects empty name', () => {
        const { valid, errors } = validateBottle({ ...base, name: '' });
        expect(valid).toBe(false);
        expect(errors.some(e => e.toLowerCase().includes('name'))).toBe(true);
    });

    it('rejects whitespace-only name', () => {
        expect(validateBottle({ ...base, name: '   ' }).valid).toBe(false);
    });

    it('rejects null name', () => {
        expect(validateBottle({ ...base, name: null }).valid).toBe(false);
    });

    it('rejects zero quantity', () => {
        const { valid, errors } = validateBottle({ ...base, qty: 0 });
        expect(valid).toBe(false);
        expect(errors.some(e => e.toLowerCase().includes('quantity'))).toBe(true);
    });

    it('rejects fractional quantity', () => {
        expect(validateBottle({ ...base, qty: 1.5 }).valid).toBe(false);
    });

    it('rejects negative quantity', () => {
        expect(validateBottle({ ...base, qty: -3 }).valid).toBe(false);
    });

    it('rejects negative purchase price', () => {
        const { valid, errors } = validateBottle({ ...base, purchasePrice: -10 });
        expect(valid).toBe(false);
        expect(errors.some(e => e.toLowerCase().includes('price'))).toBe(true);
    });

    it('rejects NaN purchase price', () => {
        expect(validateBottle({ ...base, purchasePrice: NaN }).valid).toBe(false);
    });

    it('rejects vintage before 1800', () => {
        expect(validateBottle({ ...base, vintage: 1799 }).valid).toBe(false);
    });

    it('rejects a future vintage beyond next year', () => {
        expect(validateBottle({ ...base, vintage: new Date().getFullYear() + 5 }).valid).toBe(false);
    });

    it('rejects null data entirely', () => {
        expect(validateBottle(null).valid).toBe(false);
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

    it('maps all recognised identity fields from a full scan result', () => {
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

    // wineId is assigned by the storage layer after the wine catalog entry is
    // resolved/created — it must never appear in scan output.
    it('does not include wineId in the scan output', () => {
        const bottle = buildBottleFromScan(fullScan);
        expect(bottle.wineId).toBeUndefined();
    });

    // Holding fields (qty, purchasePrice, etc.) are entered by the user
    // after scanning — they must not be injected by the scan.
    it('does not include holding fields (qty, purchasePrice, estimatedValue)', () => {
        const bottle = buildBottleFromScan({ ...fullScan, qty: 99, purchasePrice: 999, estimatedValue: 1 });
        expect(bottle.qty).toBeUndefined();
        expect(bottle.purchasePrice).toBeUndefined();
        expect(bottle.estimatedValue).toBeUndefined();
    });

    it('does not include valuation fields (valueLow, valueHigh, valuationNote)', () => {
        const bottle = buildBottleFromScan({ ...fullScan, valueLow: 100, valueHigh: 200 });
        expect(bottle.valueLow).toBeUndefined();
        expect(bottle.valueHigh).toBeUndefined();
        expect(bottle.valuationNote).toBeUndefined();
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
        expect(buildBottleFromScan({ vintage: 'unknown' }).vintage).toBeNull();
    });
});

// ── buildCellarSnapshot ───────────────────────────────────────────────────────

describe('buildCellarSnapshot', () => {
    const cellar = [
        makeBottle({ qty: 6, purchasePrice: 100, estimatedValue: 150 }),
        makeBottle({ qty: 3, purchasePrice: 200 }),
    ];

    it('builds a snapshot with correct totals', () => {
        const snap = buildCellarSnapshot(cellar, '2025-01-15T10:00:00.000Z');
        expect(snap.timestamp).toBe('2025-01-15T10:00:00.000Z');
        expect(snap.totalInvested).toBe(6 * 100 + 3 * 200);        // 1200
        expect(snap.totalEstimatedValue).toBe(6 * 150 + 3 * 200);  // 1500
        expect(snap.bottleCount).toBe(9);
    });

    it('builds a correct snapshot with two lots of the same wine', () => {
        const lots = [
            makeBottle({ wineId: WINE_ID_A, qty: 6, purchasePrice: 100, estimatedValue: 200 }),
            makeBottle({ wineId: WINE_ID_A, qty: 3, purchasePrice: 120, estimatedValue: 200 }),
        ];
        const snap = buildCellarSnapshot(lots, '2025-06-01T00:00:00.000Z');
        expect(snap.totalInvested).toBe(6 * 100 + 3 * 120);  // 960
        expect(snap.totalEstimatedValue).toBe(9 * 200);        // 1800
        expect(snap.bottleCount).toBe(9);
    });

    it('uses current time when no timestamp is provided', () => {
        const before = Date.now();
        const snap   = buildCellarSnapshot(cellar);
        const after  = Date.now();
        expect(new Date(snap.timestamp).getTime()).toBeGreaterThanOrEqual(before);
        expect(new Date(snap.timestamp).getTime()).toBeLessThanOrEqual(after);
    });

    it('builds a zero snapshot for an empty cellar', () => {
        const snap = buildCellarSnapshot([], '2025-01-01T00:00:00.000Z');
        expect(snap.totalInvested).toBe(0);
        expect(snap.totalEstimatedValue).toBe(0);
        expect(snap.bottleCount).toBe(0);
    });
});

// ── getDrinkStatus ────────────────────────────────────────────────────────────
// drinkWindow is now stored on the shared wines row (wines.drink_window) and
// surfaced as bottle.drinkWindow after the JOIN in loadBottles(). The pure
// function itself is unchanged — these tests verify it still works correctly.

describe('getDrinkStatus', () => {
    it('returns not-ready when before the window', () => {
        expect(getDrinkStatus('2028-2035', 2025)).toBe('not-ready');
    });

    it('returns ready in the first half of the window', () => {
        expect(getDrinkStatus('2024-2030', 2025)).toBe('ready');
    });

    it('returns ready exactly at the midpoint', () => {
        // mid of 2024-2030 = floor((2030-2024)/2)+2024 = 2027
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
        const far = (new Date().getFullYear() + 10).toString();
        expect(getDrinkStatus(`${far}-${Number(far) + 5}`)).toBe('not-ready');
    });
});

// ── filterBottles ─────────────────────────────────────────────────────────────

describe('filterBottles', () => {
    const cellar = [
        makeBottle({ wineId: WINE_ID_A, name: 'Château Margaux', winery: 'Château Margaux',
            region: 'Bordeaux', varietal: 'Cabernet Sauvignon', country: 'France',
            appellation: 'Margaux AOC', vintage: 2018 }),
        makeBottle({ wineId: WINE_ID_B, name: 'Penfolds Grange', winery: 'Penfolds',
            region: 'Barossa Valley', varietal: 'Shiraz', country: 'Australia',
            appellation: null, vintage: 2017 }),
        makeBottle({ wineId: WINE_ID_C, name: 'Opus One', winery: 'Opus One Winery',
            region: 'Napa Valley', varietal: 'Cabernet Sauvignon', country: 'USA',
            appellation: null, vintage: 2019 }),
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
        expect(filterBottles(cellar, 'cabernet sauvignon')).toHaveLength(2);
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
        expect(filterBottles(cellar, '  grange  ')).toHaveLength(1);
    });

    // wineId is a UUID — it must not accidentally match search terms.
    it('does not match against wineId (UUID not searchable)', () => {
        // Search for a substring that appears in WINE_ID_A but not in any text field
        const result = filterBottles(cellar, '11111111');
        expect(result).toHaveLength(0);
    });

    it('returns both lots when two purchases of the same wine match the query', () => {
        const twoLots = [
            makeBottle({ wineId: WINE_ID_A, name: 'Margaux', purchasePrice: 100 }),
            makeBottle({ wineId: WINE_ID_A, name: 'Margaux', purchasePrice: 150 }),
        ];
        expect(filterBottles(twoLots, 'margaux')).toHaveLength(2);
    });
});

// ── sortBottles ───────────────────────────────────────────────────────────────

describe('sortBottles', () => {
    const bottles = [
        makeBottle({ name: 'Zinfandel Reserve', vintage: 2015, estimatedValue: 80,  purchasePrice: 60,  valueLow: 70,  valueHigh: 90  }),
        makeBottle({ name: 'Château Petrus',    vintage: 2019, estimatedValue: 500, purchasePrice: 400, valueLow: 450, valueHigh: 550, valuationNote: 'Top Pomerol' }),
        makeBottle({ name: 'Barossa Shiraz',    vintage: 2012, estimatedValue: 120, purchasePrice: 90,  valueLow: 100, valueHigh: 140 }),
    ];

    it('does not mutate the input array', () => {
        const copy = [...bottles];
        sortBottles(bottles, 'name');
        expect(bottles[0].name).toBe(copy[0].name);
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
        expect(result[result.length - 1].name).toBe('Château Petrus'); // lowest gain%
    });

    it('preserves original order for "added" mode', () => {
        const result = sortBottles(bottles, 'added');
        expect(result[0].name).toBe(bottles[0].name);
        expect(result[1].name).toBe(bottles[1].name);
        expect(result[2].name).toBe(bottles[2].name);
    });

    it('preserves original order for unknown sort mode', () => {
        expect(sortBottles(bottles, 'unknown')[0].name).toBe(bottles[0].name);
    });

    it('returns empty array for empty input', () => {
        expect(sortBottles([], 'name')).toHaveLength(0);
    });

    it('returns empty array for null input', () => {
        expect(sortBottles(null, 'name')).toHaveLength(0);
    });

    it('falls back to purchasePrice for value sort when estimatedValue is null', () => {
        const withNull = [
            makeBottle({ name: 'A', purchasePrice: 100, estimatedValue: null }),
            makeBottle({ name: 'B', purchasePrice: 200, estimatedValue: null }),
        ];
        const result = sortBottles(withNull, 'value-desc');
        expect(result[0].name).toBe('B');
    });

    it('sorts two lots of same wine independently by value', () => {
        const lots = [
            makeBottle({ wineId: WINE_ID_A, name: 'Margaux', purchasePrice: 100, estimatedValue: 150 }),
            makeBottle({ wineId: WINE_ID_A, name: 'Margaux', purchasePrice: 130, estimatedValue: 200 }),
        ];
        const result = sortBottles(lots, 'value-desc');
        expect(result[0].estimatedValue).toBe(200);
        expect(result[1].estimatedValue).toBe(150);
    });

    it('valuationNote does not affect sort order', () => {
        // Two bottles with the same estimatedValue but different valuationNote
        const pair = [
            makeBottle({ name: 'X', estimatedValue: 100, valuationNote: 'Excellent' }),
            makeBottle({ name: 'Y', estimatedValue: 100, valuationNote: null }),
        ];
        const result = sortBottles(pair, 'value-desc');
        // Both have same value — order should be stable (no crash or reorder)
        expect(result).toHaveLength(2);
    });
});

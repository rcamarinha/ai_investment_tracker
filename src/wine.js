/**
 * Pure functions for the Wine Cellar Tracker — imported by the Vitest test suite.
 *
 * Mirrors computation logic from wine/cellar.js and wine/ui.js without any
 * DOM or state module dependencies. Keep in sync with the live modules.
 */

// ── Cellar Totals ────────────────────────────────────────────────────────────

/**
 * Compute aggregate totals from an array of bottle objects.
 * Falls back to cost basis for bottles without an estimated value.
 *
 * @param {Array} cellar
 * @returns {{ totalInvested: number, totalEstimated: number, totalBottles: number, valuedBottles: number }}
 */
export function computeCellarTotals(cellar) {
    let totalInvested  = 0;
    let totalEstimated = 0;
    let totalBottles   = 0;
    let valuedBottles  = 0;

    (cellar || []).forEach(b => {
        const qty           = b.qty           || 0;
        const purchasePrice = b.purchasePrice || 0;
        const invested      = qty * purchasePrice;

        totalInvested += invested;
        totalBottles  += qty;

        if (b.estimatedValue != null && !isNaN(b.estimatedValue)) {
            totalEstimated += qty * b.estimatedValue;
            valuedBottles++;
        } else {
            totalEstimated += invested; // fallback to cost basis
        }
    });

    return { totalInvested, totalEstimated, totalBottles, valuedBottles };
}

// ── Gain / Loss ───────────────────────────────────────────────────────────────

/**
 * Calculate gain/loss for a bottle (or group of bottles at uniform price).
 *
 * @param {number} qty
 * @param {number} purchasePrice  - per bottle
 * @param {number|null} estimatedValue - per bottle; null falls back to purchasePrice
 * @returns {{ totalInvested, totalEstimated, gain, gainPct }}
 */
export function calculateBottleGain(qty, purchasePrice, estimatedValue) {
    const totalInvested  = (qty || 0) * (purchasePrice || 0);
    const perBottleValue = (estimatedValue != null && !isNaN(estimatedValue))
        ? estimatedValue
        : purchasePrice;
    const totalEstimated = (qty || 0) * (perBottleValue || 0);
    const gain    = totalEstimated - totalInvested;
    const gainPct = totalInvested > 0 ? (gain / totalInvested) * 100 : 0;
    return { totalInvested, totalEstimated, gain, gainPct };
}

// ── Allocation Grouping ───────────────────────────────────────────────────────

/**
 * Group bottles by a dimension ('region', 'varietal', or 'country').
 * Returns an object keyed by dimension value with aggregated data.
 *
 * @param {Array}  cellar
 * @param {string} dimension - 'region' | 'varietal' | 'country'
 * @returns {Object} { [key]: { invested, estimated, bottles } }
 */
export function groupBottlesByDimension(cellar, dimension) {
    const groups = {};

    (cellar || []).forEach(b => {
        let key;
        if (dimension === 'region')   key = b.region   || 'Unknown';
        if (dimension === 'varietal') key = b.varietal  || 'Unknown';
        if (dimension === 'country')  key = b.country   || 'Unknown';
        if (key === undefined)        key = 'Unknown';

        const invested  = (b.qty || 0) * (b.purchasePrice || 0);
        const estimated = (b.estimatedValue != null && !isNaN(b.estimatedValue))
            ? (b.qty || 0) * b.estimatedValue
            : invested;

        if (!groups[key]) groups[key] = { invested: 0, estimated: 0, bottles: 0 };
        groups[key].invested  += invested;
        groups[key].estimated += estimated;
        groups[key].bottles   += (b.qty || 0);
    });

    return groups;
}

// ── Bottle Validation ─────────────────────────────────────────────────────────

/**
 * Validate a bottle data object before saving.
 * @param {Object} data
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBottle(data) {
    const errors = [];

    if (!data || !String(data.name || '').trim()) {
        errors.push('Wine name is required');
    }

    const qty = data ? data.qty : undefined;
    if (qty == null || isNaN(qty) || qty < 1 || !Number.isInteger(Number(qty))) {
        errors.push('Quantity must be a positive integer');
    }

    // purchase_price is nullable in user_wines (bottle may have no cost basis)
    const price = data ? data.purchasePrice : undefined;
    if (price != null && (isNaN(price) || price < 0)) {
        errors.push('Purchase price must be a non-negative number');
    }

    if (data && data.vintage != null) {
        const maxVintage = new Date().getFullYear() + 1;
        if (isNaN(data.vintage) || data.vintage < 1800 || data.vintage > maxVintage) {
            errors.push('Vintage must be a valid year (1800 – present)');
        }
    }

    const VALID_BOTTLE_SIZES = ['0.375L', '0.75L', '1.5L', '3.0L', '4.5L', '6.0L', '9.0L', '12.0L', '15.0L'];
    if (data && data.bottleSize != null && !VALID_BOTTLE_SIZES.includes(data.bottleSize)) {
        errors.push(`Bottle size must be one of: ${VALID_BOTTLE_SIZES.join(', ')}`);
    }

    return { valid: errors.length === 0, errors };
}

// ── Scan Result → Bottle ──────────────────────────────────────────────────────

/**
 * Convert a raw Claude Vision scan result (JSON) to a partial bottle object.
 * Safely handles null, undefined, and non-object inputs.
 *
 * @param {*} scanResult
 * @returns {Object}
 */
export function buildBottleFromScan(scanResult) {
    if (!scanResult || typeof scanResult !== 'object' || Array.isArray(scanResult)) {
        return {};
    }
    return {
        name:        scanResult.name        || null,
        winery:      scanResult.winery      || null,
        vintage:     scanResult.vintage != null ? parseInt(String(scanResult.vintage), 10) || null : null,
        region:      scanResult.region      || null,
        appellation: scanResult.appellation || null,
        varietal:    scanResult.varietal    || null,
        country:     scanResult.country     || null,
        alcohol:     scanResult.alcohol     || null,
        bottleSize:  scanResult.bottleSize  || null,
        notes:       scanResult.notes       || null,
    };
}

// ── Drink Window Status ───────────────────────────────────────────────────────

/**
 * Determine the drinking-readiness status of a wine from its drink window string.
 *
 * Strategy: split the window into two halves.
 *   - Before window start  → 'not-ready'
 *   - First half of window → 'ready'
 *   - Second half          → 'at-peak'
 *   - After window end     → 'past-peak'
 *
 * @param {string|null} drinkWindow  - e.g. "2024-2030" or "2028"
 * @param {number}      [currentYear] - defaults to current calendar year
 * @returns {'not-ready'|'ready'|'at-peak'|'past-peak'|'unknown'}
 */
export function getDrinkStatus(drinkWindow, currentYear) {
    if (!drinkWindow || typeof drinkWindow !== 'string') return 'unknown';
    const year = currentYear !== undefined ? currentYear : new Date().getFullYear();

    // Accept "YYYY-YYYY", "YYYY – YYYY", or bare "YYYY"
    const match = drinkWindow.match(/(\d{4})(?:\s*[-–]\s*(\d{4}))?/);
    if (!match) return 'unknown';

    const start = parseInt(match[1], 10);
    const end   = match[2] ? parseInt(match[2], 10) : start;

    if (year < start) return 'not-ready';
    if (year > end)   return 'past-peak';

    const mid = start + Math.floor((end - start) / 2);
    return year <= mid ? 'ready' : 'at-peak';
}

// ── Search Filter ─────────────────────────────────────────────────────────────

/**
 * Return only the bottles whose text fields contain the search term.
 * A blank/null term returns the full array unchanged.
 *
 * Searched fields: name, winery, region, varietal, country, appellation, vintage.
 *
 * @param {Array}       cellar
 * @param {string|null} searchTerm
 * @returns {Array}
 */
export function filterBottles(cellar, searchTerm) {
    const arr  = cellar || [];
    const term = (searchTerm || '').trim().toLowerCase();
    if (!term) return arr;

    return arr.filter(b =>
        (b.name        || '').toLowerCase().includes(term) ||
        (b.winery      || '').toLowerCase().includes(term) ||
        (b.region      || '').toLowerCase().includes(term) ||
        (b.varietal    || '').toLowerCase().includes(term) ||
        (b.country     || '').toLowerCase().includes(term) ||
        (b.appellation || '').toLowerCase().includes(term) ||
        String(b.vintage || '').includes(term)
    );
}

// ── Sort ──────────────────────────────────────────────────────────────────────

/**
 * Return a new sorted copy of a bottles array.
 *
 * @param {Array}  bottles
 * @param {'added'|'name'|'vintage-desc'|'value-desc'|'gain-desc'} sortMode
 * @returns {Array}
 */
export function sortBottles(bottles, sortMode) {
    const arr = [...(bottles || [])];

    switch (sortMode) {
        case 'name':
            return arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        case 'vintage-desc':
            return arr.sort((a, b) => (b.vintage || 0) - (a.vintage || 0));

        case 'value-desc':
            return arr.sort((a, b) =>
                (b.estimatedValue || b.purchasePrice || 0) -
                (a.estimatedValue || a.purchasePrice || 0));

        case 'gain-desc': {
            const pct = bottle =>
                (bottle.estimatedValue && bottle.purchasePrice)
                    ? (bottle.estimatedValue - bottle.purchasePrice) / bottle.purchasePrice
                    : 0;
            return arr.sort((a, b) => pct(b) - pct(a));
        }

        default: // 'added' — preserve insertion order
            return arr;
    }
}


/**
 * Build a snapshot record from the current cellar state.
 *
 * @param {Array}  cellar
 * @param {string} [timestamp] - ISO string; defaults to now
 * @returns {{ timestamp, totalInvested, totalEstimatedValue, bottleCount }}
 */
export function buildCellarSnapshot(cellar, timestamp) {
    const totals = computeCellarTotals(cellar);
    return {
        timestamp:           timestamp || new Date().toISOString(),
        totalInvested:       totals.totalInvested,
        totalEstimatedValue: totals.totalEstimated,
        bottleCount:         totals.totalBottles,
    };
}

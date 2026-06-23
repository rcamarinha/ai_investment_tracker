/**
 * Pure functions for the Hub dashboard — imported by the Vitest test suite.
 *
 * Mirrors the inline script in index.html (hubFmt, loadHubValues computations).
 * No DOM, no state, no Supabase dependencies.
 */

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a numeric EUR value for display on the hub card.
 * Returns '— —' when the value is falsy or below 0.01.
 *
 * @param {number|null|undefined} val
 * @returns {string}
 */
export function hubFmt(val) {
    if (!val || val < 0.01) return '— —';
    return '€ ' + Math.round(val).toLocaleString('en-US');
}

// ── Computation helpers (mirrors loadHubValues inline logic) ──────────────────

/**
 * Compute the stock portfolio cost-basis value from position rows.
 *
 * @param {Array<{shares: number, avg_price: number}>} positions - Rows from `positions` table
 * @returns {number}
 */
export function computeStockValue(positions) {
    return (positions || []).reduce((s, p) => s + ((p.shares || 0) * (p.avg_price || 0)), 0);
}

/**
 * Compute the wine cellar estimated value from wine rows.
 * Bottles without an estimatedValue contribute 0.
 *
 * @param {Array<{qty: number, estimated_value: number|null}>} wines - Rows from `user_wines`
 * @returns {number}
 */
export function computeWineValue(wines) {
    return (wines || []).reduce((s, w) => s + ((w.estimated_value || 0) * (w.qty || 1)), 0);
}

/**
 * Compute the wine cellar purchase cost from wine rows.
 *
 * @param {Array<{qty: number, purchase_price: number|null}>} wines
 * @returns {number}
 */
export function computeWineCost(wines) {
    return (wines || []).reduce((s, w) => s + ((w.purchase_price || 0) * (w.qty || 1)), 0);
}

/**
 * Compute the wine delta label and CSS class for the hub card.
 *
 * Rules (mirror of loadHubValues):
 *  1. If wineValue > 0 AND wineCost > 0   → percentage gain/loss string + "up"/"down" class
 *  2. If wineValue > 0 AND wineCost === 0  → "valued Xd ago" using the most recent last_valued_at
 *  3. Otherwise                            → empty string + "neutral" class
 *
 * @param {number}  wineValue  - Total estimated value (from computeWineValue)
 * @param {number}  wineCost   - Total purchase cost (from computeWineCost)
 * @param {Array}   wines      - Raw wine rows (for last_valued_at lookup)
 * @param {number}  [now]      - Unix ms timestamp (injectable for deterministic tests)
 * @returns {{ text: string, cls: string }}
 */
export function computeWineDelta(wineValue, wineCost, wines, now = Date.now()) {
    if (wineValue > 0 && wineCost > 0) {
        const pct  = (wineValue - wineCost) / wineCost * 100;
        const sign = pct >= 0 ? '+' : '';
        return {
            text: `${sign}${pct.toFixed(1)}%`,
            cls:  pct >= 0 ? 'up' : 'down',
        };
    }

    if (wineValue > 0) {
        const lastValued = (wines || [])
            .filter(w => w.last_valued_at)
            .map(w => new Date(w.last_valued_at))
            .sort((a, b) => b - a)[0];

        if (lastValued) {
            const daysAgo = Math.round((now - lastValued.getTime()) / 86400000);
            return { text: `valued ${daysAgo}d ago`, cls: 'neutral' };
        }
    }

    return { text: '', cls: 'neutral' };
}

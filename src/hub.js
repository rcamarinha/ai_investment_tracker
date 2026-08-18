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
 * Read the stock side of the hub from the latest usable SNAPSHOT.
 *
 * This deliberately replaces the old `computeStockValue(positions)`, which
 * summed `shares × avg_price` from the `positions` table. That table has no
 * currency column, so the sum added pounds to euros and to dollars and then
 * stamped the result '€'. Its removal is the fix: nothing should ever total
 * money across currencies again, and the hub must not carry a third
 * independent copy of currency conversion. The portfolio page already computes
 * this correctly with per-trade FX and writes the EUR figure onto the snapshot.
 *
 * Returns null when there is no snapshot carrying a canonical EUR total —
 * including legacy rows written before the base currency was recorded. A
 * landing page showing a confident number nobody computed is the disease.
 *
 * @param {Object|null} row - snapshot row with total_market_value_eur, timestamp
 * @returns {{value: number, asOf: string|null, excluded: number}|null}
 */
export function computeStockCardEUR(row) {
    if (!row) return null;
    const value = row.total_market_value_eur;
    if (value == null || !Number.isFinite(Number(value))) return null;
    return {
        value: Number(value),
        asOf: row.timestamp || null,
        excluded: Number(row.excluded_positions) || 0,
    };
}

/**
 * Combine the stock card with the wine cellar value into a net worth figure.
 * `partial` is true when any part of it is missing or incomplete, so the UI can
 * mark the number rather than presenting it as a full valuation.
 *
 * @param {{value: number, excluded: number}|null} stockCard
 * @param {number} wineValue - EUR by schema (wine is priced in EUR by definition)
 * @returns {{value: number|null, partial: boolean}}
 */
export function computeNetWorthEUR(stockCard, wineValue) {
    const wine = Number(wineValue) || 0;
    if (!stockCard) {
        // No usable stock figure: report the wine alone, clearly marked partial,
        // never a bare number implying it is the whole portfolio.
        return { value: wine > 0 ? wine : null, partial: true };
    }
    return { value: stockCard.value + wine, partial: (stockCard.excluded || 0) > 0 };
}

/**
 * Short "as of" label for the hub subtitle, e.g. "as of 3 Aug".
 * Returns '' when there is no timestamp.
 */
export function hubAsOfLabel(iso, now = Date.now()) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const days = Math.floor((now - d.getTime()) / 86400000);
    if (days <= 0) return 'as of today';
    if (days === 1) return 'as of yesterday';
    return `as of ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
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

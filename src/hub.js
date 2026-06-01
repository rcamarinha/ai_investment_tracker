/**
 * Pure-logic functions extracted from the hub dashboard inline script in index.html.
 *
 * These mirror the implementations in index.html and must be kept in sync.
 * The single-file architecture of index.html is preserved — this module exists
 * solely to enable automated testing of the core business logic.
 */

/**
 * Format a numeric euro value for the hub card display.
 * Returns '— —' for zero, null, undefined, or values below €0.01.
 *
 * @param {number|null|undefined} val
 * @returns {string}
 */
export function hubFmt(val) {
  if (!val || val < 0.01) return '— —';
  return '€ ' + Math.round(val).toLocaleString('en-US');
}

/**
 * Compute total stock cost basis from a positions array.
 * Each position has { shares, avg_price }.
 *
 * @param {Array<{shares: number, avg_price: number}>|null} positions
 * @returns {number}
 */
export function computeStockValue(positions) {
  return (positions || []).reduce((s, p) => s + (p.shares * p.avg_price), 0);
}

/**
 * Compute total wine cellar value from a user_wines array.
 * Each row has { qty, estimated_value }.
 * Missing qty defaults to 1; missing estimated_value defaults to 0.
 *
 * @param {Array<{qty?: number, estimated_value?: number}>|null} wines
 * @returns {number}
 */
export function computeWineValue(wines) {
  return (wines || []).reduce((s, w) => s + ((w.estimated_value || 0) * (w.qty || 1)), 0);
}

/**
 * Compute total wine purchase cost from a user_wines array.
 * Each row has { qty, purchase_price }.
 * Missing qty defaults to 1; missing purchase_price defaults to 0.
 *
 * @param {Array<{qty?: number, purchase_price?: number}>|null} wines
 * @returns {number}
 */
export function computeWineCost(wines) {
  return (wines || []).reduce((s, w) => s + ((w.purchase_price || 0) * (w.qty || 1)), 0);
}

/**
 * Compute the wine delta label and CSS class for the hub card.
 *
 * Rules (mirroring loadHubValues in index.html):
 *  - No wine value → empty text, empty class
 *  - Wine value + cost → percentage gain/loss (e.g. "+12.3%" or "-5.0%")
 *  - Wine value but no cost → staleness label ("valued Xd ago") if last_valued_at
 *    is available on any row, or empty text
 *
 * @param {number} wineValue - total estimated cellar value
 * @param {number} wineCost  - total purchase cost
 * @param {Array<{last_valued_at?: string|null}>} wineRows - raw wine rows
 * @param {number} [now]     - epoch ms, injectable for deterministic testing
 * @returns {{ text: string, className: string }}
 */
export function computeWineDelta(wineValue, wineCost, wineRows, now = Date.now()) {
  if (wineValue > 0 && wineCost > 0) {
    const pct = (wineValue - wineCost) / wineCost * 100;
    const sign = pct >= 0 ? '+' : '';
    return {
      text: `${sign}${pct.toFixed(1)}%`,
      className: 'hub-card-delta ' + (pct >= 0 ? 'up' : 'down'),
    };
  }

  if (wineValue > 0) {
    const lastValued = wineRows
      .filter(w => w.last_valued_at)
      .map(w => new Date(w.last_valued_at))
      .sort((a, b) => b - a)[0];

    if (lastValued) {
      const daysAgo = Math.round((now - lastValued) / 86400000);
      return { text: `valued ${daysAgo}d ago`, className: 'hub-card-delta neutral' };
    }
    return { text: '', className: '' };
  }

  return { text: '', className: '' };
}

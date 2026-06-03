/**
 * Pure functions for the hub dashboard (index.html).
 * Extracted here so they can be unit-tested without a DOM.
 * Keep in sync with the inline helpers in index.html.
 */

/**
 * Format a numeric value as "€ 1,234" or the placeholder "— —" when the
 * value is falsy or below €0.01 (so we never show "€ 0" for an empty cellar).
 *
 * @param {number|null|undefined} val
 * @returns {string}
 */
export function hubFmt(val) {
  if (!val || val < 0.01) return '— —';
  return '€ ' + Math.round(val).toLocaleString('en-US');
}

/**
 * Compute total stock portfolio cost basis from a positions array.
 *
 * @param {Array<{shares: number, avg_price: number}>|null|undefined} positions
 * @returns {number}
 */
export function computeStockValue(positions) {
  return (positions || []).reduce((s, p) => s + (p.shares * p.avg_price), 0);
}

/**
 * Compute total wine cellar estimated value.
 * Missing estimated_value defaults to 0; missing qty defaults to 1.
 *
 * @param {Array<{qty?: number, estimated_value?: number}>|null|undefined} wineRows
 * @returns {number}
 */
export function computeWineValue(wineRows) {
  return (wineRows || []).reduce((s, w) => s + ((w.estimated_value || 0) * (w.qty || 1)), 0);
}

/**
 * Compute total wine cellar purchase cost.
 * Missing purchase_price defaults to 0; missing qty defaults to 1.
 *
 * @param {Array<{qty?: number, purchase_price?: number}>|null|undefined} wineRows
 * @returns {number}
 */
export function computeWineCost(wineRows) {
  return (wineRows || []).reduce((s, w) => s + ((w.purchase_price || 0) * (w.qty || 1)), 0);
}

/**
 * Compute the wine-delta display: percent gain/loss versus cost, or a
 * staleness label when purchase prices are missing, or empty when no wines.
 *
 * Returns a plain-data object so it can be tested without a DOM.
 *
 * @param {number} wineValue   - total estimated value
 * @param {number} wineCost    - total purchase cost
 * @param {Array<{last_valued_at?: string}>} wineRows
 * @param {number} [now]       - current timestamp in ms (injectable for testing)
 * @returns {{text: string, cssClass: string}}
 */
export function computeWineDelta(wineValue, wineCost, wineRows, now = Date.now()) {
  if (wineValue > 0 && wineCost > 0) {
    const pct = (wineValue - wineCost) / wineCost * 100;
    const sign = pct >= 0 ? '+' : '';
    return {
      text: `${sign}${pct.toFixed(1)}%`,
      cssClass: 'hub-card-delta ' + (pct >= 0 ? 'up' : 'down'),
    };
  }

  if (wineValue > 0) {
    const lastValued = (wineRows || [])
      .filter(w => w.last_valued_at)
      .map(w => new Date(w.last_valued_at))
      .sort((a, b) => b - a)[0];
    if (lastValued) {
      const daysAgo = Math.round((now - lastValued) / 86400000);
      return { text: `valued ${daysAgo}d ago`, cssClass: 'hub-card-delta neutral' };
    }
    return { text: '', cssClass: '' };
  }

  return { text: '', cssClass: '' };
}

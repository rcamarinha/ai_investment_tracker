/**
 * Pure hub dashboard computation helpers.
 *
 * Mirrors the inline logic in index.html (hubFmt, loadHubValues). Extracted here
 * so the business logic can be tested without a browser DOM or live Supabase
 * connection. Keep this file in sync with the corresponding block in index.html.
 */

/**
 * Format a hub card value as a rounded Euro amount.
 *
 * Returns '— —' for falsy, negative, or sub-cent values so the UI always
 * shows a clean placeholder instead of "€ 0" or a tiny rounding artefact.
 *
 * @param {number|null|undefined} val
 * @returns {string}
 */
export function hubFmt(val) {
  if (!val || val < 0.01) return '— —';
  return '€ ' + Math.round(val).toLocaleString('en-US');
}

/**
 * Sum total stock cost basis from a positions array.
 *
 * Each row: { shares: number, avg_price: number }
 * Null/undefined rows are skipped.
 *
 * @param {Array<{shares: number, avg_price: number}>} positions
 * @returns {number}
 */
export function computeStockValue(positions) {
  return (positions || []).reduce((s, p) => s + (p.shares * p.avg_price), 0);
}

/**
 * Sum total estimated wine cellar value.
 *
 * Each row: { estimated_value: number|null, qty: number|null }
 * When qty is missing/null it defaults to 1 (single bottle).
 *
 * @param {Array<{estimated_value?: number|null, qty?: number|null}>} wineRows
 * @returns {number}
 */
export function computeWineValue(wineRows) {
  return (wineRows || []).reduce((s, w) => s + ((w.estimated_value || 0) * (w.qty || 1)), 0);
}

/**
 * Sum total original purchase cost for the wine cellar.
 *
 * Each row: { purchase_price: number|null, qty: number|null }
 * When qty is missing/null it defaults to 1 (single bottle).
 *
 * @param {Array<{purchase_price?: number|null, qty?: number|null}>} wineRows
 * @returns {number}
 */
export function computeWineCost(wineRows) {
  return (wineRows || []).reduce((s, w) => s + ((w.purchase_price || 0) * (w.qty || 1)), 0);
}

/**
 * Derive the wine delta label and CSS modifier class for the hub card.
 *
 * Three cases:
 *  1. Both wineValue and wineCost are positive → show % gain/loss (e.g. "+12.3%" or "-5.0%")
 *  2. wineValue > 0 but wineCost is zero → show staleness label ("valued Xd ago")
 *     using the most-recent last_valued_at date found in wineRows
 *  3. wineValue is zero → empty text (no wines valued)
 *
 * @param {number} wineValue
 * @param {number} wineCost
 * @param {Array<{last_valued_at?: string|null}>} wineRows
 * @param {number} [nowMs] - Current time in ms (injectable for deterministic tests)
 * @returns {{ text: string, cssClass: string }}
 */
export function computeWineDelta(wineValue, wineCost, wineRows, nowMs = Date.now()) {
  if (wineValue > 0 && wineCost > 0) {
    const pct  = (wineValue - wineCost) / wineCost * 100;
    const sign = pct >= 0 ? '+' : '';
    return {
      text:     `${sign}${pct.toFixed(1)}%`,
      cssClass: 'hub-card-delta ' + (pct >= 0 ? 'up' : 'down'),
    };
  }

  if (wineValue > 0) {
    const lastValued = (wineRows || [])
      .filter(w => w.last_valued_at)
      .map(w => new Date(w.last_valued_at))
      .sort((a, b) => b - a)[0];

    if (lastValued) {
      const daysAgo = Math.round((nowMs - lastValued) / 86400000);
      return {
        text:     `valued ${daysAgo}d ago`,
        cssClass: 'hub-card-delta neutral',
      };
    }
    return { text: '', cssClass: '' };
  }

  return { text: '', cssClass: '' };
}

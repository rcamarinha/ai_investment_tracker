/**
 * Utility / helper functions used across the application.
 */

import state from './state.js';
import { getSector } from '../data/sectors.js';

// ── HTML / Formatting ───────────────────────────────────────────────────────

export function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export function formatCurrency(num) {
    return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPercent(num) {
    const sign = num >= 0 ? '+' : '';
    return sign + num.toFixed(2) + '%';
}

// ── Exchange & Currency Detection ───────────────────────────────────────────

export function detectStockExchange(ticker) {
    if (!ticker) return 'Unknown';
    if (ticker.includes('.PA')) return 'Euronext Paris';
    if (ticker.includes('.L'))  return 'London (LSE)';
    if (ticker.includes('.DE')) return 'Frankfurt (XETRA)';
    if (ticker.includes('.AS')) return 'Euronext Amsterdam';
    if (ticker.includes('.MI')) return 'Milan (Borsa)';
    if (ticker.includes('.SW')) return 'Swiss (SIX)';
    if (ticker.includes('.MC')) return 'Madrid';
    if (ticker.includes('.BR')) return 'Brussels';
    if (ticker.includes('.HE')) return 'Helsinki';
    if (ticker.includes('.ST')) return 'Stockholm';
    if (ticker.includes('.OL')) return 'Oslo';
    if (ticker.includes('.CO')) return 'Copenhagen';
    if (ticker.includes('.TO')) return 'Toronto (TSX)';
    if (ticker.includes('.HK')) return 'Hong Kong';
    if (ticker.includes('.T'))  return 'Tokyo';
    return 'US';
}

export function detectCurrency(stockExchange) {
    const currencyMap = {
        'US': 'USD',
        'Euronext Paris': 'EUR',
        'Frankfurt (XETRA)': 'EUR',
        'Euronext Amsterdam': 'EUR',
        'Milan (Borsa)': 'EUR',
        'Madrid': 'EUR',
        'Brussels': 'EUR',
        'Helsinki': 'EUR',
        'London (LSE)': 'GBP',
        'Swiss (SIX)': 'CHF',
        'Stockholm': 'SEK',
        'Oslo': 'NOK',
        'Copenhagen': 'DKK',
        'Toronto (TSX)': 'CAD',
        'Hong Kong': 'HKD',
        'Tokyo': 'JPY'
    };
    return currencyMap[stockExchange] || 'USD';
}

// ── Asset Record Builder ────────────────────────────────────────────────────

export function buildAssetRecord(position) {
    const ticker = position.symbol.toUpperCase();
    const stockExchange = detectStockExchange(ticker);
    const currency = detectCurrency(stockExchange);
    const sector = getSector(ticker);
    return {
        ticker,
        name: position.name || ticker,
        stock_exchange: stockExchange,
        sector,
        currency,
        asset_type: position.type || 'Stock'
    };
}

// ── Environment Detection ───────────────────────────────────────────────────

export const isArtifact = typeof window !== 'undefined' &&
    window.location.hostname.includes('claude.ai') &&
    window.location.pathname.includes('artifacts');

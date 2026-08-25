/**
 * Utility / helper functions used across the application.
 */

import state from './state.js';
import { getSector } from '../data/sectors.js';
import { normalizeCurrencyCode } from './money-core.js';

// ── HTML / Formatting ───────────────────────────────────────────────────────

export function escapeHTML(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

const CURRENCY_SYMBOLS = {
    USD: '$', EUR: '\u20ac', GBP: '\u00a3', CHF: 'CHF ', SEK: 'kr ',
    NOK: 'kr ', DKK: 'kr ', CAD: 'C$', HKD: 'HK$', JPY: '\u00a5'
};

export function formatCurrency(num, currency) {
    const symbol = currency ? (CURRENCY_SYMBOLS[currency] || currency + ' ') : '\u20ac';
    if (num == null || isNaN(num)) return symbol + '—';
    return symbol + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    if (!position || !position.symbol) {
        console.warn('buildAssetRecord: invalid position', position);
        return null;
    }
    const ticker = position.symbol.toUpperCase();
    const stockExchange = detectStockExchange(ticker);
    const sector = getSector(ticker);
    // `currency` is a SUFFIX GUESS and is tagged as such. fetchMarketPrices()
    // rebuilds this record for every position on every refresh, so emitting an
    // untagged currency here silently overwrote the provider-reported one that
    // enrichment had just stored — assets.currency oscillated between the real
    // value and the guess depending on which write ran last.
    // saveAssetsToDB() honours currency_source and will not downgrade.
    return {
        ticker,
        name: position.name || ticker,
        stock_exchange: stockExchange,
        sector,
        currency: looksLikeISIN(ticker) ? null : detectCurrency(stockExchange),
        currency_source: looksLikeISIN(ticker) ? null : 'suffix',
        asset_type: normalizeAssetType(position.type),
        untracked: !!position.untracked
    };
}

// ── Currency Helpers ────────────────────────────────────────────────────────

/** ISIN pattern: 2 uppercase letters + 10 alphanumeric characters. */
function looksLikeISIN(value) {
    return /^[A-Z]{2}[A-Z0-9]{10}$/.test(String(value || '').toUpperCase());
}

/**
 * Resolve an asset's native currency AND where that answer came from.
 *
 * Precedence (highest first): user override > quote > provider profile >
 * ticker suffix. A bare ISIN carries no venue information, so it resolves to
 * `null` — NOT 'USD'. The old code fell through detectStockExchange('') to
 * 'US' → 'USD', which meant every unmapped-ISIN holding (typically bought in
 * EUR) had its cost basis converted USD→EUR at ~0.92.
 *
 * @returns {{code: string|null, source: string|null}}
 */
export function resolveAssetCurrency(symbol) {
    if (!symbol) return { code: null, source: null };
    const dbAsset = state.assetDatabase[String(symbol).toUpperCase()];
    if (dbAsset && dbAsset.currency) {
        const norm = normalizeCurrencyCode(dbAsset.currency);
        if (norm) return { code: norm.iso, source: dbAsset.currency_source || 'profile' };
    }
    // No stored currency. A bare ISIN carries no venue information of its own,
    // but the ticker we learned to PRICE it with does: an ISIN quoted as AIR.PA
    // is a euro instrument. Without this, an ISIN-keyed broker import (DeGiro)
    // has no cost-basis currency, every holding is excluded, and the portfolio
    // total reads zero — the resolver is the only thing that knows the venue.
    if (looksLikeISIN(symbol)) {
        const pricingTicker = dbAsset && dbAsset.pricingTicker;
        if (pricingTicker && !looksLikeISIN(pricingTicker)) {
            return { code: detectCurrency(detectStockExchange(pricingTicker)), source: 'suffix' };
        }
        return { code: null, source: null };
    }
    const exchange = detectStockExchange(symbol);
    return { code: detectCurrency(exchange), source: 'suffix' };
}

/**
 * Get native currency for a ticker. Returns null when genuinely unknown —
 * callers must treat null as "cannot value this", not as a reason to guess.
 */
export function getAssetCurrency(symbol) {
    return resolveAssetCurrency(symbol).code;
}

/**
 * Convert an amount into the active base currency using live stored rates.
 *
 * Returns null when the amount cannot be converted (unknown currency code, or
 * no rate available). It deliberately does NOT fall back to returning the
 * unconverted amount: that fallback is what turned "we don't know" into a
 * confident wrong number that flowed into totals, snapshots and the database.
 *
 * Minor-unit codes (GBp/GBX pence, ZAc, ILA) are folded to major units here,
 * so a London pence quote converts correctly instead of 100x high.
 */
export function toBaseCurrency(amount, fromCurrency, targetBase) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return null;
    const src = normalizeCurrencyCode(fromCurrency);
    if (!src) return null;
    const base = normalizeCurrencyCode(targetBase || state.baseCurrency || 'EUR');
    if (!base) return null;
    const major = value * src.factor;
    if (src.iso === base.iso) return major;

    // state.exchangeRates holds "1 CUR = X ACTIVE_BASE". Converting to a base
    // other than the active one (used to store a canonical EUR total whatever
    // the toggle says) is the ratio of the two: C→T = (C→active) / (T→active).
    // T === active gives rate 1, so this reduces to the simple case.
    const rateSrc = Number(state.exchangeRates[src.iso]);
    const rateTarget = base.iso === (state.baseCurrency || 'EUR')
        ? 1 : Number(state.exchangeRates[base.iso]);
    if (!Number.isFinite(rateSrc) || rateSrc <= 0) return null;
    if (!Number.isFinite(rateTarget) || rateTarget <= 0) return null;
    return major * (rateSrc / rateTarget);
}

// ── Environment Detection ───────────────────────────────────────────────────

export const isArtifact = typeof window !== 'undefined' &&
    window.location.hostname.includes('claude.ai') &&
    window.location.pathname.includes('artifacts');

// ── Canonical Asset Types ───────────────────────────────────────────────────

/** The canonical set of asset types used throughout the application. */
export const CANONICAL_ASSET_TYPES = ['Stock', 'ETF', 'Crypto', 'REIT', 'Bond', 'Commodity', 'Cash', 'Other'];

/** Map of known aliases (lowercase) → canonical type. */
const ASSET_TYPE_ALIASES = {
    // Stock variants
    'stock': 'Stock', 'stocks': 'Stock', 'equity': 'Stock', 'equities': 'Stock',
    'common stock': 'Stock', 'ordinary share': 'Stock', 'ordinary shares': 'Stock',
    'share': 'Stock', 'shares': 'Stock', 'adr': 'Stock', 'gdr': 'Stock',
    'preferred stock': 'Stock', 'preference share': 'Stock',
    // ETF variants
    'etf': 'ETF', 'etp': 'ETF', 'fund': 'ETF', 'index fund': 'ETF',
    'exchange traded fund': 'ETF', 'mutual fund': 'ETF', 'tracker': 'ETF',
    'ucits': 'ETF', 'sicav': 'ETF', 'oeic': 'ETF', 'unit trust': 'ETF',
    // Crypto variants
    'crypto': 'Crypto', 'cryptocurrency': 'Crypto', 'digital asset': 'Crypto',
    'token': 'Crypto', 'coin': 'Crypto',
    // REIT variants
    'reit': 'REIT', 'real estate': 'REIT', 'real estate investment trust': 'REIT',
    'shares (reit)': 'REIT', 'stock (reit)': 'REIT', 'reit shares': 'REIT',
    // Bond variants
    'bond': 'Bond', 'bonds': 'Bond', 'fixed income': 'Bond', 'debt': 'Bond',
    'note': 'Bond', 'treasury': 'Bond', 'government bond': 'Bond',
    'corporate bond': 'Bond', 'bond etf': 'Bond',
    // Commodity variants
    'commodity': 'Commodity', 'commodities': 'Commodity',
    // Cash variants
    'cash': 'Cash', 'money market': 'Cash',
    // Other
    'other': 'Other',
};

/**
 * Normalize an asset type string to one of the canonical types.
 * Returns the canonical type, or 'Other' if unrecognized.
 */
export function normalizeAssetType(rawType) {
    if (!rawType) return 'Stock';
    const lower = rawType.trim().toLowerCase();
    return ASSET_TYPE_ALIASES[lower] || (CANONICAL_ASSET_TYPES.includes(rawType.trim()) ? rawType.trim() : 'Other');
}

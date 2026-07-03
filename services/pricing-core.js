/**
 * Pure pricing helpers — no state, no DOM, no network. Shared between the
 * runtime service (services/pricing.js) and the test mirror (src/portfolio.js)
 * so the SHIPPED code is the code under test (previously each had its own copy
 * that could silently drift).
 */

// Exchange-suffix normalization. Many stored tickers use Finnhub's `search`
// suffix format (.FRK/.AMS) which the price endpoints don't recognize; map them
// to the FMP/Yahoo format (.DE/.AS). Already-valid suffixes pass through.
export const PRICING_SUFFIX_MAP = {
    FRK: 'DE', FRA: 'DE', ETR: 'DE', GER: 'DE', GF: 'DE', GY: 'DE',
    AMS: 'AS', AEX: 'AS',
    PAR: 'PA', EPA: 'PA', FP: 'PA',
    MCE: 'MC', MAD: 'MC', BME: 'MC',
    MIL: 'MI', BIT: 'MI', MTA: 'MI',
    LIS: 'LS', ELI: 'LS', EL: 'LS',
    BRU: 'BR', EBR: 'BR',
    SWX: 'SW', EBS: 'SW', VTX: 'SW', SIX: 'SW',
    LON: 'L', LSE: 'L',
    CPH: 'CO', STO: 'ST', HEL: 'HE', OSL: 'OL', VIE: 'VI', ICE: 'IC',
};

/** Common European FMP/Yahoo exchange suffixes, for fanning out base tickers. */
export const EU_SUFFIXES = ['DE', 'PA', 'AS', 'MI', 'MC', 'SW', 'L', 'BR', 'LS', 'CO', 'ST', 'HE', 'OL'];

/** Normalize a ticker's exchange suffix to the price-API format. */
export function normalizeForPricing(symbol) {
    const s = String(symbol || '').toUpperCase();
    const dot = s.lastIndexOf('.');
    if (dot < 0) return s;
    const base = s.slice(0, dot);
    const mapped = PRICING_SUFFIX_MAP[s.slice(dot + 1)];
    return mapped ? `${base}.${mapped}` : s;
}

/** Parse an FMP quote-short batch array → { UPPER(symbol): price>0 }. Tolerant
 *  of FMP error shapes / non-arrays (returns {}). */
export function parseFmpBatchResponse(data) {
    const out = {};
    if (!Array.isArray(data)) return out;
    for (const row of data) {
        if (!row || !row.symbol) continue;
        const price = Number(row.price);
        if (Number.isFinite(price) && price > 0) out[String(row.symbol).toUpperCase()] = price;
    }
    return out;
}

/** True if we already hold a live (non-DB-cached) success newer than windowMs. */
export function isPriceFresh(meta, windowMs, now = Date.now()) {
    if (!meta || !meta.success || !meta.timestamp) return false;
    if (typeof meta.source === 'string' && meta.source.includes('(cached)')) return false;
    const t = new Date(meta.timestamp).getTime();
    return Number.isFinite(t) && (now - t) <= windowMs;
}

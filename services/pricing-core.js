/**
 * Pure pricing helpers — no state, no DOM, no network. Shared between the
 * runtime service (services/pricing.js) and the test mirror (src/portfolio.js)
 * so the SHIPPED code is the code under test (previously each had its own copy
 * that could silently drift).
 */

import { normalizeCurrencyCode } from './money-core.js';

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

/**
 * For an FMP comma-batch: map raw input symbols to the normalized query form and
 * keep reverse indexes so a price echoed by FMP (which may come back under the
 * normalized OR the bare-base form) can be matched to every raw symbol that asked
 * for it. Returns { normToRaw, baseToRaw, normSyms } (normSyms = unique query list).
 */
export function buildRawMaps(symbols) {
    const normToRaw = {};   // normalized query form → [raw...]
    const baseToRaw = {};   // base (no suffix)     → [raw...]
    for (const raw of new Set((symbols || []).map(s => String(s).toUpperCase()))) {
        const norm = normalizeForPricing(raw);
        (normToRaw[norm] ||= []).push(raw);
        (baseToRaw[norm.split('.')[0]] ||= []).push(raw);
    }
    return { normToRaw, baseToRaw, normSyms: Object.keys(normToRaw) };
}

/**
 * Fan a { echoedSymbol: price } map back onto raw input symbols using the reverse
 * indexes from buildRawMaps. Matches on the normalized form first, then the bare
 * base (resilient to FMP returning a slightly different suffix), else the symbol
 * itself. Returns { RAW_UPPER: price }.
 */
export function mapPricedToRaw(priced, normToRaw, baseToRaw) {
    const out = {};
    for (const [sym, price] of Object.entries(priced || {})) {
        const targets = normToRaw[sym] || baseToRaw[sym.split('.')[0]] || [sym];
        targets.forEach(raw => { out[raw] = price; });
    }
    return out;
}

/** Run at most `concurrency` promises at a time, with `delay` ms between waves.
 *  Never rejects — returns the Promise.allSettled results in input order. */
export async function pooled(items, factory, concurrency, delay = 0) {
    const results = [];
    const n = Math.max(1, concurrency | 0);
    for (let i = 0; i < items.length; i += n) {
        const settled = await Promise.allSettled(items.slice(i, i + n).map(factory));
        results.push(...settled);
        if (delay && i + n < items.length) await new Promise(r => setTimeout(r, delay));
    }
    return results;
}

/**
 * Extract and parse a JSON array from LLM output that may be wrapped in prose
 * or Markdown code fences (```json or ```).
 *
 * Mirrors the inline parsing in resolveTickersViaAI() (services/pricing.js).
 * A misparse silently drops all AI ticker suggestions, so this pure helper
 * exists to make the extraction behaviour testable.
 *
 * @param {string} text - Raw LLM response text
 * @returns {Array} Parsed array, or [] on any failure
 */
export function extractLlmJsonArray(text) {
    if (!text) return [];
    const cleaned = text.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    const jsonText = (start >= 0 && end > start) ? cleaned.slice(start, end + 1) : cleaned;
    try {
        const parsed = JSON.parse(jsonText);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Derive "1 unit of `currency` = X units of base" rates from a single
 * EUR-based rate table (ECB/Frankfurter shape: { USD: 1.09, GBP: 0.85, ... }
 * meaning 1 EUR = 1.09 USD). Pure & testable.
 *
 * Math: C→EUR = 1 / (EUR→C); C→B = (EUR→B) / (EUR→C); identity for C === B.
 * Returns { EUR: r, USD: r, ... } for the requested bases, or null for a base
 * whose rate can't be derived (missing/zero table entry) — callers must treat
 * null as "no historical rate, fall back to live".
 *
 * @param {Object} eurTable - { CUR: rate } where rate = 1 EUR in CUR
 * @param {string} currency - the transaction's native currency
 * @param {string[]} bases  - target base currencies (default EUR + USD)
 * @returns {Object|null} { BASE: rate|null } or null if currency is unusable
 */
export function deriveFxToBases(eurTable, currency, bases = ['EUR', 'USD']) {
    // Normalize BEFORE any case folding: providers send the literal "GBp",
    // and uppercasing it first turns pence into pounds at subunit 1 (a silent
    // 100x). normalizeCurrencyCode owns the minor-unit table.
    const norm = normalizeCurrencyCode(currency);
    if (!norm) return null;
    const cur = norm.iso;
    const subunit = norm.factor;
    const table = eurTable || {};
    // 1 EUR = eurToCur units of the tx currency (identity for EUR itself)
    const eurToCur = cur === 'EUR' ? 1 : Number(table[cur]);
    const out = {};
    for (const b of bases) {
        const base = String(b).toUpperCase();
        if (base === cur) { out[base] = 1 * subunit; continue; }
        const eurToBase = base === 'EUR' ? 1 : Number(table[base]);
        out[base] = (Number.isFinite(eurToCur) && eurToCur > 0 && Number.isFinite(eurToBase) && eurToBase > 0)
            ? (eurToBase / eurToCur) * subunit
            : null;
    }
    return out;
}

/**
 * Look up the EUR-based rate table for `date` in a { 'YYYY-MM-DD': table } map,
 * walking back up to `maxBack` days to the previous business day (the ECB
 * publishes no rates on weekends/holidays; Frankfurter range responses simply
 * omit those dates). Returns the table or null. Pure & testable.
 */
export function lookupFxTableForDate(history, date, maxBack = 7) {
    if (!history || !date) return null;
    let d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
    if (isNaN(d.getTime())) return null;
    for (let i = 0; i <= maxBack; i++) {
        const key = d.toISOString().slice(0, 10);
        if (history[key]) return history[key];
        d = new Date(d.getTime() - 86400000);
    }
    return null;
}

/**
 * Classify an FMP batch endpoint HTTP response body.
 *
 * Mirrors the text-first / non-JSON detection logic in batchFetchFMP()
 * (services/pricing.js). On free plans the comma-list endpoint returns a
 * plain-text "Premium Query Parameter…" notice with HTTP 200, which is NOT
 * JSON — parsing it directly throws, so the caller must classify the raw text
 * before trusting it as a price array.
 *
 * @param {string} text - Raw HTTP response body text
 * @returns {{ unsupported: boolean, json?: any }}
 */
export function classifyFmpBatchText(text) {
    let json;
    try { json = JSON.parse(text); }
    catch { return { unsupported: true }; }
    if (!Array.isArray(json)) return { unsupported: true, json };
    return { unsupported: false, json };
}

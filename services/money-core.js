/**
 * money-core.js — the single source of truth for currency codes and conversion.
 *
 * Pure: no DOM, no state, no network, no service imports. Tests import this
 * file directly (same contract as pricing-core.js / returns-core.js /
 * import-brokers.js — there is deliberately no `src/` mirror).
 *
 * ── The invariant this module exists to enforce ──────────────────────────────
 *
 *   Every monetary value that crosses into application state or the database
 *   is in MAJOR UNITS, and every `currency` field is a case-normalized
 *   ISO-4217 alphabetic code. Sub-unit codes (GBp, GBX, ZAc, ILA) exist only
 *   inside normalizeQuote(), never above it. No FX lookup anywhere may take a
 *   raw provider or broker string.
 *
 * Why: London quotes in pence. Yahoo returns the literal string "GBp", FMP
 * returns "GBp", Alpha Vantage returns "GBX". Uppercasing "GBp" yields "GBP",
 * which silently mislabels a pence price as pounds — a 100x overstatement that
 * flows into totals, snapshots and the DB with no warning. Normalizing at
 * ingest is the only place that fix is cheap.
 */

/**
 * Currencies quoted in minor units by some venues/providers, mapped to their
 * ISO major-unit code and the factor that converts minor → major.
 * Keys are compared case-insensitively.
 */
export const MINOR_UNIT_CODES = {
    GBX:   { iso: 'GBP', factor: 0.01 },   // London pence (Alpha Vantage)
    'GBP.': { iso: 'GBP', factor: 0.01 },  // seen from at least one provider
    GBPX:  { iso: 'GBP', factor: 0.01 },
    ZAC:   { iso: 'ZAR', factor: 0.01 },   // Johannesburg cents
    ILA:   { iso: 'ILS', factor: 0.01 },   // Tel Aviv agorot
};

/**
 * Minor-unit codes that are distinguished from their major-unit ISO code ONLY
 * by letter case — "GBp" is pence, "GBP" is pounds. These MUST be matched
 * before any case folding; uppercasing "GBp" produces the valid ISO code "GBP"
 * and the pence factor is lost silently. Yahoo returns exactly "GBp" for every
 * London listing, so this is the common path, not an edge case.
 */
const CASE_SENSITIVE_MINOR_UNITS = {
    GBp: { iso: 'GBP', factor: 0.01 },
    ZAc: { iso: 'ZAR', factor: 0.01 },
    ILa: { iso: 'ILS', factor: 0.01 },
};

/**
 * Normalize any provider/broker currency string to an ISO-4217 code plus the
 * factor that converts the quoted amount into major units.
 *
 * Returns null for unknown/absent codes — deliberately NOT a passthrough.
 * "We don't know" must stay distinguishable from "we know it's fine", because
 * a passthrough here is what turns an unknown currency into a confident wrong
 * number downstream.
 *
 * @param {string} code
 * @returns {{iso: string, factor: number}|null}
 */
export function normalizeCurrencyCode(code) {
    if (code == null) return null;
    const raw = String(code).trim();
    if (!raw) return null;

    // Case-SENSITIVE first: "GBp" (pence) vs "GBP" (pounds) differ only in case.
    if (Object.prototype.hasOwnProperty.call(CASE_SENSITIVE_MINOR_UNITS, raw)) {
        return { ...CASE_SENSITIVE_MINOR_UNITS[raw] };
    }

    const upper = raw.toUpperCase();
    // Codes that are unambiguous once folded ("GBX", "gbx", "GBP.", "ZAC"…).
    if (Object.prototype.hasOwnProperty.call(MINOR_UNIT_CODES, upper)) {
        return { ...MINOR_UNIT_CODES[upper] };
    }
    // Plain ISO-4217 alphabetic codes only.
    if (/^[A-Z]{3}$/.test(upper)) return { iso: upper, factor: 1 };
    return null;
}

/**
 * Convert a raw provider quote into major units with an ISO code.
 * Returns null when the currency can't be understood — the caller must then
 * treat the quote as having no usable currency rather than guessing.
 *
 * @param {{price: number, currency: string}} quote
 * @returns {{price: number, currency: string}|null}
 */
export function normalizeQuote(quote) {
    if (!quote) return null;
    const price = Number(quote.price);
    if (!Number.isFinite(price)) return null;
    const norm = normalizeCurrencyCode(quote.currency);
    if (!norm) return null;
    return { price: price * norm.factor, currency: norm.iso };
}

/**
 * Convert an amount between currencies using an EUR-based rate table
 * (Frankfurter/ECB shape: { USD: 1.09, GBP: 0.85 } meaning 1 EUR = 1.09 USD).
 *
 * Returns null when the conversion cannot be performed — an unknown code, or a
 * currency absent from the table. Callers MUST handle null by excluding the
 * amount from totals, never by substituting the unconverted figure.
 *
 * @param {number} amount
 * @param {string} from     - native currency (may be a minor-unit code)
 * @param {string} to       - target/base currency
 * @param {Object} eurTable - { CUR: rate } where rate = 1 EUR in CUR
 * @returns {number|null}
 */
export function convert(amount, from, to, eurTable) {
    const value = Number(amount);
    if (!Number.isFinite(value)) return null;

    const src = normalizeCurrencyCode(from);
    const dst = normalizeCurrencyCode(to);
    if (!src || !dst) return null;

    // Amount is expressed in `from`, which may be a minor unit — fold that in.
    const major = value * src.factor;
    if (src.iso === dst.iso) return major;

    const table = eurTable || {};
    const eurToSrc = src.iso === 'EUR' ? 1 : Number(table[src.iso]);
    const eurToDst = dst.iso === 'EUR' ? 1 : Number(table[dst.iso]);
    if (!Number.isFinite(eurToSrc) || eurToSrc <= 0) return null;
    if (!Number.isFinite(eurToDst) || eurToDst <= 0) return null;

    return major * (eurToDst / eurToSrc);
}

/**
 * Precedence for where an asset's currency came from. Higher rank wins; a
 * lower-ranked source must never overwrite a higher-ranked one.
 *
 * This exists because buildAssetRecord() infers a currency from the ticker
 * suffix on EVERY price refresh and upserts it, clobbering the provider-
 * reported currency that enrichment had just written. Without a precedence
 * rule, assets.currency oscillates between correct and guessed.
 */
export const CURRENCY_SOURCE_RANK = { user: 4, quote: 3, profile: 2, suffix: 1 };

/**
 * Should a newly-observed currency overwrite the stored one?
 * Equal rank overwrites (a fresher observation from the same class of source
 * is fine); lower rank never does.
 *
 * @param {string} incomingSource
 * @param {string} storedSource
 * @returns {boolean}
 */
export function shouldOverwriteCurrency(incomingSource, storedSource) {
    const inc = CURRENCY_SOURCE_RANK[incomingSource] || 0;
    const cur = CURRENCY_SOURCE_RANK[storedSource] || 0;
    if (!inc) return false;
    return inc >= cur;
}

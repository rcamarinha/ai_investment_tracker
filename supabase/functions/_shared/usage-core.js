/**
 * Pure rules for recording what a server function spent: which row to write,
 * and how many tokens a provider's response says it used.
 *
 * Shared by supabase/functions/_shared/usage.ts (Deno, which does the write)
 * and tests/usage-core.test.js (Node). No imports, no I/O — the same split as
 * invite-core.js, and for the same reason: the edge runtime cannot be reached
 * from the test suite, so every judgement worth testing lives here.
 */

/** Functions allowed to record usage. A typo in a function name is dropped, not stored. */
export const USAGE_FUNCTIONS = [
    'analyze-portfolio',
    'categorize-transactions',
    'extract-statement',
    'extract-trades',
    'quote-proxy',
    'resolve-tickers',
    'wine-ai',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT_MAX = 2_000_000_000;

/** A non-negative whole count; anything else is none. `Number(null)` is 0, which is fine here. */
function count(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), INT_MAX) : 0;
}

/**
 * Tokens used, read from a provider's own response body.
 *
 * Anthropic reports `usage.input_tokens` and `usage.output_tokens`, plus cache
 * writes and reads when prompt caching is on. Cache tokens are folded into
 * input: none of these functions caches today, and if one starts, the estimate
 * errs high rather than hiding tokens.
 *
 * Gemini reports `usageMetadata`. On 2.5 models the "thinking" tokens are
 * counted separately as `thoughtsTokenCount` and BILLED AS OUTPUT, so they are
 * added to output — leaving them out would under-report the most expensive part.
 */
export function tokensFrom(provider, body) {
    if (!body || typeof body !== 'object') return { input: 0, output: 0 };
    if (provider === 'anthropic') {
        const u = body.usage || {};
        return {
            input: count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens),
            output: count(u.output_tokens),
        };
    }
    if (provider === 'gemini') {
        const u = body.usageMetadata || {};
        return {
            input: count(u.promptTokenCount),
            output: count(u.candidatesTokenCount) + count(u.thoughtsTokenCount),
        };
    }
    return { input: 0, output: 0 };
}

/**
 * Web searches a model ran for this call. Providers bill these separately from
 * tokens, so they are recorded as `units` rather than folded into a token count.
 *
 * Anthropic reports them in `usage.server_tool_use.web_search_requests`. Gemini
 * bills grounding per grounded PROMPT, not per query, and marks a grounded
 * answer with `groundingMetadata` carrying the queries it ran — so one grounded
 * response is one unit however many queries it made.
 */
export function searchesFrom(provider, body) {
    if (!body || typeof body !== 'object') return 0;
    if (provider === 'anthropic') return count(body.usage?.server_tool_use?.web_search_requests);
    if (provider === 'gemini') {
        const queries = body.candidates?.[0]?.groundingMetadata?.webSearchQueries;
        return Array.isArray(queries) && queries.length > 0 ? 1 : 0;
    }
    return 0;
}

/**
 * The usage_events row for one upstream call, or null when the event cannot be
 * attributed. Never throws: a malformed event must not break the request it
 * describes.
 *
 * @param {object} e
 * @param {string} e.userId    the signed-in caller, from auth.getUser — never from the request body
 * @param {string} e.fn        one of USAGE_FUNCTIONS
 * @param {string} e.provider  'anthropic' | 'gemini' | 'yahoo' | ...
 * @param {string|null} [e.model]
 * @param {boolean} [e.ok]     false for a call the provider refused or failed
 * @param {unknown} [e.response] the provider's parsed JSON body, for token counts
 * @param {number} [e.units]   non-token work, e.g. how many symbols were quoted.
 *                             Omitted for a model call, it is the web searches
 *                             the response reports.
 */
export function buildUsageRow(e) {
    try {
        if (!e || !UUID.test(String(e.userId ?? ''))) return null;
        if (!USAGE_FUNCTIONS.includes(e.fn)) return null;
        const provider = String(e.provider ?? '').trim().slice(0, 32);
        if (!provider) return null;
        const tokens = tokensFrom(provider, e.response);
        return {
            user_id: String(e.userId).toLowerCase(),
            fn: e.fn,
            provider,
            model: e.model ? String(e.model).slice(0, 100) : null,
            ok: e.ok !== false,
            input_tokens: tokens.input,
            output_tokens: tokens.output,
            units: e.units === undefined ? searchesFrom(provider, e.response) : count(e.units),
        };
    } catch {
        return null;
    }
}

/**
 * Pure rules for the market-data function: which provider endpoints it will
 * call, how a request becomes an upstream URL, how the key is kept out of what
 * comes back, and whether a call counts as having worked.
 *
 * The keys for Finnhub, FMP and Alpha Vantage used to live in a table every
 * signed-in browser could read. They now live only in the function's secrets,
 * and the function calls the provider on the browser's behalf. It is a thin
 * pass-through on purpose: every rule about READING a provider's answer —
 * FMP's premium notice sent with HTTP 200, Alpha Vantage's "Note", Finnhub's
 * `c > 0` — stays in the browser, in services/pricing-core.js, where the tests
 * already pin it. Moving those here would leave them where tests cannot reach.
 *
 * No imports, no I/O — shared by the Deno function and tests/market-data-core.test.js.
 */

export const PROVIDERS = ['finnhub', 'fmp', 'alphavantage'];

const BASE = {
    finnhub: 'https://finnhub.io',
    fmp: 'https://financialmodelingprep.com',
    alphavantage: 'https://www.alphavantage.co',
};

/**
 * Every endpoint the browser used to call directly, and nothing else. A fixed
 * list, with no free-form path, so the key can never be pointed at a premium or
 * unrelated endpoint by whoever holds a session.
 *
 * kind: what the request must carry — one symbol, a list of symbols, an ISIN,
 * or a search query.
 */
export const ENDPOINTS = {
    finnhub: {
        'quote':        { path: '/api/v1/quote',          param: 'symbol', kind: 'symbol' },
        'profile':      { path: '/api/v1/stock/profile2', param: 'symbol', kind: 'symbol' },
        'profile-isin': { path: '/api/v1/stock/profile2', param: 'isin',   kind: 'isin' },
        'search':       { path: '/api/v1/search',         param: 'q',      kind: 'query' },
    },
    fmp: {
        'quote':         { path: '/stable/quote-short',   param: 'symbol', kind: 'symbols', max: 50 },
        'profile':       { path: '/stable/profile',       param: 'symbol', kind: 'symbol' },
        'search-symbol': { path: '/stable/search-symbol', param: 'query',  kind: 'query' },
        'search-isin':   { path: '/stable/search-isin',   param: 'isin',   kind: 'isin' },
        // The legacy v3 search used by the add-asset dialog. Kept so behaviour is
        // unchanged; FMP has retired it for newer keys, so it may simply fail.
        'search-v3':     { path: '/api/v3/search',        param: 'query',  kind: 'query', extra: { limit: '8' } },
    },
    alphavantage: {
        'quote':    { path: '/query', param: 'symbol', kind: 'symbol', extra: { function: 'GLOBAL_QUOTE' } },
        'overview': { path: '/query', param: 'symbol', kind: 'symbol', extra: { function: 'OVERVIEW' } },
    },
};

const SYMBOL = /^[A-Za-z0-9.\-^=:]{1,20}$/;
const ISIN = /^[A-Za-z]{2}[A-Za-z0-9]{9}[0-9]$/;
const QUERY_MAX = 100;

/**
 * Check a request body. Returns what to call, or why not.
 *
 * @returns {{ ok: true, status: true } |
 *           { ok: true, provider, op, endpoint, value, units } |
 *           { ok: false, error: string }}
 */
export function validateRequest(body) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request.' };
    if (body.op === 'status') return { ok: true, status: true };

    const provider = body.provider;
    if (!PROVIDERS.includes(provider)) return { ok: false, error: 'Unknown provider.' };
    // Own properties only: 'constructor' or '__proto__' must not find a
    // built-in on the prototype chain and pass for an endpoint.
    const op = typeof body.op === 'string' ? body.op : '';
    const endpoint = Object.hasOwn(ENDPOINTS[provider], op) ? ENDPOINTS[provider][op] : null;
    if (!endpoint) return { ok: false, error: 'Unknown operation.' };

    let value;
    let units = 1;
    switch (endpoint.kind) {
        case 'symbol': {
            const s = String(body.symbol ?? '').trim();
            if (!SYMBOL.test(s)) return { ok: false, error: 'Invalid symbol.' };
            value = s;
            break;
        }
        case 'symbols': {
            const list = Array.isArray(body.symbols) ? body.symbols.map(x => String(x ?? '').trim()) : [];
            if (!list.length) return { ok: false, error: 'symbols[] is required.' };
            if (list.length > endpoint.max) return { ok: false, error: `At most ${endpoint.max} symbols per request.` };
            if (!list.every(s => SYMBOL.test(s))) return { ok: false, error: 'Invalid symbol.' };
            value = list.join(',');
            units = list.length;   // FMP bills per symbol
            break;
        }
        case 'isin': {
            const s = String(body.isin ?? '').trim();
            if (!ISIN.test(s)) return { ok: false, error: 'Invalid ISIN.' };
            value = s.toUpperCase();
            break;
        }
        case 'query': {
            const s = String(body.query ?? '').trim();
            if (!s || s.length > QUERY_MAX) return { ok: false, error: 'Invalid query.' };
            value = s;
            break;
        }
        default:
            return { ok: false, error: 'Unknown operation.' };
    }
    return { ok: true, provider, op, endpoint, value, units };
}

/**
 * The upstream request. Finnhub takes its key in a header; FMP and Alpha
 * Vantage only accept it in the query string, which is why nothing that holds
 * the URL — including a network error's message — may ever be logged or
 * returned by the function.
 *
 * @returns {{ url: string, headers: Record<string, string> }}
 */
export function buildUpstream(req, key) {
    const url = new URL(BASE[req.provider] + req.endpoint.path);
    for (const [k, v] of Object.entries(req.endpoint.extra || {})) url.searchParams.set(k, v);
    url.searchParams.set(req.endpoint.param, req.value);
    /** @type {Record<string, string>} */
    const headers = {};
    if (req.provider === 'finnhub') headers['X-Finnhub-Token'] = key;
    else url.searchParams.set('apikey', key);
    return { url: url.toString(), headers };
}

/**
 * Remove the keys from a provider's reply before it leaves the function: every
 * occurrence of a key in any letter case, and any `apikey=` / `token=` value,
 * so an echoed URL gives nothing away even for a key we do not hold.
 */
export function redact(text, keys) {
    let out = String(text ?? '');
    for (const k of keys || []) {
        if (!k || k.length < 6) continue;
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(escaped, 'gi'), '***');
    }
    return out.replace(/((?:apikey|token)=)[^&\s"'<>]+/gi, '$1***');
}

function tryJson(text) {
    try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * Whether the call worked, for the usage record. The browser still makes its
 * own, more detailed judgement from the body; this only decides `ok`.
 *
 * Counts as failed: a non-2xx status; FMP's plain-text premium notice or its
 * {"Error Message"} object, both sent with HTTP 200; Alpha Vantage's "Note" or
 * "Information" (rate limit, sent with HTTP 200); Finnhub's {"error"}.
 */
export function callSucceeded(provider, status, text) {
    if (!(status >= 200 && status < 300)) return false;
    const json = tryJson(text);
    if (provider === 'fmp') {
        if (json === undefined) return false;
        if (json && !Array.isArray(json) && json['Error Message']) return false;
        return true;
    }
    if (provider === 'alphavantage') {
        if (json === undefined) return false;
        return !(json && (json.Note || json.Information));
    }
    if (provider === 'finnhub') {
        if (json === undefined) return false;
        return !(json && !Array.isArray(json) && json.error);
    }
    return false;
}

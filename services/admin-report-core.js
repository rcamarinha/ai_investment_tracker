/**
 * Turns admin_usage_report's output into what the admin page shows: headline
 * counts, adoption per tool, and one line per person.
 *
 * Pure, no imports, so tests/admin-report-core.test.js can pin the definitions
 * — above all what "active" means, since a dashboard number is only as honest
 * as the rule behind it.
 *
 * ACTIVE means the most recent of: signing in, saving something in any tool,
 * a price refresh (which writes a snapshot), or an import or valuation running.
 * Merely opening a page and reading it leaves no trace, so someone who only
 * looks is under-counted. Say so wherever the number is shown.
 *
 * Note that last_sign_in_at alone would be worse than it looks: a session
 * refreshes itself for weeks, so a person who uses the app daily without ever
 * signing in again would read as inactive.
 */

export const TOOLS = [
    { key: 'stocks', label: 'Stocks', unit: 'holdings' },
    { key: 'wine',   label: 'Cellar', unit: 'wines' },
    { key: 'spend',  label: 'Spend',  unit: 'movements' },
    { key: 'bank',   label: 'Bank',   unit: 'holdings' },
];

const DAY = 86_400_000;

/** A timestamp in ms, or null. Absent is not the epoch: `Number(null)` is 0. */
function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/** A row count; anything that is not a finite non-negative number counts as none. */
function toCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function latest(...values) {
    const ms = values.filter(v => v !== null);
    return ms.length ? Math.max(...ms) : null;
}

const within = (ms, days, now) => ms !== null && now - ms <= days * DAY;

/**
 * One person, in the shape the page renders.
 *
 * Timestamps in the future are dropped, not believed. created_at and
 * updated_at are column defaults that a client can override on its own rows,
 * so anyone could date their activity to next year and sit at the top of the
 * list forever. A day of slack allows for clock skew.
 */
export function describePerson(raw, now = Date.now()) {
    const past = value => {
        const ms = toMs(value);
        return ms !== null && ms <= now + DAY ? ms : null;
    };
    const tools = TOOLS.map(t => ({
        ...t,
        items: toCount(raw?.tools?.[t.key]?.items),
        lastMs: past(raw?.tools?.[t.key]?.last),
    }));
    const used = tools.filter(t => t.items > 0);
    return {
        id: raw.id,
        email: raw.email ?? null,
        joinedMs: past(raw.created_at),
        lastSignInMs: past(raw.last_sign_in_at),
        lastActiveMs: latest(
            past(raw.last_sign_in_at),
            past(raw.last_report_at),
            ...tools.map(t => t.lastMs),
        ),
        used,
        problems30: toCount(raw.problems_30d),
        operations30: toCount(raw.operations_30d),
    };
}

/**
 * @param {{people?: object[]}} report  admin_usage_report's result
 * @param {number} now                  ms, injectable for tests
 */
export function summarizeUsage(report, now = Date.now()) {
    const people = (Array.isArray(report?.people) ? report.people : [])
        .filter(p => p && p.id)
        .map(p => describePerson(p, now))
        .sort((a, b) => (b.lastActiveMs ?? -Infinity) - (a.lastActiveMs ?? -Infinity));

    const totals = {
        accounts: people.length,
        active7: people.filter(p => within(p.lastActiveMs, 7, now)).length,
        active30: people.filter(p => within(p.lastActiveMs, 30, now)).length,
        joined30: people.filter(p => within(p.joinedMs, 30, now)).length,
        unused: people.filter(p => p.used.length === 0).length,
    };

    const tools = TOOLS.map(t => {
        const users = people.map(p => p.used.find(u => u.key === t.key)).filter(Boolean);
        return {
            ...t,
            users: users.length,
            active30: users.filter(u => within(u.lastMs, 30, now)).length,
        };
    });

    return { totals, tools, people, byId: new Map(people.map(p => [p.id, p])) };
}

// ── AI and API usage (admin_ai_usage_report) ─────────────────────────────────

/**
 * List prices, US dollars per million tokens. The report returns tokens, never
 * money; this table is the only place a token becomes a cost, so a price change
 * is a one-line edit here.
 *
 * Sources, checked 18 September 2026: Claude — Anthropic's published API rates
 * (claude-api reference, cached June 2026). Gemini 2.5 Flash, and 3.5 Flash
 * (checked 21 September) — ai.google.dev pricing page, paid tier; "thinking"
 * tokens are billed as output and are already counted as output by the recorder.
 *
 * What the estimate leaves out, and the page says so: web searches (billed per
 * search by both providers, recorded separately as units), and Gemini's free
 * tier — on a free key that share really costs nothing.
 */
export const MODEL_PRICES = {
    'claude-opus-4-6':            { input: 5.00, output: 25.00 },
    'claude-sonnet-4-6':          { input: 3.00, output: 15.00 },
    'claude-haiku-4-5':           { input: 1.00, output: 5.00 },
    'claude-haiku-4-5-20251001':  { input: 1.00, output: 5.00 },
    'gemini-2.5-flash':           { input: 0.30, output: 2.50 },
    'gemini-3.5-flash':           { input: 1.50, output: 9.00 },
};

export const FUNCTION_LABELS = {
    'analyze-portfolio':       'Portfolio analysis',
    'extract-trades':          'Broker import',
    'extract-statement':       'Statement import',
    'categorize-transactions': 'Categorisation',
    'resolve-tickers':         'Ticker lookup',
    'wine-ai':                 'Cellar AI',
    'quote-proxy':             'Price quotes',
    'market-data':             'Market data (keyed APIs)',
};

/**
 * Providers whose work is counted in symbols, not tokens, and that cost nothing
 * per call: Yahoo through the keyless proxy, and the free plans of Finnhub, FMP
 * and Alpha Vantage through market-data. Going over a free plan's limit gets a
 * refusal, never a bill. Their units are symbols quoted — never web searches.
 */
export const QUOTE_PROVIDERS = ['yahoo', 'finnhub', 'fmp', 'alphavantage'];

/** Estimated list-price cost in USD for one row, or null when the model has no known price. */
export function estimateCost(row, prices = MODEL_PRICES) {
    if (!row?.model) return QUOTE_PROVIDERS.includes(row?.provider) ? 0 : null;
    const p = prices[row.model];
    if (!p) return null;
    return (toCount(row.input_tokens) * p.input + toCount(row.output_tokens) * p.output) / 1_000_000;
}

/**
 * @param {{rows?: object[]}} report  admin_ai_usage_report's result
 * @returns {{
 *   totals: {calls, failures, inputTokens, outputTokens, cost, searches, quotes},
 *   byFunction: object[], byPerson: Map<string, object>, unpriced: string[]
 * }}
 */
export function summarizeAiUsage(report, prices = MODEL_PRICES) {
    const rows = (Array.isArray(report?.rows) ? report.rows : []).filter(r => r && r.user_id && r.fn);
    const blank = () => ({ calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, cost: 0, searches: 0, quotes: 0, lastMs: null });
    const add = (acc, r) => {
        const cost = estimateCost(r, prices);
        acc.calls += toCount(r.calls);
        acc.failures += toCount(r.failures);
        acc.inputTokens += toCount(r.input_tokens);
        acc.outputTokens += toCount(r.output_tokens);
        acc.cost += cost ?? 0;
        // Units mean different things per provider: symbols quoted for the
        // keyless proxy, web searches for a model. Kept apart so neither
        // number is inflated by the other.
        if (QUOTE_PROVIDERS.includes(r.provider)) acc.quotes += toCount(r.units);
        else acc.searches += toCount(r.units);
        const last = toMs(r.last_at);
        if (last !== null && (acc.lastMs === null || last > acc.lastMs)) acc.lastMs = last;
        return acc;
    };

    const totals = blank();
    const fnMap = new Map();
    const byPerson = new Map();
    const unpriced = new Set();

    for (const r of rows) {
        add(totals, r);
        if (!fnMap.has(r.fn)) fnMap.set(r.fn, { fn: r.fn, label: FUNCTION_LABELS[r.fn] || r.fn, ...blank() });
        add(fnMap.get(r.fn), r);
        if (!byPerson.has(r.user_id)) byPerson.set(r.user_id, blank());
        add(byPerson.get(r.user_id), r);
        if (estimateCost(r, prices) === null) unpriced.add(r.model || r.provider);
    }

    const byFunction = [...fnMap.values()].sort((a, b) => (b.cost - a.cost) || (b.calls - a.calls));
    return { totals, byFunction, byPerson, unpriced: [...unpriced].sort() };
}

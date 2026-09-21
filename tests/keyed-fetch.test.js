/**
 * Tests for keyedFetch() and loadKeyedProviders() from services/pricing.js.
 *
 * keyedFetch is the gateway all keyed API calls (Finnhub, FMP, AlphaVantage)
 * pass through since the shared price keys moved off the browser (commit
 * 03c8c08). It receives a { status, body } envelope from the market-data
 * edge function and re-wraps it into a real Response so every call site still
 * reads the provider's JSON exactly as before.
 *
 * The envelope unwrapping is new code that all keyed price calls flow through.
 * A wrong status-clamping expression or a missed bodiless-status check would
 * silently break every Finnhub/FMP/AlphaVantage tier with no thrown error.
 *
 * loadKeyedProviders uses strict === true to parse the server's status reply
 * into booleans. A truthy non-boolean (1, "yes") must NOT count as a key —
 * the edge function returns genuine booleans, and accepting a looser check
 * could cause the pricing tiers to activate when the server has no key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import state from '../services/state.js';
import { keyedFetch, loadKeyedProviders } from '../services/pricing.js';

// ── module mocks ─────────────────────────────────────────────────────────────

vi.mock('../services/storage.js', () => ({
    saveAssetsToDB: vi.fn(),
    loadAssetsFromDB: vi.fn(),
    savePriceHistoryToDB: vi.fn(),
    enrichUnknownAssets: vi.fn(),
    saveSnapshotToDB: vi.fn(),
    clearHistoryFromDB: vi.fn(),
    savePortfolioDB: vi.fn(),
    saveTransactionsToDB: vi.fn(),
    deleteTransactionsForSymbol: vi.fn(),
    deleteSnapshotFromDB: vi.fn(),
    initSupabase: vi.fn(),
    loadFromDatabase: vi.fn(),
}));

vi.mock('../services/portfolio.js', () => ({
    renderPortfolio: vi.fn(),
    renderMoversSection: vi.fn(),
    savePortfolioSnapshot: vi.fn(),
}));

vi.mock('../services/analysis.js', () => ({
    analyzeMovers: vi.fn(),
}));

// reportHandled accesses navigator.userAgent, which is absent in the node
// test environment. Mock the module so it never touches browser globals.
vi.mock('../services/telemetry.js', () => ({
    reportHandled: vi.fn(),
    reportDiagnostic: vi.fn(),
    installErrorReporting: vi.fn(),
    setTelemetryClient: vi.fn(),
    __testing: { redact: x => x, pickContext: x => x, ALLOWED_CONTEXT_KEYS: [], MAX_REPORTS_PER_LOAD: 10 },
}));

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSession(token = 'test-access-token') {
    return {
        auth: {
            getSession: vi.fn().mockResolvedValue({
                data: { session: { access_token: token } },
            }),
        },
    };
}

/**
 * Stub globalThis.fetch to return a market-data function response.
 * For keyedFetch calls: envelope should be { status: N, body: '...' }.
 * For loadKeyedProviders calls: envelope should be { finnhub, fmp, alphavantage }.
 */
function stubFetch(envelope, ok = true) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok,
        status: ok ? 200 : 503,
        json: vi.fn().mockResolvedValue(envelope),
    }));
}

beforeEach(() => {
    state.supabaseClient = makeSession();
    state.currentUser = { id: 'user-1' };
    state.keyedProviders = { finnhub: false, fmp: false, alphavantage: false };
});

afterEach(() => {
    vi.unstubAllGlobals();
    state.supabaseClient = null;
    state.currentUser = null;
    state.keyedProviders = { finnhub: false, fmp: false, alphavantage: false };
});

// ── keyedFetch ────────────────────────────────────────────────────────────────

describe('keyedFetch — envelope parsing', () => {
    it('unwraps the provider status and body into a real Response', async () => {
        stubFetch({ status: 200, body: '{"c":190.5}' });
        const resp = await keyedFetch('finnhub', 'quote', { symbol: 'AAPL' });
        expect(resp.status).toBe(200);
        expect(await resp.text()).toBe('{"c":190.5}');
    });

    it('passes a provider error status (e.g. 429) through unchanged', async () => {
        stubFetch({ status: 429, body: '' });
        const resp = await keyedFetch('finnhub', 'quote', { symbol: 'AAPL' });
        expect(resp.status).toBe(429);
    });

    it('clamps an out-of-range status (> 599) to 502', async () => {
        stubFetch({ status: 600, body: 'bad' });
        const resp = await keyedFetch('fmp', 'profile', { symbol: 'NOPE' });
        expect(resp.status).toBe(502);
    });

    it('clamps status 0 to 502', async () => {
        stubFetch({ status: 0, body: '' });
        const resp = await keyedFetch('fmp', 'quote', { symbols: ['AAPL'] });
        expect(resp.status).toBe(502);
    });

    it('coerces a missing envelope.body to an empty string', async () => {
        stubFetch({ status: 200 });
        const resp = await keyedFetch('alphavantage', 'quote', { symbol: 'IBM' });
        expect(resp.status).toBe(200);
        expect(await resp.text()).toBe('');
    });

    it('returns a bodiless Response for status 204 No Content', async () => {
        stubFetch({ status: 204 });
        const resp = await keyedFetch('finnhub', 'quote', { symbol: 'AAPL' });
        expect(resp.status).toBe(204);
        expect(await resp.text()).toBe('');
    });

    it('throws when the market-data function itself returns a non-ok HTTP status', async () => {
        stubFetch({}, false);
        await expect(keyedFetch('finnhub', 'quote', { symbol: 'AAPL' }))
            .rejects.toThrow('market-data HTTP');
    });

    it('throws immediately when supabaseClient is absent (not signed in)', async () => {
        state.supabaseClient = null;
        await expect(keyedFetch('fmp', 'profile', { symbol: 'AAPL' }))
            .rejects.toThrow('not signed in');
    });

    it('throws when the session holds no access token', async () => {
        state.supabaseClient = {
            auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
        };
        await expect(keyedFetch('finnhub', 'quote', { symbol: 'AAPL' }))
            .rejects.toThrow('not signed in');
    });
});

// ── loadKeyedProviders ────────────────────────────────────────────────────────

describe('loadKeyedProviders — parsing the server status into booleans', () => {
    it('sets state.keyedProviders from the server response', async () => {
        stubFetch({ finnhub: true, fmp: true, alphavantage: true });
        await loadKeyedProviders();
        expect(state.keyedProviders).toEqual({ finnhub: true, fmp: true, alphavantage: true });
    });

    it('uses strict === true: truthy non-boolean values do not enable a provider', async () => {
        stubFetch({ finnhub: 1, fmp: 'yes', alphavantage: true });
        await loadKeyedProviders();
        expect(state.keyedProviders).toEqual({ finnhub: false, fmp: false, alphavantage: true });
    });

    it('partial configuration — only one key set — reflects correctly', async () => {
        stubFetch({ finnhub: false, fmp: true, alphavantage: false });
        await loadKeyedProviders();
        expect(state.keyedProviders).toEqual({ finnhub: false, fmp: true, alphavantage: false });
    });

    it('falls back to all false when the market-data function is not yet deployed', async () => {
        stubFetch({}, false);
        await loadKeyedProviders();
        expect(state.keyedProviders).toEqual({ finnhub: false, fmp: false, alphavantage: false });
    });

    it('skips the network entirely when there is no currentUser and returns all false', async () => {
        state.currentUser = null;
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        await loadKeyedProviders();
        expect(state.keyedProviders).toEqual({ finnhub: false, fmp: false, alphavantage: false });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

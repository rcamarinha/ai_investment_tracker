import { describe, it, expect } from 'vitest';
import {
    ENDPOINTS, PROVIDERS, validateRequest, buildUpstream, redact, callSucceeded,
} from '../supabase/functions/_shared/market-data-core.js';

/**
 * The market-data function holds the shared price keys, so what it will and
 * will not do with them is the whole of its security. Pinned here because the
 * edge runtime cannot be reached from the suite.
 */

const KEY = 'sekret-key-123456';

describe('validateRequest', () => {
    it('answers a status request without calling anyone', () => {
        expect(validateRequest({ op: 'status' })).toEqual({ ok: true, status: true });
    });

    it('accepts every endpoint the browser used to call', () => {
        const ok = [
            { provider: 'finnhub', op: 'quote', symbol: 'AAPL' },
            { provider: 'finnhub', op: 'profile', symbol: 'MSFT' },
            { provider: 'finnhub', op: 'profile-isin', isin: 'US0378331005' },
            { provider: 'finnhub', op: 'search', query: 'apple' },
            { provider: 'fmp', op: 'quote', symbols: ['AAPL', 'VWRL.L'] },
            { provider: 'fmp', op: 'profile', symbol: 'AAPL' },
            { provider: 'fmp', op: 'search-symbol', query: 'vanguard' },
            { provider: 'fmp', op: 'search-isin', isin: 'IE00B3RBWM25' },
            { provider: 'fmp', op: 'search-v3', query: 'apple' },
            { provider: 'alphavantage', op: 'quote', symbol: 'IBM' },
            { provider: 'alphavantage', op: 'overview', symbol: 'IBM' },
        ];
        for (const body of ok) expect(validateRequest(body).ok, JSON.stringify(body)).toBe(true);
    });

    it('refuses anything outside the fixed list, so the key cannot be pointed elsewhere', () => {
        for (const body of [
            { provider: 'yahoo', op: 'quote', symbol: 'AAPL' },
            { provider: 'fmp', op: 'historical-price-full', symbol: 'AAPL' },
            { provider: 'finnhub', op: '../../etc', symbol: 'AAPL' },
            { provider: 'fmp', op: 'constructor', symbol: 'AAPL' },
            { provider: 'fmp', op: '__proto__', symbol: 'AAPL' },
            { provider: 'finnhub', op: 'toString', symbol: 'AAPL' },
            { provider: 'finnhub', op: ['quote'], symbol: 'AAPL' },
            null, 'text',
        ]) {
            expect(validateRequest(body).ok, JSON.stringify(body)).toBe(false);
        }
    });

    it('refuses symbols that are not symbols', () => {
        for (const symbol of ['', 'AAPL&apikey=x', 'A'.repeat(21), 'AA PL', 'X/Y', '<script>']) {
            expect(validateRequest({ provider: 'finnhub', op: 'quote', symbol }).ok, symbol).toBe(false);
        }
        expect(validateRequest({ provider: 'finnhub', op: 'quote', symbol: '^GSPC' }).ok).toBe(true);
        expect(validateRequest({ provider: 'finnhub', op: 'quote', symbol: 'BRK.B' }).ok).toBe(true);
    });

    it('caps an FMP batch at 50 symbols and counts each one', () => {
        const fifty = Array.from({ length: 50 }, (_, i) => `S${i}`);
        expect(validateRequest({ provider: 'fmp', op: 'quote', symbols: fifty })).toMatchObject({ ok: true, units: 50 });
        expect(validateRequest({ provider: 'fmp', op: 'quote', symbols: [...fifty, 'X'] }).ok).toBe(false);
        expect(validateRequest({ provider: 'fmp', op: 'quote', symbols: [] }).ok).toBe(false);
    });

    it('checks ISINs and query length', () => {
        expect(validateRequest({ provider: 'fmp', op: 'search-isin', isin: 'not-an-isin' }).ok).toBe(false);
        expect(validateRequest({ provider: 'finnhub', op: 'search', query: 'x'.repeat(101) }).ok).toBe(false);
        expect(validateRequest({ provider: 'finnhub', op: 'search', query: '   ' }).ok).toBe(false);
    });

    it('covers exactly the three keyed providers', () => {
        expect(PROVIDERS).toEqual(Object.keys(ENDPOINTS));
    });
});

describe('buildUpstream', () => {
    const build = body => buildUpstream(validateRequest(body), KEY);

    it('sends the Finnhub key in a header, never in the URL', () => {
        const { url, headers } = build({ provider: 'finnhub', op: 'quote', symbol: 'AAPL' });
        expect(url).toBe('https://finnhub.io/api/v1/quote?symbol=AAPL');
        expect(url).not.toContain(KEY);
        expect(headers['X-Finnhub-Token']).toBe(KEY);
    });

    it('builds the same FMP batch URL the browser used to', () => {
        const { url } = build({ provider: 'fmp', op: 'quote', symbols: ['AAPL', 'MSFT'] });
        expect(url).toBe(`https://financialmodelingprep.com/stable/quote-short?symbol=AAPL%2CMSFT&apikey=${KEY}`);
    });

    it('adds the fixed parameters an endpoint needs', () => {
        expect(build({ provider: 'alphavantage', op: 'quote', symbol: 'IBM' }).url)
            .toBe(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=${KEY}`);
        expect(build({ provider: 'fmp', op: 'search-v3', query: 'apple inc' }).url)
            .toBe(`https://financialmodelingprep.com/api/v3/search?limit=8&query=apple+inc&apikey=${KEY}`);
    });

    it('encodes whatever the query holds, so it cannot add parameters', () => {
        const { url } = build({ provider: 'fmp', op: 'search-symbol', query: 'a&apikey=stolen' });
        expect(new URL(url).searchParams.getAll('apikey')).toEqual([KEY]);
    });
});

describe('redact', () => {
    it('removes the key wherever a provider echoes it', () => {
        expect(redact(`Invalid API KEY: ${KEY}. Visit…`, [KEY])).toBe('Invalid API KEY: ***. Visit…');
    });

    it('catches a key echoed in another letter case', () => {
        expect(redact(`key ${KEY.toUpperCase()} rejected`, [KEY])).toBe('key *** rejected');
    });

    it('blanks any apikey= or token= value in an echoed URL, even for a key it does not hold', () => {
        expect(redact('see https://x.test/q?symbol=A&apikey=SOMEOTHERKEY&x=1', []))
            .toBe('see https://x.test/q?symbol=A&apikey=***&x=1');
        expect(redact('"url":"https://finnhub.io/api/v1/quote?token=abc123"', [])).toBe('"url":"https://finnhub.io/api/v1/quote?token=***"');
    });

    it('leaves text alone when no key is set, and ignores keys too short to be real', () => {
        expect(redact('{"c": 1}', ['', null, 'abc'])).toBe('{"c": 1}');
    });
});

describe('callSucceeded', () => {
    it('treats a non-2xx status as a failure', () => {
        expect(callSucceeded('finnhub', 429, '{}')).toBe(false);
    });

    it('recognises FMP refusals that arrive with HTTP 200', () => {
        expect(callSucceeded('fmp', 200, 'Premium Query Parameter: this value is not available')).toBe(false);
        expect(callSucceeded('fmp', 200, '{"Error Message":"Limit Reach"}')).toBe(false);
        expect(callSucceeded('fmp', 200, '[{"symbol":"AAPL","price":190}]')).toBe(true);
        expect(callSucceeded('fmp', 200, '[]')).toBe(true);
    });

    it('recognises the Alpha Vantage rate-limit note', () => {
        expect(callSucceeded('alphavantage', 200, '{"Note":"Thank you for using Alpha Vantage!"}')).toBe(false);
        expect(callSucceeded('alphavantage', 200, '{"Information":"daily rate limit"}')).toBe(false);
        expect(callSucceeded('alphavantage', 200, '{"Global Quote":{"05. price":"150.0"}}')).toBe(true);
    });

    it('recognises a Finnhub error object', () => {
        expect(callSucceeded('finnhub', 200, '{"error":"You don\'t have access to this resource."}')).toBe(false);
        expect(callSucceeded('finnhub', 200, '{"c":190.5}')).toBe(true);
    });
});

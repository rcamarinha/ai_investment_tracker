import { describe, it, expect } from 'vitest';
import { tokensFrom, searchesFrom, buildUsageRow, USAGE_FUNCTIONS } from '../supabase/functions/_shared/usage-core.js';

/**
 * How a server function's spend becomes a usage row. The edge runtime cannot be
 * reached from here, so the judgements live in a pure module and are pinned
 * here: tokens read the way each provider bills them, and a bad event dropped
 * rather than stored or thrown.
 */

const USER = '437251b6-c274-4c4b-93ed-addb6baf8f00';

describe('tokensFrom', () => {
    it('reads Anthropic usage', () => {
        expect(tokensFrom('anthropic', { usage: { input_tokens: 1200, output_tokens: 340 } }))
            .toEqual({ input: 1200, output: 340 });
    });

    it('folds Anthropic cache tokens into input, so nothing is hidden', () => {
        expect(tokensFrom('anthropic', { usage: {
            input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 25, output_tokens: 10,
        } })).toEqual({ input: 175, output: 10 });
    });

    it('counts Gemini thinking tokens as output, because that is how they are billed', () => {
        expect(tokensFrom('gemini', { usageMetadata: {
            promptTokenCount: 800, candidatesTokenCount: 150, thoughtsTokenCount: 600, totalTokenCount: 1550,
        } })).toEqual({ input: 800, output: 750 });
    });

    it('reports nothing for a provider with no tokens, or a missing or odd body', () => {
        expect(tokensFrom('yahoo', { quoteResponse: {} })).toEqual({ input: 0, output: 0 });
        for (const body of [null, undefined, 'text', 42, {}, { usage: null }]) {
            expect(tokensFrom('anthropic', body)).toEqual({ input: 0, output: 0 });
        }
    });

    it('never records a negative or fractional count', () => {
        expect(tokensFrom('anthropic', { usage: { input_tokens: -5, output_tokens: 10.7 } }))
            .toEqual({ input: 0, output: 10 });
    });
});

describe('searchesFrom', () => {
    it('reads the web searches Claude ran, which are billed apart from tokens', () => {
        expect(searchesFrom('anthropic', { usage: { input_tokens: 5, server_tool_use: { web_search_requests: 3 } } })).toBe(3);
    });

    it('counts a Gemini grounded answer once, since grounding is billed per prompt', () => {
        const grounded = { candidates: [{ groundingMetadata: { webSearchQueries: ['AAPL price', 'AAPL isin'] } }] };
        expect(searchesFrom('gemini', grounded)).toBe(1);
        expect(searchesFrom('gemini', { candidates: [{ content: {} }] })).toBe(0);
    });

    it('reports none when there is nothing to read', () => {
        expect(searchesFrom('anthropic', { usage: {} })).toBe(0);
        expect(searchesFrom('yahoo', {})).toBe(0);
        expect(searchesFrom('gemini', null)).toBe(0);
    });
});

describe('buildUsageRow', () => {
    it('records a model call\'s web searches as units when none are given', () => {
        expect(buildUsageRow({
            userId: USER, fn: 'resolve-tickers', provider: 'anthropic', model: 'claude-sonnet-4-6',
            response: { usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 2 } } },
        }).units).toBe(2);
    });

    it('builds the row for a successful model call', () => {
        expect(buildUsageRow({
            userId: USER, fn: 'wine-ai', provider: 'anthropic', model: 'claude-opus-4-6',
            ok: true, response: { usage: { input_tokens: 10, output_tokens: 5 } },
        })).toEqual({
            user_id: USER, fn: 'wine-ai', provider: 'anthropic', model: 'claude-opus-4-6',
            ok: true, input_tokens: 10, output_tokens: 5, units: 0,
        });
    });

    it('records a failed call as a failure with no tokens', () => {
        const row = buildUsageRow({ userId: USER, fn: 'analyze-portfolio', provider: 'anthropic', ok: false });
        expect(row).toMatchObject({ ok: false, input_tokens: 0, output_tokens: 0 });
    });

    it('carries non-token work as units', () => {
        expect(buildUsageRow({ userId: USER, fn: 'quote-proxy', provider: 'yahoo', units: 25 }))
            .toMatchObject({ provider: 'yahoo', model: null, units: 25 });
    });

    it('treats a missing ok as success, and only an explicit false as failure', () => {
        expect(buildUsageRow({ userId: USER, fn: 'wine-ai', provider: 'gemini' }).ok).toBe(true);
    });

    it('drops an event it cannot attribute rather than storing a guess', () => {
        expect(buildUsageRow({ fn: 'wine-ai', provider: 'anthropic' })).toBeNull();
        expect(buildUsageRow({ userId: 'not-a-uuid', fn: 'wine-ai', provider: 'anthropic' })).toBeNull();
        expect(buildUsageRow({ userId: USER, fn: 'wine_ai', provider: 'anthropic' })).toBeNull();
        expect(buildUsageRow({ userId: USER, fn: 'wine-ai', provider: '' })).toBeNull();
        expect(buildUsageRow(null)).toBeNull();
    });

    it('never throws, whatever it is handed', () => {
        const hostile = { get userId() { throw new Error('boom'); } };
        expect(buildUsageRow(hostile)).toBeNull();
    });

    it('knows every function that calls it', () => {
        expect(USAGE_FUNCTIONS).toEqual(expect.arrayContaining([
            'analyze-portfolio', 'categorize-transactions', 'extract-statement', 'extract-trades',
            'market-data', 'quote-proxy', 'resolve-tickers', 'wine-ai',
        ]));
    });
});

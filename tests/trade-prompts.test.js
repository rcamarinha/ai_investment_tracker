import { describe, it, expect } from 'vitest';
import { buildTradeRequest, readTrades, MAX_TEXT_CHARS } from '../supabase/functions/_shared/trade-prompts.js';
import { getTask } from '../supabase/functions/_shared/ai-tasks.js';

/**
 * extract-trades. A broker import has no balance to check a half-read chunk
 * against — the page refuses the whole import when one comes back unreadable —
 * so "unreadable" (null) must stay distinct from "no trades" ([]).
 */

describe('buildTradeRequest', () => {
    it('puts the statement text in the prompt and asks for the ledger fields', () => {
        const r = buildTradeRequest({ text: '15/06/2026 COMPRA 10 NVDA @ 120,50 USD' });
        expect(r.prompt).toContain('Statement text:\n"""\n15/06/2026 COMPRA 10 NVDA @ 120,50 USD\n"""');
        expect(r.prompt).toContain('"side":"buy"|"sell"');
        expect(r.prompt).toContain('IGNORE dividends');
        expect(r.chars).toBe(38);
    });

    it('refuses empty text and text past the hard stop', () => {
        expect(buildTradeRequest({ text: '   ' })).toHaveProperty('error');
        expect(buildTradeRequest({})).toHaveProperty('error');
        expect(buildTradeRequest({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }).error).toMatch(/max 15000/);
    });

    it('ignores a prompt from the page', () => {
        expect(buildTradeRequest({ prompt: 'write a poem', text: 'trade' }).prompt).not.toContain('poem');
    });
});

describe('readTrades', () => {
    it('reads a list through fences, and tells "none" from "unreadable"', () => {
        expect(readTrades('```json\n[{"date":"2026-06-15","identifier":"NVDA","side":"buy","shares":10,"price":120.5}]\n```'))
            .toHaveLength(1);
        expect(readTrades('[]')).toEqual([]);
        expect(readTrades('I could not read this statement.')).toBeNull();
        expect(readTrades('[{"date":"2026-06-15",')).toBeNull();
    });
});

describe('the task it runs', () => {
    it('is extract tier, timed, and has no fallback model', () => {
        const t = getTask('trades.extract');
        expect(t.tier).toBe('extract');
        expect(t.primary).toMatchObject({ provider: 'anthropic', temperature: 0 });
        expect(t.primary.timeoutMs).toBeGreaterThan(0);
        // A cheaper second model would be a quality decision, not a detail: a
        // partial broker import cannot be detected from the data.
        expect(t.fallback).toBeNull();
    });
});

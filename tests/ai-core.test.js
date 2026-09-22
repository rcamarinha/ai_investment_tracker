import { describe, it, expect } from 'vitest';
import {
    anthropicBody, geminiBody, readAnthropic, readGemini, replyFailure, AiError,
} from '../supabase/functions/_shared/ai-core.js';

/**
 * What _shared/ai.ts sends to each provider and how it reads the reply. The
 * edge runtime cannot run here, so the provider-shaped half lives in a pure
 * module and these pin it.
 */

const claude = { provider: 'anthropic', model: 'claude-sonnet-4-6', keyEnv: 'ANTHROPIC_API_KEY', maxTokens: 500, timeoutMs: 30_000 };
const gemini = { provider: 'gemini', model: 'gemini-3.5-flash', keyEnv: 'GEMINI_WINE', maxTokens: 8192, timeoutMs: 45_000 };

describe('anthropicBody', () => {
    it('sends the model, the cap and the prompt', () => {
        expect(anthropicBody(claude, 'hello')).toEqual({
            model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: 'hello' }],
        });
    });

    it('adds a system prompt only when given', () => {
        expect(anthropicBody(claude, 'hi', 'be brief').system).toBe('be brief');
    });

    it('caps web search with max_uses — uncapped, one call read 440K tokens', () => {
        expect(anthropicBody({ ...claude, searches: 3 }, 'hi').tools)
            .toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
        expect(anthropicBody({ ...claude, searches: 0 }, 'hi')).not.toHaveProperty('tools');
    });
});

describe('geminiBody', () => {
    it('always states thinking when the task sets it', () => {
        expect(geminiBody({ ...gemini, thinking: 'off' }, 'x').generationConfig)
            .toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } });
        expect(geminiBody({ ...gemini, thinking: 'low' }, 'x').generationConfig)
            .toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'low' } });
        expect(geminiBody({ ...gemini, thinking: 'minimal' }, 'x').generationConfig)
            .toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'minimal' } });
    });

    it('offers search only when allowed, and puts a system prompt where Gemini reads it', () => {
        const b = geminiBody({ ...gemini, searches: 1 }, 'x', 'search first');
        expect(b.tools).toEqual([{ google_search: {} }]);
        expect(b.systemInstruction).toEqual({ parts: [{ text: 'search first' }] });
        expect(geminiBody(gemini, 'x')).not.toHaveProperty('tools');
    });
});

describe('readAnthropic', () => {
    it('joins the text blocks and counts the searches Claude reports', () => {
        const r = readAnthropic({
            stop_reason: 'end_turn',
            content: [{ type: 'server_tool_use' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
            usage: { server_tool_use: { web_search_requests: 2 } },
        });
        expect(r).toMatchObject({ text: 'ab', stop: 'end_turn', truncated: false, searches: 2 });
    });

    it('marks an answer cut off by the output cap', () => {
        expect(readAnthropic({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '[{"a":' }] }).truncated).toBe(true);
    });

    it('survives a body with nothing in it', () => {
        expect(readAnthropic(null)).toMatchObject({ text: '', stop: 'none', searches: 0 });
    });
});

describe('readGemini', () => {
    it('reads the answer, not the thought summaries', () => {
        const r = readGemini({
            candidates: [{
                finishReason: 'STOP',
                content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"v":1}' }] },
                groundingMetadata: { webSearchQueries: ['q1', 'q2'] },
            }],
            usageMetadata: { thoughtsTokenCount: 845 },
        });
        expect(r).toEqual({ text: '{"v":1}', stop: 'STOP', truncated: false, stopped: false, searches: 2, thinking: 845 });
    });

    it('counts no search when Gemini answered from memory', () => {
        expect(readGemini({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x' }] } }] }).searches).toBe(0);
    });

    it('marks MAX_TOKENS as cut off — thinking can use up the cap', () => {
        expect(readGemini({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }).truncated).toBe(true);
    });
});

describe('temperature and abnormal stops', () => {
    it('sends temperature 0 to both providers when the task sets it', () => {
        expect(anthropicBody({ ...claude, temperature: 0 }, 'x').temperature).toBe(0);
        expect(geminiBody({ ...gemini, temperature: 0 }, 'x').generationConfig.temperature).toBe(0);
        expect(anthropicBody(claude, 'x')).not.toHaveProperty('temperature');
    });

    it('treats a refusal, an unfinished search turn, or a Gemini safety stop as not an answer', () => {
        expect(readAnthropic({ stop_reason: 'refusal', content: [{ type: 'text', text: 'x' }] }).stopped).toBe(true);
        expect(readAnthropic({ stop_reason: 'pause_turn', content: [{ type: 'text', text: 'x' }] }).stopped).toBe(true);
        expect(readAnthropic({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }).stopped).toBe(false);
        for (const finishReason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'OTHER']) {
            expect(readGemini({ candidates: [{ finishReason, content: { parts: [{ text: 'x' }] } }] }).stopped, finishReason).toBe(true);
        }
        expect(readGemini({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x' }] } }] }).stopped).toBe(false);
    });
});

describe('replyFailure', () => {
    const ok = { text: 'fine', stop: 'end_turn', truncated: false, stopped: false, searches: 0, thinking: 0 };

    it('passes a usable answer', () => {
        expect(replyFailure(ok)).toBeNull();
    });

    it('fails a cut-off answer and an empty one, saying which', () => {
        expect(replyFailure({ ...ok, truncated: true, stop: 'max_tokens' })).toMatchObject({ kind: 'truncated' });
        expect(replyFailure({ ...ok, text: '  \n' })).toMatchObject({ kind: 'empty' });
        expect(replyFailure({ ...ok, text: '' })).toBeInstanceOf(AiError);
        expect(replyFailure({ ...ok, stopped: true, stop: 'SAFETY' })).toMatchObject({ kind: 'stopped' });
    });
});

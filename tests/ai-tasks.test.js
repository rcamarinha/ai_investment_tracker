import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
    AI_TASKS, APPROVED_MODELS, KEY_ENV, FUNCTION_WALL_MS, getTask, worstCaseMs,
} from '../supabase/functions/_shared/ai-tasks.js';
import { MODEL_PRICES } from '../services/admin-report-core.js';
import { USAGE_FUNCTIONS } from '../supabase/functions/_shared/usage-core.js';

/**
 * The rules every AI task runs under (plan P9). They read their authority from
 * the registry and from the function sources, so a new task or a new function
 * cannot quietly skip one.
 */

const tasks = Object.entries(AI_TASKS);
const calls = tasks.flatMap(([name, t]) => [[name, 'primary', t.primary], ...(t.fallback ? [[name, 'fallback', t.fallback]] : [])]);
const approved = new Set(Object.values(APPROVED_MODELS));

describe('every task', () => {
    it.each(tasks)('%s runs in a known function', (_name, t) => {
        expect(USAGE_FUNCTIONS).toContain(t.fn);
        expect(['extract', 'research']).toContain(t.tier);
    });

    it.each(tasks)('%s fits inside the page\'s wait and the function\'s 150s', (_name, t) => {
        expect(worstCaseMs(t)).toBeLessThanOrEqual(t.pageWaitMs);
        expect(worstCaseMs(t)).toBeLessThanOrEqual(FUNCTION_WALL_MS);
    });

    it.each(tasks)('%s: a fallback, when there is one, uses the other provider', (_name, t) => {
        if (t.fallback) expect(t.fallback.provider).not.toBe(t.primary.provider);
    });
});

describe('every model call', () => {
    it.each(calls)('%s %s uses an approved model that the admin page can price', (_n, _w, c) => {
        expect(approved.has(c.model)).toBe(true);
        // A model with no price would show on the admin page as costing nothing.
        expect(MODEL_PRICES).toHaveProperty([c.model]);
    });

    it.each(calls)('%s %s has a time limit', (_n, _w, c) => {
        expect(Number.isInteger(c.timeoutMs) && c.timeoutMs > 0).toBe(true);
    });

    it.each(calls)('%s %s names a known key and an output cap', (_n, _w, c) => {
        expect(Object.values(KEY_ENV)).toContain(c.keyEnv);
        expect(c.keyEnv.startsWith(c.provider === 'gemini' ? 'GEMINI' : 'ANTHROPIC')).toBe(true);
        expect(Number.isInteger(c.maxTokens) && c.maxTokens > 0).toBe(true);
    });

    it.each(calls)('%s %s: web search, if allowed, is capped', (_n, _w, c) => {
        if (c.searches !== undefined) expect(Number.isInteger(c.searches) && c.searches >= 0 && c.searches <= 10).toBe(true);
    });

    it.each(calls)('%s %s: thinking is only set for Gemini', (_n, _w, c) => {
        if (c.thinking !== undefined) {
            expect(c.provider).toBe('gemini');
            expect(['off', 'low']).toContain(c.thinking);
        }
    });
});

describe('the extract tier stays cheap and repeatable', () => {
    const extract = calls.filter(([n]) => AI_TASKS[n].tier === 'extract');
    it.each(extract.length ? extract : [['(none yet)', '', null]])('%s %s: no search, no thinking', (_n, _w, c) => {
        if (!c) return;
        expect(c.searches ?? 0).toBe(0);
        if (c.provider === 'gemini') expect(c.thinking).toBe('off');
    });
});

describe('getTask', () => {
    it('finds a registered task', () => {
        expect(getTask('analysis.movers')).toBe(AI_TASKS['analysis.movers']);
    });

    it('never resolves an inherited name or a non-string', () => {
        for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', undefined, null, 42]) {
            expect(getTask(name), String(name)).toBeNull();
        }
    });
});

// ── The source, not only the table ───────────────────────────────────────────
//
// A registry that functions can walk around is not one place. These read every
// function's source: only _shared/ai.ts may call a provider, and no function may
// run a prompt the browser wrote. Functions not yet migrated are listed here;
// the lists may only SHRINK — remove a name when its function moves.

const FUNCTIONS_DIR = join(__dirname, '..', 'supabase', 'functions');
const functionSources = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_'))
    .map(d => [d.name, readFileSync(join(FUNCTIONS_DIR, d.name, 'index.ts'), 'utf8')]);

const NOT_YET_ON_AI_TS = [
    'extract-trades', 'wine-ai',
];
const STILL_ACCEPTS_A_PROMPT = [];

const callsProviderDirectly = src => /api\.anthropic\.com|generativelanguage\.googleapis\.com/.test(src);
const readsPromptFromBody = src =>
    /\{[^}]*\bprompt\b[^}]*\}\s*=\s*(?:body|await\s+req\.json\(\))/.test(src)
    || /\bbody\s*(?:\.\s*prompt\b|\[\s*["']prompt["']\s*\])/.test(src);

describe('only _shared/ai.ts calls a model provider', () => {
    it.each(functionSources)('%s', (name, src) => {
        if (NOT_YET_ON_AI_TS.includes(name)) return;
        expect(callsProviderDirectly(src), `${name} calls a provider itself; use runTask from _shared/ai.ts`).toBe(false);
    });

    it('the not-yet-migrated list names only functions that still need it', () => {
        for (const name of NOT_YET_ON_AI_TS) {
            const src = functionSources.find(([n]) => n === name)?.[1];
            expect(src, `${name} does not exist`).toBeDefined();
            expect(callsProviderDirectly(src), `${name} has moved to ai.ts — remove it from NOT_YET_ON_AI_TS`).toBe(true);
        }
    });
});

describe('no function runs a prompt the browser wrote', () => {
    it.each(functionSources)('%s', (name, src) => {
        if (STILL_ACCEPTS_A_PROMPT.includes(name)) return;
        expect(readsPromptFromBody(src), `${name} reads "prompt" from the request body`).toBe(false);
    });

    it('the exception list names only functions that still need it', () => {
        for (const name of STILL_ACCEPTS_A_PROMPT) {
            const src = functionSources.find(([n]) => n === name)?.[1];
            expect(readsPromptFromBody(src), `${name} no longer reads a prompt — remove it from STILL_ACCEPTS_A_PROMPT`).toBe(true);
        }
    });

    it('the detector catches the shapes it must', () => {
        expect(readsPromptFromBody('const { portfolio, prompt: customPrompt } = body;')).toBe(true);
        expect(readsPromptFromBody('const { requestType, prompt, image } = body;')).toBe(true);
        expect(readsPromptFromBody('const p = body.prompt;')).toBe(true);
        expect(readsPromptFromBody('const p = body["prompt"];')).toBe(true);
        expect(readsPromptFromBody('const prompt = buildPrompt(text);')).toBe(false);
    });
});

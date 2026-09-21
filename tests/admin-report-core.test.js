import { describe, it, expect } from 'vitest';
import { summarizeUsage, describePerson, TOOLS } from '../services/admin-report-core.js';

/**
 * The admin dashboard's numbers. Each is only as honest as the rule behind it,
 * so the rules are pinned here: what counts as active, what counts as using a
 * tool, and that a missing date is never read as a date.
 */

const NOW = Date.parse('2026-09-18T12:00:00Z');
const daysAgo = n => new Date(NOW - n * 86_400_000).toISOString();
const noTools = { stocks: { items: 0, last: null }, wine: { items: 0, last: null },
                  spend: { items: 0, last: null }, bank: { items: 0, last: null } };

const person = (id, overrides = {}) => ({
    id, email: `${id}@example.com`, created_at: daysAgo(100), last_sign_in_at: null,
    invited_at: null, confirmed_at: daysAgo(100), last_report_at: null,
    problems_30d: 0, operations_30d: 0, tools: { ...noTools }, ...overrides,
});

describe('what counts as active', () => {
    it('counts someone who saved something recently, even without signing in again', () => {
        // Sessions refresh themselves for weeks; last_sign_in_at alone would
        // call a daily user inactive.
        const p = person('daily', {
            last_sign_in_at: daysAgo(40),
            tools: { ...noTools, wine: { items: 12, last: daysAgo(2) } },
        });
        const s = summarizeUsage({ people: [p] }, NOW);
        expect(s.totals.active7).toBe(1);
        expect(s.totals.active30).toBe(1);
    });

    it('counts a sign-in on its own as activity', () => {
        const s = summarizeUsage({ people: [person('a', { last_sign_in_at: daysAgo(3) })] }, NOW);
        expect(s.totals.active7).toBe(1);
    });

    it('counts an import or valuation that ran, via its diagnostic', () => {
        const s = summarizeUsage({ people: [person('a', { last_report_at: daysAgo(20) })] }, NOW);
        expect(s.totals.active7).toBe(0);
        expect(s.totals.active30).toBe(1);
    });

    it('does not count someone whose last trace is older than the window', () => {
        const s = summarizeUsage({ people: [person('old', { last_sign_in_at: daysAgo(45) })] }, NOW);
        expect(s.totals.active30).toBe(0);
    });

    it('does not believe a date in the future', () => {
        // created_at and updated_at can be set by the owner of the row, so a
        // date next year would otherwise pin someone to the top of the list.
        const faked = person('faker', {
            last_sign_in_at: daysAgo(90),
            tools: { ...noTools, stocks: { items: 1, last: daysAgo(-365) } },
        });
        const p = describePerson(faked, NOW);
        expect(p.lastActiveMs).toBe(Date.parse(daysAgo(90)));
        const s = summarizeUsage({ people: [faked, person('real', { last_sign_in_at: daysAgo(2) })] }, NOW);
        expect(s.people[0].id).toBe('real');
        expect(s.totals.active30).toBe(1);
    });

    it('never reads a missing date as 1970, or as now', () => {
        const p = describePerson(person('never'), NOW);
        expect(p.lastActiveMs).toBeNull();
        const s = summarizeUsage({ people: [person('never')] }, NOW);
        expect(s.totals.active30).toBe(0);
    });
});

describe('what counts as using a tool', () => {
    it('is having at least one row there, whenever it was added', () => {
        const p = describePerson(person('a', {
            tools: { ...noTools, stocks: { items: 79, last: daysAgo(90) }, spend: { items: 592, last: daysAgo(1) } },
        }));
        expect(p.used.map(t => t.key)).toEqual(['stocks', 'spend']);
    });

    it('separates people who use a tool from people who used it this month', () => {
        const s = summarizeUsage({ people: [
            person('a', { tools: { ...noTools, wine: { items: 599, last: daysAgo(1) } } }),
            person('b', { tools: { ...noTools, wine: { items: 1, last: daysAgo(200) } } }),
            person('c'),
        ] }, NOW);
        const wine = s.tools.find(t => t.key === 'wine');
        expect(wine).toMatchObject({ users: 2, active30: 1 });
        expect(s.tools.find(t => t.key === 'bank')).toMatchObject({ users: 0, active30: 0 });
    });

    it('treats a malformed count as none rather than guessing', () => {
        const p = describePerson(person('a', {
            tools: { ...noTools, stocks: { items: 'lots', last: daysAgo(1) }, wine: { items: -3, last: null } },
        }));
        expect(p.used).toEqual([]);
    });

    it('lists every tool in a fixed order', () => {
        expect(summarizeUsage({ people: [] }, NOW).tools.map(t => t.key)).toEqual(TOOLS.map(t => t.key));
    });
});

describe('the headline counts', () => {
    it('counts accounts, recent signups and accounts that have done nothing', () => {
        const s = summarizeUsage({ people: [
            person('old'),
            person('new', { created_at: daysAgo(5) }),
            person('busy', { tools: { ...noTools, spend: { items: 3, last: daysAgo(1) } } }),
        ] }, NOW);
        expect(s.totals).toMatchObject({ accounts: 3, joined30: 1, unused: 2 });
    });

    it('carries problems and operations through as counts', () => {
        const p = describePerson(person('a', { problems_30d: 4, operations_30d: 9 }));
        expect(p).toMatchObject({ problems30: 4, operations30: 9 });
    });
});

describe('ordering and robustness', () => {
    it('lists the most recently active first and the never-active last', () => {
        const s = summarizeUsage({ people: [
            person('never'),
            person('recent', { last_sign_in_at: daysAgo(1) }),
            person('older', { last_sign_in_at: daysAgo(10) }),
        ] }, NOW);
        expect(s.people.map(p => p.id)).toEqual(['recent', 'older', 'never']);
    });

    it('indexes people by id for the page to join onto its invitation list', () => {
        const s = summarizeUsage({ people: [person('a')] }, NOW);
        expect(s.byId.get('a').email).toBe('a@example.com');
    });

    it('survives an empty, missing or malformed report', () => {
        for (const r of [null, undefined, {}, { people: null }, { people: [null, { email: 'no-id' }] }]) {
            const s = summarizeUsage(r, NOW);
            expect(s.totals.accounts).toBe(0);
            expect(s.people).toEqual([]);
        }
    });
});

// ── AI and API usage ──────────────────────────────────────────────────────────

import { summarizeAiUsage, estimateCost, MODEL_PRICES, FUNCTION_LABELS } from '../services/admin-report-core.js';

const aiRow = (overrides = {}) => ({
    user_id: 'ana', fn: 'wine-ai', provider: 'anthropic', model: 'claude-opus-4-6',
    calls: 1, failures: 0, input_tokens: 0, output_tokens: 0, units: 0, last_at: daysAgo(1), ...overrides,
});

describe('estimateCost', () => {
    it('prices input and output separately, per million tokens', () => {
        // Opus 4.6 at $5 in / $25 out: 1M in + 1M out = $30.
        expect(estimateCost(aiRow({ input_tokens: 1_000_000, output_tokens: 1_000_000 }))).toBeCloseTo(30);
        // Gemini 2.5 Flash at $0.30 / $2.50.
        expect(estimateCost(aiRow({ model: 'gemini-2.5-flash', provider: 'gemini', input_tokens: 2_000_000, output_tokens: 400_000 })))
            .toBeCloseTo(0.6 + 1.0);
    });

    it('says it does not know, rather than calling an unknown model free', () => {
        expect(estimateCost(aiRow({ model: 'some-future-model', input_tokens: 1000 }))).toBeNull();
    });

    it('prices the free keyed price APIs at nothing, rather than calling them unpriced', () => {
        for (const provider of ['finnhub', 'fmp', 'alphavantage']) {
            expect(estimateCost(aiRow({ fn: 'market-data', provider, model: null, units: 3 })), provider).toBe(0);
        }
    });

    it('prices the keyless quote proxy at nothing', () => {
        expect(estimateCost(aiRow({ fn: 'quote-proxy', provider: 'yahoo', model: null, units: 25 }))).toBe(0);
    });

    it('has a price for every model the functions call today', () => {
        for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'gemini-2.5-flash']) {
            expect(MODEL_PRICES[m], m).toBeTruthy();
        }
    });
});

describe('summarizeAiUsage', () => {
    const report = { rows: [
        aiRow({ calls: 3, failures: 1, input_tokens: 4000, output_tokens: 1000, units: 2 }),
        aiRow({ model: 'gemini-2.5-flash', provider: 'gemini', calls: 5, input_tokens: 10_000, output_tokens: 2000, units: 3 }),
        aiRow({ user_id: 'ben', fn: 'analyze-portfolio', model: 'claude-sonnet-4-6', calls: 2, input_tokens: 3000, output_tokens: 600 }),
        aiRow({ user_id: 'ben', fn: 'quote-proxy', provider: 'yahoo', model: null, calls: 4, units: 90 }),
    ] };

    it('adds up calls, failures and tokens across everything', () => {
        const s = summarizeAiUsage(report);
        expect(s.totals).toMatchObject({ calls: 14, failures: 1, inputTokens: 17_000, outputTokens: 3600 });
    });

    it('keeps web searches and quoted symbols apart', () => {
        const s = summarizeAiUsage(report);
        expect(s.totals.searches).toBe(5);
        expect(s.totals.quotes).toBe(90);
    });

    it('estimates cost per person', () => {
        const s = summarizeAiUsage(report);
        const ana = (4000 * 5 + 1000 * 25 + 10_000 * 0.3 + 2000 * 2.5) / 1e6;
        expect(s.byPerson.get('ana').cost).toBeCloseTo(ana, 8);
        expect(s.byPerson.get('ben').cost).toBeCloseTo((3000 * 3 + 600 * 15) / 1e6, 8);
    });

    it('groups by feature with a readable name, most expensive first', () => {
        const s = summarizeAiUsage(report);
        expect(s.byFunction[0]).toMatchObject({ fn: 'wine-ai', label: FUNCTION_LABELS['wine-ai'], calls: 8 });
        expect(s.byFunction.map(f => f.fn)).toContain('quote-proxy');
    });

    it('counts symbols from the keyed price APIs as quotes, never as web searches', () => {
        const s = summarizeAiUsage({ rows: [
            aiRow({ fn: 'market-data', provider: 'fmp', model: null, calls: 2, units: 60 }),
            aiRow({ fn: 'market-data', provider: 'finnhub', model: null, calls: 5, units: 5 }),
        ] });
        expect(s.totals).toMatchObject({ quotes: 65, searches: 0, cost: 0 });
        expect(s.unpriced).toEqual([]);
    });

    it('names models it could not price, so the total is not silently low', () => {
        const s = summarizeAiUsage({ rows: [aiRow({ model: 'claude-next-9', input_tokens: 5000 })] });
        expect(s.unpriced).toEqual(['claude-next-9']);
        expect(s.totals.cost).toBe(0);
    });

    it('survives an empty or malformed report', () => {
        for (const r of [null, {}, { rows: null }, { rows: [null, { fn: 'x' }] }]) {
            const s = summarizeAiUsage(r);
            expect(s.totals.calls).toBe(0);
            expect(s.byFunction).toEqual([]);
        }
    });
});

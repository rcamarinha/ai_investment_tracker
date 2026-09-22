/**
 * Every AI task the server runs, and the rules it runs under — plan P9.
 *
 * One table, not one model. A task names its model from APPROVED_MODELS and
 * picks a tier: "extract" work (statements, categories, trades) must give the
 * same rows for the same input, so it runs cheap with thinking off and no
 * search; "research" work (prices, tickers, analysis) may search and think.
 * Uniform rules live in _shared/ai.ts and are the same for every task: a time
 * limit on every call, timeouts recorded as usage, a cut-off answer is a
 * failure, searches are capped, one timing log.
 *
 * Pure, so tests/ai-tasks.test.js holds the rules: every model is priced on the
 * admin page, every call has a time limit, a searched call has a cap, and a
 * task's calls fit inside the time its page waits.
 *
 * Tasks move here one function at a time (plan P9 order). A function not yet
 * migrated still calls its providers directly; tests/ai-tasks.test.js keeps
 * that list and it may only shrink.
 */

/** The only models a task may name. Retiring one is a one-line change here. */
export const APPROVED_MODELS = Object.freeze({
  claudeSonnet: "claude-sonnet-4-6",
  claudeHaiku: "claude-haiku-4-5-20251001",
  geminiFlash: "gemini-3.5-flash",
  // gemini-2.5-flash is on Google's retirement path; tasks still on it move to
  // geminiFlash when their function is migrated.
  geminiFlashLegacy: "gemini-2.5-flash",
});

/**
 * The secrets holding the keys. Every Gemini caller shares one (its name is
 * historical); wine-ai has its own Anthropic key.
 */
export const KEY_ENV = Object.freeze({
  anthropic: "ANTHROPIC_API_KEY",
  anthropicWine: "ANTHROPIC_API_KEY_Wine",
  gemini: "GEMINI_WINE",
});

/** Supabase stops an edge function request at 150s of wall clock. */
export const FUNCTION_WALL_MS = 150_000;

/**
 * @typedef {object} ModelCall
 * @property {"anthropic"|"gemini"} provider
 * @property {string} model        one of APPROVED_MODELS
 * @property {string} keyEnv       the secret holding this provider's key
 * @property {number} maxTokens    output cap, thinking included for Gemini
 * @property {number} timeoutMs    this call's time limit
 * @property {number} [searches]   web searches allowed; 0 or absent = none
 * @property {"off"|"low"} [thinking]  Gemini only
 *
 * @typedef {object} AiTask
 * @property {string} fn           the edge function that runs it (a USAGE_FUNCTIONS name)
 * @property {"extract"|"research"} tier
 * @property {number} pageWaitMs   how long the page waits for the answer
 * @property {ModelCall} primary
 * @property {ModelCall|null} fallback
 */

/** @type {Readonly<Record<string, AiTask>>} */
export const AI_TASKS = Object.freeze({
  // analyze-portfolio — the portfolio page's AI panel. Prompts are built on the
  // server from typed fields (_shared/analysis-prompts.js).
  "analysis.markets": {
    fn: "analyze-portfolio", tier: "research", pageWaitMs: FUNCTION_WALL_MS,
    primary: { provider: "anthropic", keyEnv: KEY_ENV.anthropic, model: APPROVED_MODELS.claudeSonnet, maxTokens: 2500, timeoutMs: 90_000 },
    fallback: null,
  },
  "analysis.tradeIdeas": {
    fn: "analyze-portfolio", tier: "research", pageWaitMs: FUNCTION_WALL_MS,
    primary: { provider: "anthropic", keyEnv: KEY_ENV.anthropic, model: APPROVED_MODELS.claudeSonnet, maxTokens: 4000, timeoutMs: 120_000 },
    fallback: null,
  },
  "analysis.movers": {
    fn: "analyze-portfolio", tier: "research", pageWaitMs: FUNCTION_WALL_MS,
    primary: { provider: "anthropic", keyEnv: KEY_ENV.anthropic, model: APPROVED_MODELS.claudeSonnet, maxTokens: 350, timeoutMs: 30_000 },
    fallback: null,
  },
});

/**
 * The task by name, own properties only, so "constructor" or "__proto__" can
 * never resolve to something.
 * @param {string} name
 * @returns {AiTask|null}
 */
export function getTask(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(AI_TASKS, name)
    ? AI_TASKS[name] : null;
}

/**
 * The time the task's calls can take in the worst case: the primary, then the
 * fallback. Must stay under the page's wait and the function's wall clock.
 * @param {AiTask} task
 * @returns {number}
 */
export function worstCaseMs(task) {
  return task.primary.timeoutMs + (task.fallback ? task.fallback.timeoutMs : 0);
}

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
 * @property {"off"|"minimal"|"low"} [thinking]  Gemini only: "off" is the 2.5 form; "minimal"/"low" are 3.x levels
 * @property {number} [temperature]    0 for extraction: the same input must give the same rows
 *
 * @typedef {object} AiTask
 * @property {string} fn           the edge function that runs it (a USAGE_FUNCTIONS name)
 * @property {"extract"|"research"} tier
 * @property {number} pageWaitMs   how long the page waits for the answer
 * @property {ModelCall} primary
 * @property {ModelCall|null} fallback
 * @property {ModelCall} [candidate]  a model on trial: run beside the primary
 *   only when the trial is switched on (_shared/shadow.ts), its answer compared
 *   and discarded — never returned as the result, never falling back
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
  // extract-statement — statement lines to ledger rows. Extract tier: the same
  // statement must give the same rows (temperature 0, no thinking), and the page
  // re-checks every row against the statement's running balance. Still on
  // gemini-2.5 until 3.5 is compared on a real statement (plan P9 step 5b).
  "statements.extract": {
    fn: "extract-statement", tier: "extract", pageWaitMs: 115_000,
    primary: { provider: "gemini", keyEnv: KEY_ENV.gemini, model: APPROVED_MODELS.geminiFlashLegacy, maxTokens: 16384, timeoutMs: 45_000, thinking: "off", temperature: 0 },
    fallback: { provider: "anthropic", keyEnv: KEY_ENV.anthropic, model: APPROVED_MODELS.claudeHaiku, maxTokens: 8000, timeoutMs: 60_000, temperature: 0 },
    // Trial, plan P9 step 5b (from 22 September, about two weeks): Google's
    // recommended 3.x settings — "minimal" thinking and the default temperature,
    // which Google advises keeping for Gemini 3. Remove once decided.
    candidate: { provider: "gemini", keyEnv: KEY_ENV.gemini, model: APPROVED_MODELS.geminiFlash, maxTokens: 16384, timeoutMs: 45_000, thinking: "minimal" },
  },
  // categorize-transactions — a category from the user's own list per row.
  "transactions.categorize": {
    fn: "categorize-transactions", tier: "extract", pageWaitMs: 55_000,
    primary: { provider: "gemini", keyEnv: KEY_ENV.gemini, model: APPROVED_MODELS.geminiFlashLegacy, maxTokens: 16384, timeoutMs: 25_000, thinking: "off", temperature: 0 },
    fallback: { provider: "anthropic", keyEnv: KEY_ENV.anthropic, model: APPROVED_MODELS.claudeHaiku, maxTokens: 8000, timeoutMs: 25_000, temperature: 0 },
    candidate: { provider: "gemini", keyEnv: KEY_ENV.gemini, model: APPROVED_MODELS.geminiFlash, maxTokens: 16384, timeoutMs: 25_000, thinking: "minimal" },
  },
  // extract-trades — a broker statement's text to ledger trades. Extract tier,
  // and Claude alone: a broker import has no balance to check a partial answer
  // against, so the page refuses the import when a chunk is unreadable. Trying
  // a cheaper model here is a decision to take with evidence, not in passing.
  "trades.extract": {
    fn: "extract-trades", tier: "extract", pageWaitMs: FUNCTION_WALL_MS,
    primary: { provider: "anthropic", keyEnv: KEY_ENV.anthropic, model: APPROVED_MODELS.claudeSonnet, maxTokens: 4000, timeoutMs: 90_000, temperature: 0 },
    fallback: null,
  },
  // resolve-tickers — a priceable ticker for holdings every price API refused.
  // Gemini decides whether to search; a price in an unsearched answer is
  // dropped (_shared/ticker-prompts.js), and the page validates every ticker.
  "tickers.resolve": {
    fn: "resolve-tickers", tier: "research", pageWaitMs: FUNCTION_WALL_MS,
    primary: { provider: "gemini", keyEnv: KEY_ENV.gemini, model: APPROVED_MODELS.geminiFlash, maxTokens: 8192, timeoutMs: 45_000, searches: 1, thinking: "low" },
    // Uncapped until P9: one wine call like this read 440K tokens.
    fallback: { provider: "anthropic", keyEnv: KEY_ENV.anthropic, model: APPROVED_MODELS.claudeSonnet, maxTokens: 4000, timeoutMs: 60_000, searches: 8 },
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

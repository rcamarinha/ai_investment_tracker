/**
 * categorize-core.js — deciding what to send, and what to do with the answers.
 *
 * PURE by contract: no DOM, no network, no service imports. Tests import this
 * directly; no `src/` mirror (see CLAUDE.md).
 *
 * The shape this encodes:
 *   rules (free, instant)  →  structural facts (transfers, income)  →  AI
 *
 * Each stage removes work from the next. Rules cover the repetitive bulk — one
 * correction on a real ledger categorised 140 of 971 rows — and transfers are
 * solved deterministically by pairing, so neither should cost a token. The AI
 * is for the long tail: on real data 61% of distinct merchants appear exactly
 * once, but they are only 16% of rows.
 */

const DEFAULT_CONFIDENCE = 0.8;
const LARGE_MULTIPLE = 3;
const DEFAULT_BATCH = 40;

/** Rows the AI should never see, and why. */
export function partitionForAi(transactions = [], options = {}) {
    const incomeCategories = new Set(options.incomeCategories || []);
    const skipped = { alreadyCategorised: 0, transfer: 0, income: 0 };
    const toSend = [];

    for (const tx of transactions) {
        // Transfers are checked FIRST. A transfer carries category 'transfer',
        // so testing `tx.category` before it attributed every transfer to
        // "already categorised" and reported "0 transfers skipped" — the row was
        // correctly excluded, but the summary told the user the wrong reason.
        //
        // A transfer is established by pairing two of the user's own accounts —
        // a fact about the data, not a judgement. Asking a model to recognise
        // the account holder's own name would be strictly worse, and paying for
        // it absurd.
        if (tx.category === 'transfer' || tx.transferPairId) { skipped.transfer++; continue; }
        if (tx.category) { skipped.alreadyCategorised++; continue; }
        // A credit already matching a known income category is likewise settled.
        if (tx.amount > 0 && incomeCategories.has(tx.suggestedCategory)) { skipped.income++; continue; }
        toSend.push(tx);
    }
    return { toSend, skipped };
}

/** Split into request-sized batches. */
export function batchTransactions(transactions = [], size = DEFAULT_BATCH) {
    const batches = [];
    for (let i = 0; i < transactions.length; i += size) batches.push(transactions.slice(i, i + size));
    return batches;
}

/** Only what the model needs. Never the balance, the account, or the raw text. */
export function toPrompt(transactions = []) {
    return transactions.map(t => ({
        id: t.id,
        description: (t.merchant || t.description || '').slice(0, 80),
        amount: t.amount,
        direction: t.amount < 0 ? 'out' : 'in'
    }));
}

function median(values) {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Turn model answers into decisions.
 *
 * Two guardrails, both mechanical:
 *
 *  - Results are matched by id through a Map, never by array index. The model
 *    can return fewer items than it was asked about, and index matching then
 *    applies one row's category to a different row — the same defect the wine
 *    module's batch valuation already had to fix.
 *
 *  - A transaction far larger than the batch's median is forced to review
 *    whatever its confidence. A big one-off silently filed as routine spend is
 *    worse than leaving it uncategorised: uncategorised is visibly a gap, while
 *    a wrong category is invisible until the savings rate built on it is
 *    already wrong.
 */
export function applyAiResults(transactions = [], results = [], options = {}) {
    const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE;
    const validCategories = options.validCategories ? new Set(options.validCategories) : null;
    const byId = new Map();
    for (const r of results) if (r && r.id !== undefined && r.id !== null) byId.set(String(r.id), r);

    const magnitudes = transactions.map(t => Math.abs(Number(t.amount) || 0)).filter(n => n > 0);
    const largeThreshold = median(magnitudes) * LARGE_MULTIPLE;

    const applied = [], review = [], unanswered = [];
    for (const tx of transactions) {
        const result = byId.get(String(tx.id));
        if (!result || !result.category) { unanswered.push(tx); continue; }

        // A category the user does not have is not a category.
        if (validCategories && !validCategories.has(result.category)) {
            review.push({ ...tx, suggestedCategory: result.category, confidence: result.confidence ?? null,
                reason: 'suggested a category that does not exist' });
            continue;
        }

        const confidence = Number(result.confidence);
        const isLarge = largeThreshold > 0 && Math.abs(Number(tx.amount) || 0) >= largeThreshold;

        if (isLarge) {
            review.push({ ...tx, suggestedCategory: result.category, confidence,
                reason: 'unusually large for this batch — confirm before filing' });
        } else if (Number.isFinite(confidence) && confidence >= threshold) {
            applied.push({ ...tx, category: result.category, categorySource: 'ai', categoryConfidence: confidence });
        } else {
            review.push({ ...tx, suggestedCategory: result.category, confidence: Number.isFinite(confidence) ? confidence : null,
                reason: 'not confident enough to file automatically' });
        }
    }
    return { applied, review, unanswered, largeThreshold };
}

/** A short, honest summary for the UI. */
export function summarizeRun({ ruleMatched = 0, applied = 0, review = 0, unanswered = 0, skipped = {} } = {}) {
    return {
        ruleMatched, applied, review, unanswered,
        skippedTransfer: skipped.transfer || 0,
        skippedIncome: skipped.income || 0,
        total: ruleMatched + applied + review + unanswered
    };
}

export const __testing = { median, DEFAULT_CONFIDENCE, LARGE_MULTIPLE, DEFAULT_BATCH };

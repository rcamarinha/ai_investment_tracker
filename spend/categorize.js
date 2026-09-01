/**
 * spend/categorize.js — run categorisation and let a human settle the rest.
 *
 * Order matters and each stage exists to shrink the next:
 *
 *   1. Rules       free, instant, local. On real data one learned rule
 *                  categorised 140 of 971 rows.
 *   2. Structure   transfers are paired deterministically; income already
 *                  matching a category is settled. Neither costs a token.
 *   3. AI          the long tail only. On real data 61% of distinct merchants
 *                  appear exactly once, but they are just 16% of rows.
 *
 * Nothing here files a category the user cannot see and undo.
 */

import state from './state.js?v=3.42.1';
import { escapeHTML, showToast, fmtMoney } from './utils.js?v=3.42.1';
import { saveTransactions, saveRule, incomeCategoryNames, requireAuth } from './storage.js?v=3.42.1';
import { applyRules, ruleFromCorrection } from '../services/import-banks.js';
import { partitionForAi, batchTransactions, toPrompt, applyAiResults, summarizeRun }
    from '../services/categorize-core.js';
import { reportHandled } from '../services/telemetry.js';

const BATCH_SIZE = 40;
const REQUEST_TIMEOUT_MS = 55000;

async function freshToken() {
    const { data } = await state.supabaseClient.auth.getSession();
    const session = data?.session;
    if (!session) throw new Error('Not signed in.');
    const expiresIn = (session.expires_at || 0) * 1000 - Date.now();
    if (expiresIn < 60000) {
        const { data: refreshed } = await state.supabaseClient.auth.refreshSession();
        return refreshed?.session?.access_token || session.access_token;
    }
    return session.access_token;
}

async function callCategoriser(transactions, categories) {
    const token = await freshToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${state.supabaseUrl}/functions/v1/categorize-transactions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: state.supabaseAnonKey,
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ transactions, categories }),
            signal: controller.signal
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || `Categorisation failed (${res.status})`);
        return payload;
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error('The categorisation service timed out.');
        if (err instanceof TypeError) {
            throw new Error('Could not reach the categorisation service. It may not be deployed yet ' +
                '(run: supabase functions deploy categorize-transactions).');
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Categorise everything that has no category.
 * `onProgress(done, total)` reports batch progress — several hundred rows is
 * more than one request and silence reads as a hang.
 */
export async function categoriseAll({ onProgress } = {}) {
    if (!requireAuth('categorise transactions')) return null;

    const categories = state.categories.map(c => c.name);
    if (!categories.length) { showToast('No categories to choose from yet.', 'warning'); return null; }

    // 1. rules — free, and they get better every time the user corrects one
    const ruled = applyRules(state.transactions, state.rules);
    const ruleMatched = ruled.matched;

    // 2. structure
    const { toSend, skipped } = partitionForAi(ruled.rows, { incomeCategories: incomeCategoryNames() });

    if (!toSend.length) {
        const summary = summarizeRun({ ruleMatched, skipped });
        if (ruleMatched) await persist(ruled.rows.filter(r => r.categorySource === 'rule'));
        return { ...summary, applied: [], review: [] };
    }

    // 3. AI, in batches
    const batches = batchTransactions(toSend, BATCH_SIZE);
    const allApplied = [], allReview = [], allUnanswered = [];
    let failures = 0;

    for (let i = 0; i < batches.length; i++) {
        onProgress?.(i, batches.length);
        try {
            const payload = await callCategoriser(toPrompt(batches[i]), categories);
            const { applied, review, unanswered } = applyAiResults(batches[i], payload.results || [], {
                validCategories: categories
            });
            allApplied.push(...applied);
            allReview.push(...review);
            allUnanswered.push(...unanswered);
        } catch (err) {
            failures++;
            reportHandled(err, { action: 'categorise', status: i + 1 });
            allUnanswered.push(...batches[i]);
        }
    }
    onProgress?.(batches.length, batches.length);

    // Persist what rules and the model settled. Review rows are NOT written —
    // an unconfirmed suggestion must not enter the ledger, or the savings rate
    // starts resting on guesses nobody saw.
    const toPersist = [...ruled.rows.filter(r => r.categorySource === 'rule'), ...allApplied];
    if (toPersist.length) await persist(toPersist);

    state.reviewQueue = allReview;

    return {
        ...summarizeRun({ ruleMatched, applied: allApplied.length, review: allReview.length,
                          unanswered: allUnanswered.length, skipped }),
        applied: allApplied, review: allReview, failures, batches: batches.length
    };
}

async function persist(rows) {
    try {
        await saveTransactions(rows);
    } catch (err) {
        reportHandled(err, { action: 'categorise-save', rows: rows.length });
        showToast('Categories were worked out but could not be saved: ' + err.message, 'error', 7000);
    }
}

/**
 * Accept a suggestion for one row.
 * Also writes a rule, because a decision a human has confirmed is the only kind
 * worth generalising — an unreviewed model guess is not.
 */
export async function acceptSuggestion(id, { teachRule = true } = {}) {
    const row = (state.reviewQueue || []).find(r => r.id === id);
    if (!row?.suggestedCategory) return;
    const updated = { ...row, category: row.suggestedCategory, categorySource: 'manual' };
    delete updated.suggestedCategory;

    await persist([updated]);
    state.reviewQueue = state.reviewQueue.filter(r => r.id !== id);

    if (teachRule) {
        const rule = ruleFromCorrection(row, row.suggestedCategory);
        if (rule) { try { await saveRule(rule); } catch (err) { reportHandled(err, { action: 'teach-rule' }); } }
    }
}

/** Dismiss a suggestion without filing it. The row stays uncategorised. */
export function rejectSuggestion(id) {
    state.reviewQueue = (state.reviewQueue || []).filter(r => r.id !== id);
}

/** Accept every suggestion at or above the threshold in one go. */
export async function acceptAllConfident(threshold = 0.8) {
    const confident = (state.reviewQueue || []).filter(r => Number(r.confidence) >= threshold);
    for (const row of confident) await acceptSuggestion(row.id, { teachRule: false });
    return confident.length;
}

/**
 * Apply one row's category to every other transaction from the same merchant,
 * and remember it as a rule.
 */
export async function applyToMerchant(id, category) {
    const source = state.transactions.find(t => t.id === id) || (state.reviewQueue || []).find(r => r.id === id);
    if (!source || !category) return 0;

    const rule = ruleFromCorrection(source, category);
    if (!rule) { showToast('Nothing distinctive enough in that description to make a rule.', 'warning'); return 0; }

    const uncategorised = state.transactions.filter(t => !t.category);
    const { rows, matched } = applyRules(uncategorised, [rule]);
    if (matched) await persist(rows.filter(r => r.category));
    try { await saveRule(rule); } catch (err) { reportHandled(err, { action: 'teach-rule' }); }

    const done = new Set(rows.filter(r => r.category).map(r => r.id));
    state.reviewQueue = (state.reviewQueue || []).filter(r => !done.has(r.id));
    return matched;
}

export function reviewCount() { return (state.reviewQueue || []).length; }

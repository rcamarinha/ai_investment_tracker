/**
 * Valuation service — AI-powered wine bottle value estimation.
 *
 * Single bottle: Gemini (Google Search grounding) → Claude fallback via the edge function.
 *   Gemini retries up to 3× on 429 rate-limit before falling back to Claude.
 * Batch: one edge-function call with all bottles (requestType: 'batch-valuation');
 *        the server splits them into chunks of 5, runs each chunk as a parallel
 *        Gemini grounding call (→ Claude fallback per chunk if Gemini fails).
 *
 * Results are stored back on each bottle object and persisted to Supabase.
 * valueLow / valueHigh / valuationNote are kept in a localStorage cache
 * (not in the DB schema) and applied to in-memory bottle state on load.
 */

import state from './state.js?v=3.55.5';
import { callWineAI, bottleForAI } from './api.js?v=3.55.5';
import { saveBottleToDB, saveWinePriceHistory, logAssetMovement } from './storage.js?v=3.55.5';
import { renderCellar, updateBottleCard } from './cellar.js?v=3.55.5';
import { showToast, repairTruncatedJSON } from './utils.js?v=3.55.5';
import { reportHandled, reportDiagnostic } from '../services/telemetry.js';
import { triageBatchValuation } from '../src/wine.js';

// ── Auth Guard ────────────────────────────────────────────────────────────────

function requireAuth(actionName) {
    if (!state.supabaseClient) return true; // local-only mode
    if (state.currentUser) return true;
    showToast(`Please log in to ${actionName}.`, 'warning');
    return false;
}

// ── Navigation Guard (active while valuations are running) ────────────────────

function _beforeUnloadHandler(e) {
    e.preventDefault();
    // Modern browsers show their own generic message; this string is for legacy ones.
    e.returnValue = 'Valuation is still running. Leaving now will cancel it. Continue?';
    return e.returnValue;
}

/** Attach the beforeunload guard and intercept same-site navbar link clicks. */
export function attachValuationGuard() {
    window.addEventListener('beforeunload', _beforeUnloadHandler);
    // Mark body so wine.html's delegated click handler knows guard is active.
    document.body.dataset.valuationRunning = '1';
}

/** Remove the navigation guard (call when valuations finish or fail). */
export function detachValuationGuard() {
    window.removeEventListener('beforeunload', _beforeUnloadHandler);
    delete document.body.dataset.valuationRunning;
}

// ── Valuation Detail Cache (localStorage) ────────────────────────────────────

const VAL_CACHE_KEY = 'wine_val_details';

function loadValCache() {
    try { return JSON.parse(localStorage.getItem(VAL_CACHE_KEY) || '{}'); }
    catch { return {}; }
}

function persistValCache(bottleId, details) {
    const cache = loadValCache();
    cache[bottleId] = details;
    localStorage.setItem(VAL_CACHE_KEY, JSON.stringify(cache));
}

/**
 * Merge cached valuation details (range, note) into in-memory cellar state.
 * Call this after bottles are loaded from DB.
 */
export function applyValuationCache() {
    const cache = loadValCache();
    state.cellar.forEach(b => {
        if (b.id && cache[b.id]) {
            b.valueLow           = cache[b.id].valueLow;
            b.valueHigh          = cache[b.id].valueHigh;
            b.valuationNote      = cache[b.id].valuationNote;
            b.estimatedValueUSD  = cache[b.id].estimatedValueUSD  ?? null;
            b.confidence         = cache[b.id].confidence         ?? null;
            b.valuationSources   = cache[b.id].valuationSources   ?? null;
        }
    });
}

// ── Single Bottle Valuation ───────────────────────────────────────────────────

/**
 * Ask Gemini to estimate the current market value of a single bottle.
 * Updates the bottle in state and persists the new value to DB.
 */
export async function valuateSingleBottle(bottleId) {
    if (!requireAuth('valuate bottles')) return;
    const bottle = state.cellar.find(b => b.id === bottleId);
    if (!bottle) return;

    // Show loading state on the card
    const cardEl = document.getElementById(`bottle-${bottleId}`);
    if (cardEl) {
        const actionsEl = cardEl.querySelector('.bottle-actions');
        if (actionsEl) {
            actionsEl.innerHTML = '<span class="bottle-fin-muted" style="padding: 4px 6px;">Valuing...</span>';
        }
    }

    try {
        const result = await fetchValuation(bottle);
        console.log('[Valuation] Parsed result:', result);
        applyValuationResult(bottle, result, result._aiSource);
        await saveBottleToDB(bottle);
        await Promise.all([
            saveWinePriceHistory(bottle),
            logAssetMovement({
                assetType:    'wine',
                wineId:       bottle.wineId,
                movementType: 'valuation_update',
                price:        bottle.estimatedValue,
                totalValue:   (bottle.qty || 0) * (bottle.estimatedValue || 0),
                notes:        bottle.valuationNote || null,
            }),
        ]);
        updateBottleCard(bottleId);
        showToast(`Valuation updated: ${bottle.name}`);
    } catch (err) {
        console.error('Valuation error:', err);
        showToast(`Valuation failed: ${err.message}`, 'error');
        updateBottleCard(bottleId); // restore button state
    }
}

// ── Batch Valuation ───────────────────────────────────────────────────────────

/**
 * Valuate all bottles (or only unvalued ones) in a single batched request.
 * The edge function splits them into chunks of 5 and runs each chunk as one
 * parallel Gemini grounding call, so the total time is roughly one Gemini
 * round-trip instead of N sequential calls.
 */
export async function valuateAllBottles(forceAll = false) {
    if (!requireAuth('valuate bottles')) return;
    if (state.valuationsLoading) return;
    if (state.cellar.length === 0) {
        showToast('No bottles in cellar to valuate.', 'warning');
        return;
    }

    const toValueate = forceAll
        ? state.cellar
        : state.cellar.filter(b => !b.estimatedValue);

    if (toValueate.length === 0) {
        showToast('All bottles already have valuations. Use the 💎 button to refresh individual ones.', 'info');
        return;
    }

    state.valuationsLoading = true;
    attachValuationGuard();
    const btn = document.getElementById('valuateBtn');
    if (btn) { btn.disabled = true; btn.textContent = `💎 Sending ${toValueate.length} bottle(s) for valuation...`; }

    // One bottle per request. Measured on 21 September: one grounded valuation
    // takes ~20s and three searches, so a request for three wines needed nine or
    // more searches and often ran past Gemini's limit, failing all three
    // together. One bottle per request keeps each call short, lets a failure
    // cost one bottle rather than three, and needs no matching by position.
    const CLIENT_BATCH_SIZE = 1;

    try {
        const bottleInfos = toValueate.map(b => ({
            id:            b.id,
            name:          b.name,
            winery:        b.winery,
            vintage:       b.vintage,
            type:          b.type,
            region:        b.region,
            appellation:   b.appellation,
            varietal:      b.varietal,
            country:       b.country,
            purchasePrice: b.purchasePrice,
            notes:         b.notes,
            bottleSize:    b.bottleSize || '0.75L',
        }));

        const allResults = [];
        let batchesFailed = 0;
        const totalBatches = Math.ceil(bottleInfos.length / CLIENT_BATCH_SIZE);
        // A pool, not waves: a new request starts as soon as any one finishes, so
        // one slow bottle no longer holds up the next group. Three at a time
        // keeps within Gemini's per-minute limits for grounded requests.
        const VAL_CONCURRENCY = 3;
        let completedBatches = 0;
        let nextBatch = 0;
        const worker = async () => {
            while (nextBatch < totalBatches) {
                const batchIdx   = nextBatch++;
                const batchStart = batchIdx * CLIENT_BATCH_SIZE;
                const batchSlice = bottleInfos.slice(batchStart, batchStart + CLIENT_BATCH_SIZE);
                const batchNum   = batchIdx + 1;
                console.log(`[Valuation] Client batch ${batchNum}/${totalBatches}: ${batchSlice.length} bottles`);
                try {
                    const data = await callWineAI({ requestType: 'batch-valuation', bottles: batchSlice });
                    if (!data.results || !Array.isArray(data.results)) {
                        throw new Error(`Unexpected response from batch valuation endpoint (batch ${batchNum}).`);
                    }
                    allResults.push(...data.results);
                } catch (err) {
                    // One bad batch must not abort the rest. Its bottles stay
                    // unvalued, and the triage below counts them as missing.
                    batchesFailed++;
                    console.warn(`[Valuation] Batch ${batchNum} failed:`, err.message);
                    reportHandled(err, { action: 'wine-batch-valuation', chunks: totalBatches });
                } finally {
                    completedBatches++;
                    if (btn) btn.textContent = `\uD83D\uDC8E Valuing\u2026 ${completedBatches}/${totalBatches}`;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(VAL_CONCURRENCY, totalBatches) }, worker));
        if (allResults.length === 0) {
            throw new Error('All valuation batches failed. Check your connection and try again.');
        }

        if (btn) btn.textContent = `💎 Saving results...`;

        // Decide what to do with every result BEFORE anything is written — see
        // triageBatchValuation in src/wine.js. This used to apply whatever came
        // back: a missing or non-numeric price was written to the bottle, a
        // bottle the model never returned was counted as valued, and no value was
        // compared with the last one. The figure reaches net worth on the hub.
        const { apply, errors, missing, heldBack } = triageBatchValuation(toValueate, allResults);
        let saveFailures = 0;
        const savePromises = apply.map(({ bottle, result }) => {
            applyValuationResult(bottle, result);
            return saveBottleToDB(bottle).then(() =>
                Promise.all([
                    saveWinePriceHistory(bottle),
                    logAssetMovement({
                        assetType:    'wine',
                        wineId:       bottle.wineId,
                        movementType: 'valuation_update',
                        price:        bottle.estimatedValue,
                        totalValue:   (bottle.qty || 0) * (bottle.estimatedValue || 0),
                        notes:        bottle.valuationNote || null,
                    }),
                ])
            ).catch(err => {
                saveFailures++;
                errors.push(`${bottle.name}: could not be saved`);
                reportHandled(err, { action: 'wine-valuation-save' });
            });
        });

        await Promise.all(savePromises);

        const done = apply.length - saveFailures;
        renderCellar();

        // How it went, whether or not anything threw. A valuation's correctness
        // cannot be checked as it runs, so these counts are the only record.
        reportDiagnostic('wine-valuation', {
            rows: toValueate.length,
            parsed: done,
            skipped: missing.length,
            flagged: heldBack.length,
            chunks: totalBatches,
            chunksFailed: batchesFailed,
        });

        const parts = [`Valued ${done} bottle${done !== 1 ? 's' : ''}`];
        if (errors.length)   parts.push(`${errors.length} failed`);
        if (missing.length)  parts.push(`${missing.length} got no answer and are still unvalued`);
        if (heldBack.length) parts.push(`${heldBack.length} held back because the price changed sharply. Value ${heldBack.length === 1 ? 'it' : 'them'} one at a time with 💎 to confirm`);
        const allGood = !errors.length && !missing.length && !heldBack.length;
        showToast(parts.join('. ') + '.', allGood ? 'success' : 'warning', allGood ? 4000 : 9000);
    } catch (err) {
        console.error('[Valuation] Batch error:', err);
        reportHandled(err, { action: 'wine-batch-valuation' });
        showToast(`Batch valuation failed: ${err.message}`, 'error');
    } finally {
        state.valuationsLoading = false;
        detachValuationGuard();
        if (btn) { btn.disabled = false; btn.textContent = '💎 Update Valuations'; }
        renderCellar();
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function applyValuationResult(bottle, result, aiSource = 'gemini_ai') {
    bottle.estimatedValue    = result.estimatedValue;
    bottle.estimatedValueUSD = result.estimatedValueUSD ?? null;
    bottle.drinkWindow       = result.drinkWindow       || bottle.drinkWindow;
    bottle.valueLow          = result.valueLow          ?? null;
    bottle.valueHigh         = result.valueHigh         ?? null;
    bottle.valuationNote     = result.valuationNote     ?? null;
    bottle.confidence        = result.confidence        ?? null;
    bottle.valuationSources  = result.sources           ?? null;
    bottle.lastValuedAt      = new Date().toISOString();
    bottle._aiSource         = aiSource;

    if (bottle.id) {
        persistValCache(bottle.id, {
            valueLow:         result.valueLow,
            valueHigh:        result.valueHigh,
            valuationNote:    result.valuationNote,
            estimatedValueUSD: result.estimatedValueUSD ?? null,
            confidence:       result.confidence ?? null,
            valuationSources: result.sources    ?? null,
        });
    }
}

// ── Single-bottle Gemini→Claude API call ──────────────────────────────────────

async function fetchValuation(bottle) {
    // The server builds the prompt from the bottle (_shared/wine-prompts.js)
    // and returns { text, _geminiGrounding } for valuation requests.
    const data = await callWineAI({ requestType: 'valuation', bottle: bottleForAI(bottle) });

    // Debug: surface Gemini fallback so it's visible in the UI until Gemini is stable.
    if (data._fallback === 'claude' && data._geminiError) {
        const snippet = data._geminiError.slice(0, 120);
        console.warn('[Valuation] Gemini failed, used Claude fallback. Gemini error:', data._geminiError);
        showToast(`[Debug] Gemini failed → Claude used. ${snippet}`, 'warning', 10000);
    }

    const text = (data.text ?? '').replace(/```json\s*|```/gi, '').trim();

    if (!text) {
        console.error('[Valuation] No text in Gemini response:', JSON.stringify(data).slice(0, 300));
        throw new Error('No text in Gemini valuation response.');
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        console.error('[Valuation] No JSON in Gemini text:', text.slice(0, 300));
        throw new Error('Could not parse valuation response from Gemini.');
    }

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.estimatedValue || isNaN(parsed.estimatedValue)) {
            throw new Error('Invalid valuation response — estimatedValue missing or NaN');
        }
        parsed._aiSource = data._fallback === 'claude' ? 'claude_ai' : 'gemini_ai';
        return parsed;
    } catch {
        const repaired = repairTruncatedJSON(jsonMatch[0]);
        try {
            const parsed = JSON.parse(repaired);
            if (!parsed.estimatedValue || isNaN(parsed.estimatedValue)) {
                throw new Error('Invalid valuation response — estimatedValue missing or NaN');
            }
            parsed._aiSource = data._fallback === 'claude' ? 'claude_ai' : 'gemini_ai';
            return parsed;
        } catch {
            throw new Error('Could not parse valuation JSON from Gemini.');
        }
    }
}


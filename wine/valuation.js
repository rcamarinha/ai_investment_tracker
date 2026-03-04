/**
 * Valuation service — AI-powered wine bottle value estimation.
 *
 * Single bottle: Gemini (Google Search grounding) → Claude fallback via the edge function.
 *   Gemini retries up to 3× on 429 rate-limit before falling back to Claude.
 * Batch: one edge-function call with all bottles (requestType: 'batch-valuation');
 *        the server sends all bottles in a single Gemini request → Claude fallback.
 *
 * Results are stored back on each bottle object and persisted to Supabase.
 * valueLow / valueHigh / valuationNote are kept in a localStorage cache
 * (not in the DB schema) and applied to in-memory bottle state on load.
 */

import state from './state.js';
import { callWineAI } from './api.js?v=1.3.16';
import { saveBottleToDB, saveWinePriceHistory, logAssetMovement } from './storage.js';
import { renderCellar } from './cellar.js';
import { showToast } from './utils.js';

// ── Auth Guard ────────────────────────────────────────────────────────────────

function requireAuth(actionName) {
    if (!state.supabaseClient) return true; // local-only mode
    if (state.currentUser) return true;
    showToast(`Please log in to ${actionName}.`, 'warning');
    return false;
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
            actionsEl.innerHTML = '<span style="color: #94a3b8; font-size: 12px; padding: 4px 6px;">Valuing...</span>';
        }
    }

    try {
        const result = await fetchValuation(bottle);
        console.log('[Valuation] Parsed result:', result);
        applyValuationResult(bottle, result);
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
        renderCellar();
        showToast(`Valuation updated: ${bottle.name}`);
    } catch (err) {
        console.error('Valuation error:', err);
        showToast(`Valuation failed: ${err.message}`, 'error');
        renderCellar(); // restore button state
    }
}

// ── Batch Valuation ───────────────────────────────────────────────────────────

/**
 * Valuate all bottles (or only unvalued ones) in a single batched request.
 * The edge function chunks them into groups of 8 and runs each chunk as one
 * Gemini call in parallel, so the total time is roughly one Gemini round-trip
 * instead of N sequential calls.
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
    const btn = document.getElementById('valuateBtn');
    if (btn) { btn.disabled = true; btn.textContent = `💎 Sending ${toValueate.length} bottle(s) for valuation...`; }

    try {
        // Send all bottles to the edge function in one request.
        // The server handles chunking and parallel Gemini calls internally.
        const bottleInfos = toValueate.map(b => ({
            id:            b.id,
            name:          b.name,
            winery:        b.winery,
            vintage:       b.vintage,
            region:        b.region,
            appellation:   b.appellation,
            varietal:      b.varietal,
            country:       b.country,
            purchasePrice: b.purchasePrice,
            notes:         b.notes,
        }));

        if (btn) btn.textContent = `💎 Valuing ${toValueate.length} bottle(s) via Gemini...`;

        const data = await callWineAI({ requestType: 'batch-valuation', bottles: bottleInfos });

        if (!data.results || !Array.isArray(data.results)) {
            throw new Error('Unexpected response from batch valuation endpoint.');
        }

        if (btn) btn.textContent = `💎 Saving results...`;

        // Apply results and persist — run DB saves in parallel
        const errors = [];
        const savePromises = [];

        data.results.forEach((result, idx) => {
            const bottle = toValueate[idx];
            if (!bottle) return;

            if (result.error) {
                errors.push(`${bottle.name || bottle.id}: ${result.error}`);
                console.warn('[Valuation] Batch item failed:', bottle.name, result.error);
                return;
            }

            applyValuationResult(bottle, result);

            savePromises.push(
                saveBottleToDB(bottle).then(() =>
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
                    console.warn('[Valuation] DB save failed for', bottle.name, err);
                    errors.push(`${bottle.name}: DB save failed`);
                })
            );
        });

        await Promise.all(savePromises);

        const done = toValueate.length - errors.length;
        renderCellar();

        if (errors.length > 0) {
            showToast(`Valuations done: ${done} succeeded, ${errors.length} failed. Check console.`, 'warning', 6000);
        } else {
            showToast(`Valued ${done} bottle${done !== 1 ? 's' : ''} successfully.`);
        }
    } catch (err) {
        console.error('[Valuation] Batch error:', err);
        showToast(`Batch valuation failed: ${err.message}`, 'error');
    } finally {
        state.valuationsLoading = false;
        if (btn) { btn.disabled = false; btn.textContent = '💎 Update Valuations'; }
        renderCellar();
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function applyValuationResult(bottle, result) {
    bottle.estimatedValue    = result.estimatedValue;
    bottle.estimatedValueUSD = result.estimatedValueUSD ?? null;
    bottle.drinkWindow       = result.drinkWindow       || bottle.drinkWindow;
    bottle.valueLow          = result.valueLow          ?? null;
    bottle.valueHigh         = result.valueHigh         ?? null;
    bottle.valuationNote     = result.valuationNote     ?? null;
    bottle.confidence        = result.confidence        ?? null;
    bottle.valuationSources  = result.sources           ?? null;
    bottle.lastValuedAt      = new Date().toISOString();

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

// ── Single-bottle Claude→Gemini API call ──────────────────────────────────────

async function fetchValuation(bottle) {
    const prompt = buildValuationPrompt(bottle);

    // The edge function returns { text, _geminiGrounding } for valuation requests.
    const data = await callWineAI({
        requestType: 'valuation',
        prompt,
        maxTokens: 4096,
    });

    // Debug: surface Gemini fallback so it's visible in the UI until Gemini is stable.
    if (data._fallback === 'claude' && data._geminiError) {
        const snippet = data._geminiError.slice(0, 120);
        console.warn('[Valuation] Gemini failed, used Claude fallback. Gemini error:', data._geminiError);
        showToast(`[Debug] Gemini failed → Claude used. ${snippet}`, 'warning', 10000);
    }

    const text = data.text ?? '';

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
        return parsed;
    } catch {
        throw new Error('Could not parse valuation JSON from Gemini.');
    }
}

function buildValuationPrompt(bottle) {
    const criticMatch = bottle.notes
        ? bottle.notes.match(/(\d{2,3})\s*(?:\/\s*100|points?)/i)
        : null;
    const criticLine = criticMatch ? `Critic score: ${criticMatch[1]}/100` : '';

    const details = [
        bottle.name        && `Wine name: ${bottle.name}`,
        bottle.winery      && `Winery/Producer: ${bottle.winery}`,
        bottle.vintage     && `Vintage: ${bottle.vintage}`,
        bottle.region      && `Region: ${bottle.region}`,
        bottle.appellation && `Appellation: ${bottle.appellation}`,
        bottle.varietal    && `Grape variety: ${bottle.varietal}`,
        bottle.country     && `Country: ${bottle.country}`,
        criticLine,
        bottle.purchasePrice && `Purchase price: €${bottle.purchasePrice}/bottle`,
        bottle.purchaseDate  && `Purchase date: ${bottle.purchaseDate}`,
        bottle.notes       && `Label notes: ${bottle.notes}`,
    ].filter(Boolean).join('\n');

    const vintageInstruction = bottle.vintage
        ? `IMPORTANT: Price specifically for the ${bottle.vintage} vintage — do NOT average across years or use a generic producer price.`
        : '';

    return `You are a wine investment expert with deep knowledge of fine wine valuations.
Use Google Search to find current retail and auction market prices for this specific wine bottle.
Search Wine-Searcher, recent auction results (Sotheby's, Christie's, Acker, Zachys, Hart Davis Hart), and retailer listings.

Wine details:
${details}

Today's date: ${new Date().toISOString().slice(0, 10)}
${vintageInstruction}

Return a valid JSON object with exactly these fields:
{
  "estimatedValue": 105.00,
  "estimatedValueUSD": 113.00,
  "valueLow": 90.00,
  "valueHigh": 125.00,
  "drinkWindow": "2025-2035",
  "confidence": "high",
  "sources": "Wine-Searcher avg €105 for 2019 vintage; Garrafeira Nacional listing €115",
  "valuationNote": "1-2 sentence explanation referencing specific data points found"
}

Guidelines:
- estimatedValue: best estimate per 750ml bottle in EUR
- estimatedValueUSD: same estimate converted to USD at current exchange rate
- valueLow / valueHigh: realistic market range in EUR
- confidence: "high" if you found direct price data, "medium" if using comparables, "low" if largely estimated
- sources: brief citation of specific sources, retailers, or auction results used (max 1-2 lines)
- valuationNote: 1-2 sentences explaining the estimate with reference to what was found
- drinkWindow: optimal drinking window as "YYYY-YYYY" string, or null if unknown
- Be vintage-specific and conservative — cite real data points where possible

Return ONLY the JSON object. No markdown fences, no preamble.`;
}

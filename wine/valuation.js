/**
 * Valuation service — AI-powered wine bottle value estimation via Claude API.
 *
 * Sends wine details to Claude and asks for current market value estimate.
 * Results are stored back on each bottle object and persisted to Supabase.
 * valueLow / valueHigh / valuationNote are kept in a localStorage cache
 * (not in the DB schema) and applied to in-memory bottle state on load.
 */

import state from './state.js';
import { callWineAI } from './api.js';
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
// valueLow/valueHigh/valuationNote are now persisted in user_wines (DB) AND
// loaded directly by loadBottles() via the JOIN. The localStorage cache below
// is kept as a fast warm-load path so the UI shows ranges immediately on page
// load before the DB round-trip completes.

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
 * Ask Claude to estimate the current market value of a single bottle.
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
        applyValuationResult(bottle, result);

        await saveBottleToDB(bottle);
        // Log price history and valuation movement (non-critical, run in parallel)
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

/**
 * Valuate all bottles that don't yet have an estimated value.
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
    if (btn) { btn.disabled = true; btn.textContent = `💎 Valuing 0/${toValueate.length}...`; }

    let done = 0;
    const errors = [];

    for (const bottle of toValueate) {
        try {
            const result = await fetchValuation(bottle);
            applyValuationResult(bottle, result);
            await saveBottleToDB(bottle);
            // Log price history and valuation movement (non-critical)
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
            done++;
            if (btn) btn.textContent = `💎 Valuing ${done}/${toValueate.length}...`;
        } catch (err) {
            errors.push(`${bottle.name}: ${err.message}`);
            console.warn('Valuation failed for', bottle.name, err);
        }
        // Small delay to avoid hammering the API
        if (done < toValueate.length) await sleep(500);
    }

    state.valuationsLoading = false;
    if (btn) { btn.disabled = false; btn.textContent = '💎 Update Valuations'; }

    renderCellar();

    if (errors.length > 0) {
        showToast(`Valuations done with ${errors.length} error(s). Check console for details.`, 'warning', 6000);
    } else {
        showToast(`Valuated ${done} bottle${done !== 1 ? 's' : ''} successfully.`);
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
            valueLow:        result.valueLow,
            valueHigh:       result.valueHigh,
            valuationNote:   result.valuationNote,
            estimatedValueUSD: result.estimatedValueUSD ?? null,
            confidence:      result.confidence ?? null,
            valuationSources: result.sources   ?? null,
        });
    }
}

// ── Claude API Call ───────────────────────────────────────────────────────────

async function fetchValuation(bottle) {
    const prompt = buildValuationPrompt(bottle);

    const data = await callWineAI({
        requestType: 'valuation',
        prompt,
        maxTokens: 1024,
        enableWebSearch: true,
    });

    // Use the last text block — web search responses may contain tool_use/tool_result
    // blocks before Claude's final synthesised answer.
    const textBlocks = (data.content || []).filter(c => c.type === 'text');
    const text = textBlocks[textBlocks.length - 1]?.text || '';

    // Extract the first JSON object from the response (handles surrounding prose)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse valuation response from Claude.');

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.estimatedValue || isNaN(parsed.estimatedValue)) {
            throw new Error('Invalid valuation response');
        }
        return parsed;
    } catch {
        throw new Error('Could not parse valuation response from Claude.');
    }
}

function buildValuationPrompt(bottle) {
    // Extract critic score from notes if present (e.g. "96/100", "94 points")
    const criticMatch = bottle.notes
        ? bottle.notes.match(/(\d{2,3})\s*(?:\/\s*100|points?)/i)
        : null;
    const criticLine = criticMatch
        ? `Critic score: ${criticMatch[1]}/100`
        : '';

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
Search for and estimate the current retail market value of the following wine bottle.
Use Wine-Searcher, recent auction results (Sotheby's, Christie's, Acker, Zachys, Hart Davis Hart), and retailer listings to ground your estimate.

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
- If this is a well-known fine wine, search for current listings before estimating

Return ONLY the JSON object. No markdown fences, no preamble.`;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

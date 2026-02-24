/**
 * Valuation service — AI-powered wine bottle value estimation via Claude API.
 *
 * Sends wine details to Claude and asks for current market value estimate.
 * Results are stored back on each bottle object and persisted to Supabase.
 */

import state from './state.js';
import { callWineAI } from './api.js';
import { saveBottleToDB } from './storage.js';
import { renderCellar } from './cellar.js';

// ── Auth Guard ───────────────────────────────────────────────────────────────

function requireAuth(actionName) {
    if (!state.supabaseClient) return true; // local-only mode
    if (state.currentUser) return true;
    alert(`🔒 Please log in to ${actionName}.\n\nSign in with your email or Google account above.`);
    return false;
}

// ── Single Bottle Valuation ──────────────────────────────────────────────────

/**
 * Ask Claude to estimate the current market value of a single bottle.
 * Updates the bottle in state and persists the new value to DB.
 * @param {string} bottleId
 */
export async function valuateSingleBottle(bottleId) {
    if (!requireAuth('valuate bottles')) return;
    const bottle = state.cellar.find(b => b.id === bottleId);
    if (!bottle) return;

    // Briefly show loading state on the card
    const cardEl = document.getElementById(`bottle-${bottleId}`);
    if (cardEl) {
        const actionsEl = cardEl.querySelector('.bottle-actions');
        if (actionsEl) {
            actionsEl.innerHTML = '<span style="color: #94a3b8; font-size: 12px;">Valuing...</span>';
        }
    }

    try {
        const result = await fetchValuation(bottle);
        bottle.estimatedValue = result.estimatedValue;
        bottle.drinkWindow    = result.drinkWindow || bottle.drinkWindow;
        bottle.lastValuedAt   = new Date().toISOString();

        await saveBottleToDB(bottle);
        renderCellar();
    } catch (err) {
        console.error('Valuation error:', err);
        alert(`Valuation failed: ${err.message}`);
        renderCellar(); // re-render to restore button state
    }
}

/**
 * Valuate all bottles that don't yet have an estimated value (or force-refresh all).
 * @param {boolean} forceAll - If true, re-valuate even already-valued bottles
 */
export async function valuateAllBottles(forceAll = false) {
    if (!requireAuth('valuate bottles')) return;
    if (state.valuationsLoading) return;
    if (state.cellar.length === 0) {
        alert('No bottles in cellar to valuate.');
        return;
    }

    const toValueate = forceAll
        ? state.cellar
        : state.cellar.filter(b => !b.estimatedValue);

    if (toValueate.length === 0) {
        alert('All bottles already have valuations.\nUse the 💎 button on individual bottles to refresh them.');
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
            bottle.estimatedValue = result.estimatedValue;
            bottle.drinkWindow    = result.drinkWindow || bottle.drinkWindow;
            bottle.lastValuedAt   = new Date().toISOString();
            await saveBottleToDB(bottle);
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
        alert(`Valuations complete with ${errors.length} error(s):\n\n${errors.join('\n')}`);
    } else {
        alert(`✓ Valuated ${done} bottle${done !== 1 ? 's' : ''} successfully.`);
    }
}

// ── Claude API Call ──────────────────────────────────────────────────────────

async function fetchValuation(bottle) {
    const prompt = buildValuationPrompt(bottle);

    const data = await callWineAI({ requestType: 'valuation', prompt, maxTokens: 512 });
    const text = data.content?.find(c => c.type === 'text')?.text || '';
    const cleanText = text.replace(/```json\n?|```/g, '').trim();

    try {
        const parsed = JSON.parse(cleanText);
        if (!parsed.estimatedValue || isNaN(parsed.estimatedValue)) {
            throw new Error('Invalid valuation response');
        }
        return parsed;
    } catch {
        throw new Error('Could not parse valuation response from Claude.');
    }
}

function buildValuationPrompt(bottle) {
    const details = [
        bottle.name     && `Wine name: ${bottle.name}`,
        bottle.winery   && `Winery/Producer: ${bottle.winery}`,
        bottle.vintage  && `Vintage: ${bottle.vintage}`,
        bottle.region   && `Region: ${bottle.region}`,
        bottle.appellation && `Appellation: ${bottle.appellation}`,
        bottle.varietal && `Grape variety: ${bottle.varietal}`,
        bottle.country  && `Country: ${bottle.country}`,
        bottle.purchasePrice && `Purchase price: €${bottle.purchasePrice}/bottle`,
        bottle.purchaseDate  && `Purchase date: ${bottle.purchaseDate}`,
        bottle.notes    && `Label notes: ${bottle.notes}`,
    ].filter(Boolean).join('\n');

    return `You are a wine investment expert with deep knowledge of fine wine valuations.
Estimate the current market value of the following wine bottle based on your knowledge of wine markets, auction results, and collector demand.

Wine details:
${details}

Today's date: ${new Date().toISOString().slice(0, 10)}

Return ONLY a valid JSON object with exactly these fields:
{
  "estimatedValue": 150.00,
  "valueLow": 120.00,
  "valueHigh": 180.00,
  "drinkWindow": "2025-2035",
  "valuationNote": "1-2 sentence explanation of the estimate"
}

Guidelines:
- estimatedValue: single best estimate per bottle in EUR
- valueLow / valueHigh: realistic range
- drinkWindow: optimal drinking window as "YYYY-YYYY" string, or null if unknown
- Be conservative and realistic — use auction comps and market knowledge
- For unknown or obscure wines, base on similar quality wines from the same region/vintage

Return ONLY the JSON. No markdown, no preamble.`;
}

// ── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

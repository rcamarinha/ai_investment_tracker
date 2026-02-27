/**
 * Analysis service — AI-powered cellar analysis and insights via Claude API.
 */

import state from './state.js';
import { callWineAI } from './api.js?v=1.3.4';
import { computeTotals } from './cellar.js';
import { showToast, escapeHTML } from './utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Attempt to repair JSON truncated at max_tokens by closing unclosed
 * strings, arrays, and objects. Not perfect, but handles the common case
 * of a response cut off mid-string or mid-object.
 */
function repairTruncatedJSON(str) {
    const opens = [];
    let inString = false;
    let escape = false;

    for (const ch of str) {
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (!inString) {
            if (ch === '{' || ch === '[') opens.push(ch);
            else if (ch === '}' || ch === ']') opens.pop();
        }
    }

    let repaired = str;
    // Close an unterminated string value
    if (inString) repaired += '"';
    // Close unclosed arrays/objects in reverse order
    for (let i = opens.length - 1; i >= 0; i--) {
        repaired += opens[i] === '{' ? '}' : ']';
    }
    return repaired;
}

function fmt(value) {
    if (value == null || isNaN(value)) return '—';
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(value);
}

function requireAuth(actionName) {
    if (!state.supabaseClient) return true; // local-only mode
    if (state.currentUser) return true;
    showToast(`Please log in to ${actionName}.`, 'warning');
    return false;
}

// ── Cellar Analysis ──────────────────────────────────────────────────────────

export async function analyzeCellar() {
    if (!requireAuth('use AI analysis')) return;
    if (state.cellar.length === 0) {
        showToast('Add some bottles before running analysis.', 'warning');
        return;
    }

    const analyzeBtn = document.getElementById('analyzeBtn');
    const analysisSection = document.getElementById('analysisSection');

    if (analyzeBtn) { analyzeBtn.disabled = true; analyzeBtn.textContent = 'Analyzing...'; }
    analysisSection.innerHTML = `
        <div class="card" style="background: #1e1b4b; border-color: #3730a3;">
            <div style="display: flex; align-items: center; gap: 10px; color: #a5b4fc; padding: 10px 0;">
                <div class="spinner"></div>
                Analyzing your cellar with Claude...
            </div>
        </div>`;

    try {
        const prompt = buildAnalysisPrompt();

        const data = await callWineAI({ requestType: 'analysis', prompt, maxTokens: 3500 });
        const text = data.content?.find(c => c.type === 'text')?.text || '';
        const cleanText = text.replace(/```json\n?|```/g, '').trim();
        let analysis;
        try {
            analysis = JSON.parse(cleanText);
        } catch {
            // Response may have been truncated at max_tokens — attempt structural repair
            const repaired = repairTruncatedJSON(cleanText);
            try {
                analysis = JSON.parse(repaired);
                console.warn('[WineAI] JSON was truncated and repaired — response may be incomplete');
            } catch {
                throw new Error('Could not parse AI response as JSON (response may have been cut off). Raw: ' + cleanText.slice(0, 200));
            }
        }

        renderAnalysis(analysis);
        // Auto-scroll to results
        setTimeout(() => analysisSection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    } catch (err) {
        console.error('=== WINE ANALYSIS ERROR ===', err);
        showToast('Analysis failed: ' + err.message, 'error', 6000);
        analysisSection.innerHTML = `
            <div class="card">
                <div style="color: #f87171; font-size: 14px;">❌ Analysis failed: ${escapeHTML(err.message)}</div>
            </div>`;
    } finally {
        if (analyzeBtn) { analyzeBtn.disabled = false; analyzeBtn.textContent = '🤖 AI Analysis'; }
    }
}

// ── Render Analysis ──────────────────────────────────────────────────────────

function renderAnalysis(analysis) {
    const analysisSection = document.getElementById('analysisSection');

    const recommendations = (analysis.recommendations || []).map(r =>
        `<li>${escapeHTML(r)}</li>`).join('');

    const highlights = (analysis.highlights || []).map(h =>
        `<li>${escapeHTML(h)}</li>`).join('');

    const drinkNow = (analysis.drinkNow || []).map(d =>
        `<li><strong style="color: #fda4af;">${escapeHTML(d.wine)}</strong> — ${escapeHTML(d.reason)}</li>`).join('');

    const hold = (analysis.holdBottles || []).map(h =>
        `<li><strong style="color: #d97706;">${escapeHTML(h.wine)}</strong> — ${escapeHTML(h.reason)}</li>`).join('');

    analysisSection.innerHTML = `
        <div class="card" style="background: #1e1b4b; border-color: #3730a3;">
            <h2 style="color: #a5b4fc; margin-bottom: 20px;">🤖 AI Cellar Analysis</h2>

            <div class="wine-analysis-card">
                <div class="wine-analysis-title">📊 Cellar Overview</div>
                <div class="wine-analysis-body">${escapeHTML(analysis.overview || '')}</div>
            </div>

            ${analysis.diversification ? `
            <div class="wine-analysis-card">
                <div class="wine-analysis-title">🌍 Diversification</div>
                <div class="wine-analysis-body">${escapeHTML(analysis.diversification)}</div>
            </div>` : ''}

            ${highlights ? `
            <div class="wine-analysis-card">
                <div class="wine-analysis-title">⭐ Cellar Highlights</div>
                <ul class="wine-analysis-list">${highlights}</ul>
            </div>` : ''}

            ${drinkNow ? `
            <div class="wine-analysis-card" style="border-color: #9f1239;">
                <div class="wine-analysis-title" style="color: #fda4af;">🍷 Drink Now or Soon</div>
                <ul class="wine-analysis-list">${drinkNow}</ul>
            </div>` : ''}

            ${hold ? `
            <div class="wine-analysis-card" style="border-color: #d97706;">
                <div class="wine-analysis-title" style="color: #d97706;">⏳ Hold for Maximum Value</div>
                <ul class="wine-analysis-list">${hold}</ul>
            </div>` : ''}

            ${recommendations ? `
            <div class="wine-analysis-card">
                <div class="wine-analysis-title">💡 Recommendations</div>
                <ul class="wine-analysis-list">${recommendations}</ul>
            </div>` : ''}

            <div style="margin-top: 15px; padding: 12px; background: #0f172a; border-radius: 8px; font-size: 12px; color: #64748b; line-height: 1.6;">
                <strong>Disclaimer:</strong> This analysis is generated by AI for educational and informational purposes only.
                Wine valuations and market predictions are approximate. Consult a specialist before making investment decisions.
            </div>
        </div>`;
}

// ── Prompt Builder ───────────────────────────────────────────────────────────

function buildAnalysisPrompt() {
    const totals = computeTotals();

    const cellarSummary = state.cellar.map(b => {
        const invested  = (b.qty || 0) * (b.purchasePrice || 0);
        const estimated = b.estimatedValue ? (b.qty || 0) * b.estimatedValue : null;
        const parts = [
            `${b.qty}x ${b.name || 'Unknown'}`,
            b.vintage  && `(${b.vintage})`,
            b.winery   && `by ${b.winery}`,
            b.region   && `from ${b.region}`,
            b.varietal && `[${b.varietal}]`,
            `cost €${(b.purchasePrice || 0).toFixed(0)}/bottle`,
            estimated  && `est. €${(b.estimatedValue || 0).toFixed(0)}/bottle`,
            b.drinkWindow && `drink: ${b.drinkWindow}`,
        ].filter(Boolean).join(' ');
        return `• ${parts}`;
    }).join('\n');

    return `You are a master sommelier and fine wine investment advisor. Analyze the following wine cellar and provide comprehensive insights.

Cellar summary:
- Total bottles: ${totals.totalBottles}
- Total invested: €${totals.totalInvested.toFixed(2)}
- Estimated total value: €${totals.totalEstimated.toFixed(2)}
- Gain/Loss: €${(totals.totalEstimated - totals.totalInvested).toFixed(2)}

Individual bottles:
${cellarSummary}

Today's date: ${new Date().toISOString().slice(0, 10)}

Analyze this cellar and provide:
1. An overview of the collection quality and investment potential
2. Diversification assessment (regions, varietals, vintages)
3. Top highlights / most valuable bottles
4. Which bottles to drink now or soon (before they peak)
5. Which bottles to hold for maximum appreciation
6. Actionable recommendations for improving the collection

Return ONLY a valid JSON object:
{
  "overview": "3-4 sentence overview of the cellar",
  "diversification": "2-3 sentence diversification assessment",
  "highlights": ["bottle highlight 1", "bottle highlight 2", "bottle highlight 3"],
  "drinkNow": [
    {"wine": "Wine name + vintage", "reason": "why drink now"},
    {"wine": "Wine name + vintage", "reason": "why drink now"}
  ],
  "holdBottles": [
    {"wine": "Wine name + vintage", "reason": "why hold and until when"},
    {"wine": "Wine name + vintage", "reason": "why hold and until when"}
  ],
  "recommendations": ["recommendation 1", "recommendation 2", "recommendation 3"]
}

Return ONLY the JSON. No markdown, no preamble.`;
}

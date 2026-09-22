/**
 * Analysis service — AI-powered cellar analysis via Gemini (primary) / Claude (fallback).
 */

import state from './state.js?v=3.55.6';
import { callWineAI, bottleForAI } from './api.js?v=3.55.6';
import { showToast, escapeHTML, repairTruncatedJSON } from './utils.js?v=3.55.6';
import { t } from '../data/i18n.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

    if (analyzeBtn) { analyzeBtn.disabled = true; analyzeBtn.textContent = t('analysis.analyzing'); }
    analysisSection.innerHTML = `
        <div class="wine-analysis-section">
            <div class="wine-analysis-loading">
                <div class="spinner"></div>
                Analyzing your cellar with AI...
            </div>
        </div>`;

    try {
        // The server builds the prompt and the totals from the bottles
        // (_shared/wine-prompts.js), with the page's language.
        const data = await callWineAI({ requestType: 'analysis', bottles: state.cellar.map(bottleForAI) });

        // Debug: surface Gemini fallback so it's visible in the UI until Gemini is stable.
        if (data._source === 'claude' && data._geminiError) {
            const snippet = data._geminiError.slice(0, 120);
            console.warn('[Analysis] Gemini failed, used Claude fallback. Gemini error:', data._geminiError);
            showToast(`[Debug] Gemini failed → Claude used. ${snippet}`, 'warning', 10000);
        }

        // Extract text — handle both Claude (content[]) and Gemini (text) response shapes
        let text = '';
        if (data.content && Array.isArray(data.content)) {
            text = data.content.find(c => c.type === 'text')?.text || '';
        } else if (typeof data.text === 'string') {
            text = data.text;
        } else if (typeof data === 'string') {
            text = data;
        }
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
                <div class="wine-analysis-error">❌ Analysis failed: ${escapeHTML(err.message)}</div>
            </div>`;
    } finally {
        if (analyzeBtn) { analyzeBtn.disabled = false; analyzeBtn.textContent = t('wine.btn.analyze_done'); }
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
        `<li><strong class="wine-highlight-drink">${escapeHTML(d.wine)}</strong> — ${escapeHTML(d.reason)}</li>`).join('');

    const hold = (analysis.holdBottles || []).map(h =>
        `<li><strong class="wine-highlight-hold">${escapeHTML(h.wine)}</strong> — ${escapeHTML(h.reason)}</li>`).join('');

    analysisSection.innerHTML = `
        <div class="wine-analysis-section">
            <h2>${t('wine.analysis.title')}</h2>

            <div class="wine-analysis-card">
                <div class="wine-analysis-title">${t('wine.analysis.overview')}</div>
                <div class="wine-analysis-body">${escapeHTML(analysis.overview || '')}</div>
            </div>

            ${analysis.diversification ? `
            <div class="wine-analysis-card">
                <div class="wine-analysis-title">${t('wine.analysis.divers')}</div>
                <div class="wine-analysis-body">${escapeHTML(analysis.diversification)}</div>
            </div>` : ''}

            ${highlights ? `
            <div class="wine-analysis-card">
                <div class="wine-analysis-title">${t('wine.analysis.highlights')}</div>
                <ul class="wine-analysis-list">${highlights}</ul>
            </div>` : ''}

            ${drinkNow ? `
            <div class="wine-analysis-card wine-analysis-drink-card">
                <div class="wine-analysis-title">${t('wine.analysis.drink_now')}</div>
                <ul class="wine-analysis-list">${drinkNow}</ul>
            </div>` : ''}

            ${hold ? `
            <div class="wine-analysis-card wine-analysis-hold-card">
                <div class="wine-analysis-title">${t('wine.analysis.hold')}</div>
                <ul class="wine-analysis-list">${hold}</ul>
            </div>` : ''}

            ${recommendations ? `
            <div class="wine-analysis-card">
                <div class="wine-analysis-title">${t('wine.analysis.recs')}</div>
                <ul class="wine-analysis-list">${recommendations}</ul>
            </div>` : ''}

            <div class="wine-analysis-disclaimer">
                <strong>Disclaimer:</strong> ${escapeHTML(t('wine.analysis.disclaimer'))}
            </div>
        </div>`;
}

// ── Prompt Builder ───────────────────────────────────────────────────────────


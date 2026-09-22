/**
 * Analysis service — AI-powered portfolio analysis and trade ideas via Claude API.
 */

import state from './state.js';
import { escapeHTML } from './utils.js';
import { INVESTMENT_PERSPECTIVES } from '../data/perspectives.js';
import { t, getLang } from '../data/i18n.js';
// The prompts are built by the same module the analyze-portfolio function uses,
// so the admin's own-key path and the server path cannot drift. The server
// builds its own from the data sent; it no longer accepts a prompt (plan P9).
import {
    PERSPECTIVES, marketsPrompt, tradeIdeasPrompt, moversPrompt, todayLabel,
} from '../supabase/functions/_shared/analysis-prompts.js';

/** The page's language, as the prompt module names it. */
const aiLang = () => (getLang() === 'pt' ? 'pt' : 'en');

/** Holdings as analyze-portfolio accepts them: data only, never prompt text. */
function holdingsForAnalysis() {
    return state.portfolio.map(p => ({
        symbol: p.symbol,
        shares: Number(p.shares),
        avgPrice: Number(p.avgPrice),
        currentPrice: Number.isFinite(state.marketPrices[p.symbol]) ? state.marketPrices[p.symbol] : null,
        type: p.type || 'Stock',
    }));
}

/**
 * Call analyze-portfolio with data and return a reply shaped like Anthropic's,
 * so the three callers read both paths the same way. The function returns the
 * answer's text only.
 */
async function callAnalysisFunction(payload) {
    const { data: { session } } = await state.supabaseClient.auth.getSession();
    const response = await fetch(`${state.supabaseUrl}/functions/v1/analyze-portfolio`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': state.supabaseAnonKey,
            ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ ...payload, lang: aiLang() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const err = new Error(body.error || `Analysis service error (${response.status})`);
        err.status = response.status;
        throw err;
    }
    return { content: [{ type: 'text', text: typeof body.text === 'string' ? body.text : '' }] };
}

// ── AI Analysis ─────────────────────────────────────────────────────────────

export async function analyzeMarkets() {
    if (state.supabaseClient && !state.currentUser) {
        alert('\u{1F512} Please log in to use AI analysis.\n\nSign in with your email or Google account above.');
        return;
    }
    const analyzeBtn = document.getElementById('analyzeBtn');
    const analysisSection = document.getElementById('analysisSection');

    const perspective = INVESTMENT_PERSPECTIVES[state.selectedPerspective] || INVESTMENT_PERSPECTIVES['value'];
    if (!perspective) {
        alert('\u274C Unknown investment perspective selected. Please refresh the page.');
        return;
    }
    console.log('=== ANALYZE MARKETS ===');
    console.log('Perspective:', state.selectedPerspective, perspective.name);

    if (state.portfolio.length === 0) {
        alert('\u274C No positions in portfolio. Import your portfolio first.');
        return;
    }

    const isClaudeAI = window.location.hostname.includes('claude.ai') ||
                        window.location.hostname.includes('anthropic.com') ||
                        (typeof window.storage !== 'undefined');

    const useDirectAPI = isClaudeAI || state.anthropicKey;
    const useEdgeFunction = !useDirectAPI && state.supabaseUrl;

    if (!useDirectAPI && !useEdgeFunction) {
        analysisSection.innerHTML = `
            <div class="card" style="background: var(--surface-2); padding: 20px;">
                <h3 style="color: var(--text-primary); margin-bottom: 10px;">\uD83E\uDD16 AI Analysis</h3>
                <p style="color: var(--text-secondary); margin-bottom: 15px;">AI analysis requires either a Supabase connection or your own Anthropic API key.</p>
                <ol style="color: var(--text-secondary); margin-left: 20px; line-height: 1.8;">
                    <li>Get an API key from <a href="https://console.anthropic.com/settings/keys" target="_blank" style="color: var(--gold);">console.anthropic.com</a></li>
                    <li>Click the <strong style="color: var(--text-primary);">\uD83D\uDD11 API Keys</strong> button above</li>
                    <li>Enter your Anthropic key and save</li>
                    <li>Click "Get AI Analysis" again</li>
                </ol>
            </div>
        `;
        return;
    }

    analyzeBtn.disabled = true;
    analyzeBtn.textContent = t('analysis.analyzing');
    analysisSection.innerHTML = `<div class="card loading">${perspective.icon} ${t('analysis.analyzing')}</div>`;

    try {
        let data;

        if (useDirectAPI) {
            console.log('Using direct Anthropic API...');
            const headers = { 'Content-Type': 'application/json' };
            if (!isClaudeAI && state.anthropicKey) {
                headers['x-api-key'] = state.anthropicKey;
                headers['anthropic-version'] = '2023-06-01';
                headers['anthropic-dangerous-direct-browser-access'] = 'true';
            }

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 2500,
                    messages: [{
                        role: 'user',
                        content: marketsPrompt({
                            perspective: PERSPECTIVES[state.selectedPerspective] || PERSPECTIVES.value,
                            holdings: holdingsForAnalysis(),
                            lang: aiLang(),
                        })
                    }]
                })
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                if (response.status === 401) throw new Error('Invalid API key. Check your Anthropic key in API Keys settings.');
                throw new Error(`API returned status ${response.status}: ${errBody}`);
            }

            data = await response.json();
        } else {
            console.log('Using Supabase Edge Function...');
            data = await callAnalysisFunction({
                task: 'markets',
                perspective: state.selectedPerspective in PERSPECTIVES ? state.selectedPerspective : 'value',
                holdings: holdingsForAnalysis(),
            });
        }

        if (!data || !Array.isArray(data.content)) {
            throw new Error('Unexpected API response format');
        }
        const text = data.content.find(c => c.type === 'text')?.text || '';
        const cleanText = text.replace(/```json|```/g, '').trim();
        let analysis;
        try {
            analysis = JSON.parse(cleanText);
        } catch {
            throw new Error('Could not parse AI response as JSON. Raw: ' + cleanText.slice(0, 200));
        }

        analysisSection.innerHTML = `
            <div class="card analysis-section">
                <div class="ai-card market-news-card">
                    <div class="ai-header">${t('analysis.market_news')}</div>
                    <div class="ai-text">${escapeHTML(analysis.marketNews || analysis.marketOverview)}</div>
                </div>
            </div>
            <div class="card analysis-section">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                    <div class="ai-badge" style="background: ${perspective.color};">${perspective.icon} ${escapeHTML(perspective.name)}</div>
                    <div class="ai-perspective">Inspired by ${escapeHTML(perspective.figures)}</div>
                </div>
                <div class="ai-card" style="border-left: 3px solid ${perspective.color};">
                    <div class="ai-header">${perspective.icon} ${t('analysis.market_assess')} \u2014 ${escapeHTML(perspective.name)} ${t('analysis.view')}</div>
                    <div class="ai-text">${escapeHTML(analysis.marketOverview)}</div>
                </div>
                <div class="ai-card" style="border-left: 3px solid ${perspective.color};">
                    <div class="ai-header">\uD83C\uDFAF ${t('analysis.portfolio_eval')}${escapeHTML(perspective.name)} ${t('analysis.view')}</div>
                    <div class="ai-text">${escapeHTML(analysis.portfolioImpact)}</div>
                </div>
                <div class="disclaimer">
                    <strong>Disclaimer:</strong> ${escapeHTML(t('analysis.disclaimer').replace('{perspective}', perspective.name))}
                </div>
            </div>
        `;
    } catch (err) {
        console.error('=== ANALYZE MARKETS ERROR ===', err);
        analysisSection.innerHTML = `
            <div class="card">
                <div class="ai-text" style="color: var(--down);">\u274C Unable to generate analysis: ${escapeHTML(err.message)}<br><br>Check the browser console (F12) for detailed error information.</div>
            </div>
        `;
    }

    analyzeBtn.disabled = false;
    analyzeBtn.textContent = t('analysis.btn.analyze');
}

// ── Trade Ideas ─────────────────────────────────────────────────────────────

export async function getTradeIdeas() {
    if (state.supabaseClient && !state.currentUser) {
        alert('\u{1F512} Please log in to get trade ideas.\n\nSign in with your email or Google account above.');
        return;
    }
    const tradeIdeasBtn = document.getElementById('tradeIdeasBtn');
    const analysisSection = document.getElementById('analysisSection');
    const perspective = INVESTMENT_PERSPECTIVES[state.selectedPerspective] || INVESTMENT_PERSPECTIVES['value'];
    if (!perspective) {
        alert('\u274C Unknown investment perspective selected. Please refresh the page.');
        return;
    }

    if (state.portfolio.length === 0) {
        alert('\u274C No positions in portfolio. Import your portfolio first.');
        return;
    }

    tradeIdeasBtn.disabled = true;
    tradeIdeasBtn.textContent = t('analysis.generating');

    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    analysisSection.innerHTML = `<div class="card loading">\uD83D\uDCC8 Generating concrete trade ideas for ${today}...</div>`;

    const isClaudeAI = window.location.hostname.includes('claude.ai') ||
                        window.location.hostname.includes('claude.site') ||
                        (typeof window.anthropic !== 'undefined');
    const useDirectAPI = isClaudeAI || state.anthropicKey;
    const useEdgeFunction = !useDirectAPI && state.supabaseUrl;

    if (!useDirectAPI && !useEdgeFunction) {
        analysisSection.innerHTML = `
            <div class="card" style="background: var(--surface-2); padding: 20px;">
                <h3 style="color: var(--text-primary); margin-bottom: 10px;">\uD83D\uDCC8 Trade Ideas</h3>
                <p style="color: var(--text-secondary);">Trade ideas require either a Supabase connection or your own Anthropic API key.</p>
            </div>
        `;
        tradeIdeasBtn.disabled = false;
        tradeIdeasBtn.textContent = '\uD83D\uDCC8 Get Trade Ideas';
        return;
    }

    try {
        let data;
        const perspectiveKey = state.selectedPerspective in PERSPECTIVES ? state.selectedPerspective : 'value';
        const tradeIdeasText = tradeIdeasPrompt({
            perspective: PERSPECTIVES[perspectiveKey],
            holdings: holdingsForAnalysis(),
            lang: aiLang(),
            today: todayLabel(),
        });

        if (useDirectAPI) {
            const headers = { 'Content-Type': 'application/json' };
            if (!isClaudeAI && state.anthropicKey) {
                headers['x-api-key'] = state.anthropicKey;
                headers['anthropic-version'] = '2023-06-01';
                headers['anthropic-dangerous-direct-browser-access'] = 'true';
            }

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 4000,
                    messages: [{ role: 'user', content: tradeIdeasText }]
                })
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                if (response.status === 401) throw new Error('Invalid API key.');
                throw new Error(`API returned status ${response.status}: ${errBody}`);
            }

            data = await response.json();
        } else {
            data = await callAnalysisFunction({
                task: 'tradeIdeas',
                perspective: perspectiveKey,
                holdings: holdingsForAnalysis(),
            });
        }

        if (!data || !Array.isArray(data.content)) {
            throw new Error('Unexpected API response format');
        }
        const text = data.content.find(c => c.type === 'text')?.text || '';
        const cleanText = text.replace(/```json|```/g, '').trim();
        let ideas;
        try {
            ideas = JSON.parse(cleanText);
        } catch {
            // Fallback: extract the outermost JSON object in case the model added
            // any preamble/trailing prose around it.
            const start = cleanText.indexOf('{');
            const end = cleanText.lastIndexOf('}');
            if (start !== -1 && end > start) {
                try { ideas = JSON.parse(cleanText.slice(start, end + 1)); } catch { /* fall through */ }
            }
            if (!ideas) {
                throw new Error('Could not parse trade ideas response as JSON. Raw: ' + cleanText.slice(0, 200));
            }
        }

        const actionColors = { 'BUY': '#4CAF84', 'SELL': '#E05A5A', 'TRIM': '#E09A3A', 'ADD': '#4CAF84', 'REBALANCE': '#E09A3A', 'WATCH': '#7A8099', 'HOLD': '#7A8099' };
        const actionIcons = { 'BUY': '\uD83D\uDFE2', 'SELL': '\uD83D\uDD34', 'TRIM': '\uD83D\uDFE1', 'ADD': '\uD83D\uDD35', 'REBALANCE': '\uD83D\uDCCA', 'WATCH': '\uD83D\uDC41\uFE0F', 'HOLD': '\u23F8\uFE0F' };

        analysisSection.innerHTML = `
            <div class="card trade-ideas-section">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                    <div class="ai-badge" style="background: ${perspective.color};">${perspective.icon} ${escapeHTML(perspective.name)}</div>
                    <span style="color: var(--text-secondary); font-size: 12px;">${escapeHTML(ideas.date || today)}</span>
                </div>
                <div style="background: var(--surface); border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                    <div style="color: var(--text-secondary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">${t('analysis.market_summary')}</div>
                    <div style="color: var(--text-primary); font-size: 14px; line-height: 1.6;">${escapeHTML(ideas.marketSummary || ideas.marketOverview || '')}</div>
                </div>
                ${ideas.portfolioImpact ? `<div style="background: var(--surface); border-radius: 8px; padding: 15px; margin-bottom: 20px;"><div style="color: var(--text-secondary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">${t('analysis.portfolio_impact')}</div><div style="color: var(--text-primary); font-size: 14px; line-height: 1.6;">${escapeHTML(ideas.portfolioImpact)}</div></div>` : ''}
                <h3 style="color: var(--text-primary); font-size: 18px; margin-bottom: 15px;">${t('analysis.trade_ideas')}</h3>
                ${(ideas.trades || ideas.ideas || []).map((trade, idx) => {
                    // Constrained to the known set BEFORE it reaches a class
                    // attribute. This value comes from the model's JSON, and
                    // `.toLowerCase()` does not remove a quote character, so an
                    // unconstrained action could close the attribute.
                    const rawAction = String(trade.action || 'WATCH').toUpperCase();
                    const action = Object.hasOwn(actionColors, rawAction) ? rawAction : 'WATCH';
                    const color = actionColors[action];
                    const icon = actionIcons[action] || '\uD83D\uDCCB';   // action is now always a known key
                    return `
                    <div class="trade-idea-card ${action.toLowerCase()}">
                        <div class="trade-idea-header">
                            <div class="trade-idea-number" style="background: ${color}20; color: ${color};">${idx + 1}</div>
                            <div class="trade-idea-title-section">
                                <div class="trade-idea-title">${icon} ${escapeHTML(trade.title || '')}</div>
                                <div class="trade-idea-subtitle">${escapeHTML(trade.subtitle || '')}</div>
                            </div>
                        </div>
                        ${trade.context && trade.context.length > 0 ? `<div class="trade-idea-context"><h4>${t('analysis.current_context')}</h4><ul>${trade.context.map(c => `<li>${escapeHTML(c)}</li>`).join('')}</ul></div>` : ''}
                        <div class="trade-idea-action"><h4>${t('analysis.specific_action')}</h4><p>${escapeHTML(trade.specificAction || trade.description || '')}</p></div>
                        ${trade.rationale ? `<div class="trade-idea-rationale"><strong>Rationale:</strong> ${escapeHTML(trade.rationale)}</div>` : ''}
                    </div>`;
                }).join('')}
                ${ideas.executionPlan && ideas.executionPlan.length > 0 ? `
                <div class="trade-ideas-summary">
                    <h3>${t('analysis.exec_plan')}</h3>
                    ${ideas.executionPlan.map(step => `<div class="execution-step"><span class="execution-time">${escapeHTML(step.time || '')}</span><span class="execution-action">${escapeHTML(step.action || '')}</span></div>`).join('')}
                </div>` : ''}
                <div class="disclaimer" style="margin-top: 20px;">
                    <strong>Disclaimer:</strong> ${escapeHTML(t('analysis.trade_disclaimer').replace('{perspective}', perspective.name))}
                </div>
            </div>
        `;
    } catch (err) {
        console.error('=== GET TRADE IDEAS ERROR ===', err);
        analysisSection.innerHTML = `<div class="card"><div class="ai-text" style="color: var(--down);">\u274C Unable to generate trade ideas: ${escapeHTML(err.message)}</div></div>`;
    }

    tradeIdeasBtn.disabled = false;
    tradeIdeasBtn.textContent = t('analysis.btn.trade');
}

// ── Movers Analysis ──────────────────────────────────────────────────────────

/**
 * Explain the biggest price movers via Claude API and update #moversAiText.
 * Called automatically after fetchMarketPrices() completes.
 * @param {Array} movers - [{symbol, name, changePct, prevPrice, newPrice}]
 */
export async function analyzeMovers(movers) {
    const aiTextEl = document.getElementById('moversAiText');
    if (!aiTextEl || !movers || movers.length === 0) return;

    const isClaudeAI = window.location.hostname.includes('claude.ai') ||
                        window.location.hostname.includes('anthropic.com') ||
                        (typeof window.storage !== 'undefined');
    const useDirectAPI = isClaudeAI || state.anthropicKey;
    const useEdgeFunction = !useDirectAPI && state.supabaseUrl;

    if (!useDirectAPI && !useEdgeFunction) {
        aiTextEl.textContent = 'Add an Anthropic API key in \uD83D\uDD11 API Keys to get AI-powered explanations of these moves.';
        aiTextEl.classList.remove('movers-ai-loading');
        return;
    }

    // Build a concise summary of significant movers (up to 6)
    const significant = movers
        .filter(m => Math.abs(m.changePct) >= 0.1)
        .slice(0, 6);

    if (significant.length === 0) {
        aiTextEl.textContent = 'No significant moves detected since the last price update.';
        aiTextEl.classList.remove('movers-ai-loading');
        return;
    }

    const moverData = significant.map(m => ({
        symbol: m.symbol, changePct: m.changePct, prevPrice: m.prevPrice, newPrice: m.newPrice,
    }));
    const prompt = moversPrompt({ movers: moverData, lang: aiLang(), today: todayLabel() });

    try {
        let data;

        if (useDirectAPI) {
            const headers = { 'Content-Type': 'application/json' };
            if (!isClaudeAI && state.anthropicKey) {
                headers['x-api-key'] = state.anthropicKey;
                headers['anthropic-version'] = '2023-06-01';
                headers['anthropic-dangerous-direct-browser-access'] = 'true';
            }

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 350,
                    messages: [{ role: 'user', content: prompt }]
                })
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                throw new Error(`API ${response.status}: ${errBody}`);
            }
            data = await response.json();
        } else {
            // Use Supabase Edge Function (server-side Anthropic key)
            try {
                data = await callAnalysisFunction({ task: 'movers', movers: moverData });
            } catch (err) {
                if (err.status === 502 || err.status === 504) {
                    // Transient on the provider's side — not worth an error.
                    console.warn('[analyzeMovers] analysis service busy, skipping AI insight.');
                    const el = document.getElementById('moversAiText');
                    if (el) {
                        el.textContent = 'AI insight unavailable right now. It will retry on the next price update.';
                        el.classList.remove('movers-ai-loading');
                    }
                    return;
                }
                throw err;
            }
        }

        const text = (data && Array.isArray(data.content))
            ? (data.content.find(c => c.type === 'text')?.text?.trim() || '')
            : '';

        const el = document.getElementById('moversAiText');
        if (el) {
            el.textContent = text || 'No explanation available.';
            el.classList.remove('movers-ai-loading');
        }
    } catch (err) {
        console.warn('analyzeMovers failed:', err.message);
        const el = document.getElementById('moversAiText');
        if (el) {
            el.textContent = 'Could not load AI explanation. Check console for details.';
            el.classList.remove('movers-ai-loading');
        }
    }
}

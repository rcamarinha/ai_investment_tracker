/**
 * Analysis service — AI-powered portfolio analysis and trade ideas via Claude API.
 */

import state from './state.js';
import { escapeHTML } from './utils.js';
import { INVESTMENT_PERSPECTIVES } from '../data/perspectives.js';

// ── AI Analysis ─────────────────────────────────────────────────────────────

export async function analyzeMarkets() {
    if (state.supabaseClient && !state.currentUser) {
        alert('\u{1F512} Please log in to use AI analysis.\n\nSign in with your email or Google account above.');
        return;
    }
    const analyzeBtn = document.getElementById('analyzeBtn');
    const analysisSection = document.getElementById('analysisSection');

    const perspective = INVESTMENT_PERSPECTIVES[state.selectedPerspective];
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
            <div class="card" style="background: #334155; padding: 20px;">
                <h3 style="color: #cbd5e1; margin-bottom: 10px;">\uD83E\uDD16 AI Analysis</h3>
                <p style="color: #94a3b8; margin-bottom: 15px;">AI analysis requires either a Supabase connection or your own Anthropic API key.</p>
                <ol style="color: #94a3b8; margin-left: 20px; line-height: 1.8;">
                    <li>Get an API key from <a href="https://console.anthropic.com/settings/keys" target="_blank" style="color: #60a5fa;">console.anthropic.com</a></li>
                    <li>Click the <strong style="color: #cbd5e1;">\uD83D\uDD11 API Keys</strong> button above</li>
                    <li>Enter your Anthropic key and save</li>
                    <li>Click "Get AI Analysis" again</li>
                </ol>
            </div>
        `;
        return;
    }

    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analyzing...';
    analysisSection.innerHTML = `<div class="card loading">${perspective.icon} Analyzing through ${escapeHTML(perspective.name)} lens...</div>`;

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
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 2500,
                    messages: [{
                        role: 'user',
                        content: `${perspective.prompt}

The portfolio contains: ${state.portfolio.map(p => `${p.shares} shares of ${p.symbol} at avg price $${p.avgPrice}${state.marketPrices[p.symbol] ? ` (current: $${state.marketPrices[p.symbol]})` : ''}`).join(', ')}.

Please provide your analysis in JSON format with these fields:
- marketNews: an OBJECTIVE, perspective-neutral overview of current market conditions and recent notable events affecting equities, bonds, or macro (3-5 sentences). This section should be purely factual — no opinion from any investment philosophy.
- marketOverview: your OPINIONATED assessment of these market conditions strictly through the lens of ${perspective.name}. Explain what a ${perspective.name} practitioner would focus on and how they would interpret current conditions (3-4 sentences). Make it clear this is a ${perspective.name} perspective.
- portfolioImpact: evaluate the specific holdings in this portfolio through the ${perspective.name} lens — which positions align well with this philosophy, which don't, and why (3-4 sentences). Be specific about individual holdings.

Respond ONLY with valid JSON, no markdown, no preamble.`
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
            const { data: { session } } = await state.supabaseClient.auth.getSession();
            const response = await fetch(`${state.supabaseUrl}/functions/v1/analyze-portfolio`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': state.supabaseAnonKey,
                    'Authorization': `Bearer ${session?.access_token || state.supabaseAnonKey}`
                },
                body: JSON.stringify({
                    portfolio: state.portfolio.map(p => ({
                        shares: p.shares,
                        symbol: p.symbol,
                        avgPrice: p.avgPrice,
                        currentPrice: state.marketPrices[p.symbol] || null
                    })),
                    perspective: {
                        key: state.selectedPerspective,
                        name: perspective.name,
                        prompt: perspective.prompt
                    }
                })
            });

            const responseBody = await response.text();
            if (!response.ok) throw new Error(`Edge Function error (${response.status}): ${responseBody}`);
            data = JSON.parse(responseBody);
        }

        const text = data.content.find(c => c.type === 'text')?.text || '';
        const cleanText = text.replace(/```json|```/g, '').trim();
        const analysis = JSON.parse(cleanText);

        analysisSection.innerHTML = `
            <div class="card analysis-section">
                <div class="analysis-card market-news-card">
                    <div class="analysis-title">\uD83D\uDCF0 Market News Overview</div>
                    <div class="analysis-content">${escapeHTML(analysis.marketNews || analysis.marketOverview)}</div>
                </div>
            </div>
            <div class="card analysis-section">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                    <span class="perspective-badge" style="background: ${perspective.color};">${perspective.icon} ${escapeHTML(perspective.name)}</span>
                    <span style="color: #64748b; font-size: 12px;">Inspired by ${escapeHTML(perspective.figures)}</span>
                </div>
                <div class="analysis-card" style="border-left: 3px solid ${perspective.color};">
                    <div class="analysis-title">${perspective.icon} Market Assessment \u2014 ${escapeHTML(perspective.name)} View</div>
                    <div class="analysis-content">${escapeHTML(analysis.marketOverview)}</div>
                </div>
                <div class="analysis-card" style="border-left: 3px solid ${perspective.color};">
                    <div class="analysis-title">\uD83C\uDFAF Portfolio Evaluation \u2014 ${escapeHTML(perspective.name)} View</div>
                    <div class="analysis-content">${escapeHTML(analysis.portfolioImpact)}</div>
                </div>
                <div class="disclaimer">
                    <strong>Disclaimer:</strong> This analysis is generated from a ${escapeHTML(perspective.name)} perspective for educational purposes only. It should not be considered financial advice. Always consult with a qualified financial advisor before making investment decisions.
                </div>
            </div>
        `;
    } catch (err) {
        console.error('=== ANALYZE MARKETS ERROR ===', err);
        analysisSection.innerHTML = `
            <div class="card">
                <div class="analysis-content" style="color: #f87171;">\u274C Unable to generate analysis: ${escapeHTML(err.message)}<br><br>Check the browser console (F12) for detailed error information.</div>
            </div>
        `;
        alert(`\u274C Error generating analysis:\n\n${err.message}`);
    }

    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Get AI Analysis';
}

// ── Trade Ideas ─────────────────────────────────────────────────────────────

export async function getTradeIdeas() {
    if (state.supabaseClient && !state.currentUser) {
        alert('\u{1F512} Please log in to get trade ideas.\n\nSign in with your email or Google account above.');
        return;
    }
    const tradeIdeasBtn = document.getElementById('tradeIdeasBtn');
    const analysisSection = document.getElementById('analysisSection');
    const perspective = INVESTMENT_PERSPECTIVES[state.selectedPerspective];

    if (state.portfolio.length === 0) {
        alert('\u274C No positions in portfolio. Import your portfolio first.');
        return;
    }

    tradeIdeasBtn.disabled = true;
    tradeIdeasBtn.textContent = 'Generating...';

    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    analysisSection.innerHTML = `<div class="card loading">\uD83D\uDCC8 Generating concrete trade ideas for ${today}...</div>`;

    const isClaudeAI = window.location.hostname.includes('claude.ai') ||
                        window.location.hostname.includes('claude.site') ||
                        (typeof window.anthropic !== 'undefined');
    const useDirectAPI = isClaudeAI || state.anthropicKey;
    const useEdgeFunction = !useDirectAPI && state.supabaseUrl;

    if (!useDirectAPI && !useEdgeFunction) {
        analysisSection.innerHTML = `
            <div class="card" style="background: #334155; padding: 20px;">
                <h3 style="color: #cbd5e1; margin-bottom: 10px;">\uD83D\uDCC8 Trade Ideas</h3>
                <p style="color: #94a3b8;">Trade ideas require either a Supabase connection or your own Anthropic API key.</p>
            </div>
        `;
        tradeIdeasBtn.disabled = false;
        tradeIdeasBtn.textContent = '\uD83D\uDCC8 Get Trade Ideas';
        return;
    }

    try {
        let data;
        const portfolioSummary = state.portfolio.map(p => {
            const currentPrice = state.marketPrices[p.symbol];
            const invested = p.shares * p.avgPrice;
            const marketValue = currentPrice ? p.shares * currentPrice : invested;
            const gainLoss = marketValue - invested;
            const gainLossPct = invested > 0 ? ((gainLoss / invested) * 100).toFixed(1) : 0;
            return `${p.symbol}: ${p.shares} shares @ $${p.avgPrice} avg${currentPrice ? `, current $${currentPrice} (${gainLoss >= 0 ? '+' : ''}${gainLossPct}%)` : ''}, type: ${p.type || 'Stock'}`;
        }).join('\n');

        const tradeIdeasPrompt = `You are a ${perspective.name} investment advisor (inspired by ${perspective.figures}). Today is ${today}.

${perspective.prompt}

The user's current portfolio:
${portfolioSummary}

Based on current market conditions and this portfolio, provide 3-4 CONCRETE, ACTIONABLE trade ideas for TODAY that align with the ${perspective.name} philosophy.

For each trade idea, provide:
1. A clear action type (REBALANCE, BUY, SELL, TRIM, ADD, or WATCH)
2. Specific ticker symbol(s) involved
3. Current market context (recent price action, news, technical signals relevant to this perspective)
4. The specific action to take (exact percentages, price levels, limit orders)
5. Rationale explaining why this trade fits the ${perspective.name} philosophy

Also provide a brief "Today's Execution Plan" with timing suggestions (Morning, Mid-Day, Afternoon, End of Day).

Respond in JSON format:
{
  "date": "${today}",
  "perspective": "${perspective.name}",
  "marketSummary": "Brief 2-3 sentence overview of today's market conditions",
  "trades": [
    {
      "action": "BUY|SELL|TRIM|ADD|REBALANCE|WATCH",
      "title": "Short descriptive title",
      "subtitle": "One-line trade summary with tickers",
      "tickers": ["TICKER1", "TICKER2"],
      "context": ["bullet point 1 about current conditions", "bullet point 2", "bullet point 3"],
      "specificAction": "Detailed description of exactly what to do",
      "rationale": "Why this fits the ${perspective.name} philosophy"
    }
  ],
  "executionPlan": [
    {"time": "Morning", "action": "What to do in the morning"},
    {"time": "Mid-Day", "action": "What to do mid-day"},
    {"time": "Afternoon", "action": "What to do in the afternoon"}
  ]
}

Respond ONLY with valid JSON, no markdown, no preamble.`;

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
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 4000,
                    messages: [{ role: 'user', content: tradeIdeasPrompt }]
                })
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                if (response.status === 401) throw new Error('Invalid API key.');
                throw new Error(`API returned status ${response.status}: ${errBody}`);
            }

            data = await response.json();
        } else {
            const { data: { session } } = await state.supabaseClient.auth.getSession();
            const response = await fetch(`${state.supabaseUrl}/functions/v1/analyze-portfolio`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': state.supabaseAnonKey,
                    'Authorization': `Bearer ${session?.access_token || state.supabaseAnonKey}`
                },
                body: JSON.stringify({
                    portfolio: state.portfolio.map(p => ({
                        shares: p.shares, symbol: p.symbol, avgPrice: p.avgPrice,
                        currentPrice: state.marketPrices[p.symbol] || null, type: p.type || 'Stock'
                    })),
                    perspective: { key: state.selectedPerspective, name: perspective.name, prompt: tradeIdeasPrompt },
                    requestType: 'tradeIdeas'
                })
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                throw new Error(`Edge function returned ${response.status}: ${errBody}`);
            }
            data = await response.json();
        }

        const text = data.content.find(c => c.type === 'text')?.text || '';
        const cleanText = text.replace(/```json|```/g, '').trim();
        const ideas = JSON.parse(cleanText);

        const actionColors = { 'BUY': '#10b981', 'SELL': '#ef4444', 'TRIM': '#f59e0b', 'ADD': '#3b82f6', 'REBALANCE': '#f59e0b', 'WATCH': '#8b5cf6', 'HOLD': '#6366f1' };
        const actionIcons = { 'BUY': '\uD83D\uDFE2', 'SELL': '\uD83D\uDD34', 'TRIM': '\uD83D\uDFE1', 'ADD': '\uD83D\uDD35', 'REBALANCE': '\uD83D\uDCCA', 'WATCH': '\uD83D\uDC41\uFE0F', 'HOLD': '\u23F8\uFE0F' };

        analysisSection.innerHTML = `
            <div class="card trade-ideas-section">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 15px;">
                    <span class="perspective-badge" style="background: ${perspective.color};">${perspective.icon} ${escapeHTML(perspective.name)}</span>
                    <span style="color: #94a3b8; font-size: 12px;">${escapeHTML(ideas.date || today)}</span>
                </div>
                <div style="background: #1e293b; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                    <div style="color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Market Summary</div>
                    <div style="color: #e2e8f0; font-size: 14px; line-height: 1.6;">${escapeHTML(ideas.marketSummary || ideas.marketOverview || '')}</div>
                </div>
                ${ideas.portfolioImpact ? `<div style="background: #1e293b; border-radius: 8px; padding: 15px; margin-bottom: 20px;"><div style="color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Portfolio Impact</div><div style="color: #e2e8f0; font-size: 14px; line-height: 1.6;">${escapeHTML(ideas.portfolioImpact)}</div></div>` : ''}
                <h3 style="color: #e2e8f0; font-size: 18px; margin-bottom: 15px;">\uD83D\uDCC8 Concrete Trade Ideas</h3>
                ${(ideas.trades || ideas.ideas || []).map((trade, idx) => {
                    const action = (trade.action || 'WATCH').toUpperCase();
                    const color = actionColors[action] || '#6366f1';
                    const icon = actionIcons[action] || '\uD83D\uDCCB';
                    return `
                    <div class="trade-idea-card ${action.toLowerCase()}">
                        <div class="trade-idea-header">
                            <div class="trade-idea-number" style="background: ${color}20; color: ${color};">${idx + 1}</div>
                            <div class="trade-idea-title-section">
                                <div class="trade-idea-title">${icon} ${escapeHTML(trade.title || '')}</div>
                                <div class="trade-idea-subtitle">${escapeHTML(trade.subtitle || '')}</div>
                            </div>
                        </div>
                        ${trade.context && trade.context.length > 0 ? `<div class="trade-idea-context"><h4>Current Context</h4><ul>${trade.context.map(c => `<li>${escapeHTML(c)}</li>`).join('')}</ul></div>` : ''}
                        <div class="trade-idea-action"><h4>\uD83C\uDFAF Specific Action</h4><p>${escapeHTML(trade.specificAction || trade.description || '')}</p></div>
                        ${trade.rationale ? `<div class="trade-idea-rationale"><strong>Rationale:</strong> ${escapeHTML(trade.rationale)}</div>` : ''}
                    </div>`;
                }).join('')}
                ${ideas.executionPlan && ideas.executionPlan.length > 0 ? `
                <div class="trade-ideas-summary">
                    <h3>\uD83D\uDCCB Today's Execution Plan</h3>
                    ${ideas.executionPlan.map(step => `<div class="execution-step"><span class="execution-time">${escapeHTML(step.time || '')}</span><span class="execution-action">${escapeHTML(step.action || '')}</span></div>`).join('')}
                </div>` : ''}
                <div class="disclaimer" style="margin-top: 20px;">
                    <strong>Disclaimer:</strong> These trade ideas are generated from a ${escapeHTML(perspective.name)} perspective for educational purposes only. They are not personalized financial advice. Always do your own research and consult with a qualified financial advisor before making investment decisions.
                </div>
            </div>
        `;
    } catch (err) {
        console.error('=== GET TRADE IDEAS ERROR ===', err);
        analysisSection.innerHTML = `<div class="card"><div class="analysis-content" style="color: #f87171;">\u274C Unable to generate trade ideas: ${escapeHTML(err.message)}</div></div>`;
    }

    tradeIdeasBtn.disabled = false;
    tradeIdeasBtn.textContent = '\uD83D\uDCC8 Get Trade Ideas';
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

    if (!useDirectAPI) {
        aiTextEl.textContent = 'Add an Anthropic API key in \uD83D\uDD11 API Keys to get AI-powered explanations of these moves.';
        aiTextEl.classList.remove('movers-ai-loading');
        return;
    }

    const today = new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    // Build a concise summary of significant movers (up to 6)
    const significant = movers
        .filter(m => Math.abs(m.changePct) >= 0.1)
        .slice(0, 6);

    if (significant.length === 0) {
        aiTextEl.textContent = 'No significant moves detected since the last price update.';
        aiTextEl.classList.remove('movers-ai-loading');
        return;
    }

    const moversList = significant.map(m => {
        const dir = m.changePct >= 0 ? 'up' : 'down';
        return `${m.symbol} ${dir} ${Math.abs(m.changePct).toFixed(2)}% (${m.prevPrice.toFixed(2)} → ${m.newPrice.toFixed(2)})`;
    }).join('; ');

    const prompt = `Today is ${today}. A portfolio tracker just updated prices and detected these notable moves compared to the previous price snapshot: ${moversList}.

In 2-3 concise sentences, explain what general market factors, sector news, or company events could plausibly explain these kinds of price moves. Be specific about each ticker if you can, drawing on your knowledge of each company and its sector. Acknowledge if your training data may not cover the latest events, and suggest the investor checks financial news for the latest catalyst.

Reply with plain text only — no markdown, no bullet points, no JSON.`;

    try {
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
                model: 'claude-sonnet-4-20250514',
                max_tokens: 350,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`API ${response.status}: ${errBody}`);
        }

        const data = await response.json();
        const text = data.content.find(c => c.type === 'text')?.text?.trim() || '';

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

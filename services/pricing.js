/**
 * Pricing service — 3-tier API fallback strategy for fetching stock prices.
 *
 * Tier 1: Finnhub   (60 calls/min, no daily limit)
 * Tier 2: FMP       (250 calls/day, no per-min limit)
 * Tier 3: Alpha Vantage (5/min, 25/day)
 */

import state from './state.js';
import { buildAssetRecord, getAssetCurrency } from './utils.js';
import { renderPortfolio, renderMoversSection } from './portfolio.js';
import { savePortfolioSnapshot } from './portfolio.js';
import {
    saveAssetsToDB, loadAssetsFromDB,
    savePriceHistoryToDB, enrichUnknownAssets
} from './storage.js';
import { analyzeMovers } from './analysis.js';
// Pure exchange-suffix / batch-parse / freshness helpers — shared with the test
// mirror (src/portfolio.js) so the shipped code is what the tests exercise.
import {
    normalizeForPricing, parseFmpBatchResponse, isPriceFresh,
    buildRawMaps, mapPricedToRaw, pooled,
    extractLlmJsonArray, classifyFmpBatchText,
    deriveFxToBases, lookupFxTableForDate,
} from './pricing-core.js';
export { normalizeForPricing, pooled };

// ── FMP daily-quota guard ────────────────────────────────────────────────────
// FMP free plan is 250 requests/day (comma-batch bills ~per symbol). Track usage
// across reloads in localStorage, keyed by date so it resets at midnight, and
// actually STOP hitting FMP when near the cap (falls back to Finnhub/AV/AI).
const FMP_DAILY_LIMIT = 250;
const FMP_QUOTA_HEADROOM = 10;   // stop a bit early to leave manual-lookup budget

function fmpQuota() {
    const today = new Date().toISOString().slice(0, 10);
    try {
        const raw = JSON.parse(localStorage.getItem('fmpQuota') || '{}');
        if (raw && raw.date === today && Number.isFinite(raw.count)) return raw;
    } catch { /* ignore */ }
    return { date: today, count: 0 };
}
export function fmpCallsUsed() { return fmpQuota().count; }
function addFmpCalls(n) {
    const q = fmpQuota();
    q.count += n;
    try { localStorage.setItem('fmpQuota', JSON.stringify(q)); } catch { /* ignore quota */ }
    state.fmpCallsToday = q.count;   // kept for existing UI/log references
}
function fmpQuotaExhausted() { return fmpCallsUsed() >= FMP_DAILY_LIMIT - FMP_QUOTA_HEADROOM; }

/**
 * Fetch many tickers from FMP in one (chunked) call. Queries the price-API
 * normalized form and maps results back to the raw input symbol.
 * Returns { RAW_UPPER: price }. Never throws — returns {} on failure so the
 * caller falls back to per-symbol.
 */
export async function batchFetchFMP(symbols) {
    if (!state.fmpKey || state.fmpBatchUnsupported || fmpQuotaExhausted() || !symbols || !symbols.length) return {};
    const result = {};
    const { normToRaw, baseToRaw, normSyms } = buildRawMaps(symbols);
    for (let i = 0; i < normSyms.length; i += 50) {
        const chunk = normSyms.slice(i, i + 50);
        try {
            const url = `https://financialmodelingprep.com/stable/quote-short?symbol=${encodeURIComponent(chunk.join(','))}&apikey=${state.fmpKey}`;
            const resp = await fetch(url);
            if (!resp.ok) {
                console.warn(`FMP batch HTTP ${resp.status}`);
                if (resp.status === 401 || resp.status === 402 || resp.status === 403) state.fmpBatchUnsupported = true;
                continue;
            }
            // Read as text first: on free plans the comma-list endpoint returns a
            // plain-text notice ("Premium Query Parameter…") with HTTP 200, which
            // is NOT JSON. Parsing it directly throws and we'd never learn to stop.
            const text = await resp.text();
            const classified = classifyFmpBatchText(text);
            if (classified.unsupported) {
                console.warn('FMP batch non-JSON/non-array response (likely premium-only comma-list) — disabling batch for this session:', text.slice(0, 80));
                state.fmpBatchUnsupported = true;
                continue;
            }
            const json = classified.json;
            addFmpCalls(chunk.length); // FMP bills ≈ per symbol, only on success
            const priced = parseFmpBatchResponse(json);
            // If we asked for many but got ≤1 back, the plan likely ignores comma-lists.
            if (chunk.length > 3 && json.length <= 1) {
                console.warn(`FMP batch returned ${json.length} for ${chunk.length} symbols — disabling batch for this session (falling back to per-symbol/Finnhub).`);
                state.fmpBatchUnsupported = true;
            }
            Object.assign(result, mapPricedToRaw(priced, normToRaw, baseToRaw));
        } catch (err) { console.warn('FMP batch failed:', err.message); }
    }
    return result;
}

// Injected by portfolio.js (avoids a static import cycle): opens the interactive
// "resolve missing tickers" dialog and returns the user's decisions.
let _missingTickerResolver = null;
export function setMissingTickerResolver(fn) { _missingTickerResolver = fn; }

/** Search for a ticker by company/instrument name → [{ ticker, exchange, name }]. */
export async function searchTickerByName(query) {
    const out = [];
    if (!query || !query.trim()) return out;
    if (state.fmpKey) {
        try {
            const url = `https://financialmodelingprep.com/stable/search-symbol?query=${encodeURIComponent(query)}&apikey=${state.fmpKey}`;
            const r = await fetch(url);
            if (r.ok) {
                const data = await r.json();
                if (Array.isArray(data)) data.slice(0, 8).forEach(x => {
                    if (x.symbol) out.push({ ticker: String(x.symbol).toUpperCase(), exchange: x.exchangeShortName || x.exchange || '', name: x.name || '' });
                });
            }
        } catch (err) { console.warn('FMP name search failed:', err.message); }
    }
    if (!out.length && state.finnhubKey) {
        try {
            const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${state.finnhubKey}`;
            const r = await fetch(url);
            if (r.ok) {
                const data = await r.json();
                (data.result || []).slice(0, 8).forEach(x => {
                    if (x.symbol) out.push({ ticker: String(x.symbol).toUpperCase(), exchange: '', name: x.description || '' });
                });
            }
        } catch (err) { console.warn('Finnhub name search failed:', err.message); }
    }
    return out;
}

/** Remember the ticker that actually returned a price for a holding, so future
 *  refreshes fetch it directly instead of re-running the alternative search.
 *  MUST be awaited: the post-fetch loadAssetsFromDB() rebuilds assetDatabase
 *  from the DB, and an un-landed upsert would be silently wiped from memory
 *  (the "mapped ticker doesn't stick" bug). */
async function persistPricingTicker(symbol, pricingTicker) {
    if (!symbol || !pricingTicker || pricingTicker === symbol) return;
    const existing = state.assetDatabase[symbol] || {};
    state.assetDatabase[symbol] = { ...existing, ticker: symbol, pricingTicker };
    try {
        await saveAssetsToDB([{
            ticker: symbol,
            name: existing.name || symbol,
            stock_exchange: existing.stockExchange || '',
            sector: existing.sector || 'Other',
            currency: existing.currency || '',
            asset_type: existing.assetType || 'Stock',
            isin: existing.isin || null,
            pricing_ticker: pricingTicker,
        }]);
    } catch (err) { console.warn('persistPricingTicker failed:', err.message); }
}

/**
 * Set (or clear) the "kept at cost" flag on a holding and persist it immediately,
 * so the choice survives a reload and re-enabling pricing sticks. Updates both the
 * position and the asset DB. Exported for the per-card "re-enable pricing" action.
 */
export async function setUntracked(symbol, flag) {
    if (!symbol) return;
    const existing = state.assetDatabase[symbol] || {};
    state.assetDatabase[symbol] = { ...existing, ticker: symbol, untracked: !!flag };
    const pos = state.portfolio.find(p => p.symbol === symbol);
    if (pos) pos.untracked = !!flag;
    try {
        await saveAssetsToDB([{
            ticker: symbol,
            name: existing.name || symbol,
            stock_exchange: existing.stockExchange || '',
            sector: existing.sector || 'Other',
            currency: existing.currency || '',
            asset_type: existing.assetType || 'Stock',
            isin: existing.isin || null,
            untracked: !!flag,
        }]);
    } catch (err) { console.warn('setUntracked failed:', err.message); }
}

/**
 * Ask the resolve-tickers edge function for a priceable ticker for each symbol
 * that failed all price APIs. Returns { ORIGINAL_SYMBOL: SUGGESTED_TICKER }.
 * The caller must VALIDATE each suggestion against a price API before trusting it.
 */
async function resolveTickersViaAI(failedSymbols) {
    if (!state.supabaseUrl || !state.supabaseClient || !failedSymbols.length) return {};
    const items = failedSymbols.map(sym => {
        const pos = state.portfolio.find(p => p.symbol === sym);
        const meta = state.assetDatabase[sym] || {};
        return { currentSymbol: sym, name: (pos && pos.name) || meta.name || sym, isin: meta.isin || '' };
    });
    try {
        const { data: { session } } = await state.supabaseClient.auth.getSession();
        const response = await fetch(`${state.supabaseUrl}/functions/v1/resolve-tickers`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': state.supabaseAnonKey,
                ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
            },
            body: JSON.stringify({ items }),
        });
        const txt = await response.text();
        if (!response.ok) {
            console.warn('resolve-tickers failed:', response.status, txt.slice(0, 200));
            state.lastResolverError = `resolver unavailable (HTTP ${response.status})`;
            return {};
        }
        const data = JSON.parse(txt);
        const out = data.content?.find(c => c.type === 'text')?.text || '';
        // Gemini/Claude may wrap the JSON in prose or code fences — extract the array.
        const rows = extractLlmJsonArray(out);
        const map = {};
        rows.forEach(r => {
            const inp = String(r.input || '').toUpperCase();
            if (!inp) return;
            const price = Number(r.price);
            map[inp] = {
                ticker: r.ticker ? String(r.ticker).toUpperCase() : null,
                price: Number.isFinite(price) && price > 0 ? price : null,
            };
        });
        state.lastResolverError = null;   // reached the resolver successfully
        return map;
    } catch (err) {
        console.warn('resolveTickersViaAI error:', err.message);
        state.lastResolverError = `resolver error: ${err.message}`;
        return {};
    }
}

// ── Single Symbol Fetch ─────────────────────────────────────────────────────

export async function fetchStockPrice(symbol) {
    console.log(`Fetching price for ${symbol}...`);

    // TIER 1: Finnhub
    if (state.finnhubKey) {
        try {
            const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${state.finnhubKey}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                if (data.c && data.c > 0) {
                    console.log(`\u2713 ${symbol}: $${data.c} (Finnhub)`);
                    return { price: data.c, source: 'Finnhub', tier: 1, success: true };
                }
            }
        } catch (err) {
            console.log(`Finnhub failed for ${symbol}:`, err.message);
        }
    }

    // FMP / Alpha Vantage use FMP-style suffixes — remap Finnhub-style ones (.FRK→.DE)
    const pricingSymbol = normalizeForPricing(symbol);

    // TIER 2: FMP (skipped when the daily quota is near the cap)
    if (state.fmpKey && !fmpQuotaExhausted()) {
        try {
            const url = `https://financialmodelingprep.com/stable/quote-short?symbol=${pricingSymbol}&apikey=${state.fmpKey}`;
            console.log(`Trying FMP for ${symbol}...`);
            addFmpCalls(1);
            const response = await fetch(url);

            if (response.ok) {
                const data = await response.json();
                if (data.error) {
                    console.log(`FMP API error for ${symbol}:`, data.error);
                } else if (data && Array.isArray(data) && data.length > 0) {
                    const quote = data[0];
                    if (quote.price && quote.price > 0) {
                        console.log(`\u2713 ${symbol}: $${quote.price} (FMP)`);
                        return { price: quote.price, source: 'Financial Modeling Prep', tier: 2, success: true };
                    } else {
                        console.log(`FMP returned data but no valid price for ${symbol}`);
                    }
                } else {
                    console.log(`FMP returned empty/invalid data for ${symbol}`);
                }
            } else if (response.status === 403) {
                console.log(`FMP 403 for ${symbol}`);
                if (!window.fmpKeyWarningShown) {
                    window.fmpKeyWarningShown = true;
                    console.warn('\u26A0\uFE0F FMP 403 - Check API key');
                }
            } else if (response.status === 429) {
                console.log(`\u26A0\uFE0F FMP rate limit hit for ${symbol}`);
            } else {
                console.log(`FMP HTTP ${response.status} for ${symbol}`);
            }
        } catch (err) {
            console.log(`FMP failed for ${symbol}:`, err.message);
        }
        console.log(`FMP didn't find price for ${symbol}, trying Alpha Vantage...`);
    }

    // TIER 3: Alpha Vantage
    if (state.alphaVantageKey) {
        try {
            const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${pricingSymbol}&apikey=${state.alphaVantageKey}`;
            console.log(`Trying Alpha Vantage for ${symbol}...`);
            const response = await fetch(url);

            if (response.ok) {
                const data = await response.json();
                const quote = data['Global Quote'];
                if (quote && quote['05. price']) {
                    const price = parseFloat(quote['05. price']);
                    if (isNaN(price) || price <= 0) {
                        console.log(`Alpha Vantage returned invalid price "${quote['05. price']}" for ${symbol}`);
                    } else {
                        console.log(`\u2713 ${symbol}: $${price} (Alpha Vantage)`);
                        return { price, source: 'Alpha Vantage', tier: 3, success: true };
                    }
                } else {
                    console.log(`Alpha Vantage returned no price for ${symbol}`);
                }
                if (data['Note']) {
                    console.log('\u26A0\uFE0F Alpha Vantage rate limit hit');
                    return { price: null, source: 'Alpha Vantage', tier: 3, success: false, error: 'Rate limit (5/min) - wait 12s' };
                }
            } else {
                console.log(`Alpha Vantage HTTP ${response.status} for ${symbol}`);
            }
        } catch (err) {
            console.log(`Alpha Vantage failed for ${symbol}:`, err.message);
        }
    }

    // All tiers failed
    const availableAPIs = [state.finnhubKey && 'Finnhub', state.fmpKey && 'FMP', state.alphaVantageKey && 'AlphaV'].filter(Boolean);
    return {
        price: null,
        source: availableAPIs.length > 0 ? 'All APIs failed' : 'No API keys',
        tier: 0,
        success: false,
        error: availableAPIs.length > 0 ? 'Symbol not found in any API' : 'Configure API keys'
    };
}

// ── Asset Profile Fetching ──────────────────────────────────────────────────

export async function fetchAssetProfile(symbol) {
    console.log(`Fetching profile for ${symbol}...`);

    // Tier 1: Finnhub
    if (state.finnhubKey) {
        try {
            const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${state.finnhubKey}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                if (data && data.finnhubIndustry) {
                    console.log(`\u2713 ${symbol} profile from Finnhub: ${data.finnhubIndustry}`);
                    return {
                        sector: data.finnhubIndustry,
                        industry: data.finnhubIndustry,
                        currency: data.currency || null,
                        exchange: data.exchange || null,
                        source: 'Finnhub'
                    };
                }
            }
        } catch (err) {
            console.log(`Finnhub profile failed for ${symbol}:`, err.message);
        }
    }

    // Tier 2: FMP
    if (state.fmpKey) {
        try {
            const url = `https://financialmodelingprep.com/stable/profile?symbol=${encodeURIComponent(symbol)}&apikey=${state.fmpKey}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                if (data && Array.isArray(data) && data.length > 0 && data[0].sector) {
                    console.log(`\u2713 ${symbol} profile from FMP: ${data[0].sector}`);
                    return {
                        sector: data[0].sector,
                        industry: data[0].industry || null,
                        currency: data[0].currency || null,
                        exchange: data[0].exchangeShortName || null,
                        source: 'FMP'
                    };
                }
            }
        } catch (err) {
            console.log(`FMP profile failed for ${symbol}:`, err.message);
        }
    }

    // Tier 3: Alpha Vantage
    if (state.alphaVantageKey) {
        try {
            const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${state.alphaVantageKey}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                if (data && data.Sector && data.Sector !== 'None') {
                    console.log(`\u2713 ${symbol} profile from Alpha Vantage: ${data.Sector}`);
                    return {
                        sector: data.Sector,
                        industry: data.Industry || null,
                        currency: data.Currency || null,
                        exchange: data.Exchange || null,
                        source: 'Alpha Vantage'
                    };
                }
            }
        } catch (err) {
            console.log(`Alpha Vantage profile failed for ${symbol}:`, err.message);
        }
    }

    return null;
}

// ── Batch Price Fetching ────────────────────────────────────────────────────

export async function fetchMarketPrices(opts = {}) {
    // Only the manual "Update Prices" button is interactive; auto-refresh/import
    // callers pass nothing so the resolve dialog never pops on its own.
    const interactive = opts.interactive === true;
    // Auth guard: require login when Supabase is configured
    if (state.supabaseClient && !state.currentUser) {
        alert('\u{1F512} Please log in to fetch market prices.\n\nSign in with your email or Google account above.');
        return;
    }
    if (state.portfolio.length === 0) {
        alert('\u274C No positions in portfolio. Import your portfolio first.');
        return;
    }

    if (!state.alphaVantageKey && !state.finnhubKey && !state.fmpKey) {
        alert(
            '\uD83D\uDD11 API Keys Required\n\n' +
            'Click the "\uD83D\uDD11 API Keys" button to configure your API keys.\n\n' +
            'You need at least one free API key to fetch live prices.'
        );
        return;
    }

    const refreshBtn = document.getElementById('refreshBtn');
    if (!refreshBtn) {
        console.warn('fetchMarketPrices: #refreshBtn element not found');
        return;
    }
    const originalText = refreshBtn.textContent;
    refreshBtn.disabled = true;
    refreshBtn.textContent = '\u23F3 Fetching...';

    state.pricesLoading = true;
    // Snapshot prices before update so we can compute movers afterwards
    const previousPrices = { ...state.marketPrices };
    // Skip untracked holdings (manually kept under their ISIN, no live price).
    // A bare ISIN as the symbol means no ticker was mapped → never price-fetch it.
    const isIsinSymbol = s => /^[A-Z]{2}[A-Z0-9]{10}$/.test(String(s || ''));
    const symbols = [...new Set(state.portfolio.filter(p => !p.untracked && !isIsinSymbol(p.symbol)).map(p => p.symbol))];

    // Determine rate limiting
    let delayBetweenCalls = 1000;
    let apiInfo = '';

    if (state.finnhubKey) {
        delayBetweenCalls = 1000;
        apiInfo = 'Using Finnhub (primary)';
        if (state.fmpKey) apiInfo += ' + FMP (fallback #1)';
        if (state.alphaVantageKey) apiInfo += ' + Alpha Vantage (fallback #2)';
    } else if (state.fmpKey) {
        delayBetweenCalls = 500;
        apiInfo = 'Using FMP (primary - 250/day)';
        if (state.alphaVantageKey) apiInfo += ' + Alpha Vantage (fallback)';
    } else if (state.alphaVantageKey) {
        delayBetweenCalls = 12000;
        apiInfo = 'Using Alpha Vantage only (5 calls/min - slower)';
    }

    console.log('=== FETCH PRICES ===');
    console.log('API Configuration:', apiInfo);
    console.log('Symbols:', symbols);
    console.log('Total:', symbols.length);
    console.log('Delay between calls:', delayBetweenCalls + 'ms');

    const estimatedSeconds = Math.ceil((symbols.length * delayBetweenCalls) / 1000);
    const estimatedMinutes = Math.floor(estimatedSeconds / 60);
    const remainingSeconds = estimatedSeconds % 60;
    const timeEstimate = estimatedMinutes > 0
        ? `~${estimatedMinutes}m ${remainingSeconds}s`
        : `~${estimatedSeconds}s`;

    console.log('Estimated time:', timeEstimate);

    if (estimatedMinutes > 2) {
        const proceed = confirm(
            `\u23F1\uFE0F Estimated fetch time: ${timeEstimate}\n\n` +
            `Fetching ${symbols.length} symbols with current API configuration.\n\n` +
            `Tip: Add Finnhub API for faster updates (60 calls/min)\n\nContinue?`
        );
        if (!proceed) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = originalText;
            state.pricesLoading = false;
            return;
        }
    }

    let successCount = 0;
    let failCount = 0;
    let errors = [];
    state.lastResolverError = null;         // reset per run; set if the AI resolver errors
    state.fmpCallsToday = fmpCallsUsed();   // sync from persisted daily quota

    // The ticker we actually query for a holding (a learned pricingTicker wins).
    const queryOf = sym => (state.assetDatabase[sym] && state.assetDatabase[sym].pricingTicker) || sym;
    // Symbols whose price was actually (re)fetched this run — NOT the ones the
    // freshness cache skipped. Used to avoid snapshotting/re-saving on a run that
    // fetched nothing (e.g. a 2nd "Update Prices" click within the 15-min window).
    const refreshedThisRun = new Set();
    const recordSuccess = (sym, price, source) => {
        state.marketPrices[sym] = price;
        state.priceMetadata[sym] = { timestamp: new Date().toISOString(), source, success: true };
        refreshedThisRun.add(sym);
    };

    try {
        // Freshness cache: skip symbols already priced live within 15 min.
        const FRESH_WINDOW_MS = 15 * 60 * 1000;
        const nowMs = Date.now();
        let toFetch = symbols.filter(s => !isPriceFresh(state.priceMetadata[s], FRESH_WINDOW_MS, nowMs));
        console.log(`Fresh (skipped): ${symbols.length - toFetch.length} | To fetch: ${toFetch.length}`);

        // Phase A: one FMP batch pass over everything.
        if (state.fmpKey && toFetch.length) {
            refreshBtn.textContent = 'Batch...';
            const priced = await batchFetchFMP([...new Set(toFetch.map(queryOf))]);
            for (const sym of toFetch) {
                const price = priced[queryOf(sym).toUpperCase()];
                if (price > 0) recordSuccess(sym, price, 'Financial Modeling Prep (batch)');
            }
            // Only drop symbols Phase A actually priced THIS run. Filtering on
            // priceMetadata.success here reused the stale success:true left by
            // loadLatestPricesFromDB '(cached)' entries, silently skipping Phase B
            // for every DB-cached symbol — prices froze at the last cached values.
            toFetch = toFetch.filter(s => !refreshedThisRun.has(s));
            renderPortfolio();
        }

        // Phase B: per-symbol fallback (Finnhub/AV + alternatives) for misses, pooled.
        if (toFetch.length) {
            const concurrency = state.finnhubKey ? 2 : (state.fmpKey ? 5 : 1);
            let done = 0;
            await pooled(toFetch, async (symbol) => {
                try {
                    // fetchStockPrice already normalizes the FMP/AV suffix (.FRK→.DE);
                    // true misses go to the AI resolver (Phase C), not a costly FMP fan-out.
                    const result = await fetchStockPrice(queryOf(symbol));
                    if (result.success) {
                        recordSuccess(symbol, result.price, result.source + (result.alternativeSymbol ? ` (as ${result.alternativeSymbol})` : ''));
                    } else {
                        state.priceMetadata[symbol] = { timestamp: new Date().toISOString(), source: result.source, success: false, error: result.error };
                    }
                } catch (err) {
                    state.priceMetadata[symbol] = { timestamp: new Date().toISOString(), source: 'Error', success: false, error: err.message };
                }
                if (++done % 3 === 0) { refreshBtn.textContent = `${done}/${toFetch.length}`; renderPortfolio(); }
            }, concurrency, delayBetweenCalls);
            renderPortfolio();
        }

        // Phase C: AI web-search resolver (Gemini->Claude) for the remainder.
        // Returns { SYM: {ticker, price?} }. Validate each ticker via one batch call;
        // fall back to the AI's grounded price only when no API covers it.
        let aiSuggestions = {};
        const stillFailed = symbols.filter(s => !(state.priceMetadata[s] && state.priceMetadata[s].success));
        if (stillFailed.length > 0) {
            refreshBtn.textContent = 'AI...';
            const suggestions = await resolveTickersViaAI(stillFailed);
            aiSuggestions = suggestions;
            const suggestedTickers = Object.values(suggestions).map(x => x && x.ticker).filter(Boolean);
            // One batch validation pass — no-ops instantly on free plans where the
            // comma-list batch is unsupported, so per-symbol validation carries it.
            const validated = suggestedTickers.length ? await batchFetchFMP(suggestedTickers) : {};
            // Pool the per-symbol validations so a large AI batch doesn't validate
            // strictly sequentially (recordSuccess/persist mutate maps — pool-safe).
            await pooled(stillFailed, async (sym) => {
                const s = suggestions[sym.toUpperCase()];
                if (!s) return;
                if (s.ticker && s.ticker.toUpperCase() !== sym.toUpperCase()) {
                    let price = validated[s.ticker.toUpperCase()];
                    let source = `Financial Modeling Prep (AI: ${s.ticker})`;
                    if (!(price > 0)) {
                        const r = await fetchStockPrice(s.ticker);
                        if (r.success) { price = r.price; source = `${r.source} (AI: ${s.ticker})`; }
                    }
                    if (price > 0) { recordSuccess(sym, price, source); await persistPricingTicker(sym, s.ticker); return; }
                }
                if (Number(s.price) > 0) recordSuccess(sym, Number(s.price), 'Web search (AI)');
            }, state.finnhubKey ? 3 : 2, 300);
            renderPortfolio();
        }

        // ── Interactive resolve: let the user fix anything still unpriced ──
        // (manual "Update Prices" only). Validate every chosen ticker before it's
        // persisted — never trust an AI/user ticker blindly.
        if (interactive && _missingTickerResolver) {
            const unpriced = symbols.filter(s => !(state.priceMetadata[s] && state.priceMetadata[s].success));
            if (unpriced.length) {
                const items = unpriced.map(s => ({
                    symbol: s,
                    name: (state.portfolio.find(p => p.symbol === s) || {}).name || s,
                    suggestion: (aiSuggestions[s.toUpperCase()] || {}).ticker || '',
                }));
                let decisions = [];
                try { decisions = (await _missingTickerResolver(items)) || []; }
                catch (err) { console.warn('missing-ticker resolver error:', err.message); }
                for (const d of decisions) {
                    if (!d || !d.symbol) continue;
                    if (d.keepAtCost) {
                        await setUntracked(d.symbol, true);   // persisted so the choice survives reload
                    } else if (d.ticker) {
                        const r = await fetchStockPrice(d.ticker);   // validate before persist
                        if (r.success) {
                            recordSuccess(d.symbol, r.price, `${r.source} (user: ${d.ticker})`);
                            await setUntracked(d.symbol, false);      // mapping a ticker re-enables pricing
                            await persistPricingTicker(d.symbol, d.ticker);
                        } else {
                            // Validation failed — surface WHY instead of leaving the old
                            // "no price found" so the user knows their ticker was rejected.
                            state.priceMetadata[d.symbol] = {
                                timestamp: new Date().toISOString(),
                                source: `User entry (${d.ticker})`,
                                success: false,
                                error: r.error || `"${d.ticker}" returned no price`,
                            };
                        }
                    }
                }
                renderPortfolio();
            }
        }

        // Recompute counts/errors from final state (avoids races).
        successCount = 0; failCount = 0; errors = [];
        for (const s of symbols) {
            const meta = state.priceMetadata[s];
            if (meta && meta.success) successCount++;
            else { failCount++; errors.push(`${s}: ${(meta && meta.error) || 'no price found'}`); }
        }
        if (fmpCallsUsed() > FMP_DAILY_LIMIT * 0.8) console.warn(`FMP calls today ~ ${fmpCallsUsed()}/${FMP_DAILY_LIMIT}${fmpQuotaExhausted() ? ' — FMP paused, using Finnhub/AV/AI' : ''}`);

        console.log('\n=== FETCH COMPLETE ===');
        console.log('Success:', successCount);
        console.log('Failed:', failCount);

        renderPortfolio();

        // Compute & display top movers (only where we had a previous price to compare)
        if (refreshedThisRun.size > 0 && Object.keys(previousPrices).length > 0) {
            const now = new Date().toISOString();
            const movers = [];
            for (const [symbol, newPrice] of Object.entries(state.marketPrices)) {
                const prevPrice = previousPrices[symbol];
                if (prevPrice && prevPrice > 0 && newPrice > 0) {
                    const changePct = ((newPrice - prevPrice) / prevPrice) * 100;
                    const position = state.portfolio.find(p => p.symbol === symbol);
                    movers.push({
                        symbol,
                        name: position?.name || symbol,
                        prevPrice,
                        newPrice,
                        changePct
                    });
                }
            }
            movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
            state.lastMovers = { movers, updatedAt: now };
            renderMoversSection(movers, now);
            // Fire-and-forget AI explanation (non-blocking)
            analyzeMovers(movers).catch(err => console.warn('analyzeMovers error:', err));
        }

        // Post-fetch: save assets and prices to DB — only when we actually fetched
        // something this run (skip on a fully fresh-cached no-op run).
        if (refreshedThisRun.size > 0) {
            const assetRecords = state.portfolio.map(p => buildAssetRecord(p));
            await saveAssetsToDB(assetRecords);
            await loadAssetsFromDB();
            await enrichUnknownAssets();

            const priceRecords = [];
            const now = new Date().toISOString();
            for (const [symbol, price] of Object.entries(state.marketPrices)) {
                const meta = state.priceMetadata[symbol];
                if (refreshedThisRun.has(symbol) && meta && meta.success && !meta.source.includes('(cached)')) {
                    const assetInfo = state.assetDatabase[symbol.toUpperCase()];
                    priceRecords.push({
                        ticker: symbol.toUpperCase(),
                        price,
                        currency: assetInfo ? assetInfo.currency : 'USD',
                        source: meta.source,
                        fetchedAt: now
                    });
                }
            }
            if (priceRecords.length > 0) {
                await savePriceHistoryToDB(priceRecords);
            }
        }

        let msg = `\u2713 Price update complete!\n\n`;
        msg += `\u2713 Priced: ${successCount} of ${symbols.length} holdings\n`;
        // Tell the user when the FMP tier was paused for the day, so unpriced
        // holdings aren't a mystery (the quota guard is otherwise console-only).
        if (fmpQuotaExhausted() && state.fmpKey) {
            msg += `\n\u23f8 FMP daily limit reached (${fmpCallsUsed()}/${FMP_DAILY_LIMIT}) \u2014 used Finnhub/Alpha Vantage/AI for the rest. Resets tomorrow.\n`;
        }
        if (failCount > 0) {
            // Calm, non-alarming: these are shown at cost basis, not "failures".
            const noPrice = symbols.filter(s => !(state.priceMetadata[s] && state.priceMetadata[s].success));
            msg += `\n\u2139 ${failCount} holding${failCount !== 1 ? 's have' : ' has'} no live price and ${failCount !== 1 ? 'are' : 'is'} shown at cost basis:\n`;
            msg += noPrice.slice(0, 12).map(s => `\u2022 ${s}`).join('\n') + '\n';
            if (noPrice.length > 12) msg += `\u2022 \u2026and ${noPrice.length - 12} more\n`;
            // Distinguish a transient resolver outage from a genuine "no match".
            if (state.lastResolverError) {
                msg += `\n\u26a0\ufe0f The online ticker resolver was ${state.lastResolverError} \u2014 some of these may resolve if you retry in a bit.`;
            } else {
                msg += `\nTip: open one of these holdings to map a ticker your market-data provider recognizes (e.g. a US ADR or the right exchange suffix).`;
            }
        }

        if (refreshedThisRun.size > 0) {
            await savePortfolioSnapshot();
            msg += '\n\n\uD83D\uDCCA Portfolio snapshot saved to history!';
        }

        alert(msg);
    } catch (err) {
        console.error('=== FETCH PRICES ERROR ===');
        console.error('Error:', err);
        alert(`\u274C Error fetching prices: ${err.message}\n\nCheck console (F12) for details.`);
    } finally {
        state.pricesLoading = false;
        refreshBtn.disabled = false;
        refreshBtn.textContent = originalText;
    }
}

// ── Exchange Rate Fetching ──────────────────────────────────────────────────

/**
 * Fetch current exchange rates relative to baseCurrency.
 * Stores rates as: 1 unit of foreign currency = X units of baseCurrency.
 * Uses free API (no key required).
 */
export async function fetchExchangeRates() {
    const base = state.baseCurrency || 'EUR';
    console.log(`=== FETCHING EXCHANGE RATES (base: ${base}) ===`);

    try {
        const url = `https://open.er-api.com/v6/latest/${base}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (data.result === 'success' && data.rates) {
            // We need: 1 foreign = X base. API gives: 1 base = X foreign.
            // So invert: rate_to_base = 1 / rate_from_base
            const rates = {};
            for (const [currency, rateFromBase] of Object.entries(data.rates)) {
                if (rateFromBase > 0) {
                    rates[currency] = 1 / rateFromBase;
                }
            }
            // Base currency rate is always 1
            rates[base] = 1;
            state.exchangeRates = rates;
            state.exchangeRatesTimestamp = new Date().toISOString();
            localStorage.setItem('exchangeRates', JSON.stringify({ rates, timestamp: state.exchangeRatesTimestamp }));
            console.log(`\u2713 Loaded ${Object.keys(rates).length} exchange rates`);
            return true;
        }
        throw new Error('Invalid response format');
    } catch (err) {
        console.warn('Primary forex API failed:', err.message);
    }

    // Fallback: try loading cached rates from localStorage
    try {
        const cached = localStorage.getItem('exchangeRates');
        if (cached) {
            const parsed = JSON.parse(cached);
            if (!parsed || typeof parsed.rates !== 'object') {
                throw new Error('Invalid cached exchange rates format');
            }
            state.exchangeRates = parsed.rates;
            state.exchangeRatesTimestamp = parsed.timestamp || null;
            console.log('\u2713 Loaded cached exchange rates from localStorage');
            return true;
        }
    } catch (err) {
        console.warn('Failed to load cached exchange rates:', err);
    }

    console.warn('\u2717 No exchange rates available');
    return false;
}

/**
 * Get the exchange rate for a specific currency to base currency.
 * Returns 1 if same as base or rate unknown.
 */
export function getExchangeRate(fromCurrency) {
    if (!fromCurrency || fromCurrency === state.baseCurrency) return 1;
    return state.exchangeRates[fromCurrency] || 1;
}

// ── Historical FX (trade-date rates) ─────────────────────────────────────────
// Invested capital / income must convert at the rate WHEN ACQUIRED, per base.
// Each transaction gets fxRates = { EUR: r, USD: r } (1 unit of tx.currency = r
// units of base, at the trade date). Sourced from Frankfurter (ECB reference
// rates: free, keyless, CORS). Historical rates are immutable, so the per-date
// EUR-based table is cached in localStorage forever.

export const SUPPORTED_BASES = ['EUR', 'USD'];
const FX_HISTORY_KEY = 'fxHistoryEUR';   // { 'YYYY-MM-DD': { USD: 1.09, ... } }
const FX_MIN_DATE = '1999-01-04';        // ECB euro reference rates begin here

function loadFxHistoryCache() {
    try { return JSON.parse(localStorage.getItem(FX_HISTORY_KEY) || '{}'); }
    catch { return {}; }
}

/**
 * Ensure the local EUR-based history covers every date in `dates` (each date
 * resolvable directly or via previous-business-day walk-back). Fetches ONE
 * Frankfurter range request covering the missing span (range responses omit
 * weekends/holidays, hence the walk-back at lookup time). Returns the history.
 */
async function ensureFxHistoryForDates(dates) {
    const hist = loadFxHistoryCache();
    const missing = dates.filter(d => !lookupFxTableForDate(hist, d));
    if (missing.length === 0) return hist;
    missing.sort();
    // Pad the start so the earliest date's walk-back has business days to land on.
    const startPad = new Date(new Date(`${missing[0]}T00:00:00Z`).getTime() - 10 * 86400000)
        .toISOString().slice(0, 10);
    const start = startPad < FX_MIN_DATE ? FX_MIN_DATE : startPad;
    const end = missing[missing.length - 1];
    const url = `https://api.frankfurter.dev/v1/${start}..${end}?base=EUR&symbols=${SUPPORTED_BASES.filter(b => b !== 'EUR').join(',')}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Frankfurter HTTP ${resp.status}`);
    const data = await resp.json();
    if (data && data.rates && typeof data.rates === 'object') {
        Object.assign(hist, data.rates);
        try { localStorage.setItem(FX_HISTORY_KEY, JSON.stringify(hist)); } catch { /* quota */ }
    }
    return hist;
}

/**
 * Backfill fxRates on every transaction missing a rate for any supported base
 * ("fix all values already in the system"). Runs once per session on load
 * (opts.force bypasses, e.g. right after an import adds new dates). Mutates
 * state.transactions in place; the CALLER persists iff the return count > 0
 * (saveTransactionsToDB is delete-then-insert — never trigger it for nothing).
 * Never throws: on any failure the affected rows simply keep falling back to
 * live rates at display time.
 */
export async function backfillFxRates(opts = {}) {
    if (!opts.force && state._fxBackfillDone) return 0;
    state._fxBackfillDone = true;
    const today = new Date().toISOString().slice(0, 10);

    // Collect rows missing any supported base (per-base check: adding a new
    // base later re-triggers backfill for old rows automatically).
    const targets = [];
    const dates = new Set();
    for (const [symbol, txs] of Object.entries(state.transactions || {})) {
        for (const tx of txs) {
            const missing = SUPPORTED_BASES.some(b => !(tx.fxRates && Number.isFinite(Number(tx.fxRates[b])) && Number(tx.fxRates[b]) > 0));
            if (!missing) continue;
            // Resolve the currency NOW and persist it with the rates — if display
            // and backfill resolved a null currency differently, we'd persist an
            // inconsistency. Unresolvable rows stay on the live-rate fallback.
            const currency = tx.currency || getAssetCurrency(symbol);
            if (!currency) continue;
            let d = String(tx.date || '').slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
            if (d < FX_MIN_DATE) d = FX_MIN_DATE;
            if (d > today) d = today;
            targets.push({ tx, currency, date: d });
            dates.add(d);
        }
    }
    if (targets.length === 0) return 0;

    let hist;
    try { hist = await ensureFxHistoryForDates([...dates]); }
    catch (err) {
        console.warn('FX backfill: history fetch failed — rows stay on live-rate fallback:', err.message);
        return 0;
    }

    let changed = 0;
    for (const t of targets) {
        const table = lookupFxTableForDate(hist, t.date);
        if (!table) continue;
        const fx = deriveFxToBases(table, t.currency);
        if (!fx || SUPPORTED_BASES.some(b => fx[b] == null)) continue;
        t.tx.fxRates = fx;
        if (!t.tx.currency) t.tx.currency = t.currency;
        changed++;
    }
    if (changed) console.log(`✓ Backfilled trade-date FX rates for ${changed} transaction(s)`);
    return changed;
}

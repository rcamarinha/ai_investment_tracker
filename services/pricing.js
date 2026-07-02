/**
 * Pricing service — 3-tier API fallback strategy for fetching stock prices.
 *
 * Tier 1: Finnhub   (60 calls/min, no daily limit)
 * Tier 2: FMP       (250 calls/day, no per-min limit)
 * Tier 3: Alpha Vantage (5/min, 25/day)
 */

import state from './state.js';
import { buildAssetRecord } from './utils.js';
import { renderPortfolio, renderMoversSection } from './portfolio.js';
import { savePortfolioSnapshot } from './portfolio.js';
import {
    saveAssetsToDB, loadAssetsFromDB,
    savePriceHistoryToDB, enrichUnknownAssets
} from './storage.js';
import { analyzeMovers } from './analysis.js';

// ── Exchange-suffix normalization (kept in sync with src/portfolio.js) ───────
// Many stored tickers use Finnhub's `search` suffix format (.FRK/.AMS) which the
// price endpoints don't recognize. Map them to the FMP/Yahoo format.
const PRICING_SUFFIX_MAP = {
    FRK: 'DE', FRA: 'DE', ETR: 'DE', GER: 'DE', GF: 'DE', GY: 'DE',
    AMS: 'AS', AEX: 'AS',
    PAR: 'PA', EPA: 'PA', FP: 'PA',
    MCE: 'MC', MAD: 'MC', BME: 'MC',
    MIL: 'MI', BIT: 'MI', MTA: 'MI',
    LIS: 'LS', ELI: 'LS', EL: 'LS',
    BRU: 'BR', EBR: 'BR',
    SWX: 'SW', EBS: 'SW', VTX: 'SW', SIX: 'SW',
    LON: 'L', LSE: 'L',
    CPH: 'CO', STO: 'ST', HEL: 'HE', OSL: 'OL', VIE: 'VI', ICE: 'IC',
};
const EU_SUFFIXES = ['DE', 'PA', 'AS', 'MI', 'MC', 'SW', 'L', 'BR', 'LS', 'CO', 'ST', 'HE', 'OL'];

/** Normalize a ticker's exchange suffix to the price-API format. */
export function normalizeForPricing(symbol) {
    const s = String(symbol || '').toUpperCase();
    const dot = s.lastIndexOf('.');
    if (dot < 0) return s;
    const base = s.slice(0, dot);
    const mapped = PRICING_SUFFIX_MAP[s.slice(dot + 1)];
    return mapped ? `${base}.${mapped}` : s;
}

/** Parse an FMP quote-short batch array → { UPPER(symbol): price>0 }. Tolerant. */
function parseFmpBatchResponse(data) {
    const out = {};
    if (!Array.isArray(data)) return out;
    for (const row of data) {
        if (!row || !row.symbol) continue;
        const price = Number(row.price);
        if (Number.isFinite(price) && price > 0) out[String(row.symbol).toUpperCase()] = price;
    }
    return out;
}

/** True if we already hold a live (non-DB-cached) success newer than windowMs. */
function isPriceFresh(meta, windowMs, now = Date.now()) {
    if (!meta || !meta.success || !meta.timestamp) return false;
    if (typeof meta.source === 'string' && meta.source.includes('(cached)')) return false;
    const t = new Date(meta.timestamp).getTime();
    return Number.isFinite(t) && (now - t) <= windowMs;
}

/**
 * Fetch many tickers from FMP in one (chunked) call. Queries the price-API
 * normalized form and maps results back to the raw input symbol.
 * Returns { RAW_UPPER: price }. Never throws — returns {} on failure so the
 * caller falls back to per-symbol.
 */
export async function batchFetchFMP(symbols) {
    if (!state.fmpKey || state.fmpBatchUnsupported || !symbols || !symbols.length) return {};
    const result = {};
    const normToRaw = {};        // normalized query form → [raw...]
    const baseToRaw = {};        // base (no suffix) → [raw...] for resilient echo matching
    for (const raw of new Set(symbols.map(s => String(s).toUpperCase()))) {
        const norm = normalizeForPricing(raw);
        (normToRaw[norm] ||= []).push(raw);
        (baseToRaw[norm.split('.')[0]] ||= []).push(raw);
    }
    const normSyms = Object.keys(normToRaw);
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
            const json = await resp.json();
            if (json && !Array.isArray(json)) {           // { "Error Message": ... } etc.
                console.warn('FMP batch non-array response — treating comma-list as unsupported for this session.');
                state.fmpBatchUnsupported = true;
                continue;
            }
            state.fmpCallsToday = (state.fmpCallsToday || 0) + chunk.length; // FMP bills ≈ per symbol, only on success
            const priced = parseFmpBatchResponse(json);
            // If we asked for many but got ≤1 back, the plan likely ignores comma-lists.
            if (chunk.length > 3 && json.length <= 1) {
                console.warn(`FMP batch returned ${json.length} for ${chunk.length} symbols — disabling batch for this session (falling back to per-symbol/Finnhub).`);
                state.fmpBatchUnsupported = true;
            }
            for (const [sym, price] of Object.entries(priced)) {
                const targets = normToRaw[sym] || baseToRaw[sym.split('.')[0]] || [sym];
                targets.forEach(raw => { result[raw] = price; });
            }
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

/** Run at most `concurrency` promises at a time, with `delay` ms between waves. */
async function pooled(items, factory, concurrency, delay = 0) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const settled = await Promise.allSettled(items.slice(i, i + concurrency).map(factory));
        results.push(...settled);
        if (delay && i + concurrency < items.length) await new Promise(r => setTimeout(r, delay));
    }
    return results;
}

/** Remember the ticker that actually returned a price for a holding, so future
 *  refreshes fetch it directly instead of re-running the alternative search. */
function persistPricingTicker(symbol, pricingTicker) {
    if (!symbol || !pricingTicker || pricingTicker === symbol) return;
    const existing = state.assetDatabase[symbol] || {};
    state.assetDatabase[symbol] = { ...existing, ticker: symbol, pricingTicker };
    try {
        saveAssetsToDB([{
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
        if (!response.ok) { console.warn('resolve-tickers failed:', response.status, txt.slice(0, 200)); return {}; }
        const data = JSON.parse(txt);
        const out = data.content?.find(c => c.type === 'text')?.text || '';
        // Gemini/Claude may wrap the JSON in prose or code fences — extract the array.
        const cleaned = out.replace(/```json|```/g, '').trim();
        const start = cleaned.indexOf('['), end = cleaned.lastIndexOf(']');
        const jsonText = (start >= 0 && end > start) ? cleaned.slice(start, end + 1) : cleaned;
        let rows;
        try { rows = JSON.parse(jsonText); } catch { rows = []; }
        const map = {};
        (Array.isArray(rows) ? rows : []).forEach(r => {
            const inp = String(r.input || '').toUpperCase();
            if (!inp) return;
            const price = Number(r.price);
            map[inp] = {
                ticker: r.ticker ? String(r.ticker).toUpperCase() : null,
                price: Number.isFinite(price) && price > 0 ? price : null,
            };
        });
        return map;
    } catch (err) { console.warn('resolveTickersViaAI error:', err.message); return {}; }
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

    // TIER 2: FMP
    if (state.fmpKey) {
        try {
            const url = `https://financialmodelingprep.com/stable/quote-short?symbol=${pricingSymbol}&apikey=${state.fmpKey}`;
            console.log(`Trying FMP for ${symbol}...`);
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

// ── Alternative Ticker Formats (international stocks) ───────────────────────

export async function tryAlternativeFormats(originalSymbol, assetName) {
    const alternatives = [];

    console.log(`\n=== TRYING ALTERNATIVES FOR ${originalSymbol} (${assetName}) ===`);

    if (originalSymbol.includes('.')) {
        const base = originalSymbol.split('.')[0].toUpperCase();
        // 1) remap an unrecognized suffix to the price-API format (highest hit rate)
        const normalized = normalizeForPricing(originalSymbol);
        if (normalized !== originalSymbol.toUpperCase()) alternatives.push(normalized);
        // 2) fan the base across the common EU exchanges, then 3) the bare base (US/ADR)
        EU_SUFFIXES.forEach(sfx => alternatives.push(`${base}.${sfx}`));
        alternatives.push(base);
        console.log(`Alternatives for ${originalSymbol}: ${alternatives.join(', ')}`);
    } else {
        alternatives.push(`${originalSymbol}.PA`);
        alternatives.push(`${originalSymbol}.L`);
        alternatives.push(`${originalSymbol}.DE`);
        alternatives.push(`${originalSymbol}.MC`);
        alternatives.push(`${originalSymbol}.SW`);
        alternatives.push(`${originalSymbol}.AS`);
        alternatives.push(`${originalSymbol}.MI`);
        alternatives.push(`${originalSymbol}.BR`);
        alternatives.push(`${originalSymbol}.HE`);
        alternatives.push(`${originalSymbol}.ST`);
        alternatives.push(`${originalSymbol}.OL`);
        alternatives.push(`${originalSymbol}.CO`);
        console.log(`Alternatives: ${alternatives.join(', ')}`);
    }

    if (assetName && assetName !== originalSymbol) {
        const nameLower = assetName.toLowerCase();
        const smartMappings = {
            'cellnex': ['CLNX', 'CLNX.MC'],
            'covestro': ['1COV.DE', 'COV.DE'],
            'prosus': ['PRX.AS', 'PROSUS'],
            'adyen': ['ADYEN.AS', 'ADYEY'],
            'just eat': ['JET.L', 'TKWY.AS'],
            'moncler': ['MONC.MI', 'MONRF'],
            'sartorius': ['SRT.DE', 'SRT3.DE'],
            'nestle': ['NESN.SW', 'NSRGY'],
            'roche': ['ROG.SW', 'RHHBY'],
            'novartis': ['NOVN.SW', 'NVS'],
            'asml': ['ASML.AS', 'ASML'],
            'lvmh': ['MC.PA', 'LVMUY'],
            'hermes': ['RMS.PA', 'HESAY'],
            'schneider': ['SU.PA', 'SBGSF'],
            'totalenergies': ['TTE.PA', 'TTE'],
            'airbus': ['AIR.PA', 'EADSY']
        };

        for (const [key, tickers] of Object.entries(smartMappings)) {
            if (nameLower.includes(key)) {
                alternatives.push(...tickers);
                console.log(`Smart mapping found for "${key}": ${tickers.join(', ')}`);
                break;
            }
        }

        const baseName = assetName.split(/\s+(SA|NV|AG|SE|PLC|INC|CORP|LTD|SPA|ASA|OYJ)/i)[0].trim();
        const firstWord = baseName.split(' ')[0];
        if (firstWord.length >= 3 && firstWord.length <= 6) {
            alternatives.push(firstWord.toUpperCase());
            console.log(`Trying company name as ticker: ${firstWord.toUpperCase()}`);
        }
    }

    const uniqueAlternatives = [...new Set(alternatives)];
    console.log(`Trying ${uniqueAlternatives.length} alternatives in one FMP batch...`);

    // Try ALL candidates in a single FMP batch call (was: sequential, ~500ms each).
    const priced = await batchFetchFMP(uniqueAlternatives);
    for (const altSymbol of uniqueAlternatives) {          // priority order preserved
        const price = priced[altSymbol.toUpperCase()];
        if (price > 0) {
            console.log(`\u2713 SUCCESS with ${altSymbol} (FMP batch)`);
            return { price, source: 'Financial Modeling Prep', tier: 2, success: true, alternativeSymbol: altSymbol, originalSymbol };
        }
    }

    console.log(`\u2717 All alternatives failed for ${originalSymbol}`);
    return null;
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
    state.fmpCallsToday = state.fmpCallsToday || 0;

    // The ticker we actually query for a holding (a learned pricingTicker wins).
    const queryOf = sym => (state.assetDatabase[sym] && state.assetDatabase[sym].pricingTicker) || sym;
    const recordSuccess = (sym, price, source) => {
        state.marketPrices[sym] = price;
        state.priceMetadata[sym] = { timestamp: new Date().toISOString(), source, success: true };
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
            toFetch = toFetch.filter(s => !(state.priceMetadata[s] && state.priceMetadata[s].success));
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
            const validated = suggestedTickers.length ? await batchFetchFMP(suggestedTickers) : {};
            for (const sym of stillFailed) {
                const s = suggestions[sym.toUpperCase()];
                if (!s) continue;
                if (s.ticker && s.ticker.toUpperCase() !== sym.toUpperCase()) {
                    let price = validated[s.ticker.toUpperCase()];
                    let source = `Financial Modeling Prep (AI: ${s.ticker})`;
                    if (!(price > 0)) {
                        const r = await fetchStockPrice(s.ticker);
                        if (r.success) { price = r.price; source = `${r.source} (AI: ${s.ticker})`; }
                    }
                    if (price > 0) { recordSuccess(sym, price, source); persistPricingTicker(sym, s.ticker); continue; }
                }
                if (Number(s.price) > 0) recordSuccess(sym, Number(s.price), 'Web search (AI)');
            }
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
                        const meta = state.assetDatabase[d.symbol] || {};
                        state.assetDatabase[d.symbol] = { ...meta, ticker: d.symbol, untracked: true };
                        const pos = state.portfolio.find(p => p.symbol === d.symbol);
                        if (pos) pos.untracked = true;
                    } else if (d.ticker) {
                        const r = await fetchStockPrice(d.ticker);   // validate before persist
                        if (r.success) { recordSuccess(d.symbol, r.price, `${r.source} (user: ${d.ticker})`); persistPricingTicker(d.symbol, d.ticker); }
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
        if (state.fmpCallsToday > 200) console.warn(`FMP calls today ~ ${state.fmpCallsToday}/250`);

        console.log('\n=== FETCH COMPLETE ===');
        console.log('Success:', successCount);
        console.log('Failed:', failCount);

        renderPortfolio();

        // Compute & display top movers (only where we had a previous price to compare)
        if (successCount > 0 && Object.keys(previousPrices).length > 0) {
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

        // Post-fetch: save assets and prices to DB
        if (successCount > 0) {
            const assetRecords = state.portfolio.map(p => buildAssetRecord(p));
            await saveAssetsToDB(assetRecords);
            await loadAssetsFromDB();
            await enrichUnknownAssets();

            const priceRecords = [];
            const now = new Date().toISOString();
            for (const [symbol, price] of Object.entries(state.marketPrices)) {
                const meta = state.priceMetadata[symbol];
                if (meta && meta.success && !meta.source.includes('(cached)')) {
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
        if (failCount > 0) {
            // Calm, non-alarming: these are shown at cost basis, not "failures".
            const noPrice = symbols.filter(s => !(state.priceMetadata[s] && state.priceMetadata[s].success));
            msg += `\n\u2139 ${failCount} holding${failCount !== 1 ? 's have' : ' has'} no live price and ${failCount !== 1 ? 'are' : 'is'} shown at cost basis:\n`;
            msg += noPrice.slice(0, 12).map(s => `\u2022 ${s}`).join('\n') + '\n';
            if (noPrice.length > 12) msg += `\u2022 \u2026and ${noPrice.length - 12} more\n`;
            msg += `\nTip: open one of these holdings to map a ticker your market-data provider recognizes (e.g. a US ADR or the right exchange suffix).`;
        }

        if (successCount > 0) {
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

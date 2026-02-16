/**
 * Pricing service — 3-tier API fallback strategy for fetching stock prices.
 *
 * Tier 1: Finnhub   (60 calls/min, no daily limit)
 * Tier 2: FMP       (250 calls/day, no per-min limit)
 * Tier 3: Alpha Vantage (5/min, 25/day)
 */

import state from './state.js';
import { buildAssetRecord } from './utils.js';
import { renderPortfolio } from './portfolio.js';
import { savePortfolioSnapshot } from './portfolio.js';
import {
    saveAssetsToDB, loadAssetsFromDB,
    savePriceHistoryToDB, enrichUnknownAssets
} from './storage.js';

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

    // TIER 2: FMP
    if (state.fmpKey) {
        try {
            const url = `https://financialmodelingprep.com/stable/quote-short?symbol=${symbol}&apikey=${state.fmpKey}`;
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
            const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${state.alphaVantageKey}`;
            console.log(`Trying Alpha Vantage for ${symbol}...`);
            const response = await fetch(url);

            if (response.ok) {
                const data = await response.json();
                const quote = data['Global Quote'];
                if (quote && quote['05. price']) {
                    const price = parseFloat(quote['05. price']);
                    console.log(`\u2713 ${symbol}: $${price} (Alpha Vantage)`);
                    return { price, source: 'Alpha Vantage', tier: 3, success: true };
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
        const base = originalSymbol.split('.')[0];
        alternatives.push(base);
        console.log(`Alternative: ${base} (removed exchange suffix)`);
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
    console.log(`Total unique alternatives to try: ${uniqueAlternatives.length}`);

    for (const altSymbol of uniqueAlternatives) {
        console.log(`Trying: ${altSymbol}...`);
        const result = await fetchStockPrice(altSymbol);
        if (result.success) {
            console.log(`\u2713 SUCCESS with ${altSymbol}!`);
            return { ...result, alternativeSymbol: altSymbol, originalSymbol };
        }
        await new Promise(resolve => setTimeout(resolve, 500));
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

export async function fetchMarketPrices() {
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
    const originalText = refreshBtn.textContent;
    refreshBtn.disabled = true;
    refreshBtn.textContent = '\u23F3 Fetching...';

    state.pricesLoading = true;
    const symbols = [...new Set(state.portfolio.map(p => p.symbol))];

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
    const errors = [];

    try {
        for (let i = 0; i < symbols.length; i++) {
            const symbol = symbols[i];
            refreshBtn.textContent = `\u23F3 ${i + 1}/${symbols.length}`;

            try {
                let result = await fetchStockPrice(symbol);

                if (!result.success) {
                    console.log(`Primary failed for ${symbol}, trying alternatives...`);
                    const position = state.portfolio.find(p => p.symbol === symbol);
                    const assetName = position ? position.name : symbol;
                    const altResult = await tryAlternativeFormats(symbol, assetName);
                    if (altResult && altResult.success) {
                        result = altResult;
                        console.log(`\u2713 Found ${symbol} as ${altResult.alternativeSymbol}`);
                    }
                }

                if (result.success) {
                    state.marketPrices[symbol] = result.price;
                    state.priceMetadata[symbol] = {
                        timestamp: new Date().toISOString(),
                        source: result.source + (result.alternativeSymbol ? ` (as ${result.alternativeSymbol})` : ''),
                        success: true
                    };
                    successCount++;
                } else {
                    state.priceMetadata[symbol] = {
                        timestamp: new Date().toISOString(),
                        source: result.source,
                        success: false,
                        error: result.error
                    };
                    errors.push(`${symbol}: ${result.error}`);
                    failCount++;
                }

                if ((i + 1) % 5 === 0 || i === symbols.length - 1) {
                    renderPortfolio();
                }

                await new Promise(resolve => setTimeout(resolve, delayBetweenCalls));
            } catch (err) {
                console.error(`\u2717 ${symbol}: ${err.message}`);
                state.priceMetadata[symbol] = {
                    timestamp: new Date().toISOString(),
                    source: 'Error',
                    success: false,
                    error: err.message
                };
                errors.push(`${symbol}: ${err.message}`);
                failCount++;
            }
        }

        console.log('\n=== FETCH COMPLETE ===');
        console.log('Success:', successCount);
        console.log('Failed:', failCount);

        renderPortfolio();

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
        msg += `\u2713 Successfully fetched: ${successCount} symbols\n`;
        if (failCount > 0) {
            msg += `\u2717 Failed: ${failCount} symbols\n\n`;
            msg += `Failed symbols:\n`;
            errors.forEach(err => { msg += `\u2022 ${err}\n`; });
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
            const { rates, timestamp } = JSON.parse(cached);
            state.exchangeRates = rates;
            state.exchangeRatesTimestamp = timestamp;
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

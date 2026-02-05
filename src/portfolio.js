/**
 * Extracted pure-logic functions from index.html for testing.
 *
 * These mirror the implementations in index.html and should be kept in sync.
 * The single-file architecture of index.html is preserved — this module exists
 * solely to enable automated testing of the core business logic.
 */

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatCurrency(num) {
  return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPercent(num) {
  const sign = num >= 0 ? '+' : '';
  return sign + num.toFixed(2) + '%';
}

export function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Import Parsing ──────────────────────────────────────────────────────────

/**
 * Parse tab-separated portfolio data into position objects.
 * Mirrors the parsing logic in importPositions() from index.html.
 *
 * @param {string} text - Raw tab-separated text from spreadsheet paste
 * @returns {{ positions: Array, errors: string[] }}
 */
export function parsePortfolioText(text) {
  if (!text || !text.trim()) {
    return { positions: [], errors: ['No text provided'] };
  }

  const lines = text.split('\n');
  const positions = [];
  const errors = [];
  let isFirstLine = true;

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parts = trimmed.split('\t');

    // Skip header row
    if (isFirstLine && (trimmed.includes('Asset') || trimmed.includes('Ticker'))) {
      isFirstLine = false;
      return;
    }
    isFirstLine = false;

    if (parts.length >= 8) {
      // Full format: Asset, Ticker, Platform, Type, Units, TotalInvestment, ActiveInvestment, AvgUnitPrice
      const assetName = parts[0] ? parts[0].trim() : '';
      const symbol = parts[1] ? parts[1].trim().toUpperCase() : '';
      const platform = parts[2] ? parts[2].trim() : 'Unknown';
      const assetType = parts[3] ? parts[3].trim() : 'Other';
      const sharesRaw = parts[4] ? parts[4].trim() : '';
      const shares = parseFloat(sharesRaw);
      const priceRaw = parts[7] ? parts[7].trim() : '';
      const avgPrice = parseFloat(priceRaw.replace(/[$,]/g, ''));

      if (symbol && !isNaN(shares) && !isNaN(avgPrice) && shares > 0 && avgPrice > 0) {
        positions.push({ name: assetName, symbol, platform, type: assetType, shares, avgPrice });
      } else {
        const reason = [];
        if (!symbol) reason.push('missing ticker');
        if (isNaN(shares) || shares <= 0) reason.push(`invalid shares (${sharesRaw})`);
        if (isNaN(avgPrice) || avgPrice <= 0) reason.push(`invalid price (${priceRaw})`);
        errors.push(`Line ${idx + 1}: ${reason.join(', ')}`);
      }
    } else if (parts.length >= 3) {
      // Simple format: Ticker, Shares, Price
      const symbol = parts[0].toUpperCase();
      const shares = parseFloat(parts[1]);
      const avgPrice = parseFloat(parts[2].replace(/[$,]/g, ''));

      if (symbol && !isNaN(shares) && !isNaN(avgPrice)) {
        positions.push({ name: symbol, symbol, platform: 'Unknown', type: 'Stock', shares, avgPrice });
      } else {
        errors.push(`Line ${idx + 1}: Invalid simple format`);
      }
    } else {
      errors.push(`Line ${idx + 1}: Only ${parts.length} columns (need at least 3)`);
    }
  });

  return { positions, errors };
}

// ── Gain / Loss Calculations ────────────────────────────────────────────────

/**
 * Calculate portfolio totals from positions and current market prices.
 *
 * @param {Array<{shares: number, avgPrice: number, symbol: string}>} portfolio
 * @param {Object<string, number>} marketPrices - { symbol: currentPrice }
 * @returns {{ totalInvested: number, totalMarketValue: number, positionsWithPrices: number, gainLoss: number, gainLossPct: number }}
 */
export function calculatePortfolioTotals(portfolio, marketPrices = {}) {
  let totalInvested = 0;
  let totalMarketValue = 0;
  let positionsWithPrices = 0;

  portfolio.forEach((p) => {
    const invested = p.shares * p.avgPrice;
    totalInvested += invested;

    const currentPrice = marketPrices[p.symbol];
    if (currentPrice) {
      totalMarketValue += p.shares * currentPrice;
      positionsWithPrices++;
    } else {
      totalMarketValue += invested; // cost basis fallback
    }
  });

  const gainLoss = totalMarketValue - totalInvested;
  const gainLossPct = totalInvested > 0 ? (gainLoss / totalInvested) * 100 : 0;

  return { totalInvested, totalMarketValue, positionsWithPrices, gainLoss, gainLossPct };
}

/**
 * Calculate gain/loss for a single position.
 *
 * @param {{ shares: number, avgPrice: number, symbol: string }} position
 * @param {number|undefined} currentPrice
 * @returns {{ invested: number, marketValue: number, gainLoss: number, gainLossPct: number, hasPrice: boolean }}
 */
export function calculatePositionGainLoss(position, currentPrice) {
  const invested = position.shares * position.avgPrice;
  const hasPrice = currentPrice !== undefined;
  const marketValue = hasPrice ? position.shares * currentPrice : invested;
  const gainLoss = marketValue - invested;
  const gainLossPct = invested > 0 ? (gainLoss / invested) * 100 : 0;

  return { invested, marketValue, gainLoss, gainLossPct, hasPrice };
}

// ── Snapshot Creation ───────────────────────────────────────────────────────

/**
 * Build a snapshot object from current portfolio state.
 * Mirrors the calculation in savePortfolioSnapshot().
 *
 * @param {Array<{shares: number, avgPrice: number, symbol: string}>} portfolio
 * @param {Object<string, number>} marketPrices
 * @param {string} [timestamp] - ISO string; defaults to now
 * @returns {Object} snapshot
 */
export function buildSnapshot(portfolio, marketPrices, timestamp) {
  let totalInvested = 0;
  let totalMarketValue = 0;

  portfolio.forEach((p) => {
    const invested = p.shares * p.avgPrice;
    totalInvested += invested;

    const currentPrice = marketPrices[p.symbol];
    if (currentPrice) {
      totalMarketValue += p.shares * currentPrice;
    } else {
      totalMarketValue += invested;
    }
  });

  return {
    timestamp: timestamp || new Date().toISOString(),
    totalInvested,
    totalMarketValue,
    positionCount: portfolio.length,
    pricesAvailable: Object.keys(marketPrices).length,
  };
}

// ── Snapshot Deduplication & Merge ──────────────────────────────────────────

/**
 * Merge two snapshot arrays, deduplicating by timestamp, sorted chronologically.
 *
 * @param {Array} existing
 * @param {Array} incoming
 * @returns {Array} merged and sorted
 */
export function mergeSnapshots(existing, incoming) {
  const timestamps = new Set(existing.map((s) => s.timestamp));
  const merged = [...existing];

  incoming.forEach((s) => {
    if (!timestamps.has(s.timestamp)) {
      merged.push(s);
      timestamps.add(s.timestamp);
    }
  });

  merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return merged;
}

// ── Price Fetching (requires fetch to be injected / mocked) ─────────────────

/**
 * Build the list of alternative ticker symbols to try for international stocks.
 * Mirrors the logic in tryAlternativeFormats() but returns just the symbol list
 * (no API calls).
 *
 * @param {string} originalSymbol
 * @param {string} [assetName]
 * @returns {string[]} unique alternative symbols
 */
export function buildAlternativeSymbols(originalSymbol, assetName) {
  const alternatives = [];

  // Strategy 1: exchange suffixes
  if (originalSymbol.includes('.')) {
    const base = originalSymbol.split('.')[0];
    alternatives.push(base);
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
  }

  // Strategy 2: smart ticker lookup
  if (assetName && assetName !== originalSymbol) {
    const nameLower = assetName.toLowerCase();

    const smartMappings = {
      cellnex: ['CLNX', 'CLNX.MC'],
      covestro: ['1COV.DE', 'COV.DE'],
      prosus: ['PRX.AS', 'PROSUS'],
      adyen: ['ADYEN.AS', 'ADYEY'],
      'just eat': ['JET.L', 'TKWY.AS'],
      moncler: ['MONC.MI', 'MONRF'],
      sartorius: ['SRT.DE', 'SRT3.DE'],
      nestle: ['NESN.SW', 'NSRGY'],
      roche: ['ROG.SW', 'RHHBY'],
      novartis: ['NOVN.SW', 'NVS'],
      asml: ['ASML.AS', 'ASML'],
      lvmh: ['MC.PA', 'LVMUY'],
      hermes: ['RMS.PA', 'HESAY'],
      schneider: ['SU.PA', 'SBGSF'],
      totalenergies: ['TTE.PA', 'TTE'],
      airbus: ['AIR.PA', 'EADSY'],
    };

    for (const [key, tickers] of Object.entries(smartMappings)) {
      if (nameLower.includes(key)) {
        alternatives.push(...tickers);
        break;
      }
    }

    // Try first word of company name as ticker
    const baseName = assetName.split(/\s+(SA|NV|AG|SE|PLC|INC|CORP|LTD|SPA|ASA|OYJ)/i)[0].trim();
    const firstWord = baseName.split(' ')[0];
    if (firstWord.length >= 3 && firstWord.length <= 6) {
      alternatives.push(firstWord.toUpperCase());
    }
  }

  return [...new Set(alternatives)];
}

/**
 * Fetch a stock price using the 3-tier API fallback strategy.
 * Accepts a fetchFn parameter so the real `fetch` can be injected or mocked.
 *
 * @param {string} symbol
 * @param {{ finnhubKey?: string, fmpKey?: string, alphaVantageKey?: string }} keys
 * @param {Function} fetchFn - fetch implementation (defaults to globalThis.fetch)
 * @returns {Promise<{price: number|null, source: string, tier: number, success: boolean, error?: string}>}
 */
export async function fetchStockPrice(symbol, keys, fetchFn = globalThis.fetch) {
  // TIER 1: Finnhub
  if (keys.finnhubKey) {
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${keys.finnhubKey}`;
      const response = await fetchFn(url);

      if (response.ok) {
        const data = await response.json();
        if (data.c && data.c > 0) {
          return { price: data.c, source: 'Finnhub', tier: 1, success: true };
        }
      }
    } catch {
      // fall through
    }
  }

  // TIER 2: FMP
  if (keys.fmpKey) {
    try {
      const url = `https://financialmodelingprep.com/stable/quote-short?symbol=${symbol}&apikey=${keys.fmpKey}`;
      const response = await fetchFn(url);

      if (response.ok) {
        const data = await response.json();

        if (data.error) {
          // FMP returned an error message
        } else if (data && Array.isArray(data) && data.length > 0) {
          const quote = data[0];
          if (quote.price && quote.price > 0) {
            return { price: quote.price, source: 'Financial Modeling Prep', tier: 2, success: true };
          }
        }
      }
    } catch {
      // fall through
    }
  }

  // TIER 3: Alpha Vantage
  if (keys.alphaVantageKey) {
    try {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${keys.alphaVantageKey}`;
      const response = await fetchFn(url);

      if (response.ok) {
        const data = await response.json();
        const quote = data['Global Quote'];

        if (quote && quote['05. price']) {
          const price = parseFloat(quote['05. price']);
          return { price, source: 'Alpha Vantage', tier: 3, success: true };
        }

        if (data['Note']) {
          return {
            price: null,
            source: 'Alpha Vantage',
            tier: 3,
            success: false,
            error: 'Rate limit (5/min) - wait 12s',
          };
        }
      }
    } catch {
      // fall through
    }
  }

  // All tiers failed
  const availableAPIs = [keys.finnhubKey && 'Finnhub', keys.fmpKey && 'FMP', keys.alphaVantageKey && 'AlphaV'].filter(Boolean);
  return {
    price: null,
    source: availableAPIs.length > 0 ? 'All APIs failed' : 'No API keys',
    tier: 0,
    success: false,
    error: availableAPIs.length > 0 ? 'Symbol not found in any API' : 'Configure API keys',
  };
}

// ── Rate-Limit Delay Calculation ────────────────────────────────────────────

/**
 * Determine the delay between API calls based on available keys.
 * Mirrors the logic in fetchMarketPrices().
 *
 * @param {{ finnhubKey?: string, fmpKey?: string, alphaVantageKey?: string }} keys
 * @returns {{ delay: number, description: string }}
 */
export function calculateRateDelay(keys) {
  if (keys.finnhubKey) {
    let desc = 'Using Finnhub (primary)';
    if (keys.fmpKey) desc += ' + FMP (fallback #1)';
    if (keys.alphaVantageKey) desc += ' + Alpha Vantage (fallback #2)';
    return { delay: 1000, description: desc };
  }
  if (keys.fmpKey) {
    let desc = 'Using FMP (primary - 250/day)';
    if (keys.alphaVantageKey) desc += ' + Alpha Vantage (fallback)';
    return { delay: 500, description: desc };
  }
  if (keys.alphaVantageKey) {
    return { delay: 12000, description: 'Using Alpha Vantage only (5 calls/min - slower)' };
  }
  return { delay: 1000, description: 'No API keys configured' };
}

// ── Weight Calculation ───────────────────────────────────────────────────────

/**
 * Calculate the weight of a position within the portfolio.
 *
 * @param {number} positionMarketValue - Market value of the position
 * @param {number} totalMarketValue - Total portfolio market value
 * @returns {number} Weight as a percentage (0-100)
 */
export function calculatePositionWeight(positionMarketValue, totalMarketValue) {
  if (totalMarketValue <= 0) return 0;
  return (positionMarketValue / totalMarketValue) * 100;
}

/**
 * Calculate weights for all positions in a portfolio.
 *
 * @param {Array<{shares: number, avgPrice: number, symbol: string}>} portfolio
 * @param {Object<string, number>} marketPrices - { symbol: currentPrice }
 * @returns {Array<{symbol: string, marketValue: number, weight: number}>}
 */
export function calculatePortfolioWeights(portfolio, marketPrices = {}) {
  // Calculate total market value
  let totalMarketValue = 0;
  const positionValues = portfolio.map((p) => {
    const invested = p.shares * p.avgPrice;
    const currentPrice = marketPrices[p.symbol];
    const marketValue = currentPrice ? p.shares * currentPrice : invested;
    totalMarketValue += marketValue;
    return { symbol: p.symbol, marketValue };
  });

  // Calculate weights
  return positionValues.map((pv) => ({
    symbol: pv.symbol,
    marketValue: pv.marketValue,
    weight: calculatePositionWeight(pv.marketValue, totalMarketValue),
  }));
}

// ── Type Aggregation ─────────────────────────────────────────────────────────

/**
 * Aggregate portfolio value by asset type.
 *
 * @param {Array<{shares: number, avgPrice: number, symbol: string, type?: string}>} portfolio
 * @param {Object<string, number>} marketPrices - { symbol: currentPrice }
 * @returns {{ allocations: Array<{type: string, value: number, weight: number}>, totalMarketValue: number }}
 */
export function aggregateByType(portfolio, marketPrices = {}) {
  // Calculate total market value and aggregate by type
  let totalMarketValue = 0;
  const typeValues = {};

  portfolio.forEach((p) => {
    const invested = p.shares * p.avgPrice;
    const currentPrice = marketPrices[p.symbol];
    const marketValue = currentPrice ? p.shares * currentPrice : invested;
    totalMarketValue += marketValue;

    const assetType = p.type || 'Other';
    if (!typeValues[assetType]) {
      typeValues[assetType] = 0;
    }
    typeValues[assetType] += marketValue;
  });

  // Convert to array with weights, sorted by value descending
  const allocations = Object.entries(typeValues)
    .map(([type, value]) => ({
      type,
      value,
      weight: totalMarketValue > 0 ? (value / totalMarketValue) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  return { allocations, totalMarketValue };
}

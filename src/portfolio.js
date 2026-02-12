/**
 * Extracted pure-logic functions from index.html for testing.
 *
 * These mirror the implementations in index.html and should be kept in sync.
 * The single-file architecture of index.html is preserved — this module exists
 * solely to enable automated testing of the core business logic.
 */

// ── Formatting ──────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '\u20ac', GBP: '\u00a3', CHF: 'CHF ', SEK: 'kr ',
  NOK: 'kr ', DKK: 'kr ', CAD: 'C$', HKD: 'HK$', JPY: '\u00a5'
};

export function formatCurrency(num, currency) {
  const symbol = currency ? (CURRENCY_SYMBOLS[currency] || currency + ' ') : '\u20ac';
  return symbol + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// ── Column Alias Definitions ────────────────────────────────────────────────

const COLUMN_ALIASES = {
  symbol:   ['ticker', 'symbol', 'isin', 'code', 'instrument', 'stock', 'asset code', 'security', 'id', 'wkn', 'sedol', 'cusip', 'valor'],
  shares:   ['shares', 'quantity', 'qty', 'units', 'amount of shares', 'no. of shares', 'no of shares', 'number of shares', 'holding', 'holdings', 'position', 'volume', 'lots', 'antal'],
  price:    ['avg price', 'avg unit price', 'average price', 'avg cost', 'average cost', 'unit cost', 'cost price', 'purchase price', 'buy price', 'price per share', 'price/share', 'entry price', 'cost basis per share', 'cost/share', 'avg unit cost', 'prix moyen', 'snitt'],
  name:     ['asset', 'asset name', 'name', 'company', 'company name', 'description', 'security name', 'instrument name', 'stock name', 'product'],
  platform: ['platform', 'broker', 'account', 'exchange', 'market', 'provider', 'source', 'brokerage'],
  type:     ['type', 'asset type', 'security type', 'instrument type', 'asset class', 'category', 'class'],
  amount:   ['invested', 'invested amount', 'total invested', 'total cost', 'cost basis', 'total amount', 'amount invested', 'book value', 'book cost', 'market value', 'value', 'total value'],
};

// ── Flexible Parsing Helpers ────────────────────────────────────────────────

export function matchesRole(headerText, role) {
  const lower = headerText.toLowerCase().trim();
  const aliases = COLUMN_ALIASES[role];
  if (!aliases) return false;
  return aliases.some(alias => lower === alias || lower.replace(/[^a-z0-9 ]/g, '').trim() === alias);
}

export function isISIN(value) {
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(value);
}

export function detectSeparator(text) {
  const firstLines = text.split('\n').slice(0, 5).join('\n');
  const tabCount = (firstLines.match(/\t/g) || []).length;
  const semiCount = (firstLines.match(/;/g) || []).length;
  const pipeCount = (firstLines.match(/\|/g) || []).length;
  const commaCount = (firstLines.match(/,/g) || []).length;
  const counts = { '\t': tabCount, ';': semiCount, '|': pipeCount, ',': commaCount };
  const preferred = ['\t', ';', '|', ','];
  for (const sep of preferred) {
    if (counts[sep] >= 1) return sep;
  }
  return '\t';
}

export function parseFlexibleNumber(raw) {
  if (!raw) return NaN;
  let s = raw.trim();
  s = s.replace(/[$\u20ac\u00a3\u00a5C\$HK\$kr\s]/gi, '').trim();
  s = s.replace(/^\((.+)\)$/, '-$1');
  if (/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+(,\d{1,2})$/.test(s)) {
    s = s.replace(',', '.');
  }
  s = s.replace(/,/g, '');
  return parseFloat(s);
}

export function detectColumnMapping(headerParts) {
  const mapping = {};
  let matchCount = 0;

  headerParts.forEach((cell, idx) => {
    for (const role of Object.keys(COLUMN_ALIASES)) {
      if (!mapping[role] && matchesRole(cell, role)) {
        mapping[role] = idx;
        matchCount++;
        break;
      }
    }
  });

  if (mapping.symbol !== undefined && mapping.shares !== undefined) {
    return mapping;
  }
  return null;
}

// ── Import Parsing (Flexible) ──────────────────────────────────────────────

/**
 * Parse portfolio data from various formats into position objects.
 * Supports flexible column detection, multiple separators, ISIN identifiers,
 * European number formats, and optional price columns.
 *
 * @param {string} text - Raw text from spreadsheet paste
 * @returns {{ positions: Array, errors: string[], warnings: string[] }}
 */
export function parsePortfolioText(text) {
  if (!text || !text.trim()) {
    return { positions: [], errors: ['No text provided'], warnings: [] };
  }

  const separator = detectSeparator(text);
  const lines = text.split('\n');
  const positions = [];
  const errors = [];
  const warnings = [];

  // Step 1: Try to detect header row and column mapping
  let mapping = null;
  let dataStartIdx = 0;

  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const headerParts = trimmed.split(separator).map(s => s.trim());
    mapping = detectColumnMapping(headerParts);
    if (mapping) {
      dataStartIdx = i + 1;
      break;
    }
  }

  // Step 2: Fallback heuristic if no header detected
  if (!mapping) {
    let sampleLine = null;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t) { sampleLine = t; break; }
    }
    if (sampleLine) {
      const parts = sampleLine.split(separator).map(s => s.trim());
      if (parts.length >= 8) {
        mapping = { name: 0, symbol: 1, platform: 2, type: 3, shares: 4, price: 7 };
        const firstLower = sampleLine.toLowerCase();
        if (/\b(asset|ticker|symbol|name|shares|price|type|platform)\b/.test(firstLower)) {
          dataStartIdx = 1;
        }
      } else if (parts.length >= 2) {
        const colTypes = parts.map(p => {
          if (!p) return 'empty';
          if (!isNaN(parseFlexibleNumber(p))) return 'number';
          if (isISIN(p.toUpperCase())) return 'isin';
          if (/^[A-Z0-9.]{1,12}$/i.test(p)) return 'ticker';
          return 'text';
        });

        const symbolIdx = colTypes.findIndex(t => t === 'ticker' || t === 'isin');
        const numberIdxs = colTypes.reduce((acc, t, i) => { if (t === 'number') acc.push(i); return acc; }, []);

        if (symbolIdx >= 0 && numberIdxs.length >= 1) {
          mapping = { symbol: symbolIdx, shares: numberIdxs[0] };
          if (numberIdxs.length >= 2) mapping.price = numberIdxs[1];
          const nameIdx = colTypes.findIndex((t, i) => (t === 'text') && i !== symbolIdx);
          if (nameIdx >= 0) mapping.name = nameIdx;
        }

        const firstLower = sampleLine.toLowerCase();
        if (/\b(asset|ticker|symbol|isin|name|shares|price|quantity|units)\b/.test(firstLower)) {
          const headerParts = sampleLine.split(separator).map(s => s.trim());
          mapping = detectColumnMapping(headerParts);
          dataStartIdx = 1;
        }
      }
    }
  }

  if (!mapping || mapping.symbol === undefined || mapping.shares === undefined) {
    return { positions: [], errors: ['Could not detect column layout — need at least a Ticker/Symbol/ISIN column and a Quantity/Shares column'], warnings: [] };
  }

  // Step 3: Parse data rows
  for (let idx = dataStartIdx; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!trimmed) continue;

    // Split the original line (not trimmed) to preserve empty leading/trailing fields
    const parts = lines[idx].split(separator).map(s => s.trim());
    const lineNum = idx + 1;

    const rawSymbol = parts[mapping.symbol] ? parts[mapping.symbol].trim() : '';
    const rawShares = parts[mapping.shares] ? parts[mapping.shares].trim() : '';
    const rawPrice = mapping.price !== undefined && parts[mapping.price] ? parts[mapping.price].trim() : '';
    const rawName = mapping.name !== undefined && parts[mapping.name] ? parts[mapping.name].trim() : '';
    const rawPlatform = mapping.platform !== undefined && parts[mapping.platform] ? parts[mapping.platform].trim() : '';
    const rawType = mapping.type !== undefined && parts[mapping.type] ? parts[mapping.type].trim() : '';
    const rawAmount = mapping.amount !== undefined && parts[mapping.amount] ? parts[mapping.amount].trim() : '';

    if (!rawSymbol) {
      errors.push(`Line ${lineNum}: Missing ticker/symbol/ISIN`);
      continue;
    }

    const shares = parseFlexibleNumber(rawShares);
    if (isNaN(shares) || shares <= 0) {
      errors.push(`Line ${lineNum}: Invalid quantity "${rawShares}" for ${rawSymbol}`);
      continue;
    }

    let symbol = rawSymbol.toUpperCase();

    let avgPrice = parseFlexibleNumber(rawPrice);
    let needsCurrentPrice = false;

    if ((isNaN(avgPrice) || avgPrice <= 0) && rawAmount) {
      const totalAmount = parseFlexibleNumber(rawAmount);
      if (!isNaN(totalAmount) && totalAmount > 0) {
        avgPrice = totalAmount / shares;
      }
    }

    if (isNaN(avgPrice) || avgPrice <= 0) {
      avgPrice = 0;
      needsCurrentPrice = true;
      warnings.push(`${rawSymbol}: No acquisition price — will use current market price`);
    }

    let assetType = rawType || 'Stock';
    const typeMap = { 'etf': 'ETF', 'reit': 'REIT', 'crypto': 'Crypto', 'stock': 'Stock', 'bond': 'Bond', 'fund': 'ETF', 'equity': 'Stock', 'common stock': 'Stock', 'etp': 'ETF' };
    assetType = typeMap[assetType.toLowerCase()] || assetType;

    positions.push({
      name: rawName || symbol,
      symbol,
      platform: rawPlatform || 'Unknown',
      type: assetType,
      shares,
      avgPrice,
      ...(needsCurrentPrice ? { _needsCurrentPrice: true } : {}),
      ...(isISIN(symbol) ? { _resolvedFrom: symbol } : {}),
    });
  }

  return { positions, errors, warnings };
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

// ── Position Management (pure logic) ─────────────────────────────────────────

/**
 * Add a new position to a portfolio array (immutable — returns new array).
 * If a closed position (shares=0) for the symbol already exists, it is reactivated.
 *
 * @param {Array} portfolio - Current portfolio
 * @param {{ symbol: string, name?: string, platform?: string, type?: string, shares: number, totalAmount: number, date: string }} params
 * @returns {{ portfolio: Array, transaction: Object|null, error?: string }}
 */
export function addPosition(portfolio, { symbol, name, platform, type, shares, totalAmount, date }) {
  const pricePerShare = totalAmount / shares;
  const existing = portfolio.find(p => p.symbol === symbol);

  let newPortfolio;
  if (existing && existing.shares > 0) {
    return { portfolio, transaction: null, error: `Active position for ${symbol} already exists` };
  } else if (existing) {
    newPortfolio = portfolio.map(p =>
      p.symbol === symbol
        ? { ...p, shares, avgPrice: pricePerShare, name: name || p.name, type: type || p.type, platform: platform || p.platform }
        : p
    );
  } else {
    newPortfolio = [...portfolio, {
      name: name || symbol,
      symbol,
      platform: platform || 'Unknown',
      type: type || 'Stock',
      shares,
      avgPrice: pricePerShare
    }];
  }

  const transaction = { type: 'buy', shares, price: pricePerShare, date, totalAmount };
  return { portfolio: newPortfolio, transaction };
}

/**
 * Add more shares to an existing position (buy). Recalculates weighted average price.
 *
 * @param {Array} portfolio
 * @param {string} symbol
 * @param {number} shares
 * @param {number} totalAmount
 * @param {string} date
 * @returns {{ portfolio: Array, transaction: Object|null, error?: string }}
 */
export function buyMoreShares(portfolio, symbol, shares, totalAmount, date) {
  const position = portfolio.find(p => p.symbol === symbol);
  if (!position) {
    return { portfolio, transaction: null, error: `Position ${symbol} not found` };
  }

  const pricePerShare = totalAmount / shares;
  const oldTotal = position.shares * position.avgPrice;
  const newTotal = shares * pricePerShare;
  const newShares = position.shares + shares;
  const newAvgPrice = (oldTotal + newTotal) / newShares;

  const newPortfolio = portfolio.map(p =>
    p.symbol === symbol
      ? { ...p, shares: newShares, avgPrice: newAvgPrice }
      : p
  );

  const transaction = { type: 'buy', shares, price: pricePerShare, date, totalAmount };
  return { portfolio: newPortfolio, transaction };
}

/**
 * Sell shares from an existing position. Records cost basis and realized P&L.
 * If all shares are sold, position becomes inactive (shares=0).
 *
 * @param {Array} portfolio
 * @param {string} symbol
 * @param {number} shares
 * @param {number} totalAmount
 * @param {string} date
 * @returns {{ portfolio: Array, transaction: Object|null, error?: string }}
 */
export function sellShares(portfolio, symbol, shares, totalAmount, date) {
  const position = portfolio.find(p => p.symbol === symbol);
  if (!position) {
    return { portfolio, transaction: null, error: `Position ${symbol} not found` };
  }
  if (shares > position.shares) {
    return { portfolio, transaction: null, error: `Cannot sell ${shares} shares, only have ${position.shares}` };
  }

  const pricePerShare = totalAmount / shares;
  const costBasis = position.avgPrice;
  const realizedGainLoss = (pricePerShare - costBasis) * shares;
  const remainingShares = position.shares - shares;

  const newPortfolio = portfolio.map(p =>
    p.symbol === symbol
      ? { ...p, shares: remainingShares }
      : p
  );

  const transaction = {
    type: 'sell', shares, price: pricePerShare, date, totalAmount,
    costBasis, realizedGainLoss
  };
  return { portfolio: newPortfolio, transaction };
}

/**
 * Delete a position entirely from the portfolio.
 *
 * @param {Array} portfolio
 * @param {string} symbol
 * @returns {{ portfolio: Array, removed: boolean }}
 */
export function removePosition(portfolio, symbol) {
  const exists = portfolio.some(p => p.symbol === symbol);
  if (!exists) return { portfolio, removed: false };
  return { portfolio: portfolio.filter(p => p.symbol !== symbol), removed: true };
}

/**
 * Filter portfolio into active (shares > 0) and inactive (shares <= 0) positions.
 *
 * @param {Array} portfolio
 * @returns {{ active: Array, inactive: Array }}
 */
export function partitionPositions(portfolio) {
  const active = portfolio.filter(p => p.shares > 0);
  const inactive = portfolio.filter(p => p.shares <= 0);
  return { active, inactive };
}

/**
 * Record a transaction into a transactions map (immutable).
 *
 * @param {Object} transactions - { SYMBOL: [tx, ...] }
 * @param {string} symbol
 * @param {Object} tx
 * @returns {Object} new transactions map
 */
export function recordTransaction(transactions, symbol, tx) {
  const existing = transactions[symbol] || [];
  return { ...transactions, [symbol]: [...existing, tx] };
}

/**
 * Collect all sell transactions across all symbols, sorted by date descending.
 *
 * @param {Object} transactions - { SYMBOL: [tx, ...] }
 * @returns {Array<Object>} sorted sell transactions with symbol field added
 */
export function collectSalesHistory(transactions) {
  const sales = [];
  for (const [symbol, txs] of Object.entries(transactions)) {
    txs.filter(t => t.type === 'sell').forEach(t => {
      sales.push({ symbol, ...t });
    });
  }
  sales.sort((a, b) => new Date(b.date) - new Date(a.date));
  return sales;
}

/**
 * Calculate total realized P&L from sell transactions.
 *
 * @param {Array<Object>} sales - Array of sell transactions with realizedGainLoss field
 * @returns {number}
 */
export function calculateTotalRealizedPnL(sales) {
  return sales.reduce((sum, s) => sum + (s.realizedGainLoss || 0), 0);
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

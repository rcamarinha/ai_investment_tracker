/**
 * Portfolio service — rendering, import, snapshots, history, and position management.
 */

import state from './state.js';
import { escapeHTML, formatCurrency, formatPercent, buildAssetRecord, normalizeAssetType } from './utils.js';
import { getSector } from '../data/sectors.js';
import { renderAllocationCharts } from './ui.js';
import { saveSnapshotToDB, clearHistoryFromDB, savePortfolioDB,
         saveTransactionsToDB, deleteTransactionsForSymbol,
         saveAssetsToDB, loadAssetsFromDB, deleteSnapshotFromDB } from './storage.js';
import { fetchMarketPrices, fetchStockPrice, getExchangeRate } from './pricing.js';
import { getAssetCurrency, toBaseCurrency } from './utils.js';

// ── Auth Guard ──────────────────────────────────────────────────────────────

/** Check if user is logged in (when Supabase is configured). Returns true if OK to proceed. */
function requireAuth(actionName) {
    // If Supabase is not configured, allow everything (local-only mode)
    if (!state.supabaseClient) return true;
    if (state.currentUser) return true;
    alert(`\u{1F512} Please log in to ${actionName}.\n\nSign in with your email or Google account above.`);
    return false;
}

// ── Portfolio Rendering ─────────────────────────────────────────────────────

export function renderPortfolio() {
    const positionsDiv = document.getElementById('positions');

    // Separate active and inactive positions
    const activePositions = state.portfolio.filter(p => p.shares > 0);
    const inactivePositions = state.portfolio.filter(p => p.shares <= 0);

    const base = state.baseCurrency || 'EUR';
    let totalInvestedBase = 0;  // In base currency (EUR)
    let totalMarketValueBase = 0;
    let positionsWithPrices = 0;

    activePositions.forEach(p => {
        const currency = getAssetCurrency(p.symbol);
        const investedNative = p.shares * p.avgPrice;

        // Invested in base currency: use transaction-stored rates if available, else current rate
        const txs = state.transactions[p.symbol];
        if (txs && txs.length > 0) {
            // Sum buy transactions converted at their historical rates
            let investedBase = 0;
            let soldBase = 0;
            txs.forEach(tx => {
                const rate = tx.exchangeRate || getExchangeRate(tx.currency || currency);
                if (tx.type === 'buy') investedBase += tx.totalAmount * rate;
                else if (tx.type === 'sell') soldBase += tx.totalAmount * rate;
            });
            // Invested = total buys minus total sells (in base), proportional to remaining shares
            const totalBuyShares = txs.filter(t => t.type === 'buy').reduce((s, t) => s + t.shares, 0);
            const totalSellShares = txs.filter(t => t.type === 'sell').reduce((s, t) => s + t.shares, 0);
            const remainingRatio = totalBuyShares > 0 ? p.shares / totalBuyShares : 1;
            totalInvestedBase += investedBase * remainingRatio;
        } else {
            // No transactions: fallback to current rate
            totalInvestedBase += toBaseCurrency(investedNative, currency);
        }

        // Market value in base currency: always use current exchange rate
        const currentPrice = state.marketPrices[p.symbol];
        if (currentPrice) {
            totalMarketValueBase += toBaseCurrency(p.shares * currentPrice, currency);
            positionsWithPrices++;
        } else {
            totalMarketValueBase += toBaseCurrency(investedNative, currency);
        }
    });

    console.log('=== RENDER PORTFOLIO DEBUG ===');
    console.log('Rendering portfolio:', activePositions.length, 'active,', inactivePositions.length, 'closed');
    console.log('Positions with live prices:', positionsWithPrices);
    console.log('Totals in', base, '- Invested:', totalInvestedBase.toFixed(2), 'Market:', totalMarketValueBase.toFixed(2));

    // Update header
    const portfolioHeader = document.querySelector('.portfolio-header');
    const totalGainLoss = totalMarketValueBase - totalInvestedBase;
    const totalGainLossPct = totalInvestedBase > 0 ? (totalGainLoss / totalInvestedBase) * 100 : 0;
    const gainLossColor = totalGainLoss >= 0 ? '#4ade80' : '#f87171';
    const hasRates = Object.keys(state.exchangeRates).length > 0;

    const inactiveToggle = inactivePositions.length > 0
        ? `<span class="inactive-toggle" onclick="toggleInactivePositions()">${state.showInactivePositions ? 'Hide' : 'Show'} ${inactivePositions.length} closed position${inactivePositions.length !== 1 ? 's' : ''}</span>`
        : '';

    portfolioHeader.innerHTML = `
        <div>
            <h2 style="margin-bottom: 5px;">\uD83D\uDCBC Your Portfolio</h2>
            <div style="font-size: 13px; color: #94a3b8;">
                ${activePositions.length} active position${activePositions.length !== 1 ? 's' : ''}
                ${Object.keys(state.marketPrices).length > 0 ? ` \u2022 ${positionsWithPrices} with live prices` : ' \u2022 Click "Update Prices" for live market data'}
                ${hasRates ? ` \u2022 FX rates loaded` : ''}
                ${inactiveToggle}
                ${state.selectedSector ? `<span style="color: #60a5fa; margin-left: 8px;">Filtered: ${escapeHTML(state.selectedSector)} <span style="cursor:pointer; color:#f87171;" role="button" tabindex="0" onclick="toggleSectorFilter('${escapeHTML(state.selectedSector).replace(/'/g, "\\'")}')">✕</span></span>` : ''}
            </div>
        </div>
        <div class="total-value">
            <div style="color: #94a3b8; font-size: 12px;">Total Invested (${escapeHTML(base)})</div>
            <div style="color: #cbd5e1; font-size: 16px; margin-bottom: 5px;">${formatCurrency(totalInvestedBase, base)}</div>
            <div style="color: #94a3b8; font-size: 12px;">Market Value (${escapeHTML(base)})</div>
            <div style="color: ${gainLossColor}; font-size: 24px; font-weight: bold;">${formatCurrency(totalMarketValueBase, base)}</div>
            ${totalInvestedBase > 0 ? `
                <div style="color: ${gainLossColor}; font-size: 14px; margin-top: 5px;">
                    ${formatCurrency(totalGainLoss, base)} (${formatPercent(totalGainLossPct)})
                </div>
            ` : ''}
        </div>
    `;

    if (state.portfolio.length === 0) {
        positionsDiv.innerHTML = '<div style="text-align: center; color: #64748b; padding: 40px;">No positions yet. Click "Add Position" or import your portfolio to get started.</div>';
        return;
    }

    // Build display list: active + optionally inactive, filtered by sector
    let displayPositions = state.showInactivePositions
        ? [...activePositions, ...inactivePositions]
        : [...activePositions];

    if (state.selectedSector) {
        displayPositions = displayPositions.filter(p => getSector(p.symbol) === state.selectedSector);
    }

    let html = `
        <div class="position-header-row">
            <div>Symbol</div>
            <div>Asset</div>
            <div class="pos-hide-mobile">Type</div>
            <div class="pos-right">Position</div>
            <div class="pos-right">Market Value</div>
            <div class="pos-right pos-hide-mobile">P&L</div>
            <div>Actions</div>
        </div>
    `;

    html += displayPositions.map((pos) => {
        const isActive = pos.shares > 0;
        const currency = getAssetCurrency(pos.symbol);
        const invested = pos.shares * pos.avgPrice; // native currency
        const currentPrice = state.marketPrices[pos.symbol];
        const hasPrice = currentPrice !== undefined;
        const marketValue = hasPrice ? pos.shares * currentPrice : invested; // native currency
        const gainLoss = marketValue - invested; // native currency P&L
        const gainLossPct = invested > 0 ? (gainLoss / invested) * 100 : 0;
        // Weight uses base currency conversion
        const marketValueBase = toBaseCurrency(marketValue, currency);
        const weight = totalMarketValueBase > 0 ? (marketValueBase / totalMarketValueBase) * 100 : 0;
        const color = gainLoss >= 0 ? '#4ade80' : '#f87171';

        // Price metadata
        const metadata = state.priceMetadata[pos.symbol];
        let statusFlag = '\u23F3';
        let statusColor = '#f59e0b';
        let statusText = 'Pending';
        let timestampText = '';

        if (metadata) {
            if (metadata.success) {
                statusFlag = '\u2713';
                statusColor = '#4ade80';
                statusText = metadata.source;
                const date = new Date(metadata.timestamp);
                const now = new Date();
                const diffMins = Math.floor((now - date) / 60000);
                if (diffMins < 1) timestampText = 'Just now';
                else if (diffMins < 60) timestampText = `${diffMins}m ago`;
                else {
                    const diffHours = Math.floor(diffMins / 60);
                    if (diffHours < 24) timestampText = `${diffHours}h ago`;
                    else timestampText = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }
            } else {
                statusFlag = '\u2717';
                statusColor = '#f87171';
                statusText = metadata.error || 'Failed';
                timestampText = 'Failed to fetch';
            }
        }

        const escapedSymbol = escapeHTML(pos.symbol).replace(/'/g, "\\'");
        const sector = getSector(pos.symbol);
        const typeColor = ({ 'ETF': '#8b5cf6', 'REIT': '#ec4899', 'Stock': '#3b82f6', 'Crypto': '#f59e0b' }[pos.type] || '#94a3b8');

        // Action buttons: active positions get refresh/buy/sell/delete; inactive get just delete
        const actionButtons = isActive
            ? `<button class="position-action-btn action-refresh" title="Refresh price" onclick="refreshSinglePrice('${escapedSymbol}')">&#x21bb;</button>
               <button class="position-action-btn action-buy" title="Add shares" onclick="showEditPositionDialog('${escapedSymbol}','buy')">+</button>
               <button class="position-action-btn action-sell" title="Sell shares" onclick="showEditPositionDialog('${escapedSymbol}','sell')">-</button>
               <button class="position-action-btn action-del" title="Delete position" onclick="deletePosition('${escapedSymbol}')">&#x2717;</button>`
            : `<button class="position-action-btn action-del" title="Delete position" onclick="deletePosition('${escapedSymbol}')">&#x2717;</button>`;

        return `
        <div class="position${isActive ? '' : ' inactive'}">
            <div class="pos-cell position-symbol">
                <div style="display: flex; align-items: center; gap: 4px;">
                    <span style="color: ${statusColor}; font-size: 12px;" title="${escapeHTML(statusText)}">${statusFlag}</span>
                    <span>${escapeHTML(pos.symbol)}</span>
                </div>
                <div class="pos-secondary">${timestampText ? escapeHTML(timestampText) : ''}</div>
            </div>
            <div class="pos-cell" title="${escapeHTML(pos.name || pos.symbol)}${pos.platform ? '\nPlatform: ' + escapeHTML(pos.platform) : ''}${sector !== 'Other' ? '\nSector: ' + escapeHTML(sector) : ''}">
                <div style="font-size: 12px; color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    ${pos.name ? escapeHTML(pos.name.length > 35 ? pos.name.substring(0, 32) + '...' : pos.name) : escapeHTML(pos.symbol)}
                </div>
                <div class="pos-secondary">${pos.platform && pos.platform !== 'Unknown' ? escapeHTML(pos.platform) : ''}${pos.platform && pos.platform !== 'Unknown' && sector !== 'Other' ? ' \u2022 ' : ''}${sector !== 'Other' ? escapeHTML(sector) : ''}</div>
            </div>
            <div class="pos-cell pos-hide-mobile">
                <div style="font-size: 11px; color: ${typeColor}; font-weight: 600;">${escapeHTML(pos.type || 'Stock')}</div>
                <div class="pos-secondary">${escapeHTML(currency)}</div>
            </div>
            <div class="pos-cell pos-right">
                <div>${isActive ? pos.shares + ' shares' : '\u2014'}</div>
                <div class="pos-secondary">${isActive ? 'avg ' + formatCurrency(pos.avgPrice, currency) : 'Closed'}</div>
            </div>
            <div class="pos-cell pos-right">
                <div style="color: ${hasPrice ? '#60a5fa' : '#f59e0b'}; font-weight: bold;">
                    ${isActive ? formatCurrency(marketValue, currency) : '\u2014'}
                </div>
                <div class="pos-secondary">${isActive ? (hasPrice ? formatCurrency(currentPrice, currency) + ' \u2022 ' + weight.toFixed(1) + '%' : '\u23F3 Pending') : ''}</div>
            </div>
            <div class="pos-cell pos-right pos-hide-mobile">
                <div style="color: ${isActive ? color : '#64748b'}; font-weight: bold;">
                    ${isActive ? `${gainLoss >= 0 ? '+' : ''}${formatCurrency(gainLoss, currency)}` : '\u2014'}
                </div>
                <div class="pos-secondary" style="color: ${isActive ? color : '#64748b'};">
                    ${isActive ? formatPercent(gainLossPct) : ''}
                </div>
            </div>
            <div class="position-actions">
                ${actionButtons}
            </div>
        </div>
        `;
    }).join('');

    positionsDiv.innerHTML = html;
    renderAllocationCharts();
    renderSalesHistory();
    console.log('Portfolio rendered successfully');
}

// ── Import Dialog ───────────────────────────────────────────────────────────

export function showImportDialog() {
    try {
        console.log('=== IMPORT DIALOG OPENED ===');
        const dialog = document.getElementById('importDialog');
        const textarea = document.getElementById('importText');
        if (!dialog) throw new Error('Import dialog element not found');
        if (!textarea) throw new Error('Import textarea element not found');
        dialog.style.display = 'block';
        textarea.focus();
    } catch (err) {
        console.error('=== SHOW IMPORT DIALOG ERROR ===', err);
        alert('Error opening import dialog: ' + err.message);
    }
}

export function closeImportDialog() {
    try {
        const dialog = document.getElementById('importDialog');
        const textarea = document.getElementById('importText');
        const reportArea = document.getElementById('importReportArea');
        if (dialog) dialog.style.display = 'none';
        if (textarea) textarea.value = '';
        if (reportArea) reportArea.innerHTML = '';
        // Reset import mode to default
        const addRadio = document.querySelector('input[name="importMode"][value="add"]');
        if (addRadio) addRadio.checked = true;
    } catch (err) {
        console.error('=== CLOSE IMPORT DIALOG ERROR ===', err);
    }
}

// ── Import Positions ────────────────────────────────────────────────────────

// Column-role aliases: map various header names to canonical role names.
// Roles: 'symbol' (ticker/ISIN), 'shares' (quantity), 'price' (avg unit cost),
//        'name' (asset name), 'platform', 'type' (asset type), 'amount' (total invested)
const COLUMN_ALIASES = {
    // Symbol / Ticker / ISIN
    symbol:   ['ticker', 'symbol', 'isin', 'code', 'instrument', 'stock', 'asset code', 'security', 'id', 'wkn', 'sedol', 'cusip', 'valor'],
    // Quantity / Shares
    shares:   ['shares', 'quantity', 'qty', 'units', 'amount of shares', 'no. of shares', 'no of shares', 'number of shares', 'holding', 'holdings', 'position', 'volume', 'lots', 'antal'],
    // Average price per unit
    price:    ['avg price', 'avg unit price', 'average price', 'avg cost', 'average cost', 'unit cost', 'cost price', 'purchase price', 'buy price', 'price per share', 'price/share', 'entry price', 'cost basis per share', 'cost/share', 'avg unit cost', 'prix moyen', 'snitt'],
    // Asset name
    name:     ['asset', 'asset name', 'name', 'company', 'company name', 'description', 'security name', 'instrument name', 'stock name', 'product'],
    // Platform / Broker
    platform: ['platform', 'broker', 'account', 'exchange', 'market', 'provider', 'source', 'brokerage'],
    // Asset type
    type:     ['type', 'asset type', 'security type', 'instrument type', 'asset class', 'category', 'class'],
    // Total invested amount (alternative to avg price)
    amount:   ['invested', 'invested amount', 'total invested', 'total cost', 'cost basis', 'total amount', 'amount invested', 'book value', 'book cost', 'market value', 'value', 'total value'],
};

/** Check if a header cell text matches a given role. */
function matchesRole(headerText, role) {
    const lower = headerText.toLowerCase().trim();
    const aliases = COLUMN_ALIASES[role];
    if (!aliases) return false;
    return aliases.some(alias => lower === alias || lower.replace(/[^a-z0-9 ]/g, '').trim() === alias);
}

/** ISIN pattern: 2 uppercase letters + 10 alphanumeric characters */
function isISIN(value) {
    return /^[A-Z]{2}[A-Z0-9]{10}$/.test(value);
}

/** Detect the separator used in the pasted data (tab, semicolon, comma, or pipe). */
function detectSeparator(text) {
    const firstLines = text.split('\n').slice(0, 5).join('\n');
    const tabCount = (firstLines.match(/\t/g) || []).length;
    const semiCount = (firstLines.match(/;/g) || []).length;
    const pipeCount = (firstLines.match(/\|/g) || []).length;
    // Comma is tricky (appears inside numbers). Only use if others are absent.
    const commaCount = (firstLines.match(/,/g) || []).length;
    const counts = { '\t': tabCount, ';': semiCount, '|': pipeCount, ',': commaCount };
    // Prefer tab > semicolon > pipe > comma
    const preferred = ['\t', ';', '|', ','];
    for (const sep of preferred) {
        if (counts[sep] >= 1) return sep;
    }
    return '\t'; // default
}

/** Parse a numeric string, handling European formats (1.234,56), currency symbols, etc. */
function parseFlexibleNumber(raw) {
    if (!raw) return NaN;
    let s = raw.trim();
    // Remove currency symbols and whitespace
    s = s.replace(/[$\u20ac\u00a3\u00a5C\$HK\$kr\s]/gi, '').trim();
    // Remove leading/trailing non-numeric chars (e.g. parentheses for negatives)
    s = s.replace(/^\((.+)\)$/, '-$1');
    // Detect European format: digits.digits,digits -> convert to US format
    if (/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(s)) {
        s = s.replace(/\./g, '').replace(',', '.');
    }
    // Also handle: digits,digits without thousands separator (e.g. "12,50")
    else if (/^\d+(,\d{1,2})$/.test(s)) {
        s = s.replace(',', '.');
    }
    // Remove any remaining commas (US thousands separators)
    s = s.replace(/,/g, '');
    return parseFloat(s);
}

/**
 * Try to auto-detect column roles from the header row.
 * Returns a mapping: { symbol: colIndex, shares: colIndex, ... } or null if no header detected.
 */
function detectColumnMapping(headerParts) {
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

    // We need at least symbol+shares to consider this a valid header
    if (mapping.symbol !== undefined && mapping.shares !== undefined) {
        console.log('Header mapping detected:', mapping, `(${matchCount} roles matched)`);
        return mapping;
    }
    return null;
}

/**
 * Use Claude API to resolve ISINs (and unknown identifiers) to ticker symbols.
 * Returns a map: { isin: { ticker, name, type, exchange } }
 */
/**
 * Look up an ISIN/identifier in the local asset database.
 * Assets are stored with an `isin` field when resolved, so future imports
 * can skip the Claude API call.
 */
function lookupIdentifierInDB(identifier) {
    const upper = identifier.toUpperCase();
    // Check if any asset in the database has this ISIN stored
    for (const [ticker, asset] of Object.entries(state.assetDatabase)) {
        if (asset.isin === upper) {
            return {
                ticker: ticker,
                name: asset.name || ticker,
                type: asset.assetType || 'Stock',
                exchange: ''
            };
        }
    }
    return null;
}

/**
 * Look up an ISIN using Finnhub API endpoints.
 * Tries /stock/profile2?isin= first, then /search?q= for additional candidates.
 * Returns array of { ticker, name, type, exchange } candidates.
 */
async function lookupISINviaFinnhub(isin) {
    if (!state.finnhubKey) return [];
    const candidates = [];

    // Method 1: Company Profile 2 (direct ISIN→ticker mapping)
    try {
        const url = `https://finnhub.io/api/v1/stock/profile2?isin=${encodeURIComponent(isin)}&token=${state.finnhubKey}`;
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            if (data && data.ticker) {
                candidates.push({
                    ticker: data.ticker.toUpperCase(),
                    name: data.name || data.ticker,
                    type: 'Stock',
                    exchange: data.exchange || ''
                });
            }
        }
    } catch (err) {
        console.log(`Finnhub profile2 failed for ${isin}:`, err.message);
    }

    // Method 2: Symbol Search (may return additional exchange listings)
    try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(isin)}&token=${state.finnhubKey}`;
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            if (data.result && data.result.length > 0) {
                data.result.slice(0, 5).forEach(r => {
                    const ticker = r.symbol.toUpperCase();
                    if (!candidates.find(c => c.ticker === ticker)) {
                        candidates.push({
                            ticker,
                            name: r.description || r.symbol,
                            type: normalizeAssetType(r.type),
                            exchange: ''
                        });
                    }
                });
            }
        }
    } catch (err) {
        console.log(`Finnhub search failed for ${isin}:`, err.message);
    }

    return candidates;
}

/**
 * Look up an ISIN using FMP's dedicated ISIN search endpoint.
 * Returns array of { ticker, name, type, exchange } candidates.
 */
async function lookupISINviaFMP(isin) {
    if (!state.fmpKey) return [];
    const candidates = [];

    try {
        const url = `https://financialmodelingprep.com/stable/search-isin?isin=${encodeURIComponent(isin)}&apikey=${state.fmpKey}`;
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            if (data && Array.isArray(data) && data.length > 0) {
                data.slice(0, 5).forEach(r => {
                    if (r.symbol) {
                        candidates.push({
                            ticker: r.symbol.toUpperCase(),
                            name: r.companyName || r.name || r.symbol,
                            type: 'Stock',
                            exchange: r.exchangeShortName || r.exchange || ''
                        });
                    }
                });
            }
        }
    } catch (err) {
        console.log(`FMP ISIN search failed for ${isin}:`, err.message);
    }

    return candidates;
}

/**
 * Given ticker candidates for an ISIN, pick the best one by preferring
 * a ticker already present in the portfolio or asset database.
 * This avoids duplicate positions when an ISIN maps to multiple exchange listings.
 */
function pickBestTicker(candidates) {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // Prefer a ticker already in the current portfolio
    for (const c of candidates) {
        if (state.portfolio.find(p => p.symbol.toUpperCase() === c.ticker)) {
            console.log(`  → Preferred ${c.ticker} (already in portfolio)`);
            return c;
        }
    }

    // Prefer a ticker already in the asset database
    for (const c of candidates) {
        if (state.assetDatabase[c.ticker]) {
            console.log(`  → Preferred ${c.ticker} (already in asset database)`);
            return c;
        }
    }

    // No match — return first candidate (primary listing)
    return candidates[0];
}

/**
 * Persist an ISIN→ticker mapping to the asset database and Supabase.
 */
async function persistISINMapping(isin, resolved) {
    const ticker = resolved.ticker;
    state.assetDatabase[ticker] = {
        ...(state.assetDatabase[ticker] || {}),
        name: resolved.name || ticker,
        ticker,
        assetType: resolved.type || 'Stock',
        isin
    };

    try {
        await saveAssetsToDB([{
            ticker,
            name: resolved.name || ticker,
            asset_type: resolved.type || 'Stock',
            isin,
            stock_exchange: resolved.exchange || '',
            sector: 'Other',
            currency: 'USD'
        }]);
    } catch (err) {
        console.warn(`Failed to persist ISIN mapping ${isin} → ${ticker}:`, err.message);
    }
}

/**
 * Resolve ISINs and unknown identifiers to ticker symbols using a 4-tier strategy:
 *   Tier 0: Local asset database (cached ISIN→ticker mappings)
 *   Tier 1: Finnhub API (profile2 + search — direct ISIN lookup)
 *   Tier 2: FMP API (dedicated ISIN search endpoint)
 *   Tier 3: Claude AI (last resort, with hallucination risk)
 *
 * After resolution, each ticker is checked against the existing portfolio and
 * asset database to prefer known tickers and avoid duplicates.
 *
 * Returns a map: { identifier: { ticker, name, type, exchange } }
 */
async function resolveIdentifiers(identifiers) {
    if (identifiers.length === 0) return {};

    const resultMap = {};
    let needsResolution = [];

    // ── Tier 0: Check local asset database ──────────────────────────────
    identifiers.forEach(id => {
        const cached = lookupIdentifierInDB(id);
        if (cached) {
            resultMap[id.toUpperCase()] = cached;
            console.log(`ISIN ${id} → ${cached.ticker} (from asset database)`);
        } else {
            needsResolution.push(id);
        }
    });

    if (needsResolution.length === 0) {
        console.log(`All ${identifiers.length} identifiers resolved from asset database`);
        return resultMap;
    }

    // Update progress UI
    const statusEl = document.getElementById('importReportArea');

    // ── Tier 1: Finnhub API ─────────────────────────────────────────────
    let afterFinnhub = [];
    if (state.finnhubKey) {
        for (const id of needsResolution) {
            if (!isISIN(id.toUpperCase())) { afterFinnhub.push(id); continue; }
            if (statusEl) statusEl.innerHTML = `<div style="color: #60a5fa; padding: 10px; font-size: 13px;">\u23F3 Resolving ISINs — Finnhub lookup (${Object.keys(resultMap).length + 1}/${identifiers.length})...</div>`;
            const candidates = await lookupISINviaFinnhub(id);
            if (candidates.length > 0) {
                const best = pickBestTicker(candidates);
                resultMap[id.toUpperCase()] = { ...best, confident: true };
                console.log(`ISIN ${id} → ${best.ticker} (Finnhub, ${candidates.length} candidate(s))`);
                await persistISINMapping(id.toUpperCase(), best);
            } else {
                afterFinnhub.push(id);
            }
            // Rate limit: profile2 + search = 2 calls per ISIN; 60/min → ~2s between ISINs
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    } else {
        afterFinnhub = [...needsResolution];
    }

    // ── Tier 2: FMP API ─────────────────────────────────────────────────
    let needsClaude = [];
    if (state.fmpKey && afterFinnhub.length > 0) {
        for (const id of afterFinnhub) {
            if (!isISIN(id.toUpperCase())) { needsClaude.push(id); continue; }
            if (statusEl) statusEl.innerHTML = `<div style="color: #60a5fa; padding: 10px; font-size: 13px;">\u23F3 Resolving ISINs — FMP lookup (${Object.keys(resultMap).length + 1}/${identifiers.length})...</div>`;
            const candidates = await lookupISINviaFMP(id);
            if (candidates.length > 0) {
                const best = pickBestTicker(candidates);
                resultMap[id.toUpperCase()] = { ...best, confident: true };
                console.log(`ISIN ${id} → ${best.ticker} (FMP, ${candidates.length} candidate(s))`);
                await persistISINMapping(id.toUpperCase(), best);
            } else {
                needsClaude.push(id);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    } else {
        needsClaude = [...afterFinnhub];
    }

    if (needsClaude.length === 0) {
        console.log(`All identifiers resolved via API lookups (Finnhub/FMP)`);
        return resultMap;
    }

    // ── Tier 3: Claude API (last resort) ────────────────────────────────
    const isClaudeAI = window.location.hostname.includes('claude.ai') ||
                        window.location.hostname.includes('anthropic.com') ||
                        (typeof window.storage !== 'undefined');
    const hasKey = isClaudeAI || state.anthropicKey;

    if (!hasKey) {
        console.warn('No Claude API key available for identifier resolution');
        return resultMap;
    }

    console.log(`=== RESOLVING ${needsClaude.length} IDENTIFIERS VIA CLAUDE (tier 3) ===`);
    if (statusEl) statusEl.innerHTML = `<div style="color: #a78bfa; padding: 10px; font-size: 13px;">\u23F3 Resolving ${needsClaude.length} remaining ISIN(s) via Claude AI...</div>`;

    const headers = { 'Content-Type': 'application/json' };
    if (!isClaudeAI && state.anthropicKey) {
        headers['x-api-key'] = state.anthropicKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2000,
                messages: [{
                    role: 'user',
                    content: `I have these financial instrument identifiers that I need resolved to their commonly-used stock TICKER symbols. They may be ISINs, WKNs, SEDOLs, company names, or partial tickers.

IMPORTANT: The "ticker" field MUST always be a real stock exchange ticker symbol (e.g. "AAPL", "MSFT", "SAN.PA", "VOW3.DE"). NEVER return an ISIN, WKN, SEDOL, or any other identifier code as the ticker. If you cannot determine the ticker, set "ticker" to null.

Identifiers:
${needsClaude.map((id, i) => `${i + 1}. ${id}`).join('\n')}

For each one, return the most commonly used ticker symbol (preferring the primary listing exchange), the full company/fund name, the asset type (Stock, ETF, REIT, Crypto, Bond), and the exchange suffix if non-US (e.g. ".PA" for Paris, ".L" for London, ".DE" for Frankfurt).

If you are NOT confident about the resolution for an identifier, include "alternatives" with up to 3 possible matches so the user can pick. Each alternative must also have a real ticker symbol, not an ISIN.

Respond ONLY with valid JSON, no markdown, no preamble. Format:
{"results": [{"input": "...", "ticker": "AAPL", "name": "...", "type": "Stock", "exchange": "", "confident": true, "alternatives": []}]}`
                }]
            })
        });

        if (!response.ok) {
            console.warn('Claude API returned', response.status, 'for identifier resolution');
            return resultMap;
        }

        const data = await response.json();
        const text = data.content.find(c => c.type === 'text')?.text || '';
        const cleanText = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleanText);

        const assetsToSave = [];
        (parsed.results || []).forEach(r => {
            if (r.input && r.ticker) {
                const inputUpper = r.input.toUpperCase();
                const rawTicker = r.ticker.toUpperCase();

                // Reject if Claude returned an ISIN as the ticker
                if (isISIN(rawTicker)) {
                    console.warn(`Claude returned ISIN as ticker for ${r.input} — skipping`);
                    return;
                }

                const resolvedTicker = (r.ticker + (r.exchange || '')).toUpperCase();

                // Check if this ticker already exists in DB — log for visibility
                const existingInPortfolio = state.portfolio.find(p => p.symbol.toUpperCase() === resolvedTicker);
                const existingInDB = state.assetDatabase[resolvedTicker];
                if (existingInPortfolio || existingInDB) {
                    console.log(`Claude resolved ${inputUpper} → ${resolvedTicker} (matches existing DB entry)`);
                }

                resultMap[inputUpper] = {
                    ticker: resolvedTicker,
                    name: r.name || r.ticker,
                    type: r.type || 'Stock',
                    exchange: r.exchange || '',
                    confident: r.confident !== false,
                    alternatives: r.alternatives || []
                };

                // Save ISIN→ticker mapping to asset database for future lookups
                if (isISIN(inputUpper)) {
                    assetsToSave.push({
                        ticker: resolvedTicker,
                        name: r.name || r.ticker,
                        asset_type: r.type || 'Stock',
                        isin: inputUpper,
                        stock_exchange: r.exchange || '',
                        sector: 'Other',
                        currency: 'USD'
                    });

                    state.assetDatabase[resolvedTicker] = {
                        ...(state.assetDatabase[resolvedTicker] || {}),
                        name: r.name || r.ticker,
                        ticker: resolvedTicker,
                        assetType: r.type || 'Stock',
                        isin: inputUpper
                    };
                }
            }
        });

        // Persist to DB
        if (assetsToSave.length > 0) {
            try {
                await saveAssetsToDB(assetsToSave);
                console.log(`Persisted ${assetsToSave.length} ISIN→ticker mappings to asset database`);
            } catch (err) {
                console.warn('Failed to persist ISIN mappings:', err.message);
            }
        }

        console.log('Claude resolved identifiers:', resultMap);
        return resultMap;
    } catch (err) {
        console.warn('Failed to resolve identifiers via Claude:', err.message);
        return resultMap;
    }
}

/** Show the import report inside the import dialog (replaces basic alert). */
function showImportReport(container, report) {
    const { newPositions, errors, warnings, needsPriceLookup } = report;
    const successCount = newPositions.length;
    const errCount = errors.length;
    const warnCount = warnings.length;

    let html = `<div class="import-report" style="background: #1e293b; border-radius: 10px; padding: 18px; margin-bottom: 15px; font-size: 13px; max-height: 350px; overflow-y: auto;">`;
    html += `<div style="font-weight: 700; font-size: 15px; color: #e2e8f0; margin-bottom: 10px;">Import Report</div>`;
    html += `<div style="color: #4ade80; margin-bottom: 4px;">\u2713 Successfully parsed: ${successCount} positions</div>`;
    if (errCount > 0) html += `<div style="color: #f87171; margin-bottom: 4px;">\u2717 Failed: ${errCount} lines</div>`;
    if (warnCount > 0) html += `<div style="color: #f59e0b; margin-bottom: 4px;">\u26A0 Warnings: ${warnCount}</div>`;

    if (warnings.length > 0) {
        html += `<div style="margin-top: 10px; padding: 10px; background: #422006; border-radius: 6px; border-left: 3px solid #f59e0b;">`;
        warnings.forEach(w => { html += `<div style="color: #fbbf24; font-size: 12px; margin-bottom: 3px;">\u26A0 ${escapeHTML(w)}</div>`; });
        html += `</div>`;
    }

    if (errors.length > 0) {
        html += `<div style="margin-top: 10px; padding: 10px; background: #350a0a; border-radius: 6px; border-left: 3px solid #f87171;">`;
        errors.slice(0, 15).forEach(e => { html += `<div style="color: #fca5a5; font-size: 12px; margin-bottom: 3px;">${escapeHTML(e)}</div>`; });
        if (errors.length > 15) html += `<div style="color: #fca5a5; font-size: 11px;">... and ${errors.length - 15} more</div>`;
        html += `</div>`;
    }

    if (successCount > 0) {
        html += `<div style="margin-top: 12px;"><div style="color: #94a3b8; font-size: 11px; text-transform: uppercase; margin-bottom: 6px;">Parsed positions (first 10)</div>`;
        newPositions.slice(0, 10).forEach(p => {
            const priceNote = p._needsCurrentPrice ? ' <span style="color:#f59e0b;">(price TBD)</span>' : '';
            const isinNote = p._resolvedFrom ? ` <span style="color:#60a5fa;">(from ${escapeHTML(p._resolvedFrom)})</span>` : '';
            html += `<div style="color: #cbd5e1; font-size: 12px; margin-bottom: 2px;">\u2022 <strong>${escapeHTML(p.symbol)}</strong>${isinNote}: ${p.shares} shares @ ${p.avgPrice > 0 ? '$' + p.avgPrice.toFixed(2) : 'pending'}${priceNote}</div>`;
        });
        if (successCount > 10) html += `<div style="color: #94a3b8; font-size: 11px;">... and ${successCount - 10} more</div>`;
        html += `</div>`;
    }

    html += `</div>`;
    container.innerHTML = html;
}

export async function importPositions() {
    if (!requireAuth('import positions')) return;
    console.log('=== IMPORT POSITIONS STARTED ===');

    const text = document.getElementById('importText').value.trim();
    if (!text) {
        alert('Please paste your positions data');
        return;
    }

    const separator = detectSeparator(text);
    console.log('Detected separator:', JSON.stringify(separator));

    const lines = text.split('\n');
    const newPositions = [];
    const errors = [];
    const warnings = [];
    const needsPriceLookup = []; // symbols that need current price as avgPrice
    const unknownIdentifiers = []; // ISINs or codes we need to resolve

    console.log('Total lines:', lines.length);

    try {
        // ── Step 1: Parse header and detect column mapping ───────────────
        let mapping = null;
        let dataStartIdx = 0;

        // Try the first non-empty line as a header
        for (let i = 0; i < Math.min(3, lines.length); i++) {
            const trimmed = lines[i].trim();
            if (!trimmed) continue;
            const headerParts = trimmed.split(separator).map(s => s.trim());
            mapping = detectColumnMapping(headerParts);
            if (mapping) {
                dataStartIdx = i + 1;
                console.log(`Header found on line ${i + 1}`);
                break;
            }
        }

        // ── Step 2: Fallback — no header detected, use heuristic ─────────
        if (!mapping) {
            console.log('No header detected, using heuristic column detection...');
            // Find the first non-empty data line to analyze structure
            let sampleLine = null;
            for (let i = 0; i < lines.length; i++) {
                const t = lines[i].trim();
                if (t) { sampleLine = t; break; }
            }
            if (sampleLine) {
                const parts = sampleLine.split(separator).map(s => s.trim());
                if (parts.length >= 8) {
                    // Legacy 8+ column format: Name, Ticker, Platform, Type, Shares, ?, ?, AvgPrice
                    mapping = { name: 0, symbol: 1, platform: 2, type: 3, shares: 4, price: 7 };
                    // Check if first line looks like a header (contains common words)
                    const firstLower = sampleLine.toLowerCase();
                    if (/\b(asset|ticker|symbol|name|shares|price|type|platform)\b/.test(firstLower)) {
                        dataStartIdx = 1;
                    }
                    console.log('Assuming legacy 8-column format');
                } else if (parts.length >= 2) {
                    // Minimal: try to identify which columns are symbol vs number
                    const colTypes = parts.map(p => {
                        if (!p) return 'empty';
                        if (!isNaN(parseFlexibleNumber(p))) return 'number';
                        if (isISIN(p.toUpperCase())) return 'isin';
                        if (/^[A-Z0-9.]{1,12}$/i.test(p)) return 'ticker';
                        return 'text';
                    });
                    console.log('Column types detected:', colTypes);

                    // Find first ticker/isin column → symbol, first number → shares, second number → price
                    const symbolIdx = colTypes.findIndex(t => t === 'ticker' || t === 'isin');
                    const numberIdxs = colTypes.reduce((acc, t, i) => { if (t === 'number') acc.push(i); return acc; }, []);

                    if (symbolIdx >= 0 && numberIdxs.length >= 1) {
                        mapping = { symbol: symbolIdx, shares: numberIdxs[0] };
                        if (numberIdxs.length >= 2) mapping.price = numberIdxs[1];
                        // Try to find a text column before symbol as name
                        const nameIdx = colTypes.findIndex((t, i) => (t === 'text') && i !== symbolIdx);
                        if (nameIdx >= 0) mapping.name = nameIdx;
                        console.log('Heuristic mapping:', mapping);
                    }

                    // Check if first line is actually a header by seeing if "number" columns contain text
                    const firstLower = sampleLine.toLowerCase();
                    if (/\b(asset|ticker|symbol|isin|name|shares|price|quantity|units)\b/.test(firstLower)) {
                        // Re-detect with header logic
                        const headerParts = sampleLine.split(separator).map(s => s.trim());
                        mapping = detectColumnMapping(headerParts);
                        dataStartIdx = 1;
                    }
                }
            }
        }

        if (!mapping || mapping.symbol === undefined || mapping.shares === undefined) {
            alert('\u274C Could not detect column layout.\n\nMake sure your data includes at least:\n\u2022 A Ticker/Symbol/ISIN column\n\u2022 A Quantity/Shares column\n\nAccepted separators: Tab, semicolon, comma, pipe.\nHeaders help but are not required.');
            return;
        }

        // ── Step 3: Parse data rows ──────────────────────────────────────
        for (let idx = dataStartIdx; idx < lines.length; idx++) {
            const trimmed = lines[idx].trim();
            if (!trimmed) continue;

            // Split the original line (not trimmed) to preserve empty leading/trailing fields
            const parts = lines[idx].split(separator).map(s => s.trim());
            const lineNum = idx + 1;

            // Extract values using the mapping
            const rawSymbol = parts[mapping.symbol] ? parts[mapping.symbol].trim() : '';
            const rawShares = parts[mapping.shares] ? parts[mapping.shares].trim() : '';
            const rawPrice = mapping.price !== undefined && parts[mapping.price] ? parts[mapping.price].trim() : '';
            const rawName = mapping.name !== undefined && parts[mapping.name] ? parts[mapping.name].trim() : '';
            const rawPlatform = mapping.platform !== undefined && parts[mapping.platform] ? parts[mapping.platform].trim() : '';
            const rawType = mapping.type !== undefined && parts[mapping.type] ? parts[mapping.type].trim() : '';
            const rawAmount = mapping.amount !== undefined && parts[mapping.amount] ? parts[mapping.amount].trim() : '';

            // Validate mandatory: symbol
            if (!rawSymbol) {
                errors.push(`Line ${lineNum}: Missing ticker/symbol/ISIN`);
                continue;
            }

            // Validate mandatory: shares
            const shares = parseFlexibleNumber(rawShares);
            if (isNaN(shares) || shares <= 0) {
                errors.push(`Line ${lineNum}: Invalid quantity "${rawShares}" for ${rawSymbol}`);
                continue;
            }

            // Determine symbol — could be ISIN, ticker, or unknown identifier
            let symbol = rawSymbol.toUpperCase();
            let resolvedFrom = null;

            if (isISIN(symbol)) {
                // Mark for Claude resolution later
                unknownIdentifiers.push({ isin: symbol, lineNum, rawName });
                resolvedFrom = symbol;
            }

            // Parse price: try direct price first, then try computing from total amount
            let avgPrice = parseFlexibleNumber(rawPrice);
            let needsCurrentPrice = false;

            if ((isNaN(avgPrice) || avgPrice <= 0) && rawAmount) {
                // Try to derive price from total amount / shares
                const totalAmount = parseFlexibleNumber(rawAmount);
                if (!isNaN(totalAmount) && totalAmount > 0) {
                    avgPrice = totalAmount / shares;
                    console.log(`Line ${lineNum}: Derived price ${avgPrice.toFixed(2)} from amount ${totalAmount} / ${shares} shares`);
                }
            }

            if (isNaN(avgPrice) || avgPrice <= 0) {
                // No price available — will use current market price
                avgPrice = 0;
                needsCurrentPrice = true;
                warnings.push(`${rawSymbol}: No acquisition price found — will use current market price as cost basis`);
            }

            // Determine asset type (normalize to canonical types)
            const assetType = normalizeAssetType(rawType);

            const position = {
                name: rawName || symbol,
                symbol,
                platform: rawPlatform || 'Unknown',
                type: assetType,
                shares,
                avgPrice,
                _needsCurrentPrice: needsCurrentPrice,
                _resolvedFrom: resolvedFrom
            };

            newPositions.push(position);
        }

        // ── Step 4: Resolve ISINs and unknown identifiers via Claude ─────
        const isinsToResolve = unknownIdentifiers.map(u => u.isin);
        // Also check if any symbols look non-standard and might need resolution
        newPositions.forEach(p => {
            if (!p._resolvedFrom && isISIN(p.symbol)) {
                if (!isinsToResolve.includes(p.symbol)) isinsToResolve.push(p.symbol);
            }
        });

        if (isinsToResolve.length > 0) {
            const statusEl = document.getElementById('importReportArea');
            if (statusEl) statusEl.innerHTML = `<div style="color: #60a5fa; padding: 10px; font-size: 13px;">\u23F3 Resolving ${isinsToResolve.length} ISIN(s) via API lookup...</div>`;

            const resolved = await resolveIdentifiers(isinsToResolve);

            // Apply resolutions
            const unresolvedISINs = [];
            for (const p of newPositions) {
                const resolution = resolved[p.symbol];
                if (resolution) {
                    // If resolution is not confident and has alternatives, let user pick
                    if (!resolution.confident && resolution.alternatives && resolution.alternatives.length > 0) {
                        const options = [
                            `${resolution.ticker} — ${resolution.name} (best guess)`,
                            ...resolution.alternatives.map(a => `${a.ticker || a} — ${a.name || ''}`)
                        ];
                        const choice = prompt(
                            `\u{1F50D} Uncertain match for ${p.symbol}:\n\n` +
                            options.map((o, i) => `${i + 1}. ${o}`).join('\n') +
                            `\n\nEnter number (1-${options.length}) or type a ticker manually:`,
                            '1'
                        );

                        if (choice && !isNaN(parseInt(choice))) {
                            const idx = parseInt(choice) - 1;
                            if (idx === 0) {
                                // Use best guess
                                p._resolvedFrom = p.symbol;
                                p.symbol = resolution.ticker;
                                p.name = resolution.name || p.name;
                                if (resolution.type) p.type = resolution.type;
                            } else if (idx > 0 && idx <= resolution.alternatives.length) {
                                const alt = resolution.alternatives[idx - 1];
                                p._resolvedFrom = p.symbol;
                                p.symbol = (alt.ticker || alt).toUpperCase();
                                p.name = alt.name || p.name;
                            }
                        } else if (choice && choice.trim()) {
                            p._resolvedFrom = p.symbol;
                            p.symbol = choice.trim().toUpperCase();
                        }
                    } else {
                        console.log(`Resolved ${p.symbol} \u2192 ${resolution.ticker} (${resolution.name})`);
                        p._resolvedFrom = p.symbol;
                        p.symbol = resolution.ticker;
                        p.name = resolution.name || p.name;
                        if (resolution.type) p.type = resolution.type;
                    }
                } else if (isISIN(p.symbol)) {
                    // Claude couldn't resolve at all
                    unresolvedISINs.push(p.symbol);
                }
            }

            // Warn about completely unresolved ISINs — exclude them from import
            if (unresolvedISINs.length > 0) {
                errors.push(`Could not resolve ${unresolvedISINs.length} ISIN(s) to tickers: ${unresolvedISINs.join(', ')}. These positions were skipped — please provide the correct ticker symbol.`);
                // Remove unresolved ISIN positions from the import
                for (let i = newPositions.length - 1; i >= 0; i--) {
                    if (isISIN(newPositions[i].symbol)) {
                        newPositions.splice(i, 1);
                    }
                }
            }
        }

        // Detect import mode from radio buttons
        const importModeEl = document.querySelector('input[name="importMode"]:checked');
        const importMode = importModeEl ? importModeEl.value : 'add';

        // Check for duplicate tickers (same symbol already in portfolio)
        const existingSymbols = new Set(state.portfolio.map(p => p.symbol));
        if (importMode === 'add') {
            newPositions.forEach(p => {
                if (existingSymbols.has(p.symbol)) {
                    warnings.push(`${p.symbol}: Already in portfolio — will be updated with imported data`);
                }
            });
        }

        // ── Step 5: Show report and let user confirm ─────────────────────
        const reportArea = document.getElementById('importReportArea');
        if (reportArea) {
            showImportReport(reportArea, { newPositions, errors, warnings, needsPriceLookup });
        }

        if (newPositions.length === 0) {
            let msg = '\u274C No positions could be imported.\n\n';
            if (errors.length > 0) {
                msg += 'Errors:\n' + errors.slice(0, 10).join('\n');
            } else {
                msg += 'Tip: Make sure your data contains at least a Ticker/ISIN column and a Quantity column.';
            }
            alert(msg);
            return;
        }

        // Build confirmation message
        const modeLabel = importMode === 'add' ? 'Add' : 'Replace';
        let confirmMsg = `${modeLabel} ${newPositions.length} position(s)?`;
        if (importMode === 'add' && state.portfolio.length > 0) {
            confirmMsg += `\n\nExisting portfolio has ${state.portfolio.length} position(s). New positions will be merged in (duplicates updated).`;
        } else if (importMode === 'replace' && state.portfolio.length > 0) {
            confirmMsg += `\n\n\u26A0 This will replace your entire portfolio (${state.portfolio.length} existing positions).`;
        }
        if (warnings.length > 0) {
            confirmMsg += `\n\n\u26A0 ${warnings.length} warning(s) — some positions have no acquisition price and will use current market price.`;
        }
        if (errors.length > 0) {
            confirmMsg += `\n\n\u2717 ${errors.length} line(s) skipped due to errors.`;
        }

        if (!confirm(confirmMsg)) return;

        // ── Step 6: Import confirmed — clean up temp fields and save ─────
        // Final safety: reject any position still using an ISIN as symbol
        for (let i = newPositions.length - 1; i >= 0; i--) {
            if (isISIN(newPositions[i].symbol)) {
                errors.push(`${newPositions[i].symbol}: ISIN not resolved to ticker — skipped.`);
                newPositions.splice(i, 1);
            }
        }

        const positionsNeedingPrice = [];
        newPositions.forEach(p => {
            if (p._needsCurrentPrice) positionsNeedingPrice.push(p.symbol);
            delete p._needsCurrentPrice;
            delete p._resolvedFrom;
        });

        if (importMode === 'add' && state.portfolio.length > 0) {
            // Merge: update existing positions by symbol, add new ones
            const importedSymbols = new Set();
            newPositions.forEach(np => {
                importedSymbols.add(np.symbol);
                const existingIdx = state.portfolio.findIndex(p => p.symbol === np.symbol);
                if (existingIdx >= 0) {
                    // Update existing position with imported data
                    state.portfolio[existingIdx] = np;
                } else {
                    // Add new position
                    state.portfolio.push(np);
                }
            });
        } else {
            // Replace: overwrite entire portfolio
            state.portfolio = [...newPositions];
        }

        // Populate local assetDatabase
        newPositions.forEach(p => {
            const assetRecord = buildAssetRecord(p);
            state.assetDatabase[assetRecord.ticker] = {
                name: assetRecord.name,
                ticker: assetRecord.ticker,
                stockExchange: assetRecord.stock_exchange,
                sector: assetRecord.sector,
                currency: assetRecord.currency,
                assetType: assetRecord.asset_type
            };
        });

        savePortfolioDB();
        closeImportDialog();

        renderPortfolio();
        setTimeout(() => renderPortfolio(), 50);
        setTimeout(() => renderPortfolio(), 200);

        // ── Step 7: Fetch prices, then fill in missing avgPrices ─────────
        setTimeout(async () => {
            console.log('Auto-fetching market prices...');
            await fetchMarketPrices();

            // For positions without acquisition price, use current market price
            if (positionsNeedingPrice.length > 0) {
                let filledCount = 0;
                positionsNeedingPrice.forEach(symbol => {
                    const price = state.marketPrices[symbol];
                    if (price && price > 0) {
                        const pos = state.portfolio.find(p => p.symbol === symbol);
                        if (pos && pos.avgPrice <= 0) {
                            pos.avgPrice = price;
                            filledCount++;
                            console.log(`Set ${symbol} avgPrice to current market price: ${price}`);
                        }
                    }
                });

                if (filledCount > 0) {
                    savePortfolioDB();
                    renderPortfolio();
                    alert(`\u26A0 ${filledCount} position(s) had no acquisition price.\n\nTheir cost basis has been set to the current market price. You can adjust this by selling and re-adding the position with the correct price.`);
                }

                // Warn about positions where price couldn't be found
                const unfilled = positionsNeedingPrice.filter(s => {
                    const pos = state.portfolio.find(p => p.symbol === s);
                    return pos && pos.avgPrice <= 0;
                });
                if (unfilled.length > 0) {
                    alert(`\u274C Could not determine price for: ${unfilled.join(', ')}.\n\nPlease update these positions manually.`);
                }
            }
        }, 500);

        setTimeout(() => {
            alert(`\u2713 Successfully imported ${newPositions.length} position(s)!\n\nFetching current market prices...`);
        }, 300);

    } catch (err) {
        console.error('=== IMPORT ERROR ===', err);
        alert(`\u274C Import failed: ${err.message}\n\nCheck the browser console (F12) for details.`);
    }
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export async function savePortfolioSnapshot() {
    if (!requireAuth('save snapshots')) return;
    if (state.portfolio.length === 0) {
        alert('\u274C No portfolio to save. Import your portfolio first.');
        return;
    }

    let totalInvested = 0;
    let totalMarketValue = 0;

    state.portfolio.forEach(p => {
        const invested = p.shares * p.avgPrice;
        totalInvested += invested;
        const currentPrice = state.marketPrices[p.symbol];
        totalMarketValue += currentPrice ? p.shares * currentPrice : invested;
    });

    const snapshot = {
        timestamp: new Date().toISOString(),
        totalInvested,
        totalMarketValue,
        positionCount: state.portfolio.length,
        pricesAvailable: Object.keys(state.marketPrices).length
    };

    state.portfolioHistory.push(snapshot);
    localStorage.setItem('portfolioHistory', JSON.stringify(state.portfolioHistory));

    let cloudSaved = false;
    let dbSaved = false;

    try {
        await saveSnapshotToDB(snapshot);
        if (state.supabaseClient && state.currentUser) dbSaved = true;
    } catch (err) {
        console.warn('Supabase save failed:', err);
    }

    if (typeof window.storage !== 'undefined') {
        try {
            const snapshotKey = `snapshot:${Date.now()}`;
            await window.storage.set(snapshotKey, JSON.stringify(snapshot), false);
            await window.storage.set('current-portfolio', JSON.stringify({
                portfolio: state.portfolio,
                marketPrices: state.marketPrices,
                priceMetadata: state.priceMetadata,
                lastUpdated: new Date().toISOString()
            }), false);
            cloudSaved = true;
        } catch (err) {
            console.warn('Cloud storage failed:', err);
        }
    }

    updateHistoryDisplay();

    const gainLoss = totalMarketValue - totalInvested;
    const gainLossPct = totalInvested > 0 ? (gainLoss / totalInvested) * 100 : 0;
    const syncStatus = dbSaved ? '\u2601\uFE0F Synced to Supabase' : cloudSaved ? '\u2601\uFE0F Synced to cloud storage' : '\uD83D\uDCBE Saved to browser only';
    alert(`\u2713 Portfolio snapshot saved!\n\nInvested: ${formatCurrency(totalInvested)}\nMarket Value: ${formatCurrency(totalMarketValue)}\nGain/Loss: ${formatCurrency(gainLoss)} (${formatPercent(gainLossPct)})\n\nTotal snapshots: ${state.portfolioHistory.length}\n\n${syncStatus}`);
}

// ── History Display ─────────────────────────────────────────────────────────

export function updateHistoryDisplay() {
    try {
        if (state.portfolioHistory.length === 0) {
            document.getElementById('historySection').style.display = 'none';
            return;
        }

        document.getElementById('historySection').style.display = 'block';
        updateChart();

        const historyLog = document.getElementById('historyLog');
        if (!historyLog) return;

        historyLog.innerHTML = `
            <h3 style="margin-bottom: 10px; color: #cbd5e1;">Snapshot Log</h3>
            <div style="max-height: 300px; overflow-y: auto;">
                ${state.portfolioHistory.slice().reverse().map((snapshot) => {
                    const date = new Date(snapshot.timestamp);
                    const gainLoss = snapshot.totalMarketValue - snapshot.totalInvested;
                    const gainLossPct = snapshot.totalInvested > 0 ? (gainLoss / snapshot.totalInvested) * 100 : 0;
                    const color = gainLoss >= 0 ? '#4ade80' : '#f87171';
                    const ts = encodeURIComponent(snapshot.timestamp);
                    return `
                        <div style="background: #334155; padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid ${color};">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                                <div style="font-size: 13px; color: #94a3b8;">${date.toLocaleDateString()} ${date.toLocaleTimeString()}</div>
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <div style="font-size: 12px; color: #94a3b8;">${snapshot.positionCount} positions \u2022 ${snapshot.pricesAvailable} with prices</div>
                                    <button onclick="deleteSnapshot('${ts}')" title="Delete this snapshot" style="background: none; border: none; cursor: pointer; color: #94a3b8; font-size: 14px; padding: 2px 4px; border-radius: 4px; transition: color 0.2s;" onmouseover="this.style.color='#f87171'" onmouseout="this.style.color='#94a3b8'">\u{1F5D1}\u{FE0F}</button>
                                </div>
                            </div>
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; font-size: 13px;">
                                <div><div style="color: #94a3b8; font-size: 11px;">Invested</div><div style="color: #cbd5e1;">${formatCurrency(snapshot.totalInvested)}</div></div>
                                <div><div style="color: #94a3b8; font-size: 11px;">Market Value</div><div style="color: #cbd5e1;">${formatCurrency(snapshot.totalMarketValue)}</div></div>
                                <div><div style="color: #94a3b8; font-size: 11px;">Gain/Loss</div><div style="color: ${color}; font-weight: bold;">${formatCurrency(gainLoss)} (${formatPercent(gainLossPct)})</div></div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
            <button class="btn btn-danger" onclick="clearHistory()" style="margin-top: 15px;">\uD83D\uDDD1\uFE0F Clear History</button>
        `;
    } catch (err) {
        console.error('Error updating history display:', err);
    }
}

// ── Chart ───────────────────────────────────────────────────────────────────

function updateChart() {
    if (state.portfolioHistory.length === 0) return;

    try {
        const chartDiv = document.getElementById('historyChart');
        if (!chartDiv) return;

        const allValues = state.portfolioHistory.flatMap(s => [s.totalInvested, s.totalMarketValue]);
        const minValue = Math.min(...allValues) * 0.95;
        const maxValue = Math.max(...allValues) * 1.05;
        const range = maxValue - minValue;

        let chartHTML = '<div style="background: #334155; padding: 20px; border-radius: 10px;">';
        chartHTML += '<div style="display: flex; justify-content: space-around; gap: 8px; align-items: flex-end; height: 200px;">';

        state.portfolioHistory.forEach((snapshot) => {
            const date = new Date(snapshot.timestamp);
            const label = `${date.getMonth() + 1}/${date.getDate()}`;
            const marketHeight = ((snapshot.totalMarketValue - minValue) / range) * 180;
            const investedHeight = ((snapshot.totalInvested - minValue) / range) * 180;
            const gainLoss = snapshot.totalMarketValue - snapshot.totalInvested;
            const color = gainLoss >= 0 ? '#4ade80' : '#f87171';

            chartHTML += `
                <div style="flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 40px;">
                    <div style="position: relative; width: 100%; height: 180px; display: flex; align-items: flex-end; justify-content: center; gap: 2px;">
                        <div style="width: 45%; background: #60a5fa; height: ${investedHeight}px; border-radius: 3px 3px 0 0;" title="Invested: ${formatCurrency(snapshot.totalInvested)}"></div>
                        <div style="width: 45%; background: ${color}; height: ${marketHeight}px; border-radius: 3px 3px 0 0;" title="Market: ${formatCurrency(snapshot.totalMarketValue)}"></div>
                    </div>
                    <div style="font-size: 10px; color: #94a3b8; margin-top: 5px; text-align: center;">${label}</div>
                </div>
            `;
        });

        chartHTML += '</div>';
        chartHTML += `
            <div style="display: flex; justify-content: center; gap: 20px; margin-top: 15px; font-size: 12px;">
                <div style="display: flex; align-items: center; gap: 5px;"><div style="width: 12px; height: 12px; background: #60a5fa; border-radius: 2px;"></div><span style="color: #cbd5e1;">Invested</span></div>
                <div style="display: flex; align-items: center; gap: 5px;"><div style="width: 12px; height: 12px; background: #4ade80; border-radius: 2px;"></div><span style="color: #cbd5e1;">Market Value (Profit)</span></div>
                <div style="display: flex; align-items: center; gap: 5px;"><div style="width: 12px; height: 12px; background: #f87171; border-radius: 2px;"></div><span style="color: #cbd5e1;">Market Value (Loss)</span></div>
            </div>
        `;
        chartHTML += '</div>';
        chartDiv.innerHTML = chartHTML;
    } catch (err) {
        console.error('Error creating chart:', err);
    }
}

// ── Clear History ───────────────────────────────────────────────────────────

export async function deleteSnapshot(timestamp) {
    const ts = decodeURIComponent(timestamp);
    const idx = state.portfolioHistory.findIndex(s => s.timestamp === ts);
    if (idx === -1) {
        alert('Snapshot not found.');
        return;
    }
    const date = new Date(ts);
    if (!confirm(`Delete snapshot from ${date.toLocaleDateString()} ${date.toLocaleTimeString()}?`)) return;

    state.portfolioHistory.splice(idx, 1);
    localStorage.setItem('portfolioHistory', JSON.stringify(state.portfolioHistory));
    await deleteSnapshotFromDB(ts);
    updateHistoryDisplay();
}

export function clearHistory() {
    if (confirm('Are you sure you want to clear all portfolio history?\n\nThis cannot be undone.')) {
        state.portfolioHistory = [];
        localStorage.removeItem('portfolioHistory');
        clearHistoryFromDB();
        document.getElementById('historySection').style.display = 'none';
        alert('\u2713 History cleared');
    }
}

// ── Position Management ────────────────────────────────────────────────────

// -- Asset Search (uses Finnhub /search and FMP /search endpoints) --

async function searchAssets(query) {
    if (!query || query.length < 1) return [];

    // Tier 1: Finnhub symbol search
    if (state.finnhubKey) {
        try {
            const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${state.finnhubKey}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                if (data.result && data.result.length > 0) {
                    return data.result.slice(0, 8).map(r => ({
                        symbol: r.symbol,
                        name: r.description || r.symbol,
                        type: normalizeAssetType(r.type)
                    }));
                }
            }
        } catch (err) {
            console.log('Finnhub search failed:', err.message);
        }
    }

    // Tier 2: FMP symbol search
    if (state.fmpKey) {
        try {
            const url = `https://financialmodelingprep.com/api/v3/search?query=${encodeURIComponent(query)}&limit=8&apikey=${state.fmpKey}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                if (data && Array.isArray(data) && data.length > 0) {
                    return data.slice(0, 8).map(r => ({
                        symbol: r.symbol,
                        name: r.name || r.symbol,
                        type: 'Stock'
                    }));
                }
            }
        } catch (err) {
            console.log('FMP search failed:', err.message);
        }
    }

    return [];
}

function renderSearchResults(results) {
    const container = document.getElementById('searchResults');
    if (!container) return;

    if (results.length === 0) {
        container.innerHTML = '<div class="search-no-results">No results found. You can enter ticker and details manually below.</div>';
        return;
    }

    container.innerHTML = results.map(r => `
        <div class="search-result-item" data-symbol="${escapeHTML(r.symbol)}" data-name="${escapeHTML(r.name)}" data-type="${escapeHTML(r.type)}">
            <span class="search-result-symbol">${escapeHTML(r.symbol)}</span>
            <span class="search-result-name">${escapeHTML(r.name)}</span>
            <span class="search-result-type">${escapeHTML(r.type)}</span>
        </div>
    `).join('');
}

function selectSearchResult(symbol, name, type) {
    document.getElementById('positionSearchInput').value = `${symbol} \u2014 ${name}`;
    document.getElementById('positionSymbol').value = symbol;
    document.getElementById('positionName').value = name;

    document.getElementById('positionType').value = normalizeAssetType(type);
    document.getElementById('searchResults').innerHTML = '';
    document.getElementById('positionShares').focus();
}

function updateCalculatedPrice() {
    const shares = parseFloat(document.getElementById('positionShares').value);
    const amount = parseFloat(document.getElementById('positionAmount').value);
    const display = document.getElementById('positionCalcDisplay');
    if (!display) return;

    if (!isNaN(shares) && shares > 0 && !isNaN(amount) && amount > 0) {
        display.textContent = `Price per share: ${formatCurrency(amount / shares)}`;
    } else {
        display.textContent = '';
    }
}

// -- Init: attach event listeners for search and calculation --

export function initPositionDialog() {
    const searchInput = document.getElementById('positionSearchInput');
    if (!searchInput) return;

    let searchTimeout = null;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();
        if (query.length < 1) {
            document.getElementById('searchResults').innerHTML = '';
            return;
        }
        searchTimeout = setTimeout(async () => {
            const results = await searchAssets(query);
            renderSearchResults(results);
        }, 300);
    });

    // Click delegation on search results
    const resultsContainer = document.getElementById('searchResults');
    if (resultsContainer) {
        resultsContainer.addEventListener('click', (e) => {
            const item = e.target.closest('.search-result-item');
            if (!item) return;
            selectSearchResult(
                item.dataset.symbol,
                item.dataset.name,
                item.dataset.type
            );
        });
    }

    // Auto-calculate price per share
    const sharesInput = document.getElementById('positionShares');
    const amountInput = document.getElementById('positionAmount');
    if (sharesInput) sharesInput.addEventListener('input', updateCalculatedPrice);
    if (amountInput) amountInput.addEventListener('input', updateCalculatedPrice);
}

// -- Show Add Position Dialog --

export function showAddPositionDialog() {
    if (!requireAuth('add positions')) return;
    const dialog = document.getElementById('positionDialog');
    if (!dialog) return;

    dialog.dataset.mode = 'add';
    dialog.dataset.symbol = '';
    document.getElementById('positionDialogTitle').textContent = 'Add New Position';

    // Reset all fields
    document.getElementById('positionSearchInput').value = '';
    document.getElementById('positionSymbol').value = '';
    document.getElementById('positionName').value = '';
    document.getElementById('positionType').value = 'Stock';
    document.getElementById('positionPlatform').value = '';
    document.getElementById('positionShares').value = '';
    document.getElementById('positionAmount').value = '';
    document.getElementById('positionDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('positionCalcDisplay').textContent = '';
    document.getElementById('searchResults').innerHTML = '';

    // Show search, hide sell info
    document.getElementById('positionSearchSection').style.display = 'block';
    document.getElementById('positionSellInfo').style.display = 'none';
    document.getElementById('positionSymbolGroup').style.display = 'block';
    document.getElementById('positionNameGroup').style.display = 'block';
    document.getElementById('positionTypeGroup').style.display = 'block';
    document.getElementById('positionPlatformGroup').style.display = 'block';

    // Labels for add mode
    document.getElementById('positionSharesLabel').textContent = 'Number of Shares *';
    document.getElementById('positionAmountLabel').textContent = 'Invested Amount *';
    document.getElementById('positionDialogSubmit').textContent = 'Add Position';
    document.getElementById('positionDialogSubmit').className = 'btn btn-success';

    dialog.style.display = 'flex';
    document.getElementById('positionSearchInput').focus();
}

// -- Show Edit Position Dialog (buy more or sell) --

export function showEditPositionDialog(symbol, mode) {
    const position = state.portfolio.find(p => p.symbol === symbol);
    if (!position) return;

    const dialog = document.getElementById('positionDialog');
    if (!dialog) return;

    dialog.dataset.mode = mode; // 'buy' or 'sell'
    dialog.dataset.symbol = symbol;

    const isSell = mode === 'sell';
    document.getElementById('positionDialogTitle').textContent =
        isSell ? `Sell Shares \u2014 ${symbol}` : `Add Shares \u2014 ${symbol}`;

    // Hide search section (we already know the asset)
    document.getElementById('positionSearchSection').style.display = 'none';
    document.getElementById('positionSymbolGroup').style.display = 'none';
    document.getElementById('positionNameGroup').style.display = 'none';
    document.getElementById('positionTypeGroup').style.display = 'none';
    document.getElementById('positionPlatformGroup').style.display = 'none';

    // Pre-fill hidden fields
    document.getElementById('positionSymbol').value = position.symbol;
    document.getElementById('positionName').value = position.name;
    document.getElementById('positionType').value = position.type || 'Stock';
    document.getElementById('positionPlatform').value = position.platform || '';

    // Clear input fields
    document.getElementById('positionShares').value = '';
    document.getElementById('positionAmount').value = '';
    document.getElementById('positionDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('positionCalcDisplay').textContent = '';
    document.getElementById('searchResults').innerHTML = '';

    // Show position info banner
    const infoEl = document.getElementById('positionSellInfo');
    if (isSell) {
        infoEl.style.display = 'block';
        infoEl.innerHTML = `
            <strong>${escapeHTML(position.name || position.symbol)}</strong><br>
            Current: <strong>${position.shares}</strong> shares @ ${formatCurrency(position.avgPrice)} avg cost
            <br>Total invested: ${formatCurrency(position.shares * position.avgPrice)}
        `;
        document.getElementById('positionSharesLabel').textContent = 'Shares to Sell *';
        document.getElementById('positionAmountLabel').textContent = 'Sale Amount *';
        document.getElementById('positionDialogSubmit').textContent = 'Sell Shares';
        document.getElementById('positionDialogSubmit').className = 'btn btn-warning';
    } else {
        infoEl.style.display = 'block';
        infoEl.innerHTML = `
            <strong>${escapeHTML(position.name || position.symbol)}</strong><br>
            Current: <strong>${position.shares}</strong> shares @ ${formatCurrency(position.avgPrice)} avg cost
        `;
        document.getElementById('positionSharesLabel').textContent = 'Shares to Add *';
        document.getElementById('positionAmountLabel').textContent = 'Invested Amount *';
        document.getElementById('positionDialogSubmit').textContent = 'Add Shares';
        document.getElementById('positionDialogSubmit').className = 'btn btn-success';
    }

    dialog.style.display = 'flex';
    document.getElementById('positionShares').focus();
}

// -- Close Dialog --

export function closePositionDialog() {
    const dialog = document.getElementById('positionDialog');
    if (dialog) dialog.style.display = 'none';
    document.getElementById('searchResults').innerHTML = '';
}

// -- Submit Position (handles add, buy, sell) --

export function submitPosition() {
    if (!requireAuth('manage positions')) return;
    const dialog = document.getElementById('positionDialog');
    const mode = dialog.dataset.mode;

    const symbol = document.getElementById('positionSymbol').value.trim().toUpperCase();
    const name = document.getElementById('positionName').value.trim();
    const type = document.getElementById('positionType').value;
    const platform = document.getElementById('positionPlatform').value.trim() || 'Unknown';
    const shares = parseFloat(document.getElementById('positionShares').value);
    const totalAmount = parseFloat(document.getElementById('positionAmount').value);
    const date = document.getElementById('positionDate').value;

    // Validation
    if (!symbol) { alert('Please enter or select a ticker symbol.'); return; }
    if (isISIN(symbol)) { alert('Please enter a ticker symbol, not an ISIN.\n\nUse the import function to resolve ISINs automatically.'); return; }
    if (isNaN(shares) || shares <= 0) { alert('Please enter a valid number of shares.'); return; }
    if (isNaN(totalAmount) || totalAmount <= 0) { alert('Please enter a valid amount.'); return; }
    if (!date) { alert('Please enter a date.'); return; }

    const pricePerShare = totalAmount / shares;

    if (mode === 'add') {
        // Check for existing active position
        const existing = state.portfolio.find(p => p.symbol === symbol);
        if (existing && existing.shares > 0) {
            alert(`An active position for ${symbol} already exists.\nUse the "+" button on that row to add more shares.`);
            return;
        }

        // If position exists but inactive (0 shares), reactivate it
        if (existing) {
            existing.shares = shares;
            existing.avgPrice = pricePerShare;
            existing.name = name || existing.name;
            existing.type = type;
            existing.platform = platform;
        } else {
            state.portfolio.push({
                name: name || symbol,
                symbol,
                platform,
                type,
                shares,
                avgPrice: pricePerShare
            });
        }

        // Build asset database record
        const assetRecord = buildAssetRecord({ name: name || symbol, symbol, platform, type, shares, avgPrice: pricePerShare });
        state.assetDatabase[assetRecord.ticker] = {
            name: assetRecord.name,
            ticker: assetRecord.ticker,
            stockExchange: assetRecord.stock_exchange,
            sector: assetRecord.sector,
            currency: assetRecord.currency,
            assetType: assetRecord.asset_type
        };

        recordTransaction(symbol, 'buy', shares, pricePerShare, date, totalAmount);

    } else if (mode === 'buy') {
        const position = state.portfolio.find(p => p.symbol === dialog.dataset.symbol);
        if (!position) { alert('Position not found.'); return; }

        // Weighted average price calculation
        const oldTotal = position.shares * position.avgPrice;
        const newTotal = shares * pricePerShare;
        position.shares += shares;
        position.avgPrice = (oldTotal + newTotal) / position.shares;

        recordTransaction(position.symbol, 'buy', shares, pricePerShare, date, totalAmount);

    } else if (mode === 'sell') {
        const position = state.portfolio.find(p => p.symbol === dialog.dataset.symbol);
        if (!position) { alert('Position not found.'); return; }

        if (shares > position.shares) {
            alert(`Cannot sell ${shares} shares. You only have ${position.shares} shares.`);
            return;
        }

        // Record sale with cost basis and realized gain/loss
        const costBasis = position.avgPrice;
        const realizedGainLoss = (pricePerShare - costBasis) * shares;

        recordTransaction(position.symbol, 'sell', shares, pricePerShare, date, totalAmount, costBasis, realizedGainLoss);

        // Reduce shares (avgPrice stays the same for remaining shares)
        position.shares -= shares;
    }

    // Persist and re-render
    savePortfolioDB();
    saveTransactionsToStorage();
    closePositionDialog();
    renderPortfolio();

    // Try to fetch price for new position
    if (mode === 'add' && (state.finnhubKey || state.fmpKey || state.alphaVantageKey)) {
        setTimeout(async () => {
            console.log(`Auto-fetching price for new position ${symbol}...`);
            const result = await fetchStockPrice(symbol);
            if (result.success) {
                state.marketPrices[symbol] = result.price;
                state.priceMetadata[symbol] = {
                    timestamp: new Date().toISOString(),
                    source: result.source,
                    success: true
                };
                renderPortfolio();
            }
        }, 200);
    }
}

// -- Switch Base Currency --

export async function setBaseCurrency(currency) {
    state.baseCurrency = currency;
    localStorage.setItem('baseCurrency', currency);
    console.log(`=== BASE CURRENCY CHANGED TO ${currency} ===`);

    // Update selector UI
    document.querySelectorAll('.currency-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.currency === currency);
    });

    // Re-fetch exchange rates with new base, then re-render
    const { fetchExchangeRates } = await import('./pricing.js');
    await fetchExchangeRates();
    renderPortfolio();
}

// -- Refresh Single Asset Price --

export async function refreshSinglePrice(symbol) {
    if (!state.finnhubKey && !state.fmpKey && !state.alphaVantageKey) {
        alert('No API keys configured. Set up at least one pricing API key first.');
        return;
    }

    // Update metadata to show loading state
    state.priceMetadata[symbol] = { timestamp: new Date().toISOString(), source: 'Fetching...', success: true };
    renderPortfolio();

    const result = await fetchStockPrice(symbol);
    if (result.success) {
        state.marketPrices[symbol] = result.price;
        state.priceMetadata[symbol] = {
            timestamp: new Date().toISOString(),
            source: result.source,
            success: true
        };
    } else {
        state.priceMetadata[symbol] = {
            timestamp: new Date().toISOString(),
            source: '',
            success: false,
            error: result.error || 'Failed'
        };
    }
    renderPortfolio();
}

// -- Delete Position --

export function deletePosition(symbol) {
    if (!requireAuth('delete positions')) return;
    const position = state.portfolio.find(p => p.symbol === symbol);
    if (!position) return;

    const msg = `Delete ${symbol}` +
        (position.name && position.name !== symbol ? ` (${position.name})` : '') +
        `?\n\nThis will permanently remove this position and its transaction history.\nThis cannot be undone.`;

    if (!confirm(msg)) return;

    state.portfolio = state.portfolio.filter(p => p.symbol !== symbol);
    delete state.transactions[symbol];
    delete state.marketPrices[symbol];
    delete state.priceMetadata[symbol];

    savePortfolioDB();
    saveTransactionsToStorage();
    deleteTransactionsForSymbol(symbol);
    renderPortfolio();
}

// -- Toggle Inactive Positions Visibility --

export function toggleInactivePositions() {
    state.showInactivePositions = !state.showInactivePositions;
    renderPortfolio();
}

// ── Transaction Recording & Persistence ────────────────────────────────────

function recordTransaction(symbol, type, shares, price, date, totalAmount, costBasis, realizedGainLoss) {
    if (!state.transactions[symbol]) {
        state.transactions[symbol] = [];
    }
    const currency = getAssetCurrency(symbol);
    const exchangeRate = getExchangeRate(currency);
    const tx = {
        type,
        shares,
        price,
        date,
        totalAmount,
        currency,
        exchangeRate,
        timestamp: new Date().toISOString()
    };
    if (type === 'sell') {
        tx.costBasis = costBasis;
        tx.realizedGainLoss = realizedGainLoss;
    }
    state.transactions[symbol].push(tx);
}

export function saveTransactionsToStorage() {
    try {
        localStorage.setItem('positionTransactions', JSON.stringify(state.transactions));
        console.log('\u2713 Transactions saved to localStorage');
        // Also persist to Supabase
        saveTransactionsToDB();
    } catch (err) {
        console.error('Failed to save transactions:', err);
    }
}

export function loadTransactionsFromStorage() {
    try {
        const stored = localStorage.getItem('positionTransactions');
        if (stored) {
            state.transactions = JSON.parse(stored);
            console.log('\u2713 Loaded transactions:', Object.keys(state.transactions).length, 'symbols');
        }
    } catch (err) {
        console.error('Error loading transactions:', err);
    }
}

// ── Sales History Display ──────────────────────────────────────────────────

function renderSalesHistory() {
    const section = document.getElementById('salesHistorySection');
    if (!section) return;

    // Collect all sell transactions across all symbols
    const allSales = [];
    for (const [symbol, txs] of Object.entries(state.transactions)) {
        txs.filter(t => t.type === 'sell').forEach(t => {
            allSales.push({ symbol, ...t });
        });
    }

    if (allSales.length === 0) {
        section.style.display = 'none';
        return;
    }

    // Sort by date descending
    allSales.sort((a, b) => new Date(b.date) - new Date(a.date));

    let totalRealized = 0;
    allSales.forEach(s => { totalRealized += s.realizedGainLoss || 0; });

    const realizedColor = totalRealized >= 0 ? '#4ade80' : '#f87171';

    section.style.display = 'block';
    const content = section.querySelector('.card') || section;

    content.innerHTML = `
        <h2 style="margin-bottom: 15px;">\uD83D\uDCC9 Sales History</h2>
        <div style="margin-bottom: 15px; font-size: 14px; color: #94a3b8;">
            Total realized P&L: <span style="color: ${realizedColor}; font-weight: bold;">${totalRealized >= 0 ? '+' : ''}${formatCurrency(totalRealized)}</span>
            &bull; ${allSales.length} sale${allSales.length !== 1 ? 's' : ''}
        </div>
        <div style="overflow-x: auto;">
            <table class="sales-history-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Symbol</th>
                        <th>Shares Sold</th>
                        <th>Sale Price</th>
                        <th>Cost Basis</th>
                        <th>Sale Amount</th>
                        <th>Realized P&L</th>
                    </tr>
                </thead>
                <tbody>
                    ${allSales.map(s => {
                        const plColor = (s.realizedGainLoss || 0) >= 0 ? '#4ade80' : '#f87171';
                        return `<tr>
                            <td>${escapeHTML(s.date)}</td>
                            <td style="font-weight: 600; color: #60a5fa;">${escapeHTML(s.symbol)}</td>
                            <td>${s.shares}</td>
                            <td>${formatCurrency(s.price)}</td>
                            <td>${s.costBasis ? formatCurrency(s.costBasis) : '\u2014'}</td>
                            <td>${formatCurrency(s.totalAmount)}</td>
                            <td style="color: ${plColor}; font-weight: bold;">
                                ${s.realizedGainLoss !== undefined ? `${s.realizedGainLoss >= 0 ? '+' : ''}${formatCurrency(s.realizedGainLoss)}` : '\u2014'}
                            </td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

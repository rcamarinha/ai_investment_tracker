/**
 * Portfolio service — rendering, import, snapshots, history, and position management.
 */

import state from './state.js';
import { escapeHTML, formatCurrency, formatPercent, buildAssetRecord, normalizeAssetType, detectStockExchange } from './utils.js';
import { getSector } from '../data/sectors.js';
import { renderAllocationCharts } from './ui.js';
import { saveSnapshotToDB, clearHistoryFromDB, savePortfolioDB,
         saveTransactionsToDB, deleteTransactionsForSymbol,
         saveAssetsToDB, loadAssetsFromDB, deleteSnapshotFromDB } from './storage.js';
import { fetchMarketPrices, fetchStockPrice, getExchangeRate, searchTickerByName } from './pricing.js';
import { getAssetCurrency, toBaseCurrency } from './utils.js';
import { parseBrokerExport, normalizeTrades,
         buildExistingFingerprints, dedupeTrades,
         computePositionsFromLedger,
         collectUnresolved, applyUnresolvedDecisions } from './import-brokers.js';

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
    if (!positionsDiv) {
        console.warn('renderPortfolio: #positions element not found');
        return;
    }

    // Separate active and inactive positions
    const activePositions = state.portfolio.filter(p => p.shares > 0);
    const inactivePositions = state.portfolio.filter(p => p.shares <= 0);

    // Scope totals to the active sector filter (if any)
    const filteredActivePositions = state.selectedSector
        ? activePositions.filter(p => getSector(p.symbol) === state.selectedSector)
        : activePositions;

    const base = state.baseCurrency || 'EUR';
    let totalInvestedBase = 0;  // In base currency (EUR)
    let totalMarketValueBase = 0;
    let positionsWithPrices = 0;

    filteredActivePositions.forEach(p => {
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
    if (!portfolioHeader) {
        console.warn('renderPortfolio: .portfolio-header element not found');
        return;
    }
    const totalGainLoss = totalMarketValueBase - totalInvestedBase;
    const totalGainLossPct = totalInvestedBase > 0 ? (totalGainLoss / totalInvestedBase) * 100 : 0;
    const gainLossColor = totalGainLoss >= 0 ? 'var(--up)' : 'var(--down)';
    const hasRates = Object.keys(state.exchangeRates).length > 0;

    const inactiveToggle = inactivePositions.length > 0
        ? `<span class="inactive-toggle" onclick="toggleInactivePositions()">${state.showInactivePositions ? 'Hide' : 'Show'} ${inactivePositions.length} closed position${inactivePositions.length !== 1 ? 's' : ''}</span>`
        : '';

    // Portfolio-wide income & fees (base currency), from the full ledger.
    const inc = computeIncomeTotalsBase();
    const incomeFeesRow = (inc.netIncome > 0 || inc.fees > 0) ? `
        <div style="margin-top: 8px; display: flex; gap: 16px; justify-content: flex-end; font-size: 12px;">
            ${inc.netIncome > 0 ? `<div><span style="color: var(--text-secondary);">Income</span> <span style="color: var(--up); font-weight: 600;">+${formatCurrency(inc.netIncome, base)}</span></div>` : ''}
            ${inc.fees > 0 ? `<div><span style="color: var(--text-secondary);">Fees</span> <span style="color: var(--down); font-weight: 600;">−${formatCurrency(inc.fees, base)}</span></div>` : ''}
        </div>` : '';

    portfolioHeader.innerHTML = `
        <div>
            <h2 style="margin-bottom: 5px;">\uD83D\uDCBC Your Portfolio</h2>
            <div style="font-size: 13px; color: var(--text-secondary);">
                ${filteredActivePositions.length} position${filteredActivePositions.length !== 1 ? 's' : ''}${state.selectedSector ? ` of ${activePositions.length}` : ''}
                ${Object.keys(state.marketPrices).length > 0 ? ` \u2022 ${positionsWithPrices} with live prices` : ' \u2022 Click "Update Prices" for live market data'}
                ${hasRates ? ` \u2022 FX rates loaded` : ''}
                ${inactiveToggle}
                ${state.selectedSector ? `<span style="color: var(--gold); margin-left: 8px;">Filtered: ${escapeHTML(state.selectedSector)} <span style="cursor:pointer; color:var(--down);" role="button" tabindex="0" onclick="toggleSectorFilter('${escapeHTML(state.selectedSector).replace(/'/g, "\\'")}')">✕</span></span>` : ''}
            </div>
        </div>
        <div class="total-value">
            <div style="color: var(--text-secondary); font-size: 12px;">Total Invested (${escapeHTML(base)})</div>
            <div style="color: var(--text-primary); font-size: 16px; margin-bottom: 5px;">${formatCurrency(totalInvestedBase, base)}</div>
            <div style="color: var(--text-secondary); font-size: 12px;">Market Value (${escapeHTML(base)})</div>
            <div style="color: ${gainLossColor}; font-size: 24px; font-weight: bold;">${formatCurrency(totalMarketValueBase, base)}</div>
            ${totalInvestedBase > 0 ? `
                <div style="color: ${gainLossColor}; font-size: 14px; margin-top: 5px;">
                    ${formatCurrency(totalGainLoss, base)} (${formatPercent(totalGainLossPct)})
                </div>
            ` : ''}
            ${incomeFeesRow}
        </div>
    `;

    if (state.portfolio.length === 0) {
        positionsDiv.innerHTML = '<div style="text-align: center; color: var(--text-tertiary); padding: 40px;">No positions yet. Click "Add Position" or import your portfolio to get started.</div>';
        return;
    }

    // Build display list: active + optionally inactive, filtered by sector
    let displayPositions = state.showInactivePositions
        ? [...activePositions, ...inactivePositions]
        : [...activePositions];

    if (state.selectedSector) {
        displayPositions = displayPositions.filter(p => getSector(p.symbol) === state.selectedSector);
    }

    let html = '';

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
        const pnlClass = gainLoss >= 0 ? 'up' : 'down';

        // Price metadata
        const metadata = state.priceMetadata[pos.symbol];
        let statusFlag = '\u23F3';
        let statusColor = 'var(--gold-dim)';
        let statusText = 'Pending';
        let timestampText = '';

        if (metadata) {
            if (metadata.success) {
                statusFlag = '\u2713';
                statusColor = 'var(--up)';
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
                statusColor = 'var(--down)';
                statusText = metadata.error || 'Failed';
                timestampText = 'Failed to fetch';
            }
        }

        const escapedSymbol = escapeHTML(pos.symbol).replace(/'/g, "\\'");
        const sector = getSector(pos.symbol);
        const tickerBadge = escapeHTML(pos.symbol.substring(0, 5));
        const displayName = pos.name
            ? escapeHTML(pos.name.length > 35 ? pos.name.substring(0, 32) + '...' : pos.name)
            : escapeHTML(pos.symbol);
        // DS asset-type class for left-border and icon color
        const typeRaw = (pos.type || '').toLowerCase();
        const assetTypeClass = typeRaw === 'etf' ? 'etf' : typeRaw === 'crypto' ? 'crypto' : typeRaw === 'wine' ? 'wine' : 'stock';
        const subTypeParts = [];
        if (pos.type) subTypeParts.push(escapeHTML(pos.type));
        if (sector !== 'Other') subTypeParts.push(escapeHTML(sector));
        const cardSub = subTypeParts.join(' \u00B7 ');
        const positionSub = isActive
            ? `${pos.shares} shs \u00B7 avg ${formatCurrency(pos.avgPrice, currency)}`
            : 'Closed';
        const priceSub = isActive
            ? (hasPrice ? `${formatCurrency(currentPrice, currency)} \u00B7 ${weight.toFixed(1)}%` : '\u23F3 Pending')
            : '';
        const platformBadge = (pos.platform && pos.platform !== 'Unknown')
            ? `<span class="pos-platform">${escapeHTML(pos.platform)}</span>`
            : '';

        // Action buttons: active positions get refresh/buy/sell/delete; inactive get just delete
        const actionButtons = isActive
            ? `<button class="position-action-btn action-refresh" title="Refresh price" onclick="refreshSinglePrice('${escapedSymbol}')">&#x21bb;</button>
               <button class="position-action-btn action-buy" title="Add shares" onclick="showEditPositionDialog('${escapedSymbol}','buy')">+</button>
               <button class="position-action-btn action-sell" title="Sell shares" onclick="showEditPositionDialog('${escapedSymbol}','sell')">-</button>
               <button class="position-action-btn action-del" title="Delete position" onclick="deletePosition('${escapedSymbol}')">&#x2717;</button>`
            : `<button class="position-action-btn action-del" title="Delete position" onclick="deletePosition('${escapedSymbol}')">&#x2717;</button>`;

        return `
        <div class="pos-card ${assetTypeClass}${isActive ? '' : ' inactive'}" title="${escapeHTML(pos.name || pos.symbol)}${pos.platform ? '\nPlatform: ' + escapeHTML(pos.platform) : ''}${sector !== 'Other' ? '\nSector: ' + escapeHTML(sector) : ''}">
            <div class="pos-icon ${assetTypeClass}">${tickerBadge}</div>
            <div>
                <div class="pos-name">
                    <span class="pos-status-dot" style="color:${statusColor}" title="${escapeHTML(statusText)}">${statusFlag}</span>
                    ${displayName}
                </div>
                <div class="pos-sub">${cardSub}</div>
                <div class="pos-sub">${positionSub}${timestampText ? ' \u00B7 ' + escapeHTML(timestampText) : ''}</div>
                ${(pos.untracked || isISIN(pos.symbol)) ? `<div class="pos-sub" style="color: var(--gold);" title="No ticker mapping \u2014 live price disabled. Re-import and map a ticker, or it stays cost-only.">\u26A0 untracked \u00B7 no live price</div>` : ''}
                ${(pos.dividends > 0) ? `<div class="pos-sub" style="color: var(--up);">\uD83D\uDCB0 ${formatCurrency(pos.dividends - (pos.taxWithheld || 0), currency)} income${(pos.avgPrice > 0 && pos.shares > 0) ? ` \u00B7 ${formatPercent((pos.dividends - (pos.taxWithheld || 0)) / (pos.avgPrice * pos.shares) * 100)} yld/cost` : ''}</div>` : ''}
                ${platformBadge}
                <div class="position-actions">${actionButtons}</div>
            </div>
            <div class="pos-right">
                <div class="pos-value">${isActive ? formatCurrency(marketValue, currency) : '\u2014'}</div>
                ${isActive ? `<div class="pos-change ${pnlClass}">${gainLoss >= 0 ? '+' : ''}${formatCurrency(gainLoss, currency)} (${formatPercent(gainLossPct)})</div>` : ''}
                ${priceSub ? `<div class="pos-sub">${priceSub}</div>` : ''}
            </div>
        </div>
        `;
    }).join('');

    // Safety banner: a sell drove some holding's share count negative — a sign of
    // an unhandled split, ISIN change, or a missing buy. Surface it rather than
    // showing silently-corrupted numbers.
    const reviewBanner = state.ledgerNeedsReview
        ? `<div style="background: var(--gold-glow); border-left: 3px solid var(--gold); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; font-size: 13px; color: var(--gold);">⚠ Some holdings show more sold than bought — likely an unhandled split or ISIN change. Re-import the broker export and use the review step to mark splits, or adjust the transactions in the ledger.</div>`
        : '';
    positionsDiv.innerHTML = reviewBanner + html;
    renderAllocationCharts();
    renderSalesHistory();
    renderIncomeHistory();
    renderTransactionsLedger();
    console.log('Portfolio rendered successfully');
}

// ── Top Movers Section ───────────────────────────────────────────────────────

/**
 * Render the "Biggest Movers Since Last Update" card above the positions list.
 * @param {Array} movers  - [{symbol, name, prevPrice, newPrice, changePct}]
 * @param {string} updatedAt - ISO timestamp of when prices were fetched
 */
export function renderMoversSection(movers, updatedAt) {
    const section = document.getElementById('moversSection');
    if (!section) return;

    if (!movers || movers.length === 0) {
        section.style.display = 'none';
        return;
    }

    const gainers = movers.filter(m => m.changePct > 0)
        .sort((a, b) => b.changePct - a.changePct)
        .slice(0, 3);
    const losers = movers.filter(m => m.changePct < 0)
        .sort((a, b) => a.changePct - b.changePct)
        .slice(0, 3);

    if (gainers.length === 0 && losers.length === 0) {
        section.style.display = 'none';
        return;
    }

    const timeLabel = updatedAt
        ? new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

    const chipHtml = (mover, isGain) => `
        <div class="mover-chip ${isGain ? 'gain' : 'loss'}">
            <span class="mover-symbol">${escapeHTML(mover.symbol)}</span>
            <span class="mover-name">${escapeHTML(mover.name !== mover.symbol ? mover.name : '')}</span>
            <span class="mover-pct ${isGain ? 'gain' : 'loss'}">${formatPercent(mover.changePct)}</span>
        </div>
    `;

    section.innerHTML = `
        <div class="movers-section">
            <div class="movers-header">
                <div class="movers-title">📊 Biggest Movers Since Last Update</div>
                ${timeLabel ? `<div class="movers-timestamp">Updated ${escapeHTML(timeLabel)}</div>` : ''}
            </div>
            <div class="movers-grid">
                <div>
                    <div class="movers-column-header gainers">▲ Top Gainers</div>
                    ${gainers.length > 0
                        ? gainers.map(m => chipHtml(m, true)).join('')
                        : '<div style="color:var(--text-tertiary);font-size:13px;">No gainers this update</div>'}
                </div>
                <div>
                    <div class="movers-column-header losers">▼ Top Losers</div>
                    ${losers.length > 0
                        ? losers.map(m => chipHtml(m, false)).join('')
                        : '<div style="color:var(--text-tertiary);font-size:13px;">No losers this update</div>'}
                </div>
            </div>
            <div class="movers-ai-section">
                <div class="movers-ai-label">🤖 AI Insight</div>
                <div class="movers-ai-text movers-ai-loading" id="moversAiText">Analyzing what drove these moves…</div>
            </div>
        </div>
    `;
    section.style.display = 'block';
}

// ── Import Dialog ───────────────────────────────────────────────────────────

export function showImportDialog() {
    if (!requireAuth('import positions')) return;
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
        const fileInput = document.getElementById('tradeFileInput');
        if (fileInput) fileInput.value = '';
        // Reset import mode to default
        const addRadio = document.querySelector('input[name="importMode"][value="add"]');
        if (addRadio) addRadio.checked = true;
        // Reset top-level import type back to Trades (the default)
        if (typeof window !== 'undefined' && typeof window.setImportType === 'function') {
            window.setImportType('trades');
        }
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
async function persistISINMapping(isin, resolved, source = 'api') {
    const ticker = resolved.ticker;
    state.assetDatabase[ticker] = {
        ...(state.assetDatabase[ticker] || {}),
        name: resolved.name || ticker,
        ticker,
        assetType: resolved.type || 'Stock',
        isin,
        source
    };

    try {
        await saveAssetsToDB([{
            ticker,
            name: resolved.name || ticker,
            asset_type: resolved.type || 'Stock',
            isin,
            stock_exchange: resolved.exchange || '',
            sector: 'Other',
            currency: 'USD',
            source
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
            if (statusEl) statusEl.innerHTML = `<div style="color: var(--gold); padding: 10px; font-size: 13px;">\u23F3 Resolving ISINs — Finnhub lookup (${Object.keys(resultMap).length + 1}/${identifiers.length})...</div>`;
            const candidates = await lookupISINviaFinnhub(id);
            if (candidates.length > 1) {
                // Multiple listings found — let user pick later
                const best = pickBestTicker(candidates);
                resultMap[id.toUpperCase()] = {
                    ...best,
                    confident: false,
                    multipleListings: true,
                    alternatives: candidates.filter(c => c.ticker !== best.ticker)
                };
                console.log(`ISIN ${id} → ${best.ticker} (Finnhub, ${candidates.length} listing(s) — user will pick)`);
                await persistISINMapping(id.toUpperCase(), best);
            } else if (candidates.length === 1) {
                resultMap[id.toUpperCase()] = { ...candidates[0], confident: true };
                console.log(`ISIN ${id} → ${candidates[0].ticker} (Finnhub, single match)`);
                await persistISINMapping(id.toUpperCase(), candidates[0]);
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
            if (statusEl) statusEl.innerHTML = `<div style="color: var(--gold); padding: 10px; font-size: 13px;">\u23F3 Resolving ISINs — FMP lookup (${Object.keys(resultMap).length + 1}/${identifiers.length})...</div>`;
            const candidates = await lookupISINviaFMP(id);
            if (candidates.length > 1) {
                const best = pickBestTicker(candidates);
                resultMap[id.toUpperCase()] = {
                    ...best,
                    confident: false,
                    multipleListings: true,
                    alternatives: candidates.filter(c => c.ticker !== best.ticker)
                };
                console.log(`ISIN ${id} → ${best.ticker} (FMP, ${candidates.length} listing(s) — user will pick)`);
                await persistISINMapping(id.toUpperCase(), best);
            } else if (candidates.length === 1) {
                resultMap[id.toUpperCase()] = { ...candidates[0], confident: true };
                console.log(`ISIN ${id} → ${candidates[0].ticker} (FMP, single match)`);
                await persistISINMapping(id.toUpperCase(), candidates[0]);
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
    if (statusEl) statusEl.innerHTML = `<div style="color: var(--gold); padding: 10px; font-size: 13px;">\u23F3 Resolving ${needsClaude.length} remaining ISIN(s) via Claude AI...</div>`;

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
                model: 'claude-sonnet-4-6',
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

    let html = `<div class="import-report" style="background: var(--surface); border-radius: 10px; padding: 18px; margin-bottom: 15px; font-size: 13px; max-height: 350px; overflow-y: auto;">`;
    html += `<div style="font-weight: 700; font-size: 15px; color: var(--text-primary); margin-bottom: 10px;">Import Report</div>`;
    html += `<div style="color: var(--up); margin-bottom: 4px;">\u2713 Successfully parsed: ${successCount} positions</div>`;
    if (errCount > 0) html += `<div style="color: var(--down); margin-bottom: 4px;">\u2717 Failed: ${errCount} lines</div>`;
    if (warnCount > 0) html += `<div style="color: var(--gold); margin-bottom: 4px;">\u26A0 Warnings: ${warnCount}</div>`;

    if (warnings.length > 0) {
        html += `<div style="margin-top: 10px; padding: 10px; background: var(--gold-glow); border-radius: 6px; border-left: 3px solid var(--gold);">`;
        warnings.forEach(w => { html += `<div style="color: var(--gold); font-size: 12px; margin-bottom: 3px;">\u26A0 ${escapeHTML(w)}</div>`; });
        html += `</div>`;
    }

    if (errors.length > 0) {
        html += `<div style="margin-top: 10px; padding: 10px; background: rgba(224,90,90,0.08); border-radius: 6px; border-left: 3px solid var(--down);">`;
        errors.slice(0, 15).forEach(e => { html += `<div style="color: var(--down); font-size: 12px; margin-bottom: 3px;">${escapeHTML(e)}</div>`; });
        if (errors.length > 15) html += `<div style="color: var(--down); font-size: 11px;">... and ${errors.length - 15} more</div>`;
        html += `</div>`;
    }

    if (successCount > 0) {
        html += `<div style="margin-top: 12px;"><div style="color: var(--text-secondary); font-size: 11px; text-transform: uppercase; margin-bottom: 6px;">Parsed positions (first 10)</div>`;
        newPositions.slice(0, 10).forEach(p => {
            const priceNote = p._needsCurrentPrice ? ' <span style="color:var(--gold);">(price TBD)</span>' : '';
            const isinNote = p._resolvedFrom ? ` <span style="color:var(--gold);">(from ${escapeHTML(p._resolvedFrom)})</span>` : '';
            html += `<div style="color: var(--text-primary); font-size: 12px; margin-bottom: 2px;">\u2022 <strong>${escapeHTML(p.symbol)}</strong>${isinNote}: ${p.shares} shares @ ${p.avgPrice > 0 ? '$' + p.avgPrice.toFixed(2) : 'pending'}${priceNote}</div>`;
        });
        if (successCount > 10) html += `<div style="color: var(--text-secondary); font-size: 11px;">... and ${successCount - 10} more</div>`;
        html += `</div>`;
    }

    html += `</div>`;
    container.innerHTML = html;
}

/**
 * Show a modal dialog for the user to pick which ticker/exchange listing to use
 * when an ISIN maps to multiple tickers.
 * Returns a promise that resolves with the chosen { ticker, name, type, exchange }.
 */
function showTickerPickerDialog(isin, primary, alternatives) {
    return new Promise(resolve => {
        const allOptions = [primary, ...alternatives];

        // Build exchange labels from ticker suffix or explicit exchange field
        const optionsHTML = allOptions.map((opt, idx) => {
            const exchange = opt.exchange || detectStockExchange(opt.ticker);
            const typeBadge = opt.type && opt.type !== 'Stock' ? opt.type : '';
            return `
                <label class="ticker-option${idx === 0 ? ' selected' : ''}" data-idx="${idx}">
                    <input type="radio" name="tickerPick" value="${idx}" ${idx === 0 ? 'checked' : ''} style="display:none" />
                    <div>
                        <div class="to-ticker">${escapeHTML(opt.ticker)}${typeBadge ? ` <span style="font-size:10px;color:var(--wine-light)">${escapeHTML(typeBadge)}</span>` : ''}</div>
                        <div class="to-exchange">${escapeHTML(exchange)}${opt.name ? ' · ' + escapeHTML(opt.name) : ''}</div>
                    </div>
                    <span class="to-check">✓</span>
                </label>`
        }).join('');

        const overlay = document.createElement('div');
        overlay.className = 'ticker-picker-overlay';
        overlay.innerHTML = `
            <div class="ticker-picker-dialog">
                <h3>Multiple listings found</h3>
                <p><span style="color: var(--gold); font-weight: 600;">${escapeHTML(isin)}</span> is listed on multiple exchanges. Select the one you want to track:</p>
                <div class="ticker-picker-options">${optionsHTML}</div>
                <div class="ticker-picker-footer">
                    <button class="btn btn-primary" id="tickerPickerConfirm">Confirm Selection</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);

        // Click-to-select for DS .ticker-option style
        overlay.querySelectorAll('.ticker-option').forEach(label => {
            label.addEventListener('click', () => {
                overlay.querySelectorAll('.ticker-option').forEach(l => l.classList.remove('selected'));
                label.classList.add('selected');
                const radio = label.querySelector('input[type="radio"]');
                if (radio) radio.checked = true;
            });
        });

        overlay.querySelector('#tickerPickerConfirm').addEventListener('click', () => {
            const selected = overlay.querySelector('input[name="tickerPick"]:checked');
            const idx = selected ? parseInt(selected.value) : 0;
            const chosen = allOptions[idx];
            document.body.removeChild(overlay);
            resolve(chosen);
        });
    });
}

/**
 * Show a modal to classify ambiguous corporate-action / split rows surfaced by
 * the parser. Returns a promise resolving to an array of split records
 * ({ type:'split', symbol, identifier, date, ratio, name, currency, broker })
 * for the items the user chose to apply; ignored items are omitted.
 */
function showReviewDialog(reviewItems) {
    return new Promise(resolve => {
        const rowsHTML = reviewItems.map((r, idx) => {
            const isSplit = r.reason === 'possible_split';
            const label = isSplit
                ? `Looks like a <strong>split</strong> (${r.fromShares} → ${r.toShares})`
                : `Corporate action${r.signedShares ? ` (${r.signedShares > 0 ? '+' : ''}${r.signedShares} sh)` : ''}`;
            const ratioVal = isSplit && r.ratio ? Number(r.ratio).toFixed(4).replace(/\.?0+$/, '') : '';
            return `
                <tr data-idx="${idx}">
                    <td style="padding:6px 8px;">${escapeHTML(r.date || '')}</td>
                    <td style="padding:6px 8px;">${escapeHTML(r.symbol || r.identifier || '')}<div style="font-size:11px;color:var(--text-tertiary);">${escapeHTML(r.name || '')}</div></td>
                    <td style="padding:6px 8px;font-size:12px;">${label}</td>
                    <td style="padding:6px 8px;">
                        <select class="rv-action" style="font-size:12px;padding:3px;">
                            <option value="ignore" ${isSplit ? '' : 'selected'}>Ignore</option>
                            <option value="split" ${isSplit ? 'selected' : ''}>Apply as split</option>
                        </select>
                    </td>
                    <td style="padding:6px 8px;">
                        <input class="rv-ratio" type="number" step="any" min="0" placeholder="ratio" value="${ratioVal}" style="width:70px;font-size:12px;padding:3px;" />
                    </td>
                </tr>`;
        }).join('');

        const overlay = document.createElement('div');
        overlay.className = 'ticker-picker-overlay';
        overlay.innerHTML = `
            <div class="ticker-picker-dialog" style="max-width:640px;">
                <h3>⚠ Review ${reviewItems.length} non-trade row(s)</h3>
                <p style="font-size:13px;">These rows aren't plain buys/sells. Splits adjust your share count without changing cost basis. Choose how to handle each — <strong>Ignore</strong> is safe for cosmetic transfers/conversions.</p>
                <div style="max-height:320px;overflow-y:auto;margin:10px 0;">
                    <table style="width:100%;border-collapse:collapse;font-size:13px;">
                        <thead><tr style="text-align:left;color:var(--text-secondary);font-size:11px;text-transform:uppercase;">
                            <th style="padding:6px 8px;">Date</th><th style="padding:6px 8px;">Asset</th>
                            <th style="padding:6px 8px;">Detected</th><th style="padding:6px 8px;">Action</th><th style="padding:6px 8px;">Ratio</th>
                        </tr></thead>
                        <tbody>${rowsHTML}</tbody>
                    </table>
                </div>
                <div class="ticker-picker-footer" style="display:flex; gap:8px; justify-content:flex-end;">
                    <button class="btn btn-primary" id="reviewCancel">Cancel import</button>
                    <button class="btn btn-accent" id="reviewConfirm">Apply selections</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.querySelector('#reviewCancel').addEventListener('click', () => {
            document.body.removeChild(overlay);
            resolve(null); // signal: abort the whole import
        });

        overlay.querySelector('#reviewConfirm').addEventListener('click', () => {
            const out = [];
            overlay.querySelectorAll('tbody tr').forEach(tr => {
                const idx = Number(tr.dataset.idx);
                const r = reviewItems[idx];
                const action = tr.querySelector('.rv-action').value;
                const ratio = parseFloat(tr.querySelector('.rv-ratio').value);
                if (action === 'split' && ratio > 0) {
                    out.push({
                        type: 'split', symbol: r.symbol, identifier: r.identifier,
                        date: r.date, ratio, name: r.name, currency: r.currency, broker: r.broker,
                    });
                }
            });
            document.body.removeChild(overlay);
            resolve(out);
        });
    });
}

/**
 * Show a modal to manually map ISINs that auto-resolution couldn't handle.
 * Returns a promise resolving to { ISIN: { action:'map'|'untracked'|'skip', ticker?, type? } }.
 * Default is "map"; a blank ticker on "map" is treated as "skip".
 */
function showUnresolvedDialog(items) {
    return new Promise(resolve => {
        const rowsHTML = items.map((it, idx) => `
            <tr data-idx="${idx}" data-isin="${escapeHTML(it.identifier)}">
                <td style="padding:6px 8px;">
                    <div style="font-weight:600;">${escapeHTML(it.name || '—')}</div>
                    <div style="font-size:11px;color:var(--text-tertiary);font-family:var(--font-mono,monospace);">${escapeHTML(it.identifier)}</div>
                </td>
                <td style="padding:6px 8px;">
                    <input class="ur-ticker" type="text" placeholder="e.g. IUSQ.DE" style="width:110px;font-size:12px;padding:4px;text-transform:uppercase;" />
                </td>
                <td style="padding:6px 8px;">
                    <select class="ur-action" style="font-size:12px;padding:4px;">
                        <option value="map" selected>Map to ticker</option>
                        <option value="untracked">Keep untracked</option>
                        <option value="skip">Skip</option>
                    </select>
                </td>
            </tr>`).join('');

        const overlay = document.createElement('div');
        overlay.className = 'ticker-picker-overlay';
        overlay.innerHTML = `
            <div class="ticker-picker-dialog" style="max-width:620px;">
                <h3>🔎 ${items.length} symbol(s) couldn't be auto-resolved</h3>
                <p style="font-size:13px;">Enter the ticker each instrument trades under (include an exchange suffix if needed, e.g. <code>IUSQ.DE</code>). Mapped tickers are remembered, so you'll only do this once per instrument. Nothing is dropped unless you choose <strong>Skip</strong>.</p>
                <div style="max-height:320px;overflow-y:auto;margin:10px 0;">
                    <table style="width:100%;border-collapse:collapse;font-size:13px;">
                        <thead><tr style="text-align:left;color:var(--text-secondary);font-size:11px;text-transform:uppercase;">
                            <th style="padding:6px 8px;">Instrument</th><th style="padding:6px 8px;">Ticker</th><th style="padding:6px 8px;">Action</th>
                        </tr></thead>
                        <tbody>${rowsHTML}</tbody>
                    </table>
                </div>
                <div class="ticker-picker-footer">
                    <button class="btn btn-accent" id="urConfirm">Apply</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.querySelector('#urConfirm').addEventListener('click', () => {
            const decisions = {};
            overlay.querySelectorAll('tbody tr').forEach(tr => {
                const isin = tr.dataset.isin;
                let action = tr.querySelector('.ur-action').value;
                const ticker = (tr.querySelector('.ur-ticker').value || '').trim().toUpperCase();
                if (action === 'map' && !ticker) action = 'skip'; // blank ticker → skip
                decisions[isin] = { action, ticker };
            });
            document.body.removeChild(overlay);
            resolve(decisions);
        });
    });
}

/**
 * Interactive "resolve missing prices" dialog, opened after a manual price
 * refresh leaves holdings unpriced. Per holding: confirm the AI suggestion,
 * search by name, enter a ticker, or keep at cost. Returns
 * [{ symbol, ticker?, keepAtCost? }]; the caller (pricing.js) validates each
 * ticker (fetches a price) before persisting it. Registered via
 * setMissingTickerResolver so pricing.js needs no static import of this module.
 */
export function resolveMissingTickers(items) {
    return new Promise(resolve => {
        const rows = items.map((it, idx) => `
            <tr data-idx="${idx}" data-symbol="${escapeHTML(it.symbol)}">
                <td style="padding:6px 8px;">
                    <div style="font-weight:600;">${escapeHTML(it.name || it.symbol)}</div>
                    <div style="font-size:11px;color:var(--text-tertiary);font-family:var(--font-mono,monospace);">${escapeHTML(it.symbol)}</div>
                </td>
                <td style="padding:6px 8px;">
                    <input class="rmt-ticker" type="text" placeholder="ticker" value="${escapeHTML(it.suggestion || '')}" style="width:96px;font-size:12px;padding:4px;text-transform:uppercase;" />
                    <button class="btn btn-sm btn-primary rmt-search" type="button" title="Search by name" style="margin-left:4px;">🔎</button>
                </td>
                <td style="padding:6px 8px;">
                    <select class="rmt-action" style="font-size:12px;padding:4px;">
                        <option value="map"${it.suggestion ? ' selected' : ''}>Use ticker</option>
                        <option value="cost"${it.suggestion ? '' : ' selected'}>Keep at cost</option>
                        <option value="skip">Skip</option>
                    </select>
                </td>
            </tr>`).join('');

        const overlay = document.createElement('div');
        overlay.className = 'ticker-picker-overlay';
        overlay.innerHTML = `
            <div class="ticker-picker-dialog" style="max-width:640px;">
                <h3>💹 ${items.length} holding(s) have no live price</h3>
                <p style="font-size:13px;">Map each to a ticker your data provider recognizes (a suggestion is pre-filled where we found one). Search by name if unsure, or keep it at cost. Tickers are validated before saving and remembered next time.</p>
                <div style="max-height:340px;overflow-y:auto;margin:10px 0;">
                    <table style="width:100%;border-collapse:collapse;font-size:13px;">
                        <thead><tr style="text-align:left;color:var(--text-secondary);font-size:11px;text-transform:uppercase;">
                            <th style="padding:6px 8px;">Holding</th><th style="padding:6px 8px;">Ticker</th><th style="padding:6px 8px;">Action</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
                <div class="ticker-picker-footer" style="display:flex;gap:8px;justify-content:flex-end;">
                    <button class="btn btn-primary" id="rmtCancel">Cancel</button>
                    <button class="btn btn-accent" id="rmtApply">Apply</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        // Per-row "search by name" → picker → fills the ticker input.
        overlay.querySelectorAll('.rmt-search').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tr = btn.closest('tr');
                const it = items[Number(tr.dataset.idx)];
                const query = prompt('Search ticker by name/description:', it.name || it.symbol);
                if (!query) return;
                btn.textContent = '…';
                const results = await searchTickerByName(query);
                btn.textContent = '🔎';
                if (!results.length) { alert('No matches found. Try a different name.'); return; }
                const chosen = await showTickerPickerDialog(
                    query,
                    { ticker: results[0].ticker, name: results[0].name, exchange: results[0].exchange },
                    results.slice(1).map(r => ({ ticker: r.ticker, name: r.name, exchange: r.exchange }))
                );
                if (chosen && chosen.ticker) {
                    tr.querySelector('.rmt-ticker').value = chosen.ticker.toUpperCase();
                    tr.querySelector('.rmt-action').value = 'map';
                }
            });
        });

        overlay.querySelector('#rmtCancel').addEventListener('click', () => { document.body.removeChild(overlay); resolve([]); });
        overlay.querySelector('#rmtApply').addEventListener('click', () => {
            const out = [];
            overlay.querySelectorAll('tbody tr').forEach(tr => {
                const symbol = tr.dataset.symbol;
                const action = tr.querySelector('.rmt-action').value;
                const ticker = (tr.querySelector('.rmt-ticker').value || '').trim().toUpperCase();
                if (action === 'cost') out.push({ symbol, keepAtCost: true });
                else if (action === 'map' && ticker) out.push({ symbol, ticker });
            });
            document.body.removeChild(overlay);
            resolve(out);
        });
    });
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
            if (statusEl) statusEl.innerHTML = `<div style="color: var(--gold); padding: 10px; font-size: 13px;">\u23F3 Resolving ${isinsToResolve.length} ISIN(s) via API lookup...</div>`;

            const resolved = await resolveIdentifiers(isinsToResolve);

            // Apply resolutions — show picker dialog when multiple listings exist
            const unresolvedISINs = [];
            for (const p of newPositions) {
                const resolution = resolved[p.symbol];
                if (resolution) {
                    const hasAlternatives = resolution.alternatives && resolution.alternatives.length > 0;

                    if (hasAlternatives) {
                        // Multiple listings or uncertain match — let user pick via modal
                        const chosen = await showTickerPickerDialog(
                            p.symbol,
                            { ticker: resolution.ticker, name: resolution.name, type: resolution.type, exchange: resolution.exchange },
                            resolution.alternatives
                        );
                        p._resolvedFrom = p.symbol;
                        p.symbol = chosen.ticker.toUpperCase();
                        p.name = chosen.name || p.name;
                        if (chosen.type) p.type = normalizeAssetType(chosen.type);
                        console.log(`User picked ${chosen.ticker} for ${p._resolvedFrom}`);
                    } else {
                        // Single confident match — apply directly
                        console.log(`Resolved ${p.symbol} \u2192 ${resolution.ticker} (${resolution.name})`);
                        p._resolvedFrom = p.symbol;
                        p.symbol = resolution.ticker;
                        p.name = resolution.name || p.name;
                        if (resolution.type) p.type = normalizeAssetType(resolution.type);
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
            if (!assetRecord) return; // skip if symbol was invalid
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

// ── Import Trades / Moves (ledger) ───────────────────────────────────────────

/** Human-readable platform label for a broker key. */
function brokerLabel(broker) {
    switch (broker) {
        case 'degiro': return 'DeGiro';
        case 'degiro_account': return 'DeGiro (Account)';
        case 'revolut': return 'Revolut';
        case 'bancobest': return 'BancoBest';
        default: return null;
    }
}

/** Split long text into <= maxLen chunks on line boundaries (for the AI fallback). */
function chunkText(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const lines = text.split('\n');
    const chunks = [];
    let cur = '';
    for (const line of lines) {
        if (cur.length + line.length + 1 > maxLen && cur) { chunks.push(cur); cur = ''; }
        cur += line + '\n';
    }
    if (cur.trim()) chunks.push(cur);
    return chunks;
}

/**
 * Extract trades from unstructured statement text via the extract-trades edge
 * function (used for Revolut PDF text and BancoBest option confirmations).
 * Returns an array of loose trade rows for normalizeTrades().
 */
async function extractTradesViaAI(text) {
    if (!state.supabaseUrl || !state.supabaseClient) {
        throw new Error('AI extraction needs Supabase configured. Use a DeGiro/Revolut CSV instead, or paste structured columns (Ticker, Side, Quantity, Price).');
    }
    const chunks = chunkText(text, 12000);
    const all = [];
    const { data: { session } } = await state.supabaseClient.auth.getSession();
    const reportArea = document.getElementById('importReportArea');

    for (let i = 0; i < chunks.length; i++) {
        if (reportArea) reportArea.innerHTML = `<div style="color: var(--gold); padding: 10px; font-size: 13px;">⏳ AI extracting trades… (part ${i + 1}/${chunks.length})</div>`;
        const response = await fetch(`${state.supabaseUrl}/functions/v1/extract-trades`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': state.supabaseAnonKey,
                ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
            },
            body: JSON.stringify({ text: chunks[i] }),
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`AI extraction failed (${response.status}): ${body.slice(0, 200)}`);
        const data = JSON.parse(body);
        const out = data.content?.find(c => c.type === 'text')?.text || '';
        const clean = out.replace(/```json|```/g, '').trim();
        let rows;
        try { rows = JSON.parse(clean); } catch { rows = []; }
        if (Array.isArray(rows)) all.push(...rows);
        else if (rows && Array.isArray(rows.trades)) all.push(...rows.trades);
    }
    return all;
}

/** Render the trade-import review report (new vs duplicate vs skipped). */
function showTradeReport(container, { trades, duplicates, errors, broker, usedAi, splits = 0, income = 0 }) {
    if (!container) return;
    let html = `<div class="import-report" style="background: var(--surface); border-radius: 10px; padding: 18px; margin-bottom: 15px; font-size: 13px; max-height: 350px; overflow-y: auto;">`;
    html += `<div style="font-weight: 700; font-size: 15px; color: var(--text-primary); margin-bottom: 10px;">Trade Import Report</div>`;
    const source = usedAi ? 'AI extraction' : (brokerLabel(broker) || 'CSV');
    html += `<div style="color: var(--text-secondary); font-size: 12px; margin-bottom: 8px;">Source: ${escapeHTML(source)}</div>`;
    html += `<div style="color: var(--up); margin-bottom: 4px;">✓ New trades: ${trades.length}</div>`;
    if (splits > 0) html += `<div style="color: var(--gold); margin-bottom: 4px;">↪ Splits / adjustments: ${splits}</div>`;
    if (income > 0) html += `<div style="color: var(--gold); margin-bottom: 4px;">💰 Dividends / fees / splits: ${income}</div>`;
    if (duplicates.length > 0) html += `<div style="color: var(--gold); margin-bottom: 4px;">↻ Already imported (skipped): ${duplicates.length}</div>`;
    if (errors.length > 0) html += `<div style="color: var(--down); margin-bottom: 4px;">✗ Issues: ${errors.length}</div>`;

    if (errors.length > 0) {
        html += `<div style="margin-top: 10px; padding: 10px; background: rgba(224,90,90,0.08); border-radius: 6px; border-left: 3px solid var(--down);">`;
        errors.slice(0, 12).forEach(e => { html += `<div style="color: var(--down); font-size: 12px; margin-bottom: 3px;">${escapeHTML(e)}</div>`; });
        if (errors.length > 12) html += `<div style="color: var(--down); font-size: 11px;">... and ${errors.length - 12} more</div>`;
        html += `</div>`;
    }

    if (trades.length > 0) {
        html += `<div style="margin-top: 12px;"><div style="color: var(--text-secondary); font-size: 11px; text-transform: uppercase; margin-bottom: 6px;">New trades (first 12)</div>`;
        trades.slice(0, 12).forEach(t => {
            const sideColor = t.side === 'buy' ? 'var(--up)' : 'var(--down)';
            const label = (t.symbol && t.symbol !== t.identifier) ? `${escapeHTML(t.symbol)} <span style="color:var(--text-tertiary);">(${escapeHTML(t.identifier)})</span>` : escapeHTML(t.symbol || t.identifier);
            html += `<div style="color: var(--text-primary); font-size: 12px; margin-bottom: 2px;">${escapeHTML(t.date || '')} • <span style="color:${sideColor};font-weight:600;text-transform:uppercase;">${t.side}</span> ${t.shares} ${label} @ ${t.price.toFixed(2)} ${escapeHTML(t.currency || '')}</div>`;
        });
        if (trades.length > 12) html += `<div style="color: var(--text-secondary); font-size: 11px;">... and ${trades.length - 12} more</div>`;
        html += `</div>`;
    }

    html += `</div>`;
    container.innerHTML = html;
}

/**
 * Recompute state.portfolio holdings from the full transactions ledger
 * (average-cost basis). Updates existing positions in place, adds new active
 * ones, and zeroes out fully-closed positions (kept as inactive).
 */
export function rebuildPositionsFromLedger() {
    const computed = computePositionsFromLedger(state.transactions);
    let needsReview = false;
    for (const [symbol, data] of Object.entries(computed)) {
        if (data.needsReview) needsReview = true;
        // Reserved cash/fee bucket — not a real holding; income totals read the
        // ledger directly, so don't materialize it as a position card.
        if (symbol === 'CASH') continue;
        // Per-asset income/cost aggregates derived from the ledger (used by the UI)
        const agg = {
            dividends: data.dividends, taxWithheld: data.taxWithheld,
            feesPaid: data.feesPaid, realizedPnL: data.realizedPnL,
        };
        const existing = state.portfolio.find(p => p.symbol === symbol);
        if (existing) {
            existing.shares = data.shares;
            if (data.shares > 0) existing.avgPrice = data.avgPrice;
            Object.assign(existing, agg);
        } else if (data.shares > 0 || data.dividends || data.realizedPnL || data.feesPaid) {
            const meta = state.assetDatabase[symbol] || {};
            const txs = state.transactions[symbol] || [];
            const broker = txs.length ? txs[txs.length - 1].broker : null;
            state.portfolio.push({
                name: meta.name || symbol,
                symbol,
                platform: brokerLabel(broker) || 'Imported',
                type: meta.assetType || 'Stock',
                shares: data.shares,
                avgPrice: data.avgPrice,
                isin: meta.isin || null,
                untracked: !!meta.untracked,
                ...agg,
            });
        }
        // Keep isin/untracked current on existing positions too (from the asset DB)
        if (existing) {
            const meta = state.assetDatabase[symbol];
            if (meta) { existing.isin = meta.isin || existing.isin || null; existing.untracked = !!meta.untracked; }
        }
    }
    state.ledgerNeedsReview = needsReview;
}

/**
 * Import a broker trade export into the transaction ledger.
 * Pipeline: parse (CSV or AI) → resolve ISINs → dedupe → review → commit →
 * rebuild positions → persist → fetch prices.
 */
export async function importTrades() {
    if (!requireAuth('import trades')) return;
    console.log('=== IMPORT TRADES STARTED ===');

    const textarea = document.getElementById('importText');
    const text = (textarea?.value || '').trim();
    const reportArea = document.getElementById('importReportArea');
    if (!text) {
        alert('Paste a broker export (or choose a CSV/PDF file) first.');
        return;
    }

    try {
        // ── Step 1: Parse to normalized trades (structured CSV or AI fallback) ──
        let parsed = parseBrokerExport(text);
        let usedAi = false;
        if (!parsed.broker) {
            if (reportArea) reportArea.innerHTML = `<div style="color: var(--gold); padding: 10px; font-size: 13px;">⏳ No broker CSV detected — extracting trades with AI…</div>`;
            const aiRows = await extractTradesViaAI(text);
            parsed = normalizeTrades(aiRows, 'generic');
            usedAi = true;
        }

        let trades = parsed.trades;
        let reviewItems = parsed.review || [];
        let incomeItems = parsed.income || [];
        let errors = [...parsed.errors];

        if (trades.length === 0 && reviewItems.length === 0 && incomeItems.length === 0) {
            showTradeReport(reportArea, { trades: [], duplicates: [], errors: errors.length ? errors : ['No trades found in the input.'], broker: parsed.broker, usedAi });
            alert('❌ No trades could be parsed from the input.');
            return;
        }

        // ── Step 2: Resolve ISIN identifiers → tickers (trades + review + income) ───
        const isins = [...new Set([...trades, ...reviewItems, ...incomeItems].filter(x => x.isISIN).map(x => x.identifier))];
        if (isins.length > 0) {
            if (reportArea) reportArea.innerHTML = `<div style="color: var(--gold); padding: 10px; font-size: 13px;">⏳ Resolving ${isins.length} ISIN(s)…</div>`;
            const resolved = await resolveIdentifiers(isins);
            for (const t of trades) {
                if (!t.isISIN) continue;
                const r = resolved[t.identifier];
                if (!r) continue; // handled by the unresolved dialog below
                if (r.alternatives && r.alternatives.length) {
                    const chosen = await showTickerPickerDialog(
                        t.identifier,
                        { ticker: r.ticker, name: r.name, type: r.type, exchange: r.exchange },
                        r.alternatives
                    );
                    t.symbol = chosen.ticker.toUpperCase();
                    t.name = t.name || chosen.name;
                    if (chosen.type) t.assetType = normalizeAssetType(chosen.type);
                } else {
                    t.symbol = r.ticker.toUpperCase();
                    t.name = t.name || r.name;
                    if (r.type) t.assetType = normalizeAssetType(r.type);
                }
            }
            // Apply resolution to review + income items too (primary match, no picker)
            for (const x of [...reviewItems, ...incomeItems]) {
                if (!x.isISIN) continue;
                const r = resolved[x.identifier];
                if (r) { x.symbol = r.ticker.toUpperCase(); x.name = x.name || r.name; }
            }

            // ── Step 2b: Manually map whatever couldn't be auto-resolved ────
            // Don't silently drop — surface each unresolved ISIN so the user can
            // map it to a ticker (persisted for next time), keep it untracked, or skip.
            const allItems = [...trades, ...reviewItems, ...incomeItems];
            const unresolvedList = collectUnresolved(allItems, resolved);
            if (unresolvedList.length > 0) {
                const decisions = await showUnresolvedDialog(unresolvedList);
                applyUnresolvedDecisions(allItems, decisions);
                // Persist user ticker maps so the ISIN auto-resolves on future imports.
                for (const u of unresolvedList) {
                    const d = decisions[u.identifier];
                    if (d && d.action === 'map' && d.ticker) {
                        await persistISINMapping(
                            u.identifier,
                            { ticker: d.ticker.toUpperCase(), name: u.name || d.ticker, type: 'Stock' },
                            'user'
                        );
                    } else if (d && d.action === 'untracked') {
                        // Register the untracked instrument so pricing skips it and the ISIN is recoverable.
                        const sym = u.identifier.toUpperCase();
                        state.assetDatabase[sym] = {
                            ...(state.assetDatabase[sym] || {}),
                            name: u.name || sym, ticker: sym, isin: u.identifier.toUpperCase(),
                            assetType: 'Other', untracked: true, source: 'user',
                        };
                    }
                }
            }
            // Drop only trades the user explicitly skipped (still no symbol)
            const skippedSyms = new Set();
            trades = trades.filter(t => { if (t.isISIN && !t.symbol) { skippedSyms.add(t.identifier); return false; } return true; });
            if (skippedSyms.size) {
                errors.push(`Skipped ${skippedSyms.size} unresolved instrument(s): ${[...skippedSyms].join(', ')}.`);
            }
        }
        // Non-ISIN items use the identifier directly as the ticker
        trades.forEach(t => { if (!t.symbol) t.symbol = t.identifier.toUpperCase(); });
        reviewItems = reviewItems.filter(rv => !(rv.isISIN && !rv.symbol));
        reviewItems.forEach(rv => { if (!rv.symbol) rv.symbol = (rv.identifier || '').toUpperCase(); });
        incomeItems = incomeItems.filter(it => !(it.isISIN && !it.symbol));
        incomeItems.forEach(it => { if (!it.symbol) it.symbol = (it.identifier || '').toUpperCase(); });

        // ── Step 3: Dedupe against the existing ledger ─────────────────────
        const existing = buildExistingFingerprints(state.transactions);
        const { fresh, duplicates } = dedupeTrades(trades, existing);
        const { fresh: freshIncome } = dedupeTrades(incomeItems, existing);

        // ── Step 3b: Classify ambiguous corporate-action / split rows ──────
        let freshExtra = [];
        if (reviewItems.length > 0) {
            const decisions = await showReviewDialog(reviewItems);
            if (decisions === null) {
                if (reportArea) reportArea.innerHTML = `<div style="color: var(--text-secondary); padding: 10px; font-size: 13px;">Import cancelled.</div>`;
                return; // user aborted from the review step
            }
            ({ fresh: freshExtra } = dedupeTrades(decisions, existing));
        }

        // ── Step 4: Review and confirm ─────────────────────────────────────
        showTradeReport(reportArea, { trades: fresh, duplicates, errors, broker: parsed.broker, usedAi, splits: freshExtra.length, income: freshIncome.length });

        if (fresh.length === 0 && freshExtra.length === 0 && freshIncome.length === 0) {
            alert(duplicates.length
                ? `✓ All ${duplicates.length} trade(s) are already in your ledger — nothing new to import.`
                : '❌ No new trades to import.');
            return;
        }

        const incomeBits = [];
        if (freshExtra.length) incomeBits.push(`${freshExtra.length} split/adjustment(s)`);
        if (freshIncome.length) incomeBits.push(`${freshIncome.length} dividend/fee row(s)`);
        let confirmMsg = `Import ${fresh.length} new trade(s)${incomeBits.length ? ` + ${incomeBits.join(' + ')}` : ''} into your ledger?`;
        if (duplicates.length) confirmMsg += `\n\n↻ ${duplicates.length} duplicate(s) already imported will be skipped.`;
        if (errors.length) confirmMsg += `\n\n✗ ${errors.length} issue(s) — see the report.`;
        if (!confirm(confirmMsg)) return;

        // ── Step 5: Commit fresh items to the ledger ───────────────────────
        // Handles the full taxonomy: buy/sell trades plus dividend/fee/split/
        // isin_change rows (totalAmount = gross for trades, the amount for
        // dividend/fee; fees are stored separately, not folded into cost basis).
        [...fresh, ...freshExtra, ...freshIncome].forEach(t => {
            if (!state.transactions[t.symbol]) state.transactions[t.symbol] = [];
            const kind = (t.side || t.type || '').toLowerCase();
            const base = {
                date: t.date,
                currency: t.currency,
                exchangeRate: getExchangeRate(t.currency),
                timestamp: new Date().toISOString(),
                broker: t.broker,
            };
            let tx;
            if (kind === 'buy' || kind === 'sell') {
                tx = { ...base, type: kind, shares: t.shares, price: t.price,
                       totalAmount: t.shares * t.price, fee: t.fees || 0 };
            } else if (kind === 'dividend') {
                tx = { ...base, type: 'dividend', shares: 0, price: 0,
                       totalAmount: t.amount ?? 0, tax: t.tax || 0 };
            } else if (kind === 'fee') {
                tx = { ...base, type: 'fee', shares: 0, price: 0, totalAmount: t.amount ?? 0 };
            } else if (kind === 'split' || kind === 'isin_change') {
                // Two forms: DeGiro review → ratio (multiplicative); Revolut → shares delta (additive).
                tx = { ...base, type: kind, shares: t.shares || 0, price: 0, ratio: t.ratio ?? null, note: t.note || '' };
            } else {
                return; // unknown kind — skip
            }
            state.transactions[t.symbol].push(tx);

            if (t.symbol && !state.assetDatabase[t.symbol]) {
                const rec = buildAssetRecord({
                    name: t.name || t.symbol, symbol: t.symbol,
                    platform: brokerLabel(t.broker) || 'Imported',
                    type: t.assetType || 'Stock', shares: t.shares || 0, avgPrice: t.price || 0,
                });
                if (rec) state.assetDatabase[rec.ticker] = {
                    name: rec.name, ticker: rec.ticker, stockExchange: rec.stock_exchange,
                    sector: rec.sector, currency: rec.currency, assetType: rec.asset_type,
                };
            }
        });

        // ── Step 6: Rebuild positions from the full ledger ─────────────────
        rebuildPositionsFromLedger();

        // ── Step 7: Persist ───────────────────────────────────────────────
        await saveTransactionsToDB();
        saveTransactionsToStorage();
        await savePortfolioDB();
        closeImportDialog();
        renderPortfolio();

        // ── Step 8: Fetch current prices ───────────────────────────────────
        setTimeout(async () => {
            await fetchMarketPrices();
            renderPortfolio();
        }, 300);
        setTimeout(() => {
            alert(`✓ Imported ${fresh.length} trade(s) into your ledger.${duplicates.length ? `\n↻ ${duplicates.length} duplicate(s) skipped.` : ''}\n\nFetching current market prices…`);
        }, 200);

    } catch (err) {
        console.error('=== IMPORT TRADES ERROR ===', err);
        alert(`❌ Trade import failed: ${err.message}\n\nCheck the browser console (F12) for details.`);
    }
}

/**
 * Read an uploaded broker file into the import textarea.
 * CSV/TSV/text → loaded as-is. PDF → text extracted via pdf.js for the AI path.
 */
export async function handleTradeFile(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const textarea = document.getElementById('importText');
    const reportArea = document.getElementById('importReportArea');
    try {
        const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
        if (isPdf) {
            if (reportArea) reportArea.innerHTML = `<div style="color: var(--gold); padding: 10px; font-size: 13px;">⏳ Reading PDF — ${escapeHTML(file.name)}…</div>`;
            const text = await extractPdfText(file);
            if (textarea) textarea.value = text;
            if (reportArea) reportArea.innerHTML = `<div style="color: var(--text-secondary); padding: 10px; font-size: 13px;">✓ Extracted ${text.length} characters from PDF. Click <strong>Import Trades</strong> to parse with AI.</div>`;
        } else {
            const text = await file.text();
            if (textarea) textarea.value = text;
            const { detectBroker } = await import('./import-brokers.js');
            const broker = detectBroker(text);
            if (reportArea) reportArea.innerHTML = `<div style="color: var(--text-secondary); padding: 10px; font-size: 13px;">✓ Loaded ${escapeHTML(file.name)}${broker ? ` (detected: ${brokerLabel(broker)})` : ''}. Click <strong>Import Trades</strong>.</div>`;
        }
    } catch (err) {
        console.error('=== TRADE FILE READ ERROR ===', err);
        alert(`❌ Could not read file: ${err.message}`);
    }
}

/** Extract text from a PDF File using pdf.js (vendored locally in /lib to
 *  satisfy the strict `script-src 'self'` CSP). */
async function extractPdfText(file) {
    const pdfjsLib = await import('../lib/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = '';
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        out += content.items.map(it => it.str).join(' ') + '\n';
    }
    return out;
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export async function savePortfolioSnapshot() {
    if (!requireAuth('save snapshots')) return;
    if (state.portfolio.length === 0) {
        alert('\u274C No portfolio to save. Import your portfolio first.');
        return;
    }

    const base = state.baseCurrency || 'EUR';
    let totalInvested = 0;
    let totalMarketValue = 0;

    const activePositions = state.portfolio.filter(p => p.shares > 0);

    activePositions.forEach(p => {
        const currency = getAssetCurrency(p.symbol);
        const investedNative = p.shares * p.avgPrice;

        // Invested in base currency: use transaction-stored rates if available, else current rate
        const txs = state.transactions[p.symbol];
        if (txs && txs.length > 0) {
            let investedBase = 0;
            txs.forEach(tx => {
                const rate = tx.exchangeRate || getExchangeRate(tx.currency || currency);
                if (tx.type === 'buy') investedBase += tx.totalAmount * rate;
            });
            const totalBuyShares = txs.filter(t => t.type === 'buy').reduce((s, t) => s + t.shares, 0);
            const remainingRatio = totalBuyShares > 0 ? p.shares / totalBuyShares : 1;
            totalInvested += investedBase * remainingRatio;
        } else {
            totalInvested += toBaseCurrency(investedNative, currency);
        }

        // Market value in base currency: always use current exchange rate
        const currentPrice = state.marketPrices[p.symbol];
        if (currentPrice) {
            totalMarketValue += toBaseCurrency(p.shares * currentPrice, currency);
        } else {
            totalMarketValue += toBaseCurrency(investedNative, currency);
        }
    });

    const snapshot = {
        timestamp: new Date().toISOString(),
        baseCurrency: base,
        totalInvested,
        totalMarketValue,
        positionCount: activePositions.length,
        pricesAvailable: Object.keys(state.marketPrices).length
    };

    state.portfolioHistory.push(snapshot);
    try {
        localStorage.setItem('portfolioHistory', JSON.stringify(state.portfolioHistory));
    } catch (err) {
        console.warn('Failed to save portfolio history to localStorage:', err);
    }

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
    alert(`\u2713 Portfolio snapshot saved!\n\nInvested: ${formatCurrency(totalInvested, base)}\nMarket Value: ${formatCurrency(totalMarketValue, base)}\nGain/Loss: ${formatCurrency(gainLoss, base)} (${formatPercent(gainLossPct)})\n\nAll values converted to ${base}\nTotal snapshots: ${state.portfolioHistory.length}\n\n${syncStatus}`);
}

// ── History Display ─────────────────────────────────────────────────────────

export function updateHistoryDisplay() {
    try {
        const historySection = document.getElementById('historySection');
        if (!historySection) return;

        if (state.portfolioHistory.length === 0) {
            historySection.style.display = 'none';
            return;
        }

        historySection.style.display = 'block';
        updateChart();

        const historyLog = document.getElementById('historyLog');
        if (!historyLog) return;

        historyLog.innerHTML = `
            <h3 style="margin-bottom: 10px; color: var(--text-primary);">Snapshot Log</h3>
            <div style="max-height: 300px; overflow-y: auto;">
                ${state.portfolioHistory.slice().reverse().map((snapshot) => {
                    const date = new Date(snapshot.timestamp);
                    const gainLoss = snapshot.totalMarketValue - snapshot.totalInvested;
                    const gainLossPct = snapshot.totalInvested > 0 ? (gainLoss / snapshot.totalInvested) * 100 : 0;
                    const color = gainLoss >= 0 ? 'var(--up)' : 'var(--down)';
                    const ts = encodeURIComponent(snapshot.timestamp);
                    return `
                        <div style="background: var(--surface-2); padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid ${color};">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                                <div style="font-size: 13px; color: var(--text-secondary);">${date.toLocaleDateString()} ${date.toLocaleTimeString()}</div>
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <div style="font-size: 12px; color: var(--text-secondary);">${snapshot.positionCount} positions \u2022 ${snapshot.pricesAvailable} with prices</div>
                                    <button onclick="deleteSnapshot('${ts}')" title="Delete this snapshot" class="btn-icon-hover-danger">\u{1F5D1}\u{FE0F}</button>
                                </div>
                            </div>
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; font-size: 13px;">
                                <div><div style="color: var(--text-secondary); font-size: 11px;">Invested${snapshot.baseCurrency ? ' (' + snapshot.baseCurrency + ')' : ''}</div><div style="color: var(--text-primary);">${formatCurrency(snapshot.totalInvested, snapshot.baseCurrency)}</div></div>
                                <div><div style="color: var(--text-secondary); font-size: 11px;">Market Value</div><div style="color: var(--text-primary);">${formatCurrency(snapshot.totalMarketValue, snapshot.baseCurrency)}</div></div>
                                <div><div style="color: var(--text-secondary); font-size: 11px;">Gain/Loss</div><div style="color: ${color}; font-weight: bold;">${formatCurrency(gainLoss, snapshot.baseCurrency)} (${formatPercent(gainLossPct)})</div></div>
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

        let chartHTML = '<div style="background: var(--surface-2); padding: 20px; border-radius: 10px;">';
        chartHTML += '<div style="display: flex; justify-content: space-around; gap: 8px; align-items: flex-end; height: 200px;">';

        state.portfolioHistory.forEach((snapshot) => {
            const date = new Date(snapshot.timestamp);
            const label = `${date.getMonth() + 1}/${date.getDate()}`;
            const marketHeight = ((snapshot.totalMarketValue - minValue) / range) * 180;
            const investedHeight = ((snapshot.totalInvested - minValue) / range) * 180;
            const gainLoss = snapshot.totalMarketValue - snapshot.totalInvested;
            const color = gainLoss >= 0 ? 'var(--up)' : 'var(--down)';

            chartHTML += `
                <div style="flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 40px;">
                    <div style="position: relative; width: 100%; height: 180px; display: flex; align-items: flex-end; justify-content: center; gap: 2px;">
                        <div style="width: 45%; background: var(--gold); height: ${investedHeight}px; border-radius: 3px 3px 0 0;" title="Invested: ${formatCurrency(snapshot.totalInvested, snapshot.baseCurrency)}"></div>
                        <div style="width: 45%; background: ${color}; height: ${marketHeight}px; border-radius: 3px 3px 0 0;" title="Market: ${formatCurrency(snapshot.totalMarketValue, snapshot.baseCurrency)}"></div>
                    </div>
                    <div style="font-size: 10px; color: var(--text-secondary); margin-top: 5px; text-align: center;">${label}</div>
                </div>
            `;
        });

        chartHTML += '</div>';
        chartHTML += `
            <div style="display: flex; justify-content: center; gap: 20px; margin-top: 15px; font-size: 12px;">
                <div style="display: flex; align-items: center; gap: 5px;"><div style="width: 12px; height: 12px; background: var(--gold); border-radius: 2px;"></div><span style="color: var(--text-primary);">Invested</span></div>
                <div style="display: flex; align-items: center; gap: 5px;"><div style="width: 12px; height: 12px; background: var(--up); border-radius: 2px;"></div><span style="color: var(--text-primary);">Market Value (Profit)</span></div>
                <div style="display: flex; align-items: center; gap: 5px;"><div style="width: 12px; height: 12px; background: var(--down); border-radius: 2px;"></div><span style="color: var(--text-primary);">Market Value (Loss)</span></div>
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
        const histSection = document.getElementById('historySection');
        if (histSection) histSection.style.display = 'none';
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

function recordTransaction(symbol, type, shares, price, date, totalAmount, costBasis, realizedGainLoss, extra = {}) {
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
    // Full-taxonomy extras (fee / tax / ratio / note) — only set when provided.
    if (extra.fee != null) tx.fee = extra.fee;
    if (extra.tax != null) tx.tax = extra.tax;
    if (extra.ratio != null) tx.ratio = extra.ratio;
    if (extra.note != null) tx.note = extra.note;
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

/**
 * Sum portfolio-wide income & fees from the full ledger, in base currency.
 * Returns { dividends, tax, netIncome, fees } (all base-currency).
 */
function computeIncomeTotalsBase() {
    const base = state.baseCurrency || 'EUR';
    let dividends = 0, tax = 0, fees = 0;
    for (const txs of Object.values(state.transactions || {})) {
        for (const tx of txs) {
            const rate = tx.exchangeRate || getExchangeRate(tx.currency || base);
            if (tx.type === 'dividend') {
                dividends += (Number(tx.totalAmount) || 0) * rate;
                tax += (Number(tx.tax) || 0) * rate;
            } else if (tx.type === 'fee') {
                fees += (Number(tx.totalAmount) || 0) * rate;
            } else if (tx.type === 'buy' || tx.type === 'sell') {
                fees += (Number(tx.fee) || 0) * rate;
            }
        }
    }
    return { dividends, tax, netIncome: dividends - tax, fees };
}

/** Render the Income & Fees history table (dividends + standalone fee rows). */
function renderIncomeHistory() {
    const section = document.getElementById('incomeHistorySection');
    if (!section) return;

    const rows = [];
    let hasDividendRow = false;
    for (const [symbol, txs] of Object.entries(state.transactions || {})) {
        txs.forEach(t => {
            if (t.type === 'dividend' || t.type === 'fee') rows.push({ symbol, ...t });
            if (t.type === 'dividend') hasDividendRow = true;
        });
    }

    // DeGiro dividends live in a separate Account.csv we don't parse yet, so income
    // can be incomplete for a DeGiro-heavy portfolio. Warn rather than silently
    // showing a partial (or zero) figure the user might trust.
    const hasDegiro = state.portfolio.some(p => p.platform === 'DeGiro');
    const degiroNote = (hasDegiro && !hasDividendRow)
        ? `<div style="margin-bottom: 12px; padding: 10px 12px; background: var(--gold-glow); border-left: 3px solid var(--gold); border-radius: 6px; font-size: 12px; color: var(--gold);">⚠ DeGiro dividends &amp; fees aren't imported yet (they live in DeGiro's separate Account statement). Figures here reflect other brokers only.</div>`
        : '';

    if (rows.length === 0 && !degiroNote) { section.style.display = 'none'; return; }
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    const totals = computeIncomeTotalsBase();
    const base = state.baseCurrency || 'EUR';

    section.style.display = 'block';
    const content = section.querySelector('.card') || section;
    content.innerHTML = `
        <h2 style="margin-bottom: 15px;">💰 Income &amp; Fees</h2>
        ${degiroNote}
        ${rows.length > 0 ? `<div style="margin-bottom: 15px; font-size: 14px; color: var(--text-secondary);">
            Net income: <span style="color: var(--up); font-weight: bold;">+${formatCurrency(totals.netIncome, base)}</span>
            &bull; Fees: <span style="color: var(--down); font-weight: bold;">−${formatCurrency(totals.fees, base)}</span>
            ${totals.tax > 0 ? ` &bull; Tax withheld: ${formatCurrency(totals.tax, base)}` : ''}
        </div>` : ''}
        ${rows.length > 0 ? `<div class="table-scroll">
            <table class="sales-history-table">
                <thead>
                    <tr><th>Date</th><th>Symbol</th><th>Type</th><th>Gross</th><th>Tax</th><th>Net</th><th class="col-hide-mobile">Ccy</th></tr>
                </thead>
                <tbody>
                    ${rows.map(r => {
                        const gross = Number(r.totalAmount) || 0;
                        const txTax = Number(r.tax) || 0;
                        const net = r.type === 'dividend' ? gross - txTax : -gross;
                        const netColor = net >= 0 ? 'var(--up)' : 'var(--down)';
                        const label = r.type === 'dividend' ? 'Dividend' : 'Fee';
                        return `<tr>
                            <td>${escapeHTML(r.date || '')}</td>
                            <td style="font-weight: 600; color: var(--gold);">${escapeHTML(r.symbol)}</td>
                            <td>${label}</td>
                            <td>${formatCurrency(gross, r.currency)}</td>
                            <td>${txTax ? formatCurrency(txTax, r.currency) : '—'}</td>
                            <td style="color: ${netColor}; font-weight: bold;">${net >= 0 ? '+' : ''}${formatCurrency(net, r.currency)}</td>
                            <td class="col-hide-mobile">${escapeHTML(r.currency || '')}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>` : ''}
    `;
}

/** Render the full transaction ledger with search + type filter and per-row delete. */
function renderTransactionsLedger() {
    const section = document.getElementById('transactionsSection');
    if (!section) return;

    const all = [];
    for (const [symbol, txs] of Object.entries(state.transactions || {})) {
        txs.forEach(t => all.push({ symbol, ...t }));
    }
    if (all.length === 0) { section.style.display = 'none'; return; }

    if (!state.txFilter) state.txFilter = { type: 'all', q: '' };
    const { type: fType, q } = state.txFilter;
    const qLower = (q || '').toLowerCase();
    const rows = all
        .filter(t => (fType === 'all' || t.type === fType) && (!qLower || (t.symbol || '').toLowerCase().includes(qLower)))
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    section.style.display = 'block';
    // Stash the displayed rows so the delete button can reference a row by index
    // (avoids interpolating broker-derived strings into an onclick attribute).
    state._ledgerRows = rows;
    const content = section.querySelector('.card') || section;
    const typeLabel = ty => ty === 'isin_change' ? 'ISIN change' : ty[0].toUpperCase() + ty.slice(1);
    const types = ['all', 'buy', 'sell', 'dividend', 'fee', 'split', 'isin_change'];
    const filterBtns = types.map(ty =>
        `<button class="btn btn-sm ${fType === ty ? 'btn-accent' : 'btn-primary'}" onclick="setTxFilter('${ty}')">${typeLabel(ty)}</button>`
    ).join(' ');

    content.innerHTML = `
        <h2 style="margin-bottom: 12px;">📒 Transactions <span style="font-size: 13px; color: var(--text-secondary);">(${rows.length})</span></h2>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px;">
            <input id="txSearch" type="text" placeholder="Filter by symbol…" value="${escapeHTML(q || '')}" oninput="setTxSearch(this.value)" style="padding: 6px 10px; flex: 1; min-width: 110px; border-radius: 6px;" />
            <div style="display: flex; flex-wrap: wrap; gap: 4px;">${filterBtns}</div>
        </div>
        <div class="table-scroll">
            <table class="sales-history-table">
                <thead><tr><th>Date</th><th>Symbol</th><th>Type</th><th>Qty</th><th>Price</th><th>Amount</th><th class="col-hide-mobile">Fee/Tax</th><th></th></tr></thead>
                <tbody>
                    ${rows.map((t, i) => {
                        const isTrade = t.type === 'buy' || t.type === 'sell';
                        const qty = isTrade ? t.shares : (t.type === 'split' ? `×${t.ratio}` : '—');
                        const price = isTrade ? formatCurrency(t.price, t.currency) : '—';
                        const amount = t.totalAmount != null ? formatCurrency(t.totalAmount, t.currency) : '—';
                        const feeTax = t.type === 'dividend'
                            ? (t.tax ? `tax ${formatCurrency(t.tax, t.currency)}` : '—')
                            : (t.fee ? formatCurrency(t.fee, t.currency) : '—');
                        const typeColor = t.type === 'buy' ? 'var(--up)' : t.type === 'sell' ? 'var(--down)' : t.type === 'dividend' ? 'var(--up)' : 'var(--text-secondary)';
                        return `<tr>
                            <td>${escapeHTML(t.date || '')}</td>
                            <td style="font-weight: 600; color: var(--gold);">${escapeHTML(t.symbol)}</td>
                            <td style="color: ${typeColor};">${escapeHTML(typeLabel(t.type))}</td>
                            <td>${qty}</td><td>${price}</td><td>${amount}</td><td class="col-hide-mobile">${feeTax}</td>
                            <td><button class="position-action-btn action-del" title="Delete transaction" onclick="deleteTransactionRow(${i})">✕</button></td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

/** Set the transaction-ledger type filter and re-render just that section. */
export function setTxFilter(type) {
    if (!state.txFilter) state.txFilter = { type: 'all', q: '' };
    state.txFilter.type = type;
    renderTransactionsLedger();
}

/** Set the transaction-ledger symbol search, re-render, and keep input focus. */
export function setTxSearch(value) {
    if (!state.txFilter) state.txFilter = { type: 'all', q: '' };
    state.txFilter.q = value;
    renderTransactionsLedger();
    const input = document.getElementById('txSearch');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

/**
 * Delete a single ledger transaction (referenced by its index in the currently
 * displayed `state._ledgerRows`), then re-derive positions and persist.
 * Index-based to avoid interpolating broker-derived strings into onclick.
 */
export function deleteTransactionRow(rowIndex) {
    const row = (state._ledgerRows || [])[Number(rowIndex)];
    if (!row) return;
    const { symbol, timestamp, date, type } = row;
    const txs = state.transactions[symbol];
    if (!txs) return;

    const safeSymbol = String(symbol || '').slice(0, 24);
    const safeType = String(type || '').slice(0, 16);
    const safeDate = String(date || '').slice(0, 10);
    if (!confirm(`Delete this ${safeType} transaction for ${safeSymbol} (${safeDate})?\n\nPositions and totals will be recalculated.`)) return;

    let idx = -1;
    if (timestamp) idx = txs.findIndex(t => (t.timestamp || '') === timestamp);
    if (idx < 0) idx = txs.findIndex(t => (t.date || '') === date && t.type === type); // fallback
    if (idx < 0) return;

    txs.splice(idx, 1);
    if (txs.length === 0) delete state.transactions[symbol];

    rebuildPositionsFromLedger();
    saveTransactionsToStorage();
    saveTransactionsToDB();
    savePortfolioDB();
    renderPortfolio();
}

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

    const realizedColor = totalRealized >= 0 ? 'var(--up)' : 'var(--down)';

    section.style.display = 'block';
    const content = section.querySelector('.card') || section;

    content.innerHTML = `
        <h2 style="margin-bottom: 15px;">\uD83D\uDCC9 Sales History</h2>
        <div style="margin-bottom: 15px; font-size: 14px; color: var(--text-secondary);">
            Total realized P&L: <span style="color: ${realizedColor}; font-weight: bold;">${totalRealized >= 0 ? '+' : ''}${formatCurrency(totalRealized)}</span>
            &bull; ${allSales.length} sale${allSales.length !== 1 ? 's' : ''}
        </div>
        <div class="table-scroll">
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
                        const plColor = (s.realizedGainLoss || 0) >= 0 ? 'var(--up)' : 'var(--down)';
                        return `<tr>
                            <td>${escapeHTML(s.date)}</td>
                            <td style="font-weight: 600; color: var(--gold);">${escapeHTML(s.symbol)}</td>
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

/**
 * Portfolio service — rendering, import, snapshots, history, and position management.
 */

import state from './state.js';
import { escapeHTML, formatCurrency, formatPercent, buildAssetRecord } from './utils.js';
import { getSector } from '../data/sectors.js';
import { renderAllocationCharts } from './ui.js';
import { saveSnapshotToDB, clearHistoryFromDB, savePortfolioDB } from './storage.js';
import { fetchMarketPrices, fetchStockPrice } from './pricing.js';

// ── Portfolio Rendering ─────────────────────────────────────────────────────

export function renderPortfolio() {
    const positionsDiv = document.getElementById('positions');

    // Separate active and inactive positions
    const activePositions = state.portfolio.filter(p => p.shares > 0);
    const inactivePositions = state.portfolio.filter(p => p.shares <= 0);

    let totalInvested = 0;
    let totalMarketValue = 0;
    let positionsWithPrices = 0;

    activePositions.forEach(p => {
        const invested = p.shares * p.avgPrice;
        totalInvested += invested;

        const currentPrice = state.marketPrices[p.symbol];
        if (currentPrice) {
            totalMarketValue += p.shares * currentPrice;
            positionsWithPrices++;
        } else {
            totalMarketValue += invested;
        }
    });

    console.log('=== RENDER PORTFOLIO DEBUG ===');
    console.log('Rendering portfolio:', activePositions.length, 'active,', inactivePositions.length, 'closed');
    console.log('Positions with live prices:', positionsWithPrices);

    // Update header
    const portfolioHeader = document.querySelector('.portfolio-header');
    const totalGainLoss = totalMarketValue - totalInvested;
    const totalGainLossPct = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;
    const gainLossColor = totalGainLoss >= 0 ? '#4ade80' : '#f87171';

    const inactiveToggle = inactivePositions.length > 0
        ? `<span class="inactive-toggle" onclick="toggleInactivePositions()">${state.showInactivePositions ? 'Hide' : 'Show'} ${inactivePositions.length} closed position${inactivePositions.length !== 1 ? 's' : ''}</span>`
        : '';

    portfolioHeader.innerHTML = `
        <div>
            <h2 style="margin-bottom: 5px;">\uD83D\uDCBC Your Portfolio</h2>
            <div style="font-size: 13px; color: #94a3b8;">
                ${activePositions.length} active position${activePositions.length !== 1 ? 's' : ''}
                ${Object.keys(state.marketPrices).length > 0 ? ` \u2022 ${positionsWithPrices} with live prices` : ' \u2022 Click "Update Prices" for live market data'}
                ${inactiveToggle}
                ${state.selectedSector ? `<span style="color: #60a5fa; margin-left: 8px;">Filtered: ${escapeHTML(state.selectedSector)} <span style="cursor:pointer; color:#f87171;" role="button" tabindex="0" onclick="toggleSectorFilter('${escapeHTML(state.selectedSector).replace(/'/g, "\\'")}')">✕</span></span>` : ''}
            </div>
        </div>
        <div class="total-value">
            <div style="color: #94a3b8; font-size: 12px;">Total Invested</div>
            <div style="color: #cbd5e1; font-size: 16px; margin-bottom: 5px;">${formatCurrency(totalInvested)}</div>
            <div style="color: #94a3b8; font-size: 12px;">Market Value</div>
            <div style="color: ${gainLossColor}; font-size: 24px; font-weight: bold;">${formatCurrency(totalMarketValue)}</div>
            ${totalInvested > 0 ? `
                <div style="color: ${gainLossColor}; font-size: 14px; margin-top: 5px;">
                    ${formatCurrency(totalGainLoss)} (${formatPercent(totalGainLossPct)})
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
        const invested = pos.shares * pos.avgPrice;
        const currentPrice = state.marketPrices[pos.symbol];
        const hasPrice = currentPrice !== undefined;
        const marketValue = hasPrice ? pos.shares * currentPrice : invested;
        const gainLoss = marketValue - invested;
        const gainLossPct = invested > 0 ? (gainLoss / invested) * 100 : 0;
        const weight = totalMarketValue > 0 ? (marketValue / totalMarketValue) * 100 : 0;
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

        const dbAsset = state.assetDatabase[pos.symbol.toUpperCase()];
        const escapedSymbol = escapeHTML(pos.symbol).replace(/'/g, "\\'");
        const sector = getSector(pos.symbol);
        const typeColor = ({ 'ETF': '#8b5cf6', 'REIT': '#ec4899', 'Stock': '#3b82f6', 'Crypto': '#f59e0b' }[pos.type] || '#94a3b8');
        const currency = dbAsset && dbAsset.currency && dbAsset.currency !== 'USD' ? dbAsset.currency : '';

        // Action buttons: active positions get buy/sell/delete; inactive get just delete
        const actionButtons = isActive
            ? `<button class="position-action-btn action-buy" title="Add shares" onclick="showEditPositionDialog('${escapedSymbol}','buy')">+</button>
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
                ${currency ? `<div class="pos-secondary">${escapeHTML(currency)}</div>` : ''}
            </div>
            <div class="pos-cell pos-right">
                <div>${isActive ? pos.shares + ' shares' : '\u2014'}</div>
                <div class="pos-secondary">${isActive ? 'avg ' + formatCurrency(pos.avgPrice) : 'Closed'}</div>
            </div>
            <div class="pos-cell pos-right">
                <div style="color: ${hasPrice ? '#60a5fa' : '#f59e0b'}; font-weight: bold;">
                    ${isActive ? formatCurrency(marketValue) : '\u2014'}
                </div>
                <div class="pos-secondary">${isActive ? (hasPrice ? formatCurrency(currentPrice) + ' \u2022 ' + weight.toFixed(1) + '%' : '\u23F3 Pending') : ''}</div>
            </div>
            <div class="pos-cell pos-right pos-hide-mobile">
                <div style="color: ${isActive ? color : '#64748b'}; font-weight: bold;">
                    ${isActive ? `${gainLoss >= 0 ? '+' : ''}${formatCurrency(gainLoss)}` : '\u2014'}
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
        if (dialog) dialog.style.display = 'none';
        if (textarea) textarea.value = '';
    } catch (err) {
        console.error('=== CLOSE IMPORT DIALOG ERROR ===', err);
    }
}

// ── Import Positions ────────────────────────────────────────────────────────

export function importPositions() {
    console.log('=== IMPORT POSITIONS STARTED ===');

    const text = document.getElementById('importText').value.trim();
    if (!text) {
        alert('Please paste your positions data');
        return;
    }

    const lines = text.split('\n');
    const newPositions = [];
    const errors = [];
    let isFirstLine = true;

    console.log('Total lines:', lines.length);

    try {
        lines.forEach((line, idx) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            const parts = trimmed.split('\t');

            if (isFirstLine && (trimmed.includes('Asset') || trimmed.includes('Ticker'))) {
                isFirstLine = false;
                return;
            }
            isFirstLine = false;

            if (parts.length >= 8) {
                const assetName = parts[0] ? parts[0].trim() : '';
                const symbol = parts[1] ? parts[1].trim().toUpperCase() : '';
                const platform = parts[2] ? parts[2].trim() : 'Unknown';
                const assetType = parts[3] ? parts[3].trim() : 'Other';
                const sharesRaw = parts[4] ? parts[4].trim() : '';
                const shares = parseFloat(sharesRaw);
                const priceRaw = parts[7] ? parts[7].trim() : '';
                const avgPrice = parseFloat(priceRaw.replace(/[$,]/g, ''));

                if (symbol && !isNaN(shares) && !isNaN(avgPrice) && shares > 0 && avgPrice > 0) {
                    newPositions.push({ name: assetName, symbol, platform, type: assetType, shares, avgPrice });
                } else {
                    const reason = [];
                    if (!symbol) reason.push('missing ticker');
                    if (isNaN(shares) || shares <= 0) reason.push(`invalid shares (${sharesRaw})`);
                    if (isNaN(avgPrice) || avgPrice <= 0) reason.push(`invalid price (${priceRaw})`);
                    errors.push(`Line ${idx + 1}: \u2717 Failed - ${reason.join(', ')}`);
                }
            } else if (parts.length >= 3) {
                const symbol = parts[0].toUpperCase();
                const shares = parseFloat(parts[1]);
                const avgPrice = parseFloat(parts[2].replace(/[$,]/g, ''));

                if (symbol && !isNaN(shares) && !isNaN(avgPrice)) {
                    newPositions.push({ name: symbol, symbol, platform: 'Unknown', type: 'Stock', shares, avgPrice });
                } else {
                    errors.push(`Line ${idx + 1}: \u2717 Invalid simple format`);
                }
            } else {
                errors.push(`Line ${idx + 1}: \u2717 Only ${parts.length} columns (need at least 8 for full format or 3 for simple)`);
            }
        });

        let reportMsg = `\uD83D\uDCCA Import Report:\n\n`;
        reportMsg += `\u2713 Successfully parsed: ${newPositions.length} positions\n`;
        reportMsg += `\u2717 Failed/Skipped: ${errors.length} lines\n\n`;

        if (errors.length > 0) {
            reportMsg += `--- Errors ---\n`;
            reportMsg += errors.slice(0, 10).join('\n');
            if (errors.length > 10) reportMsg += `\n... and ${errors.length - 10} more errors`;
            reportMsg += '\n\n';
        }

        if (newPositions.length === 0) {
            reportMsg += '\n\u274C No positions could be imported.\n\nTip: Make sure your data is tab-separated.';
            alert(reportMsg);
            return;
        }

        reportMsg += `\nFirst 5 positions:\n`;
        newPositions.slice(0, 5).forEach(p => {
            reportMsg += `  \u2022 ${p.symbol}: ${p.shares} shares @ $${p.avgPrice}\n`;
        });
        if (newPositions.length > 5) reportMsg += `  ... and ${newPositions.length - 5} more\n`;

        alert(reportMsg);

        if (newPositions.length > 0) {
            state.portfolio = [...newPositions];

            // Populate local assetDatabase
            state.portfolio.forEach(p => {
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

            setTimeout(() => {
                console.log('Auto-fetching market prices...');
                fetchMarketPrices();
            }, 500);

            setTimeout(() => {
                alert(`\u2713 Successfully imported ${newPositions.length} position(s)!\n\nFetching current market prices...`);
            }, 300);
        }
    } catch (err) {
        console.error('=== IMPORT ERROR ===', err);
        alert(`\u274C Import failed: ${err.message}\n\nCheck the browser console (F12) for details.`);
    }
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export async function savePortfolioSnapshot() {
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
                    return `
                        <div style="background: #334155; padding: 12px; border-radius: 8px; margin-bottom: 8px; border-left: 3px solid ${color};">
                            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 5px;">
                                <div style="font-size: 13px; color: #94a3b8;">${date.toLocaleDateString()} ${date.toLocaleTimeString()}</div>
                                <div style="font-size: 12px; color: #94a3b8;">${snapshot.positionCount} positions \u2022 ${snapshot.pricesAvailable} with prices</div>
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
                        type: r.type === 'Common Stock' ? 'Stock' : r.type === 'ETP' ? 'ETF' : r.type || 'Stock'
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

    const typeMap = {
        'Common Stock': 'Stock', 'ETP': 'ETF', 'ADR': 'Stock',
        'REIT': 'REIT', 'Crypto': 'Crypto', 'ETF': 'ETF'
    };
    document.getElementById('positionType').value = typeMap[type] || type || 'Stock';
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

// -- Delete Position --

export function deletePosition(symbol) {
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
    const tx = {
        type,
        shares,
        price,
        date,
        totalAmount,
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

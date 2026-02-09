/**
 * Portfolio service — rendering, import, snapshots, and history.
 */

import state from './state.js';
import { escapeHTML, formatCurrency, formatPercent, buildAssetRecord } from './utils.js';
import { getSector } from '../data/sectors.js';
import { renderAllocationCharts } from './ui.js';
import { saveSnapshotToDB, clearHistoryFromDB, savePortfolioDB } from './storage.js';
import { fetchMarketPrices } from './pricing.js';

// ── Portfolio Rendering ─────────────────────────────────────────────────────

export function renderPortfolio() {
    const positionsDiv = document.getElementById('positions');

    let totalInvested = 0;
    let totalMarketValue = 0;
    let positionsWithPrices = 0;

    state.portfolio.forEach(p => {
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
    console.log('Rendering portfolio:', state.portfolio.length, 'positions');
    console.log('Positions with live prices:', positionsWithPrices);

    // Update header
    const portfolioHeader = document.querySelector('.portfolio-header');
    const totalGainLoss = totalMarketValue - totalInvested;
    const totalGainLossPct = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;
    const gainLossColor = totalGainLoss >= 0 ? '#4ade80' : '#f87171';

    portfolioHeader.innerHTML = `
        <div>
            <h2 style="margin-bottom: 5px;">\uD83D\uDCBC Your Portfolio</h2>
            <div style="font-size: 13px; color: #94a3b8;">
                ${state.portfolio.length} position${state.portfolio.length !== 1 ? 's' : ''}
                ${Object.keys(state.marketPrices).length > 0 ? ` \u2022 ${positionsWithPrices} with live prices` : ' \u2022 Click "Update Prices" for live market data'}
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
        positionsDiv.innerHTML = '<div style="text-align: center; color: #64748b; padding: 40px;">No positions yet. Import your portfolio from spreadsheet to get started.</div>';
        return;
    }

    // Apply sector slicer filter
    const displayPositions = state.selectedSector
        ? state.portfolio.filter(p => getSector(p.symbol) === state.selectedSector)
        : state.portfolio;

    let html = `
        <div class="position-header-row">
            <div>Symbol</div>
            <div>Asset Name / Platform</div>
            <div>Type</div>
            <div>Sector</div>
            <div>Shares</div>
            <div>Avg Price</div>
            <div>Current Price</div>
            <div>Invested</div>
            <div>Market Value</div>
            <div>Weight</div>
            <div>Gain/Loss</div>
        </div>
    `;

    html += displayPositions.map((pos) => {
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

        return `
        <div class="position">
            <div class="position-symbol">
                <div style="display: flex; align-items: center; gap: 5px;">
                    <span style="color: ${statusColor}; font-size: 14px;" title="${escapeHTML(statusText)}">${statusFlag}</span>
                    <span>${escapeHTML(pos.symbol)}</span>
                </div>
                ${timestampText ? `<div style="font-size: 9px; color: #64748b; margin-top: 2px;">${escapeHTML(timestampText)}</div>` : ''}
            </div>
            <div class="position-details" style="font-size: 12px; color: #94a3b8;" title="${escapeHTML(pos.name || pos.symbol)}${pos.platform ? '\nPlatform: ' + escapeHTML(pos.platform) : ''}">
                ${pos.name ? escapeHTML(pos.name.length > 30 ? pos.name.substring(0, 27) + '...' : pos.name) : escapeHTML(pos.symbol)}
                ${pos.platform && pos.platform !== 'Unknown' ? `<div style="font-size: 9px; color: #64748b; margin-top: 2px;">\uD83D\uDCCD ${escapeHTML(pos.platform)}</div>` : ''}
            </div>
            <div class="position-details" style="font-size: 11px; color: ${({ 'ETF': '#8b5cf6', 'REIT': '#ec4899', 'Stock': '#3b82f6', 'Crypto': '#f59e0b' }[pos.type] || '#94a3b8')}; font-weight: 600;">
                ${escapeHTML(pos.type || 'Stock')}
            </div>
            <div class="position-details" style="font-size: 11px; color: #94a3b8;" title="${escapeHTML(getSector(pos.symbol))}${dbAsset ? '\nExchange: ' + escapeHTML(dbAsset.stockExchange || '') + '\nCurrency: ' + escapeHTML(dbAsset.currency || '') : ''}">
                ${escapeHTML(getSector(pos.symbol))}
                ${dbAsset && dbAsset.currency && dbAsset.currency !== 'USD' ? `<div style="font-size: 9px; color: #64748b; margin-top: 2px;">${escapeHTML(dbAsset.currency)}</div>` : ''}
            </div>
            <div class="position-details">${pos.shares}</div>
            <div class="position-details">${formatCurrency(pos.avgPrice)}</div>
            <div class="position-details" style="color: ${hasPrice ? '#60a5fa' : '#f59e0b'};">
                ${hasPrice ? formatCurrency(currentPrice) : '\u23F3 Pending'}
            </div>
            <div class="position-details">${formatCurrency(invested)}</div>
            <div class="position-value" style="color: ${color};">
                ${formatCurrency(marketValue)}
            </div>
            <div class="position-details" style="font-weight: 600;">
                ${weight.toFixed(1)}%
            </div>
            <div style="color: ${color}; font-weight: bold;">
                ${gainLoss >= 0 ? '+' : ''}${formatCurrency(gainLoss)}
                <span style="font-size: 11px; margin-left: 4px;">(${formatPercent(gainLossPct)})</span>
            </div>
        </div>
        `;
    }).join('');

    positionsDiv.innerHTML = html;
    renderAllocationCharts();
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

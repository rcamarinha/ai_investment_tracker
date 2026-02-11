/**
 * UI service — allocation charts, perspective tabs, API key dialogs.
 */

import state from './state.js';
import { escapeHTML, formatCurrency } from './utils.js';
import { getSector } from '../data/sectors.js';
import { INVESTMENT_PERSPECTIVES } from '../data/perspectives.js';
import { renderPortfolio } from './portfolio.js';
import { initSupabase } from './storage.js';
import { updateAuthBar, isAdmin } from './auth.js';

// ── Perspective Selector ────────────────────────────────────────────────────

export function selectPerspective(key) {
    state.selectedPerspective = key;
    renderPerspectiveTabs();
}

export function toggleSectorFilter(sector) {
    state.selectedSector = state.selectedSector === sector ? null : sector;
    renderPortfolio();
}

export function renderPerspectiveTabs() {
    const tabsContainer = document.getElementById('perspectiveTabs');
    const infoContainer = document.getElementById('perspectiveInfo');
    if (!tabsContainer || !infoContainer) return;

    tabsContainer.innerHTML = Object.entries(INVESTMENT_PERSPECTIVES).map(([key, p]) => `
        <div class="perspective-tab ${key === state.selectedPerspective ? 'active' : ''}"
             style="${key === state.selectedPerspective ? `border-color: ${p.color}; box-shadow: 0 0 8px ${p.color}40;` : ''}"
             onclick="selectPerspective('${key}')">
            <span>${p.icon}</span>
            <span>${p.name}</span>
        </div>
    `).join('');

    const active = INVESTMENT_PERSPECTIVES[state.selectedPerspective];
    infoContainer.innerHTML = `
        <span class="perspective-info-icon">${active.icon}</span>
        <div class="perspective-info-text">
            <div class="perspective-info-name" style="color: ${active.color};">${active.name}</div>
            <div class="perspective-info-desc">${active.description}</div>
            <div class="perspective-info-figures">Key figures: ${active.figures}</div>
        </div>
    `;
}

// ── Allocation Charts ───────────────────────────────────────────────────────

export function renderAllocationCharts() {
    const allocationSection = document.getElementById('allocationSection');
    const typeChart = document.getElementById('typeAllocationChart');
    const sectorChart = document.getElementById('sectorAllocationChart');

    if (!allocationSection || !typeChart || state.portfolio.length === 0) {
        if (allocationSection) allocationSection.style.display = 'none';
        return;
    }

    let totalMarketValue = 0;
    state.portfolio.forEach(p => {
        const currentPrice = state.marketPrices[p.symbol];
        const invested = p.shares * p.avgPrice;
        totalMarketValue += currentPrice ? p.shares * currentPrice : invested;
    });

    if (totalMarketValue === 0) {
        allocationSection.style.display = 'none';
        return;
    }

    // Aggregate by type
    const typeAllocation = {};
    state.portfolio.forEach(p => {
        const assetType = p.type || 'Other';
        const currentPrice = state.marketPrices[p.symbol];
        const invested = p.shares * p.avgPrice;
        const marketValue = currentPrice ? p.shares * currentPrice : invested;
        if (!typeAllocation[assetType]) typeAllocation[assetType] = 0;
        typeAllocation[assetType] += marketValue;
    });

    // Aggregate by sector
    const sectorAllocation = {};
    state.portfolio.forEach(p => {
        const sector = getSector(p.symbol);
        const currentPrice = state.marketPrices[p.symbol];
        const invested = p.shares * p.avgPrice;
        const marketValue = currentPrice ? p.shares * currentPrice : invested;
        if (!sectorAllocation[sector]) sectorAllocation[sector] = 0;
        sectorAllocation[sector] += marketValue;
    });

    const sortedTypes = Object.entries(typeAllocation).sort((a, b) => b[1] - a[1]);
    const sortedSectors = Object.entries(sectorAllocation).sort((a, b) => b[1] - a[1]);

    const typeColors = {
        'Stock': '#3b82f6', 'ETF': '#8b5cf6', 'Crypto': '#f59e0b',
        'Bond': '#10b981', 'REIT': '#ec4899', 'Commodity': '#f97316',
        'Cash': '#6b7280', 'Other': '#64748b'
    };

    const sectorColors = {
        'Technology': '#3b82f6', 'Healthcare': '#10b981', 'Financial': '#f59e0b',
        'Consumer Discretionary': '#ec4899', 'Consumer Staples': '#8b5cf6',
        'Energy': '#ef4444', 'Industrials': '#6366f1', 'Materials': '#f97316',
        'Utilities': '#14b8a6', 'Real Estate': '#a855f7', 'Communication': '#06b6d4',
        'Crypto': '#eab308', 'Index ETF': '#64748b', 'Tech ETF': '#60a5fa',
        'Bond ETF': '#34d399', 'Other': '#94a3b8'
    };

    const defaultColors = ['#06b6d4', '#84cc16', '#ef4444', '#a855f7', '#14b8a6', '#eab308'];

    // Render type chart
    let colorIdx = 0;
    typeChart.innerHTML = sortedTypes.map(([type, value]) => {
        const pct = (value / totalMarketValue * 100);
        const color = typeColors[type] || defaultColors[colorIdx++ % defaultColors.length];
        return `
            <div class="allocation-bar-row">
                <div class="allocation-bar-label" title="${escapeHTML(type)}">${escapeHTML(type)}</div>
                <div class="allocation-bar-track">
                    <div class="allocation-bar-fill" style="width: ${pct}%; background: ${color};">
                        ${pct >= 10 ? pct.toFixed(1) + '%' : ''}
                    </div>
                </div>
                <div class="allocation-bar-value">${formatCurrency(value)}</div>
            </div>
        `;
    }).join('');

    // Render sector chart (slicer)
    if (sectorChart) {
        colorIdx = 0;
        sectorChart.innerHTML = sortedSectors.map(([sector, value]) => {
            const pct = (value / totalMarketValue * 100);
            const color = sectorColors[sector] || defaultColors[colorIdx++ % defaultColors.length];
            const isActive = state.selectedSector === sector;
            const isDimmed = state.selectedSector && !isActive;
            return `
                <div class="allocation-bar-row slicer${isActive ? ' active' : ''}${isDimmed ? ' dimmed' : ''}" role="button" tabindex="0" onclick="toggleSectorFilter('${escapeHTML(sector).replace(/'/g, "\\'")}')">
                    <div class="allocation-bar-label" title="${escapeHTML(sector)}">${escapeHTML(sector)}</div>
                    <div class="allocation-bar-track">
                        <div class="allocation-bar-fill" style="width: ${pct}%; background: ${color};">
                            ${pct >= 10 ? pct.toFixed(1) + '%' : ''}
                        </div>
                    </div>
                    <div class="allocation-bar-value">${formatCurrency(value)}</div>
                </div>
            `;
        }).join('');
        sectorChart.innerHTML += `<div class="slicer-hint">Tap a sector to filter positions${state.selectedSector ? `<span class="slicer-clear" role="button" tabindex="0" onclick="toggleSectorFilter('${escapeHTML(state.selectedSector).replace(/'/g, "\\'")}')">Clear filter</span>` : ''}</div>`;
    }

    allocationSection.style.display = 'block';
}

// ── API Key Dialog ──────────────────────────────────────────────────────────

export function showApiKeyDialog() {
    if (!isAdmin()) {
        alert('Only administrators can manage API keys.');
        return;
    }
    document.getElementById('finnhubKeyInput').value = state.finnhubKey || '';
    document.getElementById('fmpKeyInput').value = state.fmpKey || '';
    document.getElementById('alphaVantageKeyInput').value = state.alphaVantageKey || '';
    document.getElementById('anthropicKeyInput').value = state.anthropicKey || '';
    document.getElementById('supabaseUrlInput').value = state.supabaseUrl || '';
    document.getElementById('supabaseAnonKeyInput').value = state.supabaseAnonKey || '';
    document.getElementById('apiKeyDialog').style.display = 'block';
}

export function closeApiKeyDialog() {
    document.getElementById('apiKeyDialog').style.display = 'none';
}

export function saveApiKeys() {
    const fhKey = document.getElementById('finnhubKeyInput').value.trim();
    const fmpKeyInput = document.getElementById('fmpKeyInput').value.trim();
    const avKey = document.getElementById('alphaVantageKeyInput').value.trim();
    const antKey = document.getElementById('anthropicKeyInput').value.trim();
    const sbUrl = document.getElementById('supabaseUrlInput').value.trim();
    const sbKey = document.getElementById('supabaseAnonKeyInput').value.trim();

    state.finnhubKey = fhKey;
    state.fmpKey = fmpKeyInput;
    state.alphaVantageKey = avKey;
    state.anthropicKey = antKey;
    state.supabaseUrl = sbUrl;
    state.supabaseAnonKey = sbKey;

    // Persist to localStorage
    const keys = { finnhubKey: fhKey, fmpKey: fmpKeyInput, alphaVantageKey: avKey, anthropicKey: antKey, supabaseUrl: sbUrl, supabaseAnonKey: sbKey };
    for (const [k, v] of Object.entries(keys)) {
        if (v) localStorage.setItem(k, v);
        else localStorage.removeItem(k);
    }

    // Re-init Supabase if config changed
    if (sbUrl && sbKey) {
        initSupabase();
    } else {
        state.supabaseClient = null;
        state.currentUser = null;
        updateAuthBar();
    }

    let msg = '\u2713 Settings saved!\n\n';
    if (fhKey || fmpKeyInput || avKey) {
        msg += 'Fetch Strategy:\n';
        if (fhKey) msg += '1\uFE0F\u20E3 Finnhub (Primary - 60/min)\n';
        if (fmpKeyInput) msg += '2\uFE0F\u20E3 FMP (Fallback - 250/day)\n';
        if (avKey) msg += '3\uFE0F\u20E3 Alpha Vantage (Last resort - 5/min)\n';
    }
    if (sbUrl && sbKey) {
        msg += '\n\u2601\uFE0F Cloud database configured! Use the auth bar to sign up or log in.';
    }

    alert(msg);
    closeApiKeyDialog();
}

export function clearApiKeys() {
    if (confirm('\u26A0\uFE0F Clear all API keys and cloud settings?\n\nYou will need to re-enter them to fetch prices and sync.')) {
        state.finnhubKey = '';
        state.fmpKey = '';
        state.alphaVantageKey = '';
        state.anthropicKey = '';
        state.supabaseUrl = '';
        state.supabaseAnonKey = '';
        state.supabaseClient = null;
        state.currentUser = null;
        localStorage.removeItem('finnhubKey');
        localStorage.removeItem('fmpKey');
        localStorage.removeItem('alphaVantageKey');
        localStorage.removeItem('anthropicKey');
        localStorage.removeItem('supabaseUrl');
        localStorage.removeItem('supabaseAnonKey');
        document.getElementById('finnhubKeyInput').value = '';
        document.getElementById('fmpKeyInput').value = '';
        document.getElementById('alphaVantageKeyInput').value = '';
        document.getElementById('anthropicKeyInput').value = '';
        document.getElementById('supabaseUrlInput').value = '';
        document.getElementById('supabaseAnonKeyInput').value = '';
        updateAuthBar();
        alert('\u2713 All keys and settings cleared.');
    }
}

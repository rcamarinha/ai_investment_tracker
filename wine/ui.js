/**
 * Wine UI service — allocation charts, API key dialog.
 */

import state from './state.js';
import { initSupabase } from './storage.js';
import { showToast, showConfirm, openModal, closeModal } from './utils.js';

// ── Auth Guard ────────────────────────────────────────────────────────────────

function requireAuth(actionName) {
    if (!state.supabaseClient) return true; // local-only mode
    if (state.currentUser) return true;
    showToast(`Please log in to ${actionName}.`, 'warning');
    return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(value) {
    if (value == null || isNaN(value)) return '—';
    return new Intl.NumberFormat('de-DE', {
        style: 'currency', currency: 'EUR', maximumFractionDigits: 0
    }).format(value);
}

// ── Allocation Charts ────────────────────────────────────────────────────────

const REGION_COLORS = [
    '#9f1239', '#c2410c', '#b45309', '#15803d', '#0369a1',
    '#6d28d9', '#be185d', '#0f766e', '#1d4ed8', '#7c3aed',
];

export function renderAllocationCharts() {
    const allocationSection = document.getElementById('allocationSection');
    const allocationChart   = document.getElementById('allocationChart');

    if (!allocationSection || !allocationChart || state.cellar.length === 0) {
        if (allocationSection) allocationSection.style.display = 'none';
        return;
    }

    allocationSection.style.display = 'block';
    showAllocationTab(state.selectedAllocationTab);
}

export function showAllocationTab(tab) {
    state.selectedAllocationTab = tab;

    // Update tab button styles
    ['region', 'varietal', 'country'].forEach(t => {
        const btn = document.getElementById(`tab-${t}`);
        if (btn) btn.className = t === tab ? 'tab-btn active' : 'tab-btn';
    });

    const allocationChart = document.getElementById('allocationChart');
    if (!allocationChart) return;

    // Aggregate by the selected dimension
    const groups = {};

    state.cellar.forEach(b => {
        let key;
        if (tab === 'region')   key = b.region   || 'Unknown';
        if (tab === 'varietal') key = b.varietal  || 'Unknown';
        if (tab === 'country')  key = b.country   || 'Unknown';

        const invested  = (b.qty || 0) * (b.purchasePrice || 0);
        const estimated = b.estimatedValue
            ? (b.qty || 0) * b.estimatedValue
            : invested;

        if (!groups[key]) groups[key] = { invested: 0, estimated: 0, bottles: 0 };
        groups[key].invested  += invested;
        groups[key].estimated += estimated;
        groups[key].bottles   += (b.qty || 0);
    });

    const sorted = Object.entries(groups)
        .sort((a, b) => b[1].estimated - a[1].estimated);

    const totalEstimated = sorted.reduce((s, [, v]) => s + v.estimated, 0);

    if (totalEstimated === 0) {
        allocationChart.innerHTML = '<div style="color: #64748b; padding: 10px;">No data to display.</div>';
        return;
    }

    allocationChart.innerHTML = sorted.map(([label, vals], idx) => {
        const pct   = totalEstimated > 0 ? (vals.estimated / totalEstimated) * 100 : 0;
        const color = REGION_COLORS[idx % REGION_COLORS.length];
        return `
        <div class="alloc-bar-row">
            <div class="alloc-label" title="${label}">${label}</div>
            <div class="alloc-bar-track">
                <div class="alloc-bar-fill" style="width: ${pct.toFixed(1)}%; background: ${color};"></div>
            </div>
            <div class="alloc-pct">${pct.toFixed(1)}%</div>
            <div class="alloc-value">${fmt(vals.estimated)}</div>
        </div>`;
    }).join('');
}

// ── API Key Dialog ───────────────────────────────────────────────────────────

export function showApiKeyDialog() {
    if (!requireAuth('manage API keys')) return;
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('anthropicKeyInput',    state.anthropicKey);
    setVal('openaiKeyInput',       state.openaiKey);
    setVal('supabaseUrlInput',     state.supabaseUrl);
    setVal('supabaseAnonKeyInput', state.supabaseAnonKey);
    openModal('apiKeyDialog');
}

export function closeApiKeyDialog() {
    closeModal('apiKeyDialog');
}

export function saveApiKeys() {
    const getVal = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

    const anthropicKey  = getVal('anthropicKeyInput');
    const openaiKey     = getVal('openaiKeyInput');
    const supabaseUrl   = getVal('supabaseUrlInput');
    const supabaseKey   = getVal('supabaseAnonKeyInput');

    if (anthropicKey) {
        state.anthropicKey = anthropicKey;
        localStorage.setItem('wine_anthropicKey', anthropicKey);
    }

    // OpenAI key is optional — clear it if the field is blanked out
    state.openaiKey = openaiKey;
    if (openaiKey) {
        localStorage.setItem('wine_openaiKey', openaiKey);
    } else {
        localStorage.removeItem('wine_openaiKey');
    }

    if (supabaseUrl && supabaseKey) {
        state.supabaseUrl     = supabaseUrl;
        state.supabaseAnonKey = supabaseKey;
        localStorage.setItem('wine_supabaseUrl',     supabaseUrl);
        localStorage.setItem('wine_supabaseAnonKey', supabaseKey);
        // Re-initialize Supabase with new credentials
        state.supabaseClient = null;
        initSupabase(() => {
            // Trigger re-render via the global window function
            if (window.renderCellar) window.renderCellar();
        });
    }

    closeApiKeyDialog();
    showToast('API keys saved.');
}

export async function clearApiKeys() {
    const confirmed = await showConfirm('Clear all API keys and disconnect from Supabase?',
        { confirmLabel: 'Clear All', danger: true });
    if (!confirmed) return;

    state.anthropicKey    = '';
    state.openaiKey       = '';
    state.supabaseUrl     = '';
    state.supabaseAnonKey = '';
    state.supabaseClient  = null;
    state.currentUser     = null;

    ['wine_anthropicKey', 'wine_openaiKey', 'wine_supabaseUrl', 'wine_supabaseAnonKey'].forEach(k =>
        localStorage.removeItem(k));

    closeApiKeyDialog();

    const authBar = document.getElementById('authBar');
    if (authBar) authBar.style.display = 'none';

    showToast('API keys cleared.');
}

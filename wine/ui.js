/**
 * Wine UI service — allocation charts.
 */

import state from './state.js';
import { showToast } from './utils.js';

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


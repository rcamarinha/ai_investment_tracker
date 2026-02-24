/**
 * Cellar service — rendering, add/edit/delete bottles, snapshots, history.
 */

import state from './state.js';
import { saveBottleToDB, deleteBottleFromDB, saveSnapshotToDB,
         deleteSnapshotFromDB, clearSnapshotsFromDB } from './storage.js';
import { renderAllocationCharts } from './ui.js';

// ── Auth Guard ───────────────────────────────────────────────────────────────

/** Returns true if the user may proceed; shows an alert and returns false otherwise. */
function requireAuth(actionName) {
    if (!state.supabaseClient) return true; // local-only mode
    if (state.currentUser) return true;
    alert(`🔒 Please log in to ${actionName}.\n\nSign in with your email or Google account above.`);
    return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#x27;'); // safe in both HTML attributes and JS-in-onclick strings
}

function fmt(value, currency = 'EUR') {
    if (value === null || value === undefined || isNaN(value)) return '—';
    return new Intl.NumberFormat('de-DE', {
        style: 'currency', currency, maximumFractionDigits: 2
    }).format(value);
}

function fmtDate(dateStr) {
    if (!dateStr) return '';
    try {
        return new Date(dateStr).toLocaleDateString('en-GB', {
            year: 'numeric', month: 'short', day: 'numeric'
        });
    } catch { return dateStr; }
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
}

// ── Totals ───────────────────────────────────────────────────────────────────

export function computeTotals() {
    let totalInvested = 0;
    let totalEstimated = 0;
    let totalBottles = 0;
    let valuedBottles = 0;

    state.cellar.forEach(b => {
        const invested = (b.qty || 0) * (b.purchasePrice || 0);
        totalInvested += invested;
        totalBottles  += (b.qty || 0);
        if (b.estimatedValue) {
            totalEstimated += (b.qty || 0) * b.estimatedValue;
            valuedBottles++;
        } else {
            totalEstimated += invested; // fallback to cost
        }
    });

    return { totalInvested, totalEstimated, totalBottles, valuedBottles };
}

// ── Portfolio Rendering ──────────────────────────────────────────────────────

export function renderCellar() {
    const bottlesDiv = document.getElementById('bottles');
    if (!bottlesDiv) return;

    if (state.cellar.length === 0) {
        bottlesDiv.innerHTML = `
            <div style="color: #64748b; text-align: center; padding: 40px; grid-column: 1/-1;">
                No bottles in cellar yet.<br>
                <span style="font-size: 13px;">Scan a wine label or click ➕ Add Bottle to get started.</span>
            </div>`;
        updateStatsBar({ totalInvested: 0, totalEstimated: 0, totalBottles: 0 });
        updateHistoryDisplay();
        renderAllocationCharts();
        return;
    }

    const totals = computeTotals();
    updateStatsBar(totals);

    bottlesDiv.innerHTML = state.cellar.map(b => renderBottleCard(b)).join('');

    updateHistoryDisplay();
    renderAllocationCharts();
}

function renderBottleCard(b) {
    const totalInvested  = (b.qty || 0) * (b.purchasePrice || 0);
    const hasValuation   = b.estimatedValue != null;
    const totalEstimated = hasValuation ? (b.qty || 0) * b.estimatedValue : totalInvested;
    const gain           = totalEstimated - totalInvested;
    const gainPct        = totalInvested > 0 ? (gain / totalInvested) * 100 : 0;
    const gainClass      = gain > 0 ? 'positive' : gain < 0 ? 'negative' : 'neutral';
    const gainSign       = gain >= 0 ? '+' : '';

    const tags = [
        b.country ? `🌍 ${escapeHTML(b.country)}` : null,
        b.appellation ? escapeHTML(b.appellation) : (b.region ? escapeHTML(b.region) : null),
        b.varietal ? escapeHTML(b.varietal) : null,
        b.alcohol ? `${escapeHTML(b.alcohol)} alc` : null,
    ].filter(Boolean);

    return `
    <div class="bottle-card" id="bottle-${escapeHTML(b.id)}">
        <div class="bottle-header">
            <div style="flex: 1; min-width: 0;">
                <div class="bottle-name">${escapeHTML(b.name || 'Unknown Wine')}${b.vintage ? ` <span style="color: #fda4af;">${b.vintage}</span>` : ''}</div>
                <div class="bottle-meta">${escapeHTML(b.winery || '')}${b.region && b.winery ? ' · ' : ''}${escapeHTML(b.region || '')}</div>
            </div>
            <div class="bottle-actions">
                <button class="btn btn-sm btn-primary" onclick="showEditBottleDialog('${escapeHTML(b.id)}')">✎</button>
                <button class="btn btn-sm btn-accent" onclick="valuateSingleBottle('${escapeHTML(b.id)}')" title="Update valuation">💎</button>
            </div>
        </div>

        ${tags.length > 0 ? `<div class="bottle-tags">${tags.map(t => `<span class="bottle-tag">${t}</span>`).join('')}</div>` : ''}

        <div class="bottle-financials">
            <div class="bottle-fin-row">
                <span>${b.qty} bottle${b.qty !== 1 ? 's' : ''} × ${fmt(b.purchasePrice)}</span>
                <span style="color: #cbd5e1;">${fmt(totalInvested)} invested</span>
            </div>
            ${hasValuation ? `
            <div class="bottle-fin-row">
                <span>Est. value</span>
                <span style="color: #d97706;">${fmt(b.estimatedValue)}/bottle · ${fmt(totalEstimated)}</span>
            </div>
            <div class="bottle-gain ${gainClass}">
                <span>Gain / Loss</span>
                <span>${gainSign}${fmt(gain)} (${gainSign}${gainPct.toFixed(1)}%)</span>
            </div>` : `
            <div class="bottle-fin-row">
                <span style="color: #64748b; font-size: 12px;">Valuation not yet fetched</span>
                <span><button class="btn btn-sm" style="background: #451a03; color: #d97706; padding: 2px 8px; font-size: 11px;" onclick="valuateSingleBottle('${escapeHTML(b.id)}')">Get estimate →</button></span>
            </div>`}
        </div>

        <div class="bottle-footer">
            ${b.drinkWindow ? `<span class="drink-window">🍷 Drink: ${escapeHTML(b.drinkWindow)}</span>` : '<span></span>'}
            ${b.lastValuedAt
                ? `<span class="valued-at">Valued ${timeAgo(b.lastValuedAt)}</span>`
                : (b.purchaseDate ? `<span class="valued-at">Bought ${fmtDate(b.purchaseDate)}</span>` : '<span></span>')}
        </div>

        ${b.notes ? `<div class="bottle-notes">${escapeHTML(b.notes)}</div>` : ''}
    </div>`;
}

function updateStatsBar(totals) {
    const gain = totals.totalEstimated - totals.totalInvested;
    const gainPct = totals.totalInvested > 0 ? (gain / totals.totalInvested) * 100 : 0;
    const gainSign = gain >= 0 ? '+' : '';
    const gainColor = gain > 0 ? '#4ade80' : gain < 0 ? '#f87171' : '#94a3b8';

    const el = id => document.getElementById(id);
    if (el('totalBottlesDisplay'))  el('totalBottlesDisplay').textContent  = totals.totalBottles;
    if (el('totalInvestedDisplay')) el('totalInvestedDisplay').textContent = fmt(totals.totalInvested);
    if (el('totalValueDisplay'))    el('totalValueDisplay').textContent    = fmt(totals.totalEstimated);
    if (el('totalGainDisplay')) {
        el('totalGainDisplay').textContent = `${gainSign}${fmt(gain)} (${gainSign}${gainPct.toFixed(1)}%)`;
        el('totalGainDisplay').style.color = gainColor;
    }
}

// ── Add / Edit Bottle ────────────────────────────────────────────────────────

export function showAddBottleDialog(prefilled = {}) {
    if (!requireAuth('add bottles')) return;
    state.editingBottleId = null;

    document.getElementById('bottleDialogTitle').textContent = '🍾 Add Bottle';
    document.getElementById('bottleDialogSubmit').textContent = 'Add Bottle';
    const deleteBtn = document.getElementById('bottleDeleteBtn');
    if (deleteBtn) deleteBtn.style.display = 'none';

    // Pre-fill from scan result or clear
    setField('bottleName',          prefilled.name || '');
    setField('bottleWinery',        prefilled.winery || '');
    setField('bottleVintage',       prefilled.vintage || '');
    setField('bottleVarietal',      prefilled.varietal || '');
    setField('bottleRegion',        prefilled.region || '');
    setField('bottleAppellation',   prefilled.appellation || '');
    setField('bottleCountry',       prefilled.country || '');
    setField('bottleAlcohol',       prefilled.alcohol || '');
    setField('bottleQty',           1);
    setField('bottlePurchasePrice', '');
    setField('bottlePurchaseDate',  new Date().toISOString().slice(0, 10));
    setField('bottleStorage',       '');
    setField('bottleNotes',         prefilled.notes || '');

    document.getElementById('bottleDialog').style.display = 'block';
    document.getElementById('bottleName').focus();
}

export function showEditBottleDialog(id) {
    const bottle = state.cellar.find(b => b.id === id);
    if (!bottle) return;

    state.editingBottleId = id;
    document.getElementById('bottleDialogTitle').textContent = '✏️ Edit Bottle';
    document.getElementById('bottleDialogSubmit').textContent = 'Save Changes';
    const deleteBtn = document.getElementById('bottleDeleteBtn');
    if (deleteBtn) deleteBtn.style.display = 'inline-flex';

    setField('bottleName',          bottle.name || '');
    setField('bottleWinery',        bottle.winery || '');
    setField('bottleVintage',       bottle.vintage || '');
    setField('bottleVarietal',      bottle.varietal || '');
    setField('bottleRegion',        bottle.region || '');
    setField('bottleAppellation',   bottle.appellation || '');
    setField('bottleCountry',       bottle.country || '');
    setField('bottleAlcohol',       bottle.alcohol || '');
    setField('bottleQty',           bottle.qty || 1);
    setField('bottlePurchasePrice', bottle.purchasePrice || '');
    setField('bottlePurchaseDate',  bottle.purchaseDate || '');
    setField('bottleStorage',       bottle.storage || '');
    setField('bottleNotes',         bottle.notes || '');

    document.getElementById('bottleDialog').style.display = 'block';
}

export function closeBottleDialog() {
    document.getElementById('bottleDialog').style.display = 'none';
    state.editingBottleId = null;
}

export async function submitBottle() {
    if (!requireAuth('save bottles')) return;
    const name          = getField('bottleName').trim();
    const qty           = parseInt(getField('bottleQty'), 10);
    const purchasePrice = parseFloat(getField('bottlePurchasePrice'));

    if (!name) { alert('Wine name is required.'); return; }
    if (!qty || qty < 1) { alert('Quantity must be at least 1.'); return; }
    if (!purchasePrice || purchasePrice < 0) { alert('Purchase price is required.'); return; }

    const submitBtn = document.getElementById('bottleDialogSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    const bottleData = {
        id:            state.editingBottleId || undefined,
        name:          name,
        winery:        getField('bottleWinery').trim() || null,
        vintage:       parseInt(getField('bottleVintage'), 10) || null,
        varietal:      getField('bottleVarietal').trim() || null,
        region:        getField('bottleRegion').trim() || null,
        appellation:   getField('bottleAppellation').trim() || null,
        country:       getField('bottleCountry').trim() || null,
        alcohol:       getField('bottleAlcohol').trim() || null,
        qty,
        purchasePrice,
        purchaseDate:  getField('bottlePurchaseDate') || null,
        storage:       getField('bottleStorage').trim() || null,
        notes:         getField('bottleNotes').trim() || null,
        // preserve existing valuation when editing
        estimatedValue: state.editingBottleId
            ? (state.cellar.find(b => b.id === state.editingBottleId)?.estimatedValue || null)
            : null,
        drinkWindow:   state.editingBottleId
            ? (state.cellar.find(b => b.id === state.editingBottleId)?.drinkWindow || null)
            : null,
        lastValuedAt:  state.editingBottleId
            ? (state.cellar.find(b => b.id === state.editingBottleId)?.lastValuedAt || null)
            : null,
    };

    try {
        const savedId = await saveBottleToDB(bottleData);
        bottleData.id = savedId || bottleData.id || ('local-' + Date.now());

        if (state.editingBottleId) {
            const idx = state.cellar.findIndex(b => b.id === state.editingBottleId);
            if (idx >= 0) state.cellar[idx] = bottleData;
        } else {
            state.cellar.push(bottleData);
        }

        closeBottleDialog();
        renderCellar();
    } catch (err) {
        alert('Failed to save bottle: ' + err.message);
        console.error(err);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = state.editingBottleId ? 'Save Changes' : 'Add Bottle';
    }
}

export async function deleteCurrentBottle() {
    if (!state.editingBottleId) return;
    const bottle = state.cellar.find(b => b.id === state.editingBottleId);
    if (!bottle) return;

    const confirmed = confirm(`Delete "${bottle.name}"? This cannot be undone.`);
    if (!confirmed) return;

    try {
        await deleteBottleFromDB(state.editingBottleId);
        state.cellar = state.cellar.filter(b => b.id !== state.editingBottleId);
        closeBottleDialog();
        renderCellar();
    } catch (err) {
        alert('Failed to delete bottle: ' + err.message);
    }
}

// ── Snapshots & History ──────────────────────────────────────────────────────

export async function saveCellarSnapshot() {
    if (!requireAuth('save snapshots')) return;
    if (state.cellar.length === 0) {
        alert('No bottles in cellar. Add some bottles first.');
        return;
    }

    const totals    = computeTotals();
    const snapshot  = {
        timestamp:           new Date().toISOString(),
        totalInvested:       totals.totalInvested,
        totalEstimatedValue: totals.totalEstimated,
        bottleCount:         totals.totalBottles,
    };

    try {
        const savedId = await saveSnapshotToDB(snapshot);
        snapshot.id = savedId || ('local-' + Date.now());
        state.cellarHistory.push(snapshot);
        updateHistoryDisplay();
        alert(`✓ Snapshot saved!\n${totals.totalBottles} bottles · ${fmt(totals.totalEstimated)} est. value`);
    } catch (err) {
        alert('Failed to save snapshot: ' + err.message);
    }
}

export function updateHistoryDisplay() {
    const historySection = document.getElementById('historySection');
    const historyChart   = document.getElementById('historyChart');
    const historyLog     = document.getElementById('historyLog');

    if (!historySection) return;

    if (state.cellarHistory.length === 0) {
        historySection.style.display = 'none';
        return;
    }

    historySection.style.display = 'block';

    // Mini bar chart
    const maxVal = Math.max(...state.cellarHistory.map(s => s.totalEstimatedValue || s.totalInvested || 0));
    const bars = state.cellarHistory.slice(-20).map(s => {
        const val    = s.totalEstimatedValue || s.totalInvested || 0;
        const pct    = maxVal > 0 ? (val / maxVal) * 100 : 10;
        const dateStr = new Date(s.timestamp).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
        return `<div class="history-bar" style="height: ${Math.max(pct, 5)}%;" title="${dateStr}: ${fmt(val)}"></div>`;
    }).join('');

    historyChart.innerHTML = `<div class="history-chart-container">${bars}</div>`;

    // Log
    const rows = [...state.cellarHistory].reverse().slice(0, 10).map(s => {
        const gain    = (s.totalEstimatedValue || 0) - (s.totalInvested || 0);
        const gainPct = s.totalInvested > 0 ? ((gain / s.totalInvested) * 100).toFixed(1) : '—';
        const gainStr = gain >= 0 ? `<span style="color:#4ade80;">+${fmt(gain)} (+${gainPct}%)</span>`
                                  : `<span style="color:#f87171;">${fmt(gain)} (${gainPct}%)</span>`;
        const deleteBtn = s.id
            ? `<button class="btn btn-sm btn-danger" style="padding: 2px 8px; font-size: 11px;" onclick="deleteSnapshot('${escapeHTML(String(s.id))}')">✕</button>`
            : '';
        return `
        <div class="history-log-item">
            <span>${new Date(s.timestamp).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span>${s.bottleCount} bottles</span>
            <span>${gainStr}</span>
            <span style="color: #94a3b8;">${fmt(s.totalEstimatedValue)}</span>
            ${deleteBtn}
        </div>`;
    }).join('');

    historyLog.innerHTML = rows;
}

export async function deleteSnapshot(id) {
    try {
        await deleteSnapshotFromDB(id);
        state.cellarHistory = state.cellarHistory.filter(s => String(s.id) !== String(id));
        updateHistoryDisplay();
    } catch (err) {
        alert('Failed to delete snapshot: ' + err.message);
    }
}

export async function clearHistory() {
    if (!confirm('Clear all cellar history snapshots? This cannot be undone.')) return;
    try {
        await clearSnapshotsFromDB();
        state.cellarHistory = [];
        updateHistoryDisplay();
    } catch (err) {
        alert('Failed to clear history: ' + err.message);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function setField(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = (value === null || value === undefined) ? '' : value;
}

function getField(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

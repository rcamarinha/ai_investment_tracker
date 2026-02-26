/**
 * Cellar service — rendering, add/edit/delete bottles, snapshots, history.
 */

import state from './state.js';
import { saveBottleToDB, deleteBottleFromDB, saveSnapshotToDB,
         deleteSnapshotFromDB, clearSnapshotsFromDB } from './storage.js';
import { renderAllocationCharts } from './ui.js';
import { showToast, showUndoToast, showConfirm, openModal, closeModal, escapeHTML } from './utils.js';
import { getDrinkStatus, filterBottles, sortBottles } from '../src/wine.js';

// ── Auth Guard ────────────────────────────────────────────────────────────────

function requireAuth(actionName) {
    if (!state.supabaseClient) return true; // local-only mode
    if (state.currentUser) return true;
    showToast(`Please log in to ${actionName}.`, 'warning');
    return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function drinkBadgeHtml(drinkWindow) {
    const status = getDrinkStatus(drinkWindow);
    if (status === 'unknown') return '';
    const map = {
        'not-ready': { cls: 'drink-badge-not-ready', label: '🔵 Not Ready' },
        'ready':     { cls: 'drink-badge-ready',     label: '🟢 Ready Now' },
        'at-peak':   { cls: 'drink-badge-at-peak',   label: '🟡 At Peak'   },
        'past-peak': { cls: 'drink-badge-past-peak', label: '🔴 Past Peak' },
    };
    const { cls, label } = map[status];
    return `<span class="drink-badge ${cls}">${label}</span>`;
}

// ── Inline form error helpers ─────────────────────────────────────────────────

function showFieldError(fieldId, message) {
    const field  = document.getElementById(fieldId);
    const errDiv = document.getElementById(fieldId + 'Error');
    if (field)  field.classList.add('field-invalid');
    if (errDiv) errDiv.textContent = message;
}

function clearFieldErrors() {
    document.querySelectorAll('.field-invalid').forEach(el => el.classList.remove('field-invalid'));
    document.querySelectorAll('.form-error').forEach(el => { el.textContent = ''; });
}

// ── Totals ────────────────────────────────────────────────────────────────────

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

// ── Advanced Filter State ─────────────────────────────────────────────────────
// Module-level Sets, persisted in the DOM (checkboxes); rebuilt on each render.

const _activeCountries = new Set();
const _activeVarietals  = new Set();

export function onFilterChange(checkbox) {
    const dim = checkbox.dataset.dim;
    const val = checkbox.value;
    if (dim === 'country') {
        if (checkbox.checked) _activeCountries.add(val); else _activeCountries.delete(val);
    } else if (dim === 'varietal') {
        if (checkbox.checked) _activeVarietals.add(val); else _activeVarietals.delete(val);
    }
    renderCellar();
}

function applyAdvancedFilters(bottles) {
    let result = bottles;
    if (_activeCountries.size > 0) {
        result = result.filter(b => _activeCountries.has(b.country || 'Unknown'));
    }
    if (_activeVarietals.size > 0) {
        result = result.filter(b => _activeVarietals.has(b.varietal || 'Unknown'));
    }
    return result;
}

function renderFilterPanel() {
    const container = document.getElementById('filterGroups');
    if (!container) return;

    const countries = [...new Set(state.cellar.map(b => b.country).filter(Boolean))].sort();
    const varietals = [...new Set(state.cellar.map(b => b.varietal).filter(Boolean))].sort();

    if (countries.length === 0 && varietals.length === 0) {
        container.innerHTML = '<span style="color:#64748b;font-size:13px;">No filters available yet.</span>';
        return;
    }

    const chips = (items, dim) => items.map(v => `
        <label class="filter-chip${(dim === 'country' ? _activeCountries : _activeVarietals).has(v) ? ' active' : ''}">
            <input type="checkbox" data-dim="${dim}" value="${escapeHTML(v)}"
                   ${(dim === 'country' ? _activeCountries : _activeVarietals).has(v) ? 'checked' : ''}
                   onchange="onFilterChange(this)" />
            ${escapeHTML(v)}
        </label>`).join('');

    container.innerHTML = `
        ${countries.length > 0 ? `
            <div class="filter-group">
                <div class="filter-group-label">Country</div>
                <div class="filter-chips">${chips(countries, 'country')}</div>
            </div>` : ''}
        ${varietals.length > 0 ? `
            <div class="filter-group">
                <div class="filter-group-label">Varietal</div>
                <div class="filter-chips">${chips(varietals, 'varietal')}</div>
            </div>` : ''}`;
}

// ── Portfolio Rendering ───────────────────────────────────────────────────────

export function renderCellar() {
    const bottlesDiv = document.getElementById('bottles');
    if (!bottlesDiv) return;

    // Show/hide search + filter controls
    const controlsEl = document.getElementById('bottleControls');
    if (controlsEl) controlsEl.style.display = state.cellar.length > 0 ? 'flex' : 'none';

    const filterPanel = document.getElementById('filterPanel');
    if (filterPanel) filterPanel.style.display = state.cellar.length > 0 ? '' : 'none';

    if (state.cellar.length === 0) {
        bottlesDiv.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🍾</div>
                <h3>Your cellar is empty</h3>
                <p>Scan a wine label with your camera, or add a bottle manually to get started.</p>
                <div class="empty-state-actions">
                    <label for="photoUpload" class="btn btn-accent" style="cursor: pointer;">📷 Scan a Label</label>
                    <button class="btn btn-success" onclick="showAddBottleDialog()">➕ Add Manually</button>
                </div>
            </div>`;
        updateStatsBar({ totalInvested: 0, totalEstimated: 0, totalBottles: 0 });
        updateHistoryDisplay();
        renderAllocationCharts();
        return;
    }

    // Rebuild the filter panel options (preserves checked state via Sets)
    renderFilterPanel();

    const totals = computeTotals();
    updateStatsBar(totals);

    // P2: Drink-window summary line
    updateReadySummary();

    // Apply text search
    const searchTerm = document.getElementById('bottleSearch')?.value || '';
    let result = filterBottles(state.cellar, searchTerm);

    // Apply advanced filters (country / varietal chips)
    result = applyAdvancedFilters(result);

    // Apply sort
    const sortMode = document.getElementById('bottleSort')?.value || 'added';
    result = sortBottles(result, sortMode);

    if (result.length === 0) {
        const hasFilter = _activeCountries.size > 0 || _activeVarietals.size > 0;
        const hint = hasFilter
            ? 'Try clearing some filters above.'
            : `Try a different search term.`;
        bottlesDiv.innerHTML = `
            <div class="no-results">
                No wines match your current search/filter.<br>
                <span style="font-size:12px;color:#475569;">${hint}</span>
            </div>`;
    } else {
        bottlesDiv.innerHTML = result.map(b => renderBottleCard(b)).join('');
    }

    updateHistoryDisplay();
    renderAllocationCharts();
}

function updateReadySummary() {
    const el = document.getElementById('readySummary');
    if (!el) return;

    const counts = { 'ready': 0, 'at-peak': 0, 'not-ready': 0, 'past-peak': 0 };
    state.cellar.forEach(b => {
        const s = getDrinkStatus(b.drinkWindow);
        if (s in counts) counts[s]++;
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) { el.style.display = 'none'; return; }

    const parts = [];
    if (counts['ready']     > 0) parts.push(`<span style="color:#4ade80;">🟢 ${counts['ready']} ready</span>`);
    if (counts['at-peak']   > 0) parts.push(`<span style="color:#fbbf24;">🟡 ${counts['at-peak']} at peak</span>`);
    if (counts['not-ready'] > 0) parts.push(`<span style="color:#60a5fa;">🔵 ${counts['not-ready']} not ready</span>`);
    if (counts['past-peak'] > 0) parts.push(`<span style="color:#f87171;">🔴 ${counts['past-peak']} past peak</span>`);
    el.style.display = 'block';
    el.innerHTML = parts.join('<span style="color:#334155;"> · </span>');
}

function renderBottleCard(b) {
    const hasPurchasePrice = b.purchasePrice != null && b.purchasePrice > 0;
    const totalInvested  = hasPurchasePrice ? (b.qty || 0) * b.purchasePrice : 0;
    const hasValuation   = b.estimatedValue != null;
    const totalEstimated = hasValuation ? (b.qty || 0) * b.estimatedValue : totalInvested;
    const gain           = totalEstimated - totalInvested;
    const gainPct        = totalInvested > 0 ? (gain / totalInvested) * 100 : 0;
    const gainClass      = gain > 0 ? 'positive' : gain < 0 ? 'negative' : 'neutral';
    const gainSign       = gain >= 0 ? '+' : '';

    const tags = [
        b.country     ? `🌍 ${escapeHTML(b.country)}` : null,
        b.appellation ? escapeHTML(b.appellation) : (b.region ? escapeHTML(b.region) : null),
        b.varietal    ? escapeHTML(b.varietal) : null,
        b.alcohol     ? `${escapeHTML(b.alcohol)} alc` : null,
    ].filter(Boolean);

    const rangeHtml = (hasValuation && b.valueLow && b.valueHigh)
        ? `<div class="valuation-range">Range: ${fmt(b.valueLow)} – ${fmt(b.valueHigh)}</div>`
        : '';

    const usdHtml = (hasValuation && b.estimatedValueUSD)
        ? `<div class="valuation-usd">≈ ${fmt(b.estimatedValueUSD, 'USD')} USD</div>`
        : '';

    const confidenceMap = {
        high:   { cls: 'confidence-high',   label: '● High confidence' },
        medium: { cls: 'confidence-medium', label: '● Medium confidence' },
        low:    { cls: 'confidence-low',    label: '● Low confidence' },
    };
    const confEntry = b.confidence && confidenceMap[b.confidence];
    const confidenceHtml = confEntry
        ? `<span class="confidence-badge ${confEntry.cls}">${confEntry.label}</span>`
        : '';

    // Staleness warning: valuation older than 60 days
    const staleHtml = (() => {
        if (!b.lastValuedAt) return '';
        const ageDays = Math.floor((Date.now() - new Date(b.lastValuedAt).getTime()) / 86400000);
        return ageDays > 60
            ? `<div class="valuation-stale">⚠ Valuation is ${ageDays} days old — consider refreshing</div>`
            : '';
    })();

    const noteHtml = (hasValuation && (b.valuationNote || b.valuationSources))
        ? `<div class="valuation-note">
            ${b.valuationNote ? escapeHTML(b.valuationNote) : ''}
            ${b.valuationSources ? `<div class="valuation-sources">📊 ${escapeHTML(b.valuationSources)}</div>` : ''}
           </div>`
        : '';

    const badge  = drinkBadgeHtml(b.drinkWindow);
    const hasWindow = !!b.drinkWindow;

    return `
    <div class="bottle-card" id="bottle-${escapeHTML(b.id)}">
        <div class="bottle-header">
            <div style="flex: 1; min-width: 0;">
                <div class="bottle-name">${escapeHTML(b.name || 'Unknown Wine')}${b.vintage ? ` <span style="color: #fda4af;">${b.vintage}</span>` : ''}</div>
                <div class="bottle-meta">${escapeHTML(b.winery || '')}${b.region && b.winery ? ' · ' : ''}${escapeHTML(b.region || '')}</div>
            </div>
            <div class="bottle-actions">
                <button class="btn btn-sm btn-primary" onclick="showEditBottleDialog('${escapeHTML(b.id)}')" title="Edit bottle">✎ Edit</button>
                <button class="btn btn-sm btn-accent" onclick="valuateSingleBottle('${escapeHTML(b.id)}')" title="Refresh AI valuation">💎</button>
            </div>
        </div>

        ${tags.length > 0 ? `<div class="bottle-tags">${tags.map(t => `<span class="bottle-tag">${t}</span>`).join('')}</div>` : ''}

        <div class="bottle-financials">
            ${hasPurchasePrice ? `
            <div class="bottle-fin-row">
                <span>${b.qty} bottle${b.qty !== 1 ? 's' : ''} × ${fmt(b.purchasePrice)}</span>
                <span style="color: #cbd5e1;">${fmt(totalInvested)} invested</span>
            </div>` : `
            <div class="bottle-fin-row">
                <span>${b.qty} bottle${b.qty !== 1 ? 's' : ''}</span>
                <span style="color: #64748b; font-size: 12px;">No purchase price</span>
            </div>`}
            ${hasValuation ? `
            <div class="bottle-fin-row">
                <div>
                    <div>Est. value ${confidenceHtml}</div>
                    ${rangeHtml}
                    ${usdHtml}
                </div>
                <span style="color: #d97706;">${fmt(b.estimatedValue)}/bottle · ${fmt(totalEstimated)}</span>
            </div>
            ${hasPurchasePrice ? `
            <div class="bottle-gain ${gainClass}">
                <span>Gain / Loss</span>
                <span>${gainSign}${fmt(gain)} (${gainSign}${gainPct.toFixed(1)}%)</span>
            </div>` : ''}` : `
            <div class="bottle-fin-row">
                <span style="color: #64748b; font-size: 12px;">Valuation not yet fetched</span>
                <span><button class="btn btn-sm" style="background: #451a03; color: #d97706; padding: 2px 8px; font-size: 11px;" onclick="valuateSingleBottle('${escapeHTML(b.id)}')">Get estimate →</button></span>
            </div>`}
        </div>

        ${noteHtml}
        ${staleHtml}

        <div class="bottle-footer">
            <div>
                ${badge}
                ${hasWindow ? `<div class="drink-window-sub">Drink: ${escapeHTML(b.drinkWindow)}</div>` : ''}
            </div>
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

// ── Add / Edit Bottle ─────────────────────────────────────────────────────────

export function showAddBottleDialog(prefilled = {}) {
    if (!requireAuth('add bottles')) return;
    state.editingBottleId = null;

    document.getElementById('bottleDialogTitle').textContent = '🍾 Add Bottle';
    document.getElementById('bottleDialogSubmit').textContent = 'Add Bottle';
    const deleteBtn = document.getElementById('bottleDeleteBtn');
    if (deleteBtn) deleteBtn.style.display = 'none';

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

    clearFieldErrors();
    openModal('bottleDialog');
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

    clearFieldErrors();
    openModal('bottleDialog');
}

export function closeBottleDialog() {
    closeModal('bottleDialog');
    state.editingBottleId = null;
}

export async function submitBottle() {
    if (!requireAuth('save bottles')) return;

    clearFieldErrors();

    const name             = getField('bottleName').trim();
    const qty              = parseInt(getField('bottleQty'), 10);
    const purchasePriceRaw = getField('bottlePurchasePrice');
    const purchasePrice    = purchasePriceRaw !== '' ? parseFloat(purchasePriceRaw) : null;

    let hasError = false;
    if (!name) {
        showFieldError('bottleName', 'Wine name is required.');
        hasError = true;
    }
    if (!qty || qty < 1) {
        showFieldError('bottleQty', 'Quantity must be at least 1.');
        hasError = true;
    }
    if (purchasePrice !== null && purchasePrice < 0) {
        showFieldError('bottlePurchasePrice', 'Price cannot be negative.');
        hasError = true;
    }
    if (hasError) return;

    const submitBtn = document.getElementById('bottleDialogSubmit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';

    const isEdit = !!state.editingBottleId;
    const existingBottle = isEdit ? state.cellar.find(b => b.id === state.editingBottleId) : null;

    const bottleData = {
        id:            state.editingBottleId || undefined,
        wineId:        existingBottle?.wineId          ?? null,
        name,
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
        estimatedValue:    existingBottle?.estimatedValue    ?? null,
        estimatedValueUSD: existingBottle?.estimatedValueUSD ?? null,
        drinkWindow:       existingBottle?.drinkWindow       ?? null,
        lastValuedAt:      existingBottle?.lastValuedAt      ?? null,
        valueLow:          existingBottle?.valueLow          ?? null,
        valueHigh:         existingBottle?.valueHigh         ?? null,
        confidence:        existingBottle?.confidence        ?? null,
        valuationNote:     existingBottle?.valuationNote     ?? null,
        valuationSources:  existingBottle?.valuationSources  ?? null,
    };

    try {
        const savedId = await saveBottleToDB(bottleData);
        bottleData.id = savedId || bottleData.id || ('local-' + Date.now());

        if (isEdit) {
            const idx = state.cellar.findIndex(b => b.id === state.editingBottleId);
            if (idx >= 0) state.cellar[idx] = bottleData;
        } else {
            state.cellar.push(bottleData);
        }

        closeBottleDialog();
        renderCellar();
        showToast(isEdit ? 'Bottle updated.' : 'Bottle added to cellar!');
    } catch (err) {
        showToast('Failed to save bottle: ' + err.message, 'error');
        console.error(err);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = isEdit ? 'Save Changes' : 'Add Bottle';
    }
}

export async function deleteCurrentBottle() {
    if (!state.editingBottleId) return;
    const bottle = state.cellar.find(b => b.id === state.editingBottleId);
    if (!bottle) return;

    const confirmed = await showConfirm(
        `Delete "${bottle.name}"? You'll have a few seconds to undo.`,
        { confirmLabel: 'Delete', danger: true }
    );
    if (!confirmed) return;

    const bottleId    = state.editingBottleId;
    const bottleIndex = state.cellar.indexOf(bottle);

    // Optimistic UI removal
    state.cellar = state.cellar.filter(b => b.id !== bottleId);
    closeBottleDialog();
    renderCellar();

    // Undo grace period: commit to DB only after 5s
    showUndoToast(
        `"${bottle.name}" deleted.`,
        () => {
            // Undo clicked → restore
            state.cellar.splice(bottleIndex, 0, bottle);
            renderCellar();
            showToast(`"${bottle.name}" restored.`);
        },
        async () => {
            // Grace period expired → actually delete from DB
            try {
                await deleteBottleFromDB(bottleId);
            } catch (err) {
                console.error('Failed to delete from DB after undo window:', err);
                showToast('Warning: cloud sync of deletion failed.', 'warning');
            }
        }
    );
}

// ── CSV Export ────────────────────────────────────────────────────────────────

export function exportCellarCSV() {
    if (state.cellar.length === 0) {
        showToast('No bottles to export.', 'warning');
        return;
    }

    const headers = [
        'Name', 'Winery', 'Vintage', 'Region', 'Appellation', 'Varietal',
        'Country', 'Alcohol', 'Qty', 'Purchase Price (€)', 'Purchase Date',
        'Storage', 'Est. Value (€)', 'Drink Window', 'Notes'
    ];

    const csvVal = v => {
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s;
    };

    const rows = state.cellar.map(b => [
        b.name, b.winery, b.vintage, b.region, b.appellation, b.varietal,
        b.country, b.alcohol, b.qty, b.purchasePrice, b.purchaseDate,
        b.storage, b.estimatedValue, b.drinkWindow, b.notes
    ].map(csvVal).join(','));

    const csv  = [headers.join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `wine-cellar-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Exported ${state.cellar.length} bottle${state.cellar.length !== 1 ? 's' : ''} to CSV.`);
}

// ── Snapshots & History ───────────────────────────────────────────────────────

export async function saveCellarSnapshot() {
    if (!requireAuth('save snapshots')) return;
    if (state.cellar.length === 0) {
        showToast('Add some bottles before saving a snapshot.', 'warning');
        return;
    }

    const totals   = computeTotals();
    const snapshot = {
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
        showToast(`Snapshot saved — ${totals.totalBottles} bottles · ${fmt(totals.totalEstimated)}`);
    } catch (err) {
        showToast('Failed to save snapshot: ' + err.message, 'error');
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
        const gainStr = gain >= 0
            ? `<span style="color:#4ade80;">+${fmt(gain)} (+${gainPct}%)</span>`
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
        showToast('Snapshot deleted.');
    } catch (err) {
        showToast('Failed to delete snapshot: ' + err.message, 'error');
    }
}

export async function clearHistory() {
    const confirmed = await showConfirm(
        'Clear all cellar history snapshots? This cannot be undone.',
        { confirmLabel: 'Clear All', danger: true }
    );
    if (!confirmed) return;
    try {
        await clearSnapshotsFromDB();
        state.cellarHistory = [];
        updateHistoryDisplay();
        showToast('History cleared.');
    } catch (err) {
        showToast('Failed to clear history: ' + err.message, 'error');
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setField(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = (value === null || value === undefined) ? '' : value;
}

function getField(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

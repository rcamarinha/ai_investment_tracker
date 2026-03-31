/**
 * Cellar service — rendering, add/edit/delete bottles, snapshots, history.
 */

import { t } from '../data/i18n.js';
import state from './state.js';
import { saveBottleToDB, deleteBottleFromDB, saveSnapshotToDB,
         deleteSnapshotFromDB, clearSnapshotsFromDB,
         findExistingUserWineHoldings, findAndMergeDuplicates } from './storage.js';
import { renderAllocationCharts } from './ui.js';
import { showToast, showUndoToast, showConfirm, showMergeDialog, openModal, closeModal, escapeHTML, repairTruncatedJSON } from './utils.js';
import { getDrinkStatus, filterBottles, sortBottles } from '../src/wine.js';
import { callWineAI } from './api.js?v=1.3.20';

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
    if (days === 0) return t('time.today');
    if (days === 1) return t('time.yesterday');
    if (days < 30) return t('time.days_ago').replace('{n}', days);
    const months = Math.floor(days / 30);
    if (months < 12) return t('time.months_ago').replace('{n}', months);
    return t('time.years_ago').replace('{n}', Math.floor(months / 12));
}

function drinkBadgeHtml(drinkWindow) {
    const status = getDrinkStatus(drinkWindow);
    if (status === 'unknown') return '';
    const map = {
        'not-ready': { cls: 'drink-badge-not-ready', label: t('drink.not_ready') },
        'ready':     { cls: 'drink-badge-ready',     label: t('drink.ready')     },
        'at-peak':   { cls: 'drink-badge-at-peak',   label: t('drink.at_peak')   },
        'past-peak': { cls: 'drink-badge-past-peak', label: t('drink.past_peak') },
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
// Module-level Sets, persisted in memory; rebuilt on each render.

const _activeTypes     = new Set();
const _activeReadiness = new Set();
const _activeCountries = new Set();
const _activeRegions   = new Set();
const _activeProducers = new Set();
const _activeVintages  = new Set();
const _activeVarietals = new Set();

// Type chip click (toggle)
export function onTypeFilterClick(btn) {
    const type = btn.dataset.type;
    if (_activeTypes.has(type)) {
        _activeTypes.delete(type);
    } else {
        _activeTypes.add(type);
    }
    renderCellar();
}

// Readiness status chip click (toggle)
export function onReadinessFilterClick(btn) {
    const status = btn.dataset.status;
    if (_activeReadiness.has(status)) {
        _activeReadiness.delete(status);
    } else {
        _activeReadiness.add(status);
    }
    renderCellar();
}

// Dimension checkbox toggle (country / region / producer / vintage / varietal)
export function onFilterChange(checkbox) {
    const dim = checkbox.dataset.dim;
    const val = checkbox.value;
    const setMap = {
        type:     _activeTypes,
        country:  _activeCountries,
        region:   _activeRegions,
        producer: _activeProducers,
        vintage:  _activeVintages,
        varietal: _activeVarietals,
    };
    const set = setMap[dim];
    if (set) {
        if (checkbox.checked) set.add(val); else set.delete(val);
    }
    renderCellar();
}

export function clearAllFilters() {
    _activeTypes.clear();
    _activeReadiness.clear();
    _activeCountries.clear();
    _activeRegions.clear();
    _activeProducers.clear();
    _activeVintages.clear();
    _activeVarietals.clear();
    renderCellar();
}

export function toggleMoreFilters() {
    const el  = document.getElementById('filterExpanded');
    const btn = document.getElementById('filterMoreBtn');
    if (!el) return;
    const isOpen = el.style.display !== 'none';
    el.style.display = isOpen ? 'none' : 'block';
    if (btn) btn.classList.toggle('active', !isOpen);
}

function _totalActiveFilters() {
    return _activeTypes.size + _activeReadiness.size + _activeCountries.size + _activeRegions.size +
           _activeProducers.size + _activeVintages.size + _activeVarietals.size;
}

function applyAdvancedFilters(bottles) {
    let result = bottles;
    if (_activeTypes.size > 0) {
        result = result.filter(b => _activeTypes.has(b.type || 'Unknown'));
    }
    if (_activeReadiness.size > 0) {
        result = result.filter(b => _activeReadiness.has(getDrinkStatus(b.drinkWindow)));
    }
    if (_activeCountries.size > 0) {
        result = result.filter(b => _activeCountries.has(b.country || 'Unknown'));
    }
    if (_activeRegions.size > 0) {
        result = result.filter(b => _activeRegions.has(b.region || 'Unknown'));
    }
    if (_activeProducers.size > 0) {
        result = result.filter(b => _activeProducers.has(b.winery || 'Unknown'));
    }
    if (_activeVintages.size > 0) {
        result = result.filter(b => _activeVintages.has(String(b.vintage || '')));
    }
    if (_activeVarietals.size > 0) {
        result = result.filter(b => _activeVarietals.has(b.varietal || 'Unknown'));
    }
    return result;
}

// ── Type chip configuration ──────────────────────────────────────────────────

const TYPE_CONFIG = [
    { value: 'Red Wine',       icon: '🍷', color: '#9B3A5A', bg: 'rgba(155,58,90,0.12)'  },
    { value: 'White Wine',     icon: '🥂', color: '#C9A84C', bg: 'rgba(201,168,76,0.12)'  },
    { value: 'Rosé',           icon: '🌸', color: '#C4607C', bg: 'rgba(196,96,124,0.12)'  },
    { value: 'Sparkling',      icon: '🍾', color: '#A0A0A0', bg: 'rgba(160,160,160,0.12)' },
    { value: 'Port',           icon: '🏰', color: '#5A2035', bg: 'rgba(90,32,53,0.18)'    },
    { value: 'Dessert Wine',   icon: '🍯', color: '#E09A3A', bg: 'rgba(224,154,58,0.12)'  },
    { value: 'Fortified Wine', icon: '🛡️', color: '#7A6430', bg: 'rgba(122,100,48,0.12)'  },
    { value: 'Cognac',         icon: '🥃', color: '#B8860B', bg: 'rgba(184,134,11,0.12)'  },
    { value: 'Whiskey',        icon: '🥃', color: '#8B4513', bg: 'rgba(139,69,19,0.12)'   },
    { value: 'Aguardente',    icon: '🔥', color: '#B5651D', bg: 'rgba(181,101,29,0.12)' },
    { value: 'Gin',           icon: '🍸', color: '#4A7C59', bg: 'rgba(74,124,89,0.12)'  },
    { value: 'Other',          icon: '🍶', color: '#7A8099', bg: 'rgba(122,128,153,0.12)' },
];

/**
 * Compute a "cascaded" subset for a given dimension by applying all active
 * filters EXCEPT that dimension's own filter. Returns the bottles that would
 * remain visible if dimension D had no active selections.
 */
function _cascadedSubset(excludeDim) {
    let result = state.cellar;
    if (excludeDim !== 'type' && _activeTypes.size > 0) {
        result = result.filter(b => _activeTypes.has(b.type || 'Unknown'));
    }
    if (excludeDim !== 'readiness' && _activeReadiness.size > 0) {
        result = result.filter(b => _activeReadiness.has(getDrinkStatus(b.drinkWindow)));
    }
    if (excludeDim !== 'country' && _activeCountries.size > 0) {
        result = result.filter(b => _activeCountries.has(b.country || 'Unknown'));
    }
    if (excludeDim !== 'region' && _activeRegions.size > 0) {
        result = result.filter(b => _activeRegions.has(b.region || 'Unknown'));
    }
    if (excludeDim !== 'producer' && _activeProducers.size > 0) {
        result = result.filter(b => _activeProducers.has(b.winery || 'Unknown'));
    }
    if (excludeDim !== 'vintage' && _activeVintages.size > 0) {
        result = result.filter(b => _activeVintages.has(String(b.vintage || '')));
    }
    if (excludeDim !== 'varietal' && _activeVarietals.size > 0) {
        result = result.filter(b => _activeVarietals.has(b.varietal || 'Unknown'));
    }
    return result;
}

function renderFilterPanel() {
    const typeRow      = document.getElementById('typeFilterRow');
    const readinessRow = document.getElementById('readinessFilterRow');
    const container    = document.getElementById('filterGroups');
    if (!readinessRow || !container) return;

    // ── Type quick-filter chips ───────────────────────────────────────────────
    if (typeRow) {
        const typeSubset = _cascadedSubset('type');
        const typeCounts = {};
        typeSubset.forEach(b => {
            const t = b.type || 'Unknown';
            typeCounts[t] = (typeCounts[t] || 0) + 1;
        });

        const visibleTypes = TYPE_CONFIG.filter(tc => typeCounts[tc.value] > 0);
        // Also show "Unknown" if present
        if (typeCounts['Unknown'] > 0) {
            visibleTypes.push({ value: 'Unknown', icon: '❓', color: '#7A8099', bg: 'rgba(122,128,153,0.12)' });
        }

        if (visibleTypes.length <= 1) {
            typeRow.innerHTML = '';
        } else {
            typeRow.innerHTML = visibleTypes.map(tc => {
                const isActive = _activeTypes.has(tc.value);
                return `<button class="type-chip${isActive ? ' active' : ''}"
                    data-type="${escapeHTML(tc.value)}"
                    onclick="onTypeFilterClick(this)"
                    style="--chip-color:${tc.color};--chip-bg:${tc.bg};"
                    >${tc.icon} <strong>${typeCounts[tc.value]}</strong> ${escapeHTML(tc.value)}</button>`;
            }).join('');
        }
    }

    // ── Readiness status chips ────────────────────────────────────────────────
    const readinessSubset = _cascadedSubset('readiness');
    const counts = { 'ready': 0, 'at-peak': 0, 'not-ready': 0, 'past-peak': 0 };
    readinessSubset.forEach(b => {
        const s = getDrinkStatus(b.drinkWindow);
        if (s in counts) counts[s]++;
    });

    const readinessConfig = [
        { status: 'ready',     icon: '🟢', label: t('cellar.ready'),     color: '#4CAF84', bg: 'rgba(76,175,132,0.12)' },
        { status: 'at-peak',   icon: '🟡', label: t('cellar.at_peak'),   color: '#C9A84C', bg: 'rgba(201,168,76,0.12)'  },
        { status: 'not-ready', icon: '🔵', label: t('cellar.not_ready'), color: '#7A8099', bg: 'rgba(122,128,153,0.12)'  },
        { status: 'past-peak', icon: '🔴', label: t('cellar.past_peak'), color: '#E05A5A', bg: 'rgba(224,90,90,0.12)' },
    ];

    const totalWithWindow = Object.values(counts).reduce((a, b) => a + b, 0);
    if (totalWithWindow === 0) {
        readinessRow.innerHTML = '';
    } else {
        readinessRow.innerHTML = readinessConfig
            .filter(c => counts[c.status] > 0)
            .map(c => {
                const isActive = _activeReadiness.has(c.status);
                return `<button class="readiness-chip${isActive ? ' active' : ''}"
                    data-status="${c.status}"
                    onclick="onReadinessFilterClick(this)"
                    style="--chip-color:${c.color};--chip-bg:${c.bg};"
                    >${c.icon} <strong>${counts[c.status]}</strong> ${escapeHTML(c.label)}</button>`;
            }).join('');
    }

    // ── Dimension filter groups (cascaded) ────────────────────────────────────
    const uniq  = (arr) => [...new Set(arr.filter(Boolean))].sort();
    const uniqN = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => b - a);

    const groups = [
        { dim: 'country',  label: t('filter.country'),  items: uniq(_cascadedSubset('country').map(b => b.country)),           set: _activeCountries },
        { dim: 'region',   label: t('filter.region'),   items: uniq(_cascadedSubset('region').map(b => b.region)),             set: _activeRegions   },
        { dim: 'producer', label: t('filter.producer'), items: uniq(_cascadedSubset('producer').map(b => b.winery)),           set: _activeProducers },
        { dim: 'vintage',  label: t('filter.vintage'),  items: uniqN(_cascadedSubset('vintage').map(b => b.vintage)).map(String), set: _activeVintages  },
        { dim: 'varietal', label: t('filter.varietal'), items: uniq(_cascadedSubset('varietal').map(b => b.varietal)),         set: _activeVarietals },
    ].filter(g => g.items.length > 0);

    if (groups.length === 0) {
        container.innerHTML = '';
    } else {
        const chipHtml = (items, dim, activeSet) => items.map(v => `
            <label class="filter-chip${activeSet.has(v) ? ' active' : ''}">
                <input type="checkbox" data-dim="${dim}" value="${escapeHTML(v)}"
                       ${activeSet.has(v) ? 'checked' : ''}
                       onchange="onFilterChange(this)" />
                ${escapeHTML(v)}
            </label>`).join('');

        container.innerHTML = groups.map(g => `
            <div class="filter-group">
                <div class="filter-group-label">${escapeHTML(g.label)}</div>
                <div class="filter-chips">${chipHtml(g.items, g.dim, g.set)}</div>
            </div>`).join('');
    }

    // ── Update active-count badge & clear button ──────────────────────────────
    const total    = _totalActiveFilters();
    const badge    = document.getElementById('filterCountBadge');
    const clearBtn = document.getElementById('clearFiltersBtn');
    const moreBtn  = document.getElementById('filterMoreBtn');
    if (badge)    { badge.style.display    = total > 0 ? 'inline-flex' : 'none'; badge.textContent = total; }
    if (clearBtn) { clearBtn.style.display = total > 0 ? '' : 'none'; }
    if (moreBtn)  { moreBtn.classList.toggle('has-active', total > 0); }
}

// ── Portfolio Rendering ───────────────────────────────────────────────────────

export function renderCellar() {
    const bottlesDiv = document.getElementById('bottles');
    if (!bottlesDiv) return;

    // Show/hide search/sort controls and filter bar
    const controlsEl = document.getElementById('bottleControls');
    if (controlsEl) controlsEl.style.display = state.cellar.length > 0 ? 'flex' : 'none';

    const filterBar = document.getElementById('filterBar');
    if (filterBar) filterBar.style.display = state.cellar.length > 0 ? 'flex' : 'none';

    if (state.cellar.length === 0) {
        bottlesDiv.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">🍾</div>
                <h3>${t('cellar.empty_title')}</h3>
                <p>${t('cellar.empty_desc')}</p>
                <div class="empty-state-actions">
                    <label for="photoUpload" class="btn btn-accent" style="cursor: pointer;">${t('cellar.scan_label')}</label>
                    <button class="btn btn-success" onclick="showAddBottleDialog()">${t('cellar.add_manual')}</button>
                </div>
            </div>`;
        updateStatsBar({ totalInvested: 0, totalEstimated: 0, totalBottles: 0 });
        updateHistoryDisplay();
        renderAllocationCharts();
        return;
    }

    // Rebuild the filter panel (readiness chips + dimension groups)
    renderFilterPanel();

    const totals = computeTotals();
    updateStatsBar(totals);

    // Apply text search
    const searchTerm = document.getElementById('bottleSearch')?.value || '';
    let result = filterBottles(state.cellar, searchTerm);

    // Apply advanced filters (country / varietal chips)
    result = applyAdvancedFilters(result);

    // Apply sort
    const sortMode = document.getElementById('bottleSort')?.value || 'added';
    result = sortBottles(result, sortMode);

    if (result.length === 0) {
        const hasFilter = _totalActiveFilters() > 0;
        const hint = hasFilter ? t('cellar.no_results_filters') : t('cellar.no_results_search');
        bottlesDiv.innerHTML = `
            <div class="no-results">
                ${t('cellar.no_results')}<br>
                <span class="no-results-hint">${hint}</span>
            </div>`;
    } else {
        bottlesDiv.innerHTML = result.map(b => renderBottleCard(b)).join('');
    }

    updateHistoryDisplay();
    renderAllocationCharts();
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

    const sizeLabel = b.bottleSize && b.bottleSize !== '0.75L' ? `🍾 ${escapeHTML(b.bottleSize)}` : null;

    const typeIcon = b.type ? (TYPE_CONFIG.find(tc => tc.value === b.type)?.icon || '🍶') : null;

    const tags = [
        b.type        ? `${typeIcon} ${escapeHTML(b.type)}` : null,
        b.country     ? `🌍 ${escapeHTML(b.country)}` : null,
        b.appellation ? escapeHTML(b.appellation) : (b.region ? escapeHTML(b.region) : null),
        b.varietal    ? escapeHTML(b.varietal) : null,
        b.alcohol     ? `${escapeHTML(b.alcohol)} alc` : null,
        sizeLabel,
    ].filter(Boolean);

    const rangeHtml = (hasValuation && b.valueLow && b.valueHigh)
        ? `<div class="valuation-range">${t('bottle.card.range')} ${fmt(b.valueLow)} – ${fmt(b.valueHigh)}</div>`
        : '';

    const usdHtml = (hasValuation && b.estimatedValueUSD)
        ? `<div class="valuation-usd">≈ ${fmt(b.estimatedValueUSD, 'USD')} USD</div>`
        : '';

    const confidenceMap = {
        high:   { cls: 'conf-high', label: t('conf.high')   },
        medium: { cls: 'conf-med',  label: t('conf.medium') },
        low:    { cls: 'conf-low',  label: t('conf.low')    },
    };
    const confEntry = b.confidence && confidenceMap[b.confidence];
    const confidenceHtml = confEntry
        ? `<span class="conf-badge ${confEntry.cls}">${confEntry.label}</span>`
        : '';

    // Staleness warning: valuation older than 60 days
    const staleHtml = (() => {
        if (!b.lastValuedAt) return '';
        const ageDays = Math.floor((Date.now() - new Date(b.lastValuedAt).getTime()) / 86400000);
        return ageDays > 60
            ? `<div class="stale-warning">${t('bottle.card.stale').replace('{n}', ageDays)}</div>`
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
    const metaValueClass = hasValuation ? (gain > 0 ? 'up' : gain < 0 ? 'down' : '') : '';

    return `
    <div class="wine-card" id="bottle-${escapeHTML(b.id)}">

        <!-- Header: name + vintage + action buttons -->
        <div class="wc-header">
            <div style="flex:1;min-width:0;">
                <div class="wc-name">${escapeHTML(b.name || 'Unknown Wine')}</div>
                ${b.winery ? `<div class="wc-producer">${escapeHTML(b.winery)}</div>` : ''}
            </div>
            ${b.vintage ? `<div class="wc-vintage">${escapeHTML(String(b.vintage))}</div>` : ''}
            <div class="bottle-actions">
                <button class="btn btn-sm btn-primary" onclick="showEditBottleDialog('${escapeHTML(b.id)}')" title="Edit bottle">${t('bottle.card.edit')}</button>
                <button class="btn btn-sm btn-accent" onclick="valuateSingleBottle('${escapeHTML(b.id)}')" title="Refresh AI valuation">💎</button>
            </div>
        </div>

        <!-- Meta tiles: region · varietal · value or qty -->
        <div class="wc-meta">
            <div class="wc-meta-item">
                <div class="wcm-label">Region</div>
                <div class="wcm-value">${escapeHTML(b.region || b.country || '—')}</div>
            </div>
            <div class="wc-meta-item">
                <div class="wcm-label">Varietal</div>
                <div class="wcm-value wine">${escapeHTML(b.varietal || '—')}</div>
            </div>
            <div class="wc-meta-item">
                <div class="wcm-label">${hasValuation ? t('bottle.card.est_value') : t('bottle.card.bottles')}</div>
                <div class="wcm-value ${metaValueClass}">${hasValuation ? fmt(b.estimatedValue) : `${b.qty || 1}`}</div>
            </div>
        </div>

        ${tags.length > 0 ? `<div class="bottle-tags">${tags.map(tag => `<span class="bottle-tag">${tag}</span>`).join('')}</div>` : ''}

        <div class="bottle-financials">
            ${hasPurchasePrice ? `
            <div class="bottle-fin-row">
                <span>${b.qty} ${b.qty !== 1 ? t('bottle.card.bottles') : t('bottle.card.bottle')} × ${fmt(b.purchasePrice)}</span>
                <span class="bottle-fin-value">${fmt(totalInvested)} ${t('bottle.card.invested')}</span>
            </div>` : `
            <div class="bottle-fin-row">
                <span>${b.qty} ${b.qty !== 1 ? t('bottle.card.bottles') : t('bottle.card.bottle')}</span>
                <span class="bottle-fin-muted">${t('bottle.card.no_price')}</span>
            </div>`}
            ${hasValuation ? `
            <div class="bottle-fin-row">
                <div>
                    <div>${t('bottle.card.est_value')}</div>
                    ${rangeHtml}
                    ${usdHtml}
                </div>
                <span class="bottle-fin-est">${fmt(b.estimatedValue)}/bottle · ${fmt(totalEstimated)}</span>
            </div>
            ${hasPurchasePrice ? `
            <div class="bottle-gain ${gainClass}">
                <span>${t('bottle.card.gain_loss')}</span>
                <span>${gainSign}${fmt(gain)} (${gainSign}${gainPct.toFixed(1)}%)</span>
            </div>` : ''}` : `
            <div class="bottle-fin-row">
                <span class="bottle-fin-muted">${t('bottle.card.no_valuation')}</span>
                <span><button class="btn btn-sm btn-warning" onclick="valuateSingleBottle('${escapeHTML(b.id)}')">${t('bottle.card.get_estimate')}</button></span>
            </div>`}
        </div>

        ${noteHtml}
        ${staleHtml}

        <!-- Footer: drink window + confidence + dated -->
        <div class="wc-footer">
            <div>
                ${badge}
                ${hasWindow ? `<div class="drink-window-sub">${t('bottle.card.drink')} ${escapeHTML(b.drinkWindow)}</div>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                ${confidenceHtml}
                ${b.lastValuedAt
                    ? `<span class="valued-at">${t('bottle.card.valued')} ${timeAgo(b.lastValuedAt)}</span>`
                    : (b.purchaseDate ? `<span class="valued-at">${t('bottle.card.bought')} ${fmtDate(b.purchaseDate)}</span>` : '')}
            </div>
        </div>

        ${b.notes ? `<div class="bottle-notes">${escapeHTML(b.notes)}</div>` : ''}
    </div>`;
}

function updateStatsBar(totals) {
    const gain = totals.totalEstimated - totals.totalInvested;
    const gainPct = totals.totalInvested > 0 ? (gain / totals.totalInvested) * 100 : 0;
    const gainSign = gain >= 0 ? '+' : '';
    const gainColor = gain > 0 ? '#4CAF84' : gain < 0 ? '#E05A5A' : '#7A8099';

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

    document.getElementById('bottleDialogTitle').textContent = t('bottle.add_title');
    document.getElementById('bottleDialogSubmit').textContent = t('bottle.btn.add');
    const deleteBtn = document.getElementById('bottleDeleteBtn');
    if (deleteBtn) deleteBtn.style.display = 'none';

    setField('bottleName',          prefilled.name || '');
    setField('bottleWinery',        prefilled.winery || '');
    setField('bottleType',          prefilled.type || '');
    setField('bottleVintage',       prefilled.vintage || '');
    setField('bottleVarietal',      prefilled.varietal || '');
    setField('bottleRegion',        prefilled.region || '');
    setField('bottleAppellation',   prefilled.appellation || '');
    setField('bottleCountry',       prefilled.country || '');
    setField('bottleAlcohol',       prefilled.alcohol || '');
    setField('bottleSize',          prefilled.bottleSize || '0.75L');
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
    document.getElementById('bottleDialogTitle').textContent = t('dialog.edit_bottle');
    document.getElementById('bottleDialogSubmit').textContent = t('dialog.save');
    const deleteBtn = document.getElementById('bottleDeleteBtn');
    if (deleteBtn) deleteBtn.style.display = 'inline-flex';

    setField('bottleName',          bottle.name || '');
    setField('bottleWinery',        bottle.winery || '');
    setField('bottleType',          bottle.type || '');
    setField('bottleVintage',       bottle.vintage || '');
    setField('bottleVarietal',      bottle.varietal || '');
    setField('bottleRegion',        bottle.region || '');
    setField('bottleAppellation',   bottle.appellation || '');
    setField('bottleCountry',       bottle.country || '');
    setField('bottleAlcohol',       bottle.alcohol || '');
    setField('bottleSize',          bottle.bottleSize || '0.75L');
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
    submitBtn.textContent = t('dialog.saving');

    const isEdit = !!state.editingBottleId;
    const existingBottle = isEdit ? state.cellar.find(b => b.id === state.editingBottleId) : null;

    const bottleData = {
        id:            state.editingBottleId || undefined,
        wineId:        existingBottle?.wineId          ?? null,
        name,
        winery:        getField('bottleWinery').trim() || null,
        type:          getField('bottleType') || null,
        vintage:       parseInt(getField('bottleVintage'), 10) || null,
        varietal:      getField('bottleVarietal').trim() || null,
        region:        getField('bottleRegion').trim() || null,
        appellation:   getField('bottleAppellation').trim() || null,
        country:       getField('bottleCountry').trim() || null,
        alcohol:       getField('bottleAlcohol').trim() || null,
        bottleSize:    getField('bottleSize') || '0.75L',
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

    // ── Duplicate check for new bottles only ─────────────────────────────────
    let mergeTargetIds = []; // IDs of all existing holdings being merged

    if (!isEdit) {
        const existingHoldings = await findExistingUserWineHoldings(
            bottleData.name, bottleData.winery, bottleData.vintage
        );

        if (existingHoldings.length > 0) {
            const choice = await showMergeDialog(existingHoldings, bottleData);

            if (choice === 'cancel') {
                submitBtn.disabled = false;
                submitBtn.textContent = t('bottle.btn.add');
                return;
            }

            if (choice === 'merge') {
                // Merge all existing holdings + new bottle into the primary (oldest) row
                const primary = existingHoldings[0];
                mergeTargetIds = existingHoldings.map(h => h.id);

                // Sum quantities
                const existingQty = existingHoldings.reduce((sum, h) => sum + (h.qty || 0), 0);
                bottleData.id     = primary.id;
                bottleData.wineId = primary.wine_id;
                bottleData.qty    = existingQty + qty;

                // Weighted average purchase price
                const allRows = [
                    ...existingHoldings.map(h => ({ qty: h.qty, price: h.purchase_price })),
                    { qty, price: purchasePrice },
                ];
                const withPrice = allRows.filter(r => r.price != null && r.price > 0);
                if (withPrice.length > 0) {
                    const totalCost = withPrice.reduce((s, r) => s + (r.qty || 0) * r.price, 0);
                    const totalQtyP = withPrice.reduce((s, r) => s + (r.qty || 0), 0);
                    bottleData.purchasePrice = totalQtyP > 0 ? totalCost / totalQtyP : null;
                }

                // Best valuation: most recently valued existing row
                const withVal = [...existingHoldings]
                    .filter(h => h.last_valued_at)
                    .sort((a, b) => new Date(b.last_valued_at) - new Date(a.last_valued_at));
                if (withVal.length > 0) {
                    const bv = withVal[0];
                    bottleData.estimatedValue    ??= bv.estimated_value;
                    bottleData.estimatedValueUSD ??= bv.estimated_value_usd;
                    bottleData.valueLow          ??= bv.value_low;
                    bottleData.valueHigh         ??= bv.value_high;
                    bottleData.confidence        ??= bv.confidence;
                    bottleData.valuationNote     ??= bv.valuation_note;
                    bottleData.valuationSources  ??= bv.valuation_sources;
                    bottleData.lastValuedAt      ??= bv.last_valued_at;
                }
            }
            // 'separate' → fall through and insert normally
        }
    }

    try {
        const savedId = await saveBottleToDB(bottleData);
        bottleData.id = savedId || bottleData.id || ('local-' + Date.now());

        if (isEdit) {
            const idx = state.cellar.findIndex(b => b.id === state.editingBottleId);
            if (idx >= 0) state.cellar[idx] = bottleData;
        } else if (mergeTargetIds.length > 0) {
            // Delete any secondary duplicate holdings from DB (all except primary)
            const secondaryIds = mergeTargetIds.slice(1);
            for (const sid of secondaryIds) {
                await state.supabaseClient
                    .from('user_wines')
                    .delete()
                    .eq('id', sid)
                    .eq('user_id', state.currentUser.id);
            }
            // Replace all merged entries in-memory with the unified bottle
            state.cellar = state.cellar.filter(b => !mergeTargetIds.includes(b.id));
            state.cellar.push(bottleData);
        } else {
            state.cellar.push(bottleData);
        }

        closeBottleDialog();
        renderCellar();
        showToast(
            isEdit          ? t('dialog.updated') :
            mergeTargetIds.length > 0 ? 'Bottles merged successfully.' :
                                        t('dialog.added')
        );
    } catch (err) {
        showToast('Failed to save bottle: ' + err.message, 'error');
        console.error(err);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = isEdit ? t('dialog.save') : t('bottle.btn.add');
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
        'Name', 'Winery', 'Type', 'Vintage', 'Region', 'Appellation', 'Varietal',
        'Country', 'Alcohol', 'Bottle Size', 'Qty', 'Purchase Price (€)', 'Purchase Date',
        'Storage', 'Est. Value (€)', 'Drink Window', 'Notes'
    ];

    const csvVal = v => {
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s;
    };

    const rows = state.cellar.map(b => [
        b.name, b.winery, b.type, b.vintage, b.region, b.appellation, b.varietal,
        b.country, b.alcohol, b.bottleSize || '0.75L', b.qty, b.purchasePrice, b.purchaseDate,
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
            ? `<span class="gain-up">+${fmt(gain)} (+${gainPct}%)</span>`
            : `<span class="gain-down">${fmt(gain)} (${gainPct}%)</span>`;
        const deleteBtn = s.id
            ? `<button class="btn btn-sm btn-danger" onclick="deleteSnapshot('${escapeHTML(String(s.id))}')">✕</button>`
            : '';
        return `
        <div class="history-log-item">
            <span>${new Date(s.timestamp).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span>${s.bottleCount} bottles</span>
            <span>${gainStr}</span>
            <span class="history-snap-value">${fmt(s.totalEstimatedValue)}</span>
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

// ── Fix Existing Duplicates ───────────────────────────────────────────────────

/**
 * Scan the cellar for duplicate holdings (same wine, multiple user_wines rows),
 * merge them in the DB, and refresh the in-memory state.
 */
export async function deduplicateCellar() {
    if (!requireAuth('fix duplicates')) return;

    showToast('Scanning for duplicates…', 'info', 3000);

    try {
        const { winesFixed, bottlesMerged } = await findAndMergeDuplicates();

        if (winesFixed === 0) {
            showToast('No duplicates found — your cellar is clean!', 'success');
            return;
        }

        // Reload cellar from DB so in-memory state reflects merged rows
        const { loadFromDatabase } = await import('./storage.js');
        await loadFromDatabase();

        renderCellar();
        showToast(
            `Fixed ${winesFixed} duplicate wine${winesFixed !== 1 ? 's' : ''} `
            + `(${bottlesMerged} extra entr${bottlesMerged !== 1 ? 'ies' : 'y'} merged).`,
            'success',
            6000
        );
    } catch (err) {
        showToast('Failed to fix duplicates: ' + err.message, 'error');
        console.error(err);
    }
}

// ── AI Type Classification (backfill) ─────────────────────────────────────────

const VALID_TYPES = [
    'Red Wine', 'White Wine', 'Rosé', 'Sparkling', 'Port',
    'Dessert Wine', 'Fortified Wine', 'Cognac', 'Whiskey',
    'Aguardente', 'Gin', 'Other',
];

/**
 * Classify all bottles that have no type using AI.
 * Sends a batch prompt with wine details and parses the JSON response.
 */
export async function classifyUntypedBottles() {
    if (!requireAuth('classify wines')) return;

    const untyped = state.cellar.filter(b => !b.type);
    if (untyped.length === 0) {
        showToast('All bottles already have a type assigned.', 'info');
        return;
    }

    const btn = document.getElementById('classifyTypesBtn');
    if (btn) { btn.disabled = true; btn.textContent = `🏷️ Classifying ${untyped.length} bottles…`; }

    try {
        // Build a compact list for the AI
        const wineList = untyped.map((b, i) => {
            const parts = [
                b.name,
                b.winery && `by ${b.winery}`,
                b.vintage && `(${b.vintage})`,
                b.varietal && `[${b.varietal}]`,
                b.region && `from ${b.region}`,
                b.country && `(${b.country})`,
            ].filter(Boolean).join(' ');
            return `${i}: ${parts}`;
        }).join('\n');

        const prompt = `Classify each wine/spirit below into exactly one type.

Valid types: ${VALID_TYPES.join(', ')}

Wines to classify:
${wineList}

Return ONLY a valid JSON array of objects: [{"index": 0, "type": "Red Wine"}, ...]
One entry per wine. Use the index from the list above. Return ONLY the JSON array, no markdown fences, no explanation.`;

        const data = await callWineAI({ requestType: 'analysis', prompt, maxTokens: 2048 });

        // Extract text from response — handle both Claude and Gemini response shapes
        let text = '';
        if (data.content && Array.isArray(data.content)) {
            text = data.content.find(c => c.type === 'text')?.text || '';
        } else if (typeof data.text === 'string') {
            text = data.text;
        } else if (typeof data === 'string') {
            text = data;
        }
        // Strip markdown code fences if present
        text = text.replace(/```json\n?|```/g, '').trim();

        console.log('[ClassifyTypes] AI response:', text.slice(0, 300));

        // Parse the JSON array — try directly first, then attempt truncation repair
        let classifications;
        try {
            classifications = JSON.parse(text);
        } catch {
            const repaired = repairTruncatedJSON(text);
            try {
                classifications = JSON.parse(repaired);
                console.warn('[ClassifyTypes] JSON was truncated and repaired — response may be incomplete');
            } catch {
                throw new Error('AI did not return a valid JSON array. Raw: ' + text.slice(0, 200));
            }
        }
        if (!Array.isArray(classifications)) {
            throw new Error('AI did not return a valid JSON array. Raw: ' + text.slice(0, 200));
        }
        let updated = 0;

        for (const entry of classifications) {
            const idx = entry.index;
            const type = entry.type;
            if (idx == null || !type) continue;
            if (!VALID_TYPES.includes(type)) continue;

            const bottle = untyped[idx];
            if (!bottle) continue;

            bottle.type = type;
            try {
                await saveBottleToDB(bottle);
                updated++;
            } catch (err) {
                console.warn(`Failed to save type for "${bottle.name}":`, err.message);
            }
        }

        renderCellar();
        showToast(
            `Classified ${updated} of ${untyped.length} bottle${untyped.length !== 1 ? 's' : ''}.`,
            updated > 0 ? 'success' : 'warning',
            5000
        );
    } catch (err) {
        console.error('classifyUntypedBottles error:', err);
        showToast('Type classification failed: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🏷️ Classify Types'; }
    }
}

/**
 * Re-classify ALL bottles (including already-typed ones) using AI.
 * Useful after adding new type categories to pick up mis-classified bottles.
 */
export async function reclassifyAllBottles() {
    if (!requireAuth('reclassify wines')) return;

    const bottles = state.cellar;
    if (bottles.length === 0) {
        showToast('No bottles in cellar to classify.', 'info');
        return;
    }

    const btn = document.getElementById('reclassifyAllBtn');
    if (btn) { btn.disabled = true; btn.textContent = `🔄 Reclassifying ${bottles.length} bottles…`; }

    try {
        const wineList = bottles.map((b, i) => {
            const parts = [
                b.name,
                b.winery && `by ${b.winery}`,
                b.vintage && `(${b.vintage})`,
                b.varietal && `[${b.varietal}]`,
                b.region && `from ${b.region}`,
                b.country && `(${b.country})`,
            ].filter(Boolean).join(' ');
            return `${i}: ${parts}`;
        }).join('\n');

        const prompt = `Classify each wine/spirit below into exactly one type.

Valid types: ${VALID_TYPES.join(', ')}

Wines to classify:
${wineList}

Return ONLY a valid JSON array of objects: [{"index": 0, "type": "Red Wine"}, ...]
One entry per wine. Use the index from the list above. Return ONLY the JSON array, no markdown fences, no explanation.`;

        const data = await callWineAI({ requestType: 'analysis', prompt, maxTokens: 4096 });

        let text = '';
        if (data.content && Array.isArray(data.content)) {
            text = data.content.find(c => c.type === 'text')?.text || '';
        } else if (typeof data.text === 'string') {
            text = data.text;
        } else if (typeof data === 'string') {
            text = data;
        }
        text = text.replace(/```json\n?|```/g, '').trim();

        console.log('[ReclassifyAll] AI response:', text.slice(0, 300));

        let classifications;
        try {
            classifications = JSON.parse(text);
        } catch {
            const repaired = repairTruncatedJSON(text);
            try {
                classifications = JSON.parse(repaired);
                console.warn('[ReclassifyAll] JSON was truncated and repaired');
            } catch {
                throw new Error('AI did not return a valid JSON array. Raw: ' + text.slice(0, 200));
            }
        }
        if (!Array.isArray(classifications)) {
            throw new Error('AI did not return a valid JSON array. Raw: ' + text.slice(0, 200));
        }

        let updated = 0;
        for (const entry of classifications) {
            const idx = entry.index;
            const type = entry.type;
            if (idx == null || !type) continue;
            if (!VALID_TYPES.includes(type)) continue;

            const bottle = bottles[idx];
            if (!bottle) continue;
            if (bottle.type === type) continue; // no change needed

            bottle.type = type;
            try {
                await saveBottleToDB(bottle);
                updated++;
            } catch (err) {
                console.warn(`Failed to save type for "${bottle.name}":`, err.message);
            }
        }

        renderCellar();
        showToast(
            `Reclassified ${updated} of ${bottles.length} bottle${bottles.length !== 1 ? 's' : ''}.`,
            updated > 0 ? 'success' : 'info',
            5000
        );
    } catch (err) {
        console.error('reclassifyAllBottles error:', err);
        showToast('Reclassification failed: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Reclassify All'; }
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

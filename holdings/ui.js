/**
 * holdings/ui.js — rendering and interaction for Bank Holdings.
 *
 * The whole module exists to make ~€157k of bonds and funds visible without
 * lying about where the numbers come from. Every value here was typed by a
 * human or copied off a statement, so every surface that shows one also shows
 * how old it is and where it came from. That is the feature, not decoration.
 */

import state from './state.js?v=3.37.0';
import {
    escapeHTML, fmtMoney, fmtPct, showToast, showConfirm,
    openModal, closeModal, typeColour
} from './utils.js?v=3.37.0';
import { saveHolding, deleteHolding, requireAuth } from './storage.js?v=3.37.0';
import {
    summarizeHoldings, holdingGain, valuationFreshness, maturityStatus, HOLDING_TYPES
} from '../services/holdings-core.js?v=3.37.0';

const el = id => document.getElementById(id);
const todayISO = () => new Date().toISOString().slice(0, 10);

const TYPE_LABELS = {
    bond: 'Bond', fund: 'Fund', deposit: 'Deposit',
    structured: 'Structured product', other: 'Other'
};

export function renderAll() {
    renderSummary();
    renderList();
}

// ── summary ─────────────────────────────────────────────────────────────────

export function renderSummary() {
    const host = el('holdingsSummary');
    if (!host) return;

    const s = summarizeHoldings(state.holdings, { today: todayISO() });
    state.summary = s;

    if (!s.count) {
        host.innerHTML = `
            <div class="empty-state">
                Nothing recorded yet. Add the bonds, funds and deposits your banks hold —
                the value goes straight into your net worth on the hub.
            </div>`;
        return;
    }

    // A gain drawn from part of the portfolio must never look like it speaks
    // for all of it, so the coverage is stated whenever it is not the whole.
    const partial = s.gain && s.costCoverage < 0.999;

    host.innerHTML = `
        <div class="overview-hero">
            <div class="hero-figure">
                <span class="hero-figure-label">Total value</span>
                <span class="hero-figure-value hold">${escapeHTML(fmtMoney(s.total))}</span>
                <span class="hero-figure-sub">${s.count} holding${s.count === 1 ? '' : 's'}</span>
            </div>
            <div class="hero-figure">
                <span class="hero-figure-label">Gain vs cost</span>
                <span class="hero-figure-value">${s.gain ? escapeHTML(fmtMoney(s.gain.absolute)) : '—'}</span>
                <span class="hero-figure-sub">
                    ${s.gain
                        ? `${escapeHTML(fmtPct(s.gain.pct, { signed: true }))}${partial
                            ? ` · on the ${Math.round(s.costCoverage * 100)}% with a recorded cost` : ''}`
                        : 'no purchase cost recorded'}
                </span>
            </div>
            <div class="hero-figure">
                <span class="hero-figure-label">Oldest valuation</span>
                <span class="hero-figure-value">${escapeHTML(s.oldestValuation.days ?? '—')}<span style="font-size:14px;color:var(--text-secondary)">${s.oldestValuation.days === null ? '' : ' days'}</span></span>
                <span class="hero-figure-sub">
                    <span class="val-badge ${s.oldestValuation.level}">${escapeHTML(s.oldestValuation.label)}</span>
                </span>
            </div>
        </div>
        <div class="hold-disclaimer">
            These values are copied from bank statements or entered by hand — they are not live prices.
            The hub shows this total with the age of its oldest valuation.
        </div>
        ${s.byType.length > 1 ? `
            <div class="hold-split">
                ${s.byType.map(t => `
                    <span class="hold-split-item">
                        <span class="hold-dot" style="background:${typeColour(t.type)}"></span>
                        ${escapeHTML(TYPE_LABELS[t.type] || t.type)} ${escapeHTML(fmtMoney(t.value))}
                    </span>`).join('')}
            </div>` : ''}`;
}

// ── list ────────────────────────────────────────────────────────────────────

export function renderList() {
    const host = el('holdingsList');
    if (!host) return;

    const visible = state.holdings
        .filter(h => state.showArchived || !h.archived)
        .filter(h => !state.typeFilter || h.holdingType === state.typeFilter);

    renderFilters();

    if (!visible.length) {
        host.innerHTML = state.holdings.length
            ? `<div class="empty-state">Nothing matches that filter.</div>`
            : '';
        return;
    }

    host.innerHTML = visible.map(h => {
        const gain = holdingGain(h);
        const fresh = valuationFreshness(h.valuedAsOf, todayISO());
        const mat = maturityStatus(h, todayISO());
        const qty = h.units ? `${h.units.toLocaleString('pt-PT')} units`
                  : h.nominal ? `${fmtMoney(h.nominal, h.currency)} nominal` : '';
        return `
        <button type="button" class="hold-card ${h.archived ? 'archived' : ''}"
                aria-label="${escapeHTML(`Edit ${h.name}, ${fmtMoney(h.currentValue, h.currency)}, ${fresh.label}`)}"
                data-act="edit" data-id="${escapeHTML(h.id)}">
            <span class="hold-dot" style="background:${typeColour(h.holdingType)}"></span>
            <span class="hold-body">
                <span class="hold-name">${escapeHTML(h.name)}</span>
                <span class="hold-meta">
                    ${escapeHTML(h.bankName)} · ${escapeHTML(TYPE_LABELS[h.holdingType] || h.holdingType)}
                    ${qty ? ` · ${escapeHTML(qty)}` : ''}
                    ${h.isin ? ` · ${escapeHTML(h.isin)}` : ''}
                </span>
                <span class="hold-badges">
                    <span class="val-badge ${fresh.level}">${escapeHTML(fresh.label)}</span>
                    <span class="val-badge source">${h.valuationSource === 'statement' ? 'from statement' : 'manual valuation'}</span>
                    ${mat ? `<span class="val-badge ${mat.level}">${escapeHTML(mat.label)}</span>` : ''}
                    ${h.archived ? '<span class="val-badge">archived</span>' : ''}
                </span>
            </span>
            <span class="hold-figures">
                <span class="hold-value">${escapeHTML(fmtMoney(h.currentValue, h.currency))}</span>
                ${gain ? `<span class="st-delta ${gain.absolute >= 0 ? 'up' : 'down'}">${escapeHTML(fmtPct(gain.pct, { signed: true }))}</span>`
                       : '<span class="hold-nocost">no cost recorded</span>'}
            </span>
        </button>`;
    }).join('');
}

function renderFilters() {
    const host = el('holdingsFilters');
    if (!host) return;
    const present = [...new Set(state.holdings.map(h => h.holdingType))];
    if (!present.length) { host.innerHTML = ''; return; }
    host.innerHTML = `
        <button class="chip-filter ${!state.typeFilter ? 'active-hold' : ''}" data-act="filter">All</button>
        ${present.map(t => `
            <button class="chip-filter ${state.typeFilter === t ? 'active-hold' : ''}"
                    data-act="filter" data-type="${escapeHTML(t)}">${escapeHTML(TYPE_LABELS[t] || t)}</button>`).join('')}
        ${state.holdings.some(h => h.archived) ? `
            <button class="chip-filter ${state.showArchived ? 'active-hold' : ''}"
                    data-act="archived">Show archived</button>` : ''}`;
}

export function setFilter(type) { state.typeFilter = type; renderList(); }
export function toggleArchived() { state.showArchived = !state.showArchived; renderList(); }

// ── event delegation ────────────────────────────────────────────────────────

/**
 * One delegated listener for the controls this module renders.
 *
 * Values live in `data-` attributes rather than inside `onclick=""`, because an
 * attribute is HTML-decoded before its contents are compiled as JavaScript —
 * so escaping does not make that position safe. See the same note in
 * spend/ledger.js.
 */
let delegationBound = false;

export function bindDelegation(root = document) {
    if (delegationBound) return;
    delegationBound = true;
    root.addEventListener('click', (event) => {
        const el = event.target.closest('[data-act]');
        if (!el) return;
        const d = el.dataset;
        if (d.act === 'edit') showDialog(d.id);
        else if (d.act === 'filter') setFilter('type' in d ? d.type : null);
        else if (d.act === 'archived') toggleArchived();
    });
}

// ── form ────────────────────────────────────────────────────────────────────

export function showDialog(id = null) {
    if (!requireAuth('add a holding')) return;
    state.editingId = id;
    const h = id ? state.holdings.find(x => x.id === id) : null;

    el('holdDialogTitle').textContent = h ? 'Edit holding' : 'Add holding';
    el('holdDialogBody').innerHTML = `
        <div class="form-group">
            <label class="form-label" for="hName">Name</label>
            <input class="form-input" id="hName" placeholder="BK 25 PPR OICVM/A" value="${escapeHTML(h?.name || '')}">
        </div>
        <div class="form-group">
            <label class="form-label" for="hBank">Bank</label>
            <input class="form-input" id="hBank" placeholder="Bankinter" value="${escapeHTML(h?.bankName || '')}"
                   list="hBankList">
            <datalist id="hBankList">
                ${[...new Set(state.holdings.map(x => x.bankName))].map(b => `<option value="${escapeHTML(b)}">`).join('')}
            </datalist>
        </div>
        <div class="form-group">
            <label class="form-label" for="hType">Type</label>
            <select class="form-select" id="hType" onchange="holdOnTypeChange()">
                ${HOLDING_TYPES.map(t => `<option value="${t}" ${h?.holdingType === t ? 'selected' : ''}>${escapeHTML(TYPE_LABELS[t])}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label class="form-label" for="hValue">Current value</label>
            <input class="form-input" id="hValue" type="number" step="0.01" inputmode="decimal"
                   placeholder="59396.36" value="${h?.currentValue ?? ''}">
            <span class="form-helper">Whatever your statement says the holding is worth.</span>
        </div>
        <div class="form-group">
            <label class="form-label" for="hValuedAsOf">Valued as of</label>
            <input class="form-input" id="hValuedAsOf" type="date" value="${escapeHTML(h?.valuedAsOf || todayISO())}">
            <span class="form-helper">The statement date — not today, unless you are reading today's statement.</span>
        </div>
        <div class="form-group">
            <label class="form-label" for="hCost">Purchase cost <span style="color:var(--text-secondary)">(optional)</span></label>
            <input class="form-input" id="hCost" type="number" step="0.01" inputmode="decimal" value="${h?.costBasis ?? ''}">
            <span class="form-helper">Leave blank if you don't know it — a gain won't be shown rather than being guessed.</span>
        </div>
        <div class="form-group" id="hQtyGroup">
            <label class="form-label" for="hQty"><span id="hQtyLabel">Units</span> <span style="color:var(--text-secondary)">(optional)</span></label>
            <input class="form-input" id="hQty" type="number" step="0.0001" inputmode="decimal"
                   value="${h?.units ?? h?.nominal ?? ''}">
        </div>
        <div class="form-group">
            <label class="form-label" for="hIsin">ISIN <span style="color:var(--text-secondary)">(optional)</span></label>
            <input class="form-input" id="hIsin" placeholder="PTBIC0AM0008" value="${escapeHTML(h?.isin || '')}">
        </div>
        <div class="form-group" id="hMaturityGroup">
            <label class="form-label" for="hMaturity">Maturity <span style="color:var(--text-secondary)">(optional)</span></label>
            <input class="form-input" id="hMaturity" type="date" value="${escapeHTML(h?.maturityDate || '')}">
        </div>
        <div class="form-group">
            <label class="form-label" for="hNote">Note <span style="color:var(--text-secondary)">(optional)</span></label>
            <input class="form-input" id="hNote" value="${escapeHTML(h?.note || '')}">
        </div>
        ${h ? `
            <label class="form-helper" style="display:flex;align-items:center;gap:6px;margin-top:4px">
                <input type="checkbox" id="hArchived" ${h.archived ? 'checked' : ''}>
                Archived — keep the record but exclude it from totals
            </label>
            <button class="btn btn-sm btn-danger" style="margin-top:10px" onclick="holdDelete()">Delete holding</button>` : ''}`;
    openModal('holdDialog');
    onTypeChange();
}

/** Bonds are held in nominal, funds in units, and only bonds mature. */
export function onTypeChange() {
    const type = el('hType')?.value;
    const label = el('hQtyLabel');
    if (label) label.textContent = type === 'bond' ? 'Nominal / face value' : 'Units';
    const mat = el('hMaturityGroup');
    if (mat) mat.style.display = type === 'bond' ? 'block' : 'none';
}

export async function submit() {
    const name = el('hName').value.trim();
    const bankName = el('hBank').value.trim();
    const value = parseFloat(el('hValue').value);
    const valuedAsOf = el('hValuedAsOf').value;

    if (!name || !bankName) { showToast('Name and bank are both required.', 'warning'); return; }
    if (!Number.isFinite(value)) { showToast('Enter the current value.', 'warning'); return; }
    if (!valuedAsOf) { showToast('Enter the date this value is from.', 'warning'); return; }
    if (valuedAsOf > todayISO()) { showToast('The valuation date is in the future.', 'warning'); return; }

    const type = el('hType').value;
    const qty = parseFloat(el('hQty').value);
    const cost = parseFloat(el('hCost').value);
    const existing = state.editingId ? state.holdings.find(h => h.id === state.editingId) : null;

    const holding = {
        ...(state.editingId ? { id: state.editingId } : {}),
        name, bankName, holdingType: type,
        currentValue: value,
        valuedAsOf,
        // Editing a statement-sourced row by hand makes it manual again — the
        // provenance label has to follow the edit, or it becomes a lie.
        valuationSource: (existing && existing.currentValue === value && existing.valuedAsOf === valuedAsOf)
            ? existing.valuationSource : 'manual',
        costBasis: Number.isFinite(cost) ? cost : null,
        units: type === 'bond' ? null : (Number.isFinite(qty) ? qty : null),
        nominal: type === 'bond' ? (Number.isFinite(qty) ? qty : null) : null,
        isin: el('hIsin').value.trim() || null,
        maturityDate: type === 'bond' ? (el('hMaturity')?.value || null) : null,
        note: el('hNote').value.trim() || null,
        archived: !!el('hArchived')?.checked,
        currency: 'EUR'
    };

    try {
        await saveHolding(holding);
        closeModal('holdDialog');
        showToast('Saved.');
        renderAll();
    } catch (err) { showToast('Could not save: ' + err.message, 'error', 7000); }
}

export async function remove() {
    const id = state.editingId;
    if (!id) return;
    const h = state.holdings.find(x => x.id === id);
    if (!await showConfirm(`Delete "${h?.name || 'this holding'}"? Archiving keeps the record but drops it from totals.`,
        { danger: true, confirmLabel: 'Delete' })) return;
    try {
        await deleteHolding(id);
        closeModal('holdDialog');
        showToast('Deleted.');
        renderAll();
    } catch (err) { showToast('Could not delete: ' + err.message, 'error'); }
}

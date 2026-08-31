/**
 * spend/ledger.js — rendering for the Spend module.
 *
 * All the arithmetic lives in services/spend-core.js (pure, unit-tested). This
 * file only turns those numbers into DOM, and turns clicks back into state.
 */

import state from './state.js?v=3.37.0';
import {
    escapeHTML, fmtMoney, fmtCompact, fmtPct, fmtDate, fmtPeriod,
    deltaClass, showToast, showConfirm, openModal, closeModal, accountColour
} from './utils.js?v=3.37.0';
import {
    updateTransaction, deleteTransaction, saveTransactions, saveRule, incomeCategoryNames
} from './storage.js?v=3.37.0';
import {
    periodKey, shiftPeriod, comparePeriods, buildTrendSeries, filterPeriod,
    detectRecurring, detectInternalTransfers, projectScenario
} from '../services/spend-core.js?v=3.37.0';
import { spendFingerprint, ruleFromCorrection } from '../services/import-banks.js?v=3.37.0';

const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * The uncategorised bucket, as a filter value.
 *
 * `state.selectedCategory === null` already means "no filter", so the bucket of
 * rows whose category IS null needs a distinct token — otherwise clicking it
 * toggles the filter off, and the one bucket a user most wants to work through
 * is the only one they cannot isolate.
 *
 * The token is a JS-only Symbol and is never written into the DOM: a string
 * sentinel would have to survive an HTML attribute round-trip, and anything
 * exotic enough to be collision-proof (a NUL byte, say) does not. The bucket is
 * signalled in markup by the PRESENCE of `data-uncategorised` instead, so no
 * sentinel value ever has to be serialised or parsed back.
 */
export const UNCATEGORISED = Symbol('uncategorised');
const currentPeriod = () => state.period || periodKey(todayISO(), state.grain);

function el(id) { return document.getElementById(id); }

/** One comparison result feeds every section, so the page can never disagree with itself. */
function currentComparison() {
    return comparePeriods(state.transactions, {
        grain: state.grain,
        period: currentPeriod(),
        mode: state.compareMode,
        today: todayISO(),
        excludeOneOffs: state.excludeOneOffs,
        incomeCategories: incomeCategoryNames()
    });
}

export function renderAll() {
    const cmp = currentComparison();
    renderPeriodBar(cmp);
    renderOverview(cmp);
    renderCategoryComparison(cmp);
    renderTrends();
    // Detected once and passed down. Previously renderBaseline read a value
    // renderRecurring had just set as a side effect, so reordering these two
    // lines would have silently projected with zero subscriptions.
    const recurring = detectRecurring(state.transactions, { today: todayISO() });
    state.recurringDetected = recurring;
    renderRecurring(recurring);
    renderBaseline(recurring);
    renderAccounts();
    renderTransactions();
    renderReviewBanner();
    // Called through window rather than imported: importer.js already imports
    // renderAll from here, and a direct import back would be a needless cycle.
    window.spendRenderImport?.();
}

// ── period bar ──────────────────────────────────────────────────────────────

export function renderPeriodBar(cmp = currentComparison()) {
    const host = el('periodBar');
    if (!host) return;

    const grains = [['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];
    const modes = [['previous', 'vs previous'], ['yoy', 'vs last year'], ['none', 'No comparison']];
    const period = currentPeriod();
    const atLatest = period >= periodKey(todayISO(), state.grain);

    host.innerHTML = `
        <div class="period-bar-row">
            <div class="seg-tab-row">
                ${grains.map(([g, label]) => `
                    <button class="seg-tab-item ${state.grain === g ? 'active-spend' : ''}"
                            data-act="grain" data-grain="${g}">${label}</button>`).join('')}
            </div>
            <div class="period-nav">
                <button class="period-step" data-act="step" data-n="-1" aria-label="Previous period">‹</button>
                <span class="period-label">${escapeHTML(fmtPeriod(period, state.grain))}</span>
                <button class="period-step" data-act="step" data-n="1" ${atLatest ? 'disabled' : ''} aria-label="Next period">›</button>
            </div>
        </div>
        <div class="chip-scroll-row">
            ${modes.map(([m, label]) => `
                <button class="chip-filter ${state.compareMode === m ? 'active-spend' : ''}"
                        data-act="compare" data-mode="${m}">${label}</button>`).join('')}
            <button class="chip-filter ${state.excludeOneOffs ? 'active-spend' : ''}"
                    data-act="oneoffs"
                    title="Exclude unusually large one-off charges from both sides">Exclude one-offs</button>
        </div>
        ${coverageNote(cmp)}`;
}

/**
 * Honest absence. A year-on-year delta computed against three imported months
 * is worse than no delta at all, so say what is missing instead of printing a
 * confident wrong number.
 */
function coverageNote(cmp) {
    if (cmp.insufficientData) {
        const need = cmp.mode === 'yoy' ? 'a year of history' : 'an earlier period';
        const have = cmp.coverage.firstDate
            ? `history starts ${fmtDate(cmp.coverage.firstDate)}/${cmp.coverage.firstDate.slice(0, 4)}`
            : 'nothing imported yet';
        return `<div class="coverage-note">No comparison available — needs ${need} (${have}).</div>`;
    }
    if (cmp.partialBaseline) {
        return `<div class="coverage-note">Baseline is only partly covered by imported history — the comparison understates it.</div>`;
    }
    if (cmp.aligned) {
        return `<div class="coverage-note">${cmp.alignLabel} — comparing the first ${cmp.elapsedDays} days of each period, so a part-finished month is not read as a collapse.</div>`;
    }
    return '';
}

// ── overview + stat tiles ───────────────────────────────────────────────────

function deltaChip(delta, { lowerIsBetter = false, money = true, unit = '', pct = null } = {}) {
    if (delta === null || delta === undefined || !Number.isFinite(Number(delta))) return '';
    const n = Number(delta);
    // "0 € (0%)" is noise. Say what it means.
    if (Math.abs(n) < 0.005) return `<span class="st-delta flat">unchanged</span>`;
    const cls = deltaClass(n, lowerIsBetter);
    const sign = n > 0 ? '+' : '';
    const body = money ? `${sign}${fmtCompact(n)}` : `${sign}${n.toFixed(1)}${unit}`;
    const suffix = pct !== null && Number.isFinite(Number(pct)) ? ` (${fmtPct(pct, { signed: true })})` : '';
    return `<span class="st-delta ${cls}">${escapeHTML(body + suffix)}</span>`;
}

export function renderOverview(cmp = currentComparison()) {
    const host = el('spendOverview');
    if (!host) return;

    const { current, delta } = cmp;
    const d = delta || {};
    const rate = current.savingsRate;

    host.innerHTML = `
        <div class="overview-hero">
            <div class="hero-figure">
                <span class="hero-figure-label">Spent</span>
                <span class="hero-figure-value spend">${escapeHTML(fmtMoney(current.spend))}</span>
                <span class="hero-figure-sub">${deltaChip(d.spend, { lowerIsBetter: true, pct: d.spendPct })}</span>
            </div>
            <div class="hero-figure">
                <span class="hero-figure-label">Income</span>
                <span class="hero-figure-value">${escapeHTML(fmtMoney(current.income))}</span>
                <span class="hero-figure-sub">${deltaChip(d.income, { pct: d.incomePct })}</span>
            </div>
            <div class="hero-figure">
                <span class="hero-figure-label">Saved</span>
                <span class="hero-figure-value">${escapeHTML(fmtMoney(current.net))}</span>
                <span class="hero-figure-sub">
                    ${rate === null ? '<span class="st-delta flat">no income recorded</span>'
                        : `${fmtPct(rate)} savings rate ${d.savingsRatePts !== null && d.savingsRatePts !== undefined
                            ? deltaChip(d.savingsRatePts * 100, { money: false, unit: ' pts' }) : ''}`}
                </span>
            </div>
        </div>
        ${renderSparkline()}`;
}

/** Twelve periods of net flow, drawn small. Context, not a chart to read values off. */
function renderSparkline() {
    const series = buildTrendSeries(state.transactions, {
        grain: state.grain, periods: 12, endPeriod: currentPeriod(),
        incomeCategories: incomeCategoryNames()
    });
    const values = series.map(s => s.spend);
    if (!values.some(v => v > 0)) return '';
    const max = Math.max(...values, 1);
    const w = 100, h = 30;
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`).join(' ');
    return `
        <div class="trend-sparkline">
            <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Spending over the last 12 periods">
                <polyline class="trend-line" points="${pts}" vector-effect="non-scaling-stroke" />
            </svg>
        </div>`;
}

// ── category comparison ─────────────────────────────────────────────────────

export function renderCategoryComparison(cmp = currentComparison()) {
    const host = el('categoryBreakdown');
    if (!host) return;

    const rows = cmp.delta ? cmp.delta.byCategory : cmp.current.byCategory.map(c => ({
        category: c.category, current: c.amount, baseline: null, delta: null, deltaPct: null
    }));

    if (!rows.length) {
        host.innerHTML = `<div class="empty-state">No spending in ${escapeHTML(fmtPeriod(currentPeriod(), state.grain))}.</div>`;
        return;
    }

    const max = Math.max(...rows.map(r => Math.max(r.current, r.baseline || 0)), 1);
    const total = cmp.current.spend || 1;

    host.innerHTML = rows.map(r => {
        const name = r.category || 'Uncategorised';
        const token = r.category === null ? UNCATEGORISED : r.category;
        const isSelected = state.selectedCategory === token;
        const dimmed = state.selectedCategory !== null && !isSelected;
        const share = (r.current / total) * 100;
        return `
        <button type="button"
                class="cmp-bar-row ${isSelected ? 'active' : ''} ${dimmed ? 'dimmed' : ''} ${r.category ? '' : 'cmp-bar-uncategorized'}"
                aria-pressed="${isSelected}"
                aria-label="${escapeHTML(`${name}, ${fmtMoney(r.current)}${r.delta !== null ? `, ${r.delta > 0 ? 'up' : 'down'} ${fmtMoney(Math.abs(r.delta))} versus the comparison period` : ''}`)}"
                data-act="category"${r.category === null ? ' data-uncategorised=""' : ` data-category="${escapeHTML(String(r.category))}"`}>
            <span class="cmp-bar-name">${escapeHTML(name)}</span>
            <span class="cmp-bar-figures">
                <span>${escapeHTML(fmtMoney(r.current))}</span>
                ${r.delta !== null ? deltaChip(r.delta, { lowerIsBetter: true }) : `<span class="st-delta flat">${share.toFixed(0)}%</span>`}
            </span>
            <span class="cmp-bar-track">
                <span class="cmp-bar-current" style="width:${(r.current / max) * 100}%"></span>
                ${r.baseline !== null ? `<span class="cmp-bar-baseline" style="width:${(r.baseline / max) * 100}%"></span>` : ''}
            </span>
        </button>`;
    }).join('');
}

// ── trend chart ─────────────────────────────────────────────────────────────

export function renderTrends() {
    const host = el('trendChart');
    if (!host) return;

    const periods = state.grain === 'year' ? 6 : state.grain === 'quarter' ? 12 : 24;
    // buildTrendSeries reads a null category as "no slice", so the uncategorised
    // bucket cannot be expressed through its option and is pre-filtered instead.
    const uncatOnly = state.selectedCategory === UNCATEGORISED;
    const source = uncatOnly ? state.transactions.filter(t => !t.category) : state.transactions;
    const series = buildTrendSeries(source, {
        grain: state.grain, periods, endPeriod: currentPeriod(),
        category: uncatOnly ? null : state.selectedCategory,
        incomeCategories: incomeCategoryNames()
    });

    const label = el('trendLabel');
    if (label) {
        const name = state.selectedCategory === UNCATEGORISED ? 'Uncategorised' : state.selectedCategory;
        label.textContent = name
            ? `${name} · last ${periods} ${state.grain}s`
            : `All spending · last ${periods} ${state.grain}s`;
    }

    if (!series.some(s => s.spend > 0)) {
        host.innerHTML = `<div class="empty-state">Not enough history yet to draw a trend.</div>`;
        return;
    }

    const max = Math.max(...series.map(s => s.spend), 1);
    const w = 600, h = 150, pad = 18;
    const bw = (w - pad * 2) / series.length;
    const cur = currentPeriod();

    const bars = series.map((s, i) => {
        const bh = (s.spend / max) * (h - pad * 2);
        const x = pad + i * bw;
        const y = h - pad - bh;
        return `<rect class="trend-bar ${s.period === cur ? 'current' : ''}"
                      x="${x + bw * 0.15}" y="${y}" width="${bw * 0.7}" height="${Math.max(bh, 1)}"
                      rx="2"><title>${escapeHTML(fmtPeriod(s.period, state.grain))} — ${escapeHTML(fmtMoney(s.spend))}</title></rect>`;
    }).join('');

    // Label only a few ticks: 24 month labels on a phone is unreadable noise.
    const every = Math.ceil(series.length / 6);
    const ticks = series.map((s, i) => (i % every === 0 || i === series.length - 1)
        ? `<text class="trend-axis" x="${pad + i * bw + bw / 2}" y="${h - 4}" text-anchor="middle">${escapeHTML(fmtPeriod(s.period, state.grain).split(' ')[0])}</text>`
        : '').join('');

    host.innerHTML = `
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Spending trend">
            <text class="trend-axis" x="${pad}" y="${pad - 6}">${escapeHTML(fmtCompact(max))}</text>
            ${bars}${ticks}
        </svg>`;
}

// ── recurring ───────────────────────────────────────────────────────────────

export function renderRecurring(found = detectRecurring(state.transactions, { today: todayISO() })) {
    const host = el('recurringList');
    if (!host) return;

    const summary = el('recurringSummary');
    const monthlyTotal = found.filter(r => !r.likelyEnded).reduce((s, r) => s + r.monthlyEquivalent, 0);
    if (summary) {
        summary.innerHTML = found.length
            ? `${found.length} detected · <strong style="color:var(--spend-light)">${escapeHTML(fmtMoney(monthlyTotal))}/mo</strong> · ${escapeHTML(fmtMoney(monthlyTotal * 12))}/yr`
            : '';
    }

    if (!found.length) {
        host.innerHTML = `<div class="empty-state">No recurring charges detected yet — this needs about three months of history.</div>`;
        return;
    }

    host.innerHTML = found.map(r => `
        <div class="recurring-row">
            <span class="rec-name">${escapeHTML(r.merchant)}</span>
            <span class="rec-amount">${escapeHTML(fmtMoney(r.amount, r.currency))}</span>
            <span class="rec-cadence">
                ${escapeHTML(r.cadenceLabel)} · ${r.occurrences}× · last ${escapeHTML(fmtDate(r.lastSeen))}
                ${r.likelyEnded ? '<span class="rec-ended">· looks cancelled</span>' : ''}
            </span>
            <span class="rec-annual">${escapeHTML(fmtMoney(r.annualEquivalent, r.currency))}/yr</span>
        </div>`).join('');
}

// ── simulator baseline ──────────────────────────────────────────────────────

/**
 * The "if nothing changes" panel — the run rate every what-if is measured
 * against. Built from complete months only, so a half-imported current month
 * cannot drag the averages down and make every projected saving look smaller
 * than it is.
 */
export function renderBaseline(recurring = state.recurringDetected || []) {
    const host = el('simulatorHost');
    if (!host) return;

    const projection = projectScenario(state.transactions, { levers: [], horizonMonths: 12 }, {
        today: todayISO(),
        incomeCategories: incomeCategoryNames(),
        recurring
    });
    const b = projection.baseline;

    if (!b.monthsOfHistory) {
        host.innerHTML = `<div class="empty-state">Needs at least one complete month of history before it can project anything.</div>`;
        return;
    }

    const annual = b.monthlyNet * 12;
    host.innerHTML = `
        <div class="projection-card" style="position:static;margin-top:0">
            <div class="projection-label">If nothing changes</div>
            <div class="projection-value ${annual < 0 ? 'negative' : ''}">${escapeHTML(fmtMoney(annual))}<span style="font-size:14px;color:var(--text-secondary)"> / year</span></div>
            <div class="projection-breakdown">
                <span>${escapeHTML(fmtMoney(b.monthlyIncome))} in</span>
                <span>${escapeHTML(fmtMoney(b.monthlySpend))} out</span>
                <span>${escapeHTML(fmtMoney(b.monthlyNet))} kept per month</span>
                ${b.savingsRate !== null ? `<span>${escapeHTML(fmtPct(b.savingsRate))} savings rate</span>` : ''}
            </div>
            <div class="projection-basis">
                Based on ${b.monthsOfHistory} complete month${b.monthsOfHistory === 1 ? '' : 's'}
                (${escapeHTML(b.periods.map(p => fmtPeriod(p, 'month')).join(', '))})${projection.thin ? ' — thin history, treat as indicative' : ''}.
            </div>
        </div>
        <p class="form-helper" style="margin-top:12px">
            What-if levers land next: cut a category, cancel a subscription, change income —
            and see the effect on this number.
        </p>`;
}

// ── accounts ────────────────────────────────────────────────────────────────

export function renderAccounts() {
    const host = el('accountsList');
    if (!host) return;

    if (!state.accounts.length) {
        host.innerHTML = `<div class="empty-state">No accounts yet. Add one per bank, plus MB WAY as a wallet linked to the account that funds it.</div>`;
        return;
    }

    const counts = new Map();
    for (const t of state.transactions) counts.set(t.accountId, (counts.get(t.accountId) || 0) + 1);

    host.innerHTML = state.accounts.map((a, i) => {
        const linked = a.linkedAccountId && state.accounts.find(x => x.id === a.linkedAccountId);
        return `
        <div class="acct-card">
            <span class="acct-dot" style="background:${a.colour || accountColour(a.id, i)}"></span>
            <span class="acct-body">
                <span class="acct-bank">${escapeHTML(a.bankName)}</span>
                <span class="acct-label">${escapeHTML(a.label)} · ${escapeHTML(a.type)}</span>
                ${linked ? `<span class="acct-linked">funded by ${escapeHTML(linked.bankName)}</span>` : ''}
            </span>
            <span class="acct-count">${counts.get(a.id) || 0}</span>
            <button class="btn btn-sm btn-ghost-spend" data-act="account" data-id="${escapeHTML(a.id)}">Edit</button>
        </div>`;
    }).join('');
}

// ── review banner ───────────────────────────────────────────────────────────

function renderReviewBanner() {
    const host = el('reviewBanner');
    if (!host) return;

    let uncategorised = 0, flagged = 0;
    for (const t of state.transactions) {
        if (!t.category && t.amount < 0) uncategorised++;
        if (t.needsReview) flagged++;
    }
    const pending = state.pendingDetails.length;

    const bits = [];
    if (state.ledgerTruncated) bits.push('older history not loaded — comparisons may understate');
    if (uncategorised) bits.push(`${uncategorised} uncategorised`);
    if (flagged) bits.push(`${flagged} need review`);
    if (pending) bits.push(`${pending} MB WAY rows waiting for a bank line`);

    host.innerHTML = bits.length
        ? `<div class="review-banner"><span>⚠</span><span>${escapeHTML(bits.join(' · '))}</span>
             <button class="btn btn-sm btn-ghost-spend" style="margin-left:auto" data-act="filter" data-filter="review">Show</button></div>`
        : '';
}

// ── transactions ────────────────────────────────────────────────────────────

function visibleTransactions() {
    const inPeriod = filterPeriod(state.transactions, currentPeriod(), state.grain);
    const q = state.txSearch.trim().toLowerCase();

    return inPeriod.filter(t => {
        if (state.accountFilter && t.accountId !== state.accountFilter) return false;
        if (state.selectedCategory === UNCATEGORISED) {
            if (t.category) return false;
        } else if (state.selectedCategory !== undefined && state.selectedCategory !== null
            && t.category !== state.selectedCategory) return false;

        switch (state.txTypeFilter) {
            case 'spend': if (t.amount >= 0 || t.category === 'transfer') return false; break;
            case 'income': if (t.amount <= 0 || t.category === 'transfer') return false; break;
            case 'transfer': if (t.category !== 'transfer' && !t.transferPairId) return false; break;
            case 'review': if (!t.needsReview && t.category) return false; break;
        }
        if (!q) return true;
        return `${t.description} ${t.merchant || ''} ${t.category || ''}`.toLowerCase().includes(q);
    });
}

export function renderTransactions() {
    const host = el('txBody');
    if (!host) return;

    const rows = visibleTransactions();
    const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    if (state.txPage >= pages) state.txPage = pages - 1;
    const page = rows.slice(state.txPage * state.pageSize, (state.txPage + 1) * state.pageSize);

    const count = el('txCount');
    if (count) count.textContent = rows.length ? `${rows.length} transaction${rows.length === 1 ? '' : 's'}` : '';

    if (!rows.length) {
        host.innerHTML = `<tr class="tx-empty-row"><td colspan="5">Nothing here for ${escapeHTML(fmtPeriod(currentPeriod(), state.grain))}.</td></tr>`;
        renderPagination(0, 1);
        return;
    }

    const acctIndex = new Map(state.accounts.map((a, i) => [a.id, a.colour || accountColour(a.id, i)]));
    const acctName = new Map(state.accounts.map(a => [a.id, `${a.bankName} · ${a.label}`]));

    host.innerHTML = page.map(t => {
        const isTransfer = t.category === 'transfer' || !!t.transferPairId;
        const cls = isTransfer ? 'transfer' : t.amount > 0 ? 'in' : 'out';
        return `
        <tr class="tx-row" data-act="tx" data-id="${escapeHTML(t.id)}">
            <td class="tx-date">${escapeHTML(fmtDate(t.date))}</td>
            <td>
                <span class="tx-merchant">
                    <span class="tx-account-dot" style="background:${acctIndex.get(t.accountId) || 'var(--border)'}"
                          title="${escapeHTML(acctName.get(t.accountId) || 'Unknown account')}"></span>
                    <button type="button" class="tx-open"
                            aria-label="${escapeHTML(`Edit ${t.merchant || t.description}, ${fmtMoney(t.amount, t.currency)}, ${fmtDate(t.date)}`)}"
                            data-act="tx" data-id="${escapeHTML(t.id)}">
                        <span class="tx-merchant-text">
                            ${escapeHTML(t.merchant || t.description)}
                            ${t.enrichedFrom ? '<span class="tx-enriched-badge" title="Description improved from MB WAY">◆</span>' : ''}
                            <span class="tx-merchant-sub">${escapeHTML((t.merchant ? t.description : '') || '')}</span>
                        </span>
                    </button>
                </span>
            </td>
            <td class="col-hide-mobile">
                <span class="tx-cat-badge ${t.category ? '' : 'none'}">${escapeHTML(t.category || 'uncategorised')}</span>
            </td>
            <td class="num tx-amount ${cls}">${escapeHTML(fmtMoney(t.amount, t.currency))}</td>
            <td class="num col-hide-mobile">
                <button class="btn btn-sm btn-ghost-spend" data-act="tx" data-id="${escapeHTML(t.id)}">Edit</button>
            </td>
        </tr>`;
    }).join('');

    renderPagination(rows.length, pages);
}

function renderPagination(total, pages) {
    const host = el('txPagination');
    if (!host) return;
    if (pages <= 1) { host.innerHTML = ''; return; }
    const from = state.txPage * state.pageSize + 1;
    const to = Math.min(total, (state.txPage + 1) * state.pageSize);
    host.innerHTML = `
        <button class="period-step" data-act="page" data-n="${state.txPage - 1}" ${state.txPage === 0 ? 'disabled' : ''}>‹</button>
        <span>${from}–${to} of ${total}</span>
        <button class="period-step" data-act="page" data-n="${state.txPage + 1}" ${state.txPage >= pages - 1 ? 'disabled' : ''}>›</button>`;
}

// ── event delegation ────────────────────────────────────────────────────────

/**
 * One delegated listener for every control this module renders.
 *
 * Handlers are attached by `data-act` rather than by inlining values into
 * `onclick=""`. That is a security boundary, not a style preference: an
 * attribute value is HTML-decoded by the parser BEFORE its contents are
 * compiled as JavaScript, so `escapeHTML` does not protect that position — a
 * category named `X'); doSomething(); //` escapes to `X&#x27;);…`, the parser
 * turns the entity back into a quote, and the injected code runs. Values in
 * `data-` attributes are only ever read back as strings via `dataset`, so they
 * can never re-enter a JS parsing context.
 */
let delegationBound = false;

export function bindDelegation(root = document) {
    if (delegationBound) return;
    delegationBound = true;

    root.addEventListener('click', (event) => {
        const el = event.target.closest('[data-act]');
        if (!el) return;
        const d = el.dataset;
        switch (d.act) {
            case 'grain':    setGrain(d.grain); break;
            case 'step':     stepPeriod(Number(d.n)); break;
            case 'compare':  setCompareMode(d.mode); break;
            case 'oneoffs':  toggleOneOffs(); break;
            // A missing data-category means the uncategorised bucket, which is
            // null — distinct from a category literally named "null".
            case 'category':
                selectCategory('uncategorised' in d ? UNCATEGORISED : d.category);
                break;
            case 'account':  showAccountDialogFor(d.id); break;
            case 'tx':       event.stopPropagation(); editTx(d.id); break;
            case 'page':     setPage(Number(d.n)); break;
            case 'filter':   setTxFilter(d.filter); break;
            // Owned by importer.js; routed through window for the same reason
            // renderImportSection is — avoiding a needless import cycle.
            case 'commit-import': window.spendCommitImport?.(); break;
            case 'cancel-import': window.spendCancelImport?.(); break;
            default: break;
        }
    });
}

// accounts.js owns the dialog; go through window to avoid a circular import,
// exactly as renderImportSection does in the other direction.
function showAccountDialogFor(id) { window.spendShowAccountDialog?.(id); }

// ── interactions ────────────────────────────────────────────────────────────

export function setGrain(grain) {
    state.grain = grain;
    state.period = null;   // a grain change invalidates the stored period key
    state.txPage = 0;
    renderAll();
}

export function stepPeriod(n) {
    state.period = shiftPeriod(currentPeriod(), state.grain, n);
    state.txPage = 0;
    renderAll();
}

export function setCompareMode(mode) { state.compareMode = mode; renderAll(); }
export function toggleOneOffs() { state.excludeOneOffs = !state.excludeOneOffs; renderAll(); }

export function selectCategory(category) {
    state.selectedCategory = state.selectedCategory === category ? null : category;
    state.txPage = 0;
    renderAll();
}

export function setTxSearch(value) { state.txSearch = value; state.txPage = 0; renderTransactions(); }
export function setTxFilter(filter) {
    state.txTypeFilter = filter;
    state.txPage = 0;
    document.querySelectorAll('[data-tx-filter]').forEach(b =>
        b.classList.toggle('active-spend', b.dataset.txFilter === filter));
    renderTransactions();
    el('transactionsSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
export function setPage(n) {
    state.txPage = Math.max(0, n);
    renderTransactions();
    el('transactionsSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── edit dialog ─────────────────────────────────────────────────────────────

export function editTx(id) {
    const t = state.transactions.find(x => x.id === id);
    if (!t) return;
    state.editingTxId = id;

    const opts = ['<option value="">Uncategorised</option>',
        ...state.categories.map(c =>
            `<option value="${escapeHTML(c.name)}" ${t.category === c.name ? 'selected' : ''}>${escapeHTML(`${c.icon || ''} ${c.name}`.trim())}</option>`),
        `<option value="transfer" ${t.category === 'transfer' ? 'selected' : ''}>↔ Transfer between my accounts</option>`
    ].join('');

    el('txEditBody').innerHTML = `
        <div class="form-group">
            <label class="form-label">Description</label>
            <input class="form-input" id="txEditDesc" value="${escapeHTML(t.description)}">
            ${t.rawDescription && t.rawDescription !== t.description
                ? `<span class="merge-preview">bank text: ${escapeHTML(t.rawDescription)}</span>` : ''}
        </div>
        <div class="form-group">
            <label class="form-label">Category</label>
            <select class="form-select" id="txEditCat">${opts}</select>
            <span class="form-helper">Correcting this also teaches a rule, so the same merchant files itself next time.</span>
        </div>
        <div class="form-group">
            <label class="form-label">Amount</label>
            <input class="form-input" id="txEditAmount" type="number" step="0.01" value="${t.amount}">
            <span class="form-helper">Negative for money out.</span>
        </div>
        <div class="form-group">
            <label class="form-label">Date</label>
            <input class="form-input" id="txEditDate" type="date" value="${escapeHTML(String(t.date).slice(0, 10))}">
        </div>`;
    openModal('txEditDialog');
}

export async function saveTxEdit() {
    const id = state.editingTxId;
    const t = state.transactions.find(x => x.id === id);
    if (!t) return;

    const category = el('txEditCat').value || null;
    const patch = {
        description: el('txEditDesc').value.trim() || t.description,
        category,
        categorySource: 'manual',
        amount: parseFloat(el('txEditAmount').value),
        date: el('txEditDate').value,
        needsReview: false
    };

    try {
        await updateTransaction(id, patch);

        // A correction is only worth making once. Persist it as a rule so the
        // same merchant categorises itself on the next import.
        if (category && category !== 'transfer' && category !== t.category) {
            const rule = ruleFromCorrection({ ...t, description: patch.description }, category);
            if (rule) {
                try { await saveRule(rule); } catch (e) { console.warn('rule save failed:', e.message); }
            }
        }

        closeModal('txEditDialog');
        showToast('Saved.');
        renderAll();
    } catch (err) {
        showToast('Could not save: ' + err.message, 'error');
    }
}

export async function removeTx() {
    const id = state.editingTxId;
    if (!id) return;
    if (!await showConfirm('Delete this transaction? It will come back on the next import unless the statement changed.', { danger: true, confirmLabel: 'Delete' })) return;
    try {
        await deleteTransaction(id);
        closeModal('txEditDialog');
        showToast('Deleted.');
        renderAll();
    } catch (err) { showToast('Could not delete: ' + err.message, 'error'); }
}

// ── quick add ───────────────────────────────────────────────────────────────

export function showQuickAdd() {
    if (!state.accounts.length) { showToast('Add an account first.', 'warning'); return; }
    el('quickAddDate').value = todayISO();
    el('quickAddAccount').innerHTML = state.accounts
        .map(a => `<option value="${a.id}">${escapeHTML(`${a.bankName} · ${a.label}`)}</option>`).join('');
    el('quickAddCat').innerHTML = ['<option value="">Uncategorised</option>',
        ...state.categories.map(c => `<option value="${escapeHTML(c.name)}">${escapeHTML(`${c.icon || ''} ${c.name}`.trim())}</option>`)
    ].join('');
    openModal('quickAddDialog');
}

export async function submitQuickAdd() {
    const amountRaw = parseFloat(el('quickAddAmount').value);
    const description = el('quickAddDesc').value.trim();
    if (!Number.isFinite(amountRaw) || amountRaw === 0) { showToast('Enter an amount.', 'warning'); return; }
    if (!description) { showToast('Enter a description.', 'warning'); return; }

    const isIncome = el('quickAddIncome').checked;
    const row = {
        accountId: el('quickAddAccount').value,
        date: el('quickAddDate').value || todayISO(),
        description,
        rawDescription: description,
        merchant: description,
        // The form takes a magnitude and a direction toggle: asking a human to
        // remember the sign convention is how cash entries end up backwards.
        amount: isIncome ? Math.abs(amountRaw) : -Math.abs(amountRaw),
        currency: 'EUR',
        category: el('quickAddCat').value || null,
        categorySource: el('quickAddCat').value ? 'manual' : null,
        source: 'manual'
    };
    row.fingerprint = spendFingerprint(row);

    try {
        await saveTransactions([row]);
        closeModal('quickAddDialog');
        el('quickAddAmount').value = '';
        el('quickAddDesc').value = '';
        showToast('Added.');
        renderAll();
    } catch (err) { showToast('Could not add: ' + err.message, 'error'); }
}

// ── transfer detection ──────────────────────────────────────────────────────

/**
 * Pair movements between the user's own accounts and mark both sides.
 * Run explicitly rather than on every render: it rewrites rows, and a
 * background process that silently reclassifies money is not something to
 * spring on someone.
 */
export async function findTransfers() {
    const candidates = state.transactions.filter(t => !t.transferPairId && t.category !== 'transfer');
    const { pairs } = detectInternalTransfers(candidates);
    if (!pairs.length) { showToast('No unmatched transfers found.'); return; }

    const total = pairs.reduce((s, p) => s + p.amount, 0);
    const ok = await showConfirm(
        `Found ${pairs.length} transfer${pairs.length === 1 ? '' : 's'} between your accounts totalling ${fmtMoney(total)}. ` +
        `Marking them excludes both sides from spending and income.`,
        { confirmLabel: 'Mark as transfers' });
    if (!ok) return;

    // Both sides of every pair go in ONE chunked upsert.
    //
    // The previous shape awaited two updates per pair in sequence — 800+ round
    // trips for three years of history. Worse than slow: a failure partway
    // through left one leg marked and the other not, so that outflow stopped
    // counting as spending while its matching inflow still counted as income,
    // silently corrupting the savings rate every projection is built on.
    const byId = new Map(state.transactions.map(t => [t.id, t]));
    const touched = [];
    for (const p of pairs) {
        for (const id of [p.outId, p.inId]) {
            const row = byId.get(id);
            if (!row) continue;
            touched.push({ ...row, category: 'transfer', categorySource: 'manual', transferPairId: p.pairId });
        }
    }

    try {
        await saveTransactions(touched);
        showToast(`${pairs.length} transfer${pairs.length === 1 ? '' : 's'} marked.`);
        renderAll();
    } catch (err) {
        showToast('Could not mark transfers: ' + err.message, 'error');
        renderAll();   // resync the view with whatever actually persisted
    }
}

export { currentComparison, currentPeriod, visibleTransactions };

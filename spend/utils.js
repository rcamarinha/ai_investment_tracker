/**
 * Shared utilities for the Spend module.
 *
 * Deliberately self-contained: importing wine/utils.js would couple two modules
 * that are meant to be independently extractable.
 */

export function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// ── formatting ──────────────────────────────────────────────────────────────

export function fmtMoney(value, currency = 'EUR', opts = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return new Intl.NumberFormat('pt-PT', {
        style: 'currency', currency,
        minimumFractionDigits: opts.decimals ?? 2,
        maximumFractionDigits: opts.decimals ?? 2
    }).format(n);
}

const CURRENCY_SYMBOLS = { EUR: '\u20ac', USD: '$', GBP: '\u00a3', CHF: 'CHF ' };

/**
 * Compact form for stat tiles and delta chips, where €1.2k reads better than
 * €1,234.56.
 *
 * Built by hand rather than with Intl's `notation: 'compact'`, which localises
 * the magnitude WORD: under pt-PT, 16000 becomes "16 mil €", which is wrong in
 * the English UI and inconsistent between the two languages. k/M are read the
 * same way in both.
 */
export function fmtCompact(value, currency = 'EUR') {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
    const abs = Math.abs(n);
    if (abs < 10000) return fmtMoney(n, currency, { decimals: 0 });
    const sign = n < 0 ? '-' : '';
    // Trailing symbol and comma decimal, to match fmtMoney's pt-PT output —
    // "€16.0k" next to "1 234,50 €" on the same card reads as a bug.
    const mag = abs < 1000000
        ? `${(abs / 1000).toFixed(abs < 100000 ? 1 : 0)}k`
        : `${(abs / 1000000).toFixed(1)}M`;
    return `${sign}${mag.replace('.', ',')} ${symbol}`.trim();
}

export function fmtPct(value, { signed = false, points = false } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const pct = n * 100;
    const sign = signed && pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(pct % 1 === 0 ? 0 : 1)}${points ? ' pts' : '%'}`;
}

export function fmtDate(iso) {
    const s = String(iso || '').slice(0, 10);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}` : s;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtPeriod(key, grain = 'month') {
    if (!key) return '—';
    if (grain === 'year') return key;
    if (grain === 'quarter') {
        const [y, q] = String(key).split('-Q');
        return `Q${q} ${y}`;
    }
    const [y, m] = String(key).split('-');
    return `${MONTHS[+m - 1] || m} ${y}`;
}

/**
 * Direction class for a delta, from the reader's point of view rather than the
 * number's sign: spending less is good, earning less is not. Callers pass
 * `lowerIsBetter` for spend-like figures.
 */
export function deltaClass(delta, lowerIsBetter = false) {
    if (!Number.isFinite(Number(delta)) || Number(delta) === 0) return 'flat';
    const good = lowerIsBetter ? Number(delta) < 0 : Number(delta) > 0;
    return good ? 'up' : 'down';
}

// ── toasts ──────────────────────────────────────────────────────────────────

export function showToast(message, type = 'success', duration = 4000) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-msg">${escapeHTML(message)}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    const dismiss = () => {
        toast.classList.remove('toast-visible');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    };
    const timer = setTimeout(dismiss, duration);
    toast.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

// ── modals ──────────────────────────────────────────────────────────────────

export function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = 'flex';
    el.dataset.activeModal = 'true';
    const first = el.querySelector('input:not([type=hidden]), textarea, select, button');
    if (first) setTimeout(() => first.focus(), 50);
}

export function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = 'none';
    delete el.dataset.activeModal;
}

export function closeActiveModal() {
    const active = document.querySelector('[data-active-modal="true"]');
    if (active) closeModal(active.id);
}

export function showConfirm(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.style.cssText = 'display:flex;z-index:10001;';
        overlay.innerHTML = `
            <div class="confirm-dialog" style="max-width:420px;">
                <p style="margin-bottom:20px;font-size:14px;color:var(--text-primary);">${escapeHTML(message)}</p>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button id="_cfCancel" class="btn btn-secondary">${escapeHTML(cancelLabel)}</button>
                    <button id="_cfOk" class="btn ${danger ? 'btn-danger' : 'btn-success'}">${escapeHTML(confirmLabel)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const cleanup = r => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(r); };
        const onKey = e => {
            if (e.key === 'Enter') cleanup(true);
            if (e.key === 'Escape') cleanup(false);
        };
        overlay.querySelector('#_cfOk').addEventListener('click', () => cleanup(true));
        overlay.querySelector('#_cfCancel').addEventListener('click', () => cleanup(false));
        document.addEventListener('keydown', onKey);
    });
}

/** Deterministic colour per account, so the ledger dot means something. */
const ACCOUNT_COLOURS = ['#2AB5A0', '#7C9BEC', '#E0A458', '#C77DBB', '#7ED0A0', '#E08A7A', '#9B8ADB'];
export function accountColour(accountId, index = 0) {
    if (!accountId) return ACCOUNT_COLOURS[0];
    let h = 0;
    for (let i = 0; i < accountId.length; i++) h = (h * 31 + accountId.charCodeAt(i)) >>> 0;
    return ACCOUNT_COLOURS[(h + index) % ACCOUNT_COLOURS.length];
}

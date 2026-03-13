/**
 * Shared utilities for Wine Cellar Tracker.
 * - escapeHTML
 * - showToast
 * - showConfirm (promise-based)
 * - openModal / closeModal
 */

// ── HTML Escaping ─────────────────────────────────────────────────────────────

export function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#x27;');
}

// ── Toast Notifications ───────────────────────────────────────────────────────

/**
 * Show a non-blocking toast notification.
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} type
 * @param {number} duration - ms before auto-dismiss
 */
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

// ── Undo Toast ────────────────────────────────────────────────────────────────

/**
 * Show a toast with an "Undo" action button.
 *
 * The `onCommit` callback fires after `duration` ms if the user did not click Undo.
 * The `onUndo` callback fires immediately if the user clicks Undo.
 *
 * @param {string}   message
 * @param {Function} onUndo   — called synchronously when Undo is clicked
 * @param {Function} onCommit — called asynchronously after the grace period
 * @param {number}   duration — grace period in ms (default 5000)
 */
export function showUndoToast(message, onUndo, onCommit, duration = 5000) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast toast-warning';
    toast.innerHTML = `
        <span class="toast-icon">⏪</span>
        <span class="toast-msg">${escapeHTML(message)}</span>
        <button class="toast-undo-btn">Undo</button>`;

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    let undone = false;

    const dismiss = () => {
        toast.classList.remove('toast-visible');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    };

    const timer = setTimeout(() => {
        if (!undone) { dismiss(); onCommit && onCommit(); }
    }, duration);

    toast.querySelector('.toast-undo-btn').addEventListener('click', () => {
        if (undone) return;
        undone = true;
        clearTimeout(timer);
        dismiss();
        onUndo && onUndo();
    });
}

// ── Confirm Modal ─────────────────────────────────────────────────────────────

/**
 * Show a themed confirmation dialog. Returns a Promise<boolean>.
 * Falls back to native confirm() if the DOM elements aren't present.
 *
 * @param {string} message
 * @param {{ confirmLabel?: string, cancelLabel?: string, danger?: boolean }} options
 */
export function showConfirm(message, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise(resolve => {
        const overlay   = document.getElementById('confirmOverlay');
        const msgEl     = document.getElementById('confirmMessage');
        const okBtn     = document.getElementById('confirmOk');
        const cancelBtn = document.getElementById('confirmCancel');

        if (!overlay || !msgEl || !okBtn || !cancelBtn) {
            resolve(window.confirm(message));
            return;
        }

        msgEl.textContent = message;
        okBtn.textContent = confirmLabel;
        okBtn.className   = danger ? 'btn btn-danger' : 'btn btn-success';
        cancelBtn.textContent = cancelLabel;
        overlay.style.display = 'flex';

        // Clone buttons to wipe previous listeners
        const newOk     = okBtn.cloneNode(true);
        const newCancel = cancelBtn.cloneNode(true);
        okBtn.replaceWith(newOk);
        cancelBtn.replaceWith(newCancel);

        const cleanup = result => {
            overlay.style.display = 'none';
            resolve(result);
        };

        newOk.addEventListener('click',     () => cleanup(true));
        newCancel.addEventListener('click', () => cleanup(false));

        // Keyboard: Enter = confirm, Escape = cancel
        const onKey = e => {
            if (e.key === 'Enter')  { document.removeEventListener('keydown', onKey); cleanup(true); }
            if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(false); }
        };
        document.addEventListener('keydown', onKey);
    });
}

// ── Merge Dialog ──────────────────────────────────────────────────────────────

/**
 * Show a 3-choice dialog when adding a wine that already exists in the cellar.
 *
 * @param {Array}  existingHoldings  - user_wines rows already in DB for this wine
 * @param {object} newBottle         - bottle data being added (has .qty)
 * @returns {Promise<'merge'|'separate'|'cancel'>}
 */
export function showMergeDialog(existingHoldings, newBottle) {
    return new Promise(resolve => {
        const existingQty = existingHoldings.reduce((sum, h) => sum + (h.qty || 0), 0);
        const newQty      = newBottle.qty || 1;

        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.style.cssText = 'display:flex;z-index:10001;';

        overlay.innerHTML = `
            <div class="confirm-dialog" style="max-width:440px;">
                <p style="margin-bottom:8px;font-weight:600;font-size:15px;">Wine already in cellar</p>
                <p style="color:#94a3b8;font-size:13px;margin-bottom:20px;">
                    You already have <strong style="color:#e2e8f0;">${existingQty} bottle${existingQty !== 1 ? 's' : ''}</strong>
                    of this wine. What would you like to do?
                </p>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <button id="_mrgMerge" class="btn btn-success" style="width:100%;justify-content:center;">
                        Merge — combine into ${existingQty + newQty} bottles
                    </button>
                    <button id="_mrgSeparate" class="btn btn-primary" style="width:100%;justify-content:center;">
                        Add as separate lot
                    </button>
                    <button id="_mrgCancel" class="btn" style="width:100%;justify-content:center;background:#374151;color:#9ca3af;">
                        Cancel
                    </button>
                </div>
            </div>`;

        document.body.appendChild(overlay);

        const cleanup = result => { overlay.remove(); resolve(result); };

        overlay.querySelector('#_mrgMerge').addEventListener('click',    () => cleanup('merge'));
        overlay.querySelector('#_mrgSeparate').addEventListener('click', () => cleanup('separate'));
        overlay.querySelector('#_mrgCancel').addEventListener('click',   () => cleanup('cancel'));
    });
}

// ── Modal Open / Close ────────────────────────────────────────────────────────

/**
 * Open a dialog as a full-screen overlay modal.
 * The dialog element should use CSS `display: flex` when open.
 */
export function openModal(dialogId) {
    const dialog = document.getElementById(dialogId);
    if (!dialog) return;
    dialog.style.display = 'flex';
    dialog.dataset.activeModal = 'true';
    // Focus first focusable element
    const first = dialog.querySelector('input:not([type=hidden]), textarea, select, button');
    if (first) setTimeout(() => first.focus(), 50);
}

/**
 * Close a specific dialog modal.
 */
export function closeModal(dialogId) {
    const dialog = document.getElementById(dialogId);
    if (!dialog) return;
    dialog.style.display = 'none';
    delete dialog.dataset.activeModal;
}

/**
 * Close whichever modal is currently open (for Escape key handler).
 */
export function closeActiveModal() {
    const active = document.querySelector('[data-active-modal="true"]');
    if (active) closeModal(active.id);
}

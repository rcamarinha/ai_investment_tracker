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

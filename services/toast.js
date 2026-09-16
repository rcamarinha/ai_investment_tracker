/**
 * The app's toast, with no imports.
 *
 * It lives apart from services/utils.js because utils imports state and the
 * sector map, and the hub (index.html) must not pull in the service graph. The
 * hub is where an invited person sets their first password, so it is the page
 * that most needed a toast rather than a blocking alert(). utils.js re-exports
 * this, so every existing import keeps working.
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
    const icons = { success: '\u2713', error: '\u2715', warning: '\u26A0', info: '\u2139' };

    // Built as nodes, not innerHTML: a toast often carries an error message,
    // and an error message often carries text from somewhere else.
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = icons[type] || icons.info;
    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = String(message);
    toast.append(icon, msg);

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    const dismiss = () => {
        toast.classList.remove('toast-visible');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    };
    const timer = setTimeout(dismiss, duration);
    toast.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
}

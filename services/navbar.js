/**
 * Persistent navigation bar — shared across index.html, portfolio.html, wine.html.
 *
 * Renders:
 *   [Investment Hub]  [📈 Portfolio]  [🍷 Wine]    [🌐 PT]  [🔐 Login ▾]
 *
 * The Login button opens a dropdown with the full auth form (Google + email/password)
 * or, when logged in, shows the user's email and a Logout button.
 *
 * Language toggle persists to localStorage ('app_lang') and reloads the page
 * so all dynamic content is re-rendered in the new language.
 *
 * Auth state is updated by calling window.updateNavbarAuth(user, recoveryMode, supabaseOn)
 * which is also exported directly for module consumers.
 *
 * Each page exposes handleLogin / handleSignup / handleLogout / etc. on window.*
 * so the navbar's onclick handlers work everywhere without circular imports.
 */

import { getLang, setLang, t, applyTranslations } from '../data/i18n.js';

// ── Google SVG icon (shared) ──────────────────────────────────────────────────

const GOOGLE_SVG = `<svg width="16" height="16" viewBox="0 0 48 48" style="flex-shrink:0;">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

// ── Internal helpers ──────────────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function getCurrentPage() {
    const path = window.location.pathname;
    if (path.includes('portfolio.html')) return 'portfolio';
    if (path.includes('wine.html'))      return 'wine';
    return 'hub';
}

// ── Auth dropdown content ─────────────────────────────────────────────────────

function buildAuthDropdownHTML(user, passwordRecoveryMode) {
    if (passwordRecoveryMode) {
        return `
            <div class="nav-dropdown-inner">
                <p style="color:var(--text-secondary);font-size:13px;margin:0 0 8px;">${t('auth.set_password')}</p>
                <input type="password" id="newPassword"
                       placeholder="${t('auth.new_password_ph')}"
                       style="width:100%;padding:8px 10px;background:var(--ink-2);color:var(--text-primary);border:1px solid var(--border-hover);border-radius:6px;font-size:13px;box-sizing:border-box;" />
                <input type="password" id="confirmPassword"
                       placeholder="${t('auth.confirm_ph')}"
                       onkeydown="if(event.key==='Enter') handlePasswordReset()"
                       style="width:100%;padding:8px 10px;background:var(--ink-2);color:var(--text-primary);border:1px solid var(--border-hover);border-radius:6px;font-size:13px;box-sizing:border-box;" />
                <div style="display:flex;gap:8px;">
                    <button class="btn-sm" style="background:var(--up);" onclick="handlePasswordReset()">${t('auth.set_btn')}</button>
                    <button class="btn-sm" style="background:var(--surface-2);" onclick="cancelPasswordRecovery()">${t('auth.cancel')}</button>
                </div>
            </div>`;
    }

    if (user) {
        return `
            <div class="nav-dropdown-inner">
                <div style="display:flex;flex-direction:column;gap:3px;padding-bottom:10px;border-bottom:1px solid var(--border);margin-bottom:10px;">
                    <span style="color:var(--up);font-weight:600;font-size:13px;">☁️ ${t('auth.connected')}</span>
                    <span style="color:var(--text-secondary);font-size:12px;word-break:break-all;">${esc(user.email)}</span>
                </div>
                <button class="btn-sm" style="background:var(--surface-2);width:100%;" onclick="handleLogout()">${t('nav.logout')}</button>
            </div>`;
    }

    return `
        <div class="nav-dropdown-inner">
            <button class="btn-sso btn-google" onclick="handleGoogleLogin()" style="width:100%;justify-content:center;">
                ${GOOGLE_SVG}
                ${t('auth.google')}
            </button>
            <div class="auth-divider" style="margin:10px 0;"><span>${t('auth.or_email')}</span></div>
            <div style="display:flex;flex-direction:column;gap:8px;">
                <input type="email" id="authEmail"
                       placeholder="${t('auth.email_ph')}"
                       style="width:100%;padding:8px 10px;background:var(--ink-2);color:var(--text-primary);border:1px solid var(--border-hover);border-radius:6px;font-size:13px;box-sizing:border-box;" />
                <input type="password" id="authPassword"
                       placeholder="${t('auth.password_ph')}"
                       onkeydown="if(event.key==='Enter') handleLogin()"
                       style="width:100%;padding:8px 10px;background:var(--ink-2);color:var(--text-primary);border:1px solid var(--border-hover);border-radius:6px;font-size:13px;box-sizing:border-box;" />
                <div style="display:flex;gap:8px;">
                    <button class="btn-sm" style="background:#2563eb;flex:1;" onclick="handleLogin()">${t('auth.login_btn')}</button>
                    <button class="btn-sm" style="background:#7c3aed;flex:1;" onclick="handleSignup()">${t('auth.signup_btn')}</button>
                </div>
                <button class="auth-forgot-link" onclick="handleForgotPassword()">${t('auth.forgot')}</button>
            </div>
        </div>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render the full navbar into #appNavbar.
 *
 * @param {object} opts
 * @param {object|null}  opts.user                - Supabase user object or null
 * @param {boolean}      opts.passwordRecoveryMode - show reset-password form
 * @param {boolean}      opts.supabaseConfigured   - show auth section at all
 */
export function renderNavbar(opts = {}) {
    const { user = null, passwordRecoveryMode = false, supabaseConfigured = false } = opts;
    const navbar = document.getElementById('appNavbar');
    if (!navbar) return;

    const page = getCurrentPage();
    const lang = getLang();
    const isLoggedIn = !!user;

    const authSection = supabaseConfigured ? `
        <div class="nav-auth-wrap" id="navAuthWrap">
            <button
                class="nav-auth-btn${isLoggedIn ? ' logged-in' : ''}"
                id="navAuthToggleBtn"
                onclick="navbarToggleAuthDropdown()">
                ${isLoggedIn
                    ? `👤 ${esc(user.email.split('@')[0])} ▾`
                    : `🔐 ${t('nav.login')} ▾`}
            </button>
            <div class="nav-auth-dropdown" id="navAuthDropdown" style="display:none;">
                ${buildAuthDropdownHTML(user, passwordRecoveryMode)}
            </div>
        </div>` : '';

    navbar.innerHTML = `
        <div class="navbar-inner">
            <a href="index.html" class="nav-brand${page === 'hub' ? ' active' : ''}"
               data-i18n="nav.hub">${t('nav.hub')}</a>
            <nav class="nav-links">
                <a href="portfolio.html"
                   class="nav-link${page === 'portfolio' ? ' active' : ''}"
                   data-i18n="nav.portfolio">${t('nav.portfolio')}</a>
                <a href="wine.html"
                   class="nav-link${page === 'wine' ? ' active' : ''}"
                   data-i18n="nav.wine">${t('nav.wine')}</a>
            </nav>
            <div class="nav-actions">
                <button class="lang-toggle" onclick="navbarToggleLang()"
                        title="${lang === 'en' ? 'Mudar para Português' : 'Switch to English'}">
                    🌐 <span data-i18n="nav.lang_switch">${t('nav.lang_switch')}</span>
                </button>
                ${authSection}
            </div>
        </div>`;

    // Apply data-i18n translations to the rest of the page
    applyTranslations();

    // Wire click-outside to close dropdown
    _attachClickOutside();
}

/**
 * Update only the auth portion of the navbar (called after login/logout/role change).
 * @param {object|null} user
 * @param {boolean}     passwordRecoveryMode
 * @param {boolean}     supabaseConfigured
 */
export function updateNavbarAuth(user, passwordRecoveryMode = false, supabaseConfigured = false) {
    const wrap = document.getElementById('navAuthWrap');

    if (!supabaseConfigured) {
        if (wrap) wrap.style.display = 'none';
        return;
    }

    // If navbar hasn't been rendered yet (e.g. Supabase config loads before renderNavbar)
    // just do a full render.
    if (!wrap) {
        renderNavbar({ user, passwordRecoveryMode, supabaseConfigured });
        return;
    }

    wrap.style.display = '';
    const isLoggedIn = !!user;

    const toggleBtn = document.getElementById('navAuthToggleBtn');
    if (toggleBtn) {
        toggleBtn.className = `nav-auth-btn${isLoggedIn ? ' logged-in' : ''}`;
        toggleBtn.innerHTML = isLoggedIn
            ? `👤 ${esc(user.email.split('@')[0])} ▾`
            : `🔐 ${t('nav.login')} ▾`;
    }

    // If the dropdown is currently open, refresh its content too
    const dropdown = document.getElementById('navAuthDropdown');
    if (dropdown && dropdown.style.display !== 'none') {
        dropdown.innerHTML = buildAuthDropdownHTML(user, passwordRecoveryMode);
    } else if (dropdown) {
        // Pre-populate so it's ready when opened; keeps prior form state if closed
        dropdown.innerHTML = buildAuthDropdownHTML(user, passwordRecoveryMode);
    }
}

// ── Window-level callbacks (called from onclick attributes) ───────────────────

/** Toggle EN ↔ PT and reload the page so all dynamic content re-renders. */
window.navbarToggleLang = function () {
    const next = getLang() === 'en' ? 'pt' : 'en';
    setLang(next);
    location.reload();
};

/** Open / close the auth dropdown. */
window.navbarToggleAuthDropdown = function () {
    const dropdown = document.getElementById('navAuthDropdown');
    if (!dropdown) return;
    const isOpen = dropdown.style.display !== 'none';
    dropdown.style.display = isOpen ? 'none' : 'block';
};

// Also expose updateNavbarAuth globally so auth.js / wine/storage.js can call it
// without importing this module (avoids circular dependencies).
window.updateNavbarAuth = updateNavbarAuth;

// ── Internal: click-outside close ────────────────────────────────────────────

let _clickOutsideAttached = false;
function _attachClickOutside() {
    if (_clickOutsideAttached) return;
    _clickOutsideAttached = true;
    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('navAuthDropdown');
        const wrap     = document.getElementById('navAuthWrap');
        if (dropdown && wrap && !wrap.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
}

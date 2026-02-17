/**
 * Authentication service — Supabase auth integration + role management.
 *
 * Supports two sign-in methods:
 *   1. Email + password (built-in)
 *   2. Google OAuth
 */

import state from './state.js';
import { escapeHTML } from './utils.js';
import { loadFromDatabase } from './storage.js';
import { renderPortfolio, updateHistoryDisplay } from './portfolio.js';

// ── Role Helpers ─────────────────────────────────────────────────────────────

/** Returns true when the current session has admin privileges. */
export function isAdmin() {
    // When no Supabase / not logged in → single-user mode, treat as admin
    if (!state.supabaseClient || !state.currentUser) return true;
    return state.userRole === 'admin';
}

/**
 * Check app_config for adminEmails and set state.userRole accordingly.
 * Called after login and after loadFromDatabase.
 */
export async function checkUserRole() {
    if (!state.supabaseClient || !state.currentUser) {
        state.userRole = 'user';
        return;
    }

    try {
        const { data, error } = await state.supabaseClient
            .from('app_config')
            .select('value')
            .eq('key', 'adminEmails')
            .single();

        if (error || !data) {
            // No adminEmails config → first user / legacy setup → default to admin
            console.log('No adminEmails config found — defaulting to admin');
            state.userRole = 'admin';
            updateActionVisibility();
            updateAuthBar();
            return;
        }

        const adminList = data.value.split(',').map(e => e.trim().toLowerCase());
        const userEmail = state.currentUser.email.toLowerCase();

        state.userRole = adminList.includes(userEmail) ? 'admin' : 'user';
        console.log(`\u2713 User role: ${state.userRole} (${userEmail})`);
    } catch (err) {
        console.warn('Failed to check user role:', err);
        state.userRole = 'user';
    }

    updateActionVisibility();
    updateAuthBar();
}

// ── Visibility ───────────────────────────────────────────────────────────────

/** Show or hide admin-only UI elements based on current role. */
export function updateActionVisibility() {
    const apiKeyBtn = document.getElementById('apiKeyBtn');
    if (!apiKeyBtn) return;

    if (isAdmin()) {
        apiKeyBtn.style.display = '';
    } else {
        apiKeyBtn.style.display = 'none';
    }
}

// ── Auth UI ─────────────────────────────────────────────────────────────────

export function updateAuthBar() {
    const authBar = document.getElementById('authBar');
    if (!authBar) return;

    if (!state.supabaseClient) {
        authBar.style.display = 'none';
        return;
    }

    authBar.style.display = 'block';

    if (state.currentUser) {
        const roleBadge = state.userRole === 'admin'
            ? '<span class="role-badge role-admin">Admin</span>'
            : '<span class="role-badge role-user">User</span>';
        authBar.innerHTML = `
            <div class="auth-logged-in">
                <span style="color: #4ade80; font-weight: 600;">\u2601\uFE0F Connected</span>
                <span style="color: #94a3b8;">${escapeHTML(state.currentUser.email)}</span>
                ${roleBadge}
                <span style="flex: 1;"></span>
                <button class="btn-sm" style="background: #475569;" onclick="handleLogout()">Logout</button>
            </div>
        `;
    } else {
        authBar.innerHTML = `
            <div class="auth-login-panel">
                <div class="auth-sso-section">
                    <button class="btn-sso btn-google" onclick="handleGoogleLogin()">
                        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
                        Sign in with Google
                    </button>
                </div>
                <div class="auth-divider">
                    <span>or sign in with email</span>
                </div>
                <div class="auth-email-section">
                    <input type="email" id="authEmail" placeholder="Email" />
                    <input type="password" id="authPassword" placeholder="Password" onkeydown="if(event.key==='Enter') handleLogin()" />
                    <button class="btn-sm" style="background: #2563eb;" onclick="handleLogin()">Login</button>
                    <button class="btn-sm" style="background: #7c3aed;" onclick="handleSignup()">Sign Up</button>
                </div>
            </div>
        `;
    }
}

// ── OAuth Providers ─────────────────────────────────────────────────────────

export async function handleGoogleLogin() {
    if (!state.supabaseClient) {
        alert('Cloud sync not configured. Set up Supabase first.');
        return;
    }
    try {
        const { error } = await state.supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: window.location.origin + window.location.pathname
            }
        });
        if (error) throw error;
        // Browser will redirect to Google, then back — onAuthStateChange handles the rest
    } catch (err) {
        alert('Google sign-in failed: ' + err.message);
    }
}

// ── Email / Password ────────────────────────────────────────────────────────

export async function handleLogin() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;

    if (!email || !password) {
        alert('Please enter email and password.');
        return;
    }

    try {
        const { data, error } = await state.supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        console.log('\u2713 Logged in:', data.user.email);
        // Role is checked in the onAuthStateChange handler after loadFromDatabase
    } catch (err) {
        alert('Login failed: ' + err.message);
    }
}

export async function handleSignup() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;

    if (!email || !password) {
        alert('Please enter email and password.');
        return;
    }
    if (password.length < 6) {
        alert('Password must be at least 6 characters.');
        return;
    }

    try {
        const { data, error } = await state.supabaseClient.auth.signUp({ email, password });
        if (error) throw error;
        alert('Account created! Check your email to confirm your account, then log in.');
        console.log('\u2713 Signed up:', data.user?.email);
    } catch (err) {
        alert('Sign up failed: ' + err.message);
    }
}

export async function handleLogout() {
    try {
        await state.supabaseClient.auth.signOut();
        state.currentUser = null;
        state.userRole = 'user';

        // Clear all user-specific state
        state.portfolio = [];
        state.portfolioHistory = [];
        state.marketPrices = {};
        state.priceMetadata = {};
        state.transactions = {};
        state.selectedSector = null;
        state.showInactivePositions = false;

        // Clear user-specific localStorage to prevent data leaks on shared browsers
        localStorage.removeItem('portfolioHistory');
        localStorage.removeItem('positionTransactions');

        // Re-render UI to reflect empty state
        renderPortfolio();
        updateHistoryDisplay();

        // Clear analysis section
        const analysisSection = document.getElementById('analysisSection');
        if (analysisSection) analysisSection.innerHTML = '';

        // Hide allocation charts
        const allocationSection = document.getElementById('allocationSection');
        if (allocationSection) allocationSection.style.display = 'none';

        // Hide sales history
        const salesSection = document.getElementById('salesHistorySection');
        if (salesSection) salesSection.style.display = 'none';

        // Close any open dialogs
        ['importDialog', 'apiKeyDialog', 'positionDialog'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        updateAuthBar();
        updateActionVisibility();
        console.log('\u2713 Logged out — UI cleared');
    } catch (err) {
        console.error('Logout error:', err);
    }
}

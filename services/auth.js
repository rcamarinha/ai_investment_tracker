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
    // No Supabase configured → local-only mode, treat as admin
    if (!state.supabaseClient) return true;
    // Supabase configured but not logged in → no privileges
    if (!state.currentUser) return false;
    return state.userRole === 'admin';
}

/**
 * Admin status = membership in the `admin_users` table (single source of truth,
 * enforced by RLS). A per-user SELECT policy (auth.uid() = user_id) lets each
 * user check ONLY their own row, so a returned row proves admin. Fail-closed:
 * any error or empty result -> regular user.
 * Called after login and after loadFromDatabase.
 */
export async function checkUserRole() {
    if (!state.supabaseClient || !state.currentUser) {
        state.userRole = 'user';
        return;
    }

    try {
        const { data, error } = await state.supabaseClient
            .from('admin_users')
            .select('user_id')
            .eq('user_id', state.currentUser.id)
            .maybeSingle();

        if (error) {
            console.warn('checkUserRole: admin_users read failed, defaulting to user:', error.message);
            state.userRole = 'user';
        } else {
            state.userRole = data ? 'admin' : 'user';
            console.log(`✓ User role: ${state.userRole} (${state.currentUser.email})`);
        }
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
    // Delegate to the persistent navbar (exposed by services/navbar.js on window)
    if (typeof window.updateNavbarAuth === 'function') {
        window.updateNavbarAuth(state.currentUser, state.passwordRecoveryMode, !!state.supabaseClient);
    }
    // Hide the legacy auth bar div if it still exists in the DOM
    const authBar = document.getElementById('authBar');
    if (authBar) authBar.style.display = 'none';
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
    const email = (document.getElementById('authEmail')?.value ?? '').trim();
    const password = document.getElementById('authPassword')?.value ?? '';

    if (!email || !password) {
        alert('Please enter email and password.');
        return;
    }

    try {
        const { data, error } = await state.supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        console.log('\u2713 Logged in:', data.user?.email);
        // Role is checked in the onAuthStateChange handler after loadFromDatabase
    } catch (err) {
        alert('Login failed: ' + err.message);
    }
}

export async function handleForgotPassword() {
    if (!state.supabaseClient) {
        alert('Cloud sync not configured. Set up Supabase first.');
        return;
    }

    const emailInput = document.getElementById('authEmail');
    const email = emailInput ? emailInput.value.trim() : '';

    if (!email) {
        alert('Please enter your email address first.');
        if (emailInput) emailInput.focus();
        return;
    }

    const redirectTo = window.location.origin + window.location.pathname.replace(/\.html$/, '');
    console.log('[auth] resetPasswordForEmail →', email, 'redirect:', redirectTo);
    try {
        const { error } = await state.supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        alert(`Password reset email sent to ${email}. Check your inbox and follow the link to set a new password.`);
    } catch (err) {
        console.error('[auth] resetPasswordForEmail failed:', err);
        alert('Failed to send reset email: ' + err.message);
    }
}

export async function handlePasswordReset() {
    const newPassword = document.getElementById('newPassword')?.value;
    const confirmPassword = document.getElementById('confirmPassword')?.value;

    if (!newPassword || !confirmPassword) {
        alert('Please fill in both password fields.');
        return;
    }
    if (newPassword !== confirmPassword) {
        alert('Passwords do not match.');
        return;
    }
    if (newPassword.length < 6) {
        alert('Password must be at least 6 characters.');
        return;
    }

    try {
        const { error } = await state.supabaseClient.auth.updateUser({ password: newPassword });
        if (error) throw error;
        state.passwordRecoveryMode = false;
        alert('Password updated successfully. You are now logged in.');
        updateAuthBar();
    } catch (err) {
        alert('Failed to update password: ' + err.message);
    }
}

export function cancelPasswordRecovery() {
    state.passwordRecoveryMode = false;
    updateAuthBar();
}

export async function handleSignup() {
    const email = (document.getElementById('authEmail')?.value ?? '').trim();
    const password = document.getElementById('authPassword')?.value ?? '';

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
        alert('Logout failed: ' + err.message);
    }
}

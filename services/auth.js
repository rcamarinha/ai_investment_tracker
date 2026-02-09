/**
 * Authentication service — Supabase auth integration.
 */

import state from './state.js';
import { escapeHTML } from './utils.js';
import { loadFromDatabase } from './storage.js';

// ── Auth UI ─────────────────────────────────────────────────────────────────

export function updateAuthBar() {
    const authBar = document.getElementById('authBar');
    if (!authBar) return;

    if (!state.supabaseClient) {
        authBar.style.display = 'none';
        return;
    }

    authBar.style.display = 'flex';

    if (state.currentUser) {
        authBar.innerHTML = `
            <span style="color: #4ade80; font-weight: 600;">\u2601\uFE0F Connected</span>
            <span style="color: #94a3b8;">${escapeHTML(state.currentUser.email)}</span>
            <span style="flex: 1;"></span>
            <button class="btn-sm" style="background: #475569;" onclick="handleLogout()">Logout</button>
        `;
    } else {
        authBar.innerHTML = `
            <span style="color: #94a3b8;">\u2601\uFE0F Cloud Sync</span>
            <input type="email" id="authEmail" placeholder="Email" />
            <input type="password" id="authPassword" placeholder="Password" onkeydown="if(event.key==='Enter') handleLogin()" />
            <button class="btn-sm" style="background: #2563eb;" onclick="handleLogin()">Login</button>
            <button class="btn-sm" style="background: #7c3aed;" onclick="handleSignup()">Sign Up</button>
        `;
    }
}

// ── Login / Signup / Logout ─────────────────────────────────────────────────

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
        updateAuthBar();
        console.log('\u2713 Logged out');
    } catch (err) {
        console.error('Logout error:', err);
    }
}

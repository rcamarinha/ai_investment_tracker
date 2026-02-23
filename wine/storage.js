/**
 * Wine storage service — Supabase DB + auth for the Wine Cellar Tracker.
 *
 * Self-contained: does not import from services/ to avoid pulling in
 * stock-portfolio-specific logic. Auth UI is handled here independently.
 */

import state from './state.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#x27;');
}

// ── Supabase Initialization ─────────────────────────────────────────────────

export function initSupabase(onLoad) {
    if (!state.supabaseUrl || !state.supabaseAnonKey) {
        updateAuthBar();
        return false;
    }
    try {
        state.supabaseClient = supabase.createClient(state.supabaseUrl, state.supabaseAnonKey);

        state.supabaseClient.auth.onAuthStateChange((event, session) => {
            state.currentUser = session?.user || null;

            if (event === 'PASSWORD_RECOVERY') {
                state.passwordRecoveryMode = true;
                updateAuthBar();
                return;
            }
            if (event === 'USER_UPDATED' && state.passwordRecoveryMode) {
                state.passwordRecoveryMode = false;
            }

            updateAuthBar();

            if (event === 'SIGNED_IN') {
                loadFromDatabase().then(onLoad);
            } else if (event === 'SIGNED_OUT') {
                state.cellar = [];
                state.cellarHistory = [];
                if (onLoad) onLoad();
            }
        });

        state.supabaseClient.auth.getSession().then(({ data: { session } }) => {
            state.currentUser = session?.user || null;
            updateAuthBar();
            if (state.currentUser) {
                loadFromDatabase().then(onLoad);
            }
        });

        console.log('✓ Wine Supabase initialized');
        return true;
    } catch (err) {
        console.error('Wine Supabase init failed:', err);
        return false;
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
        authBar.innerHTML = `
            <div class="auth-logged-in">
                <span style="color: #4ade80; font-weight: 600;">&#x2601;&#xFE0F; Connected</span>
                <span style="color: #94a3b8;">${escapeHTML(state.currentUser.email)}</span>
                <span style="flex: 1;"></span>
                <button class="btn-sm" style="background: #475569;" onclick="handleLogout()">Logout</button>
            </div>
        `;
    } else if (state.passwordRecoveryMode) {
        authBar.innerHTML = `
            <div class="auth-login-panel">
                <div class="auth-email-section">
                    <span style="color: #94a3b8; font-size: 13px;">Set new password</span>
                    <input type="password" id="newPassword" placeholder="New password" />
                    <input type="password" id="confirmPassword" placeholder="Confirm password" onkeydown="if(event.key==='Enter') handlePasswordReset()" />
                    <button class="btn-sm" style="background: #059669;" onclick="handlePasswordReset()">Set Password</button>
                    <button class="btn-sm" style="background: #475569;" onclick="cancelPasswordRecovery()">Cancel</button>
                </div>
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
                <div class="auth-divider"><span>or sign in with email</span></div>
                <div class="auth-email-section">
                    <input type="email" id="authEmail" placeholder="Email" />
                    <input type="password" id="authPassword" placeholder="Password" onkeydown="if(event.key==='Enter') handleLogin()" />
                    <button class="btn-sm" style="background: #2563eb;" onclick="handleLogin()">Login</button>
                    <button class="btn-sm" style="background: #7c3aed;" onclick="handleSignup()">Sign Up</button>
                    <button class="auth-forgot-link" onclick="handleForgotPassword()">Forgot password?</button>
                </div>
            </div>
        `;
    }
}

// ── Auth Actions ─────────────────────────────────────────────────────────────

export async function handleGoogleLogin() {
    if (!state.supabaseClient) { alert('Supabase not configured.'); return; }
    try {
        const { error } = await state.supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin + window.location.pathname }
        });
        if (error) throw error;
    } catch (err) { alert('Google sign-in failed: ' + err.message); }
}

export async function handleLogin() {
    const email    = document.getElementById('authEmail')?.value.trim();
    const password = document.getElementById('authPassword')?.value;
    if (!email || !password) { alert('Please enter email and password.'); return; }
    try {
        const { error } = await state.supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
    } catch (err) { alert('Login failed: ' + err.message); }
}

export async function handleSignup() {
    const email    = document.getElementById('authEmail')?.value.trim();
    const password = document.getElementById('authPassword')?.value;
    if (!email || !password) { alert('Please enter email and password.'); return; }
    if (password.length < 6) { alert('Password must be at least 6 characters.'); return; }
    try {
        const { error } = await state.supabaseClient.auth.signUp({ email, password });
        if (error) throw error;
        alert('Account created! Check your email to confirm, then log in.');
    } catch (err) { alert('Sign up failed: ' + err.message); }
}

export async function handleForgotPassword() {
    if (!state.supabaseClient) { alert('Supabase not configured.'); return; }
    const email = document.getElementById('authEmail')?.value.trim();
    if (!email) { alert('Please enter your email address first.'); return; }
    try {
        const { error } = await state.supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + window.location.pathname,
        });
        if (error) throw error;
        alert(`Password reset email sent to ${email}.`);
    } catch (err) { alert('Failed to send reset email: ' + err.message); }
}

export async function handlePasswordReset() {
    const newPass     = document.getElementById('newPassword')?.value;
    const confirmPass = document.getElementById('confirmPassword')?.value;
    if (!newPass || !confirmPass) { alert('Please fill in both fields.'); return; }
    if (newPass !== confirmPass)  { alert('Passwords do not match.'); return; }
    if (newPass.length < 6)       { alert('Password must be at least 6 characters.'); return; }
    try {
        const { error } = await state.supabaseClient.auth.updateUser({ password: newPass });
        if (error) throw error;
        state.passwordRecoveryMode = false;
        alert('Password updated. You are now logged in.');
        updateAuthBar();
    } catch (err) { alert('Failed to update password: ' + err.message); }
}

export function cancelPasswordRecovery() {
    state.passwordRecoveryMode = false;
    updateAuthBar();
}

export async function handleLogout() {
    try {
        await state.supabaseClient.auth.signOut();
        state.currentUser = null;
        state.cellar = [];
        state.cellarHistory = [];
        updateAuthBar();
        console.log('✓ Wine tracker logged out');
    } catch (err) { console.error('Logout error:', err); }
}

// ── Load from Database ───────────────────────────────────────────────────────

export async function loadFromDatabase() {
    if (!state.supabaseClient || !state.currentUser) return;
    console.log('=== WINE LOAD FROM DATABASE ===');
    try {
        await Promise.all([loadBottles(), loadSnapshots()]);
        console.log('✓ Wine DB loaded:', state.cellar.length, 'bottles,', state.cellarHistory.length, 'snapshots');
    } catch (err) {
        console.error('Wine loadFromDatabase error:', err);
    }
}

async function loadBottles() {
    const { data, error } = await state.supabaseClient
        .from('wine_bottles')
        .select('*')
        .eq('user_id', state.currentUser.id)
        .order('created_at', { ascending: true });

    if (error) throw error;

    state.cellar = (data || []).map(row => ({
        id:             row.id,
        name:           row.name,
        winery:         row.winery,
        vintage:        row.vintage,
        region:         row.region,
        appellation:    row.appellation,
        varietal:       row.varietal,
        country:        row.country,
        alcohol:        row.alcohol,
        qty:            row.qty,
        purchasePrice:  row.purchase_price,
        purchaseDate:   row.purchase_date,
        storage:        row.storage,
        notes:          row.notes,
        estimatedValue: row.estimated_value,
        drinkWindow:    row.drink_window,
        lastValuedAt:   row.last_valued_at,
    }));
}

async function loadSnapshots() {
    const { data, error } = await state.supabaseClient
        .from('wine_snapshots')
        .select('*')
        .eq('user_id', state.currentUser.id)
        .order('timestamp', { ascending: true });

    if (error) throw error;

    state.cellarHistory = (data || []).map(row => ({
        id:                  row.id,
        timestamp:           row.timestamp,
        totalInvested:       row.total_invested,
        totalEstimatedValue: row.total_estimated_value,
        bottleCount:         row.bottle_count,
    }));
}

// ── Bottle CRUD ──────────────────────────────────────────────────────────────

export async function saveBottleToDB(bottle) {
    if (!state.supabaseClient || !state.currentUser) return null;

    const row = {
        user_id:          state.currentUser.id,
        name:             bottle.name,
        winery:           bottle.winery || null,
        vintage:          bottle.vintage || null,
        region:           bottle.region || null,
        appellation:      bottle.appellation || null,
        varietal:         bottle.varietal || null,
        country:          bottle.country || null,
        alcohol:          bottle.alcohol || null,
        qty:              bottle.qty,
        purchase_price:   bottle.purchasePrice,
        purchase_date:    bottle.purchaseDate || null,
        storage:          bottle.storage || null,
        notes:            bottle.notes || null,
        estimated_value:  bottle.estimatedValue || null,
        drink_window:     bottle.drinkWindow || null,
        last_valued_at:   bottle.lastValuedAt || null,
        updated_at:       new Date().toISOString(),
    };

    if (bottle.id) {
        // Update existing
        const { data, error } = await state.supabaseClient
            .from('wine_bottles')
            .update(row)
            .eq('id', bottle.id)
            .eq('user_id', state.currentUser.id)
            .select()
            .single();
        if (error) throw error;
        return data.id;
    } else {
        // Insert new
        const { data, error } = await state.supabaseClient
            .from('wine_bottles')
            .insert(row)
            .select()
            .single();
        if (error) throw error;
        return data.id;
    }
}

export async function deleteBottleFromDB(id) {
    if (!state.supabaseClient || !state.currentUser) return;
    const { error } = await state.supabaseClient
        .from('wine_bottles')
        .delete()
        .eq('id', id)
        .eq('user_id', state.currentUser.id);
    if (error) throw error;
}

// ── Snapshot CRUD ────────────────────────────────────────────────────────────

export async function saveSnapshotToDB(snapshot) {
    if (!state.supabaseClient || !state.currentUser) return null;

    const { data, error } = await state.supabaseClient
        .from('wine_snapshots')
        .insert({
            user_id:               state.currentUser.id,
            timestamp:             snapshot.timestamp,
            total_invested:        snapshot.totalInvested,
            total_estimated_value: snapshot.totalEstimatedValue,
            bottle_count:          snapshot.bottleCount,
        })
        .select()
        .single();

    if (error) throw error;
    return data.id;
}

export async function deleteSnapshotFromDB(id) {
    if (!state.supabaseClient || !state.currentUser) return;
    const { error } = await state.supabaseClient
        .from('wine_snapshots')
        .delete()
        .eq('id', id)
        .eq('user_id', state.currentUser.id);
    if (error) throw error;
}

export async function clearSnapshotsFromDB() {
    if (!state.supabaseClient || !state.currentUser) return;
    const { error } = await state.supabaseClient
        .from('wine_snapshots')
        .delete()
        .eq('user_id', state.currentUser.id);
    if (error) throw error;
}

/**
 * Bank Holdings storage — Supabase DB + auth.
 *
 * Self-contained: no imports from services/ or from the other modules, so this
 * could be lifted out without dragging anything with it. Auth mirrors
 * wine/storage.js and spend/storage.js exactly.
 */

import state from './state.js?v=3.44.0';
import { showToast } from './utils.js?v=3.44.0';

export function initSupabase(onLoad) {
    if (!state.supabaseUrl || !state.supabaseAnonKey) { updateAuthBar(); return false; }
    try {
        state.supabaseClient = supabase.createClient(state.supabaseUrl, state.supabaseAnonKey);

        state.supabaseClient.auth.onAuthStateChange((event, session) => {
            state.currentUser = session?.user || null;

            if (event === 'PASSWORD_RECOVERY') { state.passwordRecoveryMode = true; updateAuthBar(); return; }
            if (event === 'USER_UPDATED' && state.passwordRecoveryMode) state.passwordRecoveryMode = false;

            updateAuthBar();

            if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
                if (state.currentUser) loadFromDatabase().then(onLoad);
                else if (event === 'INITIAL_SESSION') onLoad?.();
            } else if (event === 'SIGNED_OUT') {
                clearLocalData();
                onLoad?.();
            }
        });

        state.supabaseClient.auth.getSession().then(({ data: { session } }) => {
            if (!state.currentUser && session?.user) {
                state.currentUser = session.user;
                updateAuthBar();
                loadFromDatabase().then(onLoad).catch(err => {
                    console.error('Load failed:', err);
                    state.loadFailed = true;
                    try { onLoad?.(); } catch { /* render anyway */ }
                });
            }
        }).catch(err => console.warn('getSession fallback error:', err));

        console.log('✓ Holdings Supabase initialized');
        return true;
    } catch (err) {
        console.error('Holdings Supabase init failed:', err);
        return false;
    }
}

/** One place to forget nothing when a new state array is added. */
function clearLocalData() {
    state.holdings = [];
    state.summary = null;
    state.editingId = null;
}

export function updateAuthBar() {
    if (typeof window.updateNavbarAuth === 'function') {
        window.updateNavbarAuth(state.currentUser, state.passwordRecoveryMode, !!state.supabaseClient);
    }
}

export function requireAuth(action = 'do that') {
    if (state.currentUser) return true;
    showToast(`Please log in to ${action}.`, 'warning');
    return false;
}

// ── auth actions (identical shape to the other modules) ─────────────────────

export async function handleGoogleLogin() {
    if (!state.supabaseClient) { showToast('Supabase not configured.', 'warning'); return; }
    try {
        const { error } = await state.supabaseClient.auth.signInWithOAuth({
            provider: 'google', options: { redirectTo: window.location.origin + window.location.pathname }
        });
        if (error) throw error;
    } catch (err) { showToast('Google sign-in failed: ' + err.message, 'error'); }
}

export async function handleLogin() {
    const email = document.getElementById('authEmail')?.value.trim();
    const password = document.getElementById('authPassword')?.value;
    if (!email || !password) { showToast('Please enter email and password.', 'warning'); return; }
    try {
        const { error } = await state.supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
    } catch (err) { showToast('Login failed: ' + err.message, 'error'); }
}

export async function handleSignup() {
    const email = document.getElementById('authEmail')?.value.trim();
    const password = document.getElementById('authPassword')?.value;
    if (!email || !password) { showToast('Please enter email and password.', 'warning'); return; }
    if (password.length < 6) { showToast('Password must be at least 6 characters.', 'warning'); return; }
    try {
        const { error } = await state.supabaseClient.auth.signUp({ email, password });
        if (error) throw error;
        showToast('Account created! Check your email to confirm, then log in.', 'success', 7000);
    } catch (err) { showToast('Sign up failed: ' + err.message, 'error'); }
}

export async function handleForgotPassword() {
    if (!state.supabaseClient) { showToast('Supabase not configured.', 'warning'); return; }
    const email = document.getElementById('authEmail')?.value.trim();
    if (!email) { showToast('Please enter your email address first.', 'warning'); return; }
    const pathname = window.location.pathname.replace(/\.html$/, '');
    try {
        const { error } = await state.supabaseClient.auth.resetPasswordForEmail(email,
            { redirectTo: window.location.origin + pathname });
        if (error) throw error;
        showToast(`Password reset email sent to ${email}.`, 'success', 7000);
    } catch (err) { showToast('Failed to send reset email: ' + err.message, 'error', 8000); }
}

export async function handlePasswordReset() {
    const newPass = document.getElementById('newPassword')?.value;
    const confirmPass = document.getElementById('confirmPassword')?.value;
    if (!newPass || !confirmPass) { showToast('Please fill in both fields.', 'warning'); return; }
    if (newPass !== confirmPass) { showToast('Passwords do not match.', 'warning'); return; }
    if (newPass.length < 6) { showToast('Password must be at least 6 characters.', 'warning'); return; }
    try {
        const { error } = await state.supabaseClient.auth.updateUser({ password: newPass });
        if (error) throw error;
        state.passwordRecoveryMode = false;
        showToast('Password updated. You are now logged in.');
        updateAuthBar();
    } catch (err) { showToast('Failed to update password: ' + err.message, 'error'); }
}

export function cancelPasswordRecovery() { state.passwordRecoveryMode = false; updateAuthBar(); }

export async function handleLogout() {
    try {
        await state.supabaseClient.auth.signOut();
        state.currentUser = null;
        clearLocalData();
        updateAuthBar();
    } catch (err) { console.error('Logout error:', err); }
}

// ── row mapping ─────────────────────────────────────────────────────────────

const fromRow = r => ({
    id: r.id, bankName: r.bank_name, name: r.name, holdingType: r.holding_type,
    isin: r.isin, currency: r.currency || 'EUR',
    units: r.units === null ? null : Number(r.units),
    nominal: r.nominal === null ? null : Number(r.nominal),
    costBasis: r.cost_basis === null ? null : Number(r.cost_basis),
    currentValue: r.current_value === null ? null : Number(r.current_value),
    valuedAsOf: r.valued_as_of, valuationSource: r.valuation_source,
    maturityDate: r.maturity_date, note: r.note, archived: !!r.archived
});

const toRow = (h, userId) => ({
    ...(h.id ? { id: h.id } : {}),
    user_id: userId,
    bank_name: h.bankName,
    name: h.name,
    holding_type: h.holdingType || 'other',
    isin: h.isin || null,
    currency: h.currency || 'EUR',
    units: h.units ?? null,
    nominal: h.nominal ?? null,
    cost_basis: h.costBasis ?? null,
    current_value: Number(h.currentValue),
    valued_as_of: String(h.valuedAsOf).slice(0, 10),
    valuation_source: h.valuationSource || 'manual',
    maturity_date: h.maturityDate || null,
    note: h.note || null,
    archived: !!h.archived,
    updated_at: new Date().toISOString()
});

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function loadFromDatabase() {
    if (!state.supabaseClient || !state.currentUser) return;
    console.log('=== HOLDINGS LOAD FROM DATABASE ===');
    try {
        const { data, error } = await state.supabaseClient
            .from('bank_holdings').select('*')
            .eq('user_id', state.currentUser.id)
            .order('current_value', { ascending: false });
        if (error) throw error;
        state.holdings = (data || []).map(fromRow);
        console.log(`✓ Holdings loaded: ${state.holdings.length}`);
    } catch (err) {
        console.error('❌ Holdings load error:', err);
        showToast('Could not load holdings: ' + err.message, 'error', 7000);
    }
}

export async function saveHolding(holding) {
    if (!requireAuth('save a holding')) return null;
    const { data, error } = await state.supabaseClient
        .from('bank_holdings').upsert(toRow(holding, state.currentUser.id)).select().single();
    if (error) throw error;
    const mapped = fromRow(data);
    const i = state.holdings.findIndex(h => h.id === mapped.id);
    if (i >= 0) state.holdings[i] = mapped; else state.holdings.push(mapped);
    state.holdings.sort((a, b) => (b.currentValue || 0) - (a.currentValue || 0));
    return mapped;
}

export async function deleteHolding(id) {
    if (!requireAuth('delete a holding')) return;
    const { error } = await state.supabaseClient
        .from('bank_holdings').delete().eq('id', id).eq('user_id', state.currentUser.id);
    if (error) throw error;
    state.holdings = state.holdings.filter(h => h.id !== id);
}

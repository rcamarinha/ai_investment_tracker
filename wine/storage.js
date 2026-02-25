/**
 * Wine storage service — Supabase DB + auth for the Wine Cellar Tracker.
 *
 * Self-contained: does not import from services/ to avoid pulling in
 * stock-portfolio-specific logic. Auth UI is handled here independently.
 */

import state from './state.js';
import { showToast, escapeHTML } from './utils.js';

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
    if (!state.supabaseClient) { showToast('Supabase not configured.', 'warning'); return; }
    try {
        const { error } = await state.supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin + window.location.pathname }
        });
        if (error) throw error;
    } catch (err) { showToast('Google sign-in failed: ' + err.message, 'error'); }
}

export async function handleLogin() {
    const email    = document.getElementById('authEmail')?.value.trim();
    const password = document.getElementById('authPassword')?.value;
    if (!email || !password) { showToast('Please enter email and password.', 'warning'); return; }
    try {
        const { error } = await state.supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
    } catch (err) { showToast('Login failed: ' + err.message, 'error'); }
}

export async function handleSignup() {
    const email    = document.getElementById('authEmail')?.value.trim();
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
    try {
        const { error } = await state.supabaseClient.auth.resetPasswordForEmail(email, {
            redirectTo: window.location.origin + window.location.pathname,
        });
        if (error) throw error;
        showToast(`Password reset email sent to ${email}.`, 'success', 7000);
    } catch (err) { showToast('Failed to send reset email: ' + err.message, 'error'); }
}

export async function handlePasswordReset() {
    const newPass     = document.getElementById('newPassword')?.value;
    const confirmPass = document.getElementById('confirmPassword')?.value;
    if (!newPass || !confirmPass) { showToast('Please fill in both fields.', 'warning'); return; }
    if (newPass !== confirmPass)  { showToast('Passwords do not match.', 'warning'); return; }
    if (newPass.length < 6)       { showToast('Password must be at least 6 characters.', 'warning'); return; }
    try {
        const { error } = await state.supabaseClient.auth.updateUser({ password: newPass });
        if (error) throw error;
        state.passwordRecoveryMode = false;
        showToast('Password updated. You are now logged in.');
        updateAuthBar();
    } catch (err) { showToast('Failed to update password: ' + err.message, 'error'); }
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
    // Join user_wines with the shared wines catalog so the in-memory bottle
    // object carries both identity fields (from wines) and investment fields
    // (from user_wines), matching the flat shape expected by cellar.js.
    const { data, error } = await state.supabaseClient
        .from('user_wines')
        .select(`
            *,
            wines (
                name, winery, vintage, region, appellation,
                varietal, country, alcohol, drink_window
            )
        `)
        .eq('user_id', state.currentUser.id)
        .order('created_at', { ascending: true });

    if (error) throw error;

    state.cellar = (data || []).map(row => ({
        id:             row.id,
        wineId:         row.wine_id,          // FK to wines table
        // Identity from shared wines catalog
        name:           row.wines?.name,
        winery:         row.wines?.winery,
        vintage:        row.wines?.vintage,
        region:         row.wines?.region,
        appellation:    row.wines?.appellation,
        varietal:       row.wines?.varietal,
        country:        row.wines?.country,
        alcohol:        row.wines?.alcohol,
        drinkWindow:    row.wines?.drink_window,
        // Investment data from user_wines
        qty:            row.qty,
        purchasePrice:  row.purchase_price,
        purchaseDate:   row.purchase_date,
        storage:        row.storage,
        notes:          row.notes,
        estimatedValue: row.estimated_value,
        valueLow:       row.value_low,
        valueHigh:      row.value_high,
        valuationNote:  row.valuation_note,
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

/**
 * Save a bottle to the DB using the normalised schema:
 *   1. Find or create the shared wines catalog entry (deduped by name+winery+vintage).
 *   2. Insert or update the user_wines holding row.
 *
 * Returns the user_wines row id (used as bottle.id throughout the app).
 * Also sets bottle.wineId so callers can reference the wines FK.
 */
export async function saveBottleToDB(bottle) {
    if (!state.supabaseClient || !state.currentUser) return null;

    // ── Step 1: Resolve the shared wines catalog entry ──────────────────────
    let wineId = bottle.wineId || null;

    if (!wineId) {
        // Look for an existing catalog entry by identity (name + winery + vintage).
        // Uses ilike for case-insensitive name match; NULL-safe winery/vintage match.
        let query = state.supabaseClient
            .from('wines')
            .select('id')
            .ilike('name', bottle.name);

        if (bottle.vintage) {
            query = query.eq('vintage', bottle.vintage);
        } else {
            query = query.is('vintage', null);
        }
        if (bottle.winery) {
            query = query.ilike('winery', bottle.winery);
        } else {
            query = query.is('winery', null);
        }

        const { data: existing } = await query.maybeSingle();
        if (existing) wineId = existing.id;
    }

    const wineRow = {
        name:        bottle.name,
        winery:      bottle.winery      || null,
        vintage:     bottle.vintage     || null,
        region:      bottle.region      || null,
        appellation: bottle.appellation || null,
        varietal:    bottle.varietal    || null,
        country:     bottle.country     || null,
        alcohol:     bottle.alcohol     || null,
        drink_window: bottle.drinkWindow || null,
        updated_at:  new Date().toISOString(),
    };

    if (wineId) {
        // Update identity fields in the shared catalog
        await state.supabaseClient
            .from('wines')
            .update(wineRow)
            .eq('id', wineId);
    } else {
        // Create new catalog entry
        const { data, error } = await state.supabaseClient
            .from('wines')
            .insert(wineRow)
            .select('id')
            .single();
        if (error) throw error;
        wineId = data.id;
    }

    // Propagate wineId back to the in-memory bottle object
    bottle.wineId = wineId;

    // ── Step 2: Insert or update the user_wines holding ─────────────────────
    const userWineRow = {
        user_id:         state.currentUser.id,
        wine_id:         wineId,
        qty:             bottle.qty,
        purchase_price:  bottle.purchasePrice  ?? null,
        purchase_date:   bottle.purchaseDate   || null,
        storage:         bottle.storage        || null,
        notes:           bottle.notes          || null,
        estimated_value: bottle.estimatedValue ?? null,
        value_low:       bottle.valueLow       ?? null,
        value_high:      bottle.valueHigh      ?? null,
        valuation_note:  bottle.valuationNote  || null,
        last_valued_at:  bottle.lastValuedAt   || null,
        updated_at:      new Date().toISOString(),
    };

    if (bottle.id) {
        // Update existing holding
        const { data, error } = await state.supabaseClient
            .from('user_wines')
            .update(userWineRow)
            .eq('id', bottle.id)
            .eq('user_id', state.currentUser.id)
            .select('id')
            .single();
        if (error) throw error;
        return data.id;
    } else {
        // Insert new holding
        const { data, error } = await state.supabaseClient
            .from('user_wines')
            .insert(userWineRow)
            .select('id')
            .single();
        if (error) throw error;

        // Log the buy movement for the new holding
        await logAssetMovement({
            assetType:    'wine',
            wineId,
            movementType: 'buy',
            qty:          bottle.qty,
            price:        bottle.purchasePrice,
            totalValue:   (bottle.qty || 0) * (bottle.purchasePrice || 0),
        });

        return data.id;
    }
}

export async function deleteBottleFromDB(id) {
    if (!state.supabaseClient || !state.currentUser) return;

    // Fetch details before deletion so we can log the movement
    const { data: holding } = await state.supabaseClient
        .from('user_wines')
        .select('wine_id, qty, purchase_price')
        .eq('id', id)
        .eq('user_id', state.currentUser.id)
        .maybeSingle();

    const { error } = await state.supabaseClient
        .from('user_wines')
        .delete()
        .eq('id', id)
        .eq('user_id', state.currentUser.id);
    if (error) throw error;

    if (holding) {
        await logAssetMovement({
            assetType:    'wine',
            wineId:       holding.wine_id,
            movementType: 'sell',
            qty:          holding.qty,
            price:        holding.purchase_price,
            totalValue:   (holding.qty || 0) * (holding.purchase_price || 0),
            notes:        'Bottle removed from cellar',
        });
    }
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

// ── Asset Movements (backlog) ─────────────────────────────────────────────────

/**
 * Append a row to the asset_movements backlog table.
 * Silently swallows errors — movement logging is non-critical.
 *
 * @param {object} opts
 * @param {'wine'|'stock'} opts.assetType
 * @param {string}  [opts.wineId]        - UUID from the wines table
 * @param {string}  [opts.stockTicker]   - symbol from the positions table
 * @param {string}  opts.movementType    - one of the allowed movement_type values
 * @param {number}  [opts.qty]
 * @param {number}  [opts.price]
 * @param {number}  [opts.totalValue]
 * @param {string}  [opts.notes]
 * @param {string}  [opts.movedAt]       - ISO timestamp; defaults to now
 */
export async function logAssetMovement({
    assetType, wineId, stockTicker, movementType,
    qty, price, totalValue, notes, movedAt,
}) {
    if (!state.supabaseClient || !state.currentUser) return;
    try {
        await state.supabaseClient.from('asset_movements').insert({
            user_id:      state.currentUser.id,
            asset_type:   assetType,
            wine_id:      wineId       || null,
            stock_ticker: stockTicker  || null,
            movement_type: movementType,
            qty:          qty          ?? null,
            price:        price        ?? null,
            total_value:  totalValue   ?? null,
            notes:        notes        || null,
            moved_at:     movedAt      || new Date().toISOString(),
        });
    } catch (err) {
        console.warn('logAssetMovement failed (non-critical):', err.message);
    }
}

// ── Wine Price History ────────────────────────────────────────────────────────

/**
 * Append an AI valuation result to wine_price_history.
 * Called by valuation.js after each successful Claude API call.
 * Also updates wines.drink_window if the valuation returned one.
 *
 * @param {object} bottle - in-memory bottle object (must have wineId)
 */
export async function saveWinePriceHistory(bottle) {
    if (!state.supabaseClient || !state.currentUser) return;
    if (!bottle.wineId || !bottle.estimatedValue) return;
    try {
        await state.supabaseClient.from('wine_price_history').insert({
            wine_id:       bottle.wineId,
            user_id:       state.currentUser.id,
            price:         bottle.estimatedValue,
            value_low:     bottle.valueLow     ?? null,
            value_high:    bottle.valueHigh    ?? null,
            valuation_note: bottle.valuationNote || null,
            drink_window:  bottle.drinkWindow  || null,
            source:        'claude_ai',
            fetched_at:    bottle.lastValuedAt || new Date().toISOString(),
        });

        // Keep the shared wines.drink_window up to date
        if (bottle.drinkWindow) {
            await state.supabaseClient
                .from('wines')
                .update({ drink_window: bottle.drinkWindow, updated_at: new Date().toISOString() })
                .eq('id', bottle.wineId);
        }
    } catch (err) {
        console.warn('saveWinePriceHistory failed (non-critical):', err.message);
    }
}

/**
 * Wine storage service — Supabase DB + auth for the Wine Cellar Tracker.
 *
 * Self-contained: does not import from services/ to avoid pulling in
 * stock-portfolio-specific logic. Auth UI is handled here independently.
 */

import state from './state.js?v=3.20.0';
import { showToast, escapeHTML } from './utils.js?v=3.20.0';
import { normalizeWineName } from '../src/wine.js';

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

            if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
                // INITIAL_SESSION fires on page load when a session already exists
                // (navigating from another page). SIGNED_IN fires on explicit login.
                if (state.currentUser) {
                    loadFromDatabase().then(onLoad);
                } else if (event === 'INITIAL_SESSION') {
                    // No active session on load — render the empty state immediately
                    if (onLoad) onLoad();
                }
            } else if (event === 'SIGNED_OUT') {
                state.cellar = [];
                state.cellarHistory = [];
                if (onLoad) onLoad();
            }
        });

        // getSession() is kept as a backup for environments where INITIAL_SESSION
        // may fire before the listener is registered. It only refreshes the auth
        // display and does not trigger a second DB load.
        state.supabaseClient.auth.getSession().then(({ data: { session } }) => {
            if (!state.currentUser && session?.user) {
                // INITIAL_SESSION hasn't fired yet (rare race); set user and load.
                state.currentUser = session.user;
                updateAuthBar();
                loadFromDatabase().then(onLoad);
            }
        }).catch(err => console.warn('getSession fallback error:', err));

        console.log('✓ Wine Supabase initialized');
        return true;
    } catch (err) {
        console.error('Wine Supabase init failed:', err);
        return false;
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
    // Strip .html suffix — Vercel cleanUrls serves /wine not /wine.html
    const pathname = window.location.pathname.replace(/\.html$/, '');
    const redirectTo = window.location.origin + pathname;
    console.log('[auth] resetPasswordForEmail →', email, 'redirect:', redirectTo);
    try {
        const { error } = await state.supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        console.log('[auth] resetPasswordForEmail: success');
        showToast(`Password reset email sent to ${email}.`, 'success', 7000);
    } catch (err) {
        console.error('[auth] resetPasswordForEmail failed:', err);
        showToast('Failed to send reset email: ' + err.message, 'error', 8000);
    }
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
                varietal, country, alcohol, type, drink_window
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
        type:           row.wines?.type,
        drinkWindow:    row.wines?.drink_window,
        // Investment data from user_wines
        qty:            row.qty,
        bottleSize:     row.bottle_size     ?? '0.75L',
        purchasePrice:  row.purchase_price,
        purchaseDate:   row.purchase_date,
        storage:        row.storage,
        notes:          row.notes,
        estimatedValue:    row.estimated_value,
        estimatedValueUSD: row.estimated_value_usd ?? null,
        valueLow:          row.value_low,
        valueHigh:         row.value_high,
        confidence:        row.confidence        ?? null,
        valuationNote:     row.valuation_note,
        valuationSources:  row.valuation_sources ?? null,
        lastValuedAt:      row.last_valued_at,
        createdAt:         row.created_at,
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
        type:        bottle.type        || null,
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
        user_id:             state.currentUser.id,
        wine_id:             wineId,
        qty:                 bottle.qty,
        bottle_size:         bottle.bottleSize       || '0.75L',
        purchase_price:      bottle.purchasePrice    ?? null,
        purchase_date:       bottle.purchaseDate     || null,
        storage:             bottle.storage          || null,
        notes:               bottle.notes            || null,
        estimated_value:     bottle.estimatedValue   ?? null,
        estimated_value_usd: bottle.estimatedValueUSD ?? null,
        value_low:           bottle.valueLow         ?? null,
        value_high:          bottle.valueHigh        ?? null,
        confidence:          bottle.confidence       || null,
        valuation_note:      bottle.valuationNote    || null,
        valuation_sources:   bottle.valuationSources || null,
        last_valued_at:      bottle.lastValuedAt     || null,
        updated_at:          new Date().toISOString(),
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

// ── Duplicate Detection & Merging ─────────────────────────────────────────────

/**
 * Find any existing user_wines rows for the same wine (name + winery + vintage).
 * Used before adding a new bottle to detect duplicates.
 *
 * @param {string} name
 * @param {string|null} winery
 * @param {number|null} vintage
 * @returns {Promise<Array>} existing user_wines rows (empty = no duplicate)
 */
export async function findExistingUserWineHoldings(name, winery, vintage) {
    if (!state.supabaseClient || !state.currentUser || !name) return [];

    async function _queryWineCatalog(nameToSearch) {
        let q = state.supabaseClient
            .from('wines')
            .select('id')
            .ilike('name', nameToSearch);
        if (vintage) {
            q = q.eq('vintage', vintage);
        } else {
            q = q.is('vintage', null);
        }
        if (winery) {
            q = q.ilike('winery', winery);
        } else {
            q = q.is('winery', null);
        }
        const { data } = await q.maybeSingle();
        return data;
    }

    // Step 1: find wine in shared catalog — try original name first, then normalized (strips diacritics)
    let wineData = await _queryWineCatalog(name);
    if (!wineData) {
        const normalized = normalizeWineName(name);
        if (normalized && normalized !== name.toLowerCase()) {
            wineData = await _queryWineCatalog(normalized);
        }
    }
    if (!wineData) return [];

    // Step 2: find all user holdings for this wine
    const { data: holdings } = await state.supabaseClient
        .from('user_wines')
        .select('*')
        .eq('user_id', state.currentUser.id)
        .eq('wine_id', wineData.id)
        .order('created_at', { ascending: true });

    return holdings || [];
}

/**
 * Find all duplicate user_wines groups (same wine_id, same user) and merge them.
 * Merges by: summing qty, weighted-average purchase price, keeping best valuation.
 *
 * @returns {Promise<{winesFixed: number, bottlesMerged: number}>}
 */
export async function findAndMergeDuplicates() {
    if (!state.supabaseClient || !state.currentUser) return { winesFixed: 0, bottlesMerged: 0 };

    const { data, error } = await state.supabaseClient
        .from('user_wines')
        .select('*, wines(name, winery, vintage)')
        .eq('user_id', state.currentUser.id)
        .order('created_at', { ascending: true });

    if (error || !data) return { winesFixed: 0, bottlesMerged: 0 };

    // Group by wine_id
    const groups = {};
    for (const row of data) {
        if (!groups[row.wine_id]) groups[row.wine_id] = [];
        groups[row.wine_id].push(row);
    }

    const duplicateGroups = Object.values(groups).filter(g => g.length > 1);

    let winesFixed = 0;
    let bottlesMerged = 0;

    for (const group of duplicateGroups) {
        await _mergeDuplicateGroup(group);
        winesFixed++;
        bottlesMerged += group.length - 1;
    }

    return { winesFixed, bottlesMerged };
}

/**
 * Merge a group of duplicate user_wines rows (all same wine_id, same user).
 * Keeps the oldest row (rows[0], sorted by created_at ASC), deletes the rest.
 */
async function _mergeDuplicateGroup(rows) {
    const primary     = rows[0];
    const secondaries = rows.slice(1);

    // Sum quantities
    const totalQty = rows.reduce((sum, r) => sum + (r.qty || 0), 0);

    // Weighted average purchase price (only for rows that have one)
    const withPrice = rows.filter(r => r.purchase_price != null && r.purchase_price > 0);
    let mergedPrice = primary.purchase_price;
    if (withPrice.length > 0) {
        const totalCost    = withPrice.reduce((s, r) => s + (r.qty || 0) * r.purchase_price, 0);
        const totalQtyP    = withPrice.reduce((s, r) => s + (r.qty || 0), 0);
        mergedPrice = totalQtyP > 0 ? totalCost / totalQtyP : null;
    }

    // Best valuation: most recently valued row
    const withVal = rows
        .filter(r => r.last_valued_at)
        .sort((a, b) => new Date(b.last_valued_at) - new Date(a.last_valued_at));
    const best = withVal[0] || null;

    await state.supabaseClient
        .from('user_wines')
        .update({
            qty:                 totalQty,
            purchase_price:      mergedPrice,
            estimated_value:     best?.estimated_value     ?? primary.estimated_value,
            estimated_value_usd: best?.estimated_value_usd ?? primary.estimated_value_usd,
            value_low:           best?.value_low           ?? primary.value_low,
            value_high:          best?.value_high          ?? primary.value_high,
            confidence:          best?.confidence          ?? primary.confidence,
            valuation_note:      best?.valuation_note      ?? primary.valuation_note,
            valuation_sources:   best?.valuation_sources   ?? primary.valuation_sources,
            last_valued_at:      best?.last_valued_at      ?? primary.last_valued_at,
            updated_at:          new Date().toISOString(),
        })
        .eq('id', primary.id);

    for (const row of secondaries) {
        await state.supabaseClient
            .from('user_wines')
            .delete()
            .eq('id', row.id)
            .eq('user_id', state.currentUser.id);
    }
}

// ── Wine Price History ────────────────────────────────────────────────────────

/**
 * Append an AI valuation result to wine_price_history.
 * Called by valuation.js after each successful AI valuation call (Gemini primary, Claude fallback).
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
            source:        bottle._aiSource || 'gemini_ai',
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

/**
 * Spend storage — Supabase DB + auth for the Spend module.
 *
 * Self-contained by design: no imports from services/, so the module could be
 * lifted out without dragging the stock portfolio's dependency graph with it
 * (the lesson from the wine extraction). Auth is handled here independently,
 * matching wine/storage.js.
 */

import state from './state.js?v=3.43.1';
import { showToast } from './utils.js?v=3.43.1';

// ── Supabase init ───────────────────────────────────────────────────────────

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
                if (state.currentUser) {
                    // .catch is not optional: onLoad is async, no page installs
                    // an unhandledrejection handler, and a load failure would
                    // otherwise vanish while the UI renders a convincing empty
                    // state that is indistinguishable from "no data yet".
                    loadFromDatabase().then(onLoad).catch(err => {
                        console.error('Load failed:', err);
                        state.loadFailed = true;
                        try { onLoad?.(); } catch { /* render anyway */ }
                    });
                } else if (event === 'INITIAL_SESSION') {
                    if (onLoad) onLoad();
                }
            } else if (event === 'SIGNED_OUT') {
                clearLocalData();
                if (onLoad) onLoad();
            }
        });

        // Backup for the rare race where INITIAL_SESSION fires before the
        // listener registers. Does not trigger a second load on the happy path.
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

        console.log('✓ Spend Supabase initialized');
        return true;
    } catch (err) {
        console.error('Spend Supabase init failed:', err);
        return false;
    }
}

function clearLocalData() {
    state.accounts = [];
    state.transactions = [];
    state.categories = [];
    state.rules = [];
    state.recurring = [];
    state.profiles = [];
    state.pendingDetails = [];
    state.scenarios = [];
}

// ── Auth UI ─────────────────────────────────────────────────────────────────

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

// ── Auth actions ────────────────────────────────────────────────────────────

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
    // Strip .html — Vercel cleanUrls serves /spend, not /spend.html
    const pathname = window.location.pathname.replace(/\.html$/, '');
    const redirectTo = window.location.origin + pathname;
    try {
        const { error } = await state.supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
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

export function cancelPasswordRecovery() {
    state.passwordRecoveryMode = false;
    updateAuthBar();
}

export async function handleLogout() {
    try {
        await state.supabaseClient.auth.signOut();
        state.currentUser = null;
        clearLocalData();
        updateAuthBar();
    } catch (err) { console.error('Logout error:', err); }
}

// ── row mapping ─────────────────────────────────────────────────────────────
// The DB is snake_case, the module is camelCase. Mapping lives here and only
// here, so no other file has to know both spellings.

/** How many transactions the page holds. One more is fetched to detect truncation. */
const TX_LIMIT = 20000;

const txFromRow = r => ({
    id: r.id,
    accountId: r.account_id,
    date: r.date,
    description: r.description,
    rawDescription: r.raw_description,
    merchant: r.merchant,
    amount: Number(r.amount),
    currency: r.currency || 'EUR',
    fxRates: r.fx_rates || null,
    category: r.category,
    categorySource: r.category_source,
    categoryConfidence: r.category_confidence === null ? null : Number(r.category_confidence),
    enrichedFrom: r.enriched_from,
    transferPairId: r.transfer_pair_id,
    recurringId: r.recurring_id,
    source: r.source,
    fingerprint: r.fingerprint,
    note: r.note,
    needsReview: !!r.needs_review
});

const txToRow = (t, userId) => ({
    ...(t.id ? { id: t.id } : {}),
    user_id: userId,
    account_id: t.accountId,
    date: String(t.date).slice(0, 10),
    description: t.description || '(no description)',
    raw_description: t.rawDescription || t.description || null,
    merchant: t.merchant || null,
    amount: Number(t.amount),
    currency: t.currency || 'EUR',
    fx_rates: t.fxRates || null,
    category: t.category || null,
    category_source: t.categorySource || null,
    category_confidence: t.categoryConfidence ?? null,
    enriched_from: t.enrichedFrom || null,
    transfer_pair_id: t.transferPairId || null,
    recurring_id: t.recurringId || null,
    source: t.source || 'manual',
    fingerprint: t.fingerprint,
    note: t.note || null,
    needs_review: !!t.needsReview
});

const accountFromRow = r => ({
    id: r.id, bankName: r.bank_name, label: r.account_label, type: r.account_type,
    currency: r.currency || 'EUR', linkedAccountId: r.linked_account_id,
    colour: r.colour, lastImportedAt: r.last_imported_at, archived: !!r.archived
});

const profileFromRow = r => ({
    id: r.id, accountId: r.account_id, label: r.label, sourceRole: r.source_role,
    formatKind: r.format_kind, signature: r.signature, columnMap: r.column_map || {},
    dateFormat: r.date_format, decimalStyle: r.decimal_style, invertSign: !!r.invert_sign,
    skipRows: r.skip_rows || 0, balanceCol: r.balance_col, valueDateCol: r.value_date_col,
    pdfHint: r.pdf_hint, confirmedAt: r.confirmed_at
});

const ruleFromRow = r => ({
    id: r.id, matchType: r.match_type, pattern: r.pattern, category: r.category,
    merchant: r.merchant, priority: r.priority || 0, hitCount: r.hit_count || 0
});

// ── load ────────────────────────────────────────────────────────────────────

export async function loadFromDatabase() {
    if (!state.supabaseClient || !state.currentUser) return;
    console.log('=== SPEND LOAD FROM DATABASE ===');
    state.loading = true;
    const uid = state.currentUser.id;
    const sb = state.supabaseClient;

    try {
        const [accounts, transactions, categories, rules, recurring, profiles, pending, scenarios] =
            await Promise.all([
                sb.from('spend_accounts').select('*').eq('user_id', uid).order('created_at'),
                // Bounded: the dashboard never looks further back than the trend
                // chart, and an unbounded select on a multi-year ledger is the
                // one query here that could get genuinely slow.
                // Explicit columns, not `*`: created_at is never mapped, and
                // fx_rates / category_confidence / recurring_id / note are
                // mapped but read by no UI or maths path — together roughly a
                // quarter of the payload. (saveTransactions writes a full row,
                // but is only ever called with freshly parsed or quick-add
                // rows, never with rows loaded from here, so nothing is nulled.)
                //
                // LIMIT is one more than we keep: if the extra row comes back,
                // the history was truncated, and the oldest rows are exactly
                // what year-on-year needs. Reporting a truncation as "history
                // starts here" would be a confident lie.
                sb.from('spend_transactions')
                    .select('id,account_id,date,description,raw_description,merchant,amount,currency,' +
                            'category,category_source,enriched_from,transfer_pair_id,source,fingerprint,needs_review')
                    .eq('user_id', uid)
                    .order('date', { ascending: false }).limit(TX_LIMIT + 1),
                sb.from('spend_categories').select('*').eq('user_id', uid).order('sort_order'),
                sb.from('spend_rules').select('*').eq('user_id', uid).order('priority', { ascending: false }),
                sb.from('spend_recurring').select('*').eq('user_id', uid),
                sb.from('spend_bank_profiles').select('*').eq('user_id', uid),
                sb.from('spend_pending_details').select('*').eq('user_id', uid),
                sb.from('spend_scenarios').select('*').eq('user_id', uid).order('updated_at', { ascending: false })
            ]);

        const firstError = [accounts, transactions, categories, rules, recurring, profiles, pending, scenarios]
            .map(r => r.error).find(Boolean);
        if (firstError) throw firstError;

        state.accounts = (accounts.data || []).map(accountFromRow);
        const txRows = transactions.data || [];
        state.ledgerTruncated = txRows.length > TX_LIMIT;
        state.transactions = txRows.slice(0, TX_LIMIT).map(txFromRow);
        if (state.ledgerTruncated) {
            console.warn(`⚠ Ledger truncated at ${TX_LIMIT} rows — older history is not loaded.`);
        }
        state.categories = (categories.data || []).map(r => ({
            id: r.id, name: r.name, icon: r.icon, colour: r.colour,
            sortOrder: r.sort_order, isIncome: !!r.is_income,
            countsAsSavings: !!r.counts_as_savings
        }));
        state.rules = (rules.data || []).map(ruleFromRow);
        state.recurring = (recurring.data || []).map(r => ({
            id: r.id, merchant: r.merchant, category: r.category, amount: Number(r.amount),
            currency: r.currency, cadenceDays: r.cadence_days, nextExpected: r.next_expected,
            status: r.status, confidence: r.confidence === null ? null : Number(r.confidence)
        }));
        state.profiles = (profiles.data || []).map(profileFromRow);
        state.pendingDetails = (pending.data || []).map(r => ({
            id: r.id, accountId: r.account_id, date: r.date, description: r.description,
            merchant: r.merchant, amount: Number(r.amount), currency: r.currency,
            source: r.source, fingerprint: r.fingerprint
        }));
        state.scenarios = (scenarios.data || []).map(r => ({
            id: r.id, name: r.name, levers: r.levers || { horizonMonths: 12, levers: [] },
            basedOn: r.based_on, updatedAt: r.updated_at
        }));

        console.log(`✓ Spend DB loaded: ${state.transactions.length} transactions, ` +
                    `${state.accounts.length} accounts, ${state.rules.length} rules`);
    } catch (err) {
        console.error('❌ Spend loadFromDatabase error:', err);
        showToast('Could not load spending data: ' + err.message, 'error', 7000);
    } finally {
        state.loading = false;
    }
}

// ── writes ──────────────────────────────────────────────────────────────────

/**
 * Insert transactions.
 *
 * Deliberately an upsert on the (user_id, account_id, fingerprint) unique index
 * rather than the delete-all-then-reinsert used by the stock ledger. At hundreds
 * of rows a month across five accounts, wiping and rewriting the table on every
 * import would be slow, and a single bad row would abort the whole batch.
 * Chunked so one oversized import does not exceed the request limit.
 */
export async function saveTransactions(rows) {
    if (!requireAuth('save transactions') || !rows?.length) return { saved: 0 };
    const uid = state.currentUser.id;
    const payload = rows.map(t => txToRow(t, uid));
    const CHUNK = 500;
    let saved = 0;

    // Index once: a findIndex per returned row is O(batch × ledger), which at a
    // 5,000-row import against a large ledger is hundreds of milliseconds of
    // pure scanning.
    const indexById = new Map(state.transactions.map((t, i) => [t.id, i]));

    for (let i = 0; i < payload.length; i += CHUNK) {
        const slice = payload.slice(i, i + CHUNK);
        const { data, error } = await state.supabaseClient
            .from('spend_transactions')
            .upsert(slice, { onConflict: 'user_id,account_id,fingerprint', ignoreDuplicates: false })
            .select();
        if (error) {
            // Chunks before this one are already committed. Throwing a bare
            // error made commitImport say "Could not save", implying nothing
            // was written — so the user would retry the whole file believing
            // they had lost it. Carry the count so the message can be true.
            const partial = new Error(error.message);
            partial.saved = saved;
            partial.remaining = payload.length - saved;
            throw partial;
        }
        saved += (data || []).length;
        for (const row of data || []) {
            const mapped = txFromRow(row);
            const idx = indexById.get(mapped.id);
            if (idx !== undefined) state.transactions[idx] = mapped;
            else {
                indexById.set(mapped.id, state.transactions.length);
                state.transactions.push(mapped);
            }
        }
    }
    state.transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { saved };
}

export async function updateTransaction(id, patch) {
    if (!requireAuth('edit a transaction')) return null;
    const row = {};
    if ('category' in patch) { row.category = patch.category; row.category_source = patch.categorySource || 'manual'; }
    if ('merchant' in patch) row.merchant = patch.merchant;
    if ('description' in patch) row.description = patch.description;
    if ('amount' in patch) row.amount = Number(patch.amount);
    if ('date' in patch) row.date = String(patch.date).slice(0, 10);
    if ('note' in patch) row.note = patch.note;
    if ('needsReview' in patch) row.needs_review = !!patch.needsReview;
    if ('transferPairId' in patch) row.transfer_pair_id = patch.transferPairId;

    const { data, error } = await state.supabaseClient
        .from('spend_transactions').update(row)
        .eq('id', id).eq('user_id', state.currentUser.id).select().single();
    if (error) throw error;

    const mapped = txFromRow(data);
    const idx = state.transactions.findIndex(t => t.id === id);
    if (idx >= 0) state.transactions[idx] = mapped;
    return mapped;
}

export async function deleteTransaction(id) {
    if (!requireAuth('delete a transaction')) return;
    const { error } = await state.supabaseClient
        .from('spend_transactions').delete().eq('id', id).eq('user_id', state.currentUser.id);
    if (error) throw error;
    state.transactions = state.transactions.filter(t => t.id !== id);
}

export async function saveAccount(account) {
    if (!requireAuth('save an account')) return null;
    const row = {
        ...(account.id ? { id: account.id } : {}),
        user_id: state.currentUser.id,
        bank_name: account.bankName,
        account_label: account.label,
        account_type: account.type || 'checking',
        currency: account.currency || 'EUR',
        linked_account_id: account.linkedAccountId || null,
        colour: account.colour || null,
        archived: !!account.archived
    };
    const { data, error } = await state.supabaseClient
        .from('spend_accounts').upsert(row).select().single();
    if (error) throw error;
    const mapped = accountFromRow(data);
    const idx = state.accounts.findIndex(a => a.id === mapped.id);
    if (idx >= 0) state.accounts[idx] = mapped; else state.accounts.push(mapped);
    return mapped;
}

export async function deleteAccount(id) {
    if (!requireAuth('delete an account')) return;
    const { error } = await state.supabaseClient
        .from('spend_accounts').delete().eq('id', id).eq('user_id', state.currentUser.id);
    if (error) throw error;
    state.accounts = state.accounts.filter(a => a.id !== id);
    // The FK cascades in the DB; mirror it in memory so the UI agrees.
    state.transactions = state.transactions.filter(t => t.accountId !== id);
}

export async function saveProfile(profile) {
    if (!requireAuth('save a bank profile')) return null;
    const row = {
        ...(profile.id ? { id: profile.id } : {}),
        user_id: state.currentUser.id,
        account_id: profile.accountId || null,
        label: profile.label || null,
        source_role: profile.sourceRole || 'statement',
        format_kind: profile.formatKind || 'csv',
        signature: profile.signature,
        column_map: profile.columnMap || {},
        date_format: profile.dateFormat || null,
        decimal_style: profile.decimalStyle || 'eu',
        invert_sign: !!profile.invertSign,
        skip_rows: profile.skipRows || 0,
        balance_col: profile.balanceCol || null,
        value_date_col: profile.valueDateCol || null,
        pdf_hint: profile.pdfHint || null,
        confirmed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    const { data, error } = await state.supabaseClient
        .from('spend_bank_profiles').upsert(row, { onConflict: 'user_id,signature' }).select().single();
    if (error) throw error;
    const mapped = profileFromRow(data);
    const idx = state.profiles.findIndex(p => p.signature === mapped.signature);
    if (idx >= 0) state.profiles[idx] = mapped; else state.profiles.push(mapped);
    return mapped;
}

export async function saveRule(rule) {
    if (!requireAuth('save a rule')) return null;
    const row = {
        ...(rule.id ? { id: rule.id } : {}),
        user_id: state.currentUser.id,
        match_type: rule.matchType || 'contains',
        pattern: rule.pattern,
        category: rule.category,
        merchant: rule.merchant || null,
        priority: rule.priority || 0,
        updated_at: new Date().toISOString()
    };
    const { data, error } = await state.supabaseClient
        .from('spend_rules').upsert(row).select().single();
    if (error) throw error;
    const mapped = ruleFromRow(data);
    const idx = state.rules.findIndex(r => r.id === mapped.id);
    if (idx >= 0) state.rules[idx] = mapped; else state.rules.unshift(mapped);
    return mapped;
}

export async function savePendingDetails(rows) {
    if (!requireAuth('save pending details') || !rows?.length) return;
    const uid = state.currentUser.id;
    const payload = rows.map(r => ({
        user_id: uid, account_id: r.accountId || null,
        date: String(r.date).slice(0, 10), description: r.description,
        merchant: r.merchant || null, amount: Number(r.amount),
        currency: r.currency || 'EUR', source: r.source || null, fingerprint: r.fingerprint
    }));
    const { error } = await state.supabaseClient
        .from('spend_pending_details')
        .upsert(payload, { onConflict: 'user_id,fingerprint', ignoreDuplicates: true });
    if (error) throw error;
}

export async function clearPendingDetails(fingerprints = []) {
    if (!state.currentUser || !fingerprints.length) return;
    const { error } = await state.supabaseClient
        .from('spend_pending_details').delete()
        .eq('user_id', state.currentUser.id).in('fingerprint', fingerprints);
    if (error) throw error;
    const gone = new Set(fingerprints);
    state.pendingDetails = state.pendingDetails.filter(p => !gone.has(p.fingerprint));
}

export async function saveScenario(scenario) {
    if (!requireAuth('save a scenario')) return null;
    const row = {
        ...(scenario.id ? { id: scenario.id } : {}),
        user_id: state.currentUser.id,
        name: scenario.name,
        levers: scenario.levers,
        based_on: scenario.basedOn || null,
        updated_at: new Date().toISOString()
    };
    const { data, error } = await state.supabaseClient
        .from('spend_scenarios').upsert(row).select().single();
    if (error) throw error;
    const mapped = { id: data.id, name: data.name, levers: data.levers, basedOn: data.based_on, updatedAt: data.updated_at };
    const idx = state.scenarios.findIndex(s => s.id === mapped.id);
    if (idx >= 0) state.scenarios[idx] = mapped; else state.scenarios.unshift(mapped);
    return mapped;
}

export async function deleteScenario(id) {
    if (!requireAuth('delete a scenario')) return;
    const { error } = await state.supabaseClient
        .from('spend_scenarios').delete().eq('id', id).eq('user_id', state.currentUser.id);
    if (error) throw error;
    state.scenarios = state.scenarios.filter(s => s.id !== id);
}

/** Seed a first-time user so the module is usable before any import. */
export async function ensureDefaultCategories() {
    if (!state.currentUser || state.categories.length) return;
    const defaults = [
        ['Groceries', '🛒', false], ['Dining', '🍽️', false], ['Transport', '🚗', false],
        ['Housing', '🏠', false], ['Utilities', '💡', false], ['Health', '⚕️', false],
        ['Subscriptions', '🔁', false], ['Shopping', '🛍️', false], ['Leisure', '🎬', false],
        ['Travel', '✈️', false], ['Fees', '🏦', false],
        ['Salary', '💼', true], ['Other income', '➕', true]
    ];
    const payload = defaults.map(([name, icon, isIncome], i) => ({
        user_id: state.currentUser.id, name, icon, sort_order: i,
        is_income: isIncome, counts_as_savings: false
    }));
    const { data, error } = await state.supabaseClient
        .from('spend_categories').insert(payload).select();
    if (error) { console.warn('Could not seed categories:', error.message); return; }
    state.categories = (data || []).map(r => ({
        id: r.id, name: r.name, icon: r.icon, colour: r.colour,
        sortOrder: r.sort_order, isIncome: !!r.is_income, countsAsSavings: !!r.counts_as_savings
    }));
}

export function incomeCategoryNames() {
    return state.categories.filter(c => c.isIncome).map(c => c.name);
}

/** Categories whose outflows are saved or invested rather than consumed. */
export function savingsCategoryNames() {
    return state.categories.filter(c => c.countsAsSavings).map(c => c.name);
}

// ── category CRUD ───────────────────────────────────────────────────────────

export async function saveCategory(category) {
    if (!requireAuth('save a category')) return null;
    const name = String(category.name || '').trim();
    if (!name) throw new Error('A category needs a name.');
    if (name.toLowerCase() === 'transfer') {
        // 'transfer' is reserved by isTransfer() throughout the maths; a
        // user-made category with that name would silently vanish from every
        // total.
        throw new Error('"transfer" is reserved — pick another name.');
    }
    const clash = state.categories.find(c =>
        c.name.toLowerCase() === name.toLowerCase() && c.id !== category.id);
    if (clash) throw new Error(`You already have a category called "${clash.name}".`);

    const row = {
        ...(category.id ? { id: category.id } : {}),
        user_id: state.currentUser.id,
        name,
        icon: category.icon || null,
        colour: category.colour || null,
        sort_order: category.sortOrder ?? state.categories.length,
        is_income: !!category.isIncome,
        counts_as_savings: !!category.countsAsSavings
    };
    const { data, error } = await state.supabaseClient
        .from('spend_categories').upsert(row).select().single();
    if (error) throw error;

    const mapped = { id: data.id, name: data.name, icon: data.icon, colour: data.colour,
        sortOrder: data.sort_order, isIncome: !!data.is_income, countsAsSavings: !!data.counts_as_savings };
    const i = state.categories.findIndex(c => c.id === mapped.id);
    const previousName = i >= 0 ? state.categories[i].name : null;
    if (i >= 0) state.categories[i] = mapped; else state.categories.push(mapped);

    // A rename must rewrite history, not fork it: transactions store the
    // category by name, so leaving old rows on the old name would make a
    // year-on-year comparison run against a category that no longer exists.
    if (previousName && previousName !== mapped.name) {
        await reassignCategory(previousName, mapped.name);
    }
    return mapped;
}

/** Move every transaction from one category name to another (or to none). */
export async function reassignCategory(fromName, toName) {
    if (!requireAuth('move transactions') || !fromName) return 0;
    const { error } = await state.supabaseClient
        .from('spend_transactions')
        .update({ category: toName || null })
        .eq('user_id', state.currentUser.id)
        .eq('category', fromName);
    if (error) throw error;

    let moved = 0;
    for (const t of state.transactions) {
        if (t.category === fromName) { t.category = toName || null; moved++; }
    }
    // Rules pointing at the old name would keep recreating it on the next import.
    for (const r of state.rules) if (r.category === fromName) r.category = toName || null;
    return moved;
}

/**
 * Delete a category, moving its transactions somewhere first.
 *
 * Reassignment is mandatory rather than optional, which also makes this the
 * merge operation — merging is just reassigning A to B and deleting A. Building
 * both would be two features for one behaviour.
 */
export async function deleteCategory(id, { reassignTo = null } = {}) {
    if (!requireAuth('delete a category')) return 0;
    const category = state.categories.find(c => c.id === id);
    if (!category) return 0;

    const moved = await reassignCategory(category.name, reassignTo);

    const { error } = await state.supabaseClient
        .from('spend_categories').delete().eq('id', id).eq('user_id', state.currentUser.id);
    if (error) throw error;
    state.categories = state.categories.filter(c => c.id !== id);
    return moved;
}

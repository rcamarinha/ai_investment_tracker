/**
 * Admin page: invite people by email, see who has joined, and revoke an
 * invitation nobody has accepted.
 *
 * The browser never holds the power to invite. Every action goes to the
 * admin-invite edge function, which checks admin_users with the service role and
 * refuses anyone else. This page makes no admin decision of its own — it asks,
 * then renders whatever the function allowed. Hiding it from a non-admin is
 * courtesy, not the boundary.
 *
 * Self-contained like holdings/storage.js: its own Supabase client and auth
 * listener, importing nothing from the portfolio's service graph. Sign-in
 * actions come from services/account.js instead of a sixth copy of the handlers.
 */
import state from './state.js';
import { escapeHTML, showToast, bindActions } from './utils.js';
import { reportHandled, setTelemetryClient } from './telemetry.js';
import { createAccountActions } from './account.js';
import { t } from '../data/i18n.js';
import { summarizeUsage, summarizeAiUsage } from './admin-report-core.js';

let access = 'loading';      // loading | signed-out | denied | ready | unavailable
let people = [];
let pendingRevoke = null;    // id waiting for a second, confirming click
let revokeTimer = null;
const REVOKE_ARM_MS = 5000;
let sending = false;
let loadedFor;               // user id the list was last loaded for
let usage = null;            // summarizeUsage() output
let usageState = 'idle';     // idle | loading | ready | missing | error
let aiUsage = null;          // summarizeAiUsage() output
let aiState = 'idle';        // same states, for admin_ai_usage_report

const account = createAccountActions({
    getClient: () => state.supabaseClient,
    redirectTo: () => window.location.origin + window.location.pathname.replace(/\.html$/, ''),
});

const STATUS = {
    pending:  { label: 'Invited, not accepted yet', color: 'var(--gold)' },
    accepted: { label: 'Joined by invitation',      color: 'var(--up)' },
    member:   { label: 'Account',                   color: 'var(--text-secondary)' },
    unknown:  { label: 'Unknown',                   color: 'var(--text-tertiary)' },
};

function fmtDate(iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Talking to the function ─────────────────────────────────────────────────

async function callAdmin(payload) {
    const client = state.supabaseClient;
    if (!client) return { status: 0, body: { error: 'Sign-in is not ready yet. Refresh the page.' } };
    const { data: { session } } = await client.auth.getSession();
    if (!session?.access_token) return { status: 401, body: { error: 'Sign in first.' } };

    const res = await fetch(`${state.supabaseUrl}/functions/v1/admin-invite`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: state.supabaseAnonKey,
            Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
    });
    let body = {};
    try { body = await res.json(); } catch { /* a gateway error page is not JSON */ }
    return { status: res.status, body: body || {} };
}

// An answer we can show as it stands: our own `error`, from a request the
// function itself refused or could not complete. Only a reply with no message
// of ours — a gateway 404 because the function is not deployed, an HTML error
// page — is treated as a failure of the call.
const isAnswer = r => r.status >= 400 && typeof r.body?.error === 'string';

// The function tells an administrator why something failed; a non-admin gets
// nothing. Show the reason when it is there — it is the only copy the one
// person who can act on it will see.
const reasonFrom = r => [r.body?.error, r.body?.detail].filter(Boolean).join(' — ');

async function loadAccess() {
    if (!state.currentUser) {
        access = 'signed-out';
        people = [];
        render();
        return;
    }
    access = 'loading';
    render();
    await loadPeople();
}

async function loadPeople() {
    try {
        const r = await callAdmin({ action: 'list' });
        if (r.status === 200) {
            people = Array.isArray(r.body.people) ? r.body.people : [];
            access = 'ready';
        } else if (r.status === 401) {
            access = 'signed-out';
        } else if (r.status === 403) {
            access = 'denied';
        } else if (isAnswer(r)) {
            access = 'ready';
            people = [];
            showToast(reasonFrom(r), 'error', 14000);
        } else {
            throw new Error(r.body?.error || r.body?.message || `admin-invite answered ${r.status}`);
        }
    } catch (err) {
        // A gateway rejection carries no CORS headers, so it arrives here as a
        // bare "Failed to fetch". Usually the function is not deployed yet.
        access = 'unavailable';
        showToast(`Could not reach the invitations service: ${err.message}`, 'error', 9000);
        reportHandled(err, { action: 'admin-list' });
    }
    pendingRevoke = null;
    render();
    // The usage panels come from the database, not the invitations function,
    // so an unreachable function must not hide them. Each report checks
    // admin_users itself and refuses anyone else.
    if (access === 'ready' || access === 'unavailable') { loadUsage(); loadAiUsage(); }
}

// AI and API usage: one row per model call, recorded by the edge functions
// (supabase/migrations/20260919_usage_events.sql). Like the usage report, a
// missing function means the migration has not run yet — a state, not an error.
async function loadAiUsage() {
    if (!state.supabaseClient) return;
    if (aiState !== 'ready') { aiState = 'loading'; render(); }
    try {
        const { data, error } = await state.supabaseClient.rpc('admin_ai_usage_report');
        if (error) {
            if (error.code === 'PGRST202') { aiState = 'missing'; render(); return; }
            if (error.code === '42501') { aiState = 'denied'; render(); return; }
            throw new Error(error.message || String(error));
        }
        aiUsage = summarizeAiUsage(data);
        aiState = 'ready';
    } catch (err) {
        aiState = 'error';
        showToast(`AI usage could not be loaded: ${err.message}`, 'error', 9000);
        reportHandled(err, { action: 'admin-ai-usage' });
    }
    render();
}

// Usage comes from a database function, not the invite function: it reads
// across accounts, checks admin_users itself, and returns counts and dates only
// (see supabase/migrations/20260918_admin_usage_report.sql). The page must work
// before that migration has run, so a missing function is a state, not an error.
async function loadUsage() {
    if (!state.supabaseClient) return;
    if (usageState !== 'ready') { usageState = 'loading'; render(); }
    try {
        const { data, error } = await state.supabaseClient.rpc('admin_usage_report');
        if (error) {
            if (error.code === 'PGRST202') { usageState = 'missing'; render(); return; }
            if (error.code === '42501') { usageState = 'denied'; render(); return; }
            throw new Error(error.message || String(error));
        }
        usage = summarizeUsage(data);
        usageState = 'ready';
    } catch (err) {
        usageState = 'error';
        showToast(`Usage could not be loaded: ${err.message}`, 'error', 9000);
        reportHandled(err, { action: 'admin-usage' });
    }
    render();
}

async function sendInvite() {
    if (sending) return;
    const input = document.getElementById('inviteEmail');
    const email = (input?.value || '').trim();
    if (!email) {
        showToast('Enter an email address.', 'warning');
        input?.focus();
        return;
    }

    sending = true;
    setSendButton();
    try {
        const r = await callAdmin({ action: 'invite', email });
        if (r.status === 200) {
            showToast(`Invitation sent to ${r.body.invited || email}.`, 'success', 6000);
            if (input) input.value = '';
            await loadPeople();
        } else if (isAnswer(r)) {
            showToast(reasonFrom(r), 'warning', 14000);
            reportHandled(new Error(reasonFrom(r)), { action: 'admin-invite' });
            // The account can exist even when the email did not go out, so the
            // list must be re-read rather than assumed unchanged.
            if (r.status >= 500) await loadPeople();
            else if (r.status === 401 || r.status === 403) await loadAccess();
        } else {
            throw new Error(r.body?.error || r.body?.message || `admin-invite answered ${r.status}`);
        }
    } catch (err) {
        showToast(`The invitation was not sent: ${err.message}`, 'error', 9000);
        reportHandled(err, { action: 'admin-invite' });
    } finally {
        sending = false;
        setSendButton();
    }
}

async function revoke(id) {
    if (pendingRevoke !== id) {
        // First click only arms it. Revoking deletes the unaccepted account, so
        // it takes a second, deliberate click rather than a blocking dialog.
        // It disarms on its own, so a stale "Confirm revoke" cannot be fired
        // later by a stray tap on a phone.
        pendingRevoke = id;
        clearTimeout(revokeTimer);
        revokeTimer = setTimeout(() => { pendingRevoke = null; render(); }, REVOKE_ARM_MS);
        render();
        return;
    }
    clearTimeout(revokeTimer);
    pendingRevoke = null;
    try {
        const r = await callAdmin({ action: 'revoke', userId: id });
        if (r.status === 200) showToast('Invitation revoked. Its link no longer works.', 'success', 6000);
        else if (isAnswer(r)) showToast(reasonFrom(r), 'warning', 12000);
        else throw new Error(r.body?.error || r.body?.message || `admin-invite answered ${r.status}`);
    } catch (err) {
        showToast(`The invitation was not revoked: ${err.message}`, 'error', 9000);
        reportHandled(err, { action: 'admin-revoke' });
    }
    await loadPeople();
}

// ── Rendering ───────────────────────────────────────────────────────────────

function setSendButton() {
    const btn = document.querySelector('#adminBody [data-act="invite"]');
    if (!btn) return;
    btn.disabled = sending;
    btn.textContent = sending ? 'Sending…' : 'Send invitation';
}

const notice = text => `<div class="card"><p style="color:var(--text-secondary);margin:0;">${escapeHTML(text)}</p></div>`;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function renderUsage() {
    const card = inner => `<div class="card"><h2 class="section-heading">Usage</h2>${inner}</div>`;
    const quiet = text => `<p style="color:var(--text-secondary);font-size:13px;margin:0;">${escapeHTML(text)}</p>`;
    if (usageState === 'idle' || usageState === 'loading') return card(quiet('Loading usage…'));
    if (usageState === 'missing') return card(quiet('Usage appears once the admin_usage_report migration has been run in the Supabase SQL Editor.'));
    if (usageState === 'error' || !usage) return card(quiet('Usage could not be loaded. Reload the page to try again.'));

    const { totals, tools } = usage;
    const tile = (label, value, cls = '') =>
        `<div class="stat-tile"><div class="st-label">${escapeHTML(label)}</div><div class="st-value ${cls}">${escapeHTML(String(value))}</div></div>`;
    const toolRows = tools.map(tool => `
        <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;">
            <span style="color:var(--text-primary);">${escapeHTML(tool.label)}</span>
            <span style="color:var(--text-secondary);text-align:right;">${escapeHTML(plural(tool.users, 'person', 'people'))} · ${escapeHTML(String(tool.active30))} active this month</span>
        </div>`).join('');

    return card(`
        <div class="stat-tiles">
            ${tile('Accounts', totals.accounts)}
            ${tile('Active · 7 days', totals.active7, 'up')}
            ${tile('Active · 30 days', totals.active30)}
            ${tile('Joined · 30 days', totals.joined30, 'gold')}
        </div>
        <div style="margin-top:14px;">${toolRows}</div>
        <p style="color:var(--text-tertiary);font-size:12px;margin:10px 0 0;">
            Active means signed in, saved something, refreshed prices, or ran an import or valuation.
            Only reading a page leaves no trace, so these are lower bounds.
            ${totals.unused ? escapeHTML(plural(totals.unused, 'account has', 'accounts have')) + ' nothing in any tool yet.' : ''}
        </p>`);
}

const fmtUsd = n => n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
const fmtTokens = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

function renderAiUsage() {
    const card = inner => `<div class="card"><h2 class="section-heading">AI and price lookups · last 30 days</h2>${inner}</div>`;
    const quiet = text => `<p style="color:var(--text-secondary);font-size:13px;margin:0;">${escapeHTML(text)}</p>`;
    if (aiState === 'idle' || aiState === 'loading') return card(quiet('Loading AI usage…'));
    if (aiState === 'missing') return card(quiet('AI usage appears once the usage_events migration has been run and the functions redeployed.'));
    if (aiState === 'error' || !aiUsage) return card(quiet('AI usage could not be loaded. Reload the page to try again.'));
    const { totals, byFunction, unpriced } = aiUsage;
    if (!totals.calls) {
        return card(quiet('Nothing recorded yet. Counting starts from the moment the updated functions are deployed; earlier use was never recorded.'));
    }

    const tile = (label, value, cls = '') =>
        `<div class="stat-tile"><div class="st-label">${escapeHTML(label)}</div><div class="st-value ${cls}">${escapeHTML(String(value))}</div></div>`;
    const rows = byFunction.map(f => {
        const detail = [
            plural(f.calls, 'call', 'calls'),
            f.failures ? `${f.failures} failed` : '',
            f.inputTokens || f.outputTokens ? `${fmtTokens(f.inputTokens)} in · ${fmtTokens(f.outputTokens)} out` : '',
            f.quotes ? plural(f.quotes, 'symbol', 'symbols') : '',
            f.searches ? plural(f.searches, 'web search', 'web searches') : '',
        ].filter(Boolean).join(' · ');
        return `
        <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;flex-wrap:wrap;">
            <span style="color:var(--text-primary);">${escapeHTML(f.label)}</span>
            <span style="color:var(--text-secondary);text-align:right;">${escapeHTML(detail)}${f.fn === 'quote-proxy' ? '' : ` · <span style="color:var(--text-primary);">${escapeHTML(fmtUsd(f.cost))}</span>`}</span>
        </div>`;
    }).join('');

    const caveats = [
        'Cost is an estimate at list prices in US dollars, from the tokens each call reported.',
        totals.searches ? 'Web searches are billed separately and are not included.' : '',
        'On a free Gemini key, Gemini calls really cost nothing.',
        unpriced.length ? `No price known for ${unpriced.join(', ')}, so those calls are left out of the total.` : '',
    ].filter(Boolean).join(' ');

    return card(`
        <div class="stat-tiles">
            ${tile('Calls', totals.calls)}
            ${tile('Est. cost', fmtUsd(totals.cost), 'gold')}
            ${tile('Failed calls', totals.failures, totals.failures ? 'down' : '')}
            ${tile('Symbols quoted', totals.quotes)}
        </div>
        <div style="margin-top:14px;">${rows}</div>
        <p style="color:var(--text-tertiary);font-size:12px;margin:10px 0 0;">${escapeHTML(caveats)}</p>`);
}

/** The activity line under a person in the list, when usage has loaded. */
function activityLine(id) {
    const u = usageState === 'ready' ? usage?.byId.get(id) : null;
    if (!u) return '';
    const tools = u.used.map(t => `${t.label} ${t.items}`).join(' · ');
    const parts = [
        u.lastActiveMs ? `Active ${fmtDate(u.lastActiveMs)}` : 'No activity yet',
        tools,
    ].filter(Boolean).join(' · ');
    const ai = aiState === 'ready' ? aiUsage?.byPerson.get(id) : null;
    const aiLine = ai && ai.calls
        ? `<div style="font-size:11px;margin-top:2px;color:var(--text-secondary);">${escapeHTML(
            [`AI ${plural(ai.calls, 'call', 'calls')}`, ai.cost ? `~${fmtUsd(ai.cost)}` : '', ai.quotes ? plural(ai.quotes, 'symbol quoted', 'symbols quoted') : '']
                .filter(Boolean).join(' · '))} this month</div>`
        : '';
    const problems = u.problems30
        ? `<div style="font-size:11px;margin-top:2px;color:var(--down);">${escapeHTML(plural(u.problems30, 'problem', 'problems'))} reported this month</div>`
        : '';
    return `<div style="font-size:11px;margin-top:2px;color:var(--text-secondary);">${escapeHTML(parts)}</div>${aiLine}${problems}`;
}

function render() {
    const root = document.getElementById('adminBody');
    if (!root) return;

    if (access === 'loading')     { root.innerHTML = notice('Checking your access…'); return; }
    if (access === 'signed-out')  { root.innerHTML = notice('Sign in with an administrator account to manage invitations.'); return; }
    if (access === 'denied')      { root.innerHTML = notice('This page is for administrators.'); return; }
    if (access === 'unavailable') {
        // Invitations are down, but the usage reports may not be.
        const reports = [
            usageState === 'ready' || usageState === 'missing' ? renderUsage() : '',
            aiState === 'ready' || aiState === 'missing' ? renderAiUsage() : '',
        ].join('');
        root.innerHTML = reports + notice('The invitations service could not be reached, so invitations cannot be managed right now.');
        return;
    }

    // Keep whatever was typed across a re-render.
    const typed = document.getElementById('inviteEmail')?.value || '';

    const rows = people.map(p => {
        const s = STATUS[p.status] || STATUS.unknown;
        const confirming = pendingRevoke === p.id;
        const when = p.status === 'pending' ? `Invited ${fmtDate(p.invitedAt)}` : `Last sign-in ${fmtDate(p.lastSignInAt)}`;
        const action = p.status === 'pending'
            ? `<button class="btn btn-sm ${confirming ? 'btn-danger' : 'btn-secondary'}" data-act="revoke" data-id="${escapeHTML(p.id)}">${confirming ? 'Confirm revoke' : 'Revoke'}</button>`
            : '';
        return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
                <div style="min-width:0;flex:1 1 220px;">
                    <div style="color:var(--text-primary);font-size:14px;word-break:break-all;">${escapeHTML(p.email || 'No email')}</div>
                    <div style="font-size:12px;margin-top:2px;color:${s.color};">${escapeHTML(s.label)}</div>
                    <div style="font-size:11px;margin-top:2px;color:var(--text-tertiary);">${escapeHTML(when)}</div>
                    ${activityLine(p.id)}
                </div>
                ${action}
            </div>`;
    }).join('');

    root.innerHTML = `
        ${renderUsage()}
        ${renderAiUsage()}
        <div class="card">
            <h2 class="section-heading">Invite someone</h2>
            <p style="color:var(--text-secondary);font-size:13px;margin:0 0 12px;">They get an email with a link. Opening it signs them in and asks them to choose a password.</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <input type="email" id="inviteEmail" autocomplete="off" placeholder="name@example.com" aria-label="Email address to invite"
                       style="flex:1 1 240px;padding:10px 12px;background:var(--ink-2);color:var(--text-primary);border:1px solid var(--border-hover);border-radius:6px;font-size:14px;box-sizing:border-box;" />
                <button class="btn btn-primary" data-act="invite">Send invitation</button>
            </div>
            <p style="color:var(--text-tertiary);font-size:12px;margin:10px 0 0;">The link works once and expires. If it has expired, revoke the invitation and send a new one.</p>
        </div>
        <div class="card">
            <h2 class="section-heading">People</h2>
            ${rows || '<div class="empty-state">Nobody yet. Invitations you send appear here.</div>'}
        </div>`;

    const input = document.getElementById('inviteEmail');
    if (input && typed) input.value = typed;
    setSendButton();
}

// ── Auth ────────────────────────────────────────────────────────────────────

function updateAuthBar() {
    if (typeof window.updateNavbarAuth === 'function') {
        window.updateNavbarAuth(state.currentUser, state.passwordRecoveryMode, !!state.supabaseClient);
    }
}

function installAuthHandlers() {
    const val = id => document.getElementById(id)?.value ?? '';
    const show = (res) => {
        if (!res.ok) { showToast(res.message, 'warning', 8000); return false; }
        if (res.message) showToast(res.message, 'success', 6000);
        return true;
    };
    // The navbar's static onclick attributes call these by name.
    window.handleLogin = async () => show(await account.login(val('authEmail'), val('authPassword')));
    window.handleLogout = async () => show(await account.logout());
    window.handleGoogleLogin = async () => show(await account.googleLogin());
    window.handleForgotPassword = async () => show(await account.forgotPassword(val('authEmail')));
    window.handlePasswordReset = async () => {
        if (show(await account.setPassword(val('newPassword'), val('confirmPassword')))) {
            state.passwordRecoveryMode = false;
            updateAuthBar();
        }
    };
    window.cancelPasswordRecovery = () => { state.passwordRecoveryMode = false; updateAuthBar(); };
    window.handleSignup = () => showToast(t('auth.invite_only'), 'info');
}

function initSupabase() {
    if (typeof supabase === 'undefined' || !state.supabaseUrl || !state.supabaseAnonKey) {
        access = 'unavailable';
        render();
        return;
    }
    state.supabaseClient = supabase.createClient(state.supabaseUrl, state.supabaseAnonKey);
    setTelemetryClient(state.supabaseClient);

    state.supabaseClient.auth.onAuthStateChange((event, session) => {
        state.currentUser = session?.user || null;
        if (event === 'PASSWORD_RECOVERY') { state.passwordRecoveryMode = true; updateAuthBar(); return; }
        if (event === 'USER_UPDATED' && state.passwordRecoveryMode) state.passwordRecoveryMode = false;
        updateAuthBar();
        // INITIAL_SESSION and SIGNED_IN can both fire for one sign-in; load once per user.
        const uid = state.currentUser?.id ?? null;
        if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(event) && uid !== loadedFor) {
            loadedFor = uid;
            loadAccess();
        }
    });
    // Backup for the race where INITIAL_SESSION fires before the listener is
    // registered — without it the page would sit on "Checking your access…".
    // index.html, spend/ and wine/ guard the same race the same way.
    state.supabaseClient.auth.getSession().then(({ data: { session } }) => {
        if (loadedFor !== undefined) return;
        state.currentUser = session?.user || null;
        loadedFor = state.currentUser?.id ?? null;
        updateAuthBar();
        loadAccess();
    }).catch(err => {
        access = 'unavailable';
        render();
        reportHandled(err, { action: 'admin-session' });
    });
}

export function initAdminPage() {
    installAuthHandlers();
    const root = document.getElementById('adminBody');
    bindActions(root, {
        invite: () => sendInvite(),
        revoke: d => revoke(d.id),
    });
    root?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && ev.target?.id === 'inviteEmail') { ev.preventDefault(); sendInvite(); }
    });
    render();
    initSupabase();
}

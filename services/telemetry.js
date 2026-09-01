/**
 * telemetry.js — client error reporting.
 *
 * Installed first on every page, so a failure during module setup is still
 * caught. Deliberately small: this is a personal-scale app, not an
 * observability platform.
 *
 * PRIVACY IS THE HARD CONSTRAINT HERE. An error message can quote a bank
 * transaction description, a merchant, an amount. Nothing in this file may ship
 * financial data to a table: messages are truncated, obvious money and long
 * digit runs are redacted, and `context` is allow-listed rather than free-form.
 */

const MAX_REPORTS_PER_LOAD = 10;   // a render loop must not become a write loop
const MAX_MESSAGE = 500;
const MAX_STACK = 2000;
const ALLOWED_CONTEXT_KEYS = ['action', 'format', 'chunks', 'chunksFailed', 'rows', 'status', 'provider'];

let installed = false;
let reporting = false;            // re-entrancy guard: the reporter must never report itself
let sent = 0;
const seen = new Set();
let config = { page: 'unknown', version: null, client: null };

/**
 * Strip anything that could be financial detail.
 * Errors quote what they were processing, and what this app processes is a
 * ledger — so redaction happens before the string leaves the browser, not in
 * the database.
 */
export function redact(text) {
    return String(text || '')
        // amounts: 1.234,56 / 1,234.56 / 12.40 — with or without a symbol
        .replace(/[€$£]\s?-?\d[\d.,]*/g, '«amount»')
        .replace(/-?\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\b/g, '«amount»')
        // account numbers, IBANs, card fragments, long reference digits
        .replace(/\b[A-Z]{2}\d{2}[\s\d]{10,}/g, '«iban»')
        .replace(/\b\d{6,}\b/g, '«digits»')
        .slice(0, MAX_MESSAGE);
}

function pickContext(context) {
    const out = {};
    if (!context || typeof context !== 'object') return out;
    for (const key of ALLOWED_CONTEXT_KEYS) {
        if (context[key] !== undefined && typeof context[key] !== 'object') out[key] = context[key];
    }
    return out;
}

async function send(row) {
    // Budget and dedupe: one broken render can fire hundreds of identical
    // errors, and writing all of them helps nobody and costs the user's quota.
    if (sent >= MAX_REPORTS_PER_LOAD) return;
    const key = `${row.message}|${row.line}|${row.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    sent++;

    if (reporting) return;
    reporting = true;
    try {
        const client = config.client;
        if (!client?.auth) return;
        const { data } = await client.auth.getSession();
        // Anonymous users have no row to own; there is no point writing one.
        if (!data?.session?.user) return;
        await client.from('app_errors').insert({ ...row, user_id: data.session.user.id });
    } catch {
        // The one place a silent catch is correct: a failing reporter must not
        // generate more errors to report.
    } finally {
        reporting = false;
    }
}

function baseRow(kind, message, extra = {}) {
    return {
        page: config.page,
        kind,
        message: redact(message),
        stack: extra.stack ? redact(extra.stack).slice(0, MAX_STACK) : null,
        source: extra.source || null,
        line: Number.isFinite(extra.line) ? extra.line : null,
        col: Number.isFinite(extra.col) ? extra.col : null,
        app_version: config.version || null,
        user_agent: (navigator.userAgent || '').slice(0, 200),
        context: pickContext(extra.context)
    };
}

/** Install the global handlers. Call once, as the first statement on a page. */
export function installErrorReporting({ page, version, client, onNotice } = {}) {
    if (installed) return;
    installed = true;
    config = { page: page || 'unknown', version: version || null, client: client || null };

    window.addEventListener('error', (event) => {
        // Resource load failures (a 404 image) arrive here with no error object
        // and are not worth a row.
        if (!event.error && !event.message) return;
        if (String(event.filename || '').includes('telemetry.js')) return;
        send(baseRow('error', event.message || String(event.error), {
            stack: event.error?.stack, source: event.filename, line: event.lineno, col: event.colno
        }));
        onNotice?.();
        // Deliberately NOT returning true: swallowing the event hides the error
        // from the console too, which is what the old portfolio.html handler did.
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        send(baseRow('rejection', reason?.message || String(reason), { stack: reason?.stack }));
        onNotice?.();
    });
}

/** Report a caught error explicitly, from a catch block that already handled it. */
export function reportHandled(err, context) {
    send(baseRow('handled', err?.message || String(err), { stack: err?.stack, context }));
}

/** Let a page attach the client once auth has initialised. */
export function setTelemetryClient(client) { config.client = client; }

export const __testing = { redact, pickContext, ALLOWED_CONTEXT_KEYS, MAX_REPORTS_PER_LOAD };

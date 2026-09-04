/**
 * spend/pdf.js — PDF statements, from file to verified rows.
 *
 * The pipeline, and why each step exists:
 *
 *   file → positioned text → reconstructed LINES → prefilter → chunk
 *        → extraction service → contract rows → balance verification
 *
 * The app's older PDF reader did `items.map(i => i.str).join(' ')`, discarding
 * every coordinate and flattening a page into one unreadable line. That is why
 * PDFs previously looked like they needed a large model: the table was
 * destroyed before anything could read it. Keeping the layout is what lets a
 * cheap model do this reliably — and lets us send a fraction of the tokens.
 *
 * Nothing here trusts the model. Every returned row goes through the same
 * contract validator as CSV and OFX, and then through a balance-continuity
 * check against the statement's own running balance. Rows that do not
 * reconcile are flagged for review rather than written to the ledger.
 */

import state from './state.js?v=3.44.0';
import { escapeHTML } from './utils.js?v=3.44.0';
import { groupIntoLines, findCandidateLines, findSectionHeadings, detectStatementYear, checkBalanceChain }
    from '../services/import-pdf.js';
import { normalizeRow, validateRow } from '../services/import-contract.js';
import { mergeDetailSource, expandCardDetail, markCardSettlements } from '../services/import-banks.js';

/** Characters per request. The server rejects above 15K. */
const CHUNK_CHARS = 12000;
/** Under the 60s edge-function ceiling, so a stall surfaces as a real error. */
const REQUEST_TIMEOUT_MS = 55000;

// ── file → lines ────────────────────────────────────────────────────────────

/**
 * Extract layout-reconstructed lines from a PDF.
 *
 * pdf.js is vendored in /lib because the CSP is `script-src 'self'` — it must
 * never be loaded from a CDN.
 */
export async function extractPdfLines(file) {
    const pdfjsLib = await import('../lib/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        // pdf.js items already carry `transform` and `width`; groupIntoLines
        // needs both to rebuild the printed rows.
        for (const line of groupIntoLines(content.items)) lines.push({ ...line, page: p });
    }
    return { lines, pageCount: pdf.numPages };
}

/**
 * Keep what the model needs and drop the rest.
 *
 * A statement is mostly boilerplate — one bank prints ~20 lines of terms per
 * page. Sending candidate transaction rows plus a little header context is the
 * difference between ~5 requests and ~25 for a long export, and it removes the
 * text most likely to be mistaken for a transaction.
 */
export function prefilterLines(lines = []) {
    const candidates = new Set(findCandidateLines(lines).map(l => l.text));
    // Section headings are kept alongside the rows, IN DOCUMENT ORDER, because
    // the model is asked to classify a row by the section it sits under. Filter
    // them out and a card purchase is just another dated line — the evidence
    // needed to tell it from an account movement is gone before extraction runs.
    const headings = new Set(findSectionHeadings(lines).map(l => l.text));
    // Header context: the first lines of the document usually carry the
    // statement period, which is how a row printed as "31/07" gets its year.
    const header = lines.slice(0, 12).map(l => l.text);
    const body = lines
        .filter(l => candidates.has(l.text) || headings.has(l.text))
        .map(l => l.text);
    return { header, body, year: detectStatementYear(lines) };
}

export function chunkLines(bodyLines = [], maxChars = CHUNK_CHARS) {
    const chunks = [];
    let current = '';
    for (const line of bodyLines) {
        if (current && current.length + line.length + 1 > maxChars) { chunks.push(current); current = ''; }
        current += (current ? '\n' : '') + line;
    }
    if (current.trim()) chunks.push(current);
    return chunks;
}

// ── extraction service ──────────────────────────────────────────────────────

async function freshToken() {
    const { data } = await state.supabaseClient.auth.getSession();
    const session = data?.session;
    if (!session) throw new Error('Not signed in.');
    // Refresh only when the token is about to expire. Refreshing every time
    // rotates the single-use refresh token and breaks long multi-chunk runs.
    const expiresIn = (session.expires_at || 0) * 1000 - Date.now();
    if (expiresIn < 60000) {
        const { data: refreshed } = await state.supabaseClient.auth.refreshSession();
        return refreshed?.session?.access_token || session.access_token;
    }
    return session.access_token;
}

async function callExtractor(statementText, hint) {
    const token = await freshToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${state.supabaseUrl}/functions/v1/extract-statement`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: state.supabaseAnonKey,
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ statementText, hint }),
            signal: controller.signal
        });
        // Read as text first: a gateway 500 is often an HTML page, and
        // res.json() would discard the only description of what went wrong,
        // leaving a bare "Extraction failed (500)".
        const raw = await res.text();
        let payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
        if (!res.ok) {
            const detail = payload.error || raw.replace(/<[^>]*>/g, ' ').trim().slice(0, 200);
            throw new Error(detail ? `Extraction failed (${res.status}): ${detail}` : `Extraction failed (${res.status})`);
        }
        return payload;
    } catch (err) {
        // A bare "Failed to fetch" means the request never reached application
        // code, so the server could not explain itself. There are only a few
        // causes and the user cannot distinguish them from the browser, so name
        // them rather than passing the raw message through.
        if (err?.name === 'AbortError') {
            throw new Error(`The extraction service took longer than ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s and was cancelled.`);
        }
        if (err instanceof TypeError) {
            const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(window.location.origin);
            throw new Error(
                'Could not reach the extraction service. Either it is not deployed yet ' +
                '(run: supabase functions deploy extract-statement)' +
                (local
                    ? ', or you are on localhost, which the function\'s CORS policy blocks by default ' +
                      '(set ALLOW_LOCAL_ORIGINS=true on the project to permit it).'
                    : '.')
            );
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ── model output → verified rows ────────────────────────────────────────────

/** Coerce whatever the model returned through the same gate as every adapter. */
export function normalizeAiRows(rawRows = [], { accountId, currency = 'EUR', source = 'pdf' } = {}) {
    const rows = [], rejected = [];
    for (const raw of rawRows) {
        const candidate = normalizeRow({
            accountId,
            date: typeof raw?.date === 'string' ? raw.date : null,
            description: raw?.description,
            amount: raw?.amount,
            currency: raw?.currency || currency,
            balance: raw?.balance ?? null,
            source,
            // The model's structural call, not a guess from the wording. A card
            // purchase listed under the card section is 'detail': its money is
            // already in the statement row that pays the card.
            sourceRole: raw?.role === 'detail' ? 'detail' : 'statement'
        });
        const { ok, errors } = validateRow(candidate);
        if (ok) rows.push(candidate);
        else rejected.push({ reason: errors.join('; '), raw });
    }
    return { rows, rejected };
}

/**
 * Check the model's arithmetic against the statement's own running balance.
 *
 * This is what makes an AI-read statement safe to import: the balance chain is
 * a property of the document, not of the extraction, so a hallucinated or
 * mis-signed amount breaks it. Rows in a broken chain are flagged rather than
 * dropped — the movement probably happened, we just cannot vouch for the number.
 */
export function verifyRows(rows = []) {
    // Detail rows are excluded before the chain is built, not skipped inside it.
    // They carry no running balance by nature, and leaving them interleaved
    // breaks ADJACENCY for the statement rows around them: every pair touching a
    // detail row was silently passed over, so a handful of card lines could
    // disable verification for most of the document while still reporting valid.
    const statementRows = rows.filter(r => r.sourceRole !== 'detail');
    const chain = checkBalanceChain(statementRows);
    if (chain.valid) return { rows, chain, flagged: 0 };

    let flagged = 0;
    let prev = null;
    const out = rows.map(row => {
        if (row.sourceRole === 'detail') return row;
        const before = prev;
        prev = row;
        if (!before || row.balance === null || before.balance === null) return row;
        const expected = row.balance - before.balance;
        if (Math.abs(expected - row.amount) <= 0.011) return row;
        flagged++;
        return { ...row, needsReview: true, note: 'amount does not reconcile with the statement balance' };
    });
    return { rows: out, chain, flagged };
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * Read a PDF statement end to end.
 * `onProgress(done, total)` reports chunk progress; a long export is several
 * requests and silence for 30 seconds reads as a hang.
 */
export async function importPdfStatement(file, { accountId, hint, onProgress } = {}) {
    const { lines, pageCount } = await extractPdfLines(file);
    if (!lines.length) {
        return { rows: [], errors: [{ reason: 'No text found — this looks like a scanned image rather than a text PDF.' }], parsed: 0, skipped: 1, format: 'pdf' };
    }

    const { header, body, year } = prefilterLines(lines);
    if (!body.length) {
        return { rows: [], errors: [{ reason: 'No dated transaction lines found in this document.' }], parsed: 0, skipped: 1, format: 'pdf' };
    }

    const chunks = chunkLines(body);
    const contextHint = [hint, year ? `The statement period is in ${year}.` : null,
        `Document header:\n${header.join('\n')}`].filter(Boolean).join('\n');

    const collected = [], errors = [];
    let provider = null, chunksFailed = 0;
    for (let i = 0; i < chunks.length; i++) {
        onProgress?.(i, chunks.length);
        try {
            const payload = await callExtractor(chunks[i], contextHint);
            provider = payload.provider || provider;
            const got = payload.rows || [];
            // A section full of dated lines that yields nothing is a failure,
            // not an empty section. Left unreported it loses ~40 transactions
            // per chunk while the import still says "success".
            if (!got.length && /\d{1,2}[/.-]\d{1,2}/.test(chunks[i])) {
                chunksFailed++;
                errors.push({ reason: `Section ${i + 1} of ${chunks.length} returned no transactions despite containing dated lines — it was probably truncated.` });
            }
            collected.push(...got);
        } catch (err) {
            chunksFailed++;
            errors.push({ reason: `Section ${i + 1} of ${chunks.length}: ${err.message}` });
        }
    }
    onProgress?.(chunks.length, chunks.length);

    const { rows: normalized, rejected } = normalizeAiRows(collected, { accountId, source: file.name || 'pdf' });
    for (const r of rejected) errors.push({ reason: r.reason });

    // Chronological, so the balance chain is checked in the order the statement
    // printed it rather than the order the model happened to emit.
    normalized.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const { rows: verified, chain, flagged } = verifyRows(normalized);

    // Detail lines never enter the ledger as movements. The card bill is already
    // one statement row; adding its itemisation alongside counts the same money
    // twice, and card sections print charges unsigned, so those duplicates land
    // as INCOME — overstating income and understating spend at the same time.
    //
    // They are still worth reading: the itemisation says what a lump
    // "PAG.CTA.CARTAO" was actually spent on, which is the best categorisation
    // signal in the document. So they go through the same merge path the MB WAY
    // detail export uses — improving the wording of the row that already exists,
    // never creating one.
    const detailRows = verified.filter(r => r.sourceRole === 'detail');
    const statementRows = verified.filter(r => r.sourceRole !== 'detail');

    let rows = statementRows;
    let itemised = 0, enrichedCount = 0, unmatchedDetail = 0, promoted = 0, settlementsLinked = 0;
    if (detailRows.length) {
        // Preferred outcome: prove the purchases account for the settlement and
        // put them in the ledger in its place, so a card bill reads as what was
        // bought rather than as one opaque payment.
        const exp = expandCardDetail(statementRows, detailRows);
        rows = exp.rows;
        itemised = exp.expanded.reduce((n, g) => n + g.count, 0);

        // A group that reconciles against nothing in this document is usually not
        // an itemisation at all: on a revolving credit card the statement lists
        // THIS period's purchases while the payment on it settles the PREVIOUS
        // period's balance. Measured on a real Bankinter statement: 27 purchases
        // totalling 2.729,44 against a payment of 717,61. The two are different
        // money, so no proof will ever be found and none should be.
        //
        // Those purchases are the spending. Dropping them loses the entire card
        // month — the exact thing the user opened this app to see — so they are
        // imported as movements and flagged, rather than discarded silently.
        //
        // Flagged because one judgement remains that the app must not make on
        // someone's behalf: the card settlement in the account section is now
        // debt repayment, not spending, and counting both would count the same
        // money twice across consecutive statements.
        const stuck = new Set(exp.unexpanded.map(u => u.group));
        const leftover = detailRows.filter(d => stuck.has(d.detailGroup ?? '__ungrouped__'));
        if (leftover.length) {
            rows = [...rows, ...leftover.map(d => ({
                ...d,
                sourceRole: 'statement',
                enrichedFrom: 'card',
                needsReview: true,
                note: 'Card purchase. Its settlement is a separate row — mark that settlement as a transfer so this month is not counted twice.'
            }))];
            promoted = leftover.filter(d => Number(d.amount) < 0).length;

            // The purchases are now spending, so the account row that repays the
            // card is repayment, not consumption. Both legs are in this document,
            // so the link is proven by amount and date rather than guessed from
            // wording — and marking it is not optional: leaving it as spending
            // overstates every month by the settlement, invisibly.
            const marked = markCardSettlements(rows, leftover);
            rows = marked.rows;
            settlementsLinked = marked.linked.length;
        }
    }

    return {
        rows, errors, parsed: rows.length, skipped: errors.length,
        format: 'pdf', provider, pageCount, chunks: chunks.length, chunksFailed,
        chain, flagged, statementYear: year,
        detail: { total: detailRows.length, itemised, promoted, settlementsLinked,
                  enriched: enrichedCount, unmatched: unmatchedDetail }
    };
}

export const __testing = { CHUNK_CHARS };

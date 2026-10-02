/**
 * spend/importer.js — statement import orchestration.
 *
 * The pipeline, in order (the order matters and is not arbitrary):
 *
 *   file → text → profile (learned once per bank) → parse → enrich → categorise
 *        → dedupe → review → commit
 *
 * Enrichment runs BEFORE categorisation because feeding the categoriser
 * "COMPRA MBWAY" instead of "Pingo Doce" wastes the call and gets a worse
 * answer. Dedupe runs AFTER enrichment because the fingerprint is built from
 * the original bank text, which enrichment preserves in `rawDescription`.
 *
 * Nothing is written until the user has seen the review screen.
 */

import state, { clearViewFilters } from './state.js?v=3.56.1';
import { escapeHTML, fmtMoney, fmtDate, showToast, showConfirm, openModal, closeModal } from './utils.js?v=3.56.1';
import {
    saveTransactions, saveProfile, deleteProfile, savePendingDetails, clearPendingDetails, saveAccount, undoImport, requireAuth
} from './storage.js?v=3.56.1';
import { renderAll } from './ledger.js?v=3.56.1';
import {
    buildProfileDraft, parseWithProfile, headerSignature, sniffCsv,
    applyRules, dedupeSpendRows, buildExistingFingerprints, mergeDetailSource,
    planCardRouting, summarizeSections, sectionSignature, DATE_FORMATS, isRoutableCardRow
} from '../services/import-banks.js';
import { parseStandard } from '../services/import-standards.js';
import { importPdfStatement, extractPdfLines } from './pdf.js?v=3.56.1';
import { accountRefs, matchAccount, rememberRefs } from '../services/import-identity.js';
import { reportHandled, reportDiagnostic } from '../services/telemetry.js';
import { detectInternalTransfers } from '../services/spend-core.js';

const el = id => document.getElementById(id);

/** The date span a set of rows covers, padded by the merge window. */
function dateWindow(rows, padDays) {
    const dates = rows.map(r => r.date).filter(Boolean).sort();
    if (!dates.length) return null;
    const shift = (iso, days) =>
        new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
    return { from: shift(dates[0], -padDays), to: shift(dates[dates.length - 1], padDays) };
}
const FIELD_LABELS = {
    date: 'Date', valueDate: 'Value date', description: 'Description',
    amount: 'Amount (signed)', debit: 'Debit / money out', credit: 'Credit / money in',
    balance: 'Balance (ignored)', currency: 'Currency'
};

// ── section ─────────────────────────────────────────────────────────────────

export function renderImportSection() {
    const host = el('importHost');
    if (!host) return;

    if (!state.accounts.length) {
        host.innerHTML = `<div class="empty-state">Add an account first — every import is filed against one, so re-imports can be de-duplicated per account.</div>`;
        return;
    }

    const known = state.profiles.length;
    host.innerHTML = `
        <div class="form-group">
            <label class="form-label" for="importAccount">Account, for a file that does not name one</label>
            <select class="form-select" id="importAccount">
                ${state.accounts.map(a => `<option value="${a.id}">${escapeHTML(`${a.bankName} · ${a.label}`)}${a.type === 'wallet' ? ' (wallet)' : ''}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label class="form-label" for="importFile">Statement file</label>
            <input class="form-input" type="file" id="importFile" multiple
                   accept=".csv,.tsv,.txt,.ofx,.qfx,.qbo,.xml,.pdf"
                   onchange="spendHandleFile(this)">
            <span class="form-helper">
                <strong>Several files at once is fine.</strong> Each one is read in turn; a statement whose checks
                all pass is saved without asking, and the first one with anything to look at stops and waits.<br>
                A statement that prints its IBAN or account number files itself against the right account —
                the first one from a new account asks once, then never again. This choice is used only for files
                that name no account at all.<br>
                <strong>OFX or QFX imports with no setup at all</strong> — it's a standard format, so nothing needs mapping.
                CSV and TSV work too: ${known ? `${known} format${known === 1 ? '' : 's'} already learned, and those import without asking anything.` : 'the first file from a bank asks you to confirm its columns once, then never again.'}
            </span>
        </div>
        ${state.transferCandidates ? `
        <div class="review-banner" style="margin-top:12px"><span>↔</span><span>
            ${state.transferCandidates} movement${state.transferCandidates === 1 ? '' : 's'} look${state.transferCandidates === 1 ? 's' : ''}
            like money moving between your own accounts — typically a card payment whose purchases are already
            here. Counted as spending, it would be counted twice.
            <button class="btn btn-sm btn-ghost-spend" style="margin-left:6px;padding:1px 8px"
                    data-act="find-transfers">Review and mark</button>
        </span></div>` : ''}
        ${state.lastImport ? `
        <div class="review-banner" style="margin-top:12px"><span>↩</span><span>
            Last import added ${state.lastImport.rows} transaction${state.lastImport.rows === 1 ? '' : 's'}.
            <button class="btn btn-sm btn-ghost-spend" style="margin-left:6px;padding:1px 8px"
                    data-act="undo-import">Undo it</button>
        </span></div>` : ''}
        ${state.profiles.length ? `
        <div class="form-group" style="margin-top:14px">
            <label class="form-label">Layouts I remember</label>
            <ul style="margin:4px 0 0 18px">
                ${state.profiles.map(p => `<li class="form-helper">
                    ${escapeHTML((p.label || 'Unnamed layout').slice(0, 54))}
                    <span style="opacity:.7">· ${escapeHTML((p.formatKind || 'csv').toUpperCase())}</span>
                    <button class="btn btn-sm btn-ghost-spend" style="margin-left:6px;padding:1px 8px"
                            data-act="forget-layout" data-id="${escapeHTML(p.id)}">Forget</button>
                </li>`).join('')}
            </ul>
            <span class="form-helper">A remembered layout is replayed silently on every statement that matches it,
            so if one was confirmed by mistake, forget it here and the next import will ask again.</span>
        </div>` : ''}
        <div id="importStatus"></div>`;
}

/**
 * Forget a layout, after saying what that costs.
 *
 * Confirming is one tap, so un-confirming should be too — but it is not
 * symmetrical in effect: forgetting means the next statement from that bank
 * asks again, which is the recoverable direction. Confirming wrongly is the
 * direction with no way back, which is why this exists.
 */
/**
 * Take back the last import.
 *
 * Deliberately scoped to the most recent one rather than offering a history:
 * the moment someone needs this is the moment they have just watched an import
 * land wrong, and a list of past imports to choose from is a decision they do
 * not want to be making then.
 */
export async function undoLastImport() {
    const last = state.lastImport;
    if (!last?.id) { showToast('Nothing to undo.', 'warning'); return; }
    if (!await showConfirm(
        `Remove the ${last.rows} transaction${last.rows === 1 ? '' : 's'} added by the last import? Anything you have edited since will go too.`,
        { danger: true, confirmLabel: 'Undo import' })) return;
    try {
        const gone = await undoImport(last.id);
        state.lastImport = null;
        showToast(`${gone} transaction${gone === 1 ? '' : 's'} removed.`);
        renderAll();
        renderImportSection();
    } catch (err) {
        showToast('Could not undo: ' + err.message, 'error');
    }
}

export async function forgetLayout(id) {
    const profile = state.profiles.find(p => p.id === id);
    if (!profile) return;
    if (!await showConfirm(
        `Forget "${(profile.label || 'this layout').slice(0, 60)}"? The next statement shaped like it will ask again instead of importing silently.`,
        { confirmLabel: 'Forget it' })) return;
    try {
        await deleteProfile(id);
        showToast('Forgotten.');
        renderImportSection();
    } catch (err) {
        showToast('Could not forget it: ' + err.message, 'error');
    }
}

function status(html) {
    const s = el('importStatus');
    if (s) s.innerHTML = html;
}

// ── file → text ─────────────────────────────────────────────────────────────

export async function handleFile(input) {
    const files = [...(input?.files || [])];
    if (!files.length) return;
    if (!requireAuth('import a statement')) return;
    input.value = '';

    state.importQueue = files;
    state.importBatch = { total: files.length, done: 0, review: 0, failed: 0, notes: [], current: null };
    try {
        await processQueue();
    } catch (err) {
        status(`<div class="review-banner"><span>⚠</span><span>Could not read that file: ${escapeHTML(err.message)}</span></div>`);
        reportHandled(err, { action: 'import-batch' });
    }
}

// ── Importing several statements in one go ──────────────────────────────────
//
// One file at a time was the real cost of a month's paperwork: a dozen
// statements meant a dozen rounds of choose-account, choose-file, wait, commit.
// Files are now read one after another. A file whose checks all pass saves
// itself; the first one with anything to look at stops the queue and waits,
// because the whole point of the checks is that a human sees what they caught.

/** What must be true for a file to save itself, with nobody looking. */
export function importIsClean(r) {
    if (!r || r.isDetail) return false;                 // a detail file enriches rows; never silent
    if (!r.fresh?.length) return false;                 // nothing to save is not "clean", it is odd
    if (r.errors?.length || r.chunksFailed) return false;
    if (r.flagged) return false;                        // a row the balance chain could not reconcile
    if (r.fresh.some(row => row.needsReview)) return false;
    if ((r.cardPlan || []).some(p => p.action !== 'use')) return false;  // changes the account setup
    if (!r.chain?.valid) return false;                  // the per-row check must have passed
    if (!r.total?.ok) return false;                     // and the statement must add up as a whole
    if (!r.knownLayout && r.format === 'pdf') return false;  // a layout nobody has confirmed
    return true;
}

function queueStatus() {
    const q = state.importQueue || [];
    if (!q.length) return '';
    return `<p class="form-helper">${q.length} more file${q.length === 1 ? '' : 's'} waiting — finish this one to continue.</p>`;
}

/** Read the next queued file, saving it outright when every check passes. */
async function processQueue() {
    const batch = state.importBatch;
    while ((state.importQueue || []).length) {
        const file = state.importQueue.shift();
        batch.current = file.name;
        status(`<p class="form-helper">Reading ${escapeHTML(file.name)} (${batch.done + batch.review + batch.failed + 1} of ${batch.total})…</p>`);
        try {
            await readOneFile(file);
        } catch (err) {
            batch.failed++;
            batch.notes.push(`${file.name}: ${err.message}`);
            reportHandled(err, { action: 'import-batch-file' });
            continue;
        }
        if (!state.importResult) { batch.failed++; continue; }   // refused, or cancelled at the account question

        if (importIsClean(state.importResult)) {
            await commitImport({ silent: true });
            batch.done++;
            continue;
        }
        batch.review++;
        showReport();
        const s = el('importStatus');
        if (s) s.insertAdjacentHTML('beforeend', queueStatus());
        return;                      // wait for the person; commit or cancel resumes
    }
    finishBatch();
}

function finishBatch() {
    const b = state.importBatch;
    if (!b || b.total <= 1) { state.importBatch = null; return; }
    const parts = [`${b.done} file${b.done === 1 ? '' : 's'} imported`];
    if (b.review) parts.push(`${b.review} needed a look`);
    if (b.failed) parts.push(`${b.failed} could not be read`);
    status(`<div class="review-banner"><span>${b.failed ? '⚠' : '✓'}</span><span>
        ${escapeHTML(parts.join(', '))}.
        ${b.notes.length ? escapeHTML(b.notes.slice(0, 4).join(' · ')) : ''}</span></div>`);
    showToast(parts.join(', ') + '.', b.failed ? 'warning' : 'success', 6000);
    state.importBatch = null;
    renderAll();
}

/** Read one file: recognise its account, then hand it to the right reader. */
async function readOneFile(file) {
    state.importResult = null;
    if (/\.pdf$/i.test(file.name)) {
        const pages = await extractPdfLines(file);
        if (!await resolveAccountForFile(accountRefs(pages.lines), file.name)) return;
        await runPdfImport(file, pages);
        return;
    }
    const text = await file.text();
    if (!await resolveAccountForFile(accountRefs(text), file.name)) return;
    state.importText = text;
    state.importFileName = file.name;
    analyze();
}



/**
 * Remember the references this statement printed against the account it went
 * to, so the next one files itself. Failure is reported, not shown: the import
 * itself succeeded, and the only cost is being asked again next month.
 */
async function rememberAccountRefs() {
    const refs = state.importRefs || [];
    const account = state.accounts.find(a => a.id === state.importAccountId);
    if (!refs.length || !account) return;
    const next = rememberRefs(account.statementRefs || [], refs);
    const same = next.length === (account.statementRefs || []).length
        && next.every((ref, i) => ref === account.statementRefs[i]);
    if (same) return;
    try {
        await saveAccount({ ...account, statementRefs: next });
    } catch (err) {
        reportHandled(err, { action: 'remember-account-refs' });
    }
}

/**
 * Ask which account a statement belongs to, when it names one nobody has seen.
 *
 * Two answers, both of which end the question for good: file it against an
 * account that already exists, or make a new one. The reference is shown,
 * because "which account is 0269 0301 …?" is a question the person can only
 * answer if they can see it.
 *
 * A new account is created HERE rather than at commit, unlike the card accounts
 * an import proposes: this is the person answering a direct question, not a
 * side effect of reading a file.
 *
 * @returns {Promise<string|null>} the account id, or null if they cancelled
 */
function askWhichAccount({ refs, fileName, ambiguous }) {
    const shown = refs[0] || '';
    const accounts = state.accounts.filter(a => !a.archived);
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.style.cssText = 'display:flex;z-index:10001;';
        overlay.innerHTML = `
            <div class="confirm-dialog" style="max-width:520px;text-align:left;">
                <h3 style="margin:0 0 8px;font-size:16px;">Which account is this statement for?</h3>
                <p class="form-helper" style="margin-bottom:14px;">
                    ${escapeHTML(fileName || 'This file')} is for account
                    <strong>${escapeHTML(shown)}</strong>${ambiguous
                        ? ', and more than one of your accounts claims that reference — pick the right one.'
                        : ", which I have not seen before. Tell me once and every later statement from it files itself."}
                </p>
                ${accounts.length ? `
                <div class="form-group">
                    <label class="form-label" for="_akExisting">An account you already have</label>
                    <select class="form-select" id="_akExisting">
                        ${accounts.map(a => `<option value="${escapeHTML(a.id)}">${escapeHTML(`${a.bankName} · ${a.label}`)}</option>`).join('')}
                    </select>
                    <button id="_akUse" class="btn btn-sm btn-success" style="margin-top:8px;">Use this account</button>
                </div>
                <div class="form-helper" style="margin:12px 0 10px;opacity:.7;">or</div>` : ''}
                <div class="form-group">
                    <label class="form-label">A new account</label>
                    <input class="form-input" id="_akBank" placeholder="Bank (e.g. Bankinter)" style="margin-bottom:6px;">
                    <input class="form-input" id="_akLabel" placeholder="Label (e.g. Conta à ordem)" style="margin-bottom:6px;">
                    <input class="form-input" id="_akCurrency" value="EUR" style="max-width:110px;">
                    <div><button id="_akCreate" class="btn btn-sm btn-primary" style="margin-top:8px;">Create and use</button></div>
                </div>
                <div style="display:flex;justify-content:flex-end;margin-top:14px;">
                    <button id="_akCancel" class="btn btn-secondary">Cancel this file</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const cleanup = value => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
        const onKey = e => { if (e.key === 'Escape') cleanup(null); };
        document.addEventListener('keydown', onKey);
        overlay.querySelector('#_akCancel').addEventListener('click', () => cleanup(null));
        overlay.querySelector('#_akUse')?.addEventListener('click', () => cleanup(overlay.querySelector('#_akExisting').value));
        overlay.querySelector('#_akCreate').addEventListener('click', async () => {
            const bankName = overlay.querySelector('#_akBank').value.trim();
            const label = overlay.querySelector('#_akLabel').value.trim();
            const currency = overlay.querySelector('#_akCurrency').value.trim().toUpperCase() || 'EUR';
            if (!bankName || !label) { showToast('Bank and label are both required.', 'warning'); return; }
            try {
                const made = await saveAccount({ bankName, label, currency, type: 'checking' });
                if (!made?.id) throw new Error('the account could not be created');
                cleanup(made.id);
            } catch (err) {
                reportHandled(err, { action: 'import-new-account' });
                showToast('Could not create that account: ' + err.message, 'error', 7000);
            }
        });
    });
}

/**
 * Which account this file is for, read from the file.
 *
 * A statement prints its own IBAN, NIB or account number
 * (services/import-identity.js). One this account has been seen to print before
 * files the statement without asking. Anything else asks — once — and the
 * answer is remembered when the import is committed, never before: an import
 * that is cancelled must leave no trace.
 *
 * @returns {Promise<boolean>} false when the person cancelled
 */
async function resolveAccountForFile(refs, fileName) {
    state.importRefs = refs;
    // A file that names no account at all — many CSV exports print none — keeps
    // today's behaviour: the account chosen above. Asking about those would be
    // a question with no better answer than the one already given.
    if (!refs.length) {
        state.importAccountId = el('importAccount')?.value || state.accounts[0]?.id;
        state.importMatchedRef = null;
        return true;
    }
    const match = matchAccount(refs, state.accounts);
    if (match.accountId) {
        state.importAccountId = match.accountId;
        state.importMatchedRef = match.ref;
        const account = state.accounts.find(a => a.id === match.accountId);
        if (account) {
            status(`<p class="form-helper">${escapeHTML(fileName || 'This file')} is for
                <strong>${escapeHTML(`${account.bankName} · ${account.label}`)}</strong>
                — recognised from ${escapeHTML(match.ref)}.</p>`);
        }
        return true;
    }
    state.importMatchedRef = null;
    // Two accounts claiming the same reference is a mistake to show, not to
    // resolve: filing into the wrong one is silent and compounds every month.
    const ambiguous = match.candidates?.length > 1;
    const chosen = await askWhichAccount({ refs, fileName, ambiguous });
    if (!chosen) return false;
    state.importAccountId = chosen;
    return true;
}

/**
 * PDF statements go to the extraction service.
 *
 * Not because a PDF is unreadable in principle — a single-section statement
 * parses deterministically — but because real statements interleave several
 * sections with different layouts on the same printed row, and no single line
 * pattern describes them. Measured on a real one: the deterministic reader
 * reconciled 14% of rows and correctly refused the rest.
 *
 * What arrives back is not trusted. It passes the same contract validator as
 * every other adapter, then a balance-continuity check against the statement's
 * own running balance.
 */
async function runPdfImport(file, pages = null) {
    const accountId = state.importAccountId;
    const account = state.accounts.find(a => a.id === accountId);
    const profile = state.profiles.find(p => p.accountId === accountId && p.formatKind === 'pdf');

    status(`<p class="form-helper">Reading ${escapeHTML(file.name)}…</p>`);
    try {
        const result = await importPdfStatement(file, {
            accountId,
            pages,
            // The account's own currency, so a GBP or USD statement stops
            // importing as euros. Nothing downstream could catch that: currency
            // is not part of the balance arithmetic the chain verifies.
            accountCurrency: state.accounts.find(a => a.id === accountId)?.currency || null,
            hint: profile?.pdfHint || null,
            onProgress: (done, total) => status(
                `<p class="form-helper">Reading ${escapeHTML(file.name)} — ${done} of ${total} section${total === 1 ? '' : 's'}…</p>`)
        });

        if (!result.rows.length) {
            const why = result.errors[0]?.reason || 'Nothing could be read from this document.';
            status(`<div class="review-banner"><span>⚠</span><span>${escapeHTML(why)}</span></div>`);
            return;
        }
        state.importText = null;
        ingest(result, { sourceRole: account?.type === 'wallet' ? 'detail' : 'statement' });
    } catch (err) {
        status(`<div class="review-banner"><span>⚠</span><span>Could not read that PDF: ${escapeHTML(err.message)}</span></div>`);
    }
}

// ── profile resolution ──────────────────────────────────────────────────────

function analyze() {
    // Interchange formats are self-describing, so they need no profile, no
    // mapping dialog and no AI — the whole point of supporting them. Try them
    // before falling through to the learn-a-format path.
    const standard = parseStandard(state.importText, {
        accountId: state.importAccountId,
        source: state.importFileName || 'statement',
        sourceRole: state.accounts.find(a => a.id === state.importAccountId)?.type === 'wallet' ? 'detail' : 'statement'
    });
    if (standard) {
        if (standard.unsupported) {
            status(`<div class="review-banner"><span>⚠</span><span>${escapeHTML(standard.message)}</span></div>`);
            return;
        }
        const account = state.accounts.find(a => a.id === state.importAccountId);
        ingest(standard, { sourceRole: account?.type === 'wallet' ? 'detail' : 'statement' });
        return;
    }

    const draft = buildProfileDraft(state.importText);
    if (!draft.header?.length) {
        status(`<div class="review-banner"><span>⚠</span><span>That file has no readable rows.</span></div>`);
        return;
    }
    state.importDraft = draft;

    // A format the user has already confirmed replays with no questions asked.
    const known = state.profiles.find(p => p.signature === draft.signature);
    if (known) {
        status(`<p class="form-helper">Recognised format — ${escapeHTML(known.label || 'saved profile')}. Reading ${draft.rowCount} rows…</p>`);
        runImport(known);
        return;
    }

    showMappingDialog(draft);
}

/**
 * Confirm the column mapping. Shown once per bank format.
 *
 * Sample values sit beside every choice rather than behind a preview toggle —
 * this dialog is the one place a wrong guess gets caught, and a mapping
 * accepted blindly poisons every figure downstream.
 */
export function showMappingDialog(draft = state.importDraft) {
    const fields = ['date', 'valueDate', 'description', 'amount', 'debit', 'credit', 'currency', 'balance'];
    const { header, sampleRows } = draft;

    const options = (selected) => [
        `<option value="">— not present —</option>`,
        ...header.map((h, i) =>
            `<option value="${i}" ${selected === i ? 'selected' : ''}>${escapeHTML(h || `column ${i + 1}`)}</option>`)
    ].join('');

    const sampleText = (idx) => {
        if (idx === null || idx === undefined || idx === '') return '';
        const vals = sampleRows.map(r => r[idx]).filter(v => v !== undefined && v !== '');
        return vals.length ? `e.g. ${escapeHTML(vals.slice(0, 3).join('  ·  '))}` : '';
    };
    state.importSampleRows = sampleRows;

    // What each column actually contains, always shown.
    //
    // Previously samples were rendered only beside a column the auto-mapper had
    // already picked — so in the one case this dialog exists for (nothing
    // recognised, e.g. a bank in another language) the user faced empty
    // dropdowns labelled with words they may not read, and nothing to choose
    // from. The file's own contents are the only reliable guide there.
    const preview = header.map((h, i) => {
        const vals = sampleRows.map(r => r[i]).filter(v => v !== undefined && v !== '').slice(0, 3);
        return `
            <div class="mapping-col">
                <span class="mapping-col-n">${i + 1}</span>
                <span class="mapping-col-name">${escapeHTML(h || `(unnamed column ${i + 1})`)}</span>
                <span class="mapping-col-vals">${escapeHTML(vals.join('  ·  ')) || '<em>empty</em>'}</span>
            </div>`;
    }).join('');

    el('mappingBody').innerHTML = `
        <p class="form-helper" style="margin-bottom:14px">
            New format from <strong>${escapeHTML(state.importFileName || 'this file')}</strong> —
            ${draft.rowCount} rows. Confirm the columns once and every future file from this bank imports automatically.
        </p>
        ${draft.unresolved.length ? `<div class="review-banner"><span>⚠</span><span>
            Couldn't work out which column is the ${escapeHTML(draft.unresolved.join(', '))}.
            Match them up below — the file's own columns are listed first.</span></div>` : ''}
        <div class="mapping-preview">
            <div class="mapping-preview-title">What's in the file</div>
            ${preview}
        </div>
        <div class="mapping-grid">
            ${fields.map(f => `
                <div class="mapping-row">
                    <span class="mapping-field">${escapeHTML(FIELD_LABELS[f])}</span>
                    <select class="form-select" id="map_${f}" data-map-field="${f}">${options(draft.columnMap[f])}</select>
                    <span class="mapping-sample" data-sample-for="${f}">${sampleText(draft.columnMap[f])}</span>
                </div>`).join('')}
            <div class="mapping-row">
                <span class="mapping-field">Date format</span>
                <select class="form-select" id="map_dateFormat">
                    ${DATE_FORMATS.map(f =>
                        `<option value="${f}" ${draft.dateFormat === f ? 'selected' : ''}>${f}</option>`).join('')}
                </select>
                ${draft.dateAmbiguous ? `<span class="mapping-warn">Every day in this file is 12 or lower, so the order can't be told apart — please confirm.</span>` : ''}
            </div>
            <div class="mapping-row">
                <span class="mapping-field">Decimals</span>
                <select class="form-select" id="map_decimalStyle">
                    <option value="eu" ${draft.decimalStyle === 'eu' ? 'selected' : ''}>1.234,56 (European)</option>
                    <option value="us" ${draft.decimalStyle === 'us' ? 'selected' : ''}>1,234.56 (US)</option>
                </select>
            </div>
            <div class="mapping-row">
                <span class="mapping-field">Signs</span>
                <label class="form-helper" style="display:flex;align-items:center;gap:6px">
                    <input type="checkbox" id="map_invertSign" ${draft.invertSign ? 'checked' : ''}>
                    Money out is written as a positive number
                </label>
                ${draft.signNote ? `<span class="mapping-warn">${escapeHTML(draft.signNote)}</span>` : ''}
            </div>
        </div>`;
    openModal('mappingDialog');
    bindMappingPreview();
}

/** Keep the sample text in step with whatever column the user just chose. */
let mappingPreviewBound = false;
function bindMappingPreview() {
    if (mappingPreviewBound) return;
    mappingPreviewBound = true;
    el('mappingBody').addEventListener('change', (event) => {
        const select = event.target.closest('[data-map-field]');
        if (!select) return;
        const target = el('mappingBody').querySelector(`[data-sample-for="${select.dataset.mapField}"]`);
        if (!target) return;
        const idx = select.value === '' ? null : Number(select.value);
        const rows = state.importSampleRows || [];
        const vals = idx === null ? [] : rows.map(r => r[idx]).filter(v => v !== undefined && v !== '');
        target.textContent = vals.length ? `e.g. ${vals.slice(0, 3).join('  ·  ')}` : '';
    });
}

export async function confirmMapping() {
    const draft = state.importDraft;
    const num = id => { const v = el(id).value; return v === '' ? null : Number(v); };

    const columnMap = {};
    for (const f of ['date', 'valueDate', 'description', 'amount', 'debit', 'credit', 'currency', 'balance']) {
        const node = el(`map_${f}`);
        if (!node) continue;
        const v = node.value === '' ? null : Number(node.value);
        if (v !== null) columnMap[f] = v;
    }

    if (columnMap.date === undefined || columnMap.description === undefined) {
        showToast('Date and description are both required.', 'warning');
        return;
    }
    if (columnMap.amount === undefined && (columnMap.debit === undefined && columnMap.credit === undefined)) {
        showToast('Pick either a signed amount column, or a debit and credit pair.', 'warning');
        return;
    }

    const account = state.accounts.find(a => a.id === state.importAccountId);
    const profile = {
        accountId: state.importAccountId,
        label: account ? `${account.bankName} · ${account.label}` : 'statement',
        // A wallet's file describes movements the funding account also carries,
        // so it enriches rather than standing on its own.
        sourceRole: account?.type === 'wallet' ? 'detail' : 'statement',
        formatKind: 'csv',
        signature: draft.signature,
        columnMap,
        dateFormat: el('map_dateFormat').value,
        decimalStyle: el('map_decimalStyle').value,
        invertSign: el('map_invertSign').checked,
        skipRows: draft.skipRows
    };

    closeModal('mappingDialog');
    try {
        const saved = await saveProfile(profile);
        showToast('Format learned — future files from this bank import automatically.');
        runImport(saved || profile);
    } catch (err) {
        showToast('Could not save the format: ' + err.message, 'error');
        runImport(profile); // the import itself is still worth doing
    }
}

// ── parse → enrich → categorise → dedupe ────────────────────────────────────

function runImport(profile) {
    const accountId = state.importAccountId;
    // The fallback for a file with no currency column. Recorded by the row
    // contract as a guess ('account'), never as something the file said.
    const currency = state.accounts.find(a => a.id === accountId)?.currency || null;
    const parsed = parseWithProfile(state.importText, profile, { accountId, source: profile.label, currency });
    ingest(parsed, { profile, sourceRole: profile.sourceRole || 'statement' });
}

/**
 * Everything after parsing: enrich → categorise → dedupe → review.
 *
 * Takes a parse RESULT rather than a file, so every adapter — the profile-based
 * tabular reader, the interchange-standard readers, and in future the PDF
 * extractor — funnels through one pipeline. Nothing below this line knows or
 * cares which format the rows came from.
 */
function ingest(parsed, { profile = null, sourceRole = 'statement' } = {}) {
    const accountId = state.importAccountId;
    const account = state.accounts.find(a => a.id === accountId);
    const isDetail = sourceRole === 'detail';

    if (!parsed.rows.length) {
        status(`<div class="review-banner"><span>⚠</span><span>
            No usable rows${parsed.skipped ? ` — ${parsed.skipped} line${parsed.skipped === 1 ? '' : 's'} could not be read` : ''}.</span></div>`);
        return;
    }

    let rows = parsed.rows;
    let enriched = [], aggregated = [], pending = [], replayed = [];

    if (isDetail) {
        // A wallet file improves rows the funding account already holds.
        const fundingId = account?.linkedAccountId || accountId;
        // Only the window the wallet file covers can possibly match. Handing
        // over the whole account's history made the merge quadratic against
        // years of rows it could never pair with.
        const window = dateWindow(rows, 3);
        const targets = state.transactions.filter(t =>
            t.accountId === fundingId && (!window || (t.date >= window.from && t.date <= window.to)));
        const merged = mergeDetailSource(
            targets,
            rows.map(r => ({ ...r, accountId: fundingId })),
            { accountId: fundingId, label: account ? `${account.bankName} · ${account.label}` : 'wallet' }
        );
        enriched = merged.enriched;
        aggregated = merged.aggregated;
        pending = merged.pending;
        // Only rows that actually changed need writing back.
        rows = merged.merged.filter(m => m.enrichedFrom);
    } else {
        // Replay any wallet rows still waiting for a bank line to attach to.
        const waiting = state.pendingDetails.filter(p => (p.accountId || accountId) === accountId);
        replayed = waiting;
        if (waiting.length) {
            const merged = mergeDetailSource(rows, waiting, { accountId, label: 'wallet' });
            rows = merged.merged;
            enriched = merged.enriched;
            aggregated = merged.aggregated;
            pending = merged.pending;
        }
    }

    const ruled = applyRules(rows, state.rules);

    // A card section describes the CARD, not the account the statement was
    // imported into. Routing is decided here, before dedupe, and not later at
    // commit time: dedupe is per account, so checking a card purchase against
    // the current account's history would match nothing and re-add every
    // purchase on every import.
    //
    // Only UNPROVEN card purchases move to the card. A purchase that replaced a
    // settlement debited from this account stays here — see isRoutableCardRow.
    const cardGroups = [...new Set(
        ruled.rows.filter(isRoutableCardRow).map(r => r.detailGroup)
    )];
    const cardPlan = cardGroups.length ? planCardRouting(cardGroups, state.accounts, accountId) : [];
    const planByGroup = new Map(cardPlan.map(p => [p.group, p]));
    for (const row of ruled.rows) {
        const p = isRoutableCardRow(row) ? planByGroup.get(row.detailGroup) : null;
        if (!p) continue;
        if (p.action === 'use') row.accountId = p.accountId;
        else if (p.action === 'create') row.pendingAccountGroup = p.group;
        else {
            // Two cards and nothing to tell them apart. Putting the spending on
            // the wrong card is worse than leaving it here and saying so.
            row.needsReview = true;
            row.note = 'More than one card could be the owner of this purchase — check which account it belongs to.';
        }
    }

    const fpCache = new Map();
    const fingerprintsFor = id => {
        if (!fpCache.has(id)) fpCache.set(id, buildExistingFingerprints(
            state.transactions.filter(t => t.accountId === id)));
        return fpCache.get(id);
    };
    const dedupePerAccount = list => {
        const byDestination = new Map();
        for (const r of list) {
            const key = r.pendingAccountGroup ? `new:${r.pendingAccountGroup}` : r.accountId;
            if (!byDestination.has(key)) byDestination.set(key, []);
            byDestination.get(key).push(r);
        }
        const fresh = [], duplicates = [];
        for (const [key, rowsFor] of byDestination) {
            // An account that does not exist yet has no history to check against.
            const existing = String(key).startsWith('new:')
                ? buildExistingFingerprints([])
                : fingerprintsFor(key);
            const res = dedupeSpendRows(rowsFor, existing);
            fresh.push(...res.fresh);
            duplicates.push(...res.duplicates);
        }
        return { fresh, duplicates };
    };

    const { fresh, duplicates } = isDetail
        ? { fresh: rows, duplicates: [] }          // enrichment updates rows in place
        : dedupePerAccount(ruled.rows);

    state.importResult = {
        profile, isDetail, format: parsed.format || 'csv',
        fresh, duplicates, enriched, aggregated, pending, replayed,
        errors: parsed.errors, uncategorised: fresh.filter(r => !r.category).length,
        // Carried through from the adapter. Dropping these made showReport()
        // read `chain.checked` as undefined and print "this statement prints no
        // running balance" for EVERY pdf import — the one guardrail that makes
        // AI extraction safe was reporting itself as absent.
        chain: parsed.chain || null,
        flagged: parsed.flagged || 0,
        provider: parsed.provider || null,
        chunks: parsed.chunks || 0,
        chunksFailed: parsed.chunksFailed || 0,
        broadened: !!parsed.broadened,
        rowOrder: parsed.rowOrder || null,
        skipped: parsed.skipped || 0,
        skippedRows: parsed.skippedRows || [],
        total: parsed.total || null,
        totalWhy: parsed.totalWhy || null,
        detail: parsed.detail || null,
        cardPlan,
        // What this document turned out to contain, and whether we have seen a
        // statement shaped like it before. A layout the user has already
        // confirmed imports without asking again; anything else is shown.
        sections: parsed.headings
            ? summarizeSections(ruled.rows, parsed.headings, {
                accounts: state.accounts, importAccountId: accountId, cardPlan })
            : [],
        sectionSig: parsed.headings ? sectionSignature(parsed.headings) : null,
        knownLayout: parsed.headings
            ? state.profiles.some(p => p.formatKind === 'pdf'
                && p.signature === sectionSignature(parsed.headings))
            : false
    };
    showReport();
}

function showReport() {
    const r = state.importResult;
    const bucket = (n, label, cls = '') =>
        `<div class="import-bucket ${cls}"><div class="import-bucket-n">${n}</div><div class="import-bucket-l">${escapeHTML(label)}</div></div>`;

    const sample = r.fresh.slice(0, 6).map(t => `
        <tr class="tx-row"><td class="tx-date">${escapeHTML(fmtDate(t.date))}</td>
        <td>${escapeHTML((t.merchant || t.description).slice(0, 42))}</td>
        <td class="num tx-amount ${t.amount > 0 ? 'in' : 'out'}">${escapeHTML(fmtMoney(t.amount, t.currency))}</td></tr>`).join('');

    // Say why no mapping was needed. Otherwise a file that imports with no
    // questions looks like the app skipped a step rather than like the format
    // being self-describing.
    let formatNote = '';
    if (r.format === 'pdf') {
        const chain = r.chain || {};
        // How MUCH of the parse is vouched for, not just whether the checks that
        // ran passed. One checkable pair in four hundred rows also yields "all
        // checks reconcile", which reads as verification and is not.
        const verdict = chain.checked
            ? (chain.valid
                ? `${chain.checked} of ${chain.pairs} balance checks reconcile`
                : `${r.flagged} row${r.flagged === 1 ? '' : 's'} flagged — the amount doesn't match the statement's running balance`)
            : 'this statement prints no running balance, so the amounts could not be cross-checked';
        formatNote = `<p class="form-helper" style="margin-bottom:10px">
            Read from PDF${r.provider ? ` by ${escapeHTML(r.provider)}` : ''} — ${escapeHTML(verdict)}.
            ${r.broadened ? `This bank does not start its rows with a date, so a wider net was used —
            worth a look over the rows below before adding them.` : ''}</p>`;
    } else if (r.format && r.format !== 'csv') {
        formatNote = `<p class="form-helper" style="margin-bottom:10px">Read as <strong>${escapeHTML(r.format.toUpperCase())}</strong> — a standard bank format, so nothing needed configuring.</p>`;
    }

    status(`
        ${formatNote}
        <div class="import-buckets">
            ${bucket(r.isDetail ? r.enriched.length : r.fresh.length, r.isDetail ? 'improved' : 'new', 'new')}
            ${bucket(r.duplicates.length, 'already had')}
            ${bucket(r.pending.length, 'not on the bank yet', r.pending.length ? 'warn' : '')}
            ${bucket(r.errors.length, 'unreadable', r.errors.length ? 'warn' : '')}
        </div>
        ${r.chunksFailed ? `<div class="review-banner"><span>⚠</span><span>
            ${r.chunksFailed} of ${r.chunks} sections of this document could not be read, so transactions from
            ${r.chunksFailed === 1 ? 'it are' : 'them are'} missing. Re-importing is safe — anything already added is skipped.</span></div>` : ''}
        ${r.detail && r.detail.total ? `<p class="form-helper">
            ${r.detail.itemised ? `<strong>${r.detail.itemised}</strong> card purchase${r.detail.itemised === 1 ? '' : 's'}
            replaced the card payment ${r.detail.itemised === 1 ? 'it adds' : 'they add'} up to, so this month shows what
            was actually bought instead of one lump settlement. The total is unchanged. ` : ''}
            ${r.detail.enriched ? `${r.detail.enriched} improved the description of the payment
            ${r.detail.enriched === 1 ? 'it belongs' : 'they belong'} to. ` : ''}
            ${r.detail.promoted ? `<strong>${r.detail.promoted}</strong> card purchase${r.detail.promoted === 1 ? '' : 's'}
            belong to a card period that this statement does not settle — on a credit card the payment shown
            covers the previous month. They were imported as spending and flagged, because they are the money.
            ${r.detail.settlementsLinked
                ? `The card repayment on this statement was marked as a <em>transfer</em> automatically, so the same
                   spending is not counted twice.`
                : `Check whether a card repayment on this statement should be marked as a <em>transfer</em> — otherwise
                   the same spending is counted twice.`} ` : ''}
            ${(r.cardPlan || []).some(p => p.action === 'create')
                ? `A card account will be created for them, linked to this one, so the purchases and the repayment
                   stay separate. ` : ''}
            ${(r.cardPlan || []).some(p => p.action === 'ambiguous')
                ? `More than one card could own them, so they stay on this account and are flagged rather than
                   filed against the wrong card. ` : ''}
            ${r.detail.unmatched ? `<strong>${r.detail.unmatched}</strong> could not be tied to a payment, so
            ${r.detail.unmatched === 1 ? 'its detail was' : 'their detail was'} not recorded — the spending is still
            counted in the payment total, but not itemised.` : ''}</p>` : ''}
        ${r.skipped ? `<details style="margin:8px 0">
            <summary class="form-helper" style="cursor:pointer">
                ${r.skipped} line${r.skipped === 1 ? ' was' : 's were'} read but not imported — see which and why
            </summary>
            <table class="tx-table" style="margin-top:6px">
                ${(r.skippedRows || []).map(x => `<tr class="tx-row">
                    <td>${escapeHTML(x.description)}</td>
                    <td class="num">${x.amount === null ? '' : escapeHTML(fmtMoney(x.amount))}</td>
                    <td class="form-helper">${escapeHTML(x.reason)}</td></tr>`).join('')}
            </table>
            ${r.skipped > (r.skippedRows || []).length
                ? `<p class="form-helper">…and ${r.skipped - r.skippedRows.length} more.</p>` : ''}
            <p class="form-helper">These are positions, or an itemisation of a movement already listed —
            counting them would count the same money twice. If one of them looks like a real movement of this
            account, that is worth telling me about.</p>
        </details>` : ''}
        ${r.total && r.total.checked && r.total.ok ? `<p class="form-helper">
            The statement's own opening and closing balance
            (${escapeHTML(fmtMoney(r.total.opening))} → ${escapeHTML(fmtMoney(r.total.closing))})
            account for every row taken from it, exactly. Nothing is missing and nothing extra was added.</p>` : ''}
        ${r.total && r.total.checked && !r.total.ok ? `<div class="review-banner"><span>⚠</span><span>
            These rows do not add up to the change in the statement's own balance
            ${escapeHTML(r.total.reason || '')}.
            ${r.totalWhy?.fixedByDropping ? `
                <strong>They do add up without the ${r.totalWhy.unbalanced} row${r.totalWhy.unbalanced === 1 ? '' : 's'}
                that carry no running balance</strong> (${escapeHTML(fmtMoney(r.totalWhy.unbalancedSum))} in total):
                those are usually a card, loan or wallet section — money that belongs to another account, or that
                itemises a movement already listed here. Check them below before adding.
                ${r.totalWhy.sample?.length ? `<br><span class="form-helper">${
                    r.totalWhy.sample.map(x => escapeHTML(`${x.description} ${fmtMoney(x.amount)}`)).join(' · ')}</span>` : ''}`
            : r.totalWhy?.unbalanced ? `
                ${r.totalWhy.unbalanced} row${r.totalWhy.unbalanced === 1 ? '' : 's'} carry no running balance
                (${escapeHTML(fmtMoney(r.totalWhy.unbalancedSum))}), but leaving them out does not make it add up either —
                so a movement may also be missing.`
            : `Either a movement is missing, or something was imported that is not a movement of this account —
                a loan or card section, say.`}
            Worth checking before adding.</span></div>` : ''}
        ${r.format === 'pdf' && r.chain && !r.chain.pairs ? `<div class="review-banner"><span>⚠</span><span>
            Nothing in this document could be cross-checked. It prints no running balance, so the usual test —
            that each amount matches the balance either side of it — has nothing to work with. The rows may be
            perfectly correct; they are simply unverified, so they are worth reading before you add them.</span></div>` : ''}
        ${r.flagged ? `<div class="review-banner"><span>⚠</span><span>
            ${r.flagged} row${r.flagged === 1 ? '' : 's'} did not reconcile with the statement's running balance and
            ${r.flagged === 1 ? 'is' : 'are'} marked for review.</span></div>` : ''}
        ${r.uncategorised ? `<p class="form-helper">${r.uncategorised} of them have no category yet — you can file them from the ledger, and each correction teaches a rule.</p>` : ''}
        ${r.pending.length ? `<p class="form-helper">
            ${r.pending.length} payment${r.pending.length === 1 ? '' : 's'} from this wallet ${r.pending.length === 1 ? 'has' : 'have'} no matching line on the bank statement yet —
            usually because the bank hasn't posted ${r.pending.length === 1 ? 'it' : 'them'}. They're kept aside and matched automatically next time you import that account.</p>` : ''}
        ${r.aggregated.length ? `<p class="form-helper">${r.aggregated.length} bank line${r.aggregated.length === 1 ? '' : 's'} looked like several wallet payments posted together — flagged for review.</p>` : ''}
        ${r.errors.length ? `<details><summary class="form-helper">Show ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}</summary>
            <div class="merge-preview">${r.errors.slice(0, 12).map(e => `${e.line !== undefined ? `line ${e.line}: ` : ''}${escapeHTML(e.reason)}`).join('<br>')}</div></details>` : ''}
        ${sample ? `<table class="tx-table" style="margin-top:12px"><tbody>${sample}</tbody></table>
            ${r.fresh.length > 6 ? `<p class="form-helper">…and ${r.fresh.length - 6} more.</p>` : ''}` : ''}
        ${r.sections && r.sections.length ? `
            <div class="import-sections" style="margin-top:12px">
                <p class="form-helper">${r.knownLayout
                    ? 'This matches a statement layout you have confirmed before, so nothing needed asking.'
                    : '<strong>First statement from this bank.</strong> Nothing has been assumed — this is what was found:'}</p>
                <ul style="margin:6px 0 0 18px">
                    ${r.sections.map(sec => `<li class="form-helper">
                        <strong>${escapeHTML(sec.heading.slice(0, 60))}</strong> — ${sec.rows}
                        row${sec.rows === 1 ? '' : 's'}, into ${escapeHTML(sec.destination)}${
                        sec.verifiable ? ', checked against the running balance' : ''}</li>`).join('')}
                </ul>
                ${!r.knownLayout ? `<button class="btn btn-sm btn-ghost-spend" style="margin-top:8px"
                    data-act="confirm-layout">Looks right — remember this layout</button>` : ''}
            </div>` : ''}
        <p class="form-helper" style="margin-top:10px">Nothing is saved until you press the button.</p>
        <div class="action-buttons-row" style="margin-top:8px">
            <button class="btn btn-sm btn-primary-spend" data-act="commit-import"
                    ${!r.fresh.length && !r.pending.length ? 'disabled' : ''}>
                ${r.fresh.length || r.pending.length ? 'Add to ledger' : 'Nothing to add'}
            </button>
            <button class="btn btn-sm btn-ghost-spend" data-act="cancel-import">Cancel</button>
        </div>`);
}

export function cancelImport() {
    state.importResult = null;
    state.importText = null;
    status('<p class="form-helper">Import cancelled — nothing was saved.</p>');
    // Cancelling one file of a batch skips that file, not the rest of them.
    if ((state.importQueue || []).length) processQueue();
    else finishBatch();
}

/**
 * Remember this bank's layout, so the next statement shaped like it imports
 * without asking again.
 *
 * Keyed on the heading signature rather than on the account, because it is the
 * DOCUMENT that is being recognised. A bank that redesigns its statement
 * produces a different signature, misses, and is shown again — which is the
 * point: a stale layout replayed silently is how a card section would start
 * being read as account movements without anyone noticing.
 */
export async function confirmLayout() {
    const r = state.importResult;
    if (!r?.sectionSig) return;
    try {
        await saveProfile({
            accountId: state.importAccountId,
            label: r.sections.map(s => s.heading).join(' | ').slice(0, 80),
            formatKind: 'pdf',
            signature: r.sectionSig,
            sectionMap: { sections: r.sections }
        });
        r.knownLayout = true;
        showToast('Layout remembered — the next statement like this will not ask.');
        showReport();
    } catch (err) {
        showToast('Could not remember the layout: ' + err.message, 'error');
    }
}

/**
 * @param {{silent?: boolean}} [opts] silent: this file passed every check and is
 *   being saved as part of a batch, so it announces itself in the batch summary
 *   rather than with its own toast and re-render.
 */
export async function commitImport({ silent = false } = {}) {
    const r = state.importResult;
    if (!r) return;
    const btnRow = el('importStatus')?.querySelector('.action-buttons-row');
    if (btnRow && !silent) btnRow.innerHTML = '<span class="form-helper">Saving…</span>';

    try {
        // Card accounts are created here, not while analysing: until the user
        // commits the import, nothing about their setup should change.
        const toCreate = (r.cardPlan || []).filter(p => p.action === 'create');
        for (const plan of toCreate) {
            const made = await saveAccount(plan.proposal);
            if (!made?.id) continue;
            for (const row of r.fresh)
                if (row.pendingAccountGroup === plan.group) {
                    row.accountId = made.id;
                    delete row.pendingAccountGroup;
                }
        }
        // A row whose card account could not be created must not fall back to
        // the current account, where its spending would collide with the
        // repayment. Better to stop than to file it somewhere wrong.
        const stranded = r.fresh.filter(row => row.pendingAccountGroup);
        if (stranded.length) throw new Error(`${stranded.length} card row(s) had no account to go to.`);

        // One id across everything this commit writes, so it can be taken back
        // as a unit. Generated here rather than when the file was read: an
        // import that is never committed should leave no trace at all.
        const importId = crypto.randomUUID();
        for (const row of r.fresh) row.importId = importId;

        if (r.fresh.length) await saveTransactions(r.fresh);
        // Now, not when the file was read: an import that was cancelled must
        // leave nothing behind, including a learned account reference.
        await rememberAccountRefs();
        state.lastImport = r.fresh.length
            ? { id: importId, rows: r.fresh.length, at: Date.now() }
            : state.lastImport;
        if (r.pending.length) await savePendingDetails(r.pending);
        // Anything that finally found its bank line is no longer pending.
        //
        // Scoped to the rows this import actually replayed (`r.replayed`).
        // Filtering over the whole of state.pendingDetails deleted every row
        // belonging to a DIFFERENT account, because none of them can appear in
        // this import's leftovers — silent, irreversible loss of exactly the
        // descriptions the categoriser depends on, triggered by the second
        // account with unmatched wallet rows.
        const stillPending = new Set(r.pending.map(x => x.fingerprint));
        const attached = (r.replayed || [])
            .map(p => p.fingerprint)
            .filter(fp => fp && !stillPending.has(fp));
        if (attached.length) await clearPendingDetails(attached);

        // What this import actually did, recorded whether or not it went well.
        // The defects worth catching here do not throw: rows that reconcile
        // individually but should never have been imported, a section quietly
        // missed, a statement nothing could verify. Those show up as a verdict,
        // not an exception, so the verdict is what gets written down.
        reportDiagnostic('spend-import', {
            format: r.format,
            provider: r.provider || null,
            parsed: r.fresh.length,
            duplicates: r.duplicates.length,
            skipped: r.skipped || 0,
            flagged: r.flagged || 0,
            broadened: !!r.broadened,
            rowOrder: r.rowOrder || null,
            chainChecked: r.chain?.checked ?? null,
            chainPairs: r.chain?.pairs ?? null,
            chainValid: r.chain?.valid ?? null,
            totalOk: r.total?.checked ? !!r.total.ok : null,
            totalReason: r.total?.ok === false ? (r.total.reason || 'unreconciled') : null,
            detailTotal: r.detail?.total ?? 0,
            detailItemised: r.detail?.itemised ?? 0,
            detailPromoted: r.detail?.promoted ?? 0,
            settlementsLinked: r.detail?.settlementsLinked ?? 0,
            cardAccountsCreated: toCreate.length,
            signature: r.sectionSig || null
        });

        const n = r.isDetail ? r.enriched.length : r.fresh.length;
        if (!silent) showToast(`${n} transaction${n === 1 ? '' : 's'} ${r.isDetail ? 'improved' : 'added'}.`);
        state.importResult = null;
        state.importText = null;
        // Show what was just imported. A filter left over from before — the type
        // filter on `review`, an account, a chosen month — survives the import
        // and can hide every new row, so a successful import reads as one that
        // did nothing.
        clearViewFilters(state);

        // Once both legs are in — the card's purchases and the payment that
        // settles them — the payment is a transfer between the user's own
        // accounts, and leaving it as spending counts the same money twice.
        // Pairing is deliberately not automatic (it rewrites rows), but it has
        // to be OFFERED at the moment both legs arrive: a button nobody knows
        // about is why these were being reclassified by hand, one row at a time.
        const candidates = state.transactions.filter(t => !t.transferPairId && t.category !== 'transfer');
        state.transferCandidates = detectInternalTransfers(candidates).pairs.length;

        if (!silent) {
            renderAll();
            renderImportSection();
            // Back to the queue, if this commit was the person clearing the file
            // that had stopped it.
            if ((state.importQueue || []).length) await processQueue();
            else finishBatch();
        }
    } catch (err) {
        // Re-importing is safe — the fingerprint upsert skips anything already
        // written — but only if the message says so. "Could not save" alone
        // reads as total loss and invites a panicked retry of the whole file.
        const saved = Number(err?.saved) || 0;
        showToast(saved
            ? `Saved ${saved} before failing — press Add again to finish the rest. (${err.message})`
            : 'Could not save: ' + err.message, 'error', 9000);
        reportHandled(err, { action: 'commit-import', rows: saved });
        showReport();
    }
}

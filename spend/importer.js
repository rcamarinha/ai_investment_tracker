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

import state from './state.js?v=3.44.0';
import { escapeHTML, fmtMoney, fmtDate, showToast, openModal, closeModal } from './utils.js?v=3.44.0';
import {
    saveTransactions, saveProfile, savePendingDetails, clearPendingDetails, requireAuth
} from './storage.js?v=3.44.0';
import { renderAll } from './ledger.js?v=3.44.0';
import {
    buildProfileDraft, parseWithProfile, headerSignature, sniffCsv,
    applyRules, dedupeSpendRows, buildExistingFingerprints, mergeDetailSource,
    DATE_FORMATS
} from '../services/import-banks.js';
import { parseStandard } from '../services/import-standards.js';
import { importPdfStatement } from './pdf.js?v=3.44.0';
import { reportHandled } from '../services/telemetry.js';

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
            <label class="form-label" for="importAccount">Which account is this statement for?</label>
            <select class="form-select" id="importAccount">
                ${state.accounts.map(a => `<option value="${a.id}">${escapeHTML(`${a.bankName} · ${a.label}`)}${a.type === 'wallet' ? ' (wallet)' : ''}</option>`).join('')}
            </select>
        </div>
        <div class="form-group">
            <label class="form-label" for="importFile">Statement file</label>
            <input class="form-input" type="file" id="importFile" accept=".csv,.tsv,.txt,.ofx,.qfx,.qbo,.xml,.pdf"
                   onchange="spendHandleFile(this)">
            <span class="form-helper">
                <strong>OFX or QFX imports with no setup at all</strong> — it's a standard format, so nothing needs mapping.
                CSV and TSV work too: ${known ? `${known} format${known === 1 ? '' : 's'} already learned, and those import without asking anything.` : 'the first file from a bank asks you to confirm its columns once, then never again.'}
            </span>
        </div>
        <div id="importStatus"></div>`;
}

function status(html) {
    const s = el('importStatus');
    if (s) s.innerHTML = html;
}

// ── file → text ─────────────────────────────────────────────────────────────

export async function handleFile(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!requireAuth('import a statement')) return;

    state.importAccountId = el('importAccount')?.value || state.accounts[0]?.id;

    if (/\.pdf$/i.test(file.name)) {
        input.value = '';
        await runPdfImport(file);
        return;
    }

    try {
        const text = await file.text();
        state.importText = text;
        state.importFileName = file.name;
        analyze();
    } catch (err) {
        status(`<div class="review-banner"><span>⚠</span><span>Could not read that file: ${escapeHTML(err.message)}</span></div>`);
    }
    input.value = '';
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
async function runPdfImport(file) {
    const accountId = state.importAccountId;
    const account = state.accounts.find(a => a.id === accountId);
    const profile = state.profiles.find(p => p.accountId === accountId && p.formatKind === 'pdf');

    status(`<p class="form-helper">Reading ${escapeHTML(file.name)}…</p>`);
    try {
        const result = await importPdfStatement(file, {
            accountId,
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
    const parsed = parseWithProfile(state.importText, profile, { accountId, source: profile.label });
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

    const existing = buildExistingFingerprints(
        state.transactions.filter(t => t.accountId === (isDetail ? (account?.linkedAccountId || accountId) : accountId))
    );
    const { fresh, duplicates } = isDetail
        ? { fresh: rows, duplicates: [] }          // enrichment updates rows in place
        : dedupeSpendRows(ruled.rows, existing);

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
        detail: parsed.detail || null
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
            Read from PDF${r.provider ? ` by ${escapeHTML(r.provider)}` : ''} — ${escapeHTML(verdict)}.</p>`;
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
            ${r.detail.unmatched ? `<strong>${r.detail.unmatched}</strong> could not be tied to a payment, so
            ${r.detail.unmatched === 1 ? 'its detail was' : 'their detail was'} not recorded — the spending is still
            counted in the payment total, but not itemised.` : ''}</p>` : ''}
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
}

export async function commitImport() {
    const r = state.importResult;
    if (!r) return;
    const btnRow = el('importStatus')?.querySelector('.action-buttons-row');
    if (btnRow) btnRow.innerHTML = '<span class="form-helper">Saving…</span>';

    try {
        if (r.fresh.length) await saveTransactions(r.fresh);
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

        const n = r.isDetail ? r.enriched.length : r.fresh.length;
        showToast(`${n} transaction${n === 1 ? '' : 's'} ${r.isDetail ? 'improved' : 'added'}.`);
        state.importResult = null;
        state.importText = null;
        renderAll();
        renderImportSection();
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

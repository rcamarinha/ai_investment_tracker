/**
 * import-banks.js — pure statement ingestion for the Spend module.
 *
 * PURE by contract: no DOM, no network, no service imports beyond the pure CSV
 * primitives in import-brokers.js. Tests import this file directly, so it must
 * never grow a `src/` mirror (see CLAUDE.md).
 *
 * The design problem this file solves: every bank exports a different shape,
 * and shapes change when a bank redesigns its download. Writing one parser per
 * bank means writing another one next year, and a new user's bank is never in
 * the list. So a format is LEARNED ONCE — auto-mapped where the column names
 * are recognisable, mapped by hand where they are not, always user-confirmed —
 * and stored as a profile. Every later import of that format replays the
 * profile deterministically, at no cost and with no guessing.
 *
 * `needsAi` is reported for callers that can offer AI column inference. No such
 * path exists yet; the fallback today is the manual mapping dialog, which is
 * why the engine works for any bank in any language without a code change.
 *
 * Three problems live here and must not be conflated, because conflating any
 * two corrupts the ledger while leaving the numbers looking plausible:
 *   1. FORMAT       — same money, different file layout      → profiles
 *   2. FIDELITY     — same movement, two records (MB WAY)    → merge, not dedupe
 *   3. DUPLICATION  — same movement, imported twice          → fingerprint dedupe
 */

// Bare, like every other services/ → services/ import. That path is
// cache-busted by header (max-age=0, must-revalidate), and a `?v=` query here
// would create a SECOND module instance — the bug v3.41.0 removed.
import {
    parseFlexibleNumber, detectCsvSeparator, splitCsvLine, normHeader
} from './import-brokers.js';
import { normalizeRow, validateRow } from './import-contract.js';

// ── header aliases ──────────────────────────────────────────────────────────
// Portuguese first: these are PT retail bank exports, and the English aliases
// are the fallback rather than the other way round.

// Aliases verified against real exports from five PT banks (Bankinter, Banco
// BEST, Santander Totta, Revolut, and one semicolon CSV export). Each entry
// below that looks oddly specific is a real column header from one of them.
const FIELD_ALIASES = {
    date: ['data mov', 'data movimento', 'data operacao', 'data', 'date',
           'transaction date', 'completed date', 'started date', 'booking date'],
    // "Data-valor" normalises to "datavalor" — punctuation is stripped, so the
    // spaced alias alone would miss it and the loose 'valor' alias could then
    // hand the column to `amount`.
    valueDate: ['data valor', 'datavalor', 'data de valor', 'value date', 'data efectiv'],
    description: ['descricao', 'descritivo', 'description', 'movimento cred', 'movimento',
                  'historico', 'detalhe', 'designacao', 'narrative', 'reference', 'concept'],
    amount: ['montante', 'movimento cred deb', 'valor', 'amount', 'importancia', 'quantia', 'total'],
    debit: ['dinheiro retirado', 'debito', 'debit', 'saida', 'levantamento', 'despesa',
            'paid out', 'money out', 'a debito'],
    credit: ['dinheiro recebido', 'credito', 'credit', 'entrada', 'deposito', 'receita',
             'paid in', 'money in', 'a credito'],
    balance: ['saldo contabilistico', 'saldo disponivel', 'saldo apos', 'saldo', 'balance'],
    currency: ['moeda', 'currency', 'divisa', 'ccy']
};

// Fields that cannot share a column with anything else.
const EXCLUSIVE_FIELDS = Object.keys(FIELD_ALIASES);

/** Score how well a header cell names a field. Exact beats prefix beats substring. */
function scoreAlias(normalized, alias) {
    if (!normalized) return 0;
    if (normalized === alias) return 100;
    if (normalized.startsWith(alias)) return 60;
    if (normalized.includes(alias)) return 30;
    return 0;
}

/**
 * Map header columns to fields.
 *
 * Assignment is globally greedy by score rather than field-by-field, because
 * "Data Valor" must win the valueDate slot outright instead of being grabbed by
 * `date`'s looser "data" alias, and "Valor" must not be stolen by it either.
 */
export function autoMapColumns(header = []) {
    // normHeader strips punctuation but leaves the gap behind, so
    // "Movimento Cred. / Deb." becomes "movimento cred  deb" with a double
    // space and matches nothing. Collapse runs of whitespace before scoring.
    // Done here rather than in normHeader, which the broker parsers share.
    const normalized = header.map(h => normHeader(h).replace(/\s+/g, ' ').trim());
    const candidates = [];

    for (const field of EXCLUSIVE_FIELDS) {
        FIELD_ALIASES[field].forEach((alias, aliasRank) => {
            normalized.forEach((cell, col) => {
                const base = scoreAlias(cell, alias);
                if (!base) return;
                // Earlier aliases are the more canonical spelling.
                candidates.push({ field, col, score: base - aliasRank, alias });
            });
        });
    }

    candidates.sort((a, b) => b.score - a.score || a.col - b.col);
    const takenField = new Set(), takenCol = new Set();
    const columnMap = {}, scores = {};
    for (const c of candidates) {
        if (takenField.has(c.field) || takenCol.has(c.col)) continue;
        takenField.add(c.field); takenCol.add(c.col);
        columnMap[c.field] = c.col;
        scores[c.field] = c.score;
    }

    const hasAmount = columnMap.amount !== undefined;
    const hasDebitCredit = columnMap.debit !== undefined && columnMap.credit !== undefined;
    const unresolved = [];
    if (columnMap.date === undefined) unresolved.push('date');
    if (columnMap.description === undefined) unresolved.push('description');
    if (!hasAmount && !hasDebitCredit) unresolved.push('amount');

    // A weak substring match is a guess, and a guess the user never sees is how
    // a whole statement lands in the wrong column silently.
    const weak = ['date', 'description', 'amount', 'debit', 'credit']
        .filter(f => columnMap[f] !== undefined && scores[f] < 60);

    return {
        columnMap, scores, unresolved, weak,
        amountMode: hasAmount ? 'signed' : hasDebitCredit ? 'debit_credit' : null,
        confident: unresolved.length === 0 && weak.length === 0
    };
}

// ── CSV sniffing ────────────────────────────────────────────────────────────

/**
 * Find the real header row and tokenize.
 *
 * PT bank exports routinely open with preamble lines — account holder, IBAN,
 * date range, a blank line — before the header. Assuming line 0 is the header
 * turns the entire file into one unparseable row.
 */
export function sniffCsv(text, options = {}) {
    const maxPreamble = options.maxPreamble ?? 15;
    const rawLines = String(text || '').split(/\r?\n/);
    const lines = rawLines.filter(l => l.trim() !== '');
    if (!lines.length) return { header: [], rows: [], sep: ',', skipRows: 0, headerLine: null };

    // Width of the body: the header is the line whose column count the DATA
    // rows agree with. This is a structural signal that works in any language,
    // which matters because alias hits alone would make a statement in an
    // unsupported language fail at *finding* its header, not merely at naming
    // its columns.
    const widthVotes = new Map();
    for (let i = 0; i < lines.length; i++) {
        const sep = detectCsvSeparator(lines[i]);
        const n = splitCsvLine(lines[i], sep).length;
        if (n >= 2) widthVotes.set(`${sep}|${n}`, (widthVotes.get(`${sep}|${n}`) || 0) + 1);
    }
    let bodyShape = null, bodyVotes = 0;
    for (const [k, v] of widthVotes) if (v > bodyVotes) { bodyVotes = v; bodyShape = k; }

    let bestIdx = 0, bestScore = -Infinity, bestSep = ',';
    for (let i = 0; i < Math.min(maxPreamble, lines.length); i++) {
        const sep = detectCsvSeparator(lines[i]);
        const cells = splitCsvLine(lines[i], sep);
        if (cells.length < 3) continue;
        const mapped = autoMapColumns(cells);
        // A header row names fields and holds few bare numbers.
        const numericCells = cells.filter(c => c && !Number.isNaN(parseFlexibleNumber(c))).length;
        const matchesBody = bodyShape === `${sep}|${cells.length}` ? 25 : 0;
        const score = Object.keys(mapped.columnMap).length * 10
            + matchesBody
            + cells.length
            - numericCells * 8
            - i; // prefer the earliest row that qualifies
        if (score > bestScore) { bestScore = score; bestIdx = i; bestSep = sep; }
    }

    const header = splitCsvLine(lines[bestIdx], bestSep);
    const rows = lines.slice(bestIdx + 1)
        .map(l => splitCsvLine(l, bestSep))
        // Trailing summary/footer lines rarely match the header width.
        .filter(cells => cells.length >= Math.max(2, Math.floor(header.length / 2)));

    return { header, rows, sep: bestSep, skipRows: bestIdx, headerLine: lines[bestIdx] };
}

/**
 * Stable identity for a file layout — how an incoming file finds its profile.
 * Built from the normalised header so a bank changing capitalisation, accents
 * or the separator does not orphan a profile the user already confirmed.
 */
export function headerSignature(header = []) {
    const basis = header.map(normHeader).filter(Boolean).join('|');
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < basis.length; i++) {
        const c = basis.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    }
    return `sig_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

// ── numbers and dates, resolved by profile rather than guessed per row ──────

export function parseStyledNumber(raw, decimalStyle = 'eu') {
    if (raw === null || raw === undefined) return NaN;
    let s = String(raw).trim();
    if (!s) return NaN;
    s = s.replace(/[^0-9.,()\-+]/g, '');
    s = s.replace(/^\((.+)\)$/, '-$1');
    if (!s || s === '-' || s === '+') return NaN;
    const neg = s.startsWith('-');
    s = s.replace(/[+\-]/g, '');
    if (decimalStyle === 'us') s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? NaN : (neg ? -n : n);
}

/**
 * A comma as the last separator means European. Sampling the whole column beats
 * deciding per row: "1.234" is 1234 in one convention and 1.234 in the other,
 * and only the column as a whole disambiguates it.
 */
export function detectDecimalStyle(samples = []) {
    let eu = 0, us = 0;
    for (const raw of samples) {
        const s = String(raw || '');
        const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
        if (lastDot === -1 && lastComma === -1) continue;
        if (lastComma > lastDot) eu++;
        else if (lastDot > lastComma) us++;
    }
    return { style: us > eu ? 'us' : 'eu', eu, us, ambiguous: eu === 0 && us === 0 };
}

// Ordered by how commonly a retail bank export uses them. Extend this list
// rather than adding branches anywhere — it is data, and the mapping dialog
// renders straight from it.
export const DATE_FORMATS = ['dd-mm-yyyy', 'mm-dd-yyyy', 'yyyy-mm-dd', 'yyyy-dd-mm'];

/**
 * Infer the date layout from the whole column.
 *
 * dd-mm-yyyy and mm-dd-yyyy are indistinguishable for every day <= 12, so a
 * per-row guess silently reorders a third of a statement. If the column never
 * disambiguates itself, say so and let the confirmation dialog decide.
 */
export function detectDateFormat(samples = []) {
    let g1Max = 0, g2Max = 0, sawIsoFirst = false, parsed = 0;
    for (const raw of samples) {
        const m = String(raw || '').trim().match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
        if (!m) continue;
        parsed++;
        const g1 = +m[1], g2 = +m[2];
        if (g1 > 31) sawIsoFirst = true;
        g1Max = Math.max(g1Max, g1);
        g2Max = Math.max(g2Max, g2);
    }
    if (!parsed) return { format: 'dd-mm-yyyy', ambiguous: true, samples: parsed };
    if (sawIsoFirst) return { format: 'yyyy-mm-dd', ambiguous: false, samples: parsed };
    if (g1Max > 12) return { format: 'dd-mm-yyyy', ambiguous: false, samples: parsed };
    if (g2Max > 12) return { format: 'mm-dd-yyyy', ambiguous: false, samples: parsed };
    // Every value <= 12 in both slots. PT is the sane default, but flag it.
    return { format: 'dd-mm-yyyy', ambiguous: true, samples: parsed };
}

export function parseDateWithFormat(raw, format = 'dd-mm-yyyy') {
    const m = String(raw || '').trim().match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
    if (!m) return null;
    let d, mo, y;
    if (format === 'yyyy-mm-dd') { [, y, mo, d] = m; }
    else if (format === 'yyyy-dd-mm') { [, y, d, mo] = m; }
    else if (format === 'mm-dd-yyyy') { [, mo, d, y] = m; }
    else { [, d, mo, y] = m; }
    y = String(y); if (y.length === 2) y = '20' + y;
    const iso = `${y.padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso) ? iso : null;
}

// ── profile drafting ────────────────────────────────────────────────────────

/**
 * Everything the confirmation dialog needs to show a proposed mapping.
 * Never commits: the user confirms (or the AI fills the gaps) before a profile
 * is saved, because a wrong mapping accepted silently poisons the whole ledger.
 */
export function buildProfileDraft(text, options = {}) {
    const { header, rows, sep, skipRows, headerLine } = sniffCsv(text);
    if (!header.length) {
        return { ok: false, reason: 'empty-file', header: [], rows: [] };
    }

    const mapping = autoMapColumns(header);
    const col = (f) => (mapping.columnMap[f] !== undefined ? mapping.columnMap[f] : null);
    const sample = (idx, n = 40) =>
        idx === null ? [] : rows.slice(0, n).map(r => r[idx]).filter(v => v !== undefined && v !== '');

    const dateInfo = detectDateFormat(sample(col('date')));
    const numericSamples = [
        ...sample(col('amount')), ...sample(col('debit')), ...sample(col('credit'))
    ];
    const decimalInfo = detectDecimalStyle(numericSamples);

    // If a signed-amount column never goes negative, either the bank ships
    // debits as positives or this column is not what we think it is.
    let invertSign = false, signNote = null;
    if (col('amount') !== null) {
        const values = sample(col('amount')).map(v => parseStyledNumber(v, decimalInfo.style));
        const finite = values.filter(Number.isFinite);
        if (finite.length && finite.every(v => v >= 0)) {
            invertSign = true;
            signNote = 'no negative values found — assuming debits are positive';
        }
    }

    return {
        ok: mapping.unresolved.length === 0,
        signature: headerSignature(header),
        header, headerLine, sep, skipRows,
        rowCount: rows.length,
        sampleRows: rows.slice(0, 5),
        columnMap: mapping.columnMap,
        amountMode: mapping.amountMode,
        dateFormat: dateInfo.format,
        dateAmbiguous: dateInfo.ambiguous,
        decimalStyle: decimalInfo.style,
        decimalAmbiguous: decimalInfo.ambiguous,
        invertSign, signNote,
        unresolved: mapping.unresolved,
        weak: mapping.weak,
        // Confident AND unambiguous is the only combination that may skip the
        // dialog. Everything else asks — once per bank, then never again.
        needsConfirmation: !mapping.confident || dateInfo.ambiguous || decimalInfo.ambiguous || invertSign,
        needsAi: mapping.unresolved.length > 0,
        sourceRole: options.sourceRole || 'statement'
    };
}

// ── profile-driven parsing ──────────────────────────────────────────────────

/**
 * Find the row a saved profile describes, by matching its header SIGNATURE.
 *
 * Anchoring on content rather than on the stored `skipRows` line number is the
 * whole point. A bank that adds or removes a preamble line — a new marketing
 * message, a different address block — shifts every index by one. Replaying a
 * remembered line number would then read the wrong row as the header and
 * silently misalign every column in the file, producing a statement that
 * imports "successfully" with the amounts in the wrong fields.
 *
 * Returns null when no line matches, which means the format genuinely changed
 * and the user has to re-confirm rather than the parser guessing.
 */
export function locateHeaderBySignature(text, signature, options = {}) {
    if (!signature) return null;
    const maxScan = options.maxScan ?? 40;
    const lines = String(text || '').split(/\r?\n/).filter(l => l.trim() !== '');
    for (let i = 0; i < Math.min(maxScan, lines.length); i++) {
        const sep = detectCsvSeparator(lines[i]);
        const cells = splitCsvLine(lines[i], sep);
        if (cells.length < 2) continue;
        if (headerSignature(cells) === signature) {
            return { index: i, sep, header: cells, lines };
        }
    }
    return null;
}

export function parseWithProfile(text, profile = {}, options = {}) {
    const accountId = options.accountId || profile.accountId || null;
    const sourceLabel = options.source || profile.label || 'import';
    const decimalStyle = profile.decimalStyle || 'eu';
    const dateFormat = profile.dateFormat || 'dd-mm-yyyy';
    const map = profile.columnMap || {};

    // Replay the profile by locating its header, falling back to fresh
    // detection only when the profile carries no signature (a hand-built
    // profile, or one from before signatures were stored).
    const anchored = locateHeaderBySignature(text, profile.signature);
    let header, rows, headerIndex, headerDrift = false;

    if (anchored) {
        header = anchored.header;
        headerIndex = anchored.index;
        rows = anchored.lines.slice(anchored.index + 1)
            .map(l => splitCsvLine(l, anchored.sep))
            .filter(cells => cells.length >= Math.max(2, Math.floor(header.length / 2)));
    } else {
        const sniffed = sniffCsv(text);
        header = sniffed.header;
        rows = sniffed.rows;
        headerIndex = sniffed.skipRows;
        // The caller should re-confirm the mapping: we are parsing a file whose
        // header no longer matches what this profile was built from.
        headerDrift = !!profile.signature;
    }

    const at = (row, field) => {
        const idx = map[field];
        return idx === undefined || idx === null ? '' : (row[idx] ?? '');
    };

    const out = [], errors = [];
    rows.forEach((row, i) => {
        const lineNo = headerIndex + i + 2;
        const rawDate = at(row, 'date');
        const date = parseDateWithFormat(rawDate, dateFormat);
        if (!date) {
            if (String(row.join('')).trim()) {
                errors.push({ line: lineNo, reason: 'unreadable date', cells: row });
            }
            return;
        }

        let amount = NaN;
        if (map.amount !== undefined && map.amount !== null) {
            amount = parseStyledNumber(at(row, 'amount'), decimalStyle);
            if (profile.invertSign) amount = -amount;
        } else {
            const debit = parseStyledNumber(at(row, 'debit'), decimalStyle);
            const credit = parseStyledNumber(at(row, 'credit'), decimalStyle);
            if (Number.isFinite(debit) && debit !== 0) amount = -Math.abs(debit);
            else if (Number.isFinite(credit) && credit !== 0) amount = Math.abs(credit);
        }
        if (!Number.isFinite(amount) || amount === 0) {
            errors.push({ line: lineNo, reason: 'unreadable or zero amount', cells: row });
            return;
        }

        // The running balance is carried as transport so balance-continuity
        // verification can prove the column mapping was right. It is not ledger
        // data and never reaches the database.
        const balanceRaw = map.balance === undefined || map.balance === null
            ? null : parseStyledNumber(at(row, 'balance'), decimalStyle);

        const candidate = normalizeRow({
            accountId, date,
            description: at(row, 'description'),
            amount,
            currency: at(row, 'currency') || profile.currency || 'EUR',
            balance: Number.isFinite(balanceRaw) ? balanceRaw : null,
            source: sourceLabel,
            sourceRole: profile.sourceRole || 'statement'
        });

        // Every adapter passes through the same gate, so a bad row is reported
        // the same way whatever format it came from.
        const { ok, errors: reasons } = validateRow(candidate);
        if (!ok) {
            errors.push({ line: lineNo, reason: reasons.join('; '), cells: row });
            return;
        }
        out.push(candidate);
    });

    return {
        rows: out, errors, header,
        skipRows: headerIndex,
        headerDrift,
        parsed: out.length,
        skipped: errors.length
    };
}

// ── fingerprints and dedupe ─────────────────────────────────────────────────

/**
 * Matching form of a description: like the fingerprint form, but with long
 * digit runs stripped. Card and reference numbers change on every single
 * transaction, so a rule that keeps them matches exactly once and never again.
 * Kept separate from `normalizeDescription` because fingerprints must NOT drop
 * those digits — they are part of what makes a movement identifiable.
 */
function normalizeForMatching(value) {
    return normalizeDescription(value).replace(/\b\d{3,}\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeDescription(value) {
    return String(value || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Identity of a movement for re-import safety.
 *
 * Built from `rawDescription` deliberately. MB WAY enrichment overwrites
 * `description`; fingerprinting the enriched text would make the same bank line
 * look new on the next import and duplicate it.
 */
export function spendFingerprint(row) {
    const date = String(row.date || '').slice(0, 10);
    const amount = (Math.round(Number(row.amount) * 100) / 100).toFixed(2);
    const desc = normalizeDescription(row.rawDescription || row.description).slice(0, 60);
    const currency = String(row.currency || 'EUR').toUpperCase();
    return `${date}|${desc}|${amount}|${currency}`;
}

/**
 * Multiset counts, so two genuinely identical €5 coffees on one day both survive.
 *
 * The stored fingerprint of a repeat carries a `#n` occurrence suffix (see
 * dedupeSpendRows), but an incoming row is always hashed to the BASE key. The
 * suffix is therefore stripped when counting — otherwise the second and later
 * copies of a repeated movement never match on re-import and get inserted
 * again, silently duplicating every same-day repeat on each import.
 */
export function buildExistingFingerprints(transactions = []) {
    const counts = new Map();
    for (const tx of transactions) {
        const stored = tx.fingerprint || spendFingerprint(tx);
        const base = String(stored).replace(/#\d+$/, '');
        counts.set(base, (counts.get(base) || 0) + 1);
    }
    return counts;
}

export function dedupeSpendRows(rows = [], existing = new Map()) {
    const remaining = new Map(existing);
    const fresh = [], duplicates = [];
    const seenThisFile = new Map();

    for (const row of rows) {
        const fp = spendFingerprint(row);
        const left = remaining.get(fp) || 0;
        if (left > 0) {
            remaining.set(fp, left - 1);
            duplicates.push({ ...row, fingerprint: fp });
            continue;
        }
        // Repeats inside one file are real, distinct movements — keep them, but
        // suffix the stored fingerprint so the UNIQUE index does not reject them.
        const n = seenThisFile.get(fp) || 0;
        seenThisFile.set(fp, n + 1);
        fresh.push({ ...row, fingerprint: n === 0 ? fp : `${fp}#${n}` });
    }

    return { fresh, duplicates };
}

// ── MB WAY enrichment ───────────────────────────────────────────────────────

const EPSILON = 0.005;
/** Above this, the triple search costs seconds and finds nothing useful. */
const MAX_AGGREGATE_POOL = 40;

/** Days since epoch, for O(1) date bucketing without repeated Date.parse. */
function epochDay(iso) {
    const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(t) ? null : Math.round(t / 86400000);
}

/**
 * Merge a `detail` source (MB WAY, PayPal) into the statement ledger.
 *
 * MB WAY charges against a linked bank account, so every MB WAY movement ALSO
 * appears on a bank statement — the bank line opaque ("COMPRA MBWAY 12,40"),
 * the MB WAY line naming the merchant ("Pingo Doce"). Both describe one real
 * transaction.
 *
 * This is deliberately NOT dedupe. Dedupe keeps whichever row arrived first and
 * discards the other; if that is the bank row, the good description — the exact
 * field categorisation depends on — is gone. So: one row survives, the
 * statement's amount and date are authoritative, and the detail row donates its
 * merchant and description.
 *
 * Unmatched detail rows are NOT errors and are NOT promoted to transactions.
 * They are almost always timing (the bank has not posted yet). Promoting one
 * invents money that never moved; dropping one loses the description forever.
 * They wait in `pending` and are retried on the next statement import, which is
 * what makes the result independent of import order.
 */
export function mergeDetailSource(statementRows = [], detailRows = [], options = {}) {
    const windowDays = options.windowDays ?? 3;
    const allowAggregates = options.allowAggregates !== false;

    let tooDense = 0;
    const merged = statementRows.map(r => ({ ...r }));
    const claimed = new Set(merged.map((r, i) => (r.enrichedFrom ? i : -1)).filter(i => i >= 0));
    const enriched = [], pending = [], aggregated = [];

    const dayDiff = (a, b) => {
        const da = Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`);
        const db = Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`);
        if (Number.isNaN(da) || Number.isNaN(db)) return null;
        return Math.round((db - da) / 86400000);
    };

    const sortedDetails = [...detailRows].sort((a, b) => (a.date < b.date ? -1 : 1));
    const unmatched = [];

    // Pass 1 — one detail row to one statement row, nearest date first.
    for (const detail of sortedDetails) {
        let best = -1, bestGap = Infinity;
        for (let i = 0; i < merged.length; i++) {
            if (claimed.has(i)) continue;
            const s = merged[i];
            if (options.accountId && s.accountId !== options.accountId) continue;
            if (Math.abs(Math.abs(s.amount) - Math.abs(detail.amount)) > EPSILON) continue;
            if (Math.sign(s.amount) !== Math.sign(detail.amount)) continue;
            const gap = dayDiff(s.date, detail.date);
            if (gap === null || Math.abs(gap) > windowDays) continue;
            if (Math.abs(gap) < bestGap) { bestGap = Math.abs(gap); best = i; }
        }

        if (best === -1) { unmatched.push(detail); continue; }

        claimed.add(best);
        const target = merged[best];
        // Amount and date stay the bank's. Only the wording improves.
        target.rawDescription = target.rawDescription || target.description;
        target.description = detail.description || target.description;
        target.merchant = detail.merchant || detail.description || target.merchant;
        target.enrichedFrom = options.label || 'wallet';
        enriched.push({ index: best, before: target.rawDescription, after: target.description });
    }

    // Pass 2 — several detail rows posted to the bank as one aggregated line.
    // Bounded to pairs and triples: an unbounded subset-sum over a month of
    // transactions is both slow and prone to coincidental matches.
    //
    // Used-ness is tracked in a Set rather than stamped onto the rows. The rows
    // are the CALLER'S objects — in the importer they are live state — so
    // writing a marker onto them broke this module's purity contract and made a
    // second import in the same session silently skip them.
    const usedDetails = new Set();
    // Detail rows bucketed by day, so the candidate pool for a given statement
    // row is a handful of lookups instead of a scan of every unmatched row.
    const byDay = new Map();
    if (allowAggregates && unmatched.length > 1) {
        for (const d of unmatched) {
            const key = epochDay(d.date);
            if (key === null) continue;
            if (!byDay.has(key)) byDay.set(key, []);
            byDay.get(key).push(d);
        }
    }

    if (allowAggregates && unmatched.length > 1) {
        for (let i = 0; i < merged.length; i++) {
            if (claimed.has(i)) continue;
            const target = merged[i];
            const centre = epochDay(target.date);
            if (centre === null) continue;
            const pool = [];
            for (let off = -windowDays; off <= windowDays; off++) {
                for (const d of byDay.get(centre + off) || []) {
                    if (!usedDetails.has(d) && Math.sign(d.amount) === Math.sign(target.amount)) pool.push(d);
                }
            }
            // A very dense window makes the triple search cubic for no useful
            // result. Report it rather than spending seconds on it.
            if (pool.length > MAX_AGGREGATE_POOL) { tooDense += 1; continue; }
            const combo = findSubset(pool, target.amount, 3);
            if (!combo) continue;
            combo.forEach(d => usedDetails.add(d));
            claimed.add(i);
            target.rawDescription = target.rawDescription || target.description;
            target.merchant = combo.map(d => d.merchant || d.description).join(' + ');
            target.enrichedFrom = options.label || 'wallet';
            target.needsReview = true; // a split posting is worth a human glance
            aggregated.push({ index: i, parts: combo.length, amount: target.amount });
        }
    }

    for (const d of unmatched) {
        if (usedDetails.has(d)) continue;
        pending.push({ ...d, fingerprint: d.fingerprint || spendFingerprint(d) });
    }

    return { merged, enriched, aggregated, pending, tooDense };
}

/** Bounded subset search: sizes 2..maxSize summing to `target` within EPSILON. */
function findSubset(pool, target, maxSize) {
    const n = pool.length;
    for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
            if (Math.abs(pool[a].amount + pool[b].amount - target) <= EPSILON) return [pool[a], pool[b]];
            if (maxSize < 3) continue;
            for (let c = b + 1; c < n; c++) {
                if (Math.abs(pool[a].amount + pool[b].amount + pool[c].amount - target) <= EPSILON) {
                    return [pool[a], pool[b], pool[c]];
                }
            }
        }
    }
    return null;
}

// ── rule-based categorisation (the cache in front of the AI) ────────────────

export function applyRules(rows = [], rules = []) {
    const ordered = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    let matched = 0;
    const out = rows.map(row => {
        if (row.category) return row;
        const haystack = normalizeForMatching(`${row.description} ${row.merchant || ''}`);
        for (const rule of ordered) {
            let hit = false;
            if (rule.matchType === 'regex') {
                try { hit = new RegExp(rule.pattern, 'i').test(haystack); }
                catch { hit = false; } // a bad saved regex must not break an import
            } else {
                hit = matchesTokens(haystack, rule.pattern);
            }
            if (!hit) continue;
            matched++;
            return {
                ...row,
                category: rule.category,
                categorySource: 'rule',
                categoryConfidence: 1,
                merchant: row.merchant || rule.merchant || null
            };
        }
        // Normalise to an explicit null: downstream code distinguishes
        // "uncategorised" from "absent", and must never invent an "Other".
        return row.category === undefined ? { ...row, category: null } : row;
    });
    return { rows: out, matched, unmatched: out.filter(r => !r.category) };
}

/**
 * Does every word of the pattern appear in the text, in order?
 *
 * NOT a substring test. `ruleFromCorrection` drops words shorter than three
 * characters when it builds a pattern, but the text being searched keeps them —
 * so "COMPRAS C.DEB UBER" became the haystack "compras c deb uber" while the
 * learned rule was "compras deb uber", and a substring test found nothing.
 * Portuguese bank descriptions are full of short tokens (C.DEB, S.A, p/), so
 * correcting a category taught a rule that silently matched no future row —
 * which is the whole point of the feature.
 *
 * Matching on an ordered token subsequence tolerates the dropped words and any
 * other noise the bank inserts between them, while still requiring the
 * distinctive words to appear in the right order.
 */
export function matchesTokens(haystack, pattern) {
    const want = normalizeForMatching(pattern).split(' ').filter(Boolean);
    if (!want.length) return false;
    const have = String(haystack || '').split(' ').filter(Boolean);
    let i = 0;
    for (const token of have) {
        if (token === want[i]) i++;
        if (i === want.length) return true;
    }
    return false;
}

/** A manual correction becomes a rule, so the same merchant self-files next time. */
export function ruleFromCorrection(transaction, category) {
    const source = transaction.merchant || transaction.description || '';
    const pattern = normalizeForMatching(source)
        .split(' ')
        .filter(w => w.length > 2 && !/^\d+$/.test(w))
        .slice(0, 3)
        .join(' ');
    if (!pattern) return null;
    return {
        matchType: 'contains',
        pattern,
        category,
        merchant: transaction.merchant || null,
        priority: 10 // user-authored rules outrank anything inferred
    };
}

export const __testing = { normalizeDescription, normalizeForMatching, findSubset, FIELD_ALIASES, scoreAlias };

/**
 * Replace a lump card settlement with the purchases that make it up.
 *
 * A statement's card section itemises a payment that is already on the
 * statement: "PAG.CTA.CARTAO -555,49" plus the purchases inside it. Keeping the
 * lump row is arithmetically correct but tells the user nothing — one large
 * opaque row is exactly what "see where my money goes" is supposed to answer.
 *
 * So where the itemisation can be PROVEN to account for the settlement, the
 * settlement is dropped and its purchases take its place. The proof is the same
 * kind used for balance continuity: sum(detail) === settlement is a property of
 * the document, not of our parsing, so it either holds or the swap is refused.
 * Totals are identical either way — that is what makes this safe rather than a
 * reinterpretation of the user's money.
 *
 * Refusal is deliberate in two cases, because a wrong swap is worse than a lump
 * row: nothing matches the total (the settlement may fall in another statement
 * period), or more than one row does, where picking either would be a guess.
 *
 * Detail rows are grouped by `detailGroup` so a statement carrying two cards
 * reconciles each against its own settlement instead of summing them together.
 *
 * Run this AFTER balance verification. The settlement is what the running
 * balance actually moved by; once it is replaced the chain no longer describes
 * the rows, so verifying afterwards would report breaks that are not errors.
 */
export function expandCardDetail(statementRows = [], detailRows = [], options = {}) {
    const tolerance = options.tolerance ?? 0.011;
    const windowDays = options.windowDays ?? 45;

    if (!detailRows.length) {
        return { rows: [...statementRows], expanded: [], unexpanded: [], groups: 0 };
    }

    const groups = new Map();
    for (const d of detailRows) {
        const key = d.detailGroup ?? '__ungrouped__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
    }

    const replaced = new Set();
    const expanded = [], unexpanded = [];
    const inserts = new Map();   // index of the settlement -> rows that replace it

    const epochDay = v => Math.floor(Date.parse(`${String(v).slice(0, 10)}T00:00:00Z`) / 86400000);

    for (const [key, members] of groups) {
        // Signed, so a refund inside the card period reduces the total exactly
        // as the bank computed it.
        const total = Math.round(members.reduce((sum, d) => sum + Number(d.amount || 0), 0) * 100) / 100;
        const days = members.map(m => epochDay(m.date)).filter(Number.isFinite);
        const near = days.length ? Math.max(...days) : null;

        const candidates = [];
        for (let i = 0; i < statementRows.length; i++) {
            if (replaced.has(i)) continue;
            const s = statementRows[i];
            if (Math.abs(Number(s.amount) - total) > tolerance) continue;
            if (near !== null) {
                const gap = epochDay(s.date) - near;
                if (Number.isFinite(gap) && Math.abs(gap) > windowDays) continue;
            }
            candidates.push(i);
        }

        if (candidates.length !== 1) {
            unexpanded.push({ group: key, count: members.length, total,
                reason: candidates.length === 0 ? 'no settlement row matches this total'
                                                : `${candidates.length} settlement rows match this total` });
            continue;
        }

        const idx = candidates[0];
        const settlement = statementRows[idx];
        replaced.add(idx);
        inserts.set(idx, members.map(m => ({
            ...m,
            // They are ledger movements now, so they must not keep being treated
            // as detail by anything downstream.
            sourceRole: 'statement',
            expandedFrom: settlement.rawDescription || settlement.description,
            // Persisted, unlike expandedFrom: `enriched_from` is an existing
            // column, so the ledger keeps the fact that this row came out of a
            // card section without needing a migration for it.
            enrichedFrom: options.label || 'card',
            // Not on the running chain: the settlement was. Leaving a balance
            // here would put a number into the continuity check that the
            // document never printed against this row.
            balance: null
        })));
        expanded.push({ group: key, count: members.length, total,
                        settlement: settlement.rawDescription || settlement.description });
    }

    const rows = [];
    for (let i = 0; i < statementRows.length; i++) {
        if (inserts.has(i)) rows.push(...inserts.get(i));
        else if (!replaced.has(i)) rows.push(statementRows[i]);
    }

    return { rows, expanded, unexpanded, groups: groups.size };
}

/**
 * Mark the account row that settles a card, once that card's purchases are in
 * the ledger.
 *
 * Both legs are printed in the same document. The card section lists its own
 * payments ("PAGAMENTOS EFETUADOS NO PERÍODO"), and the account section carries
 * the matching debit. So the settlement can be identified by the document
 * agreeing with itself — same amount, opposite sign, same few days — rather than
 * by guessing from wording like "CARTOES" that differs per bank and language.
 *
 * It has to be marked, because once the purchases are counted as spending the
 * settlement is repayment of debt, not consumption. Counting both overstates
 * spending by the settlement every month, and the error is invisible: each row
 * looks entirely reasonable on its own.
 *
 * A payment inside the card section is a POSITIVE amount — it reduces what is
 * owed — while the account-side debit is negative. That is the pairing.
 */
export function markCardSettlements(statementRows = [], detailRows = [], options = {}) {
    const tolerance = options.tolerance ?? 0.011;
    const windowDays = options.windowDays ?? 5;
    const payments = detailRows.filter(d => Number(d.amount) > 0);
    if (!payments.length) return { rows: [...statementRows], linked: [] };

    const epochDay = v => Math.floor(Date.parse(`${String(v).slice(0, 10)}T00:00:00Z`) / 86400000);
    const rows = statementRows.map(r => ({ ...r }));
    const claimed = new Set();
    const linked = [];

    for (const pay of payments) {
        let best = -1, bestGap = Infinity;
        for (let i = 0; i < rows.length; i++) {
            if (claimed.has(i)) continue;
            const r = rows[i];
            // Already settled by the user or a previous import: leave it alone.
            if (r.category === 'transfer') continue;
            if (Math.abs(Number(r.amount) + Number(pay.amount)) > tolerance) continue;
            const gap = Math.abs(epochDay(r.date) - epochDay(pay.date));
            if (!Number.isFinite(gap) || gap > windowDays) continue;
            if (gap < bestGap) { bestGap = gap; best = i; }
        }
        if (best === -1) continue;
        claimed.add(best);
        rows[best] = {
            ...rows[best],
            category: 'transfer',
            categorySource: 'auto',
            note: 'Repayment of the card whose purchases this statement itemises — counted as a transfer so the same spending is not counted twice.'
        };
        linked.push({ index: best, amount: rows[best].amount });
    }

    return { rows, linked };
}

/**
 * Decide which account a card section's rows belong to.
 *
 * A single statement PDF describes two accounts: the current account and the
 * card. Importing both into the account the user picked is what forces the
 * spending and its repayment into one ledger, where they double-count unless
 * something marks the repayment. Routing the card section to its own linked
 * account removes that class of error instead of correcting it afterwards.
 *
 * Inference, not a question. The card is identified in the section heading, and
 * asking on every import defeats the point — the value is that this decision
 * stops being the user's to make. An existing linked card account is reused; a
 * missing one is proposed, never silently assumed.
 *
 * Ambiguity is refused rather than guessed: with two card accounts linked to the
 * same current account and nothing distinguishing them, routing to the wrong one
 * puts real spending on the wrong card.
 */
export function planCardRouting(groups = [], accounts = [], importAccountId = null) {
    const cards = accounts.filter(a => a.type === 'card' && !a.archived);
    const linked = cards.filter(a => a.linkedAccountId === importAccountId);
    const norm = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

    return groups.map(group => {
        const key = norm(group);
        // A card number in the heading is the strongest signal: match it against
        // any card account whose label carries the same digits.
        const digits = String(group ?? '').replace(/\D/g, '');
        const byNumber = digits.length >= 4
            ? cards.filter(a => String(a.label ?? '').replace(/\D/g, '').includes(digits.slice(-4)))
            : [];
        if (byNumber.length === 1) return { group, action: 'use', accountId: byNumber[0].id };
        if (byNumber.length > 1) return { group, action: 'ambiguous', candidates: byNumber.map(a => a.id) };

        const byLabel = cards.filter(a => norm(a.label).includes(key) && key.length >= 3);
        if (byLabel.length === 1) return { group, action: 'use', accountId: byLabel[0].id };

        if (linked.length === 1) return { group, action: 'use', accountId: linked[0].id };
        if (linked.length > 1) return { group, action: 'ambiguous', candidates: linked.map(a => a.id) };

        return {
            group, action: 'create',
            proposal: { type: 'card', label: `Card ${group}`.slice(0, 60), linkedAccountId: importAccountId }
        };
    });
}

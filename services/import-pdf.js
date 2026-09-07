/**
 * import-pdf.js — turn a PDF statement's positioned text into ledger rows.
 *
 * PURE by contract: no DOM, no network, no pdf.js import. It takes the text
 * items a caller has already extracted and returns rows. Tests import it
 * directly; no `src/` mirror (see CLAUDE.md).
 *
 * WHY LAYOUT MATTERS
 *
 * The app's existing PDF reader does `items.map(i => i.str).join(' ')`, which
 * throws away `item.transform` — the x/y of every fragment — and flattens a
 * whole page into one line. That is why PDFs previously looked like they needed
 * an AI to read: the structure was destroyed before anything got a chance.
 *
 * Keep the coordinates and a bank statement is what it looks like on paper — a
 * table. Then the same principle as the CSV path applies: learn the shape ONCE,
 * confirm it with a human, and replay it locally and free forever after.
 *
 * A PDF profile stores a LINE PATTERN rather than a column map, because a PDF
 * has no delimiter to map columns against.
 */

import { normalizeRow, validateRow } from './import-contract.js';
import { parseStyledNumber } from './import-banks.js';

// ── layout reconstruction ───────────────────────────────────────────────────

/**
 * Group positioned text fragments into visual lines.
 *
 * Fragments on one printed line rarely share an exact y — different fonts and
 * baselines drift by a point or two — so exact grouping shatters a row into
 * pieces. The tolerance is what turns fragments back into the line a human sees.
 */
export function groupIntoLines(items = [], options = {}) {
    // 2pt. Measured on a real statement: 3pt merged distinct printed rows
    // (42 date-leading lines where the page has 68), while sub-point split rows
    // whose fragments sit on slightly different baselines.
    const tol = options.yTolerance ?? 2;
    const usable = items
        .filter(it => it && typeof it.str === 'string' && it.str.trim() && Array.isArray(it.transform))
        .map(it => ({ x: it.transform[4], y: it.transform[5], w: Number(it.width) || 0, s: it.str }));
    if (!usable.length) return [];

    usable.sort((a, b) => (b.y - a.y) || (a.x - b.x));

    const out = [];
    let current = [usable[0]];
    for (let i = 1; i < usable.length; i++) {
        if (Math.abs(usable[i].y - current[0].y) <= tol) current.push(usable[i]);
        else { out.push(current); current = [usable[i]]; }
    }
    out.push(current);

    // NOT column-split by x-gap. Statements do print unrelated sections side by
    // side — a card column beside account movements — and splitting on a large
    // x gap looks like it fixes that. Measured, it does not: within one row the
    // description→amount gap is just as large, so the split also strips the
    // amount off legitimate rows. It raised pattern coverage from 33% to 91%
    // while leaving every balance check broken, i.e. it produced more rows that
    // were more wrong. Telling the two cases apart needs document-level column
    // bands, not a threshold — which is why multi-section statements go to the
    // extraction service instead.
    return out
        .map(frs => {
            const sorted = [...frs].sort((a, b) => a.x - b.x);
            return {
                y: sorted[0].y,
                xs: sorted.map(f => f.x),
                text: sorted.map(f => f.s).join(' ').replace(/\s+/g, ' ').trim()
            };
        })
        .filter(l => l.text);
}

// ── candidate line patterns ─────────────────────────────────────────────────

// Accepts the three ways a statement writes a negative: a leading minus, a
// TRAILING minus (standard in DE/AT/CH exports) and parentheses. Requiring the
// token to end in a digit meant "100,00-" and "(100,00)" matched no pattern at
// all, and the row was discarded rather than misread — which is worse, because
// a partial import that reports itself as complete looks like a correct one.
const NUM = String.raw`\(?[-+]?[\d.,]+\d[-+]?\)?`;
const D_SLASH = String.raw`\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?`;

/**
 * Shapes real statements print, most specific first.
 *
 * Ordering matters: a pattern with a trailing balance must be tried before the
 * one without, or every balance gets read as the amount — a silent, total
 * corruption of the ledger rather than a visible failure.
 */
export const LINE_PATTERNS = [
    {
        id: 'date desc valuedate amount balance',
        re: new RegExp(`^(?<date>${D_SLASH})\\s+(?<description>.*?)\\s+(?<valueDate>${D_SLASH})\\s+(?<amount>${NUM})\\s+(?<balance>${NUM})$`)
    },
    {
        id: 'date desc amount balance',
        re: new RegExp(`^(?<date>${D_SLASH})\\s+(?<description>.*?)\\s+(?<amount>${NUM})\\s+(?<balance>${NUM})$`)
    },
    {
        id: 'date valuedate desc amount',
        re: new RegExp(`^(?<date>${D_SLASH})\\s+(?<valueDate>${D_SLASH})\\s+(?<description>.*?)\\s+(?<amount>${NUM})$`)
    },
    {
        id: 'date desc amount',
        re: new RegExp(`^(?<date>${D_SLASH})\\s+(?<description>.*?)\\s+(?<amount>${NUM})$`)
    }
];

/** Lines that begin with something date-shaped — candidate transaction rows. */
// Day-first numeric is the common case in PT/EU statements, but it is not the
// only way a bank prints a date, and this gate decides whether a document is
// even offered to the extractor. Kept deliberately broad: a false positive costs
// one extra line in a prompt, while a false negative used to fail the whole
// import with "no dated transaction lines".
const D_ISO  = String.raw`\d{4}[/.-]\d{1,2}[/.-]\d{1,2}`;
const D_NAME = String.raw`\d{1,2}[\s.-]+[A-Za-zÀ-ÿ]{3,9}\.?[\s.-]+\d{2,4}`;
const D_ANY  = `(?:${D_ISO}|${D_NAME}|${D_SLASH})`;

export function findCandidateLines(lines = []) {
    const lead = new RegExp(`^\\s*${D_ANY}\\b`);
    return lines.filter(l => lead.test(l.text));
}

/**
 * Everything that could plausibly be a movement, for a document whose rows do
 * not begin with a date.
 *
 * Some banks print the date in the middle of the row, or lead with a value date
 * column, or use a layout nobody has seen. Those documents used to be refused
 * outright — the deterministic date gate decided whether the AI extractor was
 * allowed to look, which inverts the point of having it.
 *
 * Wider net, same guardrail: whatever comes back is still checked against the
 * statement's running balance, so a looser filter cannot make a wrong import
 * look right.
 */
export function findLooseCandidates(lines = []) {
    const anywhere = new RegExp(D_ANY);
    const money = /\d[\d.,]*[.,]\d{2}\b/;
    return lines.filter(l => {
        const t = l.text || '';
        if (t.length > 200) return false;
        return anywhere.test(t) && money.test(t);
    });
}

/**
 * Lines that look like a section heading, so the structure of the document
 * survives the filter that keeps only transaction rows.
 *
 * This matters more than it sounds. Extraction is asked to tell an account
 * movement from a card purchase by WHERE the row is printed — under a card
 * heading, or not. Keeping only dated rows deleted every heading before the
 * model saw one, so the card section arrived as a run of anonymous dated rows
 * indistinguishable from account movements. The classification could not
 * succeed, because the evidence it needed had already been thrown away.
 *
 * Deliberately language-neutral: no bank names and no Portuguese keywords. A
 * heading is recognised by shape — predominantly upper case, no money on the
 * line, and transaction rows following it — so "DETALHE DAS COMPRAS", "CARD
 * TRANSACTIONS" and "MOVIMIENTOS DE TARJETA" all qualify without a word list to
 * maintain per bank.
 */
export function findSectionHeadings(lines = [], options = {}) {
    const lookahead = options.lookahead ?? 15;
    const lead = new RegExp(`^${D_SLASH}\\b`);
    const money = /\d[\d.,]*,\d{2}|\d[\d,]*\.\d{2}/;

    const isCandidate = i => lines[i] && lead.test(lines[i].text);

    return lines.filter((l, i) => {
        const text = (l.text || '').trim();
        if (!text || text.length > 100) return false;
        if (lead.test(text)) return false;          // a dated row, not a heading
        if (money.test(text)) return false;         // carries a figure: a total or a row

        const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, '');
        if (letters.length < 3) return false;
        const upper = letters.replace(/[^A-ZÀ-Þ]/g, '').length;
        if (upper / letters.length < 0.6) return false;

        // A heading starts at the left margin. A wrapped description continues in
        // the description column, indented — and "LISBOA PT VISA 1234" otherwise
        // satisfies every test above. Injected as a heading it would open a
        // phantom card section mid-statement, and the rows after it would be
        // routed to a card account. Structure decides roles here, so a false
        // heading moves real money to the wrong place.
        const margins = lines.filter((_, k) => isCandidate(k)).map(c => c.xs?.[0]).filter(Number.isFinite);
        if (margins.length && Number.isFinite(l.xs?.[0])) {
            const leftMost = Math.min(...margins);
            if (l.xs[0] > leftMost + 12) return false;
        }

        // A heading introduces something. Without this, page furniture printed
        // in caps ("PAG. 2 DE 6") would be kept on every page.
        for (let j = i + 1; j <= i + lookahead && j < lines.length; j++)
            if (isCandidate(j)) return true;
        return false;
    });
}

/**
 * Does a pattern's own output reconcile against the statement's running balance?
 *
 * This is the difference between a pattern that fits and a pattern that is
 * RIGHT. `balance[n] - balance[n-1] === amount[n]` is a property of the
 * document, not of the guess, so a pattern that reads the balance column as the
 * amount fails it on every row — which is exactly what a coverage-only
 * proposer picks, because the loosest pattern always matches the most lines.
 */
export function checkBalanceChain(rows = [], tolerance = 0.011) {
    let checked = 0, breaks = 0;
    for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        if (a.balance === null || b.balance === null) continue;
        checked++;
        if (Math.abs((b.balance - a.balance) - b.amount) > tolerance) breaks++;
    }
    // `checked` alone cannot tell "verified" from "unverifiable": one checkable
    // pair in four hundred rows also yields breaks === 0. `coverage` is the
    // share of adjacent pairs the document actually let us test, so a caller can
    // report how much of the parse is vouched for instead of a bare boolean.
    const pairs = Math.max(rows.length - 1, 0);
    return {
        checked, breaks, pairs,
        coverage: pairs ? checked / pairs : 0,
        valid: checked > 0 && breaks === 0,
        ratio: checked ? 1 - breaks / checked : null
    };
}

/**
 * Pick the pattern whose output the statement itself vouches for.
 *
 * Selection is by reconciliation first and coverage second. A pattern matching
 * every line but producing a broken balance chain is wrong, and preferring it
 * would import a whole statement of plausible-looking wrong numbers.
 */
export function proposeLinePattern(lines = [], options = {}) {
    const candidates = findCandidateLines(lines);
    const year = options.statementYear ?? detectStatementYear(lines);
    const decimalStyle = options.decimalStyle || 'eu';

    const scored = [];
    for (const p of LINE_PATTERNS) {
        const matched = candidates.filter(l => p.re.test(l.text));
        if (!matched.length) continue;
        const parsed = parseWithLineProfile(lines, { patternId: p.id, decimalStyle, statementYear: year });
        const chain = checkBalanceChain(parsed.rows);
        scored.push({ id: p.id, matched, chain, parsedCount: parsed.parsed });
    }
    if (!scored.length) {
        return { patternId: null, matched: 0, candidates: candidates.length, coverage: 0, samples: [], chain: null };
    }

    // Reconciling patterns first, then by rows explained.
    scored.sort((a, b) =>
        (Number(b.chain.valid) - Number(a.chain.valid)) ||
        ((b.chain.ratio ?? 0) - (a.chain.ratio ?? 0)) ||
        (b.matched.length - a.matched.length));
    const best = scored[0];

    return {
        patternId: best.id,
        matched: best.matched.length,
        candidates: candidates.length,
        coverage: candidates.length ? best.matched.length / candidates.length : 0,
        samples: best.matched.slice(0, 5).map(l => l.text),
        chain: best.chain,
        // Nothing reconciled: the document is probably multi-section, and one
        // pattern cannot describe it. Say so instead of importing wrong numbers.
        unreconciled: !best.chain.valid
    };
}

// ── statement-level context ─────────────────────────────────────────────────

/**
 * Recover the statement's year.
 *
 * Some banks print `31/07` and leave the year to the header — so a row's date is
 * genuinely ambiguous without reading the rest of the document. Guessing the
 * current year silently files January statements into the wrong one every
 * January, so the year is taken from the document or the rows are refused.
 */
/**
 * The period a statement covers, both ends of it.
 *
 * A single year is not enough and quietly corrupts one statement a year: a
 * period running 15/12 to 15/01 spans two, so a row printed "31/12" belongs to
 * the earlier year and "02/01" to the later one. Stamping both with one year
 * puts December's spending in the wrong month — and sometimes in the future —
 * while the balance chain still reconciles perfectly, because the amounts were
 * never wrong. Nothing downstream can catch it.
 */
export function detectStatementPeriod(lines = []) {
    const text = lines.map(l => l.text).join('\n');
    const full = text.match(
        /(?:per[ií]odo|period)[^\n]*?(\d{4})[/-](\d{1,2})[/-](\d{1,2})[^\n]*?\ba\b[^\n]*?(\d{4})[/-](\d{1,2})[/-](\d{1,2})/i);
    if (full) {
        const pad = v => String(v).padStart(2, '0');
        return {
            start: `${full[1]}-${pad(full[2])}-${pad(full[3])}`,
            end:   `${full[4]}-${pad(full[5])}-${pad(full[6])}`,
            startYear: Number(full[1]), endYear: Number(full[4])
        };
    }
    const y = detectStatementYear(lines);
    return y ? { start: null, end: null, startYear: y, endYear: y } : null;
}

export function detectStatementYear(lines = []) {
    const text = lines.map(l => l.text).join('\n');
    const ranges = [
        /(?:per[ií]odo|period)[^\n]*?(\d{4})[/-]\d{1,2}[/-]\d{1,2}[^\n]*?a[^\n]*?(\d{4})/i,
        /(?:per[ií]odo|period)[^\n]*?\d{1,2}[/.-]\d{1,2}[/.-](\d{4})/i,
        /\b\d{1,2}[/.-]\d{1,2}[/.-](20\d{2})\b/
    ];
    for (const re of ranges) {
        const m = text.match(re);
        if (m) return Number(m[m.length - 1]);
    }
    return null;
}

// ── parsing ─────────────────────────────────────────────────────────────────

// Delegates to the CSV path's parser rather than keeping a second one. The two
// had drifted: this copy stripped parentheses before deciding the sign, so
// "(100,00)" parsed as +100 and a debit was recorded as income — the same class
// of bug the shared parser had for a trailing minus, discovered separately in
// each place because there were two places to discover it in.
function parseNum(raw, decimalStyle) {
    return parseStyledNumber(raw, decimalStyle);
}

function toISO(raw, dateFormat, fallbackYear) {
    const m = String(raw || '').match(/^(\d{1,4})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
    if (!m) return null;
    let a = m[1], b = m[2], c = m[3];
    let y, mo, d;
    if (c === undefined) {
        // No year on the row — it lives in the statement header.
        if (!fallbackYear) return null;
        y = fallbackYear;
        if (dateFormat === 'mm-dd-yyyy') { mo = a; d = b; } else { d = a; mo = b; }
    } else if (dateFormat === 'yyyy-mm-dd' || a.length === 4) {
        y = a; mo = b; d = c;
    } else if (dateFormat === 'mm-dd-yyyy') {
        mo = a; d = b; y = c;
    } else {
        d = a; mo = b; y = c;
    }
    y = String(y); if (y.length === 2) y = '20' + y;
    const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
    return iso;
}

/** Parse reconstructed lines with a confirmed PDF profile. */
export function parseWithLineProfile(lines = [], profile = {}, options = {}) {
    const pattern = LINE_PATTERNS.find(p => p.id === profile.patternId);
    if (!pattern) return { rows: [], errors: [{ line: 0, reason: 'unknown line pattern' }], parsed: 0, skipped: 1 };

    const decimalStyle = profile.decimalStyle || 'eu';
    const dateFormat = profile.dateFormat || 'dd-mm-yyyy';
    const year = profile.statementYear || detectStatementYear(lines);
    const invert = !!profile.invertSign;

    const rows = [], errors = [];
    for (const line of findCandidateLines(lines)) {
        const m = line.text.match(pattern.re);
        if (!m) continue;                       // not a transaction row; headers and totals land here
        const g = m.groups;

        const date = toISO(g.date, dateFormat, year);
        if (!date) {
            errors.push({ line: line.text.slice(0, 90), reason: year ? 'unreadable date' : 'no year on the row and none found in the statement header' });
            continue;
        }

        let amount = parseNum(g.amount, decimalStyle);
        if (invert) amount = -amount;

        const candidate = normalizeRow({
            accountId: options.accountId ?? null,
            date,
            description: (g.description || '').trim(),
            amount,
            // Absent, not EUR: the contract falls back to the account's currency.
            currency: profile.currency || undefined,
            balance: g.balance !== undefined ? parseNum(g.balance, decimalStyle) : null,
            source: options.source || 'pdf',
            sourceRole: profile.sourceRole || 'statement'
        });

        const { ok, errors: reasons } = validateRow(candidate);
        if (!ok) { errors.push({ line: line.text.slice(0, 90), reason: reasons.join('; ') }); continue; }
        rows.push(candidate);
    }

    return { rows, errors, parsed: rows.length, skipped: errors.length, statementYear: year, format: 'pdf' };
}

/** Everything the confirmation dialog needs, without committing anything. */
export function buildPdfDraft(lines = []) {
    const proposal = proposeLinePattern(lines);
    const year = detectStatementYear(lines);
    const numeric = proposal.samples.join(' ');
    // A comma as the last separator means European.
    const eu = (numeric.match(/\d,\d{2}\b/g) || []).length;
    const us = (numeric.match(/\d\.\d{2}\b/g) || []).length;

    return {
        // "Matched some lines" is not good enough to import money. A draft is
        // only OK if the statement's own balance chain agrees with it.
        ok: proposal.matched > 0 && !proposal.unreconciled,
        unreconciled: !!proposal.unreconciled,
        chain: proposal.chain,
        patternId: proposal.patternId,
        matched: proposal.matched,
        candidates: proposal.candidates,
        coverage: proposal.coverage,
        samples: proposal.samples,
        statementYear: year,
        needsYear: proposal.samples.some(s => !/\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/.test(s.split(/\s/)[0])) && !year,
        decimalStyle: us > eu ? 'us' : 'eu',
        dateFormat: 'dd-mm-yyyy',
        formatKind: 'pdf'
    };
}

/**
 * Which way round a statement's rows run.
 *
 * The balance chain only ever tested `balance[n] - balance[n-1] === amount[n]`,
 * which is the ascending form. In a document printed newest-first every pair
 * fails, so a perfectly parseable statement is either refused outright by the
 * deterministic path or imported with almost every row flagged — the guardrail
 * crying wolf across a whole class of banks.
 *
 * Scoring both forms costs one extra pass and answers it from the document
 * rather than from a guess about the bank.
 */
export function scoreChainDirection(rows = [], tolerance = 0.011) {
    let asc = 0, desc = 0, pairs = 0;
    for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        if (a.balance === null || a.balance === undefined) continue;
        if (b.balance === null || b.balance === undefined) continue;
        pairs++;
        if (Math.abs((b.balance - a.balance) - Number(b.amount)) <= tolerance) asc++;
        if (Math.abs((a.balance - b.balance) - Number(a.amount)) <= tolerance) desc++;
    }
    const direction = pairs === 0 ? 'unknown' : desc > asc ? 'desc' : asc > 0 ? 'asc' : 'unknown';
    return { direction, asc, desc, pairs };
}

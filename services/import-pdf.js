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

const NUM = String.raw`-?[\d.,]+\d`;
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
export function findCandidateLines(lines = []) {
    const lead = new RegExp(`^${D_SLASH}\\b`);
    return lines.filter(l => lead.test(l.text));
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

function parseNum(raw, decimalStyle) {
    if (raw === null || raw === undefined) return NaN;
    let s = String(raw).trim().replace(/[^\d.,\-]/g, '');
    if (!s) return NaN;
    const neg = s.startsWith('-');
    s = s.replace(/-/g, '');
    if (decimalStyle === 'us') s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? NaN : (neg ? -n : n);
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
            currency: profile.currency || 'EUR',
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

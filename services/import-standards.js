/**
 * import-standards.js — interchange-format statement parsers.
 *
 * PURE by contract: no DOM, no network, no service imports beyond the shared
 * row contract. Tests import this directly; no `src/` mirror (see CLAUDE.md).
 *
 * WHY THIS IS THE IMPORTANT TIER
 *
 * Every other ingestion path in this app has to work out what a particular
 * bank's export means — which column is the amount, what a date looks like,
 * where the header is. That work is unavoidable for CSV and PDF, and it is why
 * those paths need a per-format profile and a human to confirm it once.
 *
 * Interchange formats need none of it. OFX, CAMT.053 and MT940 are specified:
 * the amount is `TRNAMT` because the spec says so, in every country, for every
 * institution, forever. A bank that exports one of these is supported the
 * moment the user picks the file — no mapping dialog, no AI, no profile, no
 * code change. That is what "bank-agnostic" actually means, as distinct from
 * "good at guessing".
 *
 * Currently implemented: OFX / QFX (1.x SGML and 2.x XML).
 */

import { normalizeRow, validateRow } from './import-contract.js';

// ── detection ───────────────────────────────────────────────────────────────

/**
 * Which interchange format, if any, this text is.
 *
 * Deliberately content-based rather than extension-based: banks ship OFX as
 * .ofx, .qfx, .qbo and sometimes .txt, and a user renaming a file should not
 * change how it is read.
 */
export function detectStandardFormat(text) {
    const head = String(text || '').slice(0, 4096);
    if (/OFXHEADER\s*[:=]/i.test(head) || /<OFX>/i.test(head)) return 'ofx';
    if (/<Document[^>]*camt\.05[23]/i.test(head) || /<BkToCstmrStmt>/i.test(head)) return 'camt053';
    if (/^\s*:20:/m.test(head) && /:61:/.test(String(text || ''))) return 'mt940';
    return null;
}

export const SUPPORTED_STANDARDS = ['ofx'];

// ── OFX ─────────────────────────────────────────────────────────────────────

/**
 * Read a tag's value from an OFX fragment.
 *
 * OFX 1.x is SGML, not XML: closing tags are optional, so a field looks like
 * `<TRNAMT>-12.40` and simply ends at the next `<`. OFX 2.x is real XML with
 * `</TRNAMT>`. One expression handles both — take everything up to the next
 * tag, which is the value in either dialect.
 */
function tagValue(fragment, tag) {
    const m = fragment.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
    return m ? m[1].trim() : null;
}

/**
 * OFX dates are `YYYYMMDD`, optionally with time and a bracketed timezone —
 * `20260305120000.000[-3:EST]`. Only the calendar date is kept: a statement
 * line belongs to a day, and carrying a timezone would let the same
 * transaction land on different days for different readers.
 */
export function parseOfxDate(raw) {
    const m = String(raw || '').trim().match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    const [, y, mo, d] = m;
    const iso = `${y}-${mo}-${d}`;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
    return iso;
}

/** OFX amounts are plain signed decimals, but some writers emit a comma. */
export function parseOfxAmount(raw) {
    if (raw === null || raw === undefined) return NaN;
    const s = String(raw).trim().replace(/,/g, '.');
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * Parse an OFX/QFX bank statement.
 *
 * Sign convention needs no translation: OFX `TRNAMT` is already signed with
 * negative meaning money out, which is this app's convention too.
 */
export function parseOfx(text, options = {}) {
    const src = String(text || '');
    if (!src.trim()) return { rows: [], errors: [], format: 'ofx', accounts: [] };

    const rows = [], errors = [], accounts = [];
    const defaultCurrency = (tagValue(src, 'CURDEF') || options.currency || 'EUR').toUpperCase();

    // A file can carry several statements (one per account). Split on the
    // statement-response blocks so each transaction keeps its own account and
    // currency rather than inheriting the first one's.
    //
    // Bank (STMTRS) and credit-card (CCSTMTRS) blocks are matched by ONE
    // expression. Trying bank first and falling back to card meant a file
    // holding both — a current account and a card, which is exactly what a bank
    // exports when you ask for everything — parsed the bank rows and dropped
    // every card row without a word.
    const stmtBlocks = src.match(/<(?:CC)?STMTRS>[\s\S]*?(?=<\/(?:CC)?STMTRS>|<(?:CC)?STMTRS>|$)/gi) || [src];

    for (const block of stmtBlocks) {
        const currency = (tagValue(block, 'CURDEF') || defaultCurrency).toUpperCase();
        const acctId = tagValue(block, 'ACCTID');   // same tag under BANKACCTFROM and CCACCTFROM
        const bankId = tagValue(block, 'BANKID');
        if (acctId) accounts.push({ acctId, bankId, currency });

        const txBlocks = block.match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|$)/gi) || [];
        txBlocks.forEach((tx, i) => {
            const date = parseOfxDate(tagValue(tx, 'DTPOSTED') || tagValue(tx, 'DTAVAIL'));
            const amount = parseOfxAmount(tagValue(tx, 'TRNAMT'));
            // NAME is the counterparty; MEMO is free text. Prefer NAME and keep
            // MEMO when it adds something, because the categoriser reads this.
            const name = tagValue(tx, 'NAME') || tagValue(tx, 'PAYEE');
            const memo = tagValue(tx, 'MEMO');
            const description = [name, memo && memo !== name ? memo : null]
                .filter(Boolean).join(' — ') || tagValue(tx, 'TRNTYPE') || '(no description)';

            const candidate = normalizeRow({
                accountId: options.accountId ?? null,
                date,
                description,
                merchant: name || null,
                amount,
                currency,
                // The bank's own unique id for this transaction. Carried for
                // provenance; dedupe stays content-based so a row imported from
                // a CSV and later from an OFX is still recognised as the same
                // movement.
                externalId: tagValue(tx, 'FITID'),
                source: options.source || 'ofx',
                sourceRole: options.sourceRole || 'statement'
            });

            const { ok, errors: reasons } = validateRow(candidate);
            if (!ok) {
                errors.push({ line: i + 1, reason: reasons.join('; '), raw: tx.slice(0, 160) });
                return;
            }
            rows.push(candidate);
        });
    }

    return { rows, errors, format: 'ofx', accounts, parsed: rows.length, skipped: errors.length };
}

/**
 * Parse whatever interchange format the text is.
 * Returns null when it is not one, so the caller can fall through to the
 * profile-based tabular path.
 */
export function parseStandard(text, options = {}) {
    const format = detectStandardFormat(text);
    if (format === 'ofx') return parseOfx(text, options);
    if (format) {
        return {
            rows: [], errors: [], format, unsupported: true, parsed: 0, skipped: 0,
            message: `${format.toUpperCase()} statements aren't supported yet.`
        };
    }
    return null;
}

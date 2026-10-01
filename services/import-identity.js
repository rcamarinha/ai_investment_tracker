/**
 * Which account a statement belongs to, read from the statement itself.
 *
 * Until now the person chose the account from a dropdown BEFORE choosing the
 * file, and the learned layout hung off that choice. That is what made importing
 * a folder of statements a one-at-a-time job, and it is also a way to file a
 * whole statement against the wrong account with one wrong click.
 *
 * A statement names its account: an IBAN, a NIB, or the account number printed
 * in the header ("CONTA BANKINTER Nº 301200073864"). None of those are secret to
 * the ledger — they are already in the document the owner just uploaded — and
 * they are stable across months, which is exactly what a key needs to be.
 *
 * The rule: references are EXACT. A file matches an account when one of the
 * references it prints is one this account has been seen to print before. No
 * prefix or suffix matching, because a current account and its card share most
 * of their digits (301200073864 vs 3014A0073864) and "close enough" would file
 * a card statement into the current account. Nothing is guessed: a file with no
 * known reference is asked about, once, and then remembered.
 *
 * Pure, so tests/import-identity.test.js checks it.
 */

/**
 * An IBAN as printed: two letters, two check digits, then four-character groups
 * (a last short group is normal). Matching character by character instead let
 * the match run on into the next word — a real header prints
 * "IBAN: PT50 … 8646 0 SWIFT/BIC: BKBKPTPL" and the reference came out with
 * SWIFT stuck on the end.
 */
const IBAN = /\b([A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,3})?)\b/g;
/** A long account or NIB number, printed with or without spaces. */
const ACCOUNT_NUMBER = /\b(\d[\d ]{7,30}\d)\b/g;
/** An account number that mixes digits and letters, as card accounts do. */
const MIXED_REF = /\b(\d{2,}[A-Z]\d{4,})\b/g;

/** How a reference is stored and compared: no spaces, no punctuation, upper case. */
export function normaliseRef(value) {
    return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A date or a money figure that happens to be a long run of digits. */
function looksLikeMoneyOrDate(text) {
    return /\d[.,]\d{2}\b/.test(text) || /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(text);
}

/**
 * Every account reference a statement prints, strongest first (IBAN, then NIB
 * or account number). Deliberately generous: an extra reference costs nothing,
 * since a match is only ever made against references this owner has confirmed.
 *
 * @param {string|string[]} source the statement's text, or its lines
 * @param {number} [limit] how many to keep
 * @returns {string[]} normalised references
 */
export function accountRefs(source, limit = 12) {
    const lines = Array.isArray(source) ? source : String(source ?? '').split('\n');
    const ibans = [], numbers = [];

    for (const line of lines.slice(0, 400)) {
        const text = typeof line === 'string' ? line : (line?.text ?? '');
        if (!text || text.length > 300) continue;
        const upper = text.toUpperCase();

        for (const m of upper.matchAll(IBAN)) {
            const ref = normaliseRef(m[1]);
            // An IBAN is a country code, two check digits and at least 11 more.
            if (ref.length >= 15 && ref.length <= 34) ibans.push(ref);
        }
        for (const m of upper.matchAll(MIXED_REF)) {
            const ref = normaliseRef(m[1]);
            if (ref.length >= 8 && ref.length <= 34) numbers.push(ref);
        }
        // A money figure or a date is not an account number.
        if (looksLikeMoneyOrDate(text)) continue;
        for (const m of upper.matchAll(ACCOUNT_NUMBER)) {
            const ref = normaliseRef(m[1]);
            if (ref.length >= 9 && ref.length <= 34) numbers.push(ref);
        }
    }

    return [...new Set([...ibans, ...numbers])].slice(0, limit);
}

/**
 * The account a file belongs to, judged only by references the owner has
 * already confirmed for an account.
 *
 * @param {string[]} refs           references read from the file
 * @param {Array<{id: string, statementRefs?: string[], archived?: boolean}>} accounts
 * @returns {{ accountId: string, ref: string } | { accountId: null, candidates: string[] }}
 *   the account, or null with the ids that both claim a reference (ambiguous)
 */
export function matchAccount(refs = [], accounts = []) {
    const wanted = new Set(refs.map(normaliseRef).filter(Boolean));
    if (!wanted.size) return { accountId: null, candidates: [] };

    const hits = [];
    for (const account of accounts) {
        if (!account || account.archived) continue;
        for (const stored of account.statementRefs || []) {
            const ref = normaliseRef(stored);
            if (ref && wanted.has(ref)) { hits.push({ accountId: account.id, ref }); break; }
        }
    }
    if (hits.length === 1) return hits[0];
    // Two accounts claiming the same reference is a mistake to surface, not to
    // resolve: filing a statement into the wrong one is silent and compounding.
    return { accountId: null, candidates: hits.map(h => h.accountId) };
}

/**
 * The references to remember for an account after a confirmed import: the ones
 * this file printed, plus whatever the account already had. Capped, so a bank
 * that prints a new reference every month cannot grow the list without end.
 *
 * @param {string[]} existing
 * @param {string[]} found
 * @param {number} [max]
 * @returns {string[]}
 */
export function rememberRefs(existing = [], found = [], max = 12) {
    const out = [];
    for (const ref of [...found, ...existing].map(normaliseRef)) {
        if (ref && !out.includes(ref)) out.push(ref);
    }
    return out.slice(0, max);
}

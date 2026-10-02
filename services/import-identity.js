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
 * the match run into the next word — a real header prints
 * "IBAN: PT50 … 8646 0 SWIFT/BIC: BKBKPTPL" and the reference came out with
 * SWIFT stuck on the end.
 */
const IBAN = /\b([A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,3})?)\b/g;
/** A NIB: 21 digits, printed in groups, read only from a line that names one. */
const NIB = /\b(\d[\d ]{19,28}\d)\b/g;
/** A line that names this account's own number. */
const ACCOUNT_LABEL = /\b(IBAN|NIB)\b/;
/**
 * Numbers printed next to these are not an account: the bank's company number,
 * a branch telephone, a tax number. Each appears on every statement that bank
 * sends, so learning one would make the first account claim all the others.
 */
const NOT_AN_ACCOUNT = /\b(TELEFONE|TELEF|TEL|FAX|NIPC|NIF|CONTRIBUINTE|LINHA|TLF)\b/;

/** How a reference is stored and compared: no spaces, no punctuation, upper case. */
export function normaliseRef(value) {
    return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A date or a money figure that happens to be a long run of digits. */
function looksLikeMoneyOrDate(text) {
    return /\d[.,]\d{2}\b/.test(text) || /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(text);
}

/**
 * The references that identify THIS account: its IBAN, and its NIB where the
 * line names one. Nothing else.
 *
 * The first version read every long digit run on any line carrying no money,
 * which on a real Bankinter statement collected twelve "references": the bank's
 * company number, three branch telephone numbers, and the account numbers of the
 * CARD, the term deposit and the pension fund printed in their own sections.
 * Learning those would have made the current account claim the card's number —
 * so a card statement would file itself into the current account, the exact
 * mix-up this module exists to prevent — while the telephone numbers, printed on
 * every statement that bank sends, would have matched every other account there.
 *
 * A statement with no IBAN or NIB yields nothing, and the import falls back to
 * the account the person chose. Saying nothing is the safe answer: a wrong
 * account is silent, survives every other check (the balance chain and the
 * statement total each check a statement against ITSELF) and compounds monthly.
 *
 * @param {string|string[]} source the statement's text, or its lines
 * @param {number} [limit] how many to keep
 * @returns {string[]} normalised references, IBANs first
 */
export function accountRefs(source, limit = 6) {
    const lines = Array.isArray(source) ? source : String(source ?? '').split('\n');
    const ibans = [], nibs = [];

    for (const line of lines.slice(0, 400)) {
        const text = typeof line === 'string' ? line : (line?.text ?? '');
        if (!text || text.length > 300) continue;
        const upper = text.toUpperCase();
        if (looksLikeMoneyOrDate(upper)) continue;     // a movement row, not a header
        if (!ACCOUNT_LABEL.test(upper)) continue;      // only a line naming an account
        if (NOT_AN_ACCOUNT.test(upper)) continue;

        for (const m of upper.matchAll(IBAN)) {
            const ref = normaliseRef(m[1]);
            if (ref.length >= 15 && ref.length <= 34) ibans.push(ref);
        }
        if (/\bNIB\b/.test(upper)) {
            for (const m of upper.matchAll(NIB)) {
                const ref = normaliseRef(m[1]);
                if (ref.length >= 18 && ref.length <= 24) nibs.push(ref);
            }
        }
    }

    return [...new Set([...ibans, ...nibs])].slice(0, limit);
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

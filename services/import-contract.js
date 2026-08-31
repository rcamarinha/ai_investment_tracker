/**
 * import-contract.js — the single row shape every ingestion source must produce.
 *
 * PURE by contract: no DOM, no network, no service imports. Tests import this
 * directly, so it must never grow a `src/` mirror (see CLAUDE.md).
 *
 * WHY THIS EXISTS
 *
 * Before this file, the "normalized row" was implicit: an object literal inside
 * parseWithProfile, mirrored by hand in spend/storage.js's txToRow. Adding a
 * second ingestion source (OFX, CAMT.053, XLSX, PDF) meant reverse-engineering
 * that literal and hoping the two stayed in step.
 *
 * Making it explicit is what keeps the system bank-agnostic in practice rather
 * than in principle: a new adapter's whole job becomes "emit rows that pass
 * validateRow", and everything downstream — rules, dedupe, enrichment, storage
 * — works unchanged because it only ever sees this shape.
 *
 * The contract is deliberately small. Anything a particular format happens to
 * carry but the ledger does not need (running balance, value date, the bank's
 * own reference numbers) is either optional transport (see `balance`) or
 * dropped at the boundary.
 */

export const CONTRACT_VERSION = 1;

/** Fields an adapter MUST supply for a row to be committable. */
export const REQUIRED_FIELDS = ['date', 'description', 'amount', 'currency'];

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

/**
 * Coerce whatever an adapter produced into the canonical shape.
 *
 * Never throws and never invents: a field it cannot make sense of is left as
 * null for validateRow to reject, rather than being defaulted into something
 * plausible. A silently defaulted date or amount is exactly the failure mode
 * that puts wrong money in the ledger.
 */
export function normalizeRow(input = {}, defaults = {}) {
    const src = { ...defaults, ...input };

    const rawAmount = Number(src.amount);
    const description = String(src.description ?? '').trim();
    const rawDescription = String(src.rawDescription ?? description).trim();
    const currency = String(src.currency ?? 'EUR').trim().toUpperCase();

    return {
        // identity / placement
        accountId: src.accountId ?? null,

        // the movement itself
        date: typeof src.date === 'string' ? src.date.slice(0, 10) : null,
        description: description || '(no description)',
        // Pre-enrichment text. Kept because the fingerprint is built from it,
        // so a later merge that improves `description` cannot make an already
        // imported row look new.
        rawDescription: rawDescription || description || '(no description)',
        merchant: src.merchant ?? null,
        amount: Number.isFinite(rawAmount) ? round2(rawAmount) : null,
        currency,

        // classification — filled downstream, never by the adapter
        category: src.category ?? null,
        categorySource: src.categorySource ?? null,
        categoryConfidence: src.categoryConfidence ?? null,

        // provenance
        // The source system's own id for this movement, where it has one (OFX
        // FITID, CAMT AcctSvcrRef). Carried for traceability only — dedupe
        // stays content-based, so the same movement arriving once from a CSV
        // and later from an OFX export is still recognised as one row.
        externalId: src.externalId ?? null,
        source: src.source ?? null,
        sourceRole: src.sourceRole === 'detail' ? 'detail' : 'statement',
        enrichedFrom: src.enrichedFrom ?? null,

        // Optional transport only: the statement's running balance, carried so
        // balance-continuity verification can check the parse. Not part of the
        // ledger and not persisted.
        balance: Number.isFinite(Number(src.balance)) ? round2(Number(src.balance)) : null,

        needsReview: !!src.needsReview,
        note: src.note ?? null
    };
}

/** Why a row cannot be committed. Empty array means it can. */
export function validateRow(row = {}) {
    const errors = [];

    if (!row.date || !ISO_DATE.test(row.date)) {
        errors.push('date must be YYYY-MM-DD');
    } else {
        // Round-trip the components rather than trusting Date.parse: V8 happily
        // accepts '2026-02-31' and rolls it forward to 3 March, which would file
        // a transaction into the wrong month without anything looking wrong.
        const [y, m, d] = row.date.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
            errors.push('date is not a real calendar date');
        }
    }

    if (row.amount === null || !Number.isFinite(row.amount)) {
        errors.push('amount is not a number');
    } else if (row.amount === 0) {
        // A zero movement carries no information and is almost always a parse
        // artefact — a mis-mapped column, or a header row read as data.
        errors.push('amount is zero');
    }

    if (!row.description || typeof row.description !== 'string') {
        errors.push('description is required');
    }

    if (!ISO_CURRENCY.test(row.currency || '')) {
        errors.push('currency must be a 3-letter ISO code');
    }

    return { ok: errors.length === 0, errors };
}

/**
 * Normalize and validate a batch, partitioning rather than failing whole.
 *
 * One malformed line in a 900-row statement must not cost the other 899 — but
 * it must also never be silently dropped, so rejects come back with a reason
 * and their original index for the review screen.
 */
export function normalizeRows(rows = [], defaults = {}) {
    const accepted = [], rejected = [];
    rows.forEach((raw, index) => {
        const row = normalizeRow(raw, defaults);
        const { ok, errors } = validateRow(row);
        if (ok) accepted.push(row);
        else rejected.push({ index, row, reasons: errors, source: raw });
    });
    return { rows: accepted, rejected };
}

/** True when a row came from a source that enriches rather than stands alone. */
export function isDetailRow(row) { return row?.sourceRole === 'detail'; }

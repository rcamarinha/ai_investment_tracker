/**
 * Comparing a model on trial with the one in use — plan P9 step 5b.
 *
 * While an admin's trial is on, the spend functions return a candidate model's
 * answer beside the real one. The page puts the candidate's rows through the
 * same checks as the real ones (the statement's own running balance and whole-
 * statement total), then discards them. What is kept is this module's output:
 * COUNTS AND VERDICTS ONLY. No description, date, category name or amount — not
 * even a sum, because a one-row section's sum is that row's amount.
 *
 * The bar to switch (agreed with the architect, security and API reviews):
 *  - statements: over 15+ sections from 3+ banks, the candidate passes every
 *    check the current model passes, at most 1% of rows differ, and no row
 *    changes role (statement / detail / skip);
 *  - categories: 90%+ agreement over 200+ rows, none outside the user's list.
 *
 * Pure, so tests/model-trial.test.js checks it.
 */

const cents = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** What a row IS, for comparison: when, how much, which way, and its role. Wording is ignored. */
const rowKey = (r) => `${r?.date ?? ''}|${cents(r?.amount)}|${r?.sourceRole || 'statement'}`;
const moneyKey = (r) => `${r?.date ?? ''}|${cents(r?.amount)}`;

function multiset(rows, keyOf) {
    const m = new Map();
    for (const r of rows) {
        const k = keyOf(r);
        m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
}

/** Rows in one set and not the other, counting duplicates. */
function symmetricDifference(a, b, keyOf) {
    const ma = multiset(a, keyOf), mb = multiset(b, keyOf);
    let diff = 0;
    for (const k of new Set([...ma.keys(), ...mb.keys()])) diff += Math.abs((ma.get(k) || 0) - (mb.get(k) || 0));
    return diff;
}

/**
 * @param {{ rows: object[], chain: object, total: object }} primary   the checked result of the model in use
 * @param {{ rows: object[], chain: object, total: object }} candidate the same checks on the candidate's rows
 * @returns {Record<string, number|boolean>} counts and verdicts only
 */
export function compareExtraction(primary, candidate) {
    const a = primary.rows || [], b = candidate.rows || [];
    const rowsDiffer = symmetricDifference(a, b, rowKey);
    // Same date and amount, different role: the most dangerous kind of
    // difference, since a detail row read as a movement counts money twice.
    const roleChanges = Math.max(0, rowsDiffer - symmetricDifference(a, b, moneyKey));
    return {
        rowsPrimary: a.length,
        rowsCandidate: b.length,
        rowsDiffer,
        roleChanges: Math.ceil(roleChanges / 2),
        chainValidPrimary: !!primary.chain?.valid,
        chainValidCandidate: !!candidate.chain?.valid,
        chainCheckedPrimary: primary.chain?.checked ?? 0,
        chainCheckedCandidate: candidate.chain?.checked ?? 0,
        totalOkPrimary: !!primary.total?.ok,
        totalOkCandidate: !!candidate.total?.ok,
    };
}

/**
 * @param {object[]} primary   [{ id, category }] from the model in use
 * @param {object[]} candidate [{ id, category }] from the candidate
 * @param {string[]} categories the user's own list
 * @returns {Record<string, number>} counts only
 */
export function compareCategories(primary = [], candidate = [], categories = []) {
    const allowed = new Set(categories);
    const byId = new Map(candidate.filter(r => r && r.id !== undefined).map(r => [String(r.id), r]));
    let compared = 0, agree = 0, missing = 0;
    for (const p of primary) {
        if (!p || p.id === undefined) continue;
        const c = byId.get(String(p.id));
        if (!c) { missing++; continue; }
        compared++;
        if (c.category === p.category) agree++;
    }
    const outOfList = candidate.filter(r => r && !allowed.has(r.category)).length;
    return { compared, agree, missing, outOfList };
}

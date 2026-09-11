import { describe, it, expect } from 'vitest';
import { partitionForAi, batchTransactions, toPrompt, applyAiResults, summarizeRun,
    findPrecedent, applyPrecedents, needingCategorisation, mergeReviewQueue, merchantTokens }
    from '../services/categorize-core.js';

const tx = (id, amount, extra = {}) => ({
    id, accountId: 'a', date: '2026-08-01', description: 'thing ' + id,
    amount, currency: 'EUR', category: null, ...extra
});

describe('partitionForAi — what never reaches the model', () => {
    it('sends only uncategorised rows', () => {
        const { toSend, skipped } = partitionForAi([
            tx('1', -10), tx('2', -20, { category: 'Dining' }), tx('3', -30)
        ]);
        expect(toSend.map(t => t.id)).toEqual(['1', '3']);
        expect(skipped.alreadyCategorised).toBe(1);
    });

    it('never sends a transfer', () => {
        // Transfers are established by pairing the user's own accounts — a fact,
        // not a judgement. Asking a model to recognise the account holder's own
        // name would be worse and cost money.
        const { toSend, skipped } = partitionForAi([
            tx('1', -500, { transferPairId: 'tp1' }),
            tx('2', 500, { category: 'transfer' }),
            tx('3', -20)
        ]);
        expect(toSend.map(t => t.id)).toEqual(['3']);
        // BOTH are transfers — one by pair id, one by reserved category. Testing
        // tx.category first attributed the second to "already categorised" and
        // reported "0 transfers skipped": right exclusion, wrong reason.
        expect(skipped.transfer).toBe(2);
        expect(skipped.alreadyCategorised).toBe(0);
    });

    it('never sends a credit already matching a known income category', () => {
        const { toSend, skipped } = partitionForAi(
            [tx('1', 3200, { suggestedCategory: 'Salary' }), tx('2', -20)],
            { incomeCategories: ['Salary'] });
        expect(toSend.map(t => t.id)).toEqual(['2']);
        expect(skipped.income).toBe(1);
    });

    it('handles an empty ledger', () => {
        expect(partitionForAi([]).toSend).toEqual([]);
    });
});

describe('batchTransactions', () => {
    it('splits into request-sized batches without losing rows', () => {
        const rows = Array.from({ length: 95 }, (_, i) => tx(String(i), -1));
        const batches = batchTransactions(rows, 40);
        expect(batches.map(b => b.length)).toEqual([40, 40, 15]);
        expect(batches.flat()).toHaveLength(95);
    });

    it('returns nothing for nothing', () => {
        expect(batchTransactions([], 40)).toEqual([]);
    });
});

describe('toPrompt — only what the model needs', () => {
    it('sends id, description, amount and direction', () => {
        expect(toPrompt([tx('1', -8.9, { merchant: 'Uber' })])[0])
            .toEqual({ id: '1', description: 'Uber', amount: -8.9, direction: 'out' });
    });

    it('never sends balance, account or raw bank text', () => {
        const row = tx('1', -8.9, { balance: 1200, accountId: 'secret', rawDescription: 'COMPRAS C.DEB 4321987654' });
        const sent = toPrompt([row])[0];
        expect(Object.keys(sent).sort()).toEqual(['amount', 'description', 'direction', 'id']);
    });
});

describe('applyAiResults', () => {
    const rows = [tx('1', -10), tx('2', -12), tx('3', -11)];

    it('applies confident answers', () => {
        const { applied } = applyAiResults(rows,
            [{ id: '1', category: 'Dining', confidence: 0.95 }]);
        expect(applied[0]).toMatchObject({ id: '1', category: 'Dining', categorySource: 'ai', categoryConfidence: 0.95 });
    });

    it('sends low confidence to review instead of filing it', () => {
        const { applied, review } = applyAiResults(rows,
            [{ id: '1', category: 'Dining', confidence: 0.4 }]);
        expect(applied).toHaveLength(0);
        expect(review[0]).toMatchObject({ id: '1', suggestedCategory: 'Dining', confidence: 0.4 });
    });

    it('matches by id, never by position', () => {
        // The model can return fewer items than asked. Index matching would put
        // row 3's category onto row 1 — the defect wine's batch valuation hit.
        const { applied } = applyAiResults(rows, [{ id: '3', category: 'Transport', confidence: 0.9 }]);
        expect(applied).toHaveLength(1);
        expect(applied[0].id).toBe('3');
        expect(applied[0].category).toBe('Transport');
    });

    it('reports rows the model simply did not answer', () => {
        const { unanswered } = applyAiResults(rows, [{ id: '1', category: 'Dining', confidence: 0.9 }]);
        expect(unanswered.map(t => t.id)).toEqual(['2', '3']);
    });

    it('forces an unusually large transaction to review whatever its confidence', () => {
        // A big one-off filed as routine spend is worse than leaving it
        // uncategorised: a gap is visible, a wrong category is not — until the
        // savings rate built on it is already wrong.
        const withBig = [...rows, tx('4', -5000)];
        const { applied, review } = applyAiResults(withBig,
            [{ id: '4', category: 'Shopping', confidence: 0.99 }]);
        expect(applied).toHaveLength(0);
        expect(review[0]).toMatchObject({ id: '4', suggestedCategory: 'Shopping' });
        expect(review[0].reason).toMatch(/unusually large/);
    });

    it('rejects a category the user does not have', () => {
        const { applied, review } = applyAiResults(rows,
            [{ id: '1', category: 'Cryptocurrency', confidence: 0.99 }],
            { validCategories: ['Dining', 'Transport'] });
        expect(applied).toHaveLength(0);
        expect(review[0].reason).toMatch(/does not exist/);
    });

    it('ignores a malformed or empty answer', () => {
        const { applied, unanswered } = applyAiResults(rows,
            [null, { id: '1' }, { category: 'Dining', confidence: 0.9 }]);
        expect(applied).toHaveLength(0);
        expect(unanswered).toHaveLength(3);
    });

    it('treats a missing confidence as not confident', () => {
        const { applied, review } = applyAiResults(rows, [{ id: '1', category: 'Dining' }]);
        expect(applied).toHaveLength(0);
        expect(review[0].confidence).toBeNull();
    });
});

describe('summarizeRun', () => {
    it('adds up to the whole batch', () => {
        const s = summarizeRun({ ruleMatched: 140, applied: 200, review: 30, unanswered: 5,
                                 skipped: { transfer: 12, income: 8 } });
        expect(s.total).toBe(375);
        expect(s).toMatchObject({ skippedTransfer: 12, skippedIncome: 8 });
    });
});

// A negative amount classed as income is a contradiction, not a low-confidence
// guess: the real case was a -555,49 card payment suggested as "Other income".
// Confidence cannot settle it, so the check runs ahead of the threshold.
describe('sign versus category kind', () => {
    const income = ['Other income', 'Salary'];

    it('sends an income category on money leaving the account to review', () => {
        const txs = [{ id: '1', amount: -555.49, description: 'PAG.CTA.CARTAO' }];
        const res = applyAiResults(txs, [{ id: '1', category: 'Other income', confidence: 0.99 }],
            { validCategories: [...income, 'Card'], incomeCategories: income });
        expect(res.applied).toHaveLength(0);
        expect(res.review[0].reason).toMatch(/money left the account/);
    });

    it('still applies an income category to money arriving', () => {
        const txs = [{ id: '1', amount: 644.00, description: 'TRF.IMED.' }];
        const res = applyAiResults(txs, [{ id: '1', category: 'Other income', confidence: 0.99 }],
            { validCategories: income, incomeCategories: income });
        expect(res.applied).toHaveLength(1);
    });

    it('allows a refund: positive amount on a spend category', () => {
        const txs = [{ id: '1', amount: 30.00, description: 'REFUND' }];
        const res = applyAiResults(txs, [{ id: '1', category: 'Groceries', confidence: 0.95 }],
            { validCategories: ['Groceries'], incomeCategories: income });
        expect(res.applied).toHaveLength(1);
    });
});

// The ledger is the record of every decision the user has made, and it was not
// being read. Learning ran entirely off the rules table, which is written only
// when someone corrects a row one at a time — so "accept all confident" taught
// nothing, and a merchant filed as Dining twenty times still came back
// suggested as Leisure.
describe('learning from what the user already decided', () => {
    const history = [
        { id: '1', description: 'COMPRA OPORTO CRICKET CLUB 0003791851', category: 'Dining' },
        { id: '2', description: 'OPORTO CRICKET CLUB', category: 'Dining' },
        { id: '3', description: 'CONTINENTE BOM DIA PORTO', category: 'Groceries' },
        { id: '4', description: 'COMPRA GALP ENERGIA', category: 'Fuel' }
    ];

    it('recognises the same merchant written differently', () => {
        // The reported case: three spellings of one club across two imports.
        expect(findPrecedent({ id: 'x', description: 'COMPRA OPORTO CRICKET' }, history))
            .toMatchObject({ category: 'Dining', count: 2 });
        expect(findPrecedent({ id: 'x', description: 'OPORTO CRICKET' }, history))
            .toMatchObject({ category: 'Dining' });
    });

    it('does not match on a shared prefix alone', () => {
        // "COMPRA" is on half the statement; one shared word is not a merchant.
        expect(findPrecedent({ id: 'x', description: 'COMPRA NOVO SITIO' }, history)).toBeNull();
    });

    it('refuses when the user has filed the merchant both ways', () => {
        const split = [
            { id: '1', description: 'OPORTO CRICKET CLUB', category: 'Dining' },
            { id: '2', description: 'OPORTO CRICKET CLUB', category: 'Leisure' }
        ];
        expect(findPrecedent({ id: 'x', description: 'OPORTO CRICKET' }, split)).toBeNull();
    });

    it('never learns from a transfer', () => {
        const transfers = [{ id: '1', description: 'CARTOES BKCF DEB MENSAL', category: 'transfer' }];
        expect(findPrecedent({ id: 'x', description: 'CARTOES BKCF DEB' }, transfers)).toBeNull();
    });

    it('settles what it can and passes the rest on', () => {
        const { settled, remaining } = applyPrecedents(
            [{ id: 'a', description: 'COMPRA OPORTO CRICKET' }, { id: 'b', description: 'NEW SHOP LDA' }], history);
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({ category: 'Dining', categorySource: 'rule' });
        expect(remaining.map(r => r.id)).toEqual(['b']);
    });

    it('leaves an already-categorised row alone', () => {
        const { settled, remaining } = applyPrecedents(
            [{ id: 'a', description: 'COMPRA OPORTO CRICKET', category: 'Leisure' }], history);
        expect(settled).toHaveLength(0);
        expect(remaining[0].category).toBe('Leisure');
    });
});

describe('needingCategorisation — what is still an open question', () => {
    it('counts an uncategorised row with no suggestion waiting', () => {
        const rows = [tx('1', -10), tx('2', -20, { category: 'Dining' }), tx('3', -30)];
        expect(needingCategorisation(rows, []).map(t => t.id)).toEqual(['1', '3']);
    });

    it('excludes a row that already has a suggestion pending', () => {
        // Paying the model twice for the same row, and overwriting an answer
        // the user has not looked at, are the same mistake.
        const rows = [tx('1', -10), tx('3', -30)];
        expect(needingCategorisation(rows, [{ id: '1', suggestedCategory: 'Dining' }])
            .map(t => t.id)).toEqual(['3']);
    });

    it('still finds work when every suggestion belongs to older rows', () => {
        // The import case: a queue left unanswered from an earlier run must not
        // make freshly imported rows look settled.
        const imported = [tx('9', -12), tx('10', -8)];
        const queue = [{ id: '1', suggestedCategory: 'Dining' }];
        expect(needingCategorisation(imported, queue)).toHaveLength(2);
    });
});

describe('mergeReviewQueue — a run must not discard unanswered questions', () => {
    it('keeps suggestions the user has not answered yet', () => {
        const merged = mergeReviewQueue(
            [{ id: '1', suggestedCategory: 'Dining' }],
            [{ id: '2', suggestedCategory: 'Travel' }]);
        expect(merged.map(r => r.id)).toEqual(['1', '2']);
    });

    it('lets a fresh answer replace a stale one for the same row', () => {
        const merged = mergeReviewQueue(
            [{ id: '1', suggestedCategory: 'Dining' }],
            [{ id: '1', suggestedCategory: 'Groceries' }]);
        expect(merged).toHaveLength(1);
        expect(merged[0].suggestedCategory).toBe('Groceries');
    });

    it('drops a suggestion for a row that has since been filed', () => {
        const merged = mergeReviewQueue(
            [{ id: '1', suggestedCategory: 'Dining' }, { id: '2', suggestedCategory: 'Travel' }],
            [], ['1']);
        expect(merged.map(r => r.id)).toEqual(['2']);
    });
});

// merchantTokens is the matching primitive for the entire precedent system.
// Getting the filter wrong here makes the precedent matcher either too broad
// (matching unrelated rows on a shared prefix like "compra") or too narrow
// (stripping real merchant words because of diacritics or punctuation).
describe('merchantTokens — significant words of a merchant description', () => {
    it('returns the meaningful words in lowercase', () => {
        const tokens = merchantTokens({ description: 'OPORTO CRICKET CLUB' });
        expect([...tokens].sort()).toEqual(['club', 'cricket', 'oporto']);
    });

    it('strips diacritics so accented and plain spellings match', () => {
        // "CAFÉ DA PRAÇA" → "cafe praca"; "da" (2 chars) is excluded
        const tokens = merchantTokens({ description: 'CAFÉ DA PRAÇA' });
        expect([...tokens]).toContain('cafe');
        expect([...tokens]).toContain('praca');
        expect([...tokens]).not.toContain('da');
    });

    it('excludes tokens of two characters or fewer', () => {
        // "SL", "de", "EU" are filler words a bank appends, not merchant names.
        const tokens = merchantTokens({ description: 'SL DE EU SUPERMERCADO' });
        expect([...tokens]).toEqual(['supermercado']);
    });

    it('excludes all-numeric tokens', () => {
        // Account numbers and terminal IDs appear in descriptions; they are noise,
        // not merchant identifiers.
        const tokens = merchantTokens({ description: 'COMPRA 0033791851 SHOP' });
        expect([...tokens]).not.toContain('0033791851');
        expect([...tokens]).toContain('compra');
        expect([...tokens]).toContain('shop');
    });

    it('uses merchant field ahead of rawDescription and description', () => {
        const tokens = merchantTokens({ merchant: 'GALP ENERGIA', rawDescription: 'COMPRA GALP POSTO', description: 'IGNORE ME' });
        expect([...tokens].sort()).toEqual(['energia', 'galp']);
    });

    it('falls through to description when merchant and rawDescription are absent', () => {
        const tokens = merchantTokens({ description: 'CONTINENTE BOM DIA' });
        expect([...tokens]).toContain('continente');
    });

    it('returns an empty set for a null or missing tx', () => {
        expect(merchantTokens(null).size).toBe(0);
        expect(merchantTokens({}).size).toBe(0);
        expect(merchantTokens({ description: '' }).size).toBe(0);
    });

    it('returns empty when every token is too short or numeric', () => {
        // A description of only bank codes — no usable merchant signal at all.
        // findPrecedent short-circuits on mine.size < 2, so this never matches.
        const tokens = merchantTokens({ description: 'SL 00 EU' });
        expect(tokens.size).toBe(0);
    });
});

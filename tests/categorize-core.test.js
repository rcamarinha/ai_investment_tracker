import { describe, it, expect } from 'vitest';
import { partitionForAi, batchTransactions, toPrompt, applyAiResults, summarizeRun }
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

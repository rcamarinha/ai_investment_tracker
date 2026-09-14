import { describe, it, expect } from 'vitest';
import { triageBatchValuation } from '../src/wine.js';

/**
 * Batch wine valuation, decided before anything is written.
 *
 * The batch path used to apply whatever the model returned. A missing price
 * reached the bottle, a bottle the model skipped was reported as valued, and a
 * tenfold jump was saved without a second look. That figure feeds household net
 * worth on the hub, so each of those was a silent wrong number.
 */

const bottle = (id, extra = {}) => ({ id, name: `Wine ${id}`, ...extra });

describe('triageBatchValuation', () => {
    it('applies a well-formed result to the bottle it names', () => {
        const b = bottle('a');
        const { apply, errors, missing, heldBack } = triageBatchValuation([b], [{ id: 'a', estimatedValue: 42 }]);
        expect(apply).toHaveLength(1);
        expect(apply[0].bottle).toBe(b);
        expect(apply[0].result.estimatedValue).toBe(42);
        expect([errors.length, missing.length, heldBack.length]).toEqual([0, 0, 0]);
    });

    it('matches by id, never by position', () => {
        const a = bottle('a'), b = bottle('b');
        const { apply } = triageBatchValuation([a, b], [{ id: 'b', estimatedValue: 20 }, { id: 'a', estimatedValue: 10 }]);
        expect(apply.find(x => x.bottle === a).result.estimatedValue).toBe(10);
        expect(apply.find(x => x.bottle === b).result.estimatedValue).toBe(20);
    });

    it('refuses a result with no usable price instead of writing it', () => {
        // The single-bottle path always refused these. The batch path wrote them.
        for (const estimatedValue of [null, undefined, '', 'abc', 0, -5, NaN]) {
            const { apply, errors } = triageBatchValuation([bottle('a')], [{ id: 'a', estimatedValue }]);
            expect(apply, String(estimatedValue)).toHaveLength(0);
            expect(errors, String(estimatedValue)).toHaveLength(1);
        }
    });

    it('accepts a numeric string, stored as a number', () => {
        const { apply } = triageBatchValuation([bottle('a')], [{ id: 'a', estimatedValue: '42.5' }]);
        expect(apply[0].result.estimatedValue).toBe(42.5);
    });

    it('counts a bottle the model never returned as missing, not as valued', () => {
        // The old count was bottles sent minus errors, so an omitted bottle was
        // reported as a success.
        const { apply, missing } = triageBatchValuation([bottle('a'), bottle('b')], [{ id: 'a', estimatedValue: 10 }]);
        expect(apply).toHaveLength(1);
        expect(missing.map(b => b.id)).toEqual(['b']);
    });

    it('records a returned error against its bottle, and does not call it missing', () => {
        const { errors, missing } = triageBatchValuation([bottle('a')], [{ id: 'a', error: 'no listings found' }]);
        expect(errors[0]).toContain('no listings found');
        expect(missing).toHaveLength(0);
    });

    it('ignores results for bottles that were not in the batch', () => {
        const { apply, missing } = triageBatchValuation([bottle('a')], [{ id: 'zzz', estimatedValue: 10 }]);
        expect(apply).toHaveLength(0);
        expect(missing.map(b => b.id)).toEqual(['a']);
    });

    it('uses the first answer when the model returns the same bottle twice', () => {
        const { apply } = triageBatchValuation([bottle('a')], [{ id: 'a', estimatedValue: 10 }, { id: 'a', estimatedValue: 99 }]);
        expect(apply).toHaveLength(1);
        expect(apply[0].result.estimatedValue).toBe(10);
    });

    it('holds back a value that jumped more than threefold', () => {
        const { apply, heldBack } = triageBatchValuation([bottle('a', { estimatedValue: 50 })], [{ id: 'a', estimatedValue: 400 }]);
        expect(apply).toHaveLength(0);
        expect(heldBack[0]).toMatchObject({ from: 50, to: 400 });
    });

    it('holds back a value that fell to under a third', () => {
        const { heldBack } = triageBatchValuation([bottle('a', { estimatedValue: 300 })], [{ id: 'a', estimatedValue: 40 }]);
        expect(heldBack).toHaveLength(1);
    });

    it('accepts an ordinary move within threefold', () => {
        const { apply } = triageBatchValuation([bottle('a', { estimatedValue: 50 })], [{ id: 'a', estimatedValue: 140 }]);
        expect(apply).toHaveLength(1);
    });

    it('applies a first valuation of any size, since there is nothing to compare it with', () => {
        const { apply } = triageBatchValuation([bottle('a')], [{ id: 'a', estimatedValue: 5000 }]);
        expect(apply).toHaveLength(1);
    });

    it('holds back a value outside the range the valuation itself gave', () => {
        const { apply, heldBack } = triageBatchValuation([bottle('a')], [{ id: 'a', estimatedValue: 500, valueLow: 40, valueHigh: 60 }]);
        expect(apply).toHaveLength(0);
        expect(heldBack).toHaveLength(1);
    });

    it('ignores an incoherent range rather than holding back on it', () => {
        const { apply } = triageBatchValuation([bottle('a')], [{ id: 'a', estimatedValue: 50, valueLow: 80, valueHigh: 20 }]);
        expect(apply).toHaveLength(1);
    });
});

import { describe, it, expect } from 'vitest';
import {
    daysSince, valuationFreshness, holdingGain, summarizeHoldings, maturityStatus, isActive
} from '../services/holdings-core.js';

// Shaped like the real statements: a Banco BEST bond and a Bankinter PPR fund.
const bond = {
    id: 'b1', bankName: 'Banco BEST', name: 'Obrigações', holdingType: 'bond',
    currency: 'EUR', nominal: 100000, costBasis: 95000,
    currentValue: 98205, valuedAsOf: '2026-08-01', valuationSource: 'statement'
};
const fund = {
    id: 'f1', bankName: 'Bankinter', name: 'BK 25 PPR OICVM/A', holdingType: 'fund',
    currency: 'EUR', units: 5441.171, costBasis: 52000,
    currentValue: 59396.36, valuedAsOf: '2026-07-31', valuationSource: 'statement'
};
const TODAY = '2026-08-28';

describe('daysSince / valuationFreshness', () => {
    it('measures age in whole days', () => {
        expect(daysSince('2026-08-01', '2026-08-28')).toBe(27);
        expect(daysSince('2026-08-28', '2026-08-28')).toBe(0);
        expect(daysSince('rubbish', TODAY)).toBeNull();
    });

    it('treats a monthly statement cycle as current', () => {
        // Statements arrive monthly, so a 27-day-old valuation is simply current.
        expect(valuationFreshness('2026-08-01', TODAY)).toMatchObject({ level: 'current', days: 27 });
        expect(valuationFreshness('2026-08-27', TODAY).label).toBe('valued 1d ago');
        expect(valuationFreshness(TODAY, TODAY).label).toBe('valued today');
    });

    it('escalates as a valuation ages', () => {
        expect(valuationFreshness('2026-07-01', TODAY).level).toBe('ageing');
        expect(valuationFreshness('2026-01-01', TODAY).level).toBe('stale');
    });

    it('says so rather than guessing when there is no date', () => {
        expect(valuationFreshness(null, TODAY)).toMatchObject({ level: 'unknown', days: null });
        expect(valuationFreshness('2027-01-01', TODAY).level).toBe('future');
    });
});

describe('holdingGain', () => {
    it('is a point-in-time gain against cost', () => {
        expect(holdingGain(bond)).toEqual({ absolute: 3205, pct: 0.0337 });
    });

    it('returns null when cost is unknown, rather than implying break-even', () => {
        // "no cost recorded" and "broke even" are different facts.
        expect(holdingGain({ ...bond, costBasis: null })).toBeNull();
        expect(holdingGain({ ...bond, costBasis: 0 })).toBeNull();
    });

    it('never reports an annualised or IRR figure', () => {
        // v1 has no cash-flow history, so any rate of return would be invented.
        const g = holdingGain(fund);
        expect(Object.keys(g).sort()).toEqual(['absolute', 'pct']);
    });
});

describe('summarizeHoldings', () => {
    it('totals the real statement figures', () => {
        const s = summarizeHoldings([bond, fund], { today: TODAY });
        expect(s.count).toBe(2);
        expect(s.total).toBe(157601.36);          // the money missing from the hub
        expect(s.gain).toEqual({ absolute: 10601.36, pct: 0.0721 });
    });

    it('carries the OLDEST valuation, not the newest', () => {
        // A total is only as trustworthy as its stalest input.
        const s = summarizeHoldings([bond, fund], { today: TODAY });
        expect(s.oldestValuation.date).toBe('2026-07-31');
        expect(s.oldestValuation.days).toBe(28);
    });

    it('reports how much of the total actually has a cost basis', () => {
        const s = summarizeHoldings([bond, { ...fund, costBasis: null }], { today: TODAY });
        // Gain covers the bond alone, and coverage says so — so a gain derived
        // from part of the portfolio is never shown as speaking for all of it.
        expect(s.gain).toEqual({ absolute: 3205, pct: 0.0337 });
        expect(s.costCoverage).toBeCloseTo(98205 / 157601.36, 4);
    });

    it('returns a null gain when no holding has a cost', () => {
        const s = summarizeHoldings([{ ...bond, costBasis: null }], { today: TODAY });
        expect(s.gain).toBeNull();
        expect(s.costCoverage).toBe(0);
    });

    it('excludes archived holdings and rows with no value', () => {
        const s = summarizeHoldings([bond, { ...fund, archived: true }, { ...fund, id: 'x', currentValue: null }], { today: TODAY });
        expect(s.count).toBe(1);
        expect(s.total).toBe(98205);
    });

    it('groups by type and by bank, largest first', () => {
        const s = summarizeHoldings([bond, fund], { today: TODAY });
        expect(s.byType).toEqual([{ type: 'bond', value: 98205 }, { type: 'fund', value: 59396.36 }]);
        expect(s.byBank[0]).toEqual({ bank: 'Banco BEST', value: 98205 });
    });

    it('handles an empty portfolio without throwing', () => {
        const s = summarizeHoldings([], { today: TODAY });
        expect(s).toMatchObject({ count: 0, total: 0, gain: null, costCoverage: 0 });
        expect(s.oldestValuation.level).toBe('unknown');
    });
});

describe('maturityStatus', () => {
    it('flags a bond maturing soon', () => {
        expect(maturityStatus({ maturityDate: '2026-10-01' }, TODAY)).toMatchObject({ level: 'soon' });
    });
    it('flags one that already matured', () => {
        expect(maturityStatus({ maturityDate: '2026-01-01' }, TODAY)).toMatchObject({ level: 'matured' });
    });
    it('is silent for holdings with no maturity, such as funds', () => {
        expect(maturityStatus(fund, TODAY)).toBeNull();
    });
});

describe('isActive', () => {
    it('needs a usable value', () => {
        expect(isActive(bond)).toBe(true);
        expect(isActive({ ...bond, currentValue: null })).toBe(false);
        expect(isActive({ ...bond, currentValue: undefined })).toBe(false);
        expect(isActive({ ...bond, currentValue: '' })).toBe(false);
        expect(isActive({ ...bond, archived: true })).toBe(false);
    });

    it('keeps a genuine zero — a matured bond is not a missing valuation', () => {
        expect(isActive({ ...bond, currentValue: 0 })).toBe(true);
    });
});

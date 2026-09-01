import { describe, it, expect } from 'vitest';
import {
    periodKey, periodRange, shiftPeriod, resolveBaseline,
    summarize, rollupByPeriod, buildTrendSeries, comparePeriods, coverageOf, findOneOffs,
    detectInternalTransfers, detectRecurring, normalizeMerchantKey,
    baselineMonthly, projectScenario, daysBetween
} from '../services/spend-core.js';

// Helper: terse transaction factory. Negative amount = money out.
let seq = 0;
const tx = (date, amount, extra = {}) => ({
    id: extra.id || `t${++seq}`,
    accountId: extra.accountId || 'acc1',
    date, amount,
    description: extra.description || 'X',
    currency: 'EUR',
    ...extra
});

describe('period helpers', () => {
    it('keys months, quarters and years', () => {
        expect(periodKey('2026-03-15', 'month')).toBe('2026-03');
        expect(periodKey('2026-03-15', 'quarter')).toBe('2026-Q1');
        expect(periodKey('2026-12-31', 'quarter')).toBe('2026-Q4');
        expect(periodKey('2026-03-15', 'year')).toBe('2026');
        expect(periodKey('nonsense', 'month')).toBeNull();
    });

    it('ranges cover the whole period, including February in a leap year', () => {
        expect(periodRange('2026-02', 'month')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
        expect(periodRange('2028-02', 'month')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
        expect(periodRange('2026-Q1', 'quarter')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
        expect(periodRange('2026', 'year')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    });

    it('shifts across year boundaries in both directions', () => {
        expect(shiftPeriod('2026-01', 'month', -1)).toBe('2025-12');
        expect(shiftPeriod('2026-12', 'month', 1)).toBe('2027-01');
        expect(shiftPeriod('2026-Q1', 'quarter', -1)).toBe('2025-Q4');
        expect(shiftPeriod('2026-Q4', 'quarter', 1)).toBe('2027-Q1');
        expect(shiftPeriod('2026', 'year', -1)).toBe('2025');
    });

    it('resolves the baseline period per mode and grain', () => {
        expect(resolveBaseline('2026-03', 'month', 'previous')).toBe('2026-02');
        expect(resolveBaseline('2026-03', 'month', 'yoy')).toBe('2025-03');
        expect(resolveBaseline('2026-Q2', 'quarter', 'yoy')).toBe('2025-Q2');
        expect(resolveBaseline('2026', 'year', 'yoy')).toBe('2025');
        expect(resolveBaseline('2026-03', 'month', 'none')).toBeNull();
    });

    it('parses dates in UTC so a timezone never moves a transaction between months', () => {
        // 1st of the month at midnight is the classic off-by-one-day victim.
        expect(periodKey('2026-03-01')).toBe('2026-03');
        expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
        expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2); // leap year
    });
});

describe('summarize', () => {
    it('splits income from spend and reports spend as a positive magnitude', () => {
        const s = summarize([tx('2026-03-01', 2000), tx('2026-03-02', -500), tx('2026-03-03', -100)]);
        expect(s.income).toBe(2000);
        expect(s.spend).toBe(600);
        expect(s.net).toBe(1400);
        expect(s.savingsRate).toBe(0.7);
    });

    it('excludes transfers, whether flagged by category or by pair id', () => {
        const s = summarize([
            tx('2026-03-01', 2000),
            tx('2026-03-02', -1000, { category: 'transfer' }),
            tx('2026-03-02', 1000, { transferPairId: 'tp1' }),
            tx('2026-03-03', -200)
        ]);
        // Without exclusion this would read as €3000 income and €1200 spend.
        expect(s.income).toBe(2000);
        expect(s.spend).toBe(200);
    });

    it('nets a refund against its category instead of counting it as income', () => {
        const s = summarize([
            tx('2026-03-01', 3000, { category: 'Salary' }),
            tx('2026-03-05', -120, { category: 'Shopping' }),
            tx('2026-03-09', 40, { category: 'Shopping' })   // returned an item
        ], { incomeCategories: ['Salary'] });
        expect(s.income).toBe(3000);
        expect(s.spend).toBe(80);
        expect(s.byCategory).toEqual([{ category: 'Shopping', amount: 80 }]);
    });

    it('reports uncategorised spend as a null category rather than inventing "Other"', () => {
        const s = summarize([tx('2026-03-01', -50)]);
        expect(s.byCategory).toEqual([{ category: null, amount: 50 }]);
    });

    it('does not count money moved to savings as consumption', () => {
        // A trust-fund contribution is neither spend nor a transfer between the
        // user's own accounts. Calling it spend understates the savings rate
        // every month, and that rate feeds every projection the app makes.
        const rows = [
            tx('2026-03-01', 3000, { category: 'Salary' }),
            tx('2026-03-05', -1200, { category: 'Housing' }),
            tx('2026-03-10', -500, { category: "Kids' trust" })
        ];
        const s = summarize(rows, { incomeCategories: ['Salary'], savingsCategories: ["Kids' trust"] });
        expect(s.income).toBe(3000);
        expect(s.spend).toBe(1200);              // consumption only
        expect(s.savedInvested).toBe(500);
        expect(s.savingsRate).toBe(0.6);         // (3000 - 1200) / 3000
    });

    it('distinguishes what was not consumed from what is still in the account', () => {
        // Both are true and they are different numbers; conflating them would
        // overstate the cash actually available.
        const rows = [
            tx('2026-03-01', 3000, { category: 'Salary' }),
            tx('2026-03-05', -1200, { category: 'Housing' }),
            tx('2026-03-10', -500, { category: "Kids' trust" })
        ];
        const s = summarize(rows, { incomeCategories: ['Salary'], savingsCategories: ["Kids' trust"] });
        expect(s.net).toBe(1800);           // income minus consumption
        expect(s.cashRetained).toBe(1300);  // ...minus what was moved out to save
    });

    it('still shows a savings category in the breakdown, so the money is visible', () => {
        const rows = [
            tx('2026-03-01', 3000, { category: 'Salary' }),
            tx('2026-03-10', -500, { category: "Kids' trust" })
        ];
        const s = summarize(rows, { incomeCategories: ['Salary'], savingsCategories: ["Kids' trust"] });
        expect(s.byCategory).toEqual([{ category: "Kids' trust", amount: 500 }]);
    });

    it('behaves exactly as before when no category is marked as savings', () => {
        // The column defaults false, so existing ledgers must be unaffected.
        const rows = [tx('2026-03-01', 3000, { category: 'Salary' }), tx('2026-03-05', -1200, { category: 'Housing' })];
        const s = summarize(rows, { incomeCategories: ['Salary'] });
        expect(s).toMatchObject({ income: 3000, spend: 1200, savedInvested: 0, net: 1800, cashRetained: 1800 });
    });

    it('returns a null savings rate when there is no income to divide by', () => {
        expect(summarize([tx('2026-03-01', -50)]).savingsRate).toBeNull();
    });
});

describe('rollupByPeriod / buildTrendSeries', () => {
    const rows = [
        tx('2026-01-10', 2000), tx('2026-01-11', -800),
        tx('2026-02-10', 2000), tx('2026-02-11', -600),
        tx('2026-03-10', 2000), tx('2026-03-11', -900)
    ];

    it('buckets by month in chronological order', () => {
        const r = rollupByPeriod(rows, 'month');
        expect(r.map(x => x.period)).toEqual(['2026-01', '2026-02', '2026-03']);
        expect(r[1].spend).toBe(600);
    });

    it('rolls months up into a quarter', () => {
        const r = rollupByPeriod(rows, 'quarter');
        expect(r).toHaveLength(1);
        expect(r[0].spend).toBe(2300);
    });

    it('fills gaps with explicit empty periods so the chart has no holes', () => {
        const series = buildTrendSeries(rows, { grain: 'month', periods: 5, endPeriod: '2026-03' });
        expect(series.map(s => s.period)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
        expect(series[0]).toMatchObject({ spend: 0, empty: true });
        expect(series[4]).toMatchObject({ spend: 900, empty: false });
    });

    it('follows the category slicer', () => {
        const series = buildTrendSeries(
            [...rows, tx('2026-03-12', -75, { category: 'Dining' })],
            { grain: 'month', periods: 1, endPeriod: '2026-03', category: 'Dining' }
        );
        expect(series[0].spend).toBe(75);
    });
});

describe('comparePeriods', () => {
    const twoYears = [
        // March 2025 — the YoY baseline
        tx('2025-03-05', 3000, { category: 'Salary' }),
        tx('2025-03-06', -400, { category: 'Dining' }),
        tx('2025-03-20', -200, { category: 'Groceries' }),
        // February 2026 — the previous-period baseline
        tx('2026-02-05', 3000, { category: 'Salary' }),
        tx('2026-02-06', -300, { category: 'Dining' }),
        // March 2026 — current
        tx('2026-03-05', 3000, { category: 'Salary' }),
        tx('2026-03-06', -500, { category: 'Dining' })
    ];
    const opts = { grain: 'month', period: '2026-03', incomeCategories: ['Salary'] };

    it('carries savings categories into every derived figure', () => {
        // comparePeriods and buildTrendSeries used to rebuild a narrowed options
        // object, dropping savingsCategories one layer down — so the headline
        // counted a trust-fund contribution as spending even though summarize()
        // handled it correctly.
        const rows = [
            tx('2026-03-01', 3000, { category: 'Salary' }),
            tx('2026-03-05', -1200, { category: 'Housing' }),
            tx('2026-03-10', -500, { category: 'Trust' })
        ];
        const opts = { grain: 'month', period: '2026-03', mode: 'none',
                       incomeCategories: ['Salary'], savingsCategories: ['Trust'] };
        const r = comparePeriods(rows, opts);
        expect(r.current.spend).toBe(1200);
        expect(r.current.savedInvested).toBe(500);
        expect(r.current.savingsRate).toBe(0.6);

        const series = buildTrendSeries(rows, {
            grain: 'month', periods: 1, endPeriod: '2026-03',
            incomeCategories: ['Salary'], savingsCategories: ['Trust']
        });
        expect(series[0].spend).toBe(1200);
    });

    it('compares against the previous period', () => {
        const r = comparePeriods(twoYears, { ...opts, mode: 'previous' });
        expect(r.baselinePeriod).toBe('2026-02');
        expect(r.current.spend).toBe(500);
        expect(r.baseline.spend).toBe(300);
        expect(r.delta.spend).toBe(200);
        expect(r.delta.spendPct).toBeCloseTo(0.6667, 3);
    });

    it('compares year on year and surfaces a category that disappeared', () => {
        const r = comparePeriods(twoYears, { ...opts, mode: 'yoy' });
        expect(r.baselinePeriod).toBe('2025-03');
        expect(r.baseline.spend).toBe(600);
        const groceries = r.delta.byCategory.find(c => c.category === 'Groceries');
        expect(groceries).toMatchObject({ current: 0, baseline: 200, delta: -200 });
    });

    it('aligns a part-finished month against the same day range in the baseline', () => {
        // The trap: on the 8th, 8 days of spend vs a whole month reads as a collapse.
        const rows = [
            tx('2026-02-03', -100), tx('2026-02-20', -900),   // 1000 across all of February
            tx('2026-03-03', -120)                             // 120 in the first 8 days of March
        ];
        const r = comparePeriods(rows, { grain: 'month', period: '2026-03', mode: 'previous', today: '2026-03-08' });
        expect(r.aligned).toBe(true);
        expect(r.alignLabel).toBe('MTD vs MTD');
        expect(r.elapsedDays).toBe(8);
        // Only the 3 Feb charge falls inside Feb 1-8, so this is 120 vs 100, not 120 vs 1000.
        expect(r.baseline.spend).toBe(100);
        expect(r.delta.spend).toBe(20);
    });

    it('does not align once the period is complete', () => {
        const r = comparePeriods(twoYears, { ...opts, mode: 'previous', today: '2026-04-15' });
        expect(r.aligned).toBe(false);
        expect(r.alignLabel).toBeNull();
    });

    it('flags insufficient data instead of reporting a delta against an empty baseline', () => {
        const only2026 = twoYears.filter(t => t.date >= '2026-01-01');
        const r = comparePeriods(only2026, { ...opts, mode: 'yoy' });
        expect(r.insufficientData).toBe(true);
        expect(r.delta).toBeNull();
        expect(r.coverage.firstDate).toBe('2026-02-05');
    });

    it('flags a baseline that is only partly covered by imported history', () => {
        const rows = [
            tx('2026-02-15', -100),   // history starts mid-February
            tx('2026-03-05', -300)
        ];
        const r = comparePeriods(rows, { grain: 'month', period: '2026-03', mode: 'previous' });
        expect(r.insufficientData).toBe(false);
        expect(r.partialBaseline).toBe(true);
    });

    it('can exclude a lumpy one-off from both sides of the comparison', () => {
        const rows = [
            tx('2026-02-10', -100), tx('2026-02-11', -100),
            tx('2026-03-10', -100), tx('2026-03-11', -1800, { id: 'insurance', description: 'Annual insurance' })
        ];
        const withOneOff = comparePeriods(rows, { grain: 'month', period: '2026-03', mode: 'previous' });
        expect(withOneOff.current.spend).toBe(1900);
        expect(withOneOff.oneOffs.map(t => t.id)).toContain('insurance');

        const without = comparePeriods(rows, { grain: 'month', period: '2026-03', mode: 'previous', excludeOneOffs: true });
        expect(without.current.spend).toBe(100);
        expect(without.delta.spend).toBe(-100);
    });
});

describe('findOneOffs / coverageOf', () => {
    it('flags transactions that dominate their period', () => {
        const rows = [tx('2026-03-01', -50), tx('2026-03-02', -50), tx('2026-03-03', -900)];
        expect(findOneOffs(rows).map(t => t.amount)).toEqual([-900]);
    });

    it('does not flag every transaction in a quiet month', () => {
        // Two equal charges are each 50% of the period, but neither is an outlier.
        expect(findOneOffs([tx('2026-03-01', -100), tx('2026-03-02', -100)])).toEqual([]);
    });

    it('reports the span of imported history', () => {
        expect(coverageOf([tx('2026-01-10', -1), tx('2026-03-10', -1)]))
            .toMatchObject({ firstDate: '2026-01-10', lastDate: '2026-03-10', months: 3 });
        expect(coverageOf([])).toMatchObject({ firstDate: null, months: 0 });
    });
});

describe('detectInternalTransfers', () => {
    it('pairs opposite legs across two accounts within the window', () => {
        const rows = [
            tx('2026-03-01', -500, { id: 'out', accountId: 'millennium' }),
            tx('2026-03-02', 500, { id: 'in', accountId: 'revolut' })
        ];
        const { pairs } = detectInternalTransfers(rows);
        expect(pairs).toHaveLength(1);
        expect(pairs[0]).toMatchObject({ outId: 'out', inId: 'in', amount: 500, gapDays: 1 });
    });

    it('does not pair legs inside the same account', () => {
        const rows = [
            tx('2026-03-01', -500, { id: 'a', accountId: 'same' }),
            tx('2026-03-01', 500, { id: 'b', accountId: 'same' })
        ];
        expect(detectInternalTransfers(rows).pairs).toHaveLength(0);
    });

    it('does not pair beyond the window', () => {
        const rows = [
            tx('2026-03-01', -500, { id: 'a', accountId: 'x' }),
            tx('2026-03-20', 500, { id: 'b', accountId: 'y' })
        ];
        expect(detectInternalTransfers(rows).pairs).toHaveLength(0);
    });

    it('matches nearest in time so a repeated standing transfer does not cross-pair', () => {
        const rows = [
            tx('2026-03-01', -500, { id: 'out1', accountId: 'x' }),
            tx('2026-03-01', 500, { id: 'in1', accountId: 'y' }),
            tx('2026-04-01', -500, { id: 'out2', accountId: 'x' }),
            tx('2026-04-01', 500, { id: 'in2', accountId: 'y' })
        ];
        const { pairs } = detectInternalTransfers(rows);
        expect(pairs).toHaveLength(2);
        for (const p of pairs) {
            expect(p.outId.slice(-1)).toBe(p.inId.slice(-1)); // out1↔in1, out2↔in2
        }
    });

    it('leaves the savings rate intact once transfers are excluded', () => {
        const rows = [
            tx('2026-03-01', 2000, { id: 'pay', accountId: 'x' }),
            tx('2026-03-02', -400, { id: 'food', accountId: 'x' }),
            tx('2026-03-05', -1000, { id: 'out', accountId: 'x' }),
            tx('2026-03-05', 1000, { id: 'in', accountId: 'y' })
        ];
        const { pairs } = detectInternalTransfers(rows);
        const flagged = new Set(pairs.flatMap(p => [p.outId, p.inId]));
        const marked = rows.map(r => (flagged.has(r.id) ? { ...r, category: 'transfer' } : r));
        const s = summarize(marked);
        expect(s.income).toBe(2000);
        expect(s.spend).toBe(400);
        expect(s.savingsRate).toBe(0.8);
    });
});

describe('detectRecurring', () => {
    const monthly = (merchant, amounts, startDay = '05') =>
        amounts.map((a, i) => tx(`2026-${String(i + 1).padStart(2, '0')}-${startDay}`, a, { merchant }));

    it('detects a monthly subscription and its annual cost', () => {
        const found = detectRecurring(monthly('Netflix', [-13.99, -13.99, -13.99, -13.99]));
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ cadenceDays: 30, cadenceLabel: 'monthly', occurrences: 4 });
        expect(found[0].annualEquivalent).toBeCloseTo(170.2, 0);
        expect(found[0].confidence).toBeGreaterThan(0.6);
    });

    it('needs at least three occurrences', () => {
        expect(detectRecurring(monthly('Spotify', [-10.99, -10.99]))).toHaveLength(0);
    });

    it('ignores a merchant charged wildly different amounts', () => {
        // Weekly groceries are a habit, not a subscription.
        expect(detectRecurring(monthly('Pingo Doce', [-15, -140, -62, -8]))).toHaveLength(0);
    });

    it('tolerates a small price rise', () => {
        expect(detectRecurring(monthly('Netflix', [-13.99, -13.99, -14.99, -14.99]))).toHaveLength(1);
    });

    it('ignores income and transfers', () => {
        const rows = [
            ...monthly('Salary', [3000, 3000, 3000]),
            ...monthly('Savings', [-500, -500, -500]).map(t => ({ ...t, category: 'transfer' }))
        ];
        expect(detectRecurring(rows)).toHaveLength(0);
    });

    it('flags a subscription that has stopped arriving rather than projecting it forever', () => {
        const found = detectRecurring(monthly('Netflix', [-13.99, -13.99, -13.99]), { today: '2026-08-01' });
        expect(found[0].likelyEnded).toBe(true);
    });

    it('normalises card reference numbers out of the merchant key', () => {
        expect(normalizeMerchantKey({ description: 'COMPRA 4321987654 NETFLIX.COM' }))
            .toBe(normalizeMerchantKey({ description: 'COMPRA 9999111122 NETFLIX.COM' }));
    });

    it('detects yearly and quarterly cadences', () => {
        const yearly = [tx('2024-03-01', -89), tx('2025-03-02', -89), tx('2026-03-01', -89)]
            .map(t => ({ ...t, merchant: 'Domain' }));
        expect(detectRecurring(yearly)[0].cadenceLabel).toBe('yearly');
    });
});

describe('baselineMonthly', () => {
    const rows = [
        tx('2026-01-05', 3000), tx('2026-01-06', -1000, { category: 'Dining' }),
        tx('2026-02-05', 3000), tx('2026-02-06', -2000, { category: 'Dining' }),
        tx('2026-03-05', 300),  tx('2026-03-06', -100, { category: 'Dining' })  // month in progress
    ];

    it('ignores the in-progress month, which would drag every average down', () => {
        const b = baselineMonthly(rows, { today: '2026-03-06' });
        expect(b.months).toBe(2);
        expect(b.periods).toEqual(['2026-01', '2026-02']);
        expect(b.monthlyIncome).toBe(3000);
        expect(b.monthlySpend).toBe(1500);
        expect(b.byCategory.Dining).toBe(1500);
    });

    it('returns a zeroed baseline rather than throwing when there is no complete month', () => {
        expect(baselineMonthly([tx('2026-03-05', -10)], { today: '2026-03-06' }))
            .toMatchObject({ months: 0, monthlyNet: 0, savingsRate: null });
    });
});

describe('projectScenario', () => {
    // €3000/mo income, €1000 Dining + €500 Transport spend → €1500/mo net.
    const history = ['2026-01', '2026-02', '2026-03'].flatMap(p => [
        tx(`${p}-05`, 3000, { category: 'Salary' }),
        tx(`${p}-10`, -1000, { category: 'Dining' }),
        tx(`${p}-15`, -500, { category: 'Transport' })
    ]);
    const opts = { today: '2026-04-02', incomeCategories: ['Salary'] };

    it('establishes the do-nothing baseline', () => {
        const r = projectScenario(history, { levers: [] }, opts);
        expect(r.baseline).toMatchObject({ monthlyIncome: 3000, monthlySpend: 1500, monthlyNet: 1500 });
        expect(r.annualDelta).toBe(0);
    });

    it('turns a percentage category cut into an annual saving', () => {
        const r = projectScenario(history, {
            levers: [{ type: 'category_delta', category: 'Dining', mode: 'percent', value: -30 }]
        }, opts);
        expect(r.monthlyDelta).toBe(300);
        expect(r.annualDelta).toBe(3600);
        expect(r.projected.monthlySpend).toBe(1200);
        expect(r.savingsRatePts).toBeCloseTo(0.1, 4);
    });

    it('cannot cut a category below zero', () => {
        const r = projectScenario(history, {
            levers: [{ type: 'category_delta', category: 'Dining', mode: 'absolute', value: -5000 }]
        }, opts);
        expect(r.monthlyDelta).toBe(1000);           // capped at the actual €1000, not €5000
        expect(r.byLever[0].note).toMatch(/capped/);
    });

    it('combines several levers', () => {
        const r = projectScenario(history, {
            levers: [
                { type: 'category_delta', category: 'Dining', mode: 'percent', value: -30 },
                { type: 'income_delta', mode: 'absolute', value: 400, cadence: 'monthly' }
            ]
        }, opts);
        expect(r.monthlyDelta).toBe(700);
        expect(r.projected.monthlyIncome).toBe(3400);
    });

    it('spreads an annual income change across the year', () => {
        const r = projectScenario(history, {
            levers: [{ type: 'income_delta', mode: 'absolute', value: 1200, cadence: 'annual' }]
        }, opts);
        expect(r.monthlyDelta).toBe(100);
    });

    it('converts a cancelled subscription to its monthly equivalent', () => {
        const withSub = [...history, ...['2026-01', '2026-02', '2026-03'].map(
            p => tx(`${p}-20`, -13.99, { merchant: 'Netflix', category: 'Subscriptions' })
        )];
        const recurring = detectRecurring(withSub);
        const r = projectScenario(withSub, {
            levers: [{ type: 'cancel_recurring', recurringId: recurring[0].key }]
        }, { ...opts, recurring });
        expect(r.monthlyDelta).toBeCloseTo(14.19, 1);
        expect(r.annualDelta).toBeGreaterThan(165);
    });

    it('applies a one-off in its month without changing the monthly run rate', () => {
        const r = projectScenario(history, {
            horizonMonths: 12,
            levers: [{ type: 'one_off', label: 'New car', amount: -18000, month: 4 }]
        }, opts);
        expect(r.monthlyDelta).toBe(0);
        expect(r.oneOffTotal).toBe(-18000);
        expect(r.horizonDelta).toBe(-18000);
        expect(r.series[2].delta).toBe(0);        // month 3, before the purchase
        expect(r.series[3].delta).toBe(-18000);   // month 4, after it
    });

    it('caps the horizon at 12 months, because further out the numbers stop being believable', () => {
        const r = projectScenario(history, { horizonMonths: 60, levers: [] }, opts);
        expect(r.horizonMonths).toBe(12);
        expect(r.series).toHaveLength(12);
    });

    it('marks a projection built on thin history', () => {
        const oneMonth = history.filter(t => t.date.startsWith('2026-01'));
        expect(projectScenario(oneMonth, { levers: [] }, opts).thin).toBe(true);
        expect(projectScenario(history, { levers: [] }, opts).thin).toBe(false);
    });

    it('ignores an unknown lever type instead of throwing', () => {
        const r = projectScenario(history, { levers: [{ type: 'teleport', value: 1 }] }, opts);
        expect(r.monthlyDelta).toBe(0);
        expect(r.byLever[0].note).toMatch(/unknown lever type/);
    });

    it('never mutates the transactions it was given', () => {
        const snapshot = JSON.stringify(history);
        projectScenario(history, { levers: [{ type: 'category_delta', category: 'Dining', mode: 'percent', value: -50 }] }, opts);
        expect(JSON.stringify(history)).toBe(snapshot);
    });
});

// ── period defaulting is in spend/ledger.js, but the rule it encodes matters
// enough to pin: a ledger whose newest row is months old must not present an
// empty "today" as if the import had failed.
describe('period defaulting rule', () => {
    const latestPeriodWithData = (transactions, todayKey, grain = 'month') => {
        if (!transactions.length) return todayKey;
        let latest = null;
        for (const t of transactions) {
            const k = periodKey(t.date, grain);
            if (k && (latest === null || k > latest)) latest = k;
        }
        return latest && latest < todayKey ? latest : todayKey;
    };

    it('lands on the newest month that has data, not on an empty today', () => {
        const rows = [tx('2026-07-10', -20), tx('2026-08-14', -30)];
        expect(latestPeriodWithData(rows, '2026-09')).toBe('2026-08');
    });

    it('stays on today when today already has data', () => {
        const rows = [tx('2026-08-14', -30), tx('2026-09-01', -5)];
        expect(latestPeriodWithData(rows, '2026-09')).toBe('2026-09');
    });

    it('never jumps forward past today, even with a future-dated row', () => {
        const rows = [tx('2026-08-14', -30), tx('2027-01-01', -5)];
        expect(latestPeriodWithData(rows, '2026-09')).toBe('2026-09');
    });

    it('falls back to today on an empty ledger', () => {
        expect(latestPeriodWithData([], '2026-09')).toBe('2026-09');
    });
});

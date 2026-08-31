import { describe, it, expect } from 'vitest';
import { buildCashFlows, xirr, xnpv, summarizeCashFlows, computeYearlyIncome, computeYearlyXirr } from '../services/returns-core.js';

describe('xnpv — net present value of dated flows', () => {
  it('returns 0 for empty or null flows', () => {
    expect(xnpv(0.1, [])).toBe(0);
    expect(xnpv(0.1, null)).toBe(0);
  });

  it('at rate=0 equals the undiscounted sum of all amounts', () => {
    const flows = [
      { date: '2021-01-01', amount: -1000 },
      { date: '2021-07-01', amount: 200 },
      { date: '2022-01-01', amount: 900 },
    ];
    expect(xnpv(0, flows)).toBeCloseTo(100, 6); // −1000 + 200 + 900
  });
});

describe('xirr — money-weighted annualized return', () => {
  it('returns exactly 10% for a 1-year 1000→1100 flow (365-day span)', () => {
    const rate = xirr([
      { date: '2021-01-01', amount: -1000 },
      { date: '2022-01-01', amount: 1100 },
    ]);
    expect(rate).toBeCloseTo(0.10, 4);
  });

  it('drives NPV to ~0 at the solved rate for irregular multi-flow input', () => {
    const flows = [
      { date: '2021-01-01', amount: -1000 },
      { date: '2021-07-01', amount: -500 },
      { date: '2021-10-15', amount: 40 },   // dividend
      { date: '2022-01-01', amount: 1650 }, // terminal value
    ];
    const rate = xirr(flows);
    expect(rate).not.toBeNull();
    expect(xnpv(rate, [...flows].sort((a, b) => new Date(a.date) - new Date(b.date)))).toBeCloseTo(0, 4);
  });

  it('handles a loss (negative return)', () => {
    const rate = xirr([
      { date: '2021-01-01', amount: -1000 },
      { date: '2022-01-01', amount: 800 },
    ]);
    expect(rate).toBeCloseTo(-0.20, 4);
  });

  it('returns null when all flows share one sign (no root)', () => {
    expect(xirr([
      { date: '2021-01-01', amount: -1000 },
      { date: '2022-01-01', amount: -500 },
    ])).toBeNull();
  });

  it('returns null with fewer than two non-zero flows', () => {
    expect(xirr([{ date: '2021-01-01', amount: -1000 }])).toBeNull();
    expect(xirr([])).toBeNull();
  });

  it('ignores zero-amount and dateless flows', () => {
    const rate = xirr([
      { date: '2021-01-01', amount: -1000 },
      { date: '2021-06-01', amount: 0 },
      { date: null, amount: 50 },
      { date: '2022-01-01', amount: 1100 },
    ]);
    expect(rate).toBeCloseTo(0.10, 4);
  });
});

describe('buildCashFlows — ledger → dated base-currency flows', () => {
  const rateOne = () => 1;
  const noCurrency = () => null;

  it('applies the sign convention across the taxonomy', () => {
    const txs = {
      AAPL: [
        { type: 'buy', date: '2021-01-01', totalAmount: 1000, fee: 5 },
        { type: 'sell', date: '2021-06-01', totalAmount: 400, fee: 2 },
        { type: 'dividend', date: '2021-09-01', totalAmount: 30, tax: 5 },
        { type: 'split', date: '2021-10-01', shares: 10 },
      ],
      CASH: [
        { type: 'fee', date: '2021-12-01', totalAmount: 12 },
      ],
    };
    const flows = buildCashFlows(txs, { rateFor: rateOne, currencyFor: noCurrency });
    const byType = Object.fromEntries(flows.map(f => [`${f.symbol}:${f.type}`, f.amount]));
    expect(byType['AAPL:buy']).toBe(-1005);      // -(1000 + 5)
    expect(byType['AAPL:sell']).toBe(398);       // +(400 - 2)
    expect(byType['AAPL:dividend']).toBe(25);    // +(30 - 5)
    expect(byType['CASH:fee']).toBe(-12);        // -(12)
    expect(byType['AAPL:split']).toBeUndefined();// no cash flow
    expect(flows).toHaveLength(4);
  });

  it('multiplies every flow by the injected FX rate', () => {
    const txs = { MSFT: [{ type: 'buy', date: '2021-01-01', totalAmount: 100, fee: 0 }] };
    const flows = buildCashFlows(txs, { rateFor: () => 0.9, currencyFor: () => 'USD' });
    expect(flows[0].amount).toBeCloseTo(-90, 6);
  });

  it('skips rows without a date and tolerates an empty ledger', () => {
    expect(buildCashFlows({}, { rateFor: rateOne })).toEqual([]);
    const flows = buildCashFlows(
      { X: [{ type: 'buy', totalAmount: 100 }] }, // no date
      { rateFor: rateOne, currencyFor: noCurrency },
    );
    expect(flows).toEqual([]);
  });
});

describe('computeYearlyXirr — per-calendar-year money-weighted return', () => {
  const rateOne = () => 1;
  const noCurrency = () => null;

  it('computes the current year from an opening snapshot and live close', () => {
    const txs = { AAPL: [{ type: 'buy', date: '2023-05-01', totalAmount: 1000, fee: 0 }] };
    const rows = computeYearlyXirr(txs, {
      rateFor: rateOne, currencyFor: noCurrency,
      boundaryValueFor: d => (d === '2024-01-01' ? 1000 : (d <= '2023-05-01' ? 0 : null)),
      currentValue: 1100,
      today: '2024-07-01',
    });
    const y2024 = rows.find(r => r.year === '2024');
    expect(y2024.insufficient).toBe(false);
    expect(y2024.openValue).toBe(1000);
    expect(y2024.closeValue).toBe(1100);
    // ~half a year of +10% → annualizes above 10%
    expect(y2024.rate).toBeGreaterThan(0.15);
    // NPV of the period flows is ~0 at the solved rate
    const period = [
      { date: '2024-01-01', amount: -1000 },
      { date: '2024-07-01', amount: 1100 },
    ];
    expect(xnpv(y2024.rate, period)).toBeCloseTo(0, 4);
  });

  it('treats the first year as opening at 0 (empty portfolio before first buy)', () => {
    const txs = { AAPL: [{ type: 'buy', date: '2022-03-01', totalAmount: 1000, fee: 0 }] };
    const rows = computeYearlyXirr(txs, {
      rateFor: rateOne, currencyFor: noCurrency,
      boundaryValueFor: d => {
        if (d <= '2022-03-01') return 0;         // empty before first buy
        if (d === '2023-01-01') return 1200;     // year-end 2022 value
        return null;
      },
      currentValue: 1300,
      today: '2023-06-01',
    });
    const y2022 = rows.find(r => r.year === '2022');
    expect(y2022.openValue).toBe(0);
    expect(y2022.closeValue).toBe(1200);
    expect(y2022.insufficient).toBe(false);
    expect(y2022.rate).toBeGreaterThan(0); // -1000 mid-year → +1200 year-end
  });

  it('marks a year insufficient when a boundary value is missing', () => {
    const txs = { AAPL: [{ type: 'buy', date: '2021-01-01', totalAmount: 1000, fee: 0 }] };
    const rows = computeYearlyXirr(txs, {
      rateFor: rateOne, currencyFor: noCurrency,
      boundaryValueFor: () => null,   // no snapshots at all
      currentValue: 1500,
      today: '2023-01-15',
    });
    const y2022 = rows.find(r => r.year === '2022');
    expect(y2022.insufficient).toBe(true);
    expect(y2022.rate).toBeNull();
    expect(y2022.reason).toMatch(/opening|closing/);
  });

  it('emits one row per year from first activity through today', () => {
    const txs = { AAPL: [{ type: 'buy', date: '2021-06-01', totalAmount: 1000, fee: 0 }] };
    const rows = computeYearlyXirr(txs, {
      rateFor: rateOne, currencyFor: noCurrency,
      boundaryValueFor: () => 1000,
      currentValue: 1000,
      today: '2024-03-01',
    });
    expect(rows.map(r => r.year)).toEqual(['2021', '2022', '2023', '2024']);
  });

  it('returns [] when the ledger has no dated flows', () => {
    expect(computeYearlyXirr({}, { rateFor: rateOne, currencyFor: noCurrency, currentValue: 0 })).toEqual([]);
  });

  it('null currentValue marks the current year insufficient', () => {
    const txs = { AAPL: [{ type: 'buy', date: '2023-01-15', totalAmount: 1000, fee: 0 }] };
    const rows = computeYearlyXirr(txs, {
      rateFor: rateOne, currencyFor: noCurrency,
      boundaryValueFor: () => 1000,
      currentValue: null,
      today: '2023-06-01',
    });
    const y2023 = rows.find(r => r.year === '2023');
    expect(y2023.insufficient).toBe(true);
    expect(y2023.closeValue).toBeNull();
    expect(y2023.rate).toBeNull();
  });
});

describe('computeYearlyIncome — dividend income & yield-on-cost by calendar year', () => {
  const rateOne = () => 1;
  const noCurrency = () => null;
  const deps = { rateFor: rateOne, currencyFor: noCurrency };

  it('buckets net dividends and tax by year and totals them', () => {
    const txs = {
      AAPL: [
        { type: 'buy', date: '2022-01-01', totalAmount: 1000, fee: 0 },
        { type: 'dividend', date: '2022-06-01', totalAmount: 30, tax: 5 },
        { type: 'dividend', date: '2022-09-01', totalAmount: 20, tax: 3 },
        { type: 'dividend', date: '2023-06-01', totalAmount: 60, tax: 9 },
      ],
    };
    const { years, totals } = computeYearlyIncome(txs, deps);
    expect(years.map(y => y.year)).toEqual(['2022', '2023']);
    const y22 = years[0], y23 = years[1];
    expect(y22.dividends).toBe(50);
    expect(y22.tax).toBe(8);
    expect(y22.netIncome).toBe(42);
    expect(y23.netIncome).toBe(51);
    expect(totals.dividends).toBe(110);
    expect(totals.tax).toBe(17);
    expect(totals.netIncome).toBe(93);
  });

  it('computes yield-on-cost against average invested capital at risk', () => {
    // €1000 invested at start of 2022, held all year → avg invested = 1000.
    const txs = {
      AAPL: [
        { type: 'buy', date: '2021-12-01', totalAmount: 1000, fee: 0 },
        { type: 'dividend', date: '2022-06-01', totalAmount: 50, tax: 0 },
      ],
    };
    const { years } = computeYearlyIncome(txs, deps);
    expect(years[0].investedStart).toBe(1000);
    expect(years[0].investedEnd).toBe(1000);
    expect(years[0].yieldOnCost).toBeCloseTo(0.05, 6); // 50 / 1000
  });

  it('reduces invested-at-risk by the cost basis of shares sold', () => {
    const txs = {
      AAPL: [
        { type: 'buy', date: '2021-01-01', totalAmount: 1000, fee: 0 },
        // sell half: proceeds 700, realized gain 200 → cost basis sold = 500
        { type: 'sell', date: '2021-06-01', totalAmount: 700, realizedGainLoss: 200, fee: 0 },
        { type: 'dividend', date: '2022-06-01', totalAmount: 25, tax: 0 },
      ],
    };
    const { years } = computeYearlyIncome(txs, deps);
    const y22 = years.find(y => y.year === '2022');
    expect(y22.investedStart).toBe(500);   // 1000 − 500 cost basis sold
    expect(y22.yieldOnCost).toBeCloseTo(0.05, 6); // 25 / 500
  });

  it('yields null (not Infinity) when average invested capital is zero', () => {
    const txs = {
      AAPL: [
        { type: 'buy', date: '2022-01-10', totalAmount: 1000, fee: 0 },
        { type: 'sell', date: '2022-02-10', totalAmount: 1100, realizedGainLoss: 100, fee: 0 },
        { type: 'dividend', date: '2022-01-20', totalAmount: 10, tax: 0 },
      ],
    };
    // bought and fully sold within 2022 → start=0, end=0 → avg=0
    const { years } = computeYearlyIncome(txs, deps);
    expect(years[0].yieldOnCost).toBeNull();
  });

  it('buckets standalone fees and per-trade fees by year', () => {
    const txs = {
      AAPL: [{ type: 'buy', date: '2022-03-01', totalAmount: 1000, fee: 2 }],
      CASH: [{ type: 'fee', date: '2022-12-01', totalAmount: 12 }],
    };
    const { years, totals } = computeYearlyIncome(txs, deps);
    expect(years[0].fees).toBe(14); // 2 (trade) + 12 (custody)
    expect(totals.fees).toBe(14);
  });

  it('isin_change does not update capital events (no cost-basis change)', () => {
    const txs = {
      OLDCO: [
        { type: 'buy', date: '2021-06-01', totalAmount: 1000, fee: 0 },
        { type: 'isin_change', date: '2021-12-01', shares: 10, note: 'rename' },
      ],
      NEWCO: [
        { type: 'dividend', date: '2022-06-01', totalAmount: 50, tax: 0 },
      ],
    };
    const { years } = computeYearlyIncome(txs, deps);
    const y22 = years.find(y => y.year === '2022');
    expect(y22.investedStart).toBe(1000);
    expect(y22.investedEnd).toBe(1000);
  });

  it('aggregates dividends from two symbols in the same year into a single bucket', () => {
    const txs = {
      AAPL: [
        { type: 'buy', date: '2022-01-01', totalAmount: 1000, fee: 0 },
        { type: 'dividend', date: '2022-06-01', totalAmount: 40, tax: 4 },
      ],
      MSFT: [
        { type: 'buy', date: '2022-01-01', totalAmount: 2000, fee: 0 },
        { type: 'dividend', date: '2022-09-01', totalAmount: 60, tax: 9 },
      ],
    };
    const { years, totals } = computeYearlyIncome(txs, deps);
    expect(years).toHaveLength(1);
    const y22 = years[0];
    expect(y22.dividends).toBe(100);
    expect(y22.tax).toBe(13);
    expect(y22.netIncome).toBe(87);
    expect(totals.dividends).toBe(100);
  });

  it('applies the injected FX rate and ignores malformed dates', () => {
    const txs = {
      MSFT: [
        { type: 'dividend', date: '2022-06-01', totalAmount: 100, tax: 10 },
        { type: 'dividend', date: 'not-a-date', totalAmount: 999, tax: 0 },
      ],
    };
    const { years } = computeYearlyIncome(txs, { rateFor: () => 0.9, currencyFor: () => 'USD' });
    expect(years).toHaveLength(1);
    expect(years[0].netIncome).toBeCloseTo(81, 6); // (100 − 10) × 0.9
  });
});

describe('summarizeCashFlows', () => {
  it('splits deployed vs returned cash and finds the earliest date', () => {
    const s = summarizeCashFlows([
      { date: '2021-06-01', amount: -500 },
      { date: '2021-01-01', amount: -1000 },
      { date: '2021-09-01', amount: 40 },
      { date: '2022-01-01', amount: 300 },
    ]);
    expect(s.capitalIn).toBe(1500);
    expect(s.cashReturned).toBe(340);
    expect(s.firstDate).toBe('2021-01-01');
    expect(s.count).toBe(4);
  });
});

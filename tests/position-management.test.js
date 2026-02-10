import { describe, it, expect } from 'vitest';
import {
  addPosition,
  buyMoreShares,
  sellShares,
  removePosition,
  partitionPositions,
  recordTransaction,
  collectSalesHistory,
  calculateTotalRealizedPnL,
} from '../src/portfolio.js';

// ── Test Data ────────────────────────────────────────────────────────────────

const emptyPortfolio = [];

const samplePortfolio = [
  { name: 'Apple Inc', symbol: 'AAPL', platform: 'Fidelity', type: 'Stock', shares: 100, avgPrice: 150 },
  { name: 'Tesla Inc', symbol: 'TSLA', platform: 'Schwab', type: 'Stock', shares: 50, avgPrice: 200 },
];

const portfolioWithClosed = [
  { name: 'Apple Inc', symbol: 'AAPL', platform: 'Fidelity', type: 'Stock', shares: 100, avgPrice: 150 },
  { name: 'GameStop', symbol: 'GME', platform: 'Robinhood', type: 'Stock', shares: 0, avgPrice: 40 },
  { name: 'Tesla Inc', symbol: 'TSLA', platform: 'Schwab', type: 'Stock', shares: 50, avgPrice: 200 },
];

// ── addPosition ──────────────────────────────────────────────────────────────

describe('addPosition', () => {
  it('adds a new position to empty portfolio', () => {
    const result = addPosition(emptyPortfolio, {
      symbol: 'AAPL', name: 'Apple Inc', type: 'Stock', platform: 'Fidelity',
      shares: 10, totalAmount: 1500, date: '2024-01-15',
    });

    expect(result.portfolio).toHaveLength(1);
    expect(result.portfolio[0].symbol).toBe('AAPL');
    expect(result.portfolio[0].shares).toBe(10);
    expect(result.portfolio[0].avgPrice).toBe(150);
    expect(result.transaction).not.toBeNull();
    expect(result.transaction.type).toBe('buy');
    expect(result.transaction.price).toBe(150);
    expect(result.error).toBeUndefined();
  });

  it('adds a position to existing portfolio without mutating original', () => {
    const original = [...samplePortfolio];
    const result = addPosition(samplePortfolio, {
      symbol: 'GOOGL', name: 'Alphabet', shares: 5, totalAmount: 700, date: '2024-02-01',
    });

    expect(result.portfolio).toHaveLength(3);
    expect(samplePortfolio).toHaveLength(2); // original unchanged
    expect(result.portfolio[2].symbol).toBe('GOOGL');
    expect(result.portfolio[2].avgPrice).toBe(140);
  });

  it('rejects adding a position that already has active shares', () => {
    const result = addPosition(samplePortfolio, {
      symbol: 'AAPL', shares: 5, totalAmount: 750, date: '2024-03-01',
    });

    expect(result.error).toContain('already exists');
    expect(result.transaction).toBeNull();
    expect(result.portfolio).toBe(samplePortfolio); // unchanged reference
  });

  it('reactivates a closed position (shares=0)', () => {
    const result = addPosition(portfolioWithClosed, {
      symbol: 'GME', name: 'GameStop Corp', shares: 20, totalAmount: 1000, date: '2024-04-01',
    });

    expect(result.error).toBeUndefined();
    expect(result.portfolio).toHaveLength(3);
    const gme = result.portfolio.find(p => p.symbol === 'GME');
    expect(gme.shares).toBe(20);
    expect(gme.avgPrice).toBe(50); // 1000 / 20
    expect(gme.name).toBe('GameStop Corp');
  });

  it('defaults platform and type when not provided', () => {
    const result = addPosition(emptyPortfolio, {
      symbol: 'XYZ', shares: 10, totalAmount: 500, date: '2024-05-01',
    });

    expect(result.portfolio[0].platform).toBe('Unknown');
    expect(result.portfolio[0].type).toBe('Stock');
    expect(result.portfolio[0].name).toBe('XYZ');
  });

  it('calculates correct price per share with fractional amounts', () => {
    const result = addPosition(emptyPortfolio, {
      symbol: 'BTC', name: 'Bitcoin', type: 'Crypto',
      shares: 0.5, totalAmount: 25000, date: '2024-06-01',
    });

    expect(result.portfolio[0].avgPrice).toBe(50000);
    expect(result.transaction.price).toBe(50000);
  });

  it('records transaction with correct date and totalAmount', () => {
    const result = addPosition(emptyPortfolio, {
      symbol: 'MSFT', shares: 20, totalAmount: 7000, date: '2024-07-15',
    });

    expect(result.transaction.date).toBe('2024-07-15');
    expect(result.transaction.totalAmount).toBe(7000);
    expect(result.transaction.shares).toBe(20);
  });
});

// ── buyMoreShares ────────────────────────────────────────────────────────────

describe('buyMoreShares', () => {
  it('adds shares and recalculates weighted average price', () => {
    // Existing: 100 shares @ $150 = $15,000
    // Adding: 50 shares @ $200 = $10,000 (totalAmount)
    // New: 150 shares, avg = (15000 + 10000) / 150 = $166.67
    const result = buyMoreShares(samplePortfolio, 'AAPL', 50, 10000, '2024-02-01');

    const aapl = result.portfolio.find(p => p.symbol === 'AAPL');
    expect(aapl.shares).toBe(150);
    expect(aapl.avgPrice).toBeCloseTo(166.67, 1);
    expect(result.transaction.type).toBe('buy');
    expect(result.transaction.shares).toBe(50);
    expect(result.transaction.price).toBe(200);
  });

  it('does not mutate original portfolio', () => {
    const originalShares = samplePortfolio[0].shares;
    buyMoreShares(samplePortfolio, 'AAPL', 50, 10000, '2024-02-01');
    expect(samplePortfolio[0].shares).toBe(originalShares);
  });

  it('returns error for non-existent position', () => {
    const result = buyMoreShares(samplePortfolio, 'NOPE', 10, 500, '2024-03-01');

    expect(result.error).toContain('not found');
    expect(result.transaction).toBeNull();
  });

  it('handles buying at a lower price (averages down)', () => {
    // Existing: 100 @ $150 = $15,000
    // Adding: 100 @ $100 = $10,000
    // New: 200 shares, avg = $25,000 / 200 = $125
    const result = buyMoreShares(samplePortfolio, 'AAPL', 100, 10000, '2024-04-01');

    const aapl = result.portfolio.find(p => p.symbol === 'AAPL');
    expect(aapl.shares).toBe(200);
    expect(aapl.avgPrice).toBe(125);
  });

  it('handles buying at the same price (no avg change)', () => {
    // 100 @ $150 + 100 @ $150 = 200 @ $150
    const result = buyMoreShares(samplePortfolio, 'AAPL', 100, 15000, '2024-05-01');

    const aapl = result.portfolio.find(p => p.symbol === 'AAPL');
    expect(aapl.avgPrice).toBe(150);
  });

  it('leaves other positions unchanged', () => {
    const result = buyMoreShares(samplePortfolio, 'AAPL', 50, 10000, '2024-06-01');

    const tsla = result.portfolio.find(p => p.symbol === 'TSLA');
    expect(tsla.shares).toBe(50);
    expect(tsla.avgPrice).toBe(200);
  });
});

// ── sellShares ───────────────────────────────────────────────────────────────

describe('sellShares', () => {
  it('sells partial shares and records realized gain', () => {
    // Sell 30 shares of AAPL (cost basis $150) at $180 each = $5,400
    // Realized gain: (180 - 150) * 30 = $900
    const result = sellShares(samplePortfolio, 'AAPL', 30, 5400, '2024-03-01');

    const aapl = result.portfolio.find(p => p.symbol === 'AAPL');
    expect(aapl.shares).toBe(70);
    expect(aapl.avgPrice).toBe(150); // avgPrice unchanged after sell
    expect(result.transaction.type).toBe('sell');
    expect(result.transaction.costBasis).toBe(150);
    expect(result.transaction.realizedGainLoss).toBe(900);
    expect(result.transaction.price).toBe(180);
  });

  it('sells all shares making position inactive', () => {
    const result = sellShares(samplePortfolio, 'AAPL', 100, 17000, '2024-04-01');

    const aapl = result.portfolio.find(p => p.symbol === 'AAPL');
    expect(aapl.shares).toBe(0);
    expect(result.transaction.realizedGainLoss).toBe((170 - 150) * 100); // 2000
  });

  it('records realized loss when selling below cost', () => {
    // Sell 20 TSLA (cost $200) at $150 = $3000
    // Realized loss: (150 - 200) * 20 = -$1000
    const result = sellShares(samplePortfolio, 'TSLA', 20, 3000, '2024-05-01');

    expect(result.transaction.realizedGainLoss).toBe(-1000);
    expect(result.transaction.costBasis).toBe(200);
    const tsla = result.portfolio.find(p => p.symbol === 'TSLA');
    expect(tsla.shares).toBe(30);
  });

  it('rejects selling more shares than owned', () => {
    const result = sellShares(samplePortfolio, 'AAPL', 150, 22500, '2024-06-01');

    expect(result.error).toContain('Cannot sell 150');
    expect(result.error).toContain('only have 100');
    expect(result.transaction).toBeNull();
  });

  it('rejects selling from non-existent position', () => {
    const result = sellShares(samplePortfolio, 'NOPE', 10, 500, '2024-07-01');

    expect(result.error).toContain('not found');
    expect(result.transaction).toBeNull();
  });

  it('does not mutate original portfolio', () => {
    const originalShares = samplePortfolio[0].shares;
    sellShares(samplePortfolio, 'AAPL', 10, 1700, '2024-08-01');
    expect(samplePortfolio[0].shares).toBe(originalShares);
  });

  it('handles selling at exactly cost basis (zero P&L)', () => {
    // Sell 10 @ $150 (cost $150) = break even
    const result = sellShares(samplePortfolio, 'AAPL', 10, 1500, '2024-09-01');

    expect(result.transaction.realizedGainLoss).toBe(0);
  });
});

// ── removePosition ───────────────────────────────────────────────────────────

describe('removePosition', () => {
  it('removes an existing position', () => {
    const result = removePosition(samplePortfolio, 'AAPL');

    expect(result.portfolio).toHaveLength(1);
    expect(result.portfolio[0].symbol).toBe('TSLA');
    expect(result.removed).toBe(true);
  });

  it('returns unchanged portfolio for non-existent symbol', () => {
    const result = removePosition(samplePortfolio, 'NOPE');

    expect(result.portfolio).toHaveLength(2);
    expect(result.removed).toBe(false);
  });

  it('does not mutate original portfolio', () => {
    removePosition(samplePortfolio, 'AAPL');
    expect(samplePortfolio).toHaveLength(2);
  });

  it('can remove a closed position', () => {
    const result = removePosition(portfolioWithClosed, 'GME');

    expect(result.portfolio).toHaveLength(2);
    expect(result.removed).toBe(true);
    expect(result.portfolio.find(p => p.symbol === 'GME')).toBeUndefined();
  });

  it('handles empty portfolio', () => {
    const result = removePosition([], 'AAPL');

    expect(result.portfolio).toHaveLength(0);
    expect(result.removed).toBe(false);
  });
});

// ── partitionPositions ───────────────────────────────────────────────────────

describe('partitionPositions', () => {
  it('separates active and inactive positions', () => {
    const { active, inactive } = partitionPositions(portfolioWithClosed);

    expect(active).toHaveLength(2);
    expect(inactive).toHaveLength(1);
    expect(inactive[0].symbol).toBe('GME');
  });

  it('returns all active when none are closed', () => {
    const { active, inactive } = partitionPositions(samplePortfolio);

    expect(active).toHaveLength(2);
    expect(inactive).toHaveLength(0);
  });

  it('returns all inactive when all are closed', () => {
    const allClosed = [
      { symbol: 'A', shares: 0, avgPrice: 10 },
      { symbol: 'B', shares: 0, avgPrice: 20 },
    ];
    const { active, inactive } = partitionPositions(allClosed);

    expect(active).toHaveLength(0);
    expect(inactive).toHaveLength(2);
  });

  it('handles empty portfolio', () => {
    const { active, inactive } = partitionPositions([]);

    expect(active).toHaveLength(0);
    expect(inactive).toHaveLength(0);
  });
});

// ── recordTransaction ────────────────────────────────────────────────────────

describe('recordTransaction', () => {
  it('records first transaction for a symbol', () => {
    const tx = { type: 'buy', shares: 10, price: 100, date: '2024-01-01', totalAmount: 1000 };
    const result = recordTransaction({}, 'AAPL', tx);

    expect(result.AAPL).toHaveLength(1);
    expect(result.AAPL[0]).toEqual(tx);
  });

  it('appends to existing transactions', () => {
    const existing = { AAPL: [{ type: 'buy', shares: 10, price: 100 }] };
    const newTx = { type: 'sell', shares: 5, price: 120 };
    const result = recordTransaction(existing, 'AAPL', newTx);

    expect(result.AAPL).toHaveLength(2);
    expect(result.AAPL[1]).toEqual(newTx);
  });

  it('does not mutate original transactions object', () => {
    const original = { AAPL: [{ type: 'buy', shares: 10, price: 100 }] };
    recordTransaction(original, 'AAPL', { type: 'sell', shares: 5, price: 120 });

    expect(original.AAPL).toHaveLength(1);
  });

  it('handles multiple symbols independently', () => {
    let txs = {};
    txs = recordTransaction(txs, 'AAPL', { type: 'buy', shares: 10 });
    txs = recordTransaction(txs, 'TSLA', { type: 'buy', shares: 5 });
    txs = recordTransaction(txs, 'AAPL', { type: 'sell', shares: 3 });

    expect(txs.AAPL).toHaveLength(2);
    expect(txs.TSLA).toHaveLength(1);
  });
});

// ── collectSalesHistory ──────────────────────────────────────────────────────

describe('collectSalesHistory', () => {
  it('collects sell transactions across symbols sorted by date descending', () => {
    const transactions = {
      AAPL: [
        { type: 'buy', shares: 100, price: 150, date: '2024-01-01' },
        { type: 'sell', shares: 30, price: 180, date: '2024-03-15', costBasis: 150, realizedGainLoss: 900 },
      ],
      TSLA: [
        { type: 'buy', shares: 50, price: 200, date: '2024-02-01' },
        { type: 'sell', shares: 20, price: 250, date: '2024-04-01', costBasis: 200, realizedGainLoss: 1000 },
      ],
    };

    const sales = collectSalesHistory(transactions);

    expect(sales).toHaveLength(2);
    expect(sales[0].symbol).toBe('TSLA'); // Apr is more recent than Mar
    expect(sales[0].date).toBe('2024-04-01');
    expect(sales[1].symbol).toBe('AAPL');
    expect(sales[1].date).toBe('2024-03-15');
  });

  it('returns empty array when no sell transactions exist', () => {
    const transactions = {
      AAPL: [{ type: 'buy', shares: 100, date: '2024-01-01' }],
    };

    expect(collectSalesHistory(transactions)).toHaveLength(0);
  });

  it('returns empty array for empty transactions', () => {
    expect(collectSalesHistory({})).toHaveLength(0);
  });

  it('includes symbol field on each sale', () => {
    const transactions = {
      GOOGL: [
        { type: 'sell', shares: 5, price: 140, date: '2024-06-01', costBasis: 120, realizedGainLoss: 100 },
      ],
    };

    const sales = collectSalesHistory(transactions);
    expect(sales[0].symbol).toBe('GOOGL');
    expect(sales[0].realizedGainLoss).toBe(100);
  });

  it('ignores buy transactions', () => {
    const transactions = {
      AAPL: [
        { type: 'buy', shares: 100, date: '2024-01-01' },
        { type: 'buy', shares: 50, date: '2024-02-01' },
        { type: 'sell', shares: 10, price: 160, date: '2024-03-01', costBasis: 150, realizedGainLoss: 100 },
      ],
    };

    const sales = collectSalesHistory(transactions);
    expect(sales).toHaveLength(1);
    expect(sales[0].type).toBe('sell');
  });
});

// ── calculateTotalRealizedPnL ────────────────────────────────────────────────

describe('calculateTotalRealizedPnL', () => {
  it('sums realized gains', () => {
    const sales = [
      { realizedGainLoss: 500 },
      { realizedGainLoss: 300 },
    ];
    expect(calculateTotalRealizedPnL(sales)).toBe(800);
  });

  it('sums mix of gains and losses', () => {
    const sales = [
      { realizedGainLoss: 500 },
      { realizedGainLoss: -200 },
      { realizedGainLoss: 100 },
    ];
    expect(calculateTotalRealizedPnL(sales)).toBe(400);
  });

  it('returns 0 for empty sales', () => {
    expect(calculateTotalRealizedPnL([])).toBe(0);
  });

  it('handles sales without realizedGainLoss field', () => {
    const sales = [
      { realizedGainLoss: 500 },
      { shares: 10, price: 100 }, // missing realizedGainLoss
    ];
    expect(calculateTotalRealizedPnL(sales)).toBe(500);
  });

  it('handles net loss', () => {
    const sales = [
      { realizedGainLoss: -1000 },
      { realizedGainLoss: 200 },
    ];
    expect(calculateTotalRealizedPnL(sales)).toBe(-800);
  });
});

// ── Integration: full lifecycle ──────────────────────────────────────────────

describe('Position lifecycle (add → buy → sell → close → reopen)', () => {
  it('handles a complete position lifecycle', () => {
    let portfolio = [];
    let transactions = {};

    // 1. Add initial position: 100 AAPL @ $150
    let result = addPosition(portfolio, {
      symbol: 'AAPL', name: 'Apple Inc', shares: 100, totalAmount: 15000, date: '2024-01-01',
    });
    portfolio = result.portfolio;
    transactions = recordTransaction(transactions, 'AAPL', result.transaction);

    expect(portfolio).toHaveLength(1);
    expect(portfolio[0].shares).toBe(100);
    expect(portfolio[0].avgPrice).toBe(150);

    // 2. Buy 50 more @ $200 = $10,000
    result = buyMoreShares(portfolio, 'AAPL', 50, 10000, '2024-02-01');
    portfolio = result.portfolio;
    transactions = recordTransaction(transactions, 'AAPL', result.transaction);

    expect(portfolio[0].shares).toBe(150);
    expect(portfolio[0].avgPrice).toBeCloseTo(166.67, 1); // 25000/150

    // 3. Sell 50 shares @ $190 = $9,500
    // Realized P&L: (190 - 166.67) * 50 = $1166.67
    result = sellShares(portfolio, 'AAPL', 50, 9500, '2024-03-01');
    portfolio = result.portfolio;
    transactions = recordTransaction(transactions, 'AAPL', result.transaction);

    expect(portfolio[0].shares).toBe(100);
    expect(result.transaction.costBasis).toBeCloseTo(166.67, 1);
    expect(result.transaction.realizedGainLoss).toBeCloseTo(1166.67, 0);

    // 4. Sell remaining 100 shares @ $180 = $18,000
    result = sellShares(portfolio, 'AAPL', 100, 18000, '2024-04-01');
    portfolio = result.portfolio;
    transactions = recordTransaction(transactions, 'AAPL', result.transaction);

    expect(portfolio[0].shares).toBe(0); // closed

    // 5. Verify partition
    const { active, inactive } = partitionPositions(portfolio);
    expect(active).toHaveLength(0);
    expect(inactive).toHaveLength(1);

    // 6. Verify sales history
    const sales = collectSalesHistory(transactions);
    expect(sales).toHaveLength(2);
    const totalPnL = calculateTotalRealizedPnL(sales);
    expect(totalPnL).toBeGreaterThan(0);

    // 7. Reopen the position
    result = addPosition(portfolio, {
      symbol: 'AAPL', shares: 25, totalAmount: 4500, date: '2024-05-01',
    });
    portfolio = result.portfolio;

    expect(portfolio[0].shares).toBe(25);
    expect(portfolio[0].avgPrice).toBe(180); // 4500/25
    const { active: active2 } = partitionPositions(portfolio);
    expect(active2).toHaveLength(1);
  });
});

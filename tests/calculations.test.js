import { describe, it, expect } from 'vitest';
import { calculatePortfolioTotals, calculatePositionGainLoss } from '../src/portfolio.js';

describe('calculatePortfolioTotals', () => {
  it('calculates totals with all prices available', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150 },
      { symbol: 'TSLA', shares: 50, avgPrice: 200 },
    ];
    const marketPrices = { AAPL: 170, TSLA: 220 };
    const result = calculatePortfolioTotals(portfolio, marketPrices);

    expect(result.totalInvested).toBe(100 * 150 + 50 * 200); // 25000
    expect(result.totalMarketValue).toBe(100 * 170 + 50 * 220); // 28000
    expect(result.positionsWithPrices).toBe(2);
    expect(result.gainLoss).toBe(28000 - 25000); // 3000
    expect(result.gainLossPct).toBeCloseTo((3000 / 25000) * 100); // 12%
  });

  it('falls back to cost basis when no market prices are available', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150 },
    ];
    const result = calculatePortfolioTotals(portfolio, {});

    expect(result.totalInvested).toBe(15000);
    expect(result.totalMarketValue).toBe(15000);
    expect(result.positionsWithPrices).toBe(0);
    expect(result.gainLoss).toBe(0);
    expect(result.gainLossPct).toBe(0);
  });

  it('mixes positions with and without prices', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150 },
      { symbol: 'XYZ', shares: 10, avgPrice: 50 },
    ];
    const marketPrices = { AAPL: 170 };
    const result = calculatePortfolioTotals(portfolio, marketPrices);

    // AAPL: 100*170 = 17000, XYZ: uses cost basis 10*50 = 500
    expect(result.totalInvested).toBe(15000 + 500);
    expect(result.totalMarketValue).toBe(17000 + 500);
    expect(result.positionsWithPrices).toBe(1);
    expect(result.gainLoss).toBe(17500 - 15500);
  });

  it('handles a losing portfolio', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 200 },
    ];
    const marketPrices = { AAPL: 150 };
    const result = calculatePortfolioTotals(portfolio, marketPrices);

    expect(result.gainLoss).toBe(-5000);
    expect(result.gainLossPct).toBeCloseTo(-25);
  });

  it('handles empty portfolio', () => {
    const result = calculatePortfolioTotals([], {});
    expect(result.totalInvested).toBe(0);
    expect(result.totalMarketValue).toBe(0);
    expect(result.gainLoss).toBe(0);
    expect(result.gainLossPct).toBe(0);
  });

  it('defaults marketPrices to empty object', () => {
    const portfolio = [{ symbol: 'AAPL', shares: 10, avgPrice: 100 }];
    const result = calculatePortfolioTotals(portfolio);
    expect(result.totalMarketValue).toBe(1000);
    expect(result.positionsWithPrices).toBe(0);
  });

  it('handles fractional shares', () => {
    const portfolio = [{ symbol: 'BTC', shares: 0.5, avgPrice: 50000 }];
    const marketPrices = { BTC: 60000 };
    const result = calculatePortfolioTotals(portfolio, marketPrices);

    expect(result.totalInvested).toBe(25000);
    expect(result.totalMarketValue).toBe(30000);
    expect(result.gainLoss).toBe(5000);
  });

  it('handles multiple positions of the same symbol', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 50, avgPrice: 140 },
      { symbol: 'AAPL', shares: 50, avgPrice: 160 },
    ];
    const marketPrices = { AAPL: 170 };
    const result = calculatePortfolioTotals(portfolio, marketPrices);

    expect(result.totalInvested).toBe(50 * 140 + 50 * 160); // 15000
    expect(result.totalMarketValue).toBe(100 * 170); // 17000
    expect(result.positionsWithPrices).toBe(2);
  });
});

describe('calculatePositionGainLoss', () => {
  it('calculates gain for a profitable position', () => {
    const pos = { symbol: 'AAPL', shares: 100, avgPrice: 150 };
    const result = calculatePositionGainLoss(pos, 170);

    expect(result.invested).toBe(15000);
    expect(result.marketValue).toBe(17000);
    expect(result.gainLoss).toBe(2000);
    expect(result.gainLossPct).toBeCloseTo(13.33, 1);
    expect(result.hasPrice).toBe(true);
  });

  it('calculates loss for a losing position', () => {
    const pos = { symbol: 'TSLA', shares: 50, avgPrice: 300 };
    const result = calculatePositionGainLoss(pos, 250);

    expect(result.invested).toBe(15000);
    expect(result.marketValue).toBe(12500);
    expect(result.gainLoss).toBe(-2500);
    expect(result.gainLossPct).toBeCloseTo(-16.67, 1);
    expect(result.hasPrice).toBe(true);
  });

  it('returns zero gain/loss when no current price', () => {
    const pos = { symbol: 'XYZ', shares: 10, avgPrice: 100 };
    const result = calculatePositionGainLoss(pos, undefined);

    expect(result.invested).toBe(1000);
    expect(result.marketValue).toBe(1000);
    expect(result.gainLoss).toBe(0);
    expect(result.gainLossPct).toBe(0);
    expect(result.hasPrice).toBe(false);
  });

  it('handles zero invested (avgPrice = 0)', () => {
    const pos = { symbol: 'FREE', shares: 100, avgPrice: 0 };
    const result = calculatePositionGainLoss(pos, 10);

    expect(result.invested).toBe(0);
    expect(result.marketValue).toBe(1000);
    expect(result.gainLoss).toBe(1000);
    // gainLossPct: invested is 0, so (1000/0)*100 → division by zero → Infinity
    // The function returns 0 when invested is 0
    expect(result.gainLossPct).toBe(0);
  });

  it('handles current price of 0', () => {
    const pos = { symbol: 'DEAD', shares: 100, avgPrice: 50 };
    // currentPrice=0 is falsy but not undefined — the code checks !== undefined
    const result = calculatePositionGainLoss(pos, 0);

    expect(result.hasPrice).toBe(true);
    expect(result.marketValue).toBe(0);
    expect(result.gainLoss).toBe(-5000);
    expect(result.gainLossPct).toBe(-100);
  });
});

import { describe, it, expect } from 'vitest';
import {
  calculatePositionWeight,
  calculatePortfolioWeights,
  aggregateByType,
} from '../src/portfolio.js';

describe('calculatePositionWeight', () => {
  it('calculates weight as percentage of total', () => {
    expect(calculatePositionWeight(1000, 10000)).toBe(10);
    expect(calculatePositionWeight(5000, 10000)).toBe(50);
    expect(calculatePositionWeight(10000, 10000)).toBe(100);
  });

  it('returns 0 when total is 0', () => {
    expect(calculatePositionWeight(1000, 0)).toBe(0);
  });

  it('returns 0 when total is negative', () => {
    expect(calculatePositionWeight(1000, -100)).toBe(0);
  });

  it('handles small fractions', () => {
    const weight = calculatePositionWeight(1, 10000);
    expect(weight).toBeCloseTo(0.01);
  });
});

describe('calculatePortfolioWeights', () => {
  it('calculates weights for all positions with market prices', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150 },
      { symbol: 'TSLA', shares: 50, avgPrice: 200 },
    ];
    const marketPrices = { AAPL: 170, TSLA: 220 };
    const result = calculatePortfolioWeights(portfolio, marketPrices);

    // AAPL: 100*170 = 17000, TSLA: 50*220 = 11000, total = 28000
    expect(result).toHaveLength(2);
    expect(result[0].symbol).toBe('AAPL');
    expect(result[0].marketValue).toBe(17000);
    expect(result[0].weight).toBeCloseTo((17000 / 28000) * 100);

    expect(result[1].symbol).toBe('TSLA');
    expect(result[1].marketValue).toBe(11000);
    expect(result[1].weight).toBeCloseTo((11000 / 28000) * 100);
  });

  it('falls back to cost basis when no market prices', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150 },
      { symbol: 'TSLA', shares: 50, avgPrice: 200 },
    ];
    const result = calculatePortfolioWeights(portfolio, {});

    // AAPL: 100*150 = 15000, TSLA: 50*200 = 10000, total = 25000
    expect(result[0].marketValue).toBe(15000);
    expect(result[0].weight).toBeCloseTo(60);
    expect(result[1].marketValue).toBe(10000);
    expect(result[1].weight).toBeCloseTo(40);
  });

  it('handles mixed positions with and without prices', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150 },
      { symbol: 'XYZ', shares: 10, avgPrice: 50 },
    ];
    const marketPrices = { AAPL: 170 };
    const result = calculatePortfolioWeights(portfolio, marketPrices);

    // AAPL: 100*170 = 17000, XYZ: 10*50 = 500, total = 17500
    expect(result[0].marketValue).toBe(17000);
    expect(result[1].marketValue).toBe(500);
    expect(result[0].weight + result[1].weight).toBeCloseTo(100);
  });

  it('handles empty portfolio', () => {
    const result = calculatePortfolioWeights([], {});
    expect(result).toHaveLength(0);
  });

  it('handles single position as 100% weight', () => {
    const portfolio = [{ symbol: 'AAPL', shares: 100, avgPrice: 150 }];
    const result = calculatePortfolioWeights(portfolio, {});
    expect(result[0].weight).toBe(100);
  });
});

describe('aggregateByType', () => {
  it('aggregates positions by type', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150, type: 'Stock' },
      { symbol: 'TSLA', shares: 50, avgPrice: 200, type: 'Stock' },
      { symbol: 'BTC', shares: 1, avgPrice: 50000, type: 'Crypto' },
    ];
    const result = aggregateByType(portfolio, {});

    // Stock: 15000 + 10000 = 25000, Crypto: 50000, total = 75000
    expect(result.totalMarketValue).toBe(75000);
    expect(result.allocations).toHaveLength(2);

    // Sorted by value descending
    expect(result.allocations[0].type).toBe('Crypto');
    expect(result.allocations[0].value).toBe(50000);
    expect(result.allocations[0].weight).toBeCloseTo((50000 / 75000) * 100);

    expect(result.allocations[1].type).toBe('Stock');
    expect(result.allocations[1].value).toBe(25000);
    expect(result.allocations[1].weight).toBeCloseTo((25000 / 75000) * 100);
  });

  it('uses market prices when available', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150, type: 'Stock' },
      { symbol: 'SPY', shares: 50, avgPrice: 400, type: 'ETF' },
    ];
    const marketPrices = { AAPL: 170, SPY: 450 };
    const result = aggregateByType(portfolio, marketPrices);

    // Stock: 100*170 = 17000, ETF: 50*450 = 22500, total = 39500
    expect(result.totalMarketValue).toBe(39500);
    expect(result.allocations[0].type).toBe('ETF');
    expect(result.allocations[0].value).toBe(22500);
    expect(result.allocations[1].type).toBe('Stock');
    expect(result.allocations[1].value).toBe(17000);
  });

  it('defaults missing type to Other', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150, type: 'Stock' },
      { symbol: 'XYZ', shares: 10, avgPrice: 50 }, // no type
    ];
    const result = aggregateByType(portfolio, {});

    expect(result.allocations).toHaveLength(2);
    const otherAlloc = result.allocations.find((a) => a.type === 'Other');
    expect(otherAlloc).toBeDefined();
    expect(otherAlloc.value).toBe(500);
  });

  it('handles empty portfolio', () => {
    const result = aggregateByType([], {});
    expect(result.totalMarketValue).toBe(0);
    expect(result.allocations).toHaveLength(0);
  });

  it('handles single type', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150, type: 'Stock' },
      { symbol: 'TSLA', shares: 50, avgPrice: 200, type: 'Stock' },
    ];
    const result = aggregateByType(portfolio, {});

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].type).toBe('Stock');
    expect(result.allocations[0].weight).toBe(100);
  });

  it('weights sum to 100%', () => {
    const portfolio = [
      { symbol: 'AAPL', shares: 100, avgPrice: 150, type: 'Stock' },
      { symbol: 'SPY', shares: 50, avgPrice: 400, type: 'ETF' },
      { symbol: 'BTC', shares: 1, avgPrice: 30000, type: 'Crypto' },
      { symbol: 'BND', shares: 100, avgPrice: 80, type: 'Bond' },
    ];
    const result = aggregateByType(portfolio, {});

    const totalWeight = result.allocations.reduce((sum, a) => sum + a.weight, 0);
    expect(totalWeight).toBeCloseTo(100);
  });
});

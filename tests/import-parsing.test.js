import { describe, it, expect } from 'vitest';
import { parsePortfolioText } from '../src/portfolio.js';

describe('parsePortfolioText', () => {
  describe('empty / invalid input', () => {
    it('returns empty results for empty string', () => {
      const result = parsePortfolioText('');
      expect(result.positions).toHaveLength(0);
      expect(result.errors).toContain('No text provided');
    });

    it('returns empty results for null', () => {
      const result = parsePortfolioText(null);
      expect(result.positions).toHaveLength(0);
    });

    it('returns empty results for whitespace-only string', () => {
      const result = parsePortfolioText('   \n  \n  ');
      expect(result.positions).toHaveLength(0);
    });
  });

  describe('full format (8+ columns)', () => {
    it('parses a valid full-format row with type', () => {
      const text = 'Apple Inc\tAAPL\tFidelity\tStock\t100\t15000\t15000\t150.00\t2024-01-01';
      const result = parsePortfolioText(text);

      expect(result.positions).toHaveLength(1);
      expect(result.positions[0]).toEqual({
        name: 'Apple Inc',
        symbol: 'AAPL',
        platform: 'Fidelity',
        type: 'Stock',
        shares: 100,
        avgPrice: 150,
      });
      expect(result.errors).toHaveLength(0);
    });

    it('captures different asset types', () => {
      const text = [
        'Bitcoin\tBTC\tCoinbase\tCrypto\t1\t50000\t50000\t50000\t-',
        'SPY\tSPY\tFidelity\tETF\t100\t45000\t45000\t450\t-',
        'Bond Fund\tBND\tVanguard\tBond\t200\t16000\t16000\t80\t-',
      ].join('\n');
      const result = parsePortfolioText(text);

      expect(result.positions).toHaveLength(3);
      expect(result.positions[0].type).toBe('Crypto');
      expect(result.positions[1].type).toBe('ETF');
      expect(result.positions[2].type).toBe('Bond');
    });

    it('defaults type to Other when empty', () => {
      const text = 'Apple\tAAPL\tFidelity\t\t100\t15000\t15000\t150\t-';
      const result = parsePortfolioText(text);
      expect(result.positions[0].type).toBe('Other');
    });

    it('uppercases the ticker symbol', () => {
      const text = 'Test\taapl\tBroker\tStock\t10\t1000\t1000\t100\t-';
      const result = parsePortfolioText(text);
      expect(result.positions[0].symbol).toBe('AAPL');
    });

    it('strips $ and commas from price', () => {
      const text = 'Tesla\tTSLA\tBroker\tStock\t5\t3000\t3000\t$1,234.56\t-';
      const result = parsePortfolioText(text);
      expect(result.positions[0].avgPrice).toBeCloseTo(1234.56);
    });

    it('skips header row containing "Asset"', () => {
      const text =
        'Asset\tTicker\tPlatform\tType\tUnits\tTotal\tActive\tAvgPrice\tLast\n' +
        'Apple\tAAPL\tFidelity\tStock\t50\t7500\t7500\t150\t2024-01-01';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('AAPL');
    });

    it('skips header row containing "Ticker"', () => {
      const text =
        'Name\tTicker\tBroker\tCategory\tQty\tCost\tValue\tPrice\tDate\n' +
        'Google\tGOOGL\tVanguard\tStock\t20\t3000\t3200\t160\t-';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('GOOGL');
    });

    it('rejects row with missing ticker', () => {
      // "No Ticker" would be caught by header detection since it contains "Ticker",
      // so use a second row with missing ticker after a valid first row.
      const text = [
        'Apple\tAAPL\tBroker\tStock\t10\t1000\t1000\t100\t-',
        'Missing\t\tBroker\tStock\t10\t1000\t1000\t100\t-',
      ].join('\n');
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('missing ticker');
    });

    it('rejects row with zero shares', () => {
      const text = 'Test\tTSLA\tBroker\tStock\t0\t0\t0\t100\t-';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors[0]).toContain('invalid shares');
    });

    it('rejects row with negative shares', () => {
      const text = 'Test\tTSLA\tBroker\tStock\t-5\t-500\t-500\t100\t-';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors[0]).toContain('invalid shares');
    });

    it('rejects row with zero price', () => {
      const text = 'Test\tTSLA\tBroker\tStock\t10\t0\t0\t0\t-';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors[0]).toContain('invalid price');
    });

    it('rejects row with non-numeric shares', () => {
      const text = 'Test\tTSLA\tBroker\tStock\tABC\t1000\t1000\t100\t-';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors[0]).toContain('invalid shares');
    });

    it('parses multiple valid rows', () => {
      const text = [
        'Apple\tAAPL\tFidelity\tStock\t100\t15000\t15000\t150\t-',
        'Tesla\tTSLA\tVanguard\tStock\t50\t10000\t10000\t200\t-',
        'Google\tGOOGL\tSchwab\tStock\t25\t5000\t5000\t200\t-',
      ].join('\n');
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(3);
      expect(result.positions.map((p) => p.symbol)).toEqual(['AAPL', 'TSLA', 'GOOGL']);
    });

    it('handles mixed valid and invalid rows', () => {
      const text = [
        'Apple\tAAPL\tFidelity\tStock\t100\t15000\t15000\t150\t-',
        'Bad\t\tBroker\tStock\t0\t0\t0\t0\t-',
        'Tesla\tTSLA\tVanguard\tStock\t50\t10000\t10000\t200\t-',
      ].join('\n');
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
    });

    it('defaults platform to Unknown when empty', () => {
      const text = 'Apple\tAAPL\t\tStock\t10\t1000\t1000\t100\t-';
      const result = parsePortfolioText(text);
      // Empty string is falsy → ternary defaults to 'Unknown'
      expect(result.positions[0].platform).toBe('Unknown');
    });

    it('handles fractional shares', () => {
      const text = 'Bitcoin\tBTC\tCoinbase\tCrypto\t0.5\t25000\t25000\t50000\t-';
      const result = parsePortfolioText(text);
      expect(result.positions[0].shares).toBeCloseTo(0.5);
    });
  });

  describe('simple format (3 columns)', () => {
    it('parses valid simple-format row with default type', () => {
      const text = 'AAPL\t100\t150';
      const result = parsePortfolioText(text);

      expect(result.positions).toHaveLength(1);
      expect(result.positions[0]).toEqual({
        name: 'AAPL',
        symbol: 'AAPL',
        platform: 'Unknown',
        type: 'Stock',
        shares: 100,
        avgPrice: 150,
      });
    });

    it('uppercases ticker in simple format', () => {
      const text = 'tsla\t50\t200';
      const result = parsePortfolioText(text);
      expect(result.positions[0].symbol).toBe('TSLA');
    });

    it('strips $ and commas from price in simple format', () => {
      const text = 'AAPL\t10\t$1,234.56';
      const result = parsePortfolioText(text);
      expect(result.positions[0].avgPrice).toBeCloseTo(1234.56);
    });

    it('rejects simple format with non-numeric data', () => {
      const text = 'AAPL\tabc\txyz';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('insufficient columns', () => {
    it('rejects rows with only 1 column', () => {
      const text = 'AAPL';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors[0]).toContain('Only 1 columns');
    });

    it('rejects rows with only 2 columns', () => {
      const text = 'AAPL\t100';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors[0]).toContain('Only 2 columns');
    });
  });

  describe('blank lines and whitespace', () => {
    it('skips blank lines between valid rows', () => {
      const text = 'AAPL\t100\t150\n\n\nTSLA\t50\t200';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });
  });
});

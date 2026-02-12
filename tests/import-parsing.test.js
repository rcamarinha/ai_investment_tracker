import { describe, it, expect } from 'vitest';
import {
  parsePortfolioText,
  detectSeparator,
  parseFlexibleNumber,
  detectColumnMapping,
  isISIN,
  matchesRole,
} from '../src/portfolio.js';

// ── Helper Utilities ─────────────────────────────────────────────────────────

describe('detectSeparator', () => {
  it('detects tab separator', () => {
    expect(detectSeparator('A\tB\tC')).toBe('\t');
  });
  it('detects semicolon separator', () => {
    expect(detectSeparator('A;B;C')).toBe(';');
  });
  it('detects pipe separator', () => {
    expect(detectSeparator('A|B|C')).toBe('|');
  });
  it('detects comma separator when no tabs/semicolons/pipes', () => {
    expect(detectSeparator('A,B,C')).toBe(',');
  });
  it('prefers tab over comma', () => {
    expect(detectSeparator('A\tB,C')).toBe('\t');
  });
  it('defaults to tab for plain text', () => {
    expect(detectSeparator('hello world')).toBe('\t');
  });
});

describe('parseFlexibleNumber', () => {
  it('parses plain number', () => {
    expect(parseFlexibleNumber('150.50')).toBeCloseTo(150.5);
  });
  it('parses with $ sign', () => {
    expect(parseFlexibleNumber('$1,234.56')).toBeCloseTo(1234.56);
  });
  it('parses European format (dot thousands, comma decimal)', () => {
    expect(parseFlexibleNumber('1.234,56')).toBeCloseTo(1234.56);
  });
  it('parses simple European decimal (12,50)', () => {
    expect(parseFlexibleNumber('12,50')).toBeCloseTo(12.5);
  });
  it('parses with euro sign', () => {
    expect(parseFlexibleNumber('\u20ac150')).toBeCloseTo(150);
  });
  it('returns NaN for empty string', () => {
    expect(parseFlexibleNumber('')).toBeNaN();
  });
  it('returns NaN for null', () => {
    expect(parseFlexibleNumber(null)).toBeNaN();
  });
});

describe('isISIN', () => {
  it('recognizes valid ISIN (US)', () => {
    expect(isISIN('US0378331005')).toBe(true);
  });
  it('recognizes valid ISIN (DE)', () => {
    expect(isISIN('DE000BAY0017')).toBe(true);
  });
  it('rejects short string', () => {
    expect(isISIN('AAPL')).toBe(false);
  });
  it('rejects lowercase', () => {
    expect(isISIN('us0378331005')).toBe(false);
  });
});

describe('matchesRole', () => {
  it('matches "Ticker" to symbol role', () => {
    expect(matchesRole('Ticker', 'symbol')).toBe(true);
  });
  it('matches "ISIN" to symbol role', () => {
    expect(matchesRole('ISIN', 'symbol')).toBe(true);
  });
  it('matches "Qty" to shares role', () => {
    expect(matchesRole('Qty', 'shares')).toBe(true);
  });
  it('matches "Avg Price" to price role', () => {
    expect(matchesRole('Avg Price', 'price')).toBe(true);
  });
  it('is case insensitive', () => {
    expect(matchesRole('SHARES', 'shares')).toBe(true);
  });
  it('does not match unrelated header', () => {
    expect(matchesRole('Date', 'symbol')).toBe(false);
  });
});

describe('detectColumnMapping', () => {
  it('detects mapping from standard headers', () => {
    const mapping = detectColumnMapping(['Name', 'Ticker', 'Shares', 'Avg Price']);
    expect(mapping).not.toBeNull();
    expect(mapping.symbol).toBe(1);
    expect(mapping.shares).toBe(2);
    expect(mapping.price).toBe(3);
    expect(mapping.name).toBe(0);
  });
  it('detects mapping from ISIN headers', () => {
    const mapping = detectColumnMapping(['ISIN', 'Quantity', 'Value']);
    expect(mapping).not.toBeNull();
    expect(mapping.symbol).toBe(0);
    expect(mapping.shares).toBe(1);
  });
  it('returns null when symbol column is missing', () => {
    const mapping = detectColumnMapping(['Name', 'Shares', 'Price']);
    expect(mapping).toBeNull();
  });
  it('returns null when shares column is missing', () => {
    const mapping = detectColumnMapping(['Ticker', 'Name', 'Price']);
    expect(mapping).toBeNull();
  });
});

// ── parsePortfolioText (backward compatibility) ──────────────────────────────

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
      expect(result.positions[0].symbol).toBe('AAPL');
      expect(result.positions[0].shares).toBe(100);
      expect(result.positions[0].avgPrice).toBeCloseTo(150);
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
      const text = [
        'Apple\tAAPL\tBroker\tStock\t10\t1000\t1000\t100\t-',
        'Missing\t\tBroker\tStock\t10\t1000\t1000\t100\t-',
      ].join('\n');
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects row with zero shares', () => {
      const text = 'Test\tTSLA\tBroker\tStock\t0\t0\t0\t100\t-';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects row with negative shares', () => {
      const text = 'Test\tTSLA\tBroker\tStock\t-5\t-500\t-500\t100\t-';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects row with non-numeric shares', () => {
      const text = 'Test\tTSLA\tBroker\tStock\tABC\t1000\t1000\t100\t-';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
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
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('handles fractional shares', () => {
      const text = 'Bitcoin\tBTC\tCoinbase\tCrypto\t0.5\t25000\t25000\t50000\t-';
      const result = parsePortfolioText(text);
      expect(result.positions[0].shares).toBeCloseTo(0.5);
    });
  });

  describe('simple format (3 columns)', () => {
    it('parses valid simple-format row', () => {
      const text = 'AAPL\t100\t150';
      const result = parsePortfolioText(text);

      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('AAPL');
      expect(result.positions[0].shares).toBe(100);
      expect(result.positions[0].avgPrice).toBeCloseTo(150);
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

  describe('blank lines and whitespace', () => {
    it('skips blank lines between valid rows', () => {
      const text = 'AAPL\t100\t150\n\n\nTSLA\t50\t200';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ── New flexible parsing tests ──────────────────────────────────────────

  describe('flexible header detection', () => {
    it('detects "Symbol" + "Quantity" headers', () => {
      const text = 'Symbol\tQuantity\tAvg Price\nAAPL\t50\t180';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('AAPL');
      expect(result.positions[0].shares).toBe(50);
      expect(result.positions[0].avgPrice).toBeCloseTo(180);
    });

    it('detects "ISIN" + "Units" headers', () => {
      const text = 'ISIN\tUnits\tAvg Cost\nUS0378331005\t100\t150';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('US0378331005');
      expect(result.positions[0].shares).toBe(100);
    });

    it('detects "Code" + "Qty" + "Purchase Price" headers', () => {
      const text = 'Code\tQty\tPurchase Price\nTSLA\t20\t245.50';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('TSLA');
    });

    it('detects headers regardless of column order', () => {
      const text = 'Avg Price\tShares\tTicker\tName\n150\t100\tAAPL\tApple';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('AAPL');
      expect(result.positions[0].shares).toBe(100);
      expect(result.positions[0].avgPrice).toBeCloseTo(150);
    });
  });

  describe('multiple separator support', () => {
    it('parses semicolon-separated data', () => {
      const text = 'Ticker;Shares;Avg Price\nAAPL;50;180';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('AAPL');
    });

    it('parses comma-separated data', () => {
      const text = 'Ticker,Shares,Avg Price\nMSFT,30,400';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('MSFT');
    });

    it('parses pipe-separated data', () => {
      const text = 'Ticker|Shares|Avg Price\nGOOGL|10|170';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].symbol).toBe('GOOGL');
    });
  });

  describe('European number formats', () => {
    it('parses price with comma as decimal', () => {
      const text = 'Ticker;Shares;Avg Price\nAAPL;50;180,50';
      const result = parsePortfolioText(text);
      expect(result.positions[0].avgPrice).toBeCloseTo(180.5);
    });

    it('parses price with dot thousands and comma decimal', () => {
      const text = 'Ticker;Shares;Avg Price\nTSLA;5;1.234,56';
      const result = parsePortfolioText(text);
      expect(result.positions[0].avgPrice).toBeCloseTo(1234.56);
    });
  });

  describe('missing price handling', () => {
    it('sets avgPrice to 0 and warns when no price column', () => {
      const text = 'Ticker\tShares\nAAPL\t100';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].avgPrice).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('No acquisition price');
    });

    it('derives price from total amount when price is missing', () => {
      const text = 'Ticker\tShares\tInvested\nAAPL\t100\t15000';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].avgPrice).toBeCloseTo(150);
    });
  });

  describe('asset type normalization', () => {
    it('normalizes "etf" to "ETF"', () => {
      const text = 'Ticker\tShares\tAvg Price\tType\nSPY\t100\t450\tetf';
      const result = parsePortfolioText(text);
      expect(result.positions[0].type).toBe('ETF');
    });

    it('normalizes "equity" to "Stock"', () => {
      const text = 'Ticker\tShares\tAvg Price\tType\nAAPL\t10\t150\tequity';
      const result = parsePortfolioText(text);
      expect(result.positions[0].type).toBe('Stock');
    });
  });

  describe('ISIN detection', () => {
    it('flags ISIN identifiers for resolution', () => {
      const text = 'ISIN\tShares\tAvg Price\nUS0378331005\t50\t150';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(1);
      expect(result.positions[0]._resolvedFrom).toBe('US0378331005');
    });
  });

  describe('error handling', () => {
    it('reports missing ticker clearly', () => {
      const text = 'Ticker\tShares\n\t100';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors[0]).toContain('Missing ticker');
    });

    it('reports invalid quantity clearly', () => {
      const text = 'Ticker\tShares\nAAPL\tabc';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors[0]).toContain('Invalid quantity');
    });

    it('reports error when column layout cannot be determined', () => {
      const text = 'hello world';
      const result = parsePortfolioText(text);
      expect(result.positions).toHaveLength(0);
      expect(result.errors[0]).toContain('Could not detect column layout');
    });
  });
});

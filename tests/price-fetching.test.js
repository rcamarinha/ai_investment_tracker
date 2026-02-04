import { describe, it, expect, vi } from 'vitest';
import { fetchStockPrice, calculateRateDelay } from '../src/portfolio.js';

// Helper: create a mock fetch that returns a specific response
function mockFetch(status, body, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// Helper: create a mock fetch that throws a network error
function mockFetchError(message = 'Network error') {
  return vi.fn().mockRejectedValue(new Error(message));
}

describe('fetchStockPrice', () => {
  describe('Tier 1: Finnhub', () => {
    it('returns price from Finnhub when successful', async () => {
      const fetchFn = mockFetch(200, { c: 175.5, d: 2.1, dp: 1.2 });
      const result = await fetchStockPrice('AAPL', { finnhubKey: 'test-key' }, fetchFn);

      expect(result).toEqual({ price: 175.5, source: 'Finnhub', tier: 1, success: true });
      expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('finnhub.io'));
      expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('symbol=AAPL'));
      expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('token=test-key'));
    });

    it('skips Finnhub when c is 0 (symbol not found)', async () => {
      const fetchFn = mockFetch(200, { c: 0, d: null, dp: null });
      const result = await fetchStockPrice('INVALID', { finnhubKey: 'key' }, fetchFn);

      expect(result.success).toBe(false);
      expect(result.source).toBe('All APIs failed');
    });

    it('skips Finnhub when response is not ok', async () => {
      const fetchFn = mockFetch(429, {}, false);
      const result = await fetchStockPrice('AAPL', { finnhubKey: 'key' }, fetchFn);

      expect(result.success).toBe(false);
    });

    it('skips Finnhub on network error and continues', async () => {
      const fetchFn = mockFetchError('Connection refused');
      const result = await fetchStockPrice('AAPL', { finnhubKey: 'key' }, fetchFn);

      expect(result.success).toBe(false);
    });
  });

  describe('Tier 2: FMP', () => {
    it('returns price from FMP when Finnhub unavailable', async () => {
      const fetchFn = mockFetch(200, [{ symbol: 'AAPL', price: 175.5, volume: 1000 }]);
      const result = await fetchStockPrice('AAPL', { fmpKey: 'test-key' }, fetchFn);

      expect(result).toEqual({ price: 175.5, source: 'Financial Modeling Prep', tier: 2, success: true });
      expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('financialmodelingprep.com'));
    });

    it('falls through when FMP returns an error field', async () => {
      const fetchFn = mockFetch(200, { error: 'Invalid API key' });
      const result = await fetchStockPrice('AAPL', { fmpKey: 'bad-key' }, fetchFn);

      expect(result.success).toBe(false);
    });

    it('falls through when FMP returns empty array', async () => {
      const fetchFn = mockFetch(200, []);
      const result = await fetchStockPrice('UNKNOWN', { fmpKey: 'key' }, fetchFn);

      expect(result.success).toBe(false);
    });

    it('falls through when FMP returns array with price=0', async () => {
      const fetchFn = mockFetch(200, [{ symbol: 'UNKNOWN', price: 0 }]);
      const result = await fetchStockPrice('UNKNOWN', { fmpKey: 'key' }, fetchFn);

      expect(result.success).toBe(false);
    });
  });

  describe('Tier 3: Alpha Vantage', () => {
    it('returns price from Alpha Vantage when other tiers unavailable', async () => {
      const fetchFn = mockFetch(200, {
        'Global Quote': {
          '01. symbol': 'AAPL',
          '05. price': '175.50',
        },
      });
      const result = await fetchStockPrice('AAPL', { alphaVantageKey: 'test-key' }, fetchFn);

      expect(result.price).toBeCloseTo(175.5);
      expect(result.source).toBe('Alpha Vantage');
      expect(result.tier).toBe(3);
      expect(result.success).toBe(true);
    });

    it('reports rate limit when Note field is present', async () => {
      const fetchFn = mockFetch(200, {
        Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute.',
      });
      const result = await fetchStockPrice('AAPL', { alphaVantageKey: 'key' }, fetchFn);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limit');
      expect(result.source).toBe('Alpha Vantage');
    });

    it('falls through when Global Quote has no price', async () => {
      const fetchFn = mockFetch(200, { 'Global Quote': {} });
      const result = await fetchStockPrice('UNKNOWN', { alphaVantageKey: 'key' }, fetchFn);

      expect(result.success).toBe(false);
    });
  });

  describe('Fallback chain', () => {
    it('tries Finnhub first, then FMP on failure', async () => {
      let callCount = 0;
      const fetchFn = vi.fn().mockImplementation((url) => {
        callCount++;
        if (url.includes('finnhub.io')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ c: 0 }), // Finnhub: no price
          });
        }
        if (url.includes('financialmodelingprep.com')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ price: 150 }]), // FMP: success
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });

      const result = await fetchStockPrice(
        'AAPL',
        { finnhubKey: 'fh-key', fmpKey: 'fmp-key' },
        fetchFn
      );

      expect(result.success).toBe(true);
      expect(result.source).toBe('Financial Modeling Prep');
      expect(result.tier).toBe(2);
      expect(callCount).toBe(2);
    });

    it('tries all three tiers before failing', async () => {
      let callCount = 0;
      const fetchFn = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ c: 0, 'Global Quote': {} }),
        });
      });

      const result = await fetchStockPrice(
        'UNKNOWN',
        { finnhubKey: 'a', fmpKey: 'b', alphaVantageKey: 'c' },
        fetchFn
      );

      expect(result.success).toBe(false);
      expect(result.source).toBe('All APIs failed');
      expect(callCount).toBe(3);
    });

    it('reports "No API keys" when none configured', async () => {
      const fetchFn = vi.fn();
      const result = await fetchStockPrice('AAPL', {}, fetchFn);

      expect(result.success).toBe(false);
      expect(result.source).toBe('No API keys');
      expect(result.error).toBe('Configure API keys');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('skips tiers without keys', async () => {
      const fetchFn = mockFetch(200, {
        'Global Quote': { '05. price': '100.00' },
      });

      // Only Alpha Vantage key set
      const result = await fetchStockPrice(
        'AAPL',
        { alphaVantageKey: 'av-key' },
        fetchFn
      );

      expect(result.success).toBe(true);
      expect(result.source).toBe('Alpha Vantage');
      // Should only be called once (skipped Finnhub and FMP)
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('calculateRateDelay', () => {
  it('returns 1000ms when Finnhub key is present', () => {
    const result = calculateRateDelay({ finnhubKey: 'key' });
    expect(result.delay).toBe(1000);
    expect(result.description).toContain('Finnhub');
  });

  it('returns 500ms when only FMP key is present', () => {
    const result = calculateRateDelay({ fmpKey: 'key' });
    expect(result.delay).toBe(500);
    expect(result.description).toContain('FMP');
  });

  it('returns 12000ms when only Alpha Vantage key is present', () => {
    const result = calculateRateDelay({ alphaVantageKey: 'key' });
    expect(result.delay).toBe(12000);
    expect(result.description).toContain('Alpha Vantage');
  });

  it('prioritizes Finnhub over other keys', () => {
    const result = calculateRateDelay({ finnhubKey: 'a', fmpKey: 'b', alphaVantageKey: 'c' });
    expect(result.delay).toBe(1000);
    expect(result.description).toContain('Finnhub');
    expect(result.description).toContain('FMP');
    expect(result.description).toContain('Alpha Vantage');
  });

  it('returns default when no keys', () => {
    const result = calculateRateDelay({});
    expect(result.delay).toBe(1000);
    expect(result.description).toContain('No API keys');
  });
});

import { describe, it, expect } from 'vitest';
import { buildSnapshot, mergeSnapshots } from '../src/portfolio.js';

describe('buildSnapshot', () => {
  const portfolio = [
    { symbol: 'AAPL', shares: 100, avgPrice: 150 },
    { symbol: 'TSLA', shares: 50, avgPrice: 200 },
  ];

  it('calculates correct totals with all prices', () => {
    const marketPrices = { AAPL: 170, TSLA: 220 };
    const snapshot = buildSnapshot(portfolio, marketPrices, '2024-06-15T12:00:00Z');

    expect(snapshot.totalInvested).toBe(25000);
    expect(snapshot.totalMarketValue).toBe(28000);
    expect(snapshot.positionCount).toBe(2);
    expect(snapshot.pricesAvailable).toBe(2);
    expect(snapshot.timestamp).toBe('2024-06-15T12:00:00Z');
  });

  it('falls back to cost basis for missing prices', () => {
    const marketPrices = { AAPL: 170 };
    const snapshot = buildSnapshot(portfolio, marketPrices);

    // TSLA has no price → uses 50*200 = 10000 as market value
    expect(snapshot.totalMarketValue).toBe(17000 + 10000);
    expect(snapshot.pricesAvailable).toBe(1);
  });

  it('handles empty market prices', () => {
    const snapshot = buildSnapshot(portfolio, {});

    expect(snapshot.totalInvested).toBe(25000);
    expect(snapshot.totalMarketValue).toBe(25000); // all cost basis
    expect(snapshot.pricesAvailable).toBe(0);
  });

  it('handles empty portfolio', () => {
    const snapshot = buildSnapshot([], {});

    expect(snapshot.totalInvested).toBe(0);
    expect(snapshot.totalMarketValue).toBe(0);
    expect(snapshot.positionCount).toBe(0);
    expect(snapshot.pricesAvailable).toBe(0);
  });

  it('uses current time when no timestamp provided', () => {
    const before = new Date().toISOString();
    const snapshot = buildSnapshot(portfolio, {});
    const after = new Date().toISOString();

    expect(snapshot.timestamp >= before).toBe(true);
    expect(snapshot.timestamp <= after).toBe(true);
  });

  it('counts pricesAvailable from marketPrices keys', () => {
    // marketPrices may contain keys not in portfolio
    const marketPrices = { AAPL: 170, TSLA: 220, GOOGL: 140 };
    const snapshot = buildSnapshot(portfolio, marketPrices);

    expect(snapshot.pricesAvailable).toBe(3); // counts all keys in marketPrices
  });
});

describe('mergeSnapshots', () => {
  const snap1 = { timestamp: '2024-01-01T00:00:00Z', totalInvested: 1000, totalMarketValue: 1100 };
  const snap2 = { timestamp: '2024-02-01T00:00:00Z', totalInvested: 1000, totalMarketValue: 1200 };
  const snap3 = { timestamp: '2024-03-01T00:00:00Z', totalInvested: 1000, totalMarketValue: 1300 };

  it('merges two non-overlapping sets', () => {
    const result = mergeSnapshots([snap1], [snap2, snap3]);
    expect(result).toHaveLength(3);
    expect(result[0].timestamp).toBe(snap1.timestamp);
    expect(result[2].timestamp).toBe(snap3.timestamp);
  });

  it('deduplicates by timestamp', () => {
    const result = mergeSnapshots([snap1, snap2], [snap2, snap3]);
    expect(result).toHaveLength(3);
  });

  it('sorts chronologically', () => {
    const result = mergeSnapshots([snap3], [snap1, snap2]);
    expect(result[0].timestamp).toBe(snap1.timestamp);
    expect(result[1].timestamp).toBe(snap2.timestamp);
    expect(result[2].timestamp).toBe(snap3.timestamp);
  });

  it('handles empty existing array', () => {
    const result = mergeSnapshots([], [snap1, snap2]);
    expect(result).toHaveLength(2);
  });

  it('handles empty incoming array', () => {
    const result = mergeSnapshots([snap1, snap2], []);
    expect(result).toHaveLength(2);
  });

  it('handles both arrays empty', () => {
    const result = mergeSnapshots([], []);
    expect(result).toHaveLength(0);
  });

  it('preserves all fields from snapshot objects', () => {
    const detailed = {
      timestamp: '2024-04-01T00:00:00Z',
      totalInvested: 5000,
      totalMarketValue: 5500,
      positionCount: 10,
      pricesAvailable: 8,
    };
    const result = mergeSnapshots([], [detailed]);
    expect(result[0]).toEqual(detailed);
  });

  it('keeps first occurrence when timestamps collide', () => {
    const existing = { timestamp: '2024-01-01T00:00:00Z', totalInvested: 1000, totalMarketValue: 1100 };
    const incoming = { timestamp: '2024-01-01T00:00:00Z', totalInvested: 9999, totalMarketValue: 9999 };
    const result = mergeSnapshots([existing], [incoming]);

    expect(result).toHaveLength(1);
    expect(result[0].totalInvested).toBe(1000); // kept existing
  });
});

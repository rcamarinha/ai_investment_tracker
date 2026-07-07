import { describe, it, expect } from 'vitest';
import { deriveFxToBases, lookupFxTableForDate } from '../services/pricing-core.js';

// ECB/Frankfurter-shaped table: 1 EUR = X units of CUR
const TABLE = { USD: 1.10, GBP: 0.85, CHF: 0.95, JPY: 160 };

describe('deriveFxToBases', () => {
  it('USD transaction: identity to USD, inverse to EUR', () => {
    const fx = deriveFxToBases(TABLE, 'USD');
    expect(fx.USD).toBe(1);
    expect(fx.EUR).toBeCloseTo(1 / 1.10, 10);   // 1 USD ≈ 0.909 EUR
  });

  it('EUR transaction: identity to EUR, table rate to USD', () => {
    const fx = deriveFxToBases(TABLE, 'EUR');
    expect(fx.EUR).toBe(1);
    expect(fx.USD).toBeCloseTo(1.10, 10);       // 1 EUR = 1.10 USD
  });

  it('cross rate for a third currency (GBP → USD via EUR)', () => {
    const fx = deriveFxToBases(TABLE, 'GBP');
    expect(fx.EUR).toBeCloseTo(1 / 0.85, 10);           // 1 GBP ≈ 1.176 EUR
    expect(fx.USD).toBeCloseTo(1.10 / 0.85, 10);        // 1 GBP ≈ 1.294 USD
  });

  it('round-trips: converting through both bases is consistent', () => {
    // 100 CHF → EUR → back via USD cross must equal direct USD conversion
    const fx = deriveFxToBases(TABLE, 'CHF');
    const viaEur = 100 * fx.EUR * TABLE.USD;   // CHF→EUR→USD
    const direct = 100 * fx.USD;
    expect(viaEur).toBeCloseTo(direct, 8);
  });

  it('lowercase currency input is normalized', () => {
    const fx = deriveFxToBases(TABLE, 'usd');
    expect(fx.USD).toBe(1);
    expect(fx.EUR).toBeCloseTo(1 / 1.10, 10);
  });

  it('unknown currency yields null rates (caller falls back to live)', () => {
    const fx = deriveFxToBases(TABLE, 'XXX');
    expect(fx.EUR).toBeNull();
    expect(fx.USD).toBeNull();
  });

  it('zero/garbage table entries yield null, never Infinity', () => {
    const fx = deriveFxToBases({ USD: 0, GBP: 'bad' }, 'GBP');
    expect(fx.EUR).toBeNull();
    expect(fx.USD).toBeNull();
  });

  it('missing/empty table: EUR tx still resolves identity + null USD', () => {
    const fx = deriveFxToBases(null, 'EUR');
    expect(fx.EUR).toBe(1);
    expect(fx.USD).toBeNull();
  });

  it('empty currency returns null outright', () => {
    expect(deriveFxToBases(TABLE, '')).toBeNull();
    expect(deriveFxToBases(TABLE, null)).toBeNull();
  });

  it('custom bases list is honored', () => {
    const fx = deriveFxToBases(TABLE, 'USD', ['EUR', 'USD', 'GBP']);
    expect(fx.GBP).toBeCloseTo(0.85 / 1.10, 10); // 1 USD ≈ 0.773 GBP
  });

  it('GBX (pence) converts via GBP/100', () => {
    const fx = deriveFxToBases(TABLE, 'GBX');
    expect(fx.EUR).toBeCloseTo(0.01 / 0.85, 10);        // 1 GBX ≈ €0.0118
    expect(fx.USD).toBeCloseTo((1.10 / 0.85) * 0.01, 10);
  });
});

describe('lookupFxTableForDate', () => {
  const HIST = {
    '2024-03-15': { USD: 1.09 },   // Friday
    '2024-03-18': { USD: 1.10 },   // Monday
  };

  it('exact business-day hit', () => {
    expect(lookupFxTableForDate(HIST, '2024-03-15').USD).toBe(1.09);
  });

  it('weekend walks back to the previous Friday', () => {
    expect(lookupFxTableForDate(HIST, '2024-03-16').USD).toBe(1.09); // Saturday
    expect(lookupFxTableForDate(HIST, '2024-03-17').USD).toBe(1.09); // Sunday
  });

  it('accepts ISO timestamps (date portion used)', () => {
    expect(lookupFxTableForDate(HIST, '2024-03-18T14:30:00Z').USD).toBe(1.10);
  });

  it('gap beyond maxBack returns null', () => {
    expect(lookupFxTableForDate(HIST, '2024-03-30')).toBeNull();
  });

  it('garbage inputs return null', () => {
    expect(lookupFxTableForDate(HIST, 'not-a-date')).toBeNull();
    expect(lookupFxTableForDate(null, '2024-03-15')).toBeNull();
    expect(lookupFxTableForDate(HIST, null)).toBeNull();
  });
});

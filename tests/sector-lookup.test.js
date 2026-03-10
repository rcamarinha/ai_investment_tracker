import { describe, it, expect, beforeEach } from 'vitest';
import { getSector, SECTOR_MAPPING } from '../data/sectors.js';
import { INVESTMENT_PERSPECTIVES } from '../data/perspectives.js';
import state from '../services/state.js';

// ── getSector ────────────────────────────────────────────────────────────────

describe('getSector', () => {
  beforeEach(() => {
    // Reset state before each test so tests are independent
    state.assetDatabase = {};
    state.sectorCache = {};
  });

  it('returns Other for null', () => {
    expect(getSector(null)).toBe('Other');
  });

  it('returns Other for undefined', () => {
    expect(getSector(undefined)).toBe('Other');
  });

  it('returns Other for empty string', () => {
    expect(getSector('')).toBe('Other');
  });

  it('returns Technology for AAPL', () => {
    expect(getSector('AAPL')).toBe('Technology');
  });

  it('returns Technology for MSFT', () => {
    expect(getSector('MSFT')).toBe('Technology');
  });

  it('returns Technology for NVDA', () => {
    expect(getSector('NVDA')).toBe('Technology');
  });

  it('returns Technology for ASML', () => {
    expect(getSector('ASML')).toBe('Technology');
  });

  it('returns Financial for JPM', () => {
    expect(getSector('JPM')).toBe('Financial');
  });

  it('returns Financial for V (Visa)', () => {
    expect(getSector('V')).toBe('Financial');
  });

  it('returns Healthcare for JNJ', () => {
    expect(getSector('JNJ')).toBe('Healthcare');
  });

  it('returns Energy for XOM', () => {
    expect(getSector('XOM')).toBe('Energy');
  });

  it('returns Consumer Discretionary for TSLA', () => {
    expect(getSector('TSLA')).toBe('Consumer Discretionary');
  });

  it('returns Consumer Staples for KO', () => {
    expect(getSector('KO')).toBe('Consumer Staples');
  });

  it('returns Industrials for CAT', () => {
    expect(getSector('CAT')).toBe('Industrials');
  });

  it('returns Materials for LIN', () => {
    expect(getSector('LIN')).toBe('Materials');
  });

  it('returns Utilities for NEE', () => {
    expect(getSector('NEE')).toBe('Utilities');
  });

  it('returns Real Estate for PLD', () => {
    expect(getSector('PLD')).toBe('Real Estate');
  });

  it('returns Communication for DIS', () => {
    expect(getSector('DIS')).toBe('Communication');
  });

  it('returns Index ETF for SPY', () => {
    expect(getSector('SPY')).toBe('Index ETF');
  });

  it('returns Tech ETF for QQQ', () => {
    expect(getSector('QQQ')).toBe('Tech ETF');
  });

  it('returns Bond ETF for TLT', () => {
    expect(getSector('TLT')).toBe('Bond ETF');
  });

  it('returns Commodity ETF for GLD', () => {
    expect(getSector('GLD')).toBe('Commodity ETF');
  });

  it('returns Crypto for BTC', () => {
    expect(getSector('BTC')).toBe('Crypto');
  });

  it('returns Crypto for ETH', () => {
    expect(getSector('ETH')).toBe('Crypto');
  });

  it('returns Consumer Discretionary for MC.PA (LVMH)', () => {
    expect(getSector('MC.PA')).toBe('Consumer Discretionary');
  });

  it('returns Technology for ASML.AS', () => {
    expect(getSector('ASML.AS')).toBe('Technology');
  });

  it('returns Healthcare for AZN.L', () => {
    expect(getSector('AZN.L')).toBe('Healthcare');
  });

  it('returns Other for unknown ticker', () => {
    expect(getSector('ZZZUNKNOWN')).toBe('Other');
    expect(getSector('XYZ123')).toBe('Other');
  });

  it('is case-insensitive (lowercase input)', () => {
    expect(getSector('aapl')).toBe('Technology');
    expect(getSector('msft')).toBe('Technology');
    expect(getSector('jpm')).toBe('Financial');
  });

  it('is case-insensitive (mixed case input)', () => {
    expect(getSector('Aapl')).toBe('Technology');
    expect(getSector('Nvda')).toBe('Technology');
  });

  it('returns sector from assetDatabase when available (DB has priority)', () => {
    state.assetDatabase['AAPL'] = { sector: 'CustomSector' };
    expect(getSector('AAPL')).toBe('CustomSector');
  });

  it('falls back to static map when assetDatabase has no sector for ticker', () => {
    state.assetDatabase['AAPL'] = { name: 'Apple Inc' }; // no sector field
    expect(getSector('AAPL')).toBe('Technology');
  });

  it('falls back to sectorCache when not in static map', () => {
    state.sectorCache['XYZNOVEL'] = 'Aerospace';
    expect(getSector('XYZNOVEL')).toBe('Aerospace');
  });

  it('returns Other when ticker is only in sectorCache under different case', () => {
    // sectorCache stores uppercase keys per the implementation
    state.sectorCache['CACHED'] = 'Biotech';
    expect(getSector('cached')).toBe('Biotech');
  });
});

// ── SECTOR_MAPPING data integrity ─────────────────────────────────────────────

describe('SECTOR_MAPPING', () => {
  const VALID_SECTORS = new Set([
    'Technology', 'Healthcare', 'Financial', 'Consumer Discretionary',
    'Consumer Staples', 'Energy', 'Industrials', 'Materials', 'Utilities',
    'Real Estate', 'Communication',
    'Index ETF', 'Tech ETF', 'Financial ETF', 'Energy ETF', 'Healthcare ETF',
    'Consumer ETF', 'Industrial ETF', 'Utilities ETF', 'Real Estate ETF',
    'Materials ETF', 'Bond ETF', 'Commodity ETF', 'Intl ETF', 'Emerging ETF',
    'Crypto',
  ]);

  it('has at least 100 ticker entries', () => {
    expect(Object.keys(SECTOR_MAPPING).length).toBeGreaterThanOrEqual(100);
  });

  it('all keys are non-empty strings', () => {
    for (const key of Object.keys(SECTOR_MAPPING)) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it('all values are valid known sector names', () => {
    for (const [ticker, sector] of Object.entries(SECTOR_MAPPING)) {
      expect(VALID_SECTORS.has(sector), `${ticker} has unknown sector: "${sector}"`).toBe(true);
    }
  });

  it('all tickers are uppercase (or uppercase with dot suffix for European stocks)', () => {
    for (const key of Object.keys(SECTOR_MAPPING)) {
      // Keys should be upper-case ASCII (optionally with a dot for exchange suffix)
      expect(key, `Ticker "${key}" should be uppercase`).toBe(key.toUpperCase());
    }
  });

  it('contains major US tech stocks', () => {
    expect(SECTOR_MAPPING['AAPL']).toBe('Technology');
    expect(SECTOR_MAPPING['MSFT']).toBe('Technology');
    expect(SECTOR_MAPPING['GOOGL']).toBe('Technology');
    expect(SECTOR_MAPPING['META']).toBe('Technology');
    expect(SECTOR_MAPPING['NVDA']).toBe('Technology');
  });

  it('contains major US financials', () => {
    expect(SECTOR_MAPPING['JPM']).toBe('Financial');
    expect(SECTOR_MAPPING['BAC']).toBe('Financial');
    expect(SECTOR_MAPPING['GS']).toBe('Financial');
  });

  it('contains major ETFs', () => {
    expect(SECTOR_MAPPING['SPY']).toBe('Index ETF');
    expect(SECTOR_MAPPING['QQQ']).toBe('Tech ETF');
    expect(SECTOR_MAPPING['TLT']).toBe('Bond ETF');
    expect(SECTOR_MAPPING['GLD']).toBe('Commodity ETF');
  });

  it('contains crypto tickers', () => {
    expect(SECTOR_MAPPING['BTC']).toBe('Crypto');
    expect(SECTOR_MAPPING['ETH']).toBe('Crypto');
  });

  it('contains European stocks with exchange suffixes', () => {
    expect(SECTOR_MAPPING['MC.PA']).toBe('Consumer Discretionary');
    expect(SECTOR_MAPPING['ASML.AS']).toBe('Technology');
    expect(SECTOR_MAPPING['NESN.SW']).toBe('Consumer Staples');
    expect(SECTOR_MAPPING['SAP.DE']).toBe('Technology');
  });
});

// ── INVESTMENT_PERSPECTIVES data integrity ────────────────────────────────────

describe('INVESTMENT_PERSPECTIVES', () => {
  const EXPECTED_PERSPECTIVES = ['value', 'garp', 'quant', 'macro', 'passive', 'technical'];

  it('has exactly 6 perspectives', () => {
    expect(Object.keys(INVESTMENT_PERSPECTIVES)).toHaveLength(6);
  });

  it('contains all expected perspective keys', () => {
    for (const key of EXPECTED_PERSPECTIVES) {
      expect(INVESTMENT_PERSPECTIVES).toHaveProperty(key);
    }
  });

  it('each perspective has a non-empty name', () => {
    for (const [key, p] of Object.entries(INVESTMENT_PERSPECTIVES)) {
      expect(typeof p.name, `${key}.name`).toBe('string');
      expect(p.name.length, `${key}.name should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('each perspective has a non-empty icon', () => {
    for (const [key, p] of Object.entries(INVESTMENT_PERSPECTIVES)) {
      expect(typeof p.icon, `${key}.icon`).toBe('string');
      expect(p.icon.length, `${key}.icon should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('each perspective has a valid hex color', () => {
    for (const [key, p] of Object.entries(INVESTMENT_PERSPECTIVES)) {
      expect(p.color, `${key}.color should be a hex color or CSS value`).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
  });

  it('each perspective has a non-empty figures field', () => {
    for (const [key, p] of Object.entries(INVESTMENT_PERSPECTIVES)) {
      expect(typeof p.figures, `${key}.figures`).toBe('string');
      expect(p.figures.length, `${key}.figures should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('each perspective has a non-empty description', () => {
    for (const [key, p] of Object.entries(INVESTMENT_PERSPECTIVES)) {
      expect(typeof p.description, `${key}.description`).toBe('string');
      expect(p.description.length, `${key}.description should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('each perspective has a substantive Claude prompt (>100 chars)', () => {
    for (const [key, p] of Object.entries(INVESTMENT_PERSPECTIVES)) {
      expect(typeof p.prompt, `${key}.prompt`).toBe('string');
      expect(p.prompt.length, `${key}.prompt should have at least 100 chars`).toBeGreaterThan(100);
    }
  });

  it('value perspective references Benjamin Graham or Warren Buffett', () => {
    const p = INVESTMENT_PERSPECTIVES.value;
    expect(p.figures).toMatch(/Graham|Buffett/);
  });

  it('garp perspective references Peter Lynch', () => {
    const p = INVESTMENT_PERSPECTIVES.garp;
    expect(p.figures).toMatch(/Lynch/);
  });

  it('quant perspective references Jim Simons or Cliff Asness', () => {
    const p = INVESTMENT_PERSPECTIVES.quant;
    expect(p.figures).toMatch(/Simons|Asness/);
  });

  it('macro perspective references George Soros or Ray Dalio', () => {
    const p = INVESTMENT_PERSPECTIVES.macro;
    expect(p.figures).toMatch(/Soros|Dalio/);
  });

  it('passive perspective references John Bogle', () => {
    const p = INVESTMENT_PERSPECTIVES.passive;
    expect(p.figures).toMatch(/Bogle/);
  });

  it('technical perspective references Jesse Livermore or Paul Tudor Jones', () => {
    const p = INVESTMENT_PERSPECTIVES.technical;
    expect(p.figures).toMatch(/Livermore|Jones/);
  });

  it('all perspective names are distinct', () => {
    const names = Object.values(INVESTMENT_PERSPECTIVES).map(p => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all prompts are distinct', () => {
    const prompts = Object.values(INVESTMENT_PERSPECTIVES).map(p => p.prompt);
    const unique = new Set(prompts);
    expect(unique.size).toBe(prompts.length);
  });

  it('all prompts mention the perspective philosophy', () => {
    expect(INVESTMENT_PERSPECTIVES.value.prompt).toMatch(/intrinsic value|margin of safety/i);
    expect(INVESTMENT_PERSPECTIVES.garp.prompt).toMatch(/PEG|growth/i);
    expect(INVESTMENT_PERSPECTIVES.quant.prompt).toMatch(/factor|quantitative|systematic/i);
    expect(INVESTMENT_PERSPECTIVES.macro.prompt).toMatch(/macro|economic|geopolit/i);
    expect(INVESTMENT_PERSPECTIVES.passive.prompt).toMatch(/index|passive|market/i);
    expect(INVESTMENT_PERSPECTIVES.technical.prompt).toMatch(/trend|momentum|price action/i);
  });
});

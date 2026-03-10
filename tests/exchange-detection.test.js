import { describe, it, expect } from 'vitest';
import { detectStockExchange, detectCurrency, normalizeAssetType } from '../services/utils.js';

// ── detectStockExchange ──────────────────────────────────────────────────────

describe('detectStockExchange', () => {
  it('returns Unknown for null', () => {
    expect(detectStockExchange(null)).toBe('Unknown');
  });

  it('returns Unknown for empty string', () => {
    expect(detectStockExchange('')).toBe('Unknown');
  });

  it('identifies Euronext Paris (.PA)', () => {
    expect(detectStockExchange('MC.PA')).toBe('Euronext Paris');
    expect(detectStockExchange('AIR.PA')).toBe('Euronext Paris');
  });

  it('identifies London LSE (.L)', () => {
    expect(detectStockExchange('AZN.L')).toBe('London (LSE)');
    expect(detectStockExchange('HSBA.L')).toBe('London (LSE)');
  });

  it('identifies Frankfurt XETRA (.DE)', () => {
    expect(detectStockExchange('SAP.DE')).toBe('Frankfurt (XETRA)');
    expect(detectStockExchange('SIE.DE')).toBe('Frankfurt (XETRA)');
  });

  it('identifies Euronext Amsterdam (.AS)', () => {
    expect(detectStockExchange('ASML.AS')).toBe('Euronext Amsterdam');
    expect(detectStockExchange('ADYEN.AS')).toBe('Euronext Amsterdam');
  });

  it('identifies Milan Borsa (.MI)', () => {
    expect(detectStockExchange('MONC.MI')).toBe('Milan (Borsa)');
  });

  it('identifies Swiss SIX (.SW)', () => {
    expect(detectStockExchange('NESN.SW')).toBe('Swiss (SIX)');
    expect(detectStockExchange('ROG.SW')).toBe('Swiss (SIX)');
  });

  it('identifies Madrid (.MC)', () => {
    expect(detectStockExchange('ITX.MC')).toBe('Madrid');
  });

  it('identifies Brussels (.BR)', () => {
    expect(detectStockExchange('INGA.BR')).toBe('Brussels');
  });

  it('identifies Helsinki (.HE)', () => {
    expect(detectStockExchange('NOKIA.HE')).toBe('Helsinki');
  });

  it('identifies Stockholm (.ST)', () => {
    expect(detectStockExchange('ERIC.ST')).toBe('Stockholm');
  });

  it('identifies Oslo (.OL)', () => {
    expect(detectStockExchange('EQNR.OL')).toBe('Oslo');
  });

  it('identifies Copenhagen (.CO)', () => {
    expect(detectStockExchange('ORSTED.CO')).toBe('Copenhagen');
  });

  it('identifies Toronto TSX (.TO)', () => {
    expect(detectStockExchange('RY.TO')).toBe('Toronto (TSX)');
  });

  it('identifies Hong Kong (.HK)', () => {
    expect(detectStockExchange('0700.HK')).toBe('Hong Kong');
  });

  it('identifies Tokyo (.T)', () => {
    expect(detectStockExchange('7203.T')).toBe('Tokyo');
  });

  it('returns US for bare tickers without suffix', () => {
    expect(detectStockExchange('AAPL')).toBe('US');
    expect(detectStockExchange('MSFT')).toBe('US');
    expect(detectStockExchange('NVDA')).toBe('US');
  });
});

// ── detectCurrency ───────────────────────────────────────────────────────────

describe('detectCurrency', () => {
  it('returns USD for US', () => {
    expect(detectCurrency('US')).toBe('USD');
  });

  it('returns EUR for Euronext Paris', () => {
    expect(detectCurrency('Euronext Paris')).toBe('EUR');
  });

  it('returns EUR for Frankfurt (XETRA)', () => {
    expect(detectCurrency('Frankfurt (XETRA)')).toBe('EUR');
  });

  it('returns EUR for Euronext Amsterdam', () => {
    expect(detectCurrency('Euronext Amsterdam')).toBe('EUR');
  });

  it('returns EUR for Milan (Borsa)', () => {
    expect(detectCurrency('Milan (Borsa)')).toBe('EUR');
  });

  it('returns EUR for Madrid', () => {
    expect(detectCurrency('Madrid')).toBe('EUR');
  });

  it('returns EUR for Brussels', () => {
    expect(detectCurrency('Brussels')).toBe('EUR');
  });

  it('returns EUR for Helsinki', () => {
    expect(detectCurrency('Helsinki')).toBe('EUR');
  });

  it('returns GBP for London (LSE)', () => {
    expect(detectCurrency('London (LSE)')).toBe('GBP');
  });

  it('returns CHF for Swiss (SIX)', () => {
    expect(detectCurrency('Swiss (SIX)')).toBe('CHF');
  });

  it('returns SEK for Stockholm', () => {
    expect(detectCurrency('Stockholm')).toBe('SEK');
  });

  it('returns NOK for Oslo', () => {
    expect(detectCurrency('Oslo')).toBe('NOK');
  });

  it('returns DKK for Copenhagen', () => {
    expect(detectCurrency('Copenhagen')).toBe('DKK');
  });

  it('returns CAD for Toronto (TSX)', () => {
    expect(detectCurrency('Toronto (TSX)')).toBe('CAD');
  });

  it('returns HKD for Hong Kong', () => {
    expect(detectCurrency('Hong Kong')).toBe('HKD');
  });

  it('returns JPY for Tokyo', () => {
    expect(detectCurrency('Tokyo')).toBe('JPY');
  });

  it('falls back to USD for unknown exchange', () => {
    expect(detectCurrency('Unknown')).toBe('USD');
    expect(detectCurrency('Some Random Exchange')).toBe('USD');
  });

  it('round-trips correctly for all exchange suffixes', () => {
    const cases = [
      ['AAPL', 'USD'],
      ['MC.PA', 'EUR'],
      ['AZN.L', 'GBP'],
      ['SAP.DE', 'EUR'],
      ['ASML.AS', 'EUR'],
      ['MONC.MI', 'EUR'],
      ['NESN.SW', 'CHF'],
      ['ITX.MC', 'EUR'],
      ['INGA.BR', 'EUR'],
      ['NOKIA.HE', 'EUR'],
      ['ERIC.ST', 'SEK'],
      ['EQNR.OL', 'NOK'],
      ['ORSTED.CO', 'DKK'],
      ['RY.TO', 'CAD'],
      ['0700.HK', 'HKD'],
      ['7203.T', 'JPY'],
    ];
    for (const [ticker, expectedCurrency] of cases) {
      expect(detectCurrency(detectStockExchange(ticker))).toBe(expectedCurrency);
    }
  });
});

// ── normalizeAssetType ───────────────────────────────────────────────────────

describe('normalizeAssetType', () => {
  // null / empty
  it('returns Stock for null', () => {
    expect(normalizeAssetType(null)).toBe('Stock');
  });

  it('returns Stock for undefined', () => {
    expect(normalizeAssetType(undefined)).toBe('Stock');
  });

  it('returns Stock for empty string', () => {
    expect(normalizeAssetType('')).toBe('Stock');
  });

  // Stock variants
  it('normalizes stock → Stock', () => {
    expect(normalizeAssetType('stock')).toBe('Stock');
  });

  it('normalizes equity → Stock', () => {
    expect(normalizeAssetType('equity')).toBe('Stock');
  });

  it('normalizes equities → Stock', () => {
    expect(normalizeAssetType('equities')).toBe('Stock');
  });

  it('normalizes share → Stock', () => {
    expect(normalizeAssetType('share')).toBe('Stock');
  });

  it('normalizes common stock → Stock', () => {
    expect(normalizeAssetType('common stock')).toBe('Stock');
  });

  it('normalizes ADR → Stock', () => {
    expect(normalizeAssetType('adr')).toBe('Stock');
  });

  it('preserves canonical Stock', () => {
    expect(normalizeAssetType('Stock')).toBe('Stock');
  });

  // ETF variants
  it('normalizes etf → ETF', () => {
    expect(normalizeAssetType('etf')).toBe('ETF');
  });

  it('normalizes fund → ETF', () => {
    expect(normalizeAssetType('fund')).toBe('ETF');
  });

  it('normalizes index fund → ETF', () => {
    expect(normalizeAssetType('index fund')).toBe('ETF');
  });

  it('normalizes mutual fund → ETF', () => {
    expect(normalizeAssetType('mutual fund')).toBe('ETF');
  });

  it('normalizes ucits → ETF', () => {
    expect(normalizeAssetType('ucits')).toBe('ETF');
  });

  it('preserves canonical ETF', () => {
    expect(normalizeAssetType('ETF')).toBe('ETF');
  });

  // Crypto variants
  it('normalizes crypto → Crypto', () => {
    expect(normalizeAssetType('crypto')).toBe('Crypto');
  });

  it('normalizes cryptocurrency → Crypto', () => {
    expect(normalizeAssetType('cryptocurrency')).toBe('Crypto');
  });

  it('normalizes token → Crypto', () => {
    expect(normalizeAssetType('token')).toBe('Crypto');
  });

  it('normalizes coin → Crypto', () => {
    expect(normalizeAssetType('coin')).toBe('Crypto');
  });

  it('preserves canonical Crypto', () => {
    expect(normalizeAssetType('Crypto')).toBe('Crypto');
  });

  // REIT variants
  it('normalizes reit → REIT', () => {
    expect(normalizeAssetType('reit')).toBe('REIT');
  });

  it('normalizes real estate → REIT', () => {
    expect(normalizeAssetType('real estate')).toBe('REIT');
  });

  it('preserves canonical REIT', () => {
    expect(normalizeAssetType('REIT')).toBe('REIT');
  });

  // Bond variants
  it('normalizes bond → Bond', () => {
    expect(normalizeAssetType('bond')).toBe('Bond');
  });

  it('normalizes fixed income → Bond', () => {
    expect(normalizeAssetType('fixed income')).toBe('Bond');
  });

  it('normalizes treasury → Bond', () => {
    expect(normalizeAssetType('treasury')).toBe('Bond');
  });

  it('normalizes government bond → Bond', () => {
    expect(normalizeAssetType('government bond')).toBe('Bond');
  });

  it('preserves canonical Bond', () => {
    expect(normalizeAssetType('Bond')).toBe('Bond');
  });

  // Commodity variants
  it('normalizes commodity → Commodity', () => {
    expect(normalizeAssetType('commodity')).toBe('Commodity');
  });

  it('normalizes commodities → Commodity', () => {
    expect(normalizeAssetType('commodities')).toBe('Commodity');
  });

  it('preserves canonical Commodity', () => {
    expect(normalizeAssetType('Commodity')).toBe('Commodity');
  });

  // Cash variants
  it('normalizes cash → Cash', () => {
    expect(normalizeAssetType('cash')).toBe('Cash');
  });

  it('normalizes money market → Cash', () => {
    expect(normalizeAssetType('money market')).toBe('Cash');
  });

  it('preserves canonical Cash', () => {
    expect(normalizeAssetType('Cash')).toBe('Cash');
  });

  // Other / fallback
  it('returns Other for unrecognized type', () => {
    expect(normalizeAssetType('something_weird')).toBe('Other');
    expect(normalizeAssetType('derivative')).toBe('Other');
    expect(normalizeAssetType('warrant')).toBe('Other');
  });

  it('is case-insensitive', () => {
    expect(normalizeAssetType('STOCK')).toBe('Stock');
    expect(normalizeAssetType('ETF')).toBe('ETF');
    expect(normalizeAssetType('Equity')).toBe('Stock');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeAssetType('  stock  ')).toBe('Stock');
    expect(normalizeAssetType('  etf  ')).toBe('ETF');
  });
});

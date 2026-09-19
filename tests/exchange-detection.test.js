import { describe, it, expect } from 'vitest';
import { detectStockExchange, detectCurrency, normalizeAssetType, buildAssetRecord } from '../services/utils.js';

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

  it('normalizes stocks (plural) → Stock', () => {
    expect(normalizeAssetType('stocks')).toBe('Stock');
  });

  it('normalizes ordinary share → Stock (UK term for common stock)', () => {
    expect(normalizeAssetType('ordinary share')).toBe('Stock');
  });

  it('normalizes ordinary shares → Stock (UK term, plural)', () => {
    expect(normalizeAssetType('ordinary shares')).toBe('Stock');
    expect(normalizeAssetType('Ordinary Shares')).toBe('Stock');
  });

  it('normalizes GDR → Stock (Global Depositary Receipt)', () => {
    expect(normalizeAssetType('gdr')).toBe('Stock');
    expect(normalizeAssetType('GDR')).toBe('Stock');
  });

  it('normalizes preferred stock → Stock', () => {
    expect(normalizeAssetType('preferred stock')).toBe('Stock');
    expect(normalizeAssetType('Preferred Stock')).toBe('Stock');
  });

  it('normalizes preference share → Stock (UK term for preferred stock)', () => {
    expect(normalizeAssetType('preference share')).toBe('Stock');
    expect(normalizeAssetType('Preference Share')).toBe('Stock');
  });

  it('normalizes Shares → Stock (AI resolver label — the chart-splitting bug)', () => {
    expect(normalizeAssetType('Shares')).toBe('Stock');
  });

  it('normalizes Shares (REIT) → REIT (AI resolver label)', () => {
    expect(normalizeAssetType('Shares (REIT)')).toBe('REIT');
    expect(normalizeAssetType('shares (reit)')).toBe('REIT');
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

  it('normalizes etp → ETF (Exchange Traded Product)', () => {
    expect(normalizeAssetType('etp')).toBe('ETF');
    expect(normalizeAssetType('ETP')).toBe('ETF');
  });

  it('normalizes exchange traded fund → ETF', () => {
    expect(normalizeAssetType('exchange traded fund')).toBe('ETF');
  });

  it('normalizes tracker → ETF (UK/European term)', () => {
    expect(normalizeAssetType('tracker')).toBe('ETF');
    expect(normalizeAssetType('Tracker')).toBe('ETF');
  });

  it('normalizes sicav → ETF (EU collective investment vehicle)', () => {
    expect(normalizeAssetType('sicav')).toBe('ETF');
    expect(normalizeAssetType('SICAV')).toBe('ETF');
  });

  it('normalizes oeic → ETF (UK open-ended investment company)', () => {
    expect(normalizeAssetType('oeic')).toBe('ETF');
    expect(normalizeAssetType('OEIC')).toBe('ETF');
  });

  it('normalizes unit trust → ETF (UK fund wrapper)', () => {
    expect(normalizeAssetType('unit trust')).toBe('ETF');
    expect(normalizeAssetType('Unit Trust')).toBe('ETF');
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

  it('normalizes digital asset → Crypto', () => {
    expect(normalizeAssetType('digital asset')).toBe('Crypto');
    expect(normalizeAssetType('Digital Asset')).toBe('Crypto');
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

  it('normalizes real estate investment trust → REIT (full legal name)', () => {
    expect(normalizeAssetType('real estate investment trust')).toBe('REIT');
    expect(normalizeAssetType('Real Estate Investment Trust')).toBe('REIT');
  });

  it('normalizes stock (reit) → REIT (AI resolver variant)', () => {
    expect(normalizeAssetType('stock (reit)')).toBe('REIT');
    expect(normalizeAssetType('Stock (REIT)')).toBe('REIT');
  });

  it('normalizes reit shares → REIT (another AI resolver variant)', () => {
    expect(normalizeAssetType('reit shares')).toBe('REIT');
    expect(normalizeAssetType('REIT Shares')).toBe('REIT');
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

  it('normalizes bonds (plural) → Bond', () => {
    expect(normalizeAssetType('bonds')).toBe('Bond');
    expect(normalizeAssetType('Bonds')).toBe('Bond');
  });

  it('normalizes debt → Bond (generic debt instrument)', () => {
    expect(normalizeAssetType('debt')).toBe('Bond');
    expect(normalizeAssetType('Debt')).toBe('Bond');
  });

  it('normalizes note → Bond (debt note)', () => {
    expect(normalizeAssetType('note')).toBe('Bond');
    expect(normalizeAssetType('Note')).toBe('Bond');
  });

  it('normalizes corporate bond → Bond', () => {
    expect(normalizeAssetType('corporate bond')).toBe('Bond');
    expect(normalizeAssetType('Corporate Bond')).toBe('Bond');
  });

  it('normalizes bond etf → Bond (bond fund alias)', () => {
    expect(normalizeAssetType('bond etf')).toBe('Bond');
    expect(normalizeAssetType('Bond ETF')).toBe('Bond');
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
  it('normalizes other → Other (explicit alias)', () => {
    expect(normalizeAssetType('other')).toBe('Other');
    expect(normalizeAssetType('Other')).toBe('Other');
  });

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

// ── buildAssetRecord ─────────────────────────────────────────────────────────

describe('buildAssetRecord', () => {
  it('returns null for null position', () => {
    expect(buildAssetRecord(null)).toBeNull();
  });

  it('returns null for undefined position', () => {
    expect(buildAssetRecord(undefined)).toBeNull();
  });

  it('returns null when symbol is missing', () => {
    expect(buildAssetRecord({ name: 'Foo', shares: 10 })).toBeNull();
  });

  it('returns null when symbol is empty string', () => {
    expect(buildAssetRecord({ symbol: '' })).toBeNull();
  });

  it('upcases the ticker', () => {
    const rec = buildAssetRecord({ symbol: 'aapl' });
    expect(rec.ticker).toBe('AAPL');
  });

  it('returns minimal valid shape for a US symbol', () => {
    const rec = buildAssetRecord({ symbol: 'AAPL' });
    expect(rec).toMatchObject({
      ticker: 'AAPL',
      stock_exchange: 'US',
      currency: 'USD',
      asset_type: 'Stock',
      untracked: false,
    });
    expect(typeof rec.name).toBe('string');
    expect(typeof rec.sector).toBe('string');
  });

  it('uses position.name when provided', () => {
    const rec = buildAssetRecord({ symbol: 'MSFT', name: 'Microsoft Corp' });
    expect(rec.name).toBe('Microsoft Corp');
  });

  it('falls back to ticker as name when name is absent', () => {
    const rec = buildAssetRecord({ symbol: 'NVDA' });
    expect(rec.name).toBe('NVDA');
  });

  it('respects position.type for asset_type', () => {
    const rec = buildAssetRecord({ symbol: 'SPY', type: 'ETF' });
    expect(rec.asset_type).toBe('ETF');
  });

  it('defaults asset_type to Stock when type is absent', () => {
    const rec = buildAssetRecord({ symbol: 'AAPL' });
    expect(rec.asset_type).toBe('Stock');
  });

  it('detects European exchange and currency from suffix', () => {
    const rec = buildAssetRecord({ symbol: 'AIR.PA' });
    expect(rec.stock_exchange).toBe('Euronext Paris');
    expect(rec.currency).toBe('EUR');
  });

  // ── untracked field (added PR #211) ────────────────────────────────────────

  it('untracked defaults to false when field is absent', () => {
    const rec = buildAssetRecord({ symbol: 'AAPL' });
    expect(rec.untracked).toBe(false);
  });

  it('untracked: false → false', () => {
    const rec = buildAssetRecord({ symbol: 'AAPL', untracked: false });
    expect(rec.untracked).toBe(false);
  });

  it('untracked: true → true', () => {
    const rec = buildAssetRecord({ symbol: 'AAPL', untracked: true });
    expect(rec.untracked).toBe(true);
  });

  it('untracked: null coerced to false via !!', () => {
    const rec = buildAssetRecord({ symbol: 'AAPL', untracked: null });
    expect(rec.untracked).toBe(false);
  });

  it('untracked: 1 coerced to true via !!', () => {
    const rec = buildAssetRecord({ symbol: 'AAPL', untracked: 1 });
    expect(rec.untracked).toBe(true);
  });

  it('untracked: 0 coerced to false via !!', () => {
    const rec = buildAssetRecord({ symbol: 'AAPL', untracked: 0 });
    expect(rec.untracked).toBe(false);
  });

  // ── type normalization via normalizeAssetType (PR #224 fix) ─────────────────
  // These verify that raw broker/AI type strings stored in the DB are normalized
  // at the buildAssetRecord boundary — the bug that split 'Shares' and 'Stock'
  // into separate allocation chart buckets.

  it('normalizes type Shares → asset_type Stock', () => {
    const rec = buildAssetRecord({ symbol: 'AAPL', type: 'Shares' });
    expect(rec.asset_type).toBe('Stock');
  });

  it('normalizes type Ordinary Shares → asset_type Stock', () => {
    const rec = buildAssetRecord({ symbol: 'VOD.L', type: 'Ordinary Shares' });
    expect(rec.asset_type).toBe('Stock');
  });

  it('normalizes type GDR → asset_type Stock', () => {
    const rec = buildAssetRecord({ symbol: 'BABA', type: 'GDR' });
    expect(rec.asset_type).toBe('Stock');
  });

  it('normalizes type Preferred Stock → asset_type Stock', () => {
    const rec = buildAssetRecord({ symbol: 'BRK.A', type: 'Preferred Stock' });
    expect(rec.asset_type).toBe('Stock');
  });

  it('normalizes type Shares (REIT) → asset_type REIT', () => {
    const rec = buildAssetRecord({ symbol: 'VNQ', type: 'Shares (REIT)' });
    expect(rec.asset_type).toBe('REIT');
  });

  it('normalizes type Stock (REIT) → asset_type REIT', () => {
    const rec = buildAssetRecord({ symbol: 'O', type: 'Stock (REIT)' });
    expect(rec.asset_type).toBe('REIT');
  });

  it('normalizes type REIT Shares → asset_type REIT', () => {
    const rec = buildAssetRecord({ symbol: 'PLD', type: 'REIT Shares' });
    expect(rec.asset_type).toBe('REIT');
  });

  it('normalizes type UCITS → asset_type ETF', () => {
    const rec = buildAssetRecord({ symbol: 'VWRL.L', type: 'UCITS' });
    expect(rec.asset_type).toBe('ETF');
  });
});

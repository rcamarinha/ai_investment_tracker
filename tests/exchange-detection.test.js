import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});

// ── resolveAssetCurrency ──────────────────────────────────────────────────────
//
// This replaced a fallthrough to detectStockExchange('') → 'US' → 'USD', which
// was giving every bare ISIN (typically bought in EUR on a European exchange) a
// USD cost basis and a 0.92× conversion. DeGiro exports ISINs, not tickers, so
// the old code silently mis-valued every DeGiro holding.

import { resolveAssetCurrency, toBaseCurrency } from '../services/utils.js';
import state from '../services/state.js';

describe('resolveAssetCurrency', () => {
    beforeEach(() => {
        state.assetDatabase = {};
    });
    afterEach(() => {
        state.assetDatabase = {};
    });

    it('returns null for a missing symbol', () => {
        expect(resolveAssetCurrency(null)).toEqual({ code: null, source: null });
        expect(resolveAssetCurrency('')).toEqual({ code: null, source: null });
        expect(resolveAssetCurrency(undefined)).toEqual({ code: null, source: null });
    });

    it('derives USD for a bare US ticker with no DB entry', () => {
        expect(resolveAssetCurrency('AAPL')).toEqual({ code: 'USD', source: 'suffix' });
    });

    it('derives EUR for a Euronext Paris ticker', () => {
        expect(resolveAssetCurrency('AIR.PA')).toEqual({ code: 'EUR', source: 'suffix' });
    });

    it('derives GBP for a London ticker', () => {
        expect(resolveAssetCurrency('AZN.L')).toEqual({ code: 'GBP', source: 'suffix' });
    });

    it('returns null for a bare ISIN with no DB entry — never falls through to USD', () => {
        // The old code returned USD here, giving every DeGiro holding a wrong currency.
        expect(resolveAssetCurrency('DE0007164600')).toEqual({ code: null, source: null });
        expect(resolveAssetCurrency('FR0000131104')).toEqual({ code: null, source: null });
    });

    it('follows pricingTicker for a DB-known ISIN to derive the venue currency', () => {
        state.assetDatabase['FR0000131104'] = { pricingTicker: 'BNP.PA', currency: null };
        expect(resolveAssetCurrency('FR0000131104')).toEqual({ code: 'EUR', source: 'suffix' });
    });

    it('returns null when pricingTicker is itself an ISIN (no venue info)', () => {
        state.assetDatabase['FR0000131104'] = { pricingTicker: 'DE0007164600', currency: null };
        expect(resolveAssetCurrency('FR0000131104')).toEqual({ code: null, source: null });
    });

    it('uses the explicit DB currency when present, over suffix derivation', () => {
        state.assetDatabase['AAPL'] = { currency: 'EUR', currency_source: 'user_override' };
        expect(resolveAssetCurrency('AAPL')).toEqual({ code: 'EUR', source: 'user_override' });
    });

    it('defaults currency_source to "profile" when absent from the DB row', () => {
        state.assetDatabase['AAPL'] = { currency: 'USD' };
        expect(resolveAssetCurrency('AAPL')).toEqual({ code: 'USD', source: 'profile' });
    });

    it('normalises pence GBp to the major-unit code GBP', () => {
        state.assetDatabase['HSBA.L'] = { currency: 'GBp', currency_source: 'quote' };
        const r = resolveAssetCurrency('HSBA.L');
        // normalizeCurrencyCode folds minor-unit codes: GBp → { iso:'GBP', factor:0.01 }
        // resolveAssetCurrency returns norm.iso, which is 'GBP'
        expect(r.code).toBe('GBP');
        expect(r.source).toBe('quote');
    });

    it('looks up the DB key case-insensitively (keys stored upper-case)', () => {
        state.assetDatabase['AAPL'] = { currency: 'USD', currency_source: 'profile' };
        expect(resolveAssetCurrency('aapl')).toEqual({ code: 'USD', source: 'profile' });
    });
});

// ── toBaseCurrency ────────────────────────────────────────────────────────────
//
// Returns null on missing rates rather than the unconverted amount.  The old
// "return amount" fallback is what turned "we don't know" into a confident wrong
// total that flowed into snapshots and the hub.

describe('toBaseCurrency', () => {
    beforeEach(() => {
        state.baseCurrency = 'EUR';
        state.exchangeRates = { USD: 1.1, GBP: 1.18 };
    });
    afterEach(() => {
        state.baseCurrency = 'EUR';
        state.exchangeRates = {};
    });

    it('converts USD to EUR using the stored rate', () => {
        expect(toBaseCurrency(100, 'USD', 'EUR')).toBeCloseTo(110);
    });

    it('returns the amount unchanged for a same-currency conversion', () => {
        expect(toBaseCurrency(100, 'EUR', 'EUR')).toBe(100);
    });

    it('converts GBP to EUR', () => {
        expect(toBaseCurrency(100, 'GBP', 'EUR')).toBeCloseTo(118);
    });

    it('folds GBp (pence) to pounds before converting to EUR', () => {
        // 100 GBp = 1 GBP × 1.18 EUR/GBP = 1.18 EUR
        expect(toBaseCurrency(100, 'GBp', 'EUR')).toBeCloseTo(1.18);
    });

    it('also folds GBX pence to pounds before converting', () => {
        expect(toBaseCurrency(200, 'GBX', 'EUR')).toBeCloseTo(2.36);
    });

    it('returns null for an unrecognised currency', () => {
        expect(toBaseCurrency(100, 'XYZ', 'EUR')).toBeNull();
    });

    it('returns null when the exchange rate is not available', () => {
        expect(toBaseCurrency(100, 'CAD', 'EUR')).toBeNull();
    });

    it('returns null for a non-finite amount', () => {
        expect(toBaseCurrency(NaN, 'USD', 'EUR')).toBeNull();
        expect(toBaseCurrency(Infinity, 'USD', 'EUR')).toBeNull();
        expect(toBaseCurrency(undefined, 'USD', 'EUR')).toBeNull();
    });

    it('uses state.baseCurrency as the default target when not supplied', () => {
        // state.baseCurrency = 'EUR', so toBaseCurrency(100, 'USD') === 110
        expect(toBaseCurrency(100, 'USD')).toBeCloseTo(110);
    });

    it('converts to a non-EUR target base via the rate ratio', () => {
        // 100 USD → EUR at 1.1, then GBP at 1.18:  100 × (1.1 / 1.18) ≈ 93.22
        const result = toBaseCurrency(100, 'USD', 'GBP');
        expect(result).toBeCloseTo(100 * (1.1 / 1.18), 4);
    });

    it('returns null for missing target rate in a cross-base conversion', () => {
        expect(toBaseCurrency(100, 'USD', 'CAD')).toBeNull();
    });
});

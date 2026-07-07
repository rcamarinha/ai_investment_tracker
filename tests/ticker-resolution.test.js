import { describe, it, expect } from 'vitest';
import {
  buildAlternativeSymbols,
  normalizeForPricing,
  parseFmpBatchResponse,
  isPriceFresh,
  extractLlmJsonArray,
  classifyFmpBatchText,
} from '../src/portfolio.js';

describe('normalizeForPricing', () => {
  it('remaps Finnhub-style suffixes to FMP/Yahoo format', () => {
    expect(normalizeForPricing('AEU.FRK')).toBe('AEU.DE');
    expect(normalizeForPricing('CITY.AMS')).toBe('CITY.AS');
    expect(normalizeForPricing('X.PAR')).toBe('X.PA');
    expect(normalizeForPricing('Y.MIL')).toBe('Y.MI');
    expect(normalizeForPricing('Z.SWX')).toBe('Z.SW');
  });
  it('passes already-valid suffixes through unchanged', () => {
    expect(normalizeForPricing('BCP.LS')).toBe('BCP.LS');
    expect(normalizeForPricing('MC.PA')).toBe('MC.PA');
    expect(normalizeForPricing('AAPL')).toBe('AAPL');
  });
});

describe('buildAlternativeSymbols', () => {
  describe('exchange suffix handling', () => {
    it('adds all exchange suffixes for a bare symbol', () => {
      const result = buildAlternativeSymbols('LVMH');
      expect(result).toContain('LVMH.PA');
      expect(result).toContain('LVMH.L');
      expect(result).toContain('LVMH.DE');
      expect(result).toContain('LVMH.MC');
      expect(result).toContain('LVMH.SW');
      expect(result).toContain('LVMH.AS');
      expect(result).toContain('LVMH.MI');
      expect(result).toContain('LVMH.BR');
      expect(result).toContain('LVMH.HE');
      expect(result).toContain('LVMH.ST');
      expect(result).toContain('LVMH.OL');
      expect(result).toContain('LVMH.CO');
    });

    it('remaps an unrecognized suffix and fans the base across EU exchanges', () => {
      const result = buildAlternativeSymbols('AEU.FRK');
      expect(result).toContain('AEU.DE');   // the remapped suffix (top candidate)
      expect(result).toContain('AEU.PA');    // fanned out
      expect(result).toContain('AEU');       // bare base (US/ADR) last
    });

    it('still tries other exchanges + base for an already-valid suffix', () => {
      const result = buildAlternativeSymbols('MC.PA');
      expect(result).toContain('MC.DE');
      expect(result).toContain('MC.AS');
      expect(result).toContain('MC');
    });
  });

  describe('smart ticker mappings', () => {
    it('maps LVMH to MC.PA and LVMUY', () => {
      const result = buildAlternativeSymbols('LVMH', 'LVMH Moet Hennessy');
      expect(result).toContain('MC.PA');
      expect(result).toContain('LVMUY');
    });

    it('maps Nestle to NESN.SW and NSRGY', () => {
      const result = buildAlternativeSymbols('NESTLE', 'Nestle SA');
      expect(result).toContain('NESN.SW');
      expect(result).toContain('NSRGY');
    });

    it('maps ASML to ASML.AS', () => {
      const result = buildAlternativeSymbols('XYZ', 'ASML Holding NV');
      expect(result).toContain('ASML.AS');
      expect(result).toContain('ASML');
    });

    it('maps Airbus to AIR.PA', () => {
      const result = buildAlternativeSymbols('AIR', 'Airbus SE');
      expect(result).toContain('AIR.PA');
      expect(result).toContain('EADSY');
    });

    it('maps Hermes to RMS.PA', () => {
      const result = buildAlternativeSymbols('RMS', 'Hermes International');
      expect(result).toContain('RMS.PA');
      expect(result).toContain('HESAY');
    });

    it('maps Roche to ROG.SW', () => {
      const result = buildAlternativeSymbols('ROG', 'Roche Holding AG');
      expect(result).toContain('ROG.SW');
      expect(result).toContain('RHHBY');
    });

    it('maps TotalEnergies to TTE.PA', () => {
      const result = buildAlternativeSymbols('TTE', 'TotalEnergies SE');
      expect(result).toContain('TTE.PA');
      expect(result).toContain('TTE');
    });

    it('maps Schneider to SU.PA', () => {
      const result = buildAlternativeSymbols('SU', 'Schneider Electric SE');
      expect(result).toContain('SU.PA');
      expect(result).toContain('SBGSF');
    });

    it('maps Cellnex to CLNX.MC', () => {
      const result = buildAlternativeSymbols('CEL', 'Cellnex Telecom SA');
      expect(result).toContain('CLNX');
      expect(result).toContain('CLNX.MC');
    });

    it('maps Prosus to PRX.AS', () => {
      const result = buildAlternativeSymbols('PRX', 'Prosus NV');
      expect(result).toContain('PRX.AS');
      expect(result).toContain('PROSUS');
    });

    it('maps Adyen to ADYEN.AS', () => {
      const result = buildAlternativeSymbols('ADY', 'Adyen NV');
      expect(result).toContain('ADYEN.AS');
      expect(result).toContain('ADYEY');
    });

    it('maps Novartis to NOVN.SW', () => {
      const result = buildAlternativeSymbols('NOV', 'Novartis AG');
      expect(result).toContain('NOVN.SW');
      expect(result).toContain('NVS');
    });

    it('maps Moncler to MONC.MI', () => {
      const result = buildAlternativeSymbols('MON', 'Moncler SPA');
      expect(result).toContain('MONC.MI');
      expect(result).toContain('MONRF');
    });

    it('maps Covestro to 1COV.DE', () => {
      const result = buildAlternativeSymbols('COV', 'Covestro AG');
      expect(result).toContain('1COV.DE');
      expect(result).toContain('COV.DE');
    });

    it('maps Sartorius to SRT.DE', () => {
      const result = buildAlternativeSymbols('SRT', 'Sartorius AG');
      expect(result).toContain('SRT.DE');
      expect(result).toContain('SRT3.DE');
    });
  });

  describe('first-word company name as ticker', () => {
    it('tries first word of company name if 3-6 chars', () => {
      const result = buildAlternativeSymbols('XYZ', 'Shell International PLC');
      expect(result).toContain('SHELL');
    });

    it('does not try first word if shorter than 3 chars', () => {
      const result = buildAlternativeSymbols('XYZ', 'AB Company');
      expect(result).not.toContain('AB');
    });

    it('does not try first word if longer than 6 chars', () => {
      const result = buildAlternativeSymbols('XYZ', 'Berkshire Hathaway');
      // "Berkshire" is 9 chars, should not be added
      expect(result).not.toContain('BERKSHIRE');
    });

    it('strips legal suffixes before extracting first word', () => {
      const result = buildAlternativeSymbols('XYZ', 'Nokia OYJ');
      // baseName should be "Nokia", firstWord = "Nokia" (5 chars)
      expect(result).toContain('NOKIA');
    });
  });

  describe('deduplication', () => {
    it('returns unique symbols only', () => {
      const result = buildAlternativeSymbols('ASML', 'ASML Holding NV');
      // ASML.AS appears both from exchange suffix and smart mapping
      const asDupes = result.filter((s) => s === 'ASML.AS');
      expect(asDupes.length).toBe(1);
    });
  });

  describe('no asset name', () => {
    it('still returns exchange suffix alternatives', () => {
      const result = buildAlternativeSymbols('TEST');
      expect(result.length).toBe(12); // 12 exchange suffixes
      expect(result[0]).toBe('TEST.PA');
    });

    it('returns no smart mappings when assetName equals symbol', () => {
      const result = buildAlternativeSymbols('TEST', 'TEST');
      // assetName === originalSymbol → skips Strategy 2
      expect(result.length).toBe(12);
    });
  });
});

describe('parseFmpBatchResponse', () => {
  it('maps valid positive prices keyed by uppercased symbol', () => {
    const out = parseFmpBatchResponse([
      { symbol: 'AAPL', price: 150.2 },
      { symbol: 'tte.pa', price: 62.5 },
    ]);
    expect(out).toEqual({ AAPL: 150.2, 'TTE.PA': 62.5 });
  });
  it('drops zero / non-numeric prices', () => {
    const out = parseFmpBatchResponse([{ symbol: 'X', price: 0 }, { symbol: 'Y', price: 'n/a' }, { symbol: 'Z' }]);
    expect(out).toEqual({});
  });
  it('returns {} for FMP error shapes and non-arrays', () => {
    expect(parseFmpBatchResponse({ 'Error Message': 'Invalid API KEY' })).toEqual({});
    expect(parseFmpBatchResponse(null)).toEqual({});
    expect(parseFmpBatchResponse([])).toEqual({});
  });
});

describe('isPriceFresh', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const WIN = 15 * 60 * 1000;
  it('true for a live success within the window', () => {
    const meta = { success: true, source: 'FMP', timestamp: new Date(now - 5 * 60 * 1000).toISOString() };
    expect(isPriceFresh(meta, WIN, now)).toBe(true);
  });
  it('false when older than the window', () => {
    const meta = { success: true, source: 'FMP', timestamp: new Date(now - 20 * 60 * 1000).toISOString() };
    expect(isPriceFresh(meta, WIN, now)).toBe(false);
  });
  it('false for DB-cached, failed, or missing meta', () => {
    expect(isPriceFresh({ success: true, source: 'FMP (cached)', timestamp: new Date(now).toISOString() }, WIN, now)).toBe(false);
    expect(isPriceFresh({ success: false, source: 'FMP', timestamp: new Date(now).toISOString() }, WIN, now)).toBe(false);
    expect(isPriceFresh(null, WIN, now)).toBe(false);
  });
});

// ── extractLlmJsonArray ──────────────────────────────────────────────────────
// Mirrors the inline fence-strip + bracket-find logic inside resolveTickersViaAI
// in services/pricing.js. A misparse silently drops all AI ticker suggestions,
// leaving EU/exotic holdings permanently unpriced without any error signal.

describe('extractLlmJsonArray', () => {
  it('passes a bare JSON array straight through', () => {
    const input = '[{"ticker":"AAPL","input":"AAPL"},{"ticker":"MC.PA","input":"MC"}]';
    const result = extractLlmJsonArray(input);
    expect(result).toEqual([
      { ticker: 'AAPL', input: 'AAPL' },
      { ticker: 'MC.PA', input: 'MC' },
    ]);
  });

  it('strips a ```json ... ``` code fence', () => {
    const input = '```json\n[{"ticker":"NESN.SW","input":"NESN"}]\n```';
    const result = extractLlmJsonArray(input);
    expect(result).toEqual([{ ticker: 'NESN.SW', input: 'NESN' }]);
  });

  it('strips a plain ``` ... ``` code fence', () => {
    const input = '```\n[{"ticker":"SAP.DE","input":"SAP"}]\n```';
    const result = extractLlmJsonArray(input);
    expect(result).toEqual([{ ticker: 'SAP.DE', input: 'SAP' }]);
  });

  it('extracts an array embedded in a prose preamble', () => {
    const input = 'Here are the tickers I found:\n[{"ticker":"TTE.PA","input":"TTE"},{"ticker":"AIR.PA","input":"AIR"}]\nLet me know if you need more.';
    const result = extractLlmJsonArray(input);
    expect(result).toEqual([
      { ticker: 'TTE.PA', input: 'TTE' },
      { ticker: 'AIR.PA', input: 'AIR' },
    ]);
  });

  it('handles an array that includes an optional price field', () => {
    const input = '[{"ticker":"BCP.LS","input":"BCP","price":0.285}]';
    const result = extractLlmJsonArray(input);
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(0.285);
  });

  it('returns [] for a JSON object with no array brackets', () => {
    expect(extractLlmJsonArray('{"error":"quota exceeded"}')).toEqual([]);
  });

  it('returns [] for null input', () => {
    expect(extractLlmJsonArray(null)).toEqual([]);
  });

  it('returns [] for undefined input', () => {
    expect(extractLlmJsonArray(undefined)).toEqual([]);
  });

  it('returns [] for an empty string', () => {
    expect(extractLlmJsonArray('')).toEqual([]);
  });

  it('returns [] for a string that contains no valid JSON', () => {
    expect(extractLlmJsonArray('Sorry, I could not find any tickers.')).toEqual([]);
  });

  it('returns [] for malformed JSON that has brackets', () => {
    expect(extractLlmJsonArray('[{broken json here')).toEqual([]);
  });

  it('takes the outermost brackets when arrays are nested', () => {
    // The first [ and last ] together encompass the full structure
    const input = '[{"ticker":"AAPL","alternates":["AAPL.US","AAPL"]}]';
    const result = extractLlmJsonArray(input);
    expect(result).toHaveLength(1);
    expect(result[0].ticker).toBe('AAPL');
    expect(Array.isArray(result[0].alternates)).toBe(true);
  });
});

// ── classifyFmpBatchText ──────────────────────────────────────────────────────
// Mirrors the text-first / non-JSON detection in batchFetchFMP() introduced in
// PR #206. On free plans the FMP comma-list endpoint returns a plain-text
// "Premium Query Parameter…" notice with HTTP 200, which looks like success
// but is not JSON. Failing to detect this caused batchFetchFMP to throw, never
// set the fmpBatchUnsupported flag, and silently retry the doomed request on
// every subsequent refresh.

describe('classifyFmpBatchText', () => {
  it('marks a valid JSON array as supported and returns the parsed data', () => {
    const text = JSON.stringify([{ symbol: 'AAPL', price: 175.2 }, { symbol: 'MC.PA', price: 62.5 }]);
    const result = classifyFmpBatchText(text);
    expect(result.unsupported).toBe(false);
    expect(result.json).toEqual([{ symbol: 'AAPL', price: 175.2 }, { symbol: 'MC.PA', price: 62.5 }]);
  });

  it('marks an empty array as supported (no prices but not a plan limit)', () => {
    const result = classifyFmpBatchText('[]');
    expect(result.unsupported).toBe(false);
    expect(result.json).toEqual([]);
  });

  it('marks a plain-text premium notice as unsupported', () => {
    const result = classifyFmpBatchText('Premium Query Parameter. This endpoint is not available under your current subscription plan.');
    expect(result.unsupported).toBe(true);
  });

  it('marks a JSON error object (FMP "Error Message" shape) as unsupported', () => {
    const result = classifyFmpBatchText(JSON.stringify({ 'Error Message': 'Invalid API key.' }));
    expect(result.unsupported).toBe(true);
  });

  it('marks a partial / truncated JSON string as unsupported', () => {
    const result = classifyFmpBatchText('[{"symbol":"AAPL","price":');
    expect(result.unsupported).toBe(true);
  });

  it('marks a JSON null as unsupported', () => {
    const result = classifyFmpBatchText('null');
    expect(result.unsupported).toBe(true);
  });

  it('marks an empty string as unsupported', () => {
    const result = classifyFmpBatchText('');
    expect(result.unsupported).toBe(true);
  });

  it('marks a plain number as unsupported', () => {
    const result = classifyFmpBatchText('404');
    expect(result.unsupported).toBe(true);
  });

  it('result json field is present on a JSON object for diagnostics', () => {
    const obj = { 'Error Message': 'Premium' };
    const result = classifyFmpBatchText(JSON.stringify(obj));
    expect(result.unsupported).toBe(true);
    expect(result.json).toEqual(obj);
  });
});

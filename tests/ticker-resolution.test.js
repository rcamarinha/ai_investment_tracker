import { describe, it, expect } from 'vitest';
import { buildAlternativeSymbols } from '../src/portfolio.js';

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

    it('strips suffix for a symbol that already has one', () => {
      const result = buildAlternativeSymbols('MC.PA');
      expect(result).toEqual(['MC']);
    });

    it('strips suffix for London exchange', () => {
      const result = buildAlternativeSymbols('VOD.L');
      expect(result).toEqual(['VOD']);
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

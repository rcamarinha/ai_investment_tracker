import { describe, it, expect } from 'vitest';
import {
    detectStandardFormat, parseOfx, parseOfxDate, parseOfxAmount, parseStandard
} from '../services/import-standards.js';

// OFX 1.x — SGML, unclosed tags. What most consumer banks still emit.
const OFX_1 = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>EUR
<BANKACCTFROM><BANKID>0033<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260301<DTEND>20260331
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260305120000.000[-1:CET]
<TRNAMT>-42.10
<FITID>202603050001
<NAME>CONTINENTE COLOMBO
<MEMO>COMPRA C DEB
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260325
<TRNAMT>2400.00
<FITID>202603250002
<NAME>ORDENADO
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>3528.45<DTASOF>20260331</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

// OFX 2.x — real XML, closing tags.
const OFX_2 = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
  <CURDEF>USD</CURDEF>
  <BANKACCTFROM><BANKID>121000248</BANKID><ACCTID>9876</ACCTID></BANKACCTFROM>
  <BANKTRANLIST>
    <STMTTRN>
      <TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260114</DTPOSTED>
      <TRNAMT>-8.90</TRNAMT><FITID>abc-1</FITID><NAME>Uber</NAME>
    </STMTTRN>
  </BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe('detectStandardFormat', () => {
    it('recognises OFX in both dialects', () => {
        expect(detectStandardFormat(OFX_1)).toBe('ofx');
        expect(detectStandardFormat(OFX_2)).toBe('ofx');
    });

    it('recognises the formats not yet implemented, so they can be reported', () => {
        expect(detectStandardFormat('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">')).toBe('camt053');
        expect(detectStandardFormat(':20:STMT001\n:25:1234\n:61:2603050305D42,10NTRF')).toBe('mt940');
    });

    it('returns null for a CSV, so the tabular path still gets it', () => {
        expect(detectStandardFormat('Data;Descricao;Montante\n05-03-2026;X;-1,00')).toBeNull();
        expect(detectStandardFormat('')).toBeNull();
    });
});

describe('parseOfxDate', () => {
    it('keeps only the calendar date, discarding time and timezone', () => {
        // Carrying a timezone would let one transaction land on different days
        // for different readers.
        expect(parseOfxDate('20260305120000.000[-1:CET]')).toBe('2026-03-05');
        expect(parseOfxDate('20260305')).toBe('2026-03-05');
    });
    it('rejects an impossible date rather than rolling it forward', () => {
        expect(parseOfxDate('20260231')).toBeNull();
        expect(parseOfxDate('nonsense')).toBeNull();
    });
});

describe('parseOfxAmount', () => {
    it('reads plain signed decimals', () => {
        expect(parseOfxAmount('-42.10')).toBe(-42.1);
        expect(parseOfxAmount('2400.00')).toBe(2400);
    });
    it('tolerates writers that emit a comma decimal', () => {
        expect(parseOfxAmount('-42,10')).toBe(-42.1);
    });
    it('rejects junk', () => {
        expect(parseOfxAmount('abc')).toBeNaN();
        expect(parseOfxAmount(null)).toBeNaN();
    });
});

describe('parseOfx', () => {
    it('parses an SGML file with no closing tags and no configuration at all', () => {
        // The whole point of this tier: no profile, no mapping dialog, no AI.
        const r = parseOfx(OFX_1, { accountId: 'a1' });
        expect(r.errors).toEqual([]);
        expect(r.rows).toHaveLength(2);
        expect(r.rows[0]).toMatchObject({
            date: '2026-03-05', amount: -42.1, currency: 'EUR',
            merchant: 'CONTINENTE COLOMBO', accountId: 'a1', sourceRole: 'statement'
        });
    });

    it('needs no sign translation — OFX already signs outflows negative', () => {
        const r = parseOfx(OFX_1);
        expect(r.rows.map(x => x.amount)).toEqual([-42.1, 2400]);
    });

    it('combines NAME and MEMO, since the categoriser reads the description', () => {
        expect(parseOfx(OFX_1).rows[0].description).toBe('CONTINENTE COLOMBO — COMPRA C DEB');
    });

    it('does not repeat MEMO when it merely echoes NAME', () => {
        const echoed = OFX_1.replace('<MEMO>COMPRA C DEB', '<MEMO>CONTINENTE COLOMBO');
        expect(parseOfx(echoed).rows[0].description).toBe('CONTINENTE COLOMBO');
    });

    it('carries the bank\'s own transaction id', () => {
        expect(parseOfx(OFX_1).rows[0].externalId).toBe('202603050001');
    });

    it('parses the XML dialect identically', () => {
        const r = parseOfx(OFX_2);
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0]).toMatchObject({ date: '2026-01-14', amount: -8.9, currency: 'USD', merchant: 'Uber' });
    });

    it('takes the currency from the statement, not a guess', () => {
        expect(parseOfx(OFX_1).rows[0].currency).toBe('EUR');
        expect(parseOfx(OFX_2).rows[0].currency).toBe('USD');
    });

    it('reports the account the statement belongs to', () => {
        expect(parseOfx(OFX_1).accounts[0]).toMatchObject({ acctId: '000123456789', bankId: '0033' });
    });

    it('does not read the closing balance as a transaction', () => {
        // LEDGERBAL/BALAMT sits outside STMTTRN and must not become a row.
        expect(parseOfx(OFX_1).rows.map(r => r.amount)).not.toContain(3528.45);
    });

    it('keeps each statement in a multi-account file on its own currency', () => {
        const two = OFX_1.replace('</OFX>', `
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>GBP
<BANKACCTFROM><BANKID>99<ACCTID>555</BANKACCTFROM>
<STMTTRN><DTPOSTED>20260401<TRNAMT>-5.00<FITID>z1<NAME>Tea</STMTTRN>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);
        const r = parseOfx(two);
        expect(r.rows).toHaveLength(3);
        expect(r.rows.find(x => x.merchant === 'Tea').currency).toBe('GBP');
        expect(r.rows.find(x => x.merchant === 'ORDENADO').currency).toBe('EUR');
    });

    it('reports a malformed transaction instead of dropping it silently', () => {
        const broken = OFX_1.replace('<TRNAMT>-42.10', '<TRNAMT>not-a-number');
        const r = parseOfx(broken);
        expect(r.rows).toHaveLength(1);
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0].reason).toMatch(/amount/);
    });

    it('handles an empty or transaction-free file without throwing', () => {
        expect(parseOfx('')).toMatchObject({ rows: [], errors: [] });
        expect(parseOfx('<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>').rows).toEqual([]);
    });

    it('is deterministic — parsing twice gives identical rows', () => {
        expect(parseOfx(OFX_1).rows).toEqual(parseOfx(OFX_1).rows);
    });
});

describe('parseStandard', () => {
    it('dispatches OFX', () => {
        expect(parseStandard(OFX_1).format).toBe('ofx');
    });

    it('returns null for a tabular file so the profile path handles it', () => {
        expect(parseStandard('Data;Valor\n05-03-2026;-1,00')).toBeNull();
    });

    it('names a recognised but unimplemented format rather than failing silently', () => {
        const r = parseStandard('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"/>');
        expect(r).toMatchObject({ format: 'camt053', unsupported: true });
        expect(r.message).toMatch(/CAMT053/);
    });
});

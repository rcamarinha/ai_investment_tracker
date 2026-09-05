import { describe, it, expect } from 'vitest';
import {
    groupIntoLines, findCandidateLines, findSectionHeadings, checkBalanceChain,
    proposeLinePattern, detectStatementYear, parseWithLineProfile, buildPdfDraft, LINE_PATTERNS
} from '../services/import-pdf.js';

// pdf.js item shape: { str, transform: [a,b,c,d,x,y] }
const item = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y] });

// Real reconstructed lines from a Bankinter statement (identifiers altered).
const BANKINTER = [
    'Extracto Nº 301/200073864/01/26',
    'Período a que se referem as informações prestadas no presente extrato: de 2026/01/01 a 2026/01/31',
    'Data Descritivo Data Valor Movimento Cred. / Deb. Saldo',
    '26/01 Compra 2061936.97 ana aeroportos 26/01 -11,00 7.685,81',
    '26/01 Transf imediata p/ maria a m a quinta 26/01 -135,00 7.550,81',
    '26/01 Trf a credito sepa+ - bandeira pinto e camarin - ven 26/01 690,00 8.240,81',
    '30/01 Lev 2061936.42 r diogo botelho 30/01 -150,00 8.090,81',
    '31/01 Compra 2061936.98 hipay 31/01 -7,53 8.083,28',
    'Saldo em 2026/01/31 8.083,28'
].map((text, i) => ({ text, y: 700 - i * 12, xs: [65] }));

describe('groupIntoLines', () => {
    it('rebuilds printed lines from positioned fragments', () => {
        // The existing reader does items.map(i => i.str).join(' '), which throws
        // the coordinates away and flattens the page into one unreadable line.
        const lines = groupIntoLines([
            item('26/01', 65, 700), item('Compra ana aeroportos', 120, 700),
            item('-11,00', 336, 700), item('7.685,81', 430, 700),
            item('30/01', 65, 688), item('Lev r diogo', 120, 688), item('-150,00', 336, 688)
        ]);
        expect(lines).toHaveLength(2);
        expect(lines[0].text).toBe('26/01 Compra ana aeroportos -11,00 7.685,81');
        expect(lines[1].text).toBe('30/01 Lev r diogo -150,00');
    });

    it('tolerates baseline drift within a line', () => {
        // Different fonts on one printed row differ by a point or two; exact
        // grouping would shatter the row into fragments.
        const lines = groupIntoLines([
            item('26/01', 65, 700), item('Compra', 120, 700.8), item('-11,00', 336, 699.4)
        ]);
        expect(lines).toHaveLength(1);
        expect(lines[0].text).toBe('26/01 Compra -11,00');
    });

    it('orders lines top-to-bottom and fragments left-to-right', () => {
        const lines = groupIntoLines([
            item('second', 200, 600), item('B', 300, 700), item('A', 100, 700)
        ]);
        expect(lines.map(l => l.text)).toEqual(['A B', 'second']);
    });

    it('keeps a whole printed row together, columns and all', () => {
        // Deliberately NOT split by x gap — see the note in groupIntoLines.
        // The description-to-amount gap within one row is as large as the gap
        // between two side-by-side sections, so a threshold strips amounts off
        // legitimate rows while appearing to improve coverage.
        const lines = groupIntoLines([
            item('26/01', 65, 700), item('Compra ana aeroportos', 120, 700),
            item('-11,00', 336, 700), item('7.685,81', 430, 700)
        ]);
        expect(lines).toHaveLength(1);
        expect(lines[0].text).toBe('26/01 Compra ana aeroportos -11,00 7.685,81');
    });

    it('ignores blank fragments and malformed items', () => {
        expect(groupIntoLines([item('   ', 10, 10), { str: 'x' }, null, undefined])).toEqual([]);
        expect(groupIntoLines([])).toEqual([]);
    });
});

describe('candidate detection and pattern proposal', () => {
    it('picks out only the date-leading rows', () => {
        const c = findCandidateLines(BANKINTER);
        expect(c).toHaveLength(5);
        expect(c.every(l => /^\d{1,2}\/\d{2}/.test(l.text))).toBe(true);
    });

    it('proposes the pattern that explains the most rows', () => {
        const p = proposeLinePattern(BANKINTER);
        expect(p.patternId).toBe('date desc valuedate amount balance');
        expect(p.matched).toBe(5);
        expect(p.coverage).toBe(1);
    });

    it('does not read a running balance as the amount', () => {
        // The failure this ordering prevents is silent and total: every row
        // would import with the balance as its value.
        const parsed = parseWithLineProfile(BANKINTER, {
            patternId: 'date desc valuedate amount balance', decimalStyle: 'eu', statementYear: 2026
        });
        expect(parsed.rows.map(r => r.amount)).toEqual([-11, -135, 690, -150, -7.53]);
        expect(parsed.rows.map(r => r.balance)).toEqual([7685.81, 7550.81, 8240.81, 8090.81, 8083.28]);
    });

    it('is not confused by digits inside the description', () => {
        // "Compra 2061936.97 ana aeroportos" contains something that looks like
        // both a date fragment and a number.
        const parsed = parseWithLineProfile(BANKINTER, {
            patternId: 'date desc valuedate amount balance', decimalStyle: 'eu', statementYear: 2026
        });
        expect(parsed.rows[0].description).toBe('Compra 2061936.97 ana aeroportos');
        expect(parsed.rows[0].amount).toBe(-11);
    });

    it('reports no proposal rather than a wrong one when nothing matches', () => {
        const junk = ['no dates here', 'nor here'].map(text => ({ text, xs: [0], y: 0 }));
        expect(proposeLinePattern(junk)).toMatchObject({ patternId: null, matched: 0 });
    });
});

describe('detectStatementYear', () => {
    it('reads the year from the statement period', () => {
        expect(detectStatementYear(BANKINTER)).toBe(2026);
    });

    it('returns null when the document never states one', () => {
        expect(detectStatementYear([{ text: '26/01 Compra -11,00', xs: [], y: 0 }])).toBeNull();
    });

    it('refuses rows with no year rather than assuming the current one', () => {
        // Guessing files every January statement into the wrong year.
        const noYear = BANKINTER.filter(l => !/Período|Saldo em|Extracto/.test(l.text));
        const r = parseWithLineProfile(noYear, { patternId: 'date desc valuedate amount balance', decimalStyle: 'eu' });
        expect(r.rows).toHaveLength(0);
        expect(r.errors[0].reason).toMatch(/no year/);
    });
});

describe('parseWithLineProfile', () => {
    const profile = { patternId: 'date desc valuedate amount balance', decimalStyle: 'eu', statementYear: 2026 };

    it('produces contract rows from a real statement', () => {
        const r = parseWithLineProfile(BANKINTER, profile, { accountId: 'a1' });
        expect(r.errors).toEqual([]);
        expect(r.parsed).toBe(5);
        expect(r.rows[0]).toMatchObject({
            date: '2026-01-26', amount: -11, currency: 'EUR', accountId: 'a1', sourceRole: 'statement'
        });
    });

    it('keeps credits positive and debits negative', () => {
        const r = parseWithLineProfile(BANKINTER, profile);
        expect(r.rows.find(x => x.description.includes('Trf a credito')).amount).toBe(690);
    });

    it('skips headers, totals and anything that is not a transaction row', () => {
        const r = parseWithLineProfile(BANKINTER, profile);
        expect(r.rows.some(x => /Saldo em|Descritivo/.test(x.description))).toBe(false);
    });

    it('negates when the bank prints debits as positive', () => {
        const r = parseWithLineProfile(BANKINTER, { ...profile, invertSign: true });
        expect(r.rows[0].amount).toBe(11);
    });

    it('reports an unknown pattern instead of silently producing nothing', () => {
        expect(parseWithLineProfile(BANKINTER, { patternId: 'nope' }).errors[0].reason).toMatch(/unknown line pattern/);
    });

    it('is deterministic', () => {
        expect(parseWithLineProfile(BANKINTER, profile).rows)
            .toEqual(parseWithLineProfile(BANKINTER, profile).rows);
    });
});

describe('buildPdfDraft', () => {
    it('gives the confirmation dialog everything it needs', () => {
        const d = buildPdfDraft(BANKINTER);
        expect(d).toMatchObject({
            ok: true, patternId: 'date desc valuedate amount balance',
            matched: 5, coverage: 1, statementYear: 2026, decimalStyle: 'eu', formatKind: 'pdf'
        });
        expect(d.samples.length).toBeGreaterThan(0);
    });

    it('detects US decimals', () => {
        const us = [
            'Period 01/01/2026 to 01/31/2026',
            '01/14/2026 Uber ride 01/14/2026 -8.90 540.10',
            '01/15/2026 Coffee shop 01/15/2026 -3.50 536.60'
        ].map((text, i) => ({ text, y: 700 - i * 12, xs: [0] }));
        expect(buildPdfDraft(us).decimalStyle).toBe('us');
    });

    it('reports failure rather than a bad guess on an unreadable document', () => {
        expect(buildPdfDraft([{ text: 'scanned image, no text', xs: [], y: 0 }]))
            .toMatchObject({ ok: false, matched: 0 });
    });
});

// pdf.js line shape: { text, y, xs }
const ln = text => ({ text, y: 0, xs: [0] });
// A dated row — the kind a heading must be followed by.
const datedRow = ln('26/01 Compra GALP 26/01 -50,00 900,00');

describe('findSectionHeadings', () => {
    it('returns nothing for an empty document', () => {
        expect(findSectionHeadings([])).toHaveLength(0);
    });

    it('keeps a predominantly uppercase heading that precedes a dated row', () => {
        const lines = [ln('DETALHE DAS COMPRAS'), datedRow];
        const found = findSectionHeadings(lines);
        expect(found).toHaveLength(1);
        expect(found[0].text).toBe('DETALHE DAS COMPRAS');
    });

    it('rejects a line that starts with a date', () => {
        // Dated rows are candidate lines, never headings.
        expect(findSectionHeadings([datedRow, datedRow])).toHaveLength(0);
    });

    it('rejects a line that carries a money figure', () => {
        // Totals like "TOTAL DÉBITOS 1.234,56" are not section headings.
        const lines = [ln('TOTAL DÉBITOS 1.234,56'), datedRow];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('rejects a line with fewer than 60% uppercase letters', () => {
        // Predominantly lowercase text is body copy, not a heading.
        const lines = [ln('Detalhe das compras'), datedRow];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('rejects a line with fewer than 3 letters', () => {
        const lines = [ln('OK'), datedRow];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('rejects page furniture not followed by any dated row within lookahead', () => {
        // "PAG 2 DE 6" is uppercase but introduces nothing — it is printed on
        // every page of every bank statement and must not pollute the heading list.
        const lines = [ln('PAG 2 DE 6'), ln('OUTRO TEXTO'), ln('mais texto')];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('rejects a line longer than 100 characters', () => {
        const lines = [ln('A'.repeat(101)), datedRow];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('respects a custom lookahead', () => {
        // A heading 5 lines before the first dated row: found with lookahead=10,
        // missed with lookahead=3.
        const lines = [
            ln('DETALHE DAS COMPRAS'),
            ln('Linha dois'), ln('Linha tres'), ln('Linha quatro'), ln('Linha cinco'),
            datedRow
        ];
        expect(findSectionHeadings(lines, { lookahead: 10 })).toHaveLength(1);
        expect(findSectionHeadings(lines, { lookahead: 3 })).toHaveLength(0);
    });

    it('returns multiple headings when a statement has several sections', () => {
        const lines = [ln('MOVIMENTOS À ORDEM'), datedRow, ln('DETALHE DAS COMPRAS'), datedRow];
        expect(findSectionHeadings(lines)).toHaveLength(2);
    });
});

describe('checkBalanceChain', () => {
    const row = (amount, balance) => ({ amount, balance });

    it('reports zero pairs and zero coverage for an empty list', () => {
        const r = checkBalanceChain([]);
        expect(r).toMatchObject({ pairs: 0, checked: 0, coverage: 0, valid: false, ratio: null });
    });

    it('reports zero pairs for a single row', () => {
        const r = checkBalanceChain([row(-11, 7685.81)]);
        expect(r).toMatchObject({ pairs: 0, checked: 0, coverage: 0, valid: false });
    });

    it('verifies a two-row chain that balances', () => {
        // 95 - 100 = -5 === b.amount ✓
        const r = checkBalanceChain([row(-11, 100), row(-5, 95)]);
        expect(r).toMatchObject({ pairs: 1, checked: 1, coverage: 1, valid: true, breaks: 0, ratio: 1 });
    });

    it('reports all-null balances as unverified (not valid)', () => {
        // The regression this guards: "checked === 0 && breaks === 0" looked
        // like a pass before `valid` was changed to require checked > 0.
        const r = checkBalanceChain([row(-11, null), row(-5, null), row(-3, null)]);
        expect(r.checked).toBe(0);
        expect(r.pairs).toBe(2);
        expect(r.coverage).toBe(0);
        expect(r.valid).toBe(false);
    });

    it('computes partial coverage when some balances are null', () => {
        // 3 rows → 2 pairs. First pair: a.balance is null → skipped.
        // Second pair: 97 - 100 = -3 === b.amount ✓
        const r = checkBalanceChain([row(-10, null), row(-5, 100), row(-3, 97)]);
        expect(r.pairs).toBe(2);
        expect(r.checked).toBe(1);
        expect(r.coverage).toBeCloseTo(0.5);
        expect(r.valid).toBe(true);
    });

    it('detects a balance break and marks the chain invalid', () => {
        // 85 - 100 = -15 ≠ -5 → break
        const r = checkBalanceChain([row(-11, 100), row(-5, 85)]);
        expect(r.breaks).toBe(1);
        expect(r.valid).toBe(false);
        expect(r.ratio).toBe(0);
    });
});

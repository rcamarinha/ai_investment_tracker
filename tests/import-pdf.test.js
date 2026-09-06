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

// ── findSectionHeadings ────────────────────────────────────────────────────
//
// The extraction model classifies a row by the section it sits under. If
// headings are stripped by the date-row filter, the card section arrives as
// anonymous dated rows and the model cannot distinguish card purchases from
// account movements — so it gets everything wrong without a diagnostic.
describe('findSectionHeadings', () => {
    const ln = text => ({ text, y: 0, xs: [0] });
    // A dated row following a heading candidate (needed for the lookahead pass)
    const dated = ln('04/08 DECATHLON GAIA 172,60');

    it('returns empty for an empty document', () => {
        expect(findSectionHeadings([])).toEqual([]);
    });

    it('keeps a heading that is followed by a dated row within lookahead', () => {
        const lines = [ln('DETALHE DAS COMPRAS CARTAO N. ****042061****'), dated];
        expect(findSectionHeadings(lines)).toHaveLength(1);
        expect(findSectionHeadings(lines)[0].text).toContain('DETALHE');
    });

    it('does not return a dated row as a heading', () => {
        // A line starting with "04/08" is a transaction row, not a section heading.
        const lines = [ln('04/08 DECATHLON GAIA 172,60'), dated];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('rejects a line that carries a money figure', () => {
        // Lines like "Total: 1.234,56" look upper-case enough but are totals.
        const lines = [ln('TOTAL MOVIMENTOS 1.234,56'), dated];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('rejects a mostly-lowercase line', () => {
        const lines = [ln('Detalhe das compras'), dated];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('rejects a line with fewer than 3 letters', () => {
        const lines = [ln('P. 2'), dated];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('does not keep page furniture when no dated row follows within lookahead', () => {
        // "PAG. 2 DE 6" is printed in caps on every page footer with no
        // transaction rows following it — it must not leak into the prompt.
        const lines = [ln('PAG. 2 DE 6'), ln('Conforme as condicoes')];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('rejects a line longer than 100 characters', () => {
        const long = ln('A'.repeat(101));
        const lines = [long, dated];
        expect(findSectionHeadings(lines)).toHaveLength(0);
    });

    it('accepts a custom lookahead window', () => {
        // With lookahead=1 the heading must be immediately before the dated row.
        const lines = [ln('CARD TRANSACTIONS'), ln('Bankinter, S.A.'), dated];
        expect(findSectionHeadings(lines, { lookahead: 1 })).toHaveLength(0);
        expect(findSectionHeadings(lines, { lookahead: 2 })).toHaveLength(1);
    });

    it('keeps multiple headings when each introduces transaction rows', () => {
        const lines = [
            ln('MOVIMENTOS DE CONTA'),
            ln('01/08 TRF SEPA 100,00 1000,00'),
            ln('DETALHE DAS COMPRAS CARTAO N. ****042061****'),
            ln('04/08 DECATHLON GAIA 172,60')
        ];
        expect(findSectionHeadings(lines)).toHaveLength(2);
    });
});

// ── checkBalanceChain ──────────────────────────────────────────────────────
//
// `pairs` and `coverage` are the regression guards for the bug where
// "nothing was checkable" (all-null balances) was treated as "verified".
// A bare `checked === 0 && breaks === 0` returns valid=false, but callers
// need the coverage ratio to distinguish "fully vouched" from "uncheckable".
describe('checkBalanceChain', () => {
    it('returns pairs=0 and coverage=0 for an empty list', () => {
        const r = checkBalanceChain([]);
        expect(r.pairs).toBe(0);
        expect(r.coverage).toBe(0);
        expect(r.checked).toBe(0);
        expect(r.valid).toBe(false);
    });

    it('returns pairs=0 and coverage=0 for a single row', () => {
        const r = checkBalanceChain([{ amount: -10, balance: 990 }]);
        expect(r.pairs).toBe(0);
        expect(r.coverage).toBe(0);
    });

    it('returns pairs=N-1 and coverage=1 when all rows balance', () => {
        const rows = [
            { amount: -10, balance: 990 },
            { amount: -20, balance: 970 },
            { amount: 100, balance: 1070 }
        ];
        const r = checkBalanceChain(rows);
        expect(r.pairs).toBe(2);
        expect(r.checked).toBe(2);
        expect(r.coverage).toBe(1);
        expect(r.valid).toBe(true);
        expect(r.breaks).toBe(0);
    });

    it('returns coverage=0 when all balances are null — the regression guard', () => {
        // Before this fix, checked===0 and breaks===0 was treated as "all ok".
        // The model had already returned null balances for every row, so none of
        // the arithmetic was ever tested, yet the import reported "verified".
        const rows = [
            { amount: -10, balance: null },
            { amount: -20, balance: null }
        ];
        const r = checkBalanceChain(rows);
        expect(r.pairs).toBe(1);
        expect(r.checked).toBe(0);
        expect(r.coverage).toBe(0);
        expect(r.valid).toBe(false);
    });

    it('returns fractional coverage when only some pairs can be verified', () => {
        const rows = [
            { amount: -10, balance: 990 },
            { amount: -20, balance: null },  // breaks adjacency for this pair
            { amount: 100, balance: 1070 }
        ];
        const r = checkBalanceChain(rows);
        expect(r.pairs).toBe(2);
        expect(r.checked).toBe(0);           // neither pair is fully checkable
        expect(r.coverage).toBe(0);
    });

    it('reports a break and sets valid=false', () => {
        const rows = [
            { amount: -10, balance: 990 },
            { amount: 20, balance: 970 }    // sign is wrong — should be -20
        ];
        const r = checkBalanceChain(rows);
        expect(r.pairs).toBe(1);
        expect(r.checked).toBe(1);
        expect(r.coverage).toBe(1);
        expect(r.breaks).toBe(1);
        expect(r.valid).toBe(false);
        expect(r.ratio).toBe(0);
    });
});

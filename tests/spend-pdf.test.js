import { describe, it, expect } from 'vitest';
import { prefilterLines, chunkLines, normalizeAiRows, verifyRows } from '../spend/pdf.js';
import { expandCardDetail } from '../services/import-banks.js';
import { detectStatementPeriod, findSectionHeadings, scoreChainDirection, checkBalanceChain, reconcileStatementTotal } from '../services/import-pdf.js';
import { parseStyledNumber } from '../services/import-banks.js';

const L = (text, i = 0) => ({ text, y: 700 - i * 12, xs: [60] });

describe('prefilterLines', () => {
    const doc = [
        'Bankinter, S.A. - Sucursal em Portugal',
        'Periodo: de 2026/01/01 a 2026/01/31',
        'Data Descritivo Movimento Saldo',
        '26/01 Compra ana aeroportos -11,00 7.685,81',
        'Conforme condicoes definidas em Precario - disponivel em www.bankinter.pt',
        '30/01 Lev r diogo botelho -150,00 8.090,81',
        'Imposto do Selo a taxa de 4,000% sobre os juros'
    ].map(L);

    it('keeps the dated rows and drops the boilerplate', () => {
        // One bank prints ~20 lines of terms per page; sending them is both the
        // token cost and the text most likely to be misread as a transaction.
        const { body } = prefilterLines(doc);
        expect(body).toHaveLength(2);
        expect(body.every(t => /^\d{2}\/\d{2}/.test(t))).toBe(true);
        expect(body.join(' ')).not.toMatch(/Precario|Imposto/);
    });

    it('keeps header context, because that is where the year lives', () => {
        const { header, year } = prefilterLines(doc);
        expect(header.join(' ')).toMatch(/Periodo/);
        expect(year).toBe(2026);
    });

    it('handles a document with nothing dated in it', () => {
        expect(prefilterLines([L('just prose')]).body).toEqual([]);
    });
});

describe('chunkLines', () => {
    it('splits on line boundaries under the limit', () => {
        const lines = Array.from({ length: 50 }, (_, i) => `26/01 transaction number ${i} -10,00`);
        const chunks = chunkLines(lines, 200);
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every(c => c.length <= 200)).toBe(true);
        // nothing lost
        expect(chunks.join('\n').split('\n')).toHaveLength(50);
    });

    it('returns a single chunk when it fits', () => {
        expect(chunkLines(['a', 'b'], 1000)).toEqual(['a\nb']);
    });

    it('handles an empty body', () => {
        expect(chunkLines([])).toEqual([]);
    });
});

describe('normalizeAiRows', () => {
    it('passes model output through the same gate as every other adapter', () => {
        const { rows } = normalizeAiRows(
            [{ date: '2026-01-26', description: 'Compra', amount: -11, currency: 'EUR', balance: 7685.81 }],
            { accountId: 'a1' });
        expect(rows[0]).toMatchObject({
            date: '2026-01-26', amount: -11, currency: 'EUR', accountId: 'a1', sourceRole: 'statement'
        });
    });

    it('rejects hallucinated or malformed rows rather than importing them', () => {
        const { rows, rejected } = normalizeAiRows([
            { date: '2026-01-26', description: 'ok', amount: -11, currency: 'EUR' },
            { date: 'sometime in January', description: 'bad date', amount: -5, currency: 'EUR' },
            { date: '2026-01-27', description: 'no amount', amount: null, currency: 'EUR' },
            { date: '2026-02-31', description: 'impossible date', amount: -5, currency: 'EUR' }
        ], { accountId: 'a1' });
        expect(rows).toHaveLength(1);
        expect(rejected).toHaveLength(3);
    });

    it('does not invent a balance the model omitted', () => {
        const { rows } = normalizeAiRows([{ date: '2026-01-26', description: 'x', amount: -11, currency: 'EUR' }], {});
        expect(rows[0].balance).toBeNull();
    });
});

describe('verifyRows — the safety net for model output', () => {
    const chainOk = [
        { date: '2026-01-01', description: 'a', amount: -10, currency: 'EUR', balance: 990 },
        { date: '2026-01-02', description: 'b', amount: -20, currency: 'EUR', balance: 970 },
        { date: '2026-01-03', description: 'c', amount: 100, currency: 'EUR', balance: 1070 }
    ];

    it('passes a statement whose arithmetic reconciles', () => {
        const r = verifyRows(chainOk);
        expect(r.chain.valid).toBe(true);
        expect(r.flagged).toBe(0);
        expect(r.rows.some(x => x.needsReview)).toBe(false);
    });

    it('flags the row whose amount contradicts the balance', () => {
        // A mis-signed or hallucinated amount breaks the chain. The balance is a
        // property of the document, so this catches the model arithmetically
        // rather than trusting it.
        const tampered = [...chainOk];
        tampered[1] = { ...tampered[1], amount: 20 };     // sign flipped
        const r = verifyRows(tampered);
        expect(r.chain.valid).toBe(false);
        expect(r.flagged).toBe(1);
        expect(r.rows[1].needsReview).toBe(true);
        expect(r.rows[1].note).toMatch(/reconcile/);
    });

    it('flags rather than drops — the movement happened, the number is doubtful', () => {
        const tampered = [...chainOk];
        tampered[1] = { ...tampered[1], amount: 999 };
        const r = verifyRows(tampered);
        expect(r.rows).toHaveLength(3);
    });

    it('leaves rows alone when the statement prints no balance to check against', () => {
        const noBalance = chainOk.map(({ balance, ...rest }) => ({ ...rest, balance: null }));
        const r = verifyRows(noBalance);
        expect(r.chain.checked).toBe(0);
        expect(r.flagged).toBe(0);
        expect(r.rows.some(x => x.needsReview)).toBe(false);
    });

    it('tolerates rounding to the cent', () => {
        const rounded = [
            { date: '2026-01-01', description: 'a', amount: -10, currency: 'EUR', balance: 990 },
            { date: '2026-01-02', description: 'b', amount: -20.004, currency: 'EUR', balance: 969.996 }
        ];
        expect(verifyRows(rounded).flagged).toBe(0);
    });

    it('handles an empty or single-row statement', () => {
        expect(verifyRows([]).flagged).toBe(0);
        expect(verifyRows([chainOk[0]]).flagged).toBe(0);
    });
});

// ── card-detail sections ────────────────────────────────────────────────────
//
// Reproduces a real misread: a card purchase printed under the card section was
// ingested as an account movement. Because those sections print charges without
// a minus, it landed as +150 INCOME while the €555,49 card payment that already
// contained it was also counted — overstating income and understating spend at
// once, from one line.
describe('card-detail rows', () => {
    const raw = [
        { date: '2026-07-06', description: 'TRF.IMED. DE JOSE MANUEL VALGA CAMARINHA', amount: 644.00, balance: 1644.00 },
        { date: '2026-07-06', description: '6416965-00-PAG.CTA.CARTAO', amount: -555.49, balance: 1088.51 },
        { date: '2026-07-05', description: 'REVOLUTION SPORT', amount: -150.00, balance: null, role: 'detail' }
    ];

    it('marks a detail row as detail, not as a statement movement', () => {
        const { rows } = normalizeAiRows(raw, { accountId: 'a1' });
        expect(rows.map(r => r.sourceRole)).toEqual(['statement', 'statement', 'detail']);
    });

    it('keeps the chain intact across an interleaved detail row', () => {
        // The detail row sits BETWEEN two statement rows. Before the fix it broke
        // adjacency for both neighbouring pairs, so they went unchecked while the
        // result still reported valid.
        const { rows } = normalizeAiRows([raw[0], raw[2], raw[1]], { accountId: 'a1' });
        const { chain, flagged } = verifyRows(rows);
        expect(chain.checked).toBe(1);
        expect(chain.valid).toBe(true);
        expect(flagged).toBe(0);
    });

    it('still catches a genuine break once details are excluded', () => {
        const bad = [
            { date: '2026-07-06', description: 'A', amount: 644.00, balance: 1644.00 },
            { date: '2026-07-06', description: 'B', amount: -100.00, balance: 1088.51 } // should be -555.49
        ];
        const { rows } = normalizeAiRows(bad, { accountId: 'a1' });
        const { flagged } = verifyRows(rows);
        expect(flagged).toBe(1);
    });
});

// A revolving credit card lists this period's purchases while the payment on
// the same statement settles the previous period. Measured on a real statement:
// 27 purchases totalling 2.729,44 against a payment of 717,61. No proof exists,
// so the purchases must still reach the ledger rather than being discarded.
describe('card period that the statement does not settle', () => {
    it('imports the purchases rather than dropping them', () => {
        const raw = [
            { date: '2026-08-20', description: 'CARTOES BKCF - DEB. MENSAL', amount: -717.61, balance: 1000 },
            { date: '2026-08-01', description: 'DECATHLON GAIA',  amount: -172.60, balance: null, role: 'detail', group: 'c1' },
            { date: '2026-08-13', description: 'ZOOMARINE',       amount: -162.50, balance: null, role: 'detail', group: 'c1' }
        ];
        const { rows } = normalizeAiRows(raw.map(r => ({ ...r, detailGroup: r.group })), { accountId: 'a1' });
        const { rows: verified } = verifyRows(rows);
        const detail = verified.filter(r => r.sourceRole === 'detail');
        const statement = verified.filter(r => r.sourceRole !== 'detail');
        const exp = expandCardDetail(statement, detail);
        expect(exp.expanded).toHaveLength(0);          // 335.10 never equals 717.61
        expect(exp.unexpanded[0].count).toBe(2);       // and the rows are accounted for, not lost
    });
});

// The heading is the evidence the model classifies on. Filtering it out while
// keeping the rows under it made the card section indistinguishable from
// account movements — the classification could not succeed because what it
// needed had already been thrown away.
describe('section headings survive the prefilter', () => {
    const L = (text, i) => ({ text, y: 700 - i * 12, xs: [60] });
    const doc = [
        'Bankinter, S.A.', 'Periodo: de 2025/08/01 a 2025/08/31',
        'Data Descritivo Movimento Saldo',
        '04/08 TRF SEPA 100,00 18.063,52',
        'DETALHE DAS COMPRAS CARTAO N. ******042061****',
        '04/08 01/08 DECATHLON GAIA 172,60',
        '15/08 13/08 DECATHLON PORTIMAO 309,90',
        'Conforme condicoes definidas em Precario'
    ].map(L);

    it('keeps a card heading, in order, above its rows', () => {
        const { body } = prefilterLines(doc);
        const h = body.findIndex(t => t.includes('DETALHE DAS COMPRAS'));
        const r = body.findIndex(t => t.includes('DECATHLON GAIA'));
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(r);
    });

    it('does not keep page furniture printed in caps', () => {
        const { body } = prefilterLines([...doc, L('PAG. 2 DE 6', 20)]);
        expect(body.some(t => t.includes('PAG. 2 DE 6'))).toBe(false);
    });
});

// The strict gate decided whether the AI extractor was allowed to look at a
// document at all, so any bank not printing dd/mm at the start of every row
// failed outright with "No dated transaction lines found" — the exact opposite
// of what a bank-agnostic importer is for.
describe('documents whose rows do not start with dd/mm', () => {
    const L = (text, i) => ({ text, y: 700 - i * 12, xs: [60] });

    it('accepts ISO dates', () => {
        const { body } = prefilterLines([
            L('Statement 2025', 0), L('2025-08-04 TRF SEPA 100,00 18.063,52', 1)
        ]);
        expect(body.some(t => t.includes('TRF SEPA'))).toBe(true);
    });

    it('accepts a month name', () => {
        const { body } = prefilterLines([
            L('Statement', 0), L('04 Ago 2025 DECATHLON GAIA 172,60', 1)
        ]);
        expect(body.some(t => t.includes('DECATHLON'))).toBe(true);
    });

    it('widens to rows whose date is not first', () => {
        const { body, broadened } = prefilterLines([
            L('Movimentos', 0),
            L('DECATHLON GAIA 04/08/2025 172,60', 1),
            L('CONTINENTE 05/08/2025 42,10', 2)
        ]);
        expect(broadened).toBe(true);
        expect(body.filter(t => /DECATHLON|CONTINENTE/.test(t))).toHaveLength(2);
    });

    it('still refuses a document with no dates and no amounts', () => {
        const { body } = prefilterLines([L('Terms and conditions apply', 0), L('Thank you for banking', 1)]);
        expect(body).toHaveLength(0);
    });
});

// One statement a year spans a year boundary. A single detected year stamps
// December with January's year — wrong month, sometimes a future date — and the
// balance chain still reconciles, because the amounts were never wrong.
describe('statement period across a year boundary', () => {
    const L = (text, i) => ({ text, y: 700 - i * 12, xs: [60] });
    const doc = [
        L('Periodo: de 2025/12/15 a 2026/01/15', 0),
        L('31/12 COMPRA SUPERMERCADO 45,00 1.000,00', 1),
        L('02/01 COMPRA FARMACIA 20,00 980,00', 2)
    ];

    it('reports both ends of the period, not one year', () => {
        const p = detectStatementPeriod(doc);
        expect(p).toMatchObject({ start: '2025-12-15', end: '2026-01-15', startYear: 2025, endYear: 2026 });
    });

    it('still works when only one year is printed', () => {
        const single = [L('Periodo: de 2025/08/01 a 2025/08/31', 0), L('04/08 TRF 10,00 90,00', 1)];
        expect(detectStatementPeriod(single)).toMatchObject({ startYear: 2025, endYear: 2025 });
    });

    it('returns null when the document says nothing about dates', () => {
        expect(detectStatementPeriod([L('Thank you for banking', 0)])).toBeNull();
    });
});

// Verified against the running code, not inferred: parseStyledNumber('100,00-')
// returned +100, so a debit was recorded as income. Trailing minus is the
// standard debit marker in German, Austrian and Swiss exports, and the error
// flatters the user's spending, which is the direction nobody questions.
describe('the three ways a statement writes a negative', () => {
    it('reads a trailing minus as negative', () => {
        expect(parseStyledNumber('100,00-', 'eu')).toBe(-100);
        expect(parseStyledNumber('1,234.56-', 'us')).toBe(-1234.56);
    });
    it('reads parentheses as negative', () => {
        expect(parseStyledNumber('(100,00)', 'eu')).toBe(-100);
    });
    it('leaves a leading minus and a plain number alone', () => {
        expect(parseStyledNumber('-100,00', 'eu')).toBe(-100);
        expect(parseStyledNumber('100,00', 'eu')).toBe(100);
        expect(parseStyledNumber('100,00+', 'eu')).toBe(100);
    });
});

// A wrapped description satisfies every shape test for a heading. Injected as
// one it opens a phantom card section mid-statement, and the rows after it get
// routed to a card account — a false heading moves real money.
describe('headings versus wrapped descriptions', () => {
    const L = (text, i, x) => ({ text, y: 700 - i * 12, xs: [x] });
    it('does not treat an indented continuation as a heading', () => {
        const doc = [L('04/08 COMPRA SUPERMERCADO 45,00', 0, 60),
                     L('LISBOA PT VISA 1234', 1, 140),
                     L('05/08 FARMACIA 20,00', 2, 60)];
        expect(findSectionHeadings(doc)).toHaveLength(0);
    });
    it('still finds a real heading at the left margin', () => {
        const doc = [L('04/08 COMPRA 45,00', 0, 60),
                     L('DETALHE DAS COMPRAS CARTAO N. 042061', 1, 60),
                     L('05/08 FARMACIA 20,00', 2, 60)];
        expect(findSectionHeadings(doc).map(l => l.text)).toEqual(['DETALHE DAS COMPRAS CARTAO N. 042061']);
    });
});

// A statement printed newest-first fails every pair of the ascending chain, so
// the deterministic path refused the document and the AI path flagged nearly
// every row. Neither is a parsing error — the rows are simply the other way up.
describe('statements printed newest-first', () => {
    const desc = [
        { date: '2026-01-03', description: 'C', amount: -30, balance: 870 },
        { date: '2026-01-02', description: 'B', amount: -50, balance: 900 },
        { date: '2026-01-01', description: 'A', amount: -50, balance: 950 }
    ];
    const asc = [...desc].reverse();

    it('recognises descending order', () => {
        expect(scoreChainDirection(desc).direction).toBe('desc');
    });

    it('recognises ascending order', () => {
        expect(scoreChainDirection(asc).direction).toBe('asc');
    });

    it('reconciles once the rows are turned round', () => {
        const turned = [...desc].reverse();
        const chain = checkBalanceChain(turned);
        expect(chain.valid).toBe(true);
        expect(chain.checked).toBe(2);
    });

    it('says nothing when no row carries a balance', () => {
        const none = desc.map(r => ({ ...r, balance: null }));
        expect(scoreChainDirection(none)).toMatchObject({ direction: 'unknown', pairs: 0 });
    });
});

// Chunking by characters bounds the PROMPT but not the ANSWER. A statement of
// many short rows — a real CGD export puts 101 rows in 5.8k characters — was
// sent as one request asking for 101 JSON objects back, and it is the response
// that exhausts the token budget and the request timeout.
describe('chunking bounds the response, not just the prompt', () => {
    const rows = n => Array.from({ length: n }, (_, i) => `- - 2026-07-01 MERCHANT ${i} -42,69 4.673,69`);

    it('splits a statement with many short rows', () => {
        expect(chunkLines(rows(101)).length).toBeGreaterThan(1);
    });

    it('leaves a small statement as one request', () => {
        expect(chunkLines(rows(49))).toHaveLength(1);
    });

    it('still splits on length when rows are long', () => {
        const long = Array.from({ length: 20 }, () => 'X'.repeat(1000));
        expect(chunkLines(long).length).toBeGreaterThan(1);
    });

    it('never emits an empty chunk', () => {
        for (const n of [1, 60, 61, 120, 121])
            expect(chunkLines(rows(n)).every(c => c.trim().length > 0)).toBe(true);
    });
});

// A "global" statement covers more than the current account. A CGD one carries a
// mortgage section whose lines itemise the instalment already on the account:
//   Saldo devedor Inicial  533.336,72
//   76 COBRANCA DE CAPITAL   1.003,16
//   76 COBRANCA DE JUROS       688,89   → 1.692,05, the instalment already listed
// They are printed with no date and no balance, so importing them meant the model
// inventing a date, and their unsigned amounts landed as income.
describe('product sections in a global statement', () => {
    const raw = [
        { date: '2026-07-31', description: 'COBRANCA PRESTACAO', amount: -1692.05, balance: 4583.77, role: 'statement' },
        { date: null, description: 'COBRANCA DE CAPITAL', amount: 1003.16, balance: null, role: 'detail', group: 'mortgage' },
        { date: null, description: 'COBRANCA DE JUROS',   amount: 688.89,  balance: null, role: 'detail', group: 'mortgage' },
        { date: null, description: 'Saldo devedor final', amount: 532333.56, balance: null, role: 'skip' }
    ];

    it('imports the instalment and nothing else', () => {
        const { rows } = normalizeAiRows(raw, { accountId: 'a1', currency: 'EUR' });
        expect(rows.map(r => r.description)).toEqual(['COBRANCA PRESTACAO']);
    });

    it('accounts for what it left out rather than dropping it quietly', () => {
        const { skipped } = normalizeAiRows(raw, { accountId: 'a1', currency: 'EUR' });
        expect(skipped).toHaveLength(3);
    });

    it('never imports a row the document did not date', () => {
        const undated = [{ description: 'COBRANCA DE CAPITAL', amount: 1003.16, role: 'statement' }];
        expect(normalizeAiRows(undated, { accountId: 'a1' }).rows).toHaveLength(0);
    });

    it('still imports an ordinary dated movement', () => {
        const ok = [{ date: '2026-07-30', description: 'EDP', amount: -268.03, balance: 6761.12 }];
        expect(normalizeAiRows(ok, { accountId: 'a1' }).rows).toHaveLength(1);
    });
});

// The per-row chain proves each amount against the balance beside it. It cannot
// prove the SET of rows is right, because a row with no balance is not in the
// chain at all — which is how a mortgage section's capital and interest lines
// were imported as income with every per-row check passing. This is the check
// that would have caught it, and it finds the two balances structurally rather
// than by looking for the word "saldo".
describe('reconcileStatementTotal', () => {
    const L = t => ({ text: t });
    const doc = [
        L('Extrato Periodo 2026-07-01 a 2026-07-31'),
        L('Saldo anterior 1.000,00'),
        L('- - 2026-07-02 COMPRA A -100,00 900,00'),
        L('- - 2026-07-03 COMPRA B -50,00 850,00'),
        L('Saldo contabilistico 850,00')
    ];
    const rows = [
        { date: '2026-07-02', description: 'COMPRA A', rawDescription: 'COMPRA A', amount: -100, balance: 900 },
        { date: '2026-07-03', description: 'COMPRA B', rawDescription: 'COMPRA B', amount: -50, balance: 850 }
    ];

    it('finds the opening and closing balance with no keyword', () => {
        expect(reconcileStatementTotal(rows, doc)).toMatchObject({ ok: true, opening: 1000, closing: 850 });
    });

    it('fails when a row that is not a movement of this account is included', () => {
        const withLoan = [...rows,
            { date: '2026-07-31', description: 'COBRANCA DE CAPITAL', amount: 1003.16, balance: null }];
        expect(reconcileStatementTotal(withLoan, doc).ok).toBe(false);
    });

    it('fails when a movement is missing', () => {
        expect(reconcileStatementTotal(rows.slice(0, 1), doc).ok).toBe(false);
    });

    it('says so when the document prints no usable pair', () => {
        const bare = [L('Extrato'), L('- - 2026-07-02 COMPRA A -100,00 900,00')];
        expect(reconcileStatementTotal(rows, bare)).toMatchObject({ checked: true, ok: false });
    });

    it('ignores detail rows, which belong to another ledger', () => {
        const withCard = [...rows,
            { date: '2026-07-04', description: 'SHOP', amount: -25, balance: null, sourceRole: 'detail' }];
        expect(reconcileStatementTotal(withCard, doc).ok).toBe(true);
    });
});

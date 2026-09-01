import { describe, it, expect } from 'vitest';
import { prefilterLines, chunkLines, normalizeAiRows, verifyRows } from '../spend/pdf.js';

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

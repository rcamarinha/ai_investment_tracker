import { describe, it, expect } from 'vitest';
import {
    sniffCsv, autoMapColumns, headerSignature, buildProfileDraft, parseWithProfile,
    locateHeaderBySignature,
    parseStyledNumber, detectDecimalStyle, detectDateFormat, parseDateWithFormat,
    spendFingerprint, buildExistingFingerprints, dedupeSpendRows,
    mergeDetailSource, applyRules, ruleFromCorrection, DATE_FORMATS
} from '../services/import-banks.js';

// ── fixtures: shaped like the real thing, preamble rows and all ─────────────

// Millennium-style: preamble, semicolons, separate Débito/Crédito, EU decimals.
const MILLENNIUM = `Millennium bcp - Extrato de conta
Conta: PT50 9999 0000 0000 0000 0000 0
Periodo: 01-03-2026 a 31-03-2026

Data Mov.;Data Valor;Descricao;Debito;Credito;Saldo
05-03-2026;05-03-2026;COMPRA MBWAY 12,40;12,40;;2.487,60
07-03-2026;07-03-2026;TRF SEPA RENDA CASA;750,00;;1.737,60
25-03-2026;25-03-2026;ORDENADO MARCO;;2.400,00;4.137,60
28-03-2026;28-03-2026;LEVANTAMENTO ATM AV LIBERDADE;60,00;;4.077,60`;

// CGD-style: one signed Montante column.
const CGD = `Data movimento;Data valor;Descricao;Montante;Saldo
03-03-2026;03-03-2026;PAGAMENTO SERVICOS EDP;-84,15;1.200,00
14-03-2026;14-03-2026;COMPRA CONTINENTE COLOMBO;-132,78;1.067,22`;

// Revolut personal export: commas, ISO dates, US decimals.
const REVOLUT = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-03-04 09:12:00,2026-03-04 09:12:00,Uber,-8.90,0.00,EUR,COMPLETED,540.10
CARD_PAYMENT,Current,2026-03-06 20:31:00,2026-03-06 20:31:00,Netflix,-13.99,0.00,EUR,COMPLETED,526.11`;

// MB WAY: the same movements the bank already has, but with real merchant names.
const MBWAY = `Data;Descricao;Valor
05-03-2026;Pingo Doce Saldanha;-12,40
06-03-2026;Joao Silva;-25,00`;

describe('sniffCsv', () => {
    it('skips preamble rows and finds the real header', () => {
        const { header, rows, sep, skipRows } = sniffCsv(MILLENNIUM);
        expect(sep).toBe(';');
        expect(skipRows).toBe(3);
        expect(header[0]).toBe('Data Mov.');
        expect(header).toHaveLength(6);
        expect(rows).toHaveLength(4);
    });

    it('handles a file whose header is already on line one', () => {
        const { header, rows, skipRows } = sniffCsv(CGD);
        expect(skipRows).toBe(0);
        expect(header).toHaveLength(5);
        expect(rows).toHaveLength(2);
    });

    it('returns an empty result rather than throwing on an empty file', () => {
        expect(sniffCsv('')).toMatchObject({ header: [], rows: [] });
    });
});

describe('autoMapColumns', () => {
    it('maps a Portuguese debit/credit layout', () => {
        const { columnMap, amountMode, unresolved } = autoMapColumns(sniffCsv(MILLENNIUM).header);
        expect(amountMode).toBe('debit_credit');
        expect(unresolved).toEqual([]);
        expect(columnMap).toMatchObject({ date: 0, valueDate: 1, description: 2, debit: 3, credit: 4, balance: 5 });
    });

    it('does not let the loose "data" alias steal the Data Valor column', () => {
        const { columnMap } = autoMapColumns(['Data movimento', 'Data valor', 'Descricao', 'Montante']);
        expect(columnMap.date).toBe(0);
        expect(columnMap.valueDate).toBe(1);
    });

    it('does not let the loose "valor" alias steal Data Valor for the amount', () => {
        const { columnMap, amountMode } = autoMapColumns(sniffCsv(CGD).header);
        expect(amountMode).toBe('signed');
        expect(columnMap.amount).toBe(3);   // Montante, not Data valor
        expect(columnMap.balance).toBe(4);
    });

    it('prefers Completed Date over Started Date in a Revolut export', () => {
        const { columnMap } = autoMapColumns(sniffCsv(REVOLUT).header);
        expect(columnMap.date).toBe(3);
        expect(columnMap.description).toBe(4);
        expect(columnMap.amount).toBe(5);
        expect(columnMap.currency).toBe(7);
    });

    // Verified against real exports from Ricardo's five banks, Aug 2026. Each of
    // these headers broke the mapper at least once; they are here so they stay fixed.
    describe('real Portuguese bank headers', () => {
        it('maps a semicolon CSV export with a hyphenated Data-valor', () => {
            // "Data-valor" normalises to "datavalor" (punctuation stripped, no
            // space), which the loose 'valor' alias would otherwise claim for amount.
            const { columnMap, amountMode, unresolved } = autoMapColumns(
                ['Data mov.', 'Data-valor', 'Descrição', 'Montante', 'Saldo contabilístico após movimento']);
            expect(unresolved).toEqual([]);
            expect(amountMode).toBe('signed');
            expect(columnMap).toMatchObject({ date: 0, valueDate: 1, description: 2, amount: 3, balance: 4 });
        });

        it('maps Revolut PT two-column debit/credit', () => {
            const { columnMap, amountMode, confident } = autoMapColumns(
                ['Data', 'Descrição', 'Dinheiro retirado', 'Dinheiro recebido', 'Saldo']);
            expect(confident).toBe(true);
            expect(amountMode).toBe('debit_credit');
            expect(columnMap).toMatchObject({ date: 0, description: 1, debit: 2, credit: 3, balance: 4 });
        });

        it('maps a Bankinter header whose punctuation leaves a double space', () => {
            // "Movimento Cred. / Deb." → "movimento cred  deb" before whitespace
            // is collapsed, which matched no alias at all.
            const { columnMap, amountMode } = autoMapColumns(
                ['Data', 'Descritivo', 'Data Valor', 'Movimento Cred. / Deb.', 'Saldo']);
            expect(amountMode).toBe('signed');
            expect(columnMap).toMatchObject({ date: 0, description: 1, valueDate: 2, amount: 3, balance: 4 });
        });
    });

    it('reports what it could not find instead of guessing', () => {
        const { unresolved, confident } = autoMapColumns(['Col A', 'Col B', 'Col C']);
        expect(confident).toBe(false);
        expect(unresolved).toEqual(['date', 'description', 'amount']);
    });
});

describe('headerSignature', () => {
    it('is stable across capitalisation, accents and separator changes', () => {
        const a = headerSignature(['Data Mov.', 'Descrição', 'Débito']);
        const b = headerSignature(['DATA MOV', 'Descricao', 'Debito']);
        expect(a).toBe(b);
    });

    it('differs when the columns actually differ', () => {
        expect(headerSignature(['Data', 'Valor']))
            .not.toBe(headerSignature(['Data', 'Valor', 'Saldo']));
    });
});

describe('number and date resolution', () => {
    it('parses EU and US decimals under an explicit style', () => {
        expect(parseStyledNumber('1.234,56', 'eu')).toBe(1234.56);
        expect(parseStyledNumber('1,234.56', 'us')).toBe(1234.56);
        expect(parseStyledNumber('-84,15', 'eu')).toBe(-84.15);
        expect(parseStyledNumber('(120,00)', 'eu')).toBe(-120);
        expect(parseStyledNumber('', 'eu')).toBeNaN();
    });

    it('resolves the ambiguous "1.234" by column style, not per row', () => {
        // The whole point of storing decimalStyle on the profile.
        expect(parseStyledNumber('1.234', 'eu')).toBe(1234);
        expect(parseStyledNumber('1.234', 'us')).toBe(1.234);
    });

    it('parses the amount formats the five banks actually emit', () => {
        expect(parseStyledNumber('8 999,36€', 'eu')).toBe(8999.36);   // Revolut: space thousands, € suffix
        expect(parseStyledNumber('0,80€', 'eu')).toBe(0.8);
        expect(parseStyledNumber('6.108,58', 'eu')).toBe(6108.58);    // CSV export
        expect(parseStyledNumber('98.205,00', 'eu')).toBe(98205);     // Banco BEST bond valuation
        expect(parseStyledNumber('5.441,1710', 'eu')).toBe(5441.171); // Bankinter fund units, 4dp
    });

    it('refuses a day/month with no year rather than inventing one', () => {
        // Bankinter prints "31/07" and leaves the year to the statement header.
        // Failing loudly puts the row in the review list; guessing would file a
        // transaction into the wrong year silently.
        expect(parseDateWithFormat('31/07', 'dd-mm-yyyy')).toBeNull();
        expect(detectDateFormat(['31/07', '20/08'])).toMatchObject({ samples: 0, ambiguous: true });
    });

    it('detects decimal style from a column sample', () => {
        expect(detectDecimalStyle(['1.234,56', '-84,15']).style).toBe('eu');
        expect(detectDecimalStyle(['-8.90', '1,234.56']).style).toBe('us');
        expect(detectDecimalStyle(['12', '40'])).toMatchObject({ ambiguous: true });
    });

    it('detects day-first from a day above 12', () => {
        expect(detectDateFormat(['05-03-2026', '25-03-2026']))
            .toMatchObject({ format: 'dd-mm-yyyy', ambiguous: false });
    });

    it('detects ISO from a four-digit leading group', () => {
        expect(detectDateFormat(['2026-03-04 09:12:00']))
            .toMatchObject({ format: 'yyyy-mm-dd', ambiguous: false });
    });

    it('flags a column where every value could be either convention', () => {
        // 05-03 is 5 March or 3 May. Guessing silently reorders the statement.
        expect(detectDateFormat(['05-03-2026', '02-04-2026']))
            .toMatchObject({ ambiguous: true });
    });

    it('parses a date under the format the profile locked in', () => {
        expect(parseDateWithFormat('05-03-2026', 'dd-mm-yyyy')).toBe('2026-03-05');
        expect(parseDateWithFormat('05-03-2026', 'mm-dd-yyyy')).toBe('2026-05-03');
        expect(parseDateWithFormat('2026-03-05', 'yyyy-mm-dd')).toBe('2026-03-05');
        expect(parseDateWithFormat('not a date', 'dd-mm-yyyy')).toBeNull();
        expect(parseDateWithFormat('45-03-2026', 'dd-mm-yyyy')).toBeNull();
    });
});

describe('buildProfileDraft', () => {
    it('drafts a complete profile for a debit/credit bank and asks for nothing', () => {
        const d = buildProfileDraft(MILLENNIUM);
        expect(d.ok).toBe(true);
        expect(d.amountMode).toBe('debit_credit');
        expect(d.dateFormat).toBe('dd-mm-yyyy');
        expect(d.decimalStyle).toBe('eu');
        expect(d.needsConfirmation).toBe(false);
        expect(d.needsAi).toBe(false);
        expect(d.rowCount).toBe(4);
    });

    it('drafts a Revolut profile', () => {
        const d = buildProfileDraft(REVOLUT);
        expect(d).toMatchObject({ ok: true, amountMode: 'signed', dateFormat: 'yyyy-mm-dd', decimalStyle: 'us' });
    });

    it('asks for confirmation when the date column is ambiguous', () => {
        const ambiguous = `Data;Descricao;Montante
05-03-2026;Cafe;-2,40
02-04-2026;Padaria;-3,10`;
        const d = buildProfileDraft(ambiguous);
        expect(d.dateAmbiguous).toBe(true);
        expect(d.needsConfirmation).toBe(true);
    });

    it('spots a bank that ships debits as positive numbers', () => {
        const positives = `Data;Descricao;Montante
05-03-2026;Cafe;2,40
25-03-2026;Padaria;3,10`;
        const d = buildProfileDraft(positives);
        expect(d.invertSign).toBe(true);
        expect(d.needsConfirmation).toBe(true);
        expect(d.signNote).toMatch(/debits are positive/);
    });

    it('escalates to AI only when a required column is missing', () => {
        expect(buildProfileDraft('Col A;Col B;Col C\n1;2;3').needsAi).toBe(true);
        expect(buildProfileDraft(MILLENNIUM).needsAi).toBe(false);
    });
});

describe('parseWithProfile', () => {
    const profileFor = (text, extra = {}) => {
        const d = buildProfileDraft(text);
        return {
            columnMap: d.columnMap, dateFormat: d.dateFormat, decimalStyle: d.decimalStyle,
            invertSign: d.invertSign, skipRows: d.skipRows, label: 'test', ...extra
        };
    };

    it('turns a debit/credit statement into signed amounts', () => {
        const { rows, errors } = parseWithProfile(MILLENNIUM, profileFor(MILLENNIUM), { accountId: 'mil' });
        expect(errors).toEqual([]);
        expect(rows).toHaveLength(4);
        expect(rows[0]).toMatchObject({ date: '2026-03-05', amount: -12.4, accountId: 'mil', currency: 'EUR' });
        expect(rows[1].amount).toBe(-750);
        expect(rows[2]).toMatchObject({ date: '2026-03-25', amount: 2400 }); // credit stays positive
        expect(rows[3].amount).toBe(-60);
    });

    it('reads a signed-amount statement with EU decimals', () => {
        const { rows } = parseWithProfile(CGD, profileFor(CGD));
        expect(rows.map(r => r.amount)).toEqual([-84.15, -132.78]);
    });

    it('reads Revolut ISO dates and US decimals, picking up the currency column', () => {
        const { rows } = parseWithProfile(REVOLUT, profileFor(REVOLUT));
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ date: '2026-03-04', amount: -8.9, description: 'Uber', currency: 'EUR' });
        expect(rows[1].amount).toBe(-13.99);
    });

    it('negates a positive-debit bank when the profile says so', () => {
        const positives = `Data;Descricao;Montante
05-03-2026;Cafe;2,40
25-03-2026;Padaria;3,10`;
        const { rows } = parseWithProfile(positives, profileFor(positives));
        expect(rows.map(r => r.amount)).toEqual([-2.4, -3.1]);
    });

    it('seeds rawDescription so later enrichment cannot break re-import identity', () => {
        const { rows } = parseWithProfile(MILLENNIUM, profileFor(MILLENNIUM));
        expect(rows[0].rawDescription).toBe(rows[0].description);
    });

    it('reports unreadable rows instead of dropping them silently', () => {
        const broken = `Data;Descricao;Montante
05-03-2026;Cafe;-2,40
NOT-A-DATE;Padaria;-3,10
07-03-2026;Zero row;0,00`;
        const { rows, errors } = parseWithProfile(broken, profileFor(broken));
        expect(rows).toHaveLength(1);
        expect(errors).toHaveLength(2);
        expect(errors.map(e => e.reason)).toEqual(['unreadable date', 'unreadable or zero amount']);
    });
});

describe('dedupe', () => {
    const rows = [
        { date: '2026-03-05', description: 'Cafe', amount: -2.4, currency: 'EUR' },
        { date: '2026-03-06', description: 'Uber', amount: -8.9, currency: 'EUR' }
    ];

    it('is a no-op when the same statement is imported twice', () => {
        const first = dedupeSpendRows(rows, new Map());
        expect(first.fresh).toHaveLength(2);
        const existing = buildExistingFingerprints(first.fresh);
        const second = dedupeSpendRows(rows, existing);
        expect(second.fresh).toHaveLength(0);
        expect(second.duplicates).toHaveLength(2);
    });

    it('stays a no-op on re-import even when a day contains repeated movements', () => {
        // Found against a real statement: two €200 ATM withdrawals on one day.
        // The stored fingerprints carry #n suffixes; an incoming row hashes to
        // the base key, so without suffix-stripping every repeat re-inserted
        // itself on each import.
        const withRepeats = [
            { date: '2026-03-31', description: 'LEVANTAMENTO GALP U', amount: -200, currency: 'EUR' },
            { date: '2026-03-31', description: 'LEVANTAMENTO GALP U', amount: -200, currency: 'EUR' },
            { date: '2026-03-31', description: 'LEVANTAMENTO GALP U', amount: -200, currency: 'EUR' },
            { date: '2026-04-01', description: 'UBER', amount: -4.99, currency: 'EUR' }
        ];
        const first = dedupeSpendRows(withRepeats, new Map());
        expect(first.fresh).toHaveLength(4);

        const second = dedupeSpendRows(withRepeats, buildExistingFingerprints(first.fresh));
        expect(second.fresh).toHaveLength(0);
        expect(second.duplicates).toHaveLength(4);

        // A genuinely new fourth copy on the same day must still come through.
        const withOneMore = [...withRepeats, { date: '2026-03-31', description: 'LEVANTAMENTO GALP U', amount: -200, currency: 'EUR' }];
        const third = dedupeSpendRows(withOneMore, buildExistingFingerprints(first.fresh));
        expect(third.fresh).toHaveLength(1);
    });

    it('keeps two genuinely identical charges on the same day', () => {
        const twoCoffees = [rows[0], { ...rows[0] }];
        const { fresh } = dedupeSpendRows(twoCoffees, new Map());
        expect(fresh).toHaveLength(2);
        expect(fresh[0].fingerprint).not.toBe(fresh[1].fingerprint); // UNIQUE index would reject a tie
    });

    it('offsets the suffix by the existing count so a new copy does not collide', () => {
        const threeCopies = Array.from({ length: 3 }, () =>
            ({ date: '2026-03-31', description: 'ATM', amount: -200, currency: 'EUR' }));
        const first = dedupeSpendRows(threeCopies, new Map());
        expect(first.fresh).toHaveLength(3);
        const existing = buildExistingFingerprints(first.fresh);

        const fourCopies = Array.from({ length: 4 }, () =>
            ({ date: '2026-03-31', description: 'ATM', amount: -200, currency: 'EUR' }));
        const second = dedupeSpendRows(fourCopies, existing);
        expect(second.fresh).toHaveLength(1);
        expect(second.duplicates).toHaveLength(3);
        const usedFingerprints = new Set(first.fresh.map(r => r.fingerprint));
        expect(usedFingerprints.has(second.fresh[0].fingerprint)).toBe(false);
    });

    it('keeps a fingerprint stable once MB WAY has rewritten the description', () => {
        const bankRow = { date: '2026-03-05', description: 'COMPRA MBWAY 12,40', rawDescription: 'COMPRA MBWAY 12,40', amount: -12.4, currency: 'EUR' };
        const before = spendFingerprint(bankRow);
        const after = spendFingerprint({ ...bankRow, description: 'Pingo Doce Saldanha', merchant: 'Pingo Doce' });
        expect(after).toBe(before);
    });

    it('ignores accents and punctuation when identifying a movement', () => {
        expect(spendFingerprint({ date: '2026-03-05', description: 'CAFÉ  CENTRAL,', amount: -2.4 }))
            .toBe(spendFingerprint({ date: '2026-03-05', description: 'cafe central', amount: -2.4 }));
    });
});

describe('mergeDetailSource (MB WAY)', () => {
    const statement = () => [
        { id: 's1', accountId: 'mil', date: '2026-03-05', description: 'COMPRA MBWAY 12,40', rawDescription: 'COMPRA MBWAY 12,40', amount: -12.4, currency: 'EUR' },
        { id: 's2', accountId: 'mil', date: '2026-03-07', description: 'COMPRA MBWAY 25,00', rawDescription: 'COMPRA MBWAY 25,00', amount: -25, currency: 'EUR' },
        { id: 's3', accountId: 'mil', date: '2026-03-09', description: 'TRF SEPA RENDA CASA', rawDescription: 'TRF SEPA RENDA CASA', amount: -750, currency: 'EUR' }
    ];
    const details = () => [
        { date: '2026-03-05', description: 'Pingo Doce Saldanha', merchant: 'Pingo Doce', amount: -12.4, currency: 'EUR' },
        { date: '2026-03-06', description: 'Joao Silva', merchant: 'Joao Silva', amount: -25, currency: 'EUR' }
    ];

    it('improves the description without creating a row', () => {
        const { merged, enriched } = mergeDetailSource(statement(), details());
        expect(merged).toHaveLength(3);          // NOT 5 — this is the whole point
        expect(enriched).toHaveLength(2);
        expect(merged[0].description).toBe('Pingo Doce Saldanha');
        expect(merged[0].merchant).toBe('Pingo Doce');
        // Generic default — the engine must not name an institution.
        expect(merged[0].enrichedFrom).toBe('wallet');
    });

    it('records the enriching source by name when the caller supplies one', () => {
        const { merged } = mergeDetailSource(statement(), details(), { label: 'MB WAY · Wallet' });
        expect(merged[0].enrichedFrom).toBe('MB WAY · Wallet');
    });

    it('keeps the bank amount and date authoritative', () => {
        const skewed = [{ ...details()[0], date: '2026-03-06', amount: -12.4 }];
        const { merged } = mergeDetailSource(statement(), skewed);
        expect(merged[0].date).toBe('2026-03-05');   // the bank's date, not MB WAY's
        expect(merged[0].amount).toBe(-12.4);
    });

    it('preserves the original bank text for re-import matching', () => {
        const { merged } = mergeDetailSource(statement(), details());
        expect(merged[0].rawDescription).toBe('COMPRA MBWAY 12,40');
    });

    it('leaves untouched statement rows alone', () => {
        const { merged } = mergeDetailSource(statement(), details());
        expect(merged[2].description).toBe('TRF SEPA RENDA CASA');
        expect(merged[2].enrichedFrom).toBeUndefined();
    });

    it('holds an unposted detail row as pending rather than inventing a transaction', () => {
        const unposted = [...details(), { date: '2026-03-28', description: 'Cafe Tardio', merchant: 'Cafe', amount: -3.5, currency: 'EUR' }];
        const { merged, pending } = mergeDetailSource(statement(), unposted);
        expect(merged).toHaveLength(3);
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ merchant: 'Cafe' });
        expect(pending[0].fingerprint).toBeTruthy();
    });

    it('does not match beyond the posting window', () => {
        const late = [{ ...details()[0], date: '2026-03-20' }];
        const { enriched, pending } = mergeDetailSource(statement(), late);
        expect(enriched).toHaveLength(0);
        expect(pending).toHaveLength(1);
    });

    it('does not pair an outflow with an inflow of the same size', () => {
        const refund = [{ date: '2026-03-05', description: 'Refund', merchant: 'Shop', amount: 12.4, currency: 'EUR' }];
        expect(mergeDetailSource(statement(), refund).enriched).toHaveLength(0);
    });

    it('matches nearest in time when two bank rows share an amount', () => {
        const twice = [
            { id: 'a', accountId: 'mil', date: '2026-03-05', description: 'MBWAY', rawDescription: 'MBWAY', amount: -20 },
            { id: 'b', accountId: 'mil', date: '2026-03-15', description: 'MBWAY', rawDescription: 'MBWAY', amount: -20 }
        ];
        const { merged } = mergeDetailSource(twice, [{ date: '2026-03-15', description: 'Farmacia', merchant: 'Farmacia', amount: -20 }]);
        expect(merged[0].merchant).toBeUndefined();
        expect(merged[1].merchant).toBe('Farmacia');
    });

    it('links several detail rows posted to the bank as one aggregated line', () => {
        const agg = [{ id: 'agg', accountId: 'mil', date: '2026-03-10', description: 'MBWAY AGREGADO', rawDescription: 'MBWAY AGREGADO', amount: -30 }];
        const parts = [
            { date: '2026-03-09', description: 'Cafe', merchant: 'Cafe', amount: -10 },
            { date: '2026-03-09', description: 'Livraria', merchant: 'Livraria', amount: -20 }
        ];
        const { merged, aggregated, pending } = mergeDetailSource(agg, parts);
        expect(aggregated).toHaveLength(1);
        expect(merged[0].merchant).toBe('Cafe + Livraria');
        expect(merged[0].needsReview).toBe(true);   // a split posting deserves a human glance
        expect(pending).toHaveLength(0);
    });

    it('produces the same result whichever file is imported first', () => {
        // Order A: bank statement first, then MB WAY.
        const orderA = mergeDetailSource(statement(), details());

        // Order B: MB WAY first (everything pends), then the statement arrives
        // and the pending rows are replayed.
        const detailFirst = mergeDetailSource([], details());
        expect(detailFirst.pending).toHaveLength(2);
        const orderB = mergeDetailSource(statement(), detailFirst.pending);

        const shape = r => r.merged.map(m => ({ d: m.description, m: m.merchant || null, a: m.amount, raw: m.rawDescription }));
        expect(shape(orderB)).toEqual(shape(orderA));
        expect(orderB.pending).toEqual(orderA.pending);
    });

    it('is idempotent — re-running the merge does not re-enrich or duplicate', () => {
        const once = mergeDetailSource(statement(), details());
        const twice = mergeDetailSource(once.merged, details());
        expect(twice.merged).toHaveLength(3);
        expect(twice.enriched).toHaveLength(0);      // already claimed
        expect(twice.merged[0].description).toBe('Pingo Doce Saldanha');
    });
});

describe('applyRules / ruleFromCorrection', () => {
    const rows = [
        { description: 'COMPRA CONTINENTE COLOMBO', amount: -132.78 },
        { description: 'NETFLIX.COM 4321', amount: -13.99 },
        { description: 'ALGO DESCONHECIDO', amount: -9 }
    ];
    const rules = [
        { matchType: 'contains', pattern: 'continente', category: 'Groceries', priority: 1 },
        { matchType: 'regex', pattern: 'netflix', category: 'Subscriptions', priority: 1 }
    ];

    it('categorises what it can and leaves the rest for the AI', () => {
        const { rows: out, matched, unmatched } = applyRules(rows, rules);
        expect(matched).toBe(2);
        expect(out[0]).toMatchObject({ category: 'Groceries', categorySource: 'rule' });
        expect(out[1].category).toBe('Subscriptions');
        expect(unmatched).toHaveLength(1);
        expect(out[2].category).toBeNull();   // never silently bucketed as "Other"
    });

    it('respects rule priority', () => {
        const competing = [
            { matchType: 'contains', pattern: 'continente', category: 'Groceries', priority: 1 },
            { matchType: 'contains', pattern: 'continente colombo', category: 'Shopping', priority: 99 }
        ];
        expect(applyRules([rows[0]], competing).rows[0].category).toBe('Shopping');
    });

    it('never lets a bad saved regex break an import', () => {
        const bad = [{ matchType: 'regex', pattern: '([unclosed', category: 'X', priority: 1 }];
        expect(() => applyRules(rows, bad)).not.toThrow();
        expect(applyRules(rows, bad).matched).toBe(0);
    });

    it('leaves an already-categorised row alone', () => {
        const done = [{ description: 'COMPRA CONTINENTE', category: 'Manual', amount: -1 }];
        expect(applyRules(done, rules).rows[0].category).toBe('Manual');
    });

    it('turns a manual correction into a rule that catches the merchant next month', () => {
        const rule = ruleFromCorrection({ description: 'COMPRA 4321987654 FNAC CHIADO LISBOA' }, 'Shopping');
        expect(rule).toMatchObject({ category: 'Shopping', matchType: 'contains', priority: 10 });
        expect(rule.pattern).toBe('compra fnac chiado');   // digits dropped
        expect(applyRules([{ description: 'COMPRA 9999000011 FNAC CHIADO PORTO', amount: -20 }], [rule]).matched).toBe(1);
    });

    it('returns null when there is nothing distinctive to match on', () => {
        expect(ruleFromCorrection({ description: '12345' }, 'X')).toBeNull();
    });
});


describe('profile replay (anchoring on header content, not position)', () => {
    // A header with NO recognisable aliases — a bank in a language the alias
    // table has never seen. Fresh sniffing has almost nothing to score on here,
    // which is exactly when a remembered line number or a re-guess goes wrong.
    const HEADER = 'Buchungstag;Buchungstext;Betrag;Kontostand';
    const BODY = [
        '05-03-2026;Lebensmittel Markt;-42,10;1.200,00',
        '07-03-2026;Gehalt Maerz;2.400,00;3.600,00',
        '19-03-2026;Tankstelle A5;-71,55;3.528,45'
    ].join('\n');

    const withPreamble = (lines) => [...lines, HEADER, BODY].join('\n');

    const SHORT = withPreamble(['Kontoauszug 03/2026', 'IBAN DE00 0000 0000']);
    // The same bank a month later, having added two preamble lines — one of
    // them an ordinary marketing sentence that happens to contain commas.
    //
    // That sentence is genuinely destructive to fresh sniffing: it out-scores
    // the real header, so the separator is detected as ',' and the semicolon
    // data is then split on commas. Measured against the pre-fix code path,
    // this file produced ONE row with a fabricated amount of 45 instead of
    // three correct rows — money invented out of a punctuation coincidence.
    const LONGER = withPreamble([
        'Kontoauszug 04/2026',
        'IBAN DE00 0000 0000',
        'Sehr geehrte Kundin, sehr geehrter Kunde, beachten Sie bitte Folgendes'
    ]);

    function profileFrom(text) {
        const d = buildProfileDraft(text);
        return {
            signature: d.signature,
            // The user mapped these by hand in the dialog, because no alias matched.
            columnMap: { date: 0, description: 1, amount: 2, balance: 3 },
            dateFormat: 'dd-mm-yyyy', decimalStyle: 'eu', invertSign: false,
            skipRows: d.skipRows, label: 'test'
        };
    }

    it('locates the header by signature wherever it sits in the file', () => {
        const sig = headerSignature(HEADER.split(';'));
        expect(locateHeaderBySignature(SHORT, sig).index).toBe(2);
        expect(locateHeaderBySignature(LONGER, sig).index).toBe(3);
        expect(locateHeaderBySignature(SHORT, 'sig_doesnotexist')).toBeNull();
    });

    it('is not fooled by a preamble line that out-scores the real header', () => {
        const profile = profileFrom(SHORT);
        const r = parseWithProfile(LONGER, profile, { accountId: 'a' });
        // Without signature anchoring this returned a single fabricated row.
        expect(r.header).toEqual(['Buchungstag', 'Buchungstext', 'Betrag', 'Kontostand']);
        expect(r.parsed).toBe(3);
        expect(r.rows.map(x => x.amount)).not.toContain(45);
    });

    it('parses a later file correctly after the bank changed its preamble length', () => {
        const profile = profileFrom(SHORT);          // learned from the 2-line preamble
        const r = parseWithProfile(LONGER, profile, { accountId: 'a' });   // replayed on the 4-line one

        expect(r.headerDrift).toBe(false);
        expect(r.errors).toEqual([]);
        expect(r.rows).toHaveLength(3);
        // The decisive assertion: columns did NOT shift.
        expect(r.rows.map(x => x.amount)).toEqual([-42.1, 2400, -71.55]);
        expect(r.rows[0].description).toBe('Lebensmittel Markt');
        expect(r.rows[0].date).toBe('2026-03-05');
    });

    it('produces identical rows from both files, preamble notwithstanding', () => {
        const profile = profileFrom(SHORT);
        const strip = r => r.rows.map(({ date, description, amount }) => ({ date, description, amount }));
        expect(strip(parseWithProfile(LONGER, profile, { accountId: 'a' })))
            .toEqual(strip(parseWithProfile(SHORT, profile, { accountId: 'a' })));
    });

    it('flags drift instead of guessing when the header genuinely changed', () => {
        // The bank renamed its columns: the profile no longer describes this file.
        const renamed = SHORT.replace(HEADER, 'Datum;Verwendungszweck;Umsatz;Saldo');
        const r = parseWithProfile(renamed, profileFrom(SHORT), { accountId: 'a' });
        expect(r.headerDrift).toBe(true);
    });

    it('carries the running balance through as transport for verification', () => {
        const r = parseWithProfile(SHORT, profileFrom(SHORT), { accountId: 'a' });
        expect(r.rows.map(x => x.balance)).toEqual([1200, 3600, 3528.45]);
    });
});


describe('language independence', () => {
    // Nothing in the engine may depend on recognising a column name. These are
    // headers no alias in the table has ever seen.
    const HUNGARIAN = `Számlakivonat 2026/03
Ügyfél: Teszt Elek

Könyvelés napja;Megnevezés;Összeg;Egyenleg
05-03-2026;Élelmiszerbolt;-42,10;1.200,00
07-03-2026;Munkabér;2.400,00;3.600,00
19-03-2026;Benzinkút;-71,55;3.528,45`;

    it('still finds the header row with zero alias matches', () => {
        // Structural signal: the header is the line whose column count and
        // separator the data rows agree on.
        const { header, rows, skipRows } = sniffCsv(HUNGARIAN);
        expect(header).toEqual(['Könyvelés napja', 'Megnevezés', 'Összeg', 'Egyenleg']);
        expect(skipRows).toBe(2);
        expect(rows).toHaveLength(3);
    });

    it('reports what it cannot name, and still hands back a usable draft', () => {
        const d = buildProfileDraft(HUNGARIAN);
        expect(d.unresolved).toContain('date');
        expect(d.needsConfirmation).toBe(true);
        // The dialog can still be rendered: header and samples are present.
        expect(d.header).toHaveLength(4);
        expect(d.sampleRows.length).toBeGreaterThan(0);
    });

    it('parses correctly once a human has mapped the columns', () => {
        const d = buildProfileDraft(HUNGARIAN);
        const profile = {
            signature: d.signature,
            columnMap: { date: 0, description: 1, amount: 2, balance: 3 },
            dateFormat: 'dd-mm-yyyy', decimalStyle: 'eu', invertSign: false
        };
        const r = parseWithProfile(HUNGARIAN, profile, { accountId: 'a' });
        expect(r.errors).toEqual([]);
        expect(r.rows.map(x => x.amount)).toEqual([-42.1, 2400, -71.55]);
        expect(r.rows[1].description).toBe('Munkabér');
    });
});

describe('date format coverage', () => {
    it('handles the year-first-day-second layout some exports use', () => {
        expect(parseDateWithFormat('2026-05-03', 'yyyy-dd-mm')).toBe('2026-03-05');
    });

    it('exposes the format list as data for the mapping dialog to render', () => {
        expect(DATE_FORMATS).toContain('dd-mm-yyyy');
        expect(DATE_FORMATS).toContain('yyyy-mm-dd');
        expect(DATE_FORMATS.length).toBeGreaterThanOrEqual(4);
    });
});


describe('mergeDetailSource — purity and bounds', () => {
    const stmt = (n) => Array.from({ length: n }, (_, i) => ({
        id: 's' + i, accountId: 'mil', date: '2026-03-10',
        description: 'MBWAY', rawDescription: 'MBWAY', amount: -(100 + i), currency: 'EUR'
    }));
    const details = (n, date = '2026-03-10') => Array.from({ length: n }, (_, i) => ({
        date, description: 'shop ' + i, merchant: 'shop ' + i, amount: -(1 + i), currency: 'EUR'
    }));

    it('does not mutate the rows it is given', () => {
        // These are the caller's objects — in the importer they are live state.
        // Stamping a marker on them made a second import in the same session
        // silently skip those rows.
        const input = details(6);
        const snapshot = JSON.stringify(input);
        mergeDetailSource(stmt(4), input);
        expect(JSON.stringify(input)).toBe(snapshot);
        expect(input.some(d => '__used' in d)).toBe(false);
    });

    it('a second merge over the same detail rows behaves identically', () => {
        const targets = stmt(3), input = details(4);
        const a = mergeDetailSource(targets, input);
        const b = mergeDetailSource(targets, input);
        expect(b.pending.map(p => p.description)).toEqual(a.pending.map(p => p.description));
        expect(b.enriched.length).toBe(a.enriched.length);
    });

    it('reports a too-dense window instead of exhausting every triple', () => {
        // 500 same-day wallet rows, and statement amounts no single row and no
        // pair or triple can sum to — so pass 1 claims nothing and pass 2 faces
        // the full pool. This is the shape that took ~10s before it was bounded.
        const unmatchable = Array.from({ length: 20 }, (_, i) => ({
            id: 'u' + i, accountId: 'mil', date: '2026-03-10',
            description: 'MBWAY', rawDescription: 'MBWAY', amount: -(9999.5 + i), currency: 'EUR'
        }));
        const started = Date.now();
        const r = mergeDetailSource(unmatchable, details(500));
        expect(Date.now() - started).toBeLessThan(1500);
        expect(r.tooDense).toBeGreaterThan(0);
        expect(r.pending.length).toBeGreaterThan(0);   // nothing invented, nothing lost
    });

    it('still finds a genuine aggregate within a reasonable window', () => {
        const target = [{ id: 'agg', accountId: 'mil', date: '2026-03-10',
                          description: 'MBWAY AGREGADO', rawDescription: 'MBWAY AGREGADO', amount: -30 }];
        const parts = [
            { date: '2026-03-09', description: 'Cafe', merchant: 'Cafe', amount: -10 },
            { date: '2026-03-09', description: 'Livraria', merchant: 'Livraria', amount: -20 }
        ];
        const r = mergeDetailSource(target, parts);
        expect(r.aggregated).toHaveLength(1);
        expect(r.merged[0].merchant).toBe('Cafe + Livraria');
    });

    it('remains order-independent after bucketing', () => {
        const targets = [
            { id: 'a', accountId: 'mil', date: '2026-03-05', description: 'MBWAY', rawDescription: 'MBWAY', amount: -12.4 },
            { id: 'b', accountId: 'mil', date: '2026-03-07', description: 'MBWAY', rawDescription: 'MBWAY', amount: -25 }
        ];
        const wallet = [
            { date: '2026-03-05', description: 'Pingo Doce', merchant: 'Pingo Doce', amount: -12.4 },
            { date: '2026-03-06', description: 'Joao', merchant: 'Joao', amount: -25 }
        ];
        const after = mergeDetailSource(targets, wallet);
        const firstPending = mergeDetailSource([], wallet).pending;
        const before = mergeDetailSource(targets, firstPending);
        const shape = r => r.merged.map(m => ({ d: m.description, a: m.amount }));
        expect(shape(before)).toEqual(shape(after));
    });
});


describe('rules learned from a correction actually match', () => {
    it('tolerates the short words the pattern builder drops', () => {
        // ruleFromCorrection drops words under three characters, but the text
        // being searched keeps them. A substring test therefore matched NOTHING
        // for the majority of real Portuguese descriptions — "COMPRAS C.DEB
        // UBER" searched as "compras c deb uber" against the rule "compras deb
        // uber". Correcting a category taught a rule that never fired again,
        // which is the entire point of the feature.
        const rule = ruleFromCorrection({ description: 'COMPRAS C.DEB UBER' }, 'Transport');
        expect(rule.pattern).toBe('compras deb uber');

        const rows = [
            { description: 'COMPRAS C.DEB UBER', amount: -8.9 },
            { description: 'COMPRAS C.DEB UBER B.', amount: -4.99 },
            { description: 'COMPRAS C.DEB UBER T', amount: -6.2 }
        ];
        expect(applyRules(rows, [rule]).matched).toBe(3);
    });

    it('still requires every distinctive word, in order', () => {
        const rule = ruleFromCorrection({ description: 'COMPRAS C.DEB UBER' }, 'Transport');
        const others = [
            { description: 'COMPRAS C.DEB APPLE.C', amount: -9.99 },   // no "uber"
            { description: 'UBER COMPRAS DEB', amount: -5 },           // wrong order
            { description: 'LEVANTAMENTO ATM', amount: -200 }
        ];
        expect(applyRules(others, [rule]).matched).toBe(0);
    });

    it('does not let a generic prefix swallow unrelated merchants', () => {
        // "compras deb" alone would match every card purchase in the account.
        const uber = ruleFromCorrection({ description: 'COMPRAS C.DEB UBER' }, 'Transport');
        const rows = [
            { description: 'COMPRAS C.DEB CONTINENTE', amount: -40 },
            { description: 'COMPRAS C.DEB FARMACIA', amount: -12 }
        ];
        expect(applyRules(rows, [uber]).matched).toBe(0);
    });

    it('matches across noise the bank inserts between the words', () => {
        const rule = ruleFromCorrection({ description: 'SOLINCA HEALTH CLUB' }, 'Health');
        expect(applyRules([{ description: 'SOLINCA 4471 HEALTH F CLUB PORTO', amount: -28 }], [rule]).matched).toBe(1);
    });
});

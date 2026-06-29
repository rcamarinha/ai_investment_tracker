import { describe, it, expect } from 'vitest';
import {
  isISIN,
  parseFlexibleNumber,
  parseSignedNumber,
  detectCurrency,
  normalizeDate,
  detectBroker,
  parseDegiroCsv,
  detectSplitPairs,
  collectUnresolved,
  applyUnresolvedDecisions,
  parseRevolutCsv,
  normalizeTrades,
  parseBrokerExport,
  tradeFingerprint,
  buildExistingFingerprints,
  dedupeTrades,
  computePositionsFromLedger,
} from '../services/import-brokers.js';

// ── Helpers ────────────────────────────────────────────────────────────────

describe('parseSignedNumber', () => {
  it('preserves a leading minus', () => {
    expect(parseSignedNumber('-5')).toBe(-5);
  });
  it('treats parentheses as negative', () => {
    expect(parseSignedNumber('(10)')).toBe(-10);
  });
  it('parses European decimals', () => {
    expect(parseSignedNumber('-12,50')).toBeCloseTo(-12.5);
  });
  it('parses positive plain numbers', () => {
    expect(parseSignedNumber('7')).toBe(7);
  });
});

describe('detectCurrency', () => {
  it('detects USD from $', () => expect(detectCurrency('$150')).toBe('USD'));
  it('detects EUR from €', () => expect(detectCurrency('€150')).toBe('EUR'));
  it('detects GBP from £', () => expect(detectCurrency('£99')).toBe('GBP'));
  it('detects code from text', () => expect(detectCurrency('USD')).toBe('USD'));
  it('falls back when unknown', () => expect(detectCurrency('', 'EUR')).toBe('EUR'));
});

describe('normalizeDate', () => {
  it('normalizes DD-MM-YYYY', () => expect(normalizeDate('05-03-2024')).toBe('2024-03-05'));
  it('normalizes DD/MM/YYYY', () => expect(normalizeDate('5/3/2024')).toBe('2024-03-05'));
  it('keeps ISO dates', () => expect(normalizeDate('2024-03-05')).toBe('2024-03-05'));
  it('strips ISO time', () => expect(normalizeDate('2024-03-05 14:30')).toBe('2024-03-05'));
});

// ── Broker detection ─────────────────────────────────────────────────────────

describe('detectBroker', () => {
  it('detects Revolut by Price per share + Total Amount', () => {
    expect(detectBroker('Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency')).toBe('revolut');
  });
  it('detects DeGiro by ISIN + Quantity', () => {
    expect(detectBroker('Date,Time,Product,ISIN,Reference,Venue,Quantity,Price')).toBe('degiro');
  });
  it('returns null for unknown', () => {
    expect(detectBroker('foo,bar,baz')).toBeNull();
  });
});

// ── DeGiro ───────────────────────────────────────────────────────────────────

describe('parseDegiroCsv', () => {
  const header = 'Date,Time,Product,ISIN,Reference,Venue,Quantity,Price,,Local value,,Value,,Exchange rate,Transaction costs,,Total,,Order ID';

  it('parses a buy with positive quantity', () => {
    const csv = [header, '02-01-2024,09:00,Apple Inc,US0378331005,ref,NSY,10,150.00,USD,-1500.00,USD,-1380.00,EUR,1.08,-0.50,EUR,-1380.50,EUR,abc'].join('\n');
    const { trades, errors } = parseDegiroCsv(csv);
    expect(errors).toHaveLength(0);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      identifier: 'US0378331005', isISIN: true, side: 'buy', shares: 10, price: 150, currency: 'USD', broker: 'degiro', name: 'Apple Inc',
    });
    expect(trades[0].date).toBe('2024-01-02');
    expect(trades[0].fees).toBeCloseTo(0.5);
  });

  it('treats negative quantity as a sell', () => {
    const csv = [header, '03-01-2024,10:00,Tesla,US88160R1014,ref,NDQ,-5,200.00,USD,1000.00,USD,920.00,EUR,1.08,-0.50,EUR,919.50,EUR,def'].join('\n');
    const { trades } = parseDegiroCsv(csv);
    expect(trades[0].side).toBe('sell');
    expect(trades[0].shares).toBe(5);
  });

  it('parses European number formatting', () => {
    const csv = [header.replace(/,/g, ';'), '04-01-2024;11:00;ASML;NL0010273215;ref;EAM;3;1.234,56;EUR;-3703,68;EUR;-3703,68;EUR;1;-2,00;EUR;-3705,68;EUR;ghi'].join('\n');
    const { trades } = parseDegiroCsv(csv);
    expect(trades[0].price).toBeCloseTo(1234.56);
    expect(trades[0].currency).toBe('EUR');
  });

  it('skips rows with zero/empty quantity', () => {
    const csv = [header, '05-01-2024,09:00,Cash,,ref,,,,,,,,,,,,,,'].join('\n');
    const { trades, skipped } = parseDegiroCsv(csv);
    expect(trades).toHaveLength(0);
    expect(skipped).toBeGreaterThanOrEqual(1);
  });

  // Real-world DeGiro export: Portuguese headers, comma-separated, quoted
  // European numbers, currency in the unnamed column after "Preços".
  const ptHeader = 'Data,Hora,Produto,ISIN,Bolsa de referência,Bolsa,Quantidade,Preços,,Valor local,,Valor EUR,Taxa de Câmbio,Taxa Autofx,Custos de transação e/ou taxas de terceiros,Total EUR,ID da Ordem,';

  it('parses the real Portuguese DeGiro format (accented headers)', () => {
    const csv = [ptHeader, '16-06-2026,21:10,SPACE EXPLORATION,US84615Q1031,NDQ,EDGX,4,"205,0000",USD,"-820,00",USD,"-706,17","1,1612","-1,77","-2,00","-709,94",,abc'].join('\n');
    const { trades, errors } = parseDegiroCsv(csv);
    expect(errors).toHaveLength(0);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ identifier: 'US84615Q1031', side: 'buy', shares: 4, price: 205, currency: 'USD' });
    expect(trades[0].date).toBe('2026-06-16');
    expect(trades[0].fees).toBeCloseTo(2.0);
  });

  it('handles European prices >= 1000 without thousands separators', () => {
    const csv = [ptHeader, '10-06-2024,00:00,NVIDIA CORP,US67066G1040,NDQ,,-3,"1208,8800",USD,"3626,64",USD,"3368,79","1,0765","0,00",,"3368,79",,x'].join('\n');
    const { trades } = parseDegiroCsv(csv);
    expect(trades[0].price).toBeCloseTo(1208.88);
    expect(trades[0].side).toBe('sell');
    expect(trades[0].shares).toBe(3);
  });

  it('does not error on zero-price corporate actions (routes them to review)', () => {
    const csv = [ptHeader, '31-07-2025,07:49,BYD CO LTD - NON TRADEABLE,CNE100000296,DEG,,-43,"0,0000",EUR,"0,00",EUR,"0,00",,"0,00",,"0,00",'].join('\n');
    const { trades, errors, review } = parseDegiroCsv(csv);
    expect(trades).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(review).toHaveLength(1);
  });

  it('detects the Portuguese DeGiro header as degiro', () => {
    expect(detectBroker(ptHeader)).toBe('degiro');
  });

  it('surfaces zero-price corporate-action rows for review (not silent drop)', () => {
    const csv = [ptHeader, '31-07-2025,07:49,BYD CO LTD - NON TRADEABLE,CNE100000296,DEG,,-43,"0,0000",EUR,"0,00",EUR,"0,00",,"0,00",,"0,00",'].join('\n');
    const { trades, review } = parseDegiroCsv(csv);
    expect(trades).toHaveLength(0);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ reason: 'corporate_action', identifier: 'CNE100000296', signedShares: -43 });
  });

  it('flags a split pair (buy 30 / sell 3 at 10x price) for review', () => {
    const csv = [
      ptHeader,
      '10-06-2024,00:00,NVIDIA CORP,US67066G1040,NDQ,,30,"120,8880",USD,"-3626,64",USD,"-3368,79","1,0765","0,00",,"-3368,79",,a',
      '10-06-2024,00:00,NVIDIA CORP,US67066G1040,NDQ,,-3,"1208,8800",USD,"3626,64",USD,"3368,79","1,0765","0,00",,"3368,79",,b',
    ].join('\n');
    const { trades, review } = parseDegiroCsv(csv);
    expect(trades).toHaveLength(0); // both rows pulled out of trades
    const split = review.find(r => r.reason === 'possible_split');
    expect(split).toBeTruthy();
    expect(split.ratio).toBeCloseTo(10);
    expect(split.identifier).toBe('US67066G1040');
  });
});

describe('detectSplitPairs', () => {
  it('leaves ordinary same-day trades alone', () => {
    const trades = [
      { identifier: 'AAPL', date: '2024-01-02', side: 'buy', shares: 10, price: 150 },
      { identifier: 'AAPL', date: '2024-01-02', side: 'sell', shares: 5, price: 152 },
    ];
    const { kept, flagged } = detectSplitPairs(trades);
    expect(kept).toHaveLength(2);
    expect(flagged).toHaveLength(0);
  });

  it('flags an extreme-price buy/sell pair as a possible split', () => {
    const trades = [
      { identifier: 'NVDA', date: '2024-06-10', side: 'buy', shares: 30, price: 120.88, isISIN: false },
      { identifier: 'NVDA', date: '2024-06-10', side: 'sell', shares: 3, price: 1208.88, isISIN: false },
    ];
    const { kept, flagged } = detectSplitPairs(trades);
    expect(kept).toHaveLength(0);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].ratio).toBeCloseTo(10);
  });
});

describe('parseFlexibleNumber (broker)', () => {
  it('parses European decimals without thousands sep', () => {
    expect(parseFlexibleNumber('1208,8800')).toBeCloseTo(1208.88);
    expect(parseFlexibleNumber('205,0000')).toBeCloseTo(205);
    expect(parseFlexibleNumber('-2497,06')).toBeCloseTo(-2497.06);
  });
  it('parses European with dot thousands + comma decimal', () => {
    expect(parseFlexibleNumber('1.234,56')).toBeCloseTo(1234.56);
  });
  it('parses US with comma thousands + dot decimal', () => {
    expect(parseFlexibleNumber('$1,234.56')).toBeCloseTo(1234.56);
  });
  it('treats a lone comma group as thousands (1,234 → 1234)', () => {
    expect(parseFlexibleNumber('1,234')).toBeCloseTo(1234);
  });
});

// ── Revolut ──────────────────────────────────────────────────────────────────

describe('parseRevolutCsv', () => {
  const header = 'Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency';

  it('parses BUY and SELL rows', () => {
    const csv = [
      header,
      '2024-01-02T09:00:00.000Z,AAPL,BUY - MARKET,10,$150.00,$1500.00,USD',
      '2024-02-02T09:00:00.000Z,AAPL,SELL - MARKET,4,$170.00,$680.00,USD',
    ].join('\n');
    const { trades, errors } = parseRevolutCsv(csv);
    expect(errors).toHaveLength(0);
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ identifier: 'AAPL', side: 'buy', shares: 10, price: 150, currency: 'USD' });
    expect(trades[1]).toMatchObject({ side: 'sell', shares: 4, price: 170 });
  });

  it('routes dividends to income, skips top-ups, keeps buys', () => {
    const csv = [
      header,
      '2024-01-03,AAPL,DIVIDEND,0,$0.00,$2.50,USD',
      '2024-01-04,,CASH TOP-UP,0,,$100.00,USD',
      '2024-01-05,VUSA,BUY - MARKET,2,$80.00,$160.00,USD',
    ].join('\n');
    const { trades, income, skipped } = parseRevolutCsv(csv);
    expect(trades).toHaveLength(1);
    expect(trades[0].identifier).toBe('VUSA');
    expect(income).toHaveLength(1);
    expect(income[0]).toMatchObject({ type: 'dividend', identifier: 'AAPL', amount: 2.5 });
    expect(skipped).toBe(1); // only the cash top-up
  });

  it('derives price from total when price column missing', () => {
    const csv = [
      'Date,Ticker,Type,Quantity,Total Amount,Currency',
      '2024-01-06,MSFT,BUY - MARKET,2,$800.00,USD',
    ].join('\n');
    const { trades } = parseRevolutCsv(csv);
    expect(trades[0].price).toBeCloseTo(400);
  });

  it('handles quoted amounts with internal commas', () => {
    const csv = [
      header,
      '2024-01-07,GOOGL,BUY - MARKET,1,"$1,234.56","$1,234.56",USD',
    ].join('\n');
    const { trades } = parseRevolutCsv(csv);
    expect(trades[0].price).toBeCloseTo(1234.56);
  });

  it('captures dividend rows as income (not trades)', () => {
    const csv = [
      'Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,Withholding tax',
      '2024-03-01,KO,DIVIDEND,0,,$44.00,USD,$6.60',
      '2024-03-02,KO,BUY - MARKET,10,$50.00,$500.00,USD,',
    ].join('\n');
    const { trades, income } = parseRevolutCsv(csv);
    expect(trades).toHaveLength(1);
    expect(income).toHaveLength(1);
    expect(income[0]).toMatchObject({ type: 'dividend', identifier: 'KO', amount: 44, tax: 6.6, currency: 'USD' });
  });

  it('captures custody fees as income with a CASH symbol when no ticker', () => {
    const csv = [
      header,
      '2024-03-31,,CUSTODY FEE,0,,$1.50,USD',
    ].join('\n');
    const { income } = parseRevolutCsv(csv);
    expect(income).toHaveLength(1);
    expect(income[0]).toMatchObject({ type: 'fee', identifier: 'CASH', amount: 1.5 });
  });

  it('still skips top-ups and transfers', () => {
    const csv = [
      header,
      '2024-01-04,,CASH TOP-UP,0,,$100.00,USD',
    ].join('\n');
    const { trades, income, skipped } = parseRevolutCsv(csv);
    expect(trades).toHaveLength(0);
    expect(income).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('captures STOCK SPLIT rows as a signed share-delta split', () => {
    const csv = [
      header,
      '2020-08-31,AAPL,STOCK SPLIT,3,,USD 0,USD',     // 4:1 → +3
      '2024-09-11,HYZN,STOCK SPLIT,-78.4,,USD 0,USD',  // reverse → negative
    ].join('\n');
    const { income, skipped } = parseRevolutCsv(csv);
    const splits = income.filter(i => i.type === 'split');
    expect(splits).toHaveLength(2);
    expect(splits[0]).toMatchObject({ identifier: 'AAPL', type: 'split', shares: 3 });
    expect(splits[1].shares).toBeCloseTo(-78.4);
    expect(skipped).toBe(0);
  });

  it('excludes DIVIDEND TAX (CORRECTION) rows from income', () => {
    const csv = [
      header,
      '2025-07-02,MSFT,DIVIDEND TAX (CORRECTION),,,USD -0.25,USD',
      '2025-07-02,MSFT,DIVIDEND TAX (CORRECTION),,,USD 0.25,USD',
      '2025-06-13,MSFT,DIVIDEND,,,USD 1.41,USD',
    ].join('\n');
    const { income, skipped } = parseRevolutCsv(csv);
    const divs = income.filter(i => i.type === 'dividend');
    expect(divs).toHaveLength(1);
    expect(divs[0].amount).toBeCloseTo(1.41);
    expect(skipped).toBe(2); // the two tax-correction rows
  });

  it('treats CUSTODY FEE REVERSAL as a negative (refunded) fee', () => {
    const csv = [
      header,
      '2022-12-14,,CUSTODY FEE,,,USD -1.01,USD',
      '2022-12-14,,CUSTODY FEE REVERSAL,,,USD 1.01,USD',
    ].join('\n');
    const { income } = parseRevolutCsv(csv);
    const fees = income.filter(i => i.type === 'fee');
    expect(fees).toHaveLength(2);
    expect(fees[0].amount).toBeCloseTo(1.01);   // a real fee
    expect(fees[1].amount).toBeCloseTo(-1.01);  // the reversal nets it out
  });
});

describe('computePositionsFromLedger — additive (Revolut) splits', () => {
  it('applies a positive share delta with cost unchanged', () => {
    const txs = {
      AAPL: [
        { type: 'buy', shares: 1, price: 400, date: '2020-01-01' },
        { type: 'split', shares: 3, date: '2020-08-31' }, // 4:1 → +3, no ratio
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(pos.AAPL.shares).toBe(4);
    expect(pos.AAPL.avgPrice).toBeCloseTo(100); // 400 cost / 4 shares
  });

  it('applies a reverse (negative) share delta', () => {
    const txs = {
      HYZN: [
        { type: 'buy', shares: 80, price: 5, date: '2022-01-01' },
        { type: 'split', shares: -78.4, date: '2024-09-11' },
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(pos.HYZN.shares).toBeCloseTo(1.6);
    expect(pos.HYZN.avgPrice).toBeCloseTo(250); // 400 cost / 1.6 shares
  });

  it('dedupes a re-imported delta split via its share fingerprint', () => {
    const existing = buildExistingFingerprints({
      AAPL: [{ type: 'split', shares: 3, date: '2020-08-31' }],
    });
    const incoming = [{ type: 'split', symbol: 'AAPL', identifier: 'AAPL', date: '2020-08-31', shares: 3 }];
    const { fresh, duplicates } = dedupeTrades(incoming, existing);
    expect(fresh).toHaveLength(0);
    expect(duplicates).toHaveLength(1);
  });
});

// ── Dispatch ─────────────────────────────────────────────────────────────────

describe('parseBrokerExport', () => {
  it('routes Revolut CSV to the Revolut parser', () => {
    const csv = 'Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency\n2024-01-02,AAPL,BUY - MARKET,1,$150,$150,USD';
    const res = parseBrokerExport(csv);
    expect(res.broker).toBe('revolut');
    expect(res.trades).toHaveLength(1);
  });
  it('reports unrecognized formats', () => {
    const res = parseBrokerExport('a,b,c\n1,2,3');
    expect(res.broker).toBeNull();
    expect(res.errors.length).toBeGreaterThan(0);
  });
});

// ── AI fallback normalization ────────────────────────────────────────────────

describe('normalizeTrades', () => {
  it('normalizes loose AI rows', () => {
    const rows = [
      { date: '05-03-2024', identifier: 'AAPL', side: 'BUY', shares: '10', price: '150' },
      { date: '2024-04-01', ticker: 'TSLA', type: 'sell', quantity: 3, price: 200, currency: 'USD' },
    ];
    const { trades } = normalizeTrades(rows, 'generic');
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ identifier: 'AAPL', side: 'buy', shares: 10, price: 150, date: '2024-03-05' });
    expect(trades[1]).toMatchObject({ identifier: 'TSLA', side: 'sell', shares: 3 });
  });
  it('skips incomplete rows', () => {
    const { trades, skipped } = normalizeTrades([{ identifier: 'AAPL' }]);
    expect(trades).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});

// ── Dedupe ───────────────────────────────────────────────────────────────────

describe('tradeFingerprint + dedupe', () => {
  it('produces equal fingerprints for matching trade and ledger row', () => {
    const trade = { date: '2024-01-02', identifier: 'AAPL', side: 'buy', shares: 10, price: 150 };
    const ledgerRow = { date: '2024-01-02', symbol: 'AAPL', type: 'buy', shares: 10, price: 150 };
    expect(tradeFingerprint(trade)).toBe(tradeFingerprint({ ...ledgerRow, identifier: ledgerRow.symbol }));
  });

  it('skips trades already present in the ledger', () => {
    const existing = buildExistingFingerprints({
      AAPL: [{ type: 'buy', shares: 10, price: 150, date: '2024-01-02' }],
    });
    const incoming = [
      { date: '2024-01-02', identifier: 'AAPL', side: 'buy', shares: 10, price: 150 },
      { date: '2024-02-02', identifier: 'AAPL', side: 'sell', shares: 4, price: 170 },
    ];
    const { fresh, duplicates } = dedupeTrades(incoming, existing);
    expect(fresh).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(fresh[0].side).toBe('sell');
  });

  it('matches a re-imported ISIN trade against its ledger ticker row', () => {
    // Ledger stores the trade under the resolved ticker (AAPL)…
    const existing = buildExistingFingerprints({
      AAPL: [{ type: 'buy', shares: 10, price: 150, date: '2024-01-02' }],
    });
    // …while a re-imported DeGiro row still carries the ISIN as identifier,
    // resolved to symbol AAPL before dedupe.
    const incoming = [
      { date: '2024-01-02', identifier: 'US0378331005', symbol: 'AAPL', side: 'buy', shares: 10, price: 150 },
    ];
    const { fresh, duplicates } = dedupeTrades(incoming, existing);
    expect(fresh).toHaveLength(0);
    expect(duplicates).toHaveLength(1);
  });

  it('keeps genuine identical fills on a fresh import', () => {
    // Two identical partial fills of one order in the same file are both real.
    const t = { date: '2024-01-02', identifier: 'AAPL', side: 'buy', shares: 3, price: 32.18 };
    const { fresh, duplicates } = dedupeTrades([t, { ...t }]);
    expect(fresh).toHaveLength(2);
    expect(duplicates).toHaveLength(0);
  });

  it('marks both copies as duplicate when re-importing identical fills', () => {
    const existing = buildExistingFingerprints({
      AAPL: [
        { type: 'buy', shares: 3, price: 32.18, date: '2024-01-02' },
        { type: 'buy', shares: 3, price: 32.18, date: '2024-01-02' },
      ],
    });
    const t = { date: '2024-01-02', identifier: 'AAPL', symbol: 'AAPL', side: 'buy', shares: 3, price: 32.18 };
    const { fresh, duplicates } = dedupeTrades([t, { ...t }], existing);
    expect(fresh).toHaveLength(0);
    expect(duplicates).toHaveLength(2);
  });
});

// ── Position rebuild ─────────────────────────────────────────────────────────

describe('computePositionsFromLedger', () => {
  it('computes net shares and weighted-average cost across buys', () => {
    const txs = {
      AAPL: [
        { type: 'buy', shares: 10, price: 100, date: '2024-01-01' },
        { type: 'buy', shares: 10, price: 200, date: '2024-02-01' },
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(pos.AAPL.shares).toBe(20);
    expect(pos.AAPL.avgPrice).toBeCloseTo(150);
  });

  it('handles a partial sell with average-cost realized P&L', () => {
    const txs = {
      AAPL: [
        { type: 'buy', shares: 10, price: 100, date: '2024-01-01' },
        { type: 'buy', shares: 10, price: 200, date: '2024-02-01' },
        { type: 'sell', shares: 5, price: 300, date: '2024-03-01' },
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(pos.AAPL.shares).toBe(15);
    expect(pos.AAPL.avgPrice).toBeCloseTo(150); // avg unchanged by sell
    expect(pos.AAPL.realizedPnL).toBeCloseTo((300 - 150) * 5);
  });

  it('zeroes out a fully-closed position', () => {
    const txs = {
      TSLA: [
        { type: 'buy', shares: 5, price: 200, date: '2024-01-01' },
        { type: 'sell', shares: 5, price: 250, date: '2024-02-01' },
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(pos.TSLA.shares).toBe(0);
    expect(pos.TSLA.avgPrice).toBe(0);
    expect(pos.TSLA.realizedPnL).toBeCloseTo(250);
  });

  it('applies a split: shares ×ratio, avg ÷ratio, cost basis unchanged', () => {
    const txs = {
      NVDA: [
        { type: 'buy', shares: 3, price: 425, date: '2023-09-26' },
        { type: 'split', ratio: 10, date: '2024-06-10' },
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(pos.NVDA.shares).toBeCloseTo(30);
    expect(pos.NVDA.avgPrice).toBeCloseTo(42.5);
  });

  it('folds buy/sell fees into cost basis and realized P&L', () => {
    const txs = {
      AAPL: [
        { type: 'buy', shares: 10, price: 100, fee: 5, date: '2024-01-01' },   // cost 1005
        { type: 'sell', shares: 10, price: 120, fee: 5, date: '2024-02-01' },  // proceeds 1195
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(pos.AAPL.shares).toBe(0);
    expect(pos.AAPL.realizedPnL).toBeCloseTo(1195 - 1005); // 190
    expect(pos.AAPL.feesPaid).toBeCloseTo(10);
  });

  it('aggregates dividends (with tax) and fees without affecting shares', () => {
    const txs = {
      KO: [
        { type: 'buy', shares: 100, price: 50, date: '2024-01-01' },
        { type: 'dividend', amount: 44, tax: 6.6, date: '2024-03-01' },
        { type: 'dividend', amount: 44, tax: 6.6, date: '2024-06-01' },
        { type: 'fee', amount: 2.5, date: '2024-06-30' },
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(pos.KO.shares).toBe(100);
    expect(pos.KO.avgPrice).toBeCloseTo(50);
    expect(pos.KO.dividends).toBeCloseTo(88);
    expect(pos.KO.taxWithheld).toBeCloseTo(13.2);
    expect(pos.KO.feesPaid).toBeCloseTo(2.5);
  });

  it('ignores corrupt out-of-range split ratios (no Infinity shares)', () => {
    const txs = {
      Z: [
        { type: 'buy', shares: 10, price: 5, date: '2024-01-01' },
        { type: 'split', ratio: 1e100, date: '2024-02-01' },
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(Number.isFinite(pos.Z.shares)).toBe(true);
    expect(pos.Z.shares).toBe(10); // ratio rejected → unchanged
  });

  it('flags needsReview when a sell drives shares negative', () => {
    const txs = {
      X: [
        { type: 'buy', shares: 2, price: 10, date: '2024-01-01' },
        { type: 'sell', shares: 5, price: 12, date: '2024-02-01' },
      ],
    };
    const pos = computePositionsFromLedger(txs);
    expect(pos.X.needsReview).toBe(true);
  });
});

describe('tradeFingerprint (non-trade rows)', () => {
  it('fingerprints dividends by date|symbol|type|amount', () => {
    const a = tradeFingerprint({ date: '2024-03-01', symbol: 'KO', type: 'dividend', amount: 44 });
    const b = tradeFingerprint({ date: '2024-03-01', symbol: 'KO', type: 'dividend', amount: 44 });
    expect(a).toBe(b);
    expect(a).toBe('2024-03-01|KO|dividend|44.0000');
  });

  it('dedupes re-imported dividends but keeps distinct amounts', () => {
    const existing = buildExistingFingerprints({
      KO: [{ type: 'dividend', amount: 44, date: '2024-03-01' }],
    });
    const incoming = [
      { date: '2024-03-01', symbol: 'KO', type: 'dividend', amount: 44 },  // dup
      { date: '2024-06-01', symbol: 'KO', type: 'dividend', amount: 44 },  // new (different date)
    ];
    const { fresh, duplicates } = dedupeTrades(incoming, existing);
    expect(fresh).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(fresh[0].date).toBe('2024-06-01');
  });
});

describe('unresolved-symbol handling', () => {
  const items = () => ([
    { identifier: 'IE00BYXVGX24', isISIN: true, name: 'Fidelity US Quality ETF', broker: 'degiro' },
    { identifier: 'AAPL', isISIN: false, symbol: 'AAPL' },                 // not an ISIN
    { identifier: 'US0378331005', isISIN: true, symbol: 'AAPL' },          // already resolved
    { identifier: 'IE00B1XNHC34', isISIN: true, name: 'iShares Clean Energy', broker: 'degiro' },
  ]);

  it('collects only the still-unresolved ISINs', () => {
    const resolved = { US0378331005: { ticker: 'AAPL' } };
    const out = collectUnresolved(items(), resolved);
    expect(out.map(o => o.identifier).sort()).toEqual(['IE00B1XNHC34', 'IE00BYXVGX24']);
    expect(out[0].name).toBeTruthy();
  });

  it('maps an ISIN to a ticker for every item sharing it', () => {
    const list = [
      { identifier: 'IE00BYXVGX24', isISIN: true },
      { identifier: 'IE00BYXVGX24', isISIN: true },
    ];
    const { skipped } = applyUnresolvedDecisions(list, { IE00BYXVGX24: { action: 'map', ticker: 'iusq.de' } });
    expect(list[0].symbol).toBe('IUSQ.DE');
    expect(list[1].symbol).toBe('IUSQ.DE');
    expect(skipped.size).toBe(0);
  });

  it('keeps an untracked item under its ISIN', () => {
    const list = [{ identifier: 'XS1234567890', isISIN: true }];
    applyUnresolvedDecisions(list, { XS1234567890: { action: 'untracked' } });
    expect(list[0].symbol).toBe('XS1234567890');
    expect(list[0].untracked).toBe(true);
  });

  it('skips an item left without a ticker', () => {
    const list = [{ identifier: 'XS9999999999', isISIN: true }];
    const { skipped } = applyUnresolvedDecisions(list, { XS9999999999: { action: 'skip' } });
    expect(list[0].symbol).toBeUndefined();
    expect(skipped.has('XS9999999999')).toBe(true);
  });
});

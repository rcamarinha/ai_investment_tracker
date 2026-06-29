/**
 * Broker trade-export parsers (DeGiro, Revolut) + normalization helpers.
 *
 * These functions are intentionally PURE: no DOM, no network, no imports from
 * DOM-coupled service modules. That keeps them directly unit-testable (tests
 * import this file as-is, no `src/` mirror needed) and reusable by the
 * `importTrades()` orchestrator in services/portfolio.js.
 *
 * Canonical normalized trade event shape:
 *   {
 *     date:       'YYYY-MM-DD',
 *     identifier: 'US0378331005' | 'AAPL',   // ISIN or ticker
 *     isISIN:     boolean,
 *     side:       'buy' | 'sell',
 *     shares:     number,   // always positive
 *     price:      number,   // per-share, native currency, positive
 *     fees:       number,   // >= 0
 *     currency:   'USD' | 'EUR' | ...,
 *     broker:     'degiro' | 'revolut' | 'generic',
 *     name:       string,   // product/asset name when available
 *   }
 */

// ── Small dependency-free helpers (mirror of portfolio.js logic) ─────────────

export function isISIN(value) {
    return /^[A-Z]{2}[A-Z0-9]{10}$/.test(String(value || '').toUpperCase());
}

/**
 * Parse a number that may use US (1,234.56) or European (1.234,56 / 1208,88)
 * formatting. Uses a "last separator wins" heuristic so it handles broker
 * exports that omit thousands separators (e.g. DeGiro's "1208,8800").
 */
export function parseFlexibleNumber(raw) {
    if (raw === null || raw === undefined) return NaN;
    let s = String(raw).trim();
    if (!s) return NaN;
    // Strip currency symbols, codes and whitespace, keep digits . , ( ) -
    s = s.replace(/[^0-9.,()\-]/g, '').trim();
    s = s.replace(/^\((.+)\)$/, '-$1');
    const neg = s.startsWith('-');
    s = s.replace(/-/g, '');
    if (!s) return NaN;

    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot !== -1 && lastComma !== -1) {
        // Both present — the later one is the decimal separator.
        if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.'); // European
        else s = s.replace(/,/g, '');                                       // US
    } else if (lastComma !== -1) {
        // Only commas. A single comma is a decimal separator unless it looks
        // like a thousands group ("1,234"); multiple commas are thousands.
        const commaCount = (s.match(/,/g) || []).length;
        const decimals = s.length - lastComma - 1;
        if (commaCount === 1 && decimals !== 3) s = s.replace(',', '.');
        else s = s.replace(/,/g, '');
    } else {
        // Only dots (or none). Multiple dots → thousands separators.
        const dotCount = (s.match(/\./g) || []).length;
        if (dotCount > 1) s = s.replace(/\./g, '');
        // A single dot is treated as a decimal point (US prices, e.g. 150.50).
    }
    const n = parseFloat(s);
    if (isNaN(n)) return NaN;
    return neg ? -n : n;
}

/** Like parseFlexibleNumber but preserves a leading minus / parentheses sign. */
export function parseSignedNumber(raw) {
    const s = String(raw == null ? '' : raw).trim();
    const negative = /^-/.test(s) || /^\(.*\)$/.test(s);
    const n = parseFlexibleNumber(s.replace(/^-/, '').replace(/[()]/g, ''));
    if (isNaN(n)) return NaN;
    return negative ? -n : n;
}

/** Infer a currency code from a value string containing a symbol or code. */
export function detectCurrency(raw, fallback = 'EUR') {
    const s = String(raw || '');
    if (/\$/.test(s) || /\bUSD\b/i.test(s)) return 'USD';
    if (/€/.test(s) || /\bEUR\b/i.test(s)) return 'EUR';
    if (/£/.test(s) || /\bGBP\b/i.test(s)) return 'GBP';
    if (/\bCHF\b/i.test(s)) return 'CHF';
    if (/\bSEK\b/i.test(s)) return 'SEK';
    if (/\bJPY\b/i.test(s) || /¥/.test(s)) return 'JPY';
    const code = s.trim().match(/\b([A-Z]{3})\b/);
    return code ? code[1] : fallback;
}

/** Normalize a date string to YYYY-MM-DD. Handles DD-MM-YYYY and ISO inputs. */
export function normalizeDate(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    // DD-MM-YYYY or DD/MM/YYYY (DeGiro/EU style)
    let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) {
        let [, d, mo, y] = m;
        if (y.length === 2) y = '20' + y;
        return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    // YYYY-MM-DD (ISO, possibly with time)
    m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) {
        const [, y, mo, d] = m;
        return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    // Fallback: let Date try, else return raw
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? s : dt.toISOString().slice(0, 10);
}

// ── CSV tokenizing ───────────────────────────────────────────────────────────

/** Detect the field separator of a CSV header line (comma or semicolon). */
function detectCsvSeparator(headerLine) {
    const semis = (headerLine.match(/;/g) || []).length;
    const commas = (headerLine.match(/,/g) || []).length;
    const tabs = (headerLine.match(/\t/g) || []).length;
    if (tabs >= semis && tabs >= commas && tabs > 0) return '\t';
    return semis > commas ? ';' : ',';
}

/** Split a single CSV line, honoring double-quoted fields. */
function splitCsvLine(line, sep) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else inQuotes = false;
            } else cur += ch;
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === sep) {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out.map(c => c.trim());
}

/** Parse CSV text into { header: string[], rows: string[][], sep }. */
function parseCsv(text) {
    const lines = String(text || '').split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length === 0) return { header: [], rows: [], sep: ',' };
    const sep = detectCsvSeparator(lines[0]);
    const header = splitCsvLine(lines[0], sep);
    const rows = lines.slice(1).map(l => splitCsvLine(l, sep));
    return { header, rows, sep };
}

/** Normalize a header cell: strip diacritics + punctuation, lowercase.
 *  e.g. "Preços" → "precos", "Quantidade" → "quantidade". */
function normHeader(h) {
    return String(h)
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // drop accents (ç→c, ê→e)
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .trim();
}

/** Find the index of the first header cell matching any of the given aliases. */
function findCol(header, aliases) {
    const lower = header.map(normHeader);
    for (let i = 0; i < lower.length; i++) {
        if (aliases.some(a => lower[i] === a || lower[i].includes(a))) return i;
    }
    return -1;
}

// ── Broker detection ─────────────────────────────────────────────────────────

/** Detect which broker an export came from. Returns 'degiro' | 'revolut' | null. */
export function detectBroker(text) {
    const head = String(text || '').split(/\r?\n/).slice(0, 3).join('\n').toLowerCase();
    if (!head.trim()) return null;
    if (/price per share/.test(head) && /total amount/.test(head)) return 'revolut';
    if (/\bisin\b/.test(head) && /(quantity|quantidade|aantal|menge|qty)/.test(head)) return 'degiro';
    return null;
}

// ── DeGiro Transactions.csv ──────────────────────────────────────────────────

const DEGIRO_ALIASES = {
    date:    ['date', 'data', 'datum'],
    product: ['product', 'produto', 'produkt'],
    isin:    ['isin'],
    qty:     ['quantity', 'quantidade', 'aantal', 'menge', 'qty', 'number'],
    price:   ['price', 'preco', 'koers', 'kurs', 'prix'],
    fees:    ['transaction and or third party fees', 'transaction costs', 'costs', 'custos', 'comissoes', 'kosten', 'fee', 'fees', 'gebuhren'],
};

/**
 * Parse a DeGiro Transactions export.
 * Quantity sign determines side (negative = sell). The currency column for the
 * price is the (often header-less) column immediately after the price column.
 */
export function parseDegiroCsv(text) {
    const { header, rows } = parseCsv(text);
    let trades = [];
    const errors = [];
    const review = [];
    let skipped = 0;

    const cDate = findCol(header, DEGIRO_ALIASES.date);
    const cProduct = findCol(header, DEGIRO_ALIASES.product);
    const cIsin = findCol(header, DEGIRO_ALIASES.isin);
    const cQty = findCol(header, DEGIRO_ALIASES.qty);
    const cPrice = findCol(header, DEGIRO_ALIASES.price);
    const cFees = findCol(header, DEGIRO_ALIASES.fees);

    if (cIsin === -1 || cQty === -1 || cPrice === -1) {
        errors.push('DeGiro export missing required ISIN / Quantity / Price columns.');
        return { broker: 'degiro', trades, income: [], review, errors, skipped };
    }

    rows.forEach((row) => {
        const identifier = (row[cIsin] || '').toUpperCase().trim();
        const qty = parseSignedNumber(row[cQty]);
        const name = cProduct !== -1 ? (row[cProduct] || '') : '';
        const date = normalizeDate(row[cDate]);
        // Truly empty rows (no instrument / no quantity) are dropped silently.
        if (!identifier || isNaN(qty) || qty === 0) { skipped++; return; }

        const price = parseFlexibleNumber(row[cPrice]);
        const currency = detectCurrency(row[cPrice + 1] || row[cPrice], 'EUR');

        if (isNaN(price) || price <= 0) {
            // Zero/blank-price rows are corporate actions (transfers, ISIN
            // changes, non-tradeable conversions). Surface for review instead
            // of silently dropping — they affect share counts.
            review.push({
                reason: 'corporate_action', identifier, isISIN: isISIN(identifier),
                name, date, signedShares: qty, currency, broker: 'degiro',
            });
            return;
        }

        const fees = cFees !== -1 ? Math.abs(parseFlexibleNumber(row[cFees]) || 0) : 0;
        trades.push({
            date, identifier, isISIN: isISIN(identifier),
            side: qty < 0 ? 'sell' : 'buy', shares: Math.abs(qty), price,
            fees: isNaN(fees) ? 0 : fees, currency, broker: 'degiro', name,
        });
    });

    // Detect likely splits / ISIN-changes (same instrument & date, a buy + sell
    // at wildly different prices) and move them out of trades into review.
    const { kept, flagged } = detectSplitPairs(trades);
    trades = kept;
    flagged.forEach(f => review.push(f));

    return { broker: 'degiro', trades, income: [], review, errors, skipped };
}

/**
 * Detect buy/sell pairs that look like a stock split or ISIN/ticker change:
 * same instrument, same date, one buy + one sell whose prices differ by ≥3×.
 * Returns { kept: trades[], flagged: reviewItems[] } with the suspect pairs
 * removed from `kept`. Pure & testable.
 */
export function detectSplitPairs(trades) {
    const byKey = new Map(); // identifier|date → trade indices
    trades.forEach((t, i) => {
        const key = `${t.identifier}|${t.date}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(i);
    });

    const flaggedIdx = new Set();
    const flagged = [];
    for (const idxs of byKey.values()) {
        if (idxs.length < 2) continue;
        const buys = idxs.filter(i => trades[i].side === 'buy');
        const sells = idxs.filter(i => trades[i].side === 'sell');
        for (const bi of buys) {
            for (const si of sells) {
                if (flaggedIdx.has(bi) || flaggedIdx.has(si)) continue;
                const b = trades[bi], s = trades[si];
                const hi = Math.max(b.price, s.price), lo = Math.min(b.price, s.price);
                if (lo > 0 && hi / lo >= 3) {
                    flaggedIdx.add(bi); flaggedIdx.add(si);
                    const fromShares = s.shares, toShares = b.shares; // old sold, new bought
                    flagged.push({
                        reason: 'possible_split',
                        identifier: b.identifier, isISIN: b.isISIN,
                        name: b.name || s.name, date: b.date,
                        currency: b.currency, broker: b.broker,
                        fromShares, toShares,
                        ratio: fromShares > 0 ? toShares / fromShares : 1,
                    });
                }
            }
        }
    }
    const kept = trades.filter((_, i) => !flaggedIdx.has(i));
    return { kept, flagged };
}

// ── Revolut trade statement (CSV) ────────────────────────────────────────────

const REVOLUT_ALIASES = {
    date:     ['date', 'completed date', 'date acquired', 'started date'],
    ticker:   ['ticker', 'symbol'],
    type:     ['type', 'transaction type'],
    qty:      ['quantity', 'qty', 'shares', 'number of shares'],
    price:    ['price per share', 'price'],
    total:    ['total amount', 'total', 'amount'],
    currency: ['currency', 'ccy'],
    tax:      ['withholding tax', 'tax'],
};

/**
 * Parse a Revolut trading statement export.
 * BUY/SELL rows become trades; DIVIDEND and FEE/CUSTODY rows become income
 * entries; top-ups and other cash movements are skipped.
 */
export function parseRevolutCsv(text) {
    const { header, rows } = parseCsv(text);
    const trades = [];
    const income = [];
    const errors = [];
    let skipped = 0;

    const cDate = findCol(header, REVOLUT_ALIASES.date);
    const cTicker = findCol(header, REVOLUT_ALIASES.ticker);
    const cType = findCol(header, REVOLUT_ALIASES.type);
    const cQty = findCol(header, REVOLUT_ALIASES.qty);
    const cPrice = findCol(header, REVOLUT_ALIASES.price);
    const cTotal = findCol(header, REVOLUT_ALIASES.total);
    const cCurrency = findCol(header, REVOLUT_ALIASES.currency);
    const cTax = findCol(header, REVOLUT_ALIASES.tax);

    if (cTicker === -1 || cType === -1 || cQty === -1) {
        errors.push('Revolut export missing required Ticker / Type / Quantity columns.');
        return { broker: 'revolut', trades, income, review: [], errors, skipped };
    }

    const ccyOf = (row) => cCurrency !== -1
        ? detectCurrency(row[cCurrency], 'USD')
        : detectCurrency(cTotal !== -1 ? row[cTotal] : '', 'USD');

    rows.forEach((row, idx) => {
        const lineNum = idx + 2;
        const typeRaw = (row[cType] || '').toUpperCase();
        let side = null;
        if (/^BUY/.test(typeRaw)) side = 'buy';
        else if (/^SELL/.test(typeRaw)) side = 'sell';
        if (!side) {
            // Non-trade rows: capture stock splits, dividends and fees; skip the rest.
            const amount = cTotal !== -1 ? Math.abs(parseFlexibleNumber(row[cTotal]) || 0) : 0;

            // Stock split — Revolut reports a signed SHARE DELTA in Quantity
            // (e.g. +3 for a 4:1, −78.4 for a reverse split). Unambiguous → commit directly.
            if (/STOCK SPLIT/.test(typeRaw)) {
                const identifier = (row[cTicker] || '').toUpperCase().trim();
                const delta = parseSignedNumber(row[cQty]);
                if (!identifier || isNaN(delta) || delta === 0) { skipped++; return; }
                income.push({
                    type: 'split', identifier, isISIN: isISIN(identifier),
                    date: normalizeDate(row[cDate]), shares: delta,
                    currency: ccyOf(row), broker: 'revolut', name: '',
                });
                return;
            }
            // Dividend — plain DIVIDEND only. "DIVIDEND TAX (CORRECTION)" rows are
            // tiny withholding true-ups that net ~0; skip them (don't count as income).
            if (/^DIVIDEND/.test(typeRaw) && !/TAX/.test(typeRaw)) {
                const identifier = (row[cTicker] || '').toUpperCase().trim();
                if (!identifier || !amount) { skipped++; return; }
                income.push({
                    type: 'dividend', identifier, isISIN: isISIN(identifier),
                    date: normalizeDate(row[cDate]), amount,
                    tax: cTax !== -1 ? Math.abs(parseFlexibleNumber(row[cTax]) || 0) : 0,
                    currency: ccyOf(row), broker: 'revolut', name: '',
                });
                return;
            }
            if (/FEE|CUSTODY/.test(typeRaw)) {
                if (!amount) { skipped++; return; }
                const identifier = (row[cTicker] || '').toUpperCase().trim() || 'CASH';
                // A reversal/refund reduces fees paid → store a negative amount.
                const signed = /REVERSAL|REFUND/.test(typeRaw) ? -amount : amount;
                income.push({
                    type: 'fee', identifier, isISIN: false,
                    date: normalizeDate(row[cDate]), amount: signed,
                    currency: ccyOf(row), broker: 'revolut', name: '',
                });
                return;
            }
            skipped++; return; // top-up, withdrawal, entity transfer, tax correction, etc.
        }

        const identifier = (row[cTicker] || '').toUpperCase().trim();
        const shares = parseFlexibleNumber(row[cQty]);
        if (!identifier || isNaN(shares) || shares <= 0) {
            errors.push(`Line ${lineNum}: invalid ticker/quantity for ${typeRaw} row`);
            return;
        }

        let price = cPrice !== -1 ? parseFlexibleNumber(row[cPrice]) : NaN;
        if ((isNaN(price) || price <= 0) && cTotal !== -1) {
            const total = parseFlexibleNumber(row[cTotal]);
            if (!isNaN(total) && total > 0) price = total / shares;
        }
        if (isNaN(price) || price <= 0) {
            errors.push(`Line ${lineNum}: could not determine price for ${identifier}`);
            return;
        }

        const currency = cCurrency !== -1
            ? detectCurrency(row[cCurrency], 'USD')
            : detectCurrency(cPrice !== -1 ? row[cPrice] : (cTotal !== -1 ? row[cTotal] : ''), 'USD');

        trades.push({
            date: normalizeDate(row[cDate]),
            identifier,
            isISIN: isISIN(identifier),
            side,
            shares,
            price,
            fees: 0,
            currency,
            broker: 'revolut',
            name: '',
        });
    });

    return { broker: 'revolut', trades, income, review: [], errors, skipped };
}

// ── AI-fallback normalization ────────────────────────────────────────────────

/**
 * Normalize loosely-structured trade rows (e.g. from the extract-trades AI
 * fallback) into canonical trade events.
 * Each raw row: { date, identifier, side, shares, price, fees?, currency? }.
 */
export function normalizeTrades(rawRows, broker = 'generic') {
    const trades = [];
    const errors = [];
    let skipped = 0;
    (Array.isArray(rawRows) ? rawRows : []).forEach((r, idx) => {
        const identifier = String(r.identifier || r.ticker || r.symbol || r.isin || '').toUpperCase().trim();
        const sideRaw = String(r.side || r.type || '').toLowerCase();
        const side = /sell/.test(sideRaw) ? 'sell' : (/buy/.test(sideRaw) ? 'buy' : null);
        const shares = parseFlexibleNumber(r.shares != null ? r.shares : r.quantity);
        let price = parseFlexibleNumber(r.price);
        if ((isNaN(price) || price <= 0) && r.total != null && shares > 0) {
            const t = parseFlexibleNumber(r.total);
            if (!isNaN(t) && t > 0) price = t / shares;
        }
        if (!identifier || !side || isNaN(shares) || shares <= 0 || isNaN(price) || price <= 0) {
            skipped++;
            errors.push(`Row ${idx + 1}: incomplete trade (need identifier, side, shares, price)`);
            return;
        }
        trades.push({
            date: normalizeDate(r.date),
            identifier,
            isISIN: isISIN(identifier),
            side,
            shares,
            price,
            fees: Math.abs(parseFlexibleNumber(r.fees) || 0) || 0,
            currency: detectCurrency(r.currency, 'EUR'),
            broker,
            name: String(r.name || ''),
        });
    });
    return { broker, trades, income: [], review: [], errors, skipped };
}

/** Dispatch a raw text export to the right parser based on detected broker. */
export function parseBrokerExport(text) {
    const broker = detectBroker(text);
    if (broker === 'degiro') return parseDegiroCsv(text);
    if (broker === 'revolut') return parseRevolutCsv(text);
    return { broker: null, trades: [], errors: ['Unrecognized export format. Use a DeGiro Transactions CSV, a Revolut statement CSV, or the AI paste fallback.'], skipped: 0, review: [], income: [] };
}

// ── Dedupe + position rebuild ────────────────────────────────────────────────

/**
 * Stable fingerprint for a trade, used to skip already-imported moves.
 * Works on both normalized trade events and stored ledger rows.
 */
export function tradeFingerprint(t) {
    const date = String(t.date || '').slice(0, 10);
    // Prefer the resolved ticker (symbol) so a re-imported ISIN trade matches
    // the ledger row that was stored under its ticker.
    const symbol = String(t.symbol || t.identifier || '').toUpperCase();
    const type = String(t.side || t.type || '').toLowerCase();
    if (type === 'buy' || type === 'sell' || type === '') {
        const shares = Number(t.shares || 0).toFixed(6);
        const price = Number(t.price || 0).toFixed(4);
        return [date, symbol, type, shares, price].join('|');
    }
    // Non-trade rows (dividend / fee / split / isin_change) carry no buy/sell price,
    // so fingerprint on the monetary amount, split ratio, or share delta instead.
    const amount = Number(t.amount ?? t.totalAmount ?? t.ratio ?? t.shares ?? 0).toFixed(4);
    return [date, symbol, type, amount].join('|');
}

/**
 * Build a multiset (Map of fingerprint → count) from an existing transactions
 * ledger. Counts matter so that genuine identical fills (same day, symbol,
 * side, shares, price) are not over-collapsed on re-import.
 */
export function buildExistingFingerprints(transactions) {
    const counts = new Map();
    for (const [symbol, txs] of Object.entries(transactions || {})) {
        (txs || []).forEach(tx => {
            const fp = tradeFingerprint({ ...tx, symbol });
            counts.set(fp, (counts.get(fp) || 0) + 1);
        });
    }
    return counts;
}

/**
 * Partition trades into new vs already-imported against the existing ledger,
 * matching by occurrence count. Identical fills within a single fresh import
 * are all kept (the broker file is authoritative); re-importing the same file
 * marks every row as a duplicate because the ledger now holds the same counts.
 *
 * Accepts either a Map<fp,count> (preferred) or a Set<fp> for compatibility.
 */
export function dedupeTrades(trades, existing = new Map()) {
    const remaining = existing instanceof Map
        ? new Map(existing)
        : new Map([...existing].map(fp => [fp, Infinity]));
    const fresh = [];
    const duplicates = [];
    for (const t of trades) {
        const fp = tradeFingerprint(t);
        const left = remaining.get(fp) || 0;
        if (left > 0) {
            remaining.set(fp, left - 1);
            duplicates.push(t);
        } else {
            fresh.push(t);
        }
    }
    return { fresh, duplicates };
}

/**
 * Recompute holdings from a transactions ledger using average-cost basis,
 * across the full transaction taxonomy (buy/sell/split/isin_change/dividend/fee).
 *
 * - buy:  shares += q; cost basis += q×price + fee (fees increase cost basis)
 * - sell: realized += (q×price − fee) − avg×q; reduce shares/cost at avg
 * - split / isin_change: shares ×= ratio; cost unchanged (avg ÷= ratio)
 * - dividend: income only (amount, tax); no effect on shares
 * - fee: cost/expense only; no effect on shares
 *
 * @param {Object} transactions - { SYMBOL: [{type, shares, price, date, fee?, tax?, amount?, ratio?}, ...] }
 * @returns {Object} { SYMBOL: { shares, avgPrice, realizedPnL, dividends, taxWithheld, feesPaid, needsReview } }
 */
export function computePositionsFromLedger(transactions) {
    const out = {};
    for (const [symbol, txs] of Object.entries(transactions || {})) {
        const sorted = [...(txs || [])].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
        let shares = 0;
        let costTotal = 0; // native-currency cost of currently-held shares
        let realized = 0;
        let dividends = 0;
        let taxWithheld = 0;
        let feesPaid = 0;
        let needsReview = false;
        for (const tx of sorted) {
            const fee = Number(tx.fee) || 0;
            switch (tx.type) {
                case 'buy':
                    shares += tx.shares;
                    costTotal += tx.shares * tx.price + fee;
                    feesPaid += fee;
                    break;
                case 'sell': {
                    const avg = shares > 0 ? costTotal / shares : 0;
                    realized += (tx.price * tx.shares - fee) - avg * tx.shares;
                    costTotal -= avg * tx.shares;
                    shares -= tx.shares;
                    feesPaid += fee;
                    if (shares < -1e-9) needsReview = true; // sold more than held
                    if (shares < 1e-9) { shares = 0; costTotal = 0; }
                    break;
                }
                case 'split':
                case 'isin_change': {
                    const ratio = Number(tx.ratio) || 0;
                    if (ratio > 0 && ratio <= 1000) {
                        // Multiplicative (DeGiro review) — guard corrupt ratios (1e100 → Infinity).
                        shares *= ratio; // cost unchanged → avg ÷ ratio
                    } else if (tx.shares) {
                        // Additive share delta (Revolut STOCK SPLIT) — cost unchanged.
                        shares += Number(tx.shares);
                    }
                    break;
                }
                case 'dividend':
                    dividends += Number(tx.amount ?? tx.totalAmount) || 0;
                    taxWithheld += Number(tx.tax) || 0;
                    break;
                case 'fee':
                    feesPaid += Number(tx.amount ?? tx.totalAmount) || 0;
                    break;
                default:
                    break; // unknown type — ignored for position math
            }
        }
        out[symbol] = {
            shares: shares < 1e-9 ? 0 : shares,
            avgPrice: shares > 1e-9 ? costTotal / shares : 0,
            realizedPnL: realized,
            dividends,
            taxWithheld,
            feesPaid,
            needsReview,
        };
    }
    return out;
}

// ── Unresolved-symbol handling ───────────────────────────────────────────────

/**
 * From a list of normalized items (trades/income/review), return the distinct
 * ISIN identifiers that still have no ticker after auto-resolution — i.e. items
 * that are `isISIN` and have no `symbol` and aren't in `resolvedMap`.
 * Each entry: { identifier, name, broker }. Pure & testable.
 */
export function collectUnresolved(items, resolvedMap = {}) {
    const seen = new Map();
    for (const it of (items || [])) {
        if (!it.isISIN || it.symbol) continue;
        const id = it.identifier;
        if (resolvedMap[id]) continue;
        if (!seen.has(id)) seen.set(id, { identifier: id, name: it.name || '', broker: it.broker });
    }
    return [...seen.values()];
}

/**
 * Apply user decisions for unresolved ISINs onto the items in place.
 * decisions: { ISIN: { action: 'map'|'untracked'|'skip', ticker?, type? } }.
 * - map:       item.symbol = ticker (applies to every item sharing that ISIN)
 * - untracked: item.symbol = ISIN, item.untracked = true
 * - skip:      left unresolved (caller drops items with no symbol)
 * Returns the set of ISINs the user skipped. Pure & testable.
 */
export function applyUnresolvedDecisions(items, decisions = {}) {
    const skipped = new Set();
    for (const it of (items || [])) {
        if (!it.isISIN || it.symbol) continue;
        const d = decisions[it.identifier];
        if (!d) continue;
        if (d.action === 'map' && d.ticker) {
            it.symbol = String(d.ticker).toUpperCase();
            if (d.type) it.assetType = d.type;
        } else if (d.action === 'untracked') {
            it.symbol = String(it.identifier).toUpperCase();
            it.untracked = true;
        } else {
            skipped.add(it.identifier);
        }
    }
    return { skipped };
}

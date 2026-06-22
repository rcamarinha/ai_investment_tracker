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

/** Parse a number that may use US (1,234.56) or European (1.234,56) formatting. */
export function parseFlexibleNumber(raw) {
    if (raw === null || raw === undefined) return NaN;
    let s = String(raw).trim();
    if (!s) return NaN;
    // Strip currency symbols, codes and whitespace, keep digits . , ( ) -
    s = s.replace(/[^0-9.,()\-]/g, '').trim();
    s = s.replace(/^\((.+)\)$/, '-$1');
    if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(s)) {
        // European: dot thousands, comma decimal
        s = s.replace(/\./g, '').replace(',', '.');
    } else if (/^-?\d+(,\d{1,2})$/.test(s)) {
        // Simple European decimal, e.g. 12,50
        s = s.replace(',', '.');
    }
    s = s.replace(/,/g, '');
    return parseFloat(s);
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

/** Find the index of the first header cell matching any of the given aliases. */
function findCol(header, aliases) {
    const lower = header.map(h => h.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim());
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
    const trades = [];
    const errors = [];
    let skipped = 0;

    const cDate = findCol(header, DEGIRO_ALIASES.date);
    const cProduct = findCol(header, DEGIRO_ALIASES.product);
    const cIsin = findCol(header, DEGIRO_ALIASES.isin);
    const cQty = findCol(header, DEGIRO_ALIASES.qty);
    const cPrice = findCol(header, DEGIRO_ALIASES.price);
    const cFees = findCol(header, DEGIRO_ALIASES.fees);

    if (cIsin === -1 || cQty === -1 || cPrice === -1) {
        errors.push('DeGiro export missing required ISIN / Quantity / Price columns.');
        return { broker: 'degiro', trades, errors, skipped };
    }

    rows.forEach((row, idx) => {
        const lineNum = idx + 2;
        const identifier = (row[cIsin] || '').toUpperCase().trim();
        const qty = parseSignedNumber(row[cQty]);
        if (!identifier || isNaN(qty) || qty === 0) { skipped++; return; }

        const price = parseFlexibleNumber(row[cPrice]);
        if (isNaN(price) || price <= 0) {
            errors.push(`Line ${lineNum}: invalid price "${row[cPrice]}" for ${identifier}`);
            return;
        }

        // Currency lives in the (usually unnamed) column right after price.
        const currency = detectCurrency(row[cPrice + 1] || row[cPrice], 'EUR');
        const fees = cFees !== -1 ? Math.abs(parseFlexibleNumber(row[cFees]) || 0) : 0;

        trades.push({
            date: normalizeDate(row[cDate]),
            identifier,
            isISIN: isISIN(identifier),
            side: qty < 0 ? 'sell' : 'buy',
            shares: Math.abs(qty),
            price,
            fees: isNaN(fees) ? 0 : fees,
            currency,
            broker: 'degiro',
            name: cProduct !== -1 ? (row[cProduct] || '') : '',
        });
    });

    return { broker: 'degiro', trades, errors, skipped };
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
};

/**
 * Parse a Revolut trading statement export.
 * Only BUY/SELL rows become trades; dividends, top-ups, fees, splits are skipped.
 */
export function parseRevolutCsv(text) {
    const { header, rows } = parseCsv(text);
    const trades = [];
    const errors = [];
    let skipped = 0;

    const cDate = findCol(header, REVOLUT_ALIASES.date);
    const cTicker = findCol(header, REVOLUT_ALIASES.ticker);
    const cType = findCol(header, REVOLUT_ALIASES.type);
    const cQty = findCol(header, REVOLUT_ALIASES.qty);
    const cPrice = findCol(header, REVOLUT_ALIASES.price);
    const cTotal = findCol(header, REVOLUT_ALIASES.total);
    const cCurrency = findCol(header, REVOLUT_ALIASES.currency);

    if (cTicker === -1 || cType === -1 || cQty === -1) {
        errors.push('Revolut export missing required Ticker / Type / Quantity columns.');
        return { broker: 'revolut', trades, errors, skipped };
    }

    rows.forEach((row, idx) => {
        const lineNum = idx + 2;
        const typeRaw = (row[cType] || '').toUpperCase();
        let side = null;
        if (/^BUY/.test(typeRaw)) side = 'buy';
        else if (/^SELL/.test(typeRaw)) side = 'sell';
        if (!side) { skipped++; return; } // dividend, top-up, fee, split, etc.

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

    return { broker: 'revolut', trades, errors, skipped };
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
    return { broker, trades, errors, skipped };
}

/** Dispatch a raw text export to the right parser based on detected broker. */
export function parseBrokerExport(text) {
    const broker = detectBroker(text);
    if (broker === 'degiro') return parseDegiroCsv(text);
    if (broker === 'revolut') return parseRevolutCsv(text);
    return { broker: null, trades: [], errors: ['Unrecognized export format. Use a DeGiro Transactions CSV, a Revolut statement CSV, or the AI paste fallback.'], skipped: 0 };
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
    const side = String(t.side || t.type || '').toLowerCase();
    const shares = Number(t.shares || 0).toFixed(6);
    const price = Number(t.price || 0).toFixed(4);
    return [date, symbol, side, shares, price].join('|');
}

/** Build a Set of fingerprints from an existing transactions ledger. */
export function buildExistingFingerprints(transactions) {
    const set = new Set();
    for (const [symbol, txs] of Object.entries(transactions || {})) {
        (txs || []).forEach(tx => set.add(tradeFingerprint({ ...tx, symbol })));
    }
    return set;
}

/**
 * Partition trades into new vs duplicate against an existing fingerprint set.
 * Also dedupes within the incoming batch itself.
 */
export function dedupeTrades(trades, existingFingerprints = new Set()) {
    const seen = new Set(existingFingerprints);
    const fresh = [];
    const duplicates = [];
    for (const t of trades) {
        const fp = tradeFingerprint(t);
        if (seen.has(fp)) { duplicates.push(t); continue; }
        seen.add(fp);
        fresh.push(t);
    }
    return { fresh, duplicates };
}

/**
 * Recompute holdings from a transactions ledger using average-cost basis
 * (matching the app's existing sell cost-basis model).
 *
 * @param {Object} transactions - { SYMBOL: [{type, shares, price, date}, ...] }
 * @returns {Object} { SYMBOL: { shares, avgPrice, realizedPnL } }
 */
export function computePositionsFromLedger(transactions) {
    const out = {};
    for (const [symbol, txs] of Object.entries(transactions || {})) {
        const sorted = [...(txs || [])].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
        let shares = 0;
        let costTotal = 0; // native-currency cost of currently-held shares
        let realized = 0;
        for (const tx of sorted) {
            if (tx.type === 'buy') {
                shares += tx.shares;
                costTotal += tx.shares * tx.price;
            } else if (tx.type === 'sell') {
                const avg = shares > 0 ? costTotal / shares : 0;
                realized += (tx.price - avg) * tx.shares;
                costTotal -= avg * tx.shares;
                shares -= tx.shares;
                if (shares < 1e-9) { shares = 0; costTotal = 0; }
            }
        }
        out[symbol] = {
            shares: shares < 1e-9 ? 0 : shares,
            avgPrice: shares > 1e-9 ? costTotal / shares : 0,
            realizedPnL: realized,
        };
    }
    return out;
}

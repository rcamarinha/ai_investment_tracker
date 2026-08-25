/**
 * returns-core.js — PURE money-weighted return (XIRR) math.
 *
 * No DOM, no `state`, no network — same purity contract as import-brokers.js,
 * so tests import it directly (there is no `src/` mirror). FX is dependency-
 * injected via `rateFor`/`currencyFor` so the solver never touches app state;
 * the live wiring in services/portfolio.js passes `txRateToBase` and
 * `getAssetCurrency`, tests pass rate=1 stubs.
 */

const MS_PER_DAY = 86400000;
const DAYS_PER_YEAR = 365;

/**
 * Assemble dated, base-currency cash flows from the transaction ledger for a
 * money-weighted return. Sign convention: money INTO investments is negative,
 * money coming back is positive.
 *   buy      → −(totalAmount + fee)      (cash out, incl. commission)
 *   sell     → +(totalAmount − fee)      (net proceeds)
 *   dividend → +(totalAmount − tax)      (net cash received)
 *   fee      → −totalAmount              (standalone custody/connectivity fee)
 *   split / isin_change → no cash flow   (shares change only)
 *
 * `totalAmount` is the trade gross (shares×price) and excludes the per-trade
 * `fee`, matching the ledger commit shape in services/portfolio.js.
 *
 * @param {Object} transactions  state.transactions: { SYMBOL: tx[] }
 * @param {Object} deps
 * @param {(tx:Object, currency:string|null)=>number} deps.rateFor  native→base FX rate
 * @param {(symbol:string)=>string|null}              deps.currencyFor  symbol's native currency
 * @returns {Array<{date:string, amount:number, type:string, symbol:string}>}
 */
export function buildCashFlows(transactions, { rateFor, currencyFor } = {}) {
  const rf = rateFor || (() => 1);
  const cf = currencyFor || (() => null);
  const flows = [];
  let skipped = 0;
  for (const [symbol, txs] of Object.entries(transactions || {})) {
    for (const tx of txs || []) {
      if (!tx || !tx.date) continue;
      const currency = cf(symbol);
      const rate = rf(tx, currency);
      // A null/NaN rate must SKIP the flow, not scale it to zero. `x * null` is
      // -0, and Number.isFinite(-0) is true, so an unconvertible buy was pushed
      // as capital that cost nothing — and XIRR over a zero-cost position runs
      // away without bound. computeYearlyIncome below already guards this way.
      if (!Number.isFinite(rate)) { skipped++; continue; }
      const amt = Number(tx.totalAmount) || 0;
      const fee = Number(tx.fee) || 0;
      const tax = Number(tx.tax) || 0;
      let amount = null;
      if (tx.type === 'buy') amount = -(amt + fee) * rate;
      else if (tx.type === 'sell') amount = (amt - fee) * rate;
      else if (tx.type === 'dividend') amount = (amt - tax) * rate;
      else if (tx.type === 'fee') amount = -amt * rate;
      // split / isin_change: no cash flow
      if (amount !== null && Number.isFinite(amount)) {
        flows.push({ date: tx.date, amount, type: tx.type, symbol });
      }
    }
  }
  if (skipped > 0) {
    console.warn(`\u26A0 buildCashFlows skipped ${skipped} transaction(s) with no usable FX rate \u2014 returns are computed on the remainder.`);
  }
  return flows;
}

/**
 * Net present value of dated cash flows at an annual rate (actual/365 day count).
 * @param {number} rate  annual rate as a decimal (0.1 = 10%)
 * @param {Array<{date:string|number|Date, amount:number}>} flows  earliest-first
 */
export function xnpv(rate, flows) {
  if (!flows || flows.length === 0) return 0;
  const t0 = new Date(flows[0].date).getTime();
  return flows.reduce((acc, f) => {
    const years = (new Date(f.date).getTime() - t0) / MS_PER_DAY / DAYS_PER_YEAR;
    return acc + f.amount / Math.pow(1 + rate, years);
  }, 0);
}

/**
 * Money-weighted annualized return (XIRR) for dated cash flows.
 *
 * Sign convention per {@link buildCashFlows}. Append the current portfolio
 * market value as a positive terminal flow (dated today) before calling, so a
 * still-open portfolio has a realizable inflow. Returns the annual rate as a
 * decimal (0.12 = 12%), or `null` when the rate is undefined: fewer than two
 * flows, all-same-sign (no root exists), or non-convergence.
 *
 * Newton-Raphson from a 10% seed, with a bisection fallback over
 * [−99.99%, 1000%] for the awkward cases Newton diverges on.
 *
 * @param {Array<{date:string|number|Date, amount:number}>} flows
 * @param {Object} [opts]
 * @param {number} [opts.guess=0.1]
 * @param {number} [opts.tol=1e-7]
 * @param {number} [opts.maxIter=100]
 * @returns {number|null}
 */
export function xirr(flows, { guess = 0.1, tol = 1e-7, maxIter = 100 } = {}) {
  const fs = (flows || [])
    .filter(f => f && f.date && Number.isFinite(f.amount) && f.amount !== 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (fs.length < 2) return null;
  if (!fs.some(f => f.amount > 0) || !fs.some(f => f.amount < 0)) return null;

  const t0 = new Date(fs[0].date).getTime();
  const years = fs.map(f => (new Date(f.date).getTime() - t0) / MS_PER_DAY / DAYS_PER_YEAR);
  const npv = rate => fs.reduce((a, f, i) => a + f.amount / Math.pow(1 + rate, years[i]), 0);
  const dnpv = rate => fs.reduce((a, f, i) => a - (years[i] * f.amount) / Math.pow(1 + rate, years[i] + 1), 0);

  // Newton-Raphson
  let rate = guess;
  for (let i = 0; i < maxIter; i++) {
    const f = npv(rate);
    if (Math.abs(f) < tol) return rate;
    const d = dnpv(rate);
    if (!Number.isFinite(d) || d === 0) break;
    const next = rate - f / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - rate) < tol) return next;
    rate = next;
  }

  // Bisection fallback over a wide bracket
  let lo = -0.9999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < tol || (hi - lo) / 2 < tol) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/**
 * Per-CALENDAR-YEAR money-weighted return (XIRR).
 *
 * Each year is its own investment period: the opening portfolio value on Jan 1
 * is an outflow, the year's ledger cash flows follow, and the closing value
 * (Dec 31, or today's live value for the current year) is the terminal inflow.
 * Opening/closing values come from the injected `boundaryValueFor(dateStr)`:
 *   • `0` for any boundary on/before the first-ever transaction (empty portfolio)
 *   • the nearest reliable snapshot value in base currency, or
 *   • `null` when no snapshot is near enough.
 * A year missing either boundary is returned `insufficient: true` with a reason
 * rather than a fabricated rate — the honest limitation of snapshot-sourced
 * boundaries (Approach A). The combined lifetime XIRR (see {@link xirr}) never
 * has this gap; only the per-year slices do.
 *
 * @param {Object} transactions
 * @param {Object} deps
 * @param {(tx:Object, currency:string|null)=>number} deps.rateFor
 * @param {(symbol:string)=>string|null} deps.currencyFor
 * @param {(dateStr:string)=>number|null} deps.boundaryValueFor  Jan-1 value in base, 0 (empty), or null
 * @param {number} deps.currentValue   live market value in base = the current year's close
 * @param {string} [deps.today]        YYYY-MM-DD; injectable clock for tests
 * @returns {Array<{year:string, rate:number|null, openValue:number|null,
 *   closeValue:number|null, netFlow:number, insufficient:boolean, reason:string|null}>}
 *   ascending by year
 */
export function computeYearlyXirr(transactions, { rateFor, currencyFor, boundaryValueFor, currentValue, today } = {}) {
  const flows = buildCashFlows(transactions, { rateFor, currencyFor }).filter(f => f.date);
  if (flows.length === 0) return [];
  const bvf = boundaryValueFor || (() => null);
  const todayStr = today || new Date().toISOString().slice(0, 10);
  const curYear = Number(todayStr.slice(0, 4));
  const firstYear = Number(
    flows.reduce((min, f) => (f.date < min ? f.date : min), flows[0].date).slice(0, 4)
  );

  const out = [];
  for (let Y = firstYear; Y <= curYear; Y++) {
    const yStr = String(Y);
    const openDate = `${Y}-01-01`;
    const yearEnd = `${Y}-12-31`;
    const isCurrent = Y === curYear;
    const closeDate = isCurrent ? todayStr : yearEnd;

    const openValue = bvf(openDate);
    const closeValue = isCurrent
      ? (Number.isFinite(currentValue) ? currentValue : null)
      : bvf(`${Y + 1}-01-01`);
    const yflows = flows.filter(f => f.date >= openDate && f.date <= yearEnd);
    const netFlow = yflows.reduce((s, f) => s + f.amount, 0);

    if (openValue == null || closeValue == null) {
      out.push({
        year: yStr, rate: null, openValue, closeValue, netFlow, insufficient: true,
        reason: openValue == null ? 'no opening value near Jan 1' : 'no closing value',
      });
      continue;
    }

    const periodFlows = [
      { date: openDate, amount: -openValue },
      ...yflows,
      { date: closeDate, amount: closeValue },
    ];
    const rate = xirr(periodFlows);
    out.push({
      year: yStr, rate, openValue, closeValue, netFlow,
      insufficient: rate == null,
      reason: rate == null ? 'return undefined for this period' : null,
    });
  }
  return out;
}

/**
 * Bucket dividend income, withholding tax and fees by CALENDAR YEAR (from
 * `tx.date`), all normalized to base currency. Unlike XIRR, this needs no
 * market valuation, so every historical year is exact from the ledger alone.
 *
 * Each year's `yieldOnCost` divides net dividends by the AVERAGE cost basis at
 * risk during that year — the mean of the invested capital held at the year's
 * start and end. Invested-at-risk rises with buys (cost + fee) and falls by the
 * cost basis of shares sold (proceeds − realizedGainLoss when known, else
 * proceeds). When that average is ≤ 0 (e.g. a position fully bought and sold
 * inside one year), `yieldOnCost` is null rather than a divide-by-zero.
 *
 * FX is injected exactly as in {@link buildCashFlows}.
 *
 * @param {Object} transactions  state.transactions: { SYMBOL: tx[] }
 * @param {Object} deps  { rateFor, currencyFor } — same contract as buildCashFlows
 * @returns {{
 *   years: Array<{year:string, dividends:number, tax:number, netIncome:number,
 *                 fees:number, investedStart:number, investedEnd:number,
 *                 avgInvested:number, yieldOnCost:number|null}>,
 *   totals: {dividends:number, tax:number, netIncome:number, fees:number}
 * }}  years sorted ascending
 */
export function computeYearlyIncome(transactions, { rateFor, currencyFor } = {}) {
  const rf = rateFor || (() => 1);
  const cf = currencyFor || (() => null);
  const buckets = new Map();          // year → {dividends, tax, fees}
  const capEvents = [];               // {date, delta} — change in cost basis at risk
  const bucket = y => {
    let b = buckets.get(y);
    if (!b) { b = { dividends: 0, tax: 0, fees: 0 }; buckets.set(y, b); }
    return b;
  };

  for (const [symbol, txs] of Object.entries(transactions || {})) {
    for (const tx of txs || []) {
      if (!tx || !tx.date) continue;
      const year = String(tx.date).slice(0, 4);
      if (!/^\d{4}$/.test(year)) continue;
      const cur = cf(symbol);
      const rate = rf(tx, cur);
      if (!Number.isFinite(rate)) continue;
      const amt = Number(tx.totalAmount) || 0;
      const fee = Number(tx.fee) || 0;
      if (tx.type === 'dividend') {
        const b = bucket(year);
        b.dividends += amt * rate;
        b.tax += (Number(tx.tax) || 0) * rate;
      } else if (tx.type === 'fee') {
        bucket(year).fees += amt * rate;
      } else if (tx.type === 'buy') {
        if (fee) bucket(year).fees += fee * rate;
        capEvents.push({ date: tx.date, delta: (amt + fee) * rate });
      } else if (tx.type === 'sell') {
        if (fee) bucket(year).fees += fee * rate;
        const rg = Number(tx.realizedGainLoss);
        const cost = Number.isFinite(rg) ? (amt - rg) : amt; // cost basis of shares sold
        capEvents.push({ date: tx.date, delta: -cost * rate });
      }
      // split / isin_change: no cash and no cost-basis change
    }
  }

  // Cumulative invested-at-risk strictly BEFORE a YYYY-01-01 boundary.
  const investedBefore = boundary =>
    capEvents.reduce((s, e) => s + (e.date < boundary ? e.delta : 0), 0);

  const years = [...buckets.keys()].sort().map(year => {
    const b = buckets.get(year);
    const netIncome = b.dividends - b.tax;
    const investedStart = Math.max(0, investedBefore(`${year}-01-01`));
    const investedEnd = Math.max(0, investedBefore(`${Number(year) + 1}-01-01`));
    const avgInvested = (investedStart + investedEnd) / 2;
    return {
      year, dividends: b.dividends, tax: b.tax, netIncome, fees: b.fees,
      investedStart, investedEnd, avgInvested,
      yieldOnCost: avgInvested > 0 ? netIncome / avgInvested : null,
    };
  });

  const totals = years.reduce((t, y) => ({
    dividends: t.dividends + y.dividends,
    tax: t.tax + y.tax,
    netIncome: t.netIncome + y.netIncome,
    fees: t.fees + y.fees,
  }), { dividends: 0, tax: 0, netIncome: 0, fees: 0 });

  return { years, totals };
}

/**
 * Roll up cash flows into the numbers a performance panel needs. `flows` are the
 * ledger flows from {@link buildCashFlows} (WITHOUT the terminal market value).
 *
 * @param {Array<{date:string, amount:number}>} flows
 * @returns {{capitalIn:number, cashReturned:number, firstDate:string|null, count:number}}
 *   capitalIn    — total cash deployed (buys + standalone fees), positive
 *   cashReturned — realized cash back (sells + dividends), positive
 */
export function summarizeCashFlows(flows) {
  let capitalIn = 0, cashReturned = 0, firstDate = null;
  for (const f of flows || []) {
    if (f.amount < 0) capitalIn += -f.amount;
    else cashReturned += f.amount;
    if (f.date && (firstDate === null || f.date < firstDate)) firstDate = f.date;
  }
  return { capitalIn, cashReturned, firstDate, count: (flows || []).length };
}

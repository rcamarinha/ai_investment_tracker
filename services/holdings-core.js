/**
 * holdings-core.js — pure maths for Bank Holdings (bonds + funds held at banks).
 *
 * PURE by contract: no DOM, no network, no service imports. Tests import this
 * directly, so it must never grow a `src/` mirror (see CLAUDE.md).
 *
 * The governing constraint of this module is HONESTY ABOUT VALUATION. Every
 * figure here originates from a bank statement or from something the user
 * typed — never from a live market. So nothing in this file returns a bare
 * number: totals carry their staleness, and gains are labelled as the
 * point-in-time estimates they are. A holding whose value is nine months old
 * must not be presented the same way as one valued last week.
 */

const MS_DAY = 86400000;

function parseISO(value) {
    const m = String(value || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(dt.getTime()) ? null : dt;
}

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }

export function daysSince(date, today) {
    const a = parseISO(date), b = parseISO(today);
    if (!a || !b) return null;
    return Math.round((b.getTime() - a.getTime()) / MS_DAY);
}

/**
 * How much to trust a valuation, by age.
 *
 * Bank statements arrive monthly, so anything inside ~5 weeks is simply current.
 * Past a quarter the number is decorative and should say so. Thresholds are
 * deliberately generous — this is not a traded asset and pretending otherwise
 * would be the opposite of the point.
 */
export function valuationFreshness(valuedAsOf, today) {
    const days = daysSince(valuedAsOf, today);
    if (days === null) return { days: null, level: 'unknown', label: 'no valuation date' };
    if (days < 0) return { days, level: 'future', label: 'dated in the future' };
    if (days <= 40) return { days, level: 'current', label: days === 0 ? 'valued today' : `valued ${days}d ago` };
    if (days <= 100) return { days, level: 'ageing', label: `valued ${Math.round(days / 30)} months ago` };
    return { days, level: 'stale', label: `valued ${Math.round(days / 30)} months ago` };
}

export function isActive(h) {
    if (h.archived) return false;
    // Number(null) and Number('') are both 0, which is finite — so a row with no
    // recorded value would otherwise count towards the total as a real zero.
    // A genuine zero (a matured bond) is still active; a missing one is not.
    const v = h.currentValue;
    if (v === null || v === undefined || v === '') return false;
    return Number.isFinite(Number(v));
}

/**
 * Point-in-time gain against cost. Deliberately NOT annualised and NOT an IRR:
 * there is no cash-flow history behind these rows in v1, so any rate-of-return
 * figure would imply a precision that does not exist. Returns null rather than
 * zero when cost is unknown — "no cost recorded" and "broke even" are different
 * facts and must not render identically.
 */
export function holdingGain(h) {
    const value = Number(h.currentValue);
    const cost = Number(h.costBasis);
    if (!Number.isFinite(value) || !Number.isFinite(cost) || cost <= 0) return null;
    return { absolute: round2(value - cost), pct: round4((value - cost) / cost) };
}

/**
 * Totals across holdings, carrying the worst staleness found.
 *
 * `oldestValuation` is what the hub badge shows. Reporting the total without it
 * would let a year-old bond valuation sit inside the net-worth number looking
 * exactly as authoritative as today's stock prices.
 */
export function summarizeHoldings(holdings = [], options = {}) {
    const today = options.today || new Date().toISOString().slice(0, 10);
    const active = holdings.filter(isActive);

    let total = 0, cost = 0, costKnown = 0, oldestDays = null, oldestDate = null;
    const byType = new Map(), byBank = new Map();

    for (const h of active) {
        const value = Number(h.currentValue);
        total += value;

        const c = Number(h.costBasis);
        if (Number.isFinite(c) && c > 0) { cost += c; costKnown += value; }

        const days = daysSince(h.valuedAsOf, today);
        if (days !== null && (oldestDays === null || days > oldestDays)) {
            oldestDays = days; oldestDate = h.valuedAsOf;
        }

        const t = h.holdingType || 'other';
        byType.set(t, (byType.get(t) || 0) + value);
        const b = h.bankName || 'Unknown';
        byBank.set(b, (byBank.get(b) || 0) + value);
    }

    // Gain is computed only over the slice that actually has a cost basis, and
    // `costCoverage` says how much of the total that slice represents — so a
    // gain derived from 8% of the portfolio can never be shown as if it spoke
    // for all of it.
    const gain = cost > 0 ? { absolute: round2(costKnown - cost), pct: round4((costKnown - cost) / cost) } : null;

    return {
        count: active.length,
        total: round2(total),
        gain,
        costCoverage: total > 0 ? round4(costKnown / total) : 0,
        oldestValuation: { days: oldestDays, date: oldestDate, ...valuationFreshness(oldestDate, today) },
        byType: [...byType.entries()].map(([type, value]) => ({ type, value: round2(value) }))
            .sort((a, b) => b.value - a.value),
        byBank: [...byBank.entries()].map(([bank, value]) => ({ bank, value: round2(value) }))
            .sort((a, b) => b.value - a.value)
    };
}

/** Bonds only: days to maturity, so a redemption is not a surprise. */
export function maturityStatus(h, today) {
    if (!h.maturityDate) return null;
    const days = daysSince(today || new Date().toISOString().slice(0, 10), h.maturityDate);
    if (days === null) return null;
    if (days < 0) return { days, level: 'matured', label: 'matured' };
    if (days <= 90) return { days, level: 'soon', label: `matures in ${days}d` };
    return { days, level: 'later', label: `matures ${String(h.maturityDate).slice(0, 7)}` };
}

export const HOLDING_TYPES = ['bond', 'fund', 'deposit', 'structured', 'other'];

/**
 * spend-core.js — pure cash-flow maths for the Spend module.
 *
 * PURE by contract: no DOM, no network, no service imports. Tests import this
 * file directly, so it must never grow a `src/` mirror (see CLAUDE.md).
 *
 * Conventions used throughout:
 *   - `amount` is signed. Negative = money left the account.
 *   - A transaction with category 'transfer' or a `transferPairId` is a movement
 *     between the user's own accounts. It is neither spend nor income and is
 *     excluded from every rollup — the same discipline as the reserved CASH
 *     symbol in the stock ledger.
 *   - Summaries report `spend` as a POSITIVE magnitude. Signed amounts are an
 *     input convention; positive magnitudes are what humans compare.
 */

const MS_DAY = 86400000;
const AVG_MONTH_DAYS = 30.436875; // mean Gregorian month, so cadence→monthly is unbiased

// ── dates ───────────────────────────────────────────────────────────────────
// All date maths is UTC. Local-time parsing of 'YYYY-MM-DD' shifts the day
// backwards west of Greenwich, which silently moves transactions between months.

export function parseISO(value) {
    if (value instanceof Date) {
        return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
    }
    const m = String(value || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(dt.getTime()) ? null : dt;
}

export function toISO(dt) {
    return dt instanceof Date ? dt.toISOString().slice(0, 10) : null;
}

export function addDays(value, n) {
    const dt = parseISO(value);
    return dt ? new Date(dt.getTime() + n * MS_DAY) : null;
}

export function daysBetween(a, b) {
    const da = parseISO(a), db = parseISO(b);
    if (!da || !db) return null;
    return Math.round((db.getTime() - da.getTime()) / MS_DAY);
}

// ── periods ─────────────────────────────────────────────────────────────────

export function periodKey(date, grain = 'month') {
    const dt = parseISO(date);
    if (!dt) return null;
    const y = dt.getUTCFullYear();
    if (grain === 'year') return String(y);
    if (grain === 'quarter') return `${y}-Q${Math.floor(dt.getUTCMonth() / 3) + 1}`;
    return `${y}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function periodRange(key, grain = 'month') {
    if (!key) return null;
    if (grain === 'year') {
        const y = +key;
        return { start: `${y}-01-01`, end: `${y}-12-31` };
    }
    if (grain === 'quarter') {
        const [ys, qs] = String(key).split('-Q');
        const y = +ys, startMonth = (+qs - 1) * 3;
        return {
            start: toISO(new Date(Date.UTC(y, startMonth, 1))),
            end: toISO(new Date(Date.UTC(y, startMonth + 3, 0)))
        };
    }
    const [ys, ms] = String(key).split('-');
    const y = +ys, m = +ms - 1;
    return {
        start: toISO(new Date(Date.UTC(y, m, 1))),
        end: toISO(new Date(Date.UTC(y, m + 1, 0)))
    };
}

export function shiftPeriod(key, grain = 'month', n = -1) {
    if (grain === 'year') return String(+key + n);
    if (grain === 'quarter') {
        const [ys, qs] = String(key).split('-Q');
        let total = (+ys) * 4 + (+qs - 1) + n;
        return `${Math.floor(total / 4)}-Q${(total % 4) + 1}`;
    }
    const [ys, ms] = String(key).split('-');
    let total = (+ys) * 12 + (+ms - 1) + n;
    const y = Math.floor(total / 12), m = total % 12;
    return `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * The baseline period a comparison runs against.
 *   'previous' — the period immediately before
 *   'yoy'      — the same period one year earlier
 * Returns null for modes with no single baseline period ('none', 'trailing12').
 */
export function resolveBaseline(key, grain = 'month', mode = 'previous') {
    if (!key || mode === 'none' || mode === 'trailing12') return null;
    if (mode === 'yoy') {
        const step = grain === 'year' ? 1 : grain === 'quarter' ? 4 : 12;
        return shiftPeriod(key, grain, -step);
    }
    return shiftPeriod(key, grain, -1);
}

// ── classification ──────────────────────────────────────────────────────────

export function isTransfer(tx) {
    return tx.category === 'transfer' || !!tx.transferPairId;
}

function amountOf(tx) {
    const n = Number(tx.amount);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Roll a set of transactions into income / spend / net / savings rate.
 *
 * A positive amount inside a spend category is a REFUND, not income — netting
 * it against that category is the only treatment that keeps both the category
 * total and the savings rate honest. Counting it as income would inflate both.
 */
export function summarize(transactions = [], opts = {}) {
    const incomeCategories = new Set(opts.incomeCategories || []);
    let income = 0, spend = 0;
    const byCategory = new Map();

    for (const tx of transactions) {
        if (isTransfer(tx)) continue;
        const amt = amountOf(tx);
        if (amt === 0) continue;
        const cat = tx.category || null;

        if (incomeCategories.has(cat) || (amt > 0 && !cat)) {
            income += Math.abs(amt);
            continue;
        }
        // Outflow, or a refund against a spend category.
        const magnitude = -amt; // positive for outflow, negative for a refund
        spend += magnitude;
        const key = cat || '__uncategorized__';
        byCategory.set(key, (byCategory.get(key) || 0) + magnitude);
    }

    return {
        income: round2(income),
        spend: round2(spend),
        net: round2(income - spend),
        savingsRate: income > 0 ? round4((income - spend) / income) : null,
        byCategory: [...byCategory.entries()]
            .map(([category, amount]) => ({
                category: category === '__uncategorized__' ? null : category,
                amount: round2(amount)
            }))
            .sort((a, b) => b.amount - a.amount)
    };
}

export function computeSavingsRate(transactions, opts) {
    return summarize(transactions, opts).savingsRate;
}

export function rollupByCategory(transactions, opts) {
    return summarize(transactions, opts).byCategory;
}

function inRange(tx, start, end) {
    const d = String(tx.date || '').slice(0, 10);
    return d >= start && d <= end;
}

export function filterPeriod(transactions = [], key, grain = 'month') {
    const range = periodRange(key, grain);
    if (!range) return [];
    return transactions.filter(tx => inRange(tx, range.start, range.end));
}

export function rollupByPeriod(transactions = [], grain = 'month', opts = {}) {
    const buckets = new Map();
    for (const tx of transactions) {
        const key = periodKey(tx.date, grain);
        if (!key) continue;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(tx);
    }
    return [...buckets.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([period, rows]) => ({ period, ...summarize(rows, opts) }));
}

export function coverageOf(transactions = []) {
    const dates = transactions
        .map(tx => String(tx.date || '').slice(0, 10))
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
    if (!dates.length) return { firstDate: null, lastDate: null, months: 0 };
    const first = dates[0], last = dates[dates.length - 1];
    const months = Math.max(1, Math.round((daysBetween(first, last) || 0) / AVG_MONTH_DAYS) + 1);
    return { firstDate: first, lastDate: last, months };
}

/**
 * Transactions large enough to distort a period on their own.
 *
 * Share of the period is not enough on its own: in a month with two €100
 * charges, each is 50% of the total, and flagging both as anomalies empties the
 * period. A one-off must also stand out against the OTHER transactions, so it
 * is measured against the median of the rest rather than against the whole.
 */
export function findOneOffs(transactions = [], thresholdPct = 0.15, multipleOfMedian = 4) {
    const spends = transactions.filter(tx => !isTransfer(tx) && amountOf(tx) < 0);
    const total = spends.reduce((sum, tx) => sum - amountOf(tx), 0);
    if (total <= 0 || spends.length < 2) return [];

    return spends.filter((tx, i) => {
        const magnitude = -amountOf(tx);
        // This share test is what keeps the function linear in practice: it
        // rejects before the median-of-the-rest below ever runs, and with
        // hundreds of transactions in a period almost nothing reaches 15% of
        // the total. Lowering thresholdPct materially would make this quadratic.
        if (magnitude / total < thresholdPct) return false;
        const rest = spends.filter((_, j) => j !== i).map(t => -amountOf(t));
        const typical = median(rest);
        return typical > 0 && magnitude >= typical * multipleOfMedian;
    });
}

/**
 * Compare one period against a baseline.
 *
 * Partial-period alignment is the point of this function. On the 8th of the
 * month, comparing month-to-date against a full previous month reads as a 70%
 * collapse in spending — the most common lie in budgeting dashboards. When the
 * current period is still open, both sides are clipped to the same elapsed
 * number of days and the result is labelled MTD/QTD/YTD.
 */
export function comparePeriods(transactions = [], options = {}) {
    const {
        grain = 'month',
        period = periodKey(options.today || new Date(), grain),
        mode = 'previous',
        today = null,
        excludeOneOffs = false,
        alignPartial = true,
        incomeCategories = []
    } = options;

    const opts = { incomeCategories };
    const curRange = periodRange(period, grain);
    const baselineKey = resolveBaseline(period, grain, mode);
    const coverage = coverageOf(transactions);

    // How much of the current period has actually elapsed.
    const todayISO = today ? String(today).slice(0, 10) : null;
    const isPartial = !!(alignPartial && todayISO && todayISO >= curRange.start && todayISO < curRange.end);
    const elapsedDays = isPartial ? (daysBetween(curRange.start, todayISO) + 1) : null;

    const clip = (range) => {
        if (!isPartial) return range;
        const end = toISO(addDays(range.start, elapsedDays - 1));
        return { start: range.start, end: end < range.end ? end : range.end };
    };

    const curClipped = clip(curRange);
    let currentRows = transactions.filter(tx => inRange(tx, curClipped.start, curClipped.end));

    let baselineRows = null, baseRange = null, baseClipped = null;
    if (baselineKey) {
        baseRange = periodRange(baselineKey, grain);
        baseClipped = clip(baseRange);
        baselineRows = transactions.filter(tx => inRange(tx, baseClipped.start, baseClipped.end));
    }

    let oneOffs = [];
    if (excludeOneOffs) {
        oneOffs = [...findOneOffs(currentRows), ...(baselineRows ? findOneOffs(baselineRows) : [])];
        const drop = new Set(oneOffs.map(t => t.id));
        currentRows = currentRows.filter(t => !drop.has(t.id));
        if (baselineRows) baselineRows = baselineRows.filter(t => !drop.has(t.id));
    } else if (baselineRows) {
        oneOffs = findOneOffs(currentRows);
    }

    const current = summarize(currentRows, opts);
    const baseline = baselineRows ? summarize(baselineRows, opts) : null;

    // A baseline window with no data behind it is not a baseline. Reporting a
    // -100% delta against an empty year is worse than reporting nothing.
    let insufficientData = false, partialBaseline = false;
    if (baselineKey) {
        if (!coverage.firstDate || baseClipped.end < coverage.firstDate) insufficientData = true;
        else if (baseClipped.start < coverage.firstDate) partialBaseline = true;
    }

    const delta = baseline && !insufficientData ? {
        spend: round2(current.spend - baseline.spend),
        spendPct: baseline.spend > 0 ? round4((current.spend - baseline.spend) / baseline.spend) : null,
        income: round2(current.income - baseline.income),
        incomePct: baseline.income > 0 ? round4((current.income - baseline.income) / baseline.income) : null,
        net: round2(current.net - baseline.net),
        savingsRatePts: (current.savingsRate !== null && baseline.savingsRate !== null)
            ? round4(current.savingsRate - baseline.savingsRate) : null,
        byCategory: diffCategories(current.byCategory, baseline.byCategory)
    } : null;

    return {
        grain, period, mode,
        baselinePeriod: baselineKey,
        range: curClipped,
        baselineRange: baseClipped,
        aligned: isPartial,
        alignLabel: isPartial
            ? (grain === 'year' ? 'YTD vs YTD' : grain === 'quarter' ? 'QTD vs QTD' : 'MTD vs MTD')
            : null,
        elapsedDays,
        current, baseline, delta,
        oneOffs, excludedOneOffs: excludeOneOffs,
        insufficientData, partialBaseline, coverage
    };
}

function diffCategories(currentCats, baselineCats) {
    const base = new Map(baselineCats.map(c => [c.category, c.amount]));
    const seen = new Set();
    const rows = currentCats.map(c => {
        seen.add(c.category);
        const b = base.get(c.category) || 0;
        return {
            category: c.category,
            current: c.amount,
            baseline: round2(b),
            delta: round2(c.amount - b),
            deltaPct: b > 0 ? round4((c.amount - b) / b) : null
        };
    });
    // Categories that vanished are the most interesting rows on the page.
    for (const b of baselineCats) {
        if (seen.has(b.category)) continue;
        rows.push({
            category: b.category, current: 0, baseline: b.amount,
            delta: round2(-b.amount), deltaPct: -1
        });
    }
    return rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/** N periods of history ending at `endPeriod`, gaps filled with zeroes. */
export function buildTrendSeries(transactions = [], options = {}) {
    const {
        grain = 'month', periods = 24, category = null,
        endPeriod = periodKey(options.today || new Date(), grain),
        incomeCategories = []
    } = options;

    const rows = category === null
        ? transactions
        : transactions.filter(tx => (tx.category || null) === category);

    const byPeriod = new Map(
        rollupByPeriod(rows, grain, { incomeCategories }).map(r => [r.period, r])
    );

    const series = [];
    for (let i = periods - 1; i >= 0; i--) {
        const key = shiftPeriod(endPeriod, grain, -i);
        const found = byPeriod.get(key);
        series.push(found
            ? { period: key, income: found.income, spend: found.spend, net: found.net, savingsRate: found.savingsRate, empty: false }
            : { period: key, income: 0, spend: 0, net: 0, savingsRate: null, empty: true });
    }
    return series;
}

// ── internal transfers ──────────────────────────────────────────────────────

/**
 * Pair the two sides of a movement between the user's own accounts.
 *
 * With five banks this is not optional: an unpaired transfer inflates spend AND
 * income, which corrupts the savings rate every projection is built on.
 * Candidates are matched nearest-in-time first so a repeated standing transfer
 * pairs correctly instead of cross-matching across months.
 */
export function detectInternalTransfers(transactions = [], options = {}) {
    const windowDays = options.windowDays ?? 3;
    const epsilon = options.epsilon ?? 0.01;

    const outs = transactions.filter(tx => amountOf(tx) < 0 && !tx.transferPairId);
    const ins = transactions.filter(tx => amountOf(tx) > 0 && !tx.transferPairId);

    const candidates = [];
    for (const out of outs) {
        for (const inc of ins) {
            if (out.accountId === inc.accountId) continue;
            if (Math.abs(Math.abs(amountOf(out)) - amountOf(inc)) > epsilon) continue;
            const gap = daysBetween(out.date, inc.date);
            if (gap === null || Math.abs(gap) > windowDays) continue;
            candidates.push({ out, inc, gap: Math.abs(gap) });
        }
    }
    candidates.sort((a, b) => a.gap - b.gap || Math.abs(amountOf(b.out)) - Math.abs(amountOf(a.out)));

    const used = new Set();
    const pairs = [];
    for (const c of candidates) {
        if (used.has(c.out.id) || used.has(c.inc.id)) continue;
        used.add(c.out.id); used.add(c.inc.id);
        pairs.push({
            pairId: `tp_${c.out.id}_${c.inc.id}`,
            outId: c.out.id, inId: c.inc.id,
            fromAccountId: c.out.accountId, toAccountId: c.inc.accountId,
            amount: round2(Math.abs(amountOf(c.out))),
            date: c.out.date, gapDays: c.gap
        });
    }
    return { pairs, pairedIds: used };
}

// ── recurring detection ─────────────────────────────────────────────────────

const CADENCES = [
    { days: 7, min: 6, max: 8, label: 'weekly' },
    { days: 14, min: 12, max: 16, label: 'fortnightly' },
    { days: 30, min: 25, max: 35, label: 'monthly' },
    { days: 60, min: 55, max: 65, label: 'bi-monthly' },
    { days: 91, min: 84, max: 98, label: 'quarterly' },
    { days: 182, min: 172, max: 192, label: 'half-yearly' },
    { days: 365, min: 350, max: 380, label: 'yearly' }
];

export function normalizeMerchantKey(tx) {
    const raw = tx.merchant || tx.description || '';
    return String(raw)
        .toLowerCase()
        .replace(/\d{4,}/g, ' ')          // card/reference numbers
        .replace(/[^a-zà-ÿ ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function detectRecurring(transactions = [], options = {}) {
    const minOccurrences = options.minOccurrences ?? 3;
    const amountTolerance = options.amountTolerance ?? 0.15;
    const today = options.today ? String(options.today).slice(0, 10) : null;

    const groups = new Map();
    for (const tx of transactions) {
        if (isTransfer(tx) || amountOf(tx) >= 0) continue;
        const key = normalizeMerchantKey(tx);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tx);
    }

    const found = [];
    for (const [key, rows] of groups) {
        if (rows.length < minOccurrences) continue;
        const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1));

        const amounts = sorted.map(t => Math.abs(amountOf(t)));
        const medianAmount = median(amounts);
        if (!medianAmount) continue;
        // A merchant charged wildly different amounts is a habit, not a subscription.
        const amountsConsistent = amounts.every(
            a => Math.abs(a - medianAmount) / medianAmount <= amountTolerance
        );
        if (!amountsConsistent) continue;

        const gaps = [];
        for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1].date, sorted[i].date));
        if (gaps.some(g => g === null)) continue;
        const medianGap = median(gaps);
        const cadence = CADENCES.find(c => medianGap >= c.min && medianGap <= c.max);
        if (!cadence) continue;

        const gapsConsistent = gaps.every(g => g >= cadence.min && g <= cadence.max);
        const spread = medianGap > 0 ? mean(gaps.map(g => Math.abs(g - medianGap))) / medianGap : 1;
        const amountSpread = mean(amounts.map(a => Math.abs(a - medianAmount))) / medianAmount;
        const confidence = round4(clamp(
            0.55
            + Math.min(0.2, (sorted.length - minOccurrences) * 0.05)
            + (gapsConsistent ? 0.12 : 0)
            + (1 - Math.min(1, spread)) * 0.1
            + (1 - Math.min(1, amountSpread / amountTolerance)) * 0.08,
            0, 0.99
        ));

        const last = sorted[sorted.length - 1];
        const nextExpected = toISO(addDays(last.date, cadence.days));
        found.push({
            key,
            merchant: last.merchant || last.description,
            category: last.category || null,
            amount: round2(medianAmount),
            currency: last.currency || 'EUR',
            cadenceDays: cadence.days,
            cadenceLabel: cadence.label,
            monthlyEquivalent: round2(medianAmount * AVG_MONTH_DAYS / cadence.days),
            annualEquivalent: round2(medianAmount * 365 / cadence.days),
            occurrences: sorted.length,
            firstSeen: sorted[0].date,
            lastSeen: last.date,
            nextExpected,
            // Overdue by more than a cadence: probably cancelled, so say so
            // rather than quietly projecting a charge that will never arrive.
            likelyEnded: !!(today && daysBetween(last.date, today) > cadence.days * 1.8),
            transactionIds: sorted.map(t => t.id),
            confidence
        });
    }

    return found.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
}

// ── scenario projection ─────────────────────────────────────────────────────

/**
 * Establish the "if nothing changes" monthly baseline from complete months only.
 * A half-imported current month would drag every average down and make every
 * projected saving look smaller than it is.
 */
export function baselineMonthly(transactions = [], options = {}) {
    const months = options.months ?? 6;
    const today = options.today ? String(options.today).slice(0, 10) : null;
    const currentKey = today ? periodKey(today, 'month') : null;

    const rolled = rollupByPeriod(transactions, 'month', options)
        .filter(r => r.period !== currentKey);
    const recent = rolled.slice(-months);
    if (!recent.length) {
        return { months: 0, monthlyIncome: 0, monthlySpend: 0, monthlyNet: 0, savingsRate: null, byCategory: {} };
    }

    const monthlyIncome = mean(recent.map(r => r.income));
    const monthlySpend = mean(recent.map(r => r.spend));
    const byCategory = {};
    for (const r of recent) {
        for (const c of r.byCategory) {
            const key = c.category || '__uncategorized__';
            byCategory[key] = (byCategory[key] || 0) + c.amount;
        }
    }
    for (const k of Object.keys(byCategory)) byCategory[k] = round2(byCategory[k] / recent.length);

    return {
        months: recent.length,
        periods: recent.map(r => r.period),
        monthlyIncome: round2(monthlyIncome),
        monthlySpend: round2(monthlySpend),
        monthlyNet: round2(monthlyIncome - monthlySpend),
        savingsRate: monthlyIncome > 0 ? round4((monthlyIncome - monthlySpend) / monthlyIncome) : null,
        byCategory
    };
}

/**
 * Project a scenario forward. Non-destructive by construction: it consumes
 * transactions and returns numbers, and never mutates its input.
 *
 * Every lever's `monthlyImpact` is expressed as a change to monthly NET, so a
 * positive impact always means "more money kept", whichever side it acts on.
 */
export function projectScenario(transactions = [], scenario = {}, options = {}) {
    const horizonMonths = clamp(scenario.horizonMonths ?? 12, 1, 12);
    const levers = Array.isArray(scenario.levers) ? scenario.levers : [];
    const base = baselineMonthly(transactions, options);
    const recurring = options.recurring || detectRecurring(transactions, options);

    let monthlyIncome = base.monthlyIncome;
    let monthlySpend = base.monthlySpend;
    const oneOffsByMonth = new Map();
    const byLever = [];

    for (const lever of levers) {
        let monthlyImpact = 0, note = null;

        if (lever.type === 'category_delta') {
            const key = lever.category || '__uncategorized__';
            const current = base.byCategory[key] || 0;
            const change = lever.mode === 'percent'
                ? current * (Number(lever.value) / 100)   // -30 → spend 30% less
                : Number(lever.value);                    // -50 → spend €50 less
            const applied = Math.max(-current, change);   // can't cut below zero
            monthlySpend += applied;
            monthlyImpact = -applied;
            if (applied !== change) note = 'capped at the current category total';

        } else if (lever.type === 'cancel_recurring') {
            const sub = recurring.find(r => r.id === lever.recurringId || r.key === lever.recurringId);
            const monthly = sub ? sub.monthlyEquivalent : Number(lever.monthlyEquivalent) || 0;
            monthlySpend -= monthly;
            monthlyImpact = monthly;
            if (!sub && !lever.monthlyEquivalent) note = 'subscription not found — counted as zero';

        } else if (lever.type === 'income_delta') {
            const monthly = lever.cadence === 'annual'
                ? Number(lever.value) / 12
                : Number(lever.value);
            monthlyIncome += monthly;
            monthlyImpact = monthly;

        } else if (lever.type === 'one_off') {
            const month = clamp(Number(lever.month) || 1, 1, horizonMonths);
            oneOffsByMonth.set(month, (oneOffsByMonth.get(month) || 0) + Number(lever.amount));
            byLever.push({
                lever, monthlyImpact: 0,
                horizonImpact: round2(Number(lever.amount)),
                appliesInMonth: month, note
            });
            continue;

        } else {
            note = `unknown lever type "${lever.type}" — ignored`;
        }

        byLever.push({
            lever,
            monthlyImpact: round2(monthlyImpact),
            annualImpact: round2(monthlyImpact * 12),
            horizonImpact: round2(monthlyImpact * horizonMonths),
            note
        });
    }

    monthlySpend = Math.max(0, monthlySpend);
    monthlyIncome = Math.max(0, monthlyIncome);
    const projectedNet = monthlyIncome - monthlySpend;

    const series = [];
    let cumBase = 0, cumProj = 0;
    for (let m = 1; m <= horizonMonths; m++) {
        cumBase += base.monthlyNet;
        cumProj += projectedNet + (oneOffsByMonth.get(m) || 0);
        series.push({ month: m, baseline: round2(cumBase), projected: round2(cumProj), delta: round2(cumProj - cumBase) });
    }

    const oneOffTotal = [...oneOffsByMonth.values()].reduce((a, b) => a + b, 0);
    const recurringMonthlyDelta = projectedNet - base.monthlyNet;

    return {
        horizonMonths,
        baseline: {
            monthlyIncome: base.monthlyIncome,
            monthlySpend: base.monthlySpend,
            monthlyNet: base.monthlyNet,
            savingsRate: base.savingsRate,
            monthsOfHistory: base.months,
            periods: base.periods
        },
        projected: {
            monthlyIncome: round2(monthlyIncome),
            monthlySpend: round2(monthlySpend),
            monthlyNet: round2(projectedNet),
            savingsRate: monthlyIncome > 0 ? round4(projectedNet / monthlyIncome) : null
        },
        monthlyDelta: round2(recurringMonthlyDelta),
        annualDelta: round2(recurringMonthlyDelta * 12),
        horizonDelta: round2(recurringMonthlyDelta * horizonMonths + oneOffTotal),
        savingsRatePts: (base.savingsRate !== null && monthlyIncome > 0)
            ? round4(projectedNet / monthlyIncome - base.savingsRate) : null,
        oneOffTotal: round2(oneOffTotal),
        byLever,
        series,
        // Surfaced as the "based on <n> months" badge. A projection built on one
        // month of data is a guess, and should be labelled as one.
        thin: base.months < 3
    };
}

// ── small helpers ───────────────────────────────────────────────────────────

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }

export const __testing = { median, mean, clamp, CADENCES, AVG_MONTH_DAYS };

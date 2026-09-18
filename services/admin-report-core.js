/**
 * Turns admin_usage_report's output into what the admin page shows: headline
 * counts, adoption per tool, and one line per person.
 *
 * Pure, no imports, so tests/admin-report-core.test.js can pin the definitions
 * — above all what "active" means, since a dashboard number is only as honest
 * as the rule behind it.
 *
 * ACTIVE means the most recent of: signing in, saving something in any tool,
 * a price refresh (which writes a snapshot), or an import or valuation running.
 * Merely opening a page and reading it leaves no trace, so someone who only
 * looks is under-counted. Say so wherever the number is shown.
 *
 * Note that last_sign_in_at alone would be worse than it looks: a session
 * refreshes itself for weeks, so a person who uses the app daily without ever
 * signing in again would read as inactive.
 */

export const TOOLS = [
    { key: 'stocks', label: 'Stocks', unit: 'holdings' },
    { key: 'wine',   label: 'Cellar', unit: 'wines' },
    { key: 'spend',  label: 'Spend',  unit: 'movements' },
    { key: 'bank',   label: 'Bank',   unit: 'holdings' },
];

const DAY = 86_400_000;

/** A timestamp in ms, or null. Absent is not the epoch: `Number(null)` is 0. */
function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/** A row count; anything that is not a finite non-negative number counts as none. */
function toCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function latest(...values) {
    const ms = values.filter(v => v !== null);
    return ms.length ? Math.max(...ms) : null;
}

const within = (ms, days, now) => ms !== null && now - ms <= days * DAY;

/**
 * One person, in the shape the page renders.
 *
 * Timestamps in the future are dropped, not believed. created_at and
 * updated_at are column defaults that a client can override on its own rows,
 * so anyone could date their activity to next year and sit at the top of the
 * list forever. A day of slack allows for clock skew.
 */
export function describePerson(raw, now = Date.now()) {
    const past = value => {
        const ms = toMs(value);
        return ms !== null && ms <= now + DAY ? ms : null;
    };
    const tools = TOOLS.map(t => ({
        ...t,
        items: toCount(raw?.tools?.[t.key]?.items),
        lastMs: past(raw?.tools?.[t.key]?.last),
    }));
    const used = tools.filter(t => t.items > 0);
    return {
        id: raw.id,
        email: raw.email ?? null,
        joinedMs: past(raw.created_at),
        lastSignInMs: past(raw.last_sign_in_at),
        lastActiveMs: latest(
            past(raw.last_sign_in_at),
            past(raw.last_report_at),
            ...tools.map(t => t.lastMs),
        ),
        used,
        problems30: toCount(raw.problems_30d),
        operations30: toCount(raw.operations_30d),
    };
}

/**
 * @param {{people?: object[]}} report  admin_usage_report's result
 * @param {number} now                  ms, injectable for tests
 */
export function summarizeUsage(report, now = Date.now()) {
    const people = (Array.isArray(report?.people) ? report.people : [])
        .filter(p => p && p.id)
        .map(p => describePerson(p, now))
        .sort((a, b) => (b.lastActiveMs ?? -Infinity) - (a.lastActiveMs ?? -Infinity));

    const totals = {
        accounts: people.length,
        active7: people.filter(p => within(p.lastActiveMs, 7, now)).length,
        active30: people.filter(p => within(p.lastActiveMs, 30, now)).length,
        joined30: people.filter(p => within(p.joinedMs, 30, now)).length,
        unused: people.filter(p => p.used.length === 0).length,
    };

    const tools = TOOLS.map(t => {
        const users = people.map(p => p.used.find(u => u.key === t.key)).filter(Boolean);
        return {
            ...t,
            users: users.length,
            active30: users.filter(u => within(u.lastMs, 30, now)).length,
        };
    });

    return { totals, tools, people, byId: new Map(people.map(p => [p.id, p])) };
}

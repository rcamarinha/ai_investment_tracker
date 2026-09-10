/**
 * Shared state for the Spend module.
 *
 * Mirrors wine/state.js and services/state.js — a single plain object shared
 * across the module by ES module reference, no store library.
 */

const state = {
    // The most recent committed import, so it can be taken back as a unit.
    // Session-only: undoing is for the mistake you have just watched happen,
    // and a persisted history would be a list of decisions nobody wants to make
    // later.
    lastImport: null,

    // ── data ────────────────────────────────────────────────────────────────
    accounts: [],           // spend_accounts rows (camelCase)
    transactions: [],       // spend_transactions rows, newest first
    categories: [],         // spend_categories rows
    rules: [],              // spend_rules rows
    recurring: [],          // detected + persisted subscriptions
    profiles: [],           // spend_bank_profiles rows
    pendingDetails: [],     // MB WAY rows still waiting for their bank line
    scenarios: [],          // saved simulator scenarios

    // ── view ────────────────────────────────────────────────────────────────
    grain: 'month',         // 'month' | 'quarter' | 'year'
    period: null,           // e.g. '2026-08'; null = current period
    compareMode: 'previous',// 'previous' | 'yoy' | 'none'
    excludeOneOffs: false,
    selectedCategory: null, // category slicer (null = all)
    accountFilter: null,    // account id filter (null = all)
    txSearch: '',
    txTypeFilter: 'all',    // 'all' | 'spend' | 'income' | 'transfer' | 'review'
    txPage: 0,
    pageSize: 50,

    // ── transient view/edit state ───────────────────────────────────────────
    // Declared rather than sprung on the object at runtime: state.js is the
    // only description of a module's shape, and half of it was invisible.
    recurringDetected: [],
    editingTxId: null,
    editingAccountId: null,

    // ── import in progress ──────────────────────────────────────────────────
    importText: null,
    importFileName: null,
    importAccountId: null,
    importDraft: null,
    importResult: null,
    importSampleRows: [],

    // ── flags ───────────────────────────────────────────────────────────────
    loading: false,
    importing: false,
    ledgerTruncated: false,
    loadFailed: false,

    // ── auth ────────────────────────────────────────────────────────────────
    supabaseUrl: 'https://dybetrrhshqezokcxiid.supabase.co',
    supabaseAnonKey: 'sb_publishable_1exZf5F28-XEl-AxelyxEQ_Yb6WEQMz',
    supabaseClient: null,
    currentUser: null,
    passwordRecoveryMode: false
};

export default state;

/**
 * Clear everything that narrows the ledger view.
 *
 * Called after an import, because the one thing a user must see afterwards is
 * what they just imported. Filters survive an import, and several of them hide
 * new rows completely: leaving the type filter on `review` to deal with an
 * unconfirmed transaction hides every clean row the import just added, so a
 * successful import of eighty movements shows nothing at all. The account
 * filter and an explicitly chosen period do the same.
 *
 * Not a render concern — the filters are state, and resetting them where the
 * data changes keeps the rule in one place instead of in each view.
 */
export function clearViewFilters(target = state) {
    target.period = null;            // re-derived to the newest period holding data
    target.selectedCategory = null;
    target.accountFilter = null;
    target.txSearch = '';
    target.txTypeFilter = 'all';
    target.txPage = 0;
    return target;
}

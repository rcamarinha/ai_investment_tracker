/**
 * Shared state for the Spend module.
 *
 * Mirrors wine/state.js and services/state.js — a single plain object shared
 * across the module by ES module reference, no store library.
 */

const state = {
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

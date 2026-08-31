/**
 * Shared state for the Bank Holdings module.
 * Same plain-object-by-reference pattern as wine/state.js and spend/state.js.
 */
const state = {
    holdings: [],
    summary: null,          // last computed totals, for the hub and tests
    editingId: null,
    typeFilter: null,        // null = all
    showArchived: false,

    supabaseUrl: 'https://dybetrrhshqezokcxiid.supabase.co',
    supabaseAnonKey: 'sb_publishable_1exZf5F28-XEl-AxelyxEQ_Yb6WEQMz',
    supabaseClient: null,
    currentUser: null,
    passwordRecoveryMode: false
};
export default state;

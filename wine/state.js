/**
 * Shared state for the Wine Cellar Tracker.
 *
 * Mirrors the pattern of services/state.js — a single plain object shared
 * across all wine modules via ES module reference.
 */

const state = {
    cellar: [],              // Array of bottle objects
    valuationsLoading: false,
    anthropicKey: '',
supabaseUrl: 'https://dybetrrhshqezokcxiid.supabase.co',
    supabaseAnonKey: 'sb_publishable_1exZf5F28-XEl-AxelyxEQ_Yb6WEQMz',
    supabaseClient: null,
    currentUser: null,
    cellarHistory: [],       // Array of snapshot objects
    selectedAllocationTab: 'region',
    passwordRecoveryMode: false,
    userRole: 'user',
    // Editing state
    editingBottleId: null,   // UUID of bottle currently being edited (null = adding new)
};

export default state;

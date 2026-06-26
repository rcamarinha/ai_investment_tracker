/**
 * Shared application state.
 *
 * Every module imports this single object and reads/writes its properties.
 * No state management library — just a plain object shared via ES module reference.
 */

const state = {
    portfolio: [],
    marketPrices: {},
    priceMetadata: {},
    pricesLoading: false,
    alphaVantageKey: '',
    finnhubKey: '',
    fmpKey: '',
    anthropicKey: '',
    portfolioHistory: [],
    supabaseUrl: 'https://dybetrrhshqezokcxiid.supabase.co',
    supabaseAnonKey: 'sb_publishable_1exZf5F28-XEl-AxelyxEQ_Yb6WEQMz',
    supabaseClient: null,
    currentUser: null,
    userRole: 'user',              // 'admin' or 'user' — determines API key visibility
    selectedPerspective: 'value',
    selectedSector: null,
    sectorCache: {},
    assetDatabase: {},
    transactions: {},          // {SYMBOL: [{type, shares, price, date, totalAmount, costBasis?, realizedGainLoss?, fee?, tax?, ratio?, note?}]}
    showInactivePositions: false,
    ledgerNeedsReview: false,  // true when a holding went share-negative (unhandled split/ISIN change)
    txFilter: { type: 'all', q: '' }, // transaction-ledger view filter (type + symbol search)
    _ledgerRows: [],           // transient: rows shown in the ledger table (for index-based delete)
    baseCurrency: 'EUR',       // User's home currency for portfolio totals
    exchangeRates: {},         // {USD: 0.92, GBP: 1.17, ...} — rates TO baseCurrency (1 foreign = X base)
    exchangeRatesTimestamp: null, // When rates were last fetched
    lastMovers: null,          // Top movers from the most recent price update {movers, updatedAt}
    passwordRecoveryMode: false, // True when user arrives via a password-reset email link
};

export default state;

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
    selectedPerspective: 'value',
    selectedSector: null,
    sectorCache: {},
    assetDatabase: {},
    transactions: {},          // {SYMBOL: [{type, shares, price, date, totalAmount, costBasis?, realizedGainLoss?}]}
    showInactivePositions: false,
};

export default state;

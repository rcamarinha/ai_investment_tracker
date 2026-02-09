/**
 * Sector mapping data and lookup helpers.
 *
 * Static mapping for ~200 common tickers so we can classify positions
 * without an API call. Falls back to the DB-backed assetDatabase, then
 * a localStorage cache, then "Other".
 */

import state from '../services/state.js';

// ── Static Sector Mapping ───────────────────────────────────────────────────

export const SECTOR_MAPPING = {
    // Technology
    AAPL: 'Technology', MSFT: 'Technology', GOOGL: 'Technology', GOOG: 'Technology',
    META: 'Technology', AMZN: 'Technology', NVDA: 'Technology', AMD: 'Technology',
    INTC: 'Technology', CRM: 'Technology', ORCL: 'Technology', ADBE: 'Technology',
    CSCO: 'Technology', IBM: 'Technology', QCOM: 'Technology', TXN: 'Technology',
    AVGO: 'Technology', NOW: 'Technology', INTU: 'Technology', AMAT: 'Technology',
    MU: 'Technology', LRCX: 'Technology', KLAC: 'Technology', SNPS: 'Technology',
    CDNS: 'Technology', MRVL: 'Technology', NXPI: 'Technology', ASML: 'Technology',
    TSM: 'Technology', ARM: 'Technology', PLTR: 'Technology', SNOW: 'Technology',

    // Healthcare
    JNJ: 'Healthcare', UNH: 'Healthcare', PFE: 'Healthcare', ABBV: 'Healthcare',
    MRK: 'Healthcare', LLY: 'Healthcare', TMO: 'Healthcare', ABT: 'Healthcare',
    DHR: 'Healthcare', BMY: 'Healthcare', AMGN: 'Healthcare', GILD: 'Healthcare',
    MDT: 'Healthcare', CVS: 'Healthcare', ISRG: 'Healthcare', VRTX: 'Healthcare',
    REGN: 'Healthcare', SYK: 'Healthcare', ZTS: 'Healthcare', BDX: 'Healthcare',
    CI: 'Healthcare', HUM: 'Healthcare', ELV: 'Healthcare', MCK: 'Healthcare',

    // Financial Services
    JPM: 'Financial', BAC: 'Financial', WFC: 'Financial', GS: 'Financial',
    MS: 'Financial', C: 'Financial', BLK: 'Financial', SCHW: 'Financial',
    AXP: 'Financial', SPGI: 'Financial', CME: 'Financial', ICE: 'Financial',
    USB: 'Financial', PNC: 'Financial', TFC: 'Financial', COF: 'Financial',
    BK: 'Financial', STT: 'Financial', AIG: 'Financial', MET: 'Financial',
    PRU: 'Financial', AFL: 'Financial', ALL: 'Financial', TRV: 'Financial',
    V: 'Financial', MA: 'Financial', PYPL: 'Financial', SQ: 'Financial',

    // Consumer Discretionary
    TSLA: 'Consumer Discretionary', HD: 'Consumer Discretionary', NKE: 'Consumer Discretionary',
    MCD: 'Consumer Discretionary', SBUX: 'Consumer Discretionary', LOW: 'Consumer Discretionary',
    TJX: 'Consumer Discretionary', BKNG: 'Consumer Discretionary', MAR: 'Consumer Discretionary',
    CMG: 'Consumer Discretionary', YUM: 'Consumer Discretionary', DPZ: 'Consumer Discretionary',
    ORLY: 'Consumer Discretionary', AZO: 'Consumer Discretionary', ROST: 'Consumer Discretionary',
    DHI: 'Consumer Discretionary', LEN: 'Consumer Discretionary', PHM: 'Consumer Discretionary',
    F: 'Consumer Discretionary', GM: 'Consumer Discretionary', ABNB: 'Consumer Discretionary',

    // Consumer Staples
    PG: 'Consumer Staples', KO: 'Consumer Staples', PEP: 'Consumer Staples',
    COST: 'Consumer Staples', WMT: 'Consumer Staples', PM: 'Consumer Staples',
    MO: 'Consumer Staples', MDLZ: 'Consumer Staples', CL: 'Consumer Staples',
    KMB: 'Consumer Staples', GIS: 'Consumer Staples', K: 'Consumer Staples',
    HSY: 'Consumer Staples', SJM: 'Consumer Staples', CAG: 'Consumer Staples',
    KHC: 'Consumer Staples', STZ: 'Consumer Staples', TAP: 'Consumer Staples',

    // Energy
    XOM: 'Energy', CVX: 'Energy', COP: 'Energy', EOG: 'Energy',
    SLB: 'Energy', MPC: 'Energy', PSX: 'Energy', VLO: 'Energy',
    OXY: 'Energy', PXD: 'Energy', DVN: 'Energy', HAL: 'Energy',
    BKR: 'Energy', FANG: 'Energy', HES: 'Energy', MRO: 'Energy',
    TTE: 'Energy', BP: 'Energy', SHEL: 'Energy', RDS: 'Energy',

    // Industrials
    CAT: 'Industrials', DE: 'Industrials', BA: 'Industrials', HON: 'Industrials',
    UNP: 'Industrials', RTX: 'Industrials', LMT: 'Industrials', GE: 'Industrials',
    MMM: 'Industrials', UPS: 'Industrials', FDX: 'Industrials', CSX: 'Industrials',
    NSC: 'Industrials', WM: 'Industrials', RSG: 'Industrials', EMR: 'Industrials',
    ITW: 'Industrials', ETN: 'Industrials', PH: 'Industrials', ROK: 'Industrials',

    // Materials
    LIN: 'Materials', APD: 'Materials', SHW: 'Materials', ECL: 'Materials',
    FCX: 'Materials', NEM: 'Materials', NUE: 'Materials', DOW: 'Materials',
    DD: 'Materials', PPG: 'Materials', VMC: 'Materials', MLM: 'Materials',

    // Utilities
    NEE: 'Utilities', DUK: 'Utilities', SO: 'Utilities', D: 'Utilities',
    AEP: 'Utilities', EXC: 'Utilities', SRE: 'Utilities', XEL: 'Utilities',
    ED: 'Utilities', WEC: 'Utilities', ES: 'Utilities', AWK: 'Utilities',

    // Real Estate
    PLD: 'Real Estate', AMT: 'Real Estate', CCI: 'Real Estate', EQIX: 'Real Estate',
    SPG: 'Real Estate', PSA: 'Real Estate', O: 'Real Estate', WELL: 'Real Estate',
    DLR: 'Real Estate', AVB: 'Real Estate', EQR: 'Real Estate', VTR: 'Real Estate',

    // Communication Services
    DIS: 'Communication', NFLX: 'Communication', CMCSA: 'Communication', T: 'Communication',
    VZ: 'Communication', TMUS: 'Communication', CHTR: 'Communication', EA: 'Communication',
    TTWO: 'Communication', ATVI: 'Communication', WBD: 'Communication', PARA: 'Communication',

    // ETFs — categorized by focus
    SPY: 'Index ETF', VOO: 'Index ETF', IVV: 'Index ETF', VTI: 'Index ETF',
    QQQ: 'Tech ETF', VGT: 'Tech ETF', XLK: 'Tech ETF', ARKK: 'Tech ETF',
    XLF: 'Financial ETF', VFH: 'Financial ETF', KRE: 'Financial ETF',
    XLE: 'Energy ETF', VDE: 'Energy ETF', OIH: 'Energy ETF',
    XLV: 'Healthcare ETF', VHT: 'Healthcare ETF', IBB: 'Healthcare ETF',
    XLY: 'Consumer ETF', VCR: 'Consumer ETF',
    XLP: 'Consumer ETF', VDC: 'Consumer ETF',
    XLI: 'Industrial ETF', VIS: 'Industrial ETF',
    XLU: 'Utilities ETF', VPU: 'Utilities ETF',
    XLRE: 'Real Estate ETF', VNQ: 'Real Estate ETF',
    XLB: 'Materials ETF', VAW: 'Materials ETF',
    BND: 'Bond ETF', AGG: 'Bond ETF', TLT: 'Bond ETF', LQD: 'Bond ETF',
    HYG: 'Bond ETF', JNK: 'Bond ETF', VCIT: 'Bond ETF', VCSH: 'Bond ETF',
    GLD: 'Commodity ETF', SLV: 'Commodity ETF', IAU: 'Commodity ETF',
    VWO: 'Emerging ETF', EFA: 'Intl ETF', IEFA: 'Intl ETF', VEA: 'Intl ETF',
    EEM: 'Emerging ETF', IEMG: 'Emerging ETF',

    // Crypto
    BTC: 'Crypto', ETH: 'Crypto', SOL: 'Crypto', ADA: 'Crypto',
    DOGE: 'Crypto', XRP: 'Crypto', DOT: 'Crypto', AVAX: 'Crypto',
    GBTC: 'Crypto', ETHE: 'Crypto', BITO: 'Crypto',

    // European stocks (common ones)
    'MC.PA': 'Consumer Discretionary', 'OR.PA': 'Consumer Staples', 'SAN.PA': 'Healthcare',
    'AIR.PA': 'Industrials', 'TTE.PA': 'Energy', 'BNP.PA': 'Financial',
    'ASML.AS': 'Technology', 'ADYEN.AS': 'Technology', 'PRX.AS': 'Technology',
    'SAP.DE': 'Technology', 'SIE.DE': 'Industrials', 'ALV.DE': 'Financial',
    'NESN.SW': 'Consumer Staples', 'ROG.SW': 'Healthcare', 'NOVN.SW': 'Healthcare',
    'SHEL.L': 'Energy', 'AZN.L': 'Healthcare', 'HSBA.L': 'Financial'
};


// ── Sector Lookup ───────────────────────────────────────────────────────────

/**
 * Get sector for a symbol.
 * Priority: DB-backed assetDatabase > static SECTOR_MAPPING > localStorage cache > "Other"
 */
export function getSector(symbol) {
    if (!symbol) return 'Other';
    const upperSymbol = symbol.toUpperCase();

    // Check DB-backed asset database first
    if (state.assetDatabase[upperSymbol] && state.assetDatabase[upperSymbol].sector) {
        return state.assetDatabase[upperSymbol].sector;
    }

    // Check static mapping
    if (SECTOR_MAPPING[upperSymbol]) {
        return SECTOR_MAPPING[upperSymbol];
    }

    // Check cache (from previous API lookups)
    if (state.sectorCache[upperSymbol]) {
        return state.sectorCache[upperSymbol];
    }

    return 'Other';
}


// ── Sector Cache Persistence ────────────────────────────────────────────────

export function loadSectorCache() {
    try {
        const cached = localStorage.getItem('sectorCache');
        if (cached) {
            state.sectorCache = JSON.parse(cached);
            console.log('Loaded sector cache with', Object.keys(state.sectorCache).length, 'entries');
        }
    } catch (e) {
        console.warn('Failed to load sector cache:', e);
        state.sectorCache = {};
    }
}

export function saveSectorCache() {
    try {
        localStorage.setItem('sectorCache', JSON.stringify(state.sectorCache));
    } catch (e) {
        console.warn('Failed to save sector cache:', e);
    }
}

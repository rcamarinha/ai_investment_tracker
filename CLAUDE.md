# CLAUDE.md - AI Investment Tracker

## Project Overview

A **modular browser-based portfolio management application** that allows users to import investment portfolios, fetch live market prices via a 3-tier API fallback strategy, track performance over time, and generate AI-powered insights via the Claude API.

**No backend, no build system, no framework.** Vanilla HTML + CSS + JavaScript using ES modules. Requires an HTTP server (not `file://`) — use `python -m http.server 8000` or deploy to GitHub Pages.

## Architecture

```
ai_investment_tracker/
├── index.html                  # Entry point: HTML structure + module init (~350 lines)
├── css/
│   └── styles.css              # All styles + button style guide (~480 lines)
├── data/
│   ├── sectors.js              # SECTOR_MAPPING + getSector() helpers
│   └── perspectives.js         # INVESTMENT_PERSPECTIVES (6 philosophies + prompts)
├── services/
│   ├── state.js                # Shared application state object
│   ├── utils.js                # formatCurrency, formatPercent, escapeHTML, detectExchange
│   ├── pricing.js              # 3-tier price fetching (Finnhub → FMP → Alpha Vantage)
│   ├── storage.js              # Supabase DB, localStorage, Claude cloud storage
│   ├── auth.js                 # Supabase authentication (login, signup, logout)
│   ├── portfolio.js            # Render, import, snapshots, history
│   ├── analysis.js             # AI analysis & trade ideas via Claude API
│   └── ui.js                   # Allocation charts, perspective tabs, dialogs
├── src/
│   └── portfolio.js            # Pure functions for testing (kept in sync with services)
├── tests/                      # Vitest test suite
├── supabase/
│   └── functions/
│       └── analyze-portfolio/
│           └── index.ts        # Edge function for server-side analysis
├── supabase_schema.sql         # Database schema
├── vitest.config.js
└── package.json
```

### Module Dependency Graph

```
index.html (init)
  ├── services/state.js          (no deps — shared state object)
  ├── data/sectors.js            (← state)
  ├── data/perspectives.js       (no deps — pure data)
  ├── services/utils.js          (← state, sectors)
  ├── services/auth.js           (← state, utils, storage)
  ├── services/storage.js        (← state, utils, auth, portfolio, pricing)
  ├── services/pricing.js        (← state, utils, portfolio, storage)
  ├── services/portfolio.js      (← state, utils, sectors, ui, storage, pricing)
  ├── services/analysis.js       (← state, utils, perspectives)
  └── services/ui.js             (← state, utils, sectors, perspectives, portfolio, storage, auth)
```

Note: Several services have circular imports (e.g., pricing ↔ portfolio, storage ↔ portfolio). This works with ES modules because functions are called at runtime, not at module evaluation time.

### Key HTML Element IDs

- `positions` - Portfolio positions grid container
- `importDialog` / `importText` - Import dialog and textarea
- `apiKeyDialog` - API key configuration dialog
- `finnhubKeyInput`, `fmpKeyInput`, `alphaVantageKeyInput`, `anthropicKeyInput` - Key inputs
- `supabaseUrlInput`, `supabaseAnonKeyInput` - Supabase config inputs
- `refreshBtn` - Update prices button
- `analyzeBtn` / `tradeIdeasBtn` - AI analysis buttons
- `analysisSection` - AI analysis results container
- `historySection` / `historyChart` / `historyLog` - History section
- `allocationSection` / `typeAllocationChart` / `sectorAllocationChart` - Allocation charts
- `perspectiveTabs` / `perspectiveInfo` - Perspective selector
- `authBar` - Authentication bar

## Application State

All state lives in a single shared object (`services/state.js`):

```javascript
const state = {
    portfolio: [],           // Array of {name, symbol, platform, type, shares, avgPrice}
    marketPrices: {},        // {symbol: price}
    priceMetadata: {},       // {symbol: {timestamp, source, success, error?}}
    pricesLoading: false,    // Lock for price fetching
    alphaVantageKey: '',     // API keys (stored in localStorage)
    finnhubKey: '',
    fmpKey: '',
    anthropicKey: '',
    portfolioHistory: [],    // Array of snapshot objects
    supabaseUrl: '',         // Supabase project URL
    supabaseAnonKey: '',     // Supabase anon key
    supabaseClient: null,    // Initialized on page load
    currentUser: null,       // Authenticated user
    selectedPerspective: 'value',  // Active investment lens
    selectedSector: null,    // Sector filter (null = all)
    sectorCache: {},         // {symbol: sector} from localStorage
    assetDatabase: {},       // {ticker: {name, sector, exchange, currency, assetType}}
};
```

## Service Modules

### Pricing Service (`services/pricing.js`)
- **`fetchStockPrice(symbol)`** - Tries Finnhub → FMP → Alpha Vantage in order
- **`tryAlternativeFormats(symbol, assetName)`** - International ticker resolution (.PA, .L, .DE, etc.)
- **`fetchAssetProfile(symbol)`** - Gets sector/exchange metadata from APIs
- **`fetchMarketPrices()`** - Batch fetching with rate limiting, progress UI, auto-snapshot

### Portfolio Service (`services/portfolio.js`)
- **`renderPortfolio()`** - Renders portfolio grid with gains/losses, status icons
- **`importPositions()`** - Parses tab-separated data (full 8+ column or simple 3 column)
- **`savePortfolioSnapshot()`** - Saves to localStorage + Supabase + Claude cloud
- **`updateHistoryDisplay()`** / **`clearHistory()`** - History management

### Storage Service (`services/storage.js`)
- **`initSupabase()`** - Initialize Supabase client with auth listener
- **`loadFromDatabase()`** - Load portfolio, snapshots, assets, cached prices
- **`savePortfolioDB()`** / **`saveSnapshotToDB()`** - CRUD operations
- **`saveAssetsToDB()`** / **`loadAssetsFromDB()`** - Asset metadata
- **`enrichUnknownAssets()`** - Fetch sector data for unclassified assets
- **`savePriceHistoryToDB()`** / **`loadLatestPricesFromDB()`** - Price caching

### Analysis Service (`services/analysis.js`)
- **`analyzeMarkets()`** - Perspective-based portfolio analysis via Claude API
- **`getTradeIdeas()`** - Concrete daily trade ideas with execution plan

### UI Service (`services/ui.js`)
- **`renderAllocationCharts()`** - Type & sector allocation with interactive slicer
- **`renderPerspectiveTabs()`** - Investment perspective selector tabs
- **`showApiKeyDialog()`** / **`saveApiKeys()`** / **`clearApiKeys()`** - API key management

### Auth Service (`services/auth.js`)
- **`handleLogin()`** / **`handleSignup()`** / **`handleLogout()`**
- **`updateAuthBar()`** - Render login/logout UI

## Data Modules

### Sector Mapping (`data/sectors.js`)
- **`SECTOR_MAPPING`** - Static map of ~200 tickers to sectors (Technology, Healthcare, Financial, etc.)
- **`getSector(symbol)`** - Lookup: DB → static map → cache → "Other"
- **`loadSectorCache()`** / **`saveSectorCache()`** - localStorage persistence

### Investment Perspectives (`data/perspectives.js`)
- **`INVESTMENT_PERSPECTIVES`** - 6 philosophies: Value, GARP, Quant, Macro, Passive, Technical
- Each includes: name, icon, color, figures, description, and Claude API prompt

## Button Style Guide

All buttons use the `.btn` base class (defined in `css/styles.css`):

| Class | Color | Purpose |
|-------|-------|---------|
| `.btn-primary` | Blue `#2563eb` | Standard actions (import, cancel) |
| `.btn-accent` | Purple→Blue gradient | AI/special actions |
| `.btn-success` | Green `#059669` | Positive actions (save, update prices) |
| `.btn-warning` | Amber `#f59e0b` | Caution actions (snapshots) |
| `.btn-danger` | Red `#dc2626` | Destructive actions (clear, delete) |
| `.btn-key` | Purple `#7c3aed` | API key management |
| `.btn-trade` | Green gradient | Trade ideas |

Sizes: `.btn` (default) or `.btn-sm` (compact).

## Data Persistence

- **localStorage** — API keys, sector cache, portfolio history
- **Supabase** — Positions, snapshots, assets, price history, shared config (RLS per-user)
- **Claude cloud storage** — Portfolio state + snapshots (when running in claude.ai)

## External API Endpoints

| API | Endpoint | Rate Limit |
|-----|----------|------------|
| Finnhub | `finnhub.io/api/v1/quote` | 60/min |
| FMP | `financialmodelingprep.com/stable/quote-short` | 250/day |
| Alpha Vantage | `alphavantage.co/query?function=GLOBAL_QUOTE` | 5/min, 25/day |
| Claude API | `api.anthropic.com/v1/messages` | Per-key limits |
| Supabase | Project-specific URL | Per-plan limits |

## Development Workflow

### Running the App

**Requires an HTTP server** (ES modules don't work via `file://`):
```bash
python -m http.server 8000
# Then open http://localhost:8000
```

Or deploy to GitHub Pages (already configured via CNAME).

### Making Changes

Each concern lives in its own file:
1. **Styles** → `css/styles.css`
2. **HTML** → `index.html` (just structure + init)
3. **Data** → `data/sectors.js`, `data/perspectives.js`
4. **Logic** → `services/*.js` (one file per concern)

### Testing

```bash
npx vitest run
```

Test files in `tests/` import from `src/portfolio.js` (pure function mirror).

### Debugging

Extensive `console.log` output with `=== SECTION MARKERS ===`. Open DevTools (F12).

## Common Pitfalls

- **ES modules require HTTP** — `file://` won't work; use a local server or GitHub Pages
- **Circular imports** — Services cross-reference each other; this works because functions are called at runtime, not at module load time
- **`window.*` globals** — onclick handlers require functions on `window`; these are set in the init block of `index.html`
- **API keys are never committed** — They live only in the user's browser localStorage
- **Rate limiting** — Finnhub 1000ms, FMP 500ms, Alpha Vantage 12000ms between calls
- **FMP endpoint** — Uses `/stable/quote-short` (not `/api/v3/quote`) due to CORS/auth issues
- **`window.storage`** — Claude-specific API, not standard Web Storage
- **`renderPortfolio()` called multiple times** after import with setTimeout delays for UI refresh

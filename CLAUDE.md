# CLAUDE.md - AI Investment Tracker

## Project Overview

This is a **single-file browser-based portfolio management application** (`index.html`, ~1740 lines) that allows users to import investment portfolios, fetch live market prices via a 3-tier API fallback strategy, track performance over time, and optionally generate AI-powered insights when running inside claude.ai.

There is **no backend, no build system, no package manager, and no framework**. The entire application is vanilla HTML + CSS + JavaScript in one self-contained file.

## Architecture

```
ai_investment_tracker/
└── index.html          # Complete SPA (~310 HTML, ~140 CSS, ~1290 JS lines)
```

### Structure within `index.html`

| Section | Lines (approx) | Purpose |
|---------|----------------|---------|
| `<style>` | 7-170 | Dark theme CSS, grid layout, responsive design |
| `<body>` HTML | 170-307 | UI structure: header, portfolio card, dialogs, history |
| `<script>` | 308-1737 | All application logic |

### Key HTML Element IDs

- `positions` - Portfolio positions grid container
- `importDialog` / `importText` - Import dialog and textarea
- `apiKeyDialog` - API key configuration dialog
- `finnhubKeyInput`, `fmpKeyInput`, `alphaVantageKeyInput` - Key inputs
- `refreshBtn` - Update prices button
- `analyzeBtn` - AI analysis button
- `analysisSection` - AI analysis results container
- `historySection` - Portfolio history section
- `historyChart` / `historyLog` - Chart and snapshot log

## Application State

All state lives in module-level variables (no state management library):

```javascript
let portfolio = [];        // Array of {name, symbol, platform, shares, avgPrice}
let marketPrices = {};     // {symbol: price}
let priceMetadata = {};    // {symbol: {timestamp, source, success, error?, alternativeSymbol?}}
let pricesLoading = false; // Lock for price fetching
let alphaVantageKey = '';  // API key (stored in localStorage)
let finnhubKey = '';       // API key (stored in localStorage)
let fmpKey = '';           // API key (stored in localStorage)
let portfolioHistory = []; // Array of snapshot objects
```

## Core Functions

### Price Fetching (3-Tier Fallback)

- **`fetchStockPrice(symbol)`** (~line 329) - Tries APIs in order:
  1. **Finnhub** (Tier 1): `finnhub.io/api/v1/quote` - 60 calls/min, no daily limit
  2. **FMP** (Tier 2): `financialmodelingprep.com/stable/quote-short` - 250 calls/day
  3. **Alpha Vantage** (Tier 3): `alphavantage.co/query` - 5/min, 25/day
- **`tryAlternativeFormats(symbol, assetName)`** (~line 455) - Handles international stocks by trying exchange suffixes (`.PA`, `.L`, `.DE`, `.AS`, `.MI`, `.SW`) and smart name-to-ticker mappings for ~20 European companies
- **`fetchMarketPrices()`** (~line 895) - Orchestrates batch price fetching with rate limiting, progress UI, and auto-snapshot on completion

### Portfolio Management

- **`importPositions()`** (~line 1278) - Parses tab-separated spreadsheet data. Supports two formats:
  - Full (8+ columns): Asset, Ticker, Platform, Type, Units, TotalInvestment, ActiveInvestment, AvgUnitPrice, ...
  - Simple (3 columns): Ticker, Shares, Price
- **`renderPortfolio()`** (~line 1075) - Renders the portfolio grid with calculated gains/losses, status icons, and timestamp metadata
- **`savePortfolioSnapshot()`** (~line 690) - Saves snapshot to localStorage and optionally to Claude cloud storage
- **`updateHistoryDisplay()`** (~line 748) - Renders history chart and snapshot log

### AI Analysis

- **`analyzeMarkets()`** (~line 1449) - Calls Claude Sonnet API (only works inside claude.ai). Returns JSON with `marketOverview`, `portfolioImpact`, and `ideas[]`

### UI Helpers

- **`showApiKeyDialog()` / `saveApiKeys()`** (~line 583) - API key CRUD
- **`showImportDialog()` / `closeImportDialog()`** (~line 1234) - Import dialog
- **`updateChart()`** - CSS-only dual-bar chart for history visualization
- **`formatCurrency(val)`** / **`formatPercent(val)`** - Number formatting

## Data Persistence

- **localStorage** (always available):
  - `finnhubKey`, `fmpKey`, `alphaVantageKey` - API keys
  - `portfolioHistory` - JSON array of snapshots
- **Claude cloud storage** (only in claude.ai via `window.storage`):
  - `current-portfolio` - Full portfolio state with prices
  - `snapshot:{timestamp}` - Individual snapshots
  - Merges with localStorage on load (deduplicates by timestamp)

## External API Endpoints

| API | Endpoint | Auth | Rate Limit |
|-----|----------|------|------------|
| Finnhub | `https://finnhub.io/api/v1/quote?symbol={s}&token={key}` | Query param | 60/min |
| FMP | `https://financialmodelingprep.com/stable/quote-short?symbol={s}&apikey={key}` | Query param | 250/day |
| Alpha Vantage | `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol={s}&apikey={key}` | Query param | 5/min, 25/day |
| Claude API | `https://api.anthropic.com/v1/messages` | Header | claude.ai only |

## Styling Conventions

- **Color palette**: Dark theme based on Tailwind Slate colors
  - Background: `#1e293b` / `#0f172a`
  - Primary accent: `#2563eb` (blue), `#7c3aed` (purple)
  - Positive values: `#4ade80` (green)
  - Negative values: `#f87171` (red)
  - Muted text: `#94a3b8`
- **Layout**: CSS Grid for portfolio table (`grid-template-columns: 100px 200px 70px 100px 100px 100px 100px 120px`)
- **Responsive**: `@media (max-width: 768px)` breakpoint converts to single-column
- **Font**: System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`)

## Development Workflow

### Running the App

Open `index.html` directly in a browser. No build step or server required.

For price fetching, at least one API key is needed (configure via the API Keys button).

### Debugging

The application has extensive `console.log` output:
- `=== SECTION MARKERS ===` for major operations
- Per-symbol fetch results with source attribution
- Import parsing details per-line
- Render cycle stats

Open browser DevTools (F12) to see all debug output.

### Making Changes

Since everything is in one file:
1. All CSS is in the `<style>` block (lines 7-170)
2. All HTML structure is in `<body>` (lines 170-307)
3. All JavaScript is in the `<script>` block (lines 308-1737)

There is no minification, transpilation, or bundling. Edit directly.

### Testing

There is no automated test suite. Test manually by:
1. Opening `index.html` in a browser
2. Importing sample portfolio data (tab-separated)
3. Configuring API keys and fetching prices
4. Verifying gain/loss calculations
5. Checking snapshot save/load from localStorage

## Key Design Decisions

1. **Single-file architecture** - Designed to run as a Claude artifact or standalone HTML file with zero dependencies
2. **3-tier API fallback** - Maximizes price fetch success rate (~98%) across free API tiers
3. **International stock support** - Smart ticker mappings for European exchanges (Paris, London, Frankfurt, Amsterdam, Milan, Swiss)
4. **Dual storage** - localStorage for standalone use, Claude cloud storage for cross-device sync
5. **No authentication** - Browser-local application; API keys stored only in user's localStorage
6. **CSS-only charts** - No charting library; history visualization uses pure CSS bars

## Common Pitfalls

- **API keys are never committed** - They exist only in the user's browser localStorage
- **Rate limiting** - Finnhub delay is 1000ms, Alpha Vantage is 12000ms between calls. Changing these risks hitting API limits.
- **FMP endpoint** - Uses `/stable/quote-short` (not `/api/v3/quote`). The endpoint was changed multiple times (see git history) due to CORS and authorization issues.
- **Import format** - Tab-separated only. Column indices are hardcoded (e.g., ticker is column index 1, shares at index 4, price at index 7 for full format).
- **`renderPortfolio()` is called multiple times** after import with setTimeout delays to force UI refresh - removing these may cause stale renders.
- **`window.storage`** is a Claude-specific API, not standard Web Storage. It uses `.get()`, `.set()`, and `.list()` methods with different signatures than localStorage.

## Git History Summary

The project evolved through these phases:
1. Initial single-API upload
2. Multi-API support with Yahoo Finance (removed due to CORS)
3. 3-tier fallback strategy (Finnhub + FMP + Alpha Vantage)
4. International stock ticker resolution
5. Platform/source tracking and detailed logging
6. FMP endpoint stabilization (multiple iterations)

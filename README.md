# AI Investment Tracker

A modular browser-based portfolio management application that fetches live market prices, tracks performance over time, and generates AI-powered insights via the Claude API.

## Features

- **Portfolio Import** — Paste data from any spreadsheet or broker export (tab, comma, semicolon, pipe separated). Choose to **add to** or **replace** your existing portfolio
- **ISIN Resolution** — Automatic ISIN-to-ticker resolution via a 4-tier strategy (local DB → Finnhub → FMP → Claude AI). When an ISIN maps to multiple exchange listings, a picker dialog lets you choose the correct one
- **Asset Type Normalization** — Imported asset types (Common Stock, ETP, ADR, Mutual Fund, UCITS, etc.) are automatically normalized to canonical types: Stock, ETF, Crypto, REIT, Bond, Commodity, Cash, Other
- **Live Market Prices** — 3-tier API fallback (Finnhub → FMP → Alpha Vantage) for ~98% fetch success
- **International Stocks** — Smart ticker resolution for European exchanges (Paris, London, Frankfurt, Amsterdam, Milan, Swiss)
- **Portfolio History** — Save snapshots over time with visual bar chart tracking
- **AI Analysis** — Personalized portfolio insights powered by Claude with 6 investment perspectives (Value, GARP, Quant, Macro, Passive, Technical)
- **Trade Ideas** — Concrete daily trade suggestions with execution plans via Claude API
- **Allocation Charts** — Interactive type and sector allocation breakdowns with sector slicer
- **Cloud Sync** — Cross-device portfolio sync via Supabase (with authentication) or Claude cloud storage
- **No framework, no build step** — Vanilla HTML + CSS + JavaScript using ES modules

## Getting Started

### 1. Start a local server

The app uses ES modules, which require an HTTP server (opening `index.html` directly via `file://` won't work).

```bash
python -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser.

Alternatively, deploy to GitHub Pages or any static hosting.

### 2. Get API keys (free)

You need at least one API key to fetch live prices. All are free tier:

| Provider | Sign Up | Rate Limit |
|----------|---------|------------|
| [Finnhub](https://finnhub.io/register) (recommended) | finnhub.io/register | 60 calls/min |
| [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs/) | financialmodelingprep.com | 250 calls/day |
| [Alpha Vantage](https://www.alphavantage.co/support/#api-key) | alphavantage.co | 5 calls/min, 25/day |

Click the **API Keys** button in the app and enter your key(s).

For AI analysis features, you'll also need a [Claude API key](https://console.anthropic.com/).

### 3. Import your portfolio

Click **Import Portfolio** and paste data from your spreadsheet or broker export. The app auto-detects column layout and separator (tab, comma, semicolon, pipe).

**Full format** (8+ columns):

```
Asset    Ticker    Platform    Type    Units    Total Investment    Active Investment    Avg Unit Price
Apple    AAPL      Broker      Stock   10       1500                1600                 150
```

**Simple format** (3 columns):

```
AAPL    10    150
MSFT    5     350
```

**ISIN format** (resolved automatically):

```
IE00BYXVGX24    100
US0378331005    50
```

When importing, you can choose:
- **Add to existing portfolio** — merges new positions in, updating duplicates
- **Replace entire portfolio** — overwrites all existing positions

If an ISIN maps to multiple exchange listings (e.g., the same ETF on London, Frankfurt, and Amsterdam), a picker dialog will appear so you can select the exact listing you want to track.

### 4. Fetch prices

Click **Update Prices** to fetch current market data. The app uses your fastest available API first and falls back automatically if a source fails.

## Usage

| Button | Action |
|--------|--------|
| **API Keys** | Configure market data and AI API keys |
| **Import Portfolio** | Load positions from spreadsheet/broker export (add or replace) |
| **Update Prices** | Fetch current market prices for all positions |
| **Save Snapshot** | Save current portfolio state to history |
| **Get AI Analysis** | Generate perspective-based portfolio insights |
| **Get Trade Ideas** | Get concrete daily trade suggestions |

### Investment Perspectives

The AI analysis adapts to your selected investment philosophy:

- **Value** — Warren Buffett / Benjamin Graham style fundamental analysis
- **GARP** — Growth at a Reasonable Price (Peter Lynch approach)
- **Quant** — Data-driven quantitative analysis
- **Macro** — Top-down macroeconomic perspective
- **Passive** — Index-focused, cost-conscious strategy
- **Technical** — Chart patterns and technical indicators

## Architecture

```
ai_investment_tracker/
├── index.html              # Entry point: HTML structure + module init
├── css/
│   └── styles.css          # All styles + button style guide
├── data/
│   ├── sectors.js          # Sector mapping + getSector() helpers
│   └── perspectives.js     # 6 investment perspectives with AI prompts
├── services/
│   ├── state.js            # Shared application state
│   ├── utils.js            # Formatting, escaping, exchange detection, asset type normalization
│   ├── pricing.js          # 3-tier price fetching with rate limiting
│   ├── storage.js          # Supabase DB + localStorage + Claude cloud
│   ├── auth.js             # Supabase authentication
│   ├── portfolio.js        # Render, import, snapshots, history
│   ├── analysis.js         # AI analysis & trade ideas via Claude API
│   └── ui.js               # Allocation charts, perspective tabs, dialogs
├── src/
│   └── portfolio.js        # Pure functions mirror (for testing)
├── tests/                  # Vitest test suite
├── supabase/
│   └── functions/
│       └── analyze-portfolio/
│           └── index.ts    # Edge function for server-side analysis
├── supabase_schema.sql     # Database schema
├── vitest.config.js
└── package.json
```

## Data Persistence

The app supports three storage layers:

- **localStorage** — API keys, sector cache, portfolio history (works offline, single device)
- **Supabase** — Positions, snapshots, assets, price history (cloud sync, multi-device, requires account)
- **Claude cloud storage** — Portfolio state + snapshots (when running inside claude.ai)

## Cloud Sync (Optional)

For cross-device sync, you can connect a [Supabase](https://supabase.com/) project:

1. Create a free Supabase project
2. Run the schema from `supabase_schema.sql` in the SQL editor
3. Enter your Supabase URL and anon key in the API Keys dialog
4. Sign up / log in to sync your data

## Development

### Running locally

```bash
python -m http.server 8000
# Open http://localhost:8000
```

### Making changes

Each concern lives in its own file:

1. **Styles** → `css/styles.css`
2. **HTML structure** → `index.html` (just layout + init)
3. **Data** → `data/sectors.js`, `data/perspectives.js`
4. **Logic** → `services/*.js` (one file per concern)

### Running tests

```bash
npm install
npx vitest run
```

Tests import from `src/portfolio.js` (pure function mirror of `services/portfolio.js`).

## Requirements

- A modern web browser (Chrome, Firefox, Safari, Edge)
- Python 3 (for local server) or any static file server
- At least one free API key for live prices
- Claude API key for AI analysis features (optional)

## Changelog

### v3.6.1
- **ISIN multi-ticker picker** — When an ISIN resolves to multiple exchange listings (e.g., same ETF on London, Frankfurt, Amsterdam), a styled modal dialog lets the user choose which listing to track, showing ticker, exchange name, and asset type for each option
- Finnhub and FMP resolution tiers now preserve all candidates instead of silently auto-picking one

### v3.6.0
- **Import mode: Add or Replace** — Import dialog now lets users choose between merging new positions into the existing portfolio (default) or replacing it entirely
- **Canonical asset type normalization** — All imported asset types are normalized to a standard set (Stock, ETF, Crypto, REIT, Bond, Commodity, Cash, Other) via a centralized mapping that handles dozens of aliases (Common Stock, ETP, ADR, Mutual Fund, UCITS, SICAV, etc.)
- Consolidated 6 scattered inline type maps into a single `normalizeAssetType()` utility

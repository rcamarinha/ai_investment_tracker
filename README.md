# Investment Hub

A modular browser-based investment tracking suite — **Stock Portfolio** and **Wine Cellar** — with AI-powered analysis via the Claude API and optional cloud sync via Supabase.

---

## Trackers

### 📈 Stock Portfolio Tracker (`portfolio.html`)

- **Portfolio Import** — Paste data from any spreadsheet or broker export (tab, comma, semicolon, pipe separated). Choose to **add to** or **replace** your existing portfolio
- **ISIN Resolution** — Automatic ISIN-to-ticker resolution via a 4-tier strategy (local DB → Finnhub → FMP → Claude AI)
- **Asset Type Normalization** — Imported asset types normalized to Stock, ETF, Crypto, REIT, Bond, Commodity, Cash, Other
- **Live Market Prices** — 3-tier API fallback (Finnhub → FMP → Alpha Vantage) for ~98% fetch success
- **International Stocks** — Smart ticker resolution for European exchanges (Paris, London, Frankfurt, Amsterdam, Milan, Swiss)
- **Portfolio History** — Save snapshots over time with visual bar chart tracking
- **AI Analysis** — Personalized portfolio insights via Claude with 6 investment perspectives
- **Trade Ideas** — Concrete daily trade suggestions with execution plans
- **Allocation Charts** — Interactive type and sector allocation breakdowns

### 🍷 Wine Cellar Tracker (`wine.html`)

- **Label Scanning** — Take a photo of any wine label; Claude Vision AI identifies the wine and pre-fills all details
  - Mobile: standard OS picker — choose "Take Photo" or "Photo Library" (iOS & Android)
  - Desktop: file picker OR live camera via `getUserMedia`
- **AI Valuations** — Claude estimates current market value per bottle, including a low–high range and a short explanation note; optimal drinking window also returned
- **Drink-Window Status** — Each bottle shows a live status badge: 🔵 Not Ready / 🟢 Ready Now / 🟡 At Peak / 🔴 Past Peak; cellar summary line counts bottles in each state
- **Cellar Management** — Add, edit, and delete bottles with full metadata (vintage, region, varietal, appellation, etc.)
  - Inline form validation — errors appear beside the relevant field, no blocking alerts
  - Undo delete — 5-second grace period with an Undo button before the record is removed from the database
- **Search, Sort & Filter** — Live search bar; sort by name, vintage, value, or gain %; collapsible advanced filter chips by country and varietal; sort preference saved across sessions
- **CSV Export** — Download the full cellar as a `.csv` file
- **Value Tracking** — Total estimated collection value always shown; Gain / Loss shown per bottle only when a purchase price is provided (purchase price is optional)
- **Allocation Charts** — Breakdown by region, varietal, or country
- **Cellar History** — Save value snapshots over time
- **AI Cellar Analysis** — Drink-window recommendations, portfolio highlights, diversification assessment, and buying suggestions; auto-scrolls to results after render
- **Keyboard shortcuts** — `n` = new bottle · `Ctrl+Shift+S` = save snapshot · `Escape` = close any dialog

---

## Getting Started

### 1. Start a local server

ES modules require an HTTP server (`file://` won't work):

```bash
python -m http.server 8000
# Then open http://localhost:8000
```

Or deploy to GitHub Pages / any static host.

### 2. API keys

#### Stock Portfolio

| Provider | Free Sign-Up | Rate Limit |
|----------|-------------|------------|
| [Finnhub](https://finnhub.io/register) (primary) | finnhub.io | 60 calls/min |
| [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs/) | financialmodelingprep.com | 250 calls/day |
| [Alpha Vantage](https://www.alphavantage.co/support/#api-key) | alphavantage.co | 5 calls/min, 25/day |
| [Claude API](https://console.anthropic.com/) | console.anthropic.com | Per-key |

#### Wine Cellar

| Provider | Used For |
|----------|----------|
| [Claude API](https://console.anthropic.com/) | Label scanning (vision), valuations, cellar analysis |

The wine tracker needs **only** the Anthropic API key for all AI features. Supabase is optional for cloud sync.

Enter keys via the **🔑 API Keys** button in each tracker.

### 3. Cloud Sync (optional — both trackers)

1. Create a free [Supabase](https://supabase.com/) project
2. Run `supabase_schema.sql` in the SQL Editor (stock tracker tables)
3. Run `wine_schema.sql` in the SQL Editor (wine cellar tables)
4. Enter your Supabase URL and anon key in the API Keys dialog of each tracker
5. Sign up / log in — data syncs automatically

Both trackers share the same Supabase project and user account.

---

## Architecture

```
ai_investment_tracker/
│
├── index.html              # Hub: landing page linking to both trackers
├── portfolio.html          # Stock Portfolio Tracker
├── wine.html               # Wine Cellar Tracker
│
├── css/
│   ├── styles.css          # Shared dark-theme styles + button guide
│   └── wine.css            # Wine-specific styles (burgundy palette)
│
├── data/
│   ├── sectors.js          # Sector mapping + getSector() helpers
│   └── perspectives.js     # 6 investment perspectives with AI prompts
│
├── services/               # Stock tracker modules
│   ├── state.js
│   ├── utils.js
│   ├── pricing.js
│   ├── storage.js
│   ├── auth.js
│   ├── portfolio.js
│   ├── analysis.js
│   └── ui.js
│
├── wine/                   # Wine tracker modules
│   ├── state.js            # Shared wine state
│   ├── label.js            # Camera capture + Claude Vision label recognition
│   ├── storage.js          # Supabase auth + CRUD (self-contained)
│   ├── cellar.js           # Rendering, add/edit/delete, snapshots, history
│   ├── valuation.js        # Per-bottle AI market value estimation
│   ├── analysis.js         # AI cellar analysis (drink windows, recommendations)
│   └── ui.js               # Allocation charts, API key dialog
│
├── src/
│   ├── portfolio.js        # Pure functions mirror of services/portfolio.js (for tests)
│   └── wine.js             # Pure functions mirror of wine/ modules (for tests)
│
├── tests/                  # Vitest test suite (266 tests across 9 files)
│   ├── wine.test.js        # Wine: totals, gains, grouping, validation, scan parsing
│   ├── calculations.test.js
│   ├── allocation.test.js
│   ├── import-parsing.test.js
│   ├── position-management.test.js
│   ├── price-fetching.test.js
│   ├── snapshots.test.js
│   ├── ticker-resolution.test.js
│   └── utils.test.js
│
├── supabase/
│   └── functions/
│       └── analyze-portfolio/
│           └── index.ts    # Edge function for server-side stock analysis
│
├── supabase_schema.sql     # Stock tracker DB schema
├── wine_schema.sql         # Wine cellar DB schema
├── vitest.config.js
└── package.json
```

---

## Wine Cellar — Detailed Usage

### Scanning a label

1. Open **Wine Cellar** (`wine.html`)
2. Click **📷 Take Photo / Upload Image** (on mobile, this opens the camera directly)
3. Photograph the front label clearly
4. Claude Vision AI identifies the wine and shows the result
5. Click **➕ Add to Cellar** — the form is pre-filled; confirm and save

On desktop you can also use **🎥 Live Camera** for a live-preview capture.

### Updating valuations

Click **💎 Update Valuations** to ask Claude to estimate current market value for all unvalued bottles. Individual bottles can also be valuated with the 💎 button on their card.

> **Note:** Valuations are approximate estimates based on Claude's training knowledge and are intended as a guide. For precision, cross-check with auction houses or Wine-Searcher.

### AI cellar analysis

Click **🤖 AI Analysis** for a full assessment of your cellar:
- Diversification across regions and vintages
- Which bottles to drink now vs. hold for appreciation
- Investment highlights and improvement recommendations

### Wine Cellar buttons

| Button | Action |
|--------|--------|
| **📷 Take Photo / Upload** | Scan a wine label with camera or file picker |
| **🎥 Live Camera** | Open webcam for live capture (desktop) |
| **➕ Add Bottle** | Add a bottle manually (or after a scan) |
| **💎 Update Valuations** | AI-estimate current market value for all bottles |
| **💾 Save Snapshot** | Save current cellar value to history |
| **🤖 AI Analysis** | Full cellar analysis from a master-sommelier perspective |
| **🔑 API Keys** | Configure Anthropic and Supabase keys |

---

## Stock Portfolio — Investment Perspectives

| Perspective | Inspiration |
|------------|-------------|
| Value | Warren Buffett / Benjamin Graham |
| GARP | Peter Lynch |
| Quant | Data-driven / systematic |
| Macro | Top-down macroeconomic |
| Passive | Index-focused, cost-conscious |
| Technical | Chart patterns / indicators |

---

## Data Persistence

| Layer | Stock Tracker | Wine Cellar |
|-------|--------------|-------------|
| **localStorage** | API keys, sector cache, history | API keys |
| **Supabase** | positions, snapshots, assets, price history | wine_bottles, wine_snapshots |
| **Claude cloud** | Portfolio state (inside claude.ai) | — |

---

## Security

- **API keys** are stored only in `localStorage` in your browser. They are never sent to any server other than the relevant API provider directly.
- **Supabase anon key** is designed for public use — Row Level Security (RLS) is enabled on all tables so each user can only read and write their own data.
- **HTML output** — all user-supplied and AI-returned content rendered via `innerHTML` is passed through `escapeHTML`, which escapes `&`, `<`, `>`, `"`, and `'`.
- **Direct browser API calls** — the Anthropic SDK header `anthropic-dangerous-direct-browser-access: true` is the intended mechanism for client-side API calls. Never commit your API key to source control.

---

## Development

### Running locally

```bash
python -m http.server 8000
# Open http://localhost:8000
```

### Running tests

```bash
npm install
npx vitest run
```

Tests import from `src/portfolio.js` and `src/wine.js` (pure function mirrors without DOM or state dependencies).

| Test file | What it covers |
|-----------|---------------|
| `wine.test.js` | Cellar totals, bottle gain/loss, allocation grouping, validation, label scan parsing, snapshot building |
| `calculations.test.js` | Portfolio gain/loss, totals |
| `allocation.test.js` | Portfolio weight calculations, type aggregation |
| `import-parsing.test.js` | Flexible CSV/TSV import, ISIN detection, column mapping |
| `position-management.test.js` | Add/buy/sell/remove positions, transactions, realized P&L |
| `price-fetching.test.js` | 3-tier API fallback, rate limiting |
| `snapshots.test.js` | Snapshot build and merge |
| `ticker-resolution.test.js` | International ticker resolution, exchange suffixes |
| `utils.test.js` | Currency/percent formatting, HTML escaping |

### Making changes

| Concern | File(s) |
|---------|---------|
| Shared styles | `css/styles.css` |
| Wine styles | `css/wine.css` |
| Hub page | `index.html` |
| Stock tracker | `portfolio.html`, `services/*.js` |
| Wine tracker | `wine.html`, `wine/*.js` |
| Sector data | `data/sectors.js` |
| Investment perspectives | `data/perspectives.js` |
| DB schema — stocks | `supabase_schema.sql` |
| DB schema — wine | `wine_schema.sql` |

---

## Requirements

- A modern web browser (Chrome, Firefox, Safari, Edge)
- Python 3 or any static file server for local development
- **Anthropic API key** — required for all AI features in both trackers
- **Finnhub / FMP / Alpha Vantage** — at least one key for live stock prices
- **Supabase project** — optional, for cloud sync across devices

---

## Changelog

### v3.8.1
- **Wine Cellar — optional acquisition price** — Purchase price is no longer required when adding a bottle. Bottle cards show estimated value only when no cost basis is provided; Gain / Loss row is hidden. Focus is on total collection value rather than P&L.

### v3.8.0
- **Wine Cellar Tracker** — new tracker at `wine.html` with AI label recognition (Claude Vision), per-bottle valuations, cellar analysis, allocation charts, and Supabase sync
- **Hub page** — new `index.html` landing page linking to both trackers
- **`portfolio.html`** — existing stock tracker moved here; `index.html` is now the hub
- **`wine_schema.sql`** — Supabase tables `wine_bottles` and `wine_snapshots` with full RLS
- **`src/wine.js`** — pure function mirror of wine modules for testability
- **`tests/wine.test.js`** — 48 new tests: cellar totals, bottle gain/loss, allocation grouping, validation, scan-result parsing, snapshot building
- **Security hardening** — `escapeHTML` in all wine modules updated to also escape `'` → `&#x27;`

### v3.6.1
- **ISIN multi-ticker picker** — When an ISIN resolves to multiple exchange listings (e.g. same ETF on London, Frankfurt, Amsterdam), a styled modal lets the user choose which listing to track

### v3.6.0
- **Import mode: Add or Replace** — Import dialog now lets users choose between merging new positions or replacing the portfolio entirely
- **Canonical asset type normalization** — All imported asset types normalized to a standard set via a centralized mapping

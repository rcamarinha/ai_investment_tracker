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

- **Label Scanning** — Take a photo of any wine label; Gemini Vision AI (primary) or Claude Vision (fallback) identifies the wine and pre-fills all details
  - Mobile: standard OS picker — choose "Take Photo" or "Photo Library" (iOS & Android)
  - Desktop: file picker OR live camera via `getUserMedia`
- **AI Valuations** — Gemini with Google Search grounding (primary, falls back to Claude on quota errors) searches Wine-Searcher, recent auction results (Sotheby's, Christie's, Acker, Zachys, Hart Davis Hart), and retailer listings to estimate current market value per bottle. Returns: EUR + USD estimate, low–high range, confidence level (High / Medium / Low), cited sources, and an explanation note. Vintage-specific pricing — never averaged across years. Critic scores from label notes (e.g. "96/100") are passed to the prompt as anchors. A staleness warning appears when a valuation is over 60 days old. A navigation guard warns before leaving the page while valuations are running
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
| [Claude API](https://console.anthropic.com/) | Label scanning (Vision fallback), valuations (Gemini fallback), cellar analysis |

The wine tracker needs **only** the Anthropic API key. Gemini is called server-side via the Supabase Edge Function; no separate Gemini key is required. Supabase is optional for cloud sync.

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
│   ├── styles.css          # Design tokens (:root), shared dark-theme styles, button guide
│   └── wine.css            # Wine-specific styles (maps --wine* tokens)
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
│   ├── api.js              # Edge function client (routes label/valuation/analysis calls)
│   ├── label.js            # Camera capture + Gemini/Claude Vision label recognition
│   ├── storage.js          # Supabase auth + CRUD (self-contained)
│   ├── cellar.js           # Rendering, add/edit/delete, snapshots, history
│   ├── valuation.js        # Per-bottle AI market value estimation (Gemini → Claude)
│   ├── analysis.js         # AI cellar analysis (drink windows, recommendations)
│   ├── ui.js               # Allocation charts, API key dialog
│   └── utils.js            # escapeHTML, showToast, showConfirm helpers
│
├── src/
│   ├── portfolio.js        # Pure functions mirror of services/portfolio.js (for tests)
│   └── wine.js             # Pure functions mirror of wine/ modules (for tests)
│
├── tests/                  # Vitest test suite (266 tests across 9 files) + UX test suite
│   ├── ux-scenarios.html   # Interactive UX test suite (8 scenarios, runs on GitHub Pages)
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

Each valuation card shows:
- **EUR price** with low–high range, plus a **USD equivalent**
- A **confidence badge** (🟢 High / 🟡 Medium / 🔴 Low) based on whether Claude found direct listings, comparable data, or had to estimate
- **Sources** — a brief citation of the specific retailer or auction result used
- A **staleness warning** if the valuation is over 60 days old

> **Note:** Valuations use Anthropic's live web search feature when available; results are grounded in real listings but should still be cross-checked with auction houses or Wine-Searcher for precision.

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
| `ux-scenarios.html` | Interactive UX test suite — 8 scenarios (navigation, mobile, headers, contrast). Runs at `cacoventures.com/tests/ux-scenarios.html`. Session-only state; export results as `.txt` |
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

### v3.13.0
- **Full design-token audit** — systematic pass across all JS service files (`services/portfolio.js`, `services/navbar.js`, `services/analysis.js`) and `wine.html` replacing every hardcoded hex color (`#60a5fa`, `#4ade80`, `#f87171`, `#94a3b8`, `#64748b`, `#334155`, etc.) with the correct CSS custom property token (`var(--gold)`, `var(--up)`, `var(--down)`, `var(--text-secondary)`, `var(--surface-2)`, etc.)
- **Style guide comprehensive update** — `style-guide.html` rewritten to accurately document the current premium design system: correct wine token palette, current header pattern (dark ink + coloured left border, no gradient), perspective tab gold active state, and trade-idea legend using semantic tokens
- **Design System v2 section added** (§17 in style guide) — live demos of all new mobile-first components: `.hero-metric-section`, `.hub-card-premium` (stock + wine), `.pos-card-mobile`, `.chip-scroll-row` / `.chip-filter`, `.ai-insight-card`, `.seg-tab-row`, `.bottom-tab-nav`, `.btn-stock` / `.btn-wine-primary` / `.btn-ghost-*`, `.dw-badge` variants
- **`styles.css` blue references fixed** — seven `#60a5fa` (Tailwind blue) occurrences in `.position-value`, `.market-news-card`, `.search-result-symbol`, `.position-calc-display`, `.nav-brand.active`, `.lang-toggle`, `.slicer-clear` all replaced with gold / text tokens

### v3.12.0
- **Premium design system v2** — full redesign of all three pages (hub, portfolio, cellar) targeting HNWI audience; no more blue/purple gradient headers
- **Hub page** (`index.html`) — new hero total-wealth metric, gold sparkline SVG chart, dark premium hub cards with ambient glow; side-by-side layout on desktop, stacked on mobile
- **Headers** — replaced gradient backgrounds with `var(--ink-3)` dark card + 3px coloured left border: gold for stocks, wine-rose for cellar
- **Cormorant Garamond** promoted to all page titles and hub card names; DM Mono enforced on all monetary amounts
- **Mobile bottom tab nav** — fixed `Hub / Stocks / Cellar` bar appears at ≤640px; safe-area-inset padding for iPhone notch; active tab tinted gold (stocks) or wine-rose (cellar)
- **New CSS component classes** — `hub-card-premium`, `pos-card-mobile`, `pos-icon-badge`, `chip-scroll-row`, `chip-filter`, `ai-insight-card`, `seg-tab-row`, `bottom-tab-nav`, `btn-stock`, `btn-ghost-stock/wine`, `dw-badge` variants
- **Drink-window badges** — `.dw-ready`, `.dw-peak`, `.dw-hold`, `.dw-past` pill badges unified in `styles.css` design system
- **UX test suite** (`tests/ux-scenarios.html`) — 8 interactive scenarios across first-impression, navigation, stock portfolio, wine cellar, and visual design audit sections; automated WCAG contrast checker and CSS token validator; session-only state (no localStorage); export report as `.txt`

### v3.11.0
- **Design system tokens** — `css/styles.css` now defines a full `:root` token set: background layers (`--ink`, `--ink-2`, `--ink-3`, `--surface`, `--surface-2`), borders (`--border`, `--border-hover`), text (`--text-primary/secondary/tertiary`), semantic colours (`--up`, `--down`, `--gold`, `--wine*`), radii (`--r-sm/md/lg/xl`)
- **New font stack** — Cormorant Garamond (display), Instrument Sans (body), DM Mono (mono) loaded via Google Fonts in all three HTML entry points
- **Monetary values use DM Mono** — `font-family: var(--font-mono)` applied to all price/value/percentage elements: `.total-value`, `.position-value`, `.mover-pct`, `.allocation-bar-value`, `.bottle-gain`, `.cellar-stat .stat-value`, sales table cells
- **All hardcoded colours replaced** — `styles.css` and `wine.css` now use CSS variables throughout; wine palette maps to `--wine`, `--wine-light`, `--wine-dim`
- **Style guide updated** — `style-guide.html` reflects new token palette, font stacks, and uses CSS vars in its own inline styles

### v3.10.0
- **Gemini Vision for label scanning** — Gemini Vision is now the primary model for wine label recognition; Claude Vision acts as automatic fallback if Gemini is unavailable
- **Gemini grounding for valuations** — Single-bottle and batch valuations now use Gemini with Google Search grounding as the primary engine (real-time web data); Claude is the per-chunk fallback on Gemini quota errors (429s retried up to 3× before switching)
- **Scalable batch valuation** — Client sends sequential batches of 5 bottles; the edge function runs each batch as parallel Gemini grounding calls (CHUNK_SIZE=5), preventing timeout on large cellars (tested to 800+ bottles)
- **Navigation guard** — Browser beforeunload warning and same-site link interception prevent accidental page navigation while valuations are running
- **`wine/utils.js`** — Shared utility helpers (`escapeHTML`, `showToast`, `showConfirm`) extracted into their own module
- **Additional test coverage** — New tests for exchange detection, asset type normalization, sector lookup, and investment perspectives

### v3.9.0
- **Wine Cellar — live web-search valuations** — Valuation API calls now use Anthropic's `web_search_20250305` tool so Claude fetches real Wine-Searcher listings and recent auction data (Sotheby's, Acker, Zachys, Hart Davis Hart) instead of relying solely on training knowledge
- **Dual currency** — each valuation now returns both a EUR estimate and a USD equivalent
- **Confidence level** — `"high"` / `"medium"` / `"low"` badge on every bottle card, coloured green / amber / red
- **Source citation** — brief reference to the specific retailer or auction result used (shown on bottle card)
- **Staleness warning** — amber banner on any valuation older than 60 days, prompting a refresh
- **Critic score pass-through** — critic scores detected in label notes (e.g. "96/100", "94 points") are forwarded to the valuation prompt as quality anchors
- **Vintage-specific guard** — prompt now explicitly instructs Claude to price the exact vintage, never an averaged producer price
- **Robust JSON extraction** — response parser now finds the last text block (handling web-search `tool_use`/`tool_result` interleaving) and extracts the JSON object via regex rather than whole-string parse

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

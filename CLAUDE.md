# CLAUDE.md - AI Investment Tracker

## Project Overview

A **browser-based suite for one household's money**, in four tools sharing one auth, one design
system and one hub: **Stock Portfolio** (import, live prices via a 3-tier API fallback, XIRR, AI
analysis), **Wine Cellar** (inventory and AI valuation), **Spend** (bank-statement import,
categorisation, savings rate) and **Bank Holdings** (bonds and funds no market API can price).

Read the **Common Pitfalls** at the end before changing ingestion, money handling or failure
reporting. Most entries there were written after a bug reached real data, and they say what the
code cannot: why the obvious approach was tried and abandoned.

**No backend, no build system, no framework.** Vanilla HTML + CSS + JavaScript using ES modules. Requires an HTTP server (not `file://`) — `python -m http.server 8000` locally; Vercel in production.

## Architecture

```
ai_investment_tracker/
├── index.html                  # Hub: cross-asset net worth dashboard + auth
├── portfolio.html              # Stock portfolio
├── wine.html                   # Wine cellar
├── spend.html                  # Spending and bank statements
├── holdings.html               # Bank-held bonds and funds
├── css/styles.css              # All styles + button style guide
├── lib/                        # Vendored: CSP is script-src 'self', nothing loads from a CDN
│   ├── supabase.js
│   └── pdf.min.mjs, pdf.worker.min.mjs
├── data/                       # Pure data, no imports
│   ├── sectors.js              # SECTOR_MAPPING + getSector()
│   ├── perspectives.js         # INVESTMENT_PERSPECTIVES
│   ├── i18n.js                 # Translations
│   └── category-icons.js       # Searchable spend-category icons (EN + PT keywords)
├── services/                   # Shared logic. NEVER imported with ?v= (see Pitfalls)
│   ├── state.js, utils.js, ui.js, navbar.js, auth.js, storage.js
│   ├── pricing.js, pricing-core.js, portfolio.js, analysis.js
│   ├── money-core.js           # Currency: ISO codes, minor units (GBp != GBP), conversion
│   ├── returns-core.js         # XIRR, cash flows, yearly income
│   ├── telemetry.js            # Error + diagnostic reporting, allow-listed context
│   ├── spend-core.js           # Savings rate, period rollups, YoY, recurring, projection
│   ├── holdings-core.js        # Bank-holding valuation and freshness
│   ├── categorize-core.js      # Precedent from the ledger, AI batching, result guards
│   ├── import-contract.js      # The one row shape every ingestion source must emit
│   ├── import-banks.js         # CSV/TSV profiles, dedupe, rules, card routing, expansion
│   ├── import-standards.js     # OFX/QFX (both SGML and XML dialects)
│   ├── import-pdf.js           # Line reconstruction, balance chain, whole-statement total
│   └── import-brokers.js       # Broker exports -> trade ledger (pure; no src/ mirror)
├── src/                        # Pure mirrors for testing: hub.js, portfolio.js, wine.js, wine-ai-utils.js
├── wine/                       # state, storage, cellar, valuation, label, analysis, api, ui, utils
├── spend/                      # state, storage, ledger, importer, pdf, categorize, accounts, utils
├── holdings/                   # state, storage, ui, utils
├── tests/                      # Vitest
├── supabase/
│   ├── migrations/             # Hand-run SQL (see Pitfalls: run by the user, not by a deploy)
│   ├── maintenance/            # Operational scripts — NEVER run as a migration
│   └── functions/              # Edge functions (analyze-portfolio, extract-trades, extract-statement,
│                               #   resolve-tickers, quote-proxy, wine-ai, categorize-transactions)
├── vercel.json                 # Headers and cache rules: services/data/src revalidate,
│                               #   wine/spend/holdings/css/lib are immutable and versioned by ?v=
└── package.json, vitest.config.js
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

The graph above covers the **portfolio page only**. `wine/`, `spend/` and `holdings/` are
self-contained modules with their own `state.js` and `storage.js`; they import from `services/`
only for genuinely shared logic (`money-core`, `telemetry`, the `import-*` family, `navbar`) and
never from each other.

Note: Several services have circular imports (e.g., pricing ↔ portfolio, storage ↔ portfolio). This works with ES modules because functions are called at runtime, not at module evaluation time.

### Hub Dashboard (index.html)

After login, `loadHubValues(userId)` runs two parallel Supabase queries and populates the existing hub card DOM elements:

- `#hubTotalValue` — stock market value + wine cellar value, **in EUR**; suffixed `*` when partial
- `#hubStockValue` — `total_market_value_eur` from the **latest snapshot** carrying one
- `#hubStockDelta` — `"as of 3 Aug"` (+ `"excludes N"`), or `"open Portfolio to calculate"` when no snapshot has a EUR total
- `#hubWineValue` — SUM(estimated_value × qty) from `user_wines` (EUR by schema)
- `#hubWineDelta` — % gain vs purchase price, or staleness label ("valued Xd ago")

`clearHubValues()` resets all to `"— —"` on logout.

**Never sum `shares × avg_price` from `positions` here.** That table has no currency
column, so the sum adds pounds to euros and to dollars; the old `computeStockValue()`
did exactly that and stamped the result `€`. The hub instead *reads* the EUR figure the
portfolio page already computed with per-trade FX, so there is only one implementation of
currency conversion in the app. Snapshots without `total_market_value_eur` (legacy rows,
written before the base currency was recorded) are **skipped, not assumed to be EUR**.

index.html imports only `services/navbar.js` and `src/hub.js` — the latter is pure and
dependency-free (zero imports), so it does not drag in the service graph. All other
service modules remain forbidden here: `services/storage.js` pulls in pricing, portfolio
and the rest.

### Filter-scoped summary stats

**Wine Cellar (`wine/cellar.js`):** `computeTotals(bottles = state.cellar)` accepts an optional array. `renderCellar()` runs filters first, then calls `computeTotals(result)` so the stats bar reflects the visible subset. `updateBottleCard()` re-derives the filtered list the same way. Snapshots call `computeTotals()` with no args (full cellar).

**Stock Portfolio (`services/portfolio.js`):** `filteredActivePositions` is derived from `activePositions` filtered by `state.selectedSector` (or equal to `activePositions` when no filter). The totals loop iterates `filteredActivePositions`. The header shows "X of Y positions" when a sector filter is active. The snapshot function has its own local `activePositions` loop and is unaffected.

**Rule for both:** snapshots must always use full totals. Never pass a filtered array to a snapshot save path.

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
- **`importPositions()`** - Parses tab-separated data (full 8+ column or simple 3 column) → **positions snapshot**
- **`importTrades()`** - Imports a broker export into the **transaction ledger** (see below)
- **`handleTradeFile(input)`** - Reads an uploaded CSV/PDF into the import textarea (PDF text via pdf.js CDN)
- **`rebuildPositionsFromLedger()`** - Recomputes `state.portfolio` (net shares + weighted-avg cost) from `state.transactions`
- **`savePortfolioSnapshot()`** - Saves to localStorage + Supabase + Claude cloud
- **`updateHistoryDisplay()`** / **`clearHistory()`** - History management

### Broker Trade Import (`services/import-brokers.js` + `importTrades()`)

The import dialog (`#importDialog`) has a top-level toggle: **Trades / Moves (ledger)** (default) vs
**Positions (snapshot)**. The trades path solves the manual re-entry problem for DeGiro / Revolut /
BancoBest by feeding broker exports into the **existing** transaction ledger.

`services/import-brokers.js` is **pure** (no DOM, no network, no service imports) so tests import it
directly — there is **no `src/` mirror** for it. Key exports:
- **`parseBrokerExport(text)`** → `detectBroker()` then dispatches to `parseDegiroCsv()` / `parseDegiroAccountCsv()` / `parseRevolutCsv()`
- **`parseDegiroCsv(text)`** - DeGiro Transactions.csv; **sign of Quantity = buy/sell**; ISIN identifier; currency is the unnamed column right after Price. Zero-price corporate-action rows and detected split pairs go to a `review[]` array (not silently dropped)
- **`parseDegiroAccountCsv(text)`** - DeGiro **Account** statement (detected via ISIN + `Saldo`, no Quantidade). Imports **dividends + withholding tax only** (`Dividendo` / `Imposto sobre dividendo`), grouped per (ISIN, value-date) and summed with sign so reversals net out. Trades & per-trade commissions are skipped — they already come from the Transactions export, so importing them here would double-count
- **`parseRevolutCsv(text)`** - Revolut statement; `BUY*`/`SELL*` → trades; `DIVIDEND`/`FEE`/`CUSTODY` → an `income[]` array (with withholding `tax`); top-ups/transfers skipped
- **`detectSplitPairs(trades)`** - flags same-instrument, same-date buy/sell pairs with ≥3× price gap as `possible_split` (with inferred ratio)
- **`normalizeTrades(rows, broker)`** - normalizes loose rows from the AI fallback
- **`tradeFingerprint()` / `buildExistingFingerprints()` / `dedupeTrades()`** - multiset dedupe; trades keyed `date|symbol|side|shares|price`, non-trade rows (dividend/fee/split) keyed `date|symbol|type|amount` (symbol = **resolved ticker**, so re-imports are safe)
- **`computePositionsFromLedger(transactions)`** - average-cost engine over the **full taxonomy** (`buy/sell/split/isin_change/dividend/fee`): fees fold into cost basis; splits multiply shares (cost unchanged); dividends/fees aggregate as `dividends/taxWithheld/feesPaid`; returns `needsReview` when a sell drives shares negative

#### Transaction taxonomy

`type` is free text in the DB. Supported: `buy`, `sell`, `dividend`, `fee`, `split`, `isin_change`.
Extra columns (migration `20260626_transactions_income_fields.sql`): `fee`, `tax`, `ratio`, `note`.
Non-trade rows carry `shares=0, price=0`; their monetary value lives in `total_amount`. `CASH` is a
reserved symbol for account-level custody fees (never materialized as a position card).

`importTrades()` pipeline: parse (CSV or AI) → resolve ISINs (trades + review + income) → dedupe
against `state.transactions` → **`showReviewDialog()`** to classify splits/corporate actions → commit
full taxonomy to ledger → `rebuildPositionsFromLedger()` (also computes per-asset dividends/fees and
sets `state.ledgerNeedsReview`) → `saveTransactionsToDB()` + `savePortfolioDB()` → `fetchMarketPrices()`.
Unstructured input (Revolut PDF text, BancoBest confirmations) falls back to the `extract-trades` edge
function (client chunks to ≤12K chars).

**UI surfaces** (in `renderPortfolio()`): summary-bar Income/Fees (`computeIncomeTotalsBase()`),
per-card dividend badge + yield-on-cost, an **Income & Fees** table (`renderIncomeHistory()` →
`#incomeHistorySection`), a **Transactions** ledger with search + type filter + per-row delete
(`renderTransactionsLedger()` → `#transactionsSection`; `setTxFilter`/`setTxSearch`/`deleteTransactionRow`),
and a safety banner when `state.ledgerNeedsReview`.

**Not yet built**: DeGiro Account-statement **fees** (connectivity/FTT — currently only dividends are taken from Account.csv; transaction commissions come from Transactions.csv); ~~DeGiro `Account.csv` parser~~ (dividend handling is
broker-agnostic via the `income[]` stream, so it slots in); cash-balance modeling; first-class options.

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
- **Supabase** — Positions, snapshots, assets, transactions, price history, shared config (RLS per-user)
- **Claude cloud storage** — Portfolio state + snapshots (when running in claude.ai)

## External API Endpoints

| API | Endpoint | Rate Limit |
|-----|----------|------------|
| Finnhub | `finnhub.io/api/v1/quote` | 60/min |
| FMP | `financialmodelingprep.com/stable/quote-short` | 250/day |
| Alpha Vantage | `alphavantage.co/query?function=GLOBAL_QUOTE` | 5/min, 25/day |
| Gemini | `generativelanguage.googleapis.com/v1beta/models` | Per-key limits |
| Claude API | `api.anthropic.com/v1/messages` | Per-key limits |
| Supabase | Project-specific URL | Per-plan limits |

## Development Workflow

### Running the App

**Requires an HTTP server** (ES modules don't work via `file://`):
```bash
python -m http.server 8000
# Then open http://localhost:8000
```

Production is **Vercel** at cacoventures.com — verified from the response headers, not assumed.
`vercel.json` carries the security headers and the cache rules, and those rules are load-bearing:
`services/`, `data/` and `src/` revalidate on every request, while `css/`, `lib/`, `wine/`, `spend/`
and `holdings/` are served `immutable` and busted by `?v=`. A change to an immutable directory that
does not come with a version bump cannot reach a browser. The `CNAME` file is a leftover from
GitHub Pages; nothing deploys from there and there is no workflow.

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

Tests import the **pure** module directly wherever one exists — `services/*-core.js`,
`import-banks.js`, `import-pdf.js`, `import-contract.js`, `import-brokers.js`, `money-core.js`,
`telemetry.js` — because those have no DOM or network dependencies and therefore need no mirror.
The `src/` mirrors exist only for logic that still lives inside a DOM-coupled service
(`src/portfolio.js`, `src/hub.js`, `src/wine.js`). Do not add a mirror for a module that is
already pure: two copies is how the same sign bug came to exist twice.

Two tests enforce rules rather than behaviour, and both read their authority out of the
source rather than restating it:
- `tests/db-constraints.test.js` — no code path may emit a value a CHECK constraint would reject
- `tests/failure-handling.test.js` — the failure-handling standard (see Pitfalls)

### Debugging

Extensive `console.log` output with `=== SECTION MARKERS ===`. Open DevTools (F12).

## Common Pitfalls

- **ES modules require HTTP** — `file://` won't work; use a local server
- **Circular imports** — Services cross-reference each other; this works because functions are called at runtime, not at module load time
- **`window.*` globals** — onclick handlers require functions on `window`; these are set in the init block of `index.html`
- **API keys are never committed** — They live only in the user's browser localStorage
- **Rate limiting** — Finnhub 1000ms, FMP 500ms, Alpha Vantage 12000ms between calls
- **FMP endpoint** — Uses `/stable/quote-short` (not `/api/v3/quote`) due to CORS/auth issues
- **`window.storage`** — Claude-specific API, not standard Web Storage
- **`renderPortfolio()` called multiple times** after import with setTimeout delays for UI refresh
- **Edge function auth** — each function carries `verify_jwt = false` in its own `config.toml` and checks auth manually via `supabase.auth.getUser()`. **Verify this actually applied after deploying**: newer Supabase CLIs read function config from a root `supabase/config.toml` (`[functions.<name>]`), which this project does not have, so a per-function file can be ignored and the gateway enforces JWT anyway. Measured on the live project, only `wine-ai` runs with it off; `extract-trades` and `extract-statement` are gateway-checked and work regardless, because the gateway accepts a real user token and only rejects requests with no auth header. To force it: deploy with `--no-verify-jwt`. Symptom of getting this wrong is a bare `Failed to fetch` in the browser, because a gateway rejection carries no CORS headers
- **Edge function prompt limits** — Server enforces 15K char max prompts; classification, analysis, and `extract-trades` must batch/truncate on the client side (`importTrades()` chunks statement text to ≤12K)
- **Failure handling has one standard, and `tests/failure-handling.test.js` is the copy that cannot drift** — a failure the user must know about gets a toast AND `reportHandled`; one they need not know about gets `reportHandled` alone; `console.error` is never the handler and `alert()` is not one either. Separately, an operation whose correctness **cannot be checked at the time it runs** (statement import, broker import, batch valuation) must call `reportDiagnostic`, because every import bug found in this codebase was a silent wrong result that threw nothing — an error log stays empty through all of them. Context keys must appear in `ALLOWED_CONTEXT_KEYS`: `pickContext` drops unknown keys **silently**, so a typo'd `rowsParsed` sends a healthy-looking diagnostic carrying nothing. The test reads that list from telemetry.js rather than restating it.
- **Never interpolate a value into an `onclick=""` attribute** — an attribute is HTML-decoded by the parser *before* its contents are compiled as JavaScript, so `escapeHTML` does **not** protect that position: a value containing `'` breaks out and executes. Use `data-` attributes with a delegated listener (`bindActions` in `services/utils.js` and `wine/utils.js`, `bindDelegation` in `spend/ledger.js`), where values are only ever read back as strings. This rule was prose for a long time and was being broken in fourteen places; `tests/html-escaping.test.js` now enforces it across `services/ src/ data/ wine/ spend/ holdings/` by reading the source, so it cannot drift again.
- **`escapeHTML` must escape FIVE characters, and `services/` once escaped three** — the old implementation set `textContent` on a detached `<div>` and read back `innerHTML`. That is the HTML fragment serialisation of a *text node*: it escapes `&`, `<` and `>` and leaves **both quote characters untouched**. Safe in text position, unsafe in attribute position, and it was used in both. The value that reached it was `assets.sector`, which comes from a catalogue table **any authenticated account can write**, so a sector name containing `"` closed an `onclick` attribute and opened a new handler in another user's session. `wine/`, `spend/` and `holdings/` always escaped all five; `services/` was the only survivor. The four copies are now asserted equivalent by test.
- **The app is no longer one trusted household** — signup is invite-only rather than closed, so an account holder is an untrusted party. Anything reachable with a valid session is reachable by someone who is not you. Two consequences that are easy to forget when adding a feature: a shared table that any authenticated user can write is an input channel into everyone else's pages, and an edge function gated only on "is this a valid token" has no per-user ceiling. Before adding either, ask what a stranger with a free account does with it.
- **PDF statements go through the extraction service, not a parser** — a single-section statement parses deterministically (`services/import-pdf.js` reconstructs printed lines from pdf.js coordinates), but real statements interleave several sections with different layouts on the same printed row. Measured on a real one, a single line pattern reconciled 14% of rows. Do **not** try to fix this by splitting lines on x-gaps: within a row the description→amount gap is as large as the gap between two side-by-side sections, so it strips amounts off legitimate rows — it raised pattern coverage from 33% to 91% while leaving every balance check broken.
- **Currency and number formats are shared, not per-module** — `services/money-core.js` owns currency (`normalizeCurrencyCode` knows minor units, so `GBp` is pence and not `GBP`) and `services/import-banks.js` owns number and date parsing (`parseStyledNumber`, `detectDecimalStyle`, `detectDateFormat`). Spend originally had neither: it uppercased currency codes itself and defaulted to `'EUR'` in three places, and `import-pdf.js` kept a private `parseNum`. The duplicate parser is how the same sign bug — a trailing minus read as positive — came to exist twice and be found twice. Money handling added to a new area goes through these, never beside them.
- **Never let a deterministic pattern decide whether the AI extractor runs** — `findCandidateLines` required `dd/mm` at the START of a row, and `ingest` refused any PDF where it matched nothing. A bank using ISO dates, month names, or a date mid-row was rejected with "no dated transaction lines found" without the extractor ever seeing it, which inverts the reason that tier exists. The strict pass is now a preference, not a gate: `findLooseCandidates` widens to any line carrying both a date and an amount, and only a document with neither is refused. Widening is safe because balance continuity still checks whatever comes back — a looser filter cannot make a wrong import look right.
- **A statement can cover several PRODUCTS, and only one of them is cash** — a CGD "extrato global" carries the current account, a card and a mortgage in one PDF. The mortgage section prints `COBRANCA DE CAPITAL 1.003,16` and `COBRANCA DE JUROS 688,89`, which sum to the `COBRANCA PRESTACAO -1.692,05` already debited from the account; importing them added the same money again, unsigned, as income. Extraction has a third role, `skip`, for positions (amounts owed, limits, closing balances) alongside `detail` for itemisations. Related invariant: **a row the document did not date is never a movement** — those lines are printed undated because they share the instalment's date, and the model was inventing one, which no guardrail can catch because dates are not in the balance chain.
- **A statement section is not always a list of movements** — card sections, MB WAY and wallet breakdowns *itemise* a movement that is already on the statement (the card payment). Ingesting them as movements counts the same money twice, and because those sections print charges unsigned, the duplicates land as **income** — overstating income and understating spend from one line. The row contract has carried `sourceRole: 'statement' | 'detail'` since the MB WAY work; the PDF path just hardcoded `'statement'`. Extraction must classify by structure (printed under a card heading, or dated with no running balance while its neighbours have one), and detail rows go through `mergeDetailSource` to improve a description — never to create a row.
- **A card section is a second account inside one PDF** — a statement describes the current account AND the card. `planCardRouting` (services/import-banks.js) sends card rows to a linked `card` account, matched on the card number in the heading, and `markCardSettlements` marks the account-side repayment as a `transfer` — proven on amount, opposite sign and date, because both legs are printed in the same document. Two things are easy to get wrong: a payment inside a card section is **positive** (it reduces what is owed) while the account-side debit is negative, and routing must run **before** dedupe, since dedupe is per account and a card purchase checked against the current account's history matches nothing and is re-added every import.
- **Card detail is expanded, not merged, when it can be proven** — `expandCardDetail` (services/import-banks.js) replaces a lump settlement with the purchases that account for it, keyed on `detailGroup` so a two-card statement reconciles each against its own payment. The proof is `sum(detail) === settlement`; without it the lump row stays. It must run AFTER `verifyRows`, because the running balance moved by the settlement, not by its parts. The older `mergeDetailSource` remains the fallback for groups that cannot be proven — note its aggregate search is bounded to three rows, so it attaches nothing on a normal card month.
- **Per-row balance continuity cannot prove the row SET is right** — a row with no balance is not in the chain, so a section that should never have been imported passes every per-row check. `reconcileStatementTotal` (services/import-pdf.js) adds the whole-statement form: printed opening + sum(movements) === printed closing, which a wrong row breaks by exactly its own amount. The two balances are found by searching every figure printed outside the movement rows for the pair that makes the document add up — deliberately NOT by matching "saldo"/"balance", which would be another per-language list. Card rows are excluded from the sum: they belong to the card's ledger, and including them breaks a total that is correct.
- **Balance continuity is what makes AI-read statements safe** — `balance[n] - balance[n-1] === amount[n]` is a property of the document, not of the extraction, so a hallucinated or mis-signed amount breaks it. Rows that fail are flagged for review, never silently imported. It also selects the right deterministic line pattern: choosing by coverage alone picks the loosest pattern, which reads the balance column as the amount.
- **A guardrail that skips a row must say so** — `checkBalanceChain` `continue`d past any pair touching a null balance, and `verifyRows` treated `checked === 0` as a pass. Detail rows carry no balance, so interleaving them broke adjacency for the *statement* rows around them too: a handful of card lines could leave most of a document unverified while the import still reported "all balance checks reconcile". Report coverage (`checked` of `pairs`), and never let "nothing was checkable" render as "verified".
- **The ledger IS the training data** — categorisation learned only from `spend_rules`, written when a user corrects one row at a time, so `acceptAllConfident` (which passed `teachRule: false`) taught nothing and clearing rules erased everything learned. Meanwhile hundreds of categorised transactions sat unread. `applyPrecedents`/`findPrecedent` (services/categorize-core.js) run BEFORE the model and settle any merchant the user has filed before. Match on **shared significant words, minimum two** — a bank writes one merchant three ways ("COMPRA OPORTO CRICKET", "OPORTO CRICKET CLUB", "…CLUB 0003791851"), and keying on leading tokens makes those three merchants while one shared word makes "compra" match everything. A merchant filed under two categories equally often yields nothing: that is a question, not a precedent.
- **A rarely-used control needs MORE affordance, not less** — the category icon field was justified as "decoration on a form used twice a year, so leave it". That inverts the relationship: a frequent action survives a clunky UI because the user has learned its quirks, while a rare one has no accumulated familiarity and must explain itself every single time. It was also not decoration — an unvalidated field that silently persisted whatever was typed is a correctness bug wearing a cosmetic costume. Typing now only ever filters (`searchIcons` in data/category-icons.js), and clicking is the only thing that stores a value.
- **A view filter outlives the data change it will hide** — Spend's ledger filters (`txTypeFilter`, `selectedCategory`, `accountFilter`, `txSearch`, an explicitly chosen `period`) are state, not render options, so they survived an import. With the type filter left on `review` — the natural thing to do while dealing with an unconfirmed row — every clean row of the next import was hidden, and an import of eighty reconciled movements displayed nothing. `clearViewFilters(state)` runs where the data changes, not in each view. The same trap applies anywhere a filtered list gains rows the filter excludes.
- **`Number(null)` is `0` and passes `isFinite`** — this has bitten three separate times (`isActive`, the row contract's `balance`, `findOneOffs`). "Absent" and "zero" are different facts about money; check for null/undefined/'' explicitly before coercing.
- **Trades vs positions imports** — `importTrades()` writes the **transaction ledger** (every buy/sell) and then derives positions; `importPositions()` writes a **positions snapshot** only. Re-importing a broker export is safe because `dedupeTrades()` skips already-imported moves. `services/import-brokers.js` must stay **pure** (no DOM/network) — tests import it directly, so don't add a `src/` mirror for it
- **Batch valuation result matching** — Results from the AI must be matched to bottles by `result.id` (a `Map` keyed by bottle ID), never by positional index. The AI can return fewer items than requested; index-based matching silently applies the wrong valuation to the wrong bottle
- **Valuation pricing rules** — 6 rules enforced in both single and batch prompts: (1) Portuguese retailers first, (2) 23% IVA on ex-tax sources, (3) exact bottle format, (4) current in-stock only, (5) cross-reference ≥3 sources using median, (6) weight specialist merchants for rare/collectible wines
- **index.html must not import service modules** — `services/storage.js` pulls in the full service graph (pricing, portfolio, etc.). Hub dashboard queries are written inline in the `<script>` block to avoid this dependency chain
- **`services/`, `data/` and `src/` must NEVER be imported with a `?v=` query** — they are cache-busted by HTTP header (`max-age=0, must-revalidate` in `vercel.json`), not by URL. The browser keys the module registry on the full URL, so importing `./services/state.js?v=X` from an HTML entry point while the services import `./state.js` from each other creates **two separate module instances**: two `state` objects, and two copies of every module-level variable. That is not theoretical — it silently killed `setMissingTickerResolver()` (injected on one instance, read as `null` on the other, so the "resolve missing ticker" dialog never opened from re-enable/import) and made `state.baseCurrency` diverge from the toggle. `wine/`, `spend/` and `holdings/` are the exceptions: they version *every* URL consistently, so they stay `immutable` — see the next entry
- **Module `?v=` strings must all match** (applies to `wine/`, `spend/` and `holdings/`) — The browser module cache uses the full URL (including query string) as the cache key. If `wine.html` imports `state.js?v=X` and `cellar.js` imports `state.js?v=Y`, they become two separate module instances — mutations to one don't affect the other. Always keep all `?v=` strings in `wine.html` and within `wine/` in sync with the project version

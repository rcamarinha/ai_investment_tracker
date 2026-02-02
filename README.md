# AI Financial Advisor

A browser-based portfolio tracker that fetches live market prices, calculates gains/losses, and optionally provides AI-powered investment insights via Claude.

## Features

- **Portfolio Import** - Paste tab-separated data directly from a spreadsheet
- **Live Market Prices** - 3-tier API fallback (Finnhub, FMP, Alpha Vantage) for ~98% fetch success
- **International Stocks** - Smart ticker resolution for European exchanges (Paris, London, Frankfurt, Amsterdam, Milan, Swiss)
- **Portfolio History** - Save snapshots over time with visual bar chart tracking
- **AI Analysis** - Get personalized portfolio insights powered by Claude (requires claude.ai)
- **Cloud Sync** - Cross-device portfolio sync when running inside claude.ai

## Getting Started

### 1. Open the app

Open `index.html` in any modern browser. No install or build step required.

### 2. Get API keys (free)

You need at least one API key to fetch live prices. All are free tier:

| Provider | Sign Up | Rate Limit |
|----------|---------|------------|
| [Finnhub](https://finnhub.io/register) (recommended) | finnhub.io/register | 60 calls/min |
| [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs/) | financialmodelingprep.com | 250 calls/day |
| [Alpha Vantage](https://www.alphavantage.co/support/#api-key) | alphavantage.co | 5 calls/min, 25/day |

Click the **API Keys** button in the app and enter your key(s).

### 3. Import your portfolio

Click **Import Portfolio** and paste tab-separated data from your spreadsheet.

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

### 4. Fetch prices

Click **Update Prices** to fetch current market data. The app uses your fastest available API first and falls back automatically if a source fails.

## Usage

| Button | Action |
|--------|--------|
| API Keys | Configure your market data API keys |
| Import Portfolio | Load positions from spreadsheet data |
| Update Prices | Fetch current market prices for all positions |
| Save Snapshot | Save current portfolio state to history |
| Get AI Analysis | Generate AI insights (claude.ai only) |

## How It Works

The app runs entirely in the browser with no backend server. Portfolio data and API keys are stored in your browser's localStorage.

**Price fetching** follows a 3-tier strategy:
1. Finnhub (fastest, no daily limit)
2. Financial Modeling Prep (generous daily limit)
3. Alpha Vantage (last resort, strict limits)

If a ticker fails on all APIs, the app tries alternative exchange suffixes and smart name-to-ticker mappings for international stocks.

**AI Analysis** is only available when running inside [claude.ai](https://claude.ai) as an artifact, where it can call the Claude API and sync data across devices.

## Requirements

- A modern web browser (Chrome, Firefox, Safari, Edge)
- At least one free API key for live prices
- No server, database, or package manager needed

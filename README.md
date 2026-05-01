# 💰 My Portfolio

A self-hosted, real-time portfolio tracker with live stock quotes pushed via Server-Sent Events (SSE). Built with Node.js + vanilla JavaScript — no frameworks, no databases, just JSON files.

![Status](https://img.shields.io/badge/status-activereen

## ✨ Features

### Dashboard
- 📈 **Live prices** via [Finnhub](https://finnhub.io) — pushed via Server-Sent Events (SSE)
- 💵 **Cash + holdings tracking** with auto-computed P/L, returns, and net worth
- 📊 **Sortable holdings table** — click any column header
- 🔗 **Clickable tickers** — drill into per-ticker detail pages
- 📅 **90-day rolling history** — daily snapshots saved automatically
- 🟢 **Smart market-aware refresh** — adapts to NYSE hours, weekends, holidays
- ⚡ **Cached prices on load** — instant first paint, no waiting

### Ticker Detail Pages
- 🏢 **Company profile** — logo, exchange, industry, IPO date, market cap (cached weekly)
- 💼 **Position summary** — quantity, P/L, days held, % of portfolio
- 📊 **Live quote** — open / high / low / prev close + intraday range bar
- 📈 **Price history chart** — 7d / 30d / 90d, with buy-date marker + interactive tooltips
- 🎯 **Analyst recommendations** — Strong Buy / Buy / Hold / Sell breakdown + 4-month trend sparkline
- 📊 **Key metrics** — 52w H/L, 52w change %, P/E, EPS, dividend yield (refreshed daily)
- 📰 **Recent news** — last 7 days of headlines (1-hour cache)
- 🔒 **Price targets placeholder** — ready to display when premium upgrade is enabled

### Architecture
- 🔒 **Secure** — API key never exposed to the browser
- 👥 **Multi-tab/device sync** — all open tabs update simultaneously
- ⚠️ **Stale data handling** — keeps last known prices if Finnhub fails
- 🔌 **Auto-reconnect** when network drops or server restarts

## 🏗️ Architecture

```
                      ┌──────────────────┐
                      │  Finnhub API     │
                      └────────┬─────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼─────┐  ┌──────▼─────┐  ┌──────▼──────┐
    │  fetcher.js   │  │ profiles.js│  │financials.js│
    │  (every 60s)  │  │  (weekly)  │  │   (daily)   │
    └─────────┬─────┘  └──────┬─────┘  └──────┬──────┘
              │                │                │
              ▼                ▼                ▼
    ┌─────────────────────────────────────────────────┐
    │   prices.json   profiles.json  financials.json  │
    │   history.json  news.json (lazy, 1h TTL)        │
    └────────────────────────┬────────────────────────┘
                             │ SSE push + REST
                             ▼
              ┌──────────────────────────────┐
              │     Browser (app.js +        │
              │      ticker.js + Chart.js)   │
              └──────────────────────────────┘
```

- **Server**: Node.js scheduler with market-hour awareness (regular / pre-market / after-hours / closed)
- **Caching**: 4 JSON files refreshed at different intervals to stay within Finnhub's 60 calls/min free tier
- **Push**: Server broadcasts price updates via SSE — no browser polling
- **Routing**: Two pages — `/` (dashboard) and `/ticker.html?symbol=X` (per-ticker detail)

## 📁 Project Structure

```
livefolio/
├── .env                       # 🔒 your secrets (gitignored)
├── .env.sample                # ✅ committed template
├── .gitignore
├── package.json
├── server.js                  # Express + SSE + scheduler
├── README.md
├── LICENSE
├── DISCLAIMER.md
│
├── server/
│   ├── fetcher.js             # Finnhub price fetcher (every 60s adaptive)
│   ├── scheduler.js           # Market-aware adaptive scheduler
│   ├── holidays.js            # NYSE holiday calendar
│   ├── profiles.js            # Company profile fetcher (weekly)
│   ├── financials.js          # Metrics + recommendations (daily)
│   └── news.js                # On-demand news with 1h cache
│
└── public/                    # served as static files
├── index.html             # main dashboard
├── ticker.html            # per-ticker detail page
├── app.js                 # dashboard logic
├── ticker.js              # detail page logic
├── styles.css             # main styles
├── ticker-styles.css      # detail page styles
├── portfolio.json         # ✏️ you maintain (committed)
├── prices.json            # 🤖 auto-generated (gitignored)
├── history.json           # 🤖 auto-generated (gitignored)
├── profiles.json          # 🤖 auto-generated (gitignored)
├── financials.json        # 🤖 auto-generated (gitignored)
└── news.json              # 🤖 auto-generated (gitignored)
```

## 🚀 Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org) v18 or higher
- A free [Finnhub API key](https://finnhub.io/dashboard) (60 calls/min on free tier)

### 2. Install

```bash
git clone <your-repo-url>
cd portfolio
npm install
```

### 3. Configure

Copy the sample env file and add your Finnhub API key:

```bash
cp .env.sample .env
```

Edit `.env`:

```env
FINNHUB_API_KEY=your_real_key_here
REFRESH_SECONDS=60
PORT=3000
```

### 4. Add your holdings

Edit `public/portfolio.json`:

```json
{
  "cash": 250.00,
  "holdings": [
    {
      "ticker": "AAPL",
      "company": "Apple Inc.",
      "quantity": 2.006147,
      "avgCost": 175.50,
      "buyDate": "2025-03-15"
    },
    {
      "ticker": "ORCL",
      "company": "Oracle Corporation",
      "quantity": 0.34102,
      "avgCost": 147.12,
      "buyDate": "2025-04-20"
    }
  ]
}
```

### 5. Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) — done! 🎉

## 🛠️ Available Scripts

## 🌐 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI |
| `/ticker.html?symbol=X` | GET | Per-ticker detail page |
| `/portfolio.json` | GET | Your holdings (read-only) |
| `/prices.json` | GET | Latest prices snapshot |
| `/history.json` | GET | Daily history (90 days) |
| `/profiles.json` | GET | Company profiles |
| `/financials.json` | GET | Metrics + analyst recommendations |
| `/api/news/:ticker` | GET | News for ticker (1-hour cache, `?force=true` to bypass) |
| `/events` | GET | SSE stream of price updates + market phase events |
| `/api/refresh` | POST | Trigger immediate price fetch |
| `/api/refresh-profiles` | POST | Trigger profile refresh (`?force=true`) |
| `/api/refresh-financials` | POST | Trigger financials refresh (`?force=true`) |

## ⚙️ Configuration

All settings are controlled via `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `FINNHUB_API_KEY` | _(required)_ | Your Finnhub API key |
| `REFRESH_SECONDS` | `60` | How often the server fetches new prices (set `0` to disable auto-refresh) |
| `PORT` | `3000` | HTTP port the server listens on |

## 📊 How It Works

### Data Flow

| Phase | Action | Mechanism |
|-------|--------|-----------|
| **Page load** | Browser reads `portfolio.json` + `prices.json` | `fetch()` |
| **Live updates** | Browser subscribes to `/events` | SSE (`EventSource`) |
| **Server fetch** | Every 60s, server calls Finnhub for each ticker | Scheduled `setInterval` |
| **Push** | Server broadcasts new prices to all connected browsers | SSE event `prices` |
| **Manual refresh** | User clicks 🔄 → `POST /api/refresh` → server fetches → broadcasts | HTTP + SSE |
| **History** | Once per fetch, today's snapshot is written to `history.json` | Keyed by date |

### Files

| File | Owner | Purpose | Updated |
|------|-------|---------|---------|
| `portfolio.json` | You | Holdings + cash (source of truth) | Manually |
| `prices.json` | Server | Latest fetched prices for all tickers | Every 60s |
| `history.json` | Server | Daily snapshots of net worth, P/L, etc. | Every 60s (overwrites same day) |

## 🔒 Security

- **API key** lives only in `.env` (gitignored)
- **Browser never sees the key** — it only reads JSON files served by the local Node server
- **No external dependencies** at runtime besides Finnhub
- **No telemetry, no analytics** — fully self-hosted

## 🌐 API Endpoints

## 🌐 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI |
| `/ticker.html?symbol=X` | GET | Per-ticker detail page |
| `/portfolio.json` | GET | Your holdings (read-only) |
| `/prices.json` | GET | Latest prices snapshot |
| `/history.json` | GET | Daily history (90 days) |
| `/profiles.json` | GET | Company profiles |
| `/financials.json` | GET | Metrics + analyst recommendations |
| `/api/news/:ticker` | GET | News for ticker (1-hour cache, `?force=true` to bypass) |
| `/events` | GET | SSE stream of price updates + market phase events |
| `/api/refresh` | POST | Trigger immediate price fetch |
| `/api/refresh-profiles` | POST | Trigger profile refresh (`?force=true`) |
| `/api/refresh-financials` | POST | Trigger financials refresh (`?force=true`) |

## 🐛 Troubleshooting

### "FINNHUB_API_KEY not set in .env"
Make sure `.env` exists in the project root (not inside `public/` or `server/`) with your real key.

### Prices show as `…` and never load
- Check the server console for errors (rate limits, invalid ticker, etc.)
- Verify your Finnhub key works: visit `https://finnhub.io/api/v1/quote?symbol=AAPL&token=YOUR_KEY` directly
- Free tier supports US equities only — non-US tickers may need exchange suffix (e.g., `RELIANCE.NS`)

### Connection badge stuck on 🔴 Disconnected
- Check the server is running (`npm start`)
- Browser blocks SSE if accessed via `file://` — must use `http://localhost:3000`

### Failed to load `portfolio.json`
- Confirm the file is at `public/portfolio.json` (not at the project root)
- Validate JSON syntax — missing commas or quotes break parsing

### Sub-fields show $0.00 or NaN
- All field names are **case-sensitive**: use `avgCost`, not `averageCost` or `avg_cost`
- Required fields per holding: `ticker`, `company`, `quantity`, `avgCost`, `buyDate`
- Required at root: `cash`

## 📈 Rate Limits

Finnhub free tier = **60 API calls/minute**.

Each refresh = N calls (one per ticker). With default `REFRESH_SECONDS=60`:

| Holdings | Calls/min | Status |
|----------|-----------|--------|
| ≤ 30 | ≤ 30 | ✅ Safe |
| 30–55 | 30–55 | ⚠️ Tight |
| 60+ | 60+ | ❌ Will rate-limit |

For larger portfolios, increase `REFRESH_SECONDS` (e.g., `300` = every 5 min).

## 🗺️ Roadmap

- [ ] **Charts**: 90-day net worth & per-ticker price history (Chart.js)
- [ ] **Backfill**: Populate `history.json` with last 90 days from Finnhub `/stock/candle`
- [ ] **Alerts**: Notify when ticker hits target price
- [ ] **Multi-portfolio**: Support multiple `portfolio_*.json` files (e.g., personal/IRA/joint)
- [ ] **Export**: Download history as CSV
- [ ] **Dark mode**: Theme toggle

## 🛠️ Tech Stack

| Layer | Tech |
|-------|------|
| **Server** | Node.js, Express, native `fetch` |
| **Real-time** | Server-Sent Events (SSE) |
| **Storage** | Plain JSON files |
| **Frontend** | Vanilla HTML/CSS/JS — no build step |
| **Data source** | [Finnhub.io](https://finnhub.io) |

## 📝 License

**Personal Use License** — © 2026 Aniruddhya Khatua

This is a personal project shared publicly for **learning, reference, and inspiration**.

### ✅ You may:
- View and study the source code
- Fork and run a personal copy for **non-commercial** use
- Adapt it for your own portfolio tracking
- Share links and screenshots with credit

### ❌ You may not:
- Use it (or substantial portions) in commercial products or paid services
- Republish it as your own work without attribution
- Resell, sublicense, or distribute modified versions commercially

For commercial licensing inquiries, please open a GitHub issue.

> ⚠️ **Disclaimer**: This dashboard is for **personal research and tracking only**. It is not financial advice. Quote data is provided by Finnhub and may be delayed or inaccurate. Always verify with your broker before making investment decisions.

## 🙏 Credits

- Live quotes from [Finnhub](https://finnhub.io) (free tier)
- Built with curiosity, ☕, and a personal need to track holdings without paying for Yahoo Finance Premium
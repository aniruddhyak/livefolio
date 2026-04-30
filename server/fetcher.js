// ============================================================
// Finnhub fetcher: reads public/portfolio.json, fetches quotes,
// writes public/prices.json + history.json. Exports runFetch().
// ============================================================
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORTFOLIO_FILE = path.join(PUBLIC_DIR, 'portfolio.json');
const PRICES_FILE = path.join(PUBLIC_DIR, 'prices.json');
const HISTORY_FILE = path.join(PUBLIC_DIR, 'history.json');

const API_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = 'https://finnhub.io/api/v1/quote';
const MAX_HISTORY_DAYS = 90;
const RATE_LIMIT_DELAY_MS = 150;

// Optional broadcast hook — server.js will inject this so fetcher
// can push prices to all SSE clients after each successful fetch.
let broadcastFn = null;
export function setBroadcast(fn) { broadcastFn = fn; }

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function fetchQuote(ticker) {
  const url = `${FINNHUB_BASE}?symbol=${encodeURIComponent(ticker)}&token=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function runFetch() {
  const startTs = Date.now();

  if (!API_KEY) {
    console.error('❌ FINNHUB_API_KEY not set in .env');
    return { ok: false, error: 'missing_api_key' };
  }

  const portfolio = await readJson(PORTFOLIO_FILE);
  if (!portfolio?.holdings?.length) {
    console.error('❌ No holdings found in portfolio.json');
    return { ok: false, error: 'no_holdings' };
  }

  // Load existing prices to retain stale-but-known values on failure
  const existing = await readJson(PRICES_FILE, { prices: {} });
  const existingPrices = existing?.prices || {};

  console.log(`⏱️  Fetching ${portfolio.holdings.length} tickers...`);
  const prices = {};
  const failed = [];
  const stale = [];

  for (const h of portfolio.holdings) {
    const ticker = (h.ticker || '').toUpperCase();
    try {
      const q = await fetchQuote(ticker);
      if (q && typeof q.c === 'number' && q.c > 0) {
        prices[ticker] = {
          currentPrice: q.c,
          previousClose: q.pc,
          dayChange: q.d,
          dayChangePct: typeof q.dp === 'number' ? q.dp : 0,
          dayHigh: q.h,
          dayLow: q.l,
          dayOpen: q.o,
          quoteTime: q.t ? new Date(q.t * 1000).toISOString() : null,
          lastUpdated: new Date().toISOString(),
          isStale: false
        };
        process.stdout.write(`  ✓ ${ticker.padEnd(6)} $${q.c.toFixed(2)}\n`);
      } else {
        // No data — keep last known if we had one
        if (existingPrices[ticker]) {
          prices[ticker] = { ...existingPrices[ticker], isStale: true };
          stale.push(ticker);
          process.stdout.write(`  ⚠ ${ticker.padEnd(6)} stale (no data, kept last)\n`);
        } else {
          failed.push(ticker);
          process.stdout.write(`  ✗ ${ticker.padEnd(6)} (no data)\n`);
        }
      }
    } catch (e) {
      if (existingPrices[ticker]) {
        prices[ticker] = { ...existingPrices[ticker], isStale: true };
        stale.push(ticker);
        process.stdout.write(`  ⚠ ${ticker.padEnd(6)} stale (${e.message})\n`);
      } else {
        failed.push(ticker);
        process.stdout.write(`  ✗ ${ticker.padEnd(6)} (${e.message})\n`);
      }
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
  }

  const fetchedAt = new Date().toISOString();
  const successCount = Object.keys(prices).filter(t => !prices[t].isStale).length;

  const payload = {
    fetchedAt,
    fetchDurationMs: Date.now() - startTs,
    successCount,
    failedCount: failed.length,
    staleCount: stale.length,
    failed,
    stale,
    prices
  };

  await fs.writeFile(PRICES_FILE, JSON.stringify(payload, null, 2));

  // Update history (key by date; overwrites same day)
  await updateHistory(portfolio, prices, fetchedAt);

  console.log(`✅ prices.json written: ${successCount} fresh, ${stale.length} stale, ${failed.length} failed (${payload.fetchDurationMs}ms)`);

  // Push to all SSE clients
  if (broadcastFn) broadcastFn('prices', payload);

  return { ok: true, ...payload };
}

async function updateHistory(portfolio, prices, fetchedAt) {
  const history = (await readJson(HISTORY_FILE, {})) || {};
  const today = fetchedAt.split('T')[0];

  let totalInvested = 0, currentValue = 0;
  const holdingsSnap = portfolio.holdings.map(h => {
    const tk = (h.ticker || '').toUpperCase();
    const px = prices[tk]?.currentPrice || 0;
    const inv = (h.quantity || 0) * (h.avgCost || 0);
    const val = (h.quantity || 0) * px;
    totalInvested += inv;
    currentValue += val;
    return { ticker: tk, price: px, value: val, pl: val - inv };
  });

  history[today] = {
    date: today,
    timestamp: fetchedAt,
    cash: portfolio.cash || 0,
    totalInvested,
    currentValue,
    netWorth: currentValue + (portfolio.cash || 0),
    totalPL: currentValue - totalInvested,
    holdings: holdingsSnap
  };

  // Trim entries older than MAX_HISTORY_DAYS
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_HISTORY_DAYS);
  for (const d of Object.keys(history)) {
    if (new Date(d) < cutoff) delete history[d];
  }

  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// Run directly: `node server/fetcher.js`
import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFetch().then(r => process.exit(r.ok ? 0 : 1));
}
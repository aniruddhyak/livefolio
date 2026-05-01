// ============================================================
// News Fetcher (on-demand with 1-hour cache)
// Fetches: /company-news for a single ticker
// Caches: public/news.json (per-ticker, 1-hour TTL)
// Trigger: lazy — only when browser requests /api/news/:ticker
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const NEWS_FILE = path.join(PUBLIC_DIR, 'news.json');

const API_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = 'https://finnhub.io/api/v1/company-news';

const CACHE_TTL_MS = 60 * 60 * 1000;   // 1 hour
const NEWS_DAYS_BACK = 7;               // last 7 days
const MAX_HEADLINES = 15;               // top 15

// Concurrency guard so multiple simultaneous requests for same ticker
// only trigger ONE Finnhub fetch (other callers wait for its promise)
const inflight = new Map();

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

function ymd(date) {
  return date.toISOString().split('T')[0];
}

async function fetchNewsFromFinnhub(ticker) {
  const to = new Date();
  const from = new Date(Date.now() - NEWS_DAYS_BACK * 24 * 60 * 60 * 1000);
  const url = `${FINNHUB_BASE}?symbol=${encodeURIComponent(ticker)}&from=${ymd(from)}&to=${ymd(to)}&token=${API_KEY}`;

  const r = await fetch(url);
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const arr = await r.json();
  if (!Array.isArray(arr)) return [];

  // Most recent first; trim, dedupe by headline, limit to MAX_HEADLINES
  const seen = new Set();
  const items = arr
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
    .filter(n => {
      const key = (n.headline || '').toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_HEADLINES)
    .map(n => ({
      headline: n.headline || '',
      source: n.source || '',
      datetime: n.datetime ? new Date(n.datetime * 1000).toISOString() : null,
      url: n.url || '',
      category: n.category || '',
      id: n.id || null
    }));

  return items;
}

/**
 * Get news for a ticker — uses cache if fresh, fetches if stale/missing.
 * Returns { ticker, items, fetchedAt, fromCache, ageMinutes }
 */
export async function getNewsForTicker(ticker, { force = false } = {}) {
  ticker = (ticker || '').toUpperCase();
  if (!ticker) throw new Error('ticker required');
  if (!API_KEY) throw new Error('FINNHUB_API_KEY not set');

  // Concurrency guard
  if (inflight.has(ticker)) return inflight.get(ticker);

  const promise = (async () => {
    const cache = (await readJson(NEWS_FILE, { news: {} })) || { news: {} };
    cache.news = cache.news || {};

    const cached = cache.news[ticker];
    const now = Date.now();

    // Use cache if fresh and not forced
    if (!force && cached && cached.fetchedAt) {
      const age = now - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) {
        return {
          ticker,
          items: cached.items || [],
          fetchedAt: cached.fetchedAt,
          fromCache: true,
          ageMinutes: Math.round(age / 60000)
        };
      }
    }

    // Fetch fresh
    let items = [];
    let error = null;
    try {
      items = await fetchNewsFromFinnhub(ticker);
    } catch (e) {
      error = e;
      // On failure, return cached if we have it (mark stale)
      if (cached) {
        return {
          ticker,
          items: cached.items || [],
          fetchedAt: cached.fetchedAt,
          fromCache: true,
          isStale: true,
          ageMinutes: Math.round((now - new Date(cached.fetchedAt).getTime()) / 60000),
          error: e.message
        };
      }
      throw e;
    }

    const fetchedAt = new Date().toISOString();
    cache.news[ticker] = { items, fetchedAt };
    cache.lastUpdated = fetchedAt;

    await writeJson(NEWS_FILE, cache);

    return { ticker, items, fetchedAt, fromCache: false, ageMinutes: 0 };
  })();

  inflight.set(ticker, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(ticker);
  }
}

/**
 * Bulk prefetch (optional — can be used for warming cache).
 */
export async function prefetchNews(tickers, { force = false } = {}) {
  const results = [];
  for (const t of tickers) {
    try {
      const r = await getNewsForTicker(t, { force });
      results.push({ ticker: t, ok: true, count: r.items.length, fromCache: r.fromCache });
    } catch (e) {
      results.push({ ticker: t, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 200)); // rate-limit safety
  }
  return results;
}

// CLI: `node server/news.js TICKER [--force]`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const ticker = args.find(a => !a.startsWith('--'));

  if (!ticker) {
    console.error('Usage: node server/news.js <TICKER> [--force]');
    process.exit(1);
  }

  getNewsForTicker(ticker, { force })
    .then(r => {
      console.log(`📰 ${r.ticker} — ${r.items.length} headlines (${r.fromCache ? `cached, ${r.ageMinutes}m old` : 'fresh'})`);
      r.items.slice(0, 10).forEach((it, i) => {
        const date = it.datetime ? new Date(it.datetime).toLocaleDateString() : '?';
        console.log(`  ${(i + 1).toString().padStart(2)}. [${date}] ${it.source.padEnd(15)} ${it.headline.slice(0, 80)}`);
      });
      process.exit(0);
    })
    .catch(e => {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    });
}
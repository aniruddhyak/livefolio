// ============================================================
// Financials Fetcher
// Fetches:
//   - /stock/metric        → 52w H/L, P/E, EPS, dividend yield, 52w change %
//   - /stock/recommendation → analyst Buy/Hold/Sell trends (last 4 months)
//   - /stock/price-target   → ⚠️ premium-only (we attempt, expect 403/empty)
//
// Writes: public/financials.json
// Refresh: daily after market close (1:30 PM PST scheduled by server.js)
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORTFOLIO_FILE = path.join(PUBLIC_DIR, 'portfolio.json');
const FINANCIALS_FILE = path.join(PUBLIC_DIR, 'financials.json');

const API_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const RATE_LIMIT_DELAY_MS = 200;

// Refresh threshold: 24h (so re-running same day is a no-op unless --force)
const REFRESH_THRESHOLD_MS = 20 * 60 * 60 * 1000; // 20h (slack for daily run)

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) {
    // 403 = premium endpoint or expired key; 429 = rate limit
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// --- /stock/metric endpoint ---
async function fetchMetrics(ticker) {
  const url = `${FINNHUB_BASE}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${API_KEY}`;
  const data = await fetchJson(url);
  const m = data?.metric || {};

  return {
    week52High: m['52WeekHigh'] ?? null,
    week52Low: m['52WeekLow'] ?? null,
    week52ChangePct: m['52WeekPriceReturnDaily'] ?? null,
    week52HighDate: m['52WeekHighDate'] ?? null,
    week52LowDate: m['52WeekLowDate'] ?? null,
    peTTM: m['peNormalizedAnnual'] ?? m['peTTM'] ?? null,
    epsTTM: m['epsNormalizedAnnual'] ?? m['epsTTM'] ?? null,
    dividendYield: m['dividendYieldIndicatedAnnual'] ?? null,
    beta: m['beta'] ?? null,
    marketCapitalization: m['marketCapitalization'] ?? null,
    avg10DayVolume: m['10DayAverageTradingVolume'] ?? null
  };
}

// --- /stock/recommendation endpoint ---
async function fetchRecommendation(ticker) {
  const url = `${FINNHUB_BASE}/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${API_KEY}`;
  const data = await fetchJson(url);
  // Returns array, most recent first. We keep up to 4 entries (4 months).
  if (!Array.isArray(data) || data.length === 0) return null;

  const trend = data.slice(0, 4).map(r => ({
    period: r.period,
    strongBuy: r.strongBuy ?? 0,
    buy: r.buy ?? 0,
    hold: r.hold ?? 0,
    sell: r.sell ?? 0,
    strongSell: r.strongSell ?? 0,
    total: (r.strongBuy ?? 0) + (r.buy ?? 0) + (r.hold ?? 0) + (r.sell ?? 0) + (r.strongSell ?? 0)
  }));

  return {
    latest: trend[0],
    trend // [latest, prev, prev2, prev3]
  };
}

// --- /stock/price-target endpoint (PREMIUM — likely fails) ---
async function fetchPriceTarget(ticker) {
  const url = `${FINNHUB_BASE}/stock/price-target?symbol=${encodeURIComponent(ticker)}&token=${API_KEY}`;
  try {
    const data = await fetchJson(url);
    if (!data || data.targetMean === undefined || data.targetMean === 0) return null;
    return {
      targetHigh: data.targetHigh ?? null,
      targetLow: data.targetLow ?? null,
      targetMean: data.targetMean ?? null,
      targetMedian: data.targetMedian ?? null,
      lastUpdated: data.lastUpdated ?? null,
      numberOfAnalysts: data.numberOfAnalysts ?? null
    };
  } catch (e) {
    if (e.status === 403) return { premium: true };
    return null;
  }
}

/**
 * Fetch financials for all tickers.
 * Options:
 *   - force=true: refetch all
 *   - missingOnly=true: only fetch tickers with no cached data
 *   - staleOnly=true: only fetch if existing data is older than threshold
 */
export async function fetchFinancials({ force = false, missingOnly = false, staleOnly = false } = {}) {
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

  const existing = await readJson(FINANCIALS_FILE, { data: {} });
  const existingData = existing?.data || {};
  const now = Date.now();

  const tickers = portfolio.holdings.map(h => (h.ticker || '').toUpperCase());
  const toFetch = tickers.filter(ticker => {
    if (force) return true;
    const cached = existingData[ticker];
    if (!cached) return true;
    if (missingOnly) return false;

    const age = now - new Date(cached.fetchedAt).getTime();
    if (staleOnly && age < REFRESH_THRESHOLD_MS) return false;
    if (!staleOnly && !missingOnly && age < REFRESH_THRESHOLD_MS) return false;
    return true;
  });

  if (toFetch.length === 0) {
    console.log(`📊 All ${tickers.length} financials up to date — skipping fetch.`);
    return { ok: true, fetched: 0, skipped: tickers.length };
  }

  console.log(`📊 Fetching financials for ${toFetch.length} ticker(s)...`);
  const data = { ...existingData };
  const failed = [];
  let premiumDetected = false;

  for (const ticker of toFetch) {
    let metrics = null, recommendation = null, priceTarget = null;
    let errors = [];

    // 1) Metrics
    try {
      metrics = await fetchMetrics(ticker);
    } catch (e) {
      errors.push(`metrics: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));

    // 2) Recommendation
    try {
      recommendation = await fetchRecommendation(ticker);
    } catch (e) {
      errors.push(`recommendation: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));

    // 3) Price target (premium — likely fails)
    try {
      priceTarget = await fetchPriceTarget(ticker);
      if (priceTarget?.premium) premiumDetected = true;
    } catch (e) {
      errors.push(`priceTarget: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));

    // If everything failed, keep cached if exists
    if (!metrics && !recommendation && !priceTarget) {
      if (existingData[ticker]) {
        data[ticker] = { ...existingData[ticker], isStale: true };
        process.stdout.write(`  ⚠ ${ticker.padEnd(6)} kept stale (${errors.join('; ')})\n`);
      } else {
        failed.push(ticker);
        process.stdout.write(`  ✗ ${ticker.padEnd(6)} ${errors.join('; ')}\n`);
      }
      continue;
    }

    data[ticker] = {
      ticker,
      metrics,
      recommendation,
      priceTarget,
      fetchedAt: new Date().toISOString(),
      isStale: false
    };

    // Build a one-line summary
    const parts = [];
    if (metrics?.peTTM) parts.push(`P/E ${metrics.peTTM.toFixed(1)}`);
    if (recommendation?.latest) {
      const r = recommendation.latest;
      parts.push(`Rec: ${r.strongBuy + r.buy}B/${r.hold}H/${r.sell + r.strongSell}S`);
    }
    if (priceTarget?.targetMean) parts.push(`Tgt $${priceTarget.targetMean.toFixed(0)}`);
    process.stdout.write(`  ✓ ${ticker.padEnd(6)} ${parts.join(' · ')}\n`);
  }

  // Clean removed tickers
  for (const ticker of Object.keys(data)) {
    if (!tickers.includes(ticker)) {
      delete data[ticker];
      console.log(`  🗑️  Removed ${ticker} (no longer in portfolio)`);
    }
  }

  const payload = {
    lastUpdated: new Date().toISOString(),
    fetchDurationMs: Date.now() - startTs,
    fetchedCount: toFetch.length - failed.length,
    failedCount: failed.length,
    failed,
    priceTargetSupported: !premiumDetected,
    data
  };

  await fs.writeFile(FINANCIALS_FILE, JSON.stringify(payload, null, 2));
  console.log(`✅ financials.json written: ${payload.fetchedCount} updated, ${failed.length} failed (${payload.fetchDurationMs}ms)`);
  if (premiumDetected) {
    console.log(`   ℹ️  Price targets are premium-only — UI will show placeholder.`);
  }

  return { ok: true, ...payload };
}

// Run directly: `node server/financials.js [--force]`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  fetchFinancials({ force }).then(r => process.exit(r.ok ? 0 : 1));
}
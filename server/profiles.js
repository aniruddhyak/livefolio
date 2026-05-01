// ============================================================
// Company Profile Fetcher
// Reads tickers from public/portfolio.json, fetches company
// profiles from Finnhub /stock/profile2, writes to
// public/profiles.json. Refresh: weekly (or on-demand if missing).
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
const PROFILES_FILE = path.join(PUBLIC_DIR, 'profiles.json');

const API_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = 'https://finnhub.io/api/v1/stock/profile2';
const RATE_LIMIT_DELAY_MS = 150;

// Refresh threshold: 7 days
const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function fetchProfile(ticker) {
  const url = `${FINNHUB_BASE}?symbol=${encodeURIComponent(ticker)}&token=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/**
 * Fetch profiles for all tickers in portfolio.json.
 * Optional flags:
 *   - force=true: always refetch all profiles
 *   - missingOnly=true: only fetch profiles that don't exist yet
 *   - staleOnly=true: only fetch profiles older than REFRESH_THRESHOLD_MS
 */
export async function fetchProfiles({ force = false, missingOnly = false, staleOnly = false } = {}) {
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

  // Load existing profiles
  const existing = await readJson(PROFILES_FILE, { profiles: {} });
  const existingProfiles = existing?.profiles || {};
  const now = Date.now();

  // Decide which tickers need fetching
  const tickers = portfolio.holdings.map(h => (h.ticker || '').toUpperCase());
  const toFetch = tickers.filter(ticker => {
    if (force) return true;
    const cached = existingProfiles[ticker];
    if (!cached) return true; // missing
    if (missingOnly) return false;

    const age = now - new Date(cached.fetchedAt).getTime();
    if (staleOnly && age < REFRESH_THRESHOLD_MS) return false;
    if (!staleOnly && !missingOnly && age < REFRESH_THRESHOLD_MS) return false;
    return true;
  });

  if (toFetch.length === 0) {
    console.log(`📇 All ${tickers.length} profiles up to date — skipping fetch.`);
    return { ok: true, fetched: 0, skipped: tickers.length };
  }

  console.log(`📇 Fetching profiles for ${toFetch.length} ticker(s)...`);
  const profiles = { ...existingProfiles };
  const failed = [];

  for (const ticker of toFetch) {
    try {
      const p = await fetchProfile(ticker);
      // Empty {} response = ticker not found in Finnhub's DB
      if (!p || Object.keys(p).length === 0) {
        // Keep cached if we had one
        if (existingProfiles[ticker]) {
          profiles[ticker] = { ...existingProfiles[ticker], isStale: true };
          process.stdout.write(`  ⚠ ${ticker.padEnd(6)} kept stale (no data)\n`);
        } else {
          failed.push(ticker);
          process.stdout.write(`  ✗ ${ticker.padEnd(6)} (no data)\n`);
        }
        continue;
      }

      profiles[ticker] = {
        ticker,
        name: p.name || '',
        logo: p.logo || '',
        country: p.country || '',
        currency: p.currency || 'USD',
        exchange: p.exchange || '',
        industry: p.finnhubIndustry || '',
        ipo: p.ipo || '',
        marketCapMillions: p.marketCapitalization || 0,
        shareOutstandingMillions: p.shareOutstanding || 0,
        weburl: p.weburl || '',
        phone: p.phone || '',
        ticker_finnhub: p.ticker || ticker,
        fetchedAt: new Date().toISOString(),
        isStale: false
      };

      const cap = profiles[ticker].marketCapMillions;
      const capStr = cap >= 1000 ? `$${(cap / 1000).toFixed(1)}B` : `$${cap.toFixed(0)}M`;
      process.stdout.write(`  ✓ ${ticker.padEnd(6)} ${(p.name || '').slice(0, 30).padEnd(30)} ${capStr}\n`);
    } catch (e) {
      if (existingProfiles[ticker]) {
        profiles[ticker] = { ...existingProfiles[ticker], isStale: true };
        process.stdout.write(`  ⚠ ${ticker.padEnd(6)} kept stale (${e.message})\n`);
      } else {
        failed.push(ticker);
        process.stdout.write(`  ✗ ${ticker.padEnd(6)} (${e.message})\n`);
      }
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
  }

  // Remove profiles for tickers no longer in portfolio
  for (const ticker of Object.keys(profiles)) {
    if (!tickers.includes(ticker)) {
      delete profiles[ticker];
      console.log(`  🗑️  Removed ${ticker} (no longer in portfolio)`);
    }
  }

  const payload = {
    lastUpdated: new Date().toISOString(),
    fetchDurationMs: Date.now() - startTs,
    fetchedCount: toFetch.length - failed.length,
    failedCount: failed.length,
    failed,
    profiles
  };

  await fs.writeFile(PROFILES_FILE, JSON.stringify(payload, null, 2));

  console.log(`✅ profiles.json written: ${payload.fetchedCount} updated, ${failed.length} failed (${payload.fetchDurationMs}ms)`);
  return { ok: true, ...payload };
}

// Run directly: `node server/profiles.js [--force]`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  fetchProfiles({ force }).then(r => process.exit(r.ok ? 0 : 1));
}
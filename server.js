// ============================================================
// Express server + SSE broadcaster + scheduler.
// ============================================================
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { runFetch, setBroadcast } from './server/fetcher.js';
import { fetchProfiles } from './server/profiles.js';
import { fetchFinancials } from './server/financials.js';
import { getNewsForTicker } from './server/news.js';
import { startSmartScheduler, getPhaseLabel, getETTimeString, getMarketPhase } from './server/scheduler.js';
dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const REFRESH_SECONDS = Number(process.env.REFRESH_SECONDS) || 60;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- SSE clients registry ---
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* ignore broken pipes */ }
  }
}
setBroadcast(broadcast);

// --- SSE endpoint ---
app.get('/events', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  // Send initial snapshot from prices.json on connect
  try {
    const raw = await fs.readFile(path.join(__dirname, 'public', 'prices.json'), 'utf8');
    res.write(`event: snapshot\ndata: ${raw}\n\n`);
  } catch { /* file may not exist yet */ }

  // Send current market phase on connect (so client knows immediately)
  try {
    const phase = getMarketPhase();
    res.write(`event: phase\ndata: ${JSON.stringify({
      phase,
      label: getPhaseLabel(phase),
      updatedAt: new Date().toISOString()
    })}\n\n`);
  } catch (e) {
    console.warn('phase send failed:', e.message);
  }

  // Heartbeat every 25s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  clients.add(res);
  console.log(`🔌 SSE client connected (${clients.size} total)`);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`🔌 SSE client disconnected (${clients.size} remaining)`);
  });
});

// --- Manual refresh trigger ---
app.post('/api/refresh', async (req, res) => {
  const result = await runFetch();
  res.json(result);
});

// --- Manual profile refresh trigger ---
app.post('/api/refresh-profiles', async (req, res) => {
  const force = req.query.force === 'true';
  const result = await fetchProfiles({ force });
  res.json(result);
});

// --- Manual financials refresh trigger ---
app.post('/api/refresh-financials', async (req, res) => {
  const force = req.query.force === 'true';
  const result = await fetchFinancials({ force });
  res.json(result);
});

// --- News on-demand endpoint ---
app.get('/api/news/:ticker', async (req, res) => {
  const ticker = (req.params.ticker || '').toUpperCase().trim();
  const force = req.query.force === 'true';

  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return res.status(400).json({ ok: false, error: 'invalid_ticker' });
  }

  try {
    const result = await getNewsForTicker(ticker, { force });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error(`News fetch failed for ${ticker}:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// Daily financials scheduler — runs at 1:30 PM PST on weekdays
// ============================================================
function scheduleDailyFinancials() {
  function msUntilNext130PMpst() {
    // Compute current time in America/Los_Angeles
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, weekday: 'short'
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    let pstHour = parseInt(parts.hour, 10);
    if (pstHour === 24) pstHour = 0;
    const pstMinute = parseInt(parts.minute, 10);
    const pstSecond = parseInt(parts.second, 10);
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const pstDay = dayMap[parts.weekday];

    // Target = 13:30 PST (market close + 30min buffer)
    const TARGET_HOUR = 13;
    const TARGET_MIN = 30;

    const nowMins = pstHour * 60 + pstMinute + pstSecond / 60;
    const targetMins = TARGET_HOUR * 60 + TARGET_MIN;

    let daysAhead = 0;
    if (nowMins >= targetMins) daysAhead = 1; // already past today's run, schedule tomorrow

    // Skip weekends — push to Monday
    let nextDay = (pstDay + daysAhead) % 7;
    while (nextDay === 0 || nextDay === 6) {
      daysAhead++;
      nextDay = (pstDay + daysAhead) % 7;
    }

    const minsUntil = (daysAhead * 24 * 60) - nowMins + targetMins;
    return minsUntil * 60 * 1000;
  }

  function scheduleNext() {
    const ms = msUntilNext130PMpst();
    const hours = Math.round(ms / 3600000 * 10) / 10;
    console.log(`📅 Next financials refresh in ${hours}h (1:30 PM PST, weekdays)`);

    setTimeout(async () => {
      console.log(`📊 Daily financials refresh triggered`);
      try {
        await fetchFinancials({ staleOnly: true });
      } catch (e) {
        console.error('Daily financials refresh failed:', e.message);
      }
      scheduleNext(); // chain next run
    }, ms);
  }

  scheduleNext();
}

// --- Boot ---
app.listen(PORT, async () => {
  console.log(`🚀 Server running: http://localhost:${PORT}`);
  console.log(`📡 SSE endpoint:   http://localhost:${PORT}/events`);
  console.log(`🌎 Market check:   ${getETTimeString()}`);

  // 1. Profiles (weekly, refresh if stale)
  console.log(`📇 Checking company profiles...`);
  await fetchProfiles({ staleOnly: true });

  // 2. Financials (daily, refresh if stale)
  console.log(`📊 Checking financials...`);
  await fetchFinancials({ staleOnly: true });

  // 3. Initial price fetch
  console.log(`📥 Running initial price fetch...`);
  await runFetch();

  // 4. Adaptive price scheduler
  startSmartScheduler(runFetch, (phase) => {
    console.log(`📊 Now in phase: ${getPhaseLabel(phase)}`);
    broadcast('phase', { phase, label: getPhaseLabel(phase), updatedAt: new Date().toISOString() });
  });

  // 5. Weekly profile refresh (24h check)
  setInterval(() => {
    fetchProfiles({ staleOnly: true }).catch(e =>
      console.error('Weekly profile refresh failed:', e.message)
    );
  }, 24 * 60 * 60 * 1000);

  // 6. Daily financials refresh — scheduled at 1:30 PM PST
  scheduleDailyFinancials();
});
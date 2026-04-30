// ============================================================
// Express server + SSE broadcaster + scheduler.
// ============================================================
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import { runFetch, setBroadcast } from './server/fetcher.js';

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

// --- Boot ---
app.listen(PORT, async () => {
  console.log(`🚀 Server running: http://localhost:${PORT}`);
  console.log(`📡 SSE endpoint:   http://localhost:${PORT}/events`);

  await runFetch();

  if (REFRESH_SECONDS > 0) {
    console.log(`⏱️  Auto-fetching every ${REFRESH_SECONDS}s`);
    setInterval(runFetch, REFRESH_SECONDS * 1000);
  }
});
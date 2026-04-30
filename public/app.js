// ============================================================
// Browser app — reads portfolio.json once, then subscribes to
// /events (SSE) for live price updates. No polling.
// ============================================================

let HOLDINGS = [];
let CASH = 0;
let sortState = { key: 'ticker', dir: 'asc' };
let evtSource = null;

const fmtMoney = (n) =>
  (n < 0 ? '-$' : '$') +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n) => `${n.toFixed(2)}%`;
const fmtQty = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });

// --- portfolio loader ---
async function loadPortfolio() {
  const r = await fetch('portfolio.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('portfolio.json not found');
  const data = await r.json();
  CASH = Number(data.cash || 0);
  HOLDINGS = (data.holdings || []).map(h => ({
    ticker: (h.ticker || '').toUpperCase(),
    company: h.company || '',
    quantity: Number(h.quantity) || 0,
    avgCost: Number(h.avgCost) || 0,
    buyDate: h.buyDate || '',
    currentPrice: 0,
    dayChangePct: 0,
    invested: 0, value: 0, pl: 0, plPct: 0,
    loaded: false,
    isStale: false
  }));
}

// --- apply prices payload from SSE ---
function applyPrices(payload) {
  if (!payload?.prices) return;
  HOLDINGS.forEach(h => {
    const p = payload.prices[h.ticker];
    if (p) {
      h.currentPrice = p.currentPrice;
      h.dayChangePct = p.dayChangePct || 0;
      h.isStale = !!p.isStale;
      h.loaded = true;
    }
    recompute(h);
  });

  if (payload.fetchedAt) {
    document.getElementById('asOfDate').textContent =
      new Date(payload.fetchedAt).toLocaleString();
  }

  const fresh = payload.successCount ?? 0;
  const stale = payload.staleCount ?? 0;
  const failed = payload.failedCount ?? 0;
  const msg = `✅ ${fresh} fresh${stale ? ` · ⚠ ${stale} stale` : ''}${failed ? ` · ✗ ${failed} failed` : ''}`;
  setStatus(msg, failed > 0);

  renderAll();
}

function recompute(h) {
  h.invested = h.quantity * h.avgCost;
  h.value = h.quantity * h.currentPrice;
  h.pl = h.value - h.invested;
  h.plPct = h.invested > 0 ? (h.pl / h.invested) * 100 : 0;
}

// --- SSE connection ---
function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/events');

  evtSource.addEventListener('open', () => setConnBadge('live'));
  evtSource.addEventListener('snapshot', (e) => applyPrices(JSON.parse(e.data)));
  evtSource.addEventListener('prices', (e) => applyPrices(JSON.parse(e.data)));
  evtSource.addEventListener('error', () => setConnBadge('disconnected'));
}

function setConnBadge(state) {
  const el = document.getElementById('connBadge');
  el.classList.remove('conn-live', 'conn-pending', 'conn-disconnected');
  if (state === 'live') {
    el.textContent = '🟢 Live';
    el.classList.add('conn-live');
  } else if (state === 'disconnected') {
    el.textContent = '🔴 Disconnected — retrying…';
    el.classList.add('conn-disconnected');
  } else {
    el.textContent = '⚪ Connecting…';
    el.classList.add('conn-pending');
  }
}

// --- manual refresh ---
async function manualRefresh() {
  setStatus('🔄 Triggering server fetch…');
  try {
    await fetch('/api/refresh', { method: 'POST' });
    // SSE will push the new prices automatically
  } catch (e) {
    setStatus(`❌ Refresh failed: ${e.message}`, true);
  }
}

// --- renderers ---
function setStatus(msg, isError = false) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.className = 'status ' + (isError ? 'err' : 'ok');
}

function renderAll() {
  renderCash();
  renderTable();
  renderSummary();
}

function renderCash() {
  document.getElementById('cashAmount').textContent = fmtMoney(CASH);
}

function renderSummary() {
  const totalInvested = HOLDINGS.reduce((s, h) => s + h.invested, 0);
  const currentValue = HOLDINGS.reduce((s, h) => s + h.value, 0);
  const totalPL = currentValue - totalInvested;
  const totalReturn = totalInvested > 0 ? (totalPL / totalInvested) * 100 : 0;

  document.getElementById('totalInvested').textContent = fmtMoney(totalInvested);
  document.getElementById('currentValue').textContent = fmtMoney(currentValue);

  const plEl = document.getElementById('totalPL');
  plEl.textContent = fmtMoney(totalPL);
  plEl.className = totalPL >= 0 ? 'pos' : 'neg';

  const retEl = document.getElementById('totalReturn');
  retEl.textContent = fmtPct(totalReturn);
  retEl.className = totalReturn >= 0 ? 'pos' : 'neg';

  document.getElementById('netWorth').textContent = fmtMoney(currentValue + CASH);
}

function renderTable() {
  const sorted = [...HOLDINGS].sort(compareBy(sortState.key, sortState.dir));
  document.getElementById('holdingsBody').innerHTML = sorted.map(h => {
    const plClass = h.pl >= 0 ? 'pos' : 'neg';
    const dayClass = h.dayChangePct >= 0 ? 'pos' : 'neg';
    const staleBadge = h.isStale ? ' <span class="stale-badge" title="stale">⚠</span>' : '';
    const priceCell = h.loaded
      ? `${fmtMoney(h.currentPrice)}${staleBadge}`
      : '<span class="muted">…</span>';
    return `
      <tr>
        <td><strong>${h.ticker}</strong></td>
        <td>${h.company}</td>
        <td class="num">${fmtQty(h.quantity)}</td>
        <td class="num">${fmtMoney(h.avgCost)}</td>
        <td class="num">${priceCell}</td>
        <td class="num">${h.loaded ? `<span class="${dayClass}">${fmtPct(h.dayChangePct)}</span>` : '—'}</td>
        <td class="num">${fmtMoney(h.invested)}</td>
        <td class="num">${h.loaded ? fmtMoney(h.value) : '—'}</td>
        <td class="num ${plClass}">${h.loaded ? fmtMoney(h.pl) : '—'}</td>
        <td class="num ${plClass}">${h.loaded ? fmtPct(h.plPct) : '—'}</td>
        <td>${h.buyDate}</td>
      </tr>`;
  }).join('');

  document.querySelectorAll('#holdingsTable thead th').forEach(th => {
    const k = th.dataset.key;
    const base = th.textContent.replace(/[ ⇅▲▼]+$/, '').trim();
    th.textContent = (k === sortState.key)
      ? `${base} ${sortState.dir === 'asc' ? '▲' : '▼'}`
      : `${base} ⇅`;
  });
}

function compareBy(key, dir) {
  const mult = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
    return String(va).localeCompare(String(vb)) * mult;
  };
}

function attachSortHandlers() {
  document.querySelectorAll('#holdingsTable thead th').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (!key) return;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.key = key;
        const numericKeys = ['quantity','avgCost','currentPrice','dayChangePct','invested','value','pl','plPct'];
        sortState.dir = numericKeys.includes(key) ? 'desc' : 'asc';
      }
      renderTable();
    });
  });
}

// --- bootstrap ---
document.addEventListener('DOMContentLoaded', async () => {
  attachSortHandlers();
  document.getElementById('refreshBtn').addEventListener('click', manualRefresh);

  await loadPortfolio();
  renderAll();
  connectSSE();
});
// ============================================================
// Ticker Detail Page - app logic
// Loads: portfolio.json, prices.json, profiles.json,
//        financials.json, history.json, /api/news/:ticker
// Live: subscribes to /events (SSE) for price updates
// ============================================================

// ---------------------------------------------------------
// State
// ---------------------------------------------------------
const TICKER = (new URLSearchParams(location.search).get('symbol') || '')
  .toUpperCase().trim();

const STATE = {
  portfolio: null,    // {cash, holdings: [...]}
  holding: null,      // the holding for this ticker (or null if not owned)
  prices: null,       // entire prices.json
  price: null,        // prices.prices[TICKER]
  profile: null,      // profiles.profiles[TICKER]
  financials: null,   // financials.data[TICKER]
  history: null,      // history.json
  newsItems: []
};

let priceChart = null;
let recSparklineChart = null;
let evtSource = null;
let currentChartRange = 30;

// ---------------------------------------------------------
// Formatters
// ---------------------------------------------------------
const fmtMoney = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return (n < 0 ? '-$' : '$') +
    Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtPct = (n) => (n === null || n === undefined || isNaN(n)) ? '—' : `${Number(n).toFixed(2)}%`;
const fmtNum = (n, decimals = 2) =>
  (n === null || n === undefined || isNaN(n)) ? '—' :
  Number(n).toLocaleString('en-US', { maximumFractionDigits: decimals });
const fmtQty = (n) => (n === null || n === undefined || isNaN(n)) ? '—' :
  Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });

const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
};

const fmtDateTime = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? '—' : d.toLocaleString();
};

const fmtRelative = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d)) return '—';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(s);
};

const daysSince = (s) => {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d)) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
};

// ---------------------------------------------------------
// Boot
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  if (!TICKER) {
    document.body.innerHTML = `
      <div style="text-align:center;padding:60px;font-family:sans-serif;">
        <h2>⚠️ No ticker specified</h2>
        <p>Use a URL like: <code>ticker.html?symbol=ORCL</code></p>
        index.html
      </div>`;
    return;
  }

  document.title = `${TICKER} · Livefolio`;
  document.getElementById('tickerSymbol').textContent = TICKER;
  document.getElementById('logoFallback').textContent = TICKER.slice(0, 2);

  // Range buttons
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentChartRange = Number(btn.dataset.range);
      renderHistoryChart();
    });
  });

  // Parallel fetch all static JSONs
  await Promise.all([
    loadPortfolio(),
    loadPrices(),
    loadProfile(),
    loadFinancials(),
    loadHistory()
  ]);

  // Render everything we have
  renderHero();
  renderPosition();
  renderQuote();
  renderHistoryChart();
  renderAnalyst();
  renderMetrics();

  // News (separate — async + cached server-side)
  loadAndRenderNews();

  // Live updates
  connectSSE();
});

// ---------------------------------------------------------
// Loaders
// ---------------------------------------------------------
async function loadPortfolio() {
  try {
    const r = await fetch('portfolio.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('portfolio.json missing');
    STATE.portfolio = await r.json();
    STATE.holding = (STATE.portfolio.holdings || [])
      .find(h => (h.ticker || '').toUpperCase() === TICKER) || null;
  } catch (e) {
    console.warn('portfolio.json not loaded:', e.message);
  }
}

async function loadPrices() {
  try {
    const r = await fetch('prices.json?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    STATE.prices = await r.json();
    STATE.price = STATE.prices?.prices?.[TICKER] || null;
  } catch (e) {
    console.warn('prices.json not loaded:', e.message);
  }
}

async function loadProfile() {
  try {
    const r = await fetch('profiles.json?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    STATE.profile = data?.profiles?.[TICKER] || null;
  } catch (e) {
    console.warn('profiles.json not loaded:', e.message);
  }
}

async function loadFinancials() {
  try {
    const r = await fetch('financials.json?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    STATE.financials = data?.data?.[TICKER] || null;
  } catch (e) {
    console.warn('financials.json not loaded:', e.message);
  }
}

async function loadHistory() {
  try {
    const r = await fetch('history.json?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    STATE.history = await r.json();
  } catch (e) {
    console.warn('history.json not loaded:', e.message);
  }
}

async function loadAndRenderNews() {
  const list = document.getElementById('newsList');
  const meta = document.getElementById('newsMeta');
  list.innerHTML = '<li class="news-empty muted">Loading headlines…</li>';

  try {
    const r = await fetch(`/api/news/${encodeURIComponent(TICKER)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'unknown');

    STATE.newsItems = data.items || [];

    if (STATE.newsItems.length === 0) {
      list.innerHTML = '<li class="news-empty muted">No recent news in the last 7 days.</li>';
      meta.textContent = '';
      return;
    }

    meta.textContent = data.fromCache
      ? `cached · ${data.ageMinutes ?? 0}m ago`
      : `fresh · just now`;

    list.innerHTML = STATE.newsItems.map(item => `
      <li class="news-item">
        <a class="news-headline" href="${item.url}" target="_blank" rel="noopener">
          ${escapeHTML(item.headline)}
        </a>
        <div class="news-meta">
          <span class="news-source">${escapeHTML(item.source || '—')}</span>
          <span>${fmtRelative(item.datetime)}</span>
        </div>
      </li>
    `).join('');
  } catch (e) {
    list.innerHTML = `<li class="news-empty muted">⚠ Could not load news: ${e.message}</li>`;
    meta.textContent = '';
  }
}

// ---------------------------------------------------------
// Renderers
// ---------------------------------------------------------
function renderHero() {
  const profile = STATE.profile;
  const price = STATE.price;

  // Company name
  const name = profile?.name || STATE.holding?.company || '';
  document.getElementById('tickerCompany').textContent = name || '(unknown company)';

  // Exchange / industry
  const parts = [];
  if (profile?.exchange) parts.push(profile.exchange.split(',')[0]); // shorten "NEW YORK STOCK EXCHANGE, INC."
  if (profile?.industry) parts.push(profile.industry);
  if (profile?.country) parts.push(profile.country);
  document.getElementById('tickerExchange').textContent = parts.join(' · ');

  // Logo
  const wrap = document.getElementById('logoWrap');
  const fallback = document.getElementById('logoFallback');
  if (profile?.logo) {
    // Try to load the real logo; fall back to initials if it fails
    const img = new Image();
    img.alt = name || TICKER;
    img.onload = () => {
      wrap.innerHTML = '';
      wrap.appendChild(img);
    };
    img.onerror = () => {
      fallback.style.background = colorFromTicker(TICKER);
    };
    img.src = profile.logo;
  } else {
    fallback.style.background = colorFromTicker(TICKER);
  }

  // Price
  document.getElementById('heroPrice').textContent = fmtMoney(price?.currentPrice);

  // Day change
  const change = document.getElementById('heroChange');
  if (price && price.dayChange !== undefined) {
    const cls = price.dayChange >= 0 ? 'pos' : 'neg';
    const arrow = price.dayChange >= 0 ? '▲' : '▼';
    change.className = `hero-change ${cls}`;
    change.textContent = `${arrow} ${fmtMoney(Math.abs(price.dayChange))} (${fmtPct(price.dayChangePct)})`;
  } else {
    change.className = 'hero-change muted';
    change.textContent = '—';
  }

  // Updated
  const updated = document.getElementById('heroUpdated');
  if (price?.lastUpdated) {
    const stale = price.isStale ? ' ⚠ stale' : '';
    updated.textContent = `Updated ${fmtRelative(price.lastUpdated)}${stale}`;
  } else {
    updated.textContent = '—';
  }
}

function renderPosition() {
  const h = STATE.holding;
  const price = STATE.price;

  if (!h) {
    // Not owned — gray out the section
    document.querySelectorAll('.position-grid .stat strong').forEach(el => {
      el.textContent = 'not owned';
      el.style.color = '#9ca3af';
      el.style.fontWeight = '400';
      el.style.fontSize = '14px';
    });
    return;
  }

  const qty = Number(h.quantity) || 0;
  const avgCost = Number(h.avgCost) || 0;
  const cur = price?.currentPrice || 0;
  const invested = qty * avgCost;
  const value = qty * cur;
  const pl = value - invested;
  const retPct = invested > 0 ? (pl / invested) * 100 : 0;
  const dayChangeOnPosition = (price?.dayChange || 0) * qty;
  const days = daysSince(h.buyDate);

  setText('posQty', fmtQty(qty));
  setText('posAvg', fmtMoney(avgCost));
  setText('posBuyDate', fmtDate(h.buyDate));
  setText('posDaysHeld', days !== null ? `${days} day${days === 1 ? '' : 's'}` : '—');
  setText('posInvested', fmtMoney(invested));
  setText('posValue', fmtMoney(value));

  setColored('posPL', pl, fmtMoney(pl));
  setColored('posReturnPct', retPct, fmtPct(retPct));
  setColored('posDayChange', dayChangeOnPosition, fmtMoney(dayChangeOnPosition));

  // % of total portfolio
  const totalPortfolioValue = (STATE.portfolio?.holdings || [])
    .reduce((sum, holding) => {
      const p = STATE.prices?.prices?.[(holding.ticker || '').toUpperCase()];
      const px = p?.currentPrice || 0;
      return sum + (Number(holding.quantity) || 0) * px;
    }, 0) + Number(STATE.portfolio?.cash || 0);

  const pctOfPort = totalPortfolioValue > 0 ? (value / totalPortfolioValue) * 100 : 0;
  setText('posPctOfPortfolio', fmtPct(pctOfPort));
}

function renderQuote() {
  const p = STATE.price;
  if (!p) {
    document.querySelectorAll('.quote-grid .stat strong').forEach(el => el.textContent = '—');
    return;
  }

  setText('qOpen', fmtMoney(p.dayOpen));
  setText('qHigh', fmtMoney(p.dayHigh));
  setText('qLow', fmtMoney(p.dayLow));
  setText('qPrevClose', fmtMoney(p.previousClose));
  setColored('qDayChange', p.dayChange, fmtMoney(p.dayChange));
  setColored('qDayChangePct', p.dayChangePct, fmtPct(p.dayChangePct));

  // Range bar
  const lo = p.dayLow, hi = p.dayHigh, cur = p.currentPrice;
  if (lo > 0 && hi > 0 && hi > lo) {
    const pct = Math.max(0, Math.min(100, ((cur - lo) / (hi - lo)) * 100));
    document.getElementById('rangeBarFill').style.width = `${pct}%`;
    document.getElementById('rangeBarMarker').style.left = `${pct}%`;
    document.getElementById('rangeBarLowLabel').textContent = fmtMoney(lo);
    document.getElementById('rangeBarHighLabel').textContent = fmtMoney(hi);
  }
}

function renderHistoryChart() {
  const days = currentChartRange;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const entries = Object.values(STATE.history || {})
    .filter(e => new Date(e.date) >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(e => {
      const tk = (e.holdings || []).find(t => t.ticker === TICKER);
      return tk ? { date: e.date, price: tk.price, value: tk.value, pl: tk.pl } : null;
    })
    .filter(x => x && x.price > 0);

  const wrap = document.querySelector('.chart-wrap');
  const emptyMsg = document.getElementById('chartEmptyMsg');

  if (entries.length === 0) {
    wrap.style.display = 'none';
    emptyMsg.hidden = false;
    if (priceChart) { priceChart.destroy(); priceChart = null; }
    return;
  }

  wrap.style.display = '';
  emptyMsg.hidden = true;

  const labels = entries.map(e => e.date);
  const prices = entries.map(e => e.price);

  // Color: green if up over the period, red if down
  const first = prices[0], last = prices[prices.length - 1];
  const upish = last >= first;
  const lineColor = upish ? '#10b981' : '#ef4444';
  const fillColor = upish ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';

  // Annotations: vertical line at buy date if it's within range
  const buyDateStr = STATE.holding?.buyDate;
  const buyDateInRange = buyDateStr && labels.includes(buyDateStr);

  const ctx = document.getElementById('priceChart').getContext('2d');
  if (priceChart) priceChart.destroy();

  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Price',
        data: prices,
        borderColor: lineColor,
        backgroundColor: fillColor,
        fill: true,
        tension: 0.3,
        pointRadius: (ctx) => {
          // Highlight the buy date point
          const lab = ctx.chart.data.labels[ctx.dataIndex];
          return lab === buyDateStr ? 6 : 2;
        },
        pointBackgroundColor: (ctx) => {
          const lab = ctx.chart.data.labels[ctx.dataIndex];
          return lab === buyDateStr ? '#1f2937' : lineColor;
        },
        pointHoverRadius: 6,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (ctxs) => fmtDate(ctxs[0].label),
            label: (ctx) => {
              const e = entries[ctx.dataIndex];
              const lines = [`Price: ${fmtMoney(e.price)}`];
              if (e.value > 0) lines.push(`Position value: ${fmtMoney(e.value)}`);
              if (e.pl !== undefined) lines.push(`P/L: ${fmtMoney(e.pl)}`);
              if (ctx.label === buyDateStr) lines.push('🎯 Bought on this day');
              return lines;
            }
          }
        }
      },
      scales: {
        y: {
          ticks: { callback: (v) => `$${Number(v).toFixed(2)}` }
        },
        x: { ticks: { maxTicksLimit: 8 } }
      }
    }
  });
}

function renderAnalyst() {
  const f = STATE.financials;
  const empty = document.getElementById('analystEmpty');
  const content = document.getElementById('analystContent');

  if (!f?.recommendation?.latest) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;

  const r = f.recommendation.latest;
  const total = r.total || 0;
  const pct = (n) => total > 0 ? (n / total) * 100 : 0;

  document.getElementById('recStrongBuy').style.width  = `${pct(r.strongBuy)}%`;
  document.getElementById('recBuy').style.width         = `${pct(r.buy)}%`;
  document.getElementById('recHold').style.width        = `${pct(r.hold)}%`;
  document.getElementById('recSell').style.width        = `${pct(r.sell)}%`;
  document.getElementById('recStrongSell').style.width  = `${pct(r.strongSell)}%`;

  setText('cntStrongBuy', r.strongBuy);
  setText('cntBuy', r.buy);
  setText('cntHold', r.hold);
  setText('cntSell', r.sell);
  setText('cntStrongSell', r.strongSell);
  setText('recTotal', total);
  setText('analystPeriod', `as of ${r.period || '—'}`);

  // Sparkline (4-month trend, totals or weighted average)
  const trend = (f.recommendation.trend || []).slice().reverse(); // oldest → newest
  if (trend.length >= 2) {
    // Convert each month to a "bullishness score": (strongBuy*2 + buy) - (sell + strongSell*2)
    // Normalized 0-100: 50 = neutral
    const scores = trend.map(t => {
      const tot = t.total || 1;
      const bull = (t.strongBuy * 2 + t.buy) - (t.sell + t.strongSell * 2);
      return ((bull / tot) + 1) * 50; // -1..1 → 0..100
    });
    const labels = trend.map(t => t.period?.slice(0, 7) || '');

    const ctx = document.getElementById('recSparkline').getContext('2d');
    if (recSparklineChart) recSparklineChart.destroy();
    recSparklineChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: scores,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.15)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (ctxs) => `Month: ${ctxs[0].label}`,
              label: (ctx) => `Bullish score: ${ctx.parsed.y.toFixed(0)}/100`
            }
          }
        },
        scales: {
          y: { display: false, min: 0, max: 100 },
          x: { display: false }
        }
      }
    });
  }

  // Price target — populate if available, else keep premium placeholder
  const pt = f.priceTarget;
  const targetContent = document.getElementById('targetContent');
  if (pt && !pt.premium && pt.targetMean) {
    const cur = STATE.price?.currentPrice || 0;
    const upside = cur > 0 ? ((pt.targetMean - cur) / cur) * 100 : 0;
    const upsideClass = upside >= 0 ? 'pos' : 'neg';
    targetContent.innerHTML = `
      <div class="target-data">
        <div class="target-row"><span>Mean target</span><strong>${fmtMoney(pt.targetMean)}</strong></div>
        <div class="target-row"><span>Range</span><strong>${fmtMoney(pt.targetLow)} – ${fmtMoney(pt.targetHigh)}</strong></div>
        <div class="target-row"><span>Upside</span><strong class="${upsideClass}">${fmtPct(upside)}</strong></div>
        <div class="target-row muted small"><span>Analysts</span><strong>${pt.numberOfAnalysts || '—'}</strong></div>
      </div>`;
  }
  // else: leave the existing 🔒 Premium placeholder from HTML
}

function renderMetrics() {
  const m = STATE.financials?.metrics;
  if (!m) return;

  setText('m52High', fmtMoney(m.week52High));
  setText('m52Low', fmtMoney(m.week52Low));

  if (m.week52ChangePct !== null && m.week52ChangePct !== undefined) {
    setColored('m52Change', m.week52ChangePct, fmtPct(m.week52ChangePct));
  }

  setText('mPE', fmtNum(m.peTTM, 2));
  setText('mEPS', m.epsTTM !== null ? fmtMoney(m.epsTTM) : '—');
  setText('mDivYield', m.dividendYield !== null ? fmtPct(m.dividendYield) : '—');

  if (m.week52HighDate) document.getElementById('m52HighDate').textContent = `on ${fmtDate(m.week52HighDate)}`;
  if (m.week52LowDate) document.getElementById('m52LowDate').textContent = `on ${fmtDate(m.week52LowDate)}`;
}

// ---------------------------------------------------------
// SSE — live price updates
// ---------------------------------------------------------
let connectionPhase = null; // tracks last known market phase from server

function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/events');

  evtSource.addEventListener('open', () => {
    // Don't assume 'live' — wait for the server's phase event.
    // Show "connecting" until we hear from the server.
    if (!connectionPhase) setConnBadge('connecting');
  });

  evtSource.addEventListener('snapshot', (e) => onPricesEvent(JSON.parse(e.data)));
  evtSource.addEventListener('prices', (e) => onPricesEvent(JSON.parse(e.data)));
  evtSource.addEventListener('phase', (e) => onPhaseEvent(JSON.parse(e.data)));

  evtSource.addEventListener('error', () => setConnBadge('disconnected'));
}

function onPricesEvent(payload) {
  if (!payload?.prices) return;
  STATE.prices = payload;
  STATE.price = payload.prices[TICKER] || null;
  renderHero();
  renderPosition();
  renderQuote();
}

function onPhaseEvent(payload) {
  connectionPhase = payload.phase;
  setConnBadge(payload.phase);
}

function setConnBadge(state) {
  const el = document.getElementById('connBadge');
  el.classList.remove('conn-live', 'conn-pending', 'conn-disconnected');

  const map = {
    'connecting':   ['⚪ Connecting…',              'conn-pending'],
    'regular':      ['🟢 Market Open',              'conn-live'],
    'pre-market':   ['🟡 Pre-Market',               'conn-live'],
    'after-hours':  ['🟡 After-Hours',              'conn-live'],
    'closed':       ['🌙 Market Closed',            'conn-pending'],
    'disconnected': ['🔴 Disconnected — retrying…', 'conn-disconnected']
  };
  const [text, cls] = map[state] || ['⚪ Connecting…', 'conn-pending'];
  el.textContent = text;
  el.classList.add(cls);
}

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setColored(id, num, formatted) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = formatted;
  el.classList.remove('pos', 'neg');
  if (num > 0) el.classList.add('pos');
  else if (num < 0) el.classList.add('neg');
}

function escapeHTML(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Deterministic color based on ticker (for fallback logo)
function colorFromTicker(ticker) {
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) {
    hash = (hash << 5) - hash + ticker.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue},65%,55%), hsl(${(hue + 30) % 360},65%,40%))`;
}
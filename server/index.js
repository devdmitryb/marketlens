require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const store   = require('./store');
const fmp     = require('./fmp');
const { startCronJobs } = require('./cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────
app.use(cors({ origin: [
  'https://devdmitryb.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:5500', // VS Code live server
]}));
app.use(express.json());

// Serve static files (dashboard.html)
app.use(express.static(path.join(__dirname, '..')));

// ── Auth middleware ───────────────────────────────────────────────
// Simple token auth — set APP_TOKEN in environment
function auth(req, res, next) {
  const token = req.headers['x-app-token'] || req.query.token;
  if (process.env.APP_TOKEN && token !== process.env.APP_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Rate limiting (simple) ────────────────────────────────────────
const requestCounts = {};
function rateLimit(req, res, next) {
  const ip  = req.ip;
  const now = Math.floor(Date.now() / 60000); // minute bucket
  const key = `${ip}:${now}`;
  requestCounts[key] = (requestCounts[key] || 0) + 1;
  if (requestCounts[key] > 200) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  // Clean old buckets
  const cutoff = now - 5;
  Object.keys(requestCounts).forEach(k => {
    if (parseInt(k.split(':')[1]) < cutoff) delete requestCounts[k];
  });
  next();
}

app.use('/api', rateLimit);

// ── API Routes ────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    time:   new Date().toISOString(),
    screener: store.read('screener_meta', {}),
  });
});

// Screener feed (cached, no FMP call)
app.get('/api/screener', auth, (req, res) => {
  const data   = store.read('screener', []);
  const upside = store.read('screener_upside', {});
  // Attach upside to each entry
  const enriched = data.map(e => ({
    ...e,
    upsideData: upside[e.symbol] || null,
  }));
  res.json(enriched);
});

// Quote — serve from cache, refresh if stale
app.get('/api/quote/:sym', auth, async (req, res) => {
  const sym    = req.params.sym.toUpperCase();
  const quotes = store.read('quotes', {});
  const cached = quotes[sym];

  // Stale if older than 15 min during market hours, 4h otherwise
  const ttl = isMarketOpen() ? 15 * 60 * 1000 : 4 * 60 * 60 * 1000;
  const age = cached ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;

  if (cached && age < ttl) {
    return res.json({ ...cached, fromCache: true });
  }

  try {
    const quote = await fmp.getQuote(sym);
    if (quote) {
      quotes[sym] = { ...quote, cachedAt: new Date().toISOString() };
      store.write('quotes', quotes);
    }
    res.json({ ...quote, fromCache: false });
  } catch(e) {
    if (cached) return res.json({ ...cached, fromCache: true, stale: true });
    res.status(500).json({ error: e.message });
  }
});

// Grades for a symbol
app.get('/api/grades/:sym', auth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  try {
    const data = await fmp.getGrades(sym);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Price target
app.get('/api/target/:sym', auth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  try {
    const data = await fmp.getTarget(sym);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Historical prices
app.get('/api/history/:sym', auth, async (req, res) => {
  const sym  = req.params.sym.toUpperCase();
  const from = req.query.from || (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();
  try {
    const data = await fmp.getHistory(sym, from);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Earnings
app.get('/api/earnings/:sym', auth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  try {
    const data = await fmp.getEarnings(sym);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Signals (cached)
app.get('/api/signals', auth, (req, res) => {
  res.json(store.read('signals', {}));
});

// Signal log (cached)
app.get('/api/signal-log', auth, (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const log   = store.read('signal_log', []);
  res.json(log.slice(0, limit));
});

// Watchlist — read/write from server (shared across devices!)
app.get('/api/watchlist', auth, (req, res) => {
  res.json(store.read('watchlist', []));
});

app.post('/api/watchlist', auth, (req, res) => {
  const { symbols } = req.body;
  if (!Array.isArray(symbols)) return res.status(400).json({ error: 'symbols must be array' });
  store.write('watchlist', symbols);
  res.json({ ok: true, symbols });
});

// Trigger manual refresh (for testing)
app.post('/api/refresh', auth, async (req, res) => {
  const { collectScreenerFeed, refreshWatchedSymbols } = require('./cron');
  res.json({ ok: true, message: 'Refresh started' });
  // Run async after response
  collectScreenerFeed().then(() => refreshWatchedSymbols());
});

// ── Helper ────────────────────────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960;
}

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 MarketLens server running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`   API:       http://localhost:${PORT}/api/health\n`);
  startCronJobs();
});

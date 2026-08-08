require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const store   = require('./store');
const db      = require('./db');
const fmp     = require('./fmp');
const { startCronJobs, rebuildRefreshQueue } = require('./cron');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// ── Middleware ────────────────────────────────────────────────────
app.use(cors({ origin: [
  'https://devdmitryb.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:5500', // VS Code live server
]}));
app.use(express.json());

// Serve static files (dashboard.html)
app.use(express.static(path.join(__dirname, '..')));

// Serve login page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'login.html'));
});

// ── Login endpoint ────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  try {
    const user = await db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign(
      { user_id: user.id, username: user.username, role: user.role, display_name: user.display_name },
      JWT_SECRET,
      { expiresIn: '90d' }
    );

    await db.touchLastActive(user.id);

    res.json({ token });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Auth middleware ───────────────────────────────────────────────
// JWT auth — token carries { user_id, username, role, display_name }
function auth(req, res, next) {
  const token = req.headers['x-app-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Admin-only routes — must run after auth()
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
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

// Current session's user info
app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password_hash, ...safeUser } = user;
    res.json(safeUser);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: user management ────────────────────────────────────────
app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json(users);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/users', auth, requireAdmin, async (req, res) => {
  const { username, password, displayName, email, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (role && !['admin', 'member'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin or member' });
  }

  try {
    const existing = await db.getUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'Username already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.createUser({ username, passwordHash, displayName, email, role });
    res.json(user);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', auth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.user_id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  try {
    await db.deleteUser(id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/users/:id/reset-password', auth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'newPassword required' });

  try {
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(id, passwordHash);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/test-email', auth, requireAdmin, async (req, res) => {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    return res.status(400).json({ error: 'GMAIL_USER/GMAIL_APP_PASSWORD not configured' });
  }

  try {
    const nodemailer  = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    await transporter.sendMail({
      from: `"MarketLens" <${gmailUser}>`,
      to: gmailUser,
      subject: `✅ MarketLens test email - ${timestamp}`,
      text: 'This is a test email from MarketLens. Server is running correctly.',
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Screener feed (cached, no FMP call)
app.get('/api/screener', auth, async (req, res) => {
  try {
    const data = await db.getScreener();
    res.json(data);
  } catch(e) {
    console.error('[db] getScreener failed, falling back to store:', e.message);
    const data   = store.read('screener', []);
    const upside = store.read('screener_upside', {});
    // Attach upside to each entry
    const enriched = data.map(x => ({
      ...x,
      upsideData: upside[x.symbol] || null,
    }));
    res.json(enriched);
  }
});

// Quote — serve from cache, refresh if stale
// ── Symbol search (header autocomplete) ───────────────────────────
// In-memory cache keyed by lowercased query (5 min TTL) to avoid hammering FMP
// while the user types. Bounded to keep memory in check.
const searchCache = {}; // { [q]: { results, ts } }
const SEARCH_TTL  = 5 * 60 * 1000;
let lastSearchAt  = 0;  // global cooldown timestamp — throttles FMP search calls
const SEARCH_COOLDOWN = 500; // ms
app.get('/api/search', auth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const key = q.toLowerCase();

  const cached = searchCache[key];
  if (cached && Date.now() - cached.ts < SEARCH_TTL) {
    return res.json(cached.results);
  }

  // Cooldown: if a search hit FMP <500ms ago, don't fire another — serve whatever
  // we have cached for this query (even if stale) or []. Prevents keystroke floods.
  if (Date.now() - lastSearchAt < SEARCH_COOLDOWN) {
    return res.json(cached ? cached.results : []);
  }
  lastSearchAt = Date.now();

  try {
    const raw = await fmp.search(q, 8);
    const results = raw.slice(0, 8).map(r => ({
      symbol:   r.symbol,
      name:     r.name || '',
      exchange: r.exchangeShortName || r.stockExchange || '',
    }));

    // Bound the cache — drop the oldest entry once it grows too large
    const keys = Object.keys(searchCache);
    if (keys.length > 200) {
      let oldest = keys[0];
      for (const k of keys) if (searchCache[k].ts < searchCache[oldest].ts) oldest = k;
      delete searchCache[oldest];
    }
    searchCache[key] = { results, ts: Date.now() };

    res.json(results);
  } catch(e) {
    console.error(`[fmp] search failed for "${q}":`, e.message);
    res.status(502).json({ error: 'search failed' });
  }
});

app.get('/api/quote/:sym', auth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();

  // Stale if older than 15 min during market hours, 4h otherwise
  const ttl = isMarketOpen() ? 15 * 60 * 1000 : 4 * 60 * 60 * 1000;

  let cached;
  try {
    cached = await db.getCachedQuote(sym);
  } catch(e) {
    console.error(`[db] getCachedQuote failed for ${sym}:`, e.message);
    cached = null;
  }
  const age = cached ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;

  if (cached && age < ttl) {
    return res.json({ ...cached, fromCache: true });
  }

  try {
    const quote = await fmp.getQuote(sym);
    if (quote) {
      try {
        await db.setCachedQuote(sym, quote);
      } catch(e) {
        console.error(`[db] setCachedQuote failed for ${sym}:`, e.message);
      }
    }
    res.json({ ...quote, fromCache: false });
  } catch(e) {
    if (cached) return res.json({ ...cached, fromCache: true, stale: true });
    res.status(500).json({ error: e.message });
  }
});

// Grades for a symbol — serve from cache (6h TTL), refresh if stale
app.get('/api/grades/:sym', auth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const ttl = 6 * 60 * 60 * 1000;

  let cached;
  try {
    cached = await db.getCachedGrades(sym);
  } catch(e) {
    console.error(`[db] getCachedGrades failed for ${sym}:`, e.message);
    cached = null;
  }
  const age = cached ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;

  if (cached && age < ttl) {
    return res.json(cached.data);
  }

  try {
    const data = await fmp.getGrades(sym);
    try {
      await db.setCachedGrades(sym, data);
    } catch(e) {
      console.error(`[db] setCachedGrades failed for ${sym}:`, e.message);
    }
    res.json(data);
  } catch(e) {
    if (cached) return res.json(cached.data);
    res.status(500).json({ error: e.message });
  }
});

// Price target — serve from cache (6h TTL), refresh if stale
app.get('/api/target/:sym', auth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const ttl = 6 * 60 * 60 * 1000;

  let cached;
  try {
    cached = await db.getCachedTarget(sym);
  } catch(e) {
    console.error(`[db] getCachedTarget failed for ${sym}:`, e.message);
    cached = null;
  }
  const age = cached ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;

  if (cached && age < ttl) {
    return res.json(cached.data);
  }

  try {
    const data = await fmp.getTarget(sym);
    try {
      await db.setCachedTarget(sym, data);
    } catch(e) {
      console.error(`[db] setCachedTarget failed for ${sym}:`, e.message);
    }
    res.json(data);
  } catch(e) {
    if (cached) return res.json(cached.data);
    res.status(500).json({ error: e.message });
  }
});

// Historical prices — serve from price_history, lazily backfill on insufficient coverage
app.get('/api/history/:sym', auth, async (req, res) => {
  const sym  = req.params.sym.toUpperCase();
  const from = req.query.from || (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();

  try {
    let rows = await db.getHistory(sym, from);

    // Coverage check — do the cached rows span at least 80% of the requested range?
    const fromDate = new Date(from);
    const today = new Date();
    const requestedDays = Math.max(1, Math.round((today - fromDate) / (1000 * 60 * 60 * 24)));
    const earliest = rows.length ? new Date(rows[0].date) : null;
    const latest   = rows.length ? new Date(rows[rows.length - 1].date) : null;
    const coveredDays = earliest && latest
      ? Math.round((latest - earliest) / (1000 * 60 * 60 * 24))
      : 0;
    // Recency check — span coverage alone can pass while the latest row is days
    // stale (missing the most recent trading days). Require the latest row to be
    // within 3 calendar days of today, otherwise re-fetch to pull the gap.
    const latestAgeDays = latest
      ? Math.round((today - latest) / (1000 * 60 * 60 * 24))
      : Infinity;
    const coverageOk = rows.length > 0
      && coveredDays >= requestedDays * 0.8
      && latestAgeDays <= 3;

    if (!coverageOk) {
      const fresh = await fmp.getHistory(sym, from);
      const freshRows = (fresh || [])
        .map(d => ({ date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }))
        .filter(r => r.date && r.close != null);
      if (freshRows.length) {
        try {
          await db.upsertHistory(sym, freshRows);
          rows = await db.getHistory(sym, from);
        } catch(e) {
          console.error(`[db] upsertHistory failed for ${sym}:`, e.message);
        }
      }
    }

    // Defense in depth — db.getHistory() already returns plain "YYYY-MM-DD"
    // strings, but normalize here too so this endpoint's contract holds even
    // if a row ever comes through as a raw Date object
    res.json(rows.map(r => ({ ...r, date: new Date(r.date).toISOString().slice(0, 10) })));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Earnings — serve from cache (24h TTL), refresh if stale
app.get('/api/earnings/:sym', auth, async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  const ttl = 24 * 60 * 60 * 1000;

  let cached;
  try {
    cached = await db.getCachedEarnings(sym);
  } catch(e) {
    console.error(`[db] getCachedEarnings failed for ${sym}:`, e.message);
    cached = null;
  }
  const age = cached ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;

  if (cached && age < ttl) {
    return res.json(cached.data);
  }

  try {
    const data = await fmp.getEarnings(sym);
    try {
      await db.setCachedEarnings(sym, data);
    } catch(e) {
      console.error(`[db] setCachedEarnings failed for ${sym}:`, e.message);
    }
    res.json(data);
  } catch(e) {
    if (cached) return res.json(cached.data);
    res.status(500).json({ error: e.message });
  }
});

// Overview — cached quotes for fixed index/sector/commodity benchmark symbols
const OVERVIEW_SYMBOLS = ['SPY', 'QQQ', 'VXX', 'XBI', 'XPH', 'XLV', 'IWM', 'USO', 'GLD', 'UUP'];

app.get('/api/overview', auth, async (req, res) => {
  try {
    const entries = await Promise.all(OVERVIEW_SYMBOLS.map(async sym => {
      try {
        let cached = await db.getCachedQuote(sym);
        if (!cached) {
          const quote = await fmp.getQuote(sym);
          if (quote) {
            try {
              await db.setCachedQuote(sym, quote);
            } catch(e) {
              console.error(`[db] setCachedQuote failed for ${sym}:`, e.message);
            }
          }
          cached = quote || null;
        }
        return [sym, cached];
      } catch(e) {
        console.error(`[db] getCachedQuote failed for ${sym}:`, e.message);
        return [sym, null];
      }
    }));
    const bySymbol = {};
    entries.forEach(([sym, data]) => { if (data) bySymbol[sym] = data; });
    res.json(bySymbol);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Signals (cached)
app.get('/api/signals', auth, async (req, res) => {
  try {
    const data = await db.getSignals();
    res.json(data);
  } catch(e) {
    console.error('[db] getSignals failed, falling back to store:', e.message);
    res.json(store.read('signals', {}));
  }
});

// Signal log (cached)
app.get('/api/signal-log', auth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  try {
    const log = await db.getSignalLog(limit);
    res.json(log);
  } catch(e) {
    console.error('[db] getSignalLog failed, falling back to store:', e.message);
    const log = store.read('signal_log', []);
    res.json(log.slice(0, limit));
  }
});

// Watchlist — per-user, read/write from server (shared across devices!)
app.get('/api/watchlist', auth, async (req, res) => {
  try {
    const data = await db.getWatchlist(req.user.user_id);
    res.json(data);
  } catch(e) {
    console.error('[db] getWatchlist failed, falling back to store:', e.message);
    res.json(store.read('watchlist', []));
  }
});

app.post('/api/watchlist', auth, async (req, res) => {
  const { symbols } = req.body;
  if (!Array.isArray(symbols)) return res.status(400).json({ error: 'symbols must be array' });
  try {
    await db.saveWatchlist(symbols, req.user.user_id);
  } catch(e) {
    console.error('[db] saveWatchlist failed, falling back to store:', e.message);
    store.write('watchlist', symbols);
  }
  res.json({ ok: true, symbols });
  rebuildRefreshQueue().catch(e => console.error('[cron] rebuildRefreshQueue failed:', e.message));
});

// Practice accounts — per-user, sync across devices
app.get('/api/practice', auth, async (req, res) => {
  try {
    const data = await db.getPractice(req.user.user_id);
    res.json(data);
  } catch(e) {
    console.error('[db] getPractice failed, falling back to store:', e.message);
    res.json(store.read('practice', []));
  }
});

app.post('/api/practice', auth, async (req, res) => {
  const { accounts } = req.body;
  if (!Array.isArray(accounts)) return res.status(400).json({ error: 'accounts must be array' });
  try {
    await db.savePractice(accounts, req.user.user_id);
  } catch(e) {
    console.error('[db] savePractice failed, falling back to store:', e.message);
    store.write('practice', accounts);
  }
  res.json({ ok: true });
  rebuildRefreshQueue().catch(e => console.error('[cron] rebuildRefreshQueue failed:', e.message));
});

// Portfolio — per-user, sync across devices
app.get('/api/portfolio', auth, async (req, res) => {
  try {
    const data = await db.getPortfolio(req.user.user_id);
    res.json(data);
  } catch(e) {
    console.error('[db] getPortfolio failed, falling back to store:', e.message);
    res.json(store.read('portfolio', { open: [], closed: [] }));
  }
});

app.post('/api/portfolio', auth, async (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ error: 'No data' });
  try {
    await db.savePortfolio(data, req.user.user_id);
  } catch(e) {
    console.error('[db] savePortfolio failed, falling back to store:', e.message);
    store.write('portfolio', data);
  }
  res.json({ ok: true });
  rebuildRefreshQueue().catch(e => console.error('[cron] rebuildRefreshQueue failed:', e.message));
});

// ── Trigger manual refresh ────────────────────────────────────────
app.post('/api/refresh', auth, async (req, res) => {
  const { collectScreenerFeed, rebuildRefreshQueue } = require('./cron');
  res.json({ ok: true, message: 'Refresh started' });
  // Run async after response: refresh the screener feed and rebuild the rolling
  // per-symbol queue so any newly-added symbols enter the rotation immediately.
  // (Individual symbol refreshes are drained one-per-minute by the queue job.)
  collectScreenerFeed().then(() => rebuildRefreshQueue());
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
async function start() {
  try {
    await db.initSchema();
  } catch(e) {
    console.error('[db] initSchema failed, continuing with store.js fallback:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 MarketLens server running on port ${PORT}`);
    console.log(`   Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`   API:       http://localhost:${PORT}/api/health\n`);
    startCronJobs();
  });
}

start();
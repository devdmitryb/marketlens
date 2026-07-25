require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const store   = require('./store');
const db      = require('./db');
const fmp     = require('./fmp');
const { startCronJobs } = require('./cron');

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
});

// ── Trigger manual refresh ────────────────────────────────────────
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
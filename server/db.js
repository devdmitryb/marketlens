// PostgreSQL connection via Supabase
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Supabase
});

// Test connection on startup
pool.query('SELECT NOW()').then(() => {
  console.log('✅ PostgreSQL connected (Supabase)');
}).catch(err => {
  console.error('❌ PostgreSQL connection failed:', err.message);
});

// ── Schema setup ──────────────────────────────────────────────────
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS watchlist (
        id         SERIAL PRIMARY KEY,
        symbol     TEXT NOT NULL UNIQUE,
        added_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS portfolio (
        id         SERIAL PRIMARY KEY,
        data       JSONB NOT NULL DEFAULT '{"open":[],"closed":[]}'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS practice (
        id         SERIAL PRIMARY KEY,
        data       JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS signals (
        id         SERIAL PRIMARY KEY,
        symbol     TEXT NOT NULL UNIQUE,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS signal_log (
        id         SERIAL PRIMARY KEY,
        symbol     TEXT NOT NULL,
        new_signal TEXT,
        old_signal TEXT,
        reason     TEXT,
        source     TEXT DEFAULT 'server',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS screener (
        id           SERIAL PRIMARY KEY,
        news_url     TEXT NOT NULL UNIQUE,
        symbol       TEXT,
        data         JSONB NOT NULL,
        upside_data  JSONB,
        published_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS quotes_cache (
        symbol     TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS grades_cache (
        symbol     TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS target_cache (
        symbol     TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('[db] Schema ready ✅');
  } finally {
    client.release();
  }
}

// ── Helper functions ──────────────────────────────────────────────

// Watchlist
async function getWatchlist() {
  const res = await pool.query('SELECT symbol FROM watchlist ORDER BY added_at');
  return res.rows.map(r => r.symbol);
}

async function saveWatchlist(symbols) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM watchlist');
    for (const sym of symbols) {
      await client.query(
        'INSERT INTO watchlist (symbol) VALUES ($1) ON CONFLICT (symbol) DO NOTHING',
        [sym]
      );
    }
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Portfolio (stored as single JSON blob)
async function getPortfolio() {
  const res = await pool.query('SELECT data FROM portfolio LIMIT 1');
  return res.rows[0]?.data || { open: [], closed: [] };
}

async function savePortfolio(data) {
  await pool.query(`
    INSERT INTO portfolio (id, data, updated_at) VALUES (1, $1, NOW())
    ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()
  `, [JSON.stringify(data)]);
}

// Practice (stored as single JSON blob)
async function getPractice() {
  const res = await pool.query('SELECT data FROM practice LIMIT 1');
  return res.rows[0]?.data || [];
}

async function savePractice(accounts) {
  await pool.query(`
    INSERT INTO practice (id, data, updated_at) VALUES (1, $1, NOW())
    ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()
  `, [JSON.stringify(accounts)]);
}

// Signals
async function getSignals() {
  const res = await pool.query('SELECT symbol, data FROM signals');
  const out = {};
  res.rows.forEach(r => { out[r.symbol] = r.data; });
  return out;
}

async function saveSignal(symbol, data) {
  await pool.query(`
    INSERT INTO signals (symbol, data, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (symbol) DO UPDATE SET data = $2, updated_at = NOW()
  `, [symbol, JSON.stringify(data)]);
}

// Signal log
async function getSignalLog(limit = 200) {
  const res = await pool.query(
    'SELECT * FROM signal_log ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return res.rows.map(r => ({
    id:        r.id,
    ts:        r.created_at,
    sym:       r.symbol,
    newSignal: r.new_signal,
    oldSignal: r.old_signal,
    reason:    r.reason,
    source:    r.source,
  }));
}

async function addSignalLog(sym, newSignal, oldSignal, reason) {
  await pool.query(
    'INSERT INTO signal_log (symbol, new_signal, old_signal, reason) VALUES ($1, $2, $3, $4)',
    [sym, newSignal, oldSignal, reason]
  );
  // Keep only last 500 entries
  await pool.query(`
    DELETE FROM signal_log WHERE id NOT IN (
      SELECT id FROM signal_log ORDER BY created_at DESC LIMIT 500
    )
  `);
}

// Screener
async function getScreener() {
  const res = await pool.query(
    'SELECT data, upside_data FROM screener ORDER BY published_at DESC LIMIT 500'
  );
  return res.rows.map(r => ({ ...r.data, upsideData: r.upside_data }));
}

async function saveScreenerEntry(entry) {
  await pool.query(`
    INSERT INTO screener (news_url, symbol, data, published_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (news_url) DO NOTHING
  `, [entry.newsURL, entry.symbol, JSON.stringify(entry), entry.publishedDate]);
  // Prune entries older than 90 days
  await pool.query(`DELETE FROM screener WHERE published_at < NOW() - INTERVAL '90 days'`);
}

async function updateScreenerUpside(symbol, upsideData) {
  await pool.query(
    'UPDATE screener SET upside_data = $1 WHERE symbol = $2',
    [JSON.stringify(upsideData), symbol]
  );
}

// Quotes cache
async function getCachedQuote(symbol) {
  const res = await pool.query('SELECT data, updated_at FROM quotes_cache WHERE symbol = $1', [symbol]);
  return res.rows[0] ? { ...res.rows[0].data, cachedAt: res.rows[0].updated_at } : null;
}

async function setCachedQuote(symbol, data) {
  await pool.query(`
    INSERT INTO quotes_cache (symbol, data, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (symbol) DO UPDATE SET data = $2, updated_at = NOW()
  `, [symbol, JSON.stringify(data)]);
}

// Grades cache
async function getCachedGrades(symbol) {
  const res = await pool.query('SELECT data, updated_at FROM grades_cache WHERE symbol = $1', [symbol]);
  return res.rows[0] ? { data: res.rows[0].data, cachedAt: res.rows[0].updated_at } : null;
}

async function setCachedGrades(symbol, data) {
  await pool.query(`
    INSERT INTO grades_cache (symbol, data, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (symbol) DO UPDATE SET data = $2, updated_at = NOW()
  `, [symbol, JSON.stringify(data)]);
}

// Target cache
async function getCachedTarget(symbol) {
  const res = await pool.query('SELECT data, updated_at FROM target_cache WHERE symbol = $1', [symbol]);
  return res.rows[0] ? { data: res.rows[0].data, cachedAt: res.rows[0].updated_at } : null;
}

async function setCachedTarget(symbol, data) {
  await pool.query(`
    INSERT INTO target_cache (symbol, data, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (symbol) DO UPDATE SET data = $2, updated_at = NOW()
  `, [symbol, JSON.stringify(data)]);
}

module.exports = {
  pool,
  initSchema,
  getWatchlist, saveWatchlist,
  getPortfolio, savePortfolio,
  getPractice,  savePractice,
  getSignals,   saveSignal,
  getSignalLog, addSignalLog,
  getScreener,  saveScreenerEntry, updateScreenerUpside,
  getCachedQuote,  setCachedQuote,
  getCachedGrades, setCachedGrades,
  getCachedTarget, setCachedTarget,
};
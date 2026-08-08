// PostgreSQL connection via Supabase
const { Pool }  = require('pg');
const bcrypt    = require('bcrypt');

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
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT,
        email         TEXT,
        role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        last_active   TIMESTAMPTZ
      );

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

      CREATE TABLE IF NOT EXISTS price_history (
        symbol      TEXT NOT NULL,
        date        DATE NOT NULL,
        open        NUMERIC,
        high        NUMERIC,
        low         NUMERIC,
        close       NUMERIC NOT NULL,
        volume      BIGINT,
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (symbol, date)
      );
      CREATE INDEX IF NOT EXISTS price_history_symbol_date_idx ON price_history(symbol, date DESC);

      CREATE TABLE IF NOT EXISTS earnings_cache (
        symbol     TEXT PRIMARY KEY,
        data       JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await migrateToMultiUser(client);

    console.log('[db] Schema ready ✅');
  } finally {
    client.release();
  }
}

// ── Multiuser migration: add user_id, backfill onto a bootstrap admin ──
async function migrateToMultiUser(client) {
  try {
    await client.query('BEGIN');

    await client.query('ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
    await client.query('ALTER TABLE portfolio ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
    await client.query('ALTER TABLE practice  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');

    // Symbols are now scoped per user, not global
    await client.query('ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_symbol_key');

    // Bootstrap admin user from APP_PASSWORD (only if no users exist yet)
    const { rows: userCountRows } = await client.query('SELECT COUNT(*)::int AS count FROM users');
    let adminId = null;

    if (userCountRows[0].count === 0) {
      if (process.env.APP_PASSWORD) {
        const passwordHash = await bcrypt.hash(process.env.APP_PASSWORD, 10);
        const { rows } = await client.query(
          `INSERT INTO users (username, password_hash, display_name, role)
           VALUES ($1, $2, $3, 'admin') RETURNING id`,
          [process.env.ADMIN_USERNAME || 'admin', passwordHash, 'Admin']
        );
        adminId = rows[0].id;
        console.log(`[db] Bootstrapped admin user '${process.env.ADMIN_USERNAME || 'admin'}' (id=${adminId})`);
      } else {
        console.warn('[db] APP_PASSWORD not set — skipping admin bootstrap; user_id backfill deferred to next startup');
      }
    } else {
      const { rows } = await client.query(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`);
      adminId = rows[0]?.id ?? null;
    }

    if (adminId) {
      await client.query('UPDATE watchlist SET user_id = $1 WHERE user_id IS NULL', [adminId]);
      await client.query('UPDATE portfolio SET user_id = $1 WHERE user_id IS NULL', [adminId]);
      await client.query('UPDATE practice  SET user_id = $1 WHERE user_id IS NULL', [adminId]);
    }

    // Only enforce NOT NULL + uniqueness once every row is backfilled —
    // otherwise leave nullable and self-heal on a later startup
    const { rows: nullCheckRows } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM watchlist WHERE user_id IS NULL)::int AS watchlist,
        (SELECT COUNT(*) FROM portfolio WHERE user_id IS NULL)::int AS portfolio,
        (SELECT COUNT(*) FROM practice  WHERE user_id IS NULL)::int AS practice
    `);
    const nulls = nullCheckRows[0];

    if (nulls.watchlist === 0) {
      await client.query('ALTER TABLE watchlist ALTER COLUMN user_id SET NOT NULL');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS watchlist_user_symbol_idx ON watchlist(user_id, symbol)');
    } else {
      console.warn(`[db] watchlist: ${nulls.watchlist} row(s) missing user_id — deferring NOT NULL/index`);
    }

    if (nulls.portfolio === 0) {
      await client.query('ALTER TABLE portfolio ALTER COLUMN user_id SET NOT NULL');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS portfolio_user_idx ON portfolio(user_id)');
    } else {
      console.warn(`[db] portfolio: ${nulls.portfolio} row(s) missing user_id — deferring NOT NULL/index`);
    }

    if (nulls.practice === 0) {
      await client.query('ALTER TABLE practice ALTER COLUMN user_id SET NOT NULL');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS practice_user_idx ON practice(user_id)');
    } else {
      console.warn(`[db] practice: ${nulls.practice} row(s) missing user_id — deferring NOT NULL/index`);
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

// ── Helper functions ──────────────────────────────────────────────

// Resolves the implicit user for callers that don't pass userId yet
// (Phase 1: no JWT wiring, so index.js/cron.js keep calling these unchanged)
let cachedAdminId = null;
async function getDefaultUserId() {
  if (cachedAdminId) return cachedAdminId;
  const res = await pool.query(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`);
  cachedAdminId = res.rows[0]?.id ?? null;
  return cachedAdminId;
}

// Watchlist
async function getWatchlist(userId) {
  const uid = userId ?? await getDefaultUserId();
  const res = await pool.query('SELECT symbol FROM watchlist WHERE user_id = $1 ORDER BY added_at', [uid]);
  return res.rows.map(r => r.symbol);
}

async function saveWatchlist(symbols, userId) {
  const uid = userId ?? await getDefaultUserId();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM watchlist WHERE user_id = $1', [uid]);
    for (const sym of symbols) {
      await client.query(
        'INSERT INTO watchlist (user_id, symbol) VALUES ($1, $2) ON CONFLICT (user_id, symbol) DO NOTHING',
        [uid, sym]
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

// Portfolio (stored as single JSON blob per user)
async function getPortfolio(userId) {
  const uid = userId ?? await getDefaultUserId();
  const res = await pool.query('SELECT data FROM portfolio WHERE user_id = $1', [uid]);
  return res.rows[0]?.data || { open: [], closed: [] };
}

async function savePortfolio(data, userId) {
  const uid = userId ?? await getDefaultUserId();
  await pool.query(`
    INSERT INTO portfolio (user_id, data, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = NOW()
  `, [uid, JSON.stringify(data)]);
}

// Practice (stored as single JSON blob per user)
async function getPractice(userId) {
  const uid = userId ?? await getDefaultUserId();
  const res = await pool.query('SELECT data FROM practice WHERE user_id = $1', [uid]);
  return res.rows[0]?.data || [];
}

async function savePractice(accounts, userId) {
  const uid = userId ?? await getDefaultUserId();
  await pool.query(`
    INSERT INTO practice (user_id, data, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = NOW()
  `, [uid, JSON.stringify(accounts)]);
}

// Users
async function getUserByUsername(username) {
  const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return res.rows[0] || null;
}

async function getUserById(id) {
  const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function getUsers() {
  const res = await pool.query(
    'SELECT id, username, display_name, email, role, created_at, last_active FROM users ORDER BY created_at'
  );
  return res.rows;
}

async function createUser({ username, passwordHash, displayName, email, role = 'member' }) {
  const res = await pool.query(
    `INSERT INTO users (username, password_hash, display_name, email, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, username, display_name, email, role, created_at`,
    [username, passwordHash, displayName || null, email || null, role]
  );
  return res.rows[0];
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
}

async function updateUserPassword(id, passwordHash) {
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
}

async function touchLastActive(id) {
  await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [id]);
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
  // Skip when there's nothing to store — JSON.stringify(undefined) is undefined,
  // which pg sends as SQL NULL and violates the data NOT NULL constraint.
  if (data == null) return;
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
  // Skip when there's nothing to store (see setCachedQuote) — avoids a NULL data insert.
  if (data == null) return;
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
  // Skip when there's nothing to store (see setCachedQuote) — avoids a NULL data insert.
  if (data == null) return;
  await pool.query(`
    INSERT INTO target_cache (symbol, data, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (symbol) DO UPDATE SET data = $2, updated_at = NOW()
  `, [symbol, JSON.stringify(data)]);
}

// Price history
// Date is cast to text via TO_CHAR — otherwise `pg` parses the DATE column into
// a JS Date object, which JSON.stringify then renders as a full ISO timestamp
// ("2023-08-02T00:00:00.000Z") instead of the plain "YYYY-MM-DD" callers expect
async function getHistory(symbol, fromDate) {
  const res = await pool.query(
    `SELECT symbol, TO_CHAR(date, 'YYYY-MM-DD') AS date, open, high, low, close, volume
     FROM price_history WHERE symbol = $1 AND date >= $2 ORDER BY date ASC`,
    [symbol, fromDate]
  );
  return res.rows;
}

async function upsertHistory(symbol, rows) {
  if (!rows || !rows.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(`
        INSERT INTO price_history (symbol, date, open, high, low, close, volume, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (symbol, date) DO UPDATE SET
          open = $3, high = $4, low = $5, close = $6, volume = $7, updated_at = NOW()
      `, [symbol, row.date, row.open, row.high, row.low, row.close, row.volume]);
    }
    await client.query('COMMIT');
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Earnings cache
async function getCachedEarnings(symbol) {
  const res = await pool.query('SELECT data, updated_at FROM earnings_cache WHERE symbol = $1', [symbol]);
  return res.rows[0] ? { data: res.rows[0].data, cachedAt: res.rows[0].updated_at } : null;
}

async function setCachedEarnings(symbol, data) {
  // Skip when there's nothing to store (see setCachedQuote) — avoids a NULL data insert.
  if (data == null) return;
  await pool.query(`
    INSERT INTO earnings_cache (symbol, data, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (symbol) DO UPDATE SET data = $2, updated_at = NOW()
  `, [symbol, JSON.stringify(data)]);
}

module.exports = {
  pool,
  initSchema,
  getWatchlist, saveWatchlist,
  getPortfolio, savePortfolio,
  getPractice,  savePractice,
  getUserByUsername, getUserById, getUsers,
  createUser, deleteUser, updateUserPassword, touchLastActive,
  getSignals,   saveSignal,
  getSignalLog, addSignalLog,
  getScreener,  saveScreenerEntry, updateScreenerUpside,
  getCachedQuote,  setCachedQuote,
  getCachedGrades, setCachedGrades,
  getCachedTarget, setCachedTarget,
  getHistory, upsertHistory,
  getCachedEarnings, setCachedEarnings,
};
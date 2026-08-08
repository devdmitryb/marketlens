// Scheduled data collection jobs
const cron  = require('node-cron');
const fmp   = require('./fmp');
const store = require('./store');
const db    = require('./db');
const { calcMomentum, calcSignal, tallyGrades } = require('./signals');

// Delay between individual FMP calls within a single symbol's refresh (avoid 429s)
const FMP_DELAY = 800;

// Is NYSE market open right now?
function isMarketOpen() {
  const now = new Date();
  const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30-16:00
}

// ── JOB 1: Screener feed ──────────────────────────────────────────
// Every 2 hours during market hours, every 6 hours outside
async function collectScreenerFeed() {
  console.log('[cron] Collecting screener feed…');
  try {
    const fresh = await fmp.getGradesLatestNews(100);
    if (!fresh.length) return;

    try {
      // Merge with existing — deduplicate by newsURL
      const existing = await db.getScreener();
      const existingUrls = new Set(existing.map(e => e.newsURL));
      const newEntries   = fresh.filter(e => !existingUrls.has(e.newsURL));

      if (newEntries.length > 0) {
        for (const entry of newEntries) {
          await db.saveScreenerEntry(entry);
        }
      }

      const all = await db.getScreener();
      store.write('screener_meta', { lastUpdated: new Date().toISOString(), count: all.length });
      console.log(`[cron] Screener: +${newEntries.length} new, total: ${all.length} (90d window)`);
    } catch(dbErr) {
      console.error('[db] Screener update failed, falling back to store:', dbErr.message);

      // Merge with existing — deduplicate by newsURL
      const existing = store.read('screener', []);
      const existingUrls = new Set(existing.map(e => e.newsURL));
      const newEntries   = fresh.filter(e => !existingUrls.has(e.newsURL));

      if (newEntries.length > 0) {
        // Keep entries newer than 90 days
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const filtered = [...newEntries, ...existing].filter(e =>
          new Date(e.publishedDate) >= cutoff
        );
        store.write('screener', filtered);
        console.log(`[cron] Screener (fallback): +${newEntries.length} new, total: ${filtered.length} (90d window)`);
      } else {
        console.log('[cron] Screener (fallback): no new entries');
      }

      store.write('screener_meta', { lastUpdated: new Date().toISOString(), count: store.read('screener', []).length });
    }
  } catch(e) {
    console.error('[cron] Screener error:', e.message);
  }
}

// ── JOB 2: Rolling per-symbol refresh queue (all users) ──────────
// Instead of refreshing every symbol in one bulk loop every 2h, we process ONE
// symbol per minute from a rolling queue. Each symbol is refreshed roughly every
// (queue length) minutes — ~100 symbols → ~100 min per symbol — which spreads FMP
// load out evenly instead of bursting. The queue is (re)built on startup, whenever
// it drains, and on demand after a user changes their watchlist/portfolio/practice.
let refreshQueue    = [];   // symbols still to process this cycle
let refreshHoldings = [];   // snapshot of every user's holdings, for signal-change alerts
let refreshingNow   = false; // guards against overlapping minute ticks

// Build the queue = union of every symbol any user tracks (watchlist + open
// portfolio + open practice), and snapshot holdings so we know who to alert.
async function buildRefreshQueue() {
  let users;
  try {
    users = await db.getUsers();
  } catch(e) {
    console.error('[cron] buildRefreshQueue: getUsers failed:', e.message);
    return;
  }

  // One user's failure doesn't block the others (no per-user store.js fallback:
  // it predates multiuser and has no concept of separate users' data)
  const holdings = [];
  for (const user of users) {
    try {
      const [watchlist, portfolio, practice] = await Promise.all([
        db.getWatchlist(user.id),
        db.getPortfolio(user.id),
        db.getPractice(user.id),
      ]);
      holdings.push({
        user,
        watchlist,
        portfolioSyms: (portfolio.open || []).map(p => p.sym),
        practiceSyms:  practice.flatMap(a => (a.open || []).map(p => p.sym)),
      });
    } catch(e) {
      console.error(`[cron] buildRefreshQueue: holdings load failed for ${user.username}, skipping them:`, e.message);
    }
  }

  refreshHoldings = holdings;
  refreshQueue = [...new Set(holdings.flatMap(h => [...h.watchlist, ...h.portfolioSyms, ...h.practiceSyms]))];
  console.log(`[cron] Refresh queue built: ${refreshQueue.length} symbols across ${holdings.length} users`);
}

// Exposed so index.js can rebuild the queue right after a user mutates their
// watchlist/portfolio/practice, so newly-added symbols enter the rotation promptly.
async function rebuildRefreshQueue() {
  await buildRefreshQueue();
}

// Process the next symbol from the queue. Called once per minute. Rebuilds the
// queue when it empties so the rotation runs forever.
async function refreshNextSymbol() {
  if (refreshingNow) return; // previous tick still running — skip this one
  refreshingNow = true;
  try {
    if (!refreshQueue.length) {
      await buildRefreshQueue();
      if (!refreshQueue.length) return; // no symbols tracked by anyone yet
    }
    const sym = refreshQueue.shift();
    try {
      await refreshSymbol(sym, refreshHoldings);
    } catch(e) {
      console.error(`[cron] Error refreshing ${sym}:`, e.message);
    }
  } finally {
    refreshingNow = false;
  }
}

// Full refresh of a single symbol: quote + grades + target (6h cached) +
// incremental price_history + earnings (24h cached), then the full momentum
// signal. FMP calls are made sequentially with FMP_DELAY between them.
async function refreshSymbol(sym, holdings) {
  const now = Date.now();
  const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours for grades/target

  // 1. Quote — always fetched fresh
  const quote = await fmp.getQuote(sym);
  await sleep(FMP_DELAY);
  if (quote) {
    try {
      await db.setCachedQuote(sym, quote);
    } catch(e) {
      console.error(`[db] setCachedQuote failed for ${sym}, falling back to store:`, e.message);
      const quotes = store.read('quotes', {});
      quotes[sym] = { ...quote, cachedAt: new Date().toISOString() };
      store.write('quotes', quotes);
    }
  }

  // 2. Grades + target — served from 6h cache, only hit FMP when stale
  let cachedGrades, cachedTarget;
  try {
    [cachedGrades, cachedTarget] = await Promise.all([
      db.getCachedGrades(sym),
      db.getCachedTarget(sym),
    ]);
  } catch(e) {
    console.error(`[db] Cache lookup failed for ${sym}, falling back to store:`, e.message);
    const gradeCache  = store.read('grades_cache', {});
    const targetCache = store.read('target_cache', {});
    cachedGrades = gradeCache[sym]  || null;
    cachedTarget = targetCache[sym] || null;
  }

  const gradesFresh = cachedGrades && (now - new Date(cachedGrades.cachedAt).getTime()) < CACHE_TTL;
  let grades;
  if (gradesFresh) {
    grades = cachedGrades.data;
  } else {
    grades = await fmp.getGrades(sym);
    await sleep(FMP_DELAY);
    if (grades) {
      try {
        await db.setCachedGrades(sym, grades);
      } catch(e) {
        console.error(`[db] setCachedGrades failed for ${sym}, falling back to store:`, e.message);
        const gradeCache = store.read('grades_cache', {});
        gradeCache[sym] = { data: grades, cachedAt: new Date().toISOString() };
        store.write('grades_cache', gradeCache);
      }
    }
  }

  const targetFresh = cachedTarget && (now - new Date(cachedTarget.cachedAt).getTime()) < CACHE_TTL;
  let target;
  if (targetFresh) {
    target = cachedTarget.data;
  } else {
    target = await fmp.getTarget(sym);
    await sleep(FMP_DELAY);
    if (target) {
      try {
        await db.setCachedTarget(sym, target);
      } catch(e) {
        console.error(`[db] setCachedTarget failed for ${sym}, falling back to store:`, e.message);
        const targetCache = store.read('target_cache', {});
        targetCache[sym] = { data: target, cachedAt: new Date().toISOString() };
        store.write('target_cache', targetCache);
      }
    }
  }

  // 3. Price history — incremental upsert (full 90d backfill on first sighting)
  try {
    const { rows: maxRows } = await db.pool.query(
      'SELECT MAX(date) AS max_date FROM price_history WHERE symbol = $1',
      [sym]
    );
    const maxDateStr = maxRows[0]?.max_date
      ? new Date(maxRows[0].max_date).toISOString().slice(0, 10)
      : null;
    const todayStr = new Date().toISOString().slice(0, 10);

    let histFromStr = null;
    if (!maxDateStr) {
      const from90 = new Date(); from90.setDate(from90.getDate() - 90);
      histFromStr = from90.toISOString().slice(0, 10);
    } else if (maxDateStr < todayStr) {
      const nextDay = new Date(maxDateStr); nextDay.setDate(nextDay.getDate() + 1);
      histFromStr = nextDay.toISOString().slice(0, 10);
    } // else already up to date — skip fetch

    if (histFromStr) {
      const histData = await fmp.getHistory(sym, histFromStr);
      await sleep(FMP_DELAY);
      const histRows = (histData || [])
        .map(d => ({ date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }))
        .filter(r => r.date && r.close != null);
      if (histRows.length) await db.upsertHistory(sym, histRows);
    }
  } catch(e) {
    console.error(`[cron] Price history update failed for ${sym}:`, e.message);
  }

  // 4. Earnings cache — 24h TTL
  try {
    const cachedEarnings = await db.getCachedEarnings(sym);
    const earningsFresh = cachedEarnings &&
      (Date.now() - new Date(cachedEarnings.cachedAt).getTime()) < 24 * 60 * 60 * 1000;
    if (!earningsFresh) {
      const earningsData = await fmp.getEarnings(sym);
      await sleep(FMP_DELAY);
      await db.setCachedEarnings(sym, earningsData);
    }
  } catch(e) {
    console.error(`[cron] Earnings update failed for ${sym}:`, e.message);
  }

  // 5. Full momentum signal — load price_history for momentum, then calcSignal
  let history = [];
  try {
    const from120 = new Date(); from120.setDate(from120.getDate() - 120);
    history = await db.getHistory(sym, from120.toISOString().slice(0, 10));
  } catch(e) {
    console.error(`[db] getHistory failed for ${sym}:`, e.message);
  }
  const momentum = calcMomentum(history);
  const tally    = tallyGrades(grades || []);
  const { signal: newSignal, reason } = calcSignal({ quote, target, tally, momentum });

  // Informational upside for storage/alerts — analyst consensus vs price (not the
  // conservative figure calcSignal decides on); kept as before for /api/signals.
  const upside = target?.targetConsensus && quote?.price
    ? ((target.targetConsensus - quote.price) / quote.price * 100)
    : null;

  // 6. Previous signal for change detection
  let prevSignal = null;
  try {
    const { rows } = await db.pool.query('SELECT data FROM signals WHERE symbol = $1', [sym]);
    prevSignal = rows[0]?.data?.signal ?? null;
  } catch(e) {
    const s = store.read('signals', {});
    prevSignal = s[sym]?.signal ?? null;
  }

  // 7. Save signal
  const signalData = {
    signal: newSignal,
    reason,
    upside,
    tally,
    price: quote?.price,
    target: target?.targetConsensus,
    updatedAt: new Date().toISOString(),
  };
  try {
    await db.saveSignal(sym, signalData);
  } catch(e) {
    console.error(`[db] saveSignal failed for ${sym}, falling back to store:`, e.message);
    const storeSignals = store.read('signals', {});
    storeSignals[sym] = signalData;
    store.write('signals', storeSignals);
  }

  // 8. Log change + email the holders/watchers who care
  if (prevSignal && prevSignal !== newSignal) {
    console.log(`[cron] Signal change: ${sym} ${prevSignal} → ${newSignal}`);
    await logSignalChange(sym, newSignal, prevSignal, upside);

    for (const { user, watchlist, portfolioSyms, practiceSyms } of holdings) {
      const inPortfolio = portfolioSyms.includes(sym);
      const inPractice  = practiceSyms.includes(sym);
      const inWatchlist = watchlist.includes(sym);
      if (!inPortfolio && !inPractice && !inWatchlist) continue;

      // BUY — CONFIRMED for a pure watchlist symbol (not already held)
      if (inWatchlist && !inPortfolio && !inPractice && isBuySignal(newSignal)) {
        await sendEmailAlert(user.email, sym, newSignal, prevSignal, upside, '🟢 Time to BUY!');
      }
      // SELL / TRIM / REVERSAL for anything actually held
      if ((inPortfolio || inPractice) && isCriticalSignal(newSignal)) {
        await sendEmailAlert(user.email, sym, newSignal, prevSignal, upside, '🔴 Action needed!');
      }
    }
  }
}

// ── JOB 3: Screener upside enrichment ────────────────────────────
// Runs once per day at night — enrich all screener symbols with upside %
async function enrichScreenerUpside() {
  console.log('[cron] Enriching screener upside…');

  let entries;
  try {
    entries = await db.getScreener();
  } catch(e) {
    console.error('[db] getScreener failed, falling back to store:', e.message);
    const screener   = store.read('screener', []);
    const storeUpside = store.read('screener_upside', {});
    entries = screener.map(x => ({ ...x, upsideData: storeUpside[x.symbol] || null }));
  }

  const syms = [...new Set(entries.map(e => e.symbol))];
  const upsideMap = {};
  entries.forEach(e => { if (e.upsideData && !upsideMap[e.symbol]) upsideMap[e.symbol] = e.upsideData; });

  let enrichedCount = 0;
  for (const sym of syms) {
    if (upsideMap[sym]?.cachedAt) {
      const age = Date.now() - new Date(upsideMap[sym].cachedAt).getTime();
      if (age < 24 * 60 * 60 * 1000) { enrichedCount++; continue; } // skip if fresh
    }
    try {
      // Sequential with 400ms between each FMP call (was Promise.all + sleep(200),
      // ~10 calls/sec) — this keeps enrichment to ~2.5 calls/sec, well under FMP limits.
      const quote = await fmp.getQuote(sym);
      await sleep(400);
      const target = await fmp.getTarget(sym);
      await sleep(400);
      const minTarget = target?.targetLow ?? target?.targetConsensus;
      if (quote?.price && minTarget) {
        const data = {
          // Conservative upside: min analyst target (targetLow, falling back to
          // targetConsensus) with an additional 25% haircut — keep in sync with
          // calcConservativeUpside() in dashboard.html.
          upside: ((minTarget * 0.75 - quote.price) / quote.price * 100),
          price: quote.price,
          target: target.targetConsensus,
          cachedAt: new Date().toISOString(),
        };
        try {
          await db.updateScreenerUpside(sym, data);
        } catch(e) {
          console.error(`[db] updateScreenerUpside failed for ${sym}, falling back to store:`, e.message);
          const storeUpside = store.read('screener_upside', {});
          storeUpside[sym] = data;
          store.write('screener_upside', storeUpside);
        }
        enrichedCount++;
      }
      // (delays already applied between the getQuote/getTarget calls above)
    } catch {}
  }
  console.log(`[cron] Enriched ${enrichedCount} symbols`);
}

// ── JOB 4: Benchmark symbols (indices/sectors used by Overview + backtest) ──
// Runs on startup and every 6h — keeps quotes + 90d price history fresh
// independent of any user's watchlist/portfolio/practice holdings
const BENCHMARK_SYMBOLS = ['SPY', 'QQQ', 'VXX', 'XBI', 'XPH', 'XLV', 'IWM', 'USO', 'GLD', 'UUP'];

async function refreshBenchmarkSymbols() {
  console.log('[cron] Refreshing benchmark symbols…');
  const from90 = new Date(); from90.setDate(from90.getDate() - 90);
  const from90Str = from90.toISOString().slice(0, 10);

  let refreshed = 0;
  for (const sym of BENCHMARK_SYMBOLS) {
    try {
      const [quote, histData] = await Promise.all([
        fmp.getQuote(sym),
        fmp.getHistory(sym, from90Str),
      ]);

      if (quote) {
        try {
          await db.setCachedQuote(sym, quote);
        } catch(e) {
          console.error(`[db] setCachedQuote failed for benchmark ${sym}:`, e.message);
        }
      }

      const histRows = (histData || [])
        .map(d => ({ date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }))
        .filter(r => r.date && r.close != null);
      if (histRows.length) await db.upsertHistory(sym, histRows);

      refreshed++;
    } catch(e) {
      console.error(`[cron] Error refreshing benchmark ${sym}:`, e.message);
    }
    await sleep(800);
  }
  console.log(`[cron] Refreshed ${refreshed}/${BENCHMARK_SYMBOLS.length} benchmark symbols`);
}

// ── EMAIL ALERTS ─────────────────────────────────────────────────
// `to` is the specific user's email — the account that owns the symbol, not
// necessarily whoever GMAIL_USER/GMAIL_APP_PASSWORD (the sending account) belongs to
async function sendEmailAlert(to, sym, newSignal, oldSignal, upside, context = '') {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass || !to) return;

  const subject = `${context} MarketLens: ${sym} — ${newSignal}`;
  const body = `
${context}

Symbol:      ${sym}
New Signal:  ${newSignal}
Old Signal:  ${oldSignal}
Upside:      ${upside?.toFixed(1)}%

Open MarketLens: https://marketlens-bt5u.onrender.com
  `.trim();

  try {
    const nodemailer  = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });
    await transporter.sendMail({
      from: `"MarketLens" <${gmailUser}>`,
      to,
      subject,
      text: body,
    });
    console.log(`[email] Alert sent to ${to}: ${sym} ${newSignal}`);
  } catch(e) {
    console.error('[email] Failed:', e.message);
  }
}

// ── JOB 5: Weekly status email ────────────────────────────────────
// Every Sunday 8am ET — per-user activity summary, sent to GMAIL_USER (ops inbox),
// not to each user's own email
async function sendWeeklyStatusEmail() {
  console.log('[cron] Sending weekly status email…');
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    console.log('[cron] Weekly status email skipped — GMAIL_USER/GMAIL_APP_PASSWORD not set');
    return;
  }

  let users;
  try {
    users = await db.getUsers();
  } catch(e) {
    console.error('[cron] Weekly status email: getUsers failed:', e.message);
    return;
  }

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const sections = [];
  for (const user of users) {
    try {
      const [watchlist, portfolio, practice] = await Promise.all([
        db.getWatchlist(user.id),
        db.getPortfolio(user.id),
        db.getPractice(user.id),
      ]);

      const portfolioOpenCount = (portfolio.open || []).length;
      const practiceOpenCount  = practice.reduce((n, acct) => n + (acct.open || []).length, 0);

      const symbols = [...new Set([
        ...watchlist,
        ...(portfolio.open || []).map(p => p.sym),
        ...practice.flatMap(acct => (acct.open || []).map(p => p.sym)),
      ])];

      let signalChangeCount = 0;
      if (symbols.length) {
        const { rows } = await db.pool.query(
          'SELECT COUNT(*) FROM signal_log WHERE symbol = ANY($1) AND created_at >= $2',
          [symbols, sevenDaysAgo]
        );
        signalChangeCount = parseInt(rows[0].count, 10);
      }

      const lastActive = user.last_active
        ? new Date(user.last_active).toLocaleString('en-US', { timeZone: 'America/New_York' })
        : 'Never';

      sections.push(
`${user.display_name || user.username} (@${user.username})
  Watchlist symbols:        ${watchlist.length}
  Open portfolio positions: ${portfolioOpenCount}
  Open practice positions:  ${practiceOpenCount}
  Signal changes (7d):      ${signalChangeCount}
  Last active:              ${lastActive}`
      );
    } catch(e) {
      console.error(`[cron] Weekly status email: failed to summarize user ${user.username}:`, e.message);
    }
  }

  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const subject = `📊 MarketLens Weekly Report - ${dateStr}`;
  const body = `MarketLens Weekly Status Report — ${dateStr}

${sections.join('\n\n')}`;

  try {
    const nodemailer  = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });
    await transporter.sendMail({
      from: `"MarketLens" <${gmailUser}>`,
      to: gmailUser,
      subject,
      text: body,
    });
    console.log('[cron] Weekly status email sent');
  } catch(e) {
    console.error('[cron] Weekly status email failed:', e.message);
  }
}

// Exit/critical signals worth emailing a holder about
function isCriticalSignal(signal) {
  return signal === 'SELL — REVERSAL' || signal === 'TRIM' || signal === 'SELL';
}
// The strongest entry signal — the only one worth emailing a watchlist symbol about
function isBuySignal(signal) {
  return signal === 'BUY — CONFIRMED';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function logSignalChange(sym, newSignal, oldSignal, upside) {
  const reason = `Upside: ${upside?.toFixed(1)}%`;
  try {
    await db.addSignalLog(sym, newSignal, oldSignal, reason);
  } catch(e) {
    console.error(`[db] addSignalLog failed for ${sym}, falling back to store:`, e.message);
    const log = store.read('signal_log', []);
    log.unshift({
      id:        Date.now(),
      ts:        new Date().toISOString(),
      sym,
      newSignal,
      oldSignal,
      reason,
      source:    'server',
    });
    store.write('signal_log', log.slice(0, 500)); // keep last 500
  }
}

// ── SCHEDULE ─────────────────────────────────────────────────────
function startCronJobs() {
  // Screener feed + upside enrichment — every 2h on weekdays
  cron.schedule('0 */2 * * 1-5', async () => {
    await collectScreenerFeed();
    await enrichScreenerUpside(); // enrich after every collection
  }, { timezone: 'America/New_York' });

  // Also run every 6 hours on weekends
  cron.schedule('0 */6 * * 0,6', async () => {
    await collectScreenerFeed();
    await enrichScreenerUpside();
  });

  // Rolling per-symbol refresh (see refreshNextSymbol). Fires every minute, but
  // only actually processes a symbol every minute during market hours (Mon–Fri
  // 9:00–17:00 ET); outside that window it throttles to once every 30 minutes,
  // avoiding needless FMP calls overnight and on weekends.
  cron.schedule('* * * * *', async () => {
    const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day  = et.getDay();
    const mins = et.getHours() * 60 + et.getMinutes();
    const marketHours = day >= 1 && day <= 5 && mins >= 540 && mins < 1020; // 9:00–17:00 ET
    if (!marketHours && et.getMinutes() % 30 !== 0) return; // off-hours: only :00 and :30
    await refreshNextSymbol();
  }, { timezone: 'America/New_York' });

  // Benchmark symbols — every 6 hours, every day (not tied to market schedule)
  cron.schedule('0 */6 * * *', async () => {
    await refreshBenchmarkSymbols();
  }, { timezone: 'America/New_York' });

  // Weekly status email — every Sunday at 8am ET
  cron.schedule('0 8 * * 0', async () => {
    await sendWeeklyStatusEmail();
  }, { timezone: 'America/New_York' });

  console.log('[cron] Jobs scheduled ✅');

  // Run immediately on startup — benchmarks first so /api/overview has data
  // cached post-deploy, then seed the per-symbol refresh queue (the minute
  // job drains it from there). Stagger the jobs with 5s gaps so they don't all
  // hammer FMP simultaneously on deploy.
  setTimeout(async () => {
    await collectScreenerFeed();
    await sleep(5000);
    await enrichScreenerUpside();
    await sleep(5000);
    await refreshBenchmarkSymbols();
    await sleep(5000);
    await buildRefreshQueue();
  }, 3000);
}

module.exports = { startCronJobs, collectScreenerFeed, refreshBenchmarkSymbols, rebuildRefreshQueue, refreshNextSymbol, buildRefreshQueue };
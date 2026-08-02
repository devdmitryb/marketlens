// Scheduled data collection jobs
const cron  = require('node-cron');
const fmp   = require('./fmp');
const store = require('./store');
const db    = require('./db');

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

// ── JOB 2: Quote + signal refresh for watched symbols (all users) ─
async function refreshWatchedSymbols() {
  console.log('[cron] Refreshing watched symbols…');

  let users;
  try {
    users = await db.getUsers();
  } catch(e) {
    console.error('[db] getUsers failed, aborting refresh:', e.message);
    return;
  }

  // Load each user's watchlist/portfolio/practice so we know who to alert later —
  // one user's failure doesn't block the others (no per-user store.js fallback: it
  // predates multiuser and has no concept of separate users' data)
  const userHoldings = [];
  for (const user of users) {
    try {
      const [watchlist, portfolio, practice] = await Promise.all([
        db.getWatchlist(user.id),
        db.getPortfolio(user.id),
        db.getPractice(user.id),
      ]);
      const portfolioSyms = (portfolio.open || []).map(p => p.sym);
      const practiceSyms  = practice.flatMap(a => (a.open || []).map(p => p.sym));
      userHoldings.push({ user, watchlist, portfolioSyms, practiceSyms });
    } catch(e) {
      console.error(`[db] Failed to load holdings for user ${user.username}, skipping them:`, e.message);
    }
  }

  // Union of every symbol any user is tracking — fetched/signaled once, not per-user
  const allSyms = [...new Set(userHoldings.flatMap(h => [...h.watchlist, ...h.portfolioSyms, ...h.practiceSyms]))];

  if (!allSyms.length) return;

  let signals;
  try {
    signals = await db.getSignals();
  } catch(e) {
    console.error('[db] getSignals failed, falling back to store:', e.message);
    signals = store.read('signals', {});
  }

  const changed  = [];
  const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

  for (const sym of allSyms) {
    try {
      // Check cache for grades and target
      const now = Date.now();

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

      const gradesFresh  = cachedGrades && (now - new Date(cachedGrades.cachedAt).getTime()) < CACHE_TTL;
      const targetFresh  = cachedTarget && (now - new Date(cachedTarget.cachedAt).getTime()) < CACHE_TTL;

      const [quote, grades, target] = await Promise.all([
        fmp.getQuote(sym),
        gradesFresh  ? Promise.resolve(cachedGrades.data)  : fmp.getGrades(sym),
        targetFresh  ? Promise.resolve(cachedTarget.data) : fmp.getTarget(sym),
      ]);

      // Update caches
      if (!gradesFresh && grades) {
        try {
          await db.setCachedGrades(sym, grades);
        } catch(e) {
          console.error(`[db] setCachedGrades failed for ${sym}, falling back to store:`, e.message);
          const gradeCache = store.read('grades_cache', {});
          gradeCache[sym] = { data: grades, cachedAt: new Date().toISOString() };
          store.write('grades_cache', gradeCache);
        }
      }
      if (!targetFresh && target) {
        try {
          await db.setCachedTarget(sym, target);
        } catch(e) {
          console.error(`[db] setCachedTarget failed for ${sym}, falling back to store:`, e.message);
          const targetCache = store.read('target_cache', {});
          targetCache[sym] = { data: target, cachedAt: new Date().toISOString() };
          store.write('target_cache', targetCache);
        }
      }

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

      // Calculate signal
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
      const recentGrades = grades.filter(g => new Date(g.date) >= cutoff);
      const tally = { buy: 0, hold: 0, sell: 0 };
      recentGrades.forEach(g => {
        const gr = (g.newGrade || '').toLowerCase();
        if (/buy|outperform|overweight|strong buy|accumulate/.test(gr)) tally.buy++;
        else if (/sell|underperform|underweight|reduce/.test(gr)) tally.sell++;
        else tally.hold++;
      });

      const upside = target?.targetConsensus && quote?.price
        ? ((target.targetConsensus - quote.price) / quote.price * 100)
        : null;

      const prevSignal = signals[sym]?.signal;
      const newSignal  = calcSimpleSignal(tally, upside);

      const signalData = {
        signal: newSignal,
        upside,
        tally,
        price: quote?.price,
        target: target?.targetConsensus,
        updatedAt: new Date().toISOString(),
      };
      signals[sym] = signalData;

      try {
        await db.saveSignal(sym, signalData);
      } catch(e) {
        console.error(`[db] saveSignal failed for ${sym}, falling back to store:`, e.message);
        const storeSignals = store.read('signals', {});
        storeSignals[sym] = signalData;
        store.write('signals', storeSignals);
      }

      // Log signal change
      if (prevSignal && prevSignal !== newSignal) {
        changed.push({ sym, from: prevSignal, to: newSignal, upside });
        console.log(`[cron] Signal change: ${sym} ${prevSignal} → ${newSignal}`);
        await logSignalChange(sym, newSignal, prevSignal, upside);

        // Notify every user tracking this symbol, based on their own holdings
        for (const { user, watchlist, portfolioSyms, practiceSyms } of userHoldings) {
          const inPortfolio = portfolioSyms.includes(sym);
          const inPractice  = practiceSyms.includes(sym);
          const inWatchlist = watchlist.includes(sym);
          if (!inPortfolio && !inPractice && !inWatchlist) continue;

          // Email: BUY for watchlist (not already in portfolio/practice)
          if (inWatchlist && !inPortfolio && !inPractice && newSignal === 'BUY') {
            await sendEmailAlert(user.email, sym, newSignal, prevSignal, upside, '🟢 Time to BUY!');
          }
          // Email: SELL signals for portfolio and practice
          if ((inPortfolio || inPractice) && newSignal === 'SELL') {
            await sendEmailAlert(user.email, sym, newSignal, prevSignal, upside, '🔴 Time to SELL!');
          }
        }
      }

      // Price history — incremental upsert (full 90d backfill on first sighting)
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
          const histRows = (histData || [])
            .map(d => ({ date: d.date, open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume }))
            .filter(r => r.date && r.close != null);
          if (histRows.length) await db.upsertHistory(sym, histRows);
        }
      } catch(e) {
        console.error(`[cron] Price history update failed for ${sym}:`, e.message);
      }

      // Earnings cache — 24h TTL
      try {
        const cachedEarnings = await db.getCachedEarnings(sym);
        const earningsFresh = cachedEarnings &&
          (Date.now() - new Date(cachedEarnings.cachedAt).getTime()) < 24 * 60 * 60 * 1000;
        if (!earningsFresh) {
          const earningsData = await fmp.getEarnings(sym);
          await db.setCachedEarnings(sym, earningsData);
        }
      } catch(e) {
        console.error(`[cron] Earnings update failed for ${sym}:`, e.message);
      }

      // Rate limit — increased delay between symbols to avoid FMP 429
      await sleep(800);
    } catch(e) {
      console.error(`[cron] Error refreshing ${sym}:`, e.message);
    }
  }

  const totalWatchlist = userHoldings.reduce((n, h) => n + h.watchlist.length, 0);
  const totalPortfolio = userHoldings.reduce((n, h) => n + h.portfolioSyms.length, 0);
  const totalPractice  = userHoldings.reduce((n, h) => n + h.practiceSyms.length, 0);
  console.log(`[cron] Refreshed ${allSyms.length} symbols across ${userHoldings.length} users (${totalWatchlist} watchlist + ${totalPortfolio} portfolio + ${totalPractice} practice), ${changed.length} signal changes`);
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
      const [quote, target] = await Promise.all([
        fmp.getQuote(sym),
        fmp.getTarget(sym),
      ]);
      if (quote?.price && target?.targetConsensus) {
        const data = {
          upside: ((target.targetConsensus - quote.price) / quote.price * 100),
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
      await sleep(200);
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

function isCriticalSignal(signal) {
  return signal === 'SELL — REVERSAL' || signal === 'TRIM' || signal === 'SELL';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function calcSimpleSignal(tally, upsidePct) {
  const total    = tally.buy + tally.hold + tally.sell || 1;
  const buyRatio = tally.buy / total;
  const sellRatio= tally.sell / total;
  if (sellRatio >= 0.4) return 'SELL';
  if (upsidePct !== null && upsidePct < 20) return 'WAIT';
  if (buyRatio >= 0.5 && upsidePct >= 20) return 'BUY';
  return 'WATCH';
}

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
  // Every 2 hours — collect screener + enrich new symbols + refresh signals
  cron.schedule('0 */2 * * 1-5', async () => {
    await collectScreenerFeed();
    await enrichScreenerUpside(); // enrich after every collection
    await refreshWatchedSymbols();
  }, { timezone: 'America/New_York' });

  // Also run every 6 hours on weekends
  cron.schedule('0 */6 * * 0,6', async () => {
    await collectScreenerFeed();
    await enrichScreenerUpside();
  });

  // Benchmark symbols — every 6 hours, every day (not tied to market schedule)
  cron.schedule('0 */6 * * *', async () => {
    await refreshBenchmarkSymbols();
  }, { timezone: 'America/New_York' });

  console.log('[cron] Jobs scheduled ✅');

  // Run immediately on startup — benchmarks before watched symbols so
  // /api/overview has data cached before anyone hits it post-deploy
  setTimeout(async () => {
    await collectScreenerFeed();
    await enrichScreenerUpside();
    await refreshBenchmarkSymbols();
    await refreshWatchedSymbols();
  }, 3000);
}

module.exports = { startCronJobs, collectScreenerFeed, refreshWatchedSymbols, refreshBenchmarkSymbols };
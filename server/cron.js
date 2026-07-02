// Scheduled data collection jobs
const cron  = require('node-cron');
const fmp   = require('./fmp');
const store = require('./store');

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
      console.log(`[cron] Screener: +${newEntries.length} new, total: ${filtered.length} (90d window)`);
    } else {
      console.log('[cron] Screener: no new entries');
    }

    store.write('screener_meta', { lastUpdated: new Date().toISOString(), count: store.read('screener', []).length });
  } catch(e) {
    console.error('[cron] Screener error:', e.message);
  }
}

// ── JOB 2: Quote + signal refresh for watched symbols ────────────
async function refreshWatchedSymbols() {
  console.log('[cron] Refreshing watched symbols…');
  const watchlist = store.read('watchlist', []);
  const portfolio = store.read('portfolio', { open: [], closed: [] });
  const practice  = store.read('practice', []);

  // All symbols that need monitoring — watchlist + open portfolio + open practice
  const portfolioSyms = (portfolio.open || []).map(p => p.sym);
  const practiceSyms  = practice.flatMap(a => (a.open || []).map(p => p.sym));
  const allSyms = [...new Set([...watchlist, ...portfolioSyms, ...practiceSyms])];

  if (!allSyms.length) return;

  const quotes  = store.read('quotes', {});
  const signals = store.read('signals', {});
  const changed = [];

  for (const sym of allSyms) {
    try {
      const [quote, grades, target] = await Promise.all([
        fmp.getQuote(sym),
        fmp.getGrades(sym),
        fmp.getTarget(sym),
      ]);

      if (quote) quotes[sym] = { ...quote, cachedAt: new Date().toISOString() };

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

      signals[sym] = {
        signal: newSignal,
        upside,
        tally,
        price: quote?.price,
        target: target?.targetConsensus,
        updatedAt: new Date().toISOString(),
      };

      // Log signal change
      if (prevSignal && prevSignal !== newSignal) {
        changed.push({ sym, from: prevSignal, to: newSignal, upside });
        console.log(`[cron] Signal change: ${sym} ${prevSignal} → ${newSignal}`);
        logSignalChange(sym, newSignal, prevSignal, upside);

        const inPortfolio = portfolioSyms.includes(sym);
        const inPractice  = practiceSyms.includes(sym);
        const inWatchlist = watchlist.includes(sym);

        // Email: BUY-CONFIRMED for watchlist (not already in portfolio/practice)
        if (inWatchlist && !inPortfolio && !inPractice && newSignal === 'BUY — CONFIRMED') {
          await sendEmailAlert(sym, newSignal, prevSignal, upside, '🟢 Time to BUY!');
        }
        // Email: SELL signals for portfolio and practice
        if ((inPortfolio || inPractice) && isCriticalSignal(newSignal)) {
          await sendEmailAlert(sym, newSignal, prevSignal, upside, '🔴 Time to SELL!');
        }
      }

      // Rate limit — small delay between symbols
      await sleep(300);
    } catch(e) {
      console.error(`[cron] Error refreshing ${sym}:`, e.message);
    }
  }

  store.write('quotes', quotes);
  store.write('signals', signals);
  console.log(`[cron] Refreshed ${allSyms.length} symbols (${watchlist.length} watchlist + ${portfolioSyms.length} portfolio + ${practiceSyms.length} practice), ${changed.length} signal changes`);
}

// ── JOB 3: Screener upside enrichment ────────────────────────────
// Runs once per day at night — enrich all screener symbols with upside %
async function enrichScreenerUpside() {
  console.log('[cron] Enriching screener upside…');
  const screener = store.read('screener', []);
  const syms     = [...new Set(screener.map(e => e.symbol))];
  const upside   = store.read('screener_upside', {});

  for (const sym of syms) {
    if (upside[sym]?.cachedAt) {
      const age = Date.now() - new Date(upside[sym].cachedAt).getTime();
      if (age < 24 * 60 * 60 * 1000) continue; // skip if fresh
    }
    try {
      const [quote, target] = await Promise.all([
        fmp.getQuote(sym),
        fmp.getTarget(sym),
      ]);
      if (quote?.price && target?.targetConsensus) {
        upside[sym] = {
          upside: ((target.targetConsensus - quote.price) / quote.price * 100),
          price: quote.price,
          target: target.targetConsensus,
          cachedAt: new Date().toISOString(),
        };
      }
      await sleep(200);
    } catch {}
  }
  store.write('screener_upside', upside);
  console.log(`[cron] Enriched ${Object.keys(upside).length} symbols`);
}

// ── EMAIL ALERTS ─────────────────────────────────────────────────
async function sendEmailAlert(sym, newSignal, oldSignal, upside, context = '') {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return;

  const subject = `${context} MarketLens: ${sym} — ${newSignal}`;
  const body = `
${context}

Symbol:      ${sym}
New Signal:  ${newSignal}
Old Signal:  ${oldSignal}
Upside:      ${upside?.toFixed(1)}%

Open MarketLens: https://marketlens-bt5u.onrender.com
  `.trim();

  // Send via Gmail SMTP using raw HTTP (no nodemailer needed)
  const https  = require('https');
  const auth   = Buffer.from(`${user}:${pass}`).toString('base64');

  // Use Gmail API via SMTP - simpler: just use nodemailer
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransporter({
      service: 'gmail',
      auth: { user, pass },
    });
    await transporter.sendMail({
      from: `"MarketLens" <${user}>`,
      to:   user,
      subject,
      text: body,
    });
    console.log(`[email] Alert sent: ${sym} ${newSignal}`);
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

function logSignalChange(sym, newSignal, oldSignal, upside) {
  const log = store.read('signal_log', []);
  log.unshift({
    id:        Date.now(),
    ts:        new Date().toISOString(),
    sym,
    newSignal,
    oldSignal,
    reason:    `Upside: ${upside?.toFixed(1)}%`,
    source:    'server',
  });
  store.write('signal_log', log.slice(0, 500)); // keep last 500
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

  console.log('[cron] Jobs scheduled ✅');

  // Run immediately on startup
  setTimeout(async () => {
    await collectScreenerFeed();
    await enrichScreenerUpside();
    await refreshWatchedSymbols();
  }, 3000);
}

module.exports = { startCronJobs, collectScreenerFeed, refreshWatchedSymbols };
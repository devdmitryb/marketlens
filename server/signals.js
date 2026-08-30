// Shared signal logic — ported verbatim from dashboard.html's calcConservativeUpside /
// calcMomentum / calcSignal so the server's scheduled refresh produces the SAME full
// momentum-based signal the client shows (BUY — CONFIRMED / WATCH / WAIT, TRIM,
// SELL, SELL — REVERSAL, WAIT). Keep these in sync with the client copies; if a
// threshold changes in one place it must change in both (see CLAUDE.md).

// Conservative upside: min analyst target (targetLow, falling back to targetConsensus)
// with an extra 25% haircut, as a fraction of the current price.
function calcConservativeUpside(target, price) {
  if (!target || !price) return null;
  const minTarget = target.targetLow ?? target.targetConsensus;
  if (!minTarget) return null;
  return (minTarget * 0.75 - price) / price;
}

// Classify a single grade's newGrade text as 'buy' | 'sell' | 'hold'.
function classifyGrade(newGrade) {
  const gr = (newGrade || '').toLowerCase();
  if (/buy|outperform|overweight|strong buy|accumulate/.test(gr)) return 'buy';
  if (/sell|underperform|underweight|reduce/.test(gr)) return 'sell';
  return 'hold';
}

// Build a { buy, hold, sell } tally from analyst grades within the last `windowDays`.
function tallyGrades(grades, windowDays = 90) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const tally = { buy: 0, hold: 0, sell: 0 };
  (grades || []).forEach(g => {
    if (new Date(g.date) < cutoff) return;
    tally[classifyGrade(g.newGrade)]++;
  });
  return tally;
}

function calcMomentum(history) {
  if (!history || history.length < 10) return null;

  // Sort oldest→newest
  const sorted = [...history].sort((a, b) => new Date(a.date) - new Date(b.date));
  // PostgreSQL returns NUMERIC columns as strings — parse here so callers that
  // fetch history without normalizing it (e.g. backtest) don't silently corrupt
  // sums via string concatenation in the reduce() calls below
  const prices  = sorted.map(d => parseFloat(d.close));
  const volumes = sorted.map(d => parseInt(d.volume) || 0);
  const n = prices.length;

  const last  = prices[n - 1];
  const prev5 = prices[Math.max(0, n - 6)];
  const prev10= prices[Math.max(0, n - 11)];
  const prev20= prices[Math.max(0, n - 21)];
  const prev3 = prices[Math.max(0, n - 4)];

  // Use 60-day window for MA to reduce false signals in biotech
  const maWindow = Math.min(n, 60);
  const ma60 = prices.slice(-maWindow).reduce((a, b) => a + b, 0) / maWindow;
  const aboveMa60    = last > ma60;
  const priceToCross = ((last - ma60) / ma60 * 100);

  // Trend — needs BOTH 5d and 10d confirmation (stricter)
  const trendUp   = last > prev5 && last > prev10;
  const trendDown = last < prev5 && last < prev10;

  // Volume surge vs 20d avg
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, n);
  const avgVol3  = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const volSurge = avgVol20 > 0 && (avgVol3 / avgVol20) > 1.5; // raised from 1.3 to 1.5

  // Peak / reversal detection — 60-day window (not 20)
  const window60    = prices.slice(-60);
  const high60      = Math.max(...window60);
  const peakIdx     = window60.indexOf(high60);
  const daysFromPeak= window60.length - 1 - peakIdx;
  const priceAt60ago= prices[Math.max(0, n - 60)];
  const runUp       = priceAt60ago > 0 ? ((high60 - priceAt60ago) / priceAt60ago * 100) : 0;
  const drawdownFromHigh = Math.abs((last - high60) / high60 * 100);

  // Reversal: ran up 30%+ (lowered from 50%), peaked 3-15 days ago, dropped 7%+ from peak (lowered from 10%)
  const hadBigRun      = runUp >= 30;
  const peakedRecently = daysFromPeak >= 3 && daysFromPeak <= 15;
  const fallingFromPeak= drawdownFromHigh >= 7;
  const reversalSignal = hadBigRun && peakedRecently && fallingFromPeak;

  // Consecutive days above MA60 (filter for false breakouts)
  const consecutiveAbove = (() => {
    let count = 0;
    for (let j = prices.length - 1; j >= 0; j--) {
      if (prices[j] > ma60) count++; else break;
    }
    return count;
  })();

  // Momentum slowdown — only meaningful after big run
  const gain_last3 = last - prev3;
  const gain_prev3 = prev3 - prices[Math.max(0, n - 7)];
  const momentumSlowing = hadBigRun && gain_last3 < gain_prev3 * 0.4 && gain_prev3 > 0;

  return {
    trendUp, trendDown, aboveMa60, priceToCross, volSurge,
    drawdownFromHigh, runUp, hadBigRun,
    reversalSignal, momentumSlowing, daysFromPeak,
    consecutiveAbove, ma60, last, prev20, high60
  };
}

function calcSignal(data) {
  const { quote, target, tally, momentum } = data;
  if (!quote || !target) return { signal: 'WAIT', reason: 'Insufficient data' };

  const total     = tally.buy + tally.hold + tally.sell || 1;
  const buyRatio  = tally.buy  / total;
  const sellRatio = tally.sell / total;

  const upside = calcConservativeUpside(target, quote.price) ?? 0;

  // For ix-hunting: only care about stocks with 20%+ upside potential
  const upsidePct      = upside * 100;
  const analystsBullish= buyRatio >= 0.5 && upside >= 0.20; // raised from 10% to 20%
  const analystsBearish= sellRatio >= 0.4 || upside < -0.05;

  // ── EXIT signals ──
  if (momentum) {
    const { reversalSignal, momentumSlowing, runUp, drawdownFromHigh, daysFromPeak, hadBigRun } = momentum;

    // SELL — REVERSAL: ran 30%+, now dropping meaningfully
    if (reversalSignal && buyRatio < 0.75)
      return {
        signal: 'SELL — REVERSAL',
        reason: `Peaked ${daysFromPeak}d ago after +${runUp.toFixed(0)}% run, now -${drawdownFromHigh.toFixed(1)}% from high`
      };

    // TRIM: after big run AND momentum slowing AND near/past target
    if (hadBigRun && momentumSlowing && upsidePct < 20 && upsidePct > -10)
      return {
        signal: 'TRIM',
        reason: `After +${runUp.toFixed(0)}% run — momentum slowing, only ${upsidePct.toFixed(0)}% upside left — consider partial exit`
      };
  }

  // ── SELL: analysts turned negative ──
  if (analystsBearish)
    return { signal: 'SELL', reason: `Analysts bearish — ${(sellRatio*100).toFixed(0)}% sell ratings, upside ${upsidePct.toFixed(0)}%` };

  // ── TRIM: very near or past target ──
  if (upside > 0 && upsidePct < 10 && buyRatio < 0.65)
    return { signal: 'TRIM', reason: `Only ${upsidePct.toFixed(0)}% upside left to analyst target — consider taking profit` };

  // ── Insufficient upside for ix strategy ──
  // For live signal: show WAIT so we don't enter new positions with low upside
  if (upside > 0 && upsidePct < 20)
    return { signal: 'WAIT', reason: `Only ${upsidePct.toFixed(0)}% upside — below 20% threshold for ix strategy` };

  // ── No analyst support ──
  if (!analystsBullish)
    return { signal: 'WAIT', reason: `Weak analyst consensus (${(buyRatio*100).toFixed(0)}% buy) or insufficient upside` };

  // ── Analysts bullish + good upside — now check momentum for timing ──
  if (!momentum)
    return { signal: 'BUY — UNCONFIRMED', reason: `Analysts bullish, +${upsidePct.toFixed(0)}% upside — loading momentum…` };

  const { trendUp, trendDown, aboveMa60, volSurge, priceToCross, consecutiveAbove } = momentum;

  // Strong entry: trend up 3+ days + above MA60 + volume confirms
  if (trendUp && aboveMa60 && consecutiveAbove >= 3 && volSurge)
    return {
      signal: 'BUY — CONFIRMED',
      reason: `Trend ↑ ${consecutiveAbove}d above MA60 (+${priceToCross.toFixed(1)}%) + volume surge | Upside: +${upsidePct.toFixed(0)}%`
    };

  // Good entry: trend up 3+ days + above MA60
  if (trendUp && aboveMa60 && consecutiveAbove >= 3)
    return {
      signal: 'BUY — CONFIRMED',
      reason: `Trend ↑ ${consecutiveAbove}d above MA60 (+${priceToCross.toFixed(1)}%) | Upside: +${upsidePct.toFixed(0)}%`
    };

  // Above MA60 but less than 3 days — watch
  if (aboveMa60 && consecutiveAbove < 3)
    return {
      signal: 'BUY — WATCH',
      reason: `Above MA60 only ${consecutiveAbove}d — wait for confirmation (need 3+) | Upside: +${upsidePct.toFixed(0)}%`
    };

  // Early entry: trend turning up but below MA60
  if (trendUp && !aboveMa60)
    return {
      signal: 'BUY — WATCH',
      reason: `Trend turning ↑ but below MA60 (${priceToCross.toFixed(1)}%) — wait for breakout | Upside: +${upsidePct.toFixed(0)}%`
    };

  // Still falling
  if (trendDown)
    return {
      signal: 'BUY — WAIT',
      reason: `Price still falling — wait for reversal | Upside: +${upsidePct.toFixed(0)}% when ready`
    };

  // Sideways consolidation
  return {
    signal: 'BUY — WATCH',
    reason: `Consolidating — watch for breakout | Upside: +${upsidePct.toFixed(0)}%`
  };
}

// Volume Signal — classifies the most recent day's price+volume move using the
// last 5 days of price history. Mirrors dashboard.html's computeVolSignalHTML
// (drawer "Volume Signal" section). Independent of calcMomentum's 20d/3d
// volSurge check, which feeds the main signal's timing logic instead.
function calcVolumeSignal(history) {
  if (!history || history.length < 5) return null;

  const sorted = [...history].sort((a, b) => new Date(b.date) - new Date(a.date));
  const last5  = sorted.slice(0, 5).reverse(); // chronological order, most recent day last

  const avgVol   = last5.slice(0, 4).reduce((s, d) => s + (parseInt(d.volume) || 0), 0) / 4;
  const todayVol = parseInt(last5[4].volume) || 0;
  const priceDir = parseFloat(last5[4].close) > parseFloat(last5[3].close) ? 'up' : 'down';
  const volDir   = todayVol > avgVol ? 'up' : 'down';

  if (priceDir === 'up'   && volDir === 'up')   return 'confirmed';
  if (priceDir === 'down' && volDir === 'down') return 'pullback';
  if (priceDir === 'up'   && volDir === 'down') return 'weak';
  return 'selling'; // priceDir === 'down' && volDir === 'up'
}

// Combined Signal — pairs the main momentum+analyst signal with the Volume
// Signal into one of 3 defined high-conviction combos; null otherwise.
function calcCombinedSignal(signal, volumeSignal) {
  if (signal === 'BUY — CONFIRMED' && volumeSignal === 'confirmed') return 'strong_entry';
  if (signal === 'BUY — CONFIRMED' && volumeSignal === 'weak') return 'wait_volume';
  if (['SELL — REVERSAL', 'TRIM', 'SELL'].includes(signal) && volumeSignal === 'selling') return 'strong_exit';
  return null;
}

// Analyst Accuracy — last 5 non-Hold grades, each graded correct/incorrect by
// comparing the price at rating time (looked up in already-fetched price
// history) against the current price. A grade whose date falls outside the
// supplied history window (no matching row) is skipped rather than guessed at.
function calcAnalystAccuracy(grades, history, currentPrice) {
  if (!grades || !grades.length || currentPrice == null || !history || !history.length) return [];

  const sortedHistory = [...history].sort((a, b) => (a.date < b.date ? -1 : 1));
  const findPriceOnOrAfter = (dateStr) => {
    const row = sortedHistory.find(h => h.date >= dateStr);
    return row ? parseFloat(row.close) : null;
  };

  const candidates = grades
    .map(g => ({ date: String(g.date).slice(0, 10), gradeType: classifyGrade(g.newGrade) }))
    .filter(g => g.gradeType === 'buy' || g.gradeType === 'sell')
    .sort((a, b) => (a.date < b.date ? 1 : -1)) // most recent first
    .slice(0, 5);

  const results = [];
  for (const g of candidates) {
    const priceAtRating = findPriceOnOrAfter(g.date);
    if (priceAtRating == null) continue;
    const correct = g.gradeType === 'buy'
      ? currentPrice > priceAtRating
      : currentPrice < priceAtRating;
    results.push({ gradeType: g.gradeType, priceAtRating, currentPrice, correct });
  }
  return results;
}

module.exports = {
  calcConservativeUpside, tallyGrades, calcMomentum, calcSignal,
  calcVolumeSignal, calcCombinedSignal, calcAnalystAccuracy,
};

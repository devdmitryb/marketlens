// FMP API client — all FMP calls go through here
const BASE = 'https://financialmodelingprep.com/stable';

async function fmpFetch(path, retries = 2) {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY not set');
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}apikey=${key}`;
  const res  = await fetch(url);
  if (res.status === 429 && retries > 0) {
    console.warn(`[fmp] Rate limited, retrying in 2s... (${retries} left)`);
    await new Promise(r => setTimeout(r, 2000));
    return fmpFetch(path, retries - 1);
  }
  if (!res.ok) throw new Error(`FMP error: ${res.status} ${url}`);
  return res.json();
}

// Quote for a single symbol
async function getQuote(sym) {
  const data = await fmpFetch(`/quote?symbol=${sym}`);
  return Array.isArray(data) ? data[0] : null;
}

// Analyst grades (last 90 days)
async function getGrades(sym) {
  const data = await fmpFetch(`/grades?symbol=${sym}`);
  return Array.isArray(data) ? data : [];
}

// Price target consensus
async function getTarget(sym) {
  const data = await fmpFetch(`/price-target-consensus?symbol=${sym}`);
  return Array.isArray(data) ? data[0] : null;
}

// Historical prices
async function getHistory(sym, fromDate) {
  const data = await fmpFetch(`/historical-price-eod/full?symbol=${sym}&from=${fromDate}`);
  const arr  = data?.historical || (Array.isArray(data) ? data : []);
  return arr;
}

// Latest analyst news feed
async function getGradesLatestNews(limit = 100) {
  const data = await fmpFetch(`/grades-latest-news?limit=${limit}`);
  return Array.isArray(data) ? data : [];
}

// Earnings calendar
async function getEarnings(sym) {
  const data = await fmpFetch(`/earnings?symbol=${sym}`);
  return Array.isArray(data) ? data : [];
}

// Ratings snapshot
async function getRatingsSnapshot(sym) {
  const data = await fmpFetch(`/ratings-snapshot?symbol=${sym}`);
  return Array.isArray(data) ? data[0] : null;
}

// Symbol/name search for the header autocomplete
async function search(query, limit = 8) {
  const data = await fmpFetch(`/search?query=${encodeURIComponent(query)}&limit=${limit}`);
  return Array.isArray(data) ? data : [];
}

module.exports = { getQuote, getGrades, getTarget, getHistory, getGradesLatestNews, getEarnings, getRatingsSnapshot, search };
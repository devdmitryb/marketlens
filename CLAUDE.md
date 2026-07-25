# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MarketLens — a stock analyst dashboard that turns FMP (Financial Modeling Prep) analyst-grade and price data into buy/sell signals for a specific momentum + analyst-consensus strategy ("ix strategy": only act on stocks with 20%+ analyst upside, confirmed by price/volume momentum). It tracks a watchlist, a real portfolio, and paper-trading "practice" accounts, and can backtest the signal logic against historical data.

There is no build step and no test suite. The frontend is two static HTML files with inline JS/CSS; the backend is a small Express server that proxies/caches FMP API calls and runs scheduled jobs.

## Commands

```bash
npm start   # run the server (server/index.js)
npm run dev # run with --watch (auto-restart on file change)
```

There is no lint, test, or build command configured — `package.json` only defines `start`/`dev`.

To run locally, copy `.env.example` to `.env` and fill in `FMP_API_KEY` (required for any FMP data), `APP_TOKEN`/`APP_PASSWORD` (optional — omitting `APP_PASSWORD` disables login and auth), and `PORT`. `GMAIL_USER`/`GMAIL_APP_PASSWORD` (not in `.env.example`) enable email alerts on signal changes.

## Architecture

### Two deployment targets, one repo
- **Frontend** (`login.html`, `dashboard.html`): static files, deployed to GitHub Pages (`devdmitryb.github.io`). No bundler — everything (styles, markup, JS) lives inline in these two files.
- **Backend** (`server/`): Express app deployed to Render at `https://marketlens-bt5u.onrender.com`. Both frontend files hardcode this URL as `SERVER_URL`/`SERVER`.
- `server/index.js` also serves the static files itself (`express.static` + a `/` route to `login.html`), so the same backend can serve the whole app standalone — the GitHub Pages split is optional, not load-bearing.

### Server-optional, dual-mode frontend
`dashboard.html` can run two ways, chosen dynamically via `checkServerHealth()`:
1. **Server mode** (preferred): calls the Express API (`smartFetch`), which serves cached data from `server/data/*.json` and hides the FMP key.
2. **Direct mode** (fallback): if the server is unreachable, calls FMP directly from the browser using an API key the user pastes in and stores in `localStorage` (`fmp_key`).

Most data-fetching functions in `dashboard.html` (e.g. `fetchAndRender`, `enrichAll`) branch on server availability and duplicate logic for both paths — when changing a data flow, check both branches.

### Auth
Multi-user, JWT-based. `login.html` POSTs `{ username, password }` to `/api/login`; the server looks up the user in the `users` table (`server/db.js`) and verifies the password with `bcrypt.compare` against `password_hash`. On success it returns a JWT (`jsonwebtoken`, signed with `JWT_SECRET`, 90-day expiry) carrying `{ user_id, username, role, display_name }`, stored in `sessionStorage`/`localStorage` as `ml_token` (plus the full user object as `ml_user`, fetched via `GET /api/me`). All `/api/*` routes (except `/api/health` and `/api/login`) require this token via `x-app-token` header or `?token=` query param — `auth()` middleware in `server/index.js` verifies it with `jwt.verify` and attaches the decoded payload as `req.user`; there's no dev-mode auth bypass. `requireAdmin` middleware (checks `req.user.role === 'admin'`) gates the `/api/admin/users*` routes (list/create/delete/reset-password) and the dashboard's Admin page.

On first startup after the multiuser migration, `server/db.js`'s `initSchema()` bootstraps a single admin user (username `admin` or `ADMIN_USERNAME`, password = `APP_PASSWORD` hashed) and backfills all existing watchlist/portfolio/practice rows onto it — see the `migrateToMultiUser()` migration for the full schema change (adds `user_id` to those three tables, drops the old global unique constraint on `watchlist.symbol` in favor of `(user_id, symbol)`). `db.js`'s `getWatchlist/saveWatchlist/getPortfolio/savePortfolio/getPractice/savePractice` all take a `userId` — callers in `server/index.js` pass `req.user.user_id`; `server/cron.js`'s `refreshWatchedSymbols` loops over `db.getUsers()` to refresh every user's holdings and email alerts go to each holder's own `email` column (via `GMAIL_USER`/`GMAIL_APP_PASSWORD` as the sending account), not a single hardcoded recipient.

### Server-side persistence: flat JSON files, no database
`server/store.js` is the entire persistence layer — `read(name, default)` / `write(name, data)` / `update(name, fn, default)` against `server/data/<name>.json` (gitignored). Collections used: `screener`, `screener_meta`, `screener_upside`, `quotes`, `signals`, `signal_log`, `grades_cache`, `target_cache`, `watchlist`, `practice`, `portfolio`. There's no schema/migration mechanism — shapes are defined implicitly by whatever code reads/writes them.

### FMP API access is centralized and cached
`server/fmp.js` is the only place that calls the FMP API (`https://financialmodelingprep.com/stable`); it retries once on HTTP 429 with a 2s backoff. To avoid FMP rate limits, callers cache aggressively rather than calling `fmp.js` per-request:
- `/api/quote/:sym` caches per-symbol with a TTL that shrinks during market hours (15 min) vs. after hours (4 h).
- `/api/grades/:sym` and `/api/target/:sym` are cached in `grades_cache`/`target_cache` with a 6h TTL, refreshed only inside the cron job (not on direct API hits).
- `/api/screener` and `/api/signals` never call FMP directly — they only ever serve what cron already wrote to disk.

### Cron jobs drive all background data collection (`server/cron.js`)
Three jobs, scheduled with `node-cron` in America/New_York time and also run once on server startup:
1. `collectScreenerFeed` — pulls the latest analyst-grade news feed, dedupes by `newsURL`, keeps a rolling 90-day window in `screener`.
2. `refreshWatchedSymbols` — for the union of watchlist + open portfolio + open practice-account symbols: fetches quote/grades/target (grades/target via the 6h cache), recomputes a signal via `calcSimpleSignal`, and logs to `signal_log` when a signal changes. Signal-change transitions can trigger email alerts (`sendEmailAlert`, via `nodemailer`, silently a no-op if `GMAIL_USER`/`GMAIL_APP_PASSWORD` aren't set): BUY-CONFIRMED alerts for pure watchlist symbols, SELL/TRIM/REVERSAL alerts for anything actually held.
3. `enrichScreenerUpside` — daily-ish per-symbol upside enrichment for every screener symbol (24h cache), independent of the watch/portfolio refresh.

Schedule: every 2h on weekdays (all three jobs in sequence), every 6h on weekends (feed + enrichment only, no signal refresh). `POST /api/refresh` lets the frontend trigger `collectScreenerFeed` + `refreshWatchedSymbols` on demand (fires and returns immediately; work continues async).

### Two independent signal implementations — keep them in sync
The trading signal logic is duplicated in two places with different sophistication, and this is by design (client needs richer live analysis; server needs something cheap to run unattended every 2h):
- **Server**: `calcSimpleSignal` in `server/cron.js` — coarse (`BUY`/`WAIT`/`WATCH`/`SELL` based on analyst buy/sell ratio + upside %), used for scheduled alerting.
- **Client**: `calcSignal` in `dashboard.html` (~line 2440) — full state machine with momentum-based entries/exits (`BUY — CONFIRMED/WATCH/WAIT/UNCONFIRMED`, `SELL`, `SELL — REVERSAL`, `TRIM`), driven by `calcMomentum` (moving averages, trend, volume surge, drawdown-from-high). This is the one behind the dashboard's live cards and the backtester.

If you change the strategy's thresholds (e.g. the 20% upside cutoff, the 3-day trend confirmation, the 90-day grade window), check whether the equivalent constant needs updating in both files.

### Single-file frontend, sectioned by comment banners
`dashboard.html` is one big script tag with no modules. Major sections (grep for `═══` banners) are laid out as pages toggled by `showPage(name)`, each with its own render/fetch functions, all operating on module-level state (`watchlist`, `API_KEY`, etc.) — there is no framework or component boundary:
- **Overview** — market status, indices, sector snapshot.
- **Dashboard** — the watchlist, live signal cards (`buildCard`, `calcSignal`).
- **Screener** — the FMP analyst-news feed (`loadScreener`, `enrichAll`), independent of the watchlist.
- **Portfolio** / **Practice** — real vs. paper-trading positions, each with add/close position modals and their own P&L math (`~line 3546` onward for portfolio, `~line 4205` onward for practice — practice supports multiple named accounts via an account selector).
- **Signal Log** — history of signal transitions, sourced from `/api/signal-log`.
- **Backtest** — replays the strategy against historical price/grade data, with an optional configurable stop-loss, and a "Scan List" mode across multiple symbols with an aggregated totals row (P&L, IX count) computed as total P&L / total invested, not an average of per-symbol returns.

When editing one page's logic, watch for shared state (e.g. `watchlist`, cached data in `localStorage` under `cache_*` keys with type-specific TTLs via `getCacheTTL`) that other pages also read.

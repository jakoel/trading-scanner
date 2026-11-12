# Research tooling

Standalone signal-combo research, separate from the production scan pipeline
(`scan_headless.js`, `lib/`). Nothing here writes to `data/bars.db` or affects
what gets posted to Telegram — it's read-only against production data and
writes its own throwaway SQLite databases.

**Findings and decisions (what shipped, what didn't, and why) live in
[`../architecture.md`](../architecture.md), not here.** This file only covers
how to run the tooling.

## Files

| File | Purpose |
|------|---------|
| `features.mjs` | Single source of truth for the ~24 atomic signal "flags" the brute-force search draws from (both what's live in production and previously-unused `indicators.js` fields like `signal`/`warning`/`divergence`). Add a flag here and both scripts below pick it up automatically. |
| `build-cache.mjs` | Reads a bars database, runs `lib/indicators.js` once per symbol, and caches every flag from `features.mjs` plus forward returns (5/10/20/30 sessions) into a wide SQLite table (`bar_features`) — so `brute-force.mjs` never has to recompute indicators per combo. |
| `brute-force.mjs` | Tests every pairwise combo of `features.mjs`'s flags, applies a split-period out-of-sample check (history split at its median date; a combo only "passes" if it wins >50% in *both* halves independently and beats its stronger leg's own win rate), and ranks survivors. Guards against overfitting a ~300-combo search on a few hundred trading days. |
| `fetch-universe.mjs` | Pulls a fixed number of trading days (default 200) of daily OHLCV for a ticker list straight from Yahoo Finance into its own bars database — for testing signals against a bigger/different universe than the watchlist. |
| `discover.mjs` | Scores **new** daily-bar signal ideas (relative strength, momentum rank, squeeze, pullbacks, highs, gaps, accumulation, oscillators) plus the shipped sections as benchmarks, on one or more universes: return 10/15/20 sessions out, as excess over the same-day average stock, one event per episode, Benjamini-Hochberg-corrected across every signal tested, and a "same sign in all three time thirds of every universe" winner screen. `--selftest` runs 40 random signals plus one that peeks ahead to calibrate it; `--combos` adds a pair search. Use this, not `brute-force.mjs`, for daily-bar ideas: `brute-force.mjs` passes combos on raw win rate above 50%, which on a high-beta watchlist mostly measures market drift. `node research/discover.mjs --db=SP=research/sp_daily.db --db=WL=research/wl_daily.db` after `fetch-universe.mjs --days=540` for each. |
| `reassess.mjs` | Re-scores every Telegram report section — shown **and** hidden — on what price did 10/15/20 sessions (2-4 weeks) after each signal, as excess return over the same-day average watchlist stock, per episode (re-fires within 10 sessions count once) and per time window (before logging / live in-sample / out of sample). Replays `lib/report.js`'s own detectors over `data/bars.db`, so it scores exactly what the scanner says; read-only. `node research/reassess.mjs [--oos-start=2026-09-23]`. The decision rules for acting on its output are in `architecture.md` ("2026-11-12 reassessment"). |
| `*_tickers.txt` | Ticker lists for `fetch-universe.mjs`: `sp500_tickers.txt` (S&P 500), `nasdaq100_tickers.txt` (Nasdaq-100/QQQ), `watchlist_qqq_tickers.txt` (this repo's `watchlist.txt` ∪ Nasdaq-100, deduped). Regenerate by re-fetching from source if they go stale — see git history for where each came from. |
| `*.db` | Generated, gitignored, fully disposable. Never commit these. |

## Usage

**Research against the production watchlist** (`data/bars.db`, full stored history):

```bash
node research/build-cache.mjs
node research/brute-force.mjs
```

**Research against a different universe** — fetch it first, then point both
scripts at it with `--bars-db`/`--out`/`--db`:

```bash
node research/fetch-universe.mjs --tickers=research/sp500_tickers.txt --out=research/universe.db
node research/build-cache.mjs --bars-db=research/universe.db --out=research/universe_features.db
node research/brute-force.mjs --db=research/universe_features.db
```

`fetch-universe.mjs` also takes `--days=N` to change the trading-day window
(default 200) and defaults to `sp500_tickers.txt` if `--tickers` is omitted.

## The one hard lesson from using this so far

**A combo validating on a big, diverse universe is necessary but not
sufficient — it still has to be checked against the exact symbols the
scanner actually runs on.** Bullish Divergence + Strong Trend replicated
cleanly across the S&P 500, Nasdaq-100, and a combined watchlist+QQQ set, and
shipped on that basis — but tested directly against the watchlist's own
`data/bars.db` history, it was flat (49-53% win, trending down with horizon).
The edge was real, just concentrated in the ~70 QQQ-only names inside that
combined set, not the watchlist's own ~104. Always run the final check against
`data/bars.db` itself before shipping anything found on a broader dataset.

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

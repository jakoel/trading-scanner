# Research tooling

Standalone signal research, separate from the production scan pipeline
(`scan_headless.js`, `lib/`). Nothing here writes to `data/bars.db` or affects
what gets posted to Telegram — it reads production data and writes its own
throwaway databases.

**Where findings live:** decisions (what shipped, what didn't, and why) go in
[`../architecture.md`](../architecture.md). The full research log with every
number — strategy search, portfolio tests, sell signals, 10-year replays,
insider buying, ranked MACD/RSI/ATR features — is
[`strategy-search/RESULTS.md`](./strategy-search/RESULTS.md) (summary at the top).
This file only covers how to run the tooling.

## Which tool for which question

| Question | Tool |
|---|---|
| Are the report's sections (shown and hidden) still earning their place? | `reassess.mjs` — exact replay of `lib/report.js`, on `data/bars.db` or any longer history with `--db` |
| Does a *new* daily-bar idea beat the average stock, robustly? | `discover.mjs` (two universes, BH correction, null signals, `--vol-matched`) |
| Score a quick list of flag combos, buy or sell side? | `strategy-search/score-flags.mjs` on a `build-cache.mjs` database |
| Exhaustive combo × exit search, TradingView-strategy-tester style? | `strategy-search/search.mjs` (+ `--null` calibration) |
| Does it work as a real portfolio (position caps, drawdown, vs SPY)? | `strategy-search/portfolio.mjs`, `strategy-search/rotation.mjs` |
| Do continuous MACD/RSI/ATR values rank stocks? | `strategy-search/export-features.mjs` → `rank-study.py` → `rule-study.py` |
| Insider buying (SEC Form 4)? | `insider/` |

**Judge signals by excess return over the same-day average stock — and, for
anything volatility-tilted, over stocks of the same volatility — never by raw
win rate.** On a high-beta watchlist, win rate mostly measures the market.

## Layout

### Core harness (`research/`)

| File | Purpose |
|------|---------|
| `fetch-universe.mjs` | Daily OHLCV for a ticker list from Yahoo into its own bars database. `--tickers`, `--out`, `--days` (default 200; 2600 ≈ 10 years). |
| `fetch-4h-watchlist.mjs` | ~2 years of 1h bars (Yahoo's limit) resampled to 4H. |
| `features.mjs` | Single source of truth for the atomic signal flags (production signals, unused `indicators.js` fields, fair-value family, bearish mirrors). Add a flag here and the cache/brute-force/score-flags tools pick it up. |
| `build-cache.mjs` | Runs `lib/indicators.js` once per symbol and caches every `features.mjs` flag plus forward returns (`--horizons`) into a wide SQLite table. |
| `brute-force.mjs` | Pairwise combos of `features.mjs` flags with a split-period check. Passes on raw win rate, so prefer `discover.mjs` for daily ideas. |
| `discover.mjs` | Scores new daily ideas plus the shipped sections as benchmarks: excess vs same-day average stock (or same volatility quintile with `--vol-matched`), episodes, BH correction, winner screen across time thirds of every universe. `--selftest`, `--combos`. |
| `reassess.mjs` | Exact replay of `lib/report.js` detectors, scored 10/15/20 sessions out per episode and per window. `--db=<bars db>`, `--watchlist-only`, `--from/--live-start/--oos-start`. Decision rules: `architecture.md`. |
| `*_tickers.txt` | `sp500_tickers.txt`, `nasdaq100_tickers.txt`, `watchlist_qqq_tickers.txt` (watchlist ∪ Nasdaq-100). |

### `strategy-search/` — November 2026 search for a stronger signal

| File | Purpose |
|------|---------|
| `RESULTS.md` | The research log, parts 1–7+, summary at the top. `PLAN.md` is the original plan for part 1. |
| `flags.mjs`, `exits.mjs`, `search.mjs` | ~80 self-contained flags × 10 exit models (hold, ATR brackets, trail, EMA/RSI exits), bitset combo search with train/validate/test split and a `--null` run. |
| `dip-study.mjs` | Market-dip (SPY RSI<40) regime, scored per independent dip episode. |
| `portfolio.mjs` | Capped-slot portfolio backtester with SPY / equal-weight benchmarks and overlays. |
| `rotation.mjs` | ETF relative-strength rotation on a survivorship-light ETF universe. |
| `score-flags.mjs` | Scores sell-side candidates (default) or the shipped/hidden buy signals (`--buy`) on a feature cache. |
| `export-features.mjs` | Continuous production-indicator features + forward returns per stock-day → `research/.out_feat.csv`. |
| `rank-study.py` | Daily rank IC per feature and walk-forward linear / LightGBM scores (needs `numpy`, `pandas`, `lightgbm`). |
| `rule-study.py` | Transparent "pullback in a strong trend" rules distilled from the model picks. |
| `fvg-macd-study.py` | FVG + MACD events within 1–3 trading days, with each leg alone and a shifted-FVG null as benchmarks (part 8). |

### `insider/` — SEC Form 4 insider purchases

| File | Purpose |
|------|---------|
| `fetch-sec.mjs` | Downloads the SEC quarterly Insider Transactions Data Sets into `research/sec_raw/`. Needs `SEC_USER_AGENT="<client name> <contact email>"` in the environment (SEC fair-access policy); the script never stores one. |
| `build-insider.mjs` | Extracts open-market purchases → `insider/purchases.csv`. |
| `insider-study.mjs` | Event study vs same-day and same-volatility stocks, tradable rows only. `--db=<bars db>`. |

## Generated data (all gitignored, all rebuildable)

In the cloud sandbox, Node needs `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` for Yahoo.

| File | Built by |
|------|---------|
| `long_daily.db` (563 stocks, 10y daily) | `fetch-universe.mjs --tickers=<watchlist_qqq ∪ sp500 ∪ SPY,QQQ,IWM> --out=research/long_daily.db --days=2600` |
| `d10_wl.db`, `d10_rest.db` | `long_daily.db` split into watchlist / non-watchlist symbols (each with SPY, QQQ) for `discover.mjs` |
| `long_4h.db` | `fetch-4h-watchlist.mjs --tickers=research/watchlist_qqq_tickers.txt --out=research/long_4h.db` |
| `etf_daily.db` | `fetch-universe.mjs` with the ETF list in `strategy-search/RESULTS.md` part 2, `--days=2600` |
| `long_features.db`, `wl_features.db` | `build-cache.mjs --bars-db=research/long_daily.db` (or `data/bars.db`) `--horizons=10,15,20` |
| `.out_feat.csv` | `strategy-search/export-features.mjs` |
| `.out_search_*.json` | `strategy-search/search.mjs` |
| `sec_raw/`, `insider/purchases.csv`, `insider_prices.db` | `insider/fetch-sec.mjs`, `build-insider.mjs`, then `fetch-universe.mjs` over the purchase symbols |

## Hard lessons

- **Validate on the watchlist itself.** A combo that replicates on a big
  universe can still be flat on the symbols the scanner runs on (Bullish
  Divergence, September 2026). Run the final check on `data/bars.db` or with
  `--watchlist-only`.
- **Win rate is shaped by the exit.** A 1×ATR target with a 3×ATR stop "wins"
  ~68% of the time on a random stock; see `RESULTS.md` part 1.
- **High volatility fakes edges.** Several signals lost half their excess once
  measured against stocks of the same volatility (`--vol-matched`).
- **Per-signal averages don't survive portfolio constraints** when signals
  cluster on the same days (dip buying, `RESULTS.md` part 2).
- **Today's index members flatter everything** (survivorship); prefer
  survivorship-light universes (ETFs) or treat results as upper bounds.

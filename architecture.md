# Watchlist Scanner — Architecture

## Overview

Headless Node.js scanner — no TradingView Desktop, no CDP, no browser. Pulls daily OHLCV per symbol from Yahoo Finance (persisted incrementally in `data/bars.db`, a SQLite file), recomputes the full indicator suite locally, detects MACD signals over a lookback window, and sends a formatted report to Telegram. Runs Mon-Fri at 16:00 Israel time via GitHub Actions, triggered by an external scheduler (see "Triggering the Daily Run" below) rather than GitHub's native cron.

```
External scheduler (cron-job.org) ──POST workflow_dispatch──> GitHub Actions
        ↓
scan_headless.js
        ↓
lib/bars.js  ──fetch missing bars──>  Yahoo Finance
        ↓ (persisted OHLCV)
data/bars.db  (SQLite, one `bars` table keyed by symbol+date)
        ↓
lib/indicators.js  (full indicator suite, pure function)
        ↓
lib/report.js  (signal detection + Telegram formatting)
        ↓
Telegram Bot API
```

A separate legacy path (`legacy/scan_watchlist.js`) still exists, driving TradingView Desktop directly via CDP. It's not part of the automated pipeline — kept only for manually cross-checking `lib/indicators.js` against the live Pine indicator if drift is ever suspected.

## File Structure

```
watchlist-summary/
├── scan_headless.js         # Primary entry point — no TradingView dependency
├── lib/
│   ├── bars.js               # Persisted OHLCV, incremental Yahoo Finance fetch
│   ├── indicators.js         # Pure port of the Pine indicator (see reference/)
│   └── report.js             # Shared signal detection + Telegram formatting
├── data/bars.db              # SQLite: table `bars(symbol, date, open, high, low, close, volume)`
├── data/signals.csv          # Append-only historical log of every fired signal (never trimmed)
├── reference/
│   ├── macd.txt               # Pine source for CM_MacD_Ult_MTF (historical reference only)
│   └── indicatorSuite.txt     # Pine source for "MACD & RSI Smart Momentum Pro" — the ground truth lib/indicators.js ports
├── legacy/
│   ├── scan_watchlist.js      # Original CDP-based scanner (local cross-check only)
│   ├── scan.bat               # Launches TradingView + runs legacy/scan_watchlist.js
│   └── launch_tv_debug.bat    # Launches TradingView Desktop with CDP enabled
├── .github/workflows/scan.yml # workflow_dispatch trigger, runs scan_headless.js, commits data/bars.db
├── telegram.js                # sendMessage(text) → Telegram Bot API
├── watchlist.txt               # One symbol per line. # lines are comments.
├── telegram.config.json        # { "botToken": "...", "chatId": "..." }
└── package.json
```

## Data Persistence (`lib/bars.js`)

All symbols share a single SQLite file, `data/bars.db`, opened via Node's built-in `node:sqlite` (`DatabaseSync`) — no native dependency, but it's an experimental Node API (stable without a flag since Node 22.5; the workflow and any local run need Node ≥22). One table: `bars(symbol, date, open, high, low, close, volume)`, primary key `(symbol, date)`. On each run, per symbol:
1. Query the last stored date for that symbol.
2. If that's already today, skip the fetch entirely.
3. Otherwise fetch only bars *after* that date from Yahoo Finance (normally just the latest 1 bar).
4. If no rows exist yet for the symbol, do one full backfill (~750 calendar days, matching the Pine script's `max_bars_back=500`).
5. Upsert fetched rows (`ON CONFLICT DO UPDATE`), then delete all but the most recent 400 rows for that symbol.

Migrated from the original one-CSV-per-symbol layout (`data/bars/<SYMBOL>.csv`) to cut down on repo file sprawl (67 files → 1) and get indexed queries instead of hand-parsed CSV. `V` (Visa) appearing twice in `watchlist.txt` now shares one row set for `symbol = 'V'`, same as before.

No indicator state is cached — every run recomputes RSI/MACD/EMA/ATR/ADX fresh from the full stored OHLCV array (~500-800 rows, sub-10ms). Only raw price/volume history persists.

## Indicator Port (`lib/indicators.js`)

A pure function, `computeIndicators(bars)`, ported from `reference/indicatorSuite.txt` ("MACD & RSI Smart Momentum Pro [Swing Edition]"). Validated against live TradingView scrapes — RSI, ADX, Histogram, MACD line, ATR Trailing Stop, Trend, Score, Signal, and Warning all matched exactly (aside from trivial volume-figure rounding from a different data vendor).

Key implementation notes:
- **EMA(12)/EMA(26) → MACD line, EMA(9) signal, histogram** — matches `indicatorSuite.txt`'s `ta.ema(macdLine, signalSmoothing)`. Note this differs from `CM_MacD_Ult_MTF` (`reference/macd.txt`), which uses an **SMA** signal — the two indicators' histograms diverge slightly near zero-crossing points. `lib/indicators.js` follows the EMA-signal version since that's the actual production indicator whose table (RSI/Histogram/Trend/Score/etc.) this scanner reports on.
- **RSI, ATR, ADX/DMI** — Wilder's RMA smoothing (`rma()`), not SMA — matches Pine's `ta.rsi`/`ta.atr`/`ta.dmi` builtins.
- **HTF Trend** — not computed separately. The Pine script's higher-timeframe input defaults to `"D"` and this always runs on daily bars already, so `HTF Trend` is always identical to `Trend (EMA)` in this configuration (confirmed against live scrapes).
- **Pivot-based divergence** (`ta.pivothigh`/`ta.pivotlow`, lookback 14) — a pivot can only be confirmed once 14 *newer* bars exist past it, so "today" is never a confirmed pivot. Same lag as in Pine; not a bug.
- **ATR Trailing Stop** — sequential, stateful per-bar loop (`indicatorSuite.txt:371-403`), not a simple formula — ports directly.
- **Confluence score, confirmation bars, signal cooldown** — pure bar-index bookkeeping, ports directly.

## Signal Detection (`lib/report.js`)

Both scanners import this module, so behavior never drifts between the headless and legacy paths.

`MACD_LOOKBACK_DAYS = 5` — a signal stays active for 5 trading days after the actual crossover (still "recent/early"), then clears on its own once the window passes or the state reverses. No persisted "already alerted" state needed — recency is derived fresh each run from the bar history itself.

| Signal | Condition |
|--------|-----------|
| 🎯 ATR Reclaim (Bullish Confluence) | `price` crossed from at/below the ATR Trailing Stop to above it within the last `ATR_LOOKBACK_DAYS` (5) trading days (`detectAtrReclaim()`), AND is still above it today, AND `price > ema200`, AND `htfTrend === 'BULLISH'`. Named for the mechanical event, not "buy" — the condition alone isn't a trade recommendation. |
| ⚡ MACD TURNED GREEN | Histogram crossed from ≤0 to >0 within the last 5 trading days, AND today's histogram is still >0. Independent of the MACD line's sign — an early heads-up if the line is still negative, or a continuation signal if the line is already positive. |
| ⚡ MACD TURNED POSITIVE | The MACD line itself crossed from ≤0 to >0 within the last 5 trading days, AND is still >0 today. A more mature momentum confirmation than TURNED GREEN. |
| 📈 RSI RECLAIMED 30 | RSI crossed from ≤30 to >30 on **today's bar only** (`RSI_RECLAIM_LOOKBACK_DAYS = 1`, `detectRsiSignals()`) — fires once, the exact day it pops back out of oversold, not the day it dropped below 30 and not on subsequent days it happens to still be above 30. Telegram line includes the current RSI value. |
| 📊 VOLUME SURGE | `volumeRatio` (today's volume vs 20-day average, from `lib/indicators.js`) is ≥ `VOLUME_SURGE_THRESHOLD` (1.5x), AND today's close is above yesterday's close (`detectVolumeSignals()`). Unlike every other signal here, this is a **state check, not an event** — it fires every day volume stays elevated on an up day, not just the first day, by design (sustained high-volume buying is itself noteworthy each day it continues). Telegram line includes the volume ratio. |

The two MACD signals are independent and can both fire for the same symbol (e.g. histogram crossed green a few days before the line itself crossed positive). RSI RECLAIMED 30 is deliberately a same-day-only event (lookback of 1), unlike the 5-day lookback MACD/ATR signals — the point is to catch stocks the moment they exit oversold, not to keep flagging them for days afterward. VOLUME SURGE is the one exception to the event-not-state pattern used elsewhere in this file — a deliberate choice, not an oversight.

The ATR Reclaim signal originally used a static "within 3% above the ATR line" proximity check — a state check, not an event check, so a stock drifting slowly down toward its own (flat) trailing-stop line would get flagged every single day, not just the day it actually crossed. `detectAtrReclaim()` fixes this the same way the MACD signals were fixed: it requires an actual crossover within the lookback window (seen concretely with BRK-B, which sat continuously above its stop for 10+ days while just drifting closer — the old logic would've flagged it daily, the new logic correctly shows no signal). The legacy CDP scanner can't compute this, since CDP only exposes today's ATR Trailing Stop value, not per-bar history — its entries always carry `atrReclaimDaysAgo: null`, so it simply won't produce ATR Reclaim signals. It was originally called "Potential Buy" — renamed since the condition (trend-continuation reclaim with bullish confluence) isn't itself a trade recommendation.

`generateSummary()` adds inline annotations (RSI oversold/overbought, mixed trend, divergence, momentum fading, high volume, ATR proximity, EMA200 position).

`isAtrReclaim(r)` and `getActiveSignals(r)` are the single source of truth for which signals are "firing" on a result entry — both `formatTelegramMessages()` and `lib/signalLog.js` use them, so the Telegram report and the historical signal log can never drift apart.

## Historical Signal Log (`lib/signalLog.js`)

Every run appends one row per fired signal to `data/signals.csv` — `date,symbol,signal,price,atr,ema200,rsi`, where `signal` is one of `ATR RECLAIM`, `MACD TURNED GREEN`, `MACD TURNED POSITIVE`, `RSI RECLAIMED 30`, `VOLUME SURGE`. Note `VOLUME SURGE` is a state signal, so it can log the same symbol on consecutive days while volume stays elevated — every other signal here logs only once per event. `date` is the bar's actual trading date (from `lib/indicators.js`'s row), not the run's wall-clock date, so a late/manual run still logs against the correct day. Unlike `data/bars.db`, this file is append-only and never trimmed — it's a growing record for later research into which signals actually worked (e.g. cross-referencing against `data/bars.db` price history N days later).

## Telegram Report Format

```
*Watchlist Scan*

*🎯 ATR Reclaim (Bullish Confluence):*
*SYMBOL* $price (+x.x%)
  _just reclaimed ATR, above EMA200_

⚡ MACD Turned Green:
*ZETA* $12.50

⚡ MACD Turned Positive:
*MSFT* $390.00

📈 RSI Reclaimed 30 (Out of Oversold):
*SYMBOL* $price (RSI xx.xx)

📊 Volume Surge:
*SYMBOL* $price (N.NNx avg vol)
```
```
```

Messages are chunked at 3800 chars to stay under Telegram's 4096 limit.

**Testing/dry runs:** `node scan_headless.js --dry-run` prints the would-be report to stdout instead of calling `sendMessage()`. Bar data (`data/bars.db`) and the signal log (`data/signals.csv`) still update normally — only the Telegram send is skipped. Always use this when verifying new or changed signal logic; the live channel has real subscribers and a stray test post is noisy for them.

## Triggering the Daily Run

`.github/workflows/scan.yml` only declares `workflow_dispatch` — there is no native GitHub Actions `schedule` trigger. That's deliberate: `schedule` events are best-effort and this repo saw them both fire hours late (skipping the actual scan once a hand-rolled hour guard caught the mismatch) and not fire at all on other days, even after moving the cron off the top of the hour. GitHub Actions' scheduler is simply not reliable enough for a "same time every day" requirement here.

Instead, an **external scheduler calls the GitHub REST API to fire `workflow_dispatch`** at 16:00 Israel time, Mon-Fri:

```
POST https://api.github.com/repos/jakoel/trading-scanner/actions/workflows/scan.yml/dispatches
Authorization: Bearer <PAT with Actions: Read and write on this repo>
Accept: application/vnd.github+json
Content-Type: application/json

{ "ref": "main" }
```

Set up with e.g. [cron-job.org](https://cron-job.org) (free): create a job hitting the URL above with those headers/body, scheduled for 16:00 with the **time zone explicitly set to `Asia/Jerusalem`** (not a fixed UTC offset) so DST is handled by the scheduler itself — no need to juggle two UTC crons the way the old `schedule:` block did. The PAT lives only in the external scheduler's job config, never committed to this repo.

`workflow_dispatch` runs on-demand — no queueing, so no analogue of the schedule delays observed above. The workflow has no day-level de-duplication, so keep the external job to once/day; running it twice in the same day would re-send Telegram alerts for the same signals since the daily bar hasn't changed yet.

The workflow needs **Settings → Actions → General → Workflow permissions → Read and write** enabled, since it commits updated `data/bars.db` back to the repo after each run.

## Known Caveats

- Yahoo Finance is unofficial/unauthenticated — if it ever breaks, Stooq (free, no key, EOD CSV) is the fallback data source to switch `lib/bars.js` to.
- `V` (Visa) appears twice in `watchlist.txt` — both entries share one row set for `symbol = 'V'`, this is expected, not a bug.
- The legacy CDP scanner's `TURNED GREEN`/`TURNED POSITIVE` detection historically sourced its crossover *history* from `CM_MacD_Ult_MTF` (SMA signal) rather than the actual Momentum Pro indicator (EMA signal), because only `CM_MacD_Ult_MTF` exposed real per-bar history via `plots()` at the time. This means the legacy scanner and the headless scanner can occasionally disagree on marginal, near-zero histogram cases (seen with NVO) — the headless version is the more correct one, since it computes true history directly from the actual production indicator's own formula.

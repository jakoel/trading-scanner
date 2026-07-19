# Watchlist Scanner — Architecture

## Overview

Headless Node.js scanner — no TradingView Desktop, no CDP, no browser. Pulls daily OHLCV per symbol from Yahoo Finance (persisted incrementally in `data/bars/`), recomputes the full indicator suite locally, detects MACD signals over a lookback window, and sends a formatted report to Telegram. Runs on a schedule via GitHub Actions.

```
GitHub Actions (cron, Mon-Fri 16:00 Israel time)
        ↓
scan_headless.js
        ↓
lib/bars.js  ──fetch missing bars──>  Yahoo Finance
        ↓ (persisted OHLCV)
data/bars/<SYMBOL>.csv
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
├── data/bars/<SYMBOL>.csv    # One file per ticker: date,open,high,low,close,volume
├── data/signals.csv          # Append-only historical log of every fired signal (never trimmed)
├── reference/
│   ├── macd.txt               # Pine source for CM_MacD_Ult_MTF (historical reference only)
│   └── indicatorSuite.txt     # Pine source for "MACD & RSI Smart Momentum Pro" — the ground truth lib/indicators.js ports
├── legacy/
│   ├── scan_watchlist.js      # Original CDP-based scanner (local cross-check only)
│   ├── scan.bat               # Launches TradingView + runs legacy/scan_watchlist.js
│   └── launch_tv_debug.bat    # Launches TradingView Desktop with CDP enabled
├── .github/workflows/scan.yml # Cron trigger, runs scan_headless.js, commits data/bars/
├── telegram.js                # sendMessage(text) → Telegram Bot API
├── watchlist.txt               # One symbol per line. # lines are comments.
├── telegram.config.json        # { "botToken": "...", "chatId": "..." }
└── package.json
```

## Data Persistence (`lib/bars.js`)

Each symbol has one CSV under `data/bars/`. On each run:
1. Read the existing CSV (if any) → get the last stored date.
2. If that's already today, skip the fetch entirely.
3. Otherwise fetch only bars *after* that date from Yahoo Finance (normally just the latest 1 bar).
4. If no CSV exists yet, do one full backfill (~750 calendar days, matching the Pine script's `max_bars_back=500`).
5. Merge, dedupe by date, trim to the most recent 400 rows, write back — keeps each CSV small (401 lines with header).

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
| 🎯 Potential Buy | `price` crossed from at/below the ATR Trailing Stop to above it within the last `ATR_LOOKBACK_DAYS` (5) trading days (`detectAtrReclaim()`), AND is still above it today, AND `price > ema200`, AND `htfTrend === 'BULLISH'` |
| ⚡ MACD TURNED GREEN | Histogram crossed from ≤0 to >0 within the last 5 trading days, AND today's histogram is still >0. Independent of the MACD line's sign — an early heads-up if the line is still negative, or a continuation signal if the line is already positive. |
| ⚡ MACD TURNED POSITIVE | The MACD line itself crossed from ≤0 to >0 within the last 5 trading days, AND is still >0 today. A more mature momentum confirmation than TURNED GREEN. |

The two MACD signals are independent and can both fire for the same symbol (e.g. histogram crossed green a few days before the line itself crossed positive).

The Potential Buy signal originally used a static "within 3% above the ATR line" proximity check — a state check, not an event check, so a stock drifting slowly down toward its own (flat) trailing-stop line would get flagged every single day, not just the day it actually crossed. `detectAtrReclaim()` fixes this the same way the MACD signals were fixed: it requires an actual crossover within the lookback window (seen concretely with BRK-B, which sat continuously above its stop for 10+ days while just drifting closer — the old logic would've flagged it daily, the new logic correctly shows no signal). The legacy CDP scanner can't compute this, since CDP only exposes today's ATR Trailing Stop value, not per-bar history — its entries always carry `atrReclaimDaysAgo: null`, so it simply won't produce Potential Buy signals.

`generateSummary()` adds inline annotations (RSI oversold/overbought, mixed trend, divergence, momentum fading, high volume, ATR proximity, EMA200 position).

`isPotentialBuy(r)` and `getActiveSignals(r)` are the single source of truth for which signals are "firing" on a result entry — both `formatTelegramMessages()` and `lib/signalLog.js` use them, so the Telegram report and the historical signal log can never drift apart.

## Historical Signal Log (`lib/signalLog.js`)

Every run appends one row per fired signal to `data/signals.csv` — `date,symbol,signal,price,atr,ema200,rsi`, where `signal` is one of `POTENTIAL_BUY`, `MACD TURNED GREEN`, `MACD TURNED POSITIVE`. `date` is the bar's actual trading date (from `lib/indicators.js`'s row), not the run's wall-clock date, so a late/manual run still logs against the correct day. Unlike `data/bars/*.csv`, this file is append-only and never trimmed — it's a growing record for later research into which signals actually worked (e.g. cross-referencing against `data/bars/*.csv` price history N days later).

## Telegram Report Format

```
*Watchlist Scan*

*🎯 Potential Buys (just above ATR):*
*SYMBOL* $price (+x.x%)
  _just reclaimed ATR, above EMA200_

⚡ MACD Turned Green:
*ZETA* $12.50

⚡ MACD Turned Positive:
*MSFT* $390.00
```

Messages are chunked at 3800 chars to stay under Telegram's 4096 limit.

## GitHub Actions Schedule

`.github/workflows/scan.yml` triggers Mon-Fri. Israel alternates between UTC+2 (IST, winter) and UTC+3 (IDT, summer), so a single fixed-UTC cron would drift an hour off 16:00 Israel time twice a year. Both possible UTC times are scheduled (`13:00` and `14:00` UTC); a "Check target time" step reads the real `Asia/Jerusalem` wall-clock hour (tzdata handles DST automatically) and only lets the matching run continue past that step. A `workflow_dispatch` trigger is also available for manual runs.

The workflow needs **Settings → Actions → General → Workflow permissions → Read and write** enabled, since it commits updated `data/bars/*.csv` back to the repo after each run.

## Known Caveats

- Yahoo Finance is unofficial/unauthenticated — if it ever breaks, Stooq (free, no key, EOD CSV) is the fallback data source to switch `lib/bars.js` to.
- `V` (Visa) appears twice in `watchlist.txt` — both entries share one `data/bars/V.csv`, this is expected, not a bug.
- The legacy CDP scanner's `TURNED GREEN`/`TURNED POSITIVE` detection historically sourced its crossover *history* from `CM_MacD_Ult_MTF` (SMA signal) rather than the actual Momentum Pro indicator (EMA signal), because only `CM_MacD_Ult_MTF` exposed real per-bar history via `plots()` at the time. This means the legacy scanner and the headless scanner can occasionally disagree on marginal, near-zero histogram cases (seen with NVO) — the headless version is the more correct one, since it computes true history directly from the actual production indicator's own formula.

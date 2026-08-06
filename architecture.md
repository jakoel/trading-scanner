# Watchlist Scanner — Architecture

## Overview

Headless Node.js scanner — no TradingView Desktop, no CDP, no browser. Pulls daily OHLCV per symbol from Yahoo Finance (persisted incrementally in `data/bars.db`, a SQLite file), recomputes the full indicator suite locally, detects MACD signals over a lookback window, and sends a formatted report to Telegram. Runs Mon-Fri at 15:05 Israel time via GitHub Actions, triggered by an external scheduler (see "Triggering the Daily Run" below) rather than GitHub's native cron.

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
2. If that's already the last *closed* session (see below), skip the fetch entirely.
3. Otherwise re-fetch a 10-day trailing window ending at the cutoff, not just bars after the last stored date.
4. If no rows exist yet for the symbol, do one full backfill (~750 calendar days, matching the Pine script's `max_bars_back=500`).
5. Upsert fetched rows (`ON CONFLICT DO UPDATE`), then delete all but the most recent 400 rows for that symbol.

### Only completed sessions are stored

`lastClosedSessionDate()` returns the newest date whose US regular session (09:30–16:00 ET) has finished, and any fetched bar newer than that is discarded.

This matters because **Yahoo starts building the daily candle from pre-market trades**. The scan is dispatched pre-open (15:05 Israel; the US opens 16:30 Israel, or 15:30 during the few weeks a year when US DST is active and Israel's is not), so without this guard every run stored a partial bar for the current day — roughly a tenth of the day's volume and a pre-market print as the close. A pre-open run therefore reports on the **previous** completed session, which is the intent.

The guard is expressed as "has this session closed?" rather than "is this today?" so it also holds for a delayed dispatch, a mid-session manual run, and an after-close run (which correctly picks up that day's finished bar).

The 10-day trailing re-fetch in step 3 exists because the old "fetch only after `lastDate`" logic could never correct a bar once written. It also picks up Yahoo's post-close volume revisions, which are common in the first days after a session.

### Split detection (`isRebased()`)

Yahoo retroactively re-adjusts a symbol's **entire** price history when it splits, so stored bars stop sharing a price basis with newly fetched ones. Upserting the re-fetch window can't repair that — the bars *outside* the window are the ones now on the wrong basis, leaving a fake discontinuity that reads as a genuine crash rather than an error. Simulated on AAPL, a 2:1 split inverts `Trend`, drops RSI from 43 to 20 and swings the MACD line from +6.9 to −38.2, and would persist for ~200 trading days until the stale bars age out.

The trailing re-fetch window overlaps stored bars, which is what makes this detectable without a split calendar: if a bar already held comes back with a close differing by more than `REBASE_TOLERANCE` (2%), the symbol's rows are dropped and fully re-backfilled. The tolerance clears float/vendor noise while sitting far below the smallest split ratio in common use (5:4 = 25%).

Migrated from the original one-CSV-per-symbol layout (`data/bars/<SYMBOL>.csv`) to cut down on repo file sprawl (67 files → 1) and get indexed queries instead of hand-parsed CSV.

No indicator state is cached — every run recomputes RSI/MACD/EMA/ATR/ADX fresh from the full stored OHLCV array (~500-800 rows, sub-10ms). Only raw price/volume history persists.

## Indicator Port (`lib/indicators.js`)

A pure function, `computeIndicators(bars)`, ported from `reference/indicatorSuite.txt` ("MACD & RSI Smart Momentum Pro [Swing Edition]"). Validated against live TradingView scrapes — RSI, ADX, Histogram, MACD line, ATR Trailing Stop, Trend, Score, Signal, and Warning all matched exactly (aside from trivial volume-figure rounding from a different data vendor).

Key implementation notes:
- **EMA(12)/EMA(26) → MACD line, EMA(9) signal, histogram** — matches `indicatorSuite.txt`'s `ta.ema(macdLine, signalSmoothing)`. Note this differs from `CM_MacD_Ult_MTF` (`reference/macd.txt`), which uses an **SMA** signal — the two indicators' histograms diverge slightly near zero-crossing points. `lib/indicators.js` follows the EMA-signal version since that's the actual production indicator whose table (RSI/Histogram/Trend/Score/etc.) this scanner reports on.
- **RSI, ATR, ADX/DMI** — Wilder's RMA smoothing (`rma()`), not SMA — matches Pine's `ta.rsi`/`ta.atr`/`ta.dmi` builtins.
- **EMA seeding** — `ema()` stays `null` until `length` values exist, then seeds the recursion with the SMA of those values, matching Pine's `ta.ema`. Seeding with the first value instead leaves a seed-error residue that decays too slowly to disappear within the 400-bar retained window (~2% of it survives for a 200-length EMA), which showed up as a median 0.48% EMA200 discrepancy, worst case 2.6% — enough to flip `priceAboveEMA`, worth 2 of the 8 confluence points, for any symbol near its EMA200.
- **HTF Trend** — not computed separately. The Pine script's higher-timeframe input defaults to `"D"` and this always runs on daily bars already, so `HTF Trend` is always identical to `Trend (EMA)` in this configuration (confirmed against live scrapes).
- **Pivot-based divergence** (`ta.pivothigh`/`ta.pivotlow`, lookback 14) — a pivot can only be confirmed once 14 *newer* bars exist past it. Like Pine, `pivotHigh`/`pivotLow` therefore report the pivot's value at the **confirmation bar**, 14 bars after the pivot itself — so today's bar *can* carry a divergence flag (confirming a pivot from 14 bars ago), and the `highs[i - divLookback]` / `lows[i - divLookback]` lookups in the histogram-divergence block line up with it. Indexing the pivot at its own bar instead is wrong twice over: it leaks lookahead, and since the report only ever reads the newest bar it puts every pivot permanently out of reach, making divergence and the `⚠ TOP/BOTTOM FORMING` warnings unreachable dead code.
- **ATR Trailing Stop** — sequential, stateful per-bar loop (`indicatorSuite.txt:371-403`), not a simple formula — ports directly.
- **Confluence score, confirmation bars, signal cooldown** — pure bar-index bookkeeping, ports directly.

## Signal Detection (`lib/report.js`)

Both scanners import this module, so behavior never drifts between the headless and legacy paths.

**Every signal fires only on the bar its triggering event actually happened on** — all three lookback constants (`MACD_LOOKBACK_DAYS`, `ATR_LOOKBACK_DAYS`, `RSI_RECLAIM_LOOKBACK_DAYS`) are `1`. No persisted "already alerted" state is needed: the event is derived fresh each run from the bar history itself, and a crossover is only ever today's crossover.

The MACD and ATR lookbacks were originally `5`, on the reasoning that a signal is still "recent/early" for a few days after the cross. In practice that turned one event into five consecutive reports of the same thing. Over the ten sessions to 2026-08-05, **65% of MACD TURNED GREEN lines and 47% of ATR RECLAIM lines were re-announcements** of an event already sent on an earlier day (average green run: 2.78 trading days), and the 2026-08-05 report named 56 of 91 watchlist symbols across 85 lines on a day the watchlist was *down* 0.37% with 36 advancers. It also polluted `data/signals.csv`, which keys rows on `(date, symbol, signal)` and so logged one crossover up to five times under five different dates — enough to skew any hit-rate research over that file. `signals.csv` is the record of what fired and when; the Telegram report is a feed of what happened today. Don't widen these back out.

| Signal | Condition |
|--------|-----------|
| 🎯 ATR Reclaim (Bullish Confluence) | `price` crossed from at/below the ATR Trailing Stop to above it on **today's bar** (`detectAtrReclaim()`), AND `price > ema200`, AND `htfTrend === 'BULLISH'`. Named for the mechanical event, not "buy" — the condition alone isn't a trade recommendation. |
| ⚡ MACD TURNED GREEN | Histogram crossed from ≤0 to >0 on today's bar, **AND the MACD line is still negative**. The early-bottom case the section is named for. |
| ⚡ MACD TURNED POSITIVE | The MACD line itself crossed from ≤0 to >0 on today's bar. A more mature momentum confirmation than TURNED GREEN. |
| 📈 RSI RECLAIMED 30 | RSI crossed from ≤30 to >30 on today's bar (`detectRsiSignals()`) — fires once, the exact day it pops back out of oversold, not the day it dropped below 30 and not on subsequent days it happens to still be above 30. Telegram line includes the current RSI value. |
| 📊 VOLUME SURGE | `volumeRatio` (today's volume vs 20-day average, from `lib/indicators.js`) is ≥ `VOLUME_SURGE_THRESHOLD` (1.5x), AND today's close is above yesterday's close (`detectVolumeSignals()`). Unlike every other signal here, this is a **state check, not an event** — it fires every day volume stays elevated on an up day, not just the first day, by design (sustained high-volume buying is itself noteworthy each day it continues). Telegram line includes the volume ratio. |

The two MACD signals are now mutually exclusive by construction: TURNED GREEN requires a negative MACD line and TURNED POSITIVE requires a positive one. The `macdLineVal < 0` gate on TURNED GREEN is what makes the signal mean something. Ungated, a histogram crossing up while the line is already positive is ordinary re-acceleration inside an existing uptrend, and in a broad bounce it fires across the whole list at once — 47 of 91 symbols on 2026-08-05, i.e. a signal firing on half the watchlist, which says nothing beyond "the market went up". Those names still surface under TURNED POSITIVE on the day their line actually crosses zero.

VOLUME SURGE is the one exception to the event-not-state pattern used elsewhere in this file — a deliberate choice, not an oversight.

The ATR Reclaim signal originally used a static "within 3% above the ATR line" proximity check (and later a 5-day crossover window, since narrowed to today's bar along with the MACD signals) — a state check, not an event check, so a stock drifting slowly down toward its own (flat) trailing-stop line would get flagged every single day, not just the day it actually crossed. `detectAtrReclaim()` fixes this the same way the MACD signals were fixed: it requires an actual crossover within the lookback window (seen concretely with BRK-B, which sat continuously above its stop for 10+ days while just drifting closer — the old logic would've flagged it daily, the new logic correctly shows no signal). The legacy CDP scanner can't compute this, since CDP only exposes today's ATR Trailing Stop value, not per-bar history — its entries always carry `atrReclaimDaysAgo: null`, so it simply won't produce ATR Reclaim signals. It was originally called "Potential Buy" — renamed since the condition (trend-continuation reclaim with bullish confluence) isn't itself a trade recommendation.

`generateSummary()` adds inline annotations (RSI oversold/overbought, mixed trend, divergence, momentum fading, high volume, ATR proximity, EMA200 position).

`isAtrReclaim(r)` and `getActiveSignals(r)` are the single source of truth for which signals are "firing" on a result entry — both `formatTelegramMessages()` and `lib/signalLog.js` use them, so the Telegram report and the historical signal log can never drift apart.

## Historical Signal Log (`lib/signalLog.js`)

Every run appends one row per newly fired signal to `data/signals.csv` — `date,symbol,signal,price,atr,ema200,rsi`, where `signal` is one of `ATR RECLAIM`, `MACD TURNED GREEN`, `MACD TURNED POSITIVE`, `RSI RECLAIMED 30`, `VOLUME SURGE`. Note `VOLUME SURGE` is a state signal, so it can log the same symbol on consecutive days while volume stays elevated — every other signal here logs only once per event. `date` is the bar's actual trading date (from `lib/indicators.js`'s row), not the run's wall-clock date, so a late/manual run still logs against the correct day. Unlike `data/bars.db`, this file is append-only and never trimmed — it's a growing record for later research into which signals actually worked (e.g. cross-referencing against `data/bars.db` price history N days later).

Since every signal is a same-day event (see above), each row is one distinct occurrence — a symbol reappearing for the same signal on a later date is a genuinely separate crossover, not the same one re-logged. Rows written before 2026-08-06 predate that change and *do* contain up to five rows per crossover for the MACD and ATR signals; any analysis spanning that boundary should collapse consecutive-session runs of the same `(symbol, signal)` first.

Rows are keyed on `(date, symbol, signal)` and existing keys are skipped, so a re-run on the same trading day — a manual scan, a retried dispatch — can't append a second copy of a signal already logged and double-count it in that research. The key deliberately excludes price/RSI, which can shift slightly between two runs against the same bar.

## Staleness Guard (`scan_headless.js`)

Before any fetch, the scanner reads `latestStoredSessionDate()` — `MAX(date)` across `data/bars.db`, i.e. the session the *previous* run reported on. After the scan, if the newest session reached by any symbol is not later than that, the run is **stale** and the Telegram send is skipped.

This exists because of a real incident: on 2026-08-04 the scan re-reported the 2026-07-31 bar, because the 2026-08-03 session never made it into `bars.db` (confirmed by reading `data/bars.db` out of commit `9864e9d` — its newest bar is 07-31). The 08-03 session, +3.24% with 78 of 91 symbols advancing, went entirely unscanned, and subscribers received a silent re-send of Friday's report. Nothing in the pipeline noticed, and nothing could have: the message is deliberately dateless (see below), and the run exited green. The 08-03 and 08-04 bars were both backfilled by the next day's 10-day trailing re-fetch, which is why 08-04 then looked like an outsized signal spike.

The guard is on the symptom, not the cause — whatever makes a run land on an already-reported session (a Yahoo publication lag, a rebuild path dropping the newest bar, a double dispatch), it has nothing new to say and must not post. Notes on the design:

- **No new state file.** `MAX(date)` read before `updateBars()` runs already *is* the previous run's session.
- **Warns, doesn't fail.** It emits a `::warning::` annotation so the anomaly is visible on the Actions run page, but exits 0 so the bar-data commit still happens — a stale run often *repairs* older bars, and those repairs are worth keeping.
- **It also covers double dispatches.** A second run on the same day now no-ops instead of re-sending the same alerts (the caveat under "Triggering the Daily Run" is now enforced, not just documented).
- **`--dry-run` still prints the report** under a `⚠ STALE` banner rather than suppressing it, so the guard doesn't blind you while testing signal changes.

## Telegram Report Format

The message carries no title or date line — it opens directly on the first populated section. It always arrives pre-market on a weekday and always summarizes the last completed session (so a Monday message covers Friday), which makes the session unambiguous from context; a date line would only add noise. Don't "fix" this by adding one.

Sections always render in this order — the two strongest, most actionable reads first, then the momentum shifts, then the oversold bounce:

```
*🎯 ATR Reclaim (Bullish Confluence):*
*SYMBOL* $price
  _above EMA200_

📊 Volume Surge:
*SYMBOL* $price (N.NNx avg vol)

⚡ MACD Turned Positive (Confirmed Positive Momentum):
*MSFT* $390.00

⚡ MACD Turned Green (Early Bottom, MACD Still Negative):
*ZETA* $12.50

📈 RSI Reclaimed 30 (Out of Oversold):
*SYMBOL* $price (RSI xx.xx)
```

Empty sections are skipped entirely, so the message opens on whichever of these is first populated. Within a section, symbols are sorted alphabetically (see `formatTelegramMessages()`), so a symbol keeps its position from one day's message to the next.

Messages are chunked at 3800 chars to stay under Telegram's 4096 limit.

### ATR Reclaim lines carry no distance-to-stop figure

They used to print `(price − atrTrailingStop) / atrTrailingStop` as a percentage. It looks like performance and isn't: the ATR Trailing Stop flips sides on a reclaim, resetting to `low − 3 × ATR(10)` on the very bar the signal fires, so the gap is always one fresh full stop-width. The number therefore only ever reported how wide that symbol's ATR band is. On 2026-08-05, MRVL printed `+37.0%` against GDX's `+16.3%` — not because MRVL's reclaim was stronger but because MRVL is more volatile, and MRVL in fact closed *down* 3.5% that day. BE printed `+70.1%` off a stop that had just reset from 268.52 to 137.73.

The stop level itself is real and reconciles exactly to the Pine formula, but it isn't shown either — verified for BE/MRVL/GDX against `low − 3 × ATR(10)` with `atrLength = 10`, `atrMultiplier = 3.0` (`reference/indicatorSuite.txt:53-54`). Two properties make it a poor thing to put in a headline: it's at its widest on exactly the bar the report prints it (from the next bar it ratchets up via `max(prevStop, close − 3×ATR)` and never loosens), and it's anchored to the day's low rather than the close.

Don't reintroduce either figure. Note this leaves the `just reclaimed ATR` and `close to ATR flip` branches in `generateSummary()` unreachable for this section — an ATR Reclaim entry is by definition a full stop-width above its stop, never within 3% of it.

### Sector labels on ETFs

Every line printed for an ETF gets a trailing ` · sector` tag, from `SECTOR_LABELS` in `lib/report.js`:

```
*BOTZ* $34.12 · Robotics & Automation ETF
*XBI* $88.40 (RSI 31.20) · Biotech ETF
```

A ticker like BOTZ or COPX means nothing to a reader who doesn't already hold it, so the report says what it tracks — and names it as an ETF, so a reader doesn't mistake it for a single company. Individual stocks are deliberately **not** labelled — their tickers are the company names, and tagging all 81 would bury the signal rather than add to it.

Labels must not contain Telegram's legacy-Markdown metacharacters (`*`, `_`, `` ` ``, `[`). The API rejects a message with unbalanced markup outright, so one stray underscore in a label kills the whole report rather than just rendering oddly. Adding a new ETF to `watchlist.txt` without adding it here is harmless — `sectorTag()` returns an empty string for anything unlabelled.

**Testing/dry runs:** `node scan_headless.js --dry-run` prints the would-be report to stdout instead of calling `sendMessage()`. Bar data (`data/bars.db`) and the signal log (`data/signals.csv`) still update normally — only the Telegram send is skipped. Always use this when verifying new or changed signal logic; the live channel has real subscribers and a stray test post is noisy for them.

## Triggering the Daily Run

`.github/workflows/scan.yml` only declares `workflow_dispatch` — there is no native GitHub Actions `schedule` trigger. That's deliberate: `schedule` events are best-effort and this repo saw them both fire hours late (skipping the actual scan once a hand-rolled hour guard caught the mismatch) and not fire at all on other days, even after moving the cron off the top of the hour. GitHub Actions' scheduler is simply not reliable enough for a "same time every day" requirement here.

Instead, an **external scheduler calls the GitHub REST API to fire `workflow_dispatch`** at 15:05 Israel time, Mon-Fri:

```
POST https://api.github.com/repos/jakoel/trading-scanner/actions/workflows/scan.yml/dispatches
Authorization: Bearer <PAT with Actions: Read and write on this repo>
Accept: application/vnd.github+json
Content-Type: application/json

{ "ref": "main" }
```

Set up with e.g. [cron-job.org](https://cron-job.org) (free): create a job hitting the URL above with those headers/body, scheduled for 15:05 with the **time zone explicitly set to `Asia/Jerusalem`** (not a fixed UTC offset) so DST is handled by the scheduler itself — no need to juggle two UTC crons the way the old `schedule:` block did. The PAT lives only in the external scheduler's job config, never committed to this repo.

`workflow_dispatch` runs on-demand — no queueing, so no analogue of the schedule delays observed above. Keep the external job to once/day; a second run in the same day has no new bar to report, and is caught by the staleness guard above (it logs a warning and skips the send rather than re-alerting).

The workflow needs **Settings → Actions → General → Workflow permissions → Read and write** enabled, since it commits updated `data/bars.db` back to the repo after each run.

## Known Caveats

- Yahoo Finance is unofficial/unauthenticated — if it ever breaks, Stooq (free, no key, EOD CSV) is the fallback data source to switch `lib/bars.js` to.
- `V` (Visa) appears twice in `watchlist.txt` — both entries share one row set for `symbol = 'V'`, this is expected, not a bug.
- The legacy CDP scanner's `TURNED GREEN`/`TURNED POSITIVE` detection historically sourced its crossover *history* from `CM_MacD_Ult_MTF` (SMA signal) rather than the actual Momentum Pro indicator (EMA signal), because only `CM_MacD_Ult_MTF` exposed real per-bar history via `plots()` at the time. This means the legacy scanner and the headless scanner can occasionally disagree on marginal, near-zero histogram cases (seen with NVO) — the headless version is the more correct one, since it computes true history directly from the actual production indicator's own formula.

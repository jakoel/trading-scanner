# Watchlist Scanner — Claude Instructions

Headless Node.js watchlist scanner. No TradingView Desktop, no CDP, no GUI required — runs standalone or via GitHub Actions, triggered Mon–Fri at 16:00 Israel time by an external scheduler calling `workflow_dispatch` (GitHub's native `schedule` trigger proved unreliable — see architecture.md).

## Before touching this project

Read **[architecture.md](./architecture.md)** first — it covers file structure, the indicator port, data persistence, signal conditions, Telegram format, and known caveats. Do not re-analyze from scratch.

## Running the scanner

```bash
cd watchlist-summary
node scan_headless.js
```

No TradingView, no external services beyond Yahoo Finance (for daily bars) and Telegram (for the report). Runs automatically via `.github/workflows/scan.yml`.

**When testing or verifying a change (e.g. new/modified signal logic), always use `--dry-run`:**

```bash
node scan_headless.js --dry-run
```

Prints the report to stdout instead of posting it — bar data and `data/signals.csv` still update normally, only the Telegram send is skipped. Without this flag, every run posts a real message to the user's live Telegram broadcast channel, which is noisy for their audience. Only omit `--dry-run` for actual scheduled/production runs.

## Key files

| File | Purpose |
|------|---------|
| `scan_headless.js` | Entry point: pulls bars, computes indicators, detects signals, sends the report |
| `lib/bars.js` | Persisted OHLCV in `data/bars.db` (SQLite), incrementally fetched via Yahoo Finance |
| `lib/indicators.js` | Pure reimplementation of the Pine indicator (`reference/indicatorSuite.txt`) — RSI, MACD, ATR, ADX, divergence, confluence score, ATR trailing stop |
| `lib/report.js` | Shared signal detection (5-day lookback crossovers) + Telegram formatting, used by both scanners |
| `telegram.js` | `sendMessage(text)` — Telegram Bot API wrapper |
| `watchlist.txt` | Symbols to scan, one per line (`#` = comment) |
| `telegram.config.json` | `{ "botToken": "...", "chatId": "..." }` |
| `.github/workflows/scan.yml` | `workflow_dispatch`-only trigger (fired daily by an external scheduler, Mon–Fri 16:00 Israel time), runs the scan, commits updated `data/bars.db` |
| `architecture.md` | Full technical reference |
| `legacy/` | Original TradingView/CDP-based scanner — kept for local cross-checking against the live indicator, not used by automation. See `legacy/README` note in architecture.md. |
| `reference/` | Raw Pine source (`macd.txt`, `indicatorSuite.txt`) that `lib/indicators.js` was ported from |

## Adding new signals

1. Check `architecture.md` for what `lib/indicators.js` already computes per bar
2. Add detection logic in `lib/report.js` (shared by both scanners) so it stays consistent
3. Either add to `generateSummary()` for inline summary text, or add a new section in `formatTelegramMessages()` for a dedicated report block

## Using the legacy CDP scanner (optional, for cross-checking)

```bash
node legacy/scan_watchlist.js
```

Requires TradingView Desktop running with `--remote-debugging-port=9222` and both indicators visible on a 1D chart. Useful for validating `lib/indicators.js` against the live indicator if you ever suspect drift, but not part of the automated pipeline.

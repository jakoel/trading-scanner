# Watchlist Summary Scanner

Headless Node.js watchlist scanner — no TradingView Desktop, no browser, no GUI. Pulls daily price history from Yahoo Finance, reimplements the MACD/RSI/ATR/ADX indicator logic locally, and sends a formatted Telegram report. The whole pipeline runs on GitHub Actions — there's no local setup step for normal use.

## Setup

Set two repository secrets under **Settings → Secrets and variables → Actions → New repository secret**:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

`telegram.js` reads these as environment variables in the workflow. Nothing needs to be created or edited locally — there's no `telegram.config.json` to fill in for the GitHub Actions path (that file only matters for local/legacy runs — see below).

## Usage

Edit `watchlist.txt` (one ticker per line) and push to `main`. To run the scan itself, go to the **Actions** tab on GitHub → **"Watchlist Scan"** → **Run workflow**:
- Leave **Dry run** unchecked for a real run — sends the Telegram report and commits updated bar data (`data/bars.db`) back to the repo.
- Check **Dry run** to print the report to the workflow's job log instead — skips Telegram and skips the data commit, safe to trigger repeatedly while testing.

In production, an external scheduler (cron-job.org) fires this same workflow automatically Mon–Fri at 15:05 Israel time — see `architecture.md` for why that's external rather than GitHub's native `schedule` trigger.

First run per symbol does a one-time backfill (~2-3 years of daily bars via Yahoo Finance) into `data/bars.db` (SQLite); every run after that only fetches the bars missing since the last stored date (usually just the latest one).

## What it computes

For each symbol, `lib/indicators.js` reproduces the full indicator suite from the original Pine script (`reference/indicatorSuite.txt`): RSI, MACD line/signal/histogram, EMA 200 trend, ATR + ATR Trailing Stop, ADX strength, RSI/MACD divergence, momentum acceleration, volume ratio, and the confluence score/signal/warning columns.

## Telegram output

Stocks are grouped into sections:
- **🎯 ATR Reclaim (Bullish Confluence)** — price crossed from at/below the ATR Trailing Stop to above it within the last 5 trading days, still above it today, above EMA200, bullish HTF trend
- **⚡ MACD Turned Green** — histogram crossed from negative to positive on today's bar while the MACD line is still negative (the early-bottom case)
- **⚡ MACD Turned Positive** — the MACD line itself crossed zero on today's bar *and* the histogram is positive (a more mature momentum confirmation)
- **📈 RSI Reclaimed 30** — RSI crossed back above 30 on today's bar only
- **📊 Volume Surge** — today's volume ≥1.75x its 20-day average on an up day (fires every day it stays elevated, not just once)

See `architecture.md` for the full technical reference, including why a 5-trading-day lookback replaced the original single-bar magnitude thresholds.

## Legacy TradingView/CDP scanner (local only)

`legacy/scan_watchlist.js` is the original scanner, driving TradingView Desktop directly via Chrome DevTools Protocol. It's kept only for locally cross-checking `lib/indicators.js` against the live Pine indicator — not part of the automated pipeline, and the only part of this repo you'd run locally. Requires TradingView Desktop running with `--remote-debugging-port=9222` and both indicators visible on a 1D chart:

```bash
npm install
```

Create `telegram.config.json` (gitignored — never commit real credentials) if you want this local run to post to Telegram too:
```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "chatId": "YOUR_CHAT_ID"
}
```

```bash
node legacy/scan_watchlist.js
```

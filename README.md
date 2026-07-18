# Watchlist Summary Scanner

Headless Node.js watchlist scanner — no TradingView Desktop, no browser, no GUI. Pulls daily price history from Yahoo Finance, reimplements the MACD/RSI/ATR/ADX indicator logic locally, and sends a formatted Telegram report. Runs automatically on a schedule via GitHub Actions (Mon–Fri, 16:00 Israel time), or manually with one command.

## Setup

```bash
npm install
```

Create `telegram.config.json`:
```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "chatId": "YOUR_CHAT_ID"
}
```

## Usage

Edit `watchlist.txt` (one ticker per line), then run:

```bash
node scan_headless.js
```

First run per symbol does a one-time backfill (~2-3 years of daily bars via Yahoo Finance) into `data/bars/<SYMBOL>.csv`; every run after that only fetches the bars missing since the last stored date (usually just the latest one).

## Automation (GitHub Actions)

`.github/workflows/scan.yml` runs the scan Monday–Friday at 16:00 Israel time and commits the updated `data/bars/*.csv` files back to the repo, so the persisted history travels with the repo across runs. See `architecture.md` for how it handles Israel's daylight-saving switch.

## What it computes

For each symbol, `lib/indicators.js` reproduces the full indicator suite from the original Pine script (`reference/indicatorSuite.txt`): RSI, MACD line/signal/histogram, EMA 200 trend, ATR + ATR Trailing Stop, ADX strength, RSI/MACD divergence, momentum acceleration, volume ratio, and the confluence score/signal/warning columns.

## Telegram output

Stocks are grouped into sections:
- **🎯 Potential Buys** — price just above the ATR Trailing Stop (within 3%), above EMA200, bullish trend
- **⚡ MACD Turned Green** — histogram crossed from negative to positive within the last 5 trading days (early signal if the MACD line is still negative, continuation signal if it's already positive)
- **⚡ MACD Turned Positive** — the MACD line itself crossed zero within the last 5 trading days (a more mature momentum confirmation)

See `architecture.md` for the full technical reference, including why a 5-trading-day lookback replaced the original single-bar magnitude thresholds.

## Legacy TradingView/CDP scanner

`legacy/scan_watchlist.js` is the original scanner, driving TradingView Desktop directly via Chrome DevTools Protocol. It's kept only for locally cross-checking `lib/indicators.js` against the live Pine indicator — not part of the automated pipeline. Requires TradingView Desktop running with `--remote-debugging-port=9222` and both indicators visible on a 1D chart:

```bash
node legacy/scan_watchlist.js
```

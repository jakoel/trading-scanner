# Watchlist Scanner — Architecture

## Overview

Standalone Node.js scanner (no MCP, no API tokens). Connects directly to TradingView Desktop via CDP, scans all symbols in `watchlist.txt`, and sends a formatted report to Telegram.

```
Node.js Scanner ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
                                                       ↓
                                             Telegram Bot API
```

## File Structure

```
watchlist-summary/
├── scan_watchlist.js     # Main script — all scanning, signal detection, Telegram formatting
├── telegram.js           # Thin wrapper: sendMessage(text) → Telegram Bot API
├── watchlist.txt         # One symbol per line (e.g. AAPL, MSFT). # lines are comments.
├── telegram.config.json  # { "botToken": "...", "chatId": "..." }
└── package.json          # Dependencies: chrome-remote-interface, ws, commander
```

## Prerequisites

1. TradingView Desktop running (launched via `tv_launch` MCP tool or manually with `--remote-debugging-port=9222`)
2. Both indicators loaded and **visible** on the chart:
   - **"MACD & RSI Smart Momentum Pro [Claude Code]"** — provides RSI, Histogram, Trend (EMA), HTF Trend, Momentum, Divergence, Volume via Pine table, and ATR Trailing Stop + EMA 200 via data window
   - **CM_MacD_Ult_MTF** — provides MACD line value via data window (title `MACD`), required for MACD signal detection
3. Chart on daily timeframe (`1D`)

## Data Extraction

Two parallel extraction paths per symbol:

### 1. Data Window (`readIndicatorData`)
Iterates all `dataSources`, reads `.dataWindowView().items()` matching by `_title`:
- `ATR Trailing Stop` → `atr` (from "MACD & RSI Smart Momentum Pro")
- `EMA 200` → `ema200` (from "MACD & RSI Smart Momentum Pro")
- `macd` / `macd line` / `macd value` (case-insensitive) → `macdLine` (from CM_MacD_Ult_MTF)
- Price from `model.mainSeries().bars().last().value[4]`

### 2. Pine Table (`tableData`)
Finds the "Momentum Pro" indicator by `meta.description`, reads `_primitivesCollection.dwgtablecells` → maps row[col0] = row[col1]:
- `RSI`, `Histogram`, `Trend (EMA)`, `HTF Trend`, `Momentum`, `Divergence`, `Volume`

MACD line fallback: if not found in data window, checks table keys `MACD`, `MacD`, `MACD Line`.

## Signal Detection

All signals computed in the main loop after data extraction:

| Signal | Condition |
|--------|-----------|
| Potential Buy | `price > atr` AND within 3% above |
| Above ATR & Running | `price > atr` AND more than 3% above |
| ⚡ MACD TURNED GREEN | `macdHistNum > 0` AND `macdLineVal < 0` (histogram green, MACD still negative) |
| ⚡ MACD TURNED POSITIVE | `macdHistNum > 0` AND `macdLineVal > 0` (MACD line crossed zero) |

`generateSummary()` adds inline annotations (RSI oversold/overbought, mixed trend, divergence, momentum fading, high volume, ATR proximity, EMA200 position).

## Telegram Report Format

```
*Watchlist Scan*

*Potential Buys (just above ATR):*
*SYMBOL* $price (+x.x%)
  RSI 55 | UPTREND | STRENGTHENING
  _just reclaimed ATR, above EMA200_

*Above ATR & Running:*
...

⚡ *MACD Signals:*
⚡ *MSFT* $390.00 — MACD TURNED POSITIVE
⚡ *ZETA* $12.50 — MACD TURNED GREEN
```

Messages are chunked at 3800 chars to stay under Telegram's 4096 limit.

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `CDP_PORT` | 9222 | CDP remote debugging port |
| `SETTLE_MS` | 4000ms | Wait after symbol switch for indicators to load |
| Retry attempts | 6 × 1500ms | Retry if data not yet available |

## Known Caveats

- MACD line detection depends on the Pine indicator's `plot()` title in the data window. If `macdLineVal` is always null, log `item._title` values for the MACD indicator and add the matching title to `macdLineTitles` in `readIndicatorData`.
- Unicode minus `−` (U+2212) used by TradingView — all value parsing strips it before `parseFloat`.
- Stocks below ATR are scanned but excluded from ATR sections. They still appear in ⚡ MACD Signals if applicable.

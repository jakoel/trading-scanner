# Watchlist Summary Scanner

Standalone Node.js script that connects to TradingView Desktop via CDP, scans your watchlist, reads indicator data, and sends a formatted summary to Telegram.

## Prerequisites

1. **TradingView Desktop** running with remote debugging enabled:
   ```
   TradingView.exe --remote-debugging-port=9222
   ```
   Or use the launch script from the MCP project: `tradingview-mcp-jackson/scripts/launch_tv_debug_win.bat`

2. Both indicators loaded and **visible** on the chart:
   - **"MACD & RSI Smart Momentum Pro [Claude Code]"** — RSI, trend, momentum, divergence, volume, histogram, ATR Trailing Stop, EMA 200
   - **CM_MacD_Ult_MTF** — MACD line value (required for MACD signal detection)

3. **Node.js** 18+

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
node scan_watchlist.js
```

## What it reads

For each symbol, the scanner extracts:
- **Price, ATR, EMA 200, MACD line** from the indicator data window
- **RSI, MACD Histogram, Trend, HTF Trend, Momentum, Divergence, Volume** from the Pine table

## Telegram output

Stocks are grouped into sections:
- **Potential Buys** — above ATR, within 3%
- **Above ATR & Running** — more than 3% above ATR
- **⚡ MACD Signals** — stocks where MACD just turned green or positive (regardless of ATR position)

### MACD signal conditions
- **⚡ MACD TURNED GREEN** — histogram is positive AND MACD line is still negative AND histogram < 3% of price. Means MACD crossed above Signal but both lines are still below zero (early momentum shift).
- **⚡ MACD TURNED POSITIVE** — MACD line just crossed above zero AND MACD line < 1.5% of price (confirming it just happened, not deep into positive territory).

Each stock shows price, ATR %, RSI, trend, momentum, and a short summary of noteworthy signals (RSI extremes, mixed trends, divergences, momentum fading, high volume, EMA200 position).

# Watchlist Scanner — Claude Instructions

Standalone Node.js script that scans a watchlist via TradingView CDP and sends a Telegram report. No MCP, no API tokens required.

## Before touching this project

Read **[architecture.md](./architecture.md)** first — it covers file structure, data extraction paths, all signal conditions, Telegram format, and known caveats. Do not re-analyze from scratch.

## Running the scanner

```bash
cd watchlist-summary
node scan_watchlist.js
```

TradingView Desktop must be running with CDP enabled. If it's not, launch it first:
- Via MCP: `tv_launch` tool
- Manually: TradingView Desktop auto-starts with CDP when launched by the MCP server

## Key files

| File | Purpose |
|------|---------|
| `scan_watchlist.js` | Everything: scanning loop, signal detection, Telegram formatting |
| `telegram.js` | `sendMessage(text)` — Telegram Bot API wrapper |
| `watchlist.txt` | Symbols to scan, one per line (`#` = comment) |
| `telegram.config.json` | `{ "botToken": "...", "chatId": "..." }` |
| `architecture.md` | Full technical reference |

## Indicators required on chart

Both must be **visible** (not hidden) on the TradingView chart, on **1D timeframe**:
1. **MACD & RSI Smart Momentum Pro [Claude Code]** — provides Pine table data (RSI, trend, histogram, etc.) and ATR Trailing Stop + EMA 200 via data window
2. **CM_MacD_Ult_MTF** — provides MACD line value via data window (required for MACD signal detection)

## Adding new signals

1. Check `architecture.md` for the data available per symbol
2. Add detection logic in the main loop (after table extraction, before `generateSummary`)
3. Either add to `generateSummary()` for inline summary text, or add a new section in `formatTelegramMessages()` for a dedicated report block

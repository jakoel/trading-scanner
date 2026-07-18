/**
 * Headless watchlist scanner — no TradingView Desktop, no CDP, no GUI.
 *
 * Pulls daily OHLCV per symbol (persisted incrementally in data/bars/*.csv,
 * fetched via Yahoo Finance), recomputes the full indicator suite locally
 * (lib/indicators.js, a port of indicatorSuite.txt), and sends the same
 * Telegram report as scan_watchlist.js via the shared lib/report.js logic.
 *
 * Usage:
 *   node scan_headless.js
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sendMessage } from './telegram.js';
import { updateBars } from './lib/bars.js';
import { computeIndicators } from './lib/indicators.js';
import { detectMacdSignals, generateSummary, formatTelegramMessages, MACD_LOOKBACK_DAYS } from './lib/report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const watchlist = readFileSync(join(__dirname, 'watchlist.txt'), 'utf-8')
  .split('\n')
  .map(s => s.trim())
  .filter(s => s && !s.startsWith('#'));

async function main() {
  console.log(`Scanning ${watchlist.length} symbols...`);

  const results = [];

  for (const symbol of watchlist) {
    try {
      const bars = await updateBars(symbol);
      if (bars.length < 210) {
        console.log(`  ${symbol.padEnd(6)} — skipped (only ${bars.length} bars, need ~210 for EMA200 warmup)`);
        continue;
      }

      const rows = computeIndicators(bars);
      const last = rows[rows.length - 1];

      const price = Math.round(last.price * 100) / 100;
      const atr = Math.round(last.atrTrailingStop * 100) / 100;
      const ema200 = last.ema200 ? Math.round(last.ema200 * 100) / 100 : null;
      const rsi = last.rsi != null ? last.rsi.toFixed(2) : '—';
      const macdHist = last.histogram != null ? last.histogram.toFixed(4) : '—';
      const macdLineVal = last.macdLine;

      // Chronological (oldest-first) {macd, hist} history for the last 7 trading
      // days, matching the shape lib/report.js expects for crossover detection.
      const macdHistory = rows.slice(-7).map(r => ({ macd: r.macdLine, hist: r.histogram }));

      const { macdSignals, positiveCrossDaysAgo, greenCrossDaysAgo, todayHistVal } =
        detectMacdSignals(macdLineVal, macdHistory);

      const summary = generateSummary({
        price, atr, ema200, rsi,
        trend: last.trend, htfTrend: last.htfTrend,
        momentum: last.momentum, divergence: last.divergence, volume: last.volume,
      });

      const entry = {
        symbol, price, atr, ema200, rsi, macdHist, macdLineVal, macdSignals,
        trend: last.trend, htfTrend: last.htfTrend, momentum: last.momentum,
        divergence: last.divergence, volume: last.volume, summary,
      };
      results.push(entry);

      const pct = ((price - atr) / atr * 100).toFixed(1);
      const tag = price > atr ? 'ABOVE' : 'BELOW';
      console.log(`  ${symbol.padEnd(6)} $${price.toFixed(2).padStart(8)} | ATR $${atr.toFixed(2).padStart(8)} | ${pct}% ${tag} | RSI ${rsi} | ${last.trend} | ${summary}`);
      console.log(`    [MACD DEBUG] macdLineVal=${macdLineVal} macdHistRaw="${macdHist}" todayHistVal=${todayHistVal} price=${price}`);
      console.log(`    [MACD DEBUG] positiveCrossDaysAgo=${positiveCrossDaysAgo} greenCrossDaysAgo=${greenCrossDaysAgo} lookback=${MACD_LOOKBACK_DAYS}d | macdSignals=${macdSignals.length ? macdSignals.join(', ') : 'none'}`);
    } catch (e) {
      console.log(`  ${symbol.padEnd(6)} — error: ${e.message}`);
    }
  }

  if (results.length > 0) {
    const msgs = formatTelegramMessages(results);
    if (msgs.length === 0) {
      console.log('\nNo buys or running stocks — skipping Telegram.');
    } else {
      console.log(`\nSending Telegram alert (${msgs.length} message(s))...`);
      for (const msg of msgs) {
        await sendMessage(msg);
      }
      console.log('Done!');
    }
  } else {
    console.log('No results to send.');
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

/**
 * Headless watchlist scanner — no TradingView Desktop, no CDP, no GUI.
 *
 * Pulls daily OHLCV per symbol (persisted incrementally in data/bars.db,
 * fetched via Yahoo Finance), recomputes the full indicator suite locally
 * (lib/indicators.js, a port of indicatorSuite.txt), and sends the same
 * Telegram report as scan_watchlist.js via the shared lib/report.js logic.
 *
 * Usage:
 *   node scan_headless.js             # normal run, posts to Telegram
 *   node scan_headless.js --dry-run   # prints the report instead of sending it
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sendMessage } from './telegram.js';
import { updateBars } from './lib/bars.js';
import { computeIndicators } from './lib/indicators.js';
import { detectMacdSignals, detectAtrReclaim, detectRsiSignals, detectVolumeSignals, generateSummary, formatTelegramMessages } from './lib/report.js';
import { logSignals } from './lib/signalLog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const watchlist = readFileSync(join(__dirname, 'watchlist.txt'), 'utf-8')
  .split('\n')
  .map(s => s.trim())
  .filter(s => s && !s.startsWith('#'));

const dryRun = process.argv.includes('--dry-run');

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

      // Chronological (oldest-first) history for the last 7 trading days,
      // matching the shape lib/report.js expects for crossover detection.
      const macdHistory = rows.slice(-7).map(r => ({ macd: r.macdLine, hist: r.histogram }));
      const atrHistory = rows.slice(-7).map(r => ({ price: r.price, atr: r.atrTrailingStop }));
      const rsiHistory = rows.slice(-7).map(r => ({ rsi: r.rsi }));

      const { macdSignals } = detectMacdSignals(macdLineVal, macdHistory);
      const atrReclaimDaysAgo = detectAtrReclaim(atrHistory);
      const { rsiSignals } = detectRsiSignals(rsiHistory);
      const prevPrice = rows.length >= 2 ? rows[rows.length - 2].price : null;
      const { volumeSignals } = detectVolumeSignals({ volumeRatio: last.volumeRatio, price, prevPrice });

      const summary = generateSummary({
        price, atr, ema200, rsi,
        trend: last.trend, htfTrend: last.htfTrend,
        momentum: last.momentum, divergence: last.divergence, volume: last.volume,
      });

      const entry = {
        symbol, date: last.date, price, atr, ema200, rsi, macdHist, macdLineVal, macdSignals, atrReclaimDaysAgo, rsiSignals,
        volumeSignals, volumeRatio: last.volumeRatio,
        trend: last.trend, htfTrend: last.htfTrend, momentum: last.momentum,
        divergence: last.divergence, volume: last.volume, summary,
      };
      results.push(entry);

      const pct = ((price - atr) / atr * 100).toFixed(1);
      const tag = price > atr ? 'ABOVE' : 'BELOW';
      console.log(`  ${symbol.padEnd(6)} $${price.toFixed(2).padStart(8)} | ATR $${atr.toFixed(2).padStart(8)} | ${pct}% ${tag} | RSI ${rsi} | ${last.trend} | ${summary}`);
    } catch (e) {
      console.log(`  ${symbol.padEnd(6)} — error: ${e.message}`);
    }
  }

  if (results.length > 0) {
    logSignals(results);

    const msgs = formatTelegramMessages(results);
    if (msgs.length === 0) {
      console.log('\nNo buys or MACD signals — skipping Telegram.');
    } else if (dryRun) {
      console.log(`\n[DRY RUN] Would send ${msgs.length} Telegram message(s):\n`);
      for (const msg of msgs) {
        console.log('---');
        console.log(msg);
      }
      console.log('---');
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

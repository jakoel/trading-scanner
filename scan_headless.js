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
import { updateBars, latestStoredSessionDate } from './lib/bars.js';
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

  // Captured before any fetch, so it names the session the *previous* run
  // reported on. On 2026-08-04 the scan re-reported the 2026-07-31 bar because
  // the 08-03 session never made it into bars.db: the whole +3.24%, 78-of-91
  // advancer session went unscanned and subscribers got a silent re-send of
  // Friday's report, with no way to tell (the message is deliberately
  // dateless). Whatever the upstream cause, a run that lands on a session
  // already reported has nothing new to say and must not post.
  const previousSession = latestStoredSessionDate();

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
        trend: last.trend, htfTrend: last.htfTrend, divergence: last.divergence,
      });

      // `trend` feeds the console line, `htfTrend` the ATR Reclaim gate in
      // isAtrReclaim(), `volumeRatio` the Volume Surge report line. The
      // indicator's remaining table cells (adx/score/signal/warning/momentum/
      // volume) stay on the computeIndicators() row — the validated mirror of
      // the TradingView table — and are deliberately not copied here.
      const entry = {
        symbol, date: last.date, price, atr, ema200, rsi, macdSignals, atrReclaimDaysAgo, rsiSignals,
        volumeSignals, volumeRatio: last.volumeRatio,
        trend: last.trend, htfTrend: last.htfTrend, summary,
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

    // The newest bar any symbol reached — a symbol lagging a day (a halt, a
    // late listing) shouldn't drag the whole run's session backwards.
    const session = results.map(r => r.date).filter(Boolean).sort().pop();
    const stale = previousSession != null && session != null && session <= previousSession;

    const msgs = formatTelegramMessages(results);
    if (msgs.length === 0) {
      console.log('\nNo buys or MACD signals — skipping Telegram.');
    } else if (stale) {
      // ::warning:: surfaces this on the Actions run page without failing the
      // job, so the bar-data commit still happens (the run may well have
      // repaired older bars) while the anomaly stops being invisible.
      console.log(`::warning::Stale scan — latest completed session is still ${session}, already reported by the previous run. Telegram send skipped.`);
      console.log(`\n⚠ STALE: newest session is ${session}, same as the previous run. Not sending.`);
      if (dryRun) {
        console.log('\n[DRY RUN] Report that would have been suppressed:\n');
        for (const msg of msgs) {
          console.log('---');
          console.log(msg);
        }
        console.log('---');
      }
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

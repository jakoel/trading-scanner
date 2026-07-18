/**
 * Watchlist ATR Scanner
 *
 * Connects to TradingView via CDP, scans each symbol in watchlist.txt,
 * reads indicator table data, and sends a formatted summary to Telegram.
 *
 * Prerequisites:
 *   1. TradingView Desktop running with --remote-debugging-port=9222
 *   2. "MACD & RSI Smart Momentum Pro [Claude Code]" indicator loaded on chart
 *   3. telegram.config.json with botToken and chatId
 *   4. watchlist.txt with one symbol per line
 *
 * Usage (from repo root):
 *   node legacy/scan_watchlist.js
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import CDP from 'chrome-remote-interface';
import { sendMessage } from '../telegram.js';
import { detectMacdSignals, generateSummary, formatTelegramMessages, MACD_LOOKBACK_DAYS } from '../lib/report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const watchlist = readFileSync(join(__dirname, '..', 'watchlist.txt'), 'utf-8')
  .split('\n')
  .map(s => s.trim())
  .filter(s => s && !s.startsWith('#'));

const CDP_PORT = 9222;
const SETTLE_MS = 4000;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function findChartTarget() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find(t => t.type === 'page' && /tradingview/i.test(t.url));
}

async function evaluate(client, expr) {
  const result = await client.Runtime.evaluate({
    expression: expr,
    returnByValue: true,
    awaitPromise: false,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'eval error');
  }
  return result.result?.value;
}

/** Read price, ATR, and EMA200 from the data window */
async function readIndicatorData(client) {
  return evaluate(client, `
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var model = chart.model();
        var bars = model.mainSeries().bars();
        var last = bars.last();
        var price = last ? last.value[4] : null;

        var atrVal = null;
        var ema200 = null;
        var macdLine = null;
        // Chronological (oldest-first) history of {macd, hist} pulled straight from
        // CM_MacD_Ult_MTF's own plots (plot_0 = MACD, plot_4 = Histogram), which keep real
        // per-bar history unlike the Pine table's Histogram cell. Used for true crossover
        // detection over the last several trading days.
        var macdHistory = null;
        var sources = model.model().dataSources();
        for (var si = 0; si < sources.length; si++) {
          var s = sources[si];
          if (!s.metaInfo) continue;
          try {
            var meta = s.metaInfo();
            var name = (meta.description || meta.shortDescription || '').toLowerCase();
            var isMacdUlt = name.indexOf('cm_macd') !== -1 || name.indexOf('macd_ult') !== -1;
            var dwv = s.dataWindowView();
            if (!dwv) continue;
            var items = dwv.items();
            if (!items) continue;
            for (var i = 0; i < items.length; i++) {
              var item = items[i];
              if (!item._title || !item._value || item._value === '\\u2205') continue;
              var v = parseFloat(item._value.replace(/\u2212/g, '-').replace(/,/g, ''));
              if (item._title === 'ATR Trailing Stop' && !isNaN(v)) atrVal = v;
              if (item._title === 'EMA 200' && !isNaN(v)) ema200 = v;
              if (isMacdUlt && item._title === 'MACD' && !isNaN(v)) macdLine = v;
            }
            if (isMacdUlt) {
              var plotItems = s.plots && s.plots()._items;
              if (plotItems && plotItems.length >= 2) {
                macdHistory = plotItems.slice(-7).map(function(it) {
                  return { macd: it.value[1], hist: it.value[5] };
                });
              }
            }
          } catch(e) {}
        }

        return { price: price, atr: atrVal, ema200: ema200, macdLine: macdLine, macdHistory: macdHistory };
      } catch(e) { return { error: e.message }; }
    })()
  `);
}

async function main() {
  console.log(`Scanning ${watchlist.length} symbols...`);

  const target = await findChartTarget();
  if (!target) {
    console.error('No TradingView chart target found. Is TradingView running with --remote-debugging-port=9222?');
    process.exit(1);
  }

  const client = await CDP({ port: CDP_PORT, target: target.id });
  await client.Runtime.enable();

  const results = [];

  for (const symbol of watchlist) {
    try {
      // Switch symbol
      await client.Runtime.evaluate({
        expression: `
          (function() {
            var chart = window.TradingViewApi._activeChartWidgetWV.value();
            return new Promise(function(resolve) {
              chart.setSymbol('${symbol}', {});
              setTimeout(resolve, 500);
            });
          })()
        `,
        returnByValue: true,
        awaitPromise: true,
      });
      await sleep(SETTLE_MS);

      // Read data with retries
      let data = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        data = await readIndicatorData(client);
        if (data && data.price != null && data.atr != null) break;
        await sleep(1500);
      }

      if (!data || data.price == null || data.atr == null) {
        console.log(`  ${symbol.padEnd(6)} — skipped (no data): price=${data?.price} atr=${data?.atr} err=${data?.error || 'none'}`);
        continue;
      }

      // Read indicator table
      const tableData = await evaluate(client, `
        (function() {
          try {
            var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
            var model = chart.model();
            var sources = model.model().dataSources();
            for (var si = 0; si < sources.length; si++) {
              var s = sources[si];
              if (!s.metaInfo) continue;
              var meta = s.metaInfo();
              var name = meta.description || meta.shortDescription || '';
              if (name.indexOf('Momentum Pro') === -1) continue;
              var g = s._graphics;
              if (!g || !g._primitivesCollection) continue;
              var tc = g._primitivesCollection.dwgtablecells;
              if (!tc) continue;
              var inner = tc.get('tableCells');
              if (!inner || !inner._primitivesDataById) continue;
              var rows = {};
              inner._primitivesDataById.forEach(function(v) {
                if (v.tid !== 1) return;
                if (!rows[v.row]) rows[v.row] = {};
                rows[v.row][v.col] = (v.t || '').trim();
              });
              var parsed = {};
              for (var r in rows) {
                if (rows[r][0] && rows[r][1]) parsed[rows[r][0]] = rows[r][1];
              }
              return parsed;
            }
            return null;
          } catch(e) { return null; }
        })()
      `);

      const price = Math.round(data.price * 100) / 100;
      const atr = Math.round(data.atr * 100) / 100;
      const ema200 = data.ema200 ? Math.round(data.ema200 * 100) / 100 : null;

      const rsi = tableData?.RSI || '—';
      const macdHist = tableData?.Histogram || '—';
      const trend = tableData?.['Trend (EMA)'] || '—';
      const htfTrend = tableData?.['HTF Trend'] || '—';
      const momentum = tableData?.Momentum || '—';
      const divergence = tableData?.Divergence || '—';
      const volume = tableData?.Volume || '—';

      // Resolve MACD line value: prefer data window, fall back to table keys
      let macdLineVal = data.macdLine;
      let macdLineSource = macdLineVal != null ? 'data.macdLine' : null;
      if (macdLineVal == null) {
        for (const key of ['MACD', 'MacD', 'MACD Line', 'MACD line', 'MACD Value']) {
          const raw = tableData?.[key];
          if (raw != null) {
            const parsed = parseFloat(String(raw).replace(/\u2212/g, '-').replace(/,/g, ''));
            if (!isNaN(parsed)) { macdLineVal = parsed; macdLineSource = `tableData['${key}']`; break; }
          }
        }
      }

      const macdHistNum = parseFloat(String(macdHist).replace(/\u2212/g, '-').replace(/,/g, ''));

      // See lib/report.js for the full rationale behind these two independent signals.
      const macdHistory = data.macdHistory;
      const { macdSignals, positiveCrossDaysAgo, greenCrossDaysAgo, todayHistVal } =
        detectMacdSignals(macdLineVal, macdHistory);

      const summary = generateSummary({ price, atr, ema200, rsi, macdHist, trend, htfTrend, momentum, divergence, volume });

      // No historical ATR Trailing Stop is available from CDP (only today's snapshot),
      // so this legacy path can't detect a real reclaim event — see architecture.md.
      const entry = { symbol, price, atr, ema200, rsi, macdHist, macdLineVal, macdSignals, atrReclaimDaysAgo: null, trend, htfTrend, momentum, divergence, volume, summary };
      results.push(entry);

      const pct = ((price - atr) / atr * 100).toFixed(1);
      const tag = price > atr ? 'ABOVE' : 'BELOW';
      console.log(`  ${symbol.padEnd(6)} $${price.toFixed(2).padStart(8)} | ATR $${atr.toFixed(2).padStart(8)} | ${pct}% ${tag} | RSI ${rsi} | ${trend} | ${summary}`);
      console.log(`    [MACD DEBUG] macdLineVal=${macdLineVal} (source=${macdLineSource}) macdHistRaw="${macdHist}" macdHistNum=${macdHistNum} todayHistVal(fromCM_MacD_Ult_MTF)=${todayHistVal} price=${price}`);
      console.log(`    [MACD DEBUG] macdHistory(oldest→newest)=${JSON.stringify(macdHistory)}`);
      console.log(`    [MACD DEBUG] positiveCrossDaysAgo=${positiveCrossDaysAgo} greenCrossDaysAgo=${greenCrossDaysAgo} lookback=${MACD_LOOKBACK_DAYS}d | macdSignals=${macdSignals.length ? macdSignals.join(', ') : 'none'}`);
      console.log(`    [MACD DEBUG] data.macdLine=${data.macdLine} | tableData=${JSON.stringify(tableData)}`);

    } catch (e) {
      console.log(`  ${symbol.padEnd(6)} — error: ${e.message}`);
    }
  }

  await client.close();

  if (results.length > 0) {
    const msgs = formatTelegramMessages(results);
    if (msgs.length === 0) {
      console.log('\nNo buys or MACD signals — skipping Telegram.');
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

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

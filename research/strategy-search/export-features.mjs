/**
 * Exports continuous MACD / RSI / ATR features (from the production
 * lib/indicators.js) plus forward returns for every stock-day, for the
 * cross-sectional ranking study (rank-study.py). Output: research/.out_feat.csv
 * (gitignored). Forward returns are from the NEXT open (when a pre-market reader
 * could act) to the close h sessions later.
 *
 *   node research/strategy-search/export-features.mjs [--db=research/long_daily.db]
 */
import { createWriteStream } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { computeIndicators } from '../../lib/indicators.js';
import { detectFvgSignals, bullishFvg, FVG_RETEST_LOOKBACK } from '../../lib/fairValue.js';

// Production detectFvgSignals() with the displacement filter switchable off
// (dispMult 0 = plain 3-candle gap), for the unfiltered comparison.
function fvgUnfiltered(bars, i) {
  const formed = !!bullishFvg(bars, i, { dispMult: 0 });
  let retest = false;
  for (let j = i - 1; j >= Math.max(2, i - FVG_RETEST_LOOKBACK) && !retest; j--) {
    const z = bullishFvg(bars, j, { dispMult: 0 }); if (!z) continue;
    let mit = false; for (let k = j + 1; k < i; k++) if (bars[k].close < z.bottom) { mit = true; break; }
    if (!mit && bars[i].low <= z.top && bars[i].close > z.bottom) retest = true;
  }
  return { formed, retest };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const db = new DatabaseSync(arg('db', join(__dirname, '..', 'long_daily.db')), { readonly: true });
const out = createWriteStream(join(__dirname, '..', '.out_feat.csv'));
const H = [5, 10, 15, 20];
const cols = ['symbol', 'date', 'price', 'rsi', 'rsi_chg5', 'hist_atr', 'macd_atr', 'sig_atr', 'hist_slope3', 'stop_dist', 'atr_pct', 'atr_chg20',
  'adx', 'adx_chg5', 'ema200_dist', 'score', 'vol_ratio', 'ret5', 'ret20', 'ret60', 'vol60', 'dollar_vol20',
  'fvg_f', 'fvg_r', 'fvg_f0', 'fvg_r0', 'macd_bullx', 'macd_green', 'macd_zerox', ...H.map(h => `fwd${h}`)];
out.write(cols.join(',') + '\n');
const syms = db.prepare("SELECT DISTINCT symbol FROM bars WHERE symbol NOT IN ('SPY','QQQ','IWM') ORDER BY symbol").all().map(r => r.symbol);
const f = x => (x == null || !Number.isFinite(x) ? '' : +x.toPrecision(6));
let n = 0;
for (const sym of syms) {
  const bars = db.prepare('SELECT date, open, high, low, close, volume FROM bars WHERE symbol = ? ORDER BY date').all(sym);
  if (bars.length < 300) continue;
  const R = computeIndicators(bars), c = bars.map(b => b.close), dr = c.map((x, i) => (i ? x / c[i - 1] - 1 : 0));
  let buf = '';
  for (let i = 260; i < R.length; i++) {
    const r = R[i], a = r.atr;
    if (!(a > 0) || r.rsi == null || r.histogram == null) continue;
    let m = 0; for (let k = i - 59; k <= i; k++) m += dr[k]; m /= 60; let v = 0; for (let k = i - 59; k <= i; k++) v += (dr[k] - m) ** 2;
    let dv = 0; for (let k = i - 19; k <= i; k++) dv += bars[k].close * bars[k].volume;
    const row = [sym, r.date, f(r.price), f(r.rsi), f(r.rsi - R[i - 5].rsi), f(r.histogram / a), f(r.macdLine / a), f(r.signalLine / a),
      f((r.histogram - R[i - 3].histogram) / a), f(r.atrTrailingStop != null ? (r.price - r.atrTrailingStop) / a : null), f(a / r.price), f(a / R[i - 20].atr),
      f(r.adx), f(r.adx != null && R[i - 5].adx != null ? r.adx - R[i - 5].adx : null), f(r.ema200 ? r.price / r.ema200 - 1 : null),
      f(parseInt(r.score, 10)), f(r.volumeRatio), f(c[i] / c[i - 5] - 1), f(c[i] / c[i - 20] - 1), f(c[i] / c[i - 60] - 1), f(Math.sqrt(v / 59)), f(dv / 20),
      ...(() => {
        const { fvgSignals } = detectFvgSignals(bars, i), u = fvgUnfiltered(bars, i), p = R[i - 1];
        const bullx = p.histogram != null && p.histogram <= 0 && r.histogram > 0;
        const zerox = p.macdLine != null && p.macdLine <= 0 && r.macdLine > 0 && r.histogram > 0;
        return [+fvgSignals.includes('BULLISH FVG FORMED'), +fvgSignals.includes('BULLISH FVG RETEST'), +u.formed, +u.retest,
          +bullx, +(bullx && r.macdLine < 0), +zerox];
      })(),
      ...H.map(h => (i + h < bars.length ? f(c[i + h] / bars[i + 1].open - 1) : ''))];
    buf += row.join(',') + '\n'; n++;
  }
  out.write(buf);
}
out.end(() => console.log(`${n} stock-days from ${syms.length} symbols -> research/.out_feat.csv`));

/**
 * ETF relative-strength rotation (the classic TradingView "rotation" idea) on a
 * mostly survivorship-free universe: sector / broad / international / bond /
 * commodity ETFs. Monthly: rank by momentum, hold the top K equal-weight, and
 * (optionally) only hold names with positive absolute momentum — else cash.
 *
 *   node research/strategy-search/rotation.mjs [--db=research/etf_daily.db]
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const db = new DatabaseSync(arg('db', join(__dirname, '..', 'etf_daily.db')));
const COST = 0.0005;
const dates = db.prepare('SELECT DISTINCT date FROM bars ORDER BY date').all().map(r => r.date);
const D = dates.length, dIdx = new Map(dates.map((d, i) => [d, i]));
const syms = db.prepare('SELECT symbol FROM bars GROUP BY symbol HAVING COUNT(*) > 300').all().map(r => r.symbol);
const px = {}, op = {};
for (const s of syms) {
  const c = new Float64Array(D).fill(NaN), o = new Float64Array(D).fill(NaN);
  for (const r of db.prepare('SELECT date, open, close FROM bars WHERE symbol = ?').all(s)) { c[dIdx.get(r.date)] = r.close; o[dIdx.get(r.date)] = r.open; }
  px[s] = c; op[s] = o;
}
const START = 260, cut1 = Math.floor(D * 0.6), cut2 = Math.floor(D * 0.8);
function stats(dr, from, to) {
  let eq = 1, peak = 1, dd = 0, sum = 0, sq = 0, n = 0;
  for (let d = from; d < to; d++) { eq *= 1 + dr[d]; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); sum += dr[d]; sq += dr[d] ** 2; n++; }
  const m = sum / n, sd = Math.sqrt(Math.max(0, sq / n - m * m));
  return { cagr: Math.pow(eq, 252 / n) - 1, vol: sd * Math.sqrt(252), sharpe: sd ? m / sd * Math.sqrt(252) : 0, mdd: dd };
}
const P = x => (x * 100).toFixed(1).padStart(6) + '%';
function report(label, dr) {
  const a = stats(dr, START, D), t = stats(dr, START, cut1), v = stats(dr, cut1, cut2), e = stats(dr, cut2, D);
  console.log(`${label.padEnd(50)} CAGR ${P(a.cagr)} vol ${P(a.vol)} Sharpe ${a.sharpe.toFixed(2).padStart(5)} maxDD ${P(a.mdd)} | CAGR tr/va/te ${P(t.cagr)} ${P(v.cagr)} ${P(e.cagr)} | DD test ${P(e.mdd)}`);
}
const ret = (s, d) => px[s][d] / px[s][d - 1] - 1;

const spyR = new Float64Array(D); for (let d = 1; d < D; d++) spyR[d] = ret('SPY', d);
const ew = new Float64Array(D); for (let d = 1; d < D; d++) { let s = 0, n = 0; for (const x of syms) { const r = ret(x, d); if (r === r) { s += r; n++; } } ew[d] = n ? s / n : 0; }
console.log(`${syms.length} ETFs, ${D} days ${dates[0]} → ${dates.at(-1)}`);
console.log('\n=== BENCHMARKS ===');
report('SPY buy & hold', spyR);
report('Equal-weight all ETFs', ew);

const score = {
  '12-1': (s, t) => px[s][t - 21] / px[s][t - 252] - 1,
  '6m': (s, t) => px[s][t] / px[s][t - 126] - 1,
  'avg 1/3/6/12m': (s, t) => (px[s][t] / px[s][t - 21] + px[s][t] / px[s][t - 63] + px[s][t] / px[s][t - 126] + px[s][t] / px[s][t - 252]) / 4 - 1,
};
function rotate({ K, sc, absFilter, regime }) {
  const dr = new Float64Array(D);
  let held = []; // symbols currently held, equal weight
  for (let d = START; d < D; d++) {
    // rebalance decided at close of t=d-1 on a 21-day grid, executes at open of d
    let rebalance = (d - 1) % 21 === 0, next = held;
    if (rebalance) {
      const t = d - 1;
      const rank = syms.filter(s => px[s][t - 252] === px[s][t - 252] && px[s][t] === px[s][t]).map(s => ({ s, v: score[sc](s, t) })).filter(x => x.v === x.v).sort((a, b) => b.v - a.v);
      let top = rank.slice(0, K);
      if (absFilter) top = top.filter(x => x.v > 0);
      if (regime) { const spyOk = px.SPY[t] > px.SPY.slice(t - 199, t + 1).reduce((a, x) => a + x, 0) / 200; if (!spyOk) top = []; }
      next = top.map(x => x.s);
    }
    const w = 1 / K;
    let r = 0;
    for (const s of held) { // continuing or exiting positions earn overnight (close->open) if they are being sold at open
      if (rebalance && !next.includes(s)) { r += w * (op[s][d] / px[s][d - 1] - 1 - COST); }
      else if (rebalance) { r += w * (px[s][d] / px[s][d - 1] - 1); }
      else r += w * (px[s][d] / px[s][d - 1] - 1);
    }
    if (rebalance) for (const s of next) if (!held.includes(s)) r += w * (px[s][d] / op[s][d] - 1 - COST);
    dr[d] = r; held = next;
  }
  return dr;
}
for (const sc of Object.keys(score)) {
  console.log(`\n=== ROTATION, score = ${sc} ===`);
  for (const K of [1, 3, 5, 8]) for (const [lab, absFilter, regime] of [['relative only', false, false], ['+ absolute momentum>0 (else cash)', true, false], ['+ SPY>200d regime', false, true]]) {
    report(`top-${K} ${lab}`, rotate({ K, sc, absFilter, regime }));
  }
}

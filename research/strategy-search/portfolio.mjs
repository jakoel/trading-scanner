/**
 * Capped-slot portfolio backtester. Judges strategies the way a TradingView
 * strategy report would — equity curve, CAGR, Sharpe, max drawdown — instead
 * of per-signal win rate, and against benchmarks that share the same
 * (survivorship-flattered) universe.
 *
 *   node research/strategy-search/portfolio.mjs [--db=research/long_daily.db] [--limit-syms=N]
 *
 * Model: K equal slots, each worth 1/K of equity (rebalanced daily, cash earns
 * 0). Signals use bar t's close; entries fill at bar t+1's open; 0.05% cost per
 * side. Bracket exits check the stop before the target inside a bar. Symbols
 * with gaps in their history are skipped (global-date alignment).
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { computeFlags, marketFlags, sma, rsi } from './flags.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const db = new DatabaseSync(arg('db', join(__dirname, '..', 'long_daily.db')));
const LIMIT = Number(arg('limit-syms', '0'));
const SIDE_COST = 0.0005;
const START = 260; // warm-up bars before any strategy trades

// ── load + align ──────────────────────────────────────────────────────────
let names = db.prepare('SELECT symbol, COUNT(*) n FROM bars GROUP BY symbol HAVING n >= 400 ORDER BY symbol').all().map(r => r.symbol);
if (LIMIT) names = names.slice(0, LIMIT);
if (!names.includes('SPY')) names.push('SPY');
const q = db.prepare('SELECT date, open, high, low, close, volume FROM bars WHERE symbol = ? ORDER BY date');
const allDates = db.prepare('SELECT DISTINCT date FROM bars ORDER BY date').all().map(r => r.date);
const D = allDates.length, dIdx = new Map(allDates.map((d, i) => [d, i]));
const S = [];
let gaps = 0;
for (const name of names) {
  const r = q.all(name), n = r.length;
  const first = dIdx.get(r[0].date), last = dIdx.get(r.at(-1).date);
  if (last - first + 1 !== n) { gaps++; if (name !== 'SPY') continue; }
  const b = { name, off: first, n, o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  r.forEach((x, i) => { b.o[i] = x.open; b.h[i] = x.high; b.l[i] = x.low; b.c[i] = x.close; b.v[i] = x.volume; });
  S.push(b);
}
const spy = S.find(s => s.name === 'SPY');
console.log(`${S.length} symbols aligned (${gaps} skipped for gaps), ${D} dates ${allDates[0]} → ${allDates.at(-1)}`);

// ── per-symbol precompute ─────────────────────────────────────────────────
const sf = marketFlags(spy);
const at = (s, d) => d - s.off; // local index, may be out of range
const mktDip = new Uint8Array(D), spyBull = new Uint8Array(D);
for (let d = 0; d < D; d++) { const i = at(spy, d); if (i >= 0 && i < spy.n) { mktDip[d] = sf.rsiBelow40[i]; spyBull[d] = sf.above200[i]; } }
for (const s of S) {
  const mk = { valid: new Uint8Array(s.n), above200: new Uint8Array(s.n), rsiBelow40: new Uint8Array(s.n) };
  for (let i = 0; i < s.n; i++) { const d = s.off + i; mk.valid[i] = d >= 0 ? sf.valid[at(spy, d)] ?? 0 : 0; mk.above200[i] = spyBull[d]; mk.rsiBelow40[i] = mktDip[d]; }
  const { flags, aux } = computeFlags(s, mk);
  s.f = flags; s.atr = aux.atr; s.rsi14 = aux.rsi; s.ema10 = aux.ema10;
  s.rsi2 = rsi(s.c, 2); s.sma5 = sma(s.c, 5); s.sma200 = sma(s.c, 200);
  s.anyTrig = new Uint8Array(s.n);
  for (let i = 0; i < s.n; i++) s.anyTrig[i] = (s.f.stochCrossUp[i] | s.f.insideBreak[i] | s.f.macdHistTurnPos[i] | s.f.nr7Break[i] | s.f.cciUpM100[i]);
  s.mom = new Float64Array(s.n).fill(NaN); s.roc20 = new Float64Array(s.n).fill(NaN);
  for (let i = 252; i < s.n; i++) s.mom[i] = s.c[i - 21] / s.c[i - 252] - 1; // 12-1 momentum
  for (let i = 20; i < s.n; i++) s.roc20[i] = s.c[i] / s.c[i - 20] - 1;
}

// ── exits → {x, px, openExit} ──────────────────────────────────────────────
function bracket(s, e, a, tp, sl, T) {
  const px = s.o[e], tpP = px + tp * a, slP = px - sl * a, last = Math.min(e + T - 1, s.n - 1);
  for (let j = e; j <= last; j++) {
    if (s.l[j] <= slP) return { x: j, px: j > e && s.o[j] < slP ? s.o[j] : slP };
    if (h(s, j) >= tpP) return { x: j, px: j > e && s.o[j] > tpP ? s.o[j] : tpP };
  }
  return { x: last, px: s.c[last] };
}
const h = (s, j) => s.h[j];
const holdN = (s, e, N) => { const x = Math.min(e + N - 1, s.n - 1); return { x, px: s.c[x] }; };
const holdToOpen = (s, e, N) => { const x = e + N; return x < s.n ? { x, px: s.o[x], openExit: true } : { x: s.n - 1, px: s.c[s.n - 1] }; };
function rsi2Exit(s, e, a) { // close > SMA5 or 3xATR stop or 10 bars
  const slP = s.o[e] - 3 * a, last = Math.min(e + 9, s.n - 1);
  for (let j = e; j <= last; j++) {
    if (s.l[j] <= slP) return { x: j, px: j > e && s.o[j] < slP ? s.o[j] : slP };
    if (j > e && s.c[j] > s.sma5[j]) return { x: j, px: s.c[j] };
  }
  return { x: last, px: s.c[last] };
}

// ── engine ────────────────────────────────────────────────────────────────
function run({ K, candidates, exitFor, gate }) {
  const dayRet = new Float64Array(D), expo = new Float64Array(D), trades = [];
  let open = [];
  for (let d = START; d < D; d++) {
    // a close/intraday exit on day d still occupies its slot that day; an exit at the open frees it
    open = open.filter(t => t.x > d || (t.x === d && !t.openExit));
    if (gate && !gate(d - 1)) continue;
    const slots = K - open.length;
    if (slots <= 0) continue;
    const held = new Set(open.map(t => t.s));
    const cand = candidates(d - 1).filter(c => !held.has(c.s));
    cand.sort((a, b) => b.score - a.score);
    for (const c of cand.slice(0, slots)) {
      const s = c.s, e = d - s.off;
      if (e < 1 || e >= s.n) continue;
      const a = s.atr[e - 1];
      if (!(a > 0) || !(s.o[e] > 0)) continue;
      const ex = exitFor(s, e, a);
      const t = { s, e, x: ex.x + s.off, px: ex.px, openExit: !!ex.openExit };
      open.push(t);
      // contribute daily returns for days e..x
      const w = 1 / K;
      let eq = 1;
      for (let dd = d; dd <= t.x; dd++) {
        const i = dd - s.off, ref = dd === d ? s.o[e] : s.c[i - 1], end = dd === t.x ? t.px : s.c[i];
        let r = end / ref - 1;
        if (dd === d) r -= SIDE_COST; if (dd === t.x) r -= SIDE_COST;
        dayRet[dd] += w * r; expo[dd] += w; eq *= 1 + r;
      }
      trades.push({ ret: eq - 1, d, x: t.x });
    }
  }
  return { dayRet, expo, trades };
}

// ── metrics ───────────────────────────────────────────────────────────────
const cut1 = Math.floor(D * 0.6), cut2 = Math.floor(D * 0.8);
function stats(dr, from, to) {
  let eq = 1, peak = 1, dd = 0, sum = 0, sq = 0, n = 0;
  for (let d = from; d < to; d++) { eq *= 1 + dr[d]; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); sum += dr[d]; sq += dr[d] ** 2; n++; }
  const m = sum / n, sd = Math.sqrt(Math.max(0, sq / n - m * m));
  return { cagr: Math.pow(eq, 252 / n) - 1, vol: sd * Math.sqrt(252), sharpe: sd ? m / sd * Math.sqrt(252) : 0, mdd: dd, tot: eq - 1 };
}
const P = x => (x * 100).toFixed(1).padStart(6) + '%';
function report(label, r) {
  const all = stats(r.dayRet, START, D), tr = stats(r.dayRet, START, cut1), va = stats(r.dayRet, cut1, cut2), te = stats(r.dayRet, cut2, D);
  const inv = r.expo ? r.expo.slice(START).reduce((a, x) => a + x, 0) / (D - START) : 1;
  const tw = r.trades ? r.trades.filter(t => t.ret > 0).length / (r.trades.length || 1) : NaN;
  const ta = r.trades && r.trades.length ? r.trades.reduce((a, t) => a + t.ret, 0) / r.trades.length : NaN;
  console.log(`${label.padEnd(44)} CAGR ${P(all.cagr)} vol ${P(all.vol)} Sharpe ${all.sharpe.toFixed(2).padStart(5)} maxDD ${P(all.mdd)} | CAGR train/val/test ${P(tr.cagr)} ${P(va.cagr)} ${P(te.cagr)} | DD test ${P(te.mdd)} | invested ${P(inv)}${r.trades ? ` trades ${String(r.trades.length).padStart(5)} win ${P(tw)} avg ${P(ta)}` : ''}`);
  return all;
}
function yearly(label, dr) {
  const by = {};
  for (let d = START; d < D; d++) { const y = allDates[d].slice(0, 4); by[y] = (by[y] || 1) * (1 + dr[d]); }
  console.log(label.padEnd(32) + Object.entries(by).map(([y, v]) => `${y.slice(2)}:${((v - 1) * 100).toFixed(0)}%`).join(' '));
}

// ── benchmarks ────────────────────────────────────────────────────────────
const spyRet = new Float64Array(D), ewRet = new Float64Array(D), timing = new Float64Array(D);
for (let d = 1; d < D; d++) { const i = at(spy, d); if (i >= 1 && i < spy.n) spyRet[d] = spy.c[i] / spy.c[i - 1] - 1; }
for (let d = 1; d < D; d++) { let sum = 0, cnt = 0; for (const s of S) { if (s.name === 'SPY') continue; const i = at(s, d); if (i >= 1 && i < s.n) { sum += s.c[i] / s.c[i - 1] - 1; cnt++; } } ewRet[d] = cnt ? sum / cnt : 0; }
for (let d = 1; d < D; d++) timing[d] = spyBull[d - 1] ? spyRet[d] : 0;
console.log('\n=== BENCHMARKS ===');
report('SPY buy & hold', { dayRet: spyRet });
report('Equal-weight universe (survivor-biased)', { dayRet: ewRet });
report('SPY, only when above its 200-day', { dayRet: timing });

// ── strategies ────────────────────────────────────────────────────────────
const sym = S.filter(s => s.name !== 'SPY');
let rngSeed = 42; const rnd = () => { rngSeed = (rngSeed * 1664525 + 1013904223) >>> 0; return rngSeed / 2 ** 32; };
const at1 = (s, t) => { const i = t - s.off; return i >= 1 && i < s.n - 1 ? i : -1; };
const results = {};

function dipCandidates(rank) {
  return t => { if (!mktDip[t]) return []; const out = []; for (const s of sym) { const i = at1(s, t); if (i < 0 || !s.anyTrig[i]) continue; out.push({ s, score: rank === 'random' ? rnd() : rank === 'beaten' ? -s.roc20[i] : -s.rsi14[i] }); } return out; };
}
console.log('\n=== A. MARKET-DIP BOUNCE (SPY RSI<40 + any trigger), K positions ===');
for (const K of [5, 10, 20]) for (const [lab, ex] of [['1:1 bracket 2/2ATR 20d', (s, e, a) => bracket(s, e, a, 2, 2, 20)], ['hold 10d', (s, e) => holdN(s, e, 10)], ['1:3 bracket 1/3ATR 10d', (s, e, a) => bracket(s, e, a, 1, 3, 10)]]) {
  for (const rank of ['random', 'beaten']) {
    const r = run({ K, candidates: dipCandidates(rank), exitFor: ex });
    results[`A K${K} ${lab} ${rank}`] = r;
    report(`A K=${K} ${lab} ${rank}`, r);
  }
}

console.log('\n=== B. CROSS-SECTIONAL MOMENTUM (12-1), monthly, top K, hold to next rebalance ===');
function momCandidates(minRank) {
  return t => { if (t % 21 !== 0) return []; const out = []; for (const s of sym) { const i = at1(s, t); if (i < 252 || !(s.mom[i] === s.mom[i])) continue; out.push({ s, score: s.mom[i] }); } return out; };
}
for (const K of [10, 20, 40]) {
  for (const regime of [false, true]) {
    const gate = regime ? t => spyBull[t] === 1 : null;
    const r = run({ K, candidates: momCandidates(), exitFor: (s, e) => holdToOpen(s, e, 21), gate });
    results[`B K${K} ${regime ? 'regime' : 'always'}`] = r;
    report(`B top-${K} momentum ${regime ? '+ SPY>200 regime' : 'always in'}`, r);
  }
}

console.log('\n=== C. RSI(2) PULLBACK IN STRONG STOCKS (above 200d, RSI2<10, 126d momentum top), exit close>SMA5 ===');
function rsi2Candidates(requireStrong) {
  return t => { const out = []; for (const s of sym) { const i = at1(s, t); if (i < 252 || !(s.c[i] > s.sma200[i]) || !(s.rsi2[i] < 10)) continue; if (requireStrong && !(s.c[i] / s.c[i - 126] - 1 > 0.15)) continue; out.push({ s, score: requireStrong ? s.c[i] / s.c[i - 126] : -s.rsi2[i] }); } return out; };
}
for (const K of [10, 20]) for (const strong of [false, true]) {
  const r = run({ K, candidates: rsi2Candidates(strong), exitFor: (s, e, a) => rsi2Exit(s, e, a) });
  results[`C K${K} ${strong ? 'strong' : 'all'}`] = r;
  report(`C RSI2<10 K=${K} ${strong ? '+ 6m momentum>15%' : 'all above-200 stocks'}`, r);
}

console.log('\n=== D. OVERLAYS: idle cash parked in SPY (strategy slots + SPY for the rest) ===');
const overlay = r => { const dr = new Float64Array(D); for (let d = 0; d < D; d++) dr[d] = r.dayRet[d] + Math.max(0, 1 - r.expo[d]) * spyRet[d]; return { dayRet: dr }; };
for (const k of Object.keys(results)) {
  if (/^A K(5|10) (1:1 bracket 2\/2ATR 20d|hold 10d|1:3 bracket 1\/3ATR 10d) (random|beaten)$/.test(k) || /^C K10 /.test(k)) {
    results['D ' + k] = overlay(results[k]);
    report('SPY + ' + k, results['D ' + k]);
  }
}

console.log('\n=== YEARLY RETURNS ===');
yearly('SPY', spyRet); yearly('Equal-weight universe', ewRet);
for (const k of Object.keys(results)) if (/^(A K10 1:1 bracket 2\/2ATR 20d beaten|A K10 1:3 bracket 1\/3ATR 10d beaten|B K20 always|D A K10 1:1 bracket 2\/2ATR 20d beaten|D A K10 1:3 bracket 1\/3ATR 10d beaten)/.test(k)) yearly(k.slice(0, 31), results[k].dayRet);

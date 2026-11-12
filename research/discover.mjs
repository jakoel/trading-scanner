/**
 * Scores NEW daily-bar signal ideas the way research/reassess.mjs scores the
 * shipped ones — and, unlike research/brute-force.mjs, not on raw win rate.
 *
 *   • outcome = return 10/15/20 sessions (2-4 weeks) after the signal-day close,
 *     minus the same-day average stock in the same universe ("excess"). Win rate
 *     mostly measures market drift on a high-beta watchlist.
 *   • one event per episode: a stock re-firing within 10 sessions of its previous
 *     firing counts once, on its first day.
 *   • significance: date-cluster bootstrap p-value per signal, then
 *     Benjamini-Hochberg across every signal tested at the primary (15d) horizon,
 *     so testing 30 ideas doesn't manufacture winners.
 *   • robustness: 15d excess in each time third of the sample, in two universes
 *     (S&P 500 and the watchlist). A "winner" must have the same sign in all
 *     thirds of both.
 *
 * Production signals are run through the same harness as benchmarks (marked
 * [prod]) so a new idea is judged against what already ships.
 *
 * Usage: node research/discover.mjs --db=SP=research/sp_daily.db --db=WL=research/wl_daily.db
 *   Each db is built by research/fetch-universe.mjs and must contain SPY (the
 *   benchmark; SPY and QQQ are excluded from events and from the baseline).
 *   Optional: --combos  also test pairs of the best singles (see bottom).
 */
import { DatabaseSync } from 'node:sqlite';
import { computeIndicators } from '../lib/indicators.js';
import { detectDivergenceSignals, detectRsiSignals, detectVolumeSignals, detectMacdSignals, detectGreenStrongTrend } from '../lib/report.js';

const dbArgs = process.argv.filter(a => a.startsWith('--db=')).map(a => a.slice(5).split('='));
if (!dbArgs.length) { console.error('need --db=LABEL=path'); process.exit(1); }
const WANT_COMBOS = process.argv.includes('--combos');
const SELFTEST = process.argv.includes('--selftest'); // replaces the catalog with random signals + one that peeks at the future
const SINCE = (process.argv.find(a => a.startsWith('--since=')) ?? '--since=').slice(8); // only count events on/after this date
const HZ = [10, 15, 20], PRIMARY = 15, COOL = 10, WARM = 210, WIN = 3;
const BENCH = new Set(['SPY', 'QQQ']);

// ───────────────────────── indicator helpers ─────────────────────────
const nulls = n => new Array(n).fill(null);
const sma = (a, n) => { const o = nulls(a.length); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const ema = (a, n) => { const o = nulls(a.length); if (a.length < n) return o; let e = a.slice(0, n).reduce((x, y) => x + y, 0) / n; o[n - 1] = e; const k = 2 / (n + 1); for (let i = n; i < a.length; i++) { e = a[i] * k + e * (1 - k); o[i] = e; } return o; };
const stdev = (a, n) => { const o = nulls(a.length); for (let i = n - 1; i < a.length; i++) { let m = 0; for (let k = i - n + 1; k <= i; k++) m += a[k]; m /= n; let v = 0; for (let k = i - n + 1; k <= i; k++) v += (a[k] - m) ** 2; o[i] = Math.sqrt(v / n); } return o; };
const rollMax = (a, from, to) => { let m = -Infinity; for (let k = from; k <= to; k++) if (a[k] > m) m = a[k]; return m; };
const rollMin = (a, from, to) => { let m = Infinity; for (let k = from; k <= to; k++) if (a[k] < m) m = a[k]; return m; };
function rsiW(c, n) { const o = nulls(c.length); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n) { g += up / n; l += dn / n; if (i === n) o[i] = 100 - 100 / (1 + g / (l || 1e-12)); } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-12)); } } return o; }
function psarBull(h, l) {
  const n = h.length, bull = new Array(n).fill(null); if (n < 3) return bull;
  let up = h[1] > h[0], sar = up ? l[0] : h[0], ep = up ? h[1] : l[1], af = 0.02;
  bull[1] = up;
  for (let i = 2; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (up) { sar = Math.min(sar, l[i - 1], l[i - 2]); if (l[i] < sar) { up = false; sar = ep; ep = l[i]; af = 0.02; } else if (h[i] > ep) { ep = h[i]; af = Math.min(af + 0.02, 0.2); } }
    else { sar = Math.max(sar, h[i - 1], h[i - 2]); if (h[i] > sar) { up = true; sar = ep; ep = h[i]; af = 0.02; } else if (l[i] < ep) { ep = l[i]; af = Math.min(af + 0.02, 0.2); } }
    bull[i] = up;
  }
  return bull;
}
const crossUp = (a, i, lvl) => a[i] != null && a[i - 1] != null && a[i - 1] <= lvl && a[i] > lvl;

// ───────────────────────── per-dataset build ─────────────────────────
function build(label, path) {
  const db = new DatabaseSync(path, { readonly: true });
  const symbols = db.prepare('SELECT DISTINCT symbol FROM bars ORDER BY symbol').all().map(r => r.symbol);
  if (!symbols.includes('SPY')) throw new Error(`${label}: SPY missing from ${path}`);
  const S = symbols.map(sym => {
    const bars = db.prepare('SELECT date, open, high, low, close, volume FROM bars WHERE symbol = ? ORDER BY date').all(sym);
    return { sym, bars, n: bars.length, c: bars.map(b => b.close), h: bars.map(b => b.high), l: bars.map(b => b.low), o: bars.map(b => b.open), v: bars.map(b => b.volume) };
  }).filter(s => s.n >= WARM + 40);
  const spy = S.find(s => s.sym === 'SPY');
  const spyAt = new Map(spy.bars.map((b, i) => [b.date, i]));
  const spyEma50 = ema(spy.c, 50), spyEma200 = ema(spy.c, 200);
  const spyRet = spy.c.map((x, i) => (i ? x / spy.c[i - 1] - 1 : 0));
  const spyVol = spyRet.map((_, i) => { if (i < 21) return null; const w = spyRet.slice(i - 19, i + 1); const m = w.reduce((a, b) => a + b, 0) / 20; return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 19) * Math.sqrt(252); });

  // per-symbol feature arrays
  for (const s of S) {
    const n = s.n, { c, h, l, o, v } = s;
    s.rows = computeIndicators(s.bars);
    s.ema20 = ema(c, 20); s.ema50 = ema(c, 50); s.ema200 = ema(c, 200); s.sma50 = sma(c, 50); s.sma20 = sma(c, 20);
    const tr = c.map((_, i) => (i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]));
    s.atr = sma(tr, 14);
    s.rsi2 = rsiW(c, 2);
    const sd = stdev(c, 20); s.bbUp = s.sma20.map((m, i) => (m == null ? null : m + 2 * sd[i]));
    const bw = s.sma20.map((m, i) => (m == null ? null : 4 * sd[i] / m));
    s.bwRank = bw.map((x, i) => { if (x == null || i < 139) return null; let k = 0, t = 0; for (let j = i - 119; j <= i; j++) if (bw[j] != null) { t++; if (bw[j] <= x) k++; } return t ? k / t : null; });
    const range = h.map((x, i) => x - l[i]);
    s.nr7 = range.map((x, i) => i >= 6 && x === rollMin(range, i - 6, i));
    const mfm = c.map((x, i) => (h[i] === l[i] ? 0 : ((x - l[i]) - (h[i] - x)) / (h[i] - l[i])));
    const mv = mfm.map((x, i) => x * v[i]), mvS = sma(mv, 20), vS = sma(v, 20);
    s.cmf = mvS.map((x, i) => (x == null || !vS[i] ? null : x / vS[i]));
    s.volMa = vS;
    s.udv = c.map((_, i) => { if (i < 20) return null; let u = 0, d = 0; for (let k = i - 19; k <= i; k++) { if (c[k] > c[k - 1]) u += v[k]; else if (c[k] < c[k - 1]) d += v[k]; } return d ? u / d : null; });
    const tp = c.map((x, i) => (x + h[i] + l[i]) / 3);
    s.mfi = tp.map((_, i) => { if (i < 14) return null; let p = 0, q = 0; for (let k = i - 13; k <= i; k++) { const f = tp[k] * v[k]; if (tp[k] > tp[k - 1]) p += f; else if (tp[k] < tp[k - 1]) q += f; } return q ? 100 - 100 / (1 + p / q) : 100; });
    const kRaw = c.map((x, i) => { if (i < 13) return null; const hh = rollMax(h, i - 13, i), ll = rollMin(l, i - 13, i); return hh === ll ? 50 : (x - ll) / (hh - ll) * 100; });
    s.stochK = kRaw.map((_, i) => (i < 15 ? null : (kRaw[i] + kRaw[i - 1] + kRaw[i - 2]) / 3));
    const tpS = sma(tp, 20);
    s.cci = tp.map((x, i) => { if (tpS[i] == null) return null; let md = 0; for (let k = i - 19; k <= i; k++) md += Math.abs(tp[k] - tpS[i]); md /= 20; return md ? (x - tpS[i]) / (0.015 * md) : 0; });
    s.aroonUp = c.map((_, i) => { if (i < 25) return null; let best = i - 25, bv = -Infinity; for (let k = i - 25; k <= i; k++) if (h[k] >= bv) { bv = h[k]; best = k; } return (25 - (i - best)) / 25 * 100; });
    s.aroonDn = c.map((_, i) => { if (i < 25) return null; let best = i - 25, bv = Infinity; for (let k = i - 25; k <= i; k++) if (l[k] <= bv) { bv = l[k]; best = k; } return (25 - (i - best)) / 25 * 100; });
    s.psar = psarBull(h, l);
    s.cloudTop = c.map((_, i) => { if (i < 78) return null; const j = i - 26; const ten = (rollMax(h, j - 8, j) + rollMin(l, j - 8, j)) / 2, kij = (rollMax(h, j - 25, j) + rollMin(l, j - 25, j)) / 2; const a = (ten + kij) / 2, b = (rollMax(h, j - 51, j) + rollMin(l, j - 51, j)) / 2; return Math.max(a, b); });
    s.rs = c.map((x, i) => { const k = spyAt.get(s.bars[i].date); return k == null ? null : x / spy.c[k]; });
    s.mom = c.map((_, i) => (i >= 68 ? c[i - 5] / c[i - 68] - 1 : null));
    s.ret5 = c.map((x, i) => (i >= 5 ? x / c[i - 5] - 1 : null));
    s.ret20 = c.map((x, i) => (i >= 20 ? x / c[i - 20] - 1 : null));
  }
  // cross-sectional momentum rank per date, breadth per date
  const byDate = new Map();
  for (const s of S) { if (BENCH.has(s.sym)) continue; for (let i = 0; i < s.n; i++) { const d = s.bars[i].date; let e = byDate.get(d); if (!e) byDate.set(d, e = { mom: [], above: 0, tot: 0 }); if (s.mom[i] != null) e.mom.push([s, i, s.mom[i]]); if (s.sma50[i] != null) { e.tot++; if (s.c[i] > s.sma50[i]) e.above++; } } }
  for (const s of S) s.momRank = new Array(s.n).fill(null);
  for (const e of byDate.values()) { e.mom.sort((a, b) => a[2] - b[2]); const N = e.mom.length; e.mom.forEach(([s, i], r) => { s.momRank[i] = N > 1 ? r / (N - 1) : null; }); }
  const breadth = new Map([...byDate].map(([d, e]) => [d, e.tot ? e.above / e.tot : null]));

  // forward returns + same-day baseline
  const real = S.filter(s => !BENCH.has(s.sym));
  const baseSum = new Map();
  for (const s of real) for (let i = 0; i < s.n; i++) for (const h of HZ) if (i + h < s.n) { const k = s.bars[i].date + '|' + h; const e = baseSum.get(k) ?? (baseSum.set(k, [0, 0]).get(k)); e[0] += s.c[i + h] / s.c[i] - 1; e[1]++; }
  const base = (d, h) => { const e = baseSum.get(d + '|' + h); return e ? e[0] / e[1] : null; };
  return { label, S, real, spy, spyAt, spyEma50, spyEma200, spyVol, breadth, base };
}

// ───────────────────────── signal catalog ─────────────────────────
const within = (fn, i, back) => { for (let k = Math.max(1, i - back); k <= i; k++) if (fn(k)) return true; return false; };
const SIGNALS = [
  // ── shipped, as benchmarks ──
  { key: 'P_div', label: '[prod] Bullish Divergence + ADX>=20', fam: 'prod', f: (s, i) => detectDivergenceSignals(s.rows[i].divergence, s.rows[i].adx).divergenceSignals.length > 0 },
  { key: 'P_green', label: '[prod] MACD Green + ADX>=25 (first of episode)', fam: 'prod', f: (s, i) => { const g = detectGreenStrongTrend(s.rows, i); return g != null && !g.repeat; } },
  { key: 'P_rsi30', label: '[prod] RSI Reclaim 30 + ADX>=20', fam: 'prod', f: (s, i) => detectRsiSignals(s.rows.slice(Math.max(0, i - 6), i + 1).map(r => ({ rsi: r.rsi })), { adx: s.rows[i].adx }).rsiSignals.length > 0 },
  { key: 'P_vol', label: '[prod] Volume Surge (up day)', fam: 'prod', f: (s, i) => detectVolumeSignals({ volumeRatio: s.rows[i].volumeRatio, price: s.c[i], prevPrice: s.c[i - 1] }).volumeSignals.length > 0 },
  // ── relative strength ──
  { key: 'rsHigh60', label: 'RS line (vs SPY) new 60d high', fam: 'relstr', f: (s, i) => s.rs[i] != null && i > 61 && s.rs[i] > rollMax(s.rs.map(x => x ?? -Infinity), i - 60, i - 1) },
  { key: 'rsLead', label: 'RS new 60d high while price below its 60d high', fam: 'relstr', f: (s, i) => s.rs[i] != null && i > 61 && s.rs[i] > rollMax(s.rs.map(x => x ?? -Infinity), i - 60, i - 1) && s.c[i] < rollMax(s.c, i - 60, i - 1) },
  { key: 'momTop', label: 'Enters top-20% 3-month momentum (skip last wk)', fam: 'relstr', f: (s, i) => s.momRank[i] != null && s.momRank[i - 5] != null && s.momRank[i] >= 0.8 && s.momRank[i - 5] < 0.8 },
  { key: 'holdsSelloff', label: 'Up on the week while SPY down >=2%', fam: 'relstr', f: (s, i) => { const k = s.bars[i].date, j = spyIdx(s, i); return j != null && j >= 5 && s.ret5[i] != null && s.ret5[i] >= 0 && CTX.spy.c[j] / CTX.spy.c[j - 5] - 1 <= -0.02; } },
  // ── volatility squeeze ──
  { key: 'sqzBreak', label: 'Squeeze (BB width bottom 10%) then close above upper band', fam: 'volat', f: (s, i) => s.bbUp[i] != null && s.bbUp[i - 1] != null && s.c[i] > s.bbUp[i] && s.c[i - 1] <= s.bbUp[i - 1] && within(k => s.bwRank[k - 1] != null && s.bwRank[k - 1] <= 0.10, i, 5) },
  { key: 'nr7Break', label: 'NR7 bar then close above its high', fam: 'volat', f: (s, i) => s.nr7[i - 1] && s.c[i] > s.h[i - 1] },
  // ── trend pullbacks ──
  { key: 'pbEma20', label: 'Uptrend (20>50>200) close reclaims EMA20', fam: 'pullbk', f: (s, i) => s.ema200[i] != null && s.ema20[i] > s.ema50[i] && s.ema50[i] > s.ema200[i] && s.c[i - 1] <= s.ema20[i - 1] && s.c[i] > s.ema20[i] },
  { key: 'pbEma50', label: 'Uptrend (50>200, 50 rising) close reclaims EMA50', fam: 'pullbk', f: (s, i) => s.ema200[i] != null && s.ema50[i] > s.ema200[i] && s.ema50[i] > s.ema50[i - 5] && s.c[i - 1] <= s.ema50[i - 1] && s.c[i] > s.ema50[i] },
  // ── highs ──
  { key: 'high126', label: 'New 126-day closing high', fam: 'highs', f: (s, i) => i > 127 && s.c[i] > rollMax(s.c, i - 126, i - 1) },
  { key: 'high252', label: 'New 252-day closing high', fam: 'highs', min: 253, f: (s, i) => i > 253 && s.c[i] > rollMax(s.c, i - 252, i - 1) },
  { key: 'high126vol', label: 'New 126d high on volume >= 1.5x', fam: 'highs', f: (s, i) => i > 127 && s.c[i] > rollMax(s.c, i - 126, i - 1) && s.volMa[i] && s.v[i] >= 1.5 * s.volMa[i] },
  // ── gaps / post-earnings proxy ──
  { key: 'gapHold', label: 'Gap up >=max(3%,1.5xATR%) on 2x vol, closes in top 40% of range', fam: 'gap', f: (s, i) => { const g = s.o[i] / s.c[i - 1] - 1; return s.atr[i] && g >= Math.max(0.03, 1.5 * s.atr[i] / s.c[i]) && s.volMa[i] && s.v[i] >= 2 * s.volMa[i] && s.h[i] > s.l[i] && (s.c[i] - s.l[i]) / (s.h[i] - s.l[i]) >= 0.6 && s.c[i] >= s.o[i]; } },
  // ── accumulation ──
  { key: 'udv15', label: 'Up/down-volume ratio (20d) crosses above 1.5', fam: 'accum', f: (s, i) => s.udv[i] != null && s.udv[i - 1] != null && s.udv[i - 1] <= 1.5 && s.udv[i] > 1.5 },
  { key: 'cmfUp', label: 'Chaikin money flow (20d) crosses above +0.10', fam: 'accum', f: (s, i) => crossUp(s.cmf, i, 0.10) },
  { key: 'cmfLag', label: 'CMF crosses +0.10 while 20d return <= 0 (accumulating a laggard)', fam: 'accum', f: (s, i) => crossUp(s.cmf, i, 0.10) && s.ret20[i] != null && s.ret20[i] <= 0 },
  // ── oscillators ──
  { key: 'mfi20', label: 'MFI(14) reclaims 20', fam: 'osc', f: (s, i) => crossUp(s.mfi, i, 20) },
  { key: 'stoch20', label: 'Stochastic %K reclaims 20', fam: 'osc', f: (s, i) => crossUp(s.stochK, i, 20) },
  { key: 'cciM100', label: 'CCI(20) reclaims -100', fam: 'osc', f: (s, i) => crossUp(s.cci, i, -100) },
  { key: 'rsi2up', label: 'RSI(2) reclaims 10 above EMA200 (Connors)', fam: 'osc', f: (s, i) => s.ema200[i] != null && s.c[i] > s.ema200[i] && crossUp(s.rsi2, i, 10) },
  { key: 'aroon', label: 'Aroon Up crosses 70 with Aroon Down < 30', fam: 'osc', f: (s, i) => s.aroonUp[i] != null && s.aroonUp[i - 1] != null && s.aroonUp[i - 1] <= 70 && s.aroonUp[i] > 70 && s.aroonDn[i] < 30 },
  { key: 'psarFlip', label: 'Parabolic SAR flips bullish', fam: 'osc', f: (s, i) => s.psar[i] === true && s.psar[i - 1] === false },
  { key: 'ichiCloud', label: 'Close crosses above Ichimoku cloud', fam: 'osc', f: (s, i) => s.cloudTop[i] != null && s.cloudTop[i - 1] != null && s.c[i - 1] <= s.cloudTop[i - 1] && s.c[i] > s.cloudTop[i] },
];
if (SELFTEST) {
  SIGNALS.length = 0;
  const hashRand = (a, b, c) => mulberry32((a * 7919 + b * 104729 + c * 1299709) | 0)();
  for (let k = 1; k <= 40; k++) SIGNALS.push({ key: 'null' + k, label: `null signal ${k} (random, ~0.4%/day)`, fam: 'null', f: (s, i) => hashRand(k, s.n + s.sym.charCodeAt(0) * 31 + s.sym.length, i) < 0.004 });
  SIGNALS.push({ key: 'oracle', label: 'ORACLE (peeks 15d ahead: next-15d return > +8%)', fam: 'oracle', f: (s, i) => i + 15 < s.n && s.c[i + 15] / s.c[i] - 1 > 0.08 });
}
let CTX; // current dataset, for the few signals that reach into SPY
const spyIdx = (s, i) => CTX.spyAt.get(s.bars[i].date) ?? null;

// ───────────────────────── statistics ─────────────────────────
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// events: [{d, r, b}] -> {n, mean, win, exc, p}; bootstrap resamples whole dates (signals cluster on market-wide days)
function summarize(events, B = 2000) {
  if (!events.length) return null;
  const byDate = new Map();
  for (const e of events) { const x = byDate.get(e.d) ?? (byDate.set(e.d, [0, 0]).get(e.d)); x[0] += e.r - e.b; x[1]++; }
  const g = [...byDate.values()], U = g.length;
  const exc = events.reduce((a, e) => a + e.r - e.b, 0) / events.length;
  let lo = NaN, hi = NaN, p = NaN;
  if (U >= 5) {
    const rnd = mulberry32(12345), m = new Array(B);
    for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let k = 0; k < U; k++) { const x = g[Math.floor(rnd() * U)]; s += x[0]; n += x[1]; } m[b] = s / n; }
    m.sort((a, b) => a - b); lo = m[Math.floor(0.05 * B)]; hi = m[Math.floor(0.95 * B)];
    const le = m.filter(x => x <= 0).length / B, ge = m.filter(x => x >= 0).length / B;
    p = Math.max(1 / B, Math.min(1, 2 * Math.min(le, ge)));
  }
  return { n: events.length, mean: events.reduce((a, e) => a + e.r, 0) / events.length, win: events.filter(e => e.r > 0).length / events.length, exc, lo, hi, p, dates: U };
}
function bh(ps) { // Benjamini-Hochberg q-values
  const idx = ps.map((p, i) => [p, i]).filter(x => x[0] != null && !Number.isNaN(x[0])).sort((a, b) => a[0] - b[0]);
  const q = new Array(ps.length).fill(null); let prev = 1; const m = idx.length;
  for (let r = m - 1; r >= 0; r--) { const v = Math.min(prev, idx[r][0] * m / (r + 1)); q[idx[r][1]] = v; prev = v; }
  return q;
}
const P = (x, d = 1) => (x == null || Number.isNaN(x) ? '   -' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');

// ───────────────────────── run one dataset ─────────────────────────
function run(ds) {
  CTX = ds;
  const { real, base } = ds;
  const masterDates = ds.spy.bars.map(b => b.date);
  const lastIdx = masterDates.length - 1;
  const warmDate = masterDates[WARM], endDate = masterDates[lastIdx - PRIMARY];
  const span = masterDates.filter(d => d >= warmDate && d <= endDate);
  const cut1 = span[Math.floor(span.length / 3)], cut2 = span[Math.floor(2 * span.length / 3)];
  const third = d => (d < cut1 ? 0 : d < cut2 ? 1 : 2);
  console.log(`\n######## ${ds.label}: ${real.length} stocks, signals from ${warmDate} (thirds split at ${cut1} / ${cut2}; 15d outcomes through ${endDate}) ########`);

  // raw boolean flags per symbol per signal
  const flags = {};
  for (const sig of SIGNALS) {
    const arr = [];
    for (const s of real) {
      const f = new Uint8Array(s.n), lo = Math.max(WARM, sig.min ?? 0);
      for (let i = lo; i < s.n; i++) { try { if (sig.f(s, i)) f[i] = 1; } catch { /* insufficient history */ } }
      arr.push(f);
    }
    flags[sig.key] = arr;
  }
  const evalFlags = (flagArr) => { // -> events by horizon (episode-first)
    const ev = { 10: [], 15: [], 20: [] };
    real.forEach((s, si) => {
      let last = null; const f = flagArr[si];
      for (let i = 0; i < s.n; i++) {
        if (!f[i]) continue;
        const first = last == null || i - last > COOL; last = i;
        if (!first) continue;
        const d = s.bars[i].date;
        if (d < SINCE) continue;
        for (const h of HZ) if (i + h < s.n) { const b = base(d, h); if (b != null) ev[h].push({ d, r: s.c[i + h] / s.c[i] - 1, b, t: third(d) }); }
      }
    });
    return ev;
  };
  const score = (flagArr) => {
    const ev = evalFlags(flagArr);
    const o = { byH: {}, thirds: [] };
    for (const h of HZ) o.byH[h] = summarize(ev[h]);
    for (let t = 0; t < 3; t++) { const e = ev[PRIMARY].filter(x => x.t === t); o.thirds.push(e.length >= 10 ? { n: e.length, exc: e.reduce((a, x) => a + x.r - x.b, 0) / e.length } : null); }
    return o;
  };
  const results = SIGNALS.map(sig => ({ sig, ...score(flags[sig.key]) }));
  const q = bh(results.map(r => r.byH[PRIMARY]?.p ?? null));
  results.forEach((r, i) => { r.q = q[i]; });
  return { flags, results, score, evalFlags, third, cut1, cut2, span };
}

function printTable(label, results) {
  console.log(`\n--- ${label}: ${PRIMARY}d primary | excess = vs same-day average stock | q = Benjamini-Hochberg across all ${results.length} signals | T1/T2/T3 = ${PRIMARY}d excess by time third ---`);
  console.log('signal'.padEnd(66) + 'n(15d)  avg15    exc10    exc15    exc20     q      T1 / T2 / T3');
  for (const r of [...results].sort((a, b) => (b.byH[PRIMARY]?.exc ?? -9) - (a.byH[PRIMARY]?.exc ?? -9))) {
    const s = r.byH[PRIMARY]; if (!s) { console.log(r.sig.label.padEnd(66) + 'no events'); continue; }
    const th = r.thirds.map(t => (t ? `${P(t.exc)}(${t.n})` : '   -').padEnd(11)).join('');
    const star = r.q != null && r.q <= 0.10 ? ' ◆' : '';
    console.log(r.sig.label.slice(0, 65).padEnd(66) + String(s.n).padStart(6) + P(s.mean).padStart(8) + P(r.byH[10]?.exc).padStart(9) + P(s.exc).padStart(9) + P(r.byH[20]?.exc).padStart(9) + (r.q == null ? '    -' : r.q.toFixed(3)).padStart(8) + '   ' + th + star);
  }
}

// ───────────────────────── main ─────────────────────────
const out = [];
for (const [label, path] of dbArgs) {
  console.error(`building ${label} ...`);
  const ds = build(label, path);
  const res = run(ds);
  printTable(label, res.results);
  out.push({ ds, res });
}

if (SELFTEST) {
  for (const { ds, res } of out) {
    const nulls = res.results.filter(r => r.sig.fam === 'null' && r.byH[PRIMARY]);
    const rawHits = nulls.filter(r => r.byH[PRIMARY].p < 0.05).length, qHits = nulls.filter(r => r.q <= 0.10).length;
    const sameSign = nulls.filter(r => r.thirds.every(t => t && t.exc > 0)).length;
    console.log(`\nSELFTEST ${ds.label}: ${nulls.length} random signals | raw p<0.05: ${rawHits} (chance level ~${(nulls.length * 0.05).toFixed(1)}) | BH q<=0.10: ${qHits} | positive in all 3 thirds: ${sameSign} (chance ~${(nulls.length / 8).toFixed(1)}) | largest |exc15|: ${(Math.max(...nulls.map(r => Math.abs(r.byH[PRIMARY].exc))) * 100).toFixed(2)}%`);
  }
}

// winners: same sign in all thirds of every universe, positive pooled in all, and q<=0.10 in the largest universe
console.log('\n================ WINNER SCREEN (pre-specified) ================');
console.log('WINNER  = 15d excess > 0 pooled AND in all 3 time thirds, in EVERY universe, and q <= 0.10 in the largest universe');
console.log('AVOID   = same, but negative (useful as a filter)');
const biggest = out.reduce((a, b) => (b.ds.real.length > a.ds.real.length ? b : a));
for (const sig of SIGNALS) {
  const per = out.map(({ ds, res }) => ({ label: ds.label, r: res.results.find(x => x.sig.key === sig.key) }));
  const pos = per.every(p => p.r.byH[PRIMARY] && p.r.byH[PRIMARY].exc > 0 && p.r.thirds.every(t => t && t.exc > 0));
  const neg = per.every(p => p.r.byH[PRIMARY] && p.r.byH[PRIMARY].exc < 0 && p.r.thirds.every(t => t && t.exc < 0));
  const qBig = per.find(p => p.label === biggest.ds.label).r.q;
  sig.verdict = pos && qBig != null && qBig <= 0.10 ? 'WINNER' : neg && qBig != null && qBig <= 0.10 ? 'AVOID' : pos ? 'consistent but not significant' : neg ? 'consistently negative, not significant' : '';
}
for (const v of ['WINNER', 'AVOID', 'consistent but not significant']) {
  const list = SIGNALS.filter(s => s.verdict === v);
  console.log(`\n${v}: ${list.length ? '' : '(none)'}`);
  for (const sig of list) {
    const cells = out.map(({ ds, res }) => { const r = res.results.find(x => x.sig.key === sig.key); const s = r.byH[PRIMARY]; return `${ds.label}: n=${s.n} avg ${P(s.mean)} exc ${P(r.byH[10].exc)}/${P(s.exc)}/${P(r.byH[20].exc)} q=${r.q?.toFixed(3)}`; });
    console.log(`  ${sig.label}\n      ${cells.join('   |   ')}`);
  }
}

// ───────────────────────── regime gates on the shipped signals + winners ─────────────────────────
console.log('\n================ REGIME GATES: 15d excess when the gate is ON vs OFF (n) ================');
for (const { ds, res } of out) {
  CTX = ds;
  const spyEmaOk = (d, e) => { const j = ds.spyAt.get(d); return j != null && e[j] != null && ds.spy.c[j] > e[j]; };
  const gates = [
    ['SPY > EMA50', d => spyEmaOk(d, ds.spyEma50)],
    ['SPY > EMA200', d => spyEmaOk(d, ds.spyEma200)],
    ['breadth >= 40% above 50d', d => (ds.breadth.get(d) ?? 0) >= 0.4],
    ['SPY 20d vol < 18%', d => { const j = ds.spyAt.get(d); return j != null && ds.spyVol[j] != null && ds.spyVol[j] < 0.18; }],
  ];
  const picks = ['P_div', 'P_green', ...SIGNALS.filter(s => s.verdict === 'WINNER').map(s => s.key)];
  console.log(`\n--- ${ds.label} ---`);
  for (const key of [...new Set(picks)]) {
    const sig = SIGNALS.find(s => s.key === key);
    const ev = res.evalFlags(res.flags[key])[PRIMARY];
    const cells = gates.map(([nm, g]) => { const on = summarize(ev.filter(e => g(e.d))), off = summarize(ev.filter(e => !g(e.d))); return `${nm}: ON ${on ? P(on.exc) + `(${on.n})` : '-'} / OFF ${off ? P(off.exc) + `(${off.n})` : '-'}`; });
    console.log(`${sig.label.slice(0, 50).padEnd(51)}${cells.join('  |  ')}`);
  }
}

// ───────────────────────── optional pair search among the best singles ─────────────────────────
if (WANT_COMBOS) {
  console.log('\n================ PAIRS among shipped signals + best singles (A fires today and B fired within the last 3 sessions, or vice versa) ================');
  // shipped signals + winners + the 6 best new singles by 15d excess in the largest universe (even if they
  // didn't clear the single-signal screen: a combo can be real when its parts are individually weak)
  const topNew = biggest.res.results.filter(r => r.sig.fam !== 'prod' && r.byH[PRIMARY]).sort((a, b) => b.byH[PRIMARY].exc - a.byH[PRIMARY].exc).slice(0, 6).map(r => r.sig.key);
  const cand = SIGNALS.filter(s => s.fam === 'prod' || s.verdict === 'WINNER' || topNew.includes(s.key)).map(s => s.key);
  const pairs = [];
  for (let a = 0; a < cand.length; a++) for (let b = a + 1; b < cand.length; b++) pairs.push([cand[a], cand[b]]);
  const rows = [];
  for (const [ka, kb] of pairs) {
    const per = out.map(({ ds, res }) => {
      const fa = res.flags[ka], fb = res.flags[kb];
      const comb = ds.real.map((s, si) => { const A = fa[si], B = fb[si], f = new Uint8Array(s.n); for (let i = 1; i < s.n; i++) { let ra = false, rb = false; for (let k = Math.max(0, i - WIN); k <= i; k++) { if (A[k]) ra = true; if (B[k]) rb = true; } if ((A[i] && rb) || (B[i] && ra)) f[i] = 1; } return f; });
      return { ds, sc: res.score(comb), parentA: res.results.find(x => x.sig.key === ka), parentB: res.results.find(x => x.sig.key === kb) };
    });
    rows.push({ ka, kb, per });
  }
  const pm = rows.map(r => r.per[out.indexOf(biggest)]?.sc.byH[PRIMARY]?.p ?? null);
  const qs = bh(pm);
  rows.forEach((r, i) => { r.q = qs[i]; });
  console.log('pair'.padEnd(46) + out.map(o => `${o.ds.label}: n / exc15 / thirds`.padEnd(46)).join('') + 'q(biggest)');
  for (const r of rows.sort((x, y) => (y.per[0].sc.byH[PRIMARY]?.exc ?? -9) - (x.per[0].sc.byH[PRIMARY]?.exc ?? -9)).slice(0, 25)) {
    const cells = r.per.map(p => { const s = p.sc.byH[PRIMARY]; return s ? `${String(s.n).padStart(4)} ${P(s.exc)} [${p.sc.thirds.map(t => (t ? P(t.exc, 0) : '-')).join(' ')}]`.padEnd(46) : '-'.padEnd(46); });
    console.log(`${r.ka}+${r.kb}`.padEnd(46) + cells.join('') + (r.q == null ? '-' : r.q.toFixed(3)));
  }
}

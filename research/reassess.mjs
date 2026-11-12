/**
 * Re-scores every Telegram report section — the ones currently shown AND the
 * ones hidden — on what the price actually did 2, 3 and 4 weeks (10/15/20
 * sessions) after each signal, measured against the same-day average stock on
 * the watchlist. Replays lib/report.js's own detectors over data/bars.db, so
 * what's scored is exactly what the scanner would have said; nothing here
 * writes to data/ or touches Telegram.
 *
 * Why "excess vs the average stock" and not win rate: the watchlist is high-beta
 * and moves with the market, so raw win rates mostly measure the market. From
 * 2026-09-23 to 2026-11-11 the average stock fell 5.5%/8.7%/11.1% over
 * 10/15/20 sessions with only 26-32% of stocks up — every signal looked bad on
 * win rate. Excess return cancels that.
 *
 * Episodes: a signal re-firing for the same stock within GREEN_EPISODE_COOLDOWN
 * (10) sessions of its previous firing is the same episode and is scored once,
 * on its first day. Without this a stock that fires four times in two weeks
 * counts as four independent wins or losses.
 *
 * Windows (the thresholds were tuned on everything before OOS_START, so only
 * the OOS window is a clean test):
 *   PRE      FROM -> day before LIVE_START   (before signals.csv logging)
 *   LIVE_IS  LIVE_START -> day before OOS_START
 *   OOS      OOS_START -> end
 * Signals less than 20 sessions old have no 4-week outcome yet and drop out of
 * the 20d column; the OOS window shrinks the most.
 *
 * Usage: node research/reassess.mjs [--from=2026-02-02] [--live-start=2026-07-20] [--oos-start=2026-09-23]
 *
 * Decision rule used so far (architecture.md, 2026-11-12): trust a signal only
 * if its 15d excess has the same sign in all three windows, since ~6 signals x
 * 3 horizons x 4 windows will throw up a few "significant" cells by chance.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { computeIndicators } from '../lib/indicators.js';
import {
  detectMacdSignals, detectVolumeSignals, detectDivergenceSignals, detectVwapSignals, detectFvgRsiConfluence,
  detectGreenStrongTrend, GREEN_EPISODE_COOLDOWN, VWAP_RSI_OVERBOUGHT_THRESHOLD,
} from '../lib/report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
function argValue(name, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
}
const FROM = argValue('from', '2026-02-02'); // EMA200 needs ~200 of the 400 stored bars
const LIVE_START = argValue('live-start', '2026-07-20');
const OOS_START = argValue('oos-start', '2026-09-23');
const HZ = [10, 15, 20];
const WINDOWS = {
  ALL: d => d >= FROM,
  PRE: d => d >= FROM && d < LIVE_START,
  LIVE_IS: d => d >= LIVE_START && d < OOS_START,
  OOS: d => d >= OOS_START,
};

const SIGNALS = [
  { key: 'divergence', label: 'Bullish Divergence + Strong Trend', shown: true },
  { key: 'green', label: 'MACD Green + Strong Trend', shown: true },
  { key: 'volSurge', label: 'Volume Surge', shown: false },
  { key: 'fvgRsi', label: 'FVG Retest + RSI Reclaim', shown: false },
  { key: 'vwapOb', label: 'RSI>=70 + VWAP Reclaim', shown: false },
  { key: 'macdPos', label: 'MACD Turned Positive', shown: false },
];

// ── replay ──────────────────────────────────────────────────────────────────
const db = new DatabaseSync(join(__dirname, '..', 'data', 'bars.db'), { readonly: true });
const symbols = db.prepare('SELECT DISTINCT symbol FROM bars ORDER BY symbol').all().map(r => r.symbol);
const bySym = new Map();
console.error(`Replaying ${symbols.length} symbols from ${FROM}...`);
for (const symbol of symbols) {
  const bars = db.prepare('SELECT date, open, high, low, close, volume FROM bars WHERE symbol = ? ORDER BY date').all(symbol);
  const rows = computeIndicators(bars);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (bars[i].date < FROM) continue;
    const last = rows[i];
    const hist = rows.slice(Math.max(0, i - 6), i + 1);
    const { macdSignals } = detectMacdSignals(last.macdLine, hist.map(r => ({ macd: r.macdLine, hist: r.histogram })),
      { price: last.price, atrTrailingStop: last.atrTrailingStop, adx: last.adx });
    const { volumeSignals } = detectVolumeSignals({ volumeRatio: last.volumeRatio, price: Math.round(last.price * 100) / 100, prevPrice: rows[i - 1].price });
    const { divergenceSignals } = detectDivergenceSignals(last.divergence, last.adx);
    const { vwapSignals } = detectVwapSignals(bars, i);
    const fwd = {};
    for (const h of HZ) if (i + h < bars.length) fwd[h] = bars[i + h].close / bars[i].close - 1;
    out.push({
      symbol, date: bars[i].date, idx: i, close: bars[i].close, fwd,
      f: {
        divergence: divergenceSignals.length > 0,
        green: detectGreenStrongTrend(rows, i) !== null,
        volSurge: volumeSignals.length > 0,
        fvgRsi: detectFvgRsiConfluence(bars, rows, i),
        vwapOb: vwapSignals.includes('VWAP RECLAIM') && last.rsi != null && last.rsi >= VWAP_RSI_OVERBOUGHT_THRESHOLD,
        macdPos: macdSignals.includes('MACD TURNED POSITIVE'),
      },
    });
  }
  bySym.set(symbol, out);
}
const all = [...bySym.values()].flat();

// same-day average-stock baseline per horizon
const baseSum = {};
for (const r of all) for (const h of HZ) if (r.fwd[h] != null) { const k = `${r.date}|${h}`; (baseSum[k] ??= []).push(r.fwd[h]); }
for (const r of all) { r.base = {}; for (const h of HZ) if (r.fwd[h] != null) { const v = baseSum[`${r.date}|${h}`]; r.base[h] = v.reduce((a, b) => a + b, 0) / v.length; } }

// ── stats ───────────────────────────────────────────────────────────────────
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const P = (x, d = 1) => (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// 90% CI for mean excess, resampling whole DATES (signals cluster on market-wide days)
function clusterCI(items, B = 2000) {
  const g = new Map(); for (const it of items) (g.get(it.d) ?? g.set(it.d, []).get(it.d)).push(it.v);
  const groups = [...g.values()]; if (groups.length < 3) return [NaN, NaN];
  const rnd = mulberry32(12345), m = [];
  for (let b = 0; b < B; b++) { let s = 0, n = 0; for (let k = 0; k < groups.length; k++) { const x = groups[Math.floor(rnd() * groups.length)]; for (const v of x) { s += v; n++; } } m.push(s / n); }
  m.sort((a, b) => a - b); return [m[Math.floor(0.05 * B)], m[Math.floor(0.95 * B)]];
}
function episodes(key) {
  const eps = [];
  for (const a of bySym.values()) {
    let lastFire = null;
    for (const r of a) {
      if (!r.f[key]) continue;
      if (lastFire == null || r.idx - lastFire > GREEN_EPISODE_COOLDOWN) eps.push(r);
      lastFire = r.idx;
    }
  }
  return eps;
}
function stat(events, h, win) {
  const ev = events.filter(r => WINDOWS[win](r.date) && r.fwd[h] != null);
  if (!ev.length) return null;
  const exc = ev.map(r => r.fwd[h] - r.base[h]);
  const [lo, hi] = clusterCI(ev.map(r => ({ d: r.date, v: r.fwd[h] - r.base[h] })));
  return { n: ev.length, mean: mean(ev.map(r => r.fwd[h])), win: ev.filter(r => r.fwd[h] > 0).length / ev.length, exc: mean(exc), lo, hi };
}
const mark = s => (s.lo > 0 ? ' ▲' : s.hi < 0 ? ' ▼' : '');

// ── market backdrop ─────────────────────────────────────────────────────────
const lastDate = all.reduce((m, r) => (r.date > m ? r.date : m), '');
const closeOf = (sym, d) => bySym.get(sym)?.find(r => r.date === d)?.close;
console.log(`Data through ${lastDate}. Windows: PRE ${FROM}..${LIVE_START}  LIVE_IS ${LIVE_START}..${OOS_START}  OOS ${OOS_START}..`);
for (const sym of ['SPY', 'QQQ']) {
  const a = closeOf(sym, LIVE_START), b = closeOf(sym, lastDate);
  if (a && b) console.log(`${sym} since ${LIVE_START}: ${P(b / a - 1)}`);
}
for (const win of ['PRE', 'LIVE_IS', 'OOS']) {
  const cells = HZ.map(h => { const ev = all.filter(r => WINDOWS[win](r.date) && r.fwd[h] != null); return ev.length ? `${h}d ${P(mean(ev.map(r => r.fwd[h])))} (${(ev.filter(r => r.fwd[h] > 0).length / ev.length * 100).toFixed(0)}% up)` : `${h}d -`; });
  console.log(`Average watchlist stock, ${win.padEnd(7)}: ${cells.join('  |  ')}`);
}

// ── tables ──────────────────────────────────────────────────────────────────
const eps = Object.fromEntries(SIGNALS.map(s => [s.key, episodes(s.key)]));
function table(win, title) {
  console.log(`\n=== ${title} | episodes only | n / avg return / % up / excess vs same-day average stock | ▲▼ = 90% date-cluster CI excludes 0 ===`);
  console.log('signal'.padEnd(46) + HZ.map(h => `${h}d`.padEnd(38)).join(''));
  for (const s of SIGNALS) {
    const cells = HZ.map(h => { const t = stat(eps[s.key], h, win); return (t ? `${String(t.n).padStart(3)} / ${P(t.mean)} / ${(t.win * 100).toFixed(0)}% / ${P(t.exc)}${mark(t)}` : '-').padEnd(38); });
    console.log(`${s.label}${s.shown ? ' [shown]' : ' [hidden]'}`.padEnd(46) + cells.join(''));
  }
}
table('ALL', `POOLED ${FROM} -> ${lastDate}`);
table('OOS', `OUT OF SAMPLE ${OOS_START} -> ${lastDate}`);

console.log('\n=== CONSISTENCY: 15d excess by independent window (n in brackets) — trust a signal only if the sign holds in all three ===');
for (const s of SIGNALS) {
  const cells = ['PRE', 'LIVE_IS', 'OOS'].map(w => { const t = stat(eps[s.key], 15, w); return t ? { txt: `${P(t.exc)} (${t.n})`, exc: t.exc, n: t.n } : { txt: '-', exc: null, n: 0 }; });
  const usable = cells.filter(c => c.n >= 5);
  const verdict = usable.length < 3 ? 'too few episodes in some window' : usable.every(c => c.exc > 0) ? 'POSITIVE in all windows' : usable.every(c => c.exc < 0) ? 'NEGATIVE in all windows' : 'mixed';
  console.log(`${s.label}${s.shown ? ' [shown]' : ' [hidden]'}`.padEnd(46) + cells.map(c => c.txt.padEnd(16)).join('') + verdict);
}

console.log('\n=== REPORT VOLUME over the live period (lines per session if each section were shown) ===');
const live = all.filter(r => r.date >= LIVE_START);
const sessions = new Set(live.map(r => r.date)).size;
for (const s of SIGNALS) {
  const lines = s.key === 'green' ? live.filter(r => r.f.green).length : live.filter(r => r.f[s.key]).length;
  const listed = s.key === 'green' ? eps.green.filter(r => r.date >= LIVE_START).length : null;
  console.log(`${s.label}${s.shown ? ' [shown]' : ' [hidden]'}`.padEnd(46) + `${lines} firings over ${sessions} sessions` + (listed != null ? ` -> ${listed} listed after once-per-episode` : ''));
}

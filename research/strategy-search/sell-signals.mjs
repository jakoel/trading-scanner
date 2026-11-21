/**
 * Scores candidate SELL / exit signals the way the project scores buy signals
 * (research/reassess.mjs): forward return 10/15/20 sessions later as EXCESS over
 * the same-day average stock, one event per episode (re-fires within 10 sessions
 * of the same symbol count once), split into time thirds. A useful sell signal
 * has NEGATIVE excess, consistently, in every third.
 *
 *   node research/build-cache.mjs --bars-db=research/long_daily.db --out=research/long_features.db --horizons=10,15,20
 *   node research/build-cache.mjs --bars-db=data/bars.db --out=research/wl_features.db --horizons=10,15,20
 *   node research/strategy-search/sell-signals.mjs --db=research/long_features.db [--watchlist-only]
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const db = new DatabaseSync(arg('db', join(__dirname, '..', 'long_features.db')), { readonly: true });
const WL_ONLY = process.argv.includes('--watchlist-only');
const wl = new Set(readFileSync(join(__dirname, '..', '..', 'watchlist.txt'), 'utf-8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')));
const H = [10, 15, 20], COOLDOWN = 10;

const dates = db.prepare('SELECT DISTINCT date FROM bar_features ORDER BY date').all().map(r => r.date);
const dIdx = new Map(dates.map((d, i) => [d, i]));
const third = i => (i < dates.length / 3 ? 0 : i < 2 * dates.length / 3 ? 1 : 2);
// same-day average forward return across the whole universe (not just flagged rows)
const avg = {};
for (const h of H) {
  const m = new Float64Array(dates.length).fill(NaN);
  for (const r of db.prepare(`SELECT date, AVG(fwd${h}) a FROM bar_features WHERE fwd${h} IS NOT NULL GROUP BY date`).all()) m[dIdx.get(r.date)] = r.a;
  avg[h] = m;
}

const CANDS = [
  ['Bearish Divergence', 'f_bearishDiv=1'],
  ['Bearish Divergence + ADX>=20', 'f_bearishDiv=1 AND f_adx20=1'],
  ['MACD Red (hist<0, line>0)', 'f_macdRed=1'],
  ['MACD Red + ADX>=25', 'f_macdRed=1 AND f_adx25=1'],
  ['MACD Red + ADX>=25 + below EMA200', 'f_macdRed=1 AND f_adx25=1 AND f_aboveEma200=0'],
  ['MACD bear cross (line<signal)', 'f_macdBearCross=1'],
  ['RSI rejects from 70', 'f_rsiRejectFrom70=1'],
  ['RSI rejects from 70 + ADX>=20', 'f_rsiRejectFrom70=1 AND f_adx20=1'],
  ['RSI crosses 50 down', 'f_rsiCross50Down=1'],
  ['RSI crosses 50 down + below EMA200', 'f_rsiCross50Down=1 AND f_aboveEma200=0'],
  ['ATR trailing-stop breakdown', 'f_atrBreakdown=1'],
  ['ATR breakdown + ADX>=25', 'f_atrBreakdown=1 AND f_adx25=1'],
  ['ATR breakdown + below EMA200', 'f_atrBreakdown=1 AND f_aboveEma200=0'],
  ['VWAP loss (20d)', 'f_vwapLoss20=1'],
  ['VWAP loss + RSI>=70 state', 'f_vwapLoss20=1 AND f_rsiOverboughtState=1'],
  ['Bearish FVG formed', 'f_bearishFvgFormed=1'],
  ['Bearish FVG retest', 'f_bearishFvgRetest=1'],
  ['Bearish FVG retest + RSI cross 50 down', 'f_bearishFvgRetest=1 AND f_rsiCross50Down=1'],
];

const pct = x => (x * 100).toFixed(2).padStart(6) + '%';
function score(where) {
  const rows = db.prepare(`SELECT symbol, date, fwd10, fwd15, fwd20 FROM bar_features WHERE ${where} ORDER BY symbol, date`).all()
    .filter(r => !WL_ONLY || wl.has(r.symbol));
  const eps = []; let ls = '', li = -1e9;
  for (const r of rows) {
    const i = dIdx.get(r.date);
    if (r.symbol === ls && i - li < COOLDOWN) continue;
    eps.push({ ...r, i }); ls = r.symbol; li = i;
  }
  const out = {};
  for (const h of H) {
    const per = [[], [], []];
    for (const e of eps) { const f = e[`fwd${h}`]; if (f == null || !(avg[h][e.i] === avg[h][e.i])) continue; per[third(e.i)].push({ ex: f - avg[h][e.i], raw: f }); }
    const all = per.flat(), n = all.length, m = all.reduce((a, x) => a + x.ex, 0) / (n || 1);
    const sd = Math.sqrt(all.reduce((a, x) => a + (x.ex - m) ** 2, 0) / (n || 1));
    out[h] = { n, m, t: n > 1 && sd ? m / (sd / Math.sqrt(n)) : 0, raw: all.reduce((a, x) => a + x.raw, 0) / (n || 1), thirds: per.map(p => ({ n: p.length, m: p.reduce((a, x) => a + x.ex, 0) / (p.length || 1) })), down: all.filter(x => x.raw < 0).length / (n || 1) };
  }
  return { ep: eps.length, out };
}

console.log(`${WL_ONLY ? 'WATCHLIST ONLY' : 'FULL UNIVERSE'}  ${arg('db', 'long_features.db')}   ${dates[0]} → ${dates.at(-1)}   (negative excess = the sell signal worked)\n`);
console.log('signal'.padEnd(42) + 'episodes   ' + H.map(h => `${h}d excess (t)`.padEnd(20)).join('') + '15d excess by third (n)                    raw 15d  %down@15d');
for (const [name, where] of CANDS) {
  const r = score(where), o = r.out;
  const th = o[15].thirds.map(t => `${pct(t.m)}(${t.n})`).join(' ');
  const verdict = o[15].m < 0 && o[15].thirds.every(t => t.n >= 8 && t.m < 0) ? '  <-- negative in all 3 thirds' : '';
  console.log(name.padEnd(42) + String(r.ep).padStart(7) + '   ' + H.map(h => `${pct(o[h].m)} (${o[h].t.toFixed(1)})`.padEnd(20)).join('') + th.padEnd(42) + pct(o[15].raw) + '  ' + (o[15].down * 100).toFixed(0) + '%' + verdict);
}

/**
 * Dip-regime study. The daily search's 80%+ hits almost all contain
 * "SPY RSI(14) < 40". This isolates that: is it the stock-level trigger, or
 * just buying anything while the market is oversold?
 *
 *   node research/strategy-search/dip-study.mjs [--db=research/long_daily.db] [--limit-syms=N]
 *
 * Groups signals by independent market-dip EPISODE (runs of SPY RSI<40 days,
 * merged when separated by <= 5 sessions) — the honest sample size, since
 * hundreds of stocks bouncing off the same market low are one bet, not many.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { computeFlags, marketFlags } from './flags.mjs';
import { EXIT_MODELS, computeExits } from './exits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const db = new DatabaseSync(arg('db', join(__dirname, '..', 'long_daily.db')));
const LIMIT = Number(arg('limit-syms', '0'));
let syms = db.prepare('SELECT symbol, COUNT(*) n FROM bars GROUP BY symbol HAVING n >= 300 ORDER BY symbol').all().map(r => r.symbol);
if (LIMIT) syms = syms.slice(0, LIMIT);
if (!syms.includes('SPY')) syms.push('SPY');
const q = db.prepare('SELECT date, open, high, low, close, volume FROM bars WHERE symbol = ? ORDER BY date');
const load = s => { const r = q.all(s), n = r.length, b = { dates: r.map(x => x.date), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) }; r.forEach((x, i) => { b.o[i] = x.open; b.h[i] = x.high; b.l[i] = x.low; b.c[i] = x.close; b.v[i] = x.volume; }); return b; };
const spy = load('SPY'), sf = marketFlags(spy), spyAt = new Map(spy.dates.map((d, i) => [d, i]));

// market-dip episodes from SPY RSI<40 days
const dipDays = spy.dates.filter((_, i) => sf.rsiBelow40[i]);
const episodes = [];
for (const d of dipDays) {
  const last = episodes.at(-1), di = spyAt.get(d);
  if (last && di - last.endIdx <= 5) { last.endIdx = di; last.end = d; } else episodes.push({ start: d, end: d, startIdx: di, endIdx: di });
}
const epOf = d => { const i = spyAt.get(d); return episodes.findIndex(e => i >= e.startIdx && i <= e.endIdx); };

const MODELS = ['B1/3', 'H10', 'B2/2'];
const mi = MODELS.map(id => EXIT_MODELS.findIndex(m => m.id === id));
const TRIG = ['stochCrossUp', 'insideBreak', 'macdHistTurnPos', 'nr7Break', 'cciUpM100', 'rsiUp30', 'bbLowerReclaim'];
// stats[group][model][episode] = {n, w, sum}
const groups = ['ALL stocks, every dip day', 'any trigger', ...TRIG];
const stats = groups.map(() => MODELS.map(() => episodes.map(() => ({ n: 0, w: 0, s: 0 }))));
const outside = MODELS.map(() => ({ n: 0, w: 0 })); // baseline: every stock, every non-dip day
for (const s of syms) {
  const b = load(s), n = b.c.length;
  const mk = { valid: new Uint8Array(n), above200: new Uint8Array(n), rsiBelow40: new Uint8Array(n) };
  for (let i = 0; i < n; i++) { const j = spyAt.get(b.dates[i]); if (j !== undefined) { mk.valid[i] = sf.valid[j]; mk.above200[i] = sf.above200[j]; mk.rsiBelow40[i] = sf.rsiBelow40[j]; } }
  const { flags, aux } = computeFlags(b, mk), ex = computeExits({ aux, n });
  const lastFire = TRIG.map(() => -1e9);
  let lastAny = -1e9;
  for (let i = 0; i < n; i++) {
    const inDip = mk.rsiBelow40[i] === 1;
    const e = inDip ? epOf(b.dates[i]) : -1;
    MODELS.forEach((_, k) => { const r = ex[mi[k]][i]; if (r !== r) return; if (!inDip) { outside[k].n++; if (r > 0) outside[k].w++; } });
    if (!inDip || e < 0) continue;
    const hit = [true, TRIG.some(t => flags[t][i] === 1), ...TRIG.map(t => flags[t][i] === 1)];
    hit.forEach((h, g) => {
      if (!h) return;
      if (g >= 1) { // episode de-dup (10 bars) for trigger groups
        if (g === 1) { if (i - lastAny < 10) return; lastAny = i; } else { if (i - lastFire[g - 2] < 10) return; lastFire[g - 2] = i; }
      }
      MODELS.forEach((_, k) => { const r = ex[mi[k]][i]; if (r !== r) return; const c = stats[g][k][e]; c.n++; c.s += r; if (r > 0) c.w++; });
    });
  }
}
const pct = x => (x * 100).toFixed(0) + '%';
console.log(`SPY RSI<40 market-dip episodes: ${episodes.length}  (${episodes[0].start} -> ${episodes.at(-1).end})`);
console.log('baseline win rate, every stock on NON-dip days: ' + MODELS.map((m, k) => `${m} ${pct(outside[k].w / outside[k].n)}`).join('  '));
MODELS.forEach((m, k) => {
  console.log(`\n=== exit ${m} — pooled win rate / mean return by group, and how many of the ${episodes.length} dip episodes it won (>=50% win) ===`);
  groups.forEach((g, gi) => {
    const cells = stats[gi][k]; let n = 0, w = 0, s = 0, eps = 0, good = 0, good80 = 0;
    cells.forEach(c => { n += c.n; w += c.w; s += c.s; if (c.n >= 5) { eps++; if (c.w / c.n >= 0.5) good++; if (c.w / c.n >= 0.8) good80++; } });
    console.log(`${g.padEnd(28)} n=${String(n).padStart(6)}  win ${pct(w / n).padStart(4)}  mean ${(100 * s / n).toFixed(2).padStart(6)}%   episodes(n>=5): ${eps}, >=50% win in ${good}, >=80% in ${good80}`);
  });
});
console.log('\n=== per-episode detail, exit B1/3 ===');
console.log('episode'.padEnd(26) + 'ALL win(n)'.padEnd(16) + 'any-trigger win(n)');
episodes.forEach((e, ei) => {
  const a = stats[0][0][ei], t = stats[1][0][ei];
  if (a.n < 20) return;
  console.log(`${e.start}..${e.end}`.padEnd(26) + `${pct(a.w / a.n)} (${a.n})`.padEnd(16) + (t.n ? `${pct(t.w / t.n)} (${t.n})` : '-'));
});

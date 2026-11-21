/**
 * Strategy search: every trigger (+ up to 2 more flags) combination x every
 * exit model, scored on a chronological train / validate / test split.
 *
 *   node research/strategy-search/search.mjs --db=research/long_daily.db --label=daily
 *   node research/strategy-search/search.mjs --db=research/long_daily.db --label=daily-null --null --seed=1
 *
 * Flags: --limit-syms=N (dev), --min-ep=60, --cooldown=10, --null, --seed=N
 * Writes research/.out_search_<label>.json (gitignored) and prints summaries.
 *
 * Selection only ever looks at train + validate. The test slice (last 20% of
 * dates) is reported for whatever was selected, never used to choose.
 */
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { computeFlags, marketFlags } from './flags.mjs';
import { EXIT_MODELS, computeExits } from './exits.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const DB = arg('db', join(__dirname, '..', 'long_daily.db'));
const LABEL = arg('label', 'daily');
const NULL_MODE = process.argv.includes('--null');
let seed = Number(arg('seed', '1'));
const LIMIT = Number(arg('limit-syms', '0'));
const MIN_EP = Number(arg('min-ep', '60'));
const COOLDOWN = Number(arg('cooldown', '10'));
const TRIGGER_MAX_FREQ = 0.08;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

// ── load ──────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB);
let symbols = db.prepare('SELECT symbol, COUNT(*) n FROM bars GROUP BY symbol HAVING n >= 300 ORDER BY symbol').all().map(r => r.symbol);
if (LIMIT) symbols = symbols.slice(0, LIMIT);
if (!symbols.includes('SPY')) symbols.push('SPY');
const q = db.prepare('SELECT date, open, high, low, close, volume FROM bars WHERE symbol = ? ORDER BY date');
const raw = new Map();
for (const s of symbols) {
  const rows = q.all(s), n = rows.length;
  const b = { dates: rows.map(r => r.date), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  rows.forEach((r, i) => { b.o[i] = r.open; b.h[i] = r.high; b.l[i] = r.low; b.c[i] = r.close; b.v[i] = r.volume; });
  raw.set(s, b);
}
const allDates = [...new Set([...raw.values()].flatMap(b => b.dates))].sort();
const dateIdx = new Map(allDates.map((d, i) => [d, i]));
const D = allDates.length;
const spy = raw.get('SPY'), spyFlags = marketFlags(spy), spyAt = new Map(spy.dates.map((d, i) => [d, i]));
const evalSymbols = symbols.filter(s => s !== 'SPY' || !LIMIT || true);

let N = 0;
for (const s of evalSymbols) N += raw.get(s).c.length;
const W = Math.ceil(N / 32);
console.log(`[${LABEL}] ${evalSymbols.length} symbols, ${N.toLocaleString()} bars, ${D} dates (${allDates[0]} → ${allDates.at(-1)})${NULL_MODE ? '  ** NULL MODE (flags circularly shifted) **' : ''}`);

// ── build rows, flags, exits ──────────────────────────────────────────────
const M = EXIT_MODELS.length;
const rowSym = new Int32Array(N), rowDate = new Int32Array(N);
const ret = Array.from({ length: M }, () => new Float32Array(N).fill(NaN));
let flagNames = null, bits = null;
let base = 0;
for (let si = 0; si < evalSymbols.length; si++) {
  const s = evalSymbols[si], b = raw.get(s), n = b.c.length;
  const mk = { valid: new Uint8Array(n), above200: new Uint8Array(n), rsiBelow40: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const j = spyAt.get(b.dates[i]);
    if (j !== undefined) { mk.valid[i] = spyFlags.valid[j]; mk.above200[i] = spyFlags.above200[j]; mk.rsiBelow40[i] = spyFlags.rsiBelow40[j]; }
  }
  const { flags, aux } = computeFlags(b, mk);
  if (!flagNames) { flagNames = Object.keys(flags); bits = flagNames.map(() => new Int32Array(W)); }
  const ex = computeExits({ aux, n });
  const shift = NULL_MODE ? Math.floor(n * (0.1 + 0.8 * rand())) : 0;
  for (let i = 0; i < n; i++) {
    rowSym[base + i] = si; rowDate[base + i] = dateIdx.get(b.dates[i]);
    for (let m = 0; m < M; m++) ret[m][base + i] = ex[m][i];
  }
  for (let k = 0; k < flagNames.length; k++) {
    const f = flags[flagNames[k]], bk = bits[k];
    for (let i = 0; i < n; i++) {
      if (f[(i + shift) % n]) { const g = base + i; bk[g >>> 5] |= 1 << (g & 31); }
    }
  }
  base += n;
}

const popc = x => { x = x - ((x >>> 1) & 0x55555555); x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const popAll = a => { let c = 0; for (let w = 0; w < W; w++) c += popc(a[w]); return c; };
const freq = bits.map(b => popAll(b) / N);

// ── periods + date-matched baselines ──────────────────────────────────────
const cut1 = Math.floor(D * 0.6), cut2 = Math.floor(D * 0.8);
const per = new Uint8Array(N);
for (let i = 0; i < N; i++) per[i] = rowDate[i] < cut1 ? 0 : rowDate[i] < cut2 ? 1 : 2;
console.log(`splits: train < ${allDates[cut1]} <= validate < ${allDates[cut2]} <= test`);
const baseRet = [], baseWin = [];
for (let m = 0; m < M; m++) {
  const sum = new Float64Array(D), cnt = new Float64Array(D);
  const wn = new Float64Array(3), wt = new Float64Array(3);
  for (let i = 0; i < N; i++) { const r = ret[m][i]; if (r === r) { sum[rowDate[i]] += r; cnt[rowDate[i]]++; wt[per[i]]++; if (r > 0) wn[per[i]]++; } }
  const br = new Float32Array(N);
  for (let i = 0; i < N; i++) { const d = rowDate[i]; br[i] = cnt[d] ? sum[d] / cnt[d] : 0; }
  baseRet.push(br); baseWin.push([0, 1, 2].map(p => wn[p] / (wt[p] || 1)));
}

// ── combos ────────────────────────────────────────────────────────────────
const usable = flagNames.map((_, k) => k).filter(k => freq[k] >= 0.0005 && freq[k] <= 0.97);
const triggers = usable.filter(k => freq[k] <= TRIGGER_MAX_FREQ), filters = usable.filter(k => freq[k] > TRIGGER_MAX_FREQ);
console.log(`flags: ${flagNames.length} (${triggers.length} triggers, ${filters.length} filters)`);

const epIdx = new Int32Array(N), stamp = new Int32Array(D).fill(-1);
const A = new Float64Array(M * 3 * 7);
const out = [], counters = { cells: 0, combos: 0, win80: 0, win75: 0, win70: 0, robust: 0 };
const MINTR = 60, MINVA = 25;

function wilsonLo(w, n) { if (!n) return 0; const z = 1.96, p = w / n, d = 1 + z * z / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; }

function evaluate(vec, names) {
  // episodes: first fire, then ignore re-fires within COOLDOWN rows of the same symbol
  let ne = 0, lastSym = -1, lastIdx = -1e9;
  for (let w = 0; w < W; w++) {
    let x = vec[w];
    while (x !== 0) {
      const lb = x & -x, i = (w << 5) + (31 - Math.clz32(lb)); x ^= lb;
      const s = rowSym[i];
      if (s === lastSym && i - lastIdx < COOLDOWN) continue;
      epIdx[ne++] = i; lastSym = s; lastIdx = i;
    }
  }
  if (ne < MIN_EP) return;
  counters.combos++;
  let nd = 0;
  for (let k = 0; k < ne; k++) { const d = rowDate[epIdx[k]]; if (stamp[d] !== counters.combos) { stamp[d] = counters.combos; nd++; } }
  if (nd < 20) return;
  A.fill(0);
  for (let m = 0; m < M; m++) {
    const r = ret[m], br = baseRet[m], off = m * 21;
    for (let k = 0; k < ne; k++) {
      const i = epIdx[k], v = r[i]; if (v !== v) continue;
      const o = off + per[i] * 7, e = v - br[i];
      A[o]++; if (v > 0) { A[o + 1]++; A[o + 5] += v; } else A[o + 6] -= v;
      A[o + 2] += v; A[o + 3] += e; A[o + 4] += e * e;
    }
    counters.cells++;
    const a = off, nT = A[a], nV = A[a + 7], wT = A[a + 1] / (nT || 1), wV = A[a + 8] / (nV || 1);
    if (nT >= MINTR && nV >= MINVA) {
      const lo = Math.min(wT, wV);
      if (lo >= 0.8) counters.win80++; if (lo >= 0.75) counters.win75++; if (lo >= 0.7) counters.win70++;
    }
    // loose retention for later ranking
    const nTV = nT + nV, exTV = (A[a + 3] + A[a + 10]) / (nTV || 1);
    const varTV = (A[a + 4] + A[a + 11]) / (nTV || 1) - exTV * exTV;
    const tAdj = nTV > 1 && varTV > 0 ? exTV / Math.sqrt(varTV / Math.min(nTV, nd)) : 0;
    const robust = tAdj >= 3 && A[a + 3] > 0 && A[a + 10] > 0 && nT >= MINTR && nV >= MINVA;
    if (robust) counters.robust++;
    const hunt = nT >= MINTR && nV >= MINVA && wT >= 0.7 && wV >= 0.7;
    if (hunt || robust) {
      out.push({ combo: names, model: EXIT_MODELS[m].id, ep: ne, dates: nd, tAdj,
        p: [0, 1, 2].map(p => { const o = off + p * 7, n = A[o] || 0; return { n, win: n ? A[o + 1] / n : 0, mean: n ? A[o + 2] / n : 0, ex: n ? A[o + 3] / n : 0, pf: A[o + 6] > 0 ? A[o + 5] / A[o + 6] : null }; }) });
    }
  }
}

const tmp1 = new Int32Array(W), tmp2 = new Int32Array(W);
const MINROWS = MIN_EP;
const nm = k => flagNames[k];
const t0 = Date.now();
for (let ti = 0; ti < triggers.length; ti++) {
  const t = triggers[ti], bt = bits[t];
  evaluate(bt, [nm(t)]);
  const others = [...filters, ...triggers.slice(ti + 1)];
  for (let oi = 0; oi < others.length; oi++) {
    const f1 = others[oi], b1 = bits[f1];
    let c = 0; for (let w = 0; w < W; w++) { const v = bt[w] & b1[w]; tmp1[w] = v; c += popc(v); }
    if (c < MINROWS) continue;
    evaluate(tmp1, [nm(t), nm(f1)]);
    for (let oj = oi + 1; oj < others.length; oj++) {
      const f2 = others[oj];
      // skip trigger-trigger-trigger: keep at most 2 triggers per combo
      if (freq[f1] <= TRIGGER_MAX_FREQ && freq[f2] <= TRIGGER_MAX_FREQ) continue;
      const b2 = bits[f2]; let c2 = 0;
      for (let w = 0; w < W; w++) { const v = tmp1[w] & b2[w]; tmp2[w] = v; c2 += popc(v); }
      if (c2 < MINROWS) continue;
      evaluate(tmp2, [nm(t), nm(f1), nm(f2)]);
    }
  }
  if ((ti + 1) % 5 === 0 || ti === triggers.length - 1) console.log(`  trigger ${ti + 1}/${triggers.length}  combos ${counters.combos}  cells ${counters.cells}  retained ${out.length}  ${(Date.now() - t0) / 1000 | 0}s`);
}

// ── report ────────────────────────────────────────────────────────────────
const pct = x => (x * 100).toFixed(1) + '%';
const row = r => {
  const [a, b, c] = r.p, mi = EXIT_MODELS.findIndex(m => m.id === r.model);
  return `${r.combo.join(' + ').padEnd(54)} ${r.model.padEnd(7)} ep=${String(r.ep).padStart(5)} d=${String(r.dates).padStart(4)}  win tr/va/te ${pct(a.win).padStart(6)} ${pct(b.win).padStart(6)} ${pct(c.win).padStart(6)} (n_te=${c.n})  base ${pct(baseWin[mi][0])}/${pct(baseWin[mi][2])}  mean_te ${pct(c.mean)}  ex_te ${pct(c.ex)}  PF_te ${c.pf ? c.pf.toFixed(2) : '-'}  t=${r.tAdj.toFixed(1)}`;
};
console.log(`\ncells tested: ${counters.cells.toLocaleString()} (${counters.combos.toLocaleString()} combos x ${M} exits)`);
console.log(`cells with win rate >= 80% / 75% / 70% in BOTH train and validate (n>=${MINTR}/${MINVA}): ${counters.win80} / ${counters.win75} / ${counters.win70}`);
console.log(`cells with significant positive excess return in both halves (t>=3): ${counters.robust}`);
console.log(`baseline win rate (all stocks, train/test) by exit: ` + EXIT_MODELS.map((m, i) => `${m.id} ${pct(baseWin[i][0])}/${pct(baseWin[i][2])}`).join(', '));

const hunt = out.filter(r => r.p[0].n >= MINTR && r.p[1].n >= MINVA && r.p[0].win >= 0.7 && r.p[1].win >= 0.7)
  .map(r => ({ r, score: wilsonLo(r.p[0].win * r.p[0].n + r.p[1].win * r.p[1].n, r.p[0].n + r.p[1].n) }))
  .sort((a, b) => b.score - a.score);
console.log(`\n== WIN-RATE HUNT: top 30 by Wilson lower bound of train+validate win rate (test shown, never used to select) ==`);
hunt.slice(0, 30).forEach(({ r }) => console.log(row(r)));
const topH = hunt.slice(0, 100).map(h => h.r);
const survive = topH.filter(r => r.p[2].n >= 20 && r.p[2].win >= 0.7).length;
console.log(`of the top ${topH.length}: ${topH.filter(r => r.p[2].n >= 20).length} have >=20 test episodes; ${survive} keep >=70% win in test; ${topH.filter(r => r.p[2].n >= 20 && r.p[2].win >= 0.8).length} keep >=80%`);

const robust = out.filter(r => r.tAdj >= 3 && r.p[0].ex > 0 && r.p[1].ex > 0 && r.p[0].n >= MINTR && r.p[1].n >= MINVA).sort((a, b) => b.tAdj - a.tAdj);
console.log(`\n== ROBUST EDGE: top 30 by t-stat of excess return over same-day average (train+validate) ==`);
robust.slice(0, 30).forEach(r => console.log(row(r)));
const tops = robust.slice(0, 100);
console.log(`of the top ${tops.length}: ${tops.filter(r => r.p[2].n >= 20).length} have >=20 test episodes; ${tops.filter(r => r.p[2].n >= 20 && r.p[2].ex > 0).length} keep positive excess in test`);

writeFileSync(join(__dirname, '..', `.out_search_${LABEL}.json`), JSON.stringify({ label: LABEL, counters, baseWin, splits: [allDates[cut1], allDates[cut2]], hunt: hunt.slice(0, 500).map(h => h.r), robust: robust.slice(0, 500) }));
console.log(`\ndone in ${(Date.now() - t0) / 1000 | 0}s`);

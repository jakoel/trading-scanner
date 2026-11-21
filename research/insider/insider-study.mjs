/**
 * Event study: do stocks outperform after insiders buy them on the open market?
 *
 *   node research/insider/insider-study.mjs [--db=research/long_daily.db]
 *
 * Event timing: a purchase is public on its SEC FILING date. Entry = close of the
 * first session strictly after the filing date (filings often land after the
 * close), so nothing uses information before it was public.
 * Outcome: return 10/20/40/60 sessions after entry, minus the same-day average
 * stock ("excess"), and minus the same-day average stock in the same 60-day
 * volatility quintile ("vol-matched"). One event per symbol per 20 sessions.
 *
 * Big caveat: prices exist only for today's index members (research/long_daily.db),
 * so insider buys in companies that later failed or were delisted are missing.
 * Insiders often buy into distress, so this flatters the results.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const HZ = [10, 20, 40, 60], COOL = 20;
const wl = new Set(readFileSync(join(__dirname, '..', '..', 'watchlist.txt'), 'utf-8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')));

// ── prices ──
const db = new DatabaseSync(arg('db', join(__dirname, '..', 'long_daily.db')), { readonly: true });
const dates = db.prepare('SELECT DISTINCT date FROM bars ORDER BY date').all().map(r => r.date);
const dIdx = new Map(dates.map((d, i) => [d, i]));
const P = new Map();
for (const { symbol } of db.prepare("SELECT DISTINCT symbol FROM bars WHERE symbol NOT IN ('SPY','QQQ','IWM')").all()) {
  const rows = db.prepare('SELECT date, close FROM bars WHERE symbol = ? ORDER BY date').all(symbol);
  const c = rows.map(r => r.close), g = rows.map(r => dIdx.get(r.date));
  const ret = c.map((x, i) => (i ? x / c[i - 1] - 1 : 0));
  const vol = c.map((_, i) => { if (i < 61) return null; let m = 0; for (let k = i - 59; k <= i; k++) m += ret[k]; m /= 60; let v = 0; for (let k = i - 59; k <= i; k++) v += (ret[k] - m) ** 2; return Math.sqrt(v / 59); });
  P.set(symbol, { d: rows.map(r => r.date), c, g, vol, vq: new Array(c.length).fill(null) });
}
// volatility quintiles per date
const byDate = new Map();
for (const s of P.values()) s.vol.forEach((v, i) => { if (v != null) (byDate.get(s.g[i]) ?? byDate.set(s.g[i], []).get(s.g[i])).push([s, i, v]); });
for (const arr of byDate.values()) { arr.sort((a, b) => a[2] - b[2]); arr.forEach(([s, i], r) => { s.vq[i] = Math.min(4, Math.floor(5 * r / arr.length)); }); }
// same-day baselines: all stocks, and per vol quintile
const base = {}, baseV = {};
for (const h of HZ) {
  const S = new Float64Array(dates.length), N = new Float64Array(dates.length), SV = new Float64Array(dates.length * 5), NV = new Float64Array(dates.length * 5);
  for (const s of P.values()) for (let i = 0; i + h < s.c.length; i++) { const r = s.c[i + h] / s.c[i] - 1; S[s.g[i]] += r; N[s.g[i]]++; if (s.vq[i] != null) { SV[s.g[i] * 5 + s.vq[i]] += r; NV[s.g[i] * 5 + s.vq[i]]++; } }
  base[h] = g => (N[g] ? S[g] / N[g] : null); baseV[h] = (g, q) => (NV[g * 5 + q] ? SV[g * 5 + q] / NV[g * 5 + q] : null);
}

// ── purchases ──
const lines = readFileSync(join(__dirname, 'purchases.csv'), 'utf-8').trim().split('\n').slice(1);
const buys = new Map(); // symbol -> [{fd, owner, value, ceo}]
let kept = 0;
for (const ln of lines) {
  const m = ln.match(/^([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),"([^"]*)",([^,]*),([^,]*),([^,]*),/);
  if (!m) continue;
  const [, sym, fd, , owner, dir, off, , title, , , value] = m;
  if (!P.has(sym) || !(dir === '1' || off === '1')) continue; // directors/officers only; 10%-owner-only filers are funds
  const v = Number(value); if (!(v >= 10000)) continue;
  (buys.get(sym) ?? buys.set(sym, []).get(sym)).push({ fd, owner, value: v, ceo: /chief exec|\bceo\b|chief financial|\bcfo\b|president/i.test(title) });
  kept++;
}
console.log(`${kept} director/officer open-market purchases >= $10k in ${buys.size} of ${P.size} stocks with prices (${dates[0]} → ${dates.at(-1)})`);

// event date -> entry index (first session strictly after filing date)
function entryIdx(s, fd) { let lo = 0, hi = s.d.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s.d[m] <= fd) lo = m + 1; else hi = m; } return lo < s.d.length ? lo : -1; }
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

const VARIANTS = {
  'Any director/officer buy >= $25k': (list) => list.filter(b => b.value >= 25000).map(b => b.fd),
  'Buy >= $100k': (list) => list.filter(b => b.value >= 100000).map(b => b.fd),
  'Buy >= $500k': (list) => list.filter(b => b.value >= 500000).map(b => b.fd),
  'CEO/CFO/President buy >= $50k': (list) => list.filter(b => b.ceo && b.value >= 50000).map(b => b.fd),
  'Cluster: >= 2 insiders within 30 days': (list) => clusters(list, 2, 0),
  'Cluster: >= 3 insiders within 30 days': (list) => clusters(list, 3, 0),
  'Cluster: >= 3 insiders, total >= $250k': (list) => clusters(list, 3, 250000),
};
function clusters(list, minOwners, minValue) {
  const s = [...list].sort((a, b) => (a.fd < b.fd ? -1 : 1)), out = [];
  for (let i = 0; i < s.length; i++) {
    const from = addDays(s[i].fd, -30), owners = new Set(); let val = 0;
    for (let j = i; j >= 0 && s[j].fd > from; j--) { owners.add(s[j].owner); val += s[j].value; }
    if (owners.size >= minOwners && val >= minValue) out.push(s[i].fd);
  }
  return out;
}

const third = g => (g < dates.length / 3 ? 0 : g < 2 * dates.length / 3 ? 1 : 2);
const pct = x => (x == null || Number.isNaN(x) ? '    -' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
console.log(`\nExcess = vs same-day average stock; VM = vs same-day stocks in the same volatility quintile. Thirds split ${dates[Math.floor(dates.length / 3)]} / ${dates[Math.floor(2 * dates.length / 3)]}. t uses distinct entry dates as n.`);
console.log('variant'.padEnd(40) + 'events  pre20d   ' + HZ.map(h => `${h}d raw / exc / VM (t)`.padEnd(28)).join('') + '20d VM by third        WL-only 20d VM (n)');
for (const [name, fn] of Object.entries(VARIANTS)) {
  const ev = [];
  for (const [sym, list] of buys) {
    const s = P.get(sym); let last = -1e9;
    for (const fd of [...new Set(fn(list))].sort()) { const e = entryIdx(s, fd); if (e < 61 || e - last < COOL) continue; last = e; ev.push({ sym, s, e }); }
  }
  const cells = HZ.map(h => {
    const xs = ev.filter(x => x.e + h < x.s.c.length).map(x => { const r = x.s.c[x.e + h] / x.s.c[x.e] - 1, g = x.s.g[x.e], b = base[h](g), bv = x.s.vq[x.e] != null ? baseV[h](g, x.s.vq[x.e]) : null; return { r, ex: b == null ? null : r - b, vm: bv == null ? null : r - bv, g, wl: wl.has(x.sym) }; }).filter(x => x.ex != null && x.vm != null);
    const n = xs.length, m = k => xs.reduce((a, x) => a + x[k], 0) / (n || 1);
    const vm = m('vm'), sd = Math.sqrt(xs.reduce((a, x) => a + (x.vm - vm) ** 2, 0) / (n || 1)), nd = new Set(xs.map(x => x.g)).size;
    return { n, raw: m('r'), ex: m('ex'), vm, t: sd ? vm / (sd / Math.sqrt(nd)) : 0, xs };
  });
  const pre = ev.map(x => x.s.c[x.e - 1] / x.s.c[x.e - 21] - 1).reduce((a, b) => a + b, 0) / (ev.length || 1);
  const c20 = cells[1], th = [0, 1, 2].map(t => { const z = c20.xs.filter(x => third(x.g) === t); return z.length ? `${pct(z.reduce((a, x) => a + x.vm, 0) / z.length)}(${z.length})` : '-'; }).join(' ');
  const w = c20.xs.filter(x => x.wl), wtxt = w.length ? `${pct(w.reduce((a, x) => a + x.vm, 0) / w.length)} (${w.length})` : '-';
  console.log(name.padEnd(40) + String(ev.length).padStart(6) + pct(pre).padStart(8) + '   ' + cells.map(c => `${pct(c.raw)} / ${pct(c.ex)} / ${pct(c.vm)} (${c.t.toFixed(1)})`.padEnd(28)).join('') + th.padEnd(23) + wtxt);
}

/**
 * Brute-forces every pairwise combo of features.mjs's flags against
 * research.db (built by build-cache.mjs) and ranks the ones that survive a
 * split-period out-of-sample check.
 *
 * Guard against overfitting a ~300-combo brute force on a few hundred trading
 * days of history: history is split at its median date into an early half and
 * a late half. A combo only "passes" if it wins >50% in BOTH halves
 * independently (not just combined) AND its combined win rate beats the
 * better of its two legs' own single-flag win rate by MIN_LIFT — a combo that
 * only looks good in one half, or that's no better than its stronger leg
 * alone, is noise, not a real interaction.
 *
 * Usage: node research/build-cache.mjs   (run first, or after bars.db changes)
 *        node research/brute-force.mjs [--db=path]
 *   --db defaults to research/research.db; point it at whatever --out
 *   build-cache.mjs was given (e.g. research/universe_features.db) to run
 *   against a different cached universe.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { FLAG_NAMES } from './features.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function argValue(name, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
}

const RESEARCH_DB = argValue('db', join(__dirname, 'research.db'));
const HORIZONS = [5, 10, 20, 30];
const MIN_TOTAL = 40;   // minimum combined sample before a combo is even considered
const MIN_HALF = 15;    // minimum sample within EACH half — below this a half's win rate is too noisy to judge
const MIN_LIFT = 0.03;  // combo's total win rate must beat the better single leg by at least this many points

const db = new DatabaseSync(RESEARCH_DB);

const cols = ['date', ...HORIZONS.map(n => `fwd${n}`), ...FLAG_NAMES.map(n => `f_${n}`)];
const rows = db.prepare(`SELECT ${cols.join(', ')} FROM bar_features ORDER BY date`).all();
console.log(`Loaded ${rows.length} bar-rows from research.db`);

const dates = rows.map(r => r.date).sort();
const cutoff = dates[Math.floor(dates.length / 2)];
console.log(`Split-period cutoff: ${cutoff} (half1 < cutoff, half2 >= cutoff)\n`);

function statsFor(subset, col) {
  const vals = subset.map(r => r[col]).filter(v => v != null);
  if (!vals.length) return { n: 0, avg: null, win: null };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const win = vals.filter(v => v > 0).length / vals.length;
  return { n: vals.length, avg, win };
}

// Single-flag baselines, needed both to print for reference and to judge
// whether a combo actually beats its stronger leg rather than just riding it.
const baselines = {};
for (const flag of FLAG_NAMES) {
  const subset = rows.filter(r => r[`f_${flag}`] === 1);
  baselines[flag] = Object.fromEntries(HORIZONS.map(h => [h, statsFor(subset, `fwd${h}`)]));
}

console.log('=== SINGLE-FLAG BASELINES (10d) ===');
for (const flag of FLAG_NAMES) {
  const s = baselines[flag][10];
  const avgStr = s.avg != null ? `${(s.avg * 100).toFixed(2)}%` : '  -  ';
  const winStr = s.win != null ? `${(s.win * 100).toFixed(0)}%` : ' - ';
  console.log(`${flag.padEnd(22)} n=${String(s.n).padEnd(5)} avg=${avgStr.padEnd(8)} win=${winStr}`);
}

// Brute force every pair, every horizon.
const results = [];
for (let a = 0; a < FLAG_NAMES.length; a++) {
  for (let bIdx = a + 1; bIdx < FLAG_NAMES.length; bIdx++) {
    const flagA = FLAG_NAMES[a], flagB = FLAG_NAMES[bIdx];
    const subset = rows.filter(r => r[`f_${flagA}`] === 1 && r[`f_${flagB}`] === 1);
    if (subset.length < MIN_TOTAL) continue;

    const half1 = subset.filter(r => r.date < cutoff);
    const half2 = subset.filter(r => r.date >= cutoff);

    for (const h of HORIZONS) {
      const s1 = statsFor(half1, `fwd${h}`);
      const s2 = statsFor(half2, `fwd${h}`);
      if (s1.n < MIN_HALF || s2.n < MIN_HALF) continue;

      const total = statsFor(subset, `fwd${h}`);
      const baselineWin = Math.max(baselines[flagA][h].win ?? 0, baselines[flagB][h].win ?? 0);
      const passesOos = s1.win > 0.5 && s2.win > 0.5 && total.win >= baselineWin + MIN_LIFT;

      results.push({ flagA, flagB, horizon: h, total, s1, s2, baselineWin, passesOos });
    }
  }
}

const totalCells = (FLAG_NAMES.length * (FLAG_NAMES.length - 1) / 2) * HORIZONS.length;
console.log(`\nTested ${FLAG_NAMES.length * (FLAG_NAMES.length - 1) / 2} pairs x ${HORIZONS.length} horizons = ${totalCells} combo-horizon cells`);
console.log(`${results.length} had n>=${MIN_TOTAL} total and n>=${MIN_HALF} in each half`);
const passing = results.filter(r => r.passesOos);
console.log(`${passing.length} passed the split-period OOS check (win>50% in both halves AND beats the stronger leg's own win rate by >=${(MIN_LIFT * 100).toFixed(0)}pp)`);

db.exec('DELETE FROM combo_results');
const insert = db.prepare(`
  INSERT INTO combo_results (flag_a, flag_b, horizon, n_total, avg_total, win_total, n_half1, avg_half1, win_half1, n_half2, avg_half2, win_half2, baseline_win, passes_oos)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
db.exec('BEGIN');
for (const r of results) {
  insert.run(
    r.flagA, r.flagB, r.horizon,
    r.total.n, r.total.avg, r.total.win,
    r.s1.n, r.s1.avg, r.s1.win,
    r.s2.n, r.s2.avg, r.s2.win,
    r.baselineWin, r.passesOos ? 1 : 0,
  );
}
db.exec('COMMIT');
console.log(`\nAll ${results.length} tested combos written to combo_results (query research.db directly for anything not printed below).`);

for (const h of HORIZONS) {
  const top = passing.filter(r => r.horizon === h).sort((a, b) => b.total.win - a.total.win).slice(0, 10);
  console.log(`\n=== TOP PASSING COMBOS @ ${h}d (ranked by combined win rate) ===`);
  if (!top.length) { console.log('  (none passed)'); continue; }
  for (const r of top) {
    const label = `${r.flagA} + ${r.flagB}`;
    console.log(
      `${label.padEnd(46)} n=${String(r.total.n).padEnd(4)} avg=${(r.total.avg * 100).toFixed(2)}% win=${(r.total.win * 100).toFixed(0)}%` +
      `  | half1: n=${r.s1.n} win=${(r.s1.win * 100).toFixed(0)}%` +
      `  | half2: n=${r.s2.n} win=${(r.s2.win * 100).toFixed(0)}%` +
      `  | best single leg win=${(r.baselineWin * 100).toFixed(0)}%`
    );
  }
}

/**
 * Builds research/research.db from data/bars.db — a wide table, one row per
 * (symbol, date), holding every atomic flag from features.mjs plus forward
 * returns at several horizons, so brute-force.mjs never has to recompute
 * indicators or re-walk bar history per combo.
 *
 * research.db is gitignored and fully disposable: rerun this file any time
 * data/bars.db changes (new sessions, symbol additions) to refresh it.
 *
 * Usage: node research/build-cache.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { computeIndicators } from '../lib/indicators.js';
import { FLAG_NAMES, extractFlags } from './features.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_DB = join(__dirname, '..', 'data', 'bars.db');
const RESEARCH_DB = join(__dirname, 'research.db');
const HORIZONS = [5, 10, 20, 30];

if (existsSync(RESEARCH_DB)) unlinkSync(RESEARCH_DB); // rebuilt fresh every run, cheap for ~40k rows

const src = new DatabaseSync(SOURCE_DB, { readonly: true });
const db = new DatabaseSync(RESEARCH_DB);

db.exec(`
  CREATE TABLE bar_features (
    symbol TEXT NOT NULL,
    date TEXT NOT NULL,
    price REAL NOT NULL,
    ${HORIZONS.map(n => `fwd${n} REAL`).join(', ')},
    ${FLAG_NAMES.map(n => `f_${n} INTEGER`).join(', ')},
    PRIMARY KEY (symbol, date)
  );
  CREATE TABLE combo_results (
    flag_a TEXT NOT NULL,
    flag_b TEXT NOT NULL,
    horizon INTEGER NOT NULL,
    n_total INTEGER, avg_total REAL, win_total REAL,
    n_half1 INTEGER, avg_half1 REAL, win_half1 REAL,
    n_half2 INTEGER, avg_half2 REAL, win_half2 REAL,
    baseline_win REAL,
    passes_oos INTEGER,
    PRIMARY KEY (flag_a, flag_b, horizon)
  );
`);

const insert = db.prepare(`
  INSERT INTO bar_features (symbol, date, price, ${HORIZONS.map(n => `fwd${n}`).join(', ')}, ${FLAG_NAMES.map(n => `f_${n}`).join(', ')})
  VALUES (?, ?, ?, ${HORIZONS.map(() => '?').join(', ')}, ${FLAG_NAMES.map(() => '?').join(', ')})
`);

const symbols = src.prepare('SELECT DISTINCT symbol FROM bars').all().map(r => r.symbol);
let totalRows = 0;

db.exec('BEGIN');
for (const symbol of symbols) {
  const bars = src.prepare('SELECT date,open,high,low,close,volume FROM bars WHERE symbol = ? ORDER BY date').all(symbol);
  if (bars.length < 60) continue;
  const rows = computeIndicators(bars);

  for (let i = 1; i < rows.length; i++) {
    const flags = extractFlags(rows, i);
    if (!flags) continue;

    const fwds = HORIZONS.map(n => {
      const j = i + n;
      return j < rows.length ? (rows[j].price - rows[i].price) / rows[i].price : null;
    });

    insert.run(
      symbol, rows[i].date, rows[i].price,
      ...fwds,
      ...FLAG_NAMES.map(name => flags[name]),
    );
    totalRows++;
  }
}
db.exec('COMMIT');

console.log(`Cached ${totalRows} bar-rows across ${symbols.length} symbols into ${RESEARCH_DB}`);

/**
 * Append-only historical record of every fired signal, for later research into
 * which signals actually worked. Unlike data/bars/*.csv, this file is never
 * trimmed — it's a growing research log, not a rolling indicator window.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getActiveSignals } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, '..', 'data', 'signals.csv');
const HEADER = 'date,symbol,signal,price,atr,ema200,rsi';

/**
 * Appends one row per active signal on each result entry. Uses `r.date`, the
 * trading day the signal fired on (the bar date), not the run's wall-clock
 * date, so manual/late runs still log against the correct day.
 */
export function logSignals(results) {
  if (!existsSync(dirname(LOG_PATH))) mkdirSync(dirname(LOG_PATH), { recursive: true });
  const exists = existsSync(LOG_PATH);

  // A re-run on the same trading day (a manual scan, a retried dispatch) would
  // otherwise append a second copy of every signal already logged for that day,
  // double-counting it in any hit-rate analysis of this file. Key on the
  // identity of the event — trading day, symbol, signal — not the whole row,
  // since price/RSI can shift slightly between runs on the same bar.
  const seen = new Set();
  if (exists) {
    for (const line of readFileSync(LOG_PATH, 'utf-8').split('\n')) {
      const [date, symbol, signal] = line.split(',');
      if (signal) seen.add(`${date},${symbol},${signal}`);
    }
  }

  const rows = [];
  for (const r of results) {
    for (const signal of getActiveSignals(r)) {
      const key = `${r.date},${r.symbol},${signal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(`${key},${r.price},${r.atr},${r.ema200 ?? ''},${r.rsi}`);
    }
  }
  if (!rows.length) return;

  appendFileSync(LOG_PATH, (exists ? '' : HEADER + '\n') + rows.join('\n') + '\n');
}

/**
 * Append-only historical record of every fired signal, for later research into
 * which signals actually worked. Unlike data/bars/*.csv, this file is never
 * trimmed — it's a growing research log, not a rolling indicator window.
 */
import { existsSync, mkdirSync, appendFileSync } from 'fs';
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
  const rows = [];
  for (const r of results) {
    for (const signal of getActiveSignals(r)) {
      rows.push(`${r.date},${r.symbol},${signal},${r.price},${r.atr},${r.ema200 ?? ''},${r.rsi}`);
    }
  }
  if (!rows.length) return;

  if (!existsSync(dirname(LOG_PATH))) mkdirSync(dirname(LOG_PATH), { recursive: true });
  const needsHeader = !existsSync(LOG_PATH);
  appendFileSync(LOG_PATH, (needsHeader ? HEADER + '\n' : '') + rows.join('\n') + '\n');
}

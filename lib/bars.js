/**
 * Persisted daily OHLCV history per symbol, stored as one CSV per ticker under
 * data/bars/. Each run fetches only the bars missing since the last stored date
 * (usually just the latest one) instead of re-pulling full history every time.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import YahooFinance from 'yahoo-finance2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BARS_DIR = join(__dirname, '..', 'data', 'bars');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const BACKFILL_DAYS = 750; // ~500 trading days, matching the Pine script's max_bars_back
const RETENTION_ROWS = 400;

function csvPath(symbol) {
  return join(BARS_DIR, `${symbol}.csv`);
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, open, high, low, close, volume] = lines[i].split(',');
    if (!date) continue;
    rows.push({ date, open: +open, high: +high, low: +low, close: +close, volume: +volume });
  }
  return rows;
}

function toCsv(rows) {
  const header = 'date,open,high,low,close,volume';
  const lines = rows.map(r => `${r.date},${r.open},${r.high},${r.low},${r.close},${r.volume}`);
  return [header, ...lines].join('\n') + '\n';
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchChart(symbol, period1) {
  const res = await yf.chart(symbol, { period1, interval: '1d' });
  return res.quotes
    .filter(q => q.close != null && q.open != null && q.high != null && q.low != null)
    .map(q => ({
      date: toDateStr(q.date),
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume ?? 0,
    }));
}

/**
 * Reads the persisted history for `symbol`, fetches only bars newer than what's
 * stored (or a full backfill if nothing is stored yet), appends, dedupes, trims
 * to RETENTION_ROWS, writes back, and returns the full up-to-date row array.
 */
export async function updateBars(symbol) {
  if (!existsSync(BARS_DIR)) mkdirSync(BARS_DIR, { recursive: true });

  const path = csvPath(symbol);
  let existing = [];
  if (existsSync(path)) {
    existing = parseCsv(readFileSync(path, 'utf-8'));
  }

  const lastDate = existing.length ? existing[existing.length - 1].date : null;
  const today = toDateStr(new Date());

  if (lastDate === today) {
    return existing; // already up to date, no fetch needed
  }

  let period1;
  if (lastDate) {
    const d = new Date(lastDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    period1 = d;
  } else {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - BACKFILL_DAYS);
    period1 = d;
  }

  const fresh = await fetchChart(symbol, period1);

  const byDate = new Map(existing.map(r => [r.date, r]));
  for (const row of fresh) byDate.set(row.date, row);

  let merged = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (merged.length > RETENTION_ROWS) {
    merged = merged.slice(merged.length - RETENTION_ROWS);
  }

  writeFileSync(path, toCsv(merged));
  return merged;
}

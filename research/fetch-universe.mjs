/**
 * Fetches ~200 trading days of daily OHLCV for a large ticker universe (S&P
 * 500 by default) directly from Yahoo Finance into research/universe.db —
 * completely separate from data/bars.db, which this never touches. Exists so
 * brute-force.mjs can be re-run against a much bigger cross-section than the
 * ~104-symbol watchlist for more statistically stable combo results.
 *
 * Usage: node research/fetch-universe.mjs [--tickers=path] [--out=path] [--days=200]
 *   --tickers  defaults to research/sp500_tickers.txt (one symbol per line)
 *   --out      defaults to research/universe.db
 *   --days     trading days to keep per symbol (default 200)
 */
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import YahooFinance from 'yahoo-finance2';

const __dirname = dirname(fileURLToPath(import.meta.url));

function argValue(name, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : fallback;
}

const TICKERS_PATH = argValue('tickers', join(__dirname, 'sp500_tickers.txt'));
const OUT_PATH = argValue('out', join(__dirname, 'universe.db'));
const KEEP_DAYS = Number(argValue('days', '200'));
const CALENDAR_LOOKBACK_DAYS = Math.ceil(KEEP_DAYS * 1.5) + 20; // covers weekends/holidays with margin
const CONCURRENCY = 8;

const symbols = readFileSync(TICKERS_PATH, 'utf-8')
  .split('\n').map(s => s.trim()).filter(Boolean);

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

if (existsSync(OUT_PATH)) unlinkSync(OUT_PATH); // rebuilt fresh every run
const db = new DatabaseSync(OUT_PATH);
db.exec(`
  CREATE TABLE bars (
    symbol TEXT NOT NULL, date TEXT NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
    PRIMARY KEY (symbol, date)
  );
`);
const insert = db.prepare(`INSERT OR REPLACE INTO bars (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)`);

function easternDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

async function fetchOne(symbol) {
  const period1 = new Date();
  period1.setUTCDate(period1.getUTCDate() - CALENDAR_LOOKBACK_DAYS);
  const res = await yf.chart(symbol, { period1, interval: '1d' });
  const rows = res.quotes
    .filter(q => q.close != null && q.open != null && q.high != null && q.low != null)
    .map(q => ({ date: easternDate(q.date), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }))
    .slice(-KEEP_DAYS); // most recent KEEP_DAYS only
  return rows;
}

// Simple fixed-size concurrency pool — 503 sequential requests would be slow,
// unbounded parallelism risks Yahoo rate-limiting.
async function runPool(items, worker, concurrency) {
  let idx = 0, done = 0;
  const results = new Array(items.length);
  async function next() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await worker(items[i]);
      } catch (e) {
        results[i] = { error: e.message };
      }
      done++;
      if (done % 50 === 0 || done === items.length) console.log(`  ${done}/${items.length} symbols fetched`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return results;
}

console.log(`Fetching ${symbols.length} symbols, ${KEEP_DAYS} trading days each, into ${OUT_PATH}`);

const results = await runPool(symbols, fetchOne, CONCURRENCY);

let ok = 0, failed = [];
db.exec('BEGIN');
for (let i = 0; i < symbols.length; i++) {
  const symbol = symbols[i];
  const rows = results[i];
  if (!rows || rows.error || rows.length < 60) {
    failed.push(symbol);
    continue;
  }
  for (const row of rows) insert.run(symbol, row.date, row.open, row.high, row.low, row.close, row.volume);
  ok++;
}
db.exec('COMMIT');

console.log(`\nDone: ${ok} symbols stored, ${failed.length} failed/too-short.`);
if (failed.length) console.log('Failed:', failed.join(', '));

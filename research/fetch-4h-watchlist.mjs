/**
 * Fetches ~2 years of 1h OHLCV for the production watchlist from Yahoo
 * Finance (Yahoo's max lookback for hourly bars) and resamples it into 4H
 * bars, into research/watchlist_4h.db — completely separate from
 * data/bars.db, which this never touches.
 *
 * Resampling: hourly bars are grouped by US trading day (7 bars on a normal
 * day: six 60-minute bars 9:30-15:30 ET, plus one 30-minute closing bar
 * 15:30-16:00 ET), then split into chunks of 4 in day-order. A normal day
 * yields two 4H bars: 9:30-13:30 ET (a full 4 hours) and 13:30-16:00 ET (a
 * short ~2.5-hour second bar) — the same two-bars-a-day shape a 4H chart
 * shows for US equities. Half-days just produce one short chunk instead of
 * two; this is chunked by bar count, not by clock time, so it needs no
 * special-casing for that or for DST.
 *
 * Usage: node research/fetch-4h-watchlist.mjs [--tickers=path] [--out=path] [--days=729]
 *   --tickers  defaults to watchlist.txt (this repo's production watchlist)
 *   --out      defaults to research/watchlist_4h.db
 *   --days     calendar days of 1h history to request (default 729, Yahoo's ceiling)
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

const TICKERS_PATH = argValue('tickers', join(__dirname, '..', 'watchlist.txt'));
const OUT_PATH = argValue('out', join(__dirname, 'watchlist_4h.db'));
const LOOKBACK_DAYS = Number(argValue('days', '729'));
const CONCURRENCY = 8;

const symbols = readFileSync(TICKERS_PATH, 'utf-8')
  .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

function easternDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

function resampleTo4h(hourlyBars) {
  const byDay = new Map();
  for (const bar of hourlyBars) {
    const day = easternDate(bar.date);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(bar);
  }
  const out = [];
  for (const dayBars of byDay.values()) {
    for (let i = 0; i < dayBars.length; i += 4) {
      const chunk = dayBars.slice(i, i + 4);
      out.push({
        date: chunk[0].date.toISOString(),
        open: chunk[0].open,
        high: Math.max(...chunk.map(c => c.high)),
        low: Math.min(...chunk.map(c => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((a, c) => a + (c.volume ?? 0), 0),
      });
    }
  }
  return out;
}

async function fetchOne(symbol) {
  const period1 = new Date();
  period1.setUTCDate(period1.getUTCDate() - LOOKBACK_DAYS);
  const res = await yf.chart(symbol, { period1, interval: '1h', includePrePost: false });
  const hourly = res.quotes
    .filter(q => q.close != null && q.open != null && q.high != null && q.low != null)
    .map(q => ({ date: q.date, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  return resampleTo4h(hourly);
}

// Simple fixed-size concurrency pool — matches fetch-universe.mjs's approach.
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
      if (done % 25 === 0 || done === items.length) console.log(`  ${done}/${items.length} symbols fetched`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return results;
}

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

console.log(`Fetching ${symbols.length} watchlist symbols, ~${LOOKBACK_DAYS}d of 1h bars resampled to 4H, into ${OUT_PATH}`);

const results = await runPool(symbols, fetchOne, CONCURRENCY);

let ok = 0, failed = [];
db.exec('BEGIN');
for (let i = 0; i < symbols.length; i++) {
  const symbol = symbols[i];
  const rows = results[i];
  if (!rows || rows.error || rows.length < 60) {
    failed.push(`${symbol}${rows?.error ? ` (${rows.error})` : ''}`);
    continue;
  }
  for (const row of rows) insert.run(symbol, row.date, row.open, row.high, row.low, row.close, row.volume);
  ok++;
}
db.exec('COMMIT');

console.log(`\nDone: ${ok} symbols stored, ${failed.length} failed/too-short.`);
if (failed.length) console.log('Failed:', failed.join(', '));

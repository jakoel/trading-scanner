/**
 * Persisted daily OHLCV history per symbol, stored in a single SQLite file
 * (data/bars.db) instead of one CSV per ticker. Each run fetches only the
 * bars missing since the last stored date (usually just the latest one)
 * instead of re-pulling full history every time.
 */
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import YahooFinance from 'yahoo-finance2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'bars.db');

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const BACKFILL_DAYS = 750; // ~500 trading days, matching the Pine script's max_bars_back
const RETENTION_ROWS = 400;
// Bars already stored are re-fetched this far back on every update, so a bar
// that was written while incomplete gets corrected instead of staying wrong
// forever (see lastClosedSessionDate below).
const REFETCH_DAYS = 10;

/** Wall-clock date and minute-of-day in US Eastern, for the given instant. */
function easternParts(d) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
    .formatToParts(d)
    .reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/**
 * The most recent date whose US regular session (09:30–16:00 ET) has finished.
 *
 * Yahoo starts building the daily candle from pre-market trades, so any bar
 * dated for a session that hasn't closed yet is partial — a pre-open run sees
 * roughly a tenth of the day's volume and a pre-market print for the close.
 * This scan is dispatched before the open (~15:00–16:00 Israel, while the US
 * opens at 16:30 Israel — or 15:30 during the few weeks a year when US DST is
 * in effect and Israel's is not), so it would otherwise store a partial bar on
 * every single run. Bars newer than this cutoff are discarded; the scan simply
 * reports on the last completed session, which is the intent of a pre-open run.
 *
 * Weekends and holidays need no special handling: no bar exists for a day the
 * market never opened, so the cutoff just never matches one.
 */
function lastClosedSessionDate(now = new Date()) {
  const { date, minutes } = easternParts(now);
  if (minutes >= 16 * 60) return date;
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

let db;
function getDb() {
  if (db) return db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bars (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      PRIMARY KEY (symbol, date)
    );
  `);
  return db;
}

async function fetchChart(symbol, period1) {
  const res = await yf.chart(symbol, { period1, interval: '1d' });
  return res.quotes
    .filter(q => q.close != null && q.open != null && q.high != null && q.low != null)
    .map(q => ({
      // Daily bars are timestamped at the 09:30 ET open, so the Eastern date is
      // the trading date — deriving it in UTC happens to agree, but only by luck.
      date: easternParts(q.date).date,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume ?? 0,
    }));
}

function getStoredRows(database, symbol) {
  return database
    .prepare('SELECT date, open, high, low, close, volume FROM bars WHERE symbol = ? ORDER BY date ASC')
    .all(symbol);
}

/**
 * Reads the persisted history for `symbol`, fetches only bars newer than what's
 * stored (or a full backfill if nothing is stored yet), upserts, trims to
 * RETENTION_ROWS, and returns the full up-to-date row array.
 */
export async function updateBars(symbol) {
  const database = getDb();
  const existing = getStoredRows(database, symbol);

  const lastDate = existing.length ? existing[existing.length - 1].date : null;
  const cutoff = lastClosedSessionDate();

  if (lastDate === cutoff) {
    return existing; // already holds the latest completed session
  }

  let period1;
  if (lastDate) {
    // Re-fetch a trailing window rather than starting after lastDate, so bars
    // written before their session closed are overwritten with final values.
    const d = new Date(lastDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - REFETCH_DAYS);
    period1 = d;
  } else {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - BACKFILL_DAYS);
    period1 = d;
  }

  // Drop anything from a session that hasn't closed yet — it would be partial.
  const fresh = (await fetchChart(symbol, period1)).filter(row => row.date <= cutoff);

  if (fresh.length) {
    const upsert = database.prepare(`
      INSERT INTO bars (symbol, date, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, date) DO UPDATE SET
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume
    `);
    database.exec('BEGIN');
    try {
      for (const row of fresh) {
        upsert.run(symbol, row.date, row.open, row.high, row.low, row.close, row.volume);
      }
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
  }

  // Trim to the most recent RETENTION_ROWS rows for this symbol.
  database
    .prepare(`
      DELETE FROM bars
      WHERE symbol = ? AND date NOT IN (
        SELECT date FROM bars WHERE symbol = ? ORDER BY date DESC LIMIT ?
      )
    `)
    .run(symbol, symbol, RETENTION_ROWS);

  return getStoredRows(database, symbol);
}

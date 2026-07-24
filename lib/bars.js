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

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
// Relative close mismatch on an overlapping bar that means Yahoo re-based the
// series (see isRebased). 2% clears float/vendor noise; the smallest split
// ratio in common use, 5:4, is 25%.
const REBASE_TOLERANCE = 0.02;

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

/**
 * True if Yahoo has re-based the symbol's price history since it was stored.
 *
 * A split makes Yahoo retroactively re-adjust every historical bar, so stored
 * bars stop sharing a price basis with newly fetched ones. Only the re-fetch
 * window gets rewritten, leaving the older majority of the series on the old
 * basis — a fake discontinuity that reads as a genuine crash rather than an
 * error (a 2:1 split inverts Trend, drops RSI from 43 to 20 and swings the MACD
 * line from +6.9 to -38.2, and would persist until the stale bars age out).
 *
 * The trailing re-fetch window overlaps what's already stored, which is exactly
 * what makes this detectable: a bar we already hold coming back at a materially
 * different close means the basis moved underneath us. The tolerance sits well
 * above float noise and well below the smallest split ratio in common use (5:4).
 */
function isRebased(existing, fresh) {
  const storedByDate = new Map(existing.map(r => [r.date, r]));
  for (const row of fresh) {
    const stored = storedByDate.get(row.date);
    if (!stored || !stored.close) continue;
    if (Math.abs(stored.close - row.close) / stored.close > REBASE_TOLERANCE) return true;
  }
  return false;
}

function getStoredRows(database, symbol) {
  return database
    .prepare('SELECT date, open, high, low, close, volume FROM bars WHERE symbol = ? ORDER BY date ASC')
    .all(symbol);
}

/**
 * Reads the persisted history for `symbol`, re-fetches a trailing window (or a
 * full backfill if nothing is stored yet, or if the series has been re-based),
 * upserts, trims to RETENTION_ROWS, and returns the full up-to-date row array.
 */
export async function updateBars(symbol) {
  const database = getDb();
  let existing = getStoredRows(database, symbol);

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
  let fresh = (await fetchChart(symbol, period1)).filter(row => row.date <= cutoff);

  // A re-based series can't be repaired by upserting the window: the bars
  // outside it are the ones now on the wrong basis. Discard and rebuild.
  if (existing.length && isRebased(existing, fresh)) {
    console.log(`  ${symbol} — price history re-based (likely a split); rebuilding from scratch`);
    database.prepare('DELETE FROM bars WHERE symbol = ?').run(symbol);
    existing = [];
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - BACKFILL_DAYS);
    fresh = (await fetchChart(symbol, d)).filter(row => row.date <= cutoff);
  }

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

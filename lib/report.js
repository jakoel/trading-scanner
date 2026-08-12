/**
 * Signal detection and Telegram formatting shared between the CDP-based scanner
 * (scan_watchlist.js) and the headless scanner (scan_headless.js). Both produce
 * the same shaped `results` entries; this module turns those into MACD signals
 * and the final Telegram message text.
 */

// Every crossover signal fires only on the bar the crossover actually happened
// on. These were 5, which kept one event alive for five consecutive reports:
// across the ten sessions to 2026-08-05, 65% of MACD TURNED GREEN lines and 47%
// of ATR RECLAIM lines were re-announcements of an event already sent on an
// earlier day (average green run: 2.78 days), and data/signals.csv logged the
// same event up to five times under different dates, which would skew any
// hit-rate research over that file. `signals.csv` is the record of what fired
// and when; the Telegram report is a feed of what happened today.
export const MACD_LOOKBACK_DAYS = 1;
export const ATR_LOOKBACK_DAYS = 1;
export const RSI_RECLAIM_LOOKBACK_DAYS = 1;
export const RSI_OVERSOLD_THRESHOLD = 30;
// 1.75, not the indicator's 1.5. Measured over 250 sessions x 91 symbols of
// stored bars (up-days only, the same filter detectVolumeSignals applies), 1.5
// printed a median of 4 lines a day but blew out to 11 at p90 and 45 on the
// worst day; 1.75 gives a median of 3 and a p90 of 7 while still firing on 85%
// of sessions. Raising further was rejected: 2.0 goes silent on a quarter of
// all days, which reads as a broken signal for a state check meant to show
// sustained buying. Independent of indicators.js `volumeSurgeMultiplier`,
// which stays at 1.5 to mirror the live Pine input.
export const VOLUME_SURGE_THRESHOLD = 1.75;

/**
 * Finds the most recent bar-to-bar transition from <=0 to >0 in `history`
 * (chronological, oldest first) within the last `lookback` trading days
 * (0 = today's bar). Returns how many days ago it happened, or null if none.
 */
export function findRecentUpCrossover(history, metric, lookback) {
  const n = history.length;
  const maxK = Math.min(lookback - 1, n - 2);
  for (let k = 0; k <= maxK; k++) {
    const cur = metric(history[n - 1 - k]);
    const prev = metric(history[n - 2 - k]);
    if (cur == null || prev == null) continue;
    if (cur > 0 && prev <= 0) return k;
  }
  return null;
}

/**
 * Given macdLineVal (today's MACD line) and macdHistory (chronological array of
 * {macd, hist}, oldest first, ending with today), returns the macdSignals array
 * used on each result entry.
 *
 * TURNED GREEN = histogram crossed up today *while the MACD line is still
 * negative* — the early-bottom case the section is named for. The gate matters:
 * ungated, the histogram crossing up in an already-positive name is ordinary
 * re-acceleration in an existing uptrend, and in a broad bounce it fires on
 * half the watchlist at once (47 of 91 symbols on 2026-08-05), which carries no
 * information beyond "the market went up". Those names are covered by TURNED
 * POSITIVE when their line actually crosses zero.
 *
 * TURNED POSITIVE = the MACD line itself crossed zero today *and* the histogram
 * is positive, i.e. the line is above its own signal line. The histogram gate
 * matters: the signal line is a lagging EMA of the MACD line, so after a sharp
 * drop-and-bounce the line can cross zero while still under a signal line
 * decaying down from the prior run (LLY on 2026-08-06: macd +1.94, signal 6.55,
 * hist -4.61) — recovering momentum, not confirmed momentum. Across the 536
 * zero-crosses in data/bars.db, the 56 with a non-positive histogram averaged
 * -0.49% over the next 10 sessions (39% win rate) against +2.50% (57%) for the
 * rest, so the section's "Confirmed" label only holds with the gate on.
 *
 * Independent of TURNED GREEN, and by construction the two can no longer fire
 * for the same symbol on the same day.
 */
export function detectMacdSignals(macdLineVal, macdHistory) {
  const macdSignals = [];
  let positiveCrossDaysAgo = null;
  let greenCrossDaysAgo = null;
  let todayHistVal = null;

  if (macdLineVal != null && macdHistory && macdHistory.length >= 2) {
    todayHistVal = macdHistory[macdHistory.length - 1].hist;
    positiveCrossDaysAgo = findRecentUpCrossover(macdHistory, b => b.macd, MACD_LOOKBACK_DAYS);
    greenCrossDaysAgo = findRecentUpCrossover(macdHistory, b => b.hist, MACD_LOOKBACK_DAYS);

    if (todayHistVal != null && todayHistVal > 0 && greenCrossDaysAgo !== null && macdLineVal < 0) {
      macdSignals.push('MACD TURNED GREEN');
    }
    if (macdLineVal > 0 && positiveCrossDaysAgo !== null && todayHistVal != null && todayHistVal > 0) {
      macdSignals.push('MACD TURNED POSITIVE');
    }
  }

  return { macdSignals, positiveCrossDaysAgo, greenCrossDaysAgo, todayHistVal };
}

/**
 * Given atrHistory (chronological array of {price, atr}, oldest first, ending
 * with today), returns how many trading days ago price crossed from at/below
 * the ATR Trailing Stop to above it — a real reclaim event, not just "currently
 * sitting close to the line" (which fires every day a stock happens to hover
 * near its own stop, whether it just crossed or has been there for weeks).
 * Returns null if no such crossover happened on today's bar (ATR_LOOKBACK_DAYS).
 */
export function detectAtrReclaim(atrHistory) {
  if (!atrHistory || atrHistory.length < 2) return null;
  return findRecentUpCrossover(atrHistory, b => b.price - b.atr, ATR_LOOKBACK_DAYS);
}

/**
 * Given rsiHistory (chronological array of {rsi}, oldest first, ending with
 * today), returns the rsiSignals array for a result entry. RSI RECLAIMED 30
 * fires only on the exact day RSI crosses back up through
 * RSI_OVERSOLD_THRESHOLD (today's bar, RSI_RECLAIM_LOOKBACK_DAYS = 1) — the
 * first day it pops out of oversold, not every day it happens to sit above
 * 30 afterward.
 */
export function detectRsiSignals(rsiHistory) {
  const rsiSignals = [];
  const reclaimDaysAgo = rsiHistory && rsiHistory.length >= 2
    ? findRecentUpCrossover(rsiHistory, b => b.rsi - RSI_OVERSOLD_THRESHOLD, RSI_RECLAIM_LOOKBACK_DAYS)
    : null;

  if (reclaimDaysAgo !== null) {
    rsiSignals.push('RSI RECLAIMED 30');
  }

  return { rsiSignals };
}

/**
 * Given today's volumeRatio (vs 20-day average, from lib/indicators.js) and
 * prevPrice (prior bar's close), returns the volumeSignals array. VOLUME
 * SURGE is a state check, not an event: it fires every day volume stays at
 * or above VOLUME_SURGE_THRESHOLD on an up day (price > prevPrice) — unlike
 * the crossover-based signals, sustained high-volume buying is itself
 * noteworthy each day it continues, not just the first day.
 */
export function detectVolumeSignals({ volumeRatio, price, prevPrice }) {
  const volumeSignals = [];
  const isUpDay = prevPrice != null && price > prevPrice;

  if (volumeRatio != null && volumeRatio >= VOLUME_SURGE_THRESHOLD && isUpDay) {
    volumeSignals.push('VOLUME SURGE');
  }

  return { volumeSignals };
}

/**
 * Generate a short rule-based summary — only noteworthy signals.
 *
 * Deliberately ignores the indicator's Momentum and Volume cells. This used to
 * carry `momentum === 'FADING'` → "momentum fading" and `volume.includes('HIGH')`
 * → "high volume", neither of which could ever match: indicatorSuite.txt emits
 * ACCELERATING/DECELERATING/STABLE for Momentum ('FADING' appears only in its
 * Warning cell) and SURGE/ABOVE AVG/LOW/AVERAGE for Volume. Confirmed dead
 * across all 36,341 bars in data/bars.db. Repairing rather than deleting them
 * would have been the wrong call — DECELERATING covers 20 of 91 symbols on a
 * typical bar, and volume surges already have their own report section.
 */
export function generateSummary(data) {
  const { price, atr, ema200, rsi, trend, htfTrend, divergence } = data;
  const parts = [];

  const rsiNum = parseFloat(rsi);
  if (!isNaN(rsiNum)) {
    if (rsiNum < 30) parts.push('RSI oversold');
    else if (rsiNum < 40) parts.push('RSI near oversold');
    else if (rsiNum > 70) parts.push('RSI overbought');
    else if (rsiNum > 60) parts.push('RSI elevated');
  }

  if (trend !== htfTrend) parts.push(`mixed trend (${trend}/${htfTrend})`);
  if (divergence && divergence !== 'NONE') parts.push(`${divergence} divergence`);

  const aboveAtr = price > atr;
  const atrPct = ((price - atr) / atr * 100);
  if (aboveAtr && atrPct < 3) parts.push('just reclaimed ATR');
  else if (!aboveAtr && atrPct > -3) parts.push('close to ATR flip');

  if (ema200 && price > ema200) parts.push('above EMA200');

  return parts.length ? parts.join(', ') : 'no notable signals';
}

/**
 * A real reclaim event (price crossed above the ATR Trailing Stop within the
 * on today's bar), not just "currently sitting close to the line" —
 * same state-vs-event fix already applied to the MACD signals. Named for what
 * actually happened (a trend-continuation reclaim with bullish confluence),
 * not "buy" — the condition alone is not a trade recommendation.
 */
export function isAtrReclaim(r) {
  return r.atrReclaimDaysAgo != null &&
    r.price > r.atr &&
    r.ema200 && r.price > r.ema200 &&
    r.htfTrend === 'BULLISH';
}

/** All signal names actively firing for a result entry, e.g. for logging. */
export function getActiveSignals(r) {
  const signals = [];
  if (isAtrReclaim(r)) signals.push('ATR RECLAIM');
  signals.push(...r.macdSignals);
  signals.push(...r.rsiSignals);
  signals.push(...r.volumeSignals);
  return signals;
}

/**
 * Short sector labels for the ETFs on the watchlist.
 *
 * A ticker like BOTZ or COPX tells a reader nothing unless they already hold
 * it, so every line the report prints for one gets tagged with what it
 * actually tracks. Individual stocks are deliberately left unlabelled — their
 * tickers are the company names, and tagging all 81 would bury the signal.
 *
 * Labels must avoid Telegram's legacy-Markdown metacharacters (`*`, `_`, `` ` ``
 * and `[`) — an unpaired one breaks parsing for the whole message, and the send
 * fails rather than degrading. Plain words and `&` are safe.
 */
export const SECTOR_LABELS = {
  BOTZ: 'Robotics & Automation ETF',
  CIBR: 'Cybersecurity ETF',
  QTUM: 'Quantum Computing ETF',
  URA: 'Uranium Miners ETF',
  GRID: 'Grid & Electrification ETF',
  COPX: 'Copper Miners ETF',
  TAN: 'Solar Energy ETF',
  XBI: 'Biotech ETF',
  ITA: 'Aerospace & Defense ETF',
  GDX: 'Gold Miners ETF',
  ETHA: 'Spot Ethereum ETF',
};

/** Trailing ' · sector' tag for a symbol, or '' for anything unlabelled. */
function sectorTag(symbol) {
  const label = SECTOR_LABELS[symbol];
  return label ? ` · ${label}` : '';
}

/** Format Telegram messages, splitting into chunks under 4000 chars */
export function formatTelegramMessages(results) {
  // Sections list symbols alphabetically rather than in watchlist order, so a
  // symbol sits in the same place from one day's message to the next. Compared
  // by code unit rather than localeCompare, whose collation of the '-' in
  // tickers like BRK-B can differ between the CI runner and a local machine.
  const sorted = [...results].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const buys = sorted.filter(isAtrReclaim);

  // No distance-to-stop figure here. It used to print (price - atr) / atr as a
  // percentage, which reads like performance but measures nothing of the kind:
  // the ATR Trailing Stop resets to `low - 3 * ATR(10)` on the very bar a
  // reclaim fires, so the gap is always a fresh, full stop-width and the number
  // is just a readout of how wide the symbol's ATR band is. On 2026-08-05 MRVL
  // printed +37.0% against GDX's +16.3% purely because MRVL is more volatile —
  // and MRVL actually closed down 3.5% that day.
  function formatStock(r) {
    return `*${r.symbol}* $${r.price}${sectorTag(r.symbol)}\n  _${r.summary}_`;
  }

  const macdGreenCount = results.filter(r => r.macdSignals.includes('MACD TURNED GREEN')).length;
  const macdPositiveCount = results.filter(r => r.macdSignals.includes('MACD TURNED POSITIVE')).length;
  const rsiReclaimCount = results.filter(r => r.rsiSignals.includes('RSI RECLAIMED 30')).length;
  const volumeSurgeCount = results.filter(r => r.volumeSignals.includes('VOLUME SURGE')).length;

  const sections = [];
  if (buys.length) sections.push({ title: '🎯 ATR Reclaim (Bullish Confluence)', items: buys });

  if (!sections.length && !macdGreenCount && !macdPositiveCount && !rsiReclaimCount && !volumeSurgeCount) return [];

  const messages = [];
  let current = '';

  for (const sec of sections) {
    let secText = `\n*${sec.title}:*\n`;
    for (const r of sec.items) {
      secText += formatStock(r) + '\n';
    }
    if ((current + secText).length > 3800) {
      messages.push(current.trim());
      current = secText;
    } else {
      current += secText;
    }
  }

  const macdGreen = sorted.filter(r => r.macdSignals.includes('MACD TURNED GREEN'));
  const macdPositive = sorted.filter(r => r.macdSignals.includes('MACD TURNED POSITIVE'));
  const rsiReclaim = sorted.filter(r => r.rsiSignals.includes('RSI RECLAIMED 30'));
  const volumeSurge = sorted.filter(r => r.volumeSignals.includes('VOLUME SURGE'));

  const detailFormatters = {
    rsi: r => `*${r.symbol}* $${r.price} (RSI ${r.rsi})${sectorTag(r.symbol)}\n`,
    volume: r => `*${r.symbol}* $${r.price} (${r.volumeRatio.toFixed(2)}x avg vol)${sectorTag(r.symbol)}\n`,
  };

  // Volume Surge sits directly under ATR Reclaim, ahead of the MACD sections.
  for (const [title, items, detail] of [
    ['📊 Volume Surge', volumeSurge, 'volume'],
    ['⚡ MACD Turned Positive (Confirmed Positive Momentum)', macdPositive, null],
    ['⚡ MACD Turned Green (Early Bottom, MACD Still Negative)', macdGreen, null],
    ['📈 RSI Reclaimed 30 (Out of Oversold)', rsiReclaim, 'rsi'],
  ]) {
    if (!items.length) continue;
    let secText = `\n${title}:\n`;
    for (const r of items) {
      secText += detail ? detailFormatters[detail](r) : `*${r.symbol}* $${r.price}${sectorTag(r.symbol)}\n`;
    }
    if ((current + secText).length > 3800) {
      messages.push(current.trim());
      current = secText;
    } else {
      current += secText;
    }
  }

  messages.push(current.trim());

  return messages;
}

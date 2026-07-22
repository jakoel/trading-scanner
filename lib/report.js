/**
 * Signal detection and Telegram formatting shared between the CDP-based scanner
 * (scan_watchlist.js) and the headless scanner (scan_headless.js). Both produce
 * the same shaped `results` entries; this module turns those into MACD signals
 * and the final Telegram message text.
 */

export const MACD_LOOKBACK_DAYS = 5;
export const ATR_LOOKBACK_DAYS = 5;
export const RSI_RECLAIM_LOOKBACK_DAYS = 1;
export const RSI_OVERSOLD_THRESHOLD = 30;

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
 * used on each result entry. See scan_watchlist.js for the full rationale:
 * TURNED GREEN = histogram crossed up recently, independent of MACD line sign;
 * TURNED POSITIVE = MACD line itself crossed zero recently. Both independent.
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

    if (todayHistVal != null && todayHistVal > 0 && greenCrossDaysAgo !== null) {
      macdSignals.push('MACD TURNED GREEN');
    }
    if (macdLineVal > 0 && positiveCrossDaysAgo !== null) {
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
 * Returns null if no such crossover happened within ATR_LOOKBACK_DAYS.
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

  return { rsiSignals, reclaimDaysAgo };
}

/** Generate a short rule-based summary — only noteworthy signals */
export function generateSummary(data) {
  const { price, atr, ema200, rsi, trend, htfTrend, momentum, divergence, volume } = data;
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
  if (momentum === 'FADING') parts.push('momentum fading');
  if (volume && volume.includes('HIGH')) parts.push('high volume');

  const aboveAtr = price > atr;
  const atrPct = ((price - atr) / atr * 100);
  if (aboveAtr && atrPct < 3) parts.push('just reclaimed ATR');
  else if (!aboveAtr && atrPct > -3) parts.push('close to ATR flip');

  if (ema200 && price > ema200) parts.push('above EMA200');

  return parts.length ? parts.join(', ') : 'no notable signals';
}

/**
 * A real reclaim event (price crossed above the ATR Trailing Stop within the
 * last ATR_LOOKBACK_DAYS), not just "currently sitting close to the line" —
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
  return signals;
}

/** Format Telegram messages, splitting into chunks under 4000 chars */
export function formatTelegramMessages(results) {
  const buys = results.filter(isAtrReclaim);

  function formatStock(r) {
    const pct = ((r.price - r.atr) / r.atr * 100).toFixed(1);
    const sign = r.price > r.atr ? '+' : '';
    return `*${r.symbol}* $${r.price} (${sign}${pct}%)\n  _${r.summary}_`;
  }

  const macdGreenCount = results.filter(r => r.macdSignals.includes('MACD TURNED GREEN')).length;
  const macdPositiveCount = results.filter(r => r.macdSignals.includes('MACD TURNED POSITIVE')).length;
  const rsiReclaimCount = results.filter(r => r.rsiSignals.includes('RSI RECLAIMED 30')).length;

  const sections = [];
  if (buys.length) sections.push({ title: '🎯 ATR Reclaim (Bullish Confluence)', items: buys });

  if (!sections.length && !macdGreenCount && !macdPositiveCount && !rsiReclaimCount) return [];

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

  const macdGreen = results.filter(r => r.macdSignals.includes('MACD TURNED GREEN'));
  const macdPositive = results.filter(r => r.macdSignals.includes('MACD TURNED POSITIVE'));
  const rsiReclaim = results.filter(r => r.rsiSignals.includes('RSI RECLAIMED 30'));

  for (const [title, items, showRsi] of [
    ['⚡ MACD Turned Positive (Confirmed Positive Momentum)', macdPositive, false],
    ['⚡ MACD Turned Green (Possible Bottom / Momentum Shift)', macdGreen, false],
    ['📈 RSI Reclaimed 30 (Out of Oversold)', rsiReclaim, true],
  ]) {
    if (!items.length) continue;
    let secText = `\n${title}:\n`;
    for (const r of items) {
      secText += showRsi ? `*${r.symbol}* $${r.price} (RSI ${r.rsi})\n` : `*${r.symbol}* $${r.price}\n`;
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

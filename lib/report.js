/**
 * Signal detection and Telegram formatting shared between the CDP-based scanner
 * (scan_watchlist.js) and the headless scanner (scan_headless.js). Both produce
 * the same shaped `results` entries; this module turns those into MACD signals
 * and the final Telegram message text.
 */
// Imported (and re-exported below) so scan_headless.js/scan_watchlist.js can
// import every detectX function from this one module, same as the MACD/RSI/
// volume detectors below — and so detectFvgSignals is usable locally, by
// detectFvgRsiConfluence() further down.
import { detectFvgSignals, detectVwapSignals } from './fairValue.js';
export { detectFvgSignals, detectVwapSignals };

// Every crossover signal fires only on the bar the crossover actually happened
// on. These were 5, which kept one event alive for five consecutive reports:
// across the ten sessions to 2026-08-05, 65% of MACD TURNED GREEN lines and 47%
// of ATR RECLAIM lines were re-announcements of an event already sent on an
// earlier day (average green run: 2.78 days), and data/signals.csv logged the
// same event up to five times under different dates, which would skew any
// hit-rate research over that file. `signals.csv` is the record of what fired
// and when; the Telegram report is a feed of what happened today.
export const MACD_LOOKBACK_DAYS = 1;
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
// RSI RECLAIMED 30 reverses in choppy/range-bound conditions rather than just
// weakening: recomputing indicators.js over the full bars.db history and
// splitting the 469 reclaims on ADX at cross time, the 103 with ADX < 20
// averaged -3.39% at 10 sessions (32% win) and -6.55% at 20 (22% win) — a
// fakeout more often than not — against +2.02% (58% win) and +5.01% (64%
// win) for the 362 with ADX >= 20. 20 is indicators.js's own adxThreshold
// (DEFAULTS.adxThreshold), reused here rather than a new arbitrary cutoff.
// MACD TURNED GREEN shows the same direction (ADX>=20 outperforms) but stays
// net positive even below the threshold (+2.32%/53% win at 10d, n=361), so
// it isn't gated here — only a signal that goes negative earns suppression.
export const RSI_RECLAIM_MIN_ADX = 20;
// Bullish divergence (indicators.js's own pivot-confirmed divergence flag,
// previously never wired into any signal) paired with ADX >= 20. Found by
// running the brute-force combo search in research/ against a much larger
// cross-section (all 503 S&P 500 symbols, 200 trading days each, fetched
// 2026-09-22 into research/universe.db — separate from data/bars.db) rather
// than just the ~104-symbol watchlist: n=157 at 20 sessions, +4.05%/71% win,
// n=144 at 30 (+5.68%/70% win) — beating both legs alone (bullish div alone:
// 61% win; ADX>=20 alone: 51%) and, unlike most combos found this session,
// getting *stronger* in the more recent half of history (67%->71% at 20d),
// not weaker. Same value as RSI_RECLAIM_MIN_ADX by coincidence, not reuse —
// this came from an independent dataset and gets its own constant.
export const BULLISH_DIV_MIN_ADX = 20;
// MACD TURNED POSITIVE is a lagging confirmation — by the time the line
// crosses zero, price has usually already reclaimed its ATR Trailing Stop
// days or weeks earlier. Recomputing indicators.js over the full bars.db
// history for the 26 TURNED POSITIVE events since 2026-08-20 and splitting on
// (price - atrTrailingStop) / atrTrailingStop at cross time: the 12 nearest
// their stop (an early/fresh move) averaged +0.05% at 5 sessions (56% win),
// while the 12 furthest (an already-extended move, gap up to 37%) averaged
// -5.52% (30% win) at 5 sessions and -4.40% (20% win) at 10. The split held
// in both directions and both horizons on a small sample — treat 15 as
// provisional, not tuned.
export const MACD_POSITIVE_MAX_ATR_EXTENSION_PCT = 15;
// RSI >= 70 (state) paired with a rolling-20-day VWAP reclaim — a momentum-
// continuation read, not an oversold bounce: price is already strong AND
// just broke back above its volume-weighted "fair value" line after a dip.
// Windowed brute-force search (+/-3 trading days, same symbol) across four
// independent datasets at 5 sessions: n=144 watchlist (63% win), n=56
// Nasdaq-100 (63% win), n=93 combined watchlist+QQQ (63% win) — remarkably
// consistent. Not the indicator's own RSI_OVERBOUGHT (70) constant elsewhere
// in the codebase; this is report.js's own threshold for this specific combo.
export const VWAP_RSI_OVERBOUGHT_THRESHOLD = 70;
// Bullish FVG Retest + RSI Reclaimed 30 was validated with a +/-3 trading day
// windowed match (research/brute-force.mjs's methodology: nearest occurrence
// within the window counts, anchored on the later one) — but the first ship
// of this combo only ever checked same-day co-occurrence, since a live daily
// scan only has "today" to compare against itself. Checked directly: that
// same-day version fires 0-8 times across four datasets' entire history,
// against hundreds of days each — it doesn't reflect what was validated and
// barely fires at all. detectFvgRsiConfluence() below fixes this: a live
// scan can only ever anchor on today (no future bars to look ahead to), so
// it fires when today hosts one of the two signals and the other fired
// within the last FVG_RSI_COMBO_WINDOW trading days (today included).
export const FVG_RSI_COMBO_WINDOW = 3;
// ADX >= 25 markedly improves MACD TURNED POSITIVE (on top of the extension
// gate above) and is one of the few filters this session that held up
// consistently across a chronological split: recomputing over full bars.db
// history, the already-extension-gated crosses go from n=437 (30d +9.06%/64%
// win) to n=43 with ADX >= 25 (30d +11.12%/79% win) — and unlike most other
// combos tested, the two halves of history barely diverge (77% vs 81% win at
// 30d), not one regime carrying the number. Also used, at the same threshold,
// to gate the MACD Green + Strong Trend confluence section below — the same
// underlying relationship (MACD momentum + ADX >= 25) showed up independently
// for both TURNED GREEN and TURNED POSITIVE, so one constant covers both.
export const MACD_STRONG_TREND_ADX = 25;

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
 *
 * TURNED POSITIVE additionally requires price not be too extended above its
 * ATR Trailing Stop (MACD_POSITIVE_MAX_ATR_EXTENSION_PCT) and ADX >=
 * MACD_STRONG_TREND_ADX — see both constants above. `adx` is optional: the
 * legacy CDP scanner doesn't scrape it, and a missing value doesn't suppress
 * the signal there.
 */
export function detectMacdSignals(macdLineVal, macdHistory, { price, atrTrailingStop, adx } = {}) {
  const macdSignals = [];
  let positiveCrossDaysAgo = null;
  let greenCrossDaysAgo = null;
  let todayHistVal = null;

  const atrExtensionPct = price != null && atrTrailingStop
    ? (price - atrTrailingStop) / atrTrailingStop * 100
    : null;
  const tooExtended = atrExtensionPct != null && atrExtensionPct > MACD_POSITIVE_MAX_ATR_EXTENSION_PCT;
  const weakTrend = adx != null && adx < MACD_STRONG_TREND_ADX;

  if (macdLineVal != null && macdHistory && macdHistory.length >= 2) {
    todayHistVal = macdHistory[macdHistory.length - 1].hist;
    positiveCrossDaysAgo = findRecentUpCrossover(macdHistory, b => b.macd, MACD_LOOKBACK_DAYS);
    greenCrossDaysAgo = findRecentUpCrossover(macdHistory, b => b.hist, MACD_LOOKBACK_DAYS);

    if (todayHistVal != null && todayHistVal > 0 && greenCrossDaysAgo !== null && macdLineVal < 0) {
      macdSignals.push('MACD TURNED GREEN');
    }
    if (macdLineVal > 0 && positiveCrossDaysAgo !== null && todayHistVal != null && todayHistVal > 0 && !tooExtended && !weakTrend) {
      macdSignals.push('MACD TURNED POSITIVE');
    }
  }

  return { macdSignals, positiveCrossDaysAgo, greenCrossDaysAgo, todayHistVal };
}

/**
 * Given rsiHistory (chronological array of {rsi}, oldest first, ending with
 * today), returns the rsiSignals array for a result entry. RSI RECLAIMED 30
 * fires only on the exact day RSI crosses back up through
 * RSI_OVERSOLD_THRESHOLD (today's bar, RSI_RECLAIM_LOOKBACK_DAYS = 1) — the
 * first day it pops out of oversold, not every day it happens to sit above
 * 30 afterward.
 *
 * Also requires ADX >= RSI_RECLAIM_MIN_ADX (today's bar) — see the constant
 * above. `adx` is optional: the legacy CDP scanner doesn't scrape it, and a
 * missing value doesn't suppress the signal there.
 */
export function detectRsiSignals(rsiHistory, { adx } = {}) {
  const rsiSignals = [];
  const reclaimDaysAgo = rsiHistory && rsiHistory.length >= 2
    ? findRecentUpCrossover(rsiHistory, b => b.rsi - RSI_OVERSOLD_THRESHOLD, RSI_RECLAIM_LOOKBACK_DAYS)
    : null;
  const choppy = adx != null && adx < RSI_RECLAIM_MIN_ADX;

  if (reclaimDaysAgo !== null && !choppy) {
    rsiSignals.push('RSI RECLAIMED 30');
  }

  return { rsiSignals };
}

/**
 * Given raw `bars` (for FVG) and indicator `rows` (for RSI/ADX), returns
 * whether the Bullish FVG Retest + RSI Reclaimed 30 confluence fires on
 * today's bar (index `i`, normally rows.length - 1) — see
 * FVG_RSI_COMBO_WINDOW above for why this exists and how it differs from a
 * same-day-only check. Recomputes both underlying conditions directly off
 * `rows`/`bars` for each day in the window, rather than reusing
 * detectRsiSignals()/detectFvgSignals() in a loop, since those expect a
 * rolling-history shape built for a single "today" check, not a multi-day
 * scan.
 */
export function detectFvgRsiConfluence(bars, rows, i) {
  const rsiReclaimedAt = (k) => {
    if (k < 1) return false;
    const cur = rows[k], prev = rows[k - 1];
    const raw = cur.rsi != null && prev.rsi != null && prev.rsi <= RSI_OVERSOLD_THRESHOLD && cur.rsi > RSI_OVERSOLD_THRESHOLD;
    const choppy = cur.adx != null && cur.adx < RSI_RECLAIM_MIN_ADX;
    return raw && !choppy;
  };
  const fvgRetestAt = (k) => k >= 2 && detectFvgSignals(bars, k).fvgSignals.includes('BULLISH FVG RETEST');

  if (!fvgRetestAt(i) && !rsiReclaimedAt(i)) return false; // today must host at least one

  const windowStart = Math.max(0, i - FVG_RSI_COMBO_WINDOW);
  let rsiRecent = false, fvgRecent = false;
  for (let k = windowStart; k <= i; k++) {
    if (rsiReclaimedAt(k)) rsiRecent = true;
    if (fvgRetestAt(k)) fvgRecent = true;
  }
  return (fvgRetestAt(i) && rsiRecent) || (rsiReclaimedAt(i) && fvgRecent);
}

/**
 * Given today's `divergence` (indicators.js's row.divergence: 'BULLISH DIV',
 * 'BEARISH DIV', or 'NONE' — already pivot-confirmed on this exact bar, no
 * separate crossover check needed) and `adx`, returns the divergenceSignals
 * array. See BULLISH_DIV_MIN_ADX above for the backtest behind the gate.
 * `adx` is optional: the legacy CDP scanner doesn't scrape it, so this always
 * returns empty there rather than firing ungated.
 */
export function detectDivergenceSignals(divergence, adx) {
  const divergenceSignals = [];
  if (divergence === 'BULLISH DIV' && adx != null && adx >= BULLISH_DIV_MIN_ADX) {
    divergenceSignals.push('BULLISH DIVERGENCE (Strong Trend)');
  }
  return { divergenceSignals };
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

/** All signal names actively firing for a result entry, e.g. for logging. */
export function getActiveSignals(r) {
  const signals = [];
  signals.push(...r.macdSignals);
  signals.push(...r.rsiSignals);
  signals.push(...r.volumeSignals);
  signals.push(...r.divergenceSignals);
  signals.push(...r.fvgSignals);
  signals.push(...r.vwapSignals);
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

  // Same-day MACD TURNED GREEN + ADX >= MACD_STRONG_TREND_ADX (25) — see the
  // constant above for the backtest. n=299-301 across horizons, 10d +4.62%/70%
  // win, 30d +9.98%/70% win — the largest-sample combo this session found,
  // though (unlike the ADX gate on TURNED POSITIVE) it does show real
  // regime skew between history's two halves, so treat the win rate as
  // "clearly better than MACD Green alone" rather than a precise number.
  const comboGreenAdx = sorted.filter(r =>
    r.macdSignals.includes('MACD TURNED GREEN') && r.adx != null && r.adx >= MACD_STRONG_TREND_ADX);

  // Bullish FVG Retest + RSI Reclaimed 30, +/-FVG_RSI_COMBO_WINDOW trading
  // day windowed match — `r.fvgRsiConfluence` is precomputed per symbol in
  // scan_headless.js by detectFvgRsiConfluence(), since it needs the raw
  // bars/rows history, not just today's signal arrays. See
  // FVG_RSI_COMBO_WINDOW above for why this replaced a same-day-only check
  // that barely ever fired, and the FVG_DISPLACEMENT_ATR_MULT comment in
  // lib/fairValue.js for the retest logic's own backtest and caveats.
  const comboFvgRsi = sorted.filter(r => r.fvgRsiConfluence);

  // MACD TURNED GREEN + RSI RECLAIMED 30, same windowed match. n=124
  // watchlist (65% win at 10d, 67% at 30d), n=62 Nasdaq-100 (63%/59%), n=104
  // combined (62%/57%) — smaller than the FVG combo above but validated on
  // three datasets too (not the full S&P 500 this time).
  const comboGreenRsi = sorted.filter(r =>
    r.macdSignals.includes('MACD TURNED GREEN') && r.rsiSignals.includes('RSI RECLAIMED 30'));

  // RSI overbought (state, not an event) + VWAP Reclaim — see
  // VWAP_RSI_OVERBOUGHT_THRESHOLD above for the backtest. A momentum-
  // continuation read: strength confirming strength, not an oversold bounce
  // like the other sections here.
  const comboVwapOverbought = sorted.filter(r =>
    r.vwapSignals.includes('VWAP RECLAIM') && r.rsiNum != null && r.rsiNum >= VWAP_RSI_OVERBOUGHT_THRESHOLD);

  function formatStock(r) {
    return `*${r.symbol}* $${r.price}${sectorTag(r.symbol)}\n  _${r.summary}_`;
  }

  // No standalone MACD Turned Green section — it only surfaces via combos.
  // Bullish Divergence + Strong Trend has no display anywhere at all as of
  // 2026-09-22 — see "Removed" below for why. RSI Reclaimed 30 has no
  // standalone section either, but (as of the fair-value combos above) it's
  // back to surfacing via two combos, having previously surfaced via none.
  // detectMacdSignals()/detectRsiSignals()/detectDivergenceSignals() still
  // tag every occurrence of all of these for data/signals.csv research logging.
  const macdPositiveCount = results.filter(r => r.macdSignals.includes('MACD TURNED POSITIVE')).length;
  const volumeSurgeCount = results.filter(r => r.volumeSignals.includes('VOLUME SURGE')).length;

  const sections = [];
  if (comboFvgRsi.length) sections.push({ title: '🔥 Bullish FVG Retest + RSI Reclaim (Confluence)', items: comboFvgRsi });
  if (comboGreenAdx.length) sections.push({ title: '🔥 MACD Green + Strong Trend (Confluence)', items: comboGreenAdx });
  if (comboGreenRsi.length) sections.push({ title: '🔥 MACD Green + RSI Reclaim (Confluence)', items: comboGreenRsi });
  if (comboVwapOverbought.length) sections.push({ title: '🔥 RSI Overbought + VWAP Reclaim (Momentum Continuation)', items: comboVwapOverbought });

  if (!sections.length && !macdPositiveCount && !volumeSurgeCount) return [];

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

  const macdPositive = sorted.filter(r => r.macdSignals.includes('MACD TURNED POSITIVE'));
  const volumeSurge = sorted.filter(r => r.volumeSignals.includes('VOLUME SURGE'));

  const detailFormatters = {
    volume: r => `*${r.symbol}* $${r.price} (${r.volumeRatio.toFixed(2)}x avg vol)${sectorTag(r.symbol)}\n`,
  };

  // Volume Surge sits directly under the confluence sections, ahead of MACD Positive.
  for (const [title, items, detail] of [
    ['📊 Volume Surge', volumeSurge, 'volume'],
    ['⚡ MACD Turned Positive (Confirmed Positive Momentum)', macdPositive, null],
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

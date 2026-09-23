/**
 * "Fair value" family — price-imbalance and volume-weighted signals that
 * aren't part of lib/indicators.js (which ports a single MACD/RSI indicator).
 * Pure functions over raw OHLCV `bars` (the same array passed into
 * computeIndicators()), independent of it.
 *
 * Both scan_headless.js (via lib/report.js) and research/features.mjs import
 * from here — one implementation, so research and production can never drift
 * the way MACD/RSI signal detection already doesn't (see lib/report.js).
 */

// ─── Fair Value Gap ──────────────────────────────────────────────────────────

// True range / a simple rolling-mean ATR(14) — not Wilder's RMA, which
// lib/indicators.js uses for its own, differently-purposed ATR(10) feeding
// the trailing stop. Deliberately kept separate and cheap (O(length) per
// call): a "was this candle unusually large" filter doesn't need Wilder's
// more precise smoothing, and this file stays independent of indicators.js
// by design (see the file header). Matches the Pine reference's atrLen=14.
const FVG_DISPLACEMENT_ATR_LENGTH = 14;

function trueRange(bars, i) {
  if (i === 0) return bars[0].high - bars[0].low;
  const prevClose = bars[i - 1].close;
  return Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
}

function rollingAtr(bars, i, length = FVG_DISPLACEMENT_ATR_LENGTH) {
  if (i < length - 1) return null;
  let sum = 0;
  for (let k = i - length + 1; k <= i; k++) sum += trueRange(bars, k);
  return sum / length;
}

// Displacement filter: require the middle (impulse) candle's body to be at
// least this many multiples of its own rolling ATR(14) — filters out gaps
// formed by insignificant candles, keeping only ones backed by a genuinely
// large move. Windowed backtest (+/-3 trading days, research/brute-force.mjs
// methodology) on the Bullish FVG Retest + RSI Reclaim combo: watchlist 10d
// win 41%->76% (n=227->33), 30d 53%->79% (n=227->33) with the filter on. But
// it made the S&P 500 result *worse*, not better (10d 62%->52%, 30d
// 43%->34%, n=249->44) — the same "strong on the watchlist, weak on the
// broader market" pattern that already got Bullish Divergence removed once
// today. Shipped anyway on explicit instruction, not because the
// cross-dataset evidence supports it — see architecture.md.
export const FVG_DISPLACEMENT_ATR_MULT = 1.0;

// Ported from LuxAlgo's public "Fair Value Gap [LuxAlgo]" Pine indicator
// (threshold=0, its default). A bullish FVG at bar i is a 3-candle
// imbalance: today's low sits entirely above the high from 2 bars ago, AND
// the middle candle's close confirms it (not just a wick) — Pine's
// `close[1] > high[2]`. The gap zone is [high[i-2], low[i]]. `dispMult`
// defaults to FVG_DISPLACEMENT_ATR_MULT; pass 0 to disable the filter.
export function bullishFvg(bars, i, { dispMult = FVG_DISPLACEMENT_ATR_MULT } = {}) {
  if (i < 2) return null;
  const cur = bars[i], mid = bars[i - 1], old = bars[i - 2];
  if (!(cur.low > old.high && mid.close > old.high)) return null;
  if (dispMult > 0) {
    const atr = rollingAtr(bars, i - 1);
    if (atr == null || Math.abs(mid.close - mid.open) < atr * dispMult) return null;
  }
  return { top: cur.low, bottom: old.high };
}

export const FVG_RETEST_LOOKBACK = 15;

/**
 * Given raw `bars` and today's index `i`, returns the fvgSignals array.
 * BULLISH FVG FORMED fires the bar a gap forms. BULLISH FVG RETEST fires the
 * bar price dips back into any still-unfilled bullish FVG zone (formed
 * within FVG_RETEST_LOOKBACK bars) and closes back above its bottom — the
 * actual ICT/SMC entry, not just the imbalance itself. A zone is "mitigated"
 * (voided) the first time a close falls below its bottom, matching LuxAlgo's
 * own mitigation rule. Checks every unmitigated zone in the lookback window,
 * not just the nearest one — a nearer zone being mitigated doesn't make an
 * older, still-open zone stale too.
 */
export function detectFvgSignals(bars, i) {
  const fvgSignals = [];
  if (bullishFvg(bars, i)) fvgSignals.push('BULLISH FVG FORMED');

  for (let j = i - 1; j >= Math.max(2, i - FVG_RETEST_LOOKBACK); j--) {
    const zone = bullishFvg(bars, j);
    if (!zone) continue;
    let mitigated = false;
    for (let k = j + 1; k < i; k++) {
      if (bars[k].close < zone.bottom) { mitigated = true; break; }
    }
    if (mitigated) continue; // this zone is stale, but an older one might not be
    if (bars[i].low <= zone.top && bars[i].close > zone.bottom) {
      fvgSignals.push('BULLISH FVG RETEST');
      break; // found a retest against some open zone — that's enough
    }
  }

  return { fvgSignals };
}

// ─── Rolling VWAP ────────────────────────────────────────────────────────────

// A true intraday VWAP needs tick/volume data we don't have; this is the
// daily-bar equivalent used the same way — a volume-weighted "fair value"
// anchor over a trailing window, not just a plain moving average.
export const VWAP_LENGTH = 20;

export function rollingVwap(bars, i, length = VWAP_LENGTH) {
  if (i < length - 1) return null;
  const window = bars.slice(i - length + 1, i + 1);
  let pv = 0, v = 0;
  for (const bar of window) { pv += bar.close * bar.volume; v += bar.volume; }
  return v > 0 ? pv / v : null;
}

/** VWAP RECLAIM fires the bar price crosses back above its rolling 20-day VWAP. */
export function detectVwapSignals(bars, i) {
  const vwapSignals = [];
  if (i >= VWAP_LENGTH) {
    const vwapNow = rollingVwap(bars, i), vwapPrev = rollingVwap(bars, i - 1);
    if (vwapNow != null && vwapPrev != null && bars[i - 1].close <= vwapPrev && bars[i].close > vwapNow) {
      vwapSignals.push('VWAP RECLAIM');
    }
  }
  return { vwapSignals };
}

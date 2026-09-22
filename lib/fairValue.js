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

// Ported from LuxAlgo's public "Fair Value Gap [LuxAlgo]" Pine indicator
// (threshold=0, its default). A bullish FVG at bar i is a 3-candle
// imbalance: today's low sits entirely above the high from 2 bars ago, AND
// the middle candle's close confirms it (not just a wick) — Pine's
// `close[1] > high[2]`. The gap zone is [high[i-2], low[i]].
export function bullishFvg(bars, i) {
  if (i < 2) return null;
  const cur = bars[i], mid = bars[i - 1], old = bars[i - 2];
  if (cur.low > old.high && mid.close > old.high) {
    return { top: cur.low, bottom: old.high };
  }
  return null;
}

export const FVG_RETEST_LOOKBACK = 15;

/**
 * Given raw `bars` and today's index `i`, returns the fvgSignals array.
 * BULLISH FVG FORMED fires the bar a gap forms. BULLISH FVG RETEST fires the
 * bar price dips back into the nearest still-unfilled bullish FVG zone
 * (formed within FVG_RETEST_LOOKBACK bars) and closes back above its bottom
 * — the actual ICT/SMC entry, not just the imbalance itself. A zone is
 * "mitigated" (voided) the first time a close falls below its bottom,
 * matching LuxAlgo's own mitigation rule; only the nearest unmitigated zone
 * counts.
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
    if (mitigated) break; // this and any older zone are stale — stop scanning
    if (bars[i].low <= zone.top && bars[i].close > zone.bottom) fvgSignals.push('BULLISH FVG RETEST');
    break; // only the nearest unmitigated zone counts
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

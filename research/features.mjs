/**
 * Single source of truth for the atomic "building block" flags the brute-force
 * combo search draws from. Add a flag here and both build-cache.mjs and
 * brute-force.mjs pick it up automatically — nothing else to touch.
 *
 * Most flags read a computeIndicators() row (lib/indicators.js) directly,
 * without reimplementing indicator math. The "fair value" family (FVG,
 * Bollinger, Donchian, VWAP) is the exception — those aren't part of
 * lib/indicators.js, so this file computes them itself, straight off raw
 * OHLCV. Event flags fire only on their own crossover bar (today vs
 * yesterday); state flags are just today's value.
 *
 * FVG and VWAP specifically are shared with production (lib/fairValue.js) —
 * both were validated combos that shipped, so research and production must
 * never drift on their definitions. Bollinger/Donchian stay research-only;
 * nothing depends on them shipping identically anywhere else.
 */
import { detectFvgSignals, rollingVwap, VWAP_LENGTH, FVG_DISPLACEMENT_ATR_MULT } from '../lib/fairValue.js';

export const FLAG_NAMES = [
  'macdGreen', 'macdPositiveRaw', 'macdBullCross',
  'rsiReclaim30', 'rsiReclaim40', 'rsiCross50Up',
  'atrReclaim',
  'bullishDiv', 'bearishDiv',
  'confirmedBuy', 'standardBuy', 'bottomForming', 'oversoldWarn', 'bullFading',
  'adx20', 'adx25',
  'aboveEma200',
  'volSurge175', 'volSurge200',
  'rsiOverboughtState', 'rsiOversoldState',
  'trendBullish', 'histPositive', 'upDay',
  // "Fair value" family — deliberately not MACD/RSI/ATR-derived, added to widen
  // the search beyond momentum/trend-strength indicators already covered above.
  'bullishFvgFormed', 'bullishFvgRetest',
  'bollingerLowerReclaim', 'donchianBreakout20', 'vwapReclaim20',
  // Bearish/exit-side mirrors of the momentum flags above — research-only (not
  // shared with production, unlike the bullish FVG family), built purely to
  // give the brute-force search downside signals to pair as exit rules against
  // the validated bullish entries.
  'macdBearCross', 'rsiCross50Down', 'rsiRejectFrom70',
  'bearishFvgFormed', 'bearishFvgRetest',
];

const b = x => (x ? 1 : 0);

// ── "Fair value" family helpers ─────────────────────────────────────────────
// These read raw OHLCV off `bars` (the pre-indicator array passed into
// computeIndicators()), not the indicator row, since none of them are part of
// lib/indicators.js. extractFlags() is called once per bar with the full
// `rows`/`bars` history available, so a bounded backward scan (not carried
// state) is enough — consistent with the rest of this file staying stateless
// per call.

function extractFvgFlags(bars, i) {
  const { fvgSignals } = detectFvgSignals(bars, i);
  return {
    bullishFvgFormed: b(fvgSignals.includes('BULLISH FVG FORMED')),
    bullishFvgRetest: b(fvgSignals.includes('BULLISH FVG RETEST')),
  };
}

// Bearish FVG — research-only mirror of lib/fairValue.js's bullishFvg/
// detectFvgSignals, inverted the same way the rest of this file treats
// Bollinger/Donchian as research-only. Not shared with production; exists so
// the brute-force search has a downside "fair value" signal to test as an
// exit rule against the validated bullish entries. Duplicates lib/fairValue.js's
// trueRange/rollingAtr rather than importing them since neither is exported
// (by design — that file only exports what production needs).
const FVG_RETEST_LOOKBACK = 15;
const FVG_ATR_LENGTH = 14;

function trueRange(bars, i) {
  if (i === 0) return bars[0].high - bars[0].low;
  const prevClose = bars[i - 1].close;
  return Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
}

function rollingAtr(bars, i, length = FVG_ATR_LENGTH) {
  if (i < length - 1) return null;
  let sum = 0;
  for (let k = i - length + 1; k <= i; k++) sum += trueRange(bars, k);
  return sum / length;
}

function bearishFvg(bars, i, dispMult = FVG_DISPLACEMENT_ATR_MULT) {
  if (i < 2) return null;
  const cur = bars[i], mid = bars[i - 1], old = bars[i - 2];
  if (!(cur.high < old.low && mid.close < old.low)) return null;
  if (dispMult > 0) {
    const atr = rollingAtr(bars, i - 1);
    if (atr == null || Math.abs(mid.close - mid.open) < atr * dispMult) return null;
  }
  return { top: old.low, bottom: cur.high };
}

function extractBearishFvgFlags(bars, i) {
  let formed = 0, retest = 0;
  if (bearishFvg(bars, i)) formed = 1;
  for (let j = i - 1; j >= Math.max(2, i - FVG_RETEST_LOOKBACK); j--) {
    const zone = bearishFvg(bars, j);
    if (!zone) continue;
    let mitigated = false;
    for (let k = j + 1; k < i; k++) {
      if (bars[k].close > zone.top) { mitigated = true; break; }
    }
    if (mitigated) continue;
    if (bars[i].high >= zone.bottom && bars[i].close < zone.top) {
      retest = 1;
      break;
    }
  }
  return { bearishFvgFormed: formed, bearishFvgRetest: retest };
}

// Bollinger Bands (20, 2): classic mean-reversion "fair value" band — price
// crossing back above the lower band from below is the oversold-bounce entry,
// the same event-not-state treatment as RSI Reclaim.
const BOLLINGER_LENGTH = 20, BOLLINGER_MULT = 2;

function lowerBollinger(bars, i) {
  if (i < BOLLINGER_LENGTH - 1) return null;
  const window = bars.slice(i - BOLLINGER_LENGTH + 1, i + 1).map(x => x.close);
  const mean = window.reduce((a, x) => a + x, 0) / window.length;
  const variance = window.reduce((a, x) => a + (x - mean) ** 2, 0) / window.length;
  return mean - BOLLINGER_MULT * Math.sqrt(variance);
}

function extractBollingerReclaim(bars, i) {
  if (i < BOLLINGER_LENGTH) return 0;
  const lowerNow = lowerBollinger(bars, i), lowerPrev = lowerBollinger(bars, i - 1);
  if (lowerNow == null || lowerPrev == null) return 0;
  return b(bars[i - 1].close <= lowerPrev && bars[i].close > lowerNow);
}

// Donchian breakout (20): today's close is a new 20-session high — the
// classic trend-following "fair value has moved" signal (turtle-trading
// style), structurally the opposite bet from the mean-reversion signals above.
const DONCHIAN_LENGTH = 20;

function extractDonchianBreakout(bars, i) {
  if (i < DONCHIAN_LENGTH) return 0;
  const priorWindow = bars.slice(i - DONCHIAN_LENGTH, i).map(x => x.close);
  return b(bars[i].close > Math.max(...priorWindow));
}

// Rolling 20-day VWAP as a volume-weighted "fair value" anchor — shared with
// production (lib/fairValue.js). Reclaim = price crosses back above it.
function extractVwapReclaim(bars, i) {
  if (i < VWAP_LENGTH) return 0;
  const vwapNow = rollingVwap(bars, i), vwapPrev = rollingVwap(bars, i - 1);
  if (vwapNow == null || vwapPrev == null) return 0;
  return b(bars[i - 1].close <= vwapPrev && bars[i].close > vwapNow);
}

/**
 * Given a symbol's raw OHLCV `bars` (the array passed into computeIndicators()),
 * its `rows` (computeIndicators()'s output, same length/index as `bars`), and
 * today's index `i`, returns the flag object for bar i, or null if there's no
 * prior bar to diff against. Most flags read `rows` (the indicator output);
 * the "fair value" family reads raw `bars` directly since FVG/Bollinger/
 * Donchian/VWAP aren't part of lib/indicators.js.
 */
export function extractFlags(bars, rows, i) {
  const cur = rows[i], prev = rows[i - 1];
  if (!prev) return null;

  return {
    macdGreen: b(cur.histogram != null && prev.histogram != null && cur.macdLine != null &&
      prev.histogram <= 0 && cur.histogram > 0 && cur.macdLine < 0),
    macdPositiveRaw: b(cur.macdLine != null && prev.macdLine != null && cur.histogram != null &&
      prev.macdLine <= 0 && cur.macdLine > 0 && cur.histogram > 0),
    macdBullCross: b(cur.macdLine != null && cur.signalLine != null && prev.macdLine != null && prev.signalLine != null &&
      prev.macdLine <= prev.signalLine && cur.macdLine > cur.signalLine),
    macdBearCross: b(cur.macdLine != null && cur.signalLine != null && prev.macdLine != null && prev.signalLine != null &&
      prev.macdLine >= prev.signalLine && cur.macdLine < cur.signalLine),

    rsiReclaim30: b(cur.rsi != null && prev.rsi != null && prev.rsi <= 30 && cur.rsi > 30),
    rsiReclaim40: b(cur.rsi != null && prev.rsi != null && prev.rsi <= 40 && cur.rsi > 40),
    rsiCross50Up: b(cur.rsi != null && prev.rsi != null && prev.rsi <= 50 && cur.rsi > 50),
    rsiCross50Down: b(cur.rsi != null && prev.rsi != null && prev.rsi >= 50 && cur.rsi < 50),
    rsiRejectFrom70: b(cur.rsi != null && prev.rsi != null && prev.rsi >= 70 && cur.rsi < 70),

    atrReclaim: b(cur.atrTrailingStop != null && prev.atrTrailingStop != null &&
      (prev.price - prev.atrTrailingStop) <= 0 && (cur.price - cur.atrTrailingStop) > 0),

    bullishDiv: b(cur.divergence === 'BULLISH DIV'),
    bearishDiv: b(cur.divergence === 'BEARISH DIV'),

    // indicators.js's own composite signal/warning cells — currently unused by
    // lib/report.js entirely, so this is untested territory, not a rehash.
    confirmedBuy: b(cur.signal === 'CONFIRMED BUY'),
    standardBuy: b(cur.signal === 'STANDARD BUY'),
    bottomForming: b(cur.warning === '⚠ BOTTOM FORMING'),
    oversoldWarn: b(cur.warning === 'OVERSOLD'),
    bullFading: b(cur.warning === '↓ BULL FADING'), // control: expect this one to be bad/neutral, not good

    adx20: b(cur.adx != null && cur.adx >= 20),
    adx25: b(cur.adx != null && cur.adx >= 25),
    aboveEma200: b(cur.ema200 != null && cur.price > cur.ema200),
    volSurge175: b(cur.volumeRatio != null && cur.volumeRatio >= 1.75 && cur.price > prev.price),
    volSurge200: b(cur.volumeRatio != null && cur.volumeRatio >= 2.0 && cur.price > prev.price),
    rsiOverboughtState: b(cur.rsi != null && cur.rsi >= 70),
    rsiOversoldState: b(cur.rsi != null && cur.rsi <= 30),
    trendBullish: b(cur.trend === 'BULLISH'),
    histPositive: b(cur.histogram != null && cur.histogram > 0),
    upDay: b(cur.price > prev.price),

    ...extractFvgFlags(bars, i),
    ...extractBearishFvgFlags(bars, i),
    bollingerLowerReclaim: extractBollingerReclaim(bars, i),
    donchianBreakout20: extractDonchianBreakout(bars, i),
    vwapReclaim20: extractVwapReclaim(bars, i),
  };
}

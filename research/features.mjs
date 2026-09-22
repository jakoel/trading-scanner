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
import { detectFvgSignals, rollingVwap, VWAP_LENGTH } from '../lib/fairValue.js';

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

    rsiReclaim30: b(cur.rsi != null && prev.rsi != null && prev.rsi <= 30 && cur.rsi > 30),
    rsiReclaim40: b(cur.rsi != null && prev.rsi != null && prev.rsi <= 40 && cur.rsi > 40),
    rsiCross50Up: b(cur.rsi != null && prev.rsi != null && prev.rsi <= 50 && cur.rsi > 50),

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
    bollingerLowerReclaim: extractBollingerReclaim(bars, i),
    donchianBreakout20: extractDonchianBreakout(bars, i),
    vwapReclaim20: extractVwapReclaim(bars, i),
  };
}

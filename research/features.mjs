/**
 * Single source of truth for the atomic "building block" flags the brute-force
 * combo search draws from. Add a flag here and both build-cache.mjs and
 * brute-force.mjs pick it up automatically — nothing else to touch.
 *
 * Every flag is computed from a computeIndicators() row (lib/indicators.js) —
 * this file never reimplements indicator math, only reads its output. Event
 * flags fire only on their own crossover bar (today vs yesterday); state flags
 * are just today's value.
 */

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
];

const b = x => (x ? 1 : 0);

/** Given a symbol's full computeIndicators() rows and today's index i, returns
 * the flag object for bar i, or null if there's no prior bar to diff against. */
export function extractFlags(rows, i) {
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
  };
}

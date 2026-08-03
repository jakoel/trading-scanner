/**
 * Headless reimplementation of the Pine logic in indicatorSuite.txt ("MACD & RSI
 * Smart Momentum Pro [Swing Edition]"), operating on a plain array of daily
 * {date, open, high, low, close, volume} bars instead of a live TradingView chart.
 *
 * HTF Trend is not computed separately: the Pine script's default higher timeframe
 * input is "D" and this always runs on daily bars already, so HTF Trend is always
 * identical to Trend (EMA) in this configuration — confirmed against live scrapes.
 */

// ─── Core smoothing primitives ──────────────────────────────────────────────

// Pine's ta.ema seeds the recursion with ta.sma(src, length) and stays na until
// `length` values exist. Seeding with the first value instead leaves a residue
// of the seed error that decays too slowly to vanish over the retained window:
// for a 200-length EMA across 400 stored bars roughly 2% of it survives to the
// last bar, which showed up as a median 0.48% EMA200 discrepancy (worst 2.6%).
function ema(values, length) {
  const k = 2 / (length + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  let seed = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    if (prev == null) {
      seed += values[i];
      seedCount++;
      if (seedCount === length) {
        prev = seed / length;
        out[i] = prev;
      }
    } else {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Wilder's smoothing (RMA): used by RSI, ATR, and DMI/ADX in Pine's ta.* builtins.
function rma(values, length) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  let seed = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    if (prev == null) {
      seed += values[i];
      seedCount++;
      if (seedCount === length) {
        prev = seed / length;
        out[i] = prev;
      }
    } else {
      prev = (prev * (length - 1) + values[i]) / length;
      out[i] = prev;
    }
  }
  return out;
}

function sma(values, length) {
  const out = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += values[j];
    out[i] = sum / length;
  }
  return out;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

function rsi(closes, length) {
  const changes = closes.map((c, i) => (i === 0 ? null : c - closes[i - 1]));
  const gains = changes.map(c => (c == null ? null : Math.max(c, 0)));
  const losses = changes.map(c => (c == null ? null : Math.max(-c, 0)));
  const avgGain = rma(gains, length);
  const avgLoss = rma(losses, length);
  return closes.map((_, i) => {
    if (avgGain[i] == null || avgLoss[i] == null) return null;
    if (avgLoss[i] === 0) return 100;
    const rs = avgGain[i] / avgLoss[i];
    return 100 - 100 / (1 + rs);
  });
}

// ─── ATR ─────────────────────────────────────────────────────────────────────

function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prevClose = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });
}

function atr(bars, length) {
  return rma(trueRange(bars), length);
}

// ─── DMI / ADX (Wilder) ──────────────────────────────────────────────────────

function dmiAdx(bars, length) {
  const n = bars.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }
  const tr = trueRange(bars);
  const trRma = rma(tr, length);
  const plusDMRma = rma(plusDM, length);
  const minusDMRma = rma(minusDM, length);

  const diPlus = new Array(n).fill(null);
  const diMinus = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (trRma[i] == null || trRma[i] === 0) continue;
    diPlus[i] = 100 * (plusDMRma[i] / trRma[i]);
    diMinus[i] = 100 * (minusDMRma[i] / trRma[i]);
    const sum = diPlus[i] + diMinus[i];
    dx[i] = sum === 0 ? 0 : 100 * (Math.abs(diPlus[i] - diMinus[i]) / sum);
  }
  const adx = rma(dx, length);
  return { diPlus, diMinus, adx };
}

// ─── Pivots (ta.pivothigh / ta.pivotlow) ────────────────────────────────────

// A pivot at bar `i - right` needs `left` bars before and `right` bars after it,
// so it is only knowable `right` bars later. Like Pine's ta.pivothigh/pivotlow,
// the value is therefore reported at the confirmation bar i, not at the pivot's
// own bar — indexing it at the pivot bar both leaks lookahead and, because the
// report only ever reads the newest bar, put every pivot permanently outside the
// readable window (a divergence could never be reported at all).
function pivotHigh(values, left, right) {
  const out = new Array(values.length).fill(null);
  for (let i = left + right; i < values.length; i++) {
    const c = i - right;
    const center = values[c];
    if (center == null) continue;
    let isPivot = true;
    for (let j = c - left; j <= c + right; j++) {
      if (j === c) continue;
      if (values[j] == null || values[j] >= center) { isPivot = false; break; }
    }
    if (isPivot) out[i] = center;
  }
  return out;
}

function pivotLow(values, left, right) {
  const out = new Array(values.length).fill(null);
  for (let i = left + right; i < values.length; i++) {
    const c = i - right;
    const center = values[c];
    if (center == null) continue;
    let isPivot = true;
    for (let j = c - left; j <= c + right; j++) {
      if (j === c) continue;
      if (values[j] == null || values[j] <= center) { isPivot = false; break; }
    }
    if (isPivot) out[i] = center;
  }
  return out;
}

// ─── Main computation ────────────────────────────────────────────────────────

const DEFAULTS = {
  fastLength: 12, slowLength: 26, signalSmoothing: 9,
  rsiLength: 14, rsiOverbought: 70, rsiOversold: 30,
  emaLength: 200,
  adxLength: 14, adxThreshold: 20,
  divLookback: 14,
  accelLookback: 5,
  volumeMALength: 20, volumeSurgeMultiplier: 1.5,
  atrLength: 10, atrMultiplier: 3.0,
  minHistogramStrengthATR: 0.05,
  confirmationBars: 2, signalCooldown: 5,
  rsiStrengthThreshold: 10, macdCrossLookback: 3,
  minConfluenceScore: 4,
};

/**
 * Computes the full indicator suite for a bar history (oldest first).
 * Returns an array parallel to `bars`, each entry holding every field the
 * Pine script's info table exposes, plus the raw macd/histogram series needed
 * for crossover-lookback signal detection.
 */
export function computeIndicators(bars, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const n = bars.length;
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);

  const fastMA = ema(closes, cfg.fastLength);
  const slowMA = ema(closes, cfg.slowLength);
  const macdLine = closes.map((_, i) => (fastMA[i] == null || slowMA[i] == null ? null : fastMA[i] - slowMA[i]));
  const signalLine = ema(macdLine, cfg.signalSmoothing);
  const histogram = closes.map((_, i) => (macdLine[i] == null || signalLine[i] == null ? null : macdLine[i] - signalLine[i]));

  const rsiValue = rsi(closes, cfg.rsiLength);
  const ema200 = ema(closes, cfg.emaLength);
  const atrValue = atr(bars, cfg.atrLength);
  const { adx: adxValue } = dmiAdx(bars, cfg.adxLength);

  const volumeMA = sma(volumes, cfg.volumeMALength);
  const volumeRatio = volumes.map((v, i) => (volumeMA[i] ? v / volumeMA[i] : null));

  const pivotHighPrice = pivotHigh(highs, cfg.divLookback, cfg.divLookback);
  const pivotLowPrice = pivotLow(lows, cfg.divLookback, cfg.divLookback);
  const pivotHighRSI = pivotHigh(rsiValue, cfg.divLookback, cfg.divLookback);
  const pivotLowRSI = pivotLow(rsiValue, cfg.divLookback, cfg.divLookback);
  const histPivotHigh = pivotHigh(histogram, cfg.divLookback, cfg.divLookback);
  const histPivotLow = pivotLow(histogram, cfg.divLookback, cfg.divLookback);

  const bearishDivDetected = new Array(n).fill(false);
  const bullishDivDetected = new Array(n).fill(false);
  const macdBearishDivDetected = new Array(n).fill(false);
  const macdBullishDivDetected = new Array(n).fill(false);
  {
    let prevPHPrice = null, prevPHRSI = null, prevPLPrice = null, prevPLRSI = null;
    let prevHistPHigh = null, prevHistPHighPrice = null, prevHistPLow = null, prevHistPLowPrice = null;
    for (let i = 0; i < n; i++) {
      if (pivotHighPrice[i] != null) {
        if (prevPHPrice != null && prevPHRSI != null) {
          if (pivotHighPrice[i] > prevPHPrice && pivotHighRSI[i] < prevPHRSI) bearishDivDetected[i] = true;
        }
        prevPHPrice = pivotHighPrice[i];
        prevPHRSI = pivotHighRSI[i];
      }
      if (pivotLowPrice[i] != null) {
        if (prevPLPrice != null && prevPLRSI != null) {
          if (pivotLowPrice[i] < prevPLPrice && pivotLowRSI[i] > prevPLRSI) bullishDivDetected[i] = true;
        }
        prevPLPrice = pivotLowPrice[i];
        prevPLRSI = pivotLowRSI[i];
      }
      if (histPivotHigh[i] != null) {
        const currentPivotHighPrice = highs[i - cfg.divLookback];
        if (prevHistPHigh != null && prevHistPHighPrice != null) {
          if (currentPivotHighPrice > prevHistPHighPrice && histPivotHigh[i] < prevHistPHigh) macdBearishDivDetected[i] = true;
        }
        prevHistPHigh = histPivotHigh[i];
        prevHistPHighPrice = currentPivotHighPrice;
      }
      if (histPivotLow[i] != null) {
        const currentPivotLowPrice = lows[i - cfg.divLookback];
        if (prevHistPLow != null && prevHistPLowPrice != null) {
          if (currentPivotLowPrice < prevHistPLowPrice && histPivotLow[i] > prevHistPLow) macdBullishDivDetected[i] = true;
        }
        prevHistPLow = histPivotLow[i];
        prevHistPLowPrice = currentPivotLowPrice;
      }
    }
  }

  const abs = Math.abs;
  const histAccelerating = new Array(n).fill(false);
  const histDecelerating = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (i < cfg.accelLookback - 1) continue;
    let accelerating = true, decelerating = true;
    for (let k = 1; k < cfg.accelLookback; k++) {
      const cur = histogram[i - k + 1], prev = histogram[i - k];
      if (cur == null || prev == null) { accelerating = decelerating = false; break; }
      if (abs(prev) <= abs(cur)) accelerating = false;
      if (abs(prev) >= abs(cur)) decelerating = false;
    }
    histAccelerating[i] = accelerating;
    histDecelerating[i] = decelerating;
  }

  function crossover(a, b, i) {
    return a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
  }
  function crossunder(a, b, i) {
    return a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];
  }
  const bullishMACDCross = new Array(n).fill(false);
  const bearishMACDCross = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    for (let k = 0; k < cfg.macdCrossLookback; k++) {
      const idx = i - k;
      if (idx < 1) break;
      if (crossover(macdLine, signalLine, idx)) { bullishMACDCross[i] = true; break; }
    }
    for (let k = 0; k < cfg.macdCrossLookback; k++) {
      const idx = i - k;
      if (idx < 1) break;
      if (crossunder(macdLine, signalLine, idx)) { bearishMACDCross[i] = true; break; }
    }
  }

  let lastBuySignalBar = -999, lastSellSignalBar = -999;
  let trailStop = null, trailBullish = false;

  const rows = [];
  for (let i = 0; i < n; i++) {
    const priceAboveEMA = ema200[i] != null && closes[i] > ema200[i];
    const priceBelowEMA = ema200[i] != null && closes[i] < ema200[i];
    const trendIsStrong = adxValue[i] != null ? adxValue[i] >= cfg.adxThreshold : false;

    const aboveAverageVolume = volumeRatio[i] != null && volumeRatio[i] >= 1.0;
    const volumeSurge = volumeRatio[i] != null && volumeRatio[i] >= cfg.volumeSurgeMultiplier;
    const lowVolume = volumeRatio[i] != null && volumeRatio[i] < 0.7;

    const anyBearishDivergence = bearishDivDetected[i] || macdBearishDivDetected[i];
    const anyBullishDivergence = bullishDivDetected[i] || macdBullishDivDetected[i];

    const rsiUpperThreshold = 50 + cfg.rsiStrengthThreshold;
    const rsiLowerThreshold = 50 - cfg.rsiStrengthThreshold;
    const histogramStrong = histogram[i] != null && atrValue[i] != null
      ? abs(histogram[i]) >= cfg.minHistogramStrengthATR * atrValue[i]
      : false;

    let bullScore = 0;
    bullScore += bullishMACDCross[i] ? 1 : 0;
    bullScore += rsiValue[i] != null && rsiValue[i] > rsiUpperThreshold ? 1 : 0;
    bullScore += volumeSurge ? 2 : aboveAverageVolume ? 1 : 0;
    bullScore += priceAboveEMA ? 1 : 0;
    bullScore += priceAboveEMA ? 1 : 0; // HTF trend === current trend in this daily-only setup
    bullScore += trendIsStrong ? 1 : 0;
    bullScore += anyBullishDivergence ? 1 : 0;
    bullScore = Math.min(bullScore, 8);

    let bearScore = 0;
    bearScore += bearishMACDCross[i] ? 1 : 0;
    bearScore += rsiValue[i] != null && rsiValue[i] < rsiLowerThreshold ? 1 : 0;
    bearScore += volumeSurge ? 2 : aboveAverageVolume ? 1 : 0;
    bearScore += priceBelowEMA ? 1 : 0;
    bearScore += priceBelowEMA ? 1 : 0; // HTF trend === current trend in this daily-only setup
    bearScore += trendIsStrong ? 1 : 0;
    bearScore += anyBearishDivergence ? 1 : 0;
    bearScore = Math.min(bearScore, 8);

    const confirmedThreshold = Math.min(cfg.minConfluenceScore + 2, 8);
    const hist = histogram[i];
    const confirmedBuy = hist != null && hist > 0 && histogramStrong && bullScore >= confirmedThreshold;
    const standardBuy = hist != null && hist > 0 && histogramStrong && bullScore >= cfg.minConfluenceScore && bullScore < confirmedThreshold;
    const confirmedSell = hist != null && hist < 0 && histogramStrong && bearScore >= confirmedThreshold;
    const standardSell = hist != null && hist < 0 && histogramStrong && bearScore >= cfg.minConfluenceScore && bearScore < confirmedThreshold;

    const counterTrendRally = hist != null && hist > 0 && histogramStrong && bullScore >= cfg.minConfluenceScore && priceBelowEMA;
    const counterTrendPullback = hist != null && hist < 0 && histogramStrong && bearScore >= cfg.minConfluenceScore && priceAboveEMA;

    const pullbackWarning = histDecelerating[i] && hist != null && hist < 0 && priceAboveEMA;
    const rallyWarning = histDecelerating[i] && hist != null && hist > 0 && priceBelowEMA;

    const lowVolumeWarning = lowVolume && hist != null && hist !== 0;

    // Multi-bar confirmation: condition must hold for `confirmationBars` consecutive bars.
    // rows[] already holds prior bars' raw (pre-confirmation) flags to check against.
    function confirmedFor(currentFlag, key) {
      if (cfg.confirmationBars <= 1) return currentFlag;
      if (!currentFlag) return false;
      for (let k = 1; k < cfg.confirmationBars; k++) {
        const prevRow = rows[i - k];
        if (!prevRow || !prevRow._raw[key]) return false;
      }
      return true;
    }
    const raw = { confirmedBuy, confirmedSell, standardBuy, standardSell };
    const confirmedBuyConfirmed = confirmedFor(confirmedBuy, 'confirmedBuy');
    const confirmedSellConfirmed = confirmedFor(confirmedSell, 'confirmedSell');
    const standardBuyConfirmed = confirmedFor(standardBuy, 'standardBuy');
    const standardSellConfirmed = confirmedFor(standardSell, 'standardSell');

    const buySignalReady = cfg.signalCooldown === 0 || (i - lastBuySignalBar) >= cfg.signalCooldown;
    const sellSignalReady = cfg.signalCooldown === 0 || (i - lastSellSignalBar) >= cfg.signalCooldown;

    const finalConfirmedBuy = confirmedBuyConfirmed && buySignalReady;
    const finalConfirmedSell = confirmedSellConfirmed && sellSignalReady;
    const finalStandardBuy = standardBuyConfirmed && buySignalReady;
    const finalStandardSell = standardSellConfirmed && sellSignalReady;

    if (finalConfirmedBuy || finalStandardBuy) lastBuySignalBar = i;
    if (finalConfirmedSell || finalStandardSell) lastSellSignalBar = i;

    // ATR trailing stop (sequential, stateful across the whole history)
    if (atrValue[i] != null) {
      const stopDist = atrValue[i] * cfg.atrMultiplier;
      if (trailStop == null) {
        if (finalConfirmedBuy || finalStandardBuy) { trailStop = lows[i] - stopDist; trailBullish = true; }
        else if (finalConfirmedSell || finalStandardSell) { trailStop = highs[i] + stopDist; trailBullish = false; }
      } else {
        if (trailBullish) {
          trailStop = Math.max(trailStop, closes[i] - stopDist);
          if (closes[i] < trailStop) { trailBullish = false; trailStop = highs[i] + stopDist; }
        } else {
          trailStop = Math.min(trailStop, closes[i] + stopDist);
          if (closes[i] > trailStop) { trailBullish = true; trailStop = lows[i] - stopDist; }
        }
        if (finalConfirmedBuy || finalStandardBuy) { trailStop = lows[i] - stopDist; trailBullish = true; }
        else if (finalConfirmedSell || finalStandardSell) { trailStop = highs[i] + stopDist; trailBullish = false; }
      }
    }

    const activeScore = hist != null && hist >= 0 ? bullScore : bearScore;

    let signalText = 'NEUTRAL';
    if (finalConfirmedBuy) signalText = 'CONFIRMED BUY';
    else if (finalConfirmedSell) signalText = 'CONFIRMED SELL';
    else if (counterTrendRally) signalText = 'COUNTER RALLY';
    else if (counterTrendPullback) signalText = 'COUNTER PULL';
    else if (pullbackWarning) signalText = 'PULLBACK WARN';
    else if (rallyWarning) signalText = 'RALLY WARN';
    else if (finalStandardBuy) signalText = 'STANDARD BUY';
    else if (finalStandardSell) signalText = 'STANDARD SELL';

    let warningText = 'NONE';
    if (anyBearishDivergence && hist != null && hist > 0 && bullScore >= cfg.minConfluenceScore) warningText = '⚠ TOP FORMING';
    else if (anyBullishDivergence && hist != null && hist < 0 && bearScore >= cfg.minConfluenceScore) warningText = '⚠ BOTTOM FORMING';
    else if (histDecelerating[i] && hist != null && hist > 0) warningText = '↓ BULL FADING';
    else if (histDecelerating[i] && hist != null && hist < 0) warningText = '↑ BEAR FADING';
    else if (rsiValue[i] != null && rsiValue[i] >= cfg.rsiOverbought && hist != null && hist > 0 && bullScore >= cfg.minConfluenceScore) warningText = 'OVERBOUGHT';
    else if (rsiValue[i] != null && rsiValue[i] <= cfg.rsiOversold && hist != null && hist < 0 && bearScore >= cfg.minConfluenceScore) warningText = 'OVERSOLD';
    else if (lowVolumeWarning) warningText = 'LOW VOLUME';

    let volumeText = 'AVERAGE';
    if (volumeSurge) volumeText = 'SURGE';
    else if (aboveAverageVolume) volumeText = 'ABOVE AVG';
    else if (lowVolume) volumeText = 'LOW';

    const trendText = priceAboveEMA ? 'BULLISH' : 'BEARISH';
    const divText = anyBearishDivergence ? 'BEARISH DIV' : anyBullishDivergence ? 'BULLISH DIV' : 'NONE';
    const momentumText = histAccelerating[i] ? 'ACCELERATING' : histDecelerating[i] ? 'DECELERATING' : 'STABLE';

    rows.push({
      date: bars[i].date,
      price: closes[i],
      macdLine: macdLine[i],
      signalLine: signalLine[i],
      histogram: hist,
      rsi: rsiValue[i],
      adx: adxValue[i],
      ema200: ema200[i],
      atr: atrValue[i],
      atrTrailingStop: trailStop,
      volumeRatio: volumeRatio[i],
      trend: trendText,
      htfTrend: trendText, // identical to Trend in this daily-only configuration
      momentum: momentumText,
      divergence: divText,
      volume: `${volumeText} (${volumeRatio[i] != null ? volumeRatio[i].toFixed(2) : '?'}x)`,
      score: `${activeScore} / 8`,
      signal: signalText,
      warning: warningText,
      _raw: raw, // used internally by confirmedFor() lookback; not part of the public shape
    });
  }

  return rows;
}

/**
 * Indicator math + the flag pool for the strategy search. Self-contained and
 * vectorised: everything works on Float64Array OHLCV columns for one symbol
 * and returns Uint8Array flags (1 = condition true on that bar's close).
 *
 * Event flags fire on the crossing bar only; state flags are the bar's state.
 * Which are "triggers" (rare) vs "filters" (common) is decided from measured
 * frequency in search.mjs, not declared here.
 *
 * Several definitions come from widely used TradingView strategies
 * (Supertrend, Connors RSI(2)/IBS, Bollinger lower-band reclaim, Squeeze
 * Momentum release, EMA 9/21 cross, Stochastic/CCI/MFI turns, Donchian and
 * 52-week breakouts).
 */

const NaNs = n => new Float64Array(n).fill(NaN);

export function sma(x, n) {
  const out = NaNs(x.length);
  let s = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isNaN(v)) { s += v; cnt++; }
    if (i >= n) { const o = x[i - n]; if (!Number.isNaN(o)) { s -= o; cnt--; } }
    if (i >= n - 1 && cnt === n) out[i] = s / n;
  }
  return out;
}

export function ema(x, n) {
  const out = NaNs(x.length), a = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) { out[i] = prev; continue; }
    prev = Number.isNaN(prev) ? x[i] : a * x[i] + (1 - a) * prev;
    out[i] = i >= n - 1 ? prev : NaN;
  }
  return out;
}

export function rma(x, n) {
  const out = NaNs(x.length);
  let prev = NaN, s = 0, cnt = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      s += v; cnt++;
      if (cnt === n) { prev = s / n; out[i] = prev; }
    } else { prev = (prev * (n - 1) + v) / n; out[i] = prev; }
  }
  return out;
}

export function stdev(x, n) {
  const out = NaNs(x.length), m = sma(x, n);
  for (let i = n - 1; i < x.length; i++) {
    if (Number.isNaN(m[i])) continue;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += (x[k] - m[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

export function highest(x, n) {
  const out = NaNs(x.length);
  for (let i = n - 1; i < x.length; i++) { let m = -Infinity; for (let k = i - n + 1; k <= i; k++) if (x[k] > m) m = x[k]; out[i] = m; }
  return out;
}
export function lowest(x, n) {
  const out = NaNs(x.length);
  for (let i = n - 1; i < x.length; i++) { let m = Infinity; for (let k = i - n + 1; k <= i; k++) if (x[k] < m) m = x[k]; out[i] = m; }
  return out;
}

export function trueRange(h, l, c) {
  const out = new Float64Array(h.length);
  out[0] = h[0] - l[0];
  for (let i = 1; i < h.length; i++) out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  return out;
}
export const atr = (h, l, c, n = 14) => rma(trueRange(h, l, c), n);

export function rsi(c, n = 14) {
  const up = new Float64Array(c.length), dn = new Float64Array(c.length);
  for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; up[i] = d > 0 ? d : 0; dn[i] = d < 0 ? -d : 0; }
  const au = rma(up.subarray(1), n), ad = rma(dn.subarray(1), n), out = NaNs(c.length);
  for (let i = 0; i < au.length; i++) if (!Number.isNaN(au[i])) out[i + 1] = ad[i] === 0 ? 100 : 100 - 100 / (1 + au[i] / ad[i]);
  return out;
}

function macd(c, f = 12, s = 26, sig = 9) {
  const ef = ema(c, f), es = ema(c, s), line = NaNs(c.length);
  for (let i = 0; i < c.length; i++) line[i] = ef[i] - es[i];
  const clean = Float64Array.from(line, v => v);
  const signal = ema(clean, sig), hist = NaNs(c.length);
  for (let i = 0; i < c.length; i++) hist[i] = line[i] - signal[i];
  return { line, signal, hist };
}

function adx(h, l, c, n = 14) {
  const len = h.length, pdm = new Float64Array(len), mdm = new Float64Array(len);
  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm[i] = up > dn && up > 0 ? up : 0; mdm[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = rma(trueRange(h, l, c), n), p = rma(pdm, n), m = rma(mdm, n);
  const pdi = NaNs(len), mdi = NaNs(len), dx = NaNs(len);
  for (let i = 0; i < len; i++) {
    if (Number.isNaN(tr[i]) || Number.isNaN(p[i]) || tr[i] === 0) continue;
    pdi[i] = 100 * p[i] / tr[i]; mdi[i] = 100 * m[i] / tr[i];
    const s = pdi[i] + mdi[i]; dx[i] = s === 0 ? 0 : 100 * Math.abs(pdi[i] - mdi[i]) / s;
  }
  return { adx: rma(dx, n), pdi, mdi };
}

function supertrend(h, l, c, n = 10, mult = 3) {
  const a = atr(h, l, c, n), len = h.length, dir = new Int8Array(len);
  let fu = NaN, fl = NaN, d = 1;
  for (let i = 0; i < len; i++) {
    if (Number.isNaN(a[i])) continue;
    const hl2 = (h[i] + l[i]) / 2, bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
    const nfu = Number.isNaN(fu) || bu < fu || c[i - 1] > fu ? bu : fu;
    const nfl = Number.isNaN(fl) || bl > fl || c[i - 1] < fl ? bl : fl;
    if (!Number.isNaN(fu) && d === -1 && c[i] > nfu) d = 1;
    else if (!Number.isNaN(fl) && d === 1 && c[i] < nfl) d = -1;
    fu = nfu; fl = nfl; dir[i] = d;
  }
  return dir;
}

function mfi(h, l, c, v, n = 14) {
  const len = c.length, tp = new Float64Array(len), pos = new Float64Array(len), neg = new Float64Array(len);
  for (let i = 0; i < len; i++) tp[i] = (h[i] + l[i] + c[i]) / 3;
  for (let i = 1; i < len; i++) { const f = tp[i] * v[i]; if (tp[i] > tp[i - 1]) pos[i] = f; else if (tp[i] < tp[i - 1]) neg[i] = f; }
  const sp = sma(pos, n), sn = sma(neg, n), out = NaNs(len);
  for (let i = 0; i < len; i++) if (!Number.isNaN(sp[i])) out[i] = sn[i] === 0 ? 100 : 100 - 100 / (1 + sp[i] / sn[i]);
  return out;
}

function cci(h, l, c, n = 20) {
  const len = c.length, tp = new Float64Array(len);
  for (let i = 0; i < len; i++) tp[i] = (h[i] + l[i] + c[i]) / 3;
  const m = sma(tp, n), out = NaNs(len);
  for (let i = n - 1; i < len; i++) {
    if (Number.isNaN(m[i])) continue;
    let md = 0; for (let k = i - n + 1; k <= i; k++) md += Math.abs(tp[k] - m[i]);
    md /= n; out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  }
  return out;
}

const gt = (a, b) => a > b; // NaN compares false, so undefined bars never fire
const mk = (n, fn) => { const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = fn(i) ? 1 : 0; return out; };
const crossUp = (a, b) => i => i > 0 && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossUpK = (a, k) => i => i > 0 && a[i - 1] <= k && a[i] > k;
const crossDownK = (a, k) => i => i > 0 && a[i - 1] >= k && a[i] < k;

/**
 * `bars` = { o,h,l,c,v } Float64Arrays. `mkt` = optional { above200, rsiBelow40 }
 * Uint8Arrays already aligned to this symbol's bars (market-regime filters
 * from SPY). Returns { flags: {name: Uint8Array}, aux: {atr, ema10, rsi} } —
 * aux feeds exits.mjs so indicators are computed once.
 */
export function computeFlags(bars, mkt) {
  const { o, h, l, c, v } = bars, n = c.length;
  const sma20 = sma(c, 20), sma50 = sma(c, 50), sma200 = sma(c, 200);
  const e9 = ema(c, 9), e10 = ema(c, 10), e20 = ema(c, 20), e21 = ema(c, 21), e50 = ema(c, 50);
  const rsi14 = rsi(c, 14), rsi2 = rsi(c, 2), atr14 = atr(h, l, c, 14);
  const m = macd(c), ad = adx(h, l, c), st = supertrend(h, l, c);
  const sd20 = stdev(c, 20), hh14 = highest(h, 14), ll14 = lowest(l, 14);
  const hh20p = highest(h, 20), ll20 = lowest(l, 20), hh252 = highest(h, 252), ll252 = lowest(l, 252);
  const volAvg20 = sma(v, 20), mfi14 = mfi(h, l, c, v), cci20 = cci(h, l, c);

  const bbUp = NaNs(n), bbLo = NaNs(n), bbW = NaNs(n), kcUp = NaNs(n), kcLo = NaNs(n), pctB = NaNs(n);
  const atr20 = atr(h, l, c, 20);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(sd20[i])) continue;
    bbUp[i] = sma20[i] + 2 * sd20[i]; bbLo[i] = sma20[i] - 2 * sd20[i];
    bbW[i] = (bbUp[i] - bbLo[i]) / sma20[i]; pctB[i] = (c[i] - bbLo[i]) / (bbUp[i] - bbLo[i]);
    if (!Number.isNaN(atr20[i])) { kcUp[i] = sma20[i] + 1.5 * atr20[i]; kcLo[i] = sma20[i] - 1.5 * atr20[i]; }
  }
  const stochK = NaNs(n);
  for (let i = 0; i < n; i++) if (!Number.isNaN(hh14[i])) { const r = hh14[i] - ll14[i]; stochK[i] = r === 0 ? 50 : 100 * (c[i] - ll14[i]) / r; }
  const sK = sma(stochK, 3), sD = sma(sK, 3);
  const ibs = new Float64Array(n), roc5 = NaNs(n), roc10 = NaNs(n), roc20 = NaNs(n), bbWMed = NaNs(n);
  for (let i = 0; i < n; i++) {
    const r = h[i] - l[i]; ibs[i] = r === 0 ? 0.5 : (c[i] - l[i]) / r;
    if (i >= 5) roc5[i] = c[i] / c[i - 5] - 1;
    if (i >= 10) roc10[i] = c[i] / c[i - 10] - 1;
    if (i >= 20) roc20[i] = c[i] / c[i - 20] - 1;
  }
  // BB-width percentile proxy: width vs its own 100-bar median-ish (sma)
  const bbWAvg = sma(Float64Array.from(bbW, x => (Number.isNaN(x) ? NaN : x)), 100);
  const squeezeOn = mk(n, i => bbUp[i] < kcUp[i] && bbLo[i] > kcLo[i]);
  const obv = new Float64Array(n);
  for (let i = 1; i < n; i++) obv[i] = obv[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0);
  const obvMa = sma(obv, 20);
  const mom = NaNs(n); // squeeze-momentum proxy: close vs midpoint of (Donchian mid, SMA20)
  for (let i = 0; i < n; i++) if (!Number.isNaN(hh20p[i]) && !Number.isNaN(sma20[i])) mom[i] = c[i] - ((hh20p[i] + ll20[i]) / 2 + sma20[i]) / 2;

  const f = {};
  // ── trend / regime states ──
  f.above200 = mk(n, i => gt(c[i], sma200[i]));
  f.below200 = mk(n, i => c[i] < sma200[i]);
  f.above50 = mk(n, i => gt(c[i], sma50[i]));
  f.below50 = mk(n, i => c[i] < sma50[i]);
  f.above20 = mk(n, i => gt(c[i], e20[i]));
  f.ema9gt21 = mk(n, i => gt(e9[i], e21[i]));
  f.ema21gt50 = mk(n, i => gt(e21[i], e50[i]));
  f.sma50gt200 = mk(n, i => gt(sma50[i], sma200[i]));
  f.sma200Rising = mk(n, i => i >= 20 && gt(sma200[i], sma200[i - 20]));
  f.adx20 = mk(n, i => ad.adx[i] >= 20);
  f.adx25 = mk(n, i => ad.adx[i] >= 25);
  f.adxLow = mk(n, i => ad.adx[i] < 20);
  f.diBull = mk(n, i => gt(ad.pdi[i], ad.mdi[i]));
  f.supertrendUp = mk(n, i => st[i] === 1);
  f.nearHigh252 = mk(n, i => c[i] >= 0.95 * hh252[i]);
  f.farFromHigh252 = mk(n, i => c[i] <= 0.80 * hh252[i]);
  f.nearLow252 = mk(n, i => c[i] <= 1.15 * ll252[i]);
  if (mkt) {
    f.mktAbove200 = mkt.above200;
    f.mktBelow200 = mk(n, i => mkt.above200[i] === 0 && mkt.valid[i] === 1);
    f.mktRsiBelow40 = mkt.rsiBelow40;
  }
  // ── momentum / oscillator states ──
  f.rsiAbove50 = mk(n, i => rsi14[i] > 50);
  f.rsiBelow40 = mk(n, i => rsi14[i] < 40);
  f.rsiBelow30 = mk(n, i => rsi14[i] < 30);
  f.rsiAbove70 = mk(n, i => rsi14[i] > 70);
  f.rsi2Below10 = mk(n, i => rsi2[i] < 10);
  f.rsi2Below5 = mk(n, i => rsi2[i] < 5);
  f.stochOversold = mk(n, i => sK[i] < 20);
  f.stochOverbought = mk(n, i => sK[i] > 80);
  f.cciBelowM100 = mk(n, i => cci20[i] < -100);
  f.mfiBelow20 = mk(n, i => mfi14[i] < 20);
  f.macdHistPos = mk(n, i => m.hist[i] > 0);
  f.macdLinePos = mk(n, i => m.line[i] > 0);
  f.roc10Pos = mk(n, i => roc10[i] > 0);
  f.obvAboveMa = mk(n, i => gt(obv[i], obvMa[i]));
  f.pullbackInUptrend = mk(n, i => c[i] < e20[i] && c[i] > sma50[i] && c[i] > sma200[i]);
  f.ibsLow = mk(n, i => ibs[i] < 0.2);
  f.ibsHigh = mk(n, i => ibs[i] > 0.8);
  f.closeNearHigh = mk(n, i => ibs[i] > 0.75);
  f.down3 = mk(n, i => i >= 3 && c[i] < c[i - 1] && c[i - 1] < c[i - 2] && c[i - 2] < c[i - 3]);
  f.roc5Below5 = mk(n, i => roc5[i] < -0.05);
  f.roc20Below10 = mk(n, i => roc20[i] < -0.10);
  f.bbLow = mk(n, i => pctB[i] < 0.05);
  f.bbWidthLow = mk(n, i => bbW[i] < 0.7 * bbWAvg[i]);
  f.squeezeOn = squeezeOn;
  f.highVol = mk(n, i => i >= 50 && atr14[i] / c[i] > 0.03);
  f.lowVol = mk(n, i => atr14[i] / c[i] < 0.015);
  f.volAboveAvg = mk(n, i => v[i] > volAvg20[i]);
  f.volDryUp = mk(n, i => v[i] < 0.6 * volAvg20[i]);
  // ── events ──
  f.rsiUp30 = mk(n, crossUpK(rsi14, 30));
  f.rsiUp40 = mk(n, crossUpK(rsi14, 40));
  f.rsiUp50 = mk(n, crossUpK(rsi14, 50));
  f.rsiDown70 = mk(n, crossDownK(rsi14, 70));
  f.rsi2Up10 = mk(n, crossUpK(rsi2, 10));
  f.rsi2Up30 = mk(n, crossUpK(rsi2, 30));
  f.stochCrossUp = mk(n, i => crossUp(sK, sD)(i) && sK[i] < 30);
  f.cciUpM100 = mk(n, crossUpK(cci20, -100));
  f.mfiUp20 = mk(n, crossUpK(mfi14, 20));
  f.macdBullCross = mk(n, crossUp(m.line, m.signal));
  f.macdHistTurnPos = mk(n, crossUpK(m.hist, 0));
  f.macdLineUp0 = mk(n, crossUpK(m.line, 0));
  f.ema9x21 = mk(n, crossUp(e9, e21));
  f.ema21x50 = mk(n, crossUp(e21, e50));
  f.closeUpEma20 = mk(n, crossUp(c, e20));
  f.closeUpSma50 = mk(n, crossUp(c, sma50));
  f.closeUpSma200 = mk(n, crossUp(c, sma200));
  f.goldenCross = mk(n, crossUp(sma50, sma200));
  f.supertrendFlipUp = mk(n, i => i > 0 && st[i] === 1 && st[i - 1] === -1);
  f.bbLowerReclaim = mk(n, i => i > 0 && c[i - 1] <= bbLo[i - 1] && c[i] > bbLo[i]);
  f.bbMidReclaim = mk(n, crossUp(c, sma20));
  f.squeezeRelease = mk(n, i => i >= 5 && squeezeOn[i - 1] === 1 && squeezeOn[i] === 0 && mom[i] > 0 && squeezeOn[i - 5] === 1);
  f.donchian20 = mk(n, i => i >= 20 && gt(c[i], hh20p[i - 1]));
  f.high252Break = mk(n, i => i >= 252 && gt(c[i], hh252[i - 1]));
  f.low20Reclaim = mk(n, i => i >= 20 && l[i] < ll20[i - 1] && c[i] > c[i - 1] && ibs[i] > 0.5);
  f.insideBreak = mk(n, i => i >= 2 && h[i - 1] <= h[i - 2] && l[i - 1] >= l[i - 2] && c[i] > h[i - 1]);
  f.bullEngulf = mk(n, i => i > 0 && c[i - 1] < o[i - 1] && c[i] > o[i] && o[i] <= c[i - 1] && c[i] >= o[i - 1]);
  f.hammer = mk(n, i => { const body = Math.abs(c[i] - o[i]), low = Math.min(o[i], c[i]) - l[i], up = h[i] - Math.max(o[i], c[i]); return h[i] > l[i] && low > 2 * body && up < body + 1e-9 + 0.1 * (h[i] - l[i]); });
  f.gapUp1 = mk(n, i => i > 0 && o[i] > 1.01 * c[i - 1] && c[i] > o[i]);
  f.volSurgeUp = mk(n, i => v[i] > 1.5 * volAvg20[i] && c[i] > c[i - 1] && ibs[i] > 0.6);
  f.nr7Break = mk(n, i => { if (i < 8) return false; let narrow = true; const r = h[i - 1] - l[i - 1]; for (let k = i - 7; k < i - 1; k++) if (h[k] - l[k] <= r) narrow = false; return narrow && c[i] > h[i - 1]; });
  f.higherLow = mk(n, i => i >= 3 && l[i] > l[i - 1] && l[i - 1] < l[i - 2] && c[i] > c[i - 1]);

  return { flags: f, aux: { atr: atr14, ema10: e10, rsi: rsi14, o, h, l, c } };
}

export function marketFlags(spyBars) {
  const { c } = spyBars, n = c.length, s200 = sma(c, 200), r = rsi(c, 14);
  return {
    valid: mk(n, i => !Number.isNaN(s200[i])),
    above200: mk(n, i => gt(c[i], s200[i])),
    rsiBelow40: mk(n, i => r[i] < 40),
  };
}

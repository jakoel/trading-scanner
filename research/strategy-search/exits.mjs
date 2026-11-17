/**
 * Exit models. For a signal on bar t (close), the long entry fills at bar t+1's
 * open. Every model returns a net return per entry bar (Float32Array, NaN where
 * the trade can't complete inside the data), after a round-trip cost.
 *
 * Within a bar, a stop is checked before a target — the conservative choice
 * when one bar's range touches both. Gaps through a level fill at the open.
 */
export const COST = 0.001; // 0.1% round trip

export const EXIT_MODELS = [
  { id: 'H5',    label: 'hold 5',                              kind: 'hold', n: 5 },
  { id: 'H10',   label: 'hold 10',                             kind: 'hold', n: 10 },
  { id: 'H20',   label: 'hold 20',                             kind: 'hold', n: 20 },
  { id: 'B1/3',  label: 'target 1xATR / stop 3xATR / 10 bars', kind: 'bracket', tp: 1, sl: 3, T: 10 },
  { id: 'B1/1.5',label: 'target 1xATR / stop 1.5xATR / 10',    kind: 'bracket', tp: 1, sl: 1.5, T: 10 },
  { id: 'B2/2',  label: 'target 2xATR / stop 2xATR / 20',      kind: 'bracket', tp: 2, sl: 2, T: 20 },
  { id: 'B3/2',  label: 'target 3xATR / stop 2xATR / 30',      kind: 'bracket', tp: 3, sl: 2, T: 30 },
  { id: 'TRAIL', label: '3xATR chandelier trail / 40 bars',    kind: 'trail', mult: 3, T: 40 },
  { id: 'EMA10', label: 'close<EMA10 (4xATR stop) / 30',       kind: 'ema10', sl: 4, T: 30 },
  { id: 'RSI60', label: 'RSI>=60 (2.5xATR stop) / 15',         kind: 'rsi60', sl: 2.5, T: 15 },
];

export function computeExits({ aux, n }) {
  const { atr, ema10, rsi, o, h, l, c } = aux;
  const M = EXIT_MODELS.length;
  const out = Array.from({ length: M }, () => new Float32Array(n).fill(NaN));

  for (let t = 0; t < n - 1; t++) {
    const e = t + 1, a = atr[t], px = o[e];
    if (!(a > 0) || !(px > 0)) continue;

    for (let m = 0; m < M; m++) {
      const md = EXIT_MODELS[m];
      let exit = NaN;

      if (md.kind === 'hold') {
        const j = e + md.n - 1;
        if (j < n) exit = c[j];
      } else if (md.kind === 'bracket') {
        const tp = px + md.tp * a, sl = px - md.sl * a, last = e + md.T - 1;
        if (last < n) {
          exit = c[last];
          for (let j = e; j <= last; j++) {
            if (l[j] <= sl) { exit = j > e && o[j] < sl ? o[j] : sl; break; }
            if (h[j] >= tp) { exit = j > e && o[j] > tp ? o[j] : tp; break; }
          }
        }
      } else if (md.kind === 'trail') {
        const last = e + md.T - 1;
        if (last < n) {
          let hh = h[e], stop = px - md.mult * a;
          exit = c[last];
          if (l[e] <= stop) exit = stop;
          else {
            for (let j = e + 1; j <= last; j++) {
              if (l[j] <= stop) { exit = o[j] < stop ? o[j] : stop; break; }
              if (h[j] > hh) { hh = h[j]; const ns = hh - md.mult * a; if (ns > stop) stop = ns; }
            }
          }
        }
      } else if (md.kind === 'ema10') {
        const last = e + md.T - 1, sl = px - md.sl * a;
        if (last < n) {
          exit = c[last];
          for (let j = e; j <= last; j++) {
            if (l[j] <= sl) { exit = j > e && o[j] < sl ? o[j] : sl; break; }
            if (j > e && c[j] < ema10[j]) { exit = c[j]; break; }
          }
        }
      } else if (md.kind === 'rsi60') {
        const last = e + md.T - 1, sl = px - md.sl * a;
        if (last < n) {
          exit = c[last];
          for (let j = e; j <= last; j++) {
            if (l[j] <= sl) { exit = j > e && o[j] < sl ? o[j] : sl; break; }
            if (rsi[j] >= 60) { exit = c[j]; break; }
          }
        }
      }
      if (!Number.isNaN(exit)) out[m][t] = exit / px - 1 - COST;
    }
  }
  return out;
}

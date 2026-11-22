"""
FVG + MACD firing within the same 1-3 trading days.

  node research/strategy-search/export-features.mjs     # production FVG + MACD flags per stock-day
  python3 research/strategy-search/fvg-macd-study.py

Legs (production detectors): FVG formed / retest (lib/fairValue.js, with its
displacement filter) and the same with the filter off ("0"); MACD bull cross
(histogram turns +), Turned Green (bull cross with the line < 0), zero-line
cross (line crosses 0 with histogram > 0). Combo fires on the day the second
leg fires if the other fired within the window (W=1 same day, W=2 within 1
session, W=3 within 2), in either order. First-day events, 10-session cooldown.
Outcome vm15b: next open -> close 15 sessions later, minus same-day stocks in
the same 5% volatility bucket. Winner screen is fixed in advance (see WIN below).
Null: FVG flags circularly shifted per symbol, same grid.
"""
import numpy as np, pandas as pd, os, itertools
here = os.path.dirname(__file__)
df = pd.read_csv(os.path.join(here, '..', '.out_feat.csv'))
df = df[(df.price >= 5) & (df.dollar_vol20 >= 5e6)].dropna(subset=['fwd15']).sort_values(['symbol', 'date']).reset_index(drop=True)
df['date'] = pd.to_datetime(df.date)
wl = {s.strip() for s in open(os.path.join(here, '..', '..', 'watchlist.txt')) if s.strip() and not s.startswith('#')}
df['wl'] = df.symbol.isin(wl).values
df['vd'] = df.groupby('date').vol60.rank(pct=True)
df['vb'] = (df.vd * 20).clip(upper=19.999).astype(int)
df['vm15b'] = df.fwd15 - df.groupby(['date', 'vb']).fwd15.transform('mean')
df['ex15'] = df.fwd15 - df.groupby('date').fwd15.transform('mean')
sym = df.symbol.values; N = len(df)
same = [np.r_[np.zeros(k, bool), sym[k:] == sym[:-k]] for k in (1, 2)]
def recent(f, W):  # fired today or within the previous W-1 sessions (same symbol)
    out = f.copy()
    for k in range(1, W): out |= np.r_[np.zeros(k, bool), f[:-k]] & same[k - 1]
    return out
yrs = df.date.dt.year.values; weeks = df.date.nunique() / 5
def events(c):
    idx = np.flatnonzero(c); keep = []; ls, li = None, -10**9
    for i in idx:
        if sym[i] == ls and i - li < 10: continue
        keep.append(i); ls, li = sym[i], i
    return np.array(keep, int)
def score(ix):
    e = df.iloc[ix]
    if len(e) < 40: return None
    d = e.groupby('date').vm15b.mean(); t = d.mean() / (d.std(ddof=1) / np.sqrt(len(d))) if len(d) > 2 else 0
    yr = e.groupby(e.date.dt.year).vm15b.mean(); r, w = e[~e.wl], e[e.wl]
    return dict(n=len(e), wk=len(e) / weeks, vm=e.vm15b.mean(), t=t, ex=e.ex15.mean(), raw=e.fwd15.mean(), up=(e.fwd15 > 0).mean(),
                yp=int((yr > 0).sum()), ny=len(yr), yr=yr, rest=r.vm15b.mean(), nr=len(r), wlv=w.vm15b.mean(), nw=len(w))

FVG = {k: df[k].values.astype(bool) for k in ('fvg_f', 'fvg_r', 'fvg_f0', 'fvg_r0')}
MACD = {k: df[k].values.astype(bool) for k in ('macd_bullx', 'macd_green', 'macd_zerox')}
CTX = {'none': np.ones(N, bool), 'above EMA200': (df.ema200_dist > 0).values, 'ADX>=20': (df.adx >= 20).values,
       'strong trend': ((df.ema200_dist >= 0.10) & (df.ret60 >= 0.10)).values}
WIN = lambda s, legs: s and s['t'] >= 2.5 and s['yp'] >= 8 and s['rest'] > 0 and s['wlv'] > 0 and s['nr'] >= 30 and s['nw'] >= 30 and all(s['vm'] > l['vm'] for l in legs if l)

def run(fvg_flags, label):
    res = []
    for (fn, F), (mn, Mc), W, (cn, C) in itertools.product(fvg_flags.items(), MACD.items(), (1, 2, 3), CTX.items()):
        combo = ((F & recent(Mc, W)) | (Mc & recent(F, W))) & C
        s = score(events(combo))
        if s: res.append((fn, mn, W, cn, s))
    return res

legs = {}
for cn, C in CTX.items():
    for k, F in {**FVG, **MACD}.items(): legs[(k, cn)] = score(events(F & C))
real = run(FVG, 'real')
rng = np.random.default_rng(7); shifted = {}
starts = np.flatnonzero(np.r_[True, sym[1:] != sym[:-1]]); ends = np.r_[starts[1:], N]
for k, F in FVG.items():
    g = np.empty_like(F)
    for a, b in zip(starts, ends):
        n = b - a; sh = int(rng.integers(int(n * 0.1), int(n * 0.9))) if n > 20 else 0; g[a:b] = np.roll(F[a:b], sh)
    shifted[k] = g
null = run(shifted, 'null')

def line(fn, mn, W, cn, s):
    return (f"{fn:6} + {mn:10} W={W} {cn:13}{s['n']:6d}{s['wk']:5.1f}{s['vm']*100:+7.2f}%{s['t']:5.1f}{s['ex']*100:+6.2f}%{s['raw']*100:+6.2f}%{s['up']*100:4.0f}  {s['yp']}/{s['ny']}  "
            f"REST {s['rest']*100:+.2f}%({s['nr']}) WL {s['wlv']*100:+.2f}%({s['nw']})")
hdr = f"{'combo':44}{'events':>6}{'/wk':>5}{'vm15b':>8}{'t':>5}{'ex15':>7}{'raw15':>7}{'%up':>4}  yrs+  universes"
print(f'{len(df):,} stock-days. Legs alone (benchmarks), by context:')
print(f"{'leg':20}" + ''.join(f'{c:>24}' for c in CTX))
for k in (*FVG, *MACD):
    print(f'{k:20}' + ''.join((f"{legs[(k,c)]['vm']*100:+.2f}% t{legs[(k,c)]['t']:.1f} n{legs[(k,c)]['n']}" if legs[(k, c)] else '-').rjust(24) for c in CTX))
vr, vn = np.array([s['vm'] for *_, s in real]), np.array([s['vm'] for *_, s in null])
tr, tn = np.array([s['t'] for *_, s in real]), np.array([s['t'] for *_, s in null])
print(f'\nGRID: {len(real)} combos with >= 40 events (null: {len(null)}).')
print(f'  vm15b  real: mean {vr.mean()*100:+.2f}%  median {np.median(vr)*100:+.2f}%  share > 0: {(vr>0).mean():.0%}   |   null: mean {vn.mean()*100:+.2f}%  share > 0: {(vn>0).mean():.0%}  95th pct {np.percentile(vn,95)*100:+.2f}%')
print(f'  t      real: share >= 2.5: {(tr>=2.5).mean():.0%}  max {tr.max():.1f}   |   null: share >= 2.5: {(tn>=2.5).mean():.0%}  max {tn.max():.1f}')
print('\nTOP 15 REAL COMBOS by t (vm15b vs same-volatility stocks):\n' + hdr)
for fn, mn, W, cn, s in sorted(real, key=lambda x: -x[4]['t'])[:15]: print(line(fn, mn, W, cn, s))
win = [(fn, mn, W, cn, s) for fn, mn, W, cn, s in real if WIN(s, [legs[(fn, cn)], legs[(mn, cn)]])]
print(f'\nWINNERS (t>=2.5, >=8/10 years +, both universes +, beats both legs): {len(win)}   |   null passing the same screen: {sum(1 for fn,mn,W,cn,s in null if WIN(s, [legs[(fn, cn)], legs[(mn, cn)]]))}')
for fn, mn, W, cn, s in win: print(line(fn, mn, W, cn, s) + '   by year ' + ' '.join(f'{v*100:+.1f}' for v in s['yr'].values))

"""
Tests a transparent "pullback in a strong trend" rule distilled from the
walk-forward LightGBM picks in rank-study.py (whose top-1% picks were: far above
EMA200, strong 60d return, short-term pullback below the ATR trailing stop /
RSI < 50 / MACD histogram < 0, ADX trending, volatile).

  python3 research/strategy-search/rule-study.py

Event = first day a stock meets the rule (not met the day before), then a
10-session cooldown. Outcome vm15b: next-open -> close+15 return minus the
same-day mean of stocks in the same 5% volatility bucket (strict beta control).
Caveat: the rule's shape was read off 2019-2026 model picks, so 2017-2018 is the
only window untouched by that design step.
"""
import numpy as np, pandas as pd, os, itertools
here = os.path.dirname(__file__)
df = pd.read_csv(os.path.join(here, '..', '.out_feat.csv'))
df = df[(df.price >= 5) & (df.dollar_vol20 >= 5e6)].dropna(subset=['fwd15']).copy()
df['date'] = pd.to_datetime(df.date)
wl = {s.strip() for s in open(os.path.join(here, '..', '..', 'watchlist.txt')) if s.strip() and not s.startswith('#')}
df['wl'] = df.symbol.isin(wl)
df['vd'] = df.groupby('date').vol60.rank(pct=True)
df['vb'] = (df.vd * 20).clip(upper=19.999).astype(int)
for h in (10, 15, 20):
    df[f'vm{h}b'] = df[f'fwd{h}'] - df.groupby(['date', 'vb'])[f'fwd{h}'].transform('mean')
    df[f'ex{h}'] = df[f'fwd{h}'] - df.groupby('date')[f'fwd{h}'].transform('mean')
df = df.sort_values(['symbol', 'date']).reset_index(drop=True)

PULL = {'below ATR stop': df.stop_dist < 0, 'RSI < 50': df.rsi < 50, 'MACD hist < 0': df.hist_atr < 0}
TREND = {'>=10% above EMA200': df.ema200_dist >= 0.10, '>=20% above EMA200': df.ema200_dist >= 0.20}
MOM = {'60d ret >= 10%': df.ret60 >= 0.10, '60d ret >= 20%': df.ret60 >= 0.20}
base = (df.adx >= 20) & (df.vd >= 0.70)  # trending + top-30% volatility

def events(cond):
    c = cond.fillna(False).values
    sym = df.symbol.values
    prev = np.r_[False, c[:-1]] & (np.r_['', sym[:-1]] == sym) if False else np.r_[False, c[:-1] & (sym[:-1] == sym[1:])]
    first = c & ~prev
    idx = np.flatnonzero(first); keep = []; last_sym, last_i = None, -10**9
    for i in idx:
        if sym[i] == last_sym and i - last_i < 10: continue
        keep.append(i); last_sym, last_i = sym[i], i
    return df.iloc[keep]

def summ(e, col='vm15b'):
    d = e.groupby('date')[col].mean()
    t = d.mean() / (d.std(ddof=1) / np.sqrt(len(d))) if len(d) > 2 else np.nan
    return e[col].mean(), t

print(f"{'rule':62}{'events':>7}{'/wk':>5}{'vm15b':>8}{'t':>6}{'ex15':>7}{'raw15':>7}{'%up':>5}   vm15b by year 2017..2026                         REST / WL vm15b (n)")
rows = []
for (pn, p), (tn, t), (mn, m) in itertools.product(PULL.items(), TREND.items(), MOM.items()):
    e = events(base & p & t & m)
    if len(e) < 50: continue
    vm, tt = summ(e); yr = e.groupby(e.date.dt.year).vm15b.mean()
    weeks = df.date.nunique() / 5
    rest, w = e[~e.wl], e[e.wl]
    pos_years = (yr > 0).sum()
    name = f'{pn} + {tn} + {mn}'
    print(f'{name:62}{len(e):7d}{len(e)/weeks:5.1f}{vm*100:+7.2f}%{tt:6.1f}{e.ex15.mean()*100:+6.2f}%{e.fwd15.mean()*100:+6.2f}%{(e.fwd15>0).mean()*100:5.0f}   ' + ' '.join(f'{v*100:+.1f}' for v in yr.values) + f'   {rest.vm15b.mean()*100:+.2f}%({len(rest)}) / {w.vm15b.mean()*100:+.2f}%({len(w)})  [{pos_years}/{len(yr)} yrs +]')

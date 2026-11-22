"""
Cross-sectional ranking study for MACD / RSI / ATR features.

  python3 research/strategy-search/rank-study.py          (after export-features.mjs)

Question: on any given day, does ranking stocks by MACD/RSI/ATR features pick ones
that beat comparable stocks over the next 15 sessions?
Target `vm15`: next-open -> close+15 return minus the same-day mean of stocks in
the same 60-day-volatility quintile (so high-beta names can't fake an edge).
Per-feature: daily Spearman IC and top-decile excess; t-stats use every 15th day
(non-overlapping outcomes). Combined: walk-forward by calendar year, each test
year scored by models trained only on data ending 20 sessions before it.
"""
import numpy as np, pandas as pd, sys, os
import lightgbm as lgb

path = os.path.join(os.path.dirname(__file__), '..', '.out_feat.csv')
df = pd.read_csv(path)
df = df[(df.price >= 5) & (df.dollar_vol20 >= 5e6)].dropna(subset=['fwd15']).copy()
df['date'] = pd.to_datetime(df['date'])
wl = {s.strip() for s in open(os.path.join(os.path.dirname(__file__), '..', '..', 'watchlist.txt')) if s.strip() and not s.startswith('#')}
df['wl'] = df.symbol.isin(wl)

# targets
df['vq'] = df.groupby('date').vol60.transform(lambda x: pd.qcut(x.rank(method='first'), 5, labels=False))
for h in (10, 15, 20):
    df[f'ex{h}'] = df[f'fwd{h}'] - df.groupby('date')[f'fwd{h}'].transform('mean')
    df[f'vm{h}'] = df[f'fwd{h}'] - df.groupby(['date', 'vq'])[f'fwd{h}'].transform('mean')

IND = ['rsi', 'rsi_chg5', 'hist_atr', 'macd_atr', 'sig_atr', 'hist_slope3', 'stop_dist', 'atr_pct', 'atr_chg20', 'adx', 'adx_chg5', 'ema200_dist', 'score']
RET = ['ret5', 'ret20', 'ret60']
ALL = IND + RET + ['vol_ratio']
dates = np.sort(df.date.unique())
step_days = set(dates[::15])  # non-overlapping 15-session outcomes

def nonoverlap_t(daily):  # daily: Series indexed by date
    s = daily[daily.index.isin(step_days)].dropna()
    return s.mean() / (s.std(ddof=1) / np.sqrt(len(s))) if len(s) > 2 else np.nan

print(f'{len(df):,} stock-days, {df.symbol.nunique()} stocks, {pd.Timestamp(dates[0]).date()} -> {pd.Timestamp(dates[-1]).date()}')
print('\n=== 1. SINGLE FEATURES: daily rank IC vs vm15, and top/bottom decile vm15 (t on non-overlapping days) ===')
print(f"{'feature':14}{'IC':>8}{'t':>7}   {'top10% vm15':>12}{'t':>7}{'bottom10%':>11}{'t':>7}   top-decile vm15 by year 2017..2026")
g = df.groupby('date')
rk = {f: g[f].rank(pct=True) for f in ALL}
for f in ALL:
    tmp = pd.DataFrame({'date': df.date, 'r': rk[f], 'y': df.vm15}).dropna()
    ic = tmp.groupby('date').apply(lambda x: x.r.corr(x.y.rank(pct=True)) if len(x) > 30 else np.nan, include_groups=False)
    top = tmp[tmp.r > 0.9].groupby('date').y.mean(); bot = tmp[tmp.r <= 0.1].groupby('date').y.mean()
    yr = top.groupby(pd.DatetimeIndex(top.index).year).mean()
    print(f'{f:14}{ic.mean():8.4f}{nonoverlap_t(ic):7.1f}   {top.mean()*100:+11.2f}%{nonoverlap_t(top):7.1f}{bot.mean()*100:+10.2f}%{nonoverlap_t(bot):7.1f}   ' + ' '.join(f'{v*100:+.1f}' for v in yr.values))

# ── walk-forward models ──
for f in ALL: df['r_' + f] = rk[f] - 0.5
df['y'] = df.groupby('date').vm15.rank(pct=True) - 0.5  # rank target: robust to outliers
years = sorted({d.year for d in pd.DatetimeIndex(dates)} - {2016, 2017, 2018})
def walk(feats, kind):
    preds = []
    for Y in years:
        test = df[df.date.dt.year == Y]
        cut = pd.Timestamp(f'{Y}-01-01'); tr_end = dates[max(0, np.searchsorted(dates, np.datetime64(cut)) - 20)]
        train = df[df.date < tr_end]
        X, y = train[['r_' + f for f in feats]].fillna(0).values, train.y.values
        Xt = test[['r_' + f for f in feats]].fillna(0).values
        if kind == 'linear':
            w, *_ = np.linalg.lstsq(np.c_[X, np.ones(len(X))], y, rcond=None); p = np.c_[Xt, np.ones(len(Xt))] @ w
        else:
            params = dict(objective='regression', learning_rate=0.03, num_leaves=15, min_data_in_leaf=2000, bagging_fraction=0.7, bagging_freq=1, feature_fraction=0.8, verbose=-1, seed=1)
            m = lgb.train(params, lgb.Dataset(X, y), num_boost_round=200); p = m.predict(Xt)
        preds.append(pd.Series(p, index=test.index))
    return pd.concat(preds)

print('\n=== 2. WALK-FORWARD COMBINED SCORE (each year scored by a model trained only on earlier years) ===')
print('Picks: each day the top 10% / top 1% (the "only strong" bar) by score. vm15 = excess vs same-vol stocks, ex15 = vs all stocks.')
print(f"{'features / model':30}{'top10% vm15':>12}{'t':>6}{'ex15':>8}{'top1% vm15':>12}{'t':>6}{'picks/day':>10}   top10% vm15 by year {years[0]}..{years[-1]}     WL-only top10%")
for name, feats in (('indicators only', IND), ('returns only', RET), ('all', ALL)):
    for kind in ('linear', 'lgbm'):
        s = walk(feats, kind)
        d = df.loc[s.index, ['date', 'vm15', 'ex15', 'wl']].assign(s=s, q=s.groupby(df.loc[s.index, 'date']).rank(pct=True))
        t10, t1 = d[d.q > 0.9], d[d.q > 0.99]
        a = t10.groupby('date').vm15.mean(); b = t1.groupby('date').vm15.mean(); e = t10.groupby('date').ex15.mean()
        yr = a.groupby(pd.DatetimeIndex(a.index).year).mean()
        w = t10[t10.wl].vm15.mean()
        print(f'{name + " / " + kind:30}{a.mean()*100:+11.2f}%{nonoverlap_t(a):6.1f}{e.mean()*100:+7.2f}%{b.mean()*100:+11.2f}%{nonoverlap_t(b):6.1f}{len(t1)/t1.date.nunique():10.1f}   ' + ' '.join(f'{v*100:+.1f}' for v in yr.values) + f'     {w*100:+.2f}% ({t10.wl.sum()})')
        y1 = b.groupby(pd.DatetimeIndex(b.index).year).mean(); n1 = t1.groupby(t1.date.dt.year).size()
        print(f"{'':30}top1% by year: " + ' '.join(f'{yy}:{v*100:+.1f}%({n1[yy]})' for yy, v in y1.items()) + f'   WL-only top1%: {t1[t1.wl].vm15.mean()*100:+.2f}% ({t1.wl.sum()})')

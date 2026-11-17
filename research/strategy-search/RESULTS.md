# Strategy search — results (2026-11-17)

Method and caveats: see [PLAN.md](./PLAN.md). Reproduce:

```bash
export NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt   # only needed in the cloud sandbox
node research/fetch-universe.mjs --tickers=<570 symbols> --out=research/long_daily.db --days=2600
node research/fetch-4h-watchlist.mjs --tickers=research/watchlist_qqq_tickers.txt --out=research/long_4h.db
node research/strategy-search/search.mjs --db=research/long_daily.db --label=daily
node research/strategy-search/search.mjs --db=research/long_daily.db --label=daily-null --null --seed=7
node research/strategy-search/dip-study.mjs
```

Daily: 563 symbols, 1.4M bars, 2016-07 → 2026-11 (train < 2022-09-26 ≤ validate < 2024-10-21 ≤ test).
4H: 171 symbols, ~2y (train < 2026-01-22 ≤ validate < 2026-06-24 ≤ test).
80 flags → 43,575 daily combos × 10 exit models = 435,750 cells tested.

## Bottom line

**80% closed-positive is reachable, but it is a market-regime effect plus a
payoff trick, not a stock-picking edge — and it is not reliably 80%.**

## 1. What the search found

| | real | null (flags shifted) |
|---|---|---|
| daily cells ≥80% win in **both** train and validate | **54** | 3 |
| daily cells ≥75% | 724 | 151 |
| daily cells ≥70% | 7,572 | 4,256 |
| 4H cells ≥80% | 37 | 2 |

So the 80% cells are not pure luck (about 18× more than the null) — but see 2.

## 2. Why: it is one ingredient, not 54 strategies

Of the 51 daily 80%+ cells in the saved top-500, **50 contain a market-dip
filter (SPY RSI(14) < 40)** and **48 use the 1×ATR target / 3×ATR stop exit**.
The stock-level triggers (stoch cross, inside-day break, NR7 break, MACD turn…)
are interchangeable.

That exit is the second ingredient: with a target one ATR away and a stop three
ATR away, the *average stock on a random day* already "wins" **68–69%** of the
time (all stocks, train/test: 68.9% / 67.7%). A high win rate under that exit
mostly measures the exit. Mean return after costs is small (+0.8% to +1.7% per
trade).

`dip-study.mjs` isolates the regime. 44 independent market-dip episodes since 2016
(runs of SPY RSI<40, merged within 5 sessions). Exit = 1×ATR target / 3×ATR stop:

| entry | n | win | mean | episodes ≥50% win | episodes ≥80% win |
|---|---|---|---|---|---|
| every stock, every non-dip day | — | 68% | — | — | — |
| every stock, every dip day | 132,166 | **75%** | +0.83% | 44 / 44 | 21 / 44 |
| any stock-level trigger on a dip day | 14,464 | 76% | +0.97% | 44 / 44 | 21 / 44 |
| stoch cross up | 9,827 | 78% | +1.39% | 43 / 43 | 24 / 43 |
| inside-day break | 1,761 | 80% | +1.48% | 37 / 38 | 19 / 38 |
| NR7 break | 2,253 | 78% | +1.66% | 35 / 36 | 20 / 36 |

- Stock-level triggers add 1–5 points of win rate over "buy anything while the
  market is oversold". The regime does the work.
- It held in every one of 44 episodes at >50%, but 80%+ in only about half.
  Worst case: the 2020 crash (2020-02-24→03-25) won only **61%**; 2018-12 70%,
  2022 bear legs 69–70%, 2026-03 68%.
- The honest sample size is ~44 episodes in 10 years (~4 per year), not 132k trades.
  Hundreds of stocks bouncing off one market low are one bet.
- Hold-10-days instead of the bracket drops the same entries to 57–64% win.
  Same signals, different exit, no 80%.

## 3. Out-of-sample (test slice, never used to select)

Top 100 daily "win-rate hunt" cells (ranked on train+validate): 89 kept ≥70% win
in test, **19 kept ≥80%** (null: 38 and 7). Typical test excess return over the
same-day average stock is ~0 to +1% — the win rate holds, the *edge over just
being long* mostly doesn't.

## 4. Anything real at the stock level?

One family keeps positive excess return in train, validate **and** test with no
market filter and not via the win-rate bracket: **oversold bounce in high-volatility
stocks** (ATR/close > 3%), e.g.

| combo | exit | win tr/va/te | excess tr/va/te | n_test | PF_test |
|---|---|---|---|---|---|
| BB lower-band touch + above 200 + highVol | hold 20 | 60/59/53 | +1.5/+1.6/+1.3% | 1,208 | 1.56 |
| BB lower + BB width low + highVol | 3×ATR trail | 51/49/48 | +1.4/+2.6/+2.7% | 1,023 | 1.99 |
| RSI(2)<5 + 10d momentum up + highVol | 3×ATR/2×ATR bracket | 51/61/57 | +1.8/+2.8/+1.4% | 317 | 1.79 |

These are **mean-return edges at 50–60% win rates**, the opposite of the 80%
goal. Caveat: "excess" is vs the same-day average stock, not beta-adjusted, so
part of it is high-vol stocks simply having higher beta in a rising market.

## 5. 4H

Same shape, weaker. 37 cells ≥80% (null 2), again all through the market-dip
filter. Among the top-100 "robust edge" cells only **3** kept positive excess in
test (null 37) — no reliable stock-level 4H edge. Only ~2 years of data (Yahoo's
hourly limit), so very few independent dips.

## Biases that flatter every number above

1. **Survivorship**: the universe is today's S&P 500 / Nasdaq-100 / watchlist.
   Dip-buying wins more when the stocks that never recovered are missing.
2. **Fixed regime mix**: 10 years that include a long bull market.
3. **Multiple comparisons**: 435k cells. The null run quantifies it; selection
   used a train/validate split and the test slice is reported, not tuned on.
4. **Bar-level fills**: stop-before-target inside a bar, gaps fill at the open,
   0.1% round trip. No slippage model, no position limits (a dip has hundreds
   of simultaneous signals; a real account can't take them all).

## What I'd do next (not done)

- Turn the dip regime into a *portfolio* study: cap concurrent positions
  (e.g. 10), pick by trigger, simulate equity and drawdown — that is what a
  TradingView strategy report would show, and it is where the 61% COVID
  episode would hurt.
- Add a regime-level metric: win rate per dip episode as the unit, not per trade.
- Validate the dip rule on `data/bars.db` (the production watchlist alone) before
  any Telegram use, per the CLAUDE.md rule. Not done here.
- Try a de-survivored universe if a delisted-symbols source is available.

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

---

# Part 2 — portfolio-level tests (2026-11-18)

Per-signal statistics above ignore position caps and clustering. `portfolio.mjs`
(563 symbols, K equal slots, next-open fills, 0.05%/side) and `rotation.mjs`
(47 ETFs, monthly) judge strategies the way a TradingView strategy report does.
Window 2017-07 → 2026-11; train/val/test = 60/20/20 of the date range.

| Strategy | CAGR | Sharpe | Max DD | Test CAGR |
|---|---|---|---|---|
| **SPY buy & hold** | 12.5% | 0.73 | −34% | 12.1% |
| Equal-weight universe (survivor-biased) | 16.2% | 0.87 | −38% | 15.9% |
| SPY only above 200d | 7.6% | 0.66 | −21% | 8.2% |
| **A. Dip bounce** (SPY RSI<40 + trigger), K=10, best of 6 variants | 4.3% | 0.31 | −53% | 10.1% |
| Dip bounce, any variant (K=5/10/20, 3 exits) | −0.4% … 4.6% | 0.05 … 0.35 | −30% … −55% | |
| SPY + dip overlay (idle cash in SPY), best | 13.9% | 0.67 | −53% | 16.7% |
| **C. RSI(2)<10 pullback in above-200d stocks** | 4.4% … 12.2% | 0.35 … 0.63 | −29% … −36% | −11% … +21% |
| **B. 12-1 momentum, top 10–40 stocks, monthly** | 28% … 50% | 0.93 … 1.15 | −40% … −48% | 31% … 72% |
| **ETF rotation, best (top-3, 12-1 momentum)** | 17.4% | 0.71 | −35% | 20.1% |
| ETF rotation, other scores / K / filters | −6% … 15% | −0.06 … 0.72 | −31% … −72% | |

## Reading it

1. **The dip bounce does not work as a portfolio.** +1% per signal does not
   survive position caps: dips cluster, positions pile in together and take
   the same crash. 0–5% CAGR, drawdowns 30–55%. Adding it on top of SPY lowers
   Sharpe (0.67 vs 0.73) and deepens drawdown (−53% vs −34%). (An earlier run on
   60 symbols looked better — a sign of how fragile it is to the universe.)
2. **RSI(2) pullbacks** are the same story as the web research found for
   indices: ~63–65% win rate, tiny edge per trade, trails buy-and-hold.
3. **Stock momentum looks spectacular and is the least trustworthy number
   here.** The universe is *today's* index members plus a watchlist chosen with
   hindsight; 12-1 momentum picks exactly the names that went on to be in the
   index today (2024: +98%, 2025: +78% yearly returns in the top-20 variant).
   Equal-weight universe already earns 16% vs SPY 12.5% from the same bias. The
   momentum premium is real in the literature, but this test cannot size it.
4. **The clean test says rotation does not beat SPY.** On a mostly
   survivorship-free ETF universe, the best configuration (17.4% CAGR, Sharpe
   0.71) is no better risk-adjusted than SPY (0.72); most variants are worse and
   top-1 rotation is a disaster (−6% to +8% CAGR, −48% to −72% drawdown). Results
   swing widely with the momentum definition — a sign of noise, not edge.
5. **Absolute/regime filters** (SPY>200d) reduced returns more than drawdown in
   every family here.

## Verdict

No strategy found that beats buy-and-hold SPY after realistic constraints and
bias control. Nothing here is ready for the Telegram report.
What is real: markets bounce after sharp dips (per-signal), momentum has a
documented premium (unmeasurable on this data). Next step that could change the
answer: a **point-in-time** stock universe (historical index membership,
including delisted names) to size momentum without survivorship.

---

# Part 3 — sell-side signals (2026-11-21)

Question: can mirrors of the shipped buy signals be shipped as SELL signals?
`sell-signals.mjs` scores 18 candidates (bearish divergence, MACD turning red,
RSI reject from 70 / cross 50 down, ATR trailing-stop breakdown, 20d VWAP loss,
bearish FVG formed/retest, and gated variants) as forward return 10/15/20
sessions later **in excess of the same-day average stock**, one event per
episode, in time thirds. A working sell signal needs *negative* excess,
consistently. `features.mjs` gained `macdRed`, `atrBreakdown`, `vwapLoss20`.

| Test set | Result |
|---|---|
| Watchlist, `data/bars.db`, ~19 months | No signal negative in all three thirds with usable n; several positive (e.g. MACD Red + ADX≥25: +1.1% at 15d) |
| 563-symbol universe, 10 years | Best: Bearish Divergence −0.21% at 15d (t −3.6), MACD Red −0.10%, ATR breakdown below EMA200 −0.18%. All ≤ 0.2% — and the raw return after the signal is still **+0.5% to +0.7%** (stocks rise ~55% of the time after a "sell") |
| Watchlist symbols, 10 years | **Every** sell signal has positive excess: RSI reject from 70 +1.45% (t 7.1), bearish FVG formed +0.90%, VWAP loss +0.70%, MACD bear cross +0.67% at 15d |

## Verdict
Do not ship. On the watchlist, stocks that trigger a "sell" signal go on to
*outperform* the average stock; on the broad universe the effect is a fifth of a
percent over 3 weeks, far below any cost or a short's borrow/risk. As exit
warnings they also lose to simply holding. (Part of the watchlist result is
hindsight selection and momentum continuation in a bull market, which makes a
sell signal look worse here than it would elsewhere — but nothing suggests an
edge.) If re-tested later, use `sell-signals.mjs`, and require negative excess
in all three thirds on the watchlist itself.

---

# Part 4 — the two SHIPPED signals on 10 years / last 2 years (2026-11-21)

`sell-signals.mjs --buy [--watchlist-only] [--since=YYYY-MM-DD]`. Flags approximate
the production detectors (single-bar flags + one event per 10 sessions; not a
replay of `lib/report.js`), excess = vs same-day average stock, 15 sessions.

| Signal | 563 stocks, 10y | Watchlist, 10y | Watchlist, last 2y |
|---|---|---|---|
| Bullish Divergence + ADX≥20 | +0.31% (t 2.2), positive in all 3 thirds | +1.18% (t 2.6), all 3 thirds | +2.18% (t 2.1) |
| MACD Green + ADX≥25 | **−0.23% (t −2.3)** | +0.46% (t 1.0) | +0.79% (t 1.5) |
| hidden: MACD Positive + ADX≥25 | −0.29% | +0.01% | **−4.69% (t −2.5)** |
| hidden: Volume Surge 1.75x | 0.00% | +1.14% (t 6.0) | +2.01% (t 4.4) |

Reading: Divergence holds up (modest broadly, larger on the watchlist). MACD
Green + Strong Trend shows no edge beyond market drift on the broad universe.
Hiding MACD Positive is supported. Volume Surge looks strong only on the
hindsight-picked watchlist and is zero on the broad universe — not a reason to
reverse the 2026-11-12 decision.

---

# Part 5 — exact production replay + discovery on 10 years (2026-11-21)

**Exact replay** (`research/reassess.mjs --db=research/long_daily.db [--watchlist-only]
--from=2017-06-01 --live-start=2020-12-01 --oos-start=2023-12-01`; the script now
takes `--db` and `--watchlist-only`). 15d excess vs same-day average stock, by
window 2017-20 / 2020-23 / 2023-26:

| Signal | Universe (563) | Watchlist |
|---|---|---|
| Bullish Divergence + Strong Trend [shown] | +0.9 / +0.1 / +0.1% (pooled +0.3%, CI > 0) | +1.3 / −0.9 / +0.5% mixed |
| MACD Green + Strong Trend [shown] | **−0.2 / −0.2 / −0.2%**, negative in all | +0.4 / +0.6 / **−0.8%** (CI < 0 in latest) |
| RSI≥70 + VWAP Reclaim [hidden] | +0.4 / +1.4 / +0.6%, positive in all (n 65–104) | +2.0 / +4.4 / +3.1%, positive in all (n 19–22) |
| MACD Turned Positive [hidden] | mixed | **negative in all** (−1.3% pooled, CI < 0) |
| Volume Surge [hidden] | ~0 | +0.1 / +0.4 / +0.3% |

**Discovery** (`research/discover.mjs --db=REST=research/d10_rest.db
--db=WL=research/d10_wl.db [--vol-matched]`): two disjoint universes (446
non-watchlist stocks / 123 watchlist), 29 signals, BH correction, pre-specified
winner screen. New `--vol-matched` flag measures excess against same-day stocks
in the same 60d-volatility quintile, so high-beta names can't fake an edge.

- Standard baseline: **2 winners**, both from strategy-search part 1 — oversold
  (RSI(2)<5 or close ≤ lower BB) in an above-EMA200 stock with ATR% > 3%:
  +0.7–0.9% 15d excess, positive in every third of both universes, q ≤ 0.015.
  The same setup in low-volatility stocks (control) is ~0.
- Volatility-matched baseline: **0 winners.** The same two drop to +0.4–0.5%,
  q ≈ 0.13 / 0.97, and the broad-universe thirds go +1.6 / +0.3 / +0.1% — about
  half the edge was volatility exposure and the rest has faded to ~0 since 2020.
- Momentum/breakout *events* (RS new high, 126/252d highs, squeeze breaks,
  top-momentum entry) are flat to negative at 2–4 weeks in both universes —
  consistent with short-term reversal; momentum's documented premium is a
  3–12 month holding effect, not a breakout-day signal.

Conclusion: on daily price/volume data at a 2–4 week horizon there is no
signal that clears a "strong" bar. MACD Green + Strong Trend should be removed;
Bullish Divergence is weak and fading.

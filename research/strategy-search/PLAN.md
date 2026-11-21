# Strategy search — plan

Goal: mimic TradingView's strategy tester at scale. Take a big pool of
indicator-based entry flags, try every combination (trigger + up to 2 filters),
pair each with a set of exit rules, and find what closes positive ≥ 80% of the
time — then find out how much of that is real.

Research only. Nothing here touches `scan_headless.js`, `lib/`, or the Telegram
report. Findings go in `RESULTS.md`; anything shipped later follows the
"Adding new signals" flow in `CLAUDE.md` (validate on `data/bars.db` first).

## Data
- Daily: ~10y for watchlist ∪ Nasdaq-100 ∪ S&P 500 (~570 symbols) → `research/long_daily.db`
- 4H: ~2y (Yahoo's hourly ceiling) for watchlist ∪ Nasdaq-100 → `research/long_4h.db`
- Caveat baked into every number: universe = **today's** index members, so
  survivorship flatters long win rates. We always score against the same-day
  average stock under the same exit rule ("excess"), which cancels most of it.

## Search space
- ~75 flags (`flags.mjs`): trend/state filters, oscillator events, pullback and
  candle patterns, volatility squeeze, breakouts, market-regime (SPY) filters,
  plus rules lifted from popular TradingView strategies (Supertrend flip,
  Connors RSI(2)/IBS, BB lower-band reclaim, Squeeze release, EMA 9/21 cross,
  stoch/CCI/MFI oversold turns, Donchian/52w breakouts).
- Flags auto-split by frequency: **triggers** (fire ≤ 8% of bars) and
  **filters** (states). Combos = trigger + 0–2 filters, or 2 triggers + 0–1 filter.
- Entry: signal on bar close, fill at next open, 0.1% round-trip cost.
- 10 exit models: fixed hold 5/10/20, four ATR take-profit/stop brackets
  (incl. a deliberately win-rate-inflating 1×ATR target / 3×ATR stop, to show
  what 80% "wins" cost), 3×ATR chandelier trail, close<EMA10, RSI≥60 mean-revert.
- Bitset AND per combo, so millions of (combo × exit) cells run in minutes.

## Judging (what keeps it honest)
1. Chronological split: train 60% / validate 20% / **test 20% (never used to
   pick)**. A candidate must hold in train *and* validate independently.
2. Episode de-dup (re-fires within 10 bars of the same symbol count once);
   minimum episodes and distinct dates, so one crash day isn't "300 signals".
3. Report win rate **and** mean return, profit factor, excess vs same-day
   baseline, and the baseline win rate for that exit — 80% means little if the
   baseline is 70%.
4. **Null calibration**: rerun the identical search with every symbol's flags
   circularly shifted by a random offset (keeps flag frequencies and joint
   structure, breaks the link to returns). The number of "80% combos" that
   shows up there is the number we'd expect by luck.
5. Final cross-check of survivors on the watchlist alone, and on 4H.

## Order of work
1. Fetch data (daily 10y, 4H 2y).
2. `flags.mjs`, `exits.mjs`, `search.mjs` + smoke test on a small slice.
3. Full daily run → null run → compare.
4. 4H run.
5. Write `RESULTS.md`: what's real, what's luck, and the best honest candidates.

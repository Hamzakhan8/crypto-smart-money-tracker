# Experiments (pre-registration log)

Rules (docs/SPEC.md, evidence rule 3): every test is written here and **committed before it is run**. Results cite that
commit. This file is append-only: old entries are never edited; corrections are new entries. Every variant tried
increments the trial counter, and confidence intervals are corrected for the number of trials (Bonferroni).

**Trial counter: 48** (8 run in Phase 3; 40 reserved by E006 for v0.3, counted whether or not each is reached)

---

## Shared definitions, version 1 (frozen 2026-11-12, before any result was computed)

### D1. Data
- Source: Binance USD-M perpetual archive, https://data.binance.vision (`data/futures/um/...`). Every file is checked
  against Binance's own `.CHECKSUM` (sha256) and listed with its sha256 in `docs/replay-dataset-manifest.json`. The
  sha256 of that manifest is the "dataset manifest hash" in every receipt.
- Files: 1m klines (monthly), 1d klines (monthly, all USDT perpetuals in the archive listing, delisted included, for the
  universe), BTCUSDT 1h klines from 2024-01 (regime), fundingRate (monthly), bookDepth (daily file of the 15th of each
  month, for the cost model), and current USD-M exchangeInfo (contract type, tick size; saved and hashed).
- Phase 3 scope: Binance USD-M perpetuals only. Spot, Bybit and OKX are not in this replay (no free historical depth for
  Binance spot; Bybit/OKX later).

### D2. Period and split
- Development period: 2025-01-01T00:00Z to 2026-06-30T23:59Z (18 months). Phase 3 uses only this period.
- Walk-forward folds for reporting: the 6 calendar quarters 2025Q1 ... 2026Q2.
- **Holdout: 2026-07-01 to 2026-10-31. Not downloaded and not evaluated in Phase 3.** It is opened once, in Phase 4,
  after the design is frozen with a git tag.
- Warm-up data (features only, never evaluated): December 2024 1m klines; BTCUSDT 1h klines from 2024-01-01.

### U1. Universe (as of each month start, no survivor bias)
At 00:00 UTC on the first day of month M, from all USDT perpetuals in the archive listing: keep symbols with at least 20
daily candles in the 30 days before M; drop bases in the engine's `Symbols.EXCLUDED_BASES`, symbols whose current
exchangeInfo contract type is `TRADIFI_PERPETUAL`, and symbols whose median weekend daily quote volume is below 35% of the
median weekday volume in those 30 days (tokenized stocks / commodities; rule from this repo's perps-history.ts). Rank by
quote volume summed over the 30 days before M; keep the top 30. BTCUSDT is always included. A symbol delisted later
stays in while it qualifies.

### B1. Bars and as-of times
- 5-minute bars are built from 1m klines on UTC 5-minute boundaries; a bar exists only if all 5 minutes exist.
- A bar is known at its close (open + 5 min). Signals are evaluated at bar close t using bars up to and including that
  bar only. Features use the engine's `Features.compute` (ATR20 = mean true range of the 20 bars before the signal bar).

### L1. Outcome: triple barrier (primary setting fixed: N = 30 minutes, width = 1 ATR)
- Barrier width = 1.0 x ATR20 (5m bars, as of t) in price units, around the entry price.
- Entry delays after t: **2 minutes (primary)**, 0 s, 30 s, 5 minutes.
  - 0 s / 2 min / 5 min: entry at the open of the 1m candle starting at t / t+2m / t+5m; barriers are checked on that
    minute and the following ones, 30 minutes in total.
  - 30 s: entry at the VWAP (quote volume / volume) of the 1m candle starting at t (assumption: a fill somewhere in that
    minute); barriers are checked from the next minute on, 30 minutes in total.
- First barrier hit wins: favorable = WIN (exit at the barrier), adverse = LOSS (exit at the barrier). Both barriers
  inside the same 1m candle: order unknown, counted as **LOSS** (conservative) and flagged "ambiguous". Neither within
  30 minutes: TIMEOUT, exit at the close of the last minute.
- Any missing 1m candle between entry and the end of the window: INVALID (excluded, counted).
- Also recorded: max favorable and max adverse move (fractions of entry) and minutes to the max favorable move.

### K1. Costs (per side, fractions of notional; trade sizes $1,000 and $10,000)
- Taker fee 0.05% per side (Binance USD-M regular tier; source in DATA_INVENTORY.md).
- Half-spread = 0.5 x tick size / price; tick size from the saved exchangeInfo (assumption: unchanged over the period).
  Symbols without exchangeInfo: 0.01% per side (assumption, flagged).
- Slippage, linear book within 1%: 0.5% x size / D, where D = median notional within 1% on the side traded (asks for a
  buy, bids for a sell) in the bookDepth file of the most recent sampled day (the 15th) **strictly before** the signal
  date. No sample before the signal date: the trade has no cost estimate and is excluded from net results (counted).
- Entry and exit each pay fee + half-spread + slippage (barrier exits assumed filled at the barrier price before costs).
- Funding: for every funding settlement in (entry time, exit time], the position pays sign x rate x notional (a long
  pays a positive rate, a short receives it), rates from the fundingRate archive.
- Net return = gross return - all costs.

### H1. BTC-hedged return
hedged = sign x [(exit/entry - 1) - beta x (BTC_exit/BTC_entry - 1)], BTCUSDT prices at the same times (open of the entry
minute; close of the exit minute). beta = OLS slope of the coin's 5m returns on BTC's over the 288 bars (24 h) before
the signal bar, at least 200 pairs, else the hedged value is missing (counted). BTCUSDT: beta = 1. Hedged net = hedged -
the coin's own costs (the hedge leg's costs are not added).

### E1. Independent events
1. Same symbol, same rule, same move direction within 60 minutes after an earlier signal: same event. Only the first
   signal of an event is traded.
2. First signals from 5 or more different symbols (same rule) in the same 15-minute UTC bucket form one market-wide
   event; its result is the mean of its members.
3. Independent events = single-symbol events outside market events + market events. All statistics are per event.

### R1. Matched random baseline
For each traded signal (symbol, time, trade direction): 5 random 5m bar-close times on the same symbol and the same UTC
day, excluding times within 60 minutes of any signal of that symbol under the same rule; same labeler, direction,
delay, size and costs. Lift of an event = event net return - mean net return of its matched randoms (for market events,
averaged over members). Signals with no eligible random time are dropped from lift (counted). RNG seed 20261112.

### S1. Statistics
Mean per independent event. 95% confidence interval by day-block bootstrap: resample UTC days with replacement,
B = 2000, seed 20261112. Adjusted interval: Bonferroni, two-sided level 1 - 0.05 / T, T = trial counter at analysis
time. Fewer than 100 independent events = INCONCLUSIVE.

### G1. Regime (defined before testing, never changed after)
Per UTC day, from BTCUSDT 1h closes up to the end of the previous day: r7 = 7-day return; v7 = standard deviation of
hourly log returns over the last 7 days. Tercile cut points = 33rd and 67th percentiles of all daily values from
2024-01-08 up to the previous day (expanding, as of). Regime = r7 tercile x v7 tercile (9 cells).

### P1. Placebo tests (sanity checks, not trials)
On rules A and C, CONTINUE, 2-min delay, $1,000:
- **Time shift**: each traded signal moved to the same time of day on a random other day 1-14 days earlier or later
  (same symbol, inside the development period, in a month where the symbol is in the universe), direction kept;
  matched randoms drawn on the new day.
- **Shuffled labels**: within each UTC day, outcomes randomly permuted between real signals and their matched randoms.
- **Random symbol**: each signal's symbol replaced by a random other symbol of that month's universe, same time and
  direction, matched randoms on the new symbol; judged on BTC-hedged net lift (the raw version is also reported).
- Pass: the unadjusted 95% interval of mean lift contains 0. A failing placebo = suspected leakage: fixed before any
  baseline is reported as valid.

### Receipts
Every reported number states: command, code commit, this pre-registration commit, dataset manifest sha256, number of
independent events.

---

## E001. Baseline A: naive "moved X% in the window" scanner (trials 1 and 2)
- Rule A: a 5m bar with |close / previous close - 1| >= 2.0%. No gates.
- Trial 1: CONTINUE (trade in the move's direction). Trial 2: REVERT (trade against it).
- Metric: mean net lift over the matched random baseline per independent event, 2-min delay, $1,000, raw and BTC-hedged.
  Also reported: 0 s / 30 s / 5 min delays, $10,000, win / loss / timeout / ambiguous / invalid rates, gross and net
  returns, MFE / MAE / time to peak, per fold, per regime cell, per symbol tier (volume rank 1-10 vs 11-30), up vs down.
- Verdict for a baseline: INCONCLUSIVE if fewer than 100 independent events; **LIFT** if the Bonferroni-adjusted lower
  bound of mean net lift is above 0 both raw and BTC-hedged at 2 min, $1,000; otherwise **NO LIFT**.
  (The full PASS rule in the SPEC, with folds, holdout and threshold shifts, applies to H1-H3 in Phase 4.)

## E002. Baseline C: the app's Track A "Confirmed" rule, v0.1.0 (trials 3 and 4)
- Rule C: 5m bar with |move| >= 2.0 x ATR20, clean data (no data issues, more than 20 bars of history), and the app's
  gates as far as history allows: 24h quote volume (sum of the 1,440 1m candles before t) >= $5M; spread (2 x K1
  half-spread) <= 0.20%; K1 slippage for $1,000 <= 0.30%; ATR20 / price >= 2 x round-trip K1 cost at $1,000.
- Trial 3: CONTINUE. Trial 4: REVERT.
- Metric and verdict: as E001.

## E003. Placebo tests on rules A and C
As P1. Not trials. Pass criterion as P1.

## E004. Precision at an alert budget (descriptive, not a trial)
Among traded signals of rules A and C (CONTINUE), per UTC day ranked by |move| (plain % move), top K = 5, 10, 20:
win rate (favorable barrier first) and mean net return, 2-min delay, $1,000. (Ranking by a score comes with H1-H3.)

---

## E005. Corrections after the first run (shared definitions version 1.1), 2026-11-12

Written and committed after run 1 and before run 2. Run 1: command `./gradlew :engine:replayLab`, code `94ff12d`,
pre-registration `e1785c7`, dataset manifest sha256 `8b8bdb1dfdd04c0d9fa01309a1163f446a6cd3b817f650a71e2ddb3de5b7d599`.
Its headline, now superseded: all four trials NO LIFT (2 min, $1,000, mean lift per event: A-CONTINUE -0.033%,
A-REVERT +0.023%, C-CONTINUE -0.004%, C-REVERT +0.000%; 8,014 / 8,014 / 20,481 / 20,481 events); all six placebos passed.
Its report is kept as docs/results/phase3-baselines-run1-superseded.md.

The red-team checks of run 1 (independent recount of rule A from the raw zips; audit of every bookDepth file) found:

1. **Bug (implementation, K1):** 295 of 896 bookDepth files write the level as `-1.00` / `1.00`, not `-1` / `1`; the
   parser only accepted the latter. Those days had no depth sample: 4,459 rule A signals had no cost estimate and were
   dropped, and rule C's depth gate failed on those days. **Fix:** read the level as a number.
2. **Data quality (K1, method change):** some bookDepth days are one-sided, e.g. LINKUSDT 2025-10-15: median bids within
   1% = $295, asks = $7.3M. The linear-book model turns them into multi-percent costs (run 1's mean net at $10,000 was
   -2.2% for rule A). **Change:** a day is skipped as corrupt when either side's median notional within 1% is below
   $1,000 or below 1% of the other side; the previous valid sample (still strictly before the signal day) is used.
3. **Universe false positive (U1, method change):** the weekend-volume rule (meant for tokenized stocks) excluded
   ETHUSDT in 2026-01 and 2026-02 (weekend / weekday median 0.33 < 0.35); this explains the recount gap for ETHUSDT (78
   independent vs 68 engine signals). BTCUSDT (19 = 19) and SOLUSDT (123 = 123) matched exactly. **Change:** the weekend
   rule applies only to symbols with no contract type in the saved exchangeInfo (gone from the exchange); symbols that
   Binance lists as PERPETUAL are crypto by Binance's own label, and TRADIFI_PERPETUAL is still excluded.

Nothing else changes: same rules A and C, same labeler, statistics, placebos, seeds, period and holdout. The trial
counter goes from 4 to 8, so the adjusted intervals of run 2 use 1 - 0.05/8 (stricter than run 1).

---

## Results of E001-E004 (run 2, definitions v1.1)

Receipts: command `./gradlew :engine:replayLab` (from android/), code `d5f8c5abd7b6e19b3239996aeb0f31a7af66240f` (clean),
pre-registration `05ad63d02a9bf3acaf5992ec2a89110d46e86af9`, dataset manifest sha256
`20721e1f2f4c758251e162f262a0d70b3fdd5495cc290d0521203178f40cc1e0` (12,352 files), trial counter 8. Two consecutive runs gave
byte-identical results. Full tables: docs/results/phase3-baselines.md.

| Trial | Rule | Trade | Independent events | Mean net (2 min, $1,000) | Mean lift vs random | Adjusted CI (1-0.05/8) | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | A | CONTINUE | 11,278 | -0.156% | -0.035% | [-0.091%, +0.018%] | NO LIFT |
| 2 | A | REVERT | 11,278 | -0.103% | +0.025% | [-0.027%, +0.081%] | NO LIFT |
| 3 | C | CONTINUE | 23,564 | -0.116% | -0.001% | [-0.015%, +0.014%] | NO LIFT |
| 4 | C | REVERT | 23,564 | -0.120% | -0.004% | [-0.019%, +0.010%] | NO LIFT |

Placebos (E003): all six pass (95% CI contains 0). Red-team: independent recount of rule A from the raw zips matches
the engine for BTCUSDT 19/19, ETHUSDT 78/78, SOLUSDT 123/123; bookDepth audit after the E005 fixes: 896 files read, 859
plausible, 37 one-sided days skipped. Not checked: fills through the barrier in fast markets (exits assumed at the
barrier price), time-of-day matching of the random baseline. Conclusion: neither baseline has an edge; the app's v0.2
rule (C) performs like random entries minus costs.

---

## E006. v0.3 signal redesign: confirmations, score, exits (pre-registered 2026-11-16, before any v0.3 result)

Goal (user spec, 2026-11-16): fewer signals, higher win probability, positive expectancy after costs, proven out of
sample. Data, universe, bars, costs (K1 v1.1), BTC hedge, events, random baseline, bootstrap and regime are as in the
shared definitions v1.1. Binance USD-M perpetuals only (Bybit, OKX and spot: later, see "Not testable here").

### Split
- Train: 2025-01-01 to 2025-12-31. Validation: 2026-01-01 to 2026-03-31.
- **Holdout A (user's choice): 2026-04-01 to 2026-06-30.** Caveat: Phase 3 reported the baseline's 2026Q2 result (lift
  -0.008%); no confirmation was ever evaluated on it.
- **Holdout B (never touched): 2026-07-01 to 2026-10-31**, downloaded only after the design freeze.
- Both holdouts are opened once, after the git tag `v0.3-design-freeze`.

### Base setup (unchanged from v0.2 = rule C)
5m bar close t; |close / previous close - 1| >= 2 x ATR20; v0.2 gates; trade in the move's direction d (+1 up, -1 down).
First signal per event (E1). Primary execution: market entry at the open of minute t+2m, taker 0.05%, K1 spread and
slippage, $1,000.

### Confirmations (each: pass rule for testing alone, signed continuous value x for the score; all as of t)
Priority set (2a):
- C1 HTF trend: EMA50 of completed 1h closes and of completed 4h closes. Pass: d x (close - EMA50_1h) > 0 and
  d x (close - EMA50_4h) > 0. x = mean of d x (close / EMA - 1) over both.
- C2 BTC context: r = BTC close(t) / BTC close(t - 15m) - 1. Pass: d x r >= 0. x = d x r. (BTCUSDT signals: always
  pass, x = 0.)
- C3 Relative volume by time of day: rv = quote volume of the signal bar / mean quote volume of the same UTC 5-minute
  slot on the previous 20 days (at least 10 present). Pass: rv >= 2. x = ln(rv).
- C4 Taker flow: tb = taker-buy quote volume / quote volume of the signal bar. Pass: tb >= 0.55 (longs) or tb <= 0.45
  (shorts). x = d x (tb - 0.5).
- C5 Open interest: from the 5m metrics archive, OI(t - 5m) / OI(t - 20m) - 1 (one 5m period of lag: the archive's
  publication delay is unknown). Pass: > 0. x = the change.
- C6 Funding (veto): last settled funding rate f at or before t. Pass: d x f < 0.0005. x = -d x f.
- C7 Structure: Donchian(20) on 5m: d = +1 close > max high of the previous 20 bars (d = -1: close < min low). Pass:
  breakout. x = d x (close - channel edge) / ATR20 in price.
- C8 Candle quality: CL = (close - low) / (high - low) of the signal bar. Pass: CL >= 0.75 (longs) or <= 0.25
  (shorts). x = d x (CL - 0.5).

Extended set (2b), computable from the archive:
- X1 EMA stack: EMA20 > EMA50 > EMA200 (longs; reversed for shorts) on 5m and on 1h, both. x = agreeing stacks - 1.
- X2 Session VWAP (UTC day, from 1m candles up to t): pass d x (close - VWAP) > 0. x = d x (close / VWAP - 1).
- X3 ADX(14) on 1h (Wilder): pass ADX > 20 and the DI of direction d larger. x = (ADX - 20) / 20 x (+1 if DI agrees, -1 if not).
- X4 RSI(14) on 5m (Wilder): pass 50 <= RSI <= 70 (longs) or 30 <= RSI <= 50 (shorts). x = -|RSI - 60| (longs),
  -|RSI - 40| (shorts).
- X5 MACD(12, 26, 9) histogram on 5m: pass d x hist(t) > 0 and |hist(t)| > |hist(t-1)|. x = d x (hist(t) - hist(t-1)) / ATR20 in price.
- X6 ROC 1h: pass d x (close(t) / close(t - 60m) - 1) > 0. x = that value.
- X7 Squeeze: Bollinger(20, 2) width / SMA20 of the bar before the signal bar in the lowest 20% of the previous 100 bars'
  widths. x = -(percentile of that width).
- X8 ATR percentile: ATR20 / price at t at or below the 80th percentile of the previous 2,016 bars (7 days). x = -(percentile).
- X9 Prior-day breakout: close beyond the previous UTC day's high (longs) or low (shorts). x = d x (close - level) / ATR20 in price.
- X10 Long/short account ratio (contrarian): metrics `count_long_short_ratio` at t - 5m; pass at or below (longs) / at
  or above (shorts) its median over the previous 7 days. x = -d x (ratio / median - 1).
- X11 ETH context: as C2 with ETHUSDT (ETHUSDT signals use BTCUSDT). x = d x r.

### Not testable here (stated, not hidden)
Liquidation cascades (no free history), order-book imbalance and refill (no historical L2 beyond daily aggregates),
volume profile, cross-exchange agreement, spot-led vs perp-led, sector strength, anchored VWAP, divergences, OBV/MFI,
Supertrend/Ichimoku, retests. Confirmation on Bybit, OKX and spot needs their history in the replay (next step).

### Selection procedure (fixed order; every evaluation counts as a trial)
- **Stage 1 (train, trials 9-27):** each of the 19 confirmations alone on top of the base setup. Reported: trades,
  trades per day, win rate, average win and loss, expectancy (mean net per trade) with 95% CI, lift vs random.
- **Grouping (train, no trial):** two confirmations join a group when |phi| of their pass flags on train signals is
  >= 0.4 (groups = connected components). Each group keeps the one with the best train expectancy. A group winner
  enters Stage 2 only if its train expectancy beats the base setup's and its train lift is > 0.
- **Stage 2 (validation, trials 28-35):** group winners in order of train expectancy gain, one at a time: fit the score
  on train with the kept set plus the candidate; keep the candidate if the top-10% rule's validation expectancy
  improves and its validation mean lift vs random is > 0. At most 5 kept.
- **Score:** standardized x values (train mean and sd, winsorized at the train 1st/99th percentiles); L2 logistic
  regression (lambda = 1) on train, target = WIN under the base exit; score = 100 x the train percentile of the
  predicted probability. A signal is shown when score >= 90 (top 10% of train setups).
- **Stage 3 (validation, trials 36-48)** on the score rule. Exits (market entry at t+2m; R = stop distance):
  TP 1R / 1.5R / 2R x stop 1 ATR x time 30 / 60 / 120 min (9); structure stop (signal-bar low or high, clamped to
  0.5-2 ATR) with TP 1.5R, 60 min (1); partial: half at 1R then stop to entry, rest at 2R, 120 min (1). Pick the best
  validation expectancy. Then two entries with that exit: follow-through (the next 5m bar closes in direction d; enter
  at t+5m+2m) and limit pullback (maker 0.02%, limit at the signal bar's midpoint, valid 15 min from t+2m; unfilled =
  no trade, fill rate reported); keep one only if validation expectancy improves.
- **Ablation (validation):** remove each kept confirmation, refit, report the expectancy and trade-count change.
- Fewer than 1 signal per day across the universe: flagged as too sparse to validate.

### PROVEN only if all hold (else EXPERIMENTAL; kill rule: holdout expectancy CI containing 0 = discard)
1. Holdout A and holdout B each: at least 300 trades and expectancy 95% CI lower bound > 0 ($1,000, 2 min).
2. Pooled holdouts: lift vs matched random entries, Bonferroni-adjusted (T = 48) lower bound > 0, raw and BTC-hedged.
3. Expectancy > 0 in at least 70% of quarters (2025Q1-2026Q2 and Jul-Oct 2026).
4. Expectancy still > 0 with +50% costs, with entry at t+5m, and with the threshold at top 8% and top 12%.
5. Expectancy still > 0 without the 5 best coins and without the 5 best days.
6. Placebos (time shift, shuffled labels, random symbol) on the final rule: 95% CI contains 0.

Also reported: max drawdown (cumulative net per $1,000 trade in time order), results by coin, month, regime, long vs
short. If no confirmation survives Stage 2, the answer is "no edge found" and v0.2's rule stays EXPERIMENTAL.

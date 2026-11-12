# Experiments (pre-registration log)

Rules (docs/SPEC.md, evidence rule 3): every test is written here and **committed before it is run**. Results cite that
commit. This file is append-only: old entries are never edited; corrections are new entries. Every variant tried
increments the trial counter, and confidence intervals are corrected for the number of trials (Bonferroni).

**Trial counter: 4** (after E001 and E002 below)

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

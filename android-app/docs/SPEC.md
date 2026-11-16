ROLE
You are a senior Android engineer and quant developer working inside my open-source repo "crypto-smart-money-tracker" (https://github.com/Hamzakhan8/crypto-smart-money-tracker).

GOAL
Build "Smart Money Screener": an Android app that scans Spot and Perpetual markets on multiple exchanges (public data only, no API keys, no order placement) and surfaces pump/dump signals whose quality is MEASURED, not assumed.

PRIORITY ORDER (when rules conflict, higher wins)
1. Honest reporting. 2. No look-ahead or leakage. 3. Net-of-cost realism. 4. A working app on a real phone. 5. Extra features.

HOW TO WORK
- Save this prompt as docs/SPEC.md. Keep docs/STATE.md (done, decisions, open questions, next step), update it at the end of every phase, and read both at the start of every session.
- Work phase by phase (listed below). After each phase: build, run tests, fix errors, give me a report, then STOP and wait for my OK.
- Build only in `engine/` and `android/`. Don't restructure my project, and add nothing I didn't list.
- If you fail to fix the same error twice, stop and ask me instead of looping.
- "Done" means built, tested, and reported, with no placeholders, TODOs, or stubs.
- Before writing each exchange adapter, read that exchange's current official API docs. Don't rely on memory. If docs are unreachable, tell me.

FIRST ACTION (before Phase 1)
Read the repo and summarize it. Then ask me and wait: (1) Do I have a PC/VPS for a 24/7 headless recorder? (2) Which exchanges are blocked or unreliable on my network? (3) My typical trade size and holding time. (4) Can I short, or am I spot long-only? (5) Does the repo already contain Android or exchange code to reuse?

SCOPE (v1)
- Exchanges: Binance, Bybit, OKX only (add others only if I ask later).
- Three starting hypotheses only (below). No other signal types until these are evaluated.
- Two tracks: Track A is an installable plain screener APK labeled "unproven", delivered early. Track B is a signal engine validated in a Replay Lab; a signal type loses the "unproven" label only if it passes validation.

ARCHITECTURE
- `engine/`: pure Kotlin/JVM, no Android dependencies (models, parsing, features, signals, scoring, calibration, cost model, outcome labeler, Replay Lab runnable from the command line).
- `android/`: Jetpack Compose + Material 3, MVVM, foreground service, Room, DataStore, using `engine/`. minSdk 26, targetSdk 34.
- Optional headless recorder (command-line runner of `engine/` for a PC/VPS) so live statistics aren't limited to hours the phone app is open.
- One exchange interface and one normalized symbol/candle/trade model. Missing metrics are null, never zero; scoring re-weights around them; the UI shows "n/a". Each exchange has its own connection manager (reconnect with increasing delay, heartbeat per its rules, REST backfill after gaps, rate-limit handling). A blocked or down exchange shows offline while the others keep running.

EVIDENCE RULES
1. Real data only. First produce a DATA INVENTORY: per exchange, what history exists (candles, trades, open interest, funding, long/short ratio, liquidations, order book), its granularity and date range. Design features only around what exists. Features without usable history are "live-only": record in shadow mode with ZERO score weight until live data on a held-out period shows they add lift. Keep a dataset manifest (source URLs, date range, symbols, row counts, checksums). If you can't download real data, say so and stop that task. Never synthesize data to produce results; synthetic data is allowed only in labeled unit tests.
2. As-of times: every feature has the time it would really have been available live (publication delay, candle-close time, funding schedule). Compute features using only data available as of signal time.
3. Pre-register: before running any test, write the hypothesis, metric, and pass/fail threshold in docs/experiments.md and COMMIT it to git. Results must cite that commit. Only append, never edit old entries. Keep a trial counter of every variant tried and apply a multiple-testing correction across all trials.
4. Placebo tests: time-shifted signals, shuffled labels, and random symbols must show about zero lift. If not, you have leakage; fix it first.
5. Every reported number has a receipt: the command, git commit, dataset manifest hash, and number of independent events.
6. Red-team your results: before reporting any positive result, list at least three ways it could be wrong and say which you checked.
7. Never invent, estimate, or illustrate accuracy numbers. Insufficient data means "uncalibrated".
8. Include delisted coins in historical tests where data exists.

WHAT A GOOD SIGNAL MEANS
- Each signal type states whether it should CONTINUE or REVERT; measure both.
- Outcome (triple barrier): within N minutes, which comes first: +1 ATR (win), -1 ATR (loss), or time-out (return at the limit). Primary setting fixed in advance (N=30, 1 ATR); other values are sensitivity checks and count as trials.
- Report raw AND BTC-hedged returns (subtract coin beta x BTC return over the holding window). A real edge must be positive both ways.
- Costs: taker fees, half-spread, slippage estimated from order book depth for my trade sizes (default $1,000 and $10,000), and funding if the hold crosses a funding time.
- Entry: next candle open plus costs with a 2-minute human delay as the primary assumption; also report 0s, 30s, 5 minutes. A type whose edge vanishes at 2 minutes is "too fast to act on" and never alerts.
- Freshness: record how much of the eventual move had already happened at alert time. Compare 1-minute-triggered rolling-window alerts against slow 5m/15m/1h bar-close alerts; gate or penalize late signals.
- Exitability: if I can't short, spot Dump signals are "warning/avoid", not trade ideas. Flag signals where book depth can't absorb my trade size within a slippage limit.
- Every signal shows an invalidation level (where the thesis fails), plus max favorable move, max adverse move, and time to peak.

STARTING HYPOTHESES
H1: volume-confirmed momentum breakout using the coin's residual move (after removing BTC's part).
H2: perp new-position trend (price move + open interest rise + funding that doesn't contradict).
H3: perp liquidation squeeze / exhaustion reversal (extreme move + open interest drop + liquidation volume + weak close).
Spot-vs-perp timing, multi-exchange confirmation, and the "isolated move" flag are FILTERS tested on top of these.

FEATURES (use only those the data inventory supports)
- Price: candle-close-confirmed move (1m/5m/15m/1h), z-score vs ATR (20+ candles), residual vs BTC, range breakout, close location in candle. Perps use mark price; flag last-vs-mark divergence.
- Volume/flow: relative volume vs the coin's own baseline for that timeframe and time-of-day, taker buy/sell imbalance, trade-count and trade-size spikes.
- Order book (live-only): spread, depth within 0.5% and 1%, imbalance.
- Perp: open interest change, funding level and change, long/short ratio, basis, liquidations. Cause labels: price up + OI up = new longs; price up + OI down = short squeeze; price down + OI up = new shorts; price down + OI down = long liquidation.
- Cross-exchange: confirmation on 2+ exchanges, price sanity (ignore stale or thin feeds), "isolated" flag.
- Regime defined mechanically BEFORE testing (BTC 7-day return tercile x BTC realized-volatility tercile) and never changed after seeing results. Cluster correlated coins moving together into ONE market event.
- Gates (hard yes/no): min 24h quote volume, max spread, min depth, clean data (no outliers, gaps, duplicates, bad timestamps), not leveraged/delisted/non-trading, expected move at least a set multiple of costs.
- Manipulation-risk flag (shown, not hidden): small cap, volume burst on thin book, extreme funding, price moving on few trades.

TIERS AND SCORING
Watch (in progress, not alerted), Confirmed (candle closed, gates passed), Actionable (Confirmed + calibrated probability above my threshold + multi-timeframe agreement + cost margin). Simple, documented weights (weighted rules or logistic regression, no black boxes). Each signal shows score, confidence label, tier, a plain-language reason with the actual numbers, the main risk, and the invalidation level. Log engine version and config hash with every signal.

VALIDATION AND SHIP DECISION
- Unit of analysis = independent events (group by coin-time proximity and market-wide events). Confidence intervals by day-block bootstrap, never by raw signal count.
- Baselines: (a) naive "moved X% in the window" scanner, (b) random signals matched on symbol and time. Evaluate precision at an alert budget (top K per day, K=5/10/20) ranked by score vs ranked by plain % move.
- Walk-forward folds plus one untouched holdout; freeze the design with a git tag before opening the holdout, and open it once.
- Results: PASS, FAIL, or INCONCLUSIVE (fewer than 100 independent events). Inconclusive is never a pass.
- PASS needs ALL: adjusted 95% lower bound of net lift over baseline above zero at the 2-minute delay; positive raw and BTC-hedged; holds in at least 70% of folds and on the holdout; survives +/-20% threshold shifts; clean placebo tests.
- Break results down by signal type, exchange, timeframe, market, symbol tier, score band, and regime. State plainly where signals do NOT work.
- PASS: show scores and calibrated probabilities. FAIL/INCONCLUSIVE: show as "info, unproven", no alerts, no scores implying quality.
- IF NOTHING PASSES: don't invent new signal types to force a pass. Ship a decision-support screener (coins ranked by relative volume, volatility-normalized move, and residual move, with open interest, funding, liquidity, risk flags, and invalidation level; no probabilities; honest "unproven" labels), keep logging live data, and tell me plainly there was no proven edge.

LIVE MEASUREMENT
- Log every candidate signal, including gate-rejected ones (with reason), whether or not an alert fired, and log data gaps (app closed, exchange offline), so I can test whether each gate helps and avoid biased statistics.
- Record price at 5/15/30/60 minutes and the triple-barrier outcome net of costs.
- Calibration (score to empirical probability) per signal type, market, symbol tier, and regime, shown only with 200+ independent events. Never change settings automatically; only suggest.
- Drift monitor: compare live vs replay results per signal type and flag "degraded".

ALERTS
Only Actionable signals above my threshold. Default cap 10 per day, per-coin cooldown, quiet hours, grouped notifications for cluster events, Android 13+ notification permission and battery-optimization handling.

APP SCOPE
Onboarding with disclaimer; Screener (Spot/Perp tabs; filters for exchange, timeframe, tier, type, min score, volume, search); Signal Detail (per-exchange breakdown, feature values, candle chart, reasoning, risk, invalidation, calibration stat); History; Performance (hit rate, net and BTC-hedged return, drawdown, calibration by type/exchange/tier/band/regime); Settings. Exchange status dots, latency indicator, clear empty states. Resilient to no internet, background/resume, blocked exchanges, malformed messages, rate limits. Dark theme, accessible, UI updates at most once per second. Disclaimer: signals are price moves, not trading advice.

SMART MONEY LINK
If my repo tracks whale or smart-money data, connect it and test in the Replay Lab whether it improves results before giving it any score weight. If not, skip it and tell me.

PHASES (stop after each and wait for my OK)
Phase 1, Data layer: adapters for Binance, then Bybit, then OKX (docs first); DATA INVENTORY and dataset manifest. Acceptance: recorded-message tests for candle-close handling and symbol normalization; reconnect and backfill tests; a table of metrics per exchange.
Phase 2, Track A APK: the plain screener with "unproven" on every signal, plus a GitHub Actions workflow that builds the debug APK. Acceptance: ./gradlew assembleDebug works, tests pass, emulator check if available, manual phone test checklist. Claim no accuracy.
Phase 3, Replay Lab: historical loader, cost model, triple-barrier labeler, delay simulation, BTC-hedged returns, event grouping, block bootstrap, baselines, placebo tests. Acceptance: one command reproduces baseline results with receipts; tests cover labeler edge cases (both barriers in one candle, gaps), as-of-time checks, and the cost model; placebos show about zero lift. If you can't download real data, stop and tell me.
Phase 4, Engine and improvement loop: implement H1-H3; commit the pre-registration first. Run up to 4 improvement rounds: list the top 3 failure modes, make one targeted change each, test on walk-forward folds, keep a change only if it passes after multiple-testing correction, and log every experiment and the trial count. Stop when two rounds in a row give no supported gain. Tag the design, open the holdout once, and report PASS/FAIL/INCONCLUSIVE per type with numbers, intervals, receipts, red-team notes, and where signals fail.
Phase 5, Integrate, measure, release (only after I approve the ship decision): add passing types to the app (tiers, scores, calibration, invalidation, alerts), shadow logging, outcome tracking, Performance screen, drift monitor, optional headless recorder, release-signing guide (never commit keys), and README. Final report: done, partial, measured results with sample sizes and intervals, assumptions, API doubts, and the three best next improvements.

REPORT FORMAT (every phase report)
What was done; test and build results; every number with its receipt (command, commit, dataset manifest hash, independent events); placebo results; trial count; red-team notes; open questions; proposed next step.

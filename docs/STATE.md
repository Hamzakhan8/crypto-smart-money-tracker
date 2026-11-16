# Smart Money Screener: state

Read this file and docs/SPEC.md at the start of every session.

## Done

- 2026-11-12: Repo read and summarized (FIRST ACTION). Spec saved as docs/SPEC.md.
- 2026-11-12: **Phase 1 (data layer)** and **Phase 2 (Track A APK)**, built back to back at the user's request ("I just want
  the screener app on my phone"). Nothing committed yet.
  - `engine/` (Kotlin/JVM, no Android): one model for all exchanges (missing = null), adapters for Binance, Bybit, OKX
    (spot USDT + USDT-margined linear perps; docs read first, see DATA_INVENTORY.md), connection manager per WebSocket
    (subscribe pacing, backoff 1 s to 60 s with jitter, client pings for Bybit/OKX, server pings for Binance, reconnect
    after silence, 23 h planned reconnect for Binance), REST backfill after every reconnect with a logged data gap, rate
    limits (per-exchange pacing, 429/418/403 and exchange codes pause requests), features, gates, risk flags, screener rows.
  - `android/` (Compose + Material 3, MVVM, Room, DataStore, foreground service): onboarding with disclaimer, Screener
    (Spot/Perp tabs, timeframe 1m/5m/15m/1h, filters for exchange, tier, direction, min move in ATRs, min volume,
    search, sort), coin detail (per-exchange breakdown, candle chart with invalidation line, reason, main risk, gates,
    risk flags, all feature values with n/a, perp data, order book depth and slippage, "uncalibrated"), History (every
    closed-candle move, passed or rejected with reasons, plus data gaps; 30 days), Settings (exchanges, markets,
    timeframe, coins per exchange, thresholds, trade size, can-short, taker fees, background scanning, battery).
    Exchange status dots with latency. UI updates at most once per second. Dark theme.
  - `.github/workflows/android.yml`: runs all unit tests and builds the debug APK (artifact) on push/PR.
  - docs/DATA_INVENTORY.md (metrics per exchange, history depth, live-only list) and docs/dataset-manifest.json.

- 2026-11-12: **App v0.2.0-trackA** (user request: "clear signal: perp long or short, spot buy only"). Perps show LONG
  after an unusual up move and SHORT after an unusual down move (SHORT can be switched off in Settings); spot shows BUY
  after an up move only, falling spot coins get no action. New first tab "Signals" (live now + last 24 hours, with entry,
  target +1 ATR, stop -1 ATR, 30-minute window, current price and move since the signal). Screener "Signals only"
  filter; coin detail shows the action and plan. Every signal still labeled UNPROVEN. Installs as an update over v0.1
  (same debug key, versionCode 2); history database upgraded in place (v1 -> v2 adds target/stop; checked in SQLite).
  Engine 94/94 and app 5/5 tests pass. Not yet opened on a phone.
- 2026-11-12: Phase 3 started: pre-registration committed (e1785c7), Replay Lab code committed (b731dd8). The first
  run was stopped while downloading daily candles: **no Phase 3 results exist yet.**

- 2026-11-16: **App v0.3.0-experimental** (user: "skip the backtesting, just provide the updated app"). A confirmed
  move is shown as a signal only with a score >= 75 (Settings: 50-100): the share of 8 live checks that pass (1h+4h
  EMA50 trend, BTC 15m not against, volume >= 2x, taker flow 55% (Binance only), OI rising and funding not crowded
  (perps), 20-candle breakout, strong close), all weighted equally because no backtest set weights. Each signal shows
  coin, direction, entry, stop, target, score, EXPERIMENTAL and "holdout: not tested". Live paper tracking scores every
  signal (target / stop 1 ATR, 30 min, conservative) and compares with the v0.2 backtest (decay flag). History DB v3
  (in-place upgrade, checked in SQLite). Engine 107/107, app 10/10 tests pass. Installs over v0.2 (same key, versionCode 3).
- 2026-11-16: v0.3 research (E006) pre-registered (67dbc8e) and coded (123552a), then paused before any result.
  **Open issue:** after that refactor a Phase 3 rerun did not reproduce the committed Phase 3 numbers; cause not found.

- 2026-11-16: **App v0.3.1-experimental: signal notifications** (user request). Heads-up notifications for new LONG and
  SHORT signals (BUY optional, off by default) with entry, stop, target, score and EXPERIMENTAL; at most 10 per day
  (5-50), one per coin per hour, optional quiet hours, grouped when several arrive together, test button in Settings.
  Android 13+ permission requested; the first v0.3.1 start switches background scanning on so notifications arrive with
  the app closed. Engine 107/107, app 13/13 tests pass. Installs over v0.3 (same key, versionCode 4).

### Build and test results (2026-11-12, this PC: Windows 10, JDK 17.0.21, Gradle 8.10.2, AGP 8.7.3, Kotlin 2.0.21)

| Command (run in `android/`) | Result |
|---|---|
| `./gradlew test` | engine 71/71 passed, app 4/4 passed (debug and release unit tests) |
| `./gradlew assembleDebug` | OK. `app-debug.apk` 11,538,075 bytes, sha256 bb85f99cff8ba3fa1cf3fb5d5e6adf10ed384f33f3adff93a00dfaf8dd78f416, package com.smartmoney.screener 0.1.0-trackA, minSdk 26, targetSdk 34, debug-signed |
| `./gradlew :engine:liveSmoke -Pminutes=4 -Ptf=1m` | all 6 feeds live 4 min, latency 41-171 ms, 0 malformed, 0 reconnects (details in DATA_INVENTORY.md) |
| Emulator | **not run**: CPU virtualization is on, but no hypervisor is installed (needs Windows Hypervisor Platform or Google's emulator driver: admin + system change, not done) |
| Real phone | 2026-11-12: user installed the APK (sent via WhatsApp) and reports "it is working good". Phone model, Android version and which checklist items were tried: not reported |

Tests: recorded-message tests (real responses from all three exchanges: REST parsing, symbol normalization across
exchanges, candle-close handling on REST and on every recorded WebSocket line, subscribe acks and errors), error and
rate-limit handling, reconnect with growing delays, heartbeat and latency, silent-connection replacement, malformed
messages, gap backfill after a 10-minute outage, blocked exchange shown offline, features (labeled synthetic data), tiers,
gates, labels, cross-exchange checks, liquidity, screen filters.

A real bug found by the tests and fixed: a WebSocket message arriving at the same instant as a timer could be dropped
(withTimeout around channel receive). Now uses select; regression test added.

### No accuracy numbers

None measured, none claimed. Track A shows moves, not predictions: every row is labeled UNPROVEN, no scores or
probabilities, no alerts. Trial count: 0 (no experiments run). Placebo tests: not applicable yet (Phase 3).

## Decisions

- Built Phase 1 + 2 without stopping between them (user asked for the app directly).
- Defaults for the unanswered setup questions: trade size $1,000 (also $10,000 shown), cannot short (down moves =
  "Warning / avoid"), no 24/7 recorder, exchanges assumed reachable (all were, from this PC).
- Gradle root is `android/`; `engine/` is included from `../engine` (no files added at repo root except docs/ and
  .github/workflows/).
- Universe = top N (default 40) most-traded USDT instruments per exchange and market, BTC always added. Tier logic:
  Watch = |move| >= 2 ATR in a candle in progress; Confirmed = closed candle >= 2 ATR and all gates pass; Rejected =
  closed candle >= 2 ATR and a gate fails (logged with the reason). No Actionable tier in Track A.
- Gates: trading, 24h volume >= $5M, spread <= 0.20%, clean data, slippage for your size <= 0.30% (order book is fetched
  when a candle closes with an unusual move; unknown = not passed), ATR >= 2x round-trip cost (2 x taker fee + spread +
  2 x slippage). Thresholds are settings, not tuned on any data.
- Risk flags (display only, not validated): low liquidity (< $20M 24h), volume burst on a thin book, extreme funding
  (>= 0.1%), last vs mark > 0.5%, few trades (< 50, Binance), price > 1% from other exchanges, isolated move.
- Invalidation = the signal candle's low (up moves) or high (down moves).
- Relative volume uses the trailing median of up to 96 candles, not the time-of-day baseline in the SPEC (needs more
  history per coin than a phone should fetch); to do in the Replay Lab.
- OKX perp 24h USDT volume is approximated as coin volume x last price (OKX gives no USDT figure for swaps).

## Open questions

1. PC/VPS for a 24/7 headless recorder? (default: none)
2. Exchanges blocked on the phone's network? (all reachable from this PC)
3. Typical trade size and holding time? (default $1,000; holding time unknown)
4. Can short, or spot long-only? (default: cannot short; switch in Settings)
5. Smart money link: `whale-signals.ts` (Hyperliquid top wallets, Binance top traders vs crowd) is a candidate; per the
   SPEC it must be tested in the Replay Lab before any score weight. Not connected yet.
6. Commit and push this work? (nothing committed; the workflow only runs after a push)
7. Install an emulator hypervisor for automated app checks? (admin change on this PC)

## Manual phone test checklist (Phase 2 acceptance)

1. Copy the APK to the phone, allow "Install unknown apps" for the file manager or browser, install. Play Protect may
   warn about an unknown developer (debug build): "Install anyway".
2. First launch: read the disclaimer, tick, Continue.
3. Within about 30 s the three status dots turn green; Spot and Perp tabs list coins, each with an UNPROVEN badge.
   Perp rows show OI change and funding.
4. Switch 1m / 5m / 15m / 1h: the list reloads within a few seconds.
5. Tap a coin: chart, per-exchange table, gates, feature values (n/a where an exchange has no data), "Check order book
   now" fills spread, depth and slippage.
6. Filters: "Moving only", direction, exchanges, search "SOL"; Reset filters.
7. Airplane mode on: dots turn red within about a minute and the screen says it cannot reach any exchange. Off: it
   recovers on its own; History > Data gaps shows the outage.
8. Settings: switch one exchange off; its dot goes grey, the others keep running.
9. Background scanning on (allow notifications on Android 13+): a quiet "Scanning (unproven screener)" notification.
   Lock the phone 15 minutes; History shows moves logged meanwhile. If nothing was logged, set battery to
   "Unrestricted" (Settings > Battery optimization > Open).
10. Rotate, leave and reopen the app: no crash, data continues.
11. Report: phone model, Android version, anything red, any crash.

## Next step

After the user's OK and phone test: Phase 3 (Replay Lab: historical loader, cost model, triple-barrier labeler, delay
simulation, BTC-hedged returns, event grouping, block bootstrap, baselines, placebo tests), starting with the real
archives listed in DATA_INVENTORY.md (Binance data.binance.vision first: longest history, delisted coins included).

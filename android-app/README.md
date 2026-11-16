# Smart Money Screener (Android app)

An Android app that scans the 40 most-traded USDT coins on **Binance, Bybit and OKX** (spot and perpetuals, public
data only: no account, no API key, no orders) and shows **LONG / SHORT** signals on perps and **BUY** signals on spot,
with entry, stop, target and a score, plus notifications.

> **Every signal is EXPERIMENTAL.** The v0.2 signal rule was backtested on 18 months of Binance perps and showed
> **no edge** (48.2% wins, -0.12% per trade after costs, same as random entries; see `docs/results/`). The v0.3 score
> has not been backtested yet. The app tracks every signal's paper result live and warns when results decay.
> Signals are price moves, not trading advice.

## Folders

| Folder | What it is |
|---|---|
| `android/` | The app (Kotlin, Jetpack Compose, Material 3). Gradle root: build from here. |
| `engine/` | Plain Kotlin engine used by the app: exchange adapters, live connections, features, signals, and the Replay Lab backtest. |
| `docs/` | Spec, progress log (`STATE.md`), data inventory, pre-registered experiments, backtest results and dataset manifests. |

## Build the APK

Needs JDK 17 and the Android SDK (platform 34). From `android-app/android`:

```
./gradlew test assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. On GitHub, the workflow in
`.github/workflows/android.yml` (repo root) runs the tests and attaches the APK to each run under **Actions**.

## Install on a phone

Copy the APK to the phone (USB, Drive, WhatsApp as a document), open it, allow "install unknown apps", and tap
"Install anyway" if Play Protect warns (debug build from an unknown developer). New versions install over old ones and
keep the history.

## Backtest (Replay Lab)

From `android-app/android`: `./gradlew :engine:replayLab` reproduces the Phase 3 baseline results with receipts
(downloads about 2 GB of verified Binance archive data into `engine/replay-cache/` on the first run). See
`docs/experiments.md` for the pre-registered method and `docs/STATE.md` for open issues.

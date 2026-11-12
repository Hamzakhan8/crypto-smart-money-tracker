# Data inventory (Phase 1)

Public data only (no keys). Docs read and endpoints probed live on **2026-11-12** from this PC (Binance, Bybit and OKX all
reachable, spot and perp). Recorded samples: `engine/src/test/resources/recorded/<exchange>/` and
[dataset-manifest.json](dataset-manifest.json) (79 files, every sha256 re-checked: 0 mismatches).

"Live-only" = no usable free history, so it can be shown and logged but must get **zero score weight** until live data
on a held-out period shows it adds lift (SPEC evidence rule 1).

## Metrics per exchange

| Metric | Binance | Bybit | OKX |
|---|---|---|---|
| Candles 1m/5m/15m/1h (REST) | Spot from 2017-08-17, USD-M from 2019-09-08; full history; max 1000 (spot) / 1500 (futures) per call | Spot from 2021-07-05, linear from 2020-03-25; full history; max 1000 per call, newest first | `/market/candles` last 1,440 rows only; `/history-candles` spot 1m from 2018-01-11, swap 1m from 2019-12-16; max 300 per call |
| Candle closed flag | WS `x`; REST: period ended (server Date header) | WS `confirm`; REST: no flag, period ended by response `time` | `confirm` 0/1 on both REST and WS |
| Taker buy volume per candle | Yes (kline field 10) | **No** (null) | **No** in candles (null); separate rubik taker-volume (5m, last 1,440 rows) |
| Trade count per candle | Yes (kline field 8) | **No** (null) | **No** (null) |
| Quote (USDT) volume per candle | Yes | Yes (`turnover`) | Yes (`volCcyQuote`) |
| 24h tickers (bulk) | Spot 24hr has bid/ask; futures 24hr has none (bookTicker fills it) | Yes, with bid/ask; linear adds mark, funding, OI | Yes; SWAP `volCcy24h` is in coins, so USDT volume = coins x last (approximation) |
| Mark price | premiumIndex (bulk); mark klines in archive | tickers; mark-price kline | mark-price (bulk); mark candles last 1,440 rows, history "recent years" |
| Funding rate history | From 2019-09-10, full | From 2020-03-25, full | **~3 months only** (from 2026-08-10) |
| Open interest history | REST **last ~30 days** (5m); archive `metrics` files daily from 2020-09-01 (BTC) | 5min from 2020-08-04, full (since 2026-06 `openInterest` = both sides; we use `singleOpenInterest`) | rubik 5m **last 1,440 rows (~5 days)**, 1H ~60 days, 1D from 2024-01-01 |
| Long/short ratio history | REST last ~30 days; archive `metrics` daily | account-ratio 5min from 2020-07-20, full | contract ratio 5m last 1,440 rows; 1D from 2024-01-01 |
| Liquidations | WS `!forceOrder@arr` snapshot (largest per symbol per second): **live-only**; no archive | WS `allLiquidation.{symbol}`: **live-only**; no REST history | WS `liquidation-orders` (partial, not chronological); REST (undocumented since 2023) ~24 h back: **live-only** |
| Order book | REST depth (up to 5000); archive `bookDepth` daily from 2023-01-01 (aggregated) | REST up to 1000 levels: **live-only** | REST `books` up to 400 / `books-full` 5000; download files with 400-level book from 2023-01-01: possible history, not yet checked |
| Trades archive | data.binance.vision spot + USD-M trades/aggTrades | public.bybit.com linear trades daily from 2020-03-25; spot from 2022-11 | download API: trades SPOT 2021-09, SWAP 2021-10 |
| Delisted coins | Spot BREAK symbols and SETTLING perps stay in exchangeInfo; archive keeps them | `status=Closed` list (1000+) | not checked |
| Rate limit (REST) | Spot 6000 weight/min, futures 2400/min; 429 slow down, 418 ban, 451 restricted location | 600 req / 5 s per IP; breach = HTTP 403 + 10 min ban | Per endpoint, e.g. candles 40 / 2 s, tickers 20 / 2 s, rubik 10 / 2 s; code 50011 |
| WebSocket candles | Spot `stream.binance.com:9443/stream`; futures **`fstream.binance.com/market/stream`** (old URL sends no klines since 2026-04-23); server pings; 24 h lifetime; 5 / 10 msgs/s in | `stream.bybit.com/v5/public/{spot,linear}`; client `{"op":"ping"}` every 20 s; spot max 10 args per subscribe | `ws.okx.com/ws/v5/business` (candles are not on `/public`); `ping` within 30 s; 480 subscribes/h per connection |

Universe filters (from the docs and the recorded lists): USDT spot pairs and USDT-margined linear perpetuals only.
Excluded: Binance `TRADIFI_PERPETUAL` (235 stock/commodity perps) and dated futures; Bybit `symbolType` stock/ETF/
commodity/forex and spot `xstocks`; OKX `instCategory` 3/4 (230 stock + 9 commodity swaps), inverse swaps, `pre_market`;
stablecoins, fiat, gold and wrapped coins (list reused from this repo's `perps-history.ts` / `liquidity.ts`).
Perp names with a multiplier (`1000PEPE`, `1MBABYDOGE`) are normalized to the coin (`PEPE/USDT`, price x 1/1000) so the
same coin matches across exchanges.

## What Track A computes (and from what)

| Feature | Source | History for replay? |
|---|---|---|
| Candle-close move, ATR(20) z-score, range breakout, close location | candles | Yes, all three |
| Relative volume (vs median of up to 96 candles, same timeframe) | candles | Yes. Time-of-day baseline (SPEC) not done yet: needs days of candles per coin; planned for the Replay Lab |
| Residual move vs BTC (beta over up to 96 candles) | candles | Yes |
| Taker imbalance, trade-count spike | Binance candles only | Binance only; null on Bybit/OKX |
| OI change, cause label | OI history (5m) | Bybit full; Binance 30 days + archive; OKX ~5 days at 5m |
| Funding level, last-vs-mark | tickers | Funding history: Binance/Bybit full, OKX ~3 months |
| Spread, depth within 0.5% / 1%, slippage for $1k / $10k | order book | **Live-only** |
| Liquidations, long/short ratio | not used in Track A | Liquidations live-only; L/S as above |
| Cross-exchange confirmation, price sanity, isolated flag | rows of all exchanges | Derived |

## Fees (cost gate defaults, editable in the app)

Taker, base tier: Binance spot 0.100% (official fee schedule page), USD-M 0.05% (Binance support FAQ 360033544231);
Bybit spot 0.1% (help center, non-VIP; some regional pages say 0.25%), USDT perpetual 0.055%; OKX spot 0.100%, swap 0.05%
(secondary copies of okx.com/fees: the official page did not render for us, **not verified**).

## Live check (not a statistic)

`./gradlew :engine:liveSmoke -Pminutes=4 -Ptf=1m` (from `android/`), 2026-11-12 06:45-06:50 UTC, top 15 coins per feed:
all 6 feeds live the whole time, latency 41-171 ms, 0 malformed messages, 0 reconnects, all 90 rows with 1m features,
all 45 perp rows with OI change and funding; 2 closed-candle moves logged, both rejected by the cost gate. This checks
that the plumbing works; it says nothing about signal quality.

## Not verified / open

- Binance ping/pong timing and 429 `Retry-After` behaviour (not triggered on purpose).
- Bybit public WebSocket idle timeout (docs only state 10 min for private streams); we reconnect after 60 s of silence.
- OKX maximum channels per connection (close codes 4008/4009, no number given); we use at most 50.
- Binance `metrics` archive file columns (no file downloaded yet).

// Liquidity tab: which coins are "hot" right now on five big spot exchanges, and where the resting orders sit for one
// coin (an order-book heatmap). Public data only, no API keys. Two parts:
//   1. A multi-exchange screener. Spot prices from Binance, Bybit, OKX, Coinbase and Kraken, merged per coin (on each
//      exchange the USDT or USD pair, whichever trades more). For each exchange's 15 most traded coins it also reads the
//      last hour of 1-minute candles and the top 20 levels of the order book, gives a 0-100 hotness score and runs the
//      signal checks (volume spike, pump, dump, volatility, wide spread, book imbalance, breakout, hot market).
//      Refreshed every 15 seconds, a few coins per exchange at a time so no exchange is hammered. An exchange that fails
//      is shown as failing (with its error) and the others carry on.
//   2. An order-book heatmap for one Binance spot pair at a time (BTCUSDT by default). The live order book is rebuilt
//      from Binance's diff-depth stream plus a REST snapshot, by Binance's documented procedure (stale updates dropped,
//      a missed update forces a fresh snapshot). Every second the book is cut into price bins and kept for about
//      2 hours, next to the trade stream (for volume). Without a WebSocket it polls the REST order book every 2 s.
// A research view: the app never places orders. Not financial advice.
//
// Ported from crypto-liquidity-terminal (https://github.com/AIUngated/crypto-liquidity-terminal): the hotness score,
// the signal checks and their default thresholds (packages/screener-engine), the exchange endpoints
// (apps/api/src/adapters), and the order-book rebuild, price binning, ring buffer and volume buckets
// (apps/api/src/market-depth). Used under the MIT License:
//
//   Copyright (c) 2026 Crypto Market Screener contributors
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
//   the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
//   WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
//   OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
//   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXCLUDED } from "./perps-history.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000, HOUR = 3_600_000;
const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
export const LIQ = Object.freeze({
  refreshMs: num("LIQ_REFRESH_MS", 15_000),   // screener refresh
  perExchange: num("LIQ_PER_EXCHANGE", 15),   // coins per exchange given the full check (their LIVE_POLLING_SYMBOL_LIMIT)
  majors: ["BTC", "ETH", "SOL"],              // always in, first (their LivePollingJob)
  universeMs: 10 * MIN,                       // how often each exchange's full coin list is read again
  staleMs: 3 * MIN,                           // candles / book older than this do not count
  symbol: String(env.LIQ_SYMBOL || "BTCUSDT").toUpperCase(),
  sampleMs: 1000,                             // the heatmap samples the book every second
  historyMin: num("LIQ_HISTORY_MIN", 120),    // and keeps about 2 hours
  // price window: +-2% of the mid at most (their builder). Their floor is +-1.5%, but Binance's 1000-level book of a big
  // coin like BTC only reaches about +-0.2%, so the window here follows where the book has depth, down to +-0.25%.
  maxHalfPct: 0.02, minHalfPct: 0.0025,
  targetBins: 160,                            // price rows across the book's depth
  maxCols: 180,                               // time columns in one heatmap
  snapshotLimit: 1000,                        // levels per side in the REST snapshot (their LiquidityFeed)
  restLimit: 500, restPollMs: 2000,           // REST fallback: depth every 2 seconds
  wsFailsBeforeRest: 3,                       // WebSocket failures in a row before falling back to REST polling
});
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

// ============================================================================================================
// Screener engine (packages/screener-engine): metrics, the hotness score, the signal checks. Pure functions.
// ============================================================================================================
export const DEFAULT_CONFIG = Object.freeze({
  volumeSpike: { timeframe: "5m", relativeVolumeThreshold: 3.0 },
  pricePump: { timeframe: "5m", thresholdPercent: 2.0 },
  priceDump: { timeframe: "5m", thresholdPercent: -2.0 },
  volatilityExpansion: { timeframe: "5m", thresholdMultiplier: 2.0 },
  spreadWidening: { thresholdPercent: 0.15 },
  orderBookImbalance: { depthLevels: 20, thresholdRatio: 0.65 },
  openInterestSpike: { timeframe: "15m", thresholdPercent: 5.0 },
  fundingAnomaly: { absoluteThreshold: 0.03 },
  breakout: { lookbackCandles: 20, timeframe: "5m" },
  hotMarket: { scoreThreshold: 81 },
});
export const SCORE_BANDS = Object.freeze({ cold: { min: 0, max: 30 }, normal: { min: 31, max: 60 }, hot: { min: 61, max: 80 }, extreme: { min: 81, max: 100 } });
export const SCORE_WEIGHTS = Object.freeze({ momentumScore: 0.25, volumeScore: 0.25, volatilityScore: 0.2, liquidityScore: 0.15, orderBookScore: 0.15 });
export const SIGNAL_LABELS = Object.freeze({ VOLUME_SPIKE: "Volume spike", PRICE_PUMP: "Pump", PRICE_DUMP: "Dump", VOLATILITY_EXPANSION: "Volatility",
  SPREAD_WIDENING: "Wide spread", ORDER_BOOK_IMBALANCE: "Book imbalance", BREAKOUT: "Breakout", OI_SPIKE: "Open interest spike",
  FUNDING_ANOMALY: "Funding anomaly", HOT_MARKET: "Hot market" });

// The 0-100 hotness score: a weighted sum of five 0-100 parts. A missing part counts as 0 (with a warning); the result
// is rounded half up.
export function calculateHotMarketScore(subScores) {
  const warnings = [];
  let sum = 0;
  for (const key of Object.keys(SCORE_WEIGHTS)) {
    const raw = subScores?.[key];
    let v;
    if (typeof raw !== "number" || !Number.isFinite(raw)) { warnings.push(`Missing or non-finite sub-score: ${key}`); v = 0; }
    else if (raw < 0 || raw > 100) { warnings.push(`Sub-score out of [0,100] range, clamping: ${key}=${raw}`); v = Math.max(0, Math.min(100, raw)); }
    else v = raw;
    sum += v * SCORE_WEIGHTS[key];
  }
  return { score: Math.floor(Math.max(0, Math.min(100, sum)) + 0.5), warnings };
}
export function classifyScoreBand(score) {
  if (score <= SCORE_BANDS.cold.max) return "cold";
  if (score <= SCORE_BANDS.normal.max) return "normal";
  if (score <= SCORE_BANDS.hot.max) return "hot";
  return "extreme";
}
// Percent change; 0 when the earlier price is not positive.
export function calculatePriceChange(prev, cur) {
  if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0) return 0;
  return ((cur - prev) / prev) * 100;
}
// Volatility = standard deviation of the close-to-close % moves (0 under 2 candles). klines: [{ open, high, low, close, volume }]
export function calculateVolatility(klines) {
  if (klines.length < 2) return 0;
  const rets = [];
  for (let i = 1; i < klines.length; i++) { const p = klines[i - 1].close; if (p > 0) rets.push(((klines[i].close - p) / p) * 100); }
  if (!rets.length) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
}
// Spread in % of the mid; 0 when a side is missing.
export function calculateSpread(bid, ask) {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return 0;
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : 0;
}
// Book imbalance over the top `depth` levels: (bid qty - ask qty) / (bid qty + ask qty), from -1 to 1.
export function calculateOrderBookImbalance(bids, asks, depth = 20) {
  const sum = (lv) => (lv || []).slice(0, depth).reduce((a, [, q]) => a + (Number.isFinite(q) ? q : 0), 0);
  const b = sum(bids), a = sum(asks);
  return b + a > 0 ? (b - a) / (b + a) : 0;
}
export function calculateAverageVolume(klines, lookback) {
  const s = klines.slice(-lookback);
  return s.length ? s.reduce((a, k) => a + k.volume, 0) / s.length : 0;
}
// Did the last candle close above the highest high (or under the lowest low) of the `lookback` candles before it?
export function calculateRangeBreakout(klines, lookback) {
  if (klines.length <= lookback) return { brokeHigh: false, brokeLow: false };
  const last = klines[klines.length - 1];
  let hi = -Infinity, lo = Infinity;
  for (const k of klines.slice(-lookback - 1, -1)) { if (k.high > hi) hi = k.high; if (k.low < lo) lo = k.low; }
  return { brokeHigh: last.close > hi, brokeLow: last.close < lo };
}
// Straight line from [min, max] to [0, 100], clamped.
export function normalizeScore(value, min, max) {
  if (!Number.isFinite(value) || max <= min) return 0;
  return ((Math.max(min, Math.min(max, value)) - min) / (max - min)) * 100;
}

const SHORT_WINDOW = 5, BASELINE_LOOKBACK = 20; // the last 5 one-minute candles vs the 20 before them
const signal = (type, score, message, payload = {}) => ({ type, score, message, payload });
// s = a market snapshot: { market: { symbol, exchange, marketType, base, quote }, ticker: { last, bid, ask, volume24h, change24h },
// klines1m: [{ t, open, high, low, close, volume }] oldest first, orderBook: { bids, asks }, futures?, openInterestHistory? }
export function detectVolumeSpike(s, cfg = DEFAULT_CONFIG) {
  const k = s.klines1m;
  if (k.length < BASELINE_LOOKBACK + SHORT_WINDOW) return null;
  const base = calculateAverageVolume(k.slice(-BASELINE_LOOKBACK - SHORT_WINDOW, -SHORT_WINDOW), BASELINE_LOOKBACK);
  if (base <= 0) return null;
  const ratio = calculateAverageVolume(k.slice(-SHORT_WINDOW), SHORT_WINDOW) / base, th = cfg.volumeSpike.relativeVolumeThreshold;
  return ratio > th ? signal("VOLUME_SPIKE", Math.min(100, Math.round((ratio / th) * 60)), `Volume ${ratio.toFixed(2)}x baseline`, { ratio, threshold: th }) : null;
}
export function detectPricePump(s, cfg = DEFAULT_CONFIG) {
  const k = s.klines1m;
  if (k.length < SHORT_WINDOW + 1) return null;
  const ch = calculatePriceChange(k[k.length - SHORT_WINDOW].open, k[k.length - 1].close), th = cfg.pricePump.thresholdPercent;
  return ch > th ? signal("PRICE_PUMP", Math.min(100, Math.round((ch / th) * 50)), `Pump +${ch.toFixed(2)}% over ${cfg.pricePump.timeframe}`, { changePercent: ch }) : null;
}
export function detectPriceDump(s, cfg = DEFAULT_CONFIG) {
  const k = s.klines1m;
  if (k.length < SHORT_WINDOW + 1) return null;
  const ch = calculatePriceChange(k[k.length - SHORT_WINDOW].open, k[k.length - 1].close), th = cfg.priceDump.thresholdPercent;
  return ch < th ? signal("PRICE_DUMP", Math.min(100, Math.round((Math.abs(ch) / Math.abs(th)) * 50)), `Dump ${ch.toFixed(2)}% over ${cfg.priceDump.timeframe}`, { changePercent: ch }) : null;
}
export function detectVolatilityExpansion(s, cfg = DEFAULT_CONFIG) {
  const k = s.klines1m;
  if (k.length < BASELINE_LOOKBACK + SHORT_WINDOW) return null;
  const base = calculateVolatility(k.slice(-BASELINE_LOOKBACK - SHORT_WINDOW, -SHORT_WINDOW));
  if (base <= 0) return null;
  const ratio = calculateVolatility(k.slice(-SHORT_WINDOW)) / base;
  return ratio > cfg.volatilityExpansion.thresholdMultiplier ? signal("VOLATILITY_EXPANSION", Math.min(100, Math.round(ratio * 25)), `Volatility expanded ${ratio.toFixed(2)}x baseline`, { ratio }) : null;
}
export function detectSpreadWidening(s, cfg = DEFAULT_CONFIG) {
  const sp = calculateSpread(s.ticker.bid, s.ticker.ask), th = cfg.spreadWidening.thresholdPercent;
  return sp > th ? signal("SPREAD_WIDENING", Math.min(100, Math.round((sp / th) * 40)), `Spread ${sp.toFixed(3)}%`, { spreadPct: sp }) : null;
}
export function detectOrderBookImbalance(s, cfg = DEFAULT_CONFIG) {
  const im = calculateOrderBookImbalance(s.orderBook.bids, s.orderBook.asks, cfg.orderBookImbalance.depthLevels);
  return Math.abs(im) > cfg.orderBookImbalance.thresholdRatio ? signal("ORDER_BOOK_IMBALANCE", Math.min(100, Math.round(Math.abs(im) * 100)), `Imbalance ${(im * 100).toFixed(1)}%`, { imbalance: im }) : null;
}
export function detectBreakout(s, cfg = DEFAULT_CONFIG) {
  const { brokeHigh, brokeLow } = calculateRangeBreakout(s.klines1m, cfg.breakout.lookbackCandles);
  return brokeHigh || brokeLow ? signal("BREAKOUT", 75, brokeHigh ? "Range breakout (up)" : "Range breakout (down)", { direction: brokeHigh ? "up" : "down" }) : null;
}
// Futures only (open interest, funding): kept for completeness; this tab reads spot markets, so they never fire here.
export function detectOpenInterestSpike(s, cfg = DEFAULT_CONFIG) {
  if (s.market.marketType !== "futures") return null;
  const h = s.openInterestHistory ?? [];
  if (h.length < 2) return null;
  const last = h[h.length - 1], m = /^(\d+)m$/.exec(cfg.openInterestSpike.timeframe);
  const ago = last.ts - (m ? Number(m[1]) : 15) * MIN, first = h.find((x) => x.ts >= ago) ?? h[0];
  if (first.value <= 0) return null;
  const ch = ((last.value - first.value) / first.value) * 100;
  return ch > cfg.openInterestSpike.thresholdPercent ? signal("OI_SPIKE", Math.min(100, Math.round(ch * 5)), `OI +${ch.toFixed(2)}% in ${cfg.openInterestSpike.timeframe}`, { changePercent: ch }) : null;
}
export function detectFundingAnomaly(s, cfg = DEFAULT_CONFIG) {
  if (s.market.marketType !== "futures") return null;
  const fr = s.futures?.fundingRate ?? null;
  if (fr === null || !Number.isFinite(fr)) return null;
  return Math.abs(fr) > cfg.fundingAnomaly.absoluteThreshold ? signal("FUNDING_ANOMALY", Math.min(100, Math.round(Math.abs(fr) * 1000)), `Funding rate ${(fr * 100).toFixed(3)}%`, { fundingRate: fr }) : null;
}
export function detectHotMarket({ score }, cfg = DEFAULT_CONFIG) {
  return score >= cfg.hotMarket.scoreThreshold ? signal("HOT_MARKET", score, `Hot market score ${score}`, { score, threshold: cfg.hotMarket.scoreThreshold }) : null;
}
const changeOver = (k, minutes) => (k.length < 2 ? 0 : calculatePriceChange(k[Math.max(0, k.length - 1 - minutes)].open, k[k.length - 1].close));

// Every metric, the score and the signals for each snapshot (their runScreener, without the trades-per-minute figure:
// this tab does not read individual trades for the screener).
export function runScreener(snapshots, cfg = DEFAULT_CONFIG) {
  return snapshots.map((s) => {
    const k = s.klines1m;
    const change5m = changeOver(k, 5), change15m = changeOver(k, 15), change1h = changeOver(k, 60), change24h = s.ticker.change24h ?? changeOver(k, 1440);
    const recent = calculateAverageVolume(k.slice(-5), 5), base = calculateAverageVolume(k.slice(-25, -5), 20);
    const relativeVolume = base > 0 ? recent / base : 1;
    const volatility = calculateVolatility(k.slice(-25));
    const spreadPct = calculateSpread(s.ticker.bid, s.ticker.ask);
    const orderBookImbalance = calculateOrderBookImbalance(s.orderBook.bids, s.orderBook.asks, cfg.orderBookImbalance.depthLevels);
    const subScores = {
      momentumScore: normalizeScore(Math.abs(change5m), 0, 5),
      volumeScore: normalizeScore(relativeVolume, 1, 5),
      volatilityScore: normalizeScore(volatility, 0, 5),
      liquidityScore: normalizeScore(s.ticker.volume24h, 0, 100_000_000),
      orderBookScore: normalizeScore(Math.abs(orderBookImbalance), 0, 1),
    };
    const { score } = calculateHotMarketScore(subScores);
    const signals = [detectVolumeSpike(s, cfg), detectPricePump(s, cfg), detectPriceDump(s, cfg), detectVolatilityExpansion(s, cfg), detectSpreadWidening(s, cfg),
      detectOrderBookImbalance(s, cfg), detectBreakout(s, cfg), detectOpenInterestSpike(s, cfg), detectFundingAnomaly(s, cfg), detectHotMarket({ snapshot: s, score }, cfg)].filter(Boolean);
    return { symbol: s.market.symbol, exchange: s.market.exchange, marketType: s.market.marketType, quoteAsset: s.market.quote, price: s.ticker.last,
      change5m, change15m, change1h, change24h, volume24h: s.ticker.volume24h, relativeVolume, volatility, spreadPct, orderBookImbalance,
      signalScore: score, scoreBand: classifyScoreBand(score), subScores, activeSignals: signals.map((x) => x.type), signals };
  });
}

// One row per coin from its markets on every exchange. venues: [{ exchange, base, symbol, quote, ticker, result (runScreener
// result, or null without fresh candles and book) }]. The coin's score, band and signals are those of its hottest exchange;
// its volume is the sum; priceGapPct = how far apart the exchanges' last prices are.
export function mergeRows(venues) {
  const by = new Map();
  for (const v of venues) { if (!(v.ticker?.last > 0)) continue; if (!by.has(v.base)) by.set(v.base, []); by.get(v.base).push(v); }
  const rows = [];
  for (const [coin, list] of by) {
    const vs = list.map((v) => {
      const r = v.result, t = v.ticker;
      return { ex: v.exchange, sym: v.symbol, quote: v.quote, price: r?.price ?? t.last, change24h: r2(r?.change24h ?? t.change24h, 2), volumeUsd: Math.round(t.volUsd || 0),
        deep: !!r, score: r ? r.signalScore : null, band: r ? r.scoreBand : null, change5m: r ? r2(r.change5m, 2) : null, change15m: r ? r2(r.change15m, 2) : null,
        change1h: r ? r2(r.change1h, 2) : null, relVol: r ? r2(r.relativeVolume, 2) : null, volatility: r ? r2(r.volatility, 3) : null,
        spreadPct: r ? r2(r.spreadPct, 4) : t.bid > 0 && t.ask > 0 ? r2(calculateSpread(t.bid, t.ask), 4) : null, imbalance: r ? r2(r.orderBookImbalance, 3) : null,
        signals: r ? r.signals.map((x) => ({ type: x.type, score: x.score, message: x.message })) : [], deepAt: v.deepAt ?? null, tickAt: v.tickAt ?? null };
    }).sort((a, b) => b.volumeUsd - a.volumeUsd);
    const deep = vs.filter((x) => x.deep);
    const lead = deep.slice().sort((a, b) => b.score - a.score || b.volumeUsd - a.volumeUsd)[0] || null;
    const sigs = new Map();
    for (const v of deep) for (const s of v.signals) {
      const g = sigs.get(s.type) || { type: s.type, label: SIGNAL_LABELS[s.type] || s.type, venues: [], score: -1, message: "" };
      g.venues.push(v.ex);
      if (s.score > g.score) Object.assign(g, { score: s.score, message: `${s.message} (${v.ex})` });
      sigs.set(s.type, g);
    }
    const px = vs.map((x) => x.price).filter((x) => x > 0), top = lead || vs[0];
    rows.push({ coin, score: lead ? lead.score : null, band: lead ? lead.band : null, lead: lead ? lead.ex : null, exchanges: vs.map((x) => x.ex),
      price: top.price, change24h: top.change24h, change5m: lead?.change5m ?? null, change15m: lead?.change15m ?? null, change1h: lead?.change1h ?? null,
      relVol: lead?.relVol ?? null, spreadPct: lead?.spreadPct ?? top.spreadPct, imbalance: lead?.imbalance ?? null,
      volumeUsd: vs.reduce((a, x) => a + x.volumeUsd, 0), priceGapPct: px.length > 1 ? r2((Math.max(...px) / Math.min(...px) - 1) * 100, 3) : null,
      signals: [...sigs.values()].sort((a, b) => b.score - a.score), venues: vs });
  }
  return rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.volumeUsd - a.volumeUsd);
}

// ============================================================================================================
// Exchanges (apps/api/src/adapters): public endpoints only. Each one lists its USDT/USD spot pairs with prices and
// 24h volume in dollars, reads prices for a given list, 60 one-minute candles, and the top 20 book levels.
// ============================================================================================================
const BIN = "https://api.binance.com", BIN_WS = "wss://stream.binance.com:9443/stream";
const BYB = "https://api.bybit.com", OKX = "https://www.okx.com", CBX = "https://api.exchange.coinbase.com", CBA = "https://api.coinbase.com", KRK = "https://api.kraken.com";
// Left out of the screener: stablecoins, fiat, tokenized gold and stocks, wrapped coins (they never "run").
const SKIP = new Set([...EXCLUDED, "USDT", "USD", "USDS", "RLUSD", "USDG", "USDQ", "USDR", "USD0", "USDX", "USDB", "BFUSD", "EURC", "EURI", "EURQ", "EURT", "EURR",
  "U", "FRAX", "USDD", "LUSD", "GUSD", "PAX", "SUSD", "TRY", "BRL", "AUD", "CAD", "CHF", "JPY", "MXN", "ZAR", "PLN", "UAH", "ARS", "IDR", "VAI", "DOLA", "FDUSD"]);
// Tokenized US stocks and ETFs: Binance names them ROOT+"B" (NVDAB, "bStocks"), OKX "X"+ROOT (XNVDA), Bybit and Kraken
// ROOT+"X" (xStocks), Ondo ROOT+"ON". Roots that are also real coin tickers (STX, QNT, WEN...) are not listed here; the
// app's own Binance tag check (the `excluded` option) catches the rest, and its roots are learned the same way.
const STOCK_ROOTS = new Set(["AAPL", "AMD", "AMZN", "COIN", "CRCL", "GOOGL", "GOOG", "HOOD", "INTC", "META", "MSFT", "MSTR", "NFLX", "NVDA", "PLTR", "QQQ",
  "SPY", "TSLA", "IBM", "ORCL", "BABA", "GME", "AMC", "UBER", "SNAP", "PYPL", "SHOP", "AVGO", "TSM", "SMCI", "JPM", "DIS", "SNDK", "SPCX", "EWY", "LITE",
  "CBRS", "DRAM", "GLW", "NBIS", "QCOM", "SOXL", "SOXS", "WDC", "SKHY", "AAOI", "MRVL", "NOK", "RKLB", "AXTI", "CRWV", "INTW", "KORU", "TQQQ", "SQQQ",
  "AMAT", "DELL", "FLNC", "SMH", "ASML", "ASTS", "BMNR", "COHR", "CRDO", "IREN", "USAR", "ALAB", "DJT", "CRWD", "MRNA", "HIMS", "GPRO", "RDDT", "ADBE",
  "FWDI", "HPE", "PDD", "LLY", "MDB", "UVXY", "TMF", "GEV", "BRKB", "OKLO", "ONDS", "RIVN", "TTWO", "CRM", "SONY", "TSLL", "MU"]);
const stockLike = (b, roots = STOCK_ROOTS) => roots.has(b) || (b.length > 3 && ((b.endsWith("B") && roots.has(b.slice(0, -1))) || (b.startsWith("X") && roots.has(b.slice(1))) ||
  (b.endsWith("X") && roots.has(b.slice(0, -1))) || (b.endsWith("ON") && roots.has(b.slice(0, -2)))));
// A coin pinned at $1 that barely moved in 24 hours is a stablecoin whatever its name (new ones keep appearing).
const skipBase = (b, last, change) => SKIP.has(b) || stockLike(b) || (/USD|EUR/.test(b) && last > 0.97 && last < 1.03 && Math.abs(change || 0) < 1) ||
  (last > 0.99 && last < 1.01 && Math.abs(change || 0) < 0.5);
const lv = (rows) => (rows || []).map((x) => [Number(x[0] ?? x.price), Number(x[1] ?? x.size)]).filter(([p, q]) => p > 0 && q >= 0);
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const bybitOk = (d) => { if (d?.retCode !== 0) throw new Error(`Bybit: ${d?.retMsg || "unexpected reply"}`); return d.result; };
const okxOk = (d) => { if (d?.code !== "0") throw new Error(`OKX: ${d?.msg || "unexpected reply"}`); return d.data; };
const krakenOk = (d) => { if (d?.error?.length) throw new Error(`Kraken: ${d.error.join(", ")}`); if (!d?.result) throw new Error("Kraken: unexpected reply"); return d.result; };
const krakenBase = (b) => (b === "XBT" ? "BTC" : b === "XDG" ? "DOGE" : b);

export function exchangeAdapters(get, onBinanceSymbols = () => {}) {
  const binTick = (x) => ({ last: +x.lastPrice, bid: +x.bidPrice, ask: +x.askPrice, volUsd: +x.quoteVolume, change24h: +x.priceChangePercent });
  const bybTick = (x) => ({ last: +x.lastPrice, bid: +x.bid1Price, ask: +x.ask1Price, volUsd: +x.turnover24h, change24h: +x.price24hPcnt * 100 });
  const okxTick = (x) => ({ last: +x.last, bid: +x.bidPx, ask: +x.askPx, volUsd: +x.volCcy24h, change24h: +x.open24h > 0 ? (+x.last / +x.open24h - 1) * 100 : 0 });
  const cbTick = (s) => { const d = s?.stats_24hour || {}, last = +d.last; return { last, bid: null, ask: null, volUsd: +d.volume * last, change24h: +d.open > 0 ? (last / +d.open - 1) * 100 : 0 }; };
  // Kraken: v[1] = 24h volume in coins, p[1] = 24h average price; "o" is today's open (00:00 UTC), so its change is since then
  const krTick = (k) => ({ last: +k.c?.[0], bid: +k.b?.[0], ask: +k.a?.[0], volUsd: +k.v?.[1] * +k.p?.[1], change24h: +k.o > 0 ? (+k.c?.[0] / +k.o - 1) * 100 : 0 });
  const kl = (t, o, h, l, c, v) => ({ t, open: +o, high: +h, low: +l, close: +c, volume: +v });
  let cbProducts = null, cbAt = 0, krPairs = null, krAt = 0;
  const cbList = async () => {
    if (cbProducts && Date.now() - cbAt < HOUR) return cbProducts;
    const m = new Map();
    for (const p of (await get(`${CBX}/products`)) || []) if (p.status === "online" && !p.trading_disabled && (p.quote_currency === "USD" || p.quote_currency === "USDT")) m.set(p.id, { base: p.base_currency, quote: p.quote_currency });
    if (!m.size) throw new Error("Coinbase: no products");
    cbProducts = m; cbAt = Date.now(); return m;
  };
  const krList = async () => {
    if (krPairs && Date.now() - krAt < HOUR) return krPairs;
    const m = new Map();
    for (const [key, x] of Object.entries(krakenOk(await get(`${KRK}/0/public/AssetPairs`)))) {
      const [b, q] = String(x.wsname || "").split("/");
      if (x.status === "online" && b && (q === "USD" || q === "USDT")) m.set(key, { base: krakenBase(b), quote: q });
    }
    krPairs = m; krAt = Date.now(); return m;
  };
  return [
    { id: "binance", name: "Binance", deepPerCycle: 8, conc: 2,
      async markets() {
        const all = new Set(), out = [];
        for (const x of (await get(`${BIN}/api/v3/ticker/24hr`)) || []) {
          if (!(+x.count > 0)) continue;
          all.add(x.symbol);
          if (x.symbol.endsWith("USDT")) out.push({ sym: x.symbol, base: x.symbol.slice(0, -4), quote: "USDT", ...binTick(x) });
        }
        onBinanceSymbols(all);
        return out;
      },
      async tickers(list) { // up to 20 symbols per request (the cheapest weight)
        const m = new Map();
        for (const c of chunk(list.map((v) => v.sym), 20)) for (const x of (await get(`${BIN}/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(c))}`)) || []) m.set(x.symbol, binTick(x));
        return m;
      },
      klines: async (v) => ((await get(`${BIN}/api/v3/klines?symbol=${v.sym}&interval=1m&limit=60`)) || []).map((r) => kl(+r[0], r[1], r[2], r[3], r[4], r[5])),
      book: async (v) => { const d = await get(`${BIN}/api/v3/depth?symbol=${v.sym}&limit=20`); return { bids: lv(d.bids), asks: lv(d.asks) }; } },
    { id: "bybit", name: "Bybit", deepPerCycle: 15, conc: 3,
      async markets() { return bybitOk(await get(`${BYB}/v5/market/tickers?category=spot`)).list.filter((x) => x.symbol.endsWith("USDT")).map((x) => ({ sym: x.symbol, base: x.symbol.slice(0, -4), quote: "USDT", ...bybTick(x) })); },
      async tickers() { return new Map(bybitOk(await get(`${BYB}/v5/market/tickers?category=spot`)).list.map((x) => [x.symbol, bybTick(x)])); },
      klines: async (v) => bybitOk(await get(`${BYB}/v5/market/kline?category=spot&symbol=${v.sym}&interval=1&limit=60`)).list.slice().reverse().map((r) => kl(+r[0], r[1], r[2], r[3], r[4], r[5])),
      book: async (v) => { const r = bybitOk(await get(`${BYB}/v5/market/orderbook?category=spot&symbol=${v.sym}&limit=20`)); return { bids: lv(r.b), asks: lv(r.a) }; } },
    { id: "okx", name: "OKX", deepPerCycle: 15, conc: 3,
      async markets() {
        return okxOk(await get(`${OKX}/api/v5/market/tickers?instType=SPOT`)).map((x) => { const [b, q] = x.instId.split("-"); return { sym: x.instId, base: b, quote: q, ...okxTick(x) }; })
          .filter((x) => x.quote === "USDT" || x.quote === "USD");
      },
      async tickers() { return new Map(okxOk(await get(`${OKX}/api/v5/market/tickers?instType=SPOT`)).map((x) => [x.instId, okxTick(x)])); },
      klines: async (v) => okxOk(await get(`${OKX}/api/v5/market/candles?instId=${v.sym}&bar=1m&limit=60`)).slice().reverse().map((r) => kl(+r[0], r[1], r[2], r[3], r[4], r[5])),
      book: async (v) => { const d = okxOk(await get(`${OKX}/api/v5/market/books?instId=${v.sym}&sz=20`))[0] || {}; return { bids: lv(d.bids), asks: lv(d.asks) }; } },
    { id: "coinbase", name: "Coinbase", deepPerCycle: 8, conc: 2,
      async markets() {
        const [p, stats] = [await cbList(), await get(`${CBX}/products/stats`)];
        return [...p].filter(([id]) => stats?.[id]).map(([id, x]) => ({ sym: id, base: x.base, quote: x.quote, ...cbTick(stats[id]) }));
      },
      async tickers() { const stats = await get(`${CBX}/products/stats`); return new Map(Object.entries(stats || {}).map(([id, s]) => [id, cbTick(s)])); },
      klines: async (v) => ((await get(`${CBX}/products/${v.sym}/candles?granularity=60`)) || []).slice(0, 60).reverse().map((r) => kl(r[0] * 1000, r[3], r[2], r[1], r[4], r[5])),
      // Coinbase Exchange's level-2 book is the whole book (about 1 MB for BTC); the Advanced Trade public book takes a limit
      book: async (v) => { const b = (await get(`${CBA}/api/v3/brokerage/market/product_book?product_id=${v.sym}&limit=20`))?.pricebook || {}; return { bids: lv(b.bids), asks: lv(b.asks) }; } },
    { id: "kraken", name: "Kraken", deepPerCycle: 4, conc: 1,
      async markets() {
        const [pairs, t] = [await krList(), krakenOk(await get(`${KRK}/0/public/Ticker`))];
        return [...pairs].filter(([key]) => t[key]).map(([key, x]) => ({ sym: key, base: x.base, quote: x.quote, ...krTick(t[key]) }));
      },
      async tickers(list) {
        const m = new Map();
        for (const c of chunk(list.map((v) => v.sym), 40)) for (const [k, x] of Object.entries(krakenOk(await get(`${KRK}/0/public/Ticker?pair=${c.join(",")}`)))) m.set(k, krTick(x));
        return m;
      },
      klines: async (v) => { const r = krakenOk(await get(`${KRK}/0/public/OHLC?pair=${v.sym}&interval=1`)); const rows = Object.entries(r).find(([k]) => k !== "last")?.[1] || [];
        return rows.slice(-60).map((x) => kl(x[0] * 1000, x[1], x[2], x[3], x[4], x[6])); },
      book: async (v) => { const d = Object.values(krakenOk(await get(`${KRK}/0/public/Depth?pair=${v.sym}&count=20`)))[0] || {}; return { bids: lv(d.bids), asks: lv(d.asks) }; } },
  ];
}

// ============================================================================================================
// Order book, price bins, ring buffer (apps/api/src/market-depth)
// ============================================================================================================
// Fixed-size first-in first-out buffer: push drops the oldest entry when full.
export class RingBuffer {
  constructor(capacity) {
    if (!(capacity > 0)) throw new Error("RingBuffer capacity must be > 0");
    this.capacity = capacity; this.buf = new Array(capacity); this.head = 0; this.count = 0;
  }
  push(x) { this.buf[this.head] = x; this.head = (this.head + 1) % this.capacity; if (this.count < this.capacity) this.count++; }
  pushMany(xs) { for (const x of xs) this.push(x); }
  size() { return this.count; }
  last() { return this.count ? this.buf[(this.head - 1 + this.capacity) % this.capacity] : undefined; }
  first() { return this.count ? this.buf[this.count < this.capacity ? 0 : this.head] : undefined; }
  toArray() { // oldest first
    const out = new Array(this.count), start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) out[i] = this.buf[(start + i) % this.capacity];
    return out;
  }
  filter(fn) { return this.toArray().filter(fn); }
  clear() { this.buf = new Array(this.capacity); this.head = 0; this.count = 0; }
}

// A local copy of one Binance order book: a REST snapshot plus the diff updates (U = first update id in the event,
// u = last). applyDiff answers "applied", "stale" (older than the book: ignored) or "needs_resync" (a missed update:
// the caller must fetch a fresh snapshot). It never makes up data.
export function createBook() {
  const fresh = () => ({ lastUpdateId: 0, bids: new Map(), asks: new Map(), lastEventMs: 0, needsResync: true, bridged: false });
  let st = fresh();
  const set = (side, rows) => { for (const [p, q] of rows) { const price = Number.parseFloat(p), qty = Number.parseFloat(q); if (qty === 0) side.delete(price); else if (qty > 0) side.set(price, qty); } };
  return {
    applySnapshot(snap) {
      st.bids = new Map(); st.asks = new Map();
      set(st.bids, snap.bids || []); set(st.asks, snap.asks || []);
      st.lastUpdateId = Number(snap.lastUpdateId); st.needsResync = false;
      st.bridged = false; // the next diff must straddle the snapshot again
    },
    applyDiff(d) {
      if (st.needsResync) return "needs_resync";
      if (d.u <= st.lastUpdateId) return "stale";
      if (st.lastUpdateId !== 0) {
        // the first diff after a snapshot must contain lastUpdateId + 1; every later one must follow on exactly
        if (!st.bridged ? d.U > st.lastUpdateId + 1 : d.U !== st.lastUpdateId + 1) { st.needsResync = true; return "needs_resync"; }
      }
      set(st.bids, d.b || []); set(st.asks, d.a || []);
      st.lastUpdateId = d.u; if (d.E) st.lastEventMs = d.E; st.bridged = true;
      return "applied";
    },
    topOfBook(n) { // bids highest first, asks lowest first
      return { bids: [...st.bids].sort((a, b) => b[0] - a[0]).slice(0, n), asks: [...st.asks].sort((a, b) => a[0] - b[0]).slice(0, n) };
    },
    sides: () => [st.bids, st.asks],
    needsResync: () => st.needsResync,
    lastUpdateId: () => st.lastUpdateId,
    markStale() { st.needsResync = true; st.bridged = false; },
    reset() { st = fresh(); },
  };
}

// Binance's documented way to keep that copy in step with the diff-depth stream: (1) open the stream and buffer the
// updates; (2) get a REST snapshot; (3) if the snapshot is older than the first buffered update, get it again; (4) drop
// buffered updates with u <= lastUpdateId; (5) the first one left must contain lastUpdateId + 1; (6) apply the rest in
// order. Later, an update whose U is not the previous u + 1 means one was missed: buffer from there and go back to (2).
// Snapshots are at least minGapMs apart (each costs request weight).
export function createDepthSync({ book, fetchSnapshot, now = Date.now, minGapMs = 3_000, maxBuffer = 3_000, onError = () => {} }) {
  let buffer = [], inflight = false, lastFetch = -Infinity, timer = null, stopped = false;
  const stats = { resyncs: 0, snapshots: 0, oldSnapshots: 0 };
  const later = (ms) => { if (!timer && !stopped) timer = setTimeout(() => { timer = null; request(); }, ms); };
  function request() {
    if (inflight || timer || stopped) return;
    const wait = lastFetch + minGapMs - now();
    if (wait > 0) { later(wait); return; }
    inflight = true; lastFetch = now();
    Promise.resolve().then(fetchSnapshot).then((snap) => { inflight = false; if (!stopped) applySnapshot(snap); },
      (e) => { inflight = false; onError(e); if (book.needsResync()) later(Math.max(minGapMs, 5_000)); });
  }
  function applySnapshot(snap) {
    const id = Number(snap?.lastUpdateId);
    if (!Number.isFinite(id)) { onError(new Error("order book snapshot without lastUpdateId")); later(Math.max(minGapMs, 5_000)); return "bad"; }
    const left = buffer.filter((d) => d.u > id);
    if (left.length && left[0].U > id + 1) { stats.oldSnapshots++; buffer = left; book.markStale(); request(); return "old"; }
    book.applySnapshot(snap); stats.snapshots++; buffer = [];
    for (let i = 0; i < left.length; i++) if (book.applyDiff(left[i]) === "needs_resync") { stats.resyncs++; buffer = left.slice(i); request(); return "gap"; }
    return "ok";
  }
  return {
    onDiff(d) {
      if (stopped) return "stopped";
      if (book.needsResync()) { buffer.push(d); if (buffer.length > maxBuffer) buffer.shift(); request(); return "buffered"; }
      const r = book.applyDiff(d);
      if (r === "needs_resync") { stats.resyncs++; buffer = [d]; request(); }
      return r;
    },
    applySnapshot,
    reset() { buffer = []; clearTimeout(timer); timer = null; },
    start() { stopped = false; },
    stop() { stopped = true; buffer = []; clearTimeout(timer); timer = null; },
    buffered: () => buffer.length,
    stats,
  };
}

// Price bins (PriceBinner): auto = the visible price range cut into ~targetBins rows; or a fixed % of the mid.
const PERCENT_MAP = { "0.1%": 0.001, "0.25%": 0.0025, "0.5%": 0.005, "1%": 0.01 };
export function chooseBinWidth(midPrice, mode = "auto", halfRangePct = 0.05, options = {}) {
  if (!Number.isFinite(midPrice) || midPrice <= 0) return { binWidth: 1, midPrice };
  if (mode !== "auto") return { binWidth: midPrice * PERCENT_MAP[mode], midPrice };
  const target = options.targetBins ?? 120;
  const range = options.priceMin !== undefined && options.priceMax !== undefined && options.priceMax > options.priceMin ? options.priceMax - options.priceMin : midPrice * halfRangePct * 2;
  const raw = range / target;
  return !Number.isFinite(raw) || raw <= 0 ? { binWidth: midPrice * 0.0005, midPrice } : { binWidth: raw, midPrice };
}
export function priceToBin(price, binWidth) {
  if (binWidth <= 0 || !Number.isFinite(price)) return 0;
  return Math.floor(price / binWidth) * binWidth;
}
// Bin index of a price (priceToBin / binWidth), with a hair of tolerance for float error (77000 / 20 must be 3850).
export const binIndex = (price, w) => Math.floor(price / w + 1e-7);
// A round bin width (1, 2, 2.5 or 5 x a power of ten) so the price rows read cleanly and stay fixed for the session.
export function niceStep(x) {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const pow = 10 ** Math.floor(Math.log10(x)), m = x / pow;
  return Number(((m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * pow).toPrecision(12));
}
export const pickBinWidth = (mid, half = LIQ.maxHalfPct, p = LIQ) => niceStep(chooseBinWidth(mid, "auto", half, { priceMin: mid * (1 - half), priceMax: mid * (1 + half), targetBins: p.targetBins }).binWidth);
// The price grid of a feed, chosen once from the first full book: how far its 500th level sits from the mid on either
// side (kept within minHalf..maxHalf) gives the rows; each sample keeps 1.5x that distance (so a moving price stays in).
export function chooseGrid(bids, asks, mid, p = LIQ) {
  const depth = (prices) => (prices.length ? Math.abs(prices[Math.min(prices.length - 1, 500)] - mid) / mid : 0);
  const half = Math.min(p.maxHalfPct, Math.max(p.minHalfPct, depth([...bids.keys()].sort((a, b) => b - a)), depth([...asks.keys()].sort((a, b) => a - b))));
  return { binWidth: pickBinWidth(mid, half, p), storeHalf: Math.min(p.maxHalfPct, half * 1.5), half };
}
// Resting liquidity in dollars (price x quantity) per price bin, within +-half of the mid. bids/asks: Maps or [[price, qty]].
export function binBook(bids, asks, mid, w, half = LIQ.maxHalfPct) {
  const lo = binIndex(mid * (1 - half), w), n = binIndex(mid * (1 + half), w) - lo + 1;
  const bid = new Float64Array(n), ask = new Float64Array(n);
  for (const [p, q] of bids) { const i = binIndex(p, w) - lo; if (i >= 0 && i < n) bid[i] += p * q; }
  for (const [p, q] of asks) { const i = binIndex(p, w) - lo; if (i >= 0 && i < n) ask[i] += p * q; }
  return { lo, bid: Float32Array.from(bid), ask: Float32Array.from(ask) };
}
// Trades bucketed into buy / sell dollar volume (DeltaCalculator): buyerIsMaker = the taker sold.
export function bucketDelta(trades, ms) {
  const map = new Map();
  for (const t of trades) {
    const k = Math.floor(t.t / ms) * ms, row = map.get(k) || { t: k, buyVolume: 0, sellVolume: 0, delta: 0, cumulativeDelta: 0 };
    if (t.buyerIsMaker) row.sellVolume += t.qty * t.price; else row.buyVolume += t.qty * t.price;
    map.set(k, row);
  }
  let cum = 0;
  return [...map.values()].sort((a, b) => a.t - b.t).map((r) => { r.delta = r.buyVolume - r.sellVolume; cum += r.delta; r.cumulativeDelta = cum; return r; });
}

// ============================================================================================================
// The live heatmap feed for one Binance spot pair
// ============================================================================================================
export function createDepthFeed({ symbol, fetchJson, WS = globalThis.WebSocket, now = Date.now, p = LIQ, timers = true }) {
  const sym = String(symbol).toUpperCase(), lower = sym.toLowerCase();
  const book = createBook();
  const samples = new RingBuffer(Math.ceil((p.historyMin * MIN) / p.sampleMs) + 5); // { t, mid, bestBid, bestAsk, lo, bid, ask }
  const tape = new RingBuffer(p.historyMin * 60 + 5); // trades per second: { t, buy, sell, o, h, l, c, n }
  const st = { symbol: sym, exchange: "binance", mode: "stopped", connected: false, startedAt: null, lastError: null, updates: 0, trades: 0, lastEventAt: null, wsFails: 0, restPolls: 0 };
  let binWidth = null, storeHalf = p.maxHalfPct, sock = null, stopped = true, sampleTimer = null, reconnectTimer = null, restTimer = null, restBusy = false, lastAggId = null;
  const get = (q) => fetchJson(BIN + q, { retries: 0, timeoutMs: 10_000 });
  const sync = createDepthSync({ book, now, fetchSnapshot: () => get(`/api/v3/depth?symbol=${sym}&limit=${p.snapshotLimit}`), onError: (e) => { st.lastError = `order book snapshot: ${e.message}`; } });

  function onTrade(T, price, qty, takerSold) {
    if (!(price > 0) || !(qty > 0) || !Number.isFinite(T)) return;
    const sec = Math.floor(T / 1000) * 1000, last = tape.last(), usd = price * qty;
    let b = last && last.t >= sec ? last : null; // a late trade joins the newest second
    if (!b) { b = { t: sec, buy: 0, sell: 0, o: price, h: price, l: price, c: price, n: 0 }; tape.push(b); }
    if (takerSold) b.sell += usd; else b.buy += usd;
    if (price > b.h) b.h = price; if (price < b.l) b.l = price; b.c = price; b.n++; st.trades++;
  }
  function onMessage(raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const s = String(m?.stream || ""), d = m?.data;
    if (!d) return;
    st.lastEventAt = now();
    if (s.includes("@depth")) { st.updates++; sync.onDiff({ E: +d.E, U: +d.U, u: +d.u, b: d.b || [], a: d.a || [] }); }
    else if (s.includes("@aggTrade")) onTrade(+d.T, +d.p, +d.q, !!d.m);
  }
  // Every second: the book cut into price bins (skipped while the book is being rebuilt).
  function sample() {
    if (stopped && timers) return false;
    if (book.needsResync()) return false;
    const [bids, asks] = book.sides();
    let bb = -Infinity, ba = Infinity;
    for (const k of bids.keys()) if (k > bb) bb = k;
    for (const k of asks.keys()) if (k < ba) ba = k;
    if (!(bb > 0) || !(ba < Infinity) || ba <= bb) return false;
    const mid = (bb + ba) / 2;
    if (!binWidth) ({ binWidth, storeHalf } = chooseGrid(bids, asks, mid, p));
    samples.push({ t: now(), mid, bestBid: bb, bestAsk: ba, ...binBook(bids, asks, mid, binWidth, storeHalf) });
    return true;
  }
  function connect() {
    if (stopped) return;
    if (typeof WS !== "function") { toRest("this Node version has no WebSocket"); return; }
    let ws;
    try { ws = new WS(`${BIN_WS}?streams=${lower}@depth@100ms/${lower}@aggTrade`); } catch (e) { wsFailed(e.message); return; }
    sock = ws;
    let opened = false;
    const guard = setTimeout(() => { if (!opened && sock === ws) { sock = null; try { ws.close(); } catch { /* ignore */ } wsFailed("it did not open within 10 s"); } }, 10_000);
    ws.onopen = () => {
      if (sock !== ws || stopped) return;
      opened = true; clearTimeout(guard);
      Object.assign(st, { connected: true, mode: "websocket", wsFails: 0, lastError: null });
      stopRest(); book.markStale(); sync.reset(); // the first diffs are buffered; the snapshot is fetched once they arrive
    };
    ws.onmessage = (ev) => { if (sock === ws && !stopped) onMessage(typeof ev.data === "string" ? ev.data : String(ev.data)); };
    ws.onerror = (ev) => { if (sock === ws) st.lastError = `WebSocket: ${ev?.message || ev?.error?.message || "connection error"}`; };
    ws.onclose = () => {
      clearTimeout(guard);
      if (sock !== ws) return;
      sock = null; st.connected = false;
      if (stopped) return;
      book.markStale();
      wsFailed(st.lastError || "closed");
    };
  }
  function wsFailed(why) {
    st.wsFails++;
    if (st.wsFails >= p.wsFailsBeforeRest && st.mode !== "rest") toRest(why);
    const delay = st.mode === "rest" ? 60_000 : Math.min(30_000, 1000 * 2 ** Math.min(st.wsFails - 1, 5));
    clearTimeout(reconnectTimer);
    if (!stopped) reconnectTimer = setTimeout(connect, delay);
  }
  // Fallback: the REST order book (and recent trades) every 2 seconds while the WebSocket is unavailable.
  function toRest(why) {
    st.mode = "rest"; st.lastError = `WebSocket unavailable (${why}); polling the REST order book every ${p.restPollMs / 1000} s`;
    sync.reset();
    if (!restTimer && timers) { restTimer = setInterval(restTick, p.restPollMs); restTick(); }
  }
  function stopRest() { clearInterval(restTimer); restTimer = null; }
  async function restTick() {
    if (restBusy || stopped || st.mode !== "rest") return;
    restBusy = true;
    try {
      const snap = await get(`/api/v3/depth?symbol=${sym}&limit=${p.restLimit}`);
      if (stopped || st.mode !== "rest") return;
      book.applySnapshot(snap); st.restPolls++; st.lastEventAt = now();
      const tr = await get(`/api/v3/aggTrades?symbol=${sym}&limit=1000${lastAggId != null ? `&fromId=${lastAggId + 1}` : ""}`);
      const from = tape.last()?.t ?? st.startedAt ?? 0;
      for (const x of tr || []) { if (lastAggId != null && x.a <= lastAggId) continue; lastAggId = x.a; if (x.T >= from) onTrade(+x.T, +x.p, +x.q, !!x.m); }
      if ((tr || []).length && tr[tr.length - 1].T < now() - 10_000) lastAggId = null; // fell behind: jump to the latest trades
    } catch (e) { st.lastError = `REST polling: ${e.message}`; } finally { restBusy = false; }
  }
  function start() {
    if (!stopped) return;
    stopped = false; st.startedAt = now(); st.mode = "connecting";
    sync.start(); sync.reset();
    connect();
    if (timers) sampleTimer = setInterval(sample, p.sampleMs);
  }
  function stop() {
    stopped = true;
    clearInterval(sampleTimer); clearTimeout(reconnectTimer); stopRest(); sync.stop();
    const ws = sock; sock = null;
    try { ws?.close(); } catch { /* ignore */ }
    st.connected = false; st.mode = "stopped";
  }
  function status() {
    return { ...st, resyncs: sync.stats.resyncs, snapshots: sync.stats.snapshots + st.restPolls, needsResync: book.needsResync(), binWidth,
      samples: samples.size(), historyMs: samples.size() ? samples.last().t - samples.first().t : 0, bufferedUpdates: sync.buffered() };
  }
  // The current book: best prices, spread, imbalance (top 20 levels, by quantity), the 20 best levels, the book grouped
  // into the heatmap's price bins near the price, and the biggest walls in the sampled range (the latest sample).
  function bookView() {
    if (book.needsResync()) return null;
    const { bids, asks } = book.topOfBook(20);
    if (!bids.length || !asks.length) return null;
    const bestBid = bids[0][0], bestAsk = asks[0][0], mid = (bestBid + bestAsk) / 2;
    const out = { bestBid, bestAsk, mid, spread: bestAsk - bestBid, spreadPct: r2(((bestAsk - bestBid) / mid) * 100, 4), imbalance: r2(calculateOrderBookImbalance(bids, asks, 20), 3), bids, asks };
    if (binWidth) {
      const w = binWidth, [mb, ma] = book.sides(), gb = new Map(), ga = new Map(), ib = binIndex(bestBid, w), ia = binIndex(bestAsk, w);
      for (const [px, q] of mb) { const i = binIndex(px, w); if (ib - i < 15) gb.set(i, (gb.get(i) || 0) + px * q); }
      for (const [px, q] of ma) { const i = binIndex(px, w); if (i - ia < 15) ga.set(i, (ga.get(i) || 0) + px * q); }
      out.grouped = { binWidth: w, bids: [...gb].sort((a, b) => b[0] - a[0]).map(([i, v]) => [r2(i * w, 10), Math.round(v)]), asks: [...ga].sort((a, b) => a[0] - b[0]).map(([i, v]) => [r2(i * w, 10), Math.round(v)]) };
      const s = samples.last();
      if (s) {
        const walls = (arr, keep) => [...arr].map((v, i) => [r2((s.lo + i) * w, 10), Math.round(v)]).filter(keep).sort((a, b) => b[1] - a[1]).slice(0, 3);
        out.walls = { bids: walls(s.bid, ([px, v]) => v > 0 && px <= bestBid), asks: walls(s.ask, ([px, v]) => v > 0 && px + w > bestAsk) };
      }
    }
    return out;
  }
  // The heatmap: average resting dollars per (time column, price bin) over the last lookbackMin minutes, columns of 5 s
  // or more (at most maxCols), price rows where the book had orders (their builder's rule: the book's extent, at most
  // +-maxHalf and at least +-minHalf around the latest mid); trade volume and OHLC per column. Values are sent as whole
  // numbers of `unit` dollars to keep the reply small.
  function heatmap(lookbackMin = 30) {
    const lb = Math.max(1, Math.min(p.historyMin, Math.round(Number(lookbackMin) || 30))), span = lb * MIN;
    const bucketMs = Math.max(5_000, Math.ceil(span / p.maxCols / 1000) * 1000), cols = Math.ceil(span / bucketMs);
    const end = Math.floor(now() / bucketMs) * bucketMs, t0 = end - (cols - 1) * bucketMs;
    const base = { symbol: sym, exchange: "binance", marketType: "spot", lookbackMin: lb, bucketMs, binWidth, times: Array.from({ length: cols }, (_, i) => t0 + i * bucketMs),
      status: status(), book: bookView(), updatedAt: now() };
    const win = samples.filter((s) => s.t >= t0), last = samples.last();
    if (!win.length || !last || !binWidth) return { ...base, prices: [], bids: [], asks: [], unit: 1, mids: [], volume: null, warning: book.needsResync() ? "Rebuilding the order book…" : "Collecting the first samples…" };
    const w = binWidth, M = last.mid;
    // price range: the book and trades seen in the window, at most +-maxHalf and at least +-minHalf around the latest mid
    const secs = tape.filter((x) => x.t >= t0);
    let lo = Infinity, hi = -Infinity;
    for (const s of win) {
      let a = -1, z = -1;
      for (let i = 0; i < s.bid.length; i++) if (s.bid[i] > 0 || s.ask[i] > 0) { if (a < 0) a = i; z = i; }
      if (a >= 0) { lo = Math.min(lo, (s.lo + a) * w); hi = Math.max(hi, (s.lo + z + 1) * w); }
    }
    for (const x of secs) { lo = Math.min(lo, x.l); hi = Math.max(hi, x.h); }
    const priceMin = Math.max(M * (1 - p.maxHalfPct), Math.min(lo, M * (1 - p.minHalfPct))), priceMax = Math.min(M * (1 + p.maxHalfPct), Math.max(hi, M * (1 + p.minHalfPct)));
    const rLo = binIndex(priceMin, w), rows = Math.max(1, Math.min(600, Math.ceil(priceMax / w - 1e-7) - rLo));
    const bids = Array.from({ length: cols }, () => new Float64Array(rows)), asks = Array.from({ length: cols }, () => new Float64Array(rows));
    const cnt = new Uint16Array(cols), mids = new Array(cols).fill(null);
    for (const s of win) {
      const c = Math.floor((s.t - t0) / bucketMs);
      if (c < 0 || c >= cols) continue;
      cnt[c]++; mids[c] = s.mid;
      const off = s.lo - rLo, B = bids[c], A = asks[c];
      for (let i = 0; i < s.bid.length; i++) { const r = off + i; if (r >= 0 && r < rows) { B[r] += s.bid[i]; A[r] += s.ask[i]; } }
    }
    let max = 0;
    for (let c = 0; c < cols; c++) if (cnt[c]) for (let r = 0; r < rows; r++) { bids[c][r] /= cnt[c]; asks[c][r] /= cnt[c]; max = Math.max(max, bids[c][r], asks[c][r]); }
    const unit = max > 0 ? max / 5_000 : 1, enc = (a) => Array.from(a, (v) => Math.round(v / unit));
    const vol = { buy: new Array(cols).fill(0), sell: new Array(cols).fill(0), delta: [], cum: [], o: new Array(cols).fill(null), h: new Array(cols).fill(null), l: new Array(cols).fill(null), c: new Array(cols).fill(null), trades: new Array(cols).fill(0) };
    for (const x of secs) {
      const c = Math.floor((x.t - t0) / bucketMs);
      if (c < 0 || c >= cols) continue;
      vol.buy[c] += x.buy; vol.sell[c] += x.sell; vol.trades[c] += x.n;
      if (vol.o[c] == null) { vol.o[c] = x.o; vol.h[c] = x.h; vol.l[c] = x.l; } else { vol.h[c] = Math.max(vol.h[c], x.h); vol.l[c] = Math.min(vol.l[c], x.l); }
      vol.c[c] = x.c;
    }
    let cum = 0;
    for (let c = 0; c < cols; c++) { vol.buy[c] = Math.round(vol.buy[c]); vol.sell[c] = Math.round(vol.sell[c]); vol.delta[c] = vol.buy[c] - vol.sell[c]; cum += vol.delta[c]; vol.cum[c] = cum; }
    return { ...base, priceMin: rLo * w, priceMax: (rLo + rows) * w, rows, cols, prices: Array.from({ length: rows }, (_, r) => r2((rLo + r) * w, 10)), unit,
      bids: bids.map(enc), asks: asks.map(enc), mids, samplesInWindow: win.length, volume: vol, collectionStartedAt: samples.first()?.t ?? null };
  }
  return { symbol: sym, start, stop, status, heatmap, bookView, sample, onMessage, onTrade, book, sync, toRest, restTick, binWidth: () => binWidth };
}

// ============================================================================================================
// The tab: the screener on a timer, the heatmap feed, and the HTTP routes
// ============================================================================================================
// excluded(base) = true leaves a coin out (screener.js can pass its own check: stablecoins, Binance's "bStocks" tags, ...).
export function createLiquidity({ fetchJson, WS = globalThis.WebSocket, now = Date.now, stateDir = null, p = LIQ, cfg = DEFAULT_CONFIG, adapters = null, excluded = () => false }) {
  const get = (url) => fetchJson(url, { retries: 1, timeoutMs: 12_000 });
  let binanceSymbols = null;
  const EX = adapters || exchangeAdapters(get, (s) => { binanceSymbols = s; });
  const xs = Object.fromEntries(EX.map((x) => [x.id, { id: x.id, name: x.name, status: "starting", error: null, updatedAt: null, cycleMs: null, pausedUntil: null,
    busy: false, markets: null, marketsAt: 0, byBase: new Map(), top: [], venues: new Map(), failedCoins: 0 }]));
  const st = { status: "starting", error: null, updatedAt: null, cycleMs: null, rows: [] };
  let timer = null, started = false, feed = null, symbol = p.symbol, loaded = false, cycling = false;
  const stateFile = stateDir ? path.join(stateDir, "liquidity_state.json") : null;
  const save = () => (stateFile ? writeFile(stateFile + ".tmp", JSON.stringify({ version: 1, symbol })).then(() => rename(stateFile + ".tmp", stateFile)).catch(() => {}) : null);
  async function load() {
    if (loaded) return; loaded = true;
    try { const s = JSON.parse(await readFile(stateFile, "utf8")); if (s?.version === 1 && /^[A-Z0-9]{3,20}$/.test(s.symbol)) symbol = s.symbol; } catch { /* first run */ }
  }
  async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }
  // Each exchange's coins: one market per coin (the USDT or USD pair with more volume), stablecoins and the like left
  // out; its "top" = the majors, then the most traded, perExchange in all.
  const learnedRoots = new Set(); // stock roots learned from the excluded Binance "...B" coins (NVDAB -> NVDA)
  const isExcluded = (b) => { try { return !!excluded(b); } catch { return false; } };
  function pickUniverse(s, markets) {
    if (s.id === "binance") for (const m of markets) { const b = String(m.base || "").toUpperCase(); if (b.length > 3 && b.endsWith("B") && isExcluded(b)) learnedRoots.add(b.slice(0, -1)); }
    const by = new Map();
    for (const m of markets) {
      const b = String(m.base || "").toUpperCase();
      if (!b || !(m.last > 0) || !(m.volUsd > 0) || skipBase(b, m.last, m.change24h) || isExcluded(b) || (learnedRoots.size && !learnedRoots.has(b) && stockLike(b, learnedRoots))) continue;
      const cur = by.get(b);
      if (!cur || m.volUsd > cur.volUsd) by.set(b, { ...m, base: b });
    }
    s.byBase = by;
    const ranked = [...by.values()].sort((a, b) => b.volUsd - a.volUsd).map((m) => m.base);
    s.top = [...new Set([...p.majors.filter((b) => by.has(b)), ...ranked])].slice(0, p.perExchange);
  }
  const universe = () => new Set(Object.values(xs).flatMap((s) => s.top));
  async function cycleExchange(x) {
    const s = xs[x.id];
    if (s.busy || (s.pausedUntil && s.pausedUntil > now())) return;
    s.busy = true;
    const t0 = now();
    try {
      if (!s.markets || now() - s.marketsAt > p.universeMs) { s.markets = await x.markets(); s.marketsAt = now(); pickUniverse(s, s.markets); }
      // prices for every coin of the merged list this exchange trades (one or two requests)
      const U = universe(), want = [];
      for (const b of U) { const m = s.byBase.get(b); if (m) want.push(s.venues.get(b) || { base: b, sym: m.sym, quote: m.quote }); }
      for (const b of [...s.venues.keys()]) if (!U.has(b)) s.venues.delete(b);
      const tick = await x.tickers(want);
      for (const v of want) { const t = tick.get(v.sym); if (t && t.last > 0) { v.ticker = { ...v.ticker, ...t, bid: t.bid ?? v.ticker?.bid ?? null, ask: t.ask ?? v.ticker?.ask ?? null }; v.tickAt = now(); s.venues.set(v.base, v); } }
      // candles + book for its own top coins, the oldest first, a few per cycle
      const deep = s.top.map((b) => s.venues.get(b)).filter(Boolean).sort((a, b) => (a.deepAt || 0) - (b.deepAt || 0)).slice(0, x.deepPerCycle);
      let failed = 0, lastErr = null;
      await pool(deep, x.conc, async (v) => {
        try {
          const k = await x.klines(v), b = await x.book(v);
          if (!k.length) throw new Error("no candles");
          v.klines = k; v.book = b; v.deepAt = now(); // (Coinbase's prices have no bid/ask: the spread then comes from this book)
        } catch (e) { failed++; lastErr = e; }
      });
      if (deep.length && failed === deep.length) throw lastErr;
      Object.assign(s, { status: "ok", error: failed ? `${failed} of ${deep.length} coin requests failed: ${lastErr?.message}` : null, updatedAt: now(), cycleMs: now() - t0, pausedUntil: null });
    } catch (e) {
      const code = e?.status;
      if (code === 429 || code === 418 || code === 403 || /too many requests|rate limit/i.test(e?.message || "")) s.pausedUntil = now() + (e.retryAfterMs || 60_000);
      if (s.error !== e?.message) console.log(`Liquidity: ${x.name} failed: ${e?.message}`);
      Object.assign(s, { status: "error", error: e?.message || String(e), cycleMs: now() - t0 });
    } finally { s.busy = false; }
  }
  // One round: every exchange at once (each on its own; a slow or failing one does not hold up the others).
  async function cycle() {
    if (cycling) return; cycling = true;
    const t0 = now();
    try {
      await Promise.allSettled(EX.map((x) => cycleExchange(x)));
      try { st.rows = buildRows(); } catch (e) { console.log(`Liquidity: building the screener rows failed: ${e.message}`); }
      const ok = Object.values(xs).filter((s) => s.status === "ok").length;
      Object.assign(st, { status: ok ? "ok" : Object.values(xs).every((s) => s.status === "error") ? "error" : "starting",
        error: ok ? null : Object.values(xs).map((s) => s.error && `${s.name}: ${s.error}`).filter(Boolean).join("; ") || null, updatedAt: ok ? now() : st.updatedAt, cycleMs: now() - t0 });
    } finally { cycling = false; }
  }
  function buildRows() {
    const venues = [];
    for (const s of Object.values(xs)) for (const v of s.venues.values()) {
      if (!v.ticker || now() - (v.tickAt || 0) > p.staleMs) continue; // an exchange that stopped answering drops out
      const fresh = v.klines && v.book && now() - (v.deepAt || 0) <= p.staleMs;
      const result = fresh ? runScreener([{ market: { symbol: v.sym, exchange: s.id, marketType: "spot", base: v.base, quote: v.quote },
        ticker: { last: v.ticker.last, bid: v.ticker.bid ?? v.book.bids[0]?.[0], ask: v.ticker.ask ?? v.book.asks[0]?.[0], volume24h: v.ticker.volUsd, change24h: v.ticker.change24h },
        klines1m: v.klines, orderBook: v.book }], cfg)[0] : null;
      venues.push({ exchange: s.id, base: v.base, symbol: v.sym, quote: v.quote, ticker: v.ticker, result, deepAt: v.deepAt || null, tickAt: v.tickAt });
    }
    return mergeRows(venues).filter((r) => r.score != null);
  }
  async function setSymbol(input) {
    let s = String(input || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (s && !/^[A-Z0-9]{2,}(USDT|USDC|FDUSD|BTC|ETH|BNB|EUR|TRY|BRL|JPY)$/.test(s)) s += "USDT"; // "SOL" -> SOLUSDT
    if (!/^[A-Z0-9]{3,20}$/.test(s)) return { ok: false, error: "Type a Binance spot pair, like BTCUSDT" };
    if (binanceSymbols && !binanceSymbols.has(s)) return { ok: false, error: `${s} is not a Binance spot pair that traded in the last 24 hours` };
    if (feed && feed.symbol === s) return { ok: true, symbol: s };
    symbol = s;
    if (started) { feed?.stop(); feed = createDepthFeed({ symbol: s, fetchJson, WS, now, p }); feed.start(); }
    await save();
    return { ok: true, symbol: s };
  }
  function heatmap(sym, lookbackMin) {
    const lb = lookbackMin === "max" ? p.historyMin : lookbackMin;
    if (!feed) return { symbol, exchange: "binance", status: { mode: "stopped" }, prices: [], bids: [], asks: [], times: [], warning: "The heatmap starts with the server" };
    const out = feed.heatmap(lb);
    if (sym && String(sym).toUpperCase() !== feed.symbol) out.note = `Showing ${feed.symbol}: change the pair with the symbol box`;
    return out;
  }
  function start() {
    if (started) return; started = true;
    load().then(() => { if (started && !feed) { feed = createDepthFeed({ symbol, fetchJson, WS, now, p }); feed.start(); } });
    cycle();
    timer = setInterval(cycle, p.refreshMs);
  }
  function stop() { started = false; clearInterval(timer); timer = null; feed?.stop(); feed = null; }
  function api() {
    return { status: st.status, error: st.error, updatedAt: st.updatedAt, cycleMs: st.cycleMs, refreshMs: p.refreshMs, perExchange: p.perExchange, rows: st.rows,
      exchanges: Object.values(xs).map((s) => ({ id: s.id, name: s.name, status: s.status, error: s.error, updatedAt: s.updatedAt, cycleMs: s.cycleMs, pausedUntil: s.pausedUntil,
        listed: s.byBase.size, coins: s.venues.size, top: s.top.length, deep: [...s.venues.values()].filter((v) => v.deepAt && now() - v.deepAt <= p.staleMs).length })),
      heatmap: feed ? feed.status() : { symbol, mode: "stopped" }, config: { thresholds: cfg, weights: SCORE_WEIGHTS, bands: SCORE_BANDS }, signalLabels: SIGNAL_LABELS };
  }
  const json = (res, code, data) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
  // GET /api/liquidity, GET /api/liquidity/heatmap?symbol=&lookback=, POST /api/liquidity/symbol {symbol} (this site only),
  // and GET /liquidity-tab.js (the tab's browser script). Returns false for anything else.
  async function handle(req, res, url) {
    const pth = url.pathname;
    if (pth === "/liquidity-tab.js") {
      try { const js = await readFile(path.join(here, "public", "liquidity-tab.js")); res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); res.end(js); }
      catch { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("public/liquidity-tab.js is missing"); }
      return true;
    }
    if (pth === "/api/liquidity") { json(res, 200, api()); return true; }
    if (pth === "/api/liquidity/heatmap") { json(res, 200, heatmap(url.searchParams.get("symbol"), url.searchParams.get("lookback"))); return true; }
    if (pth === "/api/liquidity/symbol") {
      if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return true; }
      const sameSite = String(req.headers["content-type"] || "").includes("application/json") && (!req.headers.origin || req.headers.origin.replace(/^https?:\/\//, "") === req.headers.host);
      if (!sameSite) { json(res, 403, { error: "Forbidden" }); return true; }
      let body = "";
      for await (const c of req) { body += c; if (body.length > 2000) break; }
      let b = {}; try { b = JSON.parse(body || "{}"); } catch { /* invalid */ }
      const r = await setSymbol(b.symbol);
      json(res, r.ok ? 200 : 400, r); return true;
    }
    return false;
  }
  return { start, stop, api, heatmap, setSymbol, handle, cycle, symbol: () => feed?.symbol ?? symbol };
}

// Liquidity tab (liquidity.ts): the hotness score and signal checks on made-up markets, merging exchanges per coin, the
// order-book rebuild (stale updates dropped, a gap forces a resync), price binning, the heatmap built from a fake
// WebSocket, and the screener with fake exchanges (one failing). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_CONFIG, calculateHotMarketScore, classifyScoreBand, calculateOrderBookImbalance, calculateSpread, calculateRangeBreakout, normalizeScore,
  detectVolumeSpike, detectPricePump, detectPriceDump, detectVolatilityExpansion, detectSpreadWidening, detectOrderBookImbalance, detectBreakout,
  detectOpenInterestSpike, detectFundingAnomaly, detectHotMarket, runScreener, mergeRows, createBook, createDepthSync, chooseBinWidth, priceToBin,
  niceStep, pickBinWidth, chooseGrid, binBook, binIndex, bucketDelta, RingBuffer, createDepthFeed, createLiquidity, exchangeAdapters,
} from "../liquidity.ts";
import type { ExchangeAdapter, Kline } from "../liquidity.ts";

const tick = () => new Promise((r) => setImmediate(r));
// 60 one-minute candles: flat at 100 with volume 10, then `tail` changes applied to the last candles
function klines(n = 60, f: (i: number, n: number) => Partial<Kline> = () => ({})) {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60_000, open: 100, high: 100.1, low: 99.9, close: 100, volume: 10, ...f(i, n) }));
}
const snap = (over = {}) => ({ market: { symbol: "TESTUSDT", exchange: "binance", marketType: "spot", base: "TEST", quote: "USDT" },
  ticker: { last: 100, bid: 99.99, ask: 100.01, volume24h: 50_000_000, change24h: 1 }, klines1m: klines(), orderBook: { bids: [[99.99, 5]], asks: [[100.01, 5]] }, ...over });

test("hotness score: their weights, missing parts count 0, rounded half up, four bands", () => {
  const all = { momentumScore: 100, volumeScore: 100, volatilityScore: 100, liquidityScore: 100, orderBookScore: 100 };
  assert.deepEqual(calculateHotMarketScore(all), { score: 100, warnings: [] });
  const half = calculateHotMarketScore({ momentumScore: 50 }); // 50 x 0.25 = 12.5 -> 13
  assert.equal(half.score, 13);
  assert.equal(half.warnings.length, 4);
  assert.equal(calculateHotMarketScore({ ...all, volumeScore: 250 }).score, 100); // clamped
  assert.equal(calculateHotMarketScore({ ...all, momentumScore: 0, volumeScore: 0 }).score, 50); // 0.2 + 0.15 + 0.15
  assert.deepEqual([0, 30, 31, 60, 61, 80, 81, 100].map(classifyScoreBand), ["cold", "cold", "normal", "normal", "hot", "hot", "extreme", "extreme"]);
  assert.equal(normalizeScore(2.5, 0, 5), 50);
  assert.equal(normalizeScore(9, 1, 5), 100);
  assert.equal(normalizeScore(NaN, 0, 5), 0);
});

test("detectors fire on made-up markets at their default thresholds, and stay quiet on a calm one", () => {
  const calm = snap();
  for (const d of [detectVolumeSpike, detectPricePump, detectPriceDump, detectVolatilityExpansion, detectSpreadWidening, detectOrderBookImbalance, detectBreakout])
    assert.equal(d(calm, DEFAULT_CONFIG), null, d.name);
  // volume: last 5 candles at 40 vs 10 before = 4x (> 3x)
  const spike = detectVolumeSpike(snap({ klines1m: klines(60, (i, n) => (i >= n - 5 ? { volume: 40 } : {})) }));
  assert.equal(spike.type, "VOLUME_SPIKE");
  assert.equal(spike.score, 80); // 4 / 3 x 60
  assert.equal(detectVolumeSpike(snap({ klines1m: klines(60, (i, n) => (i >= n - 5 ? { volume: 29 } : {})) })), null); // 2.9x
  // pump: open of the 5th-last candle 100 -> last close 102.5 (+2.5% > 2%); dump the mirror
  const pumped = snap({ klines1m: klines(60, (i, n) => (i === n - 1 ? { close: 102.5, high: 102.6 } : {})) });
  assert.equal(detectPricePump(pumped).score, 63); // 2.5 / 2 x 50 = 62.5 -> 63
  assert.equal(detectBreakout(pumped).payload.direction, "up");
  const dumped = snap({ klines1m: klines(60, (i, n) => (i === n - 1 ? { close: 97.5, low: 97.4 } : {})) });
  assert.equal(detectPriceDump(dumped).type, "PRICE_DUMP");
  assert.equal(detectBreakout(dumped).message, "Range breakout (down)");
  assert.equal(detectPricePump(snap({ klines1m: klines(60, (i, n) => (i === n - 1 ? { close: 101.9 } : {})) })), null);
  // volatility: alternating 0.1% moves, then 1% swings in the last 5 candles
  const vol = snap({ klines1m: klines(60, (i, n) => ({ close: i >= n - 5 ? (i % 2 ? 101 : 99) : i % 2 ? 100.1 : 99.9 })) });
  assert.equal(detectVolatilityExpansion(vol).type, "VOLATILITY_EXPANSION");
  // spread 0.2% > 0.15%; book 90% bids > 65%
  assert.equal(detectSpreadWidening(snap({ ticker: { last: 100, bid: 99.9, ask: 100.1, volume24h: 1, change24h: 0 } })).payload.spreadPct.toFixed(2), "0.20");
  const im = detectOrderBookImbalance(snap({ orderBook: { bids: [[99, 9]], asks: [[101, 1]] } }));
  assert.equal(im.score, 80);
  assert.ok(Math.abs(im.payload.imbalance - 0.8) < 1e-9);
  assert.equal(calculateOrderBookImbalance([[1, 1]], [], 20), 1);
  assert.equal(calculateSpread(0, 1), 0);
  assert.deepEqual(calculateRangeBreakout(klines(10), 20), { brokeHigh: false, brokeLow: false });
  // futures-only checks never fire on spot; on futures they use their thresholds
  assert.equal(detectFundingAnomaly(snap({ futures: { fundingRate: 0.05 } })), null);
  assert.equal(detectFundingAnomaly(snap({ market: { marketType: "futures" }, futures: { fundingRate: 0.05 } })).score, 50);
  assert.equal(detectOpenInterestSpike(snap({ market: { marketType: "futures" }, openInterestHistory: [{ ts: 0, value: 100 }, { ts: 600_000, value: 106 }] })).type, "OI_SPIKE");
  assert.equal(detectHotMarket({ score: 80 }), null);
  assert.equal(detectHotMarket({ score: 81 }).type, "HOT_MARKET");
});

test("runScreener scores a hot market and lists its signals", () => {
  // +4% in 5 minutes on 4x volume, wild swings, a lopsided book, $200M volume
  const hot = snap({ ticker: { last: 104, bid: 103.99, ask: 104.01, volume24h: 200e6, change24h: 6 }, orderBook: { bids: [[103.9, 95]], asks: [[104.1, 5]] },
    klines1m: klines(60, (i, n) => {
      if (i < n - 5) return {};
      const open = 100 + (i - (n - 5)) * 0.8, close = open + 0.8 + (i % 2 ? 0.6 : -0.6);
      return { volume: 40, open, close, high: Math.max(open, close) + 0.05, low: Math.min(open, close) - 0.05 };
    }) });
  const [r] = runScreener([hot]);
  assert.equal(r.relativeVolume, 4);
  assert.ok(r.change5m > 2, `change5m ${r.change5m}`);
  assert.equal(r.subScores.liquidityScore, 100);
  assert.ok(r.signalScore >= 61, `score ${r.signalScore}`);
  for (const t of ["VOLUME_SPIKE", "PRICE_PUMP", "ORDER_BOOK_IMBALANCE", "BREAKOUT"]) assert.ok(r.activeSignals.includes(t), t);
  const [calm] = runScreener([snap()]);
  assert.equal(calm.scoreBand, "cold");
  assert.deepEqual(calm.activeSignals, []);
});

test("mergeRows: one row per coin, the hottest exchange leads, volumes add up, signals name their exchanges", () => {
  const res = (score, types, price = 100) => ({ price, signalScore: score, scoreBand: classifyScoreBand(score), change24h: 1, change5m: 0.5, change15m: 1, change1h: 2,
    relativeVolume: 2, volatility: 0.1, spreadPct: 0.01, orderBookImbalance: 0.2, signals: types.map((type) => ({ type, score: 70, message: type })) });
  const rows = mergeRows([
    { exchange: "binance", base: "AAA", symbol: "AAAUSDT", ticker: { last: 100, volUsd: 5e6 }, result: res(40, ["VOLUME_SPIKE"]) },
    { exchange: "okx", base: "AAA", symbol: "AAA-USDT", ticker: { last: 101, volUsd: 1e6 }, result: res(70, ["VOLUME_SPIKE", "PRICE_PUMP"], 101) },
    { exchange: "kraken", base: "AAA", symbol: "AAAUSD", ticker: { last: 100.5, volUsd: 2e6 }, result: null }, // no fresh candles: no score
    { exchange: "bybit", base: "BBB", symbol: "BBBUSDT", ticker: { last: 5, volUsd: 9e6 }, result: res(20, []) },
    { exchange: "bybit", base: "ZZZ", symbol: "ZZZUSDT", ticker: { last: 0, volUsd: 9e6 }, result: res(99, []) }, // no price: dropped
  ]);
  assert.deepEqual(rows.map((r) => r.coin), ["AAA", "BBB"]);
  const a = rows[0];
  assert.equal(a.score, 70);
  assert.equal(a.lead, "okx");
  assert.equal(a.volumeUsd, 8e6);
  assert.deepEqual(a.exchanges, ["binance", "kraken", "okx"]); // by volume
  assert.equal(a.priceGapPct, 1);
  assert.deepEqual(a.signals.find((s) => s.type === "VOLUME_SPIKE").venues, ["binance", "okx"]);
  assert.equal(a.signals.find((s) => s.type === "PRICE_PUMP").label, "Pump");
  assert.equal(a.venues.find((v) => v.ex === "kraken").score, null);
});

test("order book rebuild: snapshot, bridge, stale updates dropped, a gap needs a resync", () => {
  const b = createBook();
  assert.equal(b.needsResync(), true);
  assert.equal(b.applyDiff({ U: 1, u: 2, b: [], a: [] }), "needs_resync"); // nothing before the snapshot
  b.applySnapshot({ lastUpdateId: 100, bids: [["99", "1"], ["98", "2"]], asks: [["101", "1"], ["102", "0"]] });
  assert.deepEqual(b.topOfBook(5), { bids: [[99, 1], [98, 2]], asks: [[101, 1]] }); // qty 0 is not a level
  assert.equal(b.applyDiff({ U: 90, u: 100, b: [["99", "50"]], a: [] }), "stale"); // already in the snapshot
  assert.equal(b.topOfBook(1).bids[0][1], 1);
  assert.equal(b.applyDiff({ U: 95, u: 105, b: [["99", "3"], ["98", "0"]], a: [["100.5", "4"]] }), "applied"); // bridges 101
  assert.deepEqual(b.topOfBook(5), { bids: [[99, 3]], asks: [[100.5, 4], [101, 1]] });
  assert.equal(b.applyDiff({ U: 100, u: 104, b: [], a: [] }), "stale");
  assert.equal(b.applyDiff({ U: 106, u: 110, b: [["97", "1"]], a: [] }), "applied"); // contiguous
  assert.equal(b.applyDiff({ U: 112, u: 115, b: [], a: [] }), "needs_resync"); // 111 missed
  assert.equal(b.needsResync(), true);
  assert.equal(b.applyDiff({ U: 116, u: 117, b: [], a: [] }), "needs_resync"); // stays out of sync until a snapshot
  // a first diff after the snapshot that starts too late is a gap too
  b.applySnapshot({ lastUpdateId: 200, bids: [], asks: [] });
  assert.equal(b.applyDiff({ U: 205, u: 210, b: [], a: [] }), "needs_resync");
});

test("depth sync (Binance's procedure): buffer, drop stale, refetch an old snapshot, a gap forces a new snapshot", async () => {
  const book = createBook(), snaps = [];
  const fetchSnapshot = async () => snaps.shift();
  const sync = createDepthSync({ book, fetchSnapshot, minGapMs: 0 });
  let calls = 0;
  const counted = createDepthSync({ book, fetchSnapshot: async () => { calls++; return fetchSnapshot(); }, minGapMs: 0 });
  // 1) updates arrive before any snapshot: buffered; the first one asks for a snapshot
  snaps.push({ lastUpdateId: 5, bids: [["10", "1"]], asks: [["11", "1"]] }); // older than the first buffered update (U 8)
  snaps.push({ lastUpdateId: 9, bids: [["10", "1"]], asks: [["11", "1"]] });
  assert.equal(counted.onDiff({ U: 8, u: 8, b: [["10", "2"]], a: [] }), "buffered");
  assert.equal(counted.onDiff({ U: 9, u: 9, b: [["10", "3"]], a: [] }), "buffered");
  assert.equal(counted.onDiff({ U: 10, u: 11, b: [["9", "1"]], a: [] }), "buffered");
  await tick(); await tick(); await tick();
  assert.equal(calls, 2); // the first snapshot (5) was older than update 8: fetched again
  assert.equal(counted.stats.oldSnapshots, 1);
  assert.equal(book.needsResync(), false);
  assert.equal(book.lastUpdateId(), 11); // 8 and 9 dropped (in snapshot 9), 10-11 applied
  assert.deepEqual(book.topOfBook(5).bids, [[10, 1], [9, 1]]);
  // 2) a gap: 12 missed -> buffered from there and a fresh snapshot
  snaps.push({ lastUpdateId: 14, bids: [["10", "7"]], asks: [["11", "1"]] });
  assert.equal(counted.onDiff({ U: 13, u: 14, b: [], a: [] }), "needs_resync");
  assert.equal(counted.stats.resyncs, 1);
  assert.equal(counted.onDiff({ U: 15, u: 15, b: [["10", "8"]], a: [] }), "buffered");
  await tick(); await tick();
  assert.equal(calls, 3);
  assert.equal(book.lastUpdateId(), 15);
  assert.deepEqual(book.topOfBook(1).bids, [[10, 8]]);
  sync.stop(); counted.stop();
});

test("binning: their auto and percent widths, round widths, dollars per bin", () => {
  assert.equal(chooseBinWidth(100, "1%").binWidth, 1);
  assert.equal(chooseBinWidth(100, "auto", 0.05, { priceMin: 98, priceMax: 102, targetBins: 200 }).binWidth, 0.02);
  assert.equal(chooseBinWidth(100, "auto", 0.05).binWidth.toFixed(6), (10 / 120).toFixed(6)); // +-5%, 120 bins
  assert.equal(chooseBinWidth(-1, "auto").binWidth, 1);
  assert.equal(priceToBin(77_012.5, 20), 77_000);
  assert.equal(binIndex(77_000, 20), 3850);
  assert.equal(binIndex(0.3, 0.1), 3); // float error does not drop a row
  assert.deepEqual([0.0123, 0.019, 0.027, 0.04, 0.09].map(niceStep), [0.01, 0.02, 0.025, 0.05, 0.1]);
  assert.equal(pickBinWidth(77_000), 20); // 4% of 77,000 / 160 = 19.25 -> 20
  // the grid follows the book's depth: BTC's 500th level ~0.1% away -> the 0.25% floor -> rows of 2.5
  const deepBids = new Map(Array.from({ length: 1000 }, (_, i) => [77_000 - i * 0.15, 1])), deepAsks = new Map(Array.from({ length: 1000 }, (_, i) => [77_000.01 + i * 0.15, 1]));
  assert.deepEqual(chooseGrid(deepBids, deepAsks, 77_000), { binWidth: 2.5, storeHalf: 0.00375, half: 0.0025 });
  const bins = binBook([[100, 2], [99.99, 1], [97, 9]], [[100.03, 3], [103, 1]], 100, 0.025, 0.02);
  assert.equal(bins.lo, binIndex(98, 0.025));
  assert.equal(bins.bid[binIndex(100, 0.025) - bins.lo], 200);
  assert.ok(Math.abs(bins.bid[binIndex(99.99, 0.025) - bins.lo] - 99.99) < 1e-3);
  assert.ok(Math.abs(bins.ask[binIndex(100.03, 0.025) - bins.lo] - 300.09) < 1e-2);
  assert.equal(bins.bid.reduce((a, v) => a + v, 0).toFixed(2), "299.99"); // 97 and 103 are outside +-2%
  const d = bucketDelta([{ t: 1000, price: 10, qty: 1, buyerIsMaker: false }, { t: 61_000, price: 10, qty: 3, buyerIsMaker: true }], 60_000);
  assert.deepEqual(d.map((x) => [x.buyVolume, x.sellVolume, x.cumulativeDelta]), [[10, 0, 10], [0, 30, -20]]);
  const rb = new RingBuffer(3); [1, 2, 3, 4].forEach((x) => rb.push(x));
  assert.deepEqual([rb.toArray(), rb.first(), rb.last(), rb.size()], [[2, 3, 4], 2, 4, 3]);
});

class FakeWS {
  static last = null;
  url: string; closed: boolean; onopen?: () => void; onmessage?: (ev: { data: string }) => void; onclose?: () => void;
  constructor(url: string) { this.url = url; FakeWS.last = this; }
  close() { this.closed = true; this.onclose?.(); }
  send(stream: string, data: unknown) { this.onmessage({ data: JSON.stringify({ stream, data }) }); }
}

test("heatmap feed: WebSocket diffs + snapshot rebuild the book, samples bin it every second, trades fill the volume", async () => {
  let t = 1_800_000_000_000;
  const now = () => t, urls = [];
  const fetchJson = async (url) => { urls.push(url); return { lastUpdateId: 100, bids: [["100", "2"], ["99.9", "1"]], asks: [["100.5", "3"], ["101", "1"]] }; };
  const feed = createDepthFeed({ symbol: "testusdt", fetchJson, WS: FakeWS, now, timers: false });
  feed.start();
  const ws = FakeWS.last;
  assert.match(ws.url, /stream\?streams=testusdt@depth@100ms\/testusdt@aggTrade$/);
  ws.onopen();
  assert.equal(feed.status().mode, "websocket");
  ws.send("testusdt@depth@100ms", { E: t, U: 99, u: 101, b: [["99.95", "4"]], a: [] }); // buffered, then bridges the snapshot
  await tick(); await tick();
  assert.match(urls[0], /\/api\/v3\/depth\?symbol=TESTUSDT&limit=1000$/);
  assert.equal(feed.book.lastUpdateId(), 101);
  assert.equal(feed.heatmap(15).warning, "Collecting the first samples…");
  for (let i = 0; i < 6; i++) {
    ws.send("testusdt@aggTrade", { T: t, p: "100.25", q: i % 2 ? "2" : "1", m: i % 2 === 1 }); // taker buys 1, taker sells 2, ...
    assert.equal(feed.sample(), true);
    t += 1000;
  }
  const h = feed.heatmap(15);
  assert.equal(h.binWidth, 0.01); // the book reaches 101 (0.75% above the mid): 1.5% / 160 rows -> 0.01
  assert.deepEqual([h.priceMin, +h.priceMax.toFixed(2)], [99.9, 101.01]); // the window follows where the book has orders
  assert.equal(h.cols, 180);
  assert.equal(h.bucketMs, 5000);
  assert.equal(h.times.length, 180);
  assert.equal(h.prices.length, h.rows);
  const row = (p) => h.prices.findIndex((x) => Math.abs(x - p) < 1e-9), col = h.bids.findIndex((c) => c.some((v) => v > 0));
  assert.ok(col >= 0);
  assert.ok(Math.abs(h.bids[col][row(100)] * h.unit - 200) < 0.2, `bid at 100: ${h.bids[col][row(100)] * h.unit}`);
  assert.ok(Math.abs(h.bids[col][row(99.95)] * h.unit - 399.8) < 0.4);
  assert.ok(Math.abs(h.asks[col][row(100.5)] * h.unit - 301.5) < 0.3);
  assert.equal(h.asks[col][row(100)], 0);
  const buy = h.volume.buy.reduce((a, x) => a + x, 0), sell = h.volume.sell.reduce((a, x) => a + x, 0);
  assert.equal(buy, Math.round(3 * 100.25) /* 3 trades of 1 */);
  assert.ok(Math.abs(sell - 6 * 100.25) <= 1);
  assert.equal(h.book.bestBid, 100);
  assert.equal(h.book.bestAsk, 100.5);
  assert.equal(h.book.walls.asks[0][0], 100.5);
  // a missed update forces a fresh snapshot; sampling pauses meanwhile
  ws.send("testusdt@depth@100ms", { E: t, U: 105, u: 106, b: [], a: [] });
  assert.equal(feed.status().needsResync, true);
  assert.equal(feed.status().resyncs, 1);
  assert.equal(feed.sample(), false);
  feed.stop();
  assert.equal(feed.status().mode, "stopped");
  assert.equal(ws.closed, true);
});

test("heatmap feed: without a WebSocket it polls the REST order book", async () => {
  const urls = [];
  const fetchJson = async (url) => { urls.push(url); return url.includes("/depth") ? { lastUpdateId: 7, bids: [["10", "1"]], asks: [["10.1", "1"]] } : [{ a: 1, T: Date.now(), p: "10", q: "1", m: false }]; };
  const feed = createDepthFeed({ symbol: "ABCUSDT", fetchJson, WS: null, timers: false });
  feed.start();
  assert.equal(feed.status().mode, "rest");
  await feed.restTick();
  assert.match(urls[0], /depth\?symbol=ABCUSDT&limit=500/);
  assert.match(urls[1], /aggTrades\?symbol=ABCUSDT&limit=1000$/);
  assert.equal(feed.sample(), true);
  assert.equal(feed.status().trades, 1);
  feed.stop();
});

function fakeExchange(id: string, coins: string[], { fail = false } = {}): ExchangeAdapter {
  const q = id === "kraken" ? "USD" : "USDT";
  const mk = (b: string, i: number) => ({ sym: b + q, base: b, quote: q, last: 10 + i, bid: 9.99 + i, ask: 10.01 + i, volUsd: 1e7 * (coins.length - i), change24h: 1 });
  return { id, name: id.toUpperCase(), deepPerCycle: 10, conc: 2,
    async markets() { if (fail) throw Object.assign(new Error(`${id} HTTP 503`), { status: 503 }); return coins.map(mk); },
    async tickers(list) { return new Map(list.map((v) => [v.sym, mk(v.base, coins.indexOf(v.base))])); },
    async klines() { return klines(60, (i, n) => (i >= n - 5 ? { volume: 50 } : {})); },
    async book() { return { bids: [[9.99, 10]], asks: [[10.01, 10]] }; } };
}

test("screener: fake exchanges merged per coin; a failing exchange is reported and the others carry on", async () => {
  const liq = createLiquidity({ fetchJson: async () => { throw new Error("no network in tests"); }, adapters: [
    fakeExchange("binance", ["BTC", "ETH", "AAA", "USDC", "NVDAB"]), fakeExchange("kraken", ["BTC", "ETH", "BBB"]), fakeExchange("okx", ["BTC"], { fail: true })],
    excluded: (b) => b === "NVDAB" });
  await liq.cycle();
  const a = liq.api();
  assert.equal(a.status, "ok");
  assert.deepEqual(a.exchanges.map((x) => x.status), ["ok", "ok", "error"]);
  assert.match(a.exchanges[2].error, /HTTP 503/);
  assert.deepEqual(a.rows.map((r) => r.coin).sort(), ["AAA", "BBB", "BTC", "ETH"]); // USDC (stablecoin) and NVDAB (stock) left out
  const btc = a.rows.find((r) => r.coin === "BTC");
  assert.deepEqual(btc.exchanges.sort(), ["binance", "kraken"]);
  assert.ok(btc.signals.some((s) => s.type === "VOLUME_SPIKE" && s.venues.length === 2)); // 5x volume on both
  assert.deepEqual(a.exchanges.map((x) => x.deep), [3, 3, 0]); // Binance: BTC, ETH, AAA
});

test("routes: GET /api/liquidity, the heatmap, and POST /api/liquidity/symbol only from this site", async () => {
  const liq = createLiquidity({ fetchJson: async () => ({}), adapters: [] });
  const call = async (method: string, pathname: string, { headers = {}, body = "" }: { headers?: Record<string, string>; body?: string } = {}) => {
    const req = { method, headers: { host: "localhost:3000", ...headers }, async *[Symbol.asyncIterator]() { if (body) yield body; } };
    const res = { code: 0, body: "", writeHead(c: number) { this.code = c; return this; }, end(b: string) { this.body = b; } };
    const handled = await liq.handle(req as IncomingMessage, res as unknown as ServerResponse, new URL(pathname, "http://localhost:3000")); // fakes of the parts used
    return { handled, code: res.code, json: res.body && res.body.startsWith("{") ? JSON.parse(res.body) : null };
  };
  assert.equal((await call("GET", "/api/other")).handled, false);
  const api = await call("GET", "/api/liquidity");
  assert.equal(api.code, 200);
  assert.deepEqual(api.json.rows, []);
  assert.equal((await call("GET", "/api/liquidity/heatmap?symbol=BTCUSDT&lookback=30")).json.symbol, "BTCUSDT");
  const json = { "content-type": "application/json" };
  assert.equal((await call("POST", "/api/liquidity/symbol", { body: '{"symbol":"ETHUSDT"}' })).code, 403); // not JSON
  assert.equal((await call("POST", "/api/liquidity/symbol", { headers: { ...json, origin: "https://evil.example" }, body: '{"symbol":"ETHUSDT"}' })).code, 403);
  assert.equal((await call("GET", "/api/liquidity/symbol")).code, 405);
  const ok = await call("POST", "/api/liquidity/symbol", { headers: { ...json, origin: "http://localhost:3000" }, body: '{"symbol":"sol"}' });
  assert.deepEqual([ok.code, ok.json], [200, { ok: true, symbol: "SOLUSDT" }]);
  assert.equal(liq.symbol(), "SOLUSDT");
  assert.equal((await call("POST", "/api/liquidity/symbol", { headers: json, body: '{"symbol":"!!"}' })).code, 400);
});

test("exchange adapters read each exchange's public reply format", async () => {
  const replies = {
    "api.binance.com/api/v3/ticker/24hr?symbols": [{ symbol: "BTCUSDT", lastPrice: "100", bidPrice: "99", askPrice: "101", quoteVolume: "5000", priceChangePercent: "2.5" }],
    "api.binance.com/api/v3/klines": [[1000, "1", "2", "0.5", "1.5", "10"]],
    "api.bybit.com/v5/market/kline": { retCode: 0, result: { list: [["2000", "2", "2", "2", "2", "1"], ["1000", "1", "1", "1", "1", "1"]] } },
    "api.bybit.com/v5/market/orderbook": { retCode: 0, result: { b: [["9", "1"]], a: [["11", "2"]] } },
    "www.okx.com/api/v5/market/tickers": { code: "0", data: [{ instId: "BTC-USDT", last: "110", open24h: "100", bidPx: "109", askPx: "111", volCcy24h: "7" }, { instId: "BTC-EUR", last: "1" }] },
    "api.exchange.coinbase.com/products/BTC-USD/candles": [[120, 1, 3, 2, 2.5, 9], [60, 1, 2, 1.5, 2, 8]],
    "api.coinbase.com/api/v3/brokerage/market/product_book": { pricebook: { bids: [{ price: "99", size: "1" }], asks: [{ price: "101", size: "2" }] } },
    "api.kraken.com/0/public/AssetPairs": { error: [], result: { XXBTZUSD: { wsname: "XBT/USD", status: "online" }, XDGUSD: { wsname: "XDG/USD", status: "online" }, XXBTZEUR: { wsname: "XBT/EUR", status: "online" } } },
    "api.kraken.com/0/public/Ticker": { error: [], result: { XXBTZUSD: { c: ["100"], b: ["99"], a: ["101"], v: ["1", "2"], p: ["0", "100"], o: "80" } } },
    "api.kraken.com/0/public/Depth": { error: ["EGeneral:Too many requests"] },
  };
  const get = async (url: string) => { const k = Object.keys(replies).find((x) => url.includes(x)); if (!k) throw new Error("unexpected " + url); return replies[k]; };
  const [bin, byb, okx, cb, kr] = exchangeAdapters(get);
  assert.deepEqual((await bin.tickers([{ sym: "BTCUSDT" }])).get("BTCUSDT"), { last: 100, bid: 99, ask: 101, volUsd: 5000, change24h: 2.5 });
  assert.deepEqual(await bin.klines({ sym: "BTCUSDT" }), [{ t: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
  assert.deepEqual((await byb.klines({ sym: "BTCUSDT" })).map((k) => k.t), [1000, 2000]); // newest-first reply, oldest first here
  assert.deepEqual(await byb.book({ sym: "BTCUSDT" }), { bids: [[9, 1]], asks: [[11, 2]] });
  const om = await okx.markets();
  assert.deepEqual([om.length, om[0].base, om[0].quote, om[0].change24h.toFixed(1)], [1, "BTC", "USDT", "10.0"]);
  const ck = await cb.klines({ sym: "BTC-USD" });
  assert.deepEqual(ck.map((k) => [k.t, k.open, k.high, k.low, k.close]), [[60_000, 1.5, 2, 1, 2], [120_000, 2, 3, 1, 2.5]]);
  assert.deepEqual(await cb.book({ sym: "BTC-USD" }), { bids: [[99, 1]], asks: [[101, 2]] });
  const km = await kr.markets();
  assert.deepEqual(km.map((m) => [m.base, m.quote, m.volUsd, m.change24h]), [["BTC", "USD", 200, 25]]); // XBT -> BTC; EUR pair left out
  await assert.rejects(kr.book({ sym: "XXBTZUSD" }), /Too many requests/);
});

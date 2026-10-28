// Binance Alpha ignition: candle parsing, the two-candle rule and its tiers, outcome tracking, eligibility, DEX summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKlines, toGrid, alphaFeatures, classifyAlpha, alphaOutcome, alphaEligible, dexSummary, advanceAlpha, alphaResults, DEFAULT_ALPHA } from "../alpha.js";

const STEP = 300_000, T0 = Date.UTC(2026, 9, 1);
// n quiet candles (price 1, `usd` each, 3 trades) then the given [usd, trades, close] candles
function series(n, usd, tail) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push([T0 + i * STEP, 1, 1.001, 0.999, 1, usd, 3]);
  let px = 1;
  tail.forEach(([u, tr, c], k) => { rows.push([T0 + (n + k) * STEP, px, Math.max(px, c), Math.min(px, c), c, u, tr]); px = c; });
  return rows;
}

test("Alpha klines: parsed to [t, o, h, l, c, quote volume, trades]; gaps filled on a 5-minute grid", () => {
  const raw = [["1000", "1", "2", "0.5", "1.5", "10", "1299", "15", "7", "10", "15", "0"], ["1600", "1.5", "1.6", "1.4", "0", "1", "1899", "1", "1", "1", "1", "0"]];
  assert.deepEqual(parseKlines(raw), [[1000, 1, 2, 0.5, 1.5, 15, 7]]); // zero close dropped
  const g = toGrid([[T0, 1, 1, 1, 1, 5, 1], [T0 + 2 * STEP, 2, 2, 2, 2, 6, 1]], T0, T0 + 3 * STEP);
  assert.equal(g.length, 3);
  assert.deepEqual(g[1], [T0 + STEP, 1, 1, 1, 1, 0, 0]); // no trades: last close, zero volume
  assert.equal(toGrid([[T0 + STEP, 1, 1, 1, 1, 1, 1]], T0, T0 + 2 * STEP)[0], null); // before the first trade
});

test("early ignition: two candles at 5x+ normal, $1k+, 10+ trades, price up; not confirmed under $1M of 24h volume", () => {
  const g = toGrid(series(298, 100, [[2000, 20, 1.02], [2500, 25, 1.04]]), T0, T0 + 300 * STEP);
  const f = alphaFeatures(g, 299);
  assert.equal(f.base, 100);
  assert.equal(f.r1, 20); assert.equal(f.r2, 25);
  assert.equal(f.move10, 4);
  assert.equal(f.qv24, 286 * 100 + 4500);
  const c = classifyAlpha(f);
  assert.equal(c.early, true); assert.equal(c.ok, false); assert.equal(c.tier, "early"); assert.equal(c.state, "ignited");
  assert.match(c.fails[0], /early only/);
});

test("confirmed ignition needs $1M+ of 24h volume; failures are named", () => {
  const g = toGrid(series(298, 4000, [[25_000, 40, 1.03], [30_000, 50, 1.05]]), T0, T0 + 300 * STEP);
  const f = alphaFeatures(g, 299);
  assert.ok(f.qv24 >= 1e6);
  const c = classifyAlpha(f);
  assert.equal(c.ok, true); assert.equal(c.tier, "confirmed");
  // the same candles with price down, or already up 40% in 24 hours
  assert.ok(classifyAlpha({ ...f, move10: -1 }).fails.includes("price not up over 10 minutes"));
  const ran = classifyAlpha({ ...f, chg24: 40 });
  assert.equal(ran.state, "ran"); assert.equal(ran.tier, null);
  assert.ok(classifyAlpha({ ...f, usd2: 900 }).fails.some((x) => /\$1000 per 5 minutes/.test(x)));
  assert.equal(classifyAlpha({ ...f, move10: 25 }).early, false); // a 25% spike in 10 minutes is too late
  assert.equal(alphaFeatures(g, 200), null); // under 24 hours of history
});

test("outcome: target first, stop first (also when both are touched in one candle), or the window ends", () => {
  const cfg = { ...DEFAULT_ALPHA, outcomeDays: 1, costPct: 1 };
  const mk = (bars) => [[0, 1, 1, 1, 1, 0, 0], ...bars.map(([h, l, c], k) => [(k + 1) * STEP, 1, h, l, c, 1, 1])];
  assert.deepEqual(alphaOutcome(mk([[1.2, 0.95, 1.1], [1.45, 1.1, 1.4]]), 0, 1, cfg).o, "win");
  assert.equal(alphaOutcome(mk([[1.2, 0.95, 1.1], [1.45, 1.1, 1.4]]), 0, 1, cfg).r, 39);
  assert.equal(alphaOutcome(mk([[1.5, 0.85, 1]]), 0, 1, cfg).o, "loss");          // both in one candle -> loss
  assert.equal(alphaOutcome(mk([[1.5, 0.85, 1]]), 0, 1, cfg).r, -11);
  const flat = mk(Array.from({ length: 300 }, () => [1.05, 0.98, 1.02]));
  assert.equal(alphaOutcome(flat, 0, 1, cfg).o, "flat");
  assert.equal(alphaOutcome(flat, 0, 1, cfg).r, 1);                                // +2% - 1% cost
  assert.equal(alphaOutcome(mk([[1.05, 0.98, 1.02]]), 0, 1, cfg).o, "open");      // not enough candles yet
});

test("live tracking: advance with new candles, results by tier", () => {
  const cfg = { ...DEFAULT_ALPHA, costPct: 1 };
  const a = { t: T0, tier: "confirmed", f: { close: 1 }, track: { status: "open", checkedTo: T0, peakPct: 0, lowPct: 0, last: 1 } };
  const now = T0 + 10 * STEP;
  assert.equal(advanceAlpha(a, [[T0, 1, 1.2, 0.95, 1.1, 1, 1]], cfg, now), true);
  assert.equal(a.track.status, "open"); assert.equal(a.track.peakPct, 20); assert.equal(a.track.lowPct, -5);
  advanceAlpha(a, [[T0, 1, 1.2, 0.95, 1.1, 1, 1], [T0 + STEP, 1.1, 1.5, 1.05, 1.4, 1, 1]], cfg, now);
  assert.equal(a.track.status, "win"); assert.equal(a.track.resultPct, 39);
  const b = { t: T0, tier: "early", f: { close: 1 }, track: { status: "open", checkedTo: T0, peakPct: 0, lowPct: 0, last: 1 } };
  advanceAlpha(b, [[T0 + 3 * STEP, 1, 1, 0.85, 0.9, 1, 1]], cfg, now);
  assert.equal(b.track.status, "loss");
  const c = { t: T0, tier: "early", f: { close: 1 }, track: { status: "open", checkedTo: T0, peakPct: 0, lowPct: 0, last: 1 } };
  advanceAlpha(c, [[T0 + 9 * STEP, 1, 1.1, 0.95, 1.05, 1, 1]], cfg, T0 + 9 * STEP + 60_000); // candle still running: ignored
  assert.equal(c.track.checkedTo, T0);
  assert.deepEqual(alphaResults([a, b, c], "confirmed"), { alerts: 1, open: 0, closed: 1, wins: 1, losses: 0, flats: 0, winPct: 100, avgNetPct: 39 });
  assert.equal(alphaResults([a, b, c], "early").losses, 1);
  assert.equal(alphaResults([a, b, c], "early").open, 1);
});

test("eligibility and DexScreener summary", () => {
  const ok = { alphaId: "ALPHA_1", symbol: "EVAA", name: "EVAA", liquidity: "361000", holders: "25775", offline: false, offsell: false, listingCex: false };
  assert.equal(alphaEligible(ok), null);
  assert.match(alphaEligible({ ...ok, offline: true }), /not trading/);
  assert.match(alphaEligible({ ...ok, listingCex: true }), /Binance spot/);
  assert.match(alphaEligible({ ...ok, liquidity: "20000" }), /liquidity/);
  assert.match(alphaEligible({ ...ok, holders: "50" }), /holders/);
  assert.match(alphaEligible({ ...ok, symbol: "USD1" }), /stablecoin/);
  const pairs = [
    { baseToken: { address: "0xABC" }, url: "u-small", liquidity: { usd: 10 }, txns: { m5: { buys: 1, sells: 1 }, h1: { buys: 1, sells: 1 } } },
    { baseToken: { address: "0xabc" }, url: "u-big", dexId: "pancakeswap", liquidity: { usd: 1000 }, txns: { m5: { buys: 30, sells: 10 }, h1: { buys: 60, sells: 40 } }, volume: { m5: 500 } },
    { baseToken: { address: "0xother" }, url: "x", liquidity: { usd: 1e9 } },
  ];
  const d = dexSummary(pairs, "0xAbC");
  assert.equal(d.url, "u-big"); assert.equal(d.buyShare5m, 75); assert.equal(d.buyShare1h, 60); assert.equal(d.pools, 2);
  assert.equal(dexSummary(pairs, "0xnone"), null);
});

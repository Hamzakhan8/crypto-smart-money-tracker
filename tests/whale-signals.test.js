// Whale signals (whale-signals.js): which whales are followed, how their positions add up per coin, the score and the
// TAKE / LEAVE call, and the whole scan against a made-up Hyperliquid in memory. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { RULE, pickWhales, bookOf, judge, rightWay, binanceOf, createWhaleSignals } from "../whale-signals.js";

const row = (a, account, all, month, vlm) => ({ ethAddress: a, accountValue: String(account), displayName: null,
  windowPerformances: [["allTime", { pnl: String(all), roi: "0.5", vlm: "1" }], ["month", { pnl: String(month), roi: "0.1", vlm: String(vlm) }]] });

test("followed whales: $1M+ accounts in profit all-time and this month, market makers left out, best first", () => {
  const w = pickWhales([row("0xA", 5e6, 9e6, 1e5, 1e8), row("0xB", 5e5, 9e9, 1e5, 1), row("0xC", 5e6, 2e7, -1, 1), row("0xD", 2e6, 3e7, 1, 2e9), row("0xE", 3e6, 1e7, 1, 1)]);
  assert.deepEqual(w.map((x) => x.address), ["0xe", "0xa"], "B too small, C losing this month, D trades 1000x its account (a market maker)");
});

test("positions add up per coin, in coins and in dollars", () => {
  const b = bookOf([{ address: "a", list: [{ coin: "SOL", size: 100 }, { coin: "kPEPE", size: -5 }] }, { address: "b", list: [{ coin: "SOL", size: -40 }] }], { SOL: 150, kPEPE: 0.01 });
  const s = b.get("SOL");
  assert.equal(s.longSize, 100); assert.equal(s.shortSize, 40); assert.equal(s.longUsd, 15000); assert.equal(s.nLong, 1); assert.equal(s.nShort, 1);
  assert.deepEqual(binanceOf("kPEPE"), { base: "PEPE", mult: 1000 });
});

const coin = (longSize, shortSize, px, nLong, nShort) => ({ longSize, shortSize, longUsd: longSize * px, shortUsd: shortSize * px, nLong, nShort });
test("TAKE LONG: whales mostly long and adding in the last hour", () => {
  const then = coin(30_000, 3_000, 100, 8, 2), now = coin(40_000, 3_000, 100, 9, 2); // $3.3M -> $4.3M of whale money
  const j = judge({ now, then, px: 100 });
  assert.equal(j.call, "TAKE LONG"); assert.ok(j.score >= RULE.take);
  assert.equal(j.flowUsd, 1_000_000); assert.match(j.why.join(" "), /added longs/);
});

test("no call without the last hour, without enough whales, or when only the price moved", () => {
  assert.equal(judge({ now: coin(40_000, 3_000, 100, 9, 2), then: null, px: 100 }).call, "WATCH", "the first scan cannot see what they added");
  assert.match(judge({ now: coin(10_000, 1_000, 100, 9, 2), then: null, px: 100 }).why[0], /too little to read/, "$1.1M is too little");
  assert.equal(judge({ now: coin(14_000, 0, 100, 2, 0), then: coin(10_000, 0, 100, 2, 0), px: 100 }).call, "WATCH", "two whales are too few");
  const then = coin(30_000, 3_000, 100, 8, 2), now = coin(30_000, 3_000, 130, 8, 2); // same coins, higher price
  assert.equal(judge({ now, then, px: 130 }).flowUsd, 0);
  assert.equal(judge({ now, then, px: 130 }).call, "WATCH");
});

test("TAKE SHORT and LEAVE", () => {
  assert.equal(judge({ now: coin(500, 20_000, 100, 2, 9), then: coin(500, 15_000, 100, 2, 8), px: 100 }).call, "TAKE SHORT");
  const leave = judge({ now: coin(18_000, 3_000, 100, 6, 2), then: coin(36_000, 3_000, 100, 8, 2), px: 100 });
  assert.equal(leave.call, "LEAVE"); assert.match(leave.why[0], /cut 55% of their net long/);
  const dumped = judge({ now: null, then: null, px: 1, ex: { tracked: true, netToExchanges24h: 8e6 } });
  assert.equal(dumped.call, "LEAVE"); assert.match(dumped.why[0], /onto exchanges/);
  assert.equal(rightWay("LEAVE", -3), true); assert.equal(rightWay("TAKE LONG", -3), false);
});

test("Ethereum, DEX and Binance crowd add to the score", () => {
  const base = judge({ now: coin(10_000, 10_000, 100, 5, 5), then: null, px: 100 }).score;
  const more = judge({ now: coin(10_000, 10_000, 100, 5, 5), then: null, px: 100, ex: { tracked: true, netToExchanges24h: -2e6 },
    dex: { tracked: true, last24h: { netUsd: 300_000, wallets: 9 } }, crowd: { state: "crowdShort", label: "Crowd short, smart money long", acc: 0.4, top: 1.3 } });
  assert.equal(more.score - base, 10 + 5 + 10);
});

test("live scan against a made-up Hyperliquid: whales picked, positions read, a call made once the hour has passed", async () => {
  let clock = Date.parse("2026-11-03T10:00:00Z"), size = 10_000; const sent = [];
  const fetchJson = async (url, opt = {}) => {
    if (url.includes("leaderboard")) return { leaderboardRows: Array.from({ length: 6 }, (_, i) => row(`0x${i}`, 5e6, 1e7 - i, 1e5, 1e6)) };
    const b = JSON.parse(opt.body);
    if (b.type === "allMids") return { SOL: "100" };
    return { assetPositions: [{ position: { coin: "SOL", szi: String(b.user === "0x0" ? size : 1_000), positionValue: "1", entryPx: "90", leverage: { value: 3 } } }] };
  };
  const w = createWhaleSignals({ fetchJson, now: () => clock, sendTelegram: (t, k) => sent.push([k, t]), wantTelegram: (k) => k === "whalesig" });
  await w.scan();
  assert.equal(w.api().read, 6); assert.equal(w.api().coins[0].call, "WATCH");
  clock += 61 * 60_000; size = 20_000; // an hour later the biggest whale doubled its long
  await w.scan();
  const a = w.api();
  assert.equal(a.coins[0].call, "TAKE LONG");
  assert.equal(a.signals.length, 1); assert.equal(sent.length, 1); assert.match(sent[0][1], /WHALE SIGNAL SOL: TAKE LONG/);
  clock += 2 * 60_000; await w.scan();
  assert.equal(w.api().signals.length, 1, "one call per coin and kind every 12 hours");
});

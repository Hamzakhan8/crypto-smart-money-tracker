// Spot tab (spot-trend.js): the 50-day trend rule, the simulation used by the test, and the daily plan end to end
// against a made-up Binance spot API in memory. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { SPOT, trendState, simulate, curveStats, coinCheck, createSpot } from "../spot-trend.js";

const DAY = 86_400_000, START = Date.parse("2026-08-01T00:00:00Z");

test("spot rule: hold while the daily close is above its 50-day average", () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i);
  const s = trendState(up);
  assert.equal(s.hold, true);
  assert.ok(Math.abs(s.avg - (110 + 159) / 2) < 1e-9); // the last 50 closes: 110..159
  assert.ok(s.distPct > 0);
  assert.equal(trendState([...up, 100]).hold, false, "a close under the average");
  assert.equal(trendState(up.slice(0, 49)), null, "50 closes needed");
  assert.equal(SPOT.avgDays, 50);
});

test("spot simulation: in the coin while above, in cash while below, a cost on every switch", () => {
  // 60 days flat at 100 then up 1% a day for 30 days, then down 2% a day for 30 days
  const px = [...Array(60).fill(100)]; for (let i = 0; i < 30; i++) px.push(px.at(-1) * 1.01); for (let i = 0; i < 30; i++) px.push(px.at(-1) * 0.98);
  const r = simulate({ BTC: px }, { n: 50, costPct: 0.15, from: 59 });
  assert.equal(r.switches.length, 2, "in once, out once");
  assert.equal(r.switches[0].hold, true); assert.equal(r.switches[1].hold, false);
  const st = curveStats(r.curve);
  assert.ok(st.totalPct > 0, "kept most of the rise, left during the fall");
  // holding would have ended under the start; the rule ends above it
  assert.ok(px.at(-1) / px[59] < 1 && r.curve.at(-1).eq > 1);
  // two coins: each gets half
  const two = simulate({ BTC: px, ETH: Array(px.length).fill(50) }, { n: 50, costPct: 0, from: 59 });
  assert.ok(Math.abs(two.curve.at(-1).eq - 1 - (r.curve.at(-1).eq / (1 - 0.0015) ** 2 - 1) / 2) < 0.01, "half in BTC, ETH (flat) never held");
});

test("spot live: the plan after the daily close, Telegram only when a coin switches", async () => {
  // BTC rising (HOLD), ETH falling (CASH); next day BTC closes far under its average
  const mk = (f) => Array.from({ length: 79 }, (_, i) => [START + i * DAY, f(i)]);
  const series = { BTC: mk((i) => 50000 + i * 200), ETH: mk((i) => 3000 - i * 10) };
  let clock = series.BTC.at(-1)[0] + DAY + 5 * 60_000;
  const fetchJson = async (url) => {
    const u = new URL(url), c = u.searchParams.get("symbol").replace(/USDT$/, ""), lim = Number(u.searchParams.get("limit"));
    const rows = series[c].filter((x) => x[0] <= clock);
    return [...rows, [rows.at(-1)[0] + DAY, rows.at(-1)[1]]].slice(-lim).map(([t, c2]) => [t, "0", "0", "0", String(c2), "0", t + DAY - 1, "0"]); // + today's open candle
  };
  const sent = [];
  const sp = createSpot({ fetchJson, base: "http://fake", now: () => clock, sendTelegram: (t, k) => sent.push([k, t]), wantTelegram: (k) => k === "spot" });
  const tick = () => new Map([["BTC", { lastPrice: String(series.BTC.at(-1)[1]) }], ["ETH", { lastPrice: String(series.ETH.at(-1)[1]) }]]);
  sp.onTickers(tick());
  for (let i = 0; i < 50 && sp.api().day == null; i++) await new Promise((r) => setTimeout(r, 5));
  let a = sp.api();
  assert.equal(a.status, "ok");
  assert.deepEqual(a.coins.map((c) => [c.coin, c.hold, c.weightPct]), [["BTC", true, 50], ["ETH", false, 0]]);
  assert.equal(a.plan, "BTC 50%, ETH 0%, USDT 50%");
  assert.equal(sent.length, 0, "the first check is not a switch");
  sp.onTickers(tick()); await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 0, "once per day");

  series.BTC.push([series.BTC.at(-1)[0] + DAY, 40000]); series.ETH.push([series.ETH.at(-1)[0] + DAY, series.ETH.at(-1)[1] - 10]);
  clock += DAY;
  sp.onTickers(tick());
  for (let i = 0; i < 50 && sp.api().day !== series.BTC.at(-1)[0]; i++) await new Promise((r) => setTimeout(r, 5));
  a = sp.api();
  assert.equal(a.coins[0].hold, false);
  assert.equal(a.coins[0].since, series.BTC.at(-1)[0]);
  assert.equal(a.plan, "BTC 0%, ETH 0%, USDT 100%");
  assert.equal(a.switches.length, 1);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], "spot");
  assert.match(sent[0][1], /BTC: SELL to USDT/); assert.match(sent[0][1], /USDT 100%/);
});

test("all-coins check: above its own average, stronger than BTC, and BUY OK only while BTC is up", async () => {
  const n = 50, btcUp = Array.from({ length: 60 }, (_, i) => 100 + i), btcDown = Array.from({ length: 60 }, (_, i) => 200 - i);
  const strong = Array.from({ length: 60 }, (_, i) => 10 * 1.02 ** i), lagging = Array.from({ length: 60 }, (_, i) => 10 + i * 0.01);
  assert.deepEqual([coinCheck(strong, btcUp, n).above, coinCheck(strong, btcUp, n).strongerThanBtc], [true, true]);
  assert.deepEqual([coinCheck(lagging, btcUp, n).above, coinCheck(lagging, btcUp, n).strongerThanBtc], [true, false], "up, but less than BTC");
  assert.equal(coinCheck(strong, btcUp.slice(1), n), null, "days must line up");

  // live: BTC falling (CASH), AAA strong, BBB weak; then the same with BTC rising
  const mk = (f, len = 130) => Array.from({ length: len }, (_, i) => [START + i * DAY, f(i)]);
  const run = async (btcF) => {
    const series = { BTC: mk(btcF), ETH: mk((i) => 2000 + i), AAA: mk((i) => 1 * 1.01 ** i), BBB: mk((i) => 5 - i * 0.02), NEW: mk((i) => 1, 60) };
    const clock = series.BTC.at(-1)[0] + DAY + 5 * 60_000;
    const fetchJson = async (url) => { const u = new URL(url), c = u.searchParams.get("symbol").replace(/USDT$/, ""), lim = Number(u.searchParams.get("limit"));
      return series[c].slice(-lim).map(([t, x]) => [t, "0", "0", "0", String(x), "0", t + DAY - 1, "3000000"]); };
    const sp = createSpot({ fetchJson, base: "http://fake", now: () => clock, excluded: (b) => b === "USDC" });
    sp.onTickers(new Map(["BTC", "ETH", "AAA", "BBB", "NEW", "USDC"].map((b) => [b, { lastPrice: "1", quoteVolume: "5000000" }])));
    for (let i = 0; i < 80 && sp.api().all == null; i++) await new Promise((r) => setTimeout(r, 5));
    return sp.api().all;
  };
  let all = await run((i) => 90000 - i * 100);
  assert.equal(all.btcUp, false);
  assert.deepEqual(all.rows.map((x) => x.coin), ["AAA", "BBB"], "not BTC/ETH (the plan has them), not a new listing, not USDC");
  assert.deepEqual([all.rows[0].above, all.rows[0].strongerThanBtc, all.rows[0].ok], [true, true, false]);
  assert.match(all.rows[0].why.join(), /BTC is under its average/);
  all = await run((i) => 50000 + i * 10);
  assert.equal(all.btcUp, true);
  assert.equal(all.rows[0].coin, "AAA"); assert.equal(all.rows[0].ok, true);
  assert.equal(all.rows[1].ok, false); assert.match(all.rows[1].why.join(), /under its own average/);
});

test("spot: off in demo mode, says so", () => {
  const a = createSpot({ fetchJson: async () => [], base: "x", demo: true }).api();
  assert.equal(a.status, "off");
  assert.match(a.error, /live Binance data/);
});

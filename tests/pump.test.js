// Pump watch (pump.js): the rule on daily candles, the tested exit, market mood, and the daily list end to end
// against a made-up Binance spot API in memory. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { PUMP, pumpFeatures, pumpCheck, pumpTrade, marketMood, createPump } from "../pump.js";

const DAY = 86_400_000, START = Date.parse("2026-06-01T00:00:00Z");
// rows [t, o, h, l, c, qv]: price wobbles 3% around `px` (so it is not "pegged"), $1M a day
const quiet = (n, px = 1, from = START) => Array.from({ length: n }, (_, i) => { const c = px * (i % 2 ? 1.015 : 0.985); return [from + i * DAY, px, c * 1.02, c * 0.98, c, 1e6]; });
const day = (k, c, qv, h = c * 1.02, l = c * 0.97) => [k.at(-1)[0] + DAY, k.at(-1)[4], h, l, c, qv];
const breakout = () => { const k = quiet(80); k.push(day(k, k.at(-1)[4] * 1.06, 3e6)); return k; }; // +6% day on 3x volume near the high

test("pump rule: near the 90-day high, 2x volume, not already running", () => {
  const k = breakout(), f = pumpFeatures(k, k.length - 1);
  assert.ok(f.volRatio >= 2.9 && f.volRatio <= 3.1);
  assert.ok(f.fromHigh90Pct > -15);
  assert.equal(pumpCheck(f).ok, true);

  const ran = quiet(80); ran.push(day(ran, ran.at(-1)[4] * 1.3, 3e6)); // +30% in a day: already running
  assert.match(pumpCheck(pumpFeatures(ran, 80)).miss.join(), /already running/);
  const thin = quiet(80); thin.push(day(thin, thin.at(-1)[4] * 1.05, 1.5e6)); // only 1.5x volume
  assert.match(pumpCheck(pumpFeatures(thin, 80)).miss.join(), /volume 2x/);
  const far = quiet(80); far[30] = [far[30][0], 1, 2, 0.98, 1.9, 1e6]; far.push(day(far, 1.05, 3e6)); // 90-day high at 2: far below it
  assert.match(pumpCheck(pumpFeatures(far, 80)).miss.join(), /90-day high/);
  const peg = Array.from({ length: 80 }, (_, i) => [START + i * DAY, 1, 1.001, 0.999, 1, 5e6]); peg.push(day(peg, 1.0005, 15e6, 1.001, 0.999));
  assert.match(pumpCheck(pumpFeatures(peg, 80)).miss.join(), /moves/);
  assert.equal(pumpFeatures(quiet(40), 39), null, "60 days of history needed");
});

test("pump exit: +100% target, -25% stop (both in one day = the stop), else the close after 14 days", () => {
  const base = breakout(), i = base.length - 1, e = base[i][4];
  const up = [...base, day(base, e * 1.3, 1e6), [0, 0, e * 2.05, e * 1.2, e * 1.9, 1e6]]; up[i + 2][0] = up[i + 1][0] + DAY;
  assert.deepEqual([pumpTrade(up, i).why, pumpTrade(up, i).pct, pumpTrade(up, i).days], ["target", 100, 2]);
  const both = [...base, [base[i][0] + DAY, e, e * 2.1, e * 0.7, e, 1e6]];
  assert.equal(pumpTrade(both, i).why, "stop");
  assert.equal(pumpTrade(both, i).pct, -25);
  const flat = [...base]; for (let j = 0; j < 14; j++) flat.push(day(flat, e * 1.1, 1e6, e * 1.12, e * 0.95));
  const t = pumpTrade(flat, i);
  assert.equal(t.why, "time"); assert.equal(t.done, true); assert.ok(Math.abs(t.pct - 10) < 1e-9);
  assert.equal(pumpTrade(flat.slice(0, i + 4), i).done, false, "still open after 3 days");
});

test("market mood: share of coins up over 30 days", () => {
  const f = (r30Pct, qv = 2e6) => ({ r30Pct, qv, pegged: false });
  assert.deepEqual(marketMood([f(10), f(5), f(-3), f(20), f(1, 1e5)]), { share: 75, coins: 4, ok: true });
  assert.equal(marketMood([f(-10), f(-5), f(3)]).ok, false);
  assert.equal(marketMood([]), null);
});

test("pump watch live: one list after the daily close, Telegram once, followed to its target, one pick per 14 days", async () => {
  // AAA breaks out on the last closed day; BBB is quiet; USDC is left out; CCC breaks out but is excluded (monitoring)
  const coins = { AAA: breakout(), BBB: quiet(81), CCC: breakout(), USDC: quiet(81) };
  let clock = coins.AAA.at(-1)[0] + DAY + 10 * 60_000; // 00:10 UTC after that close
  const kl = (r) => [r[0], String(r[1]), String(r[2]), String(r[3]), String(r[4]), "0", r[0] + DAY - 1, String(r[5])];
  const calls = [];
  const fetchJson = async (url) => {
    const u = new URL(url), b = u.searchParams.get("symbol").replace(/USDT$/, ""); calls.push(b);
    const rows = coins[b].filter((r) => r[0] <= clock);
    return [...rows, [rows.at(-1)[0] + DAY, rows.at(-1)[4], rows.at(-1)[4], rows.at(-1)[4], rows.at(-1)[4], 1]].slice(-100).map(kl); // + today's unfinished candle
  };
  const sent = [];
  const p = createPump({ fetchJson, base: "http://fake", now: () => clock, excluded: (b) => b === "CCC" || b === "USDC",
    sendTelegram: (t, kind) => sent.push([kind, t]), wantTelegram: (k) => k === "pump" });
  const tickers = () => new Map(Object.entries(coins).map(([b, k]) => [b, { lastPrice: String(k.filter((r) => r[0] <= clock).at(-1)[4]), quoteVolume: "3000000" }]));
  p.onTickers(tickers());
  for (let i = 0; i < 50 && p.api().day == null; i++) await new Promise((r) => setTimeout(r, 5));
  let a = p.api();
  assert.equal(a.status, "ok");
  assert.deepEqual(a.today.map((x) => x.base), ["AAA"]);
  assert.ok(!calls.includes("CCC") && !calls.includes("USDC"), "excluded coins are not read");
  const pick = a.today[0];
  assert.equal(pick.entry, coins.AAA.at(-1)[4]);
  assert.ok(Math.abs(pick.target / pick.entry - 2) < 1e-9 && Math.abs(pick.stop / pick.entry - 0.75) < 1e-9);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "pump");
  assert.match(sent[0][1], /PUMP WATCH .*1 coin/);
  assert.match(sent[0][1], /AAAUSDT/);
  p.onTickers(tickers()); await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1, "one list per day");

  assert.match(sent[0][1], a.mood.ok ? /mood .*OK/ : /mood .*WEAK/);
  const next = async (aaa) => {
    coins.AAA.push(aaa);
    for (const b of ["BBB", "CCC", "USDC"]) coins[b].push(day(coins[b], coins[b].at(-1)[4], 1e6));
    clock += DAY; p.onTickers(tickers());
    for (let i = 0; i < 50 && p.api().day !== aaa[0]; i++) await new Promise((r) => setTimeout(r, 5));
    return p.api();
  };
  // the next day AAA passes the rule again (+6% on 8x volume near the high), but within 14 days: no new pick
  const e = pick.entry;
  a = await next([coins.AAA.at(-1)[0] + DAY, e, e * 1.07, e * 0.99, e * 1.06, 9e6]);
  assert.equal(pumpCheck(pumpFeatures(coins.AAA, coins.AAA.length - 1)).ok, true);
  assert.equal(a.today.length, 0);
  assert.equal(a.open.length, 1);
  assert.equal(a.open[0].daysHeld, 1);
  // then it doubles
  a = await next([coins.AAA.at(-1)[0] + DAY, e * 1.06, e * 2.1, e * 1.0, e * 1.9, 6e6]);
  assert.equal(a.today.length, 0);
  assert.equal(a.open.length, 0);
  assert.equal(a.closed.length, 1);
  assert.equal(a.closed[0].why, "target");
  assert.equal(a.closed[0].netPct, 99.7);
  assert.equal(a.record.all.n, 1);
  assert.equal(sent.length, 1, "no message on a day without new picks");
});

test("pump watch: off in demo mode, says so", () => {
  const a = createPump({ fetchJson: async () => [], base: "x", demo: true }).api();
  assert.equal(a.status, "off");
  assert.match(a.error, /live Binance data/);
  assert.equal(PUMP.targetPct, 100);
});

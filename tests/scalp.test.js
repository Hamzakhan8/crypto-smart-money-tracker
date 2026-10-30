// Scalp tab (scalp.js): the flush-bounce setup on 5-minute candles, the tested exit, and the live scan end to end
// against a made-up Binance futures API in memory. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { SCALP, scalpSeries, flushBounce, scalpTrade, createScalp } from "../scalp.js";

const M5 = 300_000, DAY = 86_400_000, START = Date.parse("2026-10-01T00:00:00Z");
// a coin that swings about 1% every 5 minutes (volatile) or 0.1% (calm), $1M a candle
function wavy(n, px = 100, swing = 0.008) {
  const out = []; let c = px;
  for (let i = 0; i < n; i++) { const o = c; c = px * (i % 2 ? 1 + swing / 2 : 1 - swing / 2); out.push({ t: START + i * M5, o, h: Math.max(o, c) * (1 + swing / 3), l: Math.min(o, c) * (1 - swing / 3), c, qv: 1e6 }); }
  return out;
}
const bar = (B, o, h, l, c, qv = 1e6) => B.push({ t: B.at(-1).t + M5, o, h, l, c, qv });
// a flush (-4% on 6x volume), then a green candle back above its middle
function withFlush(B = wavy(120)) { const p = B.at(-1).c; bar(B, p, p * 1.001, p * 0.955, p * 0.96, 6e6); bar(B, p * 0.96, p * 0.986, p * 0.958, p * 0.984, 2e6); return B; }

test("scalp setup: a flush on volume, then a green close above its middle, on a volatile coin", () => {
  const B = withFlush(), x = scalpSeries(B), i = B.length - 1, s = flushBounce(x, i);
  assert.ok(s, "signal");
  assert.ok(s.dropAtr >= 2.5 && s.volRatio >= 4 && s.atrPct >= 0.6);
  assert.ok(s.stop < Math.min(B[i - 1].l, B[i].l));
  assert.equal(flushBounce(x, i - 1), null, "not on the flush candle itself");

  const calm = withFlush(wavy(120, 100, 0.001)), xc = scalpSeries(calm); // normal 5m range ~0.2%: too calm
  assert.equal(flushBounce(xc, calm.length - 1), null);
  assert.ok(flushBounce(xc, calm.length - 1, { ...SCALP, minAtrPct: 0 }), "only the calm-coin rule stops it");
  const quiet = withFlush(); quiet[quiet.length - 2].qv = 2e6; // only 2x volume
  assert.equal(flushBounce(scalpSeries(quiet), quiet.length - 1), null);
  assert.ok(flushBounce(scalpSeries(quiet), quiet.length - 1, { ...SCALP, minVolRatio: 1.5 }), "only the volume rule stops it");
  const weak = withFlush(); const w = weak.at(-1); w.c = w.o * 1.005; w.h = w.c; // green, but under the middle of the flush
  assert.equal(flushBounce(scalpSeries(weak), weak.length - 1), null);
  const small = withFlush(wavy(120, 100, 0.03)); // a 4% drop on a coin that moves 3%+ every 5 minutes: not a flush
  assert.equal(flushBounce(scalpSeries(small), small.length - 1), null);
  assert.ok(flushBounce(scalpSeries(small), small.length - 1, { ...SCALP, minDropAtr: 0.5 }), "only the size rule stops it");
});

test("scalp exit: entry at the next open, target 1.5R, stop first when both are touched, else after 1 hour", () => {
  const B = withFlush(), i = B.length - 1, x0 = scalpSeries(B), s = flushBounce(x0, i);
  assert.equal(scalpTrade(x0, i, s.stop).why, "waiting");
  const e = B[i].c, risk = e - s.stop;
  const up = [...B.map((b) => ({ ...b }))]; bar(up, e, e + 0.5 * risk, e - 0.2 * risk, e + 0.4 * risk); bar(up, e + 0.4 * risk, e + 1.6 * risk, e, e + 1.2 * risk);
  let r = scalpTrade(scalpSeries(up), i, s.stop);
  assert.deepEqual([r.why, r.candles], ["target", 2]);
  assert.ok(Math.abs(r.netPct - ((1.5 * risk) / e * 100 - SCALP.costPct)) < 1e-9);
  const both = [...B.map((b) => ({ ...b }))]; bar(both, e, e + 2 * risk, s.stop - 1, e);
  assert.equal(scalpTrade(scalpSeries(both), i, s.stop).why, "stop");
  const flat = [...B.map((b) => ({ ...b }))]; for (let k = 0; k < 12; k++) bar(flat, e, e * 1.002, e * 0.998, e * 1.001);
  r = scalpTrade(scalpSeries(flat), i, s.stop);
  assert.deepEqual([r.why, r.candles, r.done], ["time", 12, true]);
  assert.equal(scalpTrade(scalpSeries(flat.slice(0, i + 5)), i, s.stop).done, false);
  const gap = [...B.map((b) => ({ ...b }))]; bar(gap, s.stop * 0.99, s.stop, s.stop * 0.98, s.stop * 0.99);
  assert.equal(scalpTrade(scalpSeries(gap), i, s.stop).why, "gap");
});

test("scalp live: the scan finds the signal after the 5-minute close, sends it once, follows it to the target", async () => {
  const coins = { AAAUSDT: withFlush(wavy(160)), BTCUSDT: wavy(162, 60000, 0.001), XAUUSDT: wavy(162, 4000, 0.008) };
  const flushI = coins.AAAUSDT.length - 1, rev = coins.AAAUSDT[flushI];
  let clock = rev.t + M5 + 5_000;
  const forming = (B) => { const l = B.at(-1); return { t: l.t + M5, o: l.c, h: l.c, l: l.c, c: l.c, qv: 1 }; };
  const kl = (r) => [r.t, String(r.o), String(r.h), String(r.l), String(r.c), "0", r.t + M5 - 1, String(r.qv)];
  const fetchJson = async (url) => {
    const u = new URL(url), q = (k) => u.searchParams.get(k), sym = q("symbol");
    if (u.pathname === "/fapi/v1/exchangeInfo") return { symbols: [...Object.keys(coins), "USDCUSDT"].map((s) => ({ symbol: s, baseAsset: s.replace("USDT", ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", underlyingType: s === "XAUUSDT" ? "COMMODITY" : "COIN" })) };
    if (u.pathname === "/fapi/v1/ticker/24hr") return [...Object.keys(coins), "USDCUSDT"].map((s) => ({ symbol: s, quoteVolume: "9000000" }));
    if (u.pathname === "/fapi/v1/klines" && q("interval") === "1d") return Array.from({ length: 31 }, (_, k) => [START - (31 - k) * DAY, "1", "1", "1", "1", "0", 0, String(1e8 + (sym === "BTCUSDT" ? 1 : 0))]);
    if (u.pathname === "/fapi/v1/klines") { const B = coins[sym].filter((b) => b.t + M5 <= clock); return [...B, forming(B)].slice(-Number(q("limit"))).map(kl); }
    throw new Error("not mocked: " + u.pathname);
  };
  const sent = [];
  const s = createScalp({ fetchJson, base: "http://fake", now: () => clock, sendTelegram: (t, k) => sent.push([k, t]), wantTelegram: (k) => k === "scalp" });
  await s.scan();
  let a = s.api();
  assert.equal(a.status, "ok", a.error);
  assert.deepEqual(a.coins.map((c) => c.base).sort(), ["AAA", "BTC"], "gold and stablecoins are left out");
  assert.equal(a.signals.length, 1);
  const sig = a.signals[0];
  assert.equal(sig.sym, "AAAUSDT"); assert.equal(sig.status, "open"); assert.equal(sig.t, rev.t);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], "scalp");
  assert.match(sent[0][1], /SCALP LONG AAAUSDT/); assert.match(sent[0][1], /Stop/); assert.match(sent[0][1], /Close by/);
  await s.scan();
  assert.equal(s.api().signals.length, 1, "the same signal is not sent twice");
  assert.equal(sent.length, 1);

  // the next candles: up to the target
  const B = coins.AAAUSDT, e = rev.c, risk = e - sig.stop;
  bar(B, e, e + 0.4 * risk, e - 0.1 * risk, e + 0.3 * risk); bar(B, e + 0.3 * risk, e + 1.7 * risk, e + 0.2 * risk, e + 1.4 * risk); bar(B, e + 1.4 * risk, e + 1.5 * risk, e + risk, e + 1.2 * risk);
  for (const k of ["BTCUSDT", "XAUUSDT"]) for (let n = 0; n < 3; n++) bar(coins[k], coins[k].at(-1).c, coins[k].at(-1).c, coins[k].at(-1).c, coins[k].at(-1).c);
  clock += 3 * M5;
  await s.scan();
  a = s.api();
  const done = a.signals[0];
  assert.equal(done.status, "closed"); assert.equal(done.why, "target"); assert.equal(done.entry, e);
  assert.ok(Math.abs(done.netPct - ((1.5 * risk) / e * 100 - SCALP.costPct)) < 0.01);
  assert.equal(a.record.n, 1); assert.equal(a.record.targets, 1);
  assert.equal(sent.length, 1, "closing sends nothing");
});

test("scalp: off in demo mode, says so", () => {
  const a = createScalp({ fetchJson: async () => [], demo: true }).api();
  assert.equal(a.status, "off");
  assert.match(a.error, /live Binance futures data/);
});

// Perps tab, end to end against a made-up Binance futures API in memory: a 4h breakout is found on the closed candle,
// gets a verdict, is followed to its target with costs, and "check a trade" explains a coin. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { createPerps } from "../perps-live.js";

const H4 = 14_400_000, DAY = 86_400_000;
const START = Date.parse("2026-01-01T00:00:00Z");
function series(closes, volume = () => 1e6) {
  return closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: START + i * H4, o, h: Math.max(o, c) * 1.004, l: Math.min(o, c) * 0.996, c, qv: volume(i) }; });
}
const up = (n, from, step) => Array.from({ length: n }, (_, i) => from + i * step + (i % 6 === 0 ? from * 0.003 : 0));
const aaa = [...up(400, 100, 0.05), 119.5, 119.3, 119.1, 118.9, 118.7, 118.5, 123]; // a dip, then a close through the 20-day high
const bars = { BTCUSDT: series(up(407, 50000, 20)), AAAUSDT: series(aaa, (i) => (i === aaa.length - 1 ? 5e6 : 1e6)), XAUUSDT: series(up(407, 4000, 1)) };
const daily = (b) => { const out = []; for (let i = 0; i + 6 <= b.length; i += 6) { const g = b.slice(i, i + 6); out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[5].c, qv: 6e6 }); } return out; };
let now = bars.AAAUSDT[aaa.length - 1].t + H4 + 2 * 60_000; // two minutes after the breakout candle closed
const kl = (r) => [r.t, String(r.o), String(r.h), String(r.l), String(r.c), "0", r.t + 1, String(r.qv), 0, "0", "0", "0"];
async function fetchJson(url) {
  const u = new URL(url), q = (k) => u.searchParams.get(k), sym = q("symbol");
  if (u.pathname === "/fapi/v1/exchangeInfo") return { symbols: Object.keys(bars).map((s) => ({ symbol: s, baseAsset: s.replace("USDT", ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING" })) };
  if (u.pathname === "/fapi/v1/ticker/24hr") return Object.keys(bars).map((s) => ({ symbol: s, quoteVolume: "6000000" }));
  if (u.pathname === "/fapi/v1/premiumIndex") return Object.keys(bars).map((s) => ({ symbol: s, markPrice: String(bars[s].filter((b) => b.t + H4 <= now).pop().c), lastFundingRate: "0.0001" }));
  if (u.pathname === "/fapi/v1/fundingRate") return [];
  if (u.pathname === "/fapi/v1/klines") {
    const rows = (q("interval") === "1d" ? daily(bars[sym]) : bars[sym]).filter((b) => b.t <= now);
    return rows.slice(-Number(q("limit"))).map(kl);
  }
  if (u.pathname.startsWith("/futures/data/")) return [];
  throw new Error("not mocked: " + u.pathname);
}

test("perps live: finds the breakout on the closed 4h candle, follows it to the target, explains a check", async () => {
  const sent = [];
  const p = createPerps({ fetchJson, base: "http://fake", now: () => now, top: 10, sendTelegram: async (t, k) => sent.push([k, t]), wantTelegram: (k) => k === "perps" });
  await p.scan();
  let a = p.api();
  assert.equal(a.status, "ready"); assert.equal(a.coins, 2); // gold (XAU) is left out
  const sig = a.signals.find((x) => x.sym === "AAAUSDT");
  assert.ok(sig, JSON.stringify(a.signals));
  assert.equal(sig.setup, "breakout"); assert.equal(sig.side, "long"); assert.equal(sig.price, 123);
  assert.equal(sig.verdict, "WAIT"); assert.match(sig.reasons[0], /No backtest report/); // no record yet: never TAKE
  assert.equal(sent.length, 1); assert.match(sent[0][1], /^PERPS WAIT: LONG AAA/);
  // the same candle again: no duplicate
  await p.scan(); assert.equal(p.api().signals.filter((x) => x.sym === "AAAUSDT").length, 1);
  // next candles: opens at 123, then runs through the 2.5R target
  const target = sig.target, last = bars.AAAUSDT[bars.AAAUSDT.length - 1];
  bars.AAAUSDT.push({ t: last.t + H4, o: 123, h: 124, l: 122.5, c: 123.5, qv: 1e6 }, { t: last.t + 2 * H4, o: 123.5, h: target * 1.02, l: 123, c: target * 1.01, qv: 1e6 });
  for (const s of ["BTCUSDT", "XAUUSDT"]) { const b = bars[s][bars[s].length - 1]; bars[s].push({ ...b, t: b.t + H4 }, { ...b, t: b.t + 2 * H4 }); }
  now += 2 * H4;
  await p.scan();
  a = p.api();
  const done = a.signals.find((x) => x.id === sig.id);
  assert.equal(done.track.status, "closed"); assert.equal(done.track.why, "target");
  assert.ok(Math.abs(done.track.r - (2.5 - 0.16 / done.track.riskPct)) < 0.01, JSON.stringify(done.track));
  assert.equal(a.live.closed, 1);
  // check a trade: a short on the coin that just broke out has no tested setup -> WAIT, and what to wait for
  const c = await p.check({ sym: "aaa", side: "short" });
  assert.equal(c.verdict, "WAIT"); assert.equal(c.sym, "AAAUSDT"); assert.match(c.waitFor[0], /20-day breakdown short/);
  assert.ok(c.risk.stop > c.risk.entry); // a short's stop is above the entry
  const g = await p.check({ sym: "XAU", side: "long" });
  assert.match(g.reasons[0], /Not a crypto coin/);
  await assert.rejects(p.check({ sym: "NOPE", side: "long" }), /not a Binance USDⓈ-M perpetual/);
});

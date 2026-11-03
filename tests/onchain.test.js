// On-chain tab (crowd vs smart money): the rules, the exit, and a full scan against a fake Binance futures API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CROWD, positioning, crowdSetup, crowdTrade, structure, percentileOf, joinRatios, atrAt, createOnchain } from "../onchain.js";

const H4 = 14_400_000, DAY = 86_400_000;

test("positioning: his example is 'crowd short, smart money long'; the mirror needs a 30-day extreme", () => {
  assert.equal(positioning({ acc: 0.397, top: 1.31 }).state, "crowdShort"); // @ArslanOnChain's $AGT numbers
  assert.equal(positioning({ acc: 0.6, top: 1.31 }).state, "leanShort");    // not short enough for the signal
  assert.equal(positioning({ acc: 0.45, top: 1.1 }).state, "leanShort");    // top traders not long enough
  assert.equal(positioning({ acc: 2.8, top: 0.9, accPct: 95 }).state, "crowdLong");
  assert.equal(positioning({ acc: 2.8, top: 0.9, accPct: 70 }).state, "leanLong"); // high, but normal for this coin
  assert.equal(positioning({ acc: 2.8, top: 1.4, accPct: 99 }).state, "aligned");  // top traders long too
  assert.equal(positioning({ acc: null, top: 1 }).state, null);
  assert.equal(positioning({ acc: 0.5, top: 1.5 }).gap, 3);
});

test("crowdSetup: long on his setup; short only with lower highs; sides can be switched off", () => {
  assert.deepEqual(crowdSetup(positioning({ acc: 0.4, top: 1.3 }), {}), { side: 1, setup: "crowdShort" });
  const longCrowd = positioning({ acc: 3, top: 0.8, accPct: 96 });
  assert.equal(crowdSetup(longCrowd, { lowerHighs: false }), null);
  assert.deepEqual(crowdSetup(longCrowd, { lowerHighs: true }), { side: -1, setup: "crowdLong" });
  assert.equal(crowdSetup(positioning({ acc: 0.4, top: 1.3 }), {}, { ...CROWD, sides: ["short"] }), null);
});

test("percentile, structure, ATR and joining ratios to candles", () => {
  assert.equal(percentileOf(Array(59).fill(1), 2), null); // under 10 days of readings
  assert.equal(percentileOf(Array.from({ length: 100 }, (_, k) => k + 1), 91), 90);
  const bars = Array.from({ length: 20 }, (_, k) => ({ t: k * H4, o: 100, h: 101 + (k >= 14 ? 1 : 0), l: 99 + (k >= 14 ? 1 : 0), c: 100 }));
  assert.deepEqual(structure(bars, 19), { higherLows: true, lowerHighs: false });
  assert.equal(atrAt(bars, 5), null); assert.ok(atrAt(bars, 19) > 0);
  const j = joinRatios(bars.slice(0, 3), [[H4, 0.5], [2 * H4, 0.6]], [[H4, 1.2]]);
  assert.equal(j[0].acc, 0.5); assert.equal(j[1].acc, 0.6); assert.equal(j[0].top, 1.2); assert.equal(j[2].acc, null); // a reading at T = the bar closing at T
});

test("crowdTrade: entry at the next open, stop 2 ATR, close after 3 days; a gap through the stop fills at the open", () => {
  const flat = (k, o = 100) => ({ t: k * H4, o, h: o + 1, l: o - 1, c: o });
  const bars = Array.from({ length: 40 }, (_, k) => flat(k));
  const a = atrAt(bars, 19); // 2 (range 2 each bar)
  let r = crowdTrade(bars, 19, 1);
  assert.equal(r.entry, 100); assert.equal(r.stop, 100 - 2 * a); assert.equal(r.target, null);
  assert.equal(r.done, true); assert.equal(r.why, "time"); assert.equal(r.bars, 18); assert.ok(Math.abs(r.netPct + CROWD.costPct) < 1e-9);
  const gap = bars.map((b) => ({ ...b })); gap[22] = flat(22, 90); // opens 10% lower
  r = crowdTrade(gap, 19, 1);
  assert.equal(r.why, "stop"); assert.equal(r.exit, 90); assert.ok(Math.abs(r.netPct - (-10 - CROWD.costPct)) < 1e-9);
  r = crowdTrade(gap, 19, -1); // the short wins on the drop and closes on time
  assert.equal(r.why, "time");
  assert.equal(crowdTrade(bars.slice(0, 25), 19, 1).done, false); // still open
  assert.equal(crowdTrade(bars, 39, 1).entry, null);              // no next bar yet
});

// A fake Binance futures API: AAA shows his long setup on the last closed 4h bar, BBB the short mirror.
function fakeFutures(nowRef) {
  const base0 = Math.floor(Date.UTC(2026, 10, 3, 9) / H4) * H4;
  const bars = (sym) => { // 200 four-hour candles up to the current (forming) one; flat prices
    const cur = Math.floor(nowRef() / H4) * H4, out = [];
    for (let k = 199; k >= 0; k--) {
      const t = cur - k * H4, lowerHigh = sym === "BBBUSDT" && t >= base0 - 6 * H4 && t <= base0 - H4; // BBB: lower highs into the signal bar
      out.push([t, 100, lowerHigh ? 100.4 : 101, 99, 100, 0, 0, 1e7]);
    }
    return out;
  };
  const ratios = (sym, kind) => {
    const now = nowRef(), out = [];
    for (let k = 179; k >= 0; k--) {
      const ts = Math.floor(now / H4) * H4 - k * H4; // a reading at each 4h close
      let v;
      if (kind === "acc") v = sym === "AAAUSDT" ? (ts === base0 ? 0.4 : 1.1) : (ts === base0 ? 3.2 : 1.5 + (k % 7) * 0.05);
      else v = sym === "AAAUSDT" ? (ts === base0 ? 1.3 : 1.0) : (ts === base0 ? 0.8 : 1.1);
      out.push({ symbol: sym, longShortRatio: String(v), timestamp: ts });
    }
    return out;
  };
  return async (url) => {
    const u = new URL(url), sym = u.searchParams.get("symbol");
    if (u.pathname === "/fapi/v1/exchangeInfo") return { symbols: ["AAAUSDT", "BBBUSDT"].map((s) => ({ symbol: s, baseAsset: s.replace("USDT", ""), quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", underlyingType: "COIN" })) };
    if (u.pathname === "/fapi/v1/ticker/24hr") return [{ symbol: "AAAUSDT", quoteVolume: "9e8" }, { symbol: "BBBUSDT", quoteVolume: "8e8" }];
    if (u.pathname === "/fapi/v1/klines" && u.searchParams.get("interval") === "1d") {
      const d0 = Math.floor(nowRef() / DAY) * DAY; return Array.from({ length: 31 }, (_, k) => [d0 - (30 - k) * DAY, 100, 101, 99, 100, 0, 0, 1e8]);
    }
    if (u.pathname === "/fapi/v1/klines") return bars(sym);
    if (u.pathname === "/futures/data/globalLongShortAccountRatio") return ratios(sym, "acc");
    if (u.pathname === "/futures/data/topLongShortPositionRatio") return ratios(sym, "top");
    if (u.pathname === "/futures/data/openInterestHist") return [];
    throw new Error("unexpected " + u.pathname);
  };
}

test("live scan: finds his long setup and the short mirror, sends Telegram, follows both to their exit", async () => {
  let now = Math.floor(Date.UTC(2026, 10, 3, 9) / H4) * H4 + 120_000; // two minutes after the signal bar closed
  const sent = [];
  const oc = createOnchain({ fetchJson: fakeFutures(() => now), now: () => now, sendTelegram: (t, kind) => sent.push([kind, t]), wantTelegram: (k) => k === "onchain" });
  await oc.scan();
  let a = oc.api();
  assert.equal(a.status, "ok", a.error);
  assert.equal(a.coins.length, 2);
  const aaa = a.coins.find((c) => c.base === "AAA"), bbb = a.coins.find((c) => c.base === "BBB");
  assert.equal(aaa.state, "crowdShort"); assert.equal(aaa.acc, 0.4); assert.equal(aaa.top, 1.3);
  assert.equal(bbb.state, "crowdLong"); assert.ok(bbb.accPct30d >= 90);
  const long = a.signals.find((s) => s.base === "AAA"), short = a.signals.find((s) => s.base === "BBB");
  assert.ok(long && long.side === 1 && long.status === "open" && long.entry == null, JSON.stringify(a.signals));
  assert.ok(short && short.side === -1, "short mirror found: " + JSON.stringify(a.signals.map((s) => s.base)));
  assert.equal(sent.length, 2); assert.match(sent.find((x) => /AAA/.test(x[1]))[1], /ON-CHAIN: LONG \(BUY\) AAAUSDT[\s\S]*account long\/short ratio 0.4[\s\S]*Close after 3 days/);
  await oc.scan(); // the same bar again: no duplicate
  assert.equal(oc.api().signals.length, 2); assert.equal(sent.length, 2);
  now += 4 * DAY; // three days later: both close on time (flat prices)
  await oc.scan();
  a = oc.api();
  const closed = a.signals.filter((s) => s.status === "closed");
  assert.equal(closed.length, 2, JSON.stringify(a.signals.map((s) => [s.base, s.status, s.why])));
  assert.ok(closed.every((s) => s.why === "time" && s.entry > 0 && Number.isFinite(s.netPct)));
  assert.equal(a.record.n, 2); assert.equal(a.open, 0);
});

test("live scan: a blocked connection (451) shows a plain error, not a crash", async () => {
  const oc = createOnchain({ fetchJson: async () => { throw new Error("HTTP 451"); }, now: () => Date.now() });
  await oc.scan();
  assert.equal(oc.api().status, "error"); assert.match(oc.api().error, /451/);
  assert.equal(createOnchain({ fetchJson: async () => [], demo: true }).api().status, "off");
});

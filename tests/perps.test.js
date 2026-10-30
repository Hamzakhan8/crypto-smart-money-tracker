// Perps swing backtest: indicators, signals, exits with fees and funding, results, archive parsing. Made-up candles.
import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

const P = await import("../perps.js");
const Hs = await import("../perps-history.js");
const H4 = 14_400_000, DAY = 86_400_000, T0 = Date.parse("2024-01-01T00:00:00Z");

// 4h candles from a list of closes (open = previous close), and the daily candles they make
function coinFrom(closes, { wick = 0.004, qv = 1e6, oi = null, funding = [] } = {}) {
  const bars = closes.map((c, i) => { const o = i ? closes[i - 1] : c; return { t: T0 + i * H4, o, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), c, qv: typeof qv === "function" ? qv(i) : qv, oi: oi ? oi(i) : null, top: null, acc: null, taker: null }; });
  const daily = [];
  for (let i = 0; i + 6 <= bars.length; i += 6) { const g = bars.slice(i, i + 6); daily.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[5].c, qv: 6e6 }); }
  return { sym: "TESTUSDT", bars, funding, daily };
}

test("indicators: EMA, ATR and RSI", () => {
  const e = P.ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(e.slice(0, 3), [null, null, 2]);
  assert.equal(e[3], 3); assert.equal(e[4], 4);
  const bars = Array.from({ length: 20 }, (_, i) => ({ h: 11, l: 9, c: 10 }));
  assert.equal(P.atr(bars, 14)[14], 2);
  const up = P.rsi(Array.from({ length: 20 }, (_, i) => i + 1), 14);
  assert.equal(up[19], 100);
});

test("exits: long target, stop checked first, gap past the stop, short target", () => {
  const closes = Array(140).fill(100);
  const s = P.prepare(coinFrom(closes, { wick: 0 }));
  const set = (j, o, h, l, c) => Object.assign(s.bars[j], { o, h, l, c });
  // long from bar 101's open = 100, stop 95 (R = 5), 2.5R target = 112.5
  set(101, 100, 103, 99, 102); set(102, 102, 113, 101, 112);
  let t = P.simulate(s, { i: 100, dir: 1, stop: 95 }, P.EXITS.main, 0.08);
  assert.equal(t.why, "target"); assert.equal(t.exit, 112.5);
  assert.equal(t.netPct, 12.5 - 0.16); assert.equal(t.r, +((12.5 - 0.16) / 5).toFixed(3));
  // a candle touching both stop and target counts as the stop
  set(102, 102, 113, 94, 100);
  t = P.simulate(s, { i: 100, dir: 1, stop: 95 }, P.EXITS.main, 0);
  assert.equal(t.why, "stop"); assert.equal(t.exit, 95); assert.equal(t.r, -1);
  // opening below the stop fills at the open (worse than the stop)
  set(102, 90, 91, 88, 89);
  t = P.simulate(s, { i: 100, dir: 1, stop: 95 }, P.EXITS.main, 0);
  assert.equal(t.exit, 90); assert.equal(t.r, -2);
  // short: stop 105, target 87.5
  set(102, 99, 100, 87, 88);
  t = P.simulate(s, { i: 100, dir: -1, stop: 105 }, P.EXITS.main, 0);
  assert.equal(t.why, "target"); assert.equal(t.exit, 87.5); assert.equal(t.r, 2.5);
});

test("exits: time limit, trailing stop moves only after the candle closes", () => {
  const closes = Array(300).fill(100);
  const s = P.prepare(coinFrom(closes, { wick: 0.001 }));
  const t = P.simulate(s, { i: 140, dir: 1, stop: 95 }, P.EXITS.time5, 0);
  assert.equal(t.why, "time"); assert.equal(t.days, 5);
  // a candle that runs to +2R and back down to the old stop zone in the same candle: trailing is not used yet
  Object.assign(s.bars[142], { o: 100, h: 110, l: 96, c: 109 });
  Object.assign(s.bars[143], { o: 109, h: 109.5, l: 99.5, c: 100 });
  const tr = P.simulate(s, { i: 140, dir: 1, stop: 95 }, P.EXITS.trail, 0);
  // not stopped inside the +2R candle; after it closed the stop trails just under 110 (tiny ATR), and the next candle
  // opens below it: out at that open
  assert.equal(tr.why, "trailing stop"); assert.equal(tr.exit, 109); assert.equal(tr.exitT, tr.t + 2 * H4); // an in-candle stop: that candle's open time
});

test("exits: a coin delisted while a trade is open closes at its last price; open at the end of the history is left out", () => {
  const s = P.prepare(coinFrom(Array(160).fill(100), { wick: 0.001 }));
  const end = s.bars[159].t + H4;
  assert.equal(P.simulate(s, { i: 150, dir: 1, stop: 95 }, P.EXITS.main, 0, end), null);          // history ends here: still open
  const d = P.simulate(s, { i: 150, dir: 1, stop: 95 }, P.EXITS.main, 0, end + 30 * DAY);         // candles stop a month early
  assert.equal(d.why, "delisted"); assert.equal(d.exit, 100);
});

test("funding: longs pay positive funding, shorts receive it", () => {
  const closes = Array(200).fill(100);
  const funding = Array.from({ length: 200 }, (_, k) => [T0 + k * 8 * 3_600_000, 0.0005]); // 0.05% every 8h
  const s = P.prepare(coinFrom(closes, { wick: 0.001, funding }));
  const long = P.simulate(s, { i: 140, dir: 1, stop: 95 }, P.EXITS.time5, 0), short = P.simulate(s, { i: 140, dir: -1, stop: 105 }, P.EXITS.time5, 0);
  assert.equal(long.fundingPct, -0.75); assert.equal(short.fundingPct, 0.75); // 15 payments in 5 days
  assert.equal(s.fund8h[150], 0.05);
});

test("signals: a 20-day breakout on volume in an uptrend", () => {
  const closes = [];
  for (let i = 0; i < 400; i++) closes.push(100 + i * 0.05 + (i % 6 === 0 ? 0.3 : 0)); // slow uptrend
  for (let i = 0; i < 6; i++) closes.push(119.5 - i * 0.2);  // small dip under the 20-day high
  closes.push(123);                                              // the breakout candle
  const coin = coinFrom(closes, { qv: (i) => (i === closes.length - 1 ? 5e6 : 1e6) });
  const s = P.prepare(coin), i = closes.length - 1;
  const sig = P.signalsAt(s, i, {});
  assert.ok(sig.some((x) => x.setup === "breakout" && x.dir === 1), JSON.stringify(sig));
  assert.ok(!sig.some((x) => x.dir === -1));
  // the same candle without the volume: no breakout signal
  const quiet = P.prepare(coinFrom(closes));
  assert.ok(!P.signalsAt(quiet, i, {}).some((x) => x.setup === "breakout"));
});

test("signals: a flush that cuts open interest, then a reclaim", () => {
  const closes = Array(400).fill(100);
  closes.push(100, 96, 90, 86, 85, 88, 94); // fast drop, then a strong candle back over the middle
  const n = closes.length;
  const s = P.prepare(coinFrom(closes, { oi: (i) => (i < n - 5 ? 1e8 : 0.9e8) }));
  const sig = P.signalsAt(s, n - 1, {});
  assert.ok(sig.some((x) => x.setup === "flush" && x.dir === 1), JSON.stringify(sig));
  // no open interest data: no flush signal
  assert.ok(!P.signalsAt(P.prepare(coinFrom(closes)), n - 1, {}).some((x) => x.setup === "flush"));
});

test("results: summary, one-account portfolio and the verdict", () => {
  const tr = (sym, r, t) => ({ sym, r, netPct: r * 2, fundingPct: 0, days: 2, why: r > 0 ? "target" : "stop", t, exitT: t + DAY });
  const trades = [tr("A", 2.5, 0), tr("B", -1, DAY), tr("C", -1, 2 * DAY), tr("A", 2.5, 3 * DAY)];
  const s = P.summary(trades);
  assert.equal(s.trades, 4); assert.equal(s.winRatePct, 50); assert.equal(s.avgR, 0.75); assert.equal(s.profitFactor, 2.5);
  assert.equal(s.maxDrawdownR, 2); assert.equal(s.top3SharePct, 100);
  const pf = P.portfolio([tr("A", 1, 0), tr("A", 1, DAY / 2), tr("B", 1, DAY / 2)], 5);
  assert.equal(pf.taken, 2); // the second A trade overlaps the first: one position per coin
  const many = (n, r) => Array.from({ length: n }, (_, k) => tr("S" + (k % 20), r, k * DAY));
  assert.equal(P.verdict(P.summary(many(120, 0.3)), P.summary(many(40, 0.2))).verdict, "holds");
  assert.equal(P.verdict(P.summary(many(120, 0.3)), P.summary(many(40, -0.2))).verdict, "mixed: worked in one period only");
  assert.equal(P.verdict(P.summary(many(20, 0.3)), P.summary(many(10, 0.3))).verdict, "too few trades");
});

test("archive: zip reading, candles, metrics per 4h bar and joining day files", () => {
  const csv = Buffer.from("open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n1704067200000,1,2,0.5,1.5,10,1704081599999,15,3,4,6,0\n");
  const data = deflateRawSync(csv), name = Buffer.from("x.csv");
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(csv.length, 22); local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(csv.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const cdOff = 30 + name.length + data.length, eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cdOff, 16);
  const zip = Buffer.concat([local, name, data, cd, name, eocd]);
  assert.deepEqual(Hs.parseKlines(Hs.unzipFirst(zip)), [[1704067200000, 1, 2, 0.5, 1.5, 15, 6]]);
  const m = Hs.parseMetrics(Buffer.from("create_time,symbol,a,b,c,d,e,f\n2024-01-01 00:00:00,X,1,100,2,3,4,1.0\n2024-01-01 00:05:00,X,1,110,2,3.5,4,0.5\n2024-01-01 04:00:00,X,1,120,2,4,4,2\n"));
  assert.deepEqual(m.map((x) => x.slice(0, 5)), [[T0 - H4, 100, 3, 4, 1], [T0, 120, 4, 4, 1.25]]); // 00:00 closes the previous bar
  const joined = Hs.mergeMetric([T0, 110, 3.5, 4, 0.5, 1, T0 + 1], [T0, 120, 4, 5, 2, 1, T0 + 9]);
  assert.deepEqual(joined.slice(0, 5), [T0, 120, 4, 5, 1.25]);
  assert.ok(Hs.EXCLUDED.has("TSLA") && !Hs.EXCLUDED.has("T")); // TUSDT is Threshold (crypto), not TrueUSD
  // a market closed on weekends (stock / ETF / oil perpetual) vs crypto, from daily volume
  const days = (weekendVol) => Array.from({ length: 35 }, (_, k) => { const t = T0 + k * DAY, d = new Date(t).getUTCDay(); return [t, 1, 1.1, 0.9, 1, d === 0 || d === 6 ? weekendVol : 100]; });
  assert.equal(Hs.isTradFi(days(15)), true); assert.equal(Hs.isTradFi(days(55)), false); assert.equal(Hs.isTradFi(days(15).slice(0, 10)), false); // too short to tell
});

test("verdicts: TAKE / WAIT / SKIP from the tested record and the conditions met now", () => {
  const rec = (older, newer, groups) => ({ all: { trades: 2000, avgR: 0.15, winRatePct: 41 }, older: { avgR: older }, newer: { avgR: newer }, groups });
  const g = (name, olderR, newerR, holds) => ({ name, olderR, newerR, holds, trades: 500 });
  const down = { btc: "down", dTrend: "down", oi24h: null, fund8h: null, fundPct: null, topVsAcc: null, vol: 1, rs: null };
  const helps = g("Daily trend with the trade", 0.31, 0.12, "better in both");
  assert.equal(P.judge("breakout", -1, down, rec(0.2, 0.07, [helps])).verdict, "TAKE"); // +0.05 in the newer period counts (rounding)
  assert.equal(P.judge("breakout", -1, { ...down, dTrend: "mixed" }, rec(0.2, 0.07, [helps])).verdict, "WAIT"); // condition not met
  assert.equal(P.judge("breakout", -1, down, rec(0.2, 0.07, [g("Daily trend with the trade", 0.22, 0.08, "better in both")])).verdict, "WAIT"); // too small to count
  assert.equal(P.judge("breakout", -1, down, rec(-0.06, 0.07, [helps])).verdict, "SKIP"); // lost money before 2025
  const hurts = [g("BTC trend with the trade", 0.0, -0.1, "worse in both"), g("Daily trend with the trade", 0.0, -0.1, "worse in both")];
  assert.equal(P.judge("breakout", -1, down, rec(0.2, 0.07, hurts)).verdict, "SKIP"); // two conditions that hurt
  assert.equal(P.judge("breakout", -1, down, null).verdict, "WAIT"); // no report yet
  assert.deepEqual(P.conditionsMet(-1, down), ["BTC trend with the trade", "Daily trend with the trade"]);
});

test("A+ setups: which base signals qualify, their wider exit, and their verdict", () => {
  const f = { btc: "up", dTrend: "down", fund8h: 0.01, atrPct: 0.02 };
  assert.equal(P.aplusOf({ setup: "breakout", dir: -1 }, f), "weakshort");                       // breakdown, coin down, BTC up
  assert.equal(P.aplusOf({ setup: "breakout", dir: -1 }, { ...f, btc: "down" }), null);         // the whole market falling: not weakness of its own
  assert.equal(P.aplusOf({ setup: "breakout", dir: -1 }, { ...f, dTrend: "mixed" }), null);     // ~0R in the test without the coin's downtrend
  assert.equal(P.aplusOf({ setup: "breakout", dir: 1 }, { ...f, fund8h: -0.002 }), "squeeze");  // breakout with shorts paying
  assert.equal(P.aplusOf({ setup: "breakout", dir: 1 }, f), null);
  assert.equal(P.aplusOf({ setup: "pullback", dir: -1 }, f), null);
  assert.equal(P.exitOf("weakshort").tp, 4); assert.equal(P.exitOf("weakshort").hold, 14); assert.equal(P.exitOf("breakout").tp, 2.5);
  const rec = (o) => ({ all: { trades: 334, avgR: 0.73, winRatePct: 51 }, older: { avgR: 0.92, top3SharePct: 24 }, newer: { avgR: 0.54, top3SharePct: 35 }, ok: true, verdict: "holds", ...o });
  assert.equal(P.judgeAplus("weakshort", f, rec()).verdict, "TAKE");
  assert.equal(P.judgeAplus("weakshort", { ...f, atrPct: 0.06 }, rec()).verdict, "WAIT");               // a very volatile coin
  const thin = P.judgeAplus("squeeze", f, rec({ ok: false, verdict: "weak: positive but thin", newer: { avgR: 0.36, top3SharePct: 118 } }));
  assert.equal(thin.verdict, "WAIT"); assert.match(thin.reasons.join(" "), /most of the profit came from 3 coins/);
  assert.equal(P.judgeAplus("weakshort", f, rec({ newer: { avgR: -0.1 } })).verdict, "WAIT");           // lost money in one period
  assert.equal(P.judgeAplus("weakshort", f, null).verdict, "WAIT");                                      // no report yet
  assert.ok(P.conditionsMet(-1, { ...f, atrPct: 0.06 }).includes("Very volatile coin (4h ATR 5%+ of the price)"));
});

test("journal: a short gains when price falls; R needs the stop above the entry", async () => {
  const { tradeResult, cleanTrade } = await import("../journal.js");
  const short = { side: "short", entryPrice: 100, exitPrice: 90, stopPrice: 105, sizeUsd: 1000, feesUsd: 1 };
  const r = tradeResult(short);
  assert.equal(r.pnlUsd, 99); assert.equal(r.r, 2);
  assert.equal(tradeResult({ ...short, stopPrice: 95 }).r, null); // a stop below the entry is not a short's stop
  assert.equal(tradeResult({ ...short, side: "long" }).pnlUsd, -101);
  assert.equal(cleanTrade({ symbol: "DOT", entryPrice: 1, side: "short", tool: "perps" }).trade.side, "short");
  assert.equal(cleanTrade({ symbol: "DOT", entryPrice: 1, tool: "perps" }).trade.side, "long");
});

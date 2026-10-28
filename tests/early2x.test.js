// Unit tests for the Early 2x Movers screen: universe, features, models, score, late-entry checks, repeated signals,
// forward tracking and results. Synthetic candles only: no network, no API key. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SCREENER_LIBRARY_ONLY = "1"; // load the screener's helpers without starting it
await import("../screener.js");
const e2 = await import("../early2x.js");
const { CONFIG } = e2;

const HOUR = 3_600_000, MIN = 60_000, DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0), NOW = T0 + MIN; // last finished hour ends at T0

// n hourly candles ending at T0. fn(k) -> candle values, k = hours before the end (0 = newest).
function h1(n, fn) {
  const c = { t: [], o: [], h: [], l: [], c: [], qv: [], n: [], tb: [] };
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i, x = fn(k);
    c.t.push(T0 - (k + 1) * HOUR);
    for (const key of ["o", "h", "l", "c", "qv", "n", "tb"]) c[key].push(x[key]);
  }
  return c;
}
// last 120 five-minute candles ending at T0. fn(k) -> values, k = candles before the end.
function m5(fn) {
  const c = { t: [], o: [], h: [], l: [], c: [], qv: [], n: [], tb: [] };
  for (let i = 0; i < 120; i++) {
    const k = 119 - i, x = fn(k);
    c.t.push(T0 - (k + 1) * 5 * MIN);
    for (const key of ["o", "h", "l", "c", "qv", "n", "tb"]) c[key].push(x[key]);
  }
  return c;
}
const candle = (p, qv, buy, trades, wick = 0.003) => ({ o: p, h: p * (1 + wick), l: p * (1 - wick), c: p, qv, n: trades, tb: qv * buy });
const daily = (k) => 1 + 0.015 * Math.sin((2 * Math.PI * k) / 24); // calm daily cycle, ~3% typical daily range
const btc = h1(480, (k) => candle(100 * (1 + 0.0002 * k), 1e8, 0.5, 1e5)); // BTC drifting down slowly, not "falling"
const goodDepth = { bidUsd: 50_000, askUsd: 40_000, imbalance: 50_000 / 90_000, partial: false, at: NOW };
const goodTrades = { sample: 1000, spanMin: 30, buyShare: 55, largeMinUsd: 6000, largeCount: 20, largeBuyShare: 62 };
const tightening = [0.2, 0.2, 0.19, 0.2, 0.21, 0.2, 0.12, 0.11, 0.1, 0.11, 0.1, 0.1];

// Model A: last 24h at 2.5x volume and 1.7x trades, buyers 54-58% (rising CVD), price flat.
// spike=true puts the 7-day high 15% above price (a quiet base, not near a breakout).
function quietInput({ spike = true, ...over } = {}) {
  const price = (k) => (spike && k >= 100 && k <= 104 ? 1.15 : daily(k));
  const hrs = h1(480, (k) => k < 24 ? candle(price(k), 25_000, k < 12 ? 0.58 : 0.54, 170) : candle(price(k), 10_000, 0.5, 100));
  const fives = m5((k) => candle(1, 25_000 / 12, 0.56, 14));
  return {
    base: "TEST", price: 1, quoteVolume24h: 2e6, h1: hrs, m5: fives, btcH1: btc, spreadPct: 0.1, spreadHist: tightening, depth: goodDepth, trades: goodTrades,
    mcap: { value: 40e6, source: "Binance circulating supply x price", cgValue: 41e6 }, supply: { circulatingShare: 0.9 },
    events: { unlocks: [], unlockCheck: { verified: true, time: NOW - 2 * DAY, source: "https://example.org/unlocks" }, catalysts: [] },
    info: { name: "Test", tags: [] }, now: NOW, ...over,
  };
}
const run = (x, cfg = CONFIG) => { const f = e2.computeFeatures(x, cfg); return { f, ev: e2.evaluate(f, cfg, NOW) }; };

test("universe: stablecoins, wrapped tokens, tokenized stocks and leveraged tokens are left out", () => {
  const listed = new Set(["BTC", "BTCUP", "JUP", "PEPE"]);
  assert.equal(e2.exclusionReason("USDC", null, listed), "stablecoin");
  assert.equal(e2.exclusionReason("WBTC", null, listed), "wrapped");
  assert.equal(e2.exclusionReason("JITOSOL", null, listed), "wrapped");
  assert.equal(e2.exclusionReason("TSLA", { name: "Tesla (bStocks)", tags: ["bStocks"] }, listed), "tokenized stock / commodity");
  assert.equal(e2.exclusionReason("BTCUP", null, listed), "leveraged token");
  assert.equal(e2.exclusionReason("JUP", { name: "Jupiter", tags: [] }, listed), null); // ends in "UP", not leveraged
  assert.equal(e2.exclusionReason("PEPE", { name: "Pepe", tags: ["Meme"] }, listed), null);
});

test("Model A: quiet accumulation is found, with 4+ independent confirmations and high priority", () => {
  const { f, ev } = run(quietInput());
  assert.ok(f.vol.ratio24 > 2.4 && f.vol.ratio24 < 2.6, `ratio24 ${f.vol.ratio24}`);
  assert.ok(f.flow.buyDelta > 5 && f.flow.cvdAccel);
  assert.equal(ev.models.A.pass, true, JSON.stringify(ev.models.A));
  assert.equal(ev.state, "quiet", JSON.stringify({ late: ev.late, fam: ev.families.map((x) => [x.key, x.ok]) }));
  assert.equal(ev.priority, "high", JSON.stringify({ score: ev.score, mand: ev.mandatory }));
  assert.ok(ev.confirmations >= 4, JSON.stringify(ev.families.map((x) => [x.key, x.ok])));
  assert.deepEqual(ev.late, []);
});

test("Pre-breakout: the same accumulation pressing a tested 7-day high", () => {
  const { f, ev } = run(quietInput({ spike: false }));
  assert.ok(f.structure.distToHighPct > 0 && f.structure.distToHighPct <= CONFIG.nearBreakoutPct, `dist ${f.structure.distToHighPct}`);
  assert.ok(f.structure.tests >= 2);
  assert.equal(ev.state, "prebreakout");
});

test("Model B: accelerating 5m volume with executed buying is an early ignition", () => {
  const hrs = h1(480, (k) => candle(daily(k), 10_000, 0.5, 100));
  const fives = m5((k) => k < 3 ? { ...candle(1 + 0.004 * (3 - k), 2600 + 300 * (3 - k), 0.62, 30), o: 1 + 0.004 * (2 - k) } : candle(1, 10_000 / 12, 0.5, 8));
  const { f, ev } = run(quietInput({ h1: hrs, m5: fives, price: 1.012 }));
  assert.equal(f.m5.consec, 3);
  assert.equal(f.m5.accel, true);
  assert.ok(f.m5.buy15 >= 60 && f.m5.ret15 > 0);
  assert.equal(ev.models.A.pass, false); // 24h volume is normal: not model A
  assert.equal(ev.models.B.pass, true, JSON.stringify(ev.models.B));
  assert.equal(ev.state, "ignition");
});

test("late entries: a coin up 40% in a day is 'already moved', with the reason; momentum alone is not rejected", () => {
  const ran = h1(480, (k) => candle(k < 24 ? 1 + 0.4 * (24 - k) / 24 : daily(k), k < 24 ? 40_000 : 10_000, 0.6, 200));
  const { f, ev } = run(quietInput({ h1: ran, price: 1.4 }));
  assert.equal(ev.state, "moved");
  assert.ok(ev.late.some((x) => x.key === "ext24" && x.severity === "reject" && /up 40/.test(x.why)), JSON.stringify(ev.late));
  assert.equal(ev.priority, null);
  // +6% in 24h on a coin that moves ~3% a day is still within its volatility-aware limits
  const mild = h1(480, (k) => candle(k < 24 ? 1 + 0.06 * (24 - k) / 24 : daily(k), k < 24 ? 25_000 : 10_000, 0.56, 170));
  const r2 = run(quietInput({ h1: mild, price: 1.06 }));
  assert.ok(!r2.ev.late.some((x) => x.severity === "reject"), JSON.stringify(r2.ev.late));
  assert.ok(f.limits.ext24 >= CONFIG.ext24MinPct);
});

test("score: transparent breakdown, missing data never earns points, total = points / weights", () => {
  const { ev } = run(quietInput());
  let got = 0, max = 0;
  for (const c of Object.values(ev.components)) {
    const s = c.rules.reduce((a, x) => a + x.points, 0);
    assert.ok(Math.abs(s - c.points) < 0.11, `${c.label}: ${s} vs ${c.points}`);
    for (const x of c.rules) { assert.ok(x.points >= 0 && x.points <= x.max); assert.ok(typeof x.value === "string"); }
    got += c.points; max += c.max;
  }
  assert.equal(max, 100);
  assert.ok(Math.abs(Math.round((got / max) * 100) - ev.score) <= 1);
  // the same coin with no order book, trades, market cap, supply or unlock data
  const gaps = run(quietInput({ depth: null, trades: null, mcap: null, supply: null, events: undefined }));
  const rulesOf = (ev2) => Object.values(ev2.components).flatMap((c) => c.rules);
  for (const label of ["Depth within +-2% (smaller side)", "Order book within +-2%: bid share", "Large trades (top 2% by size): share bought",
    "Market cap source", "Circulating share of max (or total) supply", "Token unlocks in the next 30 days (verified)"]) {
    const x = rulesOf(gaps.ev).find((y) => y.rule === label);
    assert.equal(x.points, 0, label);
    assert.equal(x.value === "missing" || x.value === "not checked", true, `${label}: ${x.value}`);
  }
  assert.ok(gaps.ev.score < ev.score);
  assert.equal(gaps.ev.priority, "watch"); // liquidity and market cap cannot be verified
  assert.ok(gaps.ev.missing.some((m) => /order book/.test(m)) && gaps.ev.missing.some((m) => /market cap/.test(m)), JSON.stringify(gaps.ev.missing));
});

test("supply risk and unverified market caps block high priority, with the reason", () => {
  const low = run(quietInput({ supply: { circulatingShare: 0.3 } }));
  assert.equal(low.ev.state, "quiet");
  assert.equal(low.ev.priority, "watch");
  assert.ok(low.ev.flags.some((x) => /30% of max supply/.test(x)), JSON.stringify(low.ev.flags));
  const off = run(quietInput({ mcap: { value: 40e6, source: "Binance circulating supply x price", cgValue: 120e6 } }));
  assert.equal(off.ev.priority, "watch");
  assert.ok(off.ev.missing.some((m) => /not verified: Binance \$40.0M vs CoinGecko \$120.0M/.test(m)), JSON.stringify(off.ev.missing));
  const rule = Object.values(off.ev.components).flatMap((c) => c.rules).find((x) => x.rule === "Market cap source");
  assert.equal(rule.points, 0);
});

test("data gaps: too little history gives no state and says why", () => {
  const short = h1(5 * 24, (k) => candle(daily(k), 10_000, 0.5, 100));
  const { ev } = run(quietInput({ h1: short }));
  assert.equal(ev.state, null);
  assert.ok(ev.missing.some((m) => /price history/.test(m)), JSON.stringify(ev.missing));
  assert.equal(Object.values(ev.components).filter((c) => c.label !== e2.COMPONENT_LABELS.data).every((c) => c.points === 0), true);
});

test("correlated indicators count once: buy share, CVD and large-trade buying are one confirmation", () => {
  const base = run(quietInput());
  const hrs = h1(480, (k) => (k >= 100 && k <= 104 ? candle(1.15, 10_000, 0.5, 100) : candle(daily(k), k < 24 ? 25_000 : 10_000, k < 24 ? 0.47 : 0.5, k < 24 ? 170 : 100)));
  const weak = run(quietInput({ h1: hrs, trades: { ...goodTrades, largeBuyShare: 40 } }));
  assert.equal(base.ev.families.find((x) => x.key === "buying").ok, true);
  assert.equal(weak.ev.families.find((x) => x.key === "buying").ok, false);
  assert.equal(base.ev.confirmations - weak.ev.confirmations, 1); // three indicators changed, one family
  assert.equal(new Set(base.ev.families.map((x) => x.key)).size, base.ev.families.length);
  assert.ok(base.ev.families.length <= 5);
});

test("weights are configurable and the total is normalized to 100", () => {
  const cfg = { ...CONFIG, weights: { ...CONFIG.weights, tokenomics: 0, volume: 40 } };
  const { ev } = run(quietInput(), cfg);
  assert.equal(ev.components.tokenomics.max, 0);
  assert.equal(ev.components.tokenomics.points, 0);
  assert.equal(ev.components.volume.max, 40);
  const got = Object.values(ev.components).reduce((a, c) => a + c.points, 0), max = Object.values(ev.components).reduce((a, c) => a + c.max, 0);
  assert.ok(Math.abs(Math.round((got / max) * 100) - ev.score) <= 1);
});

test("repeated signals: one snapshot per coin per cooldown, upgrades saved, repeats and downgrades not", () => {
  const cd = CONFIG.cooldownHours * HOUR;
  assert.equal(e2.snapshotDecision(undefined, "quiet", "watch", NOW), true);
  const prev = { main: { at: NOW, rank: e2.rankOf("quiet", "watch"), state: "quiet" } };
  assert.equal(e2.snapshotDecision(prev, "quiet", "watch", NOW + HOUR), false);        // same again
  assert.equal(e2.snapshotDecision(prev, "quiet", "high", NOW + HOUR), true);          // watch -> high
  assert.equal(e2.snapshotDecision(prev, "ignition", "watch", NOW + HOUR), true);      // quiet -> ignition
  const hi = { main: { at: NOW, rank: e2.rankOf("ignition", "high"), state: "ignition" } };
  assert.equal(e2.snapshotDecision(hi, "prebreakout", "high", NOW + HOUR), false);     // downgrade
  assert.equal(e2.snapshotDecision(hi, "quiet", "watch", NOW + cd), true);             // after the cooldown
  assert.equal(e2.snapshotDecision(hi, "moved", null, NOW + HOUR), true);              // own cooldown
  const mv = { ...hi, moved: { at: NOW, rank: 0, state: "moved" } };
  assert.equal(e2.snapshotDecision(mv, "moved", null, NOW + 24 * HOUR), false);
  assert.equal(e2.snapshotDecision(mv, null, null, NOW + 24 * HOUR), false);
});

test("tracking: stop and target in the same bar count the stop first unless finer bars settle it", () => {
  const at = T0, entry = 1;
  const bar = { t: at, dur: HOUR, o: 1, h: 1.3, l: 0.75, c: 1.1 }; // touched -25% stop and +25% target
  const tr = e2.newTrack(entry, at);
  assert.equal(e2.needsRefine(tr, bar), true);
  e2.advanceTrack(tr, [bar]);
  assert.ok(tr.stop.hitAt);
  assert.equal(tr.targets[25].beforeStop, false);
  assert.equal(tr.ambiguous, 1);
  // 1-minute bars show the target came first, the stop later
  const tr2 = e2.newTrack(entry, at);
  const fine = [{ t: at, dur: MIN, o: 1, h: 1.28, l: 0.99, c: 1.2 }, { t: at + MIN, dur: MIN, o: 1.2, h: 1.21, l: 0.76, c: 0.8 }];
  e2.advanceTrack(tr2, fine);
  assert.equal(tr2.targets[25].beforeStop, true);
  assert.equal(tr2.targets[25].hours, 0.02); // one minute after the signal
  assert.ok(tr2.stop.hitAt > tr2.targets[25].hitAt);
  assert.equal(tr2.ambiguous, 0);
  // the reverse order: stop first, target never "before stop"
  const tr3 = e2.newTrack(entry, at);
  e2.advanceTrack(tr3, [{ t: at, dur: MIN, o: 1, h: 1.01, l: 0.75, c: 0.8 }, { t: at + MIN, dur: MIN, o: 0.8, h: 1.3, l: 0.8, c: 1.2 }]);
  assert.equal(tr3.targets[25].beforeStop, false);
});

test("tracking: no look-ahead, horizons, excursions and drawdown before the target", () => {
  const at = T0 + 2 * MIN, entry = 1;
  const tr = e2.newTrack(entry, at);
  const bars = [{ t: T0, dur: 5 * MIN, o: 1, h: 9, l: 0.1, c: 1 }]; // started before the signal: ignored
  for (let i = 1; i <= 300; i++) { const p = 1 + 0.001 * i; bars.push({ t: T0 + i * 5 * MIN, dur: 5 * MIN, o: p, h: p * 1.002, l: i === 10 ? 0.9 : p * 0.998, c: p }); }
  e2.advanceTrack(tr, bars);
  assert.ok(tr.hi < 2, "the pre-signal bar must not count");
  for (const k of ["1h", "6h", "12h", "24h"]) assert.ok(tr.horizons[k], k);
  assert.equal(tr.horizons["3d"], undefined);
  assert.ok(Math.abs(tr.horizons["1h"].ret - 1.1) < 0.2, JSON.stringify(tr.horizons["1h"])); // ~11 bars of +0.1%
  assert.equal(tr.horizons["6h"].mae, -10);
  assert.ok(tr.targets[25].hours > 20 && tr.targets[25].drawdownBeforePct === -10, JSON.stringify(tr.targets[25]));
  // a coin that stops trading keeps its last price in the results (no survivorship bias)
  e2.endTrack(tr);
  assert.ok(tr.horizons["42d"].dataEnded && tr.done && tr.dataEnded);
});

test("results: costs subtracted, false positives counted, no verdict without enough evidence", () => {
  const mk = (i, ret, hit25) => {
    const tr = e2.newTrack(1, T0 - (60 - i) * DAY);
    for (const [k] of e2.HORIZONS) tr.horizons[k] = { ret, mfe: Math.max(ret, 0), mae: -5, at: 0 };
    if (hit25) tr.targets[25] = { hitAt: tr.at + DAY, hours: 24, drawdownBeforePct: -4, beforeStop: true };
    tr.done = true;
    return { id: `S${i}`, at: tr.at, state: "quiet", priority: "high", score: 60, mcapBand: "$10M-$50M", track: tr };
  };
  const few = e2.computeResults([mk(1, 10, true), mk(2, -10, false)], CONFIG, T0);
  assert.match(few.verdict, /Not enough evidence/);
  assert.equal(few.all.horizons.find((h) => h.horizon === "14d").avgNetPct, -(CONFIG.feePct + CONFIG.slippagePct));
  assert.equal(few.all.falsePositives.count, 1);
  const many = e2.computeResults(Array.from({ length: 40 }, (_, i) => mk(i, i % 2 ? 8 : -2, i % 2 === 1)), CONFIG, T0);
  assert.doesNotMatch(many.verdict, /Not enough evidence/);
  assert.equal(many.chronological.earlier.signals + many.chronological.later.signals, 40);
  assert.equal(many.all.targets[0]["14d"].hitPct, 50);
  assert.equal(many.byMcap["$10M-$50M"].signals, 40);
});

test("snapshots are immutable and the state file is versioned", () => {
  const s = e2.freezeSnapshot({ id: "X", features: { ratio24: 2 } });
  assert.throws(() => { s.score = 99; }, TypeError);
  assert.throws(() => { s.features.ratio24 = 5; }, TypeError);
  assert.deepEqual(e2.migrateStore(null).signals, []);
  assert.equal(e2.migrateStore({ version: 1, signals: [{ id: "a" }] }).signals.length, 1);
  assert.throws(() => e2.migrateStore({ version: 99 }), /newer/);
});

test("large trades: aggressor side read from Binance's buyer-is-maker flag", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ p: "1", q: "100", m: true, T: T0 + i * 1000 })) // small sells
    .concat([{ p: "1", q: "20000", m: false, T: T0 + 61_000 }, { p: "1", q: "15000", m: false, T: T0 + 62_000 }]); // big buys
  const s = e2.largeTradeStats(rows);
  assert.equal(s.largeBuyShare, 100);
  assert.ok(s.buyShare > 80);
  assert.equal(e2.largeTradeStats(rows.slice(0, 10)), null); // too few trades to judge
});

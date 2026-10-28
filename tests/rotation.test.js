// BTC rotation: alt season meter, regime statistics, narrative stages and the forward record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { altState, regimeStats, narrativeStage, analyze, demoHistory, makeDecision, evaluateDecision, recordSummary } from "../rotation.js";

test("alt season meter: two or more votes the same way decide it", () => {
  assert.equal(altState({ ethTrend: 1, altVsBtc30: 5, breadthPct: 60 }), "altsLead");
  assert.equal(altState({ ethTrend: 1, altVsBtc30: 3, breadthPct: 45 }), "altsLead");
  assert.equal(altState({ ethTrend: -1, altVsBtc30: -5, breadthPct: 20 }), "btcLeads");
  assert.equal(altState({ ethTrend: 1, altVsBtc30: -5, breadthPct: 45 }), "mixed");
  assert.equal(altState({ ethTrend: 0, altVsBtc30: null, breadthPct: 30 }), "mixed"); // missing values vote 0
  assert.equal(altState(null), null);
});

test("regime statistics: run lengths, what came next, where it was H days later", () => {
  const R = ["up", "up", "up", "range", "range", "up", "up", "up", "up", "down", "down", "down"];
  const s = regimeStats([null, ...R], 2);
  assert.equal(s.now, "down");
  assert.equal(s.ageDays, 3);
  assert.equal(s.medianDays.up, 4);       // finished runs of 3 and 4 days -> median of the sorted pair picks the upper one
  assert.equal(s.medianDays.range, 2);
  assert.equal(s.medianDays.down, null);  // the current run is not finished yet
  assert.deepEqual(s.transitions.up, { range: 50, down: 50 });
  assert.deepEqual(s.transitions.range, { up: 100 });
  assert.equal(s.samples, 1);             // only the first "down" day has a day 2 days later
  assert.deepEqual(s.in2Days, { down: 100 });
});

test("narrative stage", () => {
  assert.equal(narrativeStage({ breadthPct: 80, breadthPrevPct: 70, atHighsPct: 75, flow: 1.2, mom14: 12 }), "late");
  assert.equal(narrativeStage({ breadthPct: 50, breadthPrevPct: 60, atHighsPct: 20, flow: 0.8, mom14: 15 }), "late"); // money leaving a strong run
  assert.equal(narrativeStage({ breadthPct: 30, breadthPrevPct: 55, atHighsPct: 5, flow: 0.9, mom14: -4 }), "cooling");
  assert.equal(narrativeStage({ breadthPct: 60, breadthPrevPct: 35, atHighsPct: 20, flow: 1.3, mom14: 3 }), "early");
  assert.equal(narrativeStage({ breadthPct: 60, breadthPrevPct: 35, atHighsPct: 30, flow: 0.7, mom14: 3 }), "running"); // volume not following
  assert.equal(narrativeStage({ breadthPct: 60, breadthPrevPct: 35, atHighsPct: 20, flow: 0.7, mom14: 3 }), "quiet");
  assert.equal(narrativeStage({ breadthPct: 40, breadthPrevPct: 38, atHighsPct: 10, flow: 1, mom14: 1 }), "quiet");
});

test("analyze: alt season meter, regime stats, money flow, stages, both halves of every strategy", () => {
  const data = demoHistory(900, []);
  const r = analyze(data, { holdDays: 7, feePct: 0.2 });
  assert.ok(["altsLead", "mixed", "btcLeads"].includes(r.altSeason.state));
  assert.equal(r.altSeason.hasEth, true);
  assert.equal(r.altSeason.history.length, 120);
  assert.equal(r.regimeStats.now, r.regimeNow.key);
  assert.ok(r.regimeStats.ageDays >= 1);
  const sum = r.ranking.reduce((a, x) => a + (x.volShare7Pct || 0), 0);
  assert.ok(sum >= 99, `volume shares cover all altcoin volume, got ${sum}`); // a coin in two narratives counts in both
  for (const x of r.ranking) assert.ok(["early", "running", "late", "cooling", "quiet"].includes(x.stage));
  for (const k of ["combined", "combinedAlt", "combinedFlow", "tokens", "tokensAlt"]) {
    const s = r.backtest.strategies.find((y) => y.key === k);
    assert.ok(s && Number.isFinite(s.olderPct) && Number.isFinite(s.newerPct), k);
    const total = ((1 + s.olderPct / 100) * (1 + s.newerPct / 100) - 1) * 100;
    assert.ok(Math.abs(total - s.totalPct) < 0.5, `${k}: halves compound to the total`);
  }
  assert.ok(Array.isArray(r.holdingsNow.combinedAlt));
  if (r.altSeason.state === "btcLeads" && !r.regimeNow.riskOff) assert.deepEqual(r.holdingsNow.combinedAlt, ["BTC"]);
  // the same analysis without ETH still works (the ETH vote counts as 0)
  const r2 = analyze({ ...data, eth: null }, { holdDays: 7 });
  assert.equal(r2.altSeason.hasEth, false);
  assert.equal(r2.altSeason.ethTrend, 0);
});

test("forward record: decision with entry prices, judged with later prices, delisted coins keep their last price", async () => {
  const DAY = 86_400_000, t0 = Date.UTC(2026, 0, 1), n = 3;
  const data = { t0, n, btc: Float64Array.from([90, 95, 100]), narratives: [
    { name: "AI", members: [{ base: "FET", close: Float64Array.from([1, 1, 2]) }, { base: "TAO", close: Float64Array.from([1, 1, 4]) }] },
    { name: "Meme", members: [{ base: "DOGE", close: Float64Array.from([1, 1, 10]) }, { base: "DEAD", close: Float64Array.from([1, 1, NaN]) }] },
  ] };
  const result = { regimeNow: { key: "up" }, altSeason: { state: "mixed" }, holdingsNow: { combined: ["AI", "Meme"], tokens: ["TAO", "DOGE"] } };
  const d = makeDecision(result, data, 7);
  assert.equal(d.date, "2026-01-03");
  assert.equal(d.exitT, t0 + 2 * DAY + 7 * DAY);
  assert.equal(d.btc, 100);
  assert.deepEqual(d.narratives.map((x) => [x.name, x.members.map((m) => m.base)]), [["AI", ["FET", "TAO"]], ["Meme", ["DOGE"]]]); // no price today -> not bought
  assert.deepEqual(d.tokens, [{ base: "TAO", close: 4 }, { base: "DOGE", close: 10 }]);
  const exit = { BTC: 110, FET: 3, TAO: 2, DOGE: 15 };
  const res = await evaluateDecision(d, async (b, t) => { assert.equal(t, d.exitT); return exit[b] ?? null; }, 0.2);
  assert.equal(res.btcPct, 10);
  assert.deepEqual(res.narrativePcts, [0, 50]);   // AI: (+50% − 50%) / 2, Meme: +50%
  assert.equal(res.combinedPct, 24.8);            // (0 + 50) / 2 − 0.2 fee
  assert.equal(res.tokensPct, -0.2);              // (−50% + 50%) / 2 − 0.2
  const noCoins = makeDecision({ ...result, holdingsNow: { combined: ["AI"], tokens: ["BTC"] } }, data, 7); // no coin scored 65+: the token rule holds BTC
  assert.equal((await evaluateDecision(noCoins, async (b) => exit[b])).tokensPct, 10);
  const cash = makeDecision({ ...result, holdingsNow: { combined: ["Cash (USDT)"], tokens: ["Cash (USDT)"] } }, data, 7);
  assert.equal(cash.cash, true);
  assert.deepEqual((await evaluateDecision(cash, async (b) => exit[b])).combinedPct, 0);
  const s = recordSummary([{ result: res }, { result: { combinedPct: -10, tokensPct: 0, btcPct: 0 } }, { result: null }]);
  assert.equal(s.weeks, 2);
  assert.equal(s.combinedPct, 12.3);              // 1.248 × 0.9 − 1
  assert.equal(s.btcPct, 10);
  assert.equal(s.beatBtcPct, 50);
});

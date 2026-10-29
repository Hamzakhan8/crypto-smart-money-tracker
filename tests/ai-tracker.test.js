// AI call tracker (ai-tracker.js): every AI answer followed with its own plan, the scorecard, the committee's own record
// for its prompts, WAIT triggers and the daily request limit. Fake candles and a fake clock; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { callFromResult, applyBars, scorecard, trackRecord, cleanTrigger, triggerHit, createAiTracker } from "../ai-tracker.js";

const MIN = 60_000, HOUR = 3_600_000, T0 = Date.parse("2026-10-29T10:00:30Z");
// A committee result as runCommittee / analyzeOne return it (only the fields the tracker reads).
const result = (o = {}) => ({
  symbol: "ABCUSDT", tier: "confirmed", decision: "TAKE", final: "YES", modelDecision: "TAKE", headline: "Clean breakout", probTargetPct: 40, probStopPct: 30, expectedValuePct: 1.2,
  plan: { stopPct: -3, target1Pct: 6, holdHours: 12 }, dossier: { price: 100, alert: { costPct: 0.3, trackedAs: { holdHours: 12 } }, dataQuality: { demo: false } },
  committee: { data: { available: true, dataQuality: { rating: "good" } }, news: { available: true, riskLevel: "low", hardStop: false },
    debate: { off: false, bull: { available: true, strength: 7 }, bear: { available: true, strength: 4, path: "fades under 97" }, verdict: { winner: "bull" } },
    trader: { decision: "TAKE" }, boss: { asked: true, available: true, verdict: "YES", agreesWithTrader: true, summary: "all tests pass" } },
  ...o,
});
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
const minute = (i) => Math.ceil(T0 / MIN) * MIN + i * MIN; // the i-th full minute after the call

test("tracker: an AI answer becomes a call with its own plan; simulated data and answers without a plan are left out", () => {
  const c = callFromResult(result(), { source: "alert", at: T0 });
  assert.equal(c.entry, 100); assert.equal(c.stopPx, 97); assert.equal(c.targetPx, 106); assert.equal(c.costPct, 0.3); assert.equal(c.holdHours, 12);
  assert.deepEqual([c.final, c.trader, c.boss, c.debate.winner, c.debate.bearPath, c.news, c.data, c.source], ["YES", "TAKE", "YES", "bull", "fades under 97", "low", "good", "alert"]);
  assert.equal(callFromResult(result({ dossier: { price: 100, dataQuality: { demo: true } } })), null);
  assert.equal(callFromResult(result({ plan: { stopPct: 2, target1Pct: 6 } })), null);
  assert.equal(callFromResult({ ...result(), committee: undefined }), null); // a batch triage row has no committee
  const noBoss = callFromResult(result({ decision: "WAIT", final: "NO", committee: { ...result().committee, boss: { asked: false } } }), { at: T0 });
  assert.equal(noBoss.boss, null); assert.equal(noBoss.final, "NO");
});

test("tracker: target, stop (checked first), gaps, the end of the holding time, missing data", () => {
  const c = () => callFromResult(result(), { at: T0 });
  const win = c();
  assert.equal(applyBars(win, [bar(minute(-1), 100, 120, 80, 100), bar(minute(0), 100, 103, 99, 102), bar(minute(1), 102, 106.5, 101, 106)], MIN, minute(5)), true);
  assert.deepEqual([win.track.status, win.track.exitPct, win.track.netPct], ["win", 6, 5.7]); // the candle before the call is ignored
  const both = c();
  applyBars(both, [bar(minute(0), 100, 107, 96, 101)], MIN, minute(5));
  assert.deepEqual([both.track.status, both.track.netPct], ["loss", -3.3]); // touched both: counted as the stop
  const gap = c();
  applyBars(gap, [bar(minute(0), 95, 95.5, 94, 95)], MIN, minute(5));
  assert.equal(gap.track.exitPct, -5); // opened below the stop: out at the open
  const unfinished = c();
  assert.equal(applyBars(unfinished, [bar(minute(0), 100, 110, 99, 109)], MIN, minute(0) + 30_000), false); // still forming
  // the holding time ends: closes at the last price once every candle is in
  const flat = c(), end = T0 + 12 * HOUR, bars = [];
  for (let t = minute(0); t < end; t += MIN) bars.push(bar(t, 100, 101, 99.5, 100.8));
  applyBars(flat, bars.slice(0, 100), MIN, end + 2 * MIN);
  assert.equal(flat.track.status, "open"); // only part of the window applied so far
  applyBars(flat, bars, MIN, end + 2 * MIN);
  assert.deepEqual([flat.track.status, flat.track.exitPct, flat.track.netPct], ["timeout", 0.8, 0.5]);
  const gone = c();
  assert.equal(applyBars(gone, [], MIN, end + HOUR), false);
  applyBars(gone, [], MIN, end + 7 * HOUR);
  assert.equal(gone.track.status, "nodata");
});

const resolved = (o, status, netPct, at = T0) => { const c = callFromResult(result(o), { at }); c.track = { ...c.track, status, netPct }; return c; };
test("tracker: the scorecard compares YES with WATCH / NO (if bought anyway), the boss's overturns, the debate and the stated chances", () => {
  const boss = (verdict, agrees) => ({ ...result().committee, boss: { asked: true, available: true, verdict, agreesWithTrader: agrees, summary: "s" } });
  const watch = { decision: "WAIT", final: "WATCH", committee: boss("WATCH", false) }; // the trader said TAKE, the boss WATCH
  const blocked = { decision: "SKIP", final: "NO", committee: boss("NO", false) };
  const upgraded = { committee: { ...boss("YES", false), trader: { decision: "WAIT" } } };
  const calls = [resolved({}, "win", 5.7), resolved({}, "loss", -3.3), resolved(upgraded, "win", 5.7), resolved(watch, "loss", -3.3), resolved(blocked, "loss", -3.3),
    callFromResult(result(), { at: T0 })]; // one still open
  const sc = scorecard(calls);
  assert.equal(sc.total, 6); assert.equal(sc.open, 1); assert.equal(sc.resolved, 5);
  const g = (s, k) => sc.groups.find((x) => x.section === s && x.key === k);
  assert.deepEqual([g("final", "yes").n, g("final", "yes").hitTargetPct, g("final", "yes").avgNetPct], [3, 67, 2.7]);
  assert.deepEqual([g("final", "watch").n, g("final", "no").n, sc.notYes.n, sc.notYes.avgNetPct], [1, 1, 2, -3.3]);
  assert.equal(sc.edgePct, 6); // 2.7 - (-3.3)
  assert.equal(g("boss", "blocked").n, 2); assert.equal(g("boss", "upgraded").n, 1); assert.equal(g("boss", "overturned").n, 3); assert.equal(g("debate", "bull").n, 5);
  assert.deepEqual(sc.calibration, [{ band: "40%+", n: 5, saidPct: 40, hitPct: 40 }]);
});

test("tracker: the committee's own record is for the same tier only; with fewer than 5: no track record for this tier", () => {
  assert.equal(trackRecord([resolved({}, "win", 5.7)], "spot", T0, "confirmed").note, "no track record for this tier");
  const calls = [...Array.from({ length: 4 }, (_, i) => resolved({}, "loss", -3.3, T0 + i * HOUR)), resolved({}, "win", 5.7),
    ...Array.from({ length: 5 }, () => resolved({ decision: "SKIP", final: "NO", committee: { ...result().committee, trader: { decision: "SKIP" } } }, "win", 5.7)),
    ...Array.from({ length: 6 }, () => resolved({ tier: "early" }, "win", 5.7))]; // another tier: never mixed in
  const tr = trackRecord(calls, "spot", T0 + 2 * 86_400_000, "confirmed");
  assert.equal(tr.resolved, 10); assert.equal(tr.scope, "spot calls, tier confirmed");
  assert.deepEqual(tr.finalYes, { n: 5, hitTargetPct: 20, hitStopPct: 80, avgNetPct: -1.5 });
  assert.equal(tr.finalNoIfBought.avgNetPct, 5.7); assert.equal(tr.edgeYesMinusNoPct, -7.2);
  assert.equal(tr.bossStoppedTakes, null); // fewer than 5
  assert.equal(tr.recentLosingYes.length, 3); assert.equal(tr.recentLosingYes[0].bearHadSaid, "fades under 97");
  assert.equal(tr.recentLosingYes[0].daysAgo, 1.9);
  assert.equal(trackRecord(calls, "spot", T0, "early").resolved, 6);
  assert.equal(trackRecord(calls, "spot", T0, "none").note, "no track record for this tier");
  assert.equal(trackRecord(calls, "alpha", T0, "confirmed").note, "no track record for this tier");
});

test("tracker: WAIT triggers are cleaned and detected only after they were armed", () => {
  assert.deepEqual(cleanTrigger({ event: "breakout", price: 102, timeframe: "15m", expiresMinutes: 45 }, 100), { event: "breakout", price: 102, timeframe: "15m", expiresMinutes: 45, distPct: 2 });
  assert.equal(cleanTrigger({ event: "breakout", price: 99, timeframe: "5m", expiresMinutes: 30 }, 100), null); // a breakout must be above
  assert.equal(cleanTrigger({ event: "pullback", price: 85, timeframe: "5m", expiresMinutes: 30 }, 100), null); // more than 10% away
  assert.equal(cleanTrigger({ event: "pullback", price: 98, timeframe: "4h", expiresMinutes: 5000 }, 100).expiresMinutes, 1440);
  assert.equal(cleanTrigger({ event: "pullback", price: 98, timeframe: "4h" }, 100).timeframe, "5m");
  assert.equal(cleanTrigger(null, 100), null); assert.equal(cleanTrigger({ event: "moon", price: 101 }, 100), null);
  const armedAt = Date.parse("2026-10-29T10:02:00Z"), five = 5 * MIN, b0 = Date.parse("2026-10-29T10:00:00Z");
  const br = { event: "breakout", price: 102, armedAt };
  assert.equal(triggerHit(br, [bar(b0 - five, 100, 103, 99, 102.5)], five, b0 + 20 * MIN), null); // closed before arming
  assert.deepEqual(triggerHit(br, [bar(b0, 100, 103, 99, 102.5)], five, b0 + 20 * MIN), { at: b0 + five, price: 102.5 });
  assert.equal(triggerHit(br, [bar(b0, 100, 103, 99, 102.5)], five, b0 + 4 * MIN), null); // not closed yet
  const pb = { event: "pullback", price: 98, armedAt };
  assert.equal(triggerHit(pb, [bar(armedAt - MIN, 99, 99, 97, 98.5)], MIN, armedAt + 10 * MIN), null);
  assert.deepEqual(triggerHit(pb, [bar(armedAt + MIN, 99, 99, 97.9, 98.5)], MIN, armedAt + 10 * MIN), { at: armedAt + 2 * MIN, price: 98 });
});

test("tracker store: records (no doubles within 30 minutes), watches WAIT triggers, re-checks on a hit, follows calls", async () => {
  let now = T0;
  const feed = new Map(); // symbol -> bars
  const hits = [];
  const tk = createAiTracker({ now: () => now, bars: async (x, { interval }) => ({ bars: feed.get(`${x.symbol}:${interval}`) || [], barMs: { "1m": MIN, "5m": 5 * MIN }[interval] }),
    onTriggerHit: async (tr) => { hits.push(tr); return { checked: true, decision: "TAKE", final: "YES", headline: "breakout confirmed" }; } });
  const wait = result({ decision: "WAIT", final: "NO", waitFor: "a 5m close above 101 within 30 minutes",
    trigger: { event: "breakout", price: 101, timeframe: "5m", expiresMinutes: 30, distPct: 1 } });
  const first = tk.record(wait);
  assert.ok(first.call && first.trigger); assert.equal(first.trigger.expiresAt, T0 + 30 * MIN);
  now += 10 * MIN;
  const again = tk.record(wait); // the same coin 10 minutes later: same call, the newer trigger replaces the old one
  assert.equal(again.call.id, first.call.id); assert.equal(tk._state.calls.length, 1);
  assert.equal(tk.view().triggers.armed.length, 1); assert.equal(first.trigger.status, "replaced");
  assert.equal(tk.record(wait, { source: "trigger", depth: 2 }).trigger, null); // re-checks of re-checks are not watched again
  assert.equal(tk._state.calls.length, 2); // a trigger re-check is always recorded
  // no candle above 101 yet
  assert.deepEqual(await tk.checkTriggers(), []);
  const armed = tk.view().triggers.armed[0], b = Math.floor(armed.armedAt / (5 * MIN)) * 5 * MIN;
  feed.set("ABCUSDT:5m", [bar(b, 100.2, 101.4, 100, 101.3)]);
  now = b + 5 * MIN + 30_000;
  const got = await tk.checkTriggers();
  assert.equal(got.length, 1); assert.equal(hits[0].symbol, "ABCUSDT"); assert.equal(hits[0].hitPrice, 101.3);
  assert.deepEqual(tk.view().triggers.past[0].result, { checked: true, decision: "TAKE", final: "YES", headline: "breakout confirmed" });
  // an unwatched coin's trigger expires; a cancelled one stops
  const other = tk.record(result({ symbol: "XYZUSDT", decision: "WAIT", final: "NO", trigger: { event: "pullback", price: 99, timeframe: "5m", expiresMinutes: 10, distPct: -1 } }));
  assert.equal(tk.cancel(other.trigger.id), true); assert.equal(tk.cancel(other.trigger.id), false);
  // following a call: the first one runs to its target
  const call = tk._state.calls[0], m0 = Math.ceil(call.at / MIN) * MIN;
  feed.set("ABCUSDT:1m", [bar(m0, 100, 102, 99.5, 101.8), bar(m0 + MIN, 101.8, 106.2, 101.5, 106)]);
  now = m0 + 10 * MIN;
  assert.equal(await tk.trackOpen(), 1); // the re-check was recorded 10 minutes later: these candles are before it
  assert.equal(call.track.status, "win"); assert.equal(tk._state.calls[1].track.status, "open");
  const no = tk.view().scorecard.groups.find((g) => g.section === "final" && g.key === "no"); // a WAIT that would have hit the target
  assert.deepEqual([no.n, no.hitTargetPct, no.avgNetPct], [1, 100, 5.7]);
});

test("tracker store: the daily limit warns at 80% and 100% once, resets each UTC day, and is saved", async () => {
  let now = Date.parse("2026-10-29T23:50:00Z");
  const warns = [], dir = await mkdtemp(path.join(tmpdir(), "aitrack-")), file = path.join(dir, "ai_calls.json");
  const tk = createAiTracker({ file, now: () => now, dailyLimit: 10, bars: async () => ({ bars: [], barMs: MIN }), onWarn: (level, u) => warns.push([level, u.requests]) });
  await tk.ready;
  for (let i = 0; i < 12; i++) tk.countRequest();
  tk.countTokens({ in: 1000, out: 200, think: 300 });
  assert.deepEqual(warns, [[1, 8], [2, 10]]);
  assert.equal(tk.canSpend(1), false); assert.deepEqual(tk.usage().tokens, { in: 1000, out: 200, think: 300 }); assert.equal(tk.usage().left, 0);
  await new Promise((ok) => setTimeout(ok, 1700)); // saved shortly after
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.usage.requests, 12);
  const again = createAiTracker({ file, now: () => now, dailyLimit: 10, bars: async () => ({ bars: [], barMs: MIN }) }); // after a restart
  await again.ready;
  assert.equal(again.usage().requests, 12); assert.equal(again.canSpend(1), false);
  now += 15 * MIN; // past midnight UTC
  assert.equal(tk.canSpend(6), true); assert.equal(tk.usage().requests, 0);
  const unlimited = createAiTracker({ dailyLimit: 0, bars: async () => ({ bars: [], barMs: MIN }) });
  for (let i = 0; i < 50; i++) unlimited.countRequest();
  assert.equal(unlimited.canSpend(1000), true); assert.equal(unlimited.usage().limit, null);
});

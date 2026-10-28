// Shadow exit rules (exits.js) and the trade journal (journal.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { exitRulesFor, newExits, applyExits, exitsOpen, recordAfter, exitSummary, speedSummary, groupSummary, aiCalibration, maxHours } from "../exits.js";
import { tradeResult, journalSummary, cleanTrade } from "../journal.js";

const M = 60_000, T0 = Date.UTC(2026, 9, 1);
const c = (i, o, h, l, cl, dur = M) => ({ t: T0 + i * dur, o, h, l, c: cl });

test("exit rules scale with the alert's own rule", () => {
  const q = exitRulesFor({ targetPct: 6, stopPct: 3, hours: 12 }), b = exitRulesFor({ targetPct: 40, stopPct: 10, hours: 168 });
  assert.deepEqual(q.map((r) => r.key), ["tpHalf", "tpWide", "be", "trailA", "trailB", "time1", "time2"]);
  assert.equal(q.find((r) => r.key === "tpWide").tp, 10);
  assert.equal(q.find((r) => r.key === "trailA").trailAt, 4);
  assert.equal(b.find((r) => r.key === "trailB").trail, 15);
  assert.equal(b.find((r) => r.key === "be").be, 15);
  assert.equal(maxHours(q), 24); assert.equal(maxHours(b), 168);
  assert.match(b.find((r) => r.key === "trailA").label, /trail 10% after \+15%/);
});

test("exits: stop before target inside one candle, trailing stop moves only after the candle, time exit", () => {
  const rules = [{ key: "tp", tp: 6, stop: 3, hours: 12 }, { key: "trail", stop: 3, trailAt: 4, trail: 3, hours: 24 }, { key: "t1", stop: 3, hours: 1 }];
  const ex = newExits(rules, 100);
  // candle 0: up to 105 (trail arms after it), candle 1: dips to 101.5 -> trail stop 101.85 hit, candle 2: 107 -> tp hit
  applyExits(ex, rules, 100, T0, [c(0, 100, 105, 99.5, 104), c(1, 104, 104.5, 101.5, 102), c(2, 102, 107, 101.9, 106)], M);
  assert.equal(ex.trail.x, 1.85); assert.equal(ex.trail.why, "trailing stop");
  assert.equal(ex.tp.x, 6); assert.equal(ex.tp.why, "target");
  assert.equal(ex.t1.x, undefined); assert.equal(exitsOpen(ex), true);
  // the 1h rule ends at the window: exit at the last close before it
  const later = Array.from({ length: 60 }, (_, k) => c(3 + k, 106, 106.5, 105.5, 106));
  applyExits(ex, rules, 100, T0, later, M);
  assert.equal(ex.t1.why, "time"); assert.equal(ex.t1.x, 6); assert.equal(exitsOpen(ex), false);
  // a candle touching both stop and target counts as the stop; a gap below the stop exits at the open
  const both = newExits([{ key: "x", tp: 6, stop: 3, hours: 12 }], 100);
  applyExits(both, [{ key: "x", tp: 6, stop: 3, hours: 12 }], 100, T0, [c(0, 100, 110, 96, 105)], M);
  assert.equal(both.x.x, -3);
  const gap = newExits([{ key: "x", tp: 6, stop: 3, hours: 12 }], 100);
  applyExits(gap, [{ key: "x", tp: 6, stop: 3, hours: 12 }], 100, T0, [c(0, 95, 96, 94, 95)], M);
  assert.equal(gap.x.x, -5);
  // candles that started before the alert are ignored, and re-applying the same candles changes nothing
  const again = JSON.stringify(ex);
  assert.equal(applyExits(ex, rules, 100, T0, later, M), false);
  assert.equal(JSON.stringify(ex), again);
});

test("price after the alert: the candle spanning each mark", () => {
  const after = {};
  recordAfter(after, 100, T0 + 20_000, [c(0, 100, 101, 99, 100.5), c(1, 100.5, 102, 100, 101), c(2, 101, 103, 100, 102)], M, [["m1", 1], ["m2", 2], ["m5", 5]]);
  assert.deepEqual(after, { m1: 1, m2: 2 }); // m1 = candle 1 (spans alert+80s), m5 not reached yet
  const a5 = {};
  recordAfter(a5, 1, T0, [c(0, 1, 1.1, 1, 1.05, 300_000), c(1, 1.05, 1.1, 1, 1.02, 300_000), c(2, 1.02, 1.03, 0.9, 0.95, 300_000)], 300_000, [["m5", 5], ["m15", 15]]);
  assert.deepEqual(a5, { m5: 5, m15: -5 });
});

test("summaries: exits with halves, speed, groups that hold in both halves, AI calibration", () => {
  const rules = [{ key: "a", label: "A", tp: 6, stop: 3, hours: 12 }];
  const items = [1, 2, 3, 4].map((k) => ({ t: k, mainPct: k % 2 ? 6 : -3, exits: { a: { x: k <= 2 ? -3 : 6 } } }));
  const ex = exitSummary(items, rules, 0.3, "main");
  assert.equal(ex[0].resolved, 4); assert.equal(ex[0].avgNetPct, 1.2); // (6-3+6-3)/4 - 0.3
  assert.equal(ex[1].olderPct, -3.3); assert.equal(ex[1].newerPct, 5.7);
  const sp = speedSummary([{ lagSec: 4, after: { m1: 2 } }, { lagSec: 8, after: { m1: -0.5 } }], [["m1", 1]], 1);
  assert.equal(sp.avgLagSec, 6); assert.equal(sp.marks[0].avgPct, 0.75); assert.equal(sp.marks[0].ranAwayPct, 50);
  const g = groupSummary(Array.from({ length: 8 }, (_, k) => ({ t: k, netPct: k % 2 ? 4 : -1, win: k % 2 === 1, hot: k % 2 === 1 })), [["hot", (it) => it.hot], ["cold", (it) => !it.hot]], 1.5);
  assert.equal(g[0].holds, null); // only 4 alerts: halves need 6+
  const g2 = groupSummary(Array.from({ length: 12 }, (_, k) => ({ t: k, netPct: k % 2 ? 4 : -1, hot: k % 2 === 1 })), [["hot", (it) => it.hot]], 1.5);
  assert.equal(g2[0].holds, "better");
  const cal = aiCalibration([{ ai: { decision: "TAKE", probTargetPct: 35 }, win: true, netPct: 5.7 }, { ai: { decision: "TAKE", probTargetPct: 32 }, win: false, netPct: -3.3 },
    { ai: { decision: "SKIP", probTargetPct: 12 }, win: false, netPct: -3.3 }, { ai: { error: "x" }, win: true, netPct: 5 }]);
  assert.equal(cal.reviewed, 3);
  assert.deepEqual(cal.verdicts.find((v) => v.decision === "TAKE"), { decision: "TAKE", resolved: 2, hitTargetPct: 50, avgNetPct: 1.2 });
  assert.equal(cal.bands.find((b) => b.band === "30-39%").resolved, 2);
});

test("journal: trade results, summary vs the alerts, input checks", () => {
  const t = { entryPrice: 100, exitPrice: 110, sizeUsd: 500, feesUsd: 1, stopPrice: 95, entryTime: T0, exitTime: T0 + 90 * M };
  assert.deepEqual(tradeResult(t), { open: false, pnlPct: 9.8, pnlUsd: 49, r: 2, holdMin: 90 });
  assert.equal(tradeResult({ entryPrice: 100, exitPrice: null }, 97).pnlPct, -3); // open trade at the live price, no size
  assert.equal(tradeResult({ entryPrice: 100, exitPrice: null }).pnlPct, null);
  const rows = [
    { tool: "ignition", entryPrice: 100, result: { open: false, pnlPct: 9.8, pnlUsd: 49, r: 2 }, alert: { price: 99, netPct: 5.7 } },
    { tool: "alpha", entryPrice: 1.02, result: { open: false, pnlPct: -11, pnlUsd: -55, r: -1.1 }, alert: { price: 1, netPct: -11 } },
    { tool: "alpha", entryPrice: 2, result: { open: true, pnlPct: 3, pnlUsd: 6, r: null } },
  ];
  const s = journalSummary(rows);
  assert.equal(s.closed, 2); assert.equal(s.open, 1); assert.equal(s.winRatePct, 50); assert.equal(s.totalPnlUsd, -6); assert.equal(s.openPnlUsd, 6);
  assert.deepEqual(s.vsAlerts, { trades: 2, yourAvgPct: -0.6, alertAvgPct: -2.65 });
  assert.equal(s.avgEntryVsAlertPct, 1.51); // bought ~1% and 2% above the alert prices
  assert.equal(cleanTrade({ symbol: "SUI", entryPrice: "abc" }).error, "Entry price must be a positive number");
  assert.equal(cleanTrade({ symbol: "", entryPrice: 1 }).error, "Symbol is missing");
  const ok = cleanTrade({ symbol: " 币安人生 ", tool: "alpha", entryPrice: "0.18", sizeUsd: "", exitPrice: 0.2 }).trade;
  assert.equal(ok.symbol, "币安人生"); assert.equal(ok.entryPrice, 0.18); assert.equal(ok.sizeUsd, null); assert.ok(ok.exitTime > 0);
  assert.equal(cleanTrade({ symbol: "X", tool: "hack", entryPrice: 1 }).trade.tool, "other");
  const reopened = cleanTrade({ exitPrice: null }, ok.exitPrice ? { ...ok } : ok).trade;
  assert.equal(reopened.exitPrice, null); assert.equal(reopened.exitTime, null);
});

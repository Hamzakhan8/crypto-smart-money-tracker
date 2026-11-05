// Scalp paper bot (paper-bot.ts): sizing from the risk, the margin cap, opening and closing trades from the signals,
// fees, the balance and its worst drop. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { PAPER, newAccount, sizePosition, stepBot, accountView } from "../paper-bot.ts";

const T0 = Date.parse("2026-11-02T10:00:00Z"), M = 60_000;
const sig = (id, at, entry, stop, extra = {}) => ({ id, sym: id + "USDT", base: id, at, entry, stop, target: entry + 1.5 * (entry - stop), closeBy: at + 60 * M, status: "open", ...extra });

test("paper account: $100 by default, settings kept inside safe limits", () => {
  const a = newAccount({}, T0);
  assert.deepEqual([a.start, a.balance, a.riskPct, a.leverage, a.maxOpen], [PAPER.start, PAPER.start, PAPER.riskPct, PAPER.leverage, PAPER.maxOpen]);
  assert.equal(a.start, 100);
  const b = newAccount({ start: 5, riskPct: 50, leverage: 100, maxOpen: 2.6 }, T0);
  assert.deepEqual([b.start, b.riskPct, b.leverage, b.maxOpen], [10, 5, 20, 3]);
});

test("position size: risk % of the balance at the stop, cut to fit the margin, too-small orders skipped", () => {
  const a = newAccount({ start: 100, riskPct: 1, leverage: 5 }, T0);
  let z = sizePosition(a, 100, 97); // 3% stop: lose $1 at the stop
  assert.ok(Math.abs(z.riskUsd - 1) < 1e-9 && Math.abs(z.notional - 100 / 3) < 1e-9 && Math.abs(z.margin - 100 / 15) < 1e-9);
  z = sizePosition(a, 100, 99.9); // 0.1% stop would need $1,000: capped at $100 x 5
  assert.ok(Math.abs(z.notional - 500) < 1e-9 && Math.abs(z.riskUsd - 0.5) < 1e-9);
  assert.equal(sizePosition(newAccount({ start: 10, riskPct: 0.1 }, T0), 100, 70).skip, "small");
  assert.equal(sizePosition(a, 100, 101).skip, "bad levels");
});

test("bot: takes new signals once their entry is known, closes them with the signal's result after fees", () => {
  const a = newAccount({ start: 100, riskPct: 1, leverage: 5, maxOpen: 2 }, T0);
  const signals = [sig("OLD", T0 - 60 * M, 10, 9.7), sig("WAIT", T0 + 5 * M, null, 9.7), sig("AAA", T0 + 5 * M, 10, 9.7), sig("BBB", T0 + 10 * M, 20, 19), sig("CCC", T0 + 15 * M, 5, 4.9)];
  let r = stepBot(a, signals, { now: T0 + 20 * M });
  assert.deepEqual(r.opened.map((x) => x.base), ["AAA", "BBB"], "not before the start, not without an entry, at most 2 open");
  assert.equal(a.skipped.busy, 1);
  // AAA hits its target (+4.5%), BBB its stop (-5%)
  Object.assign(signals[2], { status: "closed", why: "target", exit: 10.45, exitT: T0 + 30 * M });
  Object.assign(signals[3], { status: "closed", why: "stop", exit: 19, exitT: T0 + 35 * M });
  r = stepBot(a, signals, { now: T0 + 40 * M, costPct: 0.12 });
  assert.equal(r.closed.length, 2);
  const aaa = a.trades.find((t) => t.base === "AAA"), bbb = a.trades.find((t) => t.base === "BBB");
  assert.ok(Math.abs(aaa.pnl - (aaa.notional * 0.045 - aaa.notional * 0.0012)) < 1e-3, "risked $1, won 1.5R minus fees");
  assert.ok(Math.abs(bbb.pnl - (-1 - bbb.notional * 0.0012)) < 1e-3, "lost about $1 at the stop, plus fees");
  assert.ok(Math.abs(a.balance - (100 + aaa.pnl + bbb.pnl)) < 1e-9);
  assert.ok(a.maxDrawdownPct > 0);
  assert.equal(a.open.length, 0);
  r = stepBot(a, signals, { now: T0 + 45 * M });
  assert.equal(r.opened.length, 0, "a signal is taken once (CCC came while the bot was full)");
  const v = accountView(a, () => null);
  assert.deepEqual([v.trades, v.wins, v.targets, v.stops], [2, 1, 1, 1]);
});

test("bot: open trades show their profit at the live price", () => {
  const a = newAccount({}, T0);
  stepBot(a, [sig("AAA", T0, 10, 9.7)], { now: T0 + M });
  const v = accountView(a, (sym) => (sym === "AAAUSDT" ? 10.3 : null));
  assert.equal(v.open.length, 1);
  assert.ok(Math.abs(v.open[0].uPnl - v.open[0].qty * 0.3) < 1e-3);
  assert.ok(v.equity > v.balance);
});

test("bot: Perps A+ shorts sized from the stop above, results with fees and funding from the signal, separate limits per strategy", () => {
  const a = newAccount({ start: 100, riskPct: 1, leverage: 5, maxOpen: 1 }, T0);
  const short = { ...sig("BBB", T0 + 5 * M, 10, 10.5), strategy: "perps", side: "short", target: 8, setup: "weakshort" };
  const scalp = sig("AAA", T0 + 5 * M, 10, 9.7), scalp2 = sig("CCC", T0 + 6 * M, 10, 9.7);
  let r = stepBot(a, [short, scalp, scalp2], { now: T0 + 10 * M });
  assert.deepEqual(r.opened.map((x) => x.base).sort(), ["AAA", "BBB"], "one per strategy (max 1 each); CCC skipped");
  const pos = a.open.find((x) => x.base === "BBB");
  assert.equal(pos.side, "short"); assert.ok(Math.abs(pos.riskUsd - 1) < 1e-9 && Math.abs(pos.notional - 20) < 1e-9, "stop 5% above: $20 short risks $1");
  const v = accountView(a, (sym) => (sym === "BBBUSDT" ? 9.5 : 10));
  assert.ok(Math.abs(v.open.find((x) => x.base === "BBB").uPnl - 1) < 1e-9, "a short gains when the price falls");
  Object.assign(short, { status: "closed", why: "target", exit: 8, netPct: 19.5, exitT: T0 + 3 * 24 * 60 * M }); // +20% minus fees, funding received
  r = stepBot(a, [short, scalp, scalp2], { now: T0 + 4 * 24 * 60 * M });
  const t = a.trades.find((x) => x.base === "BBB");
  assert.ok(Math.abs(t.pnl - 20 * 0.195) < 1e-9, "the signal's own net result (fees and funding) is used");
  assert.equal(accountView(a).byStrategy.perps.trades, 1);
});

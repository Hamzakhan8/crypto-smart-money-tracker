import { r2 } from "./util.ts";
// Shadow exit rules: every live alert keeps its own exit rule (the one its results are judged on) and is also followed
// under a few alternative exits, on the same candles, so after a few months the live data shows which exit works best
// for each kind of alert. Pure functions, shared by the ignition screener (1-minute candles) and the Alpha tab
// (5-minute candles). Node.js 22.6+, no dependencies.
//
// Inside one candle the stop is checked before the target (a candle that touches both counts as the stop, as in the
// replays), and a trailing or break-even stop only moves after the candle that set the new high, never inside it.

// One exit rule: +tp% target (none = no target), -stop% stop, a stop to break-even once +be%, or a trailing stop trail%
// under the peak once +trailAt%; sold after `hours` at the latest.
export interface ExitRule { key: string; tp?: number; stop: number; be?: number; trailAt?: number; trail?: number; hours: number; label?: string }
// One rule's state for one alert. x = exit result in % (before costs), at = exit time, why = what closed it, to = the
// last candle applied.
export interface ExitState { stop: number; peak: number; last: number; to?: number; x?: number | null; at?: number; why?: string }
export type Exits = Record<string, ExitState>;
// A finished candle: t = open time.
export interface Candle { t: number; o: number; h: number; l: number; c: number }
// [key, minutes after the alert], e.g. ["m5", 5].
export type Mark = [key: string, minutes: number];
// [name, test]: a group of alerts for groupSummary.
export type Group<T> = [name: string, test: (it: T) => unknown];

const HOUR = 3_600_000;
const fmt = (v: number) => String(r2(v, 1)).replace(/\.0$/, "");

// Alternatives for an alert whose own rule is +target / -stop within `hours`. Distances scale with that rule, so they
// still make sense if the target or stop is changed in .env.
export function exitRulesFor({ targetPct: T, stopPct: S, hours: H }: { targetPct: number; stopPct: number; hours: number }): ExitRule[] {
  const big = T >= 20;
  const rules: ExitRule[] = [
    { key: "tpHalf", tp: T / 2, stop: S, hours: H },
    { key: "be", tp: T, stop: S, be: big ? T * 0.375 : T / 2, hours: H },
    { key: "trailA", stop: S, trailAt: big ? T * 0.375 : T * 2 / 3, trail: S, hours: big ? H : 2 * H },
    { key: "trailB", stop: S, trailAt: big ? T / 2 : T, trail: S * 1.5, hours: big ? H : 2 * H },
    { key: "time1", stop: S, hours: big ? 24 : 1 },
    { key: "time2", stop: S, hours: big ? 72 : 4 },
  ];
  if (!big) rules.splice(1, 0, { key: "tpWide", tp: T * 5 / 3, stop: S, hours: H });
  return rules.map((r) => ({ ...r, label: labelOf(r) }));
}
export function labelOf(r: ExitRule): string {
  const h = r.hours >= 48 && r.hours % 24 === 0 ? `${r.hours / 24} days` : `${fmt(r.hours)}h`;
  if (r.trailAt) return `-${fmt(r.stop)}% stop, then trail ${fmt(r.trail)}% after +${fmt(r.trailAt)}% (up to ${h})`;
  if (r.be) return `+${fmt(r.tp)}% / -${fmt(r.stop)}%, stop to break-even at +${fmt(r.be)}% (${h})`;
  if (r.tp) return `+${fmt(r.tp)}% / -${fmt(r.stop)}% (${h})`;
  return `-${fmt(r.stop)}% stop, sell after ${h}`;
}
export const maxHours = (rules: ExitRule[]): number => Math.max(0, ...rules.map((r) => r.hours));

export const newExits = (rules: ExitRule[], entry: number): Exits => Object.fromEntries(rules.map((r) => [r.key, { stop: entry * (1 - r.stop / 100), peak: entry, last: entry }]));
export const exitsOpen = (ex: Exits | null | undefined): boolean => !!ex && Object.values(ex).some((s) => s.x == null);

// Applies finished candles {t, o, h, l, c} (t = open time, durMs long) after alertTime to every open rule.
// Returns true when something changed. s.x = exit result in % (before costs), s.at = exit time, s.why = what closed it.
export function applyExits(ex: Exits, rules: ExitRule[], entry: number, alertTime: number, candles: Candle[], durMs: number): boolean {
  let changed = false;
  for (const r of rules) {
    const s = ex[r.key];
    if (!s || s.x != null) continue;
    const end = alertTime + r.hours * HOUR, tp = r.tp ? entry * (1 + r.tp / 100) : Infinity;
    for (const c of candles) {
      if (c.t < alertTime || c.t <= (s.to ?? -Infinity)) continue;
      if (c.t >= end) { Object.assign(s, { x: r2((s.last / entry - 1) * 100), at: end, why: "time" }); changed = true; break; }
      s.to = c.t; changed = true;
      if (c.l <= s.stop) { const px = Math.min(s.stop, c.o); Object.assign(s, { x: r2((px / entry - 1) * 100), at: c.t + durMs, why: s.stop >= entry ? "trailing stop" : "stop" }); break; }
      if (c.h >= tp) { Object.assign(s, { x: r2(r.tp), at: c.t + durMs, why: "target" }); break; }
      s.peak = Math.max(s.peak, c.h); s.last = c.c;
      if (r.be && s.peak >= entry * (1 + r.be / 100)) s.stop = Math.max(s.stop, entry);
      if (r.trailAt && s.peak >= entry * (1 + r.trailAt / 100)) s.stop = Math.max(s.stop, s.peak * (1 - r.trail / 100));
      if (c.t + durMs >= end) { Object.assign(s, { x: r2((c.c / entry - 1) * 100), at: end, why: "time" }); break; }
    }
  }
  return changed;
}

// Price 1, 2 and 5 minutes (1m candles) or 5 and 15 minutes (5m candles) after the alert, in % from the alert price:
// how far it ran before you could act on it.
// after[key] = false: never measured (the alert is older than the marks).
export function recordAfter(after: Record<string, number | false | null>, entry: number, alertTime: number, candles: Candle[], durMs: number, marks: Mark[]): boolean {
  let changed = false;
  for (const [key, mins] of marks) {
    if (after[key] != null) continue;
    const mark = alertTime + mins * 60_000, c = candles.find((k) => k.t < mark && k.t + durMs >= mark); // the candle spanning the mark

    if (c) { after[key] = r2((c.c / entry - 1) * 100); changed = true; }
  }
  return changed;
}

// One alert for exitSummary: its time, its own result (when known) and its alternative exits.
export interface ExitItem { t: number; mainPct?: number; exits?: Record<string, { x?: number | null }> }
// Results per rule over many alerts: items = [{ exits, t, mainPct }] (mainPct = the alert's own result, when known).
// Net = after costPct. Older / newer = the first and second half of the alerts in time order.
export function exitSummary(items: ExitItem[], rules: ExitRule[], costPct: number, mainLabel: string) {
  const rows = [{ key: "main", label: mainLabel, get: (it: ExitItem) => it.mainPct }, ...rules.map((r) => ({ key: r.key, label: r.label, get: (it: ExitItem) => it.exits?.[r.key]?.x }))];
  const sorted = [...items].sort((a, b) => a.t - b.t);
  return rows.map((row) => {
    const done = sorted.filter((it) => Number.isFinite(row.get(it)));
    const net = done.map((it) => row.get(it) - costPct), half = done.length >> 1;
    const avg = (a: number[]) => (a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null);
    return { key: row.key, label: row.label, resolved: done.length, inProfitPct: done.length ? Math.round((net.filter((x) => x > 0).length / done.length) * 100) : null,
      avgNetPct: avg(net), olderPct: done.length >= 4 ? avg(net.slice(0, half)) : null, newerPct: done.length >= 4 ? avg(net.slice(half)) : null,
      bestPct: done.length ? r2(Math.max(...net)) : null, worstPct: done.length ? r2(Math.min(...net)) : null };
  });
}

// Average price move after alerts, and how many ran away by more than `runPct` before you could act.
export function speedSummary(items: { lagSec?: number | null; after?: Record<string, number | false | null> }[], marks: Mark[], runPct = 1) {
  const out: { alerts: number; avgLagSec: number | null; marks: { key: string; minutes: number; n: number; avgPct: number | null; ranAwayPct: number | null; fellPct: number | null }[] } = { alerts: items.length, avgLagSec: null, marks: [] };
  const lags = items.map((it) => it.lagSec).filter(Number.isFinite);
  if (lags.length) out.avgLagSec = Math.round(lags.reduce((s, x) => s + x, 0) / lags.length);
  for (const [key, mins] of marks) {
    const v = items.map((it) => it.after?.[key]).filter(Number.isFinite) as number[];
    out.marks.push({ key, minutes: mins, n: v.length, avgPct: v.length ? r2(v.reduce((s, x) => s + x, 0) / v.length) : null,
      ranAwayPct: v.length ? Math.round((v.filter((x) => x >= runPct).length / v.length) * 100) : null,
      fellPct: v.length ? Math.round((v.filter((x) => x <= -runPct).length / v.length) * 100) : null });
  }
  return out;
}

// Groups of alerts by a condition, with the result in the older and the newer half (a condition only counts if it
// helps in both). items = [{ t, netPct, ...fields }], groups = [[name, fn]].
export function groupSummary<T extends { t: number; netPct: number; win?: boolean }>(items: T[], groups: Group<T>[], overallNet: number | null = null) {
  const sorted = [...items].sort((a, b) => a.t - b.t);
  return groups.map(([name, fn]) => {
    const g = sorted.filter((it) => { try { return fn(it); } catch { return false; } });
    const net = g.map((it) => it.netPct), half = net.length >> 1;
    const avg = (a: number[]) => (a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null);
    const older = net.length >= 6 ? avg(net.slice(0, half)) : null, newer = net.length >= 6 ? avg(net.slice(half)) : null;
    return { name, resolved: g.length, winRatePct: g.length ? Math.round((g.filter((it) => it.win).length / g.length) * 100) : null,
      inProfitPct: g.length ? Math.round((net.filter((x) => x > 0).length / g.length) * 100) : null, avgNetPct: avg(net), olderPct: older, newerPct: newer,
      holds: older != null && newer != null && overallNet != null ? (older > overallNet && newer > overallNet ? "better" : older < overallNet && newer < overallNet ? "worse" : "mixed") : null };
  }).filter((g) => g.resolved > 0);
}

// Does the AI's stated chance match what happened? items = [{ ai: { probTargetPct, decision }, win, netPct }].
export function aiCalibration(items: { ai?: { decision?: string; probTargetPct?: number | null; error?: string } | null; win?: boolean; netPct: number }[]) {
  const withAi = items.filter((it) => it.ai && !it.ai.error && it.ai.decision);
  const avg = (a: number[]) => (a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null);
  const verdicts = ["TAKE", "WAIT", "SKIP"].map((d) => {
    const g = withAi.filter((it) => it.ai.decision === d);
    return { decision: d, resolved: g.length, hitTargetPct: g.length ? Math.round((g.filter((it) => it.win).length / g.length) * 100) : null, avgNetPct: avg(g.map((it) => it.netPct)) };
  });
  const bands = [[0, 20], [20, 30], [30, 40], [40, 101]].map(([lo, hi]) => {
    const g = withAi.filter((it) => Number.isFinite(it.ai.probTargetPct) && it.ai.probTargetPct >= lo && it.ai.probTargetPct < hi);
    return { band: hi > 100 ? `${lo}%+` : `${lo}-${hi - 1}%`, resolved: g.length, saidPct: avg(g.map((it) => it.ai.probTargetPct)),
      hitTargetPct: g.length ? Math.round((g.filter((it) => it.win).length / g.length) * 100) : null };
  });
  return { reviewed: withAi.length, verdicts, bands };
}

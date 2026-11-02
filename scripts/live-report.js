// Live report: everything the app has recorded on this PC (Ignition alerts and their results, Perps, Scalp, Pump watch,
// Alpha, your journal, AI calls), summed up in one text so the rules can be checked and improved. Read-only: it never
// changes the app's files. Run it in the project folder while the app runs or not:
//
//   node scripts/live-report.js
//
// It prints the summary and saves it as live_report.txt (paste that into the chat), plus every alert in compact form
// in live_report.json (for a deeper look). No prices are fetched; nothing is sent anywhere.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = async (f) => { try { return JSON.parse(await readFile(path.join(root, f), "utf8")); } catch { return null; } };
const out = [], json = { generatedAt: new Date().toISOString() };
const say = (s = "") => out.push(s);
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const pct = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? "+" : "") + v.toFixed(d) + "%" : "—");
const day = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") : "—");
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const COST = 0.3; // Ignition: 0.2% fees + 0.1% slippage per trade, as on the page

// ───────── Ignition alerts (screener_state.json) ─────────
const scr = await read("screener_state.json");
const events = scr?.events || [];
const ruleOf = (e) => e.track?.rule || { targetPct: 4, stopPct: 2.5 };
const resolved = (e) => ["win", "loss", "flat"].includes(e.track?.outcome);
const resultOf = (e) => { const t = e.track || {}, r = ruleOf(e); return Number.isFinite(t.exitPct) ? t.exitPct : t.outcome === "win" ? r.targetPct : t.outcome === "loss" ? -r.stopPct : 0; };
const net = (e) => resultOf(e) - COST;
const peak = (e) => (e.track?.entry > 0 ? ((e.track.hiW ?? e.track.high) / e.track.entry - 1) * 100 : null);
const low = (e) => (e.track?.entry > 0 ? ((e.track.loW ?? e.track.low) / e.track.entry - 1) * 100 : null);
const tierName = (e) => (e.tier === "early" ? (e.aplus ? "early A+" : "early") : e.tier === "ignition" ? "confirmed" : e.tier);
function line(name, s) {
  const done = s.filter(resolved);
  if (!s.length) return;
  const k = (o) => done.filter((e) => e.track.outcome === o).length, nets = done.map(net);
  say(`  ${name.padEnd(30)} ${String(s.length).padStart(4)} alerts, ${String(done.length).padStart(4)} resolved: ${k("win")} win / ${k("loss")} loss / ${k("flat")} flat` +
    (done.length ? `, in profit ${Math.round((nets.filter((x) => x > 0).length / done.length) * 100)}%, avg ${pct(avg(nets))} after costs, avg best ${pct(avg(done.map(peak).filter(Number.isFinite)), 1)}, avg worst ${pct(avg(done.map(low).filter(Number.isFinite)), 1)}` : ""));
}
say(`LIVE REPORT ${json.generatedAt.slice(0, 16)} UTC`);
say("");
say(`IGNITION ALERTS (screener_state.json): ${events.length} saved, ${events.length ? day(events.at(-1).time) + " to " + day(events[0].time) : "none"}`);
if (events.length) {
  const versions = [...new Set(events.map((e) => e.v ?? "old"))].sort();
  for (const v of versions) {
    say(` logic v${v}:`);
    const s = events.filter((e) => (e.v ?? "old") === v);
    for (const t of ["confirmed", "early A+", "early", "bigmove", "setup"]) line(t, s.filter((e) => tierName(e) === t));
  }
  // the AI's verdicts
  say(" AI verdicts (all versions, resolved alerts):");
  for (const d of ["TAKE", "WAIT", "SKIP"]) line(`AI said ${d}`, events.filter((e) => e.ai?.decision === d && resolved(e)));
  line("no AI verdict", events.filter((e) => !e.ai?.decision && resolved(e)));
  const aiErr = events.filter((e) => e.ai?.error);
  say(`  AI reviews that failed: ${aiErr.length}${aiErr.length ? ` (latest: ${String(aiErr[0].ai.error).slice(0, 160)})` : ""} · alerts never reviewed: ${events.filter((e) => !e.ai).length}`);

  // what separated winners from losers: each feature split in three equal groups (quick tiers, +6% / -3% rule)
  const quick = events.filter((e) => (e.tier === "ignition" || e.tier === "early") && resolved(e) && ruleOf(e).targetPct === 6);
  say("");
  say(`WHAT SEPARATES WINNERS FROM LOSERS (${quick.length} resolved early + confirmed alerts with the +6% / -3% rule; avg after costs per group)`);
  const F = ["igScore", "earlySigns", "r5", "prevR5", "rvol", "rvol1h", "rvol15", "tradesRatio", "buyRatio10m", "buyRatio15m", "ret10m", "ret15m", "ret1h", "change24h", "rsi",
    "distTo12hHigh", "distTo24hHigh", "distToHigh", "extPct", "closePos5", "rangePos", "wickShare", "fadePct", "spreadBps", "range6h", "quoteVolume", "marketCap", "btc1h", "btc4h", "fundingPct", "score"];
  const B = ["breakout", "trendUp", "aboveSma", "marketWide", "seed"];
  const C = ["hourUtc", "btcRegime", "altSeason", "riskOff", "hotShare", "radarBuyShare", "btc24h"];
  const grp = (name, s) => (s.length ? `${name} ${pct(avg(s.map(net)))} (${s.length}, ${Math.round((s.filter((e) => net(e) > 0).length / s.length) * 100)}% in profit)` : `${name} —`);
  if (quick.length >= 12) {
    for (const k of [...F, ...C.map((c) => "ctx." + c)]) {
      const val = (e) => (k.startsWith("ctx.") ? e.detail?.ctx?.[k.slice(4)] : e.detail?.[k]);
      const s = quick.filter((e) => Number.isFinite(val(e))).sort((a, b) => val(a) - val(b));
      if (s.length < 12) {
        const cat = quick.filter((e) => typeof val(e) === "string" || typeof val(e) === "boolean");
        if (cat.length >= 12) { const m = new Map(); for (const e of cat) (m.get(String(val(e))) || m.set(String(val(e)), []).get(String(val(e)))).push(e); say(`  ${k.padEnd(18)} ${[...m].map(([v, x]) => grp(v, x)).join(" | ")}`); }
        continue;
      }
      const a = s.slice(0, s.length / 3 | 0), b = s.slice(s.length / 3 | 0, (2 * s.length) / 3 | 0), c = s.slice((2 * s.length) / 3 | 0);
      const edge = (x) => `${r2(val(x[0]), 2)}..${r2(val(x.at(-1)), 2)}`;
      say(`  ${k.padEnd(18)} low ${grp(edge(a), a)} | mid ${grp(edge(b), b)} | high ${grp(edge(c), c)}`);
    }
    for (const k of B) { const s = quick.filter((e) => typeof e.detail?.[k] === "boolean"); if (s.length >= 12) say(`  ${k.padEnd(18)} ${grp("yes", s.filter((e) => e.detail[k]))} | ${grp("no", s.filter((e) => !e.detail[k]))}`); }
  } else say("  fewer than 12 resolved: not enough yet");

  // alternative exits, on the same alerts
  const exitKeys = [...new Set(events.flatMap((e) => Object.keys(e.track?.exits || {})))];
  if (exitKeys.length) {
    say("");
    say("OTHER EXITS ON THE SAME ALERTS (avg after costs, resolved only)");
    for (const tier of ["confirmed", "early A+", "early", "bigmove"]) {
      const s = events.filter((e) => tierName(e) === tier && resolved(e));
      if (!s.length) continue;
      const cells = exitKeys.map((k) => { const v = s.map((e) => e.track.exits?.[k]?.x).filter(Number.isFinite); return v.length ? `${k} ${pct(avg(v) - COST)} (${v.length})` : null; }).filter(Boolean);
      if (cells.length) say(`  ${tier.padEnd(10)} main ${pct(avg(s.map(net)))} (${s.length}) | ${cells.join(" | ")}`);
    }
  }
  say("");
  say("LAST 40 RESOLVED IGNITION ALERTS (time UTC, coin, tier, result after costs, best, worst, AI, key numbers)");
  for (const e of events.filter(resolved).slice(0, 40)) {
    const d = e.detail || {};
    say(`  ${day(e.time)} ${String(e.detail?.base || e.symbol).padEnd(9)} ${tierName(e).padEnd(9)} v${e.v ?? "?"} ${e.track.outcome.padEnd(4)} ${pct(net(e)).padStart(7)} best ${pct(peak(e), 1)} worst ${pct(low(e), 1)} AI ${e.ai?.decision || "—"} | ` +
      `score ${d.igScore ?? "—"} signs ${d.earlySigns ?? "—"} 5m ${d.prevR5 ?? "—"}x→${d.r5 ?? "—"}x buy ${d.buyRatio10m ?? d.buyRatio15m ?? "—"}% 24h ${pct(d.change24h, 1)} rsi ${d.rsi ?? "—"} to12hHigh ${d.distTo12hHigh ?? "—"} ext ${d.extPct ?? "—"} btc1h ${d.btc1h ?? "—"} ${d.ctx?.btcRegime || ""}`);
  }
  json.ignition = events.map((e) => ({ id: e.id, t: e.time, sym: e.symbol, tier: tierName(e), v: e.v, outcome: e.track?.outcome || "open", netPct: resolved(e) ? r2(net(e)) : null,
    bestPct: r2(peak(e)), worstPct: r2(low(e)), ai: e.ai?.decision || null, quality: e.quality?.n ?? null, exits: Object.fromEntries(Object.entries(e.track?.exits || {}).map(([k, x]) => [k, x?.x ?? null])),
    f: Object.fromEntries(Object.entries(e.detail || {}).filter(([, v]) => typeof v === "number" || typeof v === "boolean")), ctx: e.detail?.ctx || null }));
}

// ───────── Perps, Scalp, Pump watch ─────────
const perps = await read("perps_state.json");
if (perps?.signals?.length) {
  const s = perps.signals, done = s.filter((x) => x.track?.status === "closed" && Number.isFinite(x.track.r));
  say("");
  say(`PERPS (perps_state.json): ${s.length} signals, ${done.length} closed`);
  const by = new Map(); for (const x of done) { const k = `${x.setup} ${x.side || (x.dir > 0 ? "long" : "short")} ${x.verdict}`; (by.get(k) || by.set(k, []).get(k)).push(x.track.r); }
  for (const [k, v] of by) say(`  ${k.padEnd(28)} ${v.length} closed, ${Math.round((v.filter((r) => r > 0).length / v.length) * 100)}% won, avg ${r2(avg(v))}R, total ${r2(v.reduce((a, b) => a + b, 0))}R`);
  for (const x of s.slice(0, 15)) say(`  ${day(x.t)} ${String(x.sym).padEnd(12)} ${x.setup} ${x.side || ""} ${x.verdict} ${x.track?.status} ${x.track?.why || ""} ${Number.isFinite(x.track?.r) ? r2(x.track.r) + "R" : ""}`);
  json.perps = s.map((x) => ({ t: x.t, sym: x.sym, setup: x.setup, side: x.side, verdict: x.verdict, status: x.track?.status, why: x.track?.why, r: x.track?.r ?? null, netPct: x.track?.netPct ?? null, f: x.f }));
}
const scalp = await read("scalp_state.json");
if (scalp?.signals?.length) {
  const s = scalp.signals, done = s.filter((x) => x.status === "closed" && Number.isFinite(x.netPct) && x.why !== "gap");
  say("");
  say(`SCALP (scalp_state.json): ${s.length} signals, ${done.length} closed` + (done.length ? `, ${Math.round((done.filter((x) => x.netPct > 0).length / done.length) * 100)}% won, avg ${pct(avg(done.map((x) => x.netPct)))}, ${done.filter((x) => x.why === "target").length} target / ${done.filter((x) => x.why === "stop").length} stop / ${done.filter((x) => x.why === "time").length} 1-hour` : ""));
  for (const x of s.slice(0, 25)) say(`  ${day(x.at)} ${String(x.sym).padEnd(14)} flush ${pct(x.flushPct, 1)} vol ${x.volRatio}x atr ${x.atrPct}% stop -${x.riskPct}% ${x.status} ${x.why || ""} ${Number.isFinite(x.netPct) ? pct(x.netPct) : ""}`);
  json.scalp = s;
}
if (!scalp) { say(""); say("SCALP: no scalp_state.json, so the Scalp scanner has not finished a single scan on this PC (it saves after every scan, even with no signal). Restart node server.js after updating, then check the Scalp tab's \"Last scan\" and its error box."); }
const pump = await read("pump_state.json");
if (pump?.picks?.length) {
  const s = pump.picks, done = s.filter((x) => x.status === "closed" && Number.isFinite(x.netPct));
  say("");
  say(`PUMP WATCH (pump_state.json): ${s.length} picks, ${done.length} closed` + (done.length ? `, avg ${pct(avg(done.map((x) => x.netPct)))}, ${done.filter((x) => x.why === "target").length} doubled, ${done.filter((x) => x.why === "stop").length} stopped` : "") + `; market mood now ${pump.mood?.share ?? "—"}%`);
  for (const x of s.slice(0, 25)) say(`  ${day(x.t).slice(0, 10)} ${String(x.base).padEnd(10)} vol ${x.volRatio}x ${x.fromHigh90Pct}% from 90d high, day ${pct(x.dayPct, 0)}, mood ${x.moodShare}% | ${x.status} ${x.why || ""} best ${pct(x.peakPct, 0)} worst ${pct(x.lowPct, 0)} ${Number.isFinite(x.netPct) ? "result " + pct(x.netPct, 1) : ""}`);
  json.pump = s;
}

// ───────── Alpha, journal, AI calls ─────────
const alpha = await read("alpha_state.json");
if (alpha?.alerts?.length) {
  const s = alpha.alerts, done = s.filter((a) => a.track?.status && a.track.status !== "open");
  say("");
  say(`ALPHA (alpha_state.json): ${s.length} alerts, ${done.length} closed`);
  for (const t of [...new Set(s.map((a) => a.tier))]) {
    const d = done.filter((a) => a.tier === t), v = d.map((a) => a.track.resultPct).filter(Number.isFinite);
    say(`  ${String(t).padEnd(10)} ${s.filter((a) => a.tier === t).length} alerts, ${d.length} closed: ${d.filter((a) => a.track.status === "win").length} win / ${d.filter((a) => a.track.status === "loss").length} loss${v.length ? `, avg ${pct(avg(v))}` : ""}`);
  }
  json.alpha = s.map((a) => ({ t: a.t, sym: a.symbol || a.token?.symbol, tier: a.tier, status: a.track?.status, resultPct: a.track?.resultPct ?? null, peakPct: a.track?.peakPct ?? null, lowPct: a.track?.lowPct ?? null }));
}
const journal = await read("journal.json");
const trades = Array.isArray(journal) ? journal : journal?.trades || [];
if (trades.length) {
  say("");
  say(`YOUR JOURNAL (journal.json): ${trades.length} trades`);
  for (const j of trades.slice(-25)) say(`  ${day(j.createdAt)} ${String(j.symbol).padEnd(10)} ${j.side || "long"} ${j.tool || ""} entry ${j.entryPrice ?? "—"} exit ${j.exitPrice ?? "open"} stop ${j.stopPrice ?? "—"} size $${j.sizeUsd ?? "—"} ${j.note ? "· " + String(j.note).slice(0, 60) : ""}`);
  json.journal = trades;
}
const ai = await read("ai_calls.json");
const calls = ai?.calls || (Array.isArray(ai) ? ai : []);
if (calls.length) {
  say("");
  say(`AI CALLS (ai_calls.json): ${calls.length}`);
  const fin = calls.filter((c) => c.track && !["open", "watching"].includes(c.track.status));
  for (const d of ["YES", "WATCH", "NO", "TAKE", "WAIT", "SKIP"]) {
    const s = fin.filter((c) => (c.decision || c.verdict) === d);
    if (s.length) say(`  ${d.padEnd(6)} ${s.length} resolved: ${[...new Set(s.map((c) => c.track.status))].map((st) => `${st} ${s.filter((c) => c.track.status === st).length}`).join(", ")}`);
  }
  json.ai = calls.slice(-200).map((c) => ({ t: c.t || c.at || c.time, sym: c.symbol || c.sym, kind: c.kind, tier: c.tier, decision: c.decision || c.verdict, track: c.track ? { status: c.track.status, resultPct: c.track.resultPct ?? c.track.pct ?? null } : null }));
}
const tg = await read("telegram_state.json");
if (tg?.prefs) { say(""); say(`TELEGRAM switches: ${Object.entries(tg.prefs).map(([k, v]) => `${k} ${v ? "on" : "off"}`).join(", ") || "defaults"}`); }

if (!events.length && !perps && !scalp && !pump && !alpha) say("\nNo saved data found here. Run this in the project folder (where server.js is), after the app has run for a while.");
const text = out.join("\n");
await writeFile(path.join(root, "live_report.txt"), text + "\n");
await writeFile(path.join(root, "live_report.json"), JSON.stringify(json));
console.log(text);
console.log(`\nSaved live_report.txt (paste it into the chat) and live_report.json.`);

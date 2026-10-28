// Replay test for the Alpha tab's ignition rule on past Binance Alpha 5-minute candles.
// Node.js 18+, no dependencies.
//
//   node alpha-backtest.js                         # last 60 days, every Alpha token that is not on Binance spot
//   node alpha-backtest.js --days 45 --cost 2
//   node alpha-backtest.js --end 2026-10-28T08    # a fixed window (reproduce an earlier report)
//
// The first run downloads 5m candles for 500+ Alpha tokens (20-40 minutes); they are cached in ./alpha_cache, so reruns
// of the same window are fast. Tokens Binance has since delisted from Alpha are included (their candles are still
// served), so dead coins count. Point in time: only candles up to the signal are used; pool liquidity and holders are
// known only for today, so the replay cannot filter on them (the live tab does). Entry = the second candle's close;
// when target and stop are both touched inside one 5m candle it counts as a loss. Research tool, not financial advice.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SCREENER_LIBRARY_ONLY = "1";
const { fetchJson, mapLimit } = await import("./screener.js");
const A = await import("./alpha.js");
const { DEFAULT_ALPHA, ALPHA_LIST_URL, alphaKlinesUrl, parseKlines, toGrid, alphaFeatures, classifyAlpha, alphaOutcome } = A;

const here = path.dirname(fileURLToPath(import.meta.url));
const STEP = 300_000, HOUR = 3_600_000, DAY = 86_400_000, WARM = 2;
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? Number(argv[i + 1]) : d; };
const DAYS = Math.min(120, Math.max(14, arg("days", 60)));
const COST = arg("cost", DEFAULT_ALPHA.costPct);
const endArg = argv.includes("--end") ? Date.parse(argv[argv.indexOf("--end") + 1] + ":00:00Z") : NaN;
const end = Math.floor((Number.isFinite(endArg) ? Math.min(endArg, Date.now()) : Date.now()) / HOUR) * HOUR, sigStart = end - DAYS * DAY, start = sigStart - WARM * DAY;
const split = sigStart + Math.round((DAYS * 2) / 3) * DAY;
const CACHE = path.join(here, "alpha_cache");
const day = (t) => new Date(t).toISOString().slice(0, 10), stamp = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

async function cached(name, load) {
  const file = path.join(CACHE, name);
  try { return JSON.parse(await readFile(file, "utf8")); } catch { /* not cached */ }
  const data = await load();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}
const get = async (url) => { const j = await fetchJson(url, { retries: 3, timeoutMs: 20_000 }); if (j && j.success === false) throw new Error(j.message || "Alpha API error"); return j?.data ?? j; };
const klines = (id) => cached(`${id}_5m_${start}_${end}.json`, async () => {
  const rows = [];
  let quote = "USDT";
  for (let from = start; from < end;) {
    let k;
    try { k = parseKlines(await get(alphaKlinesUrl(id, { limit: 1500, startTime: from, endTime: end - 1, quote }))); }
    catch (e) { if (quote !== "USDT" || !/invalid symbol/i.test(e.message)) throw e; quote = "USDC"; continue; } // some tokens trade only against USDC
    if (!k.length) break;
    for (const c of k) if (c[0] >= from && c[0] < end) rows.push(c);
    if (k.length < 1500) break;
    from = k[k.length - 1][0] + STEP;
  }
  return rows;
});

console.log(`ALPHA IGNITION REPLAY · signals ${day(sigStart)} to ${stamp(end)} UTC (${DAYS} days) · tune before ${day(split)}, test after · cost ${COST}% per trade`);
const list = await cached(`list_${end}.json`, () => get(ALPHA_LIST_URL));
const STABLE = /^(USD|USDT|USDC|FDUSD|DAI|TUSD|USDE|USD1|PYUSD|RLUSD|USDF|XUSD|BUSD|EUR|EURC|XAUT|PAXG)$|USD$/i;
const uni = list.filter((x) => x.alphaId && !x.listingCex && !STABLE.test(x.symbol || "") && !(x.listingTime > end - 2 * DAY));
console.log(`Universe: ${uni.length} Alpha tokens not on Binance spot (${uni.filter((x) => x.offline || x.fullyDelisted).length} of them delisted from Alpha since), stablecoins removed.`);

let done = 0, failed = 0;
const why = {};
const series = new Map();
await mapLimit(uni, 4, async (x) => {
  try { const k = await klines(x.alphaId); if (k.length) series.set(x.alphaId, k); }
  catch (e) { failed++; why[e.message] = (why[e.message] || 0) + 1; }
  if (++done % 25 === 0 || done === uni.length) process.stdout.write(`\r  candles: ${done}/${uni.length} tokens${failed ? `, ${failed} failed` : ""}   `);
});
const traded = [...series.keys()].map((id) => list.find((x) => x.alphaId === id));
console.log(`\n  ${series.size} tokens traded in the window (${traded.filter((x) => x.offline || x.fullyDelisted).length} of them delisted since). No candles for ${failed}: ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(", ")} (Binance no longer serves most long-delisted tokens, so they are missing).`);

// ── events: every candle pair passing a loose pre-filter (variants are filters on these) ──
const LOOSE = { mult: 3, usd: 300, trades: 5 };
const N = Math.round((end - start) / STEP), i0 = Math.round((sigStart - start) / STEP);
const events = [], grids = new Map(), daily = [];
const byId = new Map(list.map((x) => [x.alphaId, x]));
for (const [id, rows] of series) {
  const g = toGrid(rows, start, end);
  grids.set(id, g);
  // rolling median of the previous 288 candles' volume (excluding the two being tested), plus 24h / 1h sums
  const win = [], ins = (v) => { let lo = 0, hi = win.length; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 0, v); };
  const del = (v) => { let lo = 0, hi = win.length; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 1); };
  const qv = (k) => (g[k] ? g[k][5] : 0);
  let sumPrior = 0, s24 = 0, s1h = 0;
  for (let i = 0; i < N; i++) {
    if (i >= 2) { ins(qv(i - 2)); sumPrior += qv(i - 2); }
    if (i >= 290) { del(qv(i - 290)); sumPrior -= qv(i - 290); }
    s24 += qv(i); if (i >= 288) s24 -= qv(i - 288);
    s1h += qv(i); if (i >= 12) s1h -= qv(i - 12);
    if (i < i0 || i < 290 || !g[i] || !g[i - 289]) continue;
    if (i % 288 === 0 && s24 >= 10_000) daily.push({ id, i, t: g[i][0] + STEP, qv24: s24 }); // a random-time entry for the base rate
    const a = g[i - 1], b = g[i];
    if (!(a[5] >= LOOSE.usd && b[5] >= LOOSE.usd && a[6] >= LOOSE.trades && b[6] >= LOOSE.trades && b[4] > a[1])) continue;
    const m = win.length % 2 ? win[win.length >> 1] : (win[win.length / 2 - 1] + win[win.length / 2]) / 2;
    const f = alphaFeatures(g, i, DEFAULT_ALPHA, { median: m, mean24: sumPrior / 288, qv24: s24, qv1h: s1h });
    if (f && f.r1 >= LOOSE.mult && f.r2 >= LOOSE.mult) events.push({ id, i, t: f.t, f });
  }
}
console.log(`${events.length} candle pairs passed the loose pre-filter; ${daily.length} random daily entries for the base rate.`);

// ── outcomes ──
const RULES = { w7: { targetPct: 40, stopPct: 10, outcomeDays: 7 }, r20: { targetPct: 20, stopPct: 10, outcomeDays: 7 }, d1: { targetPct: 10, stopPct: 5, outcomeDays: 1 } };
const outCache = new Map();
const outcome = (e, rule = "w7") => {
  const key = `${e.id}|${e.i}|${rule}`;
  if (!outCache.has(key)) { const g = grids.get(e.id); outCache.set(key, alphaOutcome(g, e.i, g[e.i][4], { ...DEFAULT_ALPHA, ...RULES[rule], costPct: 0 })); }
  return outCache.get(key);
};
const dedupe = (evs) => { const last = new Map(), out = []; for (const e of [...evs].sort((a, b) => a.t - b.t)) { if (e.t - (last.get(e.id) ?? -Infinity) < DAY) continue; last.set(e.id, e.t); out.push(e); } return out; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function stats(evs, rule = "w7", cost = COST) {
  const m = evs.map((e) => ({ e, o: outcome(e, rule) })).filter((x) => x.o.o !== "open");
  if (!m.length) return { n: 0 };
  const w = m.filter((x) => x.o.o === "win").length, l = m.filter((x) => x.o.o === "loss").length;
  const rets = m.map((x) => x.o.r - cost);
  const sorted = [...rets].sort((a, b) => b - a);
  return { n: m.length, winPct: (w / m.length) * 100, lossPct: (l / m.length) * 100, net: mean(rets), netNoBest: m.length > 1 ? mean(sorted.slice(1)) : null,
    tokens: new Set(m.map((x) => x.e.id)).size, medPeak: [...m.map((x) => x.o.peakPct)].sort((a, b) => a - b)[m.length >> 1] };
}
const pad = (v, w) => String(v ?? "—").padEnd(w);
const f1 = (v) => (v == null || !Number.isFinite(v) ? "—" : (v > 0 ? "+" : "") + v.toFixed(2));
const cell = (s) => (s.n ? `${pad(s.n, 5)} ${pad(s.winPct.toFixed(1) + "%", 6)} ${pad(f1(s.net), 7)}` : pad("—", 20));
const month = (e) => day(e.t).slice(0, 7);
const months = [...new Set(events.map(month))].sort();
const hdr = `${pad("rule", 60)} ${pad("all: n / +40 first / avg net", 30)} ${pad("tune", 20)} ${pad("test", 20)} ${months.map((m) => pad(m, 20)).join(" ")} ${pad("w/o best", 9)} ${pad("cost 3%", 8)} tokens`;
const report = { window: { from: day(sigStart), to: stamp(end), days: DAYS, split: day(split), cost: COST }, universe: { tokens: uni.length, traded: series.size, delisted: uni.filter((x) => x.offline || x.fullyDelisted).length, delistedTraded: traded.filter((x) => x.offline || x.fullyDelisted).length }, rows: [] };
const show = (name, evs, rule = "w7", key = null) => {
  const s = stats(evs, rule), a = stats(evs.filter((e) => e.t < split), rule), b = stats(evs.filter((e) => e.t >= split), rule);
  console.log(`${pad(name, 60)} ${s.n ? pad(`${s.n} / ${s.winPct.toFixed(1)}% / ${f1(s.net)}%`, 30) : pad("—", 30)} ${cell(a)} ${cell(b)} ${months.map((m) => cell(stats(evs.filter((e) => month(e) === m), rule))).join(" ")} ${pad(f1(s.netNoBest), 9)} ${pad(f1(stats(evs, rule, 3).net), 8)} ${s.tokens ?? 0}`);
  if (key) report.rows.push({ key, name, rule, all: s, tune: a, test: b, cost3: stats(evs, rule, 3).net });
  return s;
};
const pass = (cfg) => (e) => classifyAlpha(e.f, { ...DEFAULT_ALPHA, ...cfg }).ok;
const sel = (cfg) => dedupe(events.filter(pass(cfg)));

console.log(`\nBASE RATE AND THE RULE (+40% before -10% within 7 days; columns: n / hit +40% first / avg net per trade after ${COST}%)`);
console.log(hdr);
const baseAt = (min) => daily.filter((d) => d.qv24 >= min).map((d) => ({ ...d, f: null }));
show("random time: every active token once a day (base rate)", daily.map((d) => ({ ...d, f: null })), "w7", "base");
const planned = sel({ min24hUsd: 0 });
show("RULE AS PLANNED: 2 x 5m at 5x normal, $1k+, 10+ trades, up, <30% 24h", planned, "w7", "planned");
show("random time, tokens with $1M+ 24h volume then (base rate)", baseAt(1e6), "w7", "base1m");
const main = sel({});
show("LIVE RULE: the same + $1M+ traded in the last 24 hours", main, "w7", "rule");

console.log("\nVARIANTS (sensitivity: a real edge should not depend on one exact setting)");
console.log(hdr);
for (const [nm, cfg] of [["volume 3x", { volMult: 3, min24hUsd: 0 }], ["volume 10x", { volMult: 10, min24hUsd: 0 }], ["$500+ per candle", { minCandleUsd: 500, min24hUsd: 0 }], ["$3k+ per candle", { minCandleUsd: 3000, min24hUsd: 0 }],
  ["$10k+ per candle", { minCandleUsd: 10_000, min24hUsd: 0 }], ["no 24h cap", { maxChg24Pct: 1e9, min24hUsd: 0 }], ["24h change under 10%", { maxChg24Pct: 10, min24hUsd: 0 }], ["10m move under 5%", { maxMove10mPct: 5, min24hUsd: 0 }],
  ["live rule, volume 3x", { volMult: 3 }], ["live rule, volume 10x", { volMult: 10 }], ["live rule, $3k+ per candle", { minCandleUsd: 3000 }], ["live rule, $500k+ 24h volume", { min24hUsd: 5e5 }], ["live rule, $3M+ 24h volume", { min24hUsd: 3e6 }]])
  show("  " + nm, sel(cfg), "w7", nm);
const big = (min) => planned.filter((e) => e.f.qv24 >= min), small = (max) => planned.filter((e) => e.f.qv24 < max);
show("  rule, 24h volume then >= $100k", big(1e5), "w7", "qv100k"); show("  base rate, 24h volume then >= $100k (same tokens, random time)", baseAt(1e5), "w7", "base100k");
show("  rule, $10k+ per candle and 24h volume >= $1M", sel({ minCandleUsd: 10_000 }), "w7", "big10k1m");
show("  rule, 24h volume then < $100k", small(1e5), "w7", "qvsmall");
const alive = planned.filter((e) => { const x = byId.get(e.id); return !(x.offline || x.fullyDelisted); });
show("  rule, only tokens still on Alpha today (survivorship check)", alive, "w7");

console.log("\nOTHER EXITS for the rule");
console.log(hdr);
show("+20% before -10%, 7 days", main, "r20", "r20"); show("+10% before -5%, 24 hours", main, "d1", "d1");
show("base rate, +20/-10/7d", daily.map((d) => ({ ...d, f: null })), "r20"); show("base rate, +10/-5/24h", daily.map((d) => ({ ...d, f: null })), "d1");

// ── EVAA and the biggest winners / losers ──
const sym = (id) => byId.get(id)?.symbol || id;
const evaa = list.find((x) => x.symbol === "EVAA");
const evaaOf = (evs) => {
  const al = evaa ? evs.filter((e) => e.id === evaa.alphaId) : [], os = al.map((e) => outcome(e).o), k = (x) => os.filter((o) => o === x).length;
  return { n: al.length, win: k("win"), loss: k("loss"), flat: k("flat"), open: k("open"), last: al.slice(-3).map((e) => ({ t: e.t, price: e.f.close, r1: e.f.r1, r2: e.f.r2, usd1: e.f.usd1, usd2: e.f.usd2, outcome: outcome(e) })) };
};
const evaaRep = evaa ? { early: evaaOf(planned), confirmed: evaaOf(main) } : null;
if (evaaRep) for (const [tier, x] of Object.entries(evaaRep))
  console.log(`${tier === "early" ? "\n" : ""}EVAA, ${tier} tier: ${x.n} alerts in ${DAYS} days (one per 24h): ${x.win} hit +40% first, ${x.loss} stopped, ${x.flat} timed out, ${x.open} still open. Last: ${x.last.map((e) => `${stamp(e.t)} UTC at ${e.price.toPrecision(4)} (volume ${e.r1}x / ${e.r2}x, $${e.usd1} / $${e.usd2}) -> ${e.outcome.o}, peak ${e.outcome.peakPct > 0 ? "+" : ""}${e.outcome.peakPct}%`).join("; ")}`);
console.log(`Alerts per day: ${(main.length / DAYS).toFixed(1)} with the live rule, ${(planned.length / DAYS).toFixed(1)} as first planned (one per token per 24 hours).`);
const top = [...main].map((e) => ({ e, o: outcome(e) })).filter((x) => x.o.o !== "open").sort((a, b) => b.o.peakPct - a.o.peakPct);
console.log(`Biggest runs after an alert: ${top.slice(0, 8).map((x) => `${sym(x.e.id)} ${stamp(x.e.t).slice(5)} +${x.o.peakPct}%`).join(" · ")}`);
console.log(`Typical alert: median peak within 7 days ${f1(stats(main).medPeak)}%; ${main.length} alerts on ${new Set(main.map((e) => e.id)).size} tokens.`);
report.evaa = evaaRep;
report.perDay = +(main.length / DAYS).toFixed(1); report.plannedPerDay = +(planned.length / DAYS).toFixed(1);
report.recent = main.slice(-40).reverse().map((e) => ({ symbol: sym(e.id), t: e.t, price: e.f.close, r1: e.f.r1, r2: e.f.r2, chg24: e.f.chg24, outcome: outcome(e) }));
report.generatedAt = Date.now();
await writeFile(path.join(here, "alpha_report.json"), JSON.stringify(report, null, 1));
console.log("\nReport saved to alpha_report.json (the Alpha tab shows it). Research tool, not financial advice.");

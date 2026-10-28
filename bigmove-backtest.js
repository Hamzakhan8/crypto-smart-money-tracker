// Replay test for the screener's big-move tier (+40% before -10% within 7 days) on past Binance 5-minute candles.
// Node.js 18+, no dependencies.
//
//   node bigmove-backtest.js                            # last 90 days, every Binance USDT pair
//   node bigmove-backtest.js --days 60 --target 40 --stop 10 --hours 168
//   node bigmove-backtest.js --end 2026-10-28T05                  # a fixed window (reproduce an earlier report)
//   BINANCE_SPOT_URL=https://data-api.binance.vision node bigmove-backtest.js   # if api.binance.com is blocked
//
// The first run downloads 5m candles for every USDT pair (500+ coins, 30-60 minutes); they are cached in
// ./backtest_cache, so reruns in the same hour are fast. Re-run it every month: a rule that only worked in one kind of
// market shows up as one good month and one bad one.
//
// Point in time: a signal counts only if the coin had enough 24h volume AT THAT MOMENT. Picking coins by today's volume
// would favour the ones that pumped since and make every small-coin rule look great. Coins that were delisted are
// still missing, which flatters results a little. Entry = the signal candle's close; when target and stop are both
// touched inside one 5m candle it counts as a loss. Fees + slippage as in the live results. Research tool, not advice.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SCREENER_LIBRARY_ONLY = "1";
const core = await import("./screener.js");
const { classifyBigMove, techMetrics, hourlyProfile, fetchJson, DEFAULT_BIGMOVE, CONFIG, STABLES, NONCRYPTO, isNonCryptoInfo } = core;
const { exclusionReason } = await import("./early2x.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const BN = (process.env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");
const STEP = 300_000, HOUR = 3_600_000, DAY = 86_400_000, WARM = 15;
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? Number(argv[i + 1]) : d; };
const DAYS = Math.min(120, Math.max(20, arg("days", 90)));
const T = arg("target", DEFAULT_BIGMOVE.targetPct), S = arg("stop", DEFAULT_BIGMOVE.stopPct), HZ = Math.round(arg("hours", DEFAULT_BIGMOVE.outcomeHours) * 12);
const COST = +(CONFIG.feePct + (CONFIG.slippagePct || 0)).toFixed(4);
const CACHE = path.join(here, "backtest_cache");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

const endArg = argv.includes("--end") ? Date.parse(argv[argv.indexOf("--end") + 1] + ":00:00Z") : NaN;
const end = Math.floor((Number.isFinite(endArg) ? Math.min(endArg, Date.now()) : Date.now()) / HOUR) * HOUR, sigStart = end - DAYS * DAY, start = sigStart - WARM * DAY;
const N = (end - start) / STEP, H = N / 12;
const tGrid = Float64Array.from({ length: N }, (_, i) => start + i * STEP);
const hourOf = (i) => Math.floor(tGrid[i] / HOUR) % 24;

async function cached(name, load) {
  const file = path.join(CACHE, name);
  try { return JSON.parse(await readFile(file, "utf8")); } catch { /* not cached */ }
  const data = await load();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}
const klines5m = (sym) => cached(`${sym}_5m_${start}_${end}.json`, async () => {
  const rows = [];
  for (let from = start; from < end;) {
    const k = await fetchJson(`${BN}/api/v3/klines?symbol=${sym}USDT&interval=5m&startTime=${from}&endTime=${end - 1}&limit=1000`);
    if (!Array.isArray(k) || !k.length) break;
    for (const c of k) if (Number(c[0]) < end) rows.push([Number(c[0]), +c[1], +c[2], +c[3], +c[4], +c[7], +c[8], +c[10]]);
    if (k.length < 1000) break;
    from = Number(k[k.length - 1][0]) + STEP;
    await sleep(40);
  }
  return rows;
});
const klines1d = (sym) => cached(`${sym}_1d_${end}.json`, async () => {
  const k = await fetchJson(`${BN}/api/v3/klines?symbol=${sym}USDT&interval=1d&endTime=${end - 1}&limit=${DAYS + WARM + 45}`);
  return Array.isArray(k) ? k.map((c) => [Number(c[0]), +c[2], +c[3], +c[4], +c[7]]) : [];
});

// Every USDT pair still trading, minus stablecoins, wrapped / staked tokens, tokenized stocks and leveraged tokens.
async function pickSymbols() {
  let meta = new Map();
  try { meta = new Map(JSON.parse(await readFile(path.join(here, "binance_meta.json"), "utf8")).coins || []); }
  catch { console.log("  binance_meta.json not found: run the screener once first, so tokenized stocks are left out."); }
  const t = await fetchJson(`${BN}/api/v3/ticker/24hr`, { timeoutMs: 20_000 });
  const usdt = t.filter((x) => /USDT$/.test(x.symbol) && Number(x.count) > 0), listed = new Set(usdt.map((x) => x.symbol.slice(0, -4)));
  return ["BTC", ...usdt.map((x) => x.symbol.slice(0, -4)).filter((b) => b !== "BTC" && !STABLES.has(b) && !NONCRYPTO.has(b) && !isNonCryptoInfo(meta.get(b)) && !exclusionReason(b, meta.get(b) || null, listed))];
}

function buildSeries(name, rows, daily) {
  const mk = () => new Float64Array(N).fill(NaN);
  const k = { t: tGrid, open: mk(), high: mk(), low: mk(), close: mk(), qv: mk(), trades: mk(), buy: mk() };
  for (const r of rows) {
    const i = (r[0] - start) / STEP;
    if (!Number.isInteger(i) || i < 0 || i >= N) continue;
    k.open[i] = r[1]; k.high[i] = r[2]; k.low[i] = r[3]; k.close[i] = r[4]; k.qv[i] = r[5]; k.trades[i] = r[6]; k.buy[i] = r[7];
  }
  let first = -1, last = -1;
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(k.close[i])) { if (first < 0) first = i; last = i; continue; }
    if (first >= 0) { const c = k.close[i - 1]; k.open[i] = k.high[i] = k.low[i] = k.close[i] = c; k.qv[i] = k.trades[i] = k.buy[i] = 0; }
  }
  if (first < 0) return null;
  const ps = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) ps[i + 1] = ps[i] + (k.qv[i] || 0);
  const hc = { t: new Float64Array(H), high: new Float64Array(H).fill(NaN), low: new Float64Array(H).fill(NaN), qv: new Float64Array(H).fill(NaN) };
  for (let h = 0; h < H; h++) {
    hc.t[h] = start + h * HOUR;
    const a = h * 12;
    if (a < first) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = a; j < a + 12; j++) { hi = Math.max(hi, k.high[j]); lo = Math.min(lo, k.low[j]); }
    hc.high[h] = hi; hc.low[h] = lo; hc.qv[h] = ps[a + 12] - ps[a];
  }
  const prof = [], days = [];
  for (let d = 0; d < DAYS; d++) {
    const hs = (WARM + d) * 24;
    prof.push(hourlyProfile(hc, hs - 335, hs));
    const dayStart = sigStart + d * DAY, closed = daily.filter((r) => r[0] + DAY <= dayStart).slice(-40);
    days.push(closed.length >= 29 ? { closes: closed.map((r) => r[3]), highs: closed.map((r) => r[1]), qvols: closed.map((r) => r[4]) } : null);
  }
  return { name, k, first, last, ps, prof, days };
}
const qvSum = (s, a, b) => s.ps[b + 1] - s.ps[a];
const expSum = (prof, a, b) => { let x = 0; for (let j = a; j <= b; j++) x += prof.hours[hourOf(j)] / 12; return x; };
const ret = (s, i, back) => (s.k.close[i] / s.k.close[i - back] - 1) * 100;
function follow(s, i) {
  const k = s.k, entry = k.close[i], up = entry * (1 + T / 100), dn = entry * (1 - S / 100);
  if (i + HZ > s.last) return null; // not enough future data yet (or the coin stopped trading): left out
  for (let j = i + 1; j <= i + HZ; j++) {
    if (k.low[j] <= dn) return { o: "loss", r: (Math.min(dn, k.open[j]) / entry - 1) * 100 };
    if (k.high[j] >= up) return { o: "win", r: T, days: (j - i) / 288 };
  }
  return { o: "flat", r: (k.close[i + HZ] / entry - 1) * 100 };
}

// Every 5m ignition (two hot finished 5m candles, price up, buyers 52%+), one per coin per 24h, and whether the big-move
// tier would have fired. (The quick tiers have their own replay: screener-backtest.js.)
function replay(series) {
  const btc = series.find((s) => s.name === "BTC"), i0 = (sigStart - start) / STEP, P = DEFAULT_BIGMOVE, out = [], lastEv = new Map();
  for (let i = i0; i < N; i++) {
    const d = Math.floor((i - i0) / 288);
    if (i - 288 < btc.first) continue;
    for (const s of series) {
      s.r5 = null;
      const prof = s.prof[d];
      if (!prof || i - 288 < s.first || i > s.last || !s.days[d]) continue;
      const e = expSum(prof, i - 2, i);
      if (!(e > 0)) continue;
      s.r5 = s.k.qv[i] / (prof.hours[hourOf(i)] / 12); s.p5 = s.k.qv[i - 1] / (prof.hours[hourOf(i - 1)] / 12);
    }
    for (const s of series) {
      if (s.name === "BTC" || s.r5 == null || !(s.r5 >= P.r5 && s.p5 >= P.prevR5)) continue;
      const qv24 = qvSum(s, i - 287, i);
      if (qv24 < P.minVolume || i - (lastEv.get(s.name) ?? -1e9) < 288) continue;
      const e5 = { r5: s.r5, prevR5: s.p5, ret10: ret(s, i, 2), buy10: ((s.k.buy[i] + s.k.buy[i - 1]) / (s.k.qv[i] + s.k.qv[i - 1])) * 100 };
      if (!(e5.ret10 > 0 && e5.buy10 >= P.minBuy)) continue;
      lastEv.set(s.name, i);
      const tm = techMetrics(s.days[d], s.k.close[i], qv24);
      if (!tm) continue;
      const big = classifyBigMove({ quoteVolume: qv24, rvolD: tm.rvol, ...e5 }).state === "ignited";
      const o = follow(s, i);
      if (o) out.push({ s: s.name, t: tGrid[i], qv24, rvolD: tm.rvol, big, o });
    }
  }
  return out;
}

function stats(ev, cost = COST) {
  if (!ev.length) return { n: 0 };
  const w = ev.filter((e) => e.o.o === "win").length, l = ev.filter((e) => e.o.o === "loss").length;
  return { n: ev.length, coins: new Set(ev.map((e) => e.s)).size, hitPct: (w / ev.length) * 100, lossPct: (l / ev.length) * 100, net: mean(ev.map((e) => e.o.r)) - cost,
    daysToHit: mean(ev.filter((e) => e.o.o === "win").map((e) => e.o.days)) };
}
const fp = (v) => (v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%");
const cell = (s) => (s.n ? `${String(s.n).padEnd(5)} ${(s.hitPct.toFixed(1) + "%").padEnd(6)} ${fp(s.net).padEnd(7)}` : "—".padEnd(19));
const month = (e) => new Date(e.t).toISOString().slice(0, 7);

async function main() {
  console.log(`Big-move tier replay: ${DAYS} days to ${new Date(end).toISOString().slice(0, 10)}, +${T}% before -${S}% within ${HZ / 288} days, fees + slippage ${COST}% per trade`);
  const syms = await pickSymbols();
  console.log(`Downloading 5m candles for ${syms.length} coins (cached in ./backtest_cache)…`);
  let done = 0, cur = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (cur < syms.length) {
      const sym = syms[cur++];
      try { await klines5m(sym); await klines1d(sym); } catch (e) { console.log(`\n  skipped ${sym}: ${e.message}`); }
      if (++done % 25 === 0) process.stdout.write(`\r  ${done}/${syms.length}`);
    }
  }));
  const series = [];
  for (const sym of syms) { try { const s = buildSeries(sym, await klines5m(sym), await klines1d(sym)); if (s) series.push(s); } catch { /* skipped above */ } }
  console.log(`\nReplaying ${series.length} coins…`);
  const ev = replay(series).sort((a, b) => a.t - b.t);
  const split = sigStart + Math.round((DAYS * 2) / 3) * DAY, months = [...new Set(ev.map(month))].sort();
  console.log(`${ev.length} signals with a full ${HZ / 288}-day outcome (5m ignitions on coins with ${DEFAULT_BIGMOVE.minVolume / 1e6}M+ of 24h volume at the time, one per coin per day).`);
  console.log(`Columns: signals / hit +${T}% before -${S}% / average result per trade after costs. Older = before ${new Date(split).toISOString().slice(0, 10)}.\n`);
  console.log(`${"".padEnd(52)} ${"older".padEnd(19)} ${"newer".padEnd(19)} ${months.map((m) => m.padEnd(19)).join(" ")} costs 0.8%`);
  const row = (name, sel) => console.log(`${name.padEnd(52)} ${cell(stats(sel.filter((e) => e.t < split)))} ${cell(stats(sel.filter((e) => e.t >= split)))} ${months.map((m) => cell(stats(sel.filter((e) => month(e) === m)))).join(" ")} ${fp(stats(sel, 0.8).net)}`);
  const P = DEFAULT_BIGMOVE;
  row("all 5m ignitions", ev);
  row(`BIG-MOVE TIER (24h vol ${P.minDailyRvol}x+ normal, $${P.minVolume / 1e6}-${P.maxVolume / 1e6}M)`, ev.filter((e) => e.big));
  console.log("\nSensitivity (daily volume vs 20-day average x size):");
  for (const rv of [1.3, 1.5, 2, 2.5]) for (const mx of [5e6, 10e6, 20e6]) row(`  ${rv}x+ normal, $${P.minVolume / 1e6}-${mx / 1e6}M`, ev.filter((e) => e.rvolD >= rv && e.qv24 <= mx));
  const b = ev.filter((e) => e.big), older = stats(b.filter((e) => e.t < split)), newer = stats(b.filter((e) => e.t >= split));
  const byMonth = months.map((m) => stats(b.filter((e) => month(e) === m))).filter((x) => x.n >= 20);
  console.log("\nVERDICT");
  if (older.n >= 30 && newer.n >= 30 && older.net > 0 && newer.net > 0 && byMonth.every((x) => x.net > 0)) console.log(`  The big-move tier made money in every month with 20+ signals (older ${fp(older.net)}, newer ${fp(newer.net)} per trade). Still check the live results before trading it with size.`);
  else console.log(`  Not a proven edge: older ${fp(older.net)} over ${older.n} signals, newer ${fp(newer.net)} over ${newer.n}${byMonth.some((x) => x.net <= 0) ? ", and at least one month lost money" : ""}. It depends on the market; treat its alerts as research.`);
  await writeFile(path.join(here, "bigmove_report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), days: DAYS, rule: { targetPct: T, stopPct: S, hours: HZ / 12 }, costPct: COST, tier: P,
    summary: { all: stats(ev), bigmove: stats(b), older, newer, byMonth: Object.fromEntries(months.map((m) => [m, stats(b.filter((e) => month(e) === m))])) },
    signals: b.map((e) => ({ coin: e.s, time: new Date(e.t).toISOString(), volume24h: Math.round(e.qv24), dailyRvol: +e.rvolD.toFixed(2), outcome: e.o.o, resultPct: +e.o.r.toFixed(2) })) }, null, 1));
  console.log("Full results saved to bigmove_report.json");
}
await main();

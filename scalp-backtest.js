// Test of the Scalp tab's flush-bounce setup (scalp.js, the same code as the live tab) on every 5-minute candle of the
// 50 most liquid Binance USDⓈ-M perpetuals of each month. Node.js 18+, no dependencies.
//
//   node scalp-backtest.js                      # July 2024 to the last complete month
//   node scalp-backtest.js --from 2025-01
//
// Data: Binance's public archive (data.binance.vision), no API key, works where the futures API is blocked. The coins
// of each month are the 50 most liquid by the 30 days before it (perps-history.js), delisted ones included. The first
// run downloads about 1,800 monthly files (about 650 MB, cached in perps_cache/).
// Every signal: buy at the next candle's open, stop under the flush low, target 1.5x the risk, else sell after 1 hour;
// a candle touching both = the stop; 0.12% fees per trade. Also shown: entering one candle (5 minutes) late, a worse
// fill with higher fees, the same setup on calm coins, and the short version. Writes scalp_report.json, which the
// Scalp tab shows (until then it shows the copy in data/). Past results do not guarantee future results.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistory, monthKlines } from "./perps-history.js";
import { SCALP, scalpSeries, flushBounce, scalpTrade } from "./scalp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const FROM = arg("from", "2024-07"), SPLIT = arg("split", "2025-10");
const M5 = 300_000;
const add = (m, k) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7); };
const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

const hist = await loadHistory({ from: add(FROM, -2), top: SCALP.top, metrics: false, log: (m) => console.log(m) });
const months = hist.months.filter((m) => m >= FROM && hist.universe[m]);
const coins = new Map(); // sym -> months it was in the top 50
for (const m of months) for (const s of hist.universe[m]) (coins.get(s) || coins.set(s, new Set()).get(s)).add(m);
console.log(`${months[0]} to ${months.at(-1)}: ${coins.size} coins were in the top ${SCALP.top}; reading 5-minute candles…`);

const trades = [], late = [], worse = [], calm = [], short = [];
let done = 0;
const files = [...coins].flatMap(([s, ms]) => [...new Set([...ms].flatMap((m) => [add(m, -1), m]))].map((m) => [s, m]));
{ let i = 0; await Promise.all(Array.from({ length: 16 }, async () => { while (i < files.length) { const [s, m] = files[i++]; await monthKlines(s, "5m", m); if (++done % 200 === 0) console.log(`  ${done}/${files.length} files`); } })); }
const sim = (B, i, e, stop, from, cost, dir = 1) => { const risk = dir * (e - stop); if (!(risk > 0)) return null; const tp = e + dir * SCALP.targetR * risk;
  for (let j = from; j <= i + SCALP.holdCandles; j++) { if (dir > 0 ? B[j].l <= stop : B[j].h >= stop) return dir * (stop / e - 1) * 100 - cost; if (dir > 0 ? B[j].h >= tp : B[j].l <= tp) return dir * (tp / e - 1) * 100 - cost; }
  return dir * (B[i + SCALP.holdCandles].c / e - 1) * 100 - cost; };
for (const [sym, ms] of coins) {
  const rows = [];
  for (const m of [...new Set([...ms].flatMap((x) => [add(x, -1), x]))].sort()) rows.push(...(await monthKlines(sym, "5m", m)));
  rows.sort((a, b) => a[0] - b[0]);
  const bars = rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]).map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], qv: r[5] }));
  const x = scalpSeries(bars), B = bars;
  let busy = 0, busyCalm = 0, busyShort = 0;
  for (let i = 300; i < B.length - SCALP.holdCandles - 2; i++) {
    if (!ms.has(monthOf(B[i].t))) continue;
    if (i >= busy) {
      const s = flushBounce(x, i);
      if (s) {
        const r = scalpTrade(x, i, s.stop);
        if (r.done && r.why !== "gap") {
          busy = i + SCALP.holdCandles;
          trades.push({ sym, t: B[i].t, netPct: r.netPct, why: r.why, riskPct: (1 - s.stop / r.entry) * 100 });
          late.push(sim(B, i, B[i + 1].c, s.stop, i + 2, SCALP.costPct) ?? -((B[i + 1].c - s.stop) / B[i + 1].c) * 100 - SCALP.costPct);
          const w = sim(B, i, r.entry * 1.003, s.stop, i + 1, 0.2); if (w != null) worse.push(w);
        }
      }
    }
    // the same setup on calm coins (normal 5m range under the 0.6% floor)
    if (i >= busyCalm) { const s = flushBounce(x, i, { ...SCALP, minAtrPct: 0 }); if (s && s.atrPct < SCALP.minAtrPct) { const v = sim(B, i, B[i + 1].o, s.stop, i + 1, SCALP.costPct); if (v != null) { calm.push(v); busyCalm = i + SCALP.holdCandles; } } }
    // the short version: a spike up on volume, then a red candle back under its middle
    if (i >= busyShort && i > 22) {
      const f = B[i - 1], b = B[i], pa = x.atr[i - 2];
      if (pa > 0 && (f.c - f.o) / pa >= SCALP.minDropAtr && x.vr[i - 1] >= SCALP.minVolRatio && (pa / B[i - 2].c) * 100 >= SCALP.minAtrPct && b.c < b.o && b.c < (f.o + f.c) / 2) {
        const v = sim(B, i, B[i + 1].o, Math.max(f.h, b.h) + SCALP.stopPadAtr * x.atr[i], i + 1, SCALP.costPct, -1); if (v != null) { short.push(v); busyShort = i + SCALP.holdCandles; }
      }
    }
  }
}
const stats = (v) => { if (!v.length) return { n: 0 }; const s = [...v].sort((a, b) => a - b);
  return { n: v.length, avgPct: r2(v.reduce((a, b) => a + b, 0) / v.length, 3), medianPct: r2(s[v.length >> 1], 2), winPct: r2((v.filter((x) => x > 0).length / v.length) * 100, 0) }; };
const block = (ts) => { const s = stats(ts.map((t) => t.netPct)); if (!s.n) return s;
  const by = new Map(); for (const t of ts) by.set(t.sym, (by.get(t.sym) || 0) + t.netPct); const tot = [...by.values()].reduce((a, b) => a + b, 0);
  const top3 = [...by.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const R = ts.map((t) => t.netPct / t.riskPct);
  return { ...s, avgR: r2(R.reduce((a, b) => a + b, 0) / R.length, 3), coins: by.size, targets: ts.filter((t) => t.why === "target").length, stops: ts.filter((t) => t.why === "stop").length, top3SharePct: tot > 0 ? r2((top3 / tot) * 100, 0) : null }; };
trades.sort((a, b) => a.t - b.t);
const splitT = Date.parse(`${SPLIT}-01T00:00:00Z`);
// account curve risking 1% per trade (a trade's result in R = its % result / its stop distance)
let eq = 0, pk = 0, dd = 0, streak = 0, worst = 0;
for (const t of trades) { eq += t.netPct / t.riskPct; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); streak = t.netPct < 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
const byMonth = new Map(); for (const t of trades) { const m = monthOf(t.t); (byMonth.get(m) || byMonth.set(m, []).get(m)).push(t.netPct); }
const risks = trades.map((t) => t.riskPct).sort((a, b) => a - b);
const report = {
  generatedAt: new Date().toISOString(), from: months[0], to: months.at(-1), split: SPLIT, coins: new Set(trades.map((t) => t.sym)).size, rule: SCALP,
  all: { ...block(trades), perMonth: r2(trades.length / months.length, 1), totalR: r2(eq, 1), maxDrawdownR: r2(dd, 1), longestLosingStreak: worst, medianRiskPct: r2(risks[risks.length >> 1], 2), p90RiskPct: r2(risks[Math.floor(risks.length * 0.9)], 2) },
  older: block(trades.filter((t) => t.t < splitT)), newer: block(trades.filter((t) => t.t >= splitT)),
  late: stats(late), worse: stats(worse), calm: stats(calm), short: stats(short),
  months: [...byMonth].map(([m, v]) => ({ m, n: v.length, avgPct: r2(v.reduce((a, b) => a + b, 0) / v.length, 2) })),
  recent: trades.slice(-30).reverse().map((t) => ({ sym: t.sym, t: t.t, netPct: r2(t.netPct, 2), why: t.why })),
};
await writeFile(path.join(here, "scalp_report.json"), JSON.stringify(report, null, 1));
const f = (s) => (s.n ? `${String(s.n).padStart(5)} trades, avg ${(s.avgPct >= 0 ? "+" : "") + s.avgPct.toFixed(2)}% per trade${s.avgR != null ? ` (${(s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(2)}R)` : ""}, ${s.winPct}% won${s.coins ? `, ${s.coins} coins, top 3 coins ${s.top3SharePct ?? "—"}% of the profit` : ""}` : "none");
console.log(`\nFlush bounce, ${report.from} to ${report.to}, after ${SCALP.costPct}% fees per trade:`);
console.log(`  all             ${f(report.all)}`);
console.log(`  before ${SPLIT}  ${f(report.older)}`);
console.log(`  from ${SPLIT}    ${f(report.newer)}`);
console.log(`  5 minutes late  ${f(report.late)}`);
console.log(`  worse fill +0.3%, 0.2% fees  ${f(report.worse)}`);
console.log(`  calm coins (not used)  ${f(report.calm)}`);
console.log(`  short version (not used)  ${f(report.short)}`);
console.log(`  months in profit: ${report.months.filter((m) => m.avgPct > 0).length}/${report.months.length} · stop distance median ${report.all.medianRiskPct}% · longest losing streak ${worst}`);
console.log(`  risking 1% of the account per trade: ${r2(eq, 1)}% in total, worst drop ${r2(dd, 1)}% of the account`);
console.log("\nSaved scalp_report.json.");

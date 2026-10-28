// BTC-regime narrative rotation backtest: command-line report. Node.js 18+, no dependencies.
//
//   node rotation-backtest.js                 # ~1000 days of daily candles (about 2.7 years)
//   node rotation-backtest.js --days 1500     # longer history (newer coins simply start later)
//   node rotation-backtest.js --hold 14       # rebalance every 14 days instead of 7
//   node rotation-backtest.js --refresh       # ignore the download cache
//
// Uses exactly the code behind the "BTC rotation" tab (rotation.js), so this report and the tab always agree.
// Only Binance data, no API key: narratives are Binance's sector tags, candles are Binance daily klines.
// Downloads are cached in ./rotation_cache (one file per coin, refreshed daily). Research tool, not financial advice.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SCREENER_LIBRARY_ONLY = "1";
const core = await import("./screener.js");
const { loadHistory, analyze, REGIMES, REGIME_KEYS } = await import("./rotation.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const DAYS = Math.min(2000, Math.max(300, Number(arg("days", 1000)) || 1000));
const HOLD = Math.min(30, Math.max(3, Number(arg("hold", 7)) || 7));
const row = (cells, widths) => cells.map((c, j) => String(c ?? "—").padEnd(widths[j])).join(" ");
const pct = (v, d = 1) => (v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(d) + "%");

const data = await loadHistory({
  fetchJson: core.fetchJson, usedWeight: core.usedWeight, cacheDir: path.join(here, "rotation_cache"), days: DAYS,
  stables: core.STABLES, nonCrypto: core.NONCRYPTO, refresh: argv.includes("--refresh"),
  getNarratives: (prices) => core.binanceNarratives(prices),
  only: (process.env.ROTATION_NARRATIVES || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
  onProgress: (step, done, total) => process.stdout.write(`\r${step}: ${done}/${total}      `),
});
const r = analyze(data, { holdDays: HOLD, feePct: core.CONFIG.feePct });
if (data.failed?.length) console.log(`\n(${data.failed.length} coins could not be downloaded and were skipped: ${data.failed.slice(0, 12).join(", ")})`);
console.log(`\n\nBTC ROTATION BACKTEST · history ${r.historyFrom} to ${r.asOf} · ${r.coverage.narratives} narratives, ${r.coverage.tokens} coins · hold ${HOLD} days · fees ${r.feePct}% per round trip\n`);

console.log("BTC NOW");
console.log(`  ${r.regimeNow ? r.regimeNow.label + ": " + r.regimeNow.desc : "not enough history"}`);
if (r.btc) console.log(`  7d ${pct(r.btc.ret7)} · 30d ${pct(r.btc.ret30)} · vs 20d avg ${pct(r.btc.vsSma20)} · vs 50d avg ${pct(r.btc.vsSma50)}`);
const rs = r.regimeStats;
if (rs?.now) console.log(`  Day ${rs.ageDays} of this regime; it usually lasts ${rs.medianDays[rs.now] ?? "?"} days (median). ${HOLD} days later it was: ${Object.entries(rs[`in${HOLD}Days`] || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${REGIMES[k].label.replace("BTC ", "")} ${v}%`).join(", ")}`);
const a = r.altSeason;
if (a) console.log(`\nALT SEASON METER: ${a.label}. ETH/BTC ${pct(a.ethBtc30)} in 30 days (trend ${a.ethTrend > 0 ? "up" : a.ethTrend < 0 ? "down" : "flat"}) · median narrative ${pct(a.altVsBtc30)} vs BTC over 30 days · ${a.breadthPct ?? "—"}% of coins above their 20-day average`);
console.log(`  Time BTC spent in each regime (weeks): ${REGIME_KEYS.map((k) => `${(REGIMES[k].label.replace("BTC ", "")[0].toUpperCase() + REGIMES[k].label.replace("BTC ", "").slice(1))} ${r.heatmap.regimeWeeks[k]}`).join(" · ")}`);

if (r.backtest) {
  const b = r.backtest, W = [58, 9, 8, 9, 7, 10, 8, 10, 10];
  console.log(`\nSTRATEGIES, ${b.from} to ${b.to} (${b.weeks} rebalances; regime statistics only from weeks that had finished)`);
  console.log(row(["Strategy", "Total", "Yearly", "Worst DD", "Sharpe", "Beat BTC", "Cash", "Older half", "Newer half"], W));
  for (const s of b.strategies) console.log(row([s.label, pct(s.totalPct, 0), pct(s.cagrPct, 0), pct(s.maxDdPct, 0), s.sharpe, s.beatBtcPct + "% wk", s.cashPct + "%", pct(s.olderPct, 0), pct(s.newerPct, 0)], W));
  for (const v of b.strategies.filter((s) => /^(combined|tokens)./.test(s.key))) {
    const base = b.strategies.find((s) => s.key === v.key.replace(/(Alt|Flow)$/, ""));
    const both = v.olderPct > base.olderPct && v.newerPct > base.newerPct;
    console.log(`  ${v.label}: ${both ? "better than the current ranking in BOTH halves" : "not better in both halves"} (older ${pct(v.olderPct, 0)} vs ${pct(base.olderPct, 0)}, newer ${pct(v.newerPct, 0)} vs ${pct(base.newerPct, 0)})`);
  }
} else console.log("\nNot enough history to backtest (needs about 300 days of narrative data).");

console.log(`\nBEST NARRATIVE PER BTC REGIME (average ${HOLD}-day return vs BTC, all history)`);
const W2 = [22, 18, 10, 8, 8, 10];
console.log(row(["BTC regime", "Narrative", "Avg vs BTC", "Hit", "Weeks", "Confidence"], W2));
for (const k of REGIME_KEYS) {
  const x = r.heatmap.bestByRegime[k];
  console.log(row([(REGIMES[k].label.replace("BTC ", "")[0].toUpperCase() + REGIMES[k].label.replace("BTC ", "").slice(1)), x?.name ?? "not enough data", pct(x?.avgPct, 2), x ? x.hitPct + "%" : "", x?.weeks, x?.confidence], W2));
}

console.log(`\nNARRATIVE RANKING NOW (${r.regimeNow?.label ?? "—"})`);
const W3 = [4, 18, 6, 14, 8, 10, 9, 8, 12, 9];
console.log(row(["#", "Narrative", "Score", "This regime", "Weeks", "14d vs BTC", "Breadth", "Trend", "Money flow", "Stage"], W3));
for (const x of r.ranking.slice(0, 12)) console.log(row([x.rank, x.name, x.score, pct(x.regimeStat?.avgPct, 2) + (x.regimeStat ? ` (${x.regimeStat.hitPct}%)` : ""), x.regimeStat?.weeks, pct(x.mom14), x.breadthPct + "%", x.trend ? "up" : "down",
  x.volShare7Pct == null ? "—" : `${x.volShare7Pct}% ${x.flow >= 1.1 ? "↑" : x.flow <= 0.9 ? "↓" : "→"}`, x.stage], W3));
console.log(`\nThe backtested rule would hold now: narratives ${r.holdingsNow.combined.join(", ")} · coins ${r.holdingsNow.tokens.join(", ")}`);

console.log("\nTOKEN PICKS IN THE TOP 3 NARRATIVES (daily price action)");
const W4 = [10, 22, 6, 11, 11, 10, 8];
console.log(row(["Coin", "Narrative", "Score", "14d vs BTC", "vs 30d high", "Vol trend", "Buy rule"], W4));
for (const t of r.picks.slice(0, 15)) console.log(row([t.base, t.narratives.join(", ").slice(0, 21), t.score, pct(t.rs14), pct(t.distHigh), t.volTrend == null ? "—" : t.volTrend + "x", t.inStrategy ? "yes" : ""], W4));

console.log("\nREAD THIS BEFORE USING IT");
console.log("  Narrative lists and Binance listings are today's: coins that died or were delisted are missing, and coins that joined a");
console.log("  narrative later count for its whole history. Both make narratives look better than they were. Regimes with few weeks or");
console.log("  'low' confidence are mostly noise. Nothing was tuned to fit this result, but past rotations may not repeat.");
await writeFile(path.join(here, "rotation_report.json"), JSON.stringify(r, null, 1));
console.log("Full report saved to rotation_report.json. Research tool, not financial advice.");
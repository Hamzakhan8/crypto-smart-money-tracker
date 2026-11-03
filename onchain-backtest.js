// Backtest of the On-chain tab's "crowd vs smart money" setups (onchain.js) on Binance's public archive: the 50 most
// liquid USDⓈ-M perpetuals of each month since December 2021 (delisted coins included), 4h candles joined to Binance's
// own long/short ratios (all accounts = the crowd, top-trader positions = smart money). Node.js 18+, no API key.
//
//   node onchain-backtest.js                 # writes onchain_report.json (shown on the On-chain tab)
//   node onchain-backtest.js --split 2025-01 # older period = before, newer = from this month on
//
// Uses the same cache as perps-backtest.js (./perps_cache): the first run downloads 1-2 GB, later runs are fast.
// Honest by design: entry at the next 4h open after the signal bar closes, 0.16% fees and slippage in and out, a bar
// touching stop and target counts as the stop, and every rule is compared with random trades in the same coins.
// Funding payments are not counted (in these setups they usually go to the signal's side). Research, not advice.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistory, coinData, monthOf } from "./perps-history.js";
import { CROWD, positioning, crowdSetup, crowdTrade, structure, percentileOf, atrAt } from "./onchain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const TOP = Number(arg("top", 50)), SPLIT = arg("split", "2025-01"), splitT = Date.parse(`${SPLIT}-01T00:00:00Z`);
const H4 = 14_400_000;
const LIVE = { ...CROWD, sides: ["long", "short"] };
const SWING = { ...LIVE, stopAtr: 1.5, targetAtr: 3, holdBars: 42 }; // the other exit tested: 2R target, 7 days

// Rules: the two live setups, looser versions, and random trades (every 24h) as the yardstick.
const RULES = [
  { key: "long", label: "LONG: crowd short (accounts ≤ 0.5), top traders long (≥ 1.2)", live: true, side: 1, f: (x) => crowdSetup(x.pos, x.sx, LIVE)?.side === 1 },
  { key: "short", label: "SHORT: crowd long (top 10% of its 30 days), top traders not long (≤ 1), lower highs", live: true, side: -1, f: (x) => crowdSetup(x.pos, x.sx, LIVE)?.side === -1 },
  { key: "longLoose", label: "Looser long: accounts ≤ 0.7, top traders ≥ 1", side: 1, f: (x) => x.acc <= 0.7 && x.top >= 1 },
  { key: "shortNoStructure", label: "Short without the lower-highs check", side: -1, f: (x) => x.pos.state === "crowdLong" },
  { key: "randomLong", label: "Random longs (same coins, every 24h)", side: 1, f: (x) => x.i % 6 === 0, base: true },
  { key: "randomShort", label: "Random shorts (same coins, every 24h)", side: -1, f: (x) => x.i % 6 === 0, base: true },
];
const hist = await loadHistory({ top: TOP, log: (m) => console.log(m) });
const out = Object.fromEntries(RULES.map((r) => [r.key, []]));
let coins = 0, done = 0;
for (const sym of hist.chosen) {
  const { bars } = await coinData(sym, hist.monthsOf(sym), hist.daily);
  if (++done % 50 === 0) console.log(`  ${done}/${hist.chosen.length} coins`);
  if (bars.length < 300) continue;
  coins++;
  const last = Object.fromEntries(RULES.map((r) => [r.key, -1e9]));
  for (let i = 200; i < bars.length - LIVE.holdBars - 2; i++) {
    const b = bars[i];
    if (!(b.acc > 0 && b.top > 0) || bars[i + 1].t - b.t !== H4 || !(hist.universe[monthOf(b.t)] || []).includes(sym)) continue;
    const before = []; for (let j = i - 180; j < i; j++) if (bars[j].t >= b.t - 30 * 86_400_000) before.push(bars[j].acc); // the 30 days before (as live)
    const x = { i, acc: b.acc, top: b.top, sx: structure(bars, i) };
    x.pos = positioning({ acc: b.acc, top: b.top, accPct: percentileOf(before, b.acc) }, LIVE);
    const a = atrAt(bars, i);
    if (!(a > 0)) continue;
    for (const r of RULES) {
      if (i - last[r.key] < LIVE.cooldownBars || !r.f(x)) continue;
      const t1 = crowdTrade(bars, i, r.side, LIVE, a), t2 = i + SWING.holdBars + 2 < bars.length ? crowdTrade(bars, i, r.side, SWING, a) : null;
      if (!t1.done) continue;
      last[r.key] = i;
      out[r.key].push({ sym, t: b.t, live: t1.netPct, swing: t2?.done ? t2.netPct : null, why: t1.why });
    }
  }
}
const st = (a, k = "live") => { const v = a.map((x) => x[k]).filter((y) => y != null); return v.length ? { n: v.length, avg: +(v.reduce((s, y) => s + y, 0) / v.length).toFixed(2), win: Math.round((v.filter((y) => y > 0).length / v.length) * 100) } : { n: 0 }; };
const rules = RULES.map((r) => {
  const a = out[r.key], o = a.filter((x) => x.t < splitT), nw = a.filter((x) => x.t >= splitT), base = out[r.side > 0 ? "randomLong" : "randomShort"];
  const all = st(a), older = st(o), newer = st(nw), bo = st(base.filter((x) => x.t < splitT)), bn = st(base.filter((x) => x.t >= splitT));
  const beats = !r.base && older.n && newer.n && older.avg > bo.avg && newer.avg > bn.avg, holds = older.n >= 20 && newer.n >= 20 && older.avg > 0 && newer.avg > 0;
  return { key: r.key, label: r.label, live: !!r.live, side: r.side, all, older, newer, swing: { all: st(a, "swing"), older: st(o, "swing"), newer: st(nw, "swing") },
    verdict: r.base ? "the yardstick" : holds && beats ? "holds: made money in both periods and beat random trades" : beats ? "beats random trades in both periods, but lost money in one" : holds ? "made money in both, but not better than random trades in one" : "does not hold",
    note: r.base ? "what no skill earned" : null };
});
const fmt = (s) => (s.n ? `${String(s.n).padStart(5)} ${s.avg >= 0 ? "+" : ""}${s.avg.toFixed(2)}% win ${s.win}%` : "    0");
console.log(`\nCrowd vs smart money, ${hist.from} to ${hist.to}, ${coins} coins. Exit: stop ${LIVE.stopAtr} ATR, close after ${LIVE.holdBars / 6} days. Before ${SPLIT} | from ${SPLIT}`);
for (const r of rules) console.log(`${r.label.slice(0, 70).padEnd(72)} | ${fmt(r.older)} | ${fmt(r.newer)} | 7-day 2R exit: ${fmt(r.swing.older)} | ${fmt(r.swing.newer)} | ${r.verdict}`);
const report = { generatedAt: new Date().toISOString(), from: hist.from, to: hist.to, top: TOP, coins, split: SPLIT, costPct: LIVE.costPct,
  exit: { stopAtr: LIVE.stopAtr, targetAtr: LIVE.targetAtr, holdBars: LIVE.holdBars }, rules,
  note: "Be careful with these numbers: the 3-day exit was chosen after a first look at the same history (a 2R target with 7 days did worse for the long in 2025-26), the long had only 37 signals before 2025, and funding is not counted. The live results above are the real test.",
  recent: [...out.long, ...out.short].sort((x, y) => y.t - x.t).slice(0, 20) };
await writeFile(path.join(here, "onchain_report.json"), JSON.stringify(report, null, 1));
console.log("\nSaved to onchain_report.json");

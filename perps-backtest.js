// Backtest of swing-trade setups on Binance USDⓈ-M perpetuals, long and short (perps.js), on years of history from
// Binance's public archive (perps-history.js). Node.js 18+, no dependencies, no API key.
//
//   node perps-backtest.js                         # Dec 2021 to last month, the 50 most liquid perps of each month
//   node perps-backtest.js --top 30 --cost 0.1     # fewer coins; fee + slippage per side in %
//   node perps-backtest.js --split 2025-01         # older period = before, newer period = from this month on
//   node perps-backtest.js --no-oi                 # quick first look without open interest (no flush / crowded setups)
//
// The first run downloads about 1-2 GB (an hour or more); everything is cached in ./perps_cache, so later runs only
// fetch the new month. The result goes to perps_report.json (shown on the Perps tab) and a summary here.
//
// Honest by design: coins are picked by their liquidity AT THE TIME (delisted coins included); entries at the next 4h
// open after a closed candle; fees, slippage and every funding payment counted; a candle touching stop and target is a
// loss. A setup "holds" only if it made money in both the older and the newer period. Research tool, not advice.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHistory, coinData, monthOf } from "./perps-history.js";
import * as P from "./perps.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const TOP = Number(arg("top", 50)), COST = Number(arg("cost", 0.08)), SPLIT = arg("split", "2025-01"), MAX_OPEN = Number(arg("max-open", 5));
const FROM = arg("from", "2021-12"), TO = arg("to", undefined);
const H4 = 14_400_000, DAY = 86_400_000;
const splitT = Date.parse(`${SPLIT}-01T00:00:00Z`);
const log = (m) => console.log(m);

const hist = await loadHistory({ from: FROM, to: TO, top: TOP, log, metrics: !argv.includes("--no-oi") });

// BTC regime after each daily close: up (close over the 50-day EMA, 20 over 50), down (both under), else mixed.
const btcD = (hist.daily.get("BTCUSDT") || []).map((d) => ({ t: d[0], c: d[4] }));
const be20 = P.ema(btcD.map((d) => d.c), 20), be50 = P.ema(btcD.map((d) => d.c), 50);
const regimeAfter = new Map(btcD.map((d, k) => [d.t + DAY, !be50[k] ? null : d.c > be50[k] && be20[k] > be50[k] ? "up" : d.c < be50[k] && be20[k] < be50[k] ? "down" : "mixed"]));
const regimeAt = (tClose) => regimeAfter.get(Math.floor(tClose / DAY) * DAY) ?? null;

// Strength vs BTC: each day, the month's liquid coins ranked by 30-day return minus BTC's (1 = strongest).
const closeOn = new Map(); // sym -> Map(dayStart -> close)
for (const [sym, rows] of hist.daily) closeOn.set(sym, new Map(rows.map((r) => [r[0], r[4]])));
const rsCache = new Map();
function rsAt(tClose, sym) {
  const day = Math.floor(tClose / DAY) * DAY - DAY; // the daily candle that just closed
  let ranks = rsCache.get(day);
  if (!ranks) {
    const list = hist.universe[monthOf(day)] || [], btc = closeOn.get("BTCUSDT"), b0 = btc?.get(day - 30 * DAY), b1 = btc?.get(day);
    const rows = [];
    for (const s of list) { const m = closeOn.get(s), a = m?.get(day - 30 * DAY), b = m?.get(day); if (a > 0 && b > 0 && b0 > 0 && b1 > 0) rows.push([s, b / a - b1 / b0]); }
    rows.sort((x, y) => y[1] - x[1]);
    ranks = new Map(rows.map(([s], k) => [s, { rank: k + 1, n: rows.length }]));
    rsCache.set(day, ranks);
  }
  return ranks.get(sym) || null;
}

// ───────────────────────────── run every coin ─────────────────────────────
const endD = new Date(`${hist.to}-01T00:00:00Z`); endD.setUTCMonth(endD.getUTCMonth() + 1);
const dataEnd = endD.getTime(); // where the history ends: a coin's candles stopping before this means it was delisted
const trades = []; // { setup, dir, rule, ...trade, f }
let coinsDone = 0, signals = 0;
for (const sym of hist.chosen) {
  const months = hist.monthsOf(sym);
  if (!months.length) continue;
  const s = P.prepare(await coinData(sym, months, hist.daily));
  const openUntil = new Map();
  for (let i = 0; i < s.bars.length - 1; i++) {
    const b = s.bars[i], tClose = b.t + H4;
    if (!hist.universe[monthOf(b.t)]?.includes(sym)) continue; // only while it was among the most liquid
    const ctx = { btcRegime: regimeAt(tClose), rs: tClose % DAY === 0 ? rsAt(tClose, sym) : null, dayClose: tClose % DAY === 0 };
    const sigs = P.signalsAt(s, i, ctx);
    if (!sigs.length) continue;
    const f = P.features(s, i, ctx);
    for (const sig of sigs) {
      signals++;
      for (const [rule, ex] of Object.entries(P.EXITS)) {
        const key = `${sig.setup}|${sig.dir}|${rule}`;
        if ((openUntil.get(key) || 0) > s.bars[i + 1].t) continue; // one position per coin, setup, side and exit rule
        const t = P.simulate(s, { i, dir: sig.dir, stop: sig.stop }, ex, COST, dataEnd);
        if (!t) continue;
        openUntil.set(key, t.exitT);
        trades.push({ setup: sig.setup, rule, f, ...t });
      }
    }
  }
  if (++coinsDone % 50 === 0) log(`  simulated ${coinsDone}/${hist.chosen.length} coins, ${trades.length} trades`);
}

// ───────────────────────────── report ─────────────────────────────
const side = (d) => (d > 0 ? "long" : "short");
const GROUPS = [
  ["BTC trend with the trade", (t) => t.f.btc === (t.dir > 0 ? "up" : "down")],
  ["BTC trend against the trade", (t) => t.f.btc === (t.dir > 0 ? "down" : "up")],
  ["Daily trend with the trade", (t) => t.f.dTrend === (t.dir > 0 ? "up" : "down")],
  ["Open interest rising (+3% in 24h)", (t) => t.f.oi24h >= 0.03],
  ["Open interest falling (-3% in 24h)", (t) => t.f.oi24h != null && t.f.oi24h <= -0.03],
  ["Crowd on the other side (funding against the trade)", (t) => t.f.fund8h != null && (t.dir > 0 ? t.f.fund8h < 0 : t.f.fund8h > 0.01)],
  ["Crowd on the same side (funding in its top/bottom 20%)", (t) => t.f.fundPct != null && (t.dir > 0 ? t.f.fundPct >= 0.8 : t.f.fundPct <= 0.2)],
  ["Top traders more on the trade's side than everyone", (t) => t.f.topVsAcc != null && (t.dir > 0 ? t.f.topVsAcc > 1.05 : t.f.topVsAcc < 0.95)],
  ["Volume 2x its average", (t) => t.f.vol >= 2],
  ["Coin strong vs BTC (top 10) / weak (bottom 10) for shorts", (t) => t.f.rs && (t.dir > 0 ? t.f.rs.rank <= 10 : t.f.rs.rank > t.f.rs.n - 10)],
];
const pick = (setup, dir, rule) => trades.filter((t) => t.setup === setup && t.dir === dir && t.rule === rule);
const years = [...new Set(trades.map((t) => new Date(t.t).getUTCFullYear()))].sort();
const report = { generatedAt: Date.now(), from: hist.from, to: hist.to, split: SPLIT, top: TOP, costPctPerSide: COST, maxOpen: MAX_OPEN,
  coins: hist.chosen.length, signals, setups: P.SETUPS, exits: Object.fromEntries(Object.entries(P.EXITS).map(([k, v]) => [k, v.label])), results: [] };
for (const setup of Object.keys(P.SETUPS)) for (const dir of [1, -1]) {
  const main = pick(setup, dir, "main");
  if (!main.length) continue;
  const train = P.summary(main.filter((t) => t.t < splitT)), test = P.summary(main.filter((t) => t.t >= splitT));
  const rules = {};
  for (const rule of Object.keys(P.EXITS)) {
    const all = pick(setup, dir, rule), tr = P.summary(all.filter((t) => t.t < splitT)), te = P.summary(all.filter((t) => t.t >= splitT));
    rules[rule] = { all: P.summary(all), older: tr, newer: te, ...P.verdict(tr, te) };
  }
  const groups = GROUPS.map(([name, fn]) => {
    const g = main.filter((t) => { try { return fn(t); } catch { return false; } });
    const o = P.summary(g.filter((t) => t.t < splitT)), n = P.summary(g.filter((t) => t.t >= splitT));
    return { name, trades: g.length, avgR: P.summary(g).avgR ?? null, olderR: o.avgR ?? null, newerR: n.avgR ?? null,
      holds: o.trades >= 30 && n.trades >= 15 && o.avgR > (train.avgR ?? 0) && n.avgR > (test.avgR ?? 0) ? "better in both" : o.trades >= 30 && n.trades >= 15 && o.avgR < (train.avgR ?? 0) && n.avgR < (test.avgR ?? 0) ? "worse in both" : "unclear" };
  }).filter((g) => g.trades > 0);
  report.results.push({ setup, side: side(dir), label: P.SETUPS[setup], all: P.summary(main), older: train, newer: test, ...P.verdict(train, test),
    byYear: Object.fromEntries(years.map((y) => [y, P.summary(main.filter((t) => new Date(t.t).getUTCFullYear() === y))])),
    byBtc: Object.fromEntries(["up", "mixed", "down"].map((r) => [r, P.summary(main.filter((t) => t.f.btc === r))])),
    portfolio: P.portfolio(main, MAX_OPEN), rules, groups });
}
// One account trading every setup that holds (main exit), at most MAX_OPEN positions, 1% risk each
const held = report.results.filter((r) => r.ok);
const heldTrades = trades.filter((t) => t.rule === "main" && held.some((r) => r.setup === t.setup && r.side === side(t.dir)));
report.combined = held.length ? { setups: held.map((r) => `${r.setup} ${r.side}`), all: P.portfolio(heldTrades, MAX_OPEN),
  older: P.portfolio(heldTrades.filter((t) => t.t < splitT), MAX_OPEN), newer: P.portfolio(heldTrades.filter((t) => t.t >= splitT), MAX_OPEN),
  byYear: Object.fromEntries(years.map((y) => [y, P.portfolio(heldTrades.filter((t) => new Date(t.t).getUTCFullYear() === y), MAX_OPEN)])) } : null;
// every main-rule trade, compact (the Perps tab shows a setup's history from these)
report.trades = trades.filter((t) => t.rule === "main").map((t) => [t.setup, t.dir, t.sym, t.t, t.exitT, +t.entry.toPrecision(6), +t.exit.toPrecision(6), t.why, t.r, t.netPct, t.fundingPct]);
await writeFile(path.join(here, "perps_report.json"), JSON.stringify(report));

// ───────────────────────────── summary ─────────────────────────────
const pad = (v, n) => String(v ?? "—").padStart(n);
log(`\nSwing setups on Binance USDⓈ-M perps, ${hist.from} to ${hist.to}: ${TOP} most liquid each month (${hist.chosen.length} coins over time).`);
log(`Costs: ${COST}% per side + funding. Exit: ${P.EXITS.main.label}. Older = before ${SPLIT}, newer = from ${SPLIT}. R = result in units of the risk.\n`);
log(`${"setup".padEnd(10)} ${"side".padEnd(5)} ${pad("trades", 6)} ${pad("win%", 5)} ${pad("avg R", 6)} ${pad("PF", 5)} ${pad("older R", 8)} ${pad("newer R", 8)} ${pad("fund%", 6)} ${pad("5-pos acct %", 13)} ${pad("max DD %", 9)}  verdict`);
for (const r of report.results) log(`${r.setup.padEnd(10)} ${r.side.padEnd(5)} ${pad(r.all.trades, 6)} ${pad(r.all.winRatePct, 5)} ${pad(r.all.avgR, 6)} ${pad(r.all.profitFactor, 5)} ${pad(r.older.avgR, 8)} ${pad(r.newer.avgR, 8)} ${pad(r.all.avgFundingPct, 6)} ${pad(r.portfolio.returnPct, 13)} ${pad(r.portfolio.maxDrawdownPct, 9)}  ${r.verdict}`);
const best = report.results.map((r) => ({ r, alt: Object.entries(r.rules).filter(([, x]) => x.ok).map(([k]) => k) })).filter((x) => x.alt.length);
log(`\nOther exits that hold: ${best.length ? best.map((x) => `${x.r.setup} ${x.r.side}: ${x.alt.join(", ")}`).join(" | ") : "none"}`);
if (report.combined) {
  const c = report.combined;
  log(`\nOne account with every setup that holds (${c.setups.join(", ")}), max ${MAX_OPEN} open, 1% risk each:`);
  log(`  all: ${c.all.returnPct}% (max drawdown ${c.all.maxDrawdownPct}%, ${c.all.taken} trades) | older: ${c.older.returnPct}% | newer: ${c.newer.returnPct}%`);
  log(`  by year: ${Object.entries(c.byYear).map(([y, p]) => `${y} ${p.returnPct ?? 0}%`).join(" · ")}`);
} else log("\nNo setup holds in both periods with the main exit.");
log(`\n${report.results.length * Object.keys(P.EXITS).length} setup / side / exit combinations were tested: by luck alone a few can look good. Trust a setup that holds with the main exit, with a large count, and keeps holding in the live tracking.`);
log(`Report: perps_report.json (${report.trades.length} trades with the main exit)`);

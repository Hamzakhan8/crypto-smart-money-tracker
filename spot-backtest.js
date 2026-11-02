// Test of the Spot tab's strategy (spot-trend.js, the same code): hold BTC and ETH, half each, only while each one's daily
// close is above its 50-day average, else USDT. Compared with simply holding, by year, by half, and with other
// average lengths and costs. Node.js 18+, no dependencies.
//
//   node spot-backtest.js                     # Jan 2021 to the last daily close
//   node spot-backtest.js --from 2023-01-01
//   BINANCE_SPOT_URL=https://data-api.binance.vision node spot-backtest.js   # if api.binance.com is blocked
//
// Decided at each daily close, held to the next close, 0.15% cost per switch (0.1% fee + slippage). Writes
// spot_report.json, which the Spot tab shows (until then it shows the copy in data/). Past results do not guarantee
// future results. Research tool, not financial advice.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SCREENER_LIBRARY_ONLY = "1";
const { fetchJson } = await import("./screener.js");
const { SPOT, simulate, curveStats } = await import("./spot-trend.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const BN = (process.env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");
const DAY = 86_400_000;
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const FROM = Date.parse(arg("from", "2021-01-01") + "T00:00:00Z"), TO = Math.floor(Date.now() / DAY) * DAY - DAY;
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const iso = (t) => new Date(t).toISOString().slice(0, 10);

async function daily(sym, start) {
  const rows = [];
  for (let s = start; s <= TO;) {
    const k = await fetchJson(`${BN}/api/v3/klines?symbol=${sym}USDT&interval=1d&startTime=${s}&endTime=${TO + DAY - 1}&limit=1000`, { retries: 2 });
    if (!Array.isArray(k) || !k.length) break;
    rows.push(...k.map((x) => [Number(x[0]), Number(x[4])]));
    s = rows.at(-1)[0] + DAY;
    if (k.length < 1000) break;
  }
  return rows;
}
const start = FROM - 200 * DAY; // room for the longest average tested
const raw = Object.fromEntries(await Promise.all(SPOT.coins.map(async (c) => [c, await daily(c, start)])));
const days = raw[SPOT.coins[0]].map((x) => x[0]).filter((t) => SPOT.coins.every((c) => raw[c].some((y) => y[0] === t)));
const series = Object.fromEntries(SPOT.coins.map((c) => { const m = new Map(raw[c]); return [c, days.map((t) => m.get(t))]; }));
const from = days.findIndex((t) => t >= FROM);
console.log(`${SPOT.coins.join(" + ")}: ${iso(days[from])} to ${iso(days.at(-1))}, ${days.length - from} days`);

const byYear = (curve) => { const y = {}; let prev = 1; for (const x of curve) { const k = new Date(days[x.d]).getUTCFullYear(); y[k] ??= { a: prev }; y[k].b = x.eq; prev = x.eq; } return Object.fromEntries(Object.entries(y).map(([k, v]) => [k, r2((v.b / v.a - 1) * 100, 1)])); };
const holdCurve = (coins, a = from, b = days.length - 1) => { const out = []; let prev = 1; for (let d = a + 1; d <= b; d++) { const eq = coins.reduce((s, c) => s + series[c][d] / series[c][a], 0) / coins.length; out.push({ d, eq, r: eq / prev - 1 }); prev = eq; } return out; };
const main = simulate(series, { from });
const mid = days.findIndex((t) => t >= Date.UTC(new Date(days[from]).getUTCFullYear() + Math.floor((days.length - from) / 365 / 2), 0, 1));
const half = (a, b) => { const s = simulate(Object.fromEntries(Object.entries(series).map(([c, v]) => [c, v.slice(0, b + 1)])), { from: a }); return { from: iso(days[a]), to: iso(days[b]), strategy: curveStats(s.curve), hold: curveStats(holdCurve(SPOT.coins, a, b)), holdBtc: curveStats(holdCurve(["BTC"], a, b)) }; };
const variants = [20, 30, 40, 50, 60, 75, 100, 150].map((n) => { const s = simulate(series, { n, from }); return { avgDays: n, ...curveStats(s.curve), switches: s.switches.length }; });
const report = {
  generatedAt: new Date().toISOString(), from: iso(days[from]), to: iso(days.at(-1)), rule: SPOT,
  strategy: { ...curveStats(main.curve), switches: main.switches.length, perMonth: r2(main.switches.length / ((days.length - from) / 30.4), 1), timeInMarketPct: r2((100 * main.curve.filter((x) => x.r !== 0).length) / main.curve.length, 0), years: byYear(main.curve) },
  hold: { ...curveStats(holdCurve(SPOT.coins)), years: byYear(holdCurve(SPOT.coins)) }, holdBtc: { ...curveStats(holdCurve(["BTC"])), years: byYear(holdCurve(["BTC"])) },
  halves: [half(from, mid - 1), half(mid, days.length - 1)],
  doubleCost: curveStats(simulate(series, { from, costPct: SPOT.costPct * 2 }).curve),
  btcOnly: curveStats(simulate({ BTC: series.BTC }, { from }).curve), ethOnly: curveStats(simulate({ ETH: series.ETH }, { from }).curve),
  variants,
  // From the Nov 2026 study on the daily candles of every Binance USDT pair (delisted ones included), 2021-01 to 2026-10,
  // same costs; not re-run by this script (it needs every coin): they lost money, so the tab does not use them.
  alsoTested: [
    ["Holding the 10 most traded coins (monthly rebalance)", -62, -91], ["Rotation into the 5 strongest coins of the top 50 (weekly, BTC filter)", -97, -100],
    ["Rotation into the 5 strongest of the top 20", -17, -87], ["Each top-20 coin above its 50-day average", 41, -80], ["Breakouts of the 50-day high on the top 30", -78, -96],
    ["Breakouts of the 20-day high (BTC filter)", 216, -62], ["Dip buying: RSI(2) under 10 in an uptrend (top 10)", -73, -77], ["Dip buying: -20% from the 30-day high (top 30)", -95, -98],
    ["Top 4 coins by volume at the time, each above its 50-day average", 236, -64],
  ].map(([name, totalPct, maxDrawdownPct]) => ({ name, totalPct, maxDrawdownPct })),
  recentSwitches: main.switches.slice(-20).reverse().map((x) => ({ day: iso(days[x.d] + DAY), coin: x.coin, hold: x.hold, close: x.close })), // the day of the close that decided
  curve: main.curve.filter((x, k) => k % 7 === 0).map((x) => [iso(days[x.d]), r2(x.eq, 3)]),
};
await writeFile(path.join(here, "spot_report.json"), JSON.stringify(report, null, 1));
const f = (s) => `${s.totalPct >= 0 ? "+" : ""}${s.totalPct}% (${s.perYearPct}% a year), worst drop -${s.maxDrawdownPct}%, Sharpe ${s.sharpe}`;
console.log(`\nStrategy:       ${f(report.strategy)}, ${report.strategy.switches} switches`);
console.log(`Hold BTC + ETH: ${f(report.hold)}`);
console.log(`Hold BTC:       ${f(report.holdBtc)}`);
for (const h of report.halves) console.log(`  ${h.from} to ${h.to}: strategy ${f(h.strategy)} | hold ${h.hold.totalPct}%`);
console.log(`Double costs:   ${f(report.doubleCost)}`);
console.log("By year:", Object.entries(report.strategy.years).map(([y, v]) => `${y} ${v}% (hold ${report.hold.years[y]}%)`).join(" · "));
console.log("Average length:", variants.map((v) => `${v.avgDays}d ${v.totalPct}%`).join(" · "));
console.log("\nSaved spot_report.json.");

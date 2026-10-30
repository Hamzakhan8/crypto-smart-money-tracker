// Test of the Pump watch rule (pump.js) on the daily candles of every Binance USDT pair, delisted ones included.
// Node.js 18+, no dependencies.
//
//   node pump-backtest.js                         # 2021 to the last closed day
//   node pump-backtest.js --from 2023-01-01
//   node pump-backtest.js --refresh               # ignore the download cache (pump_cache/)
//   BINANCE_SPOT_URL=https://data-api.binance.vision node pump-backtest.js   # if api.binance.com is blocked
//
// Every coin-day with $1M+ traded is a "random coin-day" (what you get by picking any coin); the coin-days that pass
// the rule are the picks, at most one per coin per 14 days. Both are followed with the same exit (buy at the daily
// close, +100% target or -25% stop, a day touching both = the stop, else the close after 14 days), minus 0.3% costs.
// The rule was found on March 2024 - October 2026; the years before that were not used to find it, so they are the
// fairer test. Writes pump_report.json, which the Ignition tab shows (until then it shows the copy in data/).
// Past results do not guarantee future results. Research tool, not financial advice.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SCREENER_LIBRARY_ONLY = "1";
const { fetchJson, STABLES, NONCRYPTO, isNonCryptoInfo } = await import("./screener.js");
const { PUMP, rowsOf, pumpFeatures, pumpCheck, pumpTrade } = await import("./pump.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const BN = (process.env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");
const DAY = 86_400_000;
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FROM = Date.parse(arg("from", "2021-01-01") + "T00:00:00Z");
const TO = Math.floor(Date.now() / DAY) * DAY - DAY;     // open time of the last closed day
const FOUND_FROM = Date.parse("2024-03-01T00:00:00Z");   // the rule was found on this period
const REFRESH = argv.includes("--refresh");
const CACHE = path.join(here, "pump_cache");
const OUT = path.join(here, arg("out", "pump_report.json"));
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// ───────── coins and candles ─────────
let meta = new Map();
try { meta = new Map((JSON.parse(await readFile(path.join(here, "binance_meta.json"), "utf8")).coins || []).map(([b, i]) => [b, i])); } catch { /* names only */ }
const ex = await fetchJson(`${BN}/api/v3/exchangeInfo`, { timeoutMs: 30_000 });
const bases = [...new Set((ex.symbols || []).filter((s) => s.quoteAsset === "USDT" && !/(UP|DOWN|BULL|BEAR)$/.test(s.baseAsset)).map((s) => s.baseAsset))]
  .filter((b) => !STABLES.has(b) && !NONCRYPTO.has(b) && !isNonCryptoInfo(meta.get(b)));
console.log(`${bases.length} USDT pairs (trading or delisted), ${iso(FROM)} to ${iso(TO)}`);
await mkdir(CACHE, { recursive: true });
async function daily(b) {
  const file = path.join(CACHE, `${b}.json`), start = FROM - 100 * DAY;
  if (!REFRESH) try { const c = JSON.parse(await readFile(file, "utf8")); if (c.start <= start && c.to >= TO) return c.rows.filter((r) => r[0] >= start && r[0] <= TO); } catch { /* download */ }
  const rows = [];
  for (let s = start; s <= TO;) {
    const k = await fetchJson(`${BN}/api/v3/klines?symbol=${b}USDT&interval=1d&startTime=${s}&endTime=${TO + DAY - 1}&limit=1000`, { retries: 2 }).catch(() => []);
    if (!Array.isArray(k) || !k.length) break;
    rows.push(...rowsOf(k));
    s = rows.at(-1)[0] + DAY;
    await sleep(60);
    if (k.length < 1000) break;
  }
  await writeFile(file, JSON.stringify({ start, to: TO, rows }));
  return rows.filter((r) => r[0] <= TO);
}

// downloads 6 at a time (cached in pump_cache/), then every coin-day
const candles = new Map();
{ let i = 0, n = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < bases.length) { const b = bases[i++]; candles.set(b, await daily(b)); if (++n % 50 === 0) console.log(`  ${n}/${bases.length} downloaded`); } })); }
const days = [];   // one row per coin-day with $1M+ traded
for (const b of bases) {
  const k = candles.get(b);
  if (k.length < PUMP.minHistory + 2) continue;
  const delisted = k.at(-1)[0] < TO - 2 * DAY;
  for (let i = PUMP.minHistory; i < k.length - 1; i++) {
    if (k[i][0] < FROM) continue;
    const f = pumpFeatures(k, i);
    if (!f || !(f.qv >= PUMP.minQuoteVolume) || !(f.avg20 > 0) || f.pegged) continue;
    const tr = pumpTrade(k, i);
    if (!tr.done && !delisted) continue; // its 14 days are not over yet
    let hi7 = 0; for (let j = i + 1; j <= Math.min(i + 7, k.length - 1); j++) hi7 = Math.max(hi7, k[j][2]);
    days.push({ t: k[i][0], b, f, net: tr.pct - PUMP.costPct, why: tr.why, up50: hi7 >= f.close * 1.5, up100: tr.peakPct >= 100 });
  }
}
// market mood each day: the share of coin-days up over 30 days
const moodOf = new Map();
{ const m = new Map(); for (const d of days) { const x = m.get(d.t) || m.set(d.t, [0, 0]).get(d.t); x[0]++; if (d.f.r30Pct > 0) x[1]++; }
  for (const [t, [a, u]] of m) moodOf.set(t, (u / a) * 100); }
// picks: the rule, one per coin per 14 days
const last = new Map(), picks = [];
for (const d of [...days].sort((a, b) => a.t - b.t)) {
  if (!pumpCheck(d.f).ok || d.t - (last.get(d.b) ?? -Infinity) < PUMP.gapDays * DAY) continue;
  last.set(d.b, d.t); picks.push({ ...d, mood: moodOf.get(d.t) });
}

function stats(s, from, to) {
  if (!s.length) return { n: 0 };
  const nets = s.map((d) => d.net).sort((a, b) => a - b), weeks = Math.max(1, (to - from) / DAY / 7), pct = (fn) => r2((s.filter(fn).length / s.length) * 100, 1);
  return { n: s.length, perWeek: r2(s.length / weeks, 1), up50in7Pct: pct((d) => d.up50), up100in14Pct: pct((d) => d.up100), targetPct: pct((d) => d.why === "target"),
    stopPct: pct((d) => d.why === "stop"), avgPct: r2(nets.reduce((a, v) => a + v, 0) / s.length, 2), medianPct: r2(nets[s.length >> 1], 1), winPct: pct((d) => d.net > 0) };
}
const inRange = (s, a, b) => s.filter((d) => d.t >= a && d.t < b);
const block = (a, b) => ({ from: iso(a), to: iso(Math.min(b, TO + DAY) - DAY), random: stats(inRange(days, a, b), a, b), watch: stats(inRange(picks, a, b), a, b),
  moodOk: stats(inRange(picks, a, b).filter((d) => d.mood >= PUMP.moodMin), a, b), moodWeak: stats(inRange(picks, a, b).filter((d) => d.mood < PUMP.moodMin), a, b) });
// half-years
const periods = [];
for (let y = new Date(FROM).getUTCFullYear(); y <= new Date(TO).getUTCFullYear(); y++) for (const h of [0, 6]) {
  const a = Math.max(FROM, Date.UTC(y, h, 1)), b = Math.min(TO + DAY, Date.UTC(y, h + 6, 1));
  if (b - a >= 30 * DAY) periods.push({ label: `${y} ${h ? "H2" : "H1"}`, ...block(a, b) });
}
const all = block(FROM, TO + DAY);
const report = {
  generatedAt: new Date().toISOString(), from: iso(FROM), to: iso(TO), coins: new Set(days.map((d) => d.b)).size, rule: PUMP,
  random: all.random, watch: all.watch, moodOk: all.moodOk, moodWeak: all.moodWeak,
  foundOn: block(Math.max(FROM, FOUND_FROM), TO + DAY), older: FROM < FOUND_FROM ? block(FROM, FOUND_FROM) : null, periods,
  recent: picks.slice(-30).reverse().map((d) => ({ base: d.b, day: iso(d.t), netPct: r2(d.net, 1), why: d.why, mood: r2(d.mood, 0) })),
};
await writeFile(OUT, JSON.stringify(report, null, 1));

const f = (s) => (s?.n ? `${String(s.n).padStart(6)} ${String(s.perWeek).padStart(6)}/wk  +50% in 7d ${String(s.up50in7Pct).padStart(4)}%  2x ${String(s.up100in14Pct).padStart(4)}%  stop ${String(s.stopPct).padStart(4)}%  avg ${(s.avgPct >= 0 ? "+" : "") + s.avgPct.toFixed(2)}%  win ${s.winPct}%` : "     0");
console.log(`\n${report.coins} coins. Exit: +${PUMP.targetPct}% / -${PUMP.stopPct}% / ${PUMP.days} days from the daily close, after ${PUMP.costPct}% costs.\n`);
for (const [name, b] of [["ALL", all], ["FOUND ON (2024-03 on)", report.foundOn], ["OLDER (not used to find it)", report.older]]) {
  if (!b) continue;
  console.log(`${name}: ${b.from} to ${b.to}`);
  for (const k of ["random", "watch", "moodOk", "moodWeak"]) console.log(`  ${{ random: "random coin-day", watch: "pump watch", moodOk: `  mood ${PUMP.moodMin}%+`, moodWeak: `  mood under ${PUMP.moodMin}%` }[k].padEnd(18)} ${f(b[k])}`);
}
console.log("\nhalf-years: pump watch avg vs random avg (mood OK picks)");
for (const p of periods) console.log(`  ${p.label}  watch ${String(p.watch.n ?? 0).padStart(4)} ${p.watch.n ? ((p.watch.avgPct >= 0 ? "+" : "") + p.watch.avgPct.toFixed(2) + "%").padStart(8) : "       —"}  random ${p.random.n ? ((p.random.avgPct >= 0 ? "+" : "") + p.random.avgPct.toFixed(2) + "%").padStart(8) : "—"}  mood OK ${String(p.moodOk.n ?? 0).padStart(4)} ${p.moodOk.n ? ((p.moodOk.avgPct >= 0 ? "+" : "") + p.moodOk.avgPct.toFixed(2) + "%") : "—"}`);
console.log(`\nSaved ${path.basename(OUT)}.`);

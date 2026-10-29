// History of Binance USDⓈ-M perpetuals for the swing-trade backtest (perps-backtest.js), from Binance's public archive
// (data.binance.vision): no API key, and it still works where fapi.binance.com is blocked. Node.js 18+, no dependencies.
//
// What is downloaded (cached in ./perps_cache, so a rerun only fetches what is new):
//   - the list of every USDT perpetual ever listed, delisted ones included (no survivor bias);
//   - daily candles for all of them, to pick the most liquid coins AT EACH MOMENT (by the 30 days before each month);
//   - for the coins that were ever among them: 4h candles, every funding payment, and 5-minute open interest,
//     top-trader and account long/short and taker buy/sell ratios (kept per 4h bar).
// Binance's live API keeps only 30 days of open interest; the archive goes back to December 2021.
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CACHE = path.join(here, "perps_cache");
const ARCHIVE = "https://data.binance.vision";
const LIST = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const DAY = 86_400_000, H4 = 14_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Not crypto, or not a single coin: stablecoins, gold / silver / platinum, tokenized stocks and ETFs, index contracts.
export const EXCLUDED = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "USDP", "DAI", "USDE", "EUR", "GBP", "AEUR", "XUSD", "USD1", "PYUSD",
  "XAU", "XAG", "XPT", "XPD", "XAUT", "PAXG", "WBTC", "WBETH", "STETH", "BTCDOM", "DEFI", "FOOTBALL", "BLUEBIRD", "BTCST",
  "AAPL", "AMD", "AMZN", "COIN", "CRCL", "GOOGL", "GOOG", "HOOD", "INTC", "META", "MSFT", "MSTR", "NFLX", "NVDA", "PLTR", "QQQ", "SPY", "TSLA",
  "IBM", "ORCL", "BABA", "GME", "AMC", "UBER", "SNAP", "PYPL", "SQ", "SHOP", "AVGO", "TSM", "ARM", "SMCI", "MU", "BRK", "JPM", "V", "MA", "DIS"]);
export const baseOf = (sym) => sym.replace(/USDT$/, "");

// ───────────────────────────── archive access ─────────────────────────────
// The archive's file list (S3), page by page.
async function listing(prefix, { dirs = false } = {}) {
  const out = [];
  let marker = "";
  for (;;) {
    const x = await getText(`${LIST}?prefix=${encodeURIComponent(prefix)}${dirs ? "&delimiter=/" : ""}&marker=${encodeURIComponent(marker)}`);
    const items = [...x.matchAll(dirs ? /<Prefix>([^<]*)<\/Prefix>/g : /<Key>([^<]*)<\/Key>/g)].map((m) => m[1]).filter((s) => s !== prefix);
    out.push(...items);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(x) || !items.length) break;
    marker = items[items.length - 1];
  }
  return out;
}
async function getText(url) { return (await get(url)).toString("utf8"); }
// GET with retries; 404 -> null.
async function get(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= tries - 1) throw new Error(`${url}: ${e.message}`);
      await sleep(1000 * 2 ** i);
    }
  }
}
// The one CSV file inside a Binance archive zip (read through the zip's central directory).
export function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("bad zip directory");
  const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + size);
  return method === 0 ? data : inflateRawSync(data);
}
const rowsOf = (csv) => csv.toString("utf8").split("\n").map((l) => l.trim().split(",")).filter((r) => r.length > 2 && /^\d/.test(r[0]));
const ms = (v) => { const n = Number(v); return n > 1e14 ? Math.floor(n / 1000) : n; }; // some newer files use microseconds

// ───────────────────────────── parsers (one month or one day of one coin) ─────────────────────────────
// Candles: [openTime, open, high, low, close, quoteVolume, takerBuyQuoteVolume]
export const parseKlines = (csv) => rowsOf(csv).map((r) => [ms(r[0]), +r[1], +r[2], +r[3], +r[4], +r[7], +r[10]]);
// Funding payments: [time, rate] (rate as a fraction of the position, paid by longs when positive)
export const parseFunding = (csv) => rowsOf(csv).map((r) => [ms(r[0]), +r[r.length - 1]]).filter((x) => Number.isFinite(x[1]));
// 5-minute metrics, kept per 4h bar: [barOpenTime, openInterestUsd, topTraderLongShort, accountLongShort, takerBuySellAvg,
// takerSamples, lastSampleTime] (the last values before the bar closes; the taker ratio averaged over the bar). A day file
// also holds the closing sample of the previous day's last bar; mergeMetric() joins the two parts.
export function parseMetrics(csv) {
  const bars = new Map();
  for (const r of csv.toString("utf8").split("\n").slice(1)) {
    const f = r.trim().split(",");
    if (f.length < 8) continue;
    const t = Date.parse(f[0].replace(" ", "T") + "Z") - 1; // value for the 5 minutes up to create_time
    if (!Number.isFinite(t)) continue;
    const bar = Math.floor(t / H4) * H4;
    let b = bars.get(bar);
    if (!b) bars.set(bar, (b = { t: -1, oi: null, top: null, acc: null, taker: 0, n: 0 }));
    if (t >= b.t) { b.t = t; b.oi = +f[3] || null; b.top = +f[5] || null; b.acc = +f[6] || null; }
    if (+f[7] > 0) { b.taker += +f[7]; b.n++; }
  }
  return [...bars.entries()].sort((a, b) => a[0] - b[0]).map(([t, b]) => [t, b.oi, b.top, b.acc, b.n ? +(b.taker / b.n).toFixed(4) : null, b.n, b.t]);
}
export function mergeMetric(a, b) {
  if (!a) return b;
  const [late, early] = (b[6] || 0) >= (a[6] || 0) ? [b, a] : [a, b], n = (a[5] || 0) + (b[5] || 0);
  return [a[0], late[1] ?? early[1], late[2] ?? early[2], late[3] ?? early[3], n ? +(((a[4] || 0) * (a[5] || 0) + (b[4] || 0) * (b[5] || 0)) / n).toFixed(4) : null, n, late[6]];
}

// ───────────────────────────── cache ─────────────────────────────
const fileOf = (sym, kind, period) => path.join(CACHE, sym, `${kind}_${period}.json`);
async function cachedJson(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; } }
async function saveJson(file, data) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(data)); }
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
const monthsBetween = (a, b) => { const out = []; for (let [y, m] = a.split("-").map(Number); `${y}-${String(m).padStart(2, "0")}` <= b; m === 12 ? (y++, m = 1) : m++) out.push(`${y}-${String(m).padStart(2, "0")}`); return out; };
export const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
const addMonths = (m, k) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7); };

// One file of one coin: from the cache, else downloaded (a missing file is cached as empty, so it is not asked again).
async function one(sym, kind, period, url, parse) {
  const file = fileOf(sym, kind, period);
  const hit = await cachedJson(file);
  if (hit !== undefined) return hit;
  const buf = await get(url);
  const rows = buf ? parse(unzipFirst(buf)) : [];
  await saveJson(file, rows);
  return rows;
}
const um = (freq, what, sym, sub, period) => `${ARCHIVE}/data/futures/um/${freq}/${what}/${sym}/${sub ? sub + "/" : ""}${sym}-${sub ? sub + "-" : ""}${what === "fundingRate" ? "fundingRate-" : what === "metrics" ? "metrics-" : ""}${period}.zip`;

// ───────────────────────────── the download ─────────────────────────────
// opts: { from: "2021-12", to: "2026-09", top: 50, log, metrics: false = skip open interest (faster first look) }
export async function loadHistory({ from = "2021-12", to, top = 50, log = console.log, concurrency = 24, metrics = true } = {}) {
  to ||= addMonths(monthOf(Date.now()), -1); // the last complete month
  const months = monthsBetween(from, to);
  await mkdir(CACHE, { recursive: true });
  // 1. Every USDT perpetual, and the months each has daily candles for (refreshed weekly)
  const indexFile = path.join(CACHE, "_index.json");
  let index = await cachedJson(indexFile);
  const fresh = index && Date.now() - index.at < 7 * DAY && index.to >= to;
  if (!fresh) {
    log("Listing every USDT perpetual in the archive…");
    const syms = (await listing("data/futures/um/monthly/klines/", { dirs: true })).map((p) => p.split("/").slice(-2)[0])
      .filter((s) => /^[A-Z0-9]+USDT$/.test(s) && !EXCLUDED.has(baseOf(s)));
    const avail = {};
    await pool(syms, concurrency, async (s) => {
      const keys = await listing(`data/futures/um/monthly/klines/${s}/1d/`);
      avail[s] = keys.map((k) => k.match(/-(\d{4}-\d{2})\.zip$/)?.[1]).filter(Boolean);
    });
    index = { at: Date.now(), to, symbols: syms, avail };
    await saveJson(indexFile, index);
  }
  const symbols = index.symbols.filter((s) => (index.avail[s] || []).some((m) => m >= from && m <= to));
  log(`${symbols.length} USDT perpetuals with history in ${from}…${to} (delisted ones included)`);
  // 2. Daily candles for all of them
  const jobs1d = symbols.flatMap((s) => index.avail[s].filter((m) => m >= from && m <= to).map((m) => [s, m]));
  let done = 0;
  const daily = new Map();
  await pool(jobs1d, concurrency, async ([s, m]) => {
    const rows = await one(s, "1d", m, um("monthly", "klines", s, "1d", m), parseKlines);
    if (!daily.has(s)) daily.set(s, []);
    daily.get(s).push(...rows);
    if (++done % 2000 === 0) log(`  daily candles: ${done}/${jobs1d.length} files`);
  });
  for (const rows of daily.values()) rows.sort((a, b) => a[0] - b[0]);
  // 3. The most liquid coins at the start of each month (by quote volume in the 30 days before)
  const universe = {};
  for (const m of months.slice(1)) {
    const t0 = Date.parse(`${m}-01T00:00:00Z`);
    const vol = [];
    for (const [s, rows] of daily) {
      let v = 0, n = 0;
      for (const r of rows) if (r[0] >= t0 - 30 * DAY && r[0] < t0) { v += r[5]; n++; }
      if (n >= 25) vol.push([s, v]); // listed for most of the month before
    }
    universe[m] = vol.sort((a, b) => b[1] - a[1]).slice(0, top).map((x) => x[0]);
  }
  const chosen = [...new Set(Object.values(universe).flat())];
  if (!chosen.includes("BTCUSDT")) chosen.push("BTCUSDT");
  log(`${chosen.length} coins were among the ${top} most liquid in at least one month`);
  // 4. For those: 4h candles, funding (monthly files) and metrics (daily files) for each month a coin was in the list,
  //    plus 3 months before (indicator warm-up) and 1 after (trades still open at the month's end)
  const span = (s) => {
    const need = new Set();
    for (const m of Object.keys(universe)) if (universe[m].includes(s) || s === "BTCUSDT") for (let k = -3; k <= 1; k++) need.add(addMonths(m, k));
    return [...need].filter((m) => m >= from && m <= to && index.avail[s].includes(m)).sort();
  };
  const jobsM = chosen.flatMap((s) => span(s).flatMap((m) => [[s, "4h", m], [s, "funding", m]]));
  done = 0;
  await pool(jobsM, concurrency, async ([s, kind, m]) => {
    if (kind === "4h") await one(s, "4h", m, um("monthly", "klines", s, "4h", m), parseKlines);
    else await one(s, "funding", m, um("monthly", "fundingRate", s, null, m), parseFunding);
    if (++done % 2000 === 0) log(`  4h candles and funding: ${done}/${jobsM.length} files`);
  });
  const jobsD = [];
  if (metrics) for (const s of chosen) for (const m of span(s)) {
    const t0 = Date.parse(`${m}-01T00:00:00Z`), t1 = Date.parse(`${addMonths(m, 1)}-01T00:00:00Z`);
    if (t0 < Date.parse("2021-12-01T00:00:00Z")) continue; // the metrics archive starts in December 2021
    for (let t = t0; t < t1; t += DAY) jobsD.push([s, new Date(t).toISOString().slice(0, 10)]);
  }
  done = 0;
  if (jobsD.length) log(`Open interest and long/short metrics: ${jobsD.length} day files (cached after the first run)…`);
  await pool(jobsD, concurrency, async ([s, d]) => {
    await one(s, "metrics", d, um("daily", "metrics", s, null, d), parseMetrics);
    if (++done % 5000 === 0) log(`  metrics: ${done}/${jobsD.length} files`);
  });
  return { from, to, months, universe, chosen, daily, monthsOf: span };
}

// Everything cached for one coin, joined: 4h bars with metrics, funding payments, daily bars.
export async function coinData(sym, months, daily) {
  const bars = [], funding = [], metrics = new Map();
  for (const m of months) {
    const k = await cachedJson(fileOf(sym, "4h", m));
    if (k) bars.push(...k);
    const f = await cachedJson(fileOf(sym, "funding", m));
    if (f) funding.push(...f);
    const t0 = Date.parse(`${m}-01T00:00:00Z`);
    for (let t = t0; monthOf(t) === m; t += DAY) {
      const x = await cachedJson(fileOf(sym, "metrics", new Date(t).toISOString().slice(0, 10)));
      if (x) for (const r of x) metrics.set(r[0], mergeMetric(metrics.get(r[0]), r));
    }
  }
  bars.sort((a, b) => a[0] - b[0]); funding.sort((a, b) => a[0] - b[0]);
  const dedup = (rows) => rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0]);
  return { sym, bars: dedup(bars).map((b) => { const x = metrics.get(b[0]); return { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], qv: b[5], tbq: b[6], oi: x?.[1] ?? null, top: x?.[2] ?? null, acc: x?.[3] ?? null, taker: x?.[4] ?? null }; }),
    funding: dedup(funding), daily: dedup(daily.get(sym) || []).map((d) => ({ t: d[0], o: d[1], h: d[2], l: d[3], c: d[4], qv: d[5] })) };
}
export async function cacheSize() { try { return (await stat(CACHE)).isDirectory(); } catch { return false; } }

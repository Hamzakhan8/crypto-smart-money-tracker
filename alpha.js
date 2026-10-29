// Binance Alpha ignition: the same idea as the screener's Ignition tab, for the early on-chain tokens Binance lists in
// Binance Wallet / Binance Alpha (EVAA, ...). These are not Binance spot pairs, so the spot scanner never sees them.
// Node.js 18+, no dependencies.
//
// Data: the public endpoints Binance's own Alpha pages use (token list with liquidity, holders, market cap; 5-minute
// candles), no API key. They are not documented and can change without notice. Alpha trades carry no buyer/seller
// side (every trade reads as a buy), so buys vs sells come from DexScreener, which reads the token's DEX pools.
//
// Signal (fixed before the replay was run, then checked by `node alpha-backtest.js`): two finished 5-minute candles in a
// row, each trading at least 5x the token's normal 5-minute volume (median of the previous 24 hours) and at least
// $1,000 with 10+ trades, price up over those 10 minutes but not more than 20%, and not already up more than 30% in
// 24 hours. Added after the replay: $1M+ traded in the last 24 hours (below that the rule fired ~50 times a day and did
// no better than a random entry). Every alert is tracked: +40% before -10% within 7 days, after costs. Not advice.

import { readFile, writeFile, rename } from "node:fs/promises";
import { exitRulesFor, newExits, applyExits, exitsOpen, recordAfter, exitSummary, speedSummary, groupSummary, aiCalibration } from "./exits.js";

const MIN = 60_000, STEP = 5 * MIN, HOUR = 60 * MIN, DAY = 24 * HOUR;
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const env = process.env;
const envNum = (k, d) => { const v = Number(env[k]); return env[k] != null && env[k] !== "" && Number.isFinite(v) ? v : d; };

export const ALPHA_BAPI = "https://www.binance.com/bapi/defi/v1/public";
export const ALPHA_LIST_URL = `${ALPHA_BAPI}/wallet-direct/buw/wallet/cex/alpha/all/token/list`;
// Most Alpha tokens trade against USDT, some only against USDC ("Invalid symbol" for USDT).
export const alphaKlinesUrl = (alphaId, { interval = "5m", limit = 300, startTime, endTime, quote = "USDT" } = {}) =>
  `${ALPHA_BAPI}/alpha-trade/klines?symbol=${alphaId}${quote}&interval=${interval}&limit=${limit}${startTime != null ? `&startTime=${startTime}` : ""}${endTime != null ? `&endTime=${endTime}` : ""}`;

export const DEFAULT_ALPHA = Object.freeze({
  volMult: 5, minCandleUsd: 1000, minTrades: 10, maxMove10mPct: 20, maxChg24Pct: 30, baseFloorUsd: 100,
  min24hUsd: 1_000_000, // added after the replay: below $1M of 24h volume the rule did no better than a random entry
  targetPct: 40, stopPct: 10, outcomeDays: 7, costPct: 1.0, // costs: Alpha fee + DEX slippage on thin pools, round trip
  minLiquidityUsd: 50_000, minHolders: 1000,
});
export const ALPHA_STATES = { ignited: "Ignited", heating: "Heating up", ran: "Already moved — do not chase", quiet: "Quiet" };
const STABLE_RE = /^(USD|USDT|USDC|FDUSD|DAI|TUSD|USDE|USD1|PYUSD|RLUSD|USDF|XUSD|BUSD|EUR|EURC|XAUT|PAXG)$|USD$/i;

// Klines from the Alpha endpoint -> [t, open, high, low, close, quoteVolume, trades] (the taker-buy columns are copies of
// the total volume, so they are not used).
export const parseKlines = (k) => (Array.isArray(k) ? k.map((r) => [Number(r[0]), +r[1], +r[2], +r[3], +r[4], +r[7], +r[8]]).filter((r) => r[4] > 0) : []);

// Puts candles on a continuous 5-minute grid ending at `end` (exclusive); a minute with no trades gets the last close and
// zero volume, so "the last 288 candles" always means 24 hours.
export function toGrid(rows, start, end) {
  const n = Math.max(0, Math.round((end - start) / STEP)), out = new Array(n);
  let j = 0, last = null;
  while (j < rows.length && rows[j][0] < start) last = rows[j++][4];
  for (let i = 0; i < n; i++) {
    const t = start + i * STEP;
    while (j < rows.length && rows[j][0] < t) last = rows[j++][4];
    if (j < rows.length && rows[j][0] === t) { out[i] = rows[j]; last = rows[j][4]; j++; }
    else out[i] = last != null ? [t, last, last, last, last, 0, 0] : null;
  }
  return out;
}

const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Features of the two finished candles ending at index i (on a grid with no gaps). Needs 24h + 2 candles of history.
// pre (optional, for the replay): { median, mean24, qv24, qv1h } computed with rolling windows.
export function alphaFeatures(g, i, cfg = DEFAULT_ALPHA, pre = null) {
  if (i < 290 || !g[i] || !g[i - 1] || !g[i - 289]) return null;
  const a = g[i - 1], b = g[i];
  let med, mean24, qv24 = 0, qv1h = 0;
  if (pre) ({ median: med, mean24, qv24, qv1h } = pre);
  else {
    const prior = []; for (let k = i - 289; k <= i - 2; k++) prior.push(g[k] ? g[k][5] : 0);
    med = median(prior); mean24 = prior.reduce((s, x) => s + x, 0) / prior.length;
    for (let k = i - 287; k <= i; k++) { qv24 += g[k]?.[5] || 0; if (k > i - 12) qv1h += g[k]?.[5] || 0; }
  }
  const base = Math.max(med ?? 0, cfg.baseFloorUsd);
  const ref24 = g[i - 288][4], ref1h = g[i - 12][4];
  return {
    t: b[0] + STEP, close: b[4], base: r2(base, 2), r1: r2(a[5] / base, 1), r2: r2(b[5] / base, 1), usd1: r2(a[5], 0), usd2: r2(b[5], 0), trades1: a[6], trades2: b[6],
    move10: r2((b[4] / a[1] - 1) * 100, 2), chg1h: r2((b[4] / ref1h - 1) * 100, 2), chg24: r2((b[4] / ref24 - 1) * 100, 2),
    qv24: r2(qv24, 0), qv1h: r2(qv1h, 0), mean24: r2(mean24, 2),
  };
}

// Which rules a candle pair passes and fails. early = the rule as first planned; ok (confirmed) = early plus $1M+ of
// volume in the last 24 hours.
export function classifyAlpha(f, cfg = DEFAULT_ALPHA) {
  if (!f) return { ok: false, early: false, tier: null, state: "quiet", fails: ["not enough history"] };
  const fails = [];
  if (!(f.r1 >= cfg.volMult && f.r2 >= cfg.volMult)) fails.push(`volume under ${cfg.volMult}x normal`);
  if (!(f.usd1 >= cfg.minCandleUsd && f.usd2 >= cfg.minCandleUsd)) fails.push(`under $${cfg.minCandleUsd} per 5 minutes`);
  if (!(f.trades1 >= cfg.minTrades && f.trades2 >= cfg.minTrades)) fails.push(`under ${cfg.minTrades} trades per 5 minutes`);
  if (!(f.move10 > 0)) fails.push("price not up over 10 minutes");
  if (f.move10 > cfg.maxMove10mPct) fails.push(`spiked more than ${cfg.maxMove10mPct}% in 10 minutes`);
  if (f.chg24 > cfg.maxChg24Pct) fails.push(`already up more than ${cfg.maxChg24Pct}% in 24 hours`);
  const early = !fails.length, ok = early && f.qv24 >= (cfg.min24hUsd ?? 0);
  if (early && !ok) fails.push(`early only: under ${fmtUsd(cfg.min24hUsd)} traded in 24 hours`);
  const state = early ? "ignited" : f.chg24 > cfg.maxChg24Pct ? "ran"
    : (f.r2 >= 3 && f.usd2 >= cfg.minCandleUsd && f.trades2 >= cfg.minTrades && f.move10 > 0) || (f.qv1h >= 12 * f.base * 3 && f.chg1h >= 2 && f.qv1h >= cfg.minCandleUsd * 10) ? "heating" : "quiet";
  return { ok, early, tier: ok ? "confirmed" : early ? "early" : null, state, fails };
}

// Outcome of an entry at `entry` after index i: target first, stop first (also when both are touched in one candle), or
// the window ended (sold at the last close). Returns the net result after costs.
export function alphaOutcome(g, i, entry, cfg = DEFAULT_ALPHA) {
  const tp = entry * (1 + cfg.targetPct / 100), sl = entry * (1 - cfg.stopPct / 100), last = Math.min(g.length - 1, i + Math.round((cfg.outcomeDays * DAY) / STEP));
  let peak = entry, low = entry;
  for (let k = i + 1; k <= last; k++) {
    const c = g[k]; if (!c) continue;
    peak = Math.max(peak, c[2]); low = Math.min(low, c[3]);
    if (c[3] <= sl) return { o: "loss", r: -cfg.stopPct - cfg.costPct, steps: k - i, peakPct: r2((peak / entry - 1) * 100, 1) };
    if (c[2] >= tp) return { o: "win", r: cfg.targetPct - cfg.costPct, steps: k - i, peakPct: r2((peak / entry - 1) * 100, 1) };
  }
  const full = i + Math.round((cfg.outcomeDays * DAY) / STEP) <= g.length - 1;
  const lc = g[last]?.[4] ?? entry;
  return { o: full ? "flat" : "open", r: r2((lc / entry - 1) * 100 - cfg.costPct, 2), steps: last - i, peakPct: r2((peak / entry - 1) * 100, 1), lowPct: r2((low / entry - 1) * 100, 1) };
}

// Which Alpha tokens the live tab scans: still trading, not on Binance spot (the Ignition tab covers those), enough pool
// liquidity and holders, not a stablecoin or gold token.
export function alphaEligible(x, cfg = DEFAULT_ALPHA) {
  if (!x || !x.alphaId) return "no id";
  if (x.offline || x.offsell || x.fullyDelisted) return "not trading";
  if (x.listingCex) return "also on Binance spot (see the Ignition tab)";
  if (STABLE_RE.test(String(x.symbol || "")) || /gold|treasury|t-bill/i.test(String(x.name || ""))) return "stablecoin / gold / bond token";
  if (!(num(x.liquidity) >= cfg.minLiquidityUsd)) return `liquidity under $${Math.round(cfg.minLiquidityUsd / 1000)}k`;
  if (!(num(x.holders) >= cfg.minHolders)) return `fewer than ${cfg.minHolders} holders`;
  return null;
}
export const DEX_CHAIN = { BSC: "bsc", Base: "base", Ethereum: "ethereum", Solana: "solana", Arbitrum: "arbitrum", Sui: "sui", TRON: "tron", Sonic: "sonic", Linea: "linea" };
const isEvm = (c) => ["bsc", "base", "ethereum", "arbitrum", "sonic", "linea"].includes(c);

// Biggest DEX pool for a token from DexScreener's /tokens/v1 answer: buys and sells (counts), volume, liquidity.
export function dexSummary(pairs, address) {
  const a = String(address || "").toLowerCase();
  const mine = (Array.isArray(pairs) ? pairs : []).filter((p) => String(p?.baseToken?.address || "").toLowerCase() === a);
  if (!mine.length) return null;
  const p = mine.sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
  const tx = (k) => ({ buys: p.txns?.[k]?.buys ?? null, sells: p.txns?.[k]?.sells ?? null });
  const share = (k) => { const t = tx(k); return t.buys != null && t.buys + t.sells > 0 ? Math.round((t.buys / (t.buys + t.sells)) * 100) : null; };
  return { url: p.url || null, dex: p.dexId || null, liquidity: num(p.liquidity?.usd), m5: tx("m5"), h1: tx("h1"), buyShare5m: share("m5"), buyShare1h: share("h1"),
    vol5m: num(p.volume?.m5), vol1h: num(p.volume?.h1), pairCreatedAt: num(p.pairCreatedAt), pools: mine.length };
}

// ───────────────────────────── live scanner ─────────────────────────────
export function alphaConfig() {
  const d = DEFAULT_ALPHA;
  return Object.freeze({
    ...d, volMult: envNum("ALPHA_VOL_MULT", d.volMult), minCandleUsd: envNum("ALPHA_MIN_5M_USD", d.minCandleUsd), minTrades: envNum("ALPHA_MIN_TRADES", d.minTrades),
    min24hUsd: envNum("ALPHA_MIN_24H_USD", d.min24hUsd),
    targetPct: envNum("ALPHA_TARGET_PCT", d.targetPct), stopPct: envNum("ALPHA_STOP_PCT", d.stopPct), outcomeDays: envNum("ALPHA_OUTCOME_DAYS", d.outcomeDays),
    costPct: envNum("ALPHA_COST_PCT", d.costPct), minLiquidityUsd: envNum("ALPHA_MIN_LIQUIDITY", d.minLiquidityUsd), minHolders: envNum("ALPHA_MIN_HOLDERS", d.minHolders),
    scanMinutes: Math.max(1, envNum("ALPHA_SCAN_MINUTES", 5)),
  });
}

const fmtUsd = (v) => (v == null ? "n/a" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${Math.round(v)}`);
const fmtPx = (v) => (v == null ? "n/a" : v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(4)}`);
const sgn = (v) => (v == null ? "n/a" : `${v > 0 ? "+" : ""}${v}%`);
const STATE_RANK = { ignited: 3, heating: 2, ran: 1, quiet: 0 };
async function mapLimit(items, n, fn) {
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const j = k++; await fn(items[j], j); } }));
}

export function alphaTelegram(a, cfg, replay) {
  const f = a.f, x = a.token, d = a.dex;
  const R = a.tier === "early" ? replay?.planned : replay?.rule;
  const rp = R?.n ? `Replay of this tier (${replay.days} days, ${R.n} alerts): ${R.winPct.toFixed(0)}% hit +${cfg.targetPct}% first, average ${sgn(r2(R.net, 1))} per trade after costs.` : null;
  return [`ALPHA ${a.tier === "early" ? "EARLY " : ""}IGNITION: ${x.symbol} (${x.chain}, Binance Alpha) ${fmtPx(f.close)}`,
    `Volume ${f.r1}x / ${f.r2}x normal (${fmtUsd(f.usd1)} / ${fmtUsd(f.usd2)} per 5 min, ${f.trades1} / ${f.trades2} trades) · ${sgn(f.move10)} in 10 min · ${sgn(f.chg24)} in 24h`,
    `Pool liquidity ${fmtUsd(x.liquidity)} · market cap ${fmtUsd(x.mcap)} · FDV ${fmtUsd(x.fdv)} · ${x.holders != null ? x.holders.toLocaleString("en-US") : "n/a"} holders${x.ageDays != null ? ` · on Alpha ${x.ageDays} days` : ""}`,
    d ? `DEX last 5 min: ${d.m5.buys ?? "?"} buys / ${d.m5.sells ?? "?"} sells${d.buyShare5m != null ? ` (${d.buyShare5m}% buys)` : ""} · last hour ${d.buyShare1h ?? "?"}% buys` : null,
    `Tracked: +${cfg.targetPct}% = ${fmtPx(f.close * (1 + cfg.targetPct / 100))}, stop -${cfg.stopPct}% = ${fmtPx(f.close * (1 - cfg.stopPct / 100))}, ${cfg.outcomeDays} days`,
    rp, "Thin pools, high slippage, can be delisted. Research tool, not financial advice."].filter(Boolean).join("\n");
}

// Track an alert with candles that came after it: target / stop / window end. Returns true when it changed.
export function advanceAlpha(a, rows, cfg, now = Date.now()) {
  const tr = a.track;
  if (tr.status !== "open") return false;
  const tp = a.f.close * (1 + cfg.targetPct / 100), sl = a.f.close * (1 - cfg.stopPct / 100), until = a.t + cfg.outcomeDays * DAY;
  let changed = false;
  for (const c of rows) {
    if (c[0] < tr.checkedTo || c[0] + STEP > now || c[0] >= until) continue;
    tr.checkedTo = c[0] + STEP; tr.last = c[4]; changed = true;
    tr.peakPct = r2(Math.max(tr.peakPct, (c[2] / a.f.close - 1) * 100), 1); tr.lowPct = r2(Math.min(tr.lowPct, (c[3] / a.f.close - 1) * 100), 1);
    if (c[3] <= sl) { Object.assign(tr, { status: "loss", resultPct: r2(-cfg.stopPct - cfg.costPct), endedAt: c[0] + STEP }); return true; }
    if (c[2] >= tp) { Object.assign(tr, { status: "win", resultPct: r2(cfg.targetPct - cfg.costPct), endedAt: c[0] + STEP }); return true; }
  }
  if (now >= until && tr.checkedTo >= until - STEP * 2) { Object.assign(tr, { status: "flat", resultPct: r2(((tr.last ?? a.f.close) / a.f.close - 1) * 100 - cfg.costPct), endedAt: until }); return true; }
  return changed;
}
export function alphaResults(alerts, tier = null) {
  if (tier) alerts = alerts.filter((a) => (a.tier || "confirmed") === tier);
  const done = alerts.filter((a) => a.track && a.track.status !== "open");
  const k = (s) => done.filter((a) => a.track.status === s).length;
  const sum = done.reduce((s, a) => s + (a.track.resultPct || 0), 0);
  return { alerts: alerts.length, open: alerts.length - done.length, closed: done.length, wins: k("win"), losses: k("loss"), flats: k("flat"),
    winPct: done.length ? Math.round((k("win") / done.length) * 100) : null, avgNetPct: done.length ? r2(sum / done.length) : null };
}

// Conditions the live results are split by (saved with each alert), for the winners-vs-losers table and the AI desk.
const hr = (a) => a.ctx?.hourUtc;
export const ALPHA_GROUPS = [
  ["Confirmed tier", (a) => a.tier === "confirmed"], ["Early tier", (a) => a.tier === "early"],
  ["Pool liquidity $500k+", (a) => a.token?.liquidity >= 5e5], ["Pool liquidity under $500k", (a) => a.token?.liquidity < 5e5],
  ["20,000+ holders", (a) => a.token?.holders >= 20_000], ["Under 20,000 holders", (a) => a.token?.holders < 20_000],
  ["On Alpha under 60 days", (a) => a.token?.ageDays != null && a.token.ageDays < 60], ["On Alpha 60+ days", (a) => a.token?.ageDays >= 60],
  ["DEX buyers 55%+ in the last 5 min", (a) => a.dex?.buyShare5m >= 55], ["DEX buyers under 55%", (a) => a.dex?.buyShare5m != null && a.dex.buyShare5m < 55],
  ["Second candle 20x+ normal volume", (a) => a.f?.r2 >= 20], ["Second candle under 20x", (a) => a.f?.r2 < 20],
  ["Up 10%+ in 24h before the alert", (a) => a.f?.chg24 >= 10], ["Up under 10% in 24h", (a) => a.f?.chg24 < 10],
  ["Alt season meter: alts leading", (a) => a.ctx?.altSeason === "altsLead"], ["Alt season meter: mixed", (a) => a.ctx?.altSeason === "mixed"],
  ["Alt season meter: BTC leading", (a) => a.ctx?.altSeason === "btcLeads"], ["BTC regime downtrend", (a) => a.ctx?.riskOff === true],
  ["BTC up over the last hour", (a) => a.ctx?.btc1h > 0], ["BTC down over the last hour", (a) => a.ctx?.btc1h != null && a.ctx.btc1h <= 0],
  ["Asia hours (00-08 UTC)", (a) => hr(a) != null && hr(a) < 8], ["Europe hours (08-14 UTC)", (a) => hr(a) >= 8 && hr(a) < 14],
  ["US hours (14-22 UTC)", (a) => hr(a) >= 14 && hr(a) < 22], ["Late US (22-24 UTC)", (a) => hr(a) >= 22],
  ["AI said TAKE", (a) => a.ai?.decision === "TAKE"], ["AI said WAIT", (a) => a.ai?.decision === "WAIT"], ["AI said NO TRADE", (a) => a.ai?.decision === "SKIP"],
  ["Alert within 60s of the candle close", (a) => a.ctx?.lagSec != null && a.ctx.lagSec <= 60], ["Alert 60s+ after the candle close", (a) => a.ctx?.lagSec > 60],
];
const AFTER_MARKS_5M = [["m5", 5], ["m15", 15]];

export function createAlpha({ fetchJson, stateFile = null, reportFile = null, sendTelegram = null, telegramConfigured = () => false, context = () => null, onAlert = null, wantTelegram = () => false }) {
  const cfg = alphaConfig();
  // alternative exits followed on every alert next to its own rule (exits.js)
  const exitRules = exitRulesFor({ targetPct: cfg.targetPct, stopPct: cfg.stopPct, hours: cfg.outcomeDays * 24 });
  const needsAfter = (a) => !!a.track.after && AFTER_MARKS_5M.some(([k]) => a.track.after[k] == null);
  const needsData = (a) => a.track.status === "open" || exitsOpen(a.track.exits) || needsAfter(a);
  const cursorOf = (a) => Math.min(a.track.status === "open" ? a.track.checkedTo : Infinity, needsAfter(a) ? a.t : Infinity,
    ...Object.values(a.track.exits || {}).filter((x) => x.x == null).map((x) => (x.to != null ? x.to + STEP : a.t)));
  function follow(a, k) {
    let changed = advanceAlpha(a, k, cfg);
    const done = k.filter((r) => r[0] + STEP <= Date.now()).map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] }));
    if (a.track.exits && applyExits(a.track.exits, exitRules, a.f.close, a.t, done, STEP)) changed = true;
    if (a.track.after && recordAfter(a.track.after, a.f.close, a.t, done, STEP, AFTER_MARKS_5M)) changed = true;
    return changed;
  }
  const st = { status: "starting", error: null, updatedAt: null, nextScanAt: null, listed: 0, eligible: 0, excluded: {}, rows: [], sources: { alpha: "waiting", dex: "waiting" }, scanMs: null };
  const candles = new Map(); // alphaId -> rows
  let store = { version: 1, alerts: [] }, replay = null, busy = false, started = false;
  const save = () => (stateFile ? writeFile(stateFile + ".tmp", JSON.stringify(store)).then(() => rename(stateFile + ".tmp", stateFile)).catch(() => {}) : null);
  async function load() {
    if (stateFile) { try { const s = JSON.parse(await readFile(stateFile, "utf8")); if (s?.version === 1 && Array.isArray(s.alerts)) store = s; } catch { /* first run */ } }
    await loadReport();
  }
  async function loadReport() {
    if (!reportFile) return;
    try {
      const r = JSON.parse(await readFile(reportFile, "utf8")), row = (k) => r.rows?.find((x) => x.key === k);
      replay = { days: r.window?.days, from: r.window?.from, to: r.window?.to, cost: r.window?.cost, universe: r.universe, perDay: r.perDay, rule: row("rule")?.all || null, ruleTune: row("rule")?.tune || null,
        ruleTest: row("rule")?.test || null, base: row("base1m")?.all || null, baseTune: row("base1m")?.tune || null, baseTest: row("base1m")?.test || null,
        baseAll: row("base")?.all || null, planned: row("planned")?.all || null, plannedPerDay: r.plannedPerDay, evaa: r.evaa && !Array.isArray(r.evaa) ? r.evaa : null, generatedAt: r.generatedAt };
    } catch { replay = null; }
  }
  const get = async (url) => { const j = await fetchJson(url, { retries: 1, timeoutMs: 15_000 }); if (j && j.success === false) throw new Error(j.message || "Alpha API error"); return j?.data ?? j; };
  const quotes = new Map(); // alphaId -> "USDT" | "USDC"
  async function klinesPage(id, opts) {
    const q = quotes.get(id) || "USDT";
    try { const k = await get(alphaKlinesUrl(id, { ...opts, quote: q })); quotes.set(id, q); return k; }
    catch (e) { if (q !== "USDT" || !/invalid symbol/i.test(e.message)) throw e; quotes.set(id, "USDC"); return get(alphaKlinesUrl(id, { ...opts, quote: "USDC" })); }
  }
  async function fetchCandles(id, sinceT) {
    const have = candles.get(id), now = Date.now();
    const from = sinceT ?? (have?.length && now - have[have.length - 1][0] < 2 * HOUR ? have[have.length - 1][0] - 2 * STEP : now - 300 * STEP);
    let rows = have || [];
    for (let t = from, pages = 0; t < now && pages < 6; pages++) {
      const k = parseKlines(await klinesPage(id, { limit: 1500, startTime: t }));
      if (!k.length) break;
      const m = new Map(rows.map((r) => [r[0], r])); for (const r of k) m.set(r[0], r);
      rows = [...m.values()].sort((a, b) => a[0] - b[0]);
      if (k.length < 1500) break;
      t = k[k.length - 1][0] + STEP;
    }
    const keepFrom = Math.min(now - 302 * STEP, ...store.alerts.filter((a) => a.alphaId === id && needsData(a)).map(cursorOf));
    rows = rows.filter((r) => r[0] >= keepFrom);
    candles.set(id, rows);
    return rows;
  }
  async function dexFor(tokens) {
    const out = new Map(), byChain = new Map();
    for (const x of tokens) { const c = DEX_CHAIN[x.chain]; if (c && x.contract) byChain.set(c, [...(byChain.get(c) || []), x]); }
    let ok = 0, bad = 0;
    for (const [chain, xs] of byChain) for (let i = 0; i < xs.length; i += 30) {
      const part = xs.slice(i, i + 30);
      try {
        const pairs = await fetchJson(`https://api.dexscreener.com/tokens/v1/${chain}/${part.map((x) => x.contract).join(",")}`, { retries: 1, timeoutMs: 15_000 });
        for (const x of part) { const d = dexSummary(pairs, x.contract); if (d) out.set(x.alphaId, d); }
        ok++;
      } catch { bad++; }
    }
    st.sources.dex = bad && !ok ? "error" : bad ? `partial (${bad} failed)` : "ok";
    return out;
  }
  const tokenOf = (x) => {
    const circ = num(x.circulatingSupply), tot = num(x.totalSupply);
    return { alphaId: x.alphaId, symbol: x.symbol, name: x.name, chain: x.chainName, contract: x.contractAddress, liquidity: r2(num(x.liquidity), 0), holders: num(x.holders),
      mcap: r2(num(x.marketCap), 0), fdv: r2(num(x.fdv), 0), circPct: circ && tot ? Math.round((circ / tot) * 100) : null, vol24: r2(num(x.volume24h), 0), chg24List: r2(num(x.percentChange24h), 2),
      price: num(x.price), ageDays: x.listingTime ? Math.floor((Date.now() - x.listingTime) / DAY) : null, icon: x.iconUrl || null };
  };
  async function scan() {
    const t0 = Date.now();
    let list;
    try { list = await get(ALPHA_LIST_URL); st.sources.alpha = "ok"; }
    catch (e) { st.sources.alpha = "error"; throw new Error(`Binance Alpha token list: ${e.message}`); }
    if (!Array.isArray(list)) throw new Error("Binance Alpha token list: unexpected answer");
    const excluded = {}, uni = [];
    for (const x of list) { const why = alphaEligible(x, cfg); if (why) excluded[why] = (excluded[why] || 0) + 1; else uni.push(tokenOf(x)); }
    const byId = new Map(list.map((x) => [x.alphaId, x]));
    // alerts still being followed keep their token in the scan even if it drops out of the list
    const ids = new Set(uni.map((x) => x.alphaId)), tracked = new Map();
    for (const a of store.alerts) if (needsData(a) && !ids.has(a.alphaId) && byId.has(a.alphaId)) tracked.set(a.alphaId, tokenOf(byId.get(a.alphaId)));
    // hottest tokens first (heating up or busy last scan), so an ignition is caught in the first seconds of the scan
    const prev = new Map(st.rows.map((r) => [r.alphaId, r])), heat = (x) => { const p = prev.get(x.alphaId); return p ? STATE_RANK[p.state] * 1000 + (p.f?.r2 ?? 0) : 0; };
    const order = [...uni].sort((a, b) => heat(b) - heat(a));
    let failed = 0;
    const end = Math.floor(Date.now() / STEP) * STEP, start = end - 300 * STEP, rows = [];
    await mapLimit([...order, ...tracked.values()], 4, async (x) => {
      try {
        const open = store.alerts.filter((a) => a.alphaId === x.alphaId && needsData(a));
        const since = open.length && !candles.has(x.alphaId) ? Math.min(...open.map(cursorOf)) : undefined; // after a restart: fill the gap
        const k = await fetchCandles(x.alphaId, since);
        for (const a of open) follow(a, k);
        if (!ids.has(x.alphaId)) return;
        const g = toGrid(k, start, end), f = alphaFeatures(g, g.length - 1, cfg), c = classifyAlpha(f, cfg);
        const row = { ...x, f, state: c.state, tier: c.tier, fails: c.fails };
        rows.push(row);
        if (row.tier) await raise(row); // alert right away, not at the end of the scan
      } catch { failed++; }
    });
    if (failed && failed >= uni.length * 0.5) st.sources.alpha = `partial (${failed} tokens failed)`;
    const dex = await dexFor(rows); // ~10 DexScreener calls (30 tokens each) per scan
    for (const r of rows) r.dex = dex.get(r.alphaId) || r.dex || null;
    // a token Binance removed from Alpha gets no more candles: close what is still open once the window is long over
    for (const a of store.alerts) if (needsData(a) && Date.now() > a.t + (cfg.outcomeDays + 2) * DAY) {
      if (a.track.status === "open") Object.assign(a.track, { status: "flat", noData: true, resultPct: r2(((a.track.last ?? a.f.close) / a.f.close - 1) * 100 - cfg.costPct), endedAt: a.track.checkedTo });
      for (const x of Object.values(a.track.exits || {})) if (x.x == null) Object.assign(x, { x: r2((x.last / a.f.close - 1) * 100), why: "no data" });
      if (a.track.after) for (const [k2] of AFTER_MARKS_5M) a.track.after[k2] ??= false; // false = never measured
    }
    store.alerts = store.alerts.slice(-500);
    rows.sort((a, b) => STATE_RANK[b.state] - STATE_RANK[a.state] || (b.f?.r2 ?? 0) - (a.f?.r2 ?? 0));
    Object.assign(st, { status: "ready", error: null, updatedAt: Date.now(), listed: list.length, eligible: uni.length, excluded, rows, scanMs: Date.now() - t0 });
    await save();
  }
  // A new alert: the rule passed on the last two finished candles, at most one per token and tier per 24 hours.
  async function raise(r) {
    const last = store.alerts.filter((a) => a.alphaId === r.alphaId && (a.tier || "confirmed") === r.tier).pop();
    if (last && r.f.t - last.t < DAY) return;
    if (!r.dex) r.dex = (await dexFor([r]).catch(() => new Map())).get(r.alphaId) || null;
    const { f, dex: d, fails, tier, state, ...token } = r, now = Date.now();
    const a = { id: `${r.alphaId}-${tier}-${f.t}`, alphaId: r.alphaId, tier, t: f.t, createdAt: now, f, dex: d, token,
      ctx: { ...(context() || {}), lagSec: Math.round((now - f.t) / 1000) },
      track: { status: "open", checkedTo: f.t, peakPct: 0, lowPct: 0, last: f.close, exits: newExits(exitRules, f.close), after: {} } };
    store.alerts.push(a);
    const kind = tier === "confirmed" ? "alpha" : "alphaEarly"; // confirmed: on by default; early: off (about 50 a day)
    if (sendTelegram && wantTelegram(kind)) sendTelegram(alphaTelegram(a, cfg, replay), kind).catch(() => {});
    if (onAlert) Promise.resolve().then(() => onAlert(a)).catch(() => {});
  }
  // Live results: by tier, under each exit rule, by condition (with older / newer halves), speed, and the AI's calls.
  function stats() {
    const closed = store.alerts.filter((a) => a.track.status !== "open" && Number.isFinite(a.track.resultPct));
    const items = closed.map((a) => ({ ...a, netPct: a.track.resultPct, win: a.track.status === "win" }));
    const overall = items.length ? r2(items.reduce((x, it) => x + it.netPct, 0) / items.length) : null;
    const exitItems = (tier) => store.alerts.filter((a) => (a.tier || "confirmed") === tier && a.track.exits)
      .map((a) => ({ exits: a.track.exits, t: a.t, mainPct: a.track.status !== "open" && Number.isFinite(a.track.resultPct) ? a.track.resultPct + cfg.costPct : undefined }));
    const main = `+${cfg.targetPct}% / -${cfg.stopPct}% (${cfg.outcomeDays} days): the alert's rule`;
    return { costPct: cfg.costPct, exits: { confirmed: exitSummary(exitItems("confirmed"), exitRules, cfg.costPct, main), early: exitSummary(exitItems("early"), exitRules, cfg.costPct, main) },
      speed: speedSummary(store.alerts.filter((a) => a.track.after).map((a) => ({ lagSec: a.ctx?.lagSec, after: a.track.after })), AFTER_MARKS_5M, 2),
      groups: groupSummary(items, ALPHA_GROUPS, overall),
      groupsByTier: Object.fromEntries(["confirmed", "early"].map((t) => { const g = items.filter((it) => (it.tier || "confirmed") === t);
        return [t, groupSummary(g, ALPHA_GROUPS, g.length ? r2(g.reduce((x, it) => x + it.netPct, 0) / g.length) : null)]; })),
      overallNetPct: overall, ai: aiCalibration(items) };
  }
  let statsCache = { at: 0, v: null };
  const statsNow = () => { if (Date.now() - statsCache.at > 20_000) statsCache = { at: Date.now(), v: stats() }; return statsCache.v; };
  async function tick() {
    if (busy) return;
    busy = true;
    try { await scan(); }
    catch (e) { st.error = e.message; st.status = st.rows.length ? "ready" : "error"; }
    finally { busy = false; schedule(); }
  }
  // scan 5 seconds after each 5-minute candle closes (every scanMinutes): Alpha's closed candle is final within ~2 seconds
  function schedule() {
    const now = Date.now(), every = cfg.scanMinutes * MIN, next = Math.floor(now / every) * every + every + 5_000;
    st.nextScanAt = next;
    setTimeout(tick, next - now);
  }
  return {
    config: cfg,
    start() {
      if (started) return; started = true;
      console.log(`Binance Alpha ignition: /screener#alpha | scan every ${cfg.scanMinutes} min | volume ${cfg.volMult}x, $${cfg.minCandleUsd}+ per 5m, confirmed with ${fmtUsd(cfg.min24hUsd)}+ 24h volume | liquidity ${fmtUsd(cfg.minLiquidityUsd)}+ | Telegram: ${wantTelegram("alpha") ? (wantTelegram("alphaEarly") ? "early + confirmed" : "confirmed") : wantTelegram("alphaEarly") ? "early" : "off"}`);
      load().finally(() => setTimeout(tick, 15_000));
      setInterval(loadReport, 10 * MIN); // picks up a fresh `node alpha-backtest.js` report
    },
    api() {
      const alerts = store.alerts.slice(-60).reverse();
      return { status: st.status, error: st.error, updatedAt: st.updatedAt, nextScanAt: st.nextScanAt, scanMs: st.scanMs, listed: st.listed, eligible: st.eligible, excluded: st.excluded,
        sources: st.sources, config: cfg, telegramOn: (wantTelegram("alpha") || wantTelegram("alphaEarly")) && telegramConfigured(),
        telegramKinds: { confirmed: wantTelegram("alpha"), early: wantTelegram("alphaEarly") }, states: ALPHA_STATES,
        counts: Object.fromEntries(Object.keys(ALPHA_STATES).map((k) => [k, st.rows.filter((r) => r.state === k).length])),
        rows: st.rows.slice(0, 80), alerts, results: alphaResults(store.alerts, "confirmed"), resultsEarly: alphaResults(store.alerts, "early"), replay, stats: statsNow() };
    },
    annotate(id, patch) { const a = store.alerts.find((x) => x.id === id); if (!a) return false; Object.assign(a, patch); statsCache.at = 0; save(); return true; },
    alertById: (id) => store.alerts.find((x) => x.id === id) || null,
    // Live data for one token (by Alpha id or symbol), for the AI desk.
    tokenFor(key) {
      const k = String(key || "").toUpperCase(), row = st.rows.find((r) => r.alphaId.toUpperCase() === k || String(r.symbol).toUpperCase() === k);
      if (!row) return null;
      return { ...row, alerts: store.alerts.filter((a) => a.alphaId === row.alphaId).slice(-3), quote: quotes.get(row.alphaId) || "USDT" };
    },
    // Groups that match an alert's conditions, with their live results (10+ closed alerts).
    // tier = "confirmed" / "early": only that tier's alerts; null = both
    matchingGroups(a, minResolved = 10, tier = null) {
      const st2 = statsNow(), groups = (tier ? st2.groupsByTier?.[tier] : st2.groups) || [], x = a.ctx ? a : { ...a, ctx: context() || {} }; // a token checked now: today's conditions
      return ALPHA_GROUPS.filter(([, fn]) => { try { return fn(x); } catch { return false; } }).map(([name]) => groups.find((g) => g.name === name))
        .filter((g) => g && g.resolved >= minResolved).map((g) => ({ group: g.name, resolved: g.resolved, hitTargetPct: g.winRatePct, avgNetPct: g.avgNetPct, olderPct: g.olderPct, newerPct: g.newerPct }));
    },
    results: () => ({ confirmed: alphaResults(store.alerts, "confirmed"), early: alphaResults(store.alerts, "early") }),
    replayRates: () => replay,
  };
}

// Replay test for the screener's ignition logic on past Binance 5-minute candles. Node.js 18+, no dependencies.
//
//   node screener-backtest.js                      # last 30 days, top 80 Binance USDT tokens by volume
//   node screener-backtest.js --days 45 --symbols 120
//   node screener-backtest.js --list SOL,SUI,LINK,INJ --days 20
//   node screener-backtest.js --refresh            # ignore the download cache
//
// It imports the live signal functions from screener.js (without starting the server), so it replays the same rules.
// For every 5 minutes of history it rebuilds each token's 15m and 1h volume vs its own hour-of-day normal, the 5m
// confirmation features and the daily score, then follows each signal forward with the same win / loss / flat rule.
// Settings are tuned on the first two thirds of the period and judged on the last third, which the tuning never saw.
// Only the last-third numbers say anything about the future.
//
// Not available historically, so left out: spread, funding, open interest, CoinGecko narratives and categories.
// Prices are checked on 5m candles; when target and stop are both touched inside one candle it counts as a loss.
// Past results do not guarantee future results. Research tool, not financial advice.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SCREENER_LIBRARY_ONLY = "1";
const core = await import("./screener.js");
const { fiveMinFeatures, classifyIgnition, ignitionScore, scoreToken, techMetrics, hourlyProfile, fetchJson, usedWeight,
  DEFAULT_IGNITION, CONFIG, STABLES, NONCRYPTO } = core;

const here = path.dirname(fileURLToPath(import.meta.url));
const BN = "https://api.binance.com";
const STEP = 300_000, HOUR = 3_600_000, DAY = 86_400_000;
const argv = process.argv.slice(2);
const arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAYS = clamp(Number(arg("days", 30)) || 30, 6, 90);
const TOPN = clamp(Number(arg("symbols", 80)) || 80, 5, 200);
const LIST = String(arg("list", "")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const REFRESH = argv.includes("--refresh");
const MIN_N = Number(arg("min-signals", 25)) || 25;
const CACHE = path.join(here, "backtest_cache");
const WARM_DAYS = 15;                               // 14 days for hour-of-day baselines + 1 day for 24h figures
const HORIZON = Math.round(CONFIG.outcomeHours * 12);
const COOLDOWN = CONFIG.igniteCooldownHours * HOUR;
const FEE = CONFIG.feePct;
const LOOSE_RVOL = 3;                               // lowest 15m volume setting in the grid

// Exit rules compared at the end. The first one is the live rule.
const RULES = [[CONFIG.targetPct, CONFIG.stopPct], [3, 2], [3, 3], [2, 2], [6, 3], [2, 4], [1.5, 4], [1, 5]]
  .filter((r, i, a) => a.findIndex((x) => x[0] === r[0] && x[1] === r[1]) === i);

// The v3 ignition score, kept only so the replay can compare old and new logic on the same data.
function legacyScore(f, ctxScore) {
  const r = f.rvol15, per = f.persist ?? 0, tr = f.tradesRatio ?? 0, b = f.buy15 ?? 0, rp = f.rangePos ?? 0, rs = f.rs15 ?? 0;
  return Math.round((r >= 8 ? 25 : r >= 6 ? 21 : r >= 4 ? 16 : r >= 3 ? 10 : 0)
    + (per >= 3 ? 9 : per === 2 ? 6 : per === 1 ? 2 : 0) + (tr >= 2 ? 6 : tr >= 1.5 ? 4 : tr >= 1.2 ? 2 : 0)
    + (b >= 70 ? 15 : b >= 64 ? 11 : b >= 58 ? 7 : b >= 52 ? 3 : 0)
    + (rp >= 0.8 ? 8 : rp >= 0.6 ? 5 : 0) + (f.nearHigh ? 3 : 0) + (f.ret15 >= 0.2 && f.ret15 <= 2 ? 4 : f.ret15 > 2 ? 2 : 0)
    + (rs >= 0.5 ? 5 : rs >= 0.1 ? 3 : 0) + Math.round(clamp(ctxScore, 0, 100) * 0.15) + 2 + 1);
}
const LEGACY = { ...DEFAULT_IGNITION, rvol: 4, minBuy: 58, minPersist: 2, minRangeRatio: 0, btc1hMin: -Infinity, requireTrend: false, maxExt: Infinity, maxFade: Infinity, maxWick: Infinity };

// ───────────────────────────── download (cached) ─────────────────────────────
async function throttle() { if (usedWeight() > 3500) { process.stdout.write(" (pausing for Binance rate limit)"); await sleep(30_000); } }
async function cached(name, load) {
  const file = path.join(CACHE, name);
  if (!REFRESH) { try { return JSON.parse(await readFile(file, "utf8")); } catch { /* not cached */ } }
  const data = await load();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}
const klines5m = (sym, start, end) => cached(`${sym}_5m_${start}_${end}.json`, async () => {
  const rows = [];
  for (let from = start; from < end;) {
    await throttle();
    const k = await fetchJson(`${BN}/api/v3/klines?symbol=${sym}USDT&interval=5m&startTime=${from}&endTime=${end - 1}&limit=1000`);
    if (!Array.isArray(k) || !k.length) break;
    for (const c of k) if (Number(c[0]) < end) rows.push([Number(c[0]), +c[1], +c[2], +c[3], +c[4], +c[7], +c[8], +c[10]]);
    if (k.length < 1000) break;
    from = Number(k[k.length - 1][0]) + STEP;
    await sleep(80);
  }
  return rows;
});
const klines1d = (sym, end) => cached(`${sym}_1d_${end}.json`, async () => {
  await throttle();
  const k = await fetchJson(`${BN}/api/v3/klines?symbol=${sym}USDT&interval=1d&endTime=${end - 1}&limit=${DAYS + WARM_DAYS + 45}`);
  return Array.isArray(k) ? k.map((c) => [Number(c[0]), +c[2], +c[3], +c[4], +c[7]]) : [];
});
async function pickSymbols() {
  if (LIST.length) return [...new Set(["BTC", ...LIST])];
  const t = await fetchJson(`${BN}/api/v3/ticker/24hr`, { timeoutMs: 20_000 });
  return ["BTC", ...t.filter((x) => /USDT$/.test(x.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol))
    .map((x) => [x.symbol.slice(0, -4), Number(x.quoteVolume)])
    .filter(([b, v]) => b !== "BTC" && !STABLES.has(b) && !NONCRYPTO.has(b) && v >= CONFIG.minQuoteVolume)
    .sort((a, b) => b[1] - a[1]).slice(0, TOPN - 1).map(([b]) => b)];
}

// ───────────────────────────── replay ─────────────────────────────
const end = Math.floor(Date.now() / HOUR) * HOUR;    // closed candles only; reruns within the hour reuse the cache
const sigStart = end - DAYS * DAY, start = sigStart - WARM_DAYS * DAY;
const N = (end - start) / STEP, H = N / 12;
const tGrid = Float64Array.from({ length: N }, (_, i) => start + i * STEP);
const hourOf = (i) => Math.floor(tGrid[i] / HOUR) % 24;

function buildSeries(name, rows, daily) {
  const mk = () => new Float64Array(N).fill(NaN);
  const k = { t: tGrid, open: mk(), high: mk(), low: mk(), close: mk(), qv: mk(), trades: mk(), buy: mk() };
  for (const r of rows) {
    const i = (r[0] - start) / STEP;
    if (!Number.isInteger(i) || i < 0 || i >= N) continue;
    k.open[i] = r[1]; k.high[i] = r[2]; k.low[i] = r[3]; k.close[i] = r[4]; k.qv[i] = r[5]; k.trades[i] = r[6]; k.buy[i] = r[7];
  }
  let first = -1;
  for (let i = 0; i < N; i++) {
    if (Number.isFinite(k.close[i])) { if (first < 0) first = i; continue; }
    if (first >= 0) { const c = k.close[i - 1]; k.open[i] = k.high[i] = k.low[i] = k.close[i] = c; k.qv[i] = k.trades[i] = k.buy[i] = 0; } // gap: flat, no volume
  }
  if (first < 0) return null;
  const ps = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) ps[i + 1] = ps[i] + (Number.isFinite(k.qv[i]) ? k.qv[i] : 0);
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
    const hs = (WARM_DAYS + d) * 24;
    prof.push(hourlyProfile(hc, hs - 335, hs));
    const dayStart = sigStart + d * DAY, closed = daily.filter((r) => r[0] + DAY <= dayStart).slice(-40);
    days.push(closed.length >= 29 ? { closes: closed.map((r) => r[3]), highs: closed.map((r) => r[1]), qvols: closed.map((r) => r[4]) } : null);
  }
  return { name, k, first, ps, prof, days };
}

const qvSum = (s, a, b) => s.ps[b + 1] - s.ps[a];
const expSum = (prof, a, b) => { let x = 0; for (let j = a; j <= b; j++) x += prof.hours[hourOf(j)] / 12; return x; };
const ret = (s, i, back) => (s.k.close[i] / s.k.close[i - back] - 1) * 100;

function follow(s, i, T, S) { // forward path of one signal, entry at the signal candle's close
  const k = s.k, entry = k.close[i], up = entry * (1 + T / 100), dn = entry * (1 - S / 100);
  for (let j = i + 1; j <= i + HORIZON; j++) {
    if (k.low[j] <= dn) return { o: "loss", r: (Math.min(dn, k.open[j]) / entry - 1) * 100 }; // checked first: a candle touching both counts as a loss
    if (k.high[j] >= up) return { o: "win", r: T };
  }
  return { o: "flat", r: (k.close[i + HORIZON] / entry - 1) * 100 };
}

function replay(series) {
  const btc = series.find((s) => s.name === "BTC");
  if (!btc) throw new Error("BTC data is required");
  const cands = [];
  const i0 = (sigStart - start) / STEP;
  for (let i = i0; i < N - HORIZON; i++) {
    const d = Math.floor((i - i0) / 288);
    if (i - 288 < btc.first) continue;
    const btc24 = ret(btc, i, 288), btc15 = ret(btc, i, 3), btc1h = ret(btc, i, 12);
    if (!(btc24 > CONFIG.btcDropPausePct)) continue; // live alerts pause when BTC dumps
    let valid = 0, hot = 0;
    for (const s of series) {
      s.r15 = null;
      const prof = s.prof[d];
      if (!prof || i - 288 < s.first || !s.days[d]) continue;
      const e = expSum(prof, i - 2, i);
      if (!(e > 0)) continue;
      s.r15 = qvSum(s, i - 2, i) / e; valid++;
      if (s.r15 >= 2) hot++;
    }
    const marketWide = valid > 0 && hot / valid >= CONFIG.marketWideShare;
    for (const s of series) {
      if (s.r15 == null || s.r15 < LOOSE_RVOL) continue;
      const ret15 = ret(s, i, 3);
      if (!(ret15 >= CONFIG.minMove15m && ret15 <= CONFIG.maxMove15m)) continue;
      const prof = s.prof[d], close = s.k.close[i], qv24 = qvSum(s, i - 287, i), change24h = ret(s, i, 288);
      const tm = techMetrics(s.days[d], close, qv24);
      if (!tm) continue;
      const f = {
        rvol15: s.r15, ret15, rvol1h: qvSum(s, i - 11, i) / expSum(prof, i - 11, i), ret1h: ret(s, i, 12), spreadBps: null,
        marketWide, rs15: ret15 - btc15, btc1h, range6h: prof.range6h, seasonal: true,
        ...fiveMinFeatures(s.k, i, tGrid[i] + STEP, (endMs) => prof.hours[Math.floor((endMs - STEP) / HOUR) % 24] / 12),
      };
      const ctx = scoreToken(tm, null, null, null, null, qv24, change24h).score;
      cands.push({
        s: s.name, i, t: tGrid[i], f, change24h, distToHigh: tm.distToHigh,
        ig: ignitionScore(f, ctx, null, null).score, legacy: legacyScore(f, ctx),
        out: RULES.map(([T, S]) => follow(s, i, T, S)),
      });
    }
  }
  return cands;
}

// ───────────────────────────── evaluation ─────────────────────────────
function select(cands, pass) { // live cooldown: one alert per token per cooldown window
  const last = new Map(), out = [];
  cands.forEach((c, idx) => {
    if (!pass(c, idx)) return;
    const prev = last.get(c.s);
    if (prev != null && c.t - prev < COOLDOWN) return;
    last.set(c.s, c.t); out.push(c);
  });
  return out;
}
function stats(evts, rule = 0) {
  if (!evts.length) return { n: 0, wins: 0, losses: 0, flat: 0, winRate: null, gross: null, net: null };
  let w = 0, l = 0, sum = 0;
  for (const e of evts) { const x = e.out[rule]; if (x.o === "win") w++; else if (x.o === "loss") l++; sum += x.r; }
  return { n: evts.length, wins: w, losses: l, flat: evts.length - w - l, winRate: (w / evts.length) * 100, gross: sum / evts.length, net: sum / evts.length - FEE };
}
const fmtP = (v, d = 2) => (v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(d) + "%");
const fmtW = (s) => (s.winRate == null ? "—" : s.winRate.toFixed(0) + "%");
const row = (cells, widths) => cells.map((c, j) => String(c).padEnd(widths[j])).join(" ");
const day = (t) => new Date(t).toISOString().slice(0, 10);

async function main() {
  console.log(`Early Setup Screener v${CONFIG.version} replay: ${DAYS} days to ${day(end)}, exit rule +${CONFIG.targetPct}% / -${CONFIG.stopPct}% within ${CONFIG.outcomeHours}h, fees ${FEE}% per trade\n`);
  const syms = await pickSymbols();
  console.log(`Downloading 5m candles for ${syms.length} tokens (cached in ./backtest_cache after the first run)…`);
  const series = [];
  let done = 0;
  for (const sym of syms) {
    try {
      const [rows, daily] = [await klines5m(sym, start, end), await klines1d(sym, end)];
      const s = buildSeries(sym, rows, daily);
      if (s) series.push(s);
    } catch (e) { console.log(`\n  skipped ${sym}: ${e.message}`); }
    process.stdout.write(`\r  ${++done}/${syms.length}`);
  }
  console.log(`\nReplaying ${series.length} tokens…`);
  const cands = replay(series).sort((a, b) => a.t - b.t);
  const split = sigStart + Math.round((DAYS * 2) / 3) * DAY;
  const isTrain = (c) => c.t < split;
  console.log(`${cands.length} raw candidate moments. Tuning period ${day(sigStart)} to ${day(split)}, unseen test period ${day(split)} to ${day(end)}.\n`);

  // 1) Old vs new logic, whole period, live exit rule
  const v3 = select(cands, (c) => classifyIgnition(c.f, c.change24h, c.distToHigh, LEGACY).state === "ignited" && c.legacy >= 65);
  const v4 = select(cands, (c) => classifyIgnition(c.f, c.change24h, c.distToHigh).state === "ignited" && c.ig >= CONFIG.igniteMinScore);
  const W1 = [30, 8, 6, 6, 6, 12];
  console.log("OLD vs NEW LOGIC (whole period, live exit rule)");
  console.log(row(["", "Signals", "Win", "Loss", "Flat", "Avg net"], W1));
  for (const [name, ev] of [["v3 logic (before)", v3], [`v${CONFIG.version} logic (current settings)`, v4]]) {
    const s = stats(ev);
    console.log(row([name, s.n, fmtW(s), s.n ? ((s.losses / s.n) * 100).toFixed(0) + "%" : "—", s.n ? ((s.flat / s.n) * 100).toFixed(0) + "%" : "—", fmtP(s.net)], W1));
  }

  // 2) Grid: tune on the first two thirds, judge on the last third
  const GRID = [];
  for (const rvol of [3, 4, 5, 6]) for (const minBuy of [52, 58, 64]) for (const requireTrend of [true, false]) for (const minRangeRatio of [0.35, 0.5, 0.7])
    GRID.push({ ...DEFAULT_IGNITION, rvol, minBuy, requireTrend, minRangeRatio });
  const results = [];
  for (const p of GRID) {
    const passIg = cands.map((c) => classifyIgnition(c.f, c.change24h, c.distToHigh, p).state === "ignited");
    for (const minScore of [55, 60, 65, 70, 75]) {
      const ev = select(cands, (c, idx) => passIg[idx] && c.ig >= minScore);
      results.push({ p, minScore, train: stats(ev.filter(isTrain)), test: stats(ev.filter((c) => !isTrain(c))) });
    }
  }
  const eligible = results.filter((r) => r.train.n >= MIN_N);
  const desc = (r) => `vol ${r.p.rvol}x, buyers ${r.p.minBuy}%, trend ${r.p.requireTrend ? "on" : "off"}, range ${r.p.minRangeRatio}, score ${r.minScore}`;
  const W2 = [66, 7, 6, 9, 6, 6, 9];
  console.log(`\nBEST SETTINGS ON THE TUNING PERIOD, THEN CHECKED ON THE UNSEEN PERIOD (at least ${MIN_N} tuning signals)`);
  console.log(row(["Settings", "Tune n", "Win", "Avg net", "Test n", "Win", "Avg net"], W2));
  // Settings that pick exactly the same signals are shown once (the simplest of them), with a count of the others.
  const groups = new Map();
  for (const r of eligible) {
    const key = [r.train.n, r.train.net, r.test.n, r.test.net].map((x) => (x == null ? "-" : x.toFixed?.(6) ?? x)).join("|");
    if (groups.has(key)) groups.get(key).same++; else groups.set(key, { ...r, same: 0 });
  }
  const best = [...groups.values()].sort((a, b) => b.train.net - a.train.net).slice(0, 10);
  for (const r of best) console.log(row([desc(r) + (r.same ? ` (+${r.same} same)` : ""), r.train.n, fmtW(r.train), fmtP(r.train.net), r.test.n, fmtW(r.test), fmtP(r.test.net)], W2));
  if (!best.length) console.log(`  No setting produced ${MIN_N}+ signals. Use more --days or --symbols, or lower --min-signals.`);
  const topWin = [...eligible].sort((a, b) => b.train.winRate - a.train.winRate)[0];
  if (topWin) {
    console.log(`\nHighest win rate found: ${desc(topWin)}`);
    console.log(`  tuning ${fmtW(topWin.train)} win over ${topWin.train.n} signals (${fmtP(topWin.train.net)} avg net), unseen period ${fmtW(topWin.test)} over ${topWin.test.n} (${fmtP(topWin.test.net)})`);
  }

  // 3) Exit rules: what the win rate does when the target and stop change
  const W3 = [16, 8, 6, 6, 6, 10];
  console.log(`\nEXIT RULES for v${CONFIG.version} signals (whole period). Win rate rises as the target shrinks; check the average.`);
  console.log(row(["Target / stop", "Signals", "Win", "Loss", "Flat", "Avg net"], W3));
  RULES.forEach(([T, S], r) => {
    const s = stats(v4, r);
    console.log(row([`+${T}% / -${S}%`, s.n, fmtW(s), s.n ? ((s.losses / s.n) * 100).toFixed(0) + "%" : "—", s.n ? ((s.flat / s.n) * 100).toFixed(0) + "%" : "—", fmtP(s.net)], W3));
  });

  // 4) Which features separate winners (current settings, whole period)
  const W4 = [32, 8, 6, 10];
  console.log(`\nWHAT SEPARATES WINNERS (v${CONFIG.version} signals, whole period)`);
  console.log(row(["Group", "Signals", "Win", "Avg net"], W4));
  for (const [name, fn] of [
    ["Broke 12h high", (c) => c.f.breakout === true], ["Inside 12h range", (c) => c.f.breakout === false],
    ["Typical 6h range 2x target+", (c) => c.f.range6h >= 2 * CONFIG.targetPct], ["Typical 6h range under 2x", (c) => c.f.range6h < 2 * CONFIG.targetPct],
    ["15m volume 6x+", (c) => c.f.rvol15 >= 6], ["15m volume under 6x", (c) => c.f.rvol15 < 6],
    ["Buyers 65%+", (c) => c.f.buy15 >= 65], ["Buyers under 65%", (c) => c.f.buy15 < 65],
    ["Ignition score 75+", (c) => c.ig >= 75], ["Ignition score under 75", (c) => c.ig < 75],
  ]) { const s = stats(v4.filter(fn)); if (s.n) console.log(row([name, s.n + (s.n < 20 ? " (few)" : ""), fmtW(s), fmtP(s.net)], W4)); }

  // 5) Verdict
  const pick = best.find((r) => r.test.n >= 15 && r.test.net > 0);
  console.log("\nVERDICT");
  if (pick) {
    console.log(`  Best setting that also made money on the unseen period: ${desc(pick)}`);
    console.log(`  To use it: SCREENER_IGNITE_RVOL=${pick.p.rvol} SCREENER_MIN_BUY_RATIO=${pick.p.minBuy} SCREENER_REQUIRE_TREND=${pick.p.requireTrend ? 1 : 0} ` +
      `SCREENER_MIN_RANGE_RATIO=${pick.p.minRangeRatio} SCREENER_IGNITE_MIN_SCORE=${pick.minScore} node screener.js`);
    console.log("  Then let the live Alert performance panel confirm it over a few weeks before trusting it with size.");
  } else {
    console.log("  No setting stayed profitable after fees on the unseen period. Do not trade this signal on its own as is;");
    console.log("  try a longer period (--days 60), more tokens (--symbols 150) or other exit rules (SCREENER_TARGET_PCT / SCREENER_STOP_PCT).");
  }
  console.log("\nNot included: spread, funding, open interest, narratives. Universe = today's top tokens by volume, which flatters results a little.");
  await writeFile(path.join(here, "backtest_report.json"), JSON.stringify({
    generatedAt: new Date().toISOString(), days: DAYS, tokens: series.map((s) => s.name), split: day(split), config: CONFIG,
    oldVsNew: { v3: stats(v3), v4: stats(v4) },
    grid: results.map((r) => ({ ...r, p: { rvol: r.p.rvol, minBuy: r.p.minBuy, requireTrend: r.p.requireTrend, minRangeRatio: r.p.minRangeRatio } })),
    exitRules: RULES.map(([T, S], r) => ({ target: T, stop: S, ...stats(v4, r) })),
    signals: v4.map((c) => ({ token: c.s, time: new Date(c.t).toISOString(), igScore: c.ig, outcome: c.out[0].o, resultPct: +c.out[0].r.toFixed(2) })),
  }, null, 1));
  console.log("Full results saved to backtest_report.json");
}

main().catch((e) => { console.error(`\nBacktest failed: ${e.message}`); process.exit(1); });
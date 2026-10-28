// Early 2x Movers: a research screen for low- and mid-cap Binance spot USDT tokens that show measurable signs of a
// possible large move up (research target +100% within 1-14 days, plus a 15-42 day horizon) BEFORE price expands.
// A 2x move is a research target, not a prediction: the screen only lists coins whose data passes its rules, every
// listed coin is saved as an unchangeable snapshot and its real forward returns are measured, and no result is called
// profitable until enough tracked signals say so. Runs inside the screener (node server.js or node screener.js),
// page tab /screener#early2x, API /api/early2x. The Ignition strategy is not changed by this file.
//
// Universe: Binance spot USDT pairs with a verified market cap of $10M-$1B (preferred up to $500M), 24h volume and a
// spread limit; stablecoins, wrapped / staked tokens, tokenized stocks and leveraged tokens are left out. Market cap =
// Binance's own circulating supply x price (the product list the screener already uses), cross-checked with CoinGecko
// when it can be reached. A coin without a verified market cap is never listed.
//
// Two independent models, both on finished candles only:
//   A  Quiet accumulation: 24h volume >= 2x its 7-day baseline (with more trades, held over several hours) while price
//      stays within a volatility-aware band. Pre-breakout = the same, pressing a tested 7-day range high.
//   B  Early ignition: the last 3+ five-minute candles each >= 2x normal for that hour of day and accelerating, with
//      aggressive buying confirmed by executed trades and price rising, without being stretched.
// Evidence is grouped into five independent families (activity, executed buying, structure, order book, strength vs
// BTC); indicators that measure the same thing (volume and trade count, CVD and buy share, large-trade buying) count
// once. High priority needs 3+ families plus mandatory liquidity, data-quality, extension, BTC and supply checks.
// Futures data and on-chain flows are shown as context only and never count as proof of spot accumulation.
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchJson, mapLimit, STABLES, NONCRYPTO, isNonCryptoInfo, assetInfo, loadAssetInfo, assetInfoStatus } from "./screener.js";
import { tokenWhaleSummary } from "./whales.js";
import { tokenFlowSummary } from "./flows.js";

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = env.DEMO === "1";
const BN = (env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");
const BF = (env.BINANCE_FUTURES_URL || "https://fapi.binance.com").replace(/\/$/, "");
const CG = "https://api.coingecko.com/api/v3";
const STATE_FILE = path.join(here, DEMO ? "early2x_state.demo.json" : "early2x_state.json");
const CG_FILE = path.join(here, "early2x_coingecko.json");
const EVENTS_FILE = path.join(here, "data", "early2x-events.json");
export const LOGIC_VERSION = 1;
export const STATE_VERSION = 1;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// Every threshold is a setting (EARLY2X_* in .env). Percent values are in %, e.g. 0.3 = 0.30%.
export const DEFAULT_WEIGHTS = { volume: 20, flow: 20, structure: 15, liquidity: 10, strength: 10, compression: 10, tokenomics: 10, data: 5 };
const WEIGHT_ENV = { volume: "VOLUME", flow: "FLOW", structure: "STRUCTURE", liquidity: "LIQUIDITY", strength: "STRENGTH", compression: "COMPRESSION", tokenomics: "TOKENOMICS", data: "DATA" };
export const CONFIG = Object.freeze({
  scanMinutes: Math.max(2, num("EARLY2X_SCAN_MINUTES", 5)),
  mcapMin: num("EARLY2X_MCAP_MIN", 10e6), mcapPreferredMax: num("EARLY2X_MCAP_PREFERRED_MAX", 500e6), mcapMax: num("EARLY2X_MCAP_MAX", 1e9),
  minQuoteVolume: num("EARLY2X_MIN_QUOTE_VOLUME", 1e6), maxSpreadPct: num("EARLY2X_MAX_SPREAD_PCT", 0.3),
  minDepthUsd: num("EARLY2X_MIN_DEPTH_USD", 10_000),            // each side of the book within +-2%
  minHistoryDays: num("EARLY2X_MIN_HISTORY_DAYS", 14),          // less = "recently listed" flag
  baselineDays: 8,                                              // 7-day baseline + the last 24h: needed to judge at all
  aVolRatio: num("EARLY2X_A_VOLUME_RATIO", 2), aTradesRatio: num("EARLY2X_A_TRADES_RATIO", 1.3), aMinPersist: num("EARLY2X_A_MIN_PERSIST_HOURS", 3),
  quietDailyMult: num("EARLY2X_QUIET_RANGE_MULT", 0.8), quietMinPct: num("EARLY2X_QUIET_MIN_PCT", 4), quietMaxPct: num("EARLY2X_QUIET_MAX_PCT", 12),
  bRvol5: num("EARLY2X_B_RVOL_5M", 2), bCandles: num("EARLY2X_B_CANDLES", 3), bMinBuy: num("EARLY2X_B_MIN_BUY_PCT", 55), bTradesRatio: num("EARLY2X_B_TRADES_RATIO", 1.5),
  nearBreakoutPct: num("EARLY2X_NEAR_BREAKOUT_PCT", 4),
  minConfirmations: num("EARLY2X_MIN_CONFIRMATIONS", 3), minListConfirmations: num("EARLY2X_MIN_LIST_CONFIRMATIONS", 2),
  minHighScore: num("EARLY2X_HIGH_MIN_SCORE", 50),             // high priority also needs this score

  // Late entry: limits grow with the coin's own typical daily range (volatile coins may move more before it is "late").
  ext24MinPct: num("EARLY2X_EXT_24H_MIN_PCT", 15), ext24DailyMult: num("EARLY2X_EXT_24H_RANGE_MULT", 2),
  ext4hMinPct: num("EARLY2X_EXT_4H_MIN_PCT", 10), ext4hDailyMult: num("EARLY2X_EXT_4H_RANGE_MULT", 1.25),
  ext7dMinPct: num("EARLY2X_EXT_7D_MIN_PCT", 40), ext7dDailyMult: num("EARLY2X_EXT_7D_RANGE_MULT", 3.5),
  breakoutExtMinPct: num("EARLY2X_BREAKOUT_EXT_MIN_PCT", 5), breakoutExtDailyMult: num("EARLY2X_BREAKOUT_EXT_RANGE_MULT", 0.75),
  btc24Min: num("EARLY2X_BTC_24H_MIN", -3), btc4hMin: num("EARLY2X_BTC_4H_MIN", -1.5),
  crowdedFundingPct: num("EARLY2X_CROWDED_FUNDING_PCT", 0.05),  // per 8h
  unlockDays: num("EARLY2X_UNLOCK_DAYS", 30), unlockMajorPct: num("EARLY2X_UNLOCK_MAJOR_PCT", 2), // % of circulating supply
  minCirculatingPct: num("EARLY2X_MIN_CIRCULATING_PCT", 40),   // less of max supply circulating = supply risk flag
  mcapTolerancePct: num("EARLY2X_MCAP_TOLERANCE_PCT", 25),     // Binance vs CoinGecko market cap: further apart = not verified
  largeTradeMinUsd: num("EARLY2X_LARGE_TRADE_USD", 5000),
  deepLimit: num("EARLY2X_DEEP_LIMIT", 30),                     // coins per scan that get order book, trades and futures data
  // Tracking (research only: nothing is traded)
  stopPct: num("EARLY2X_STOP_PCT", 20), feePct: num("EARLY2X_FEE_PCT", 0.2), slippagePct: num("EARLY2X_SLIPPAGE_PCT", 0.3),
  cooldownHours: num("EARLY2X_COOLDOWN_HOURS", 24), movedCooldownHours: num("EARLY2X_MOVED_COOLDOWN_HOURS", 72),
  maxSnapshotsPerDay: num("EARLY2X_MAX_SNAPSHOTS_PER_DAY", 150), minSample: num("EARLY2X_MIN_SAMPLE", 30),
  alerts: env.EARLY2X_ALERTS === "1",                          // Telegram: off until explicitly enabled
  weights: Object.freeze(Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([k, d]) => [k, Math.max(0, num(`EARLY2X_W_${WEIGHT_ENV[k]}`, d))]))),
});
export const TARGETS = [25, 50, 100];
export const HORIZONS = [["1h", 1], ["6h", 6], ["12h", 12], ["24h", 24], ["3d", 72], ["7d", 168], ["14d", 336], ["21d", 504], ["42d", 1008]];
export const STATES = { quiet: "Quiet accumulation", prebreakout: "Pre-breakout", ignition: "Early ignition", moved: "Already moved — do not chase" };
const STATE_RANK = { moved: 0, quiet: 1, prebreakout: 2, ignition: 3 };
export const MCAP_BANDS = [["$10M-$50M", 0, 50e6], ["$50M-$150M", 50e6, 150e6], ["$150M-$500M", 150e6, 500e6], ["$500M-$1B", 500e6, Infinity]];
export const SCORE_BANDS = [["70+", 70, 101], ["55-69", 55, 70], ["40-54", 40, 55], ["under 40", -1, 40]];

// ───────────────────────────── small helpers ─────────────────────────────
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r = (v, d = 2) => (isNum(v) ? Number(v.toFixed(d)) : null);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const med = (a) => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctChg = (now, then) => (isNum(now) && isNum(then) && then > 0 ? (now / then - 1) * 100 : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ema = (vals, len) => { const k = 2 / (len + 1); const out = []; let e = vals[0]; for (const v of vals) { e = v * k + e * (1 - k); out.push(e); } return out; };
const fmtUsd = (v) => (!isNum(v) ? "n/a" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
const fmtPx = (v) => (!isNum(v) ? "n/a" : v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));
const sgn = (v, d = 1) => (!isNum(v) ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
export const bandOf = (bands, v) => (isNum(v) ? (bands.find(([, lo, hi]) => v >= lo && v < hi) || [null])[0] : null);

// Binance kline rows -> columns. Only candles that have finished by `now` are kept (no look-ahead into a forming candle).
export function cols(raw, durMs, now = Date.now()) {
  const rows = (Array.isArray(raw) ? raw : []).filter((k) => Number(k[0]) + durMs <= now);
  return {
    t: rows.map((k) => Number(k[0])), o: rows.map((k) => Number(k[1])), h: rows.map((k) => Number(k[2])), l: rows.map((k) => Number(k[3])),
    c: rows.map((k) => Number(k[4])), qv: rows.map((k) => Number(k[7])), n: rows.map((k) => Number(k[8])), tb: rows.map((k) => Number(k[10])),
  };
}

// ───────────────────────────── universe ─────────────────────────────
const WRAPPED = /^(W(BTC|ETH|BNB|SOL|BETH)|(ST|WST|CB|R|M|E|EZ|RS|OS|SW)ETH|CBBTC|BTCB|BETH|WBETH|BNSOL|BBSOL|JITOSOL|MSOL|JUPSOL|SAVAX|STSOL|LBTC|SOLVBTC|TBTC|FBTC|ENZOBTC)$/;
// Why a pair is not in the universe (null = it is in). `info` = Binance product info { name, tags }.
export function exclusionReason(base, info, listedBases = new Set()) {
  if (STABLES.has(base) || (info?.tags || []).some((t) => /stable/i.test(t))) return "stablecoin";
  if (NONCRYPTO.has(base) || WRAPPED.test(base) || /\bwrapped\b|\bbridged\b|liquid.?stak|staked /i.test(info?.name || "")) return "wrapped";
  if (isNonCryptoInfo(info)) return "tokenized stock / commodity";
  const lev = base.match(/^(.{3,})(UP|DOWN|BULL|BEAR)$/);
  if (lev && listedBases.has(lev[1]) && (!info || /up|down|bull|bear|leverag/i.test(info.name || ""))) return "leveraged token";
  return null;
}

// ───────────────────────────── features (pure) ─────────────────────────────
// in: { base, price, quoteVolume24h, h1, m5, btcH1 (column sets, finished candles), spreadPct, spreadHist [pct...],
//       depth?, trades?, futures?, mcap?, supply?, events?, info?, now }
export function computeFeatures(x, cfg = CONFIG) {
  const now = x.now ?? Date.now(), H = x.h1, M = x.m5, N = H?.t?.length || 0;
  const f = { base: x.base, symbol: `${x.base}USDT`, price: x.price, quoteVolume24h: x.quoteVolume24h, missing: [] };
  const firstAt = N ? H.t[0] : null;
  f.history = { hours: N, days: N ? r((now - firstAt) / DAY, 1) : 0, enough: N >= cfg.baselineDays * 24, full: N >= 499 };
  f.history.recent = !f.history.full && f.history.days < cfg.minHistoryDays;
  if (!f.history.enough) { f.missing.push(`price history: ${f.history.days} days (needs ${cfg.baselineDays})`); return f; }
  const last = (a, k) => a.slice(N - k), win = (a, from, to) => a.slice(N - from, N - to);
  // baseline window: the 7 days before the last 24h, so a move that started today does not raise its own baseline
  const baseIdx = [N - 24 - 168, N - 24];
  const hourOf = (t) => new Date(t).getUTCHours();
  const hourMed = Array.from({ length: 24 }, () => []), hourTr = Array.from({ length: 24 }, () => []);
  for (let i = Math.max(0, baseIdx[0]); i < baseIdx[1]; i++) { hourMed[hourOf(H.t[i])].push(H.qv[i]); hourTr[hourOf(H.t[i])].push(H.n[i]); }
  const expH = hourMed.map((a) => med(a)), expTr = hourTr.map((a) => med(a));
  const baseQv = H.qv.slice(Math.max(0, baseIdx[0]), baseIdx[1]), baseN = H.n.slice(Math.max(0, baseIdx[0]), baseIdx[1]);
  const baseTb = H.tb.slice(Math.max(0, baseIdx[0]), baseIdx[1]);
  const baseDays = baseQv.length / 24;
  const vol24 = sum(last(H.qv, 24)), tr24 = sum(last(H.n, 24)), tb24 = sum(last(H.tb, 24));
  const seasonal = (i) => (expH[hourOf(H.t[i])] > 0 ? H.qv[i] / expH[hourOf(H.t[i])] : null);
  const last12 = Array.from({ length: 12 }, (_, k) => seasonal(N - 12 + k));
  const exp4 = sum(Array.from({ length: 4 }, (_, k) => expH[hourOf(H.t[N - 4 + k])] || 0));
  const hourShares = last(H.qv, 24).map((v) => (vol24 > 0 ? v / vol24 : 0));
  f.vol = {
    vol24, base24: baseDays ? sum(baseQv) / baseDays : null,
    ratio24: baseDays && sum(baseQv) > 0 ? vol24 / (sum(baseQv) / baseDays) : null,
    ratio4h: exp4 > 0 ? sum(last(H.qv, 4)) / exp4 : null,
    ratio1h: seasonal(N - 1),
    persist12: last12.filter((v) => isNum(v) && v >= 1.5).length,
    spikeShare: hourShares.length ? Math.max(...hourShares) : null,
  };
  f.trades = { ratio24: baseDays && sum(baseN) > 0 ? tr24 / (sum(baseN) / baseDays) : null };
  // executed flow: taker-buy quote volume per candle; CVD = buy minus sell volume (the same information as buy share,
  // so the two count as one confirmation)
  const delta = (i) => 2 * H.tb[i] - H.qv[i];
  const cvdFirst12 = sum(Array.from({ length: 12 }, (_, k) => delta(N - 24 + k))), cvdLast12 = sum(Array.from({ length: 12 }, (_, k) => delta(N - 12 + k)));
  const buy24 = vol24 > 0 ? (tb24 / vol24) * 100 : null, buyPrior = sum(baseQv) > 0 ? (sum(baseTb) / sum(baseQv)) * 100 : null;
  f.flow = { buy24, buyPrior, buyDelta: isNum(buy24) && isNum(buyPrior) ? buy24 - buyPrior : null, cvd24: cvdFirst12 + cvdLast12, cvdFirst12, cvdLast12,
    cvdAccel: cvdLast12 > 0 && cvdLast12 > cvdFirst12 };
  // price
  const price = isNum(x.price) ? x.price : H.c[N - 1];
  const dailyRanges = [];
  for (let end = N; end - 24 >= 0 && dailyRanges.length < 14; end -= 24) {
    const hi = Math.max(...H.h.slice(end - 24, end)), lo = Math.min(...H.l.slice(end - 24, end));
    if (lo > 0) dailyRanges.push((hi / lo - 1) * 100);
  }
  f.px = { price, ret1h: pctChg(price, H.c[N - 2]), ret4h: pctChg(price, H.c[N - 5]), ret24: pctChg(price, H.c[N - 25]),
    ret7d: N >= 169 ? pctChg(price, H.c[N - 169]) : null, typicalDailyRange: med(dailyRanges) };
  const tdr = f.px.typicalDailyRange ?? 10;
  // structure: 7-day range ending 6 hours ago (so the current push is measured against it)
  const rs = Math.max(0, N - 168), re = N - 6;
  const rangeHigh = Math.max(...H.h.slice(rs, re)), rangeLow = Math.min(...H.l.slice(rs, re));
  let tests = 0, lastTest = -Infinity;
  for (let i = rs; i < N; i++) if (H.h[i] >= rangeHigh * 0.985 && i - lastTest >= 6) { tests++; lastTest = i; }
  const seg = (a, b) => Math.min(...H.l.slice(N - a, N - b));
  const lows = [seg(72, 48), seg(48, 24), seg(24, 0)];
  const e20 = ema(H.c.slice(-120), 20);
  const atr = (from, to) => mean(H.h.slice(from, to).map((h, i) => (h - H.l[from + i]) / H.c[from + i]));
  const atr48 = atr(N - 48, N), atrPrior = atr(Math.max(0, N - 48 - 168), N - 48);
  const bbw = [];
  for (let i = Math.max(20, N - 336); i <= N; i++) {
    const w = H.c.slice(i - 20, i), m = mean(w), sd = Math.sqrt(mean(w.map((v) => (v - m) ** 2)));
    bbw.push(m > 0 ? (4 * sd) / m : 0);
  }
  const bbNow = bbw[bbw.length - 1];
  f.structure = {
    rangeHigh, rangeLow, rangeWidthPct: pctChg(rangeHigh, rangeLow), distToHighPct: rangeHigh > 0 ? (rangeHigh / price - 1) * 100 : null,
    aboveRangePct: price > rangeHigh ? (price / rangeHigh - 1) * 100 : 0, tests,
    higherLows: lows[0] < lows[1] * 0.995 && lows[1] < lows[2] * 0.995, lows,
    ema20: e20[e20.length - 1], aboveEma: price > e20[e20.length - 1], emaRising: e20[e20.length - 1] > e20[e20.length - 7],
    compressionRatio: atrPrior > 0 ? atr48 / atrPrior : null,
    bbPctile: bbw.length >= 60 ? (bbw.filter((v) => v <= bbNow).length / bbw.length) * 100 : null,
  };
  f.limits = {
    quietMovePct: clamp(cfg.quietDailyMult * tdr, cfg.quietMinPct, cfg.quietMaxPct),
    ext24: Math.max(cfg.ext24MinPct, cfg.ext24DailyMult * tdr), ext4h: Math.max(cfg.ext4hMinPct, cfg.ext4hDailyMult * tdr),
    ext7d: Math.max(cfg.ext7dMinPct, cfg.ext7dDailyMult * tdr), breakoutExt: Math.max(cfg.breakoutExtMinPct, cfg.breakoutExtDailyMult * tdr),
  };
  // 5-minute layer (Model B): each finished 5m candle vs 1/12 of that hour-of-day's median hourly volume
  const K = M?.t?.length || 0;
  f.m5 = { available: K >= 12 };
  if (f.m5.available) {
    const r5 = M.qv.map((v, i) => { const e = expH[hourOf(M.t[i])]; return e > 0 ? v / (e / 12) : null; });
    let consec = 0;
    for (let i = K - 1; i >= 0 && isNum(r5[i]) && r5[i] >= cfg.bRvol5; i--) consec++;
    const l3 = r5.slice(K - 3), p3 = r5.slice(K - 6, K - 3);
    const exp15 = sum(M.t.slice(K - 3).map((t) => (expH[hourOf(t)] || 0) / 12)), expTr15 = sum(M.t.slice(K - 3).map((t) => (expTr[hourOf(t)] || 0) / 12));
    const qv3 = sum(M.qv.slice(K - 3)), tb3 = sum(M.tb.slice(K - 3));
    f.m5 = {
      available: true, r5: r5.slice(-6).map((v) => r(v, 2)), last: r5[K - 1], consec,
      accel: l3.every(isNum) && p3.every(isNum) && mean(l3) >= mean(p3) && M.qv[K - 1] >= M.qv[K - 3] * 0.8,
      r15: exp15 > 0 ? qv3 / exp15 : null, trades15: expTr15 > 0 ? sum(M.n.slice(K - 3)) / expTr15 : null,
      buy15: qv3 > 0 ? (tb3 / qv3) * 100 : null, ret15: pctChg(M.c[K - 1], M.o[K - 3]),
      lastAt: M.t[K - 1] + 5 * MIN,
    };
  }
  // relative strength vs BTC and the BTC regime
  const B = x.btcH1, NB = B?.t?.length || 0;
  if (NB >= 170) {
    const bp = B.c[NB - 1], be50 = ema(B.c.slice(-200), 50);
    f.btc = { ret24: pctChg(bp, B.c[NB - 25]), ret4h: pctChg(bp, B.c[NB - 5]), ret7d: pctChg(bp, B.c[NB - 169]), aboveEma50: bp > be50[be50.length - 1],
      prev24: pctChg(B.c[NB - 25], B.c[NB - 49]) };
    f.btc.deteriorating = f.btc.ret24 <= cfg.btc24Min || f.btc.ret4h <= cfg.btc4hMin;
    const prevRet = pctChg(H.c[N - 25], H.c[N - 49]);
    f.rs = { rs24: f.px.ret24 - f.btc.ret24, rsPrev24: isNum(prevRet) ? prevRet - f.btc.prev24 : null,
      rs7d: isNum(f.px.ret7d) ? f.px.ret7d - f.btc.ret7d : null };
    f.rs.improving = isNum(f.rs.rsPrev24) && f.rs.rs24 > f.rs.rsPrev24;
  } else { f.btc = null; f.rs = null; f.missing.push("BTC candles"); }
  // liquidity
  const hist = (x.spreadHist || []).filter(isNum);
  const prevMed = hist.length >= 12 ? med(hist.slice(0, -6)) : null, recentMed = hist.length >= 12 ? med(hist.slice(-6)) : null;
  f.liq = { spreadPct: x.spreadPct, spreadSamples: hist.length,
    spreadTightening: isNum(prevMed) && isNum(recentMed) ? recentMed <= prevMed * 0.85 : null,
    spreadWidening: isNum(prevMed) && isNum(x.spreadPct) && prevMed > 0 ? x.spreadPct >= prevMed * 2 : null,
    depth: x.depth || null };
  if (!x.depth) f.missing.push("order book depth");
  f.large = x.trades || null;
  if (!x.trades) f.missing.push("recent trades");
  f.deriv = x.futures || null;
  // market cap + supply (never estimated: missing stays missing)
  f.mcap = x.mcap || null;
  f.supply = x.supply || null;
  f.events = x.events || { unlocks: [], unlockCheck: null, catalysts: [] };
  f.info = x.info || null;
  // data freshness
  let gaps = 0;
  for (let i = N - 23; i < N; i++) if (H.t[i] - H.t[i - 1] !== HOUR) gaps++;
  f.data = { lastHourAt: H.t[N - 1] + HOUR, gaps24: gaps,
    fresh: now - (H.t[N - 1] + HOUR) <= 2 * HOUR && (!f.m5.available || now - f.m5.lastAt <= 12 * MIN) && gaps === 0 };
  return f;
}

// ───────────────────────────── score (pure) ─────────────────────────────
// Each rule returns [value text, points] or [null, 0] when the data is missing: missing data never earns points.
const tier = (v, steps) => { for (const [min, pts] of steps) if (v >= min) return pts; return 0; };
const rule = (label, max, fn) => ({ label, max, fn });
const has = (v) => isNum(v);
const SCORE_RULES = {
  volume: [
    rule("24h volume vs its 7-day baseline", 8, (f) => (has(f.vol?.ratio24) ? [`${f.vol.ratio24.toFixed(2)}x`, tier(f.vol.ratio24, [[3, 8], [2, 6], [1.5, 3]])] : [null, 0])),
    rule("Last 4h vs the same hours of the past 7 days", 4, (f) => (has(f.vol?.ratio4h) ? [`${f.vol.ratio4h.toFixed(2)}x`, tier(f.vol.ratio4h, [[2.5, 4], [1.5, 2]])] : [null, 0])),
    rule("Hours of the last 12 at 1.5x normal or more (persistence)", 5, (f) => (has(f.vol?.persist12) ? [`${f.vol.persist12}/12`, tier(f.vol.persist12, [[6, 5], [3, 3], [2, 1]])] : [null, 0])),
    rule("Consecutive 5m candles at the trigger level", 3, (f, cfg) => (f.m5?.available ? [`${f.m5.consec} at ${cfg.bRvol5}x+`, tier(f.m5.consec, [[3, 3], [2, 1]])] : [null, 0])),
  ],
  flow: [
    rule("Aggressive-buy share, last 24h", 5, (f) => (has(f.flow?.buy24) ? [`${f.flow.buy24.toFixed(1)}%`, tier(f.flow.buy24, [[56, 5], [53, 3], [50.5, 1]])] : [null, 0])),
    rule("Buy share vs its 7-day average", 4, (f) => (has(f.flow?.buyDelta) ? [`${f.flow.buyDelta >= 0 ? "+" : ""}${f.flow.buyDelta.toFixed(1)} pts`, tier(f.flow.buyDelta, [[3, 4], [1.5, 2], [0.5, 1]])] : [null, 0])),
    rule("Cumulative volume delta (last 12h vs previous 12h)", 4, (f) => (has(f.flow?.cvd24) ? [`${fmtUsd(f.flow.cvdLast12)} vs ${fmtUsd(f.flow.cvdFirst12)}`, f.flow.cvdAccel ? 4 : f.flow.cvd24 > 0 ? 2 : 0] : [null, 0])),
    rule("Trade count vs its 7-day baseline", 3, (f) => (has(f.trades?.ratio24) ? [`${f.trades.ratio24.toFixed(2)}x`, tier(f.trades.ratio24, [[2, 3], [1.4, 2], [1.15, 1]])] : [null, 0])),
    rule("Large trades (top 2% by size): share bought", 2, (f) => (has(f.large?.largeBuyShare) ? [`${f.large.largeBuyShare.toFixed(0)}% of ${f.large.largeCount}`, tier(f.large.largeBuyShare, [[60, 2], [53, 1]])] : [null, 0])),
    rule("Order book within +-2%: bid share", 2, (f) => (has(f.liq?.depth?.imbalance) ? [`${(f.liq.depth.imbalance * 100).toFixed(0)}% bids`, tier(f.liq.depth.imbalance, [[0.58, 2], [0.52, 1]])] : [null, 0])),
  ],
  structure: [
    rule("Position vs the 7-day range high", 5, (f, cfg) => {
      const s = f.structure;
      if (!s || !has(s.distToHighPct)) return [null, 0];
      if (s.aboveRangePct > 0) {
        const ok = s.aboveRangePct <= f.limits.breakoutExt;
        return [`${s.aboveRangePct.toFixed(1)}% above (limit ${f.limits.breakoutExt.toFixed(1)}%)`, ok && (f.vol?.ratio1h ?? 0) >= 1.5 ? 5 : ok ? 2 : 0];
      }
      return [`${s.distToHighPct.toFixed(1)}% below`, s.distToHighPct <= cfg.nearBreakoutPct ? 5 : s.distToHighPct <= 2 * cfg.nearBreakoutPct ? 2 : 0];
    }),
    rule("Tests of the range high (7 days)", 3, (f) => (f.structure ? [`${f.structure.tests}`, tier(f.structure.tests, [[3, 3], [2, 2]])] : [null, 0])),
    rule("Higher lows (last 3 days)", 4, (f) => (f.structure ? [f.structure.higherLows ? "yes" : "no", f.structure.higherLows ? 4 : 0] : [null, 0])),
    rule("Above a rising 1h EMA20", 3, (f) => (f.structure ? [f.structure.aboveEma ? (f.structure.emaRising ? "above, rising" : "above, flat") : "below", f.structure.aboveEma ? (f.structure.emaRising ? 3 : 1) : 0] : [null, 0])),
  ],
  liquidity: [
    rule("Bid-ask spread", 4, (f) => (has(f.liq?.spreadPct) ? [`${f.liq.spreadPct.toFixed(3)}%`, f.liq.spreadPct <= 0.08 ? 4 : f.liq.spreadPct <= 0.15 ? 3 : f.liq.spreadPct <= 0.3 ? 1 : 0] : [null, 0])),
    rule("Depth within +-2% (smaller side)", 4, (f, cfg) => {
      const d = f.liq?.depth;
      if (!d) return [null, 0];
      const side = Math.min(d.bidUsd, d.askUsd);
      return [`${fmtUsd(side)}${d.partial ? "+" : ""}`, side >= 3 * cfg.minDepthUsd ? 4 : side >= 2 * cfg.minDepthUsd ? 3 : side >= cfg.minDepthUsd ? 2 : 0];
    }),
    rule("Spread trend over recent scans", 2, (f) => (f.liq?.spreadTightening == null ? [null, 0] : [f.liq.spreadTightening ? "tightening" : f.liq.spreadWidening ? "widening" : "stable", f.liq.spreadTightening ? 2 : f.liq.spreadWidening ? 0 : 1])),
  ],
  strength: [
    rule("24h return vs BTC", 4, (f) => (f.rs ? [`${sgn(f.rs.rs24)}${f.rs.improving ? ", improving" : ""}`, f.rs.rs24 > 2 && f.rs.improving ? 4 : f.rs.rs24 > 0 && f.rs.improving ? 3 : f.rs.rs24 > 0 ? 2 : 0] : [null, 0])),
    rule("7-day return vs BTC", 2, (f) => (has(f.rs?.rs7d) ? [sgn(f.rs.rs7d), f.rs.rs7d > 5 ? 2 : f.rs.rs7d > 0 ? 1 : 0] : [null, 0])),
    rule("BTC not falling (24h above -1%, 4h above -0.5%)", 2, (f) => (f.btc ? [`${sgn(f.btc.ret24)} 24h, ${sgn(f.btc.ret4h)} 4h`, f.btc.ret24 > -1 && f.btc.ret4h > -0.5 ? 2 : 0] : [null, 0])),
    rule("BTC above its 1h EMA50", 2, (f) => (f.btc ? [f.btc.aboveEma50 ? "yes" : "no", f.btc.aboveEma50 ? 2 : 0] : [null, 0])),
  ],
  compression: [
    rule("Hourly range, last 48h vs prior 7 days", 6, (f) => (has(f.structure?.compressionRatio) ? [`${f.structure.compressionRatio.toFixed(2)}x`, f.structure.compressionRatio <= 0.6 ? 6 : f.structure.compressionRatio <= 0.8 ? 3 : 0] : [null, 0])),
    rule("Bollinger width percentile (14 days, 1h)", 4, (f) => (has(f.structure?.bbPctile) ? [`${f.structure.bbPctile.toFixed(0)}th`, f.structure.bbPctile <= 20 ? 4 : f.structure.bbPctile <= 35 ? 2 : 0] : [null, 0])),
  ],
  tokenomics: [
    rule("Circulating share of max (or total) supply", 4, (f) => (has(f.supply?.circulatingShare) ? [`${(f.supply.circulatingShare * 100).toFixed(0)}%`, f.supply.circulatingShare >= 0.85 ? 4 : f.supply.circulatingShare >= 0.6 ? 2 : 0] : [null, 0])),
    rule("Token unlocks in the next 30 days (verified)", 3, (f, cfg) => {
      const u = unlockStatus(f, Date.now(), cfg);
      return u.state === "major" ? [u.text, 0] : u.state === "clear" ? [u.text, 3] : [null, 0];
    }),
    rule("Verified catalyst (with a source)", 3, (f) => { const c = activeCatalysts(f); return c.length ? [c[0].title, 3] : [null, 0]; }),
  ],
  data: [
    rule("Market cap source", 2, (f, cfg) => {
      const m = f.mcap;
      if (!m || !has(m.value)) return [null, 0];
      if (has(m.cgValue)) { const agree = mcapAgrees(m, cfg); return [agree ? "Binance and CoinGecko agree" : `sources disagree >${cfg.mcapTolerancePct}%`, agree ? 2 : 0]; }
      return [`${m.source} only`, 1];
    }),
    rule("Price history", 1, (f, cfg) => [`${f.history.full ? "20+" : f.history.days} days`, f.history.full || f.history.days >= cfg.minHistoryDays ? 1 : 0]),
    rule("Order book and trades checked this scan", 1, (f) => [f.liq?.depth && f.large ? "yes" : "not checked", f.liq?.depth && f.large ? 1 : 0]),
    rule("Candles fresh, no gaps in 24h", 1, (f) => (f.data ? [f.data.fresh ? "yes" : `stale or ${f.data.gaps24} gaps`, f.data.fresh ? 1 : 0] : [null, 0])),
  ],
};
export const COMPONENT_LABELS = { volume: "Spot volume anomaly and persistence", flow: "Buying pressure and trade flow", structure: "Price structure and breakout readiness",
  liquidity: "Liquidity and execution quality", strength: "Relative strength and market regime", compression: "Volatility compression", tokenomics: "Tokenomics and verified catalysts", data: "Data reliability" };

export function scoreBreakdown(f, cfg = CONFIG) {
  const components = {};
  let got = 0, max = 0;
  for (const [key, rules] of Object.entries(SCORE_RULES)) {
    const def = DEFAULT_WEIGHTS[key], w = cfg.weights[key] ?? def, scale = def > 0 ? w / def : 0;
    const items = rules.map((ru) => {
      let out = [null, 0];
      if (f.history?.enough || key === "data") { try { out = ru.fn(f, cfg); } catch { out = [null, 0]; } }
      const pts = out[0] == null ? 0 : out[1];
      return { rule: ru.label, value: out[0] == null ? "missing" : out[0], points: r(pts * scale, 2), max: r(ru.max * scale, 2), missing: out[0] == null };
    });
    const pts = sum(items.map((i) => i.points));
    components[key] = { label: COMPONENT_LABELS[key], points: r(pts, 1), max: w, rules: items };
    got += pts; max += w;
  }
  return { total: max > 0 ? Math.round((got / max) * 100) : 0, components };
}

// ───────────────────────────── tokenomics inputs ─────────────────────────────
const mcapAgrees = (m, cfg) => !has(m?.cgValue) || Math.abs(m.value / m.cgValue - 1) * 100 <= cfg.mcapTolerancePct;
function unlockStatus(f, now = Date.now(), cfg = CONFIG) {
  const ev = f.events || {}, until = now + cfg.unlockDays * DAY;
  const upcoming = (ev.unlocks || []).filter((u) => u.verified && u.time >= now && u.time <= until);
  const major = upcoming.filter((u) => (u.percentOfCirculating ?? 0) >= cfg.unlockMajorPct);
  if (major.length) return { state: "major", text: `${major[0].percentOfCirculating}% of circulating supply on ${new Date(major[0].time).toISOString().slice(0, 10)}`, source: major[0].source };
  const chk = ev.unlockCheck;
  if (chk?.verified && now - chk.time <= cfg.unlockDays * DAY) return { state: "clear", text: upcoming.length ? `only small unlocks (checked ${new Date(chk.time).toISOString().slice(0, 10)})` : `none (checked ${new Date(chk.time).toISOString().slice(0, 10)})`, source: chk.source };
  return { state: "unknown", text: "not verified" };
}
function activeCatalysts(f, now = Date.now()) {
  return (f.events?.catalysts || []).filter((c) => c.verified && c.time >= now - 7 * DAY && c.time <= now + 42 * DAY);
}

// ───────────────────────────── models, checks, state (pure) ─────────────────────────────
export function evaluate(f, cfg = CONFIG, now = Date.now()) {
  const score = scoreBreakdown(f, cfg);
  const out = { score: score.total, components: score.components, families: [], mandatory: [], late: [], flags: [], missing: [], state: null, priority: null, models: {} };
  if (!f.history?.enough) {
    out.mandatory.push({ key: "data", ok: false, why: f.missing[0] || "not enough data" });
    out.missing = [...f.missing];
    return out;
  }
  const v = f.vol, fl = f.flow, m5 = f.m5, s = f.structure, L = f.limits;
  // independent evidence families (each counts once, whichever model found it)
  const actA = has(v.ratio24) && v.ratio24 >= cfg.aVolRatio && (f.trades.ratio24 ?? 0) >= cfg.aTradesRatio && (v.persist12 >= cfg.aMinPersist || (v.ratio4h ?? 0) >= 1.5);
  const actB = m5.available && m5.consec >= cfg.bCandles && m5.accel && (m5.trades15 ?? 0) >= cfg.bTradesRatio;
  const largeSelling = has(f.large?.largeBuyShare) && f.large.largeCount >= 5 && f.large.largeBuyShare < 45;
  const buyA = has(fl.buy24) && fl.buy24 >= 52 && (fl.buyDelta ?? 0) >= 1.5 && fl.cvd24 > 0 && fl.cvdAccel && !largeSelling;
  const buyB = m5.available && (m5.buy15 ?? 0) >= cfg.bMinBuy && (fl.buy24 ?? 0) >= 50 && !largeSelling;
  const near = has(s.distToHighPct) && s.aboveRangePct === 0 && s.distToHighPct <= cfg.nearBreakoutPct;
  const breakout = s.aboveRangePct > 0 && s.aboveRangePct <= L.breakoutExt && (v.ratio1h ?? 0) >= 1.5;
  const structA = (has(s.compressionRatio) && s.compressionRatio <= 0.8) || s.higherLows || s.tests >= 2;
  const structB = s.aboveEma && s.emaRising && (breakout || (near && s.higherLows));
  const d = f.liq.depth;
  const book = !!d && Math.min(d.bidUsd, d.askUsd) >= cfg.minDepthUsd && d.imbalance >= 0.5 && (f.liq.spreadTightening === true || (f.liq.spreadPct ?? 1) <= 0.15);
  const strength = !!f.rs && f.rs.rs24 > 0 && ((f.rs.rs7d ?? -1) > 0 || f.rs.improving);
  const fam = (key, label, ok, evidence, need) => out.families.push({ key, label, ok, evidence, need });
  fam("activity", "Volume and trade activity", actA || actB,
    actB ? `last ${m5.consec} five-minute candles at ${cfg.bRvol5}x+ normal, accelerating; trades ${m5.trades15?.toFixed(1)}x` : `24h volume ${v.ratio24?.toFixed(2)}x baseline, trades ${f.trades.ratio24?.toFixed(2)}x, ${v.persist12}/12 hours at 1.5x+`,
    `24h volume ${cfg.aVolRatio}x+ its 7-day baseline with ${cfg.aTradesRatio}x+ trades held ${cfg.aMinPersist}+ hours, or ${cfg.bCandles}+ consecutive 5m candles at ${cfg.bRvol5}x+ and accelerating`);
  fam("buying", "Executed buying pressure", buyA || buyB,
    buyB && !buyA ? `${m5.buy15?.toFixed(0)}% aggressive buying in the last 15 min` : `buyers ${fl.buy24?.toFixed(1)}% (${fl.buyDelta >= 0 ? "+" : ""}${fl.buyDelta?.toFixed(1)} pts vs 7d), CVD rising`,
    largeSelling ? "large trades are mostly selling" : `buy share 52%+ and rising with positive, accelerating CVD (or ${cfg.bMinBuy}%+ buyers on the 5m trigger)`);
  fam("structure", "Bullish price structure", structA || structB,
    [structB ? (breakout ? `broke the 7-day high by ${s.aboveRangePct.toFixed(1)}% on volume` : "pressing the range high above a rising EMA") : null,
      s.higherLows ? "higher lows" : null, s.tests >= 2 ? `${s.tests} tests of the range high` : null,
      has(s.compressionRatio) && s.compressionRatio <= 0.8 ? `volatility compressed (${s.compressionRatio.toFixed(2)}x)` : null].filter(Boolean).join(", ") || "none",
    "volatility compression, higher lows or repeated tests of the range high (or a volume breakout above a rising EMA)");
  fam("orderbook", "Order book support", book,
    d ? `${fmtUsd(Math.min(d.bidUsd, d.askUsd))} smaller side within 2%, ${(d.imbalance * 100).toFixed(0)}% bids, spread ${f.liq.spreadPct?.toFixed(3)}%` : "not checked",
    d ? `depth ${fmtUsd(cfg.minDepthUsd)}+ per side, bids >= asks, spread tightening or <= 0.15%` : "order book not checked this scan");
  fam("strength", "Relative strength vs BTC", strength,
    f.rs ? `${sgn(f.rs.rs24)} vs BTC in 24h${f.rs.improving ? ", improving" : ""}, ${sgn(f.rs.rs7d)} in 7d` : "no BTC data",
    "beating BTC over 24h and over 7 days (or improving)");
  out.confirmations = out.families.filter((x) => x.ok).length;
  // late-entry and risk checks ("reject" = already moved; "flag" = warning that blocks high priority)
  const late = (key, severity, why) => out.late.push({ key, severity, why });
  if (has(f.px.ret24) && f.px.ret24 > L.ext24) late("ext24", "reject", `up ${f.px.ret24.toFixed(1)}% in 24h (limit ${L.ext24.toFixed(0)}%)`);
  if (has(f.px.ret4h) && f.px.ret4h > L.ext4h) late("ext4h", "reject", `up ${f.px.ret4h.toFixed(1)}% in 4h (limit ${L.ext4h.toFixed(0)}%)`);
  if (has(f.px.ret7d) && f.px.ret7d > L.ext7d) late("ext7d", "reject", `up ${f.px.ret7d.toFixed(1)}% in 7 days (limit ${L.ext7d.toFixed(0)}%)`);
  if (s.aboveRangePct > L.breakoutExt) late("extRange", "reject", `${s.aboveRangePct.toFixed(1)}% above its 7-day range (limit ${L.breakoutExt.toFixed(1)}%)`);
  if ((v.spikeShare ?? 0) > 0.5 && v.persist12 <= 1) late("spike", "flag", `one hour holds ${(v.spikeShare * 100).toFixed(0)}% of the day's volume: isolated spike`);
  if ((f.px.ret24 ?? 0) > 5 && (fl.buy24 ?? 50) < 50) late("weakBuying", "flag", `price up ${f.px.ret24.toFixed(1)}% but only ${fl.buy24.toFixed(0)}% aggressive buying`);
  if (f.liq.spreadWidening) late("spreadWidening", "flag", "spread has doubled vs recent scans");
  if (d && Math.min(d.bidUsd, d.askUsd) < cfg.minDepthUsd) late("thinBook", "flag", `only ${fmtUsd(Math.min(d.bidUsd, d.askUsd))} on the thin side within 2%`);
  if (f.btc?.deteriorating) late("btc", "flag", `BTC weak (${sgn(f.btc.ret24)} 24h, ${sgn(f.btc.ret4h)} 4h)`);
  const un = unlockStatus(f, now, cfg);
  if (un.state === "major") late("unlock", "flag", `token unlock: ${un.text}`);
  if (has(f.supply?.circulatingShare) && f.supply.circulatingShare * 100 < cfg.minCirculatingPct) late("supply", "flag", `only ${(f.supply.circulatingShare * 100).toFixed(0)}% of max supply circulating: supply risk, future unlocks likely`);
  if (f.mcap && !mcapAgrees(f.mcap, cfg)) late("mcapCheck", "flag", `market cap not verified: Binance ${fmtUsd(f.mcap.value)} vs CoinGecko ${fmtUsd(f.mcap.cgValue)}`);
  if ((f.info?.tags || []).some((t) => /monitoring/i.test(t))) late("monitoring", "flag", "on Binance's Monitoring list (delisting risk)");
  if ((f.info?.tags || []).some((t) => /^seed$/i.test(t))) out.flags.push("Binance Seed tag: early-stage, very volatile");
  if (f.history.recent) out.flags.push(`recently listed: ${f.history.days} days of history`);
  if (f.deriv?.crowded) out.flags.push(`crowded futures: ${f.deriv.crowdedWhy}`);
  for (const x of out.late.filter((y) => y.severity === "flag")) out.flags.push(x.why);
  // mandatory checks for high priority
  const mand = (key, ok, why) => out.mandatory.push({ key, ok, why });
  mand("liquidity", (f.liq.spreadPct ?? 9) <= cfg.maxSpreadPct && (f.quoteVolume24h ?? 0) >= cfg.minQuoteVolume && !!d && Math.min(d.bidUsd, d.askUsd) >= cfg.minDepthUsd,
    !d ? "order book not checked" : `spread ${f.liq.spreadPct?.toFixed(3)}%, depth ${fmtUsd(Math.min(d.bidUsd, d.askUsd))} per side, volume ${fmtUsd(f.quoteVolume24h)}`);
  mand("data", has(f.mcap?.value) && f.data.fresh && !!f.btc, !has(f.mcap?.value) ? "no verified market cap" : !f.data.fresh ? "candles stale or missing" : !f.btc ? "no BTC data" : "market cap, candles and BTC data present");
  mand("extension", !out.late.some((x) => x.severity === "reject"), out.late.filter((x) => x.severity === "reject").map((x) => x.why).join("; ") || "not overextended");
  mand("risk", !out.late.some((x) => x.severity === "flag"), out.late.filter((x) => x.severity === "flag").map((x) => x.why).join("; ") || "no risk flags");
  // models
  const quiet = has(f.px.ret24) && Math.abs(f.px.ret24) <= L.quietMovePct;
  out.models.A = { pass: actA && quiet, checks: [[`volume ${cfg.aVolRatio}x+ baseline with more trades, held`, actA], [`price within +-${L.quietMovePct.toFixed(1)}% over 24h`, quiet]] };
  out.models.B = { pass: actB && buyB && (m5.ret15 ?? 0) > 0, checks: [[`${cfg.bCandles}+ accelerating 5m candles at ${cfg.bRvol5}x+ with more trades`, actB], [`${cfg.bMinBuy}%+ aggressive buying`, buyB], ["price rising over the last 15 min", (m5.ret15 ?? 0) > 0]] };
  const enough = out.confirmations >= cfg.minListConfirmations;
  if (out.late.some((x) => x.severity === "reject")) out.state = "moved";
  else if (out.models.B.pass && enough) out.state = "ignition";
  else if (out.models.A.pass && enough && near && (s.tests >= 2 || (has(s.compressionRatio) && s.compressionRatio <= 0.8))) out.state = "prebreakout";
  else if (out.models.A.pass && enough) out.state = "quiet";
  if (out.state && out.state !== "moved") out.priority = out.confirmations >= cfg.minConfirmations && out.score >= cfg.minHighScore && out.mandatory.every((x) => x.ok) ? "high" : "watch";
  // exactly what is still missing for a high-priority call
  for (const x of out.families) if (!x.ok) out.missing.push(`${x.label}: ${x.need}`);
  for (const x of out.mandatory) if (!x.ok) out.missing.push(`${x.key}: ${x.why}`);
  if (out.score < cfg.minHighScore) out.missing.unshift(`score ${cfg.minHighScore}+ (has ${out.score})`);
  if (out.confirmations < cfg.minConfirmations) out.missing.unshift(`${cfg.minConfirmations - out.confirmations} more independent confirmation${cfg.minConfirmations - out.confirmations === 1 ? "" : "s"} (has ${out.confirmations} of ${cfg.minConfirmations})`);
  out.missing.push(...f.missing.map((m) => `data: ${m}`));
  return out;
}

// ───────────────────────────── repeated signals (pure) ─────────────────────────────
// One snapshot per coin per cooldown; a better state (quiet < pre-breakout < ignition, watch < high) inside the
// cooldown is saved as a new snapshot, the same or a lower one is not. "Already moved" has its own, longer cooldown.
export const rankOf = (state, priority) => (state === "moved" ? 0 : STATE_RANK[state] * 2 + (priority === "high" ? 1 : 0));
export function snapshotDecision(prev, state, priority, now, cfg = CONFIG) {
  if (!state) return false;
  const cd = (state === "moved" ? cfg.movedCooldownHours : cfg.cooldownHours) * HOUR;
  const p = prev?.[state === "moved" ? "moved" : "main"];
  if (!p || now - p.at >= cd) return true;
  return state !== "moved" && rankOf(state, priority) > p.rank;
}

// ───────────────────────────── forward tracking (pure) ─────────────────────────────
// Bars { t, dur, o, h, l, c } in time order. Only bars that start at or after the signal are used (the entry is the
// price at the snapshot), so nothing from before the signal can leak into its result. Inside one bar the order of
// high and low is unknown: if a bar touches the stop and a target, the caller should pass finer bars for it
// (needsRefine); otherwise the stop is counted first (conservative) and the bar is counted as ambiguous.
export function newTrack(entry, at, cfg = CONFIG) {
  return { entry, at, lastT: null, lastEnd: at, hi: entry, lo: entry, last: entry, horizons: {}, targets: Object.fromEntries(TARGETS.map((t) => [t, null])),
    stop: { pct: cfg.stopPct, hitAt: null }, ambiguous: 0, bars: 0, done: false, dataEnded: false };
}
const stopPx = (tr) => tr.entry * (1 - tr.stop.pct / 100);
export function needsRefine(tr, b) {
  if (tr.stop.hitAt || b.dur <= MIN) return false;
  return b.l <= stopPx(tr) && TARGETS.some((T) => !tr.targets[T] && b.h >= tr.entry * (1 + T / 100));
}
function closeHorizons(tr, upTo, inclusive) {
  for (const [k, h] of HORIZONS) {
    if (tr.horizons[k]) continue;
    const end = tr.at + h * HOUR;
    if (inclusive ? upTo >= end : upTo > end) {
      tr.horizons[k] = { ret: r(pctChg(tr.last, tr.entry), 2), mfe: r(pctChg(tr.hi, tr.entry), 2), mae: r(pctChg(tr.lo, tr.entry), 2), at: tr.lastEnd };
    }
  }
}
export function advanceTrack(tr, bars) {
  let changed = false;
  for (const b of bars) {
    if (tr.done) break;
    if (b.t < tr.at || (tr.lastT != null && b.t < tr.lastEnd)) continue;
    const end = b.t + b.dur;
    closeHorizons(tr, end, false); // horizons that end inside this bar: measured up to the previous bar
    const stoppedBefore = !!tr.stop.hitAt, touchStop = !stoppedBefore && b.l <= stopPx(tr);
    const hits = TARGETS.filter((T) => !tr.targets[T] && b.h >= tr.entry * (1 + T / 100));
    if (touchStop && hits.length) tr.ambiguous++; // same bar: the stop is counted first
    if (touchStop) tr.stop.hitAt = end;
    for (const T of hits) {
      // the bar's low may come before its high, so it is counted in the drawdown before the target (worst case)
      tr.targets[T] = { hitAt: end, hours: r((end - tr.at) / HOUR, 2), drawdownBeforePct: r(pctChg(Math.min(tr.lo, b.l), tr.entry), 2), beforeStop: !stoppedBefore && !touchStop };
    }
    tr.hi = Math.max(tr.hi, b.h); tr.lo = Math.min(tr.lo, b.l); tr.last = b.c; tr.lastT = b.t; tr.lastEnd = end; tr.bars++;
    closeHorizons(tr, end, true);
    changed = true;
    if (end >= tr.at + HORIZONS[HORIZONS.length - 1][1] * HOUR) tr.done = true;
  }
  return changed;
}
// The coin stopped trading (e.g. delisted): every open horizon is closed at the last known price, so failed coins stay
// in the results instead of silently disappearing (survivorship bias).
export function endTrack(tr) {
  for (const [k] of HORIZONS) if (!tr.horizons[k]) tr.horizons[k] = { ret: r(pctChg(tr.last, tr.entry), 2), mfe: r(pctChg(tr.hi, tr.entry), 2), mae: r(pctChg(tr.lo, tr.entry), 2), at: tr.lastEnd, dataEnded: true };
  tr.done = true; tr.dataEnded = true;
}

// ───────────────────────────── results (pure) ─────────────────────────────
const quantile = (a, q) => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return null; const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
function block(rows, cfg, now) {
  const cost = cfg.feePct + cfg.slippagePct;
  const horizons = HORIZONS.map(([k, h]) => {
    const done = rows.filter((x) => x.track?.horizons?.[k]);
    const net = done.map((x) => x.track.horizons[k].ret - cost);
    return { horizon: k, n: done.length, avgNetPct: r(mean(net), 2), medianNetPct: r(med(net), 2), positivePct: done.length ? r((net.filter((v) => v > 0).length / done.length) * 100, 1) : null,
      avgMfePct: r(mean(done.map((x) => x.track.horizons[k].mfe)), 2), avgMaePct: r(mean(done.map((x) => x.track.horizons[k].mae)), 2) };
  });
  const within = (x, T, hours) => { const t = x.track?.targets?.[T]; return !!t && t.hours <= hours; };
  const matured = (hours) => rows.filter((x) => x.track && (x.track.done || now - x.at >= hours * HOUR || TARGETS.every((T) => within(x, T, hours))));
  const targets = TARGETS.map((T) => {
    const out = { target: T };
    for (const [label, hours] of [["14d", 336], ["42d", 1008]]) {
      const m = matured(hours), hit = m.filter((x) => within(x, T, hours));
      out[label] = { n: m.length, hits: hit.length, hitPct: m.length ? r((hit.length / m.length) * 100, 1) : null,
        medianHours: r(med(hit.map((x) => x.track.targets[T].hours)), 1), medianDrawdownPct: r(med(hit.map((x) => x.track.targets[T].drawdownBeforePct)), 1),
        beforeStopPct: hit.length ? r((hit.filter((x) => x.track.targets[T].beforeStop).length / hit.length) * 100, 1) : null };
    }
    return out;
  });
  const m14 = matured(336);
  const fp = m14.filter((x) => !within(x, 25, 336));
  return { signals: rows.length, open: rows.filter((x) => x.track && !x.track.done).length, ambiguousBars: sum(rows.map((x) => x.track?.ambiguous || 0)),
    dataEnded: rows.filter((x) => x.track?.dataEnded).length, horizons, targets,
    falsePositives: { n: m14.length, count: fp.length, pct: m14.length ? r((fp.length / m14.length) * 100, 1) : null, rule: "never reached +25% within 14 days" },
    stopHitPct: m14.length ? r((m14.filter((x) => x.track.stop.hitAt && x.track.stop.hitAt - x.at <= 336 * HOUR).length / m14.length) * 100, 1) : null };
}
// signals: [{ ...snapshot, track }]. Groups by state, priority, market-cap band and score band, plus a chronological
// split: the oldest 60% of signals vs the newest 40%, so you can see whether results hold on later, unseen signals.
export function computeResults(signals, cfg = CONFIG, now = Date.now()) {
  const tracked = signals.filter((x) => x.track);
  const sorted = [...tracked].sort((a, b) => a.at - b.at), cut = Math.floor(sorted.length * 0.6);
  const groups = (key, names) => Object.fromEntries(names.map((nm) => [nm, block(tracked.filter((x) => key(x) === nm), cfg, now)]));
  const candidates = tracked.filter((x) => x.state !== "moved");
  const all = block(candidates, cfg, now);
  const n14 = all.targets[0]["14d"].n;
  const later = block(sorted.slice(cut).filter((x) => x.state !== "moved"), cfg, now), earlier = block(sorted.slice(0, cut).filter((x) => x.state !== "moved"), cfg, now);
  const h14 = (b) => b.horizons.find((h) => h.horizon === "14d");
  let verdict;
  if (n14 < cfg.minSample) verdict = `Not enough evidence yet: ${n14} signal${n14 === 1 ? "" : "s"} have had 14 days to play out (at least ${cfg.minSample} needed before judging). No result is claimed.`;
  else {
    const e = h14(earlier), l = h14(later);
    verdict = isNum(e.avgNetPct) && isNum(l.avgNetPct) && e.avgNetPct > 0 && l.avgNetPct > 0 && l.n >= Math.max(10, cfg.minSample * 0.4)
      ? `Average 14-day result after costs was positive in both the older (${sgn(e.avgNetPct, 2)}, ${e.n} signals) and newer (${sgn(l.avgNetPct, 2)}, ${l.n} signals) halves. Encouraging, not proof: keep tracking.`
      : `The evidence does not support calling this profitable: 14-day average after costs ${sgn(e.avgNetPct, 2)} (older ${e.n}) and ${sgn(l.avgNetPct, 2)} (newer ${l.n}).`;
  }
  return {
    costPct: r(cfg.feePct + cfg.slippagePct, 2), feePct: cfg.feePct, slippagePct: cfg.slippagePct, stopPct: cfg.stopPct, minSample: cfg.minSample, verdict,
    all, controlAlreadyMoved: block(tracked.filter((x) => x.state === "moved"), cfg, now),
    byState: groups((x) => x.state, Object.keys(STATES)), byPriority: groups((x) => x.priority || "none", ["high", "watch"]),
    byMcap: groups((x) => x.mcapBand, MCAP_BANDS.map((b) => b[0])), byScore: groups((x) => bandOf(SCORE_BANDS, x.score), SCORE_BANDS.map((b) => b[0])),
    chronological: { splitAt: sorted[cut]?.at ?? null, earlier, later },
  };
}

// ───────────────────────────── live: state ─────────────────────────────
const state = {
  startedAt: Date.now(), status: "starting", lastScanAt: null, lastScanMs: null, errors: {}, demo: DEMO,
  universe: { pairs: 0, eligible: 0, excluded: {}, tooNew: 0 }, regime: null, tabs: { quiet: [], prebreakout: [], ignition: [], moved: [] },
  sources: { spot: "not checked", assetInfo: null, coingecko: "not checked", futures: "not checked", events: "not loaded" },
  results: null, telegramConfigured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
};
const store = { version: STATE_VERSION, signals: [], tracks: {}, last: {} }; // signals are frozen snapshots; tracks change
const kl = new Map();          // symbol -> { h1: raw rows, m5: raw rows, h1At, m5At }
const spreadHist = new Map();  // base -> recent spread %
let cg = { map: {}, mapAt: 0, markets: {}, marketsAt: 0, mapNext: 0 };
let events = { at: 0, mtime: 0, unlocks: [], unlockChecks: [], catalysts: [] };
let futuresIndex = { at: 0, map: new Map(), ok: false };
let busy = false, started = false;

// Migration hook: state files carry a version; older versions are upgraded here (version 1 is the first).
export function migrateStore(saved) {
  if (!saved || typeof saved !== "object") return { version: STATE_VERSION, signals: [], tracks: {}, last: {} };
  const v = Number(saved.version) || 1;
  if (v > STATE_VERSION) throw new Error(`early2x state file is version ${v}, newer than this code (${STATE_VERSION})`);
  return { version: STATE_VERSION, signals: Array.isArray(saved.signals) ? saved.signals : [], tracks: saved.tracks || {}, last: saved.last || {} };
}
export const freezeSnapshot = (o) => deepFreeze(o);
const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
async function loadStore() {
  try {
    const s = migrateStore(JSON.parse(await readFile(STATE_FILE, "utf8")));
    store.signals = s.signals.map(deepFreeze); store.tracks = s.tracks; store.last = s.last;
  } catch (e) { if (e.code !== "ENOENT") state.errors.State = `could not read ${path.basename(STATE_FILE)}: ${e.message}`; }
}
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const data = JSON.stringify({ version: STATE_VERSION, savedAt: Date.now(), signals: store.signals, tracks: store.tracks, last: store.last });
    writeFile(STATE_FILE + ".tmp", data).then(() => rename(STATE_FILE + ".tmp", STATE_FILE)).catch((e) => { state.errors.State = `save failed: ${e.message}`; });
  }, 1000);
}

// ───────────────────────────── live: data ─────────────────────────────
const get = (p, opts = {}) => fetchJson(`${BN}${p}`, { retries: 1, ...opts });
async function klines(symbol, interval, durMs, keep) {
  const c = kl.get(symbol) || {};
  const key = interval === "1h" ? "h1" : "m5", atKey = key + "At";
  const now = Date.now(), rows = c[key];
  if (rows?.length && now - c[atKey] < (interval === "1h" ? 5 * MIN : 60_000)) return rows;
  let fresh;
  if (rows?.length >= keep * 0.9 && now - Number(rows[rows.length - 1][0]) < 90 * durMs) {
    const since = Number(rows[rows.length - 1][0]);
    fresh = await get(`/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${since}&limit=100`);
    const merged = rows.filter((k) => Number(k[0]) < since).concat(fresh);
    c[key] = merged.slice(-keep);
  } else {
    fresh = await get(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${keep}`);
    c[key] = fresh;
  }
  c[atKey] = now;
  kl.set(symbol, c);
  return c[key];
}
async function depthOf(symbol, price) {
  const b = await get(`/api/v3/depth?symbol=${symbol}&limit=100`);
  const within = (side, lo, hi) => sum((b[side] || []).map(([p, q]) => [Number(p), Number(q)]).filter(([p]) => p >= lo && p <= hi).map(([p, q]) => p * q));
  const bidUsd = within("bids", price * 0.98, price * 1.0001), askUsd = within("asks", price * 0.9999, price * 1.02);
  const lastBid = Number(b.bids?.[b.bids.length - 1]?.[0]), lastAsk = Number(b.asks?.[b.asks.length - 1]?.[0]);
  return { bidUsd, askUsd, imbalance: bidUsd + askUsd > 0 ? bidUsd / (bidUsd + askUsd) : 0.5, partial: lastBid > price * 0.98 || lastAsk < price * 1.02, at: Date.now() };
}
export function largeTradeStats(rows, minUsd = CONFIG.largeTradeMinUsd) {
  const t = (rows || []).map((x) => ({ usd: Number(x.p) * Number(x.q), buy: x.m === false, time: Number(x.T) })).filter((x) => x.usd > 0);
  if (t.length < 50) return null;
  const cut = Math.max(minUsd, quantile(t.map((x) => x.usd), 0.98));
  const big = t.filter((x) => x.usd >= cut), bigUsd = sum(big.map((x) => x.usd)), allUsd = sum(t.map((x) => x.usd));
  return { sample: t.length, spanMin: r((t[t.length - 1].time - t[0].time) / MIN, 1), buyShare: r((sum(t.filter((x) => x.buy).map((x) => x.usd)) / allUsd) * 100, 1),
    largeMinUsd: Math.round(cut), largeCount: big.length, largeBuyShare: bigUsd > 0 ? r((sum(big.filter((x) => x.buy).map((x) => x.usd)) / bigUsd) * 100, 1) : null };
}
async function futuresContext(base, priceChg24) {
  if (Date.now() - futuresIndex.at > 10 * MIN) {
    try {
      const rows = await fetchJson(`${BF}/fapi/v1/premiumIndex`, { retries: 0 });
      futuresIndex = { at: Date.now(), ok: true, map: new Map(rows.filter((x) => String(x.symbol).endsWith("USDT")).map((x) => [x.symbol, Number(x.lastFundingRate)])) };
      state.sources.futures = "connected"; delete state.errors["Binance Futures"];
    } catch (e) {
      futuresIndex = { at: Date.now(), ok: false, map: new Map() };
      state.sources.futures = "unavailable"; state.errors["Binance Futures"] = `${e.message}; futures context left out (it never adds points)`;
    }
  }
  if (!futuresIndex.ok) return null;
  const sym = [`${base}USDT`, `1000${base}USDT`, `1000000${base}USDT`, `1M${base}USDT`].find((s) => futuresIndex.map.has(s));
  if (!sym) return { available: false, reason: "no USDT perpetual" };
  const [oi, fr] = await Promise.all([
    fetchJson(`${BF}/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=49`, { retries: 0 }).catch(() => null),
    fetchJson(`${BF}/fapi/v1/fundingRate?symbol=${sym}&limit=6`, { retries: 0 }).catch(() => null),
  ]);
  const v = Array.isArray(oi) ? oi.map((x) => Number(x.sumOpenInterestValue)) : [];
  const funding = (futuresIndex.map.get(sym) ?? null) * 100, hist = Array.isArray(fr) ? fr.map((x) => Number(x.fundingRate) * 100) : [];
  const ch = (k) => (v.length > k ? pctChg(v[v.length - 1], v[v.length - 1 - k]) : null);
  const out = { available: true, symbol: sym, oi1hPct: r(ch(1), 1), oi24hPct: r(ch(24), 1), oi48hPct: r(ch(48), 1), fundingPct: r(funding, 4), fundingHistPct: hist.map((x) => r(x, 4)) };
  const prev = hist.length >= 2 ? hist[hist.length - 2] : null;
  out.transition = isNum(prev) && isNum(funding) ? (prev < 0 && funding >= 0 ? "turned positive" : prev > 0 && funding <= 0 ? "turned negative" : funding > prev ? "rising" : funding < prev ? "falling" : "flat") : null;
  const crowdF = isNum(funding) && funding >= CONFIG.crowdedFundingPct, crowdOi = (out.oi24hPct ?? 0) >= 40 && Math.abs(priceChg24 ?? 0) < 5;
  out.crowded = crowdF || crowdOi;
  out.crowdedWhy = crowdF ? `funding ${funding.toFixed(3)}% per 8h` : crowdOi ? `open interest +${out.oi24hPct}% in 24h while price is flat` : null;
  return out;
}

// CoinGecko: Binance pair -> coin id (from its Binance ticker list, refreshed daily) and supply data (every 30 min).
// Optional: EARLY2X_COINGECKO=0 turns it off; COINGECKO_API_KEY (demo key) raises its rate limit.
const cgHeaders = () => (env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {});
const pause = (ms) => new Promise((s) => setTimeout(s, ms));
// The free API allows only a few requests a minute: wait out a 429 and retry the same request (background job).
async function cgGet(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json", ...cgHeaders() } });
    if (res.ok) return { data: await res.json(), total: Number(res.headers.get("total")) || 0 };
    if (res.status !== 429 || attempt >= 4) throw new Error(`CoinGecko HTTP ${res.status}${res.status === 429 ? " (rate limited)" : ""}`);
    await pause(65_000);
  }
}
let cgBusy = false;
async function refreshCoinGecko(bases) {
  if (env.EARLY2X_COINGECKO === "0") { state.sources.coingecko = "off"; return; }
  if (cgBusy) return;
  cgBusy = true;
  if (!cg.mapAt) state.sources.coingecko = "loading the Binance pair list (takes a few minutes)";
  try {
    if (Date.now() - cg.mapAt > DAY && Date.now() >= cg.mapNext) {
      const map = {}, seen = {};
      let total = Infinity;
      for (let page = 1; (page - 1) * 100 < total && page <= 30; page++) {
        const { data: d, total: tot } = await cgGet(`${CG}/exchanges/binance/tickers?page=${page}&depth=false&order=volume_desc`);
        total = tot;
        for (const t of d.tickers || []) if (t.target === "USDT" && t.coin_id) { const b = String(t.base).toUpperCase(); (seen[b] ||= new Set()).add(t.coin_id); map[b] = t.coin_id; }
        await pause(env.COINGECKO_API_KEY ? 2500 : 13_000);
      }
      for (const [b, ids] of Object.entries(seen)) if (ids.size > 1) delete map[b]; // ambiguous: never guess
      if (Object.keys(map).length < 50) throw new Error("CoinGecko Binance ticker list looks incomplete");
      cg.map = map; cg.mapAt = Date.now();
    }
    if (Date.now() - cg.marketsAt > 30 * MIN) {
      const ids = [...new Set(bases.map((b) => cg.map[b]).filter(Boolean))];
      const markets = {};
      for (let i = 0; i < ids.length; i += 200) {
        const { data: rows } = await cgGet(`${CG}/coins/markets?vs_currency=usd&ids=${ids.slice(i, i + 200).join(",")}&per_page=250`);
        for (const m of rows || []) markets[m.id] = { mcap: m.market_cap || null, circ: m.circulating_supply || null, total: m.total_supply || null, max: m.max_supply || null, fdv: m.fully_diluted_valuation || null, updated: m.last_updated };
      }
      if (ids.length) { cg.markets = markets; cg.marketsAt = Date.now(); }
    }
    state.sources.coingecko = `connected · ${Object.keys(cg.map).length} pairs mapped`;
    delete state.errors.CoinGecko;
    writeFile(CG_FILE, JSON.stringify(cg)).catch(() => {});
  } catch (e) {
    cg.mapNext = Date.now() + 30 * MIN;
    state.sources.coingecko = cg.marketsAt ? "using last copy" : "unavailable";
    state.errors.CoinGecko = `${e.message}; supply data and the market-cap cross-check are left out until it works (no points for them)`;
  } finally { cgBusy = false; }
}

// Verified token unlocks and catalysts: data/early2x-events.json, kept by you. Only entries with an https source count.
async function loadEvents() {
  try {
    const st = await stat(EVENTS_FILE);
    if (st.mtimeMs === events.mtime) return;
    const d = JSON.parse(await readFile(EVENTS_FILE, "utf8"));
    const ok = (x) => typeof x?.source === "string" && /^https:\/\//.test(x.source);
    const t = (s) => { const v = Date.parse(s); return Number.isFinite(v) ? v : null; };
    events = { at: Date.now(), mtime: st.mtimeMs,
      unlocks: (d.unlocks || []).map((u) => ({ symbol: String(u.symbol || "").toUpperCase(), time: t(u.date), percentOfCirculating: Number(u.percentOfCirculating), source: u.source, verified: ok(u) })).filter((u) => u.time),
      unlockChecks: (d.unlockChecks || []).map((u) => ({ symbol: String(u.symbol || "").toUpperCase(), time: t(u.checkedOn), source: u.source, verified: ok(u) })).filter((u) => u.time),
      catalysts: (d.catalysts || []).map((c) => ({ symbol: String(c.symbol || "").toUpperCase(), time: t(c.date), title: String(c.title || "catalyst").slice(0, 120), source: c.source, verified: ok(c) })).filter((c) => c.time) };
    state.sources.events = `${events.unlocks.length} unlocks, ${events.unlockChecks.length} unlock checks, ${events.catalysts.length} catalysts`;
    delete state.errors.Events;
  } catch (e) {
    if (e.code === "ENOENT") { state.sources.events = "no file (data/early2x-events.json)"; return; }
    state.errors.Events = `data/early2x-events.json: ${e.message}`;
  }
}
const eventsFor = (base) => ({
  unlocks: events.unlocks.filter((u) => u.symbol === base),
  unlockCheck: events.unlockChecks.filter((u) => u.symbol === base).sort((a, b) => b.time - a.time)[0] || null,
  catalysts: events.catalysts.filter((c) => c.symbol === base),
});

// ───────────────────────────── live: scan ─────────────────────────────
function mcapOf(base, price) {
  const info = assetInfo(base), cs = Number(info?.cs);
  const m = cg.markets[cg.map[base]];
  const value = cs > 0 && price > 0 ? cs * price : null;
  const cgValue = m?.mcap > 0 ? m.mcap : null;
  if (value) return { value, source: "Binance circulating supply x price", cgValue };
  if (cgValue) return { value: cgValue, source: "CoinGecko", cgValue: null };
  return null;
}
function supplyOf(base) {
  const m = cg.markets[cg.map[base]];
  if (!m || !(m.circ > 0)) return null;
  const denom = m.max > 0 ? m.max : m.total > 0 ? m.total : null;
  return { circulating: m.circ, total: m.total, max: m.max, fdv: m.fdv, circulatingShare: denom ? Math.min(1, m.circ / denom) : null, source: "CoinGecko" };
}

async function scan() {
  const t0 = Date.now();
  await loadAssetInfo().catch(() => {});
  state.sources.assetInfo = assetInfoStatus();
  await loadEvents();
  const [tickers, books] = await Promise.all([get("/api/v3/ticker/24hr", { timeoutMs: 20_000 }), get("/api/v3/ticker/bookTicker")]);
  if (!Array.isArray(tickers) || !Array.isArray(books)) throw new Error("unexpected Binance ticker response");
  state.sources.spot = "connected"; delete state.errors["Binance Spot"];
  const spread = new Map();
  for (const b of books) {
    const bid = Number(b.bidPrice), ask = Number(b.askPrice);
    if (String(b.symbol).endsWith("USDT") && bid > 0 && ask > 0) spread.set(b.symbol.slice(0, -4), ((ask - bid) / ((ask + bid) / 2)) * 100);
  }
  const usdt = tickers.filter((t) => String(t.symbol).endsWith("USDT") && Number(t.count) > 0);
  const listed = new Set(usdt.map((t) => t.symbol.slice(0, -4)));
  const excluded = {}, uni = [];
  const ex = (k) => { excluded[k] = (excluded[k] || 0) + 1; };
  for (const t of usdt) {
    const base = t.symbol.slice(0, -4), info = assetInfo(base), price = Number(t.lastPrice), qv = Number(t.quoteVolume);
    const sp = spread.get(base);
    if (isNum(sp)) { const h = spreadHist.get(base) || []; h.push(sp); spreadHist.set(base, h.slice(-36)); }
    const why = exclusionReason(base, info, listed);
    if (why) { ex(why === "wrapped" ? "wrapped, staked or gold" : why); continue; }
    if (!(qv >= CONFIG.minQuoteVolume)) { ex("24h volume under minimum"); continue; }
    const mcap = mcapOf(base, price);
    if (!mcap) { ex("no verified market cap"); continue; }
    if (mcap.value < CONFIG.mcapMin || mcap.value > CONFIG.mcapMax) { ex("market cap outside range"); continue; }
    if (!isNum(sp) || sp > CONFIG.maxSpreadPct) { ex("spread above maximum"); continue; }
    uni.push({ base, symbol: t.symbol, price, qv, chg24: Number(t.priceChangePercent), info, mcap, spreadPct: sp });
  }
  refreshCoinGecko(usdt.map((t) => t.symbol.slice(0, -4)).filter((b) => !exclusionReason(b, assetInfo(b), listed))).catch(() => {});
  const btcRaw = await klines("BTCUSDT", "1h", HOUR, 500);
  const now = Date.now(), btcH1 = cols(btcRaw, HOUR, now);
  // candles for the universe (incremental after the first load)
  const loaded = await mapLimit(uni, 4, async (u) => {
    const [h, m] = await Promise.all([klines(u.symbol, "1h", HOUR, 500), klines(u.symbol, "5m", 5 * MIN, 120)]);
    return { u, h1: cols(h, HOUR, Date.now()), m5: cols(m, 5 * MIN, Date.now()) };
  });
  const rows = [];
  let tooNew = 0, failed = 0;
  for (const x of loaded) {
    if (!x || x._error) { failed++; continue; }
    const u = x.u;
    const input = { base: u.base, price: u.price, quoteVolume24h: u.qv, h1: x.h1, m5: x.m5, btcH1, spreadPct: u.spreadPct, spreadHist: spreadHist.get(u.base),
      mcap: u.mcap, supply: supplyOf(u.base), events: eventsFor(u.base), info: u.info, now };
    try {
      const f = computeFeatures(input);
      if (!f.history.enough) { tooNew++; continue; }
      rows.push({ u, input, f, ev: evaluate(f, CONFIG, now) });
    } catch { failed++; } // one coin with odd data never stops the scan
  }
  if (failed) state.errors.Candles = `${failed} coins could not be read this scan`; else delete state.errors.Candles;
  // order book, trades and futures for the coins closest to qualifying
  const deep = rows.filter((x) => x.ev.state !== "moved" && (x.ev.models.A.pass || x.ev.models.B.pass || x.ev.confirmations >= 2))
    .sort((a, b) => b.ev.score - a.ev.score).slice(0, CONFIG.deepLimit);
  await mapLimit(deep, 3, async (x) => {
    const [depth, trades, fut] = await Promise.all([
      depthOf(x.u.symbol, x.u.price).catch(() => null),
      get(`/api/v3/aggTrades?symbol=${x.u.symbol}&limit=1000`).then((t) => largeTradeStats(t)).catch(() => null),
      futuresContext(x.u.base, x.u.chg24).catch(() => null),
    ]);
    try { const f = computeFeatures({ ...x.input, depth, trades, futures: fut }); x.ev = evaluate(f, CONFIG, now); x.f = f; } catch { /* keep the first evaluation */ }
  });
  // tabs
  const view = (x) => candidateView(x.u, x.f, x.ev);
  const tabs = { quiet: [], prebreakout: [], ignition: [], moved: [] };
  for (const x of rows) if (x.ev.state) tabs[x.ev.state].push(x);
  for (const k of Object.keys(tabs)) {
    tabs[k].sort((a, b) => (k === "moved" ? (b.f.px.ret24 ?? 0) - (a.f.px.ret24 ?? 0) : (b.ev.priority === "high") - (a.ev.priority === "high") || b.ev.score - a.ev.score));
    tabs[k] = tabs[k].slice(0, k === "moved" ? 30 : 50).map(view);
  }
  state.tabs = tabs;
  state.universe = { pairs: usdt.length, eligible: uni.length, evaluated: rows.length, excluded, tooNew };
  state.regime = btcRegime(btcH1);
  // snapshots
  let today = store.signals.filter((s) => now - s.at < DAY).length;
  for (const x of rows) {
    const { state: st, priority } = x.ev;
    if (!st || today >= CONFIG.maxSnapshotsPerDay) continue;
    const prev = store.last[x.u.symbol];
    if (!snapshotDecision(prev, st, priority, now)) continue;
    const snap = makeSnapshot(x.u, x.f, x.ev, now);
    store.signals.push(deepFreeze(snap));
    store.tracks[snap.id] = newTrack(snap.price, snap.at);
    store.last[x.u.symbol] = { ...(prev || {}), [st === "moved" ? "moved" : "main"]: { at: now, rank: rankOf(st, priority), state: st } };
    today++;
    if (CONFIG.alerts && priority === "high" && !DEMO && state.telegramConfigured) {
      sendTelegram(telegramText(snap)).then(() => { delete state.errors.Telegram; }).catch((e) => { state.errors.Telegram = e.message; });
    }
  }
  await trackSignals().catch((e) => { state.errors.Tracking = e.message; });
  state.results = computeResults(store.signals.map((s) => ({ ...s, track: store.tracks[s.id] })), CONFIG, Date.now());
  persist();
  state.status = "connected";
  state.lastScanAt = Date.now(); state.lastScanMs = Date.now() - t0;
}

export function btcRegime(B, cfg = CONFIG) {
  const NB = B?.t?.length || 0;
  if (NB < 170) return null;
  const bp = B.c[NB - 1], e50 = ema(B.c.slice(-200), 50);
  const out = { btc24: r(pctChg(bp, B.c[NB - 25]), 2), btc4h: r(pctChg(bp, B.c[NB - 5]), 2), btc7d: r(pctChg(bp, B.c[NB - 169]), 2), aboveEma50: bp > e50[e50.length - 1] };
  out.deteriorating = out.btc24 <= cfg.btc24Min || out.btc4h <= cfg.btc4hMin;
  return out;
}

function makeSnapshot(u, f, ev, now) {
  return {
    id: `${u.symbol}-${now}`, v: LOGIC_VERSION, at: now, symbol: u.symbol, base: u.base, state: ev.state, priority: ev.priority, score: ev.score,
    scoreBand: bandOf(SCORE_BANDS, ev.score), mcap: Math.round(u.mcap.value), mcapBand: bandOf(MCAP_BANDS, u.mcap.value), mcapSource: u.mcap.source,
    price: u.price, confirmations: ev.families.filter((x) => x.ok).map((x) => x.key), flags: ev.flags, late: ev.late.map((x) => x.key),
    components: Object.fromEntries(Object.entries(ev.components).map(([k, c]) => [k, c.points])),
    features: {
      ratio24: r(f.vol.ratio24, 2), ratio4h: r(f.vol.ratio4h, 2), persist12: f.vol.persist12, trades24: r(f.trades.ratio24, 2), buy24: r(f.flow.buy24, 1), buyDelta: r(f.flow.buyDelta, 1),
      r5: r(f.m5.last, 2), consec5: f.m5.consec ?? null, buy15: r(f.m5.buy15, 1), ret1h: r(f.px.ret1h, 2), ret24: r(f.px.ret24, 2), ret7d: r(f.px.ret7d, 2),
      distToHigh: r(f.structure.distToHighPct, 2), aboveRange: r(f.structure.aboveRangePct, 2), compression: r(f.structure.compressionRatio, 2),
      rs24: r(f.rs?.rs24, 2), spreadPct: r(f.liq.spreadPct, 3), depthMin: f.liq.depth ? Math.round(Math.min(f.liq.depth.bidUsd, f.liq.depth.askUsd)) : null,
      oi24h: f.deriv?.oi24hPct ?? null, funding: f.deriv?.fundingPct ?? null, btc24: r(f.btc?.ret24, 2), typicalDailyRange: r(f.px.typicalDailyRange, 1),
    },
  };
}

// Forward tracking: 5-minute bars for the first 24 hours, hourly bars after that, 1-minute bars to settle any bar that
// touched both the stop and a target. Up to 60 requests per scan, oldest-checked first.
async function trackSignals() {
  if (DEMO) return;
  const now = Date.now();
  const due = store.signals.map((s) => [s, store.tracks[s.id]]).filter(([s, t]) => t && !t.done)
    .filter(([s, t]) => now - (t.checkedAt || 0) >= (now - s.at < DAY ? 5 * MIN : HOUR))
    .sort((a, b) => (a[1].checkedAt || 0) - (b[1].checkedAt || 0)).slice(0, 60);
  await mapLimit(due, 3, async ([s, t]) => {
    t.checkedAt = now;
    const switchAt = Math.ceil((s.at + DAY) / HOUR) * HOUR; // 5m bars until the first full hour after 24h, then hourly
    const early = t.lastEnd < switchAt;
    const interval = early ? "5m" : "1h", dur = early ? 5 * MIN : HOUR;
    const start = Math.ceil(Math.max(t.lastEnd, s.at) / dur) * dur;
    const raw = await get(`/api/v3/klines?symbol=${s.symbol}&interval=${interval}&startTime=${start}&limit=${early ? 300 : 1000}`, { retries: 0 });
    const bars = (raw || []).map((k) => ({ t: Number(k[0]), dur, o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) })).filter((b) => b.t + dur <= now && (!early || b.t < switchAt));
    for (const b of bars) {
      if (needsRefine(t, b)) {
        const fine = await get(`/api/v3/klines?symbol=${s.symbol}&interval=1m&startTime=${b.t}&endTime=${b.t + dur - 1}&limit=1000`, { retries: 0 }).catch(() => null);
        const fb = (fine || []).map((k) => ({ t: Number(k[0]), dur: MIN, o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) }));
        if (fb.length && fb[fb.length - 1].t + MIN >= b.t + dur) { advanceTrack(t, fb); continue; }
      }
      advanceTrack(t, [b]);
    }
    if (!bars.length && now - t.lastEnd > 7 * DAY && now - s.at > 7 * DAY) endTrack(t); // no trading for a week: delisted or halted
  });
}

// ───────────────────────────── views + alerts ─────────────────────────────
function candidateView(u, f, ev) {
  const p = u.price, d = f.liq.depth;
  return {
    symbol: u.symbol, base: u.base, name: u.info?.name || u.base, pair: `${u.base}/USDT`, price: p, state: ev.state, stateLabel: STATES[ev.state], priority: ev.priority,
    score: ev.score, components: ev.components, families: ev.families, confirmations: ev.confirmations, mandatory: ev.mandatory, late: ev.late, flags: ev.flags,
    missing: ev.missing, models: ev.models,
    mcap: u.mcap.value, mcapSource: u.mcap.source, mcapCoinGecko: u.mcap.cgValue ?? null, mcapBand: bandOf(MCAP_BANDS, u.mcap.value), preferred: u.mcap.value <= CONFIG.mcapPreferredMax,
    targets: TARGETS.map((T) => ({ pct: T, price: p * (1 + T / 100) })), mcapAt2x: u.mcap.value * 2,
    vol: { r5: r(f.m5.last, 2), r15: r(f.m5.r15, 2), r1h: r(f.vol.ratio1h, 2), r4h: r(f.vol.ratio4h, 2), r24: r(f.vol.ratio24, 2), persist12: f.vol.persist12, consec5: f.m5.consec ?? null, trades24: r(f.trades.ratio24, 2), trades15: r(f.m5.trades15, 2) },
    flow: { buy24: r(f.flow.buy24, 1), buyDelta: r(f.flow.buyDelta, 1), buy15: r(f.m5.buy15, 1), cvdLast12: Math.round(f.flow.cvdLast12), cvdFirst12: Math.round(f.flow.cvdFirst12), cvdAccel: f.flow.cvdAccel,
      large: f.large ? { buyShare: f.large.largeBuyShare, count: f.large.largeCount, minUsd: f.large.largeMinUsd, sampleBuyShare: f.large.buyShare, spanMin: f.large.spanMin } : null },
    px: { ret15m: r(f.m5.ret15, 2), ret1h: r(f.px.ret1h, 2), ret4h: r(f.px.ret4h, 2), ret24: r(f.px.ret24, 2), ret7d: r(f.px.ret7d, 2), typicalDailyRange: r(f.px.typicalDailyRange, 1),
      rs24: r(f.rs?.rs24, 2), rs7d: r(f.rs?.rs7d, 2), rsImproving: f.rs?.improving ?? null, rangeHigh: f.structure.rangeHigh, distToHigh: r(f.structure.distToHighPct, 2), aboveRange: r(f.structure.aboveRangePct, 2),
      tests: f.structure.tests, higherLows: f.structure.higherLows, compression: r(f.structure.compressionRatio, 2), bbPctile: r(f.structure.bbPctile, 0) },
    liq: { spreadPct: r(f.liq.spreadPct, 3), quoteVolume24h: u.qv, depthBid: d ? Math.round(d.bidUsd) : null, depthAsk: d ? Math.round(d.askUsd) : null, depthPartial: d?.partial ?? null, imbalance: d ? r(d.imbalance, 2) : null, spreadTrend: f.liq.spreadTightening == null ? null : f.liq.spreadTightening ? "tightening" : f.liq.spreadWidening ? "widening" : "stable" },
    deriv: f.deriv, onchain: onchainContext(u.base), supply: f.supply, unlock: unlockStatus(f), catalysts: activeCatalysts(f).map((c) => ({ title: c.title, date: new Date(c.time).toISOString().slice(0, 10), source: c.source })),
    history: f.history, limits: Object.fromEntries(Object.entries(f.limits).map(([k, v]) => [k, r(v, 1)])), tags: u.info?.tags || [],
  };
}
// On-chain context from the app's own whale and DEX trackers (Ethereum transfers, followed DEX pools). Shown as
// context only: a transfer to or from an exchange is not proof of buying or selling, so it never adds points.
function onchainContext(base) {
  const w = tokenWhaleSummary(base), d = tokenFlowSummary(base);
  return {
    whales: w.tracked && w.transfers24h ? { transfers24h: w.transfers24h, totalUsd24h: Math.round(w.totalUsd24h), netToExchangesUsd24h: Math.round(w.netToExchanges24h) } : null,
    dex: d.tracked ? { networks: d.networks, netUsd24h: d.last24h.netUsd, swaps24h: d.last24h.swaps, wallets24h: d.last24h.wallets } : null,
  };
}
async function sendTelegram(text) {
  await fetchJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, retries: 1,
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
}
function telegramText(s) {
  const f = s.features;
  return [`EARLY 2X · ${STATES[s.state].toUpperCase()}: ${s.base} (score ${s.score}/100, high priority)`,
    `Market cap ${fmtUsd(s.mcap)} · price ${fmtPx(s.price)} · +100% = ${fmtPx(s.price * 2)} (market cap ${fmtUsd(s.mcap * 2)} at today's supply)`,
    `Volume ${f.ratio24 ?? "n/a"}x its 7-day baseline · buyers ${f.buy24 ?? "n/a"}% · ${sgn(f.ret24)} 24h · ${f.distToHigh != null && f.aboveRange === 0 ? `${f.distToHigh}% below its 7-day high` : `${f.aboveRange}% above its 7-day high`}`,
    `Confirmations: ${s.confirmations.join(", ")}`, s.flags.length ? `Risk flags: ${s.flags.slice(0, 3).join("; ")}` : null,
    "A 2x move is a research target, not a prediction. Not financial advice."].filter(Boolean).join("\n");
}

// ───────────────────────────── API + start ─────────────────────────────
const json = (res, code, d) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(d)); };
export function early2xSnapshot() {
  const recent = store.signals.slice(-60).reverse().map((s) => ({ ...s, track: store.tracks[s.id] || null }));
  return { ...state, config: CONFIG, recent, signalCount: store.signals.length, telegramOn: CONFIG.alerts && state.telegramConfigured };
}
export async function handleEarly2xRequest(req, res, url) {
  if (url.pathname === "/api/early2x") { json(res, 200, early2xSnapshot()); return true; }
  if (url.pathname === "/api/early2x/signals") { json(res, 200, { version: LOGIC_VERSION, config: CONFIG, signals: store.signals.map((s) => ({ ...s, track: store.tracks[s.id] || null })) }); return true; }
  return false;
}
async function tick() {
  if (busy) return;
  busy = true;
  try { await scan(); }
  catch (e) { state.status = "error"; state.errors["Binance Spot"] = e.message; state.sources.spot = "error"; }
  finally { busy = false; }
}
export function startEarly2x() {
  if (started) return;
  started = true;
  console.log(`Early 2x Movers: /screener#early2x | scan every ${CONFIG.scanMinutes} min | market cap ${fmtUsd(CONFIG.mcapMin)}-${fmtUsd(CONFIG.mcapMax)} | Telegram alerts: ${CONFIG.alerts ? "on" : "off (EARLY2X_ALERTS=1 to enable)"}`);
  readFile(CG_FILE, "utf8").then((t) => { const c = JSON.parse(t); if (c && c.map) cg = { ...cg, ...c, mapNext: 0 }; }).catch(() => {})
    .finally(() => loadStore().finally(() => { setTimeout(tick, 20_000); setInterval(tick, CONFIG.scanMinutes * MIN); }));
}

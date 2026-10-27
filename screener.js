// Early-Setup Screener v4 (port of screener.py + fast intraday layer). Node.js 18+, no dependencies.
//
// Two layers:
//   SETUP layer (slow context): Binance USDT spot tokens (largest 500 by market cap), scored 0-100 on
//     volume (25) · chart setup (25) · hot narrative (20) · MC/FDV (10) · futures (10) · liquidity (10).
//   IGNITION layer (fast, every ~20s): 15-minute volume vs that token's normal volume FOR THIS HOUR OF THE DAY,
//     confirmed by 1h volume, volume persistence across 5m candles, trade count, taker-buy pressure, a rising 4h
//     trend, price still holding near the spike high, a calm BTC and a tight spread, while price has NOT run yet.
//     Scored 0-100 (ignition score).
//   OUTCOME tracking: every alert is followed (win = +TARGET% before -STOP%, flat = exit at the horizon price),
//     fees are subtracted, and every alert records the logic version, so each version is measured on its own.
//
// v4, based on the first 36 tracked outcomes (11% win rate, 22 of 36 "flat"):
//   - Removes assets that cannot move +TARGET% within the horizon: stablecoins (new ones too, detected by their peg),
//     tokenized stocks/ETFs/gold and wrapped/staked tokens (Binance sector tags), and any token whose typical 6-hour
//     range is too small for the target.
//   - Narrative strength = median 24h change of the sector's own coins (a category's market cap jumps when new coins are
//     added, which produced fake "+118%" narratives).
//   - Only Binance is used (no CoinGecko, no API key): market caps and sector tags come from Binance's product list.
//     Coins on Binance's Monitoring list (delisting risk) never alert.
//   - New ignition gates: BTC not falling over the last hour, price above a rising 4h average and not stretched far
//     above it, still near the spike high, no long upper wicks. Breaking the prior 12h high adds points.
//   - Daily-setup alerts are off by default (9% win rate). The daily score still feeds the ignition score.
//   - The signal functions are exported, so screener-backtest.js replays exactly this logic on past candles.
//
// BTC rotation (rotation.js, "BTC rotation" tab, /api/rotation): ranks altcoin narratives by how they did vs BTC in
// past weeks with the same BTC regime plus their current price action, backtested week by week. Every ignition
// candidate carries that context (BTC regime, its narratives' rank) and the performance panel measures whether it helps.
// SCREENER_REGIME_GATE=1 also holds ignition alerts while BTC's daily regime is a downtrend.
//
// "Already moved" guard: tokens that are up a lot in 24h/1h or far above their 20-day high are capped at score 55
// and never alert; they are shown separately so you can see them but not chase them.
//
// Fully separate from the Market Flow Radar: own port, own page (public/screener.html), own state file.
// Start with `node screener.js`, or add `import "./screener.js";` at the very end of your server file.
// It flags early setups; it cannot predict price moves. Research signal only, not financial advice.

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRotation } from "./rotation.js";

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
const LIBRARY_ONLY = env.SCREENER_LIBRARY_ONLY === "1"; // set by screener-backtest.js: export the logic, start nothing
export const LOGIC_VERSION = 4;
const HOST = env.SCREENER_HOST || env.HOST || "127.0.0.1";
const PORT = num("SCREENER_PORT", 3001);
const DEMO = env.DEMO === "1";
const POLL_MS = Math.max(10, num("SCREENER_POLL_SECONDS", 20)) * 1000;
const TOP_N = Math.min(1000, Math.max(50, num("SCREENER_TOP_N", 500)));
const MIN_QUOTE_VOLUME = num("SCREENER_MIN_QUOTE_VOLUME", 5_000_000);
const MIN_SCORE_ALERT = num("SCREENER_MIN_SCORE", 70);
const SETUP_ALERTS = env.SCREENER_SETUP_ALERTS === "1";        // daily-setup alerts: off by default (9% win rate so far)
const COOLDOWN_MS = num("SCREENER_COOLDOWN_HOURS", 12) * 3_600_000;
// ---- early-ignition tuning (all adjustable; screener-backtest.js shows which values hold up on past data) ----
const IGNITE_RVOL = num("SCREENER_IGNITE_RVOL", 4);            // 15m volume vs normal 15m volume
const IGNITE_RVOL_1H = num("SCREENER_IGNITE_RVOL_1H", 1.5);    // 1h volume vs normal 1h volume (sustained, not one print)
const MIN_RET15 = num("SCREENER_MIN_MOVE_15M", 0.2);           // % price must have started turning up
const MAX_RET15 = num("SCREENER_MAX_MOVE_15M", 4);             // % above this in 15m = already running
const MAX_RET1H = num("SCREENER_MAX_MOVE_1H", 8);              // % above this in 1h = already moved
const MAX_MOVED_24H = num("SCREENER_MAX_MOVE_24H", 12);        // % above this in 24h = already moved
const MIN_BUY_RATIO = num("SCREENER_MIN_BUY_RATIO", 58);       // % of 15m volume that was aggressive buying
const IGNITE_MIN_SCORE = num("SCREENER_IGNITE_MIN_SCORE", 65); // minimum ignition confidence score (0-100) to alert
const MIN_PERSIST = num("SCREENER_MIN_PERSIST", 2);            // of the last 3 five-minute candles, how many must run at 2x normal volume
const MAX_SPREAD_BPS = num("SCREENER_MAX_SPREAD_BPS", 20);     // skip thin, wide-spread order books (noisy)
const MARKET_WIDE_SHARE = num("SCREENER_MARKET_WIDE_SHARE", 0.3); // if this share of tokens surges at once, raise the bar
const MIN_RANGE_RATIO = num("SCREENER_MIN_RANGE_RATIO", 0.5);  // typical 6h high-low range must be >= this x target (else too slow to win)
const BTC_1H_MIN = num("SCREENER_BTC_1H_MIN", -0.6);           // % no ignition alerts while BTC is down more than this over 1h
const REQUIRE_TREND = env.SCREENER_REQUIRE_TREND !== "0";       // price above a rising 4h average
const MAX_EXTENSION = num("SCREENER_MAX_EXTENSION", 4);        // % max distance above the 4h average (stretched = late)
const MAX_FADE = num("SCREENER_MAX_FADE", 1);                  // % max pullback from the last 15m high (burst fading)
const MAX_WICK = num("SCREENER_MAX_WICK", 0.55);               // max share of the last 15m range that is upper wick (selling)
const TARGET_PCT = num("SCREENER_TARGET_PCT", 4);              // outcome tracking: win = +target% before -stop%
const STOP_PCT = num("SCREENER_STOP_PCT", 2.5);
const OUTCOME_MS = num("SCREENER_OUTCOME_HOURS", 6) * 3_600_000;
const FEE_PCT = num("SCREENER_FEE_PCT", 0.2);                  // round-trip fees subtracted from every result (0.1% in + 0.1% out)
const EXCLUDE_NONCRYPTO = env.SCREENER_EXCLUDE_NONCRYPTO !== "0";
const REGIME_GATE = env.SCREENER_REGIME_GATE === "1";          // hold ignition alerts while BTC's daily regime is a downtrend
const HOURLY_REFRESH_MS = 6 * 3_600_000;
const IGNITE_COOLDOWN_MS = num("SCREENER_IGNITE_COOLDOWN_HOURS", 4) * 3_600_000;
const MOVED_SCORE_CAP = 55;
const WEIGHT_GUARD = num("SCREENER_WEIGHT_GUARD", 4800);       // skip the fast scan if Binance used-weight per minute gets this high
const DEEP_SCAN_LIMIT = 40;
const MAX_ALERTS_PER_SCAN = 4;
const HOT_CATEGORY_MIN_CHANGE = 3.0;                            // % median 24h change of a category's coins
const MAX_HOT_CATEGORIES = 8;
const BTC_DROP_PAUSE = -3.0;
const listEnv = (k) => new Set((env[k] || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
const BLOCKLIST = listEnv("SCREENER_BLOCKLIST");
const ALLOWLIST = listEnv("SCREENER_ALLOWLIST"); // never removed by the tag exclusion
const ALLOW_MONITORING = env.SCREENER_ALLOW_MONITORING === "1"; // let coins on Binance's Monitoring list alert
export const STABLES = new Set(["USDT", "USDC", "FDUSD", "TUSD", "DAI", "USDE", "USDD", "PYUSD", "USD1", "BUSD", "USDP", "EUR", "AEUR",
  "RLUSD", "USDS", "USDG", "USDF", "USD0", "BFUSD", "XUSD", "FRAX", "GHO", "LUSD", "CRVUSD", "EURC", "EURI", "USDB", "SUSDE", "USDX", "USDQ"]);
// Gold, wrapped and liquid-staked tokens: they track another asset and almost never move +4% in 6h on their own.
export const NONCRYPTO = new Set(["PAXG", "XAUT", "WBTC", "WBETH", "BNSOL", "STETH", "WSTETH", "CBBTC", "BETH", "WETH"]);
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;
const BN = "https://api.binance.com";
const BF = "https://fapi.binance.com";
const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, DEMO ? "screener_state.demo.json" : "screener_state.json"); // demo never touches real history
const KLINE_REFRESH_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
const MAX_EVENTS = 400;

// Ignition rules as one object, so the backtest can replay them with other values.
export const DEFAULT_IGNITION = {
  rvol: IGNITE_RVOL, rvol1h: IGNITE_RVOL_1H, minRet15: MIN_RET15, maxRet15: MAX_RET15, maxRet1h: MAX_RET1H, maxMove24h: MAX_MOVED_24H,
  minBuy: MIN_BUY_RATIO, minPersist: MIN_PERSIST, maxSpread: MAX_SPREAD_BPS, minRangeRatio: MIN_RANGE_RATIO, targetPct: TARGET_PCT,
  btc1hMin: BTC_1H_MIN, requireTrend: REQUIRE_TREND, maxExt: MAX_EXTENSION, maxFade: MAX_FADE, maxWick: MAX_WICK,
};
export const CONFIG = {
  version: LOGIC_VERSION, targetPct: TARGET_PCT, stopPct: STOP_PCT, outcomeHours: OUTCOME_MS / 3_600_000, feePct: FEE_PCT,
  igniteCooldownHours: IGNITE_COOLDOWN_MS / 3_600_000, igniteMinScore: IGNITE_MIN_SCORE, btcDropPausePct: BTC_DROP_PAUSE,
  minMove15m: MIN_RET15, maxMove15m: MAX_RET15, marketWideShare: MARKET_WIDE_SHARE, minQuoteVolume: MIN_QUOTE_VOLUME,
};

const state = {
  startedAt: Date.now(),
  lastUpdated: null,
  lastScanMs: null,
  pollIntervalMs: POLL_MS,
  demo: DEMO,
  status: "starting",
  metaStatus: { source: "none" },
  futuresStatus: "not_checked",
  errors: {},
  regime: { btcChange24hPct: null, btc1hPct: null, ok: true },
  universe: { binance: 0, eligible: 0, excluded: 0, slow: 0 },
  warmup: { loaded: 0, total: 0, seasonal: 0 },
  breadth: { hotShare: null, marketWide: false },
  stats: null,
  hotNarratives: [],
  candidates: [],
  events: [],
  config: {
    version: LOGIC_VERSION, minScore: MIN_SCORE_ALERT, setupAlerts: SETUP_ALERTS, cooldownHours: COOLDOWN_MS / 3_600_000,
    minQuoteVolume: MIN_QUOTE_VOLUME, topN: TOP_N, btcDropPausePct: BTC_DROP_PAUSE, igniteRvol: IGNITE_RVOL, igniteRvol1h: IGNITE_RVOL_1H,
    minBuyRatio: MIN_BUY_RATIO, maxMove15m: MAX_RET15, maxMove1h: MAX_RET1H, maxMove24h: MAX_MOVED_24H, igniteMinScore: IGNITE_MIN_SCORE,
    maxSpreadBps: MAX_SPREAD_BPS, minPersist: MIN_PERSIST, minRangeRatio: MIN_RANGE_RATIO, minRange6hPct: MIN_RANGE_RATIO * TARGET_PCT,
    btc1hMin: BTC_1H_MIN, requireTrend: REQUIRE_TREND, maxExtension: MAX_EXTENSION, maxFade: MAX_FADE, maxWick: MAX_WICK,
    targetPct: TARGET_PCT, stopPct: STOP_PCT, outcomeHours: OUTCOME_MS / 3_600_000, feePct: FEE_PCT,
    igniteCooldownHours: IGNITE_COOLDOWN_MS / 3_600_000, excludeNonCrypto: EXCLUDE_NONCRYPTO, regimeGate: REGIME_GATE,
  },
  telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
  mainUrl: env.MAIN_URL || `http://${env.HOST || "127.0.0.1"}:${num("PORT", 3000)}`,
};
const lastAlertAt = new Map();
const dailyCache = new Map();   // base -> closed daily candles (refreshed hourly / on UTC day change)
const dailyRetryAt = new Map(); // base -> time before which a failed load is not retried
const hourlyCache = new Map();  // base -> hour-of-day volume medians + typical 6h range
const hourlyRetryAt = new Map();
const oiCache = new Map();
let fundingCache = { at: 0, map: new Map() };
let binanceWeight = 0;
export const usedWeight = () => binanceWeight;
let polling = false, dailyBusy = false, hourlyBusy = false;
let bookCache = { at: 0, map: new Map() };
// BTC-regime narrative rotation (own tab). Not created when the backtest imports this file.
const rotation = LIBRARY_ONLY ? null : createRotation({
  fetchJson: (...a) => fetchJson(...a), cacheDir: path.join(here, DEMO ? "rotation_cache_demo" : "rotation_cache"), stables: STABLES, nonCrypto: NONCRYPTO,
  getNarratives: (prices) => binanceNarratives(prices), demo: DEMO, days: Math.min(2000, Math.max(300, num("ROTATION_DAYS", 1000))), holdDays: num("ROTATION_HOLD_DAYS", 7), feePct: FEE_PCT,
  only: (env.ROTATION_NARRATIVES || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
  startDelayMs: num("ROTATION_START_DELAY_SECONDS", 45) * 1000, usedWeight: () => binanceWeight,
});

// ───────────────────────────── utilities ─────────────────────────────
const n = (v) => {
  const x = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(x) ? null : x;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const pstdev = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
export const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

class HttpError extends Error {
  constructor(message, status, retryAfterMs = null) { super(message); this.status = status; this.retryAfterMs = retryAfterMs; }
}
const RETRYABLE = [418, 429, 500, 502, 503, 504];
const SOURCES = [["fapi.binance.com", "Binance Futures"], ["api.binance.com", "Binance Spot"], ["www.binance.com", "Binance asset info"], ["api.telegram.org", "Telegram"]];
const sourceOf = (url) => (SOURCES.find(([h]) => String(url).includes(h)) || [, "API"])[1];
// After a 429/418 Binance tells us how long to back off (Retry-After). Until then no request is sent to that host,
// because hammering a rate-limited Binance IP escalates to a temporary ban (418).
const hostPause = new Map();
export const binancePause = () => { const t = Math.max(hostPause.get("Binance Spot") || 0, hostPause.get("Binance Futures") || 0); return t > Date.now() ? t : null; };

export async function fetchJson(url, { headers = {}, method = "GET", body, timeoutMs = 12_000, retries = 2, retry429 = true } = {}) {
  const src = sourceOf(url);
  const paused = hostPause.get(src);
  if (paused && paused > Date.now()) throw new HttpError(`${src} is paused for ${Math.ceil((paused - Date.now()) / 1000)}s after a rate limit`, 429, paused - Date.now());
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method, body, signal: ctrl.signal,
        headers: { "user-agent": "EarlySetupScreener/4.0", accept: "application/json", ...headers },
      });
      if (String(url).startsWith(BN) && typeof res.headers?.get === "function") {
        const w = Number(res.headers.get("x-mbx-used-weight-1m"));
        if (Number.isFinite(w) && w > 0) binanceWeight = w;
      }
      if (res.ok) return await res.json();
      const hint = res.status === 403 || res.status === 451 ? " (access blocked in this region)"
        : res.status === 418 ? " (IP temporarily banned for too many requests)" : res.status === 429 ? " (rate limited)" : "";
      const ra = Number(typeof res.headers?.get === "function" ? res.headers.get("retry-after") : NaN);
      const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : null;
      lastErr = new HttpError(`${src} HTTP ${res.status}${hint}`, res.status, retryAfterMs);
      if ((res.status === 429 || res.status === 418) && src.startsWith("Binance")) {
        hostPause.set(src, Date.now() + (retryAfterMs ?? (res.status === 418 ? 300_000 : 60_000)));
        lastErr.noRetry = true;
        throw lastErr;
      }
      if (res.status === 429 && !retry429) lastErr.noRetry = true; // the caller handles the wait
      if (!RETRYABLE.includes(res.status) || lastErr.noRetry) throw lastErr;
    } catch (e) {
      if (e instanceof HttpError && (!RETRYABLE.includes(e.status) || e.noRetry)) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(lastErr?.retryAfterMs ?? 1500 * (attempt + 1) * (lastErr?.status === 429 ? 4 : 1));
  }
  throw lastErr;
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { _error: e.message, _item: items[i] }; }
      await sleep(25);
    }
  }));
  return results;
}

// ───────────────────────────── indicators ─────────────────────────────
export function rsi(closes, len = 14) {
  if (closes.length < len + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= len; i++) {
    gains += Math.max(closes[i] - closes[i - 1], 0);
    losses += Math.max(closes[i - 1] - closes[i], 0);
  }
  gains /= len; losses /= len;
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains = (gains * (len - 1) + Math.max(d, 0)) / len;
    losses = (losses * (len - 1) + Math.max(-d, 0)) / len;
  }
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
}

// d = closed daily candles {closes, highs, qvols}; lastPrice and vol24 come from the live 24h ticker.
export function techMetrics(d, lastPrice, vol24) {
  if (!d || d.closes.length < 29) return null;
  const avgVol = mean(d.qvols.slice(-20));
  const rets = [];
  for (let i = 1; i < d.closes.length; i++) rets.push(d.closes[i] / d.closes[i - 1] - 1);
  const sdRecent = pstdev(rets.slice(-7));
  const sdPrior = pstdev(rets.slice(-27, -7));
  return {
    rvol: avgVol > 0 ? vol24 / avgVol : 0,
    avgDailyQuote: avgVol,
    distToHigh: lastPrice / Math.max(...d.highs.slice(-20)) - 1, // <0 below the 20d high, >0 above
    aboveSma: lastPrice > mean(d.closes.slice(-20)),
    rsi: rsi([...d.closes, lastPrice]),
    compressed: sdPrior > 0 && sdRecent < 0.7 * sdPrior,
  };
}

// Hour-of-day volume medians and the typical (median) 6-hour high-low range, from ~14 days of closed hourly candles.
// c = columns {t, high, low, qv}; [from, to) selects the candles. Shared with the backtest.
export function hourlyProfile(c, from = 0, to = c.t.length) {
  const byHour = Array.from({ length: 24 }, () => []), all = [];
  for (let i = from; i < to; i++) {
    const v = c.qv[i];
    if (!Number.isFinite(v)) continue;
    byHour[Math.floor(c.t[i] / 3_600_000) % 24].push(v);
    all.push(v);
  }
  if (all.length < 120) return null;
  const overall = median(all), ranges = [];
  for (let i = from; i + 6 <= to; i++) {
    let hi = -Infinity, lo = Infinity, ok = true;
    for (let j = i; j < i + 6; j++) {
      const h = c.high[j], l = c.low[j];
      if (!Number.isFinite(h) || !Number.isFinite(l)) { ok = false; break; }
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    if (ok && lo > 0) ranges.push((hi / lo - 1) * 100);
  }
  return { hours: byHour.map((a) => (a.length >= 4 ? median(a) : overall)), range6h: ranges.length ? median(ranges) : null, n: all.length };
}

// Confirmation features from 5-minute candles. k = columns {t, open, high, low, close, qv, trades, buy};
// end = index of the newest candle (may be unfinished live); expect5(endMs) = normal volume for the 5 min ending at endMs.
export function fiveMinFeatures(k, end, nowMs, expect5) {
  if (end < 11) return null;
  let total = 0, buy = 0, persist = 0, considered = 0, wick = 0, span = 0, hi3 = -Infinity, rec = 0;
  for (let i = end - 2; i <= end; i++) {
    total += k.qv[i]; buy += k.buy[i];
    hi3 = Math.max(hi3, k.high[i]);
    wick += k.high[i] - Math.max(k.open[i], k.close[i]);
    span += k.high[i] - k.low[i];
    const elapsed = clamp((nowMs - k.t[i]) / 300_000, 0, 1);
    rec += k.trades[i] / clamp(elapsed, 0.3, 1);
    if (elapsed < 0.3) continue; // too early in this candle to judge it
    considered++;
    const exp = expect5(k.t[i] + 300_000) * elapsed;
    if (exp > 0 && k.qv[i] / exp >= 2) persist++;
  }
  const close = k.close[end], baseT = [];
  for (let i = Math.max(0, end - 11); i <= end - 3; i++) baseT.push(k.trades[i]);
  const baseTrades = median(baseT);
  let hi = -Infinity, lo = Infinity;
  for (let i = Math.max(0, end - 23); i <= end; i++) { hi = Math.max(hi, k.high[i]); lo = Math.min(lo, k.low[i]); }
  const out = {
    buy15: total > 0 ? (buy / total) * 100 : null,
    persist, persistOf: considered,
    tradesRatio: baseTrades > 0 ? rec / 3 / baseTrades : null,
    rangePos: hi > lo ? (close - lo) / (hi - lo) : null,          // position in the 2h range
    nearHigh: close >= hi * 0.995,
    fadePct: hi3 > 0 && close > 0 ? (hi3 / close - 1) * 100 : 0,  // pullback from the last 15m high
    wickShare: span > 0 ? wick / span : 0,                         // share of the last 15m range that is upper wick
    trendUp: null, extPct: null, breakout: null, distTo12hHigh: null,
  };
  if (end >= 59) { // 4h average and its slope over the last hour
    let s = 0, sp = 0;
    for (let i = end - 47; i <= end; i++) s += k.close[i];
    for (let i = end - 59; i <= end - 12; i++) sp += k.close[i];
    const sma = s / 48, smaPrev = sp / 48;
    out.trendUp = close > sma && sma > smaPrev;
    out.extPct = (close / sma - 1) * 100;
  }
  if (end >= 146) { // prior 12h high, excluding the last 15 minutes
    let h12 = -Infinity;
    for (let i = end - 146; i <= end - 3; i++) h12 = Math.max(h12, k.high[i]);
    out.breakout = close > h12;
    out.distTo12hHigh = (close / h12 - 1) * 100;
  }
  return out;
}

// ───────────────────────────── scoring ─────────────────────────────
// t = techMetrics; info = {mc, fdv} (fdv unknown on Binance: neutral); narrative = {change, names}; funding = per-8h rate.
export function scoreToken(t, info, narrative, funding, oiChg, quoteVol, priceChg) {
  const reasons = [];
  const parts = {
    volume: { pts: 0, max: 25 }, technical: { pts: 0, max: 25 }, narrative: { pts: 0, max: 20 },
    tokenomics: { pts: 0, max: 10 }, futures: { pts: 0, max: 10 }, liquidity: { pts: 0, max: 10 },
  };

  const rv = t.rvol;
  parts.volume.pts = rv >= 3 ? 25 : rv >= 2 ? 18 : rv >= 1.5 ? 10 : 0;
  if (parts.volume.pts) reasons.push(`24h volume ${rv.toFixed(1)}x its 20d average`);

  const d = t.distToHigh;
  let tech = 0;
  if (d >= -0.03 && d < 0) { tech += 12; reasons.push("within 3% of 20d high (coiling)"); }
  else if (d >= 0 && d <= 0.08) { tech += 12; reasons.push("fresh 20d breakout"); }
  else if (d > 0.08) { reasons.push("already extended above 20d high"); } // no points: do not reward chasing
  if (t.compressed) { tech += 5; reasons.push("volatility compression"); }
  if (t.aboveSma) tech += 4;
  if (t.rsi != null && t.rsi >= 45 && t.rsi <= 72) tech += 4;
  parts.technical.pts = tech;

  if (narrative) {
    parts.narrative.pts = narrative.change >= 8 ? 20 : narrative.change >= 5 ? 15 : 10;
    const names = [...new Set(narrative.names)].join(", ").slice(0, 60);
    reasons.push(`hot narrative: ${names} (coins ${narrative.change >= 0 ? "+" : ""}${narrative.change.toFixed(1)}% 24h)`);
  }

  const fdv = info?.fdv, mc = info?.mc || 0;
  if (fdv && mc) {
    const ratio = mc / fdv;
    parts.tokenomics.pts = ratio >= 0.7 ? 10 : ratio >= 0.5 ? 7 : ratio >= 0.3 ? 4 : 0;
    if (ratio < 0.3) reasons.push(`low MC/FDV ${Math.round(ratio * 100)}% (dilution risk)`);
  } else parts.tokenomics.pts = 5; // unknown: neutral

  let fut = 0;
  if (funding == null) fut = 5; // no futures market: neutral
  else {
    if (funding > 0.0005) { fut -= 5; reasons.push(`crowded longs, funding ${(funding * 100).toFixed(3)}%`); }
    else if (funding >= -0.0001 && funding <= 0.0003) fut += 4;
    if (oiChg != null && oiChg >= 0.03 && priceChg > 0) {
      fut += 6; reasons.push(`open interest +${Math.round(oiChg * 100)}% with rising price`);
    }
  }
  parts.futures.pts = fut;

  parts.liquidity.pts = quoteVol >= 50e6 ? 10 : quoteVol >= 20e6 ? 7 : 4;

  const score = clamp(Math.round(Object.values(parts).reduce((a, p) => a + p.pts, 0)), 0, 100);
  return { score, reasons, parts };
}

// f = fast-layer metrics (or undefined). moved: the token has already run (hide / never alert).
// state: ignited | heating | ran | null. miss = what a "heating" token still lacks (shown on the page).
// slow = its typical 6h range is too small to reach the target, so it is never an ignition.
export function classifyIgnition(f, change24h, distToHigh = 0, p = DEFAULT_IGNITION) {
  const movedWhy = [];
  if (change24h > p.maxMove24h) movedWhy.push(`+${change24h.toFixed(1)}% in 24h`);
  if (distToHigh > 0.08) movedWhy.push(`${Math.round(distToHigh * 100)}% above its 20d high`);
  if (f && f.ret1h != null && f.ret1h > p.maxRet1h) movedWhy.push(`+${f.ret1h.toFixed(1)}% in 1h`);
  if (f && f.ret15 > p.maxRet15) movedWhy.push(`+${f.ret15.toFixed(1)}% in 15m`);
  const moved = movedWhy.length > 0;
  const slow = !!f && f.range6h != null && f.range6h < p.minRangeRatio * p.targetPct;
  if (!f || !(f.rvol15 >= 2)) return { state: null, moved, movedWhy, miss: [], slow };
  if (moved) return { state: "ran", moved, movedWhy, miss: [], slow };
  if (slow) return { state: null, moved, movedWhy, miss: [], slow };
  const need = p.rvol * (f.marketWide ? 1.5 : 1); // a market-wide surge is not token-specific: raise the bar
  const miss = [];
  if (f.rvol15 < need) miss.push(`15m volume ${need.toFixed(1)}x${f.marketWide ? " (market-wide surge)" : ""}`);
  if (!(f.ret15 >= p.minRet15)) miss.push("price turning up");
  if ((f.rvol1h ?? 0) < p.rvol1h) miss.push("1h volume");
  if (f.range6h == null) miss.push("volatility history");
  if (f.btc1h != null && f.btc1h < p.btc1hMin) miss.push(`steady BTC (BTC ${f.btc1h.toFixed(1)}% 1h)`);
  if (f.regimeOff) miss.push(`BTC daily trend (${f.regimeOff})`);
  if (f.monitoring) miss.push("off Binance's Monitoring list (delisting risk)");
  if (f.buy15 == null) miss.push("buyer check"); else if (f.buy15 < p.minBuy) miss.push(`buyers ${p.minBuy}%+`);
  if (f.persist == null) miss.push("persistence check");
  else {
    if (f.persist < p.minPersist) miss.push("volume persistence");
    if (p.requireTrend && f.trendUp !== true) miss.push("rising 4h trend");
    if (f.extPct != null && f.extPct > p.maxExt) miss.push(`less stretched (${f.extPct.toFixed(1)}% above 4h avg)`);
    if (f.fadePct > p.maxFade) miss.push(`holding the spike (faded ${f.fadePct.toFixed(1)}%)`);
    if (f.wickShare > p.maxWick) miss.push("no selling wicks");
  }
  if (f.spreadBps != null && f.spreadBps > p.maxSpread) miss.push("tighter spread");
  return { state: miss.length ? "heating" : "ignited", moved, movedWhy, miss, slow };
}

// Ignition confidence score, 0-100. Needs the 5m confirmation data (f.persist != null).
// Buyer share did not separate winners from losers in the first results, so it now weighs less; price structure
// (12h breakout, rising 4h trend) and room to move weigh more.
export function ignitionScore(f, ctxScore, funding, narrative, p = DEFAULT_IGNITION) {
  const parts = {
    volume: { pts: 0, max: 20 }, persistence: { pts: 0, max: 15 }, buyers: { pts: 0, max: 10 }, structure: { pts: 0, max: 20 },
    strength: { pts: 0, max: 5 }, context: { pts: 0, max: 15 }, quality: { pts: 0, max: 15 },
  };
  const r = f.rvol15;
  parts.volume.pts = r >= 8 ? 20 : r >= 6 ? 17 : r >= 4 ? 13 : r >= 3 ? 8 : 0;
  const per = f.persist ?? 0, tr = f.tradesRatio ?? 0;
  parts.persistence.pts = (per >= 3 ? 9 : per === 2 ? 6 : per === 1 ? 2 : 0) + (tr >= 2 ? 6 : tr >= 1.5 ? 4 : tr >= 1.2 ? 2 : 0);
  const b = f.buy15 ?? 0;
  parts.buyers.pts = b >= 70 ? 10 : b >= 64 ? 8 : b >= 58 ? 5 : b >= 52 ? 2 : 0;
  const rp = f.rangePos ?? 0;
  parts.structure.pts = (rp >= 0.8 ? 6 : rp >= 0.6 ? 3 : 0) + (f.breakout ? 6 : 0) + (f.nearHigh ? 2 : 0)
    + (f.ret15 >= 0.2 && f.ret15 <= 2 ? 3 : f.ret15 > 2 ? 1 : 0) + (f.trendUp ? 3 : 0);
  const rs = f.rs15 ?? 0;
  parts.strength.pts = rs >= 0.5 ? 5 : rs >= 0.1 ? 3 : 0;
  parts.context.pts = Math.round(clamp(ctxScore, 0, 100) * 0.15);
  const room = f.range6h == null ? null : f.range6h / p.targetPct;
  parts.quality.pts = (f.spreadBps == null ? 2 : f.spreadBps <= 5 ? 5 : f.spreadBps <= 10 ? 3 : f.spreadBps <= 20 ? 1 : 0)
    + (funding == null ? 1 : funding <= 0.0003 ? 3 : 0) + (narrative ? 2 : 0)
    + (room == null ? 0 : room >= 1.5 ? 5 : room >= 1 ? 3 : room >= 0.75 ? 2 : 1);
  const score = clamp(Math.round(Object.values(parts).reduce((a, q) => a + q.pts, 0)), 0, 100);
  return { score, parts };
}
const labelFor = (score) => score >= MIN_SCORE_ALERT ? "Early setup" : score >= 55 ? "Watch closely" : score >= 40 ? "Developing" : "Weak";

function buildCandidate(base, info, tk, t, narrative, funding, oiChg, fast) {
  const quoteVol = n(tk.quoteVolume) || 0;
  const priceChg = n(tk.priceChangePercent) || 0;
  const s = scoreToken(t, info, narrative, funding, oiChg, quoteVol, priceChg);
  const ig = classifyIgnition(fast, priceChg, t.distToHigh);
  let score = s.score, label = labelFor(score);
  if (ig.moved) { score = Math.min(score, MOVED_SCORE_CAP); label = "Already moved"; }
  let igs = null;
  if (fast && fast.persist != null && !ig.moved && !ig.slow) igs = ignitionScore(fast, score, funding, narrative);
  return {
    symbol: base + "USDT", base, name: info?.name || base, rank: info?.rank ?? null, marketCap: info?.mc ?? null,
    monitoring: isMonitoring(info), seed: isSeed(info),
    price: n(tk.lastPrice), change24h: priceChg, quoteVolume: quoteVol,
    rvol: round(t.rvol, 2), distToHigh: round(t.distToHigh, 4), aboveSma: t.aboveSma,
    rsi: round(t.rsi, 1), compressed: t.compressed,
    mcFdv: info?.fdv && info?.mc ? round(info.mc / info.fdv, 3) : null,
    narrative: narrative ? { change24hPct: round(narrative.change, 2), names: [...new Set(narrative.names)] } : null,
    fundingPct: funding == null ? null : round(funding * 100, 4),
    oiChange24hPct: oiChg == null ? null : round(oiChg * 100, 2),
    // fast layer
    rvol15: round(fast?.rvol15, 2), rvol1h: round(fast?.rvol1h, 2), ret15m: round(fast?.ret15, 2), ret1h: round(fast?.ret1h, 2),
    buyRatio15m: round(fast?.buy15, 1), ignition: ig.state, moved: ig.moved, movedWhy: ig.movedWhy, missing: ig.miss, slow: ig.slow,
    persist: fast?.persist ?? null, persistOf: fast?.persistOf ?? null, tradesRatio: round(fast?.tradesRatio, 2),
    rangePos: round(fast?.rangePos, 2), spreadBps: round(fast?.spreadBps, 1), rs15: round(fast?.rs15, 2),
    range6h: round(fast?.range6h, 2), btc1h: round(fast?.btc1h, 2), trendUp: fast?.trendUp ?? null, extPct: round(fast?.extPct, 2),
    fadePct: round(fast?.fadePct, 2), wickShare: round(fast?.wickShare, 2), breakout: fast?.breakout ?? null,
    distTo12hHigh: round(fast?.distTo12hHigh, 2),
    seasonalBaseline: fast ? !!fast.seasonal : null, marketWide: !!fast?.marketWide,
    igScore: igs ? igs.score : null, igParts: igs ? igs.parts : null,
    rotation: rotation ? rotation.context(base) : null,
    score, label, reasons: s.reasons, parts: s.parts, updatedAt: Date.now(),
  };
}

// ───────────────────────────── data: Binance asset info (market caps + sector tags) ─────────────────────────────
// Binance's documented spot API has prices and volumes but no market caps or sectors. Those come from the product list
// that binance.com's own Markets page loads: circulating supply and sector tags (AI, Meme, RWA, Layer1_Layer2, Gaming,
// Monitoring, Seed ...). It needs no API key and is fetched once every 6 hours. It is not part of the documented API,
// so it could change: the last good copy is kept in binance_meta.json, and without any copy the screener ranks coins by
// 24h volume and uses the built-in narrative lists below.
const META_URL = "https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true";
const META_FILE = path.join(here, DEMO ? "binance_meta.demo.json" : "binance_meta.json");
const META_REFRESH_MS = 6 * 3_600_000;
// Binance sector tag -> narrative name. Unlisted tags also become narratives when 4+ coins carry them and they are not
// programme or chain labels (TAG_IGNORE).
const TAG_NARRATIVES = [
  [/^ai$|artificial.?intelligence/i, "AI"], [/meme/i, "Meme"], [/layer.?1.?.?layer.?2/i, "Layer 1 / Layer 2"], [/^layer.?1$|^l1$/i, "Layer 1"],
  [/^layer.?2$|^l2$/i, "Layer 2"], [/^defi$/i, "DeFi"], [/rwa|real.?world/i, "RWA"], [/gaming|gamefi/i, "Gaming"], [/metaverse/i, "Metaverse"],
  [/^nft$/i, "NFT"], [/depin/i, "DePIN"], [/storage/i, "Storage"], [/infrastructure/i, "Infrastructure"], [/privacy/i, "Privacy"],
  [/oracle/i, "Oracles"], [/liquid.?staking|^lsd$/i, "Liquid staking"], [/restaking/i, "Restaking"], [/payment/i, "Payments"],
  [/^zk|zero.?knowledge/i, "Zero knowledge"], [/solana/i, "Solana ecosystem"], [/polkadot/i, "Polkadot ecosystem"], [/^bitcoin.?eco|^btcfi/i, "Bitcoin ecosystem"],
];
const TAG_IGNORE = /^(pos|pow|bsc|bnb.?chain|launchpool|launchpad|megadrop|hodler.*|mining.?zone|monitoring|seed|innovation.*|new.*|alpha|fan.?token|etf|margin|isolated|.*airdrop.*|.*pool.*|grayscale|a16z.*|.*holdings|.*portfolio|arbitrum|base|polygon|avalanche|ethereum|optimism)$/i;
const NONCRYPTO_TAG = /stable|tokeni[sz]ed|xstock|\bstocks?\b|equit|\bgold\b|silver|commodit|wrapped|bridged/i;
const isMonitoring = (info) => !!info?.tags?.some((t) => /monitoring/i.test(t));
const isSeed = (info) => !!info?.tags?.some((t) => /^seed$/i.test(t));
// Used only when Binance's product list cannot be read and no saved copy exists. Coins that are not listed are skipped.
export const BUILTIN_NARRATIVES = {
  "AI": ["FET", "RENDER", "TAO", "WLD", "ARKM", "IO", "VIRTUAL", "NEAR", "GRT", "PHB", "NFP", "AI", "THETA"],
  "Meme": ["DOGE", "SHIB", "PEPE", "FLOKI", "BONK", "WIF", "BOME", "MEME", "PEOPLE", "TRUMP", "PENGU", "NEIRO", "TURBO", "1000SATS"],
  "Layer 1": ["ETH", "SOL", "BNB", "ADA", "AVAX", "DOT", "APT", "SUI", "SEI", "TON", "ATOM", "ALGO", "ICP", "TRX", "HBAR", "EGLD", "INJ"],
  "Layer 2": ["ARB", "OP", "POL", "STRK", "MANTA", "IMX", "ZK", "METIS", "SCR"],
  "DeFi": ["UNI", "AAVE", "LDO", "CRV", "COMP", "SUSHI", "1INCH", "DYDX", "PENDLE", "JUP", "ENA", "CAKE", "RUNE", "GMX", "SNX"],
  "RWA": ["ONDO", "OM", "POLYX", "PLUME", "TRU", "USUAL", "SYRUP"],
  "Gaming": ["AXS", "SAND", "MANA", "GALA", "ILV", "YGG", "PIXEL", "PORTAL", "BEAMX", "XAI", "ACE"],
  "DePIN": ["FIL", "AR", "IOTX", "STORJ", "THETA", "RENDER", "IO"],
  "Oracles": ["LINK", "PYTH", "BAND", "API3", "TRB", "UMA"],
  "Privacy": ["ZEC", "DASH", "ZEN", "ROSE"],
  "Interoperability": ["DOT", "ATOM", "QNT", "AXL", "ZRO", "W"],
  "Liquid staking": ["LDO", "RPL", "JTO", "SSV", "ETHFI", "LISTA", "EIGEN"],
};
const meta = { at: 0, source: "none", coins: new Map(), narratives: new Map(), nextTry: 0, loaded: false, error: null };
const prettyTag = (t) => t.replace(/[_-]+/g, " ").trim().replace(/^./, (ch) => ch.toUpperCase());
function narrativeOf(tag) {
  for (const [re, name] of TAG_NARRATIVES) if (re.test(tag)) return name;
  return TAG_IGNORE.test(tag) || NONCRYPTO_TAG.test(tag) ? null : "auto:" + tag;
}
function setMeta(coins, source, at) {
  const groups = new Map();
  if (coins) {
    for (const [base, c] of coins) for (const tag of c.tags) {
      const name = narrativeOf(tag);
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, { tags: new Set(), bases: new Set() });
      groups.get(name).tags.add(tag); groups.get(name).bases.add(base);
    }
  }
  const narratives = new Map();
  for (const [name, g] of groups) {
    if (!name.startsWith("auto:")) narratives.set(name, g);
    else if (g.bases.size >= 4 && !groups.has(prettyTag(name.slice(5)))) narratives.set(prettyTag(name.slice(5)), g);
  }
  if (!narratives.size) { // no usable tags (format changed or no copy): built-in lists
    for (const [name, list] of Object.entries(BUILTIN_NARRATIVES)) narratives.set(name, { tags: new Set(["built-in"]), bases: new Set(list) });
    if (source === "live" || source === "cached") source += " (no sector tags, built-in narratives)";
  }
  Object.assign(meta, { coins: coins || new Map(), narratives, source, at, loaded: true });
}
// One request at a time: callers that arrive while it is running (scan, rotation tab) wait for the same result.
let metaJob = null;
function refreshMeta() {
  if (metaJob) return metaJob;
  if (meta.loaded && Date.now() < meta.nextTry) return Promise.resolve();
  metaJob = loadMeta().finally(() => { metaJob = null; });
  return metaJob;
}
async function loadMeta() {
  try {
    const r = await fetchJson(META_URL, { retries: 1, timeoutMs: 20_000 });
    const rows = Array.isArray(r?.data) ? r.data : null;
    if (!rows?.length) throw new Error("Unexpected Binance product list response");
    const coins = new Map();
    for (const p of rows) {
      if (p.q !== "USDT" || !p.b || p.etf) continue;
      coins.set(String(p.b).toUpperCase(), { name: p.an || p.b, cs: n(p.cs), tags: Array.isArray(p.tags) ? p.tags.map(String) : [] });
    }
    if (coins.size < 50) throw new Error("Binance product list looks incomplete");
    setMeta(coins, "live", Date.now());
    writeFile(META_FILE, JSON.stringify({ at: meta.at, coins: [...coins] })).catch(() => {});
    meta.error = null; delete state.errors["Binance asset info"];
  } catch (e) {
    meta.nextTry = Date.now() + 15 * 60_000;
    if (!meta.loaded) {
      try { const c = JSON.parse(await readFile(META_FILE, "utf8")); setMeta(new Map(c.coins), "cached", c.at); }
      catch { setMeta(null, "built-in", Date.now()); }
    }
    meta.error = e.message;
    state.errors["Binance asset info"] = `${e.message}; ` + (meta.source.startsWith("cached") ? `using the saved copy from ${new Date(meta.at).toISOString().slice(0, 10)}`
      : meta.source === "built-in" ? "ranking by 24h volume and using the built-in narrative lists (retrying every 15 min)" : "using the last good copy");
  }
}
// The first scan waits for one request; later refreshes run in the background.
async function ensureMeta() {
  if (!meta.loaded) await refreshMeta();
  else if (meta.source !== "live" || Date.now() - meta.at > META_REFRESH_MS) refreshMeta();
}
const metaStatus = () => ({ source: meta.source, at: meta.at || null, coins: meta.coins.size, sectors: meta.narratives.size, error: meta.error });
const marketCap = (base, price) => { const cs = meta.coins.get(base)?.cs; return cs && price > 0 ? cs * price : null; };

// Universe: Binance USDT pairs, largest market cap first (coins without supply data after them, by 24h volume).
function buildUniverse(tickers) {
  const rows = [...tickers].map(([base, tk]) => {
    const m = meta.coins.get(base);
    return { base, vol: n(tk.quoteVolume) || 0, info: { id: base, name: m?.name || base, mc: marketCap(base, n(tk.lastPrice)), fdv: null, rank: null, tags: m?.tags || [] } };
  });
  rows.sort((a, b) => (a.info.mc == null) - (b.info.mc == null) || (b.info.mc ?? 0) - (a.info.mc ?? 0) || b.vol - a.vol);
  let rank = 0;
  for (const r of rows) if (r.info.mc != null) r.info.rank = ++rank;
  return rows.slice(0, TOP_N).map((r) => [r.base, r.info]);
}

// Hot narratives, every scan, from data already fetched: median 24h change of each sector's liquid coins.
function hotNarratives(tickers) {
  const hot = [];
  for (const [name, g] of meta.narratives) {
    const chg = [...g.bases].map((b) => tickers.get(b)).filter((tk) => tk && (n(tk.quoteVolume) || 0) >= 1_000_000)
      .map((tk) => n(tk.priceChangePercent)).filter((v) => v != null);
    if (chg.length < 5) continue;
    const med = median(chg);
    if (med >= HOT_CATEGORY_MIN_CHANGE) hot.push({ name, med, bases: g.bases });
  }
  hot.sort((a, b) => b.med - a.med);
  const mapping = new Map();
  for (const { name, med, bases } of hot.slice(0, MAX_HOT_CATEGORIES)) {
    for (const b of bases) {
      const prev = mapping.get(b) || { change: -Infinity, names: [] };
      mapping.set(b, { change: Math.max(prev.change, med), names: [...prev.names, name] });
    }
  }
  state.hotNarratives = hot.slice(0, MAX_HOT_CATEGORIES).map(({ name, med }) => ({ id: name, name, change24hPct: round(med, 2) }));
  return mapping;
}

// Narratives for the rotation tab: [{ name, category, coins: [bases, largest market cap first] }].
export async function binanceNarratives(priceByBase) {
  await ensureMeta();
  const mc = (b) => marketCap(b, priceByBase.get(b)) ?? 0;
  return [...meta.narratives].map(([name, g]) => ({
    name, category: g.tags.has("built-in") ? "built-in list" : "Binance tag: " + [...g.tags].join(", "),
    coins: [...g.bases].filter((b) => priceByBase.has(b)).sort((a, b) => mc(b) - mc(a)),
  })).filter((x) => x.coins.length >= 3).sort((a, b) => b.coins.length - a.coins.length);
}

// ───────────────────────────── data: Binance ─────────────────────────────
async function binanceTickers() {
  const data = await fetchJson(`${BN}/api/v3/ticker/24hr`, { timeoutMs: 15_000 });
  if (!Array.isArray(data)) throw new Error("Unexpected 24h ticker response");
  const out = new Map();
  for (const t of data) {
    const s = t.symbol || "";
    if (s.endsWith("USDT") && !/(UP|DOWN|BULL|BEAR)USDT$/.test(s)) out.set(s.slice(0, -4), t);
  }
  return out;
}

async function loadDaily(base) {
  const k = await fetchJson(`${BN}/api/v3/klines?symbol=${encodeURIComponent(base)}USDT&interval=1d&limit=40`);
  if (!Array.isArray(k) || k.length < 30) throw new Error("Not enough daily candles");
  const closed = k.slice(0, -1); // drop the unfinished current day
  return {
    at: Date.now(), day: Math.floor(Date.now() / DAY_MS),
    closes: closed.map((x) => Number(x[4])), highs: closed.map((x) => Number(x[2])), lows: closed.map((x) => Number(x[3])),
    qvols: closed.map((x) => Number(x[7])),
  };
}
const dailyStale = (d) => !d || Date.now() - d.at > KLINE_REFRESH_MS || d.day !== Math.floor(Date.now() / DAY_MS);
// A coin near $1 that stayed within 3% for 20 days is a stablecoin, whatever its name.
const looksPegged = (d, price) => {
  if (!d?.lows || !(price > 0.97 && price < 1.03)) return false;
  const hi = Math.max(...d.highs.slice(-20)), lo = Math.min(...d.lows.slice(-20));
  return lo > 0 && hi / lo - 1 < 0.03;
};

// Daily candles load in the background (stale data stays usable), so they never block the fast scan.
function kickDaily(eligible) {
  if (dailyBusy) return;
  const now = Date.now();
  const need = eligible.filter(([b]) => dailyStale(dailyCache.get(b)) && now >= (dailyRetryAt.get(b) || 0));
  if (!need.length) return;
  dailyBusy = true;
  (async () => {
    let failed = 0;
    await mapLimit(need, 6, async ([b]) => {
      try { dailyCache.set(b, await loadDaily(b)); dailyRetryAt.delete(b); }
      catch { failed++; dailyRetryAt.set(b, Date.now() + 10 * 60_000); }
    });
    if (failed) state.errors["Some candles"] = `${failed}/${need.length} symbols failed to load daily candles; retrying in 10 min`;
    else delete state.errors["Some candles"];
  })().finally(() => { dailyBusy = false; });
}

// Time-of-day baseline + typical 6h range from the last 14 days of hourly candles.
async function loadHourly(base) {
  const k = await fetchJson(`${BN}/api/v3/klines?symbol=${encodeURIComponent(base)}USDT&interval=1h&limit=336`);
  if (!Array.isArray(k) || k.length < 121) throw new Error("Not enough hourly candles");
  const closed = k.slice(0, -1);
  const prof = hourlyProfile({
    t: closed.map((c) => Number(c[0])), high: closed.map((c) => Number(c[2])), low: closed.map((c) => Number(c[3])), qv: closed.map((c) => Number(c[7])),
  });
  if (!prof) throw new Error("Not enough hourly candles");
  return { at: Date.now(), ...prof };
}
function kickHourly(eligible) {
  if (hourlyBusy) return;
  const now = Date.now();
  const need = eligible.filter(([b]) => (!hourlyCache.has(b) || now - hourlyCache.get(b).at > HOURLY_REFRESH_MS) && now >= (hourlyRetryAt.get(b) || 0));
  if (!need.length) return;
  hourlyBusy = true;
  mapLimit(need, 6, async ([b]) => {
    try { hourlyCache.set(b, await loadHourly(b)); hourlyRetryAt.delete(b); }
    catch { hourlyRetryAt.set(b, Date.now() + 30 * 60_000); } // new listings: no ignition until 5+ days of hourly history
  }).finally(() => { hourlyBusy = false; });
}
// Expected traded volume (USDT) over the `minutes` ending at endMs, from the token's own hour-of-day medians.
export function expectedQuoteVolume(h, minutes, endMs = Date.now()) {
  const steps = Math.max(1, Math.round(minutes)), per = minutes / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) sum += (h.hours[new Date(endMs - (i + 0.5) * per * 60_000).getUTCHours()] * per) / 60;
  return sum;
}

async function fundingRates() {
  if (Date.now() - fundingCache.at < 60_000) return fundingCache.map;
  try {
    const rows = await fetchJson(`${BF}/fapi/v1/premiumIndex`, { retries: 1 });
    const out = new Map();
    for (const x of rows) if (String(x.symbol).endsWith("USDT")) out.set(x.symbol.slice(0, -4), Number(x.lastFundingRate));
    fundingCache = { at: Date.now(), map: out };
    state.futuresStatus = "connected";
    delete state.errors["Binance Futures"];
    return out;
  } catch (e) {
    state.futuresStatus = "unavailable";
    state.errors["Binance Futures"] = `${e.message}; futures scoring treated as neutral`;
    fundingCache = { at: Date.now() - 30_000, map: fundingCache.map }; // retry in ~30s
    return fundingCache.map;
  }
}

async function oiChange24h(base) {
  const hit = oiCache.get(base);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  let v = null;
  try {
    const h = await fetchJson(`${BF}/futures/data/openInterestHist?symbol=${encodeURIComponent(base)}USDT&period=1h&limit=24`, { retries: 0 });
    const first = Number(h[0].sumOpenInterestValue), last = Number(h[h.length - 1].sumOpenInterestValue);
    v = first ? last / first - 1 : null;
  } catch { /* leave null */ }
  oiCache.set(base, { at: Date.now(), v });
  return v;
}

// ───────────────────────────── fast layer ─────────────────────────────
// Rolling-window ticker (GET /api/v3/ticker?windowSize=15m): real 15-minute volume and price change for up to
// 100 symbols per request, so the whole universe costs only a few requests per scan.
async function windowTickers(symbols, windowSize) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 100) chunks.push(symbols.slice(i, i + 100));
  const results = await Promise.all(chunks.map((chunk) =>
    fetchJson(`${BN}/api/v3/ticker?windowSize=${windowSize}&symbols=${encodeURIComponent(JSON.stringify(chunk))}`, { retries: 1 })
      .catch((e) => ({ _error: e.message }))));
  let err = null;
  for (const r of results) {
    if (Array.isArray(r)) for (const t of r) out.set(t.symbol, t);
    else err = r._error;
  }
  return { map: out, error: err };
}

// Best bid/ask spread in basis points for every USDT pair (one request).
async function bookSpreads() {
  if (Date.now() - bookCache.at < 15_000) return bookCache.map;
  try {
    const rows = await fetchJson(`${BN}/api/v3/ticker/bookTicker`, { retries: 0 });
    const map = new Map();
    for (const r of rows) {
      if (!String(r.symbol).endsWith("USDT")) continue;
      const bid = Number(r.bidPrice), ask = Number(r.askPrice);
      if (bid > 0 && ask > 0) map.set(r.symbol.slice(0, -4), ((ask - bid) / ((ask + bid) / 2)) * 1e4);
    }
    bookCache = { at: Date.now(), map };
    delete state.errors.Spreads;
  } catch (e) {
    state.errors.Spreads = `${e.message}; spread filter skipped`;
    bookCache = { at: Date.now() - 5_000, map: bookCache.map };
  }
  return bookCache.map;
}

export const columns5m = (raw) => ({
  t: raw.map((c) => Number(c[0])), open: raw.map((c) => Number(c[1])), high: raw.map((c) => Number(c[2])), low: raw.map((c) => Number(c[3])),
  close: raw.map((c) => Number(c[4])), qv: raw.map((c) => Number(c[7])), trades: raw.map((c) => Number(c[8])), buy: raw.map((c) => Number(c[10])),
});

// 5-minute candle confirmation for the strongest few (last 24h of 5m candles: buyers, persistence, trades, trend, 12h high).
async function analyze5m(base, f) {
  try {
    const raw = await fetchJson(`${BN}/api/v3/klines?symbol=${encodeURIComponent(base)}USDT&interval=5m&limit=289`, { retries: 0 });
    if (!Array.isArray(raw) || raw.length < 12) return;
    const expect5 = (endMs) => (f.hourly ? expectedQuoteVolume(f.hourly, 5, endMs) : f.avgDaily / 288);
    const feats = fiveMinFeatures(columns5m(raw), raw.length - 1, Date.now(), expect5);
    if (feats) Object.assign(f, feats);
  } catch { /* leave unconfirmed: the token stays "heating", never "ignited" */ }
}

// Returns Map(base -> metrics). "Normal" volume = that token's median for this hour of the day (14 days), falling back
// to its 20-day average only until hourly history has loaded.
async function fastLayer(ready) {
  const out = new Map();
  state.universe.slow = 0;
  if (binanceWeight > WEIGHT_GUARD) {
    state.errors["Rate guard"] = `Binance used-weight is ${binanceWeight}/min; fast scan skipped this cycle to avoid a ban`;
    return out;
  }
  delete state.errors["Rate guard"];
  const [w15, spreads] = await Promise.all([windowTickers(ready.map(([b]) => b + "USDT"), "15m"), bookSpreads()]);
  if (w15.error) state.errors["15m windows"] = w15.error; else delete state.errors["15m windows"];
  let seasonal = 0, slow = 0;
  const slowBelow = MIN_RANGE_RATIO * TARGET_PCT;
  for (const [base, info] of ready) {
    const w = w15.map.get(base + "USDT");
    const d = dailyCache.get(base);
    const avgDaily = d ? mean(d.qvols.slice(-20)) : 0;
    if (!w || !(avgDaily > 0)) continue;
    const hourly = hourlyCache.get(base) || null;
    if (hourly) seasonal++;
    if (hourly?.range6h != null && hourly.range6h < slowBelow) slow++;
    const exp15 = hourly ? expectedQuoteVolume(hourly, 15.5) : avgDaily / 96;
    out.set(base, {
      avgDaily, hourly, seasonal: !!hourly, rvol15: exp15 > 0 ? Number(w.quoteVolume) / exp15 : 0,
      ret15: Number(w.priceChangePercent), spreadBps: spreads.get(base) ?? null, range6h: hourly?.range6h ?? null,
      monitoring: !ALLOW_MONITORING && isMonitoring(info),
    });
  }
  state.warmup.seasonal = seasonal;
  state.universe.slow = slow;
  // Market-wide check: if many tokens surge together, it is a market move, not a token-specific ignition.
  const hotShare = out.size ? [...out.values()].filter((f) => f.rvol15 >= 2).length / out.size : 0;
  const marketWide = hotShare >= MARKET_WIDE_SHARE;
  state.breadth = { hotShare: round(hotShare, 3), marketWide };
  const btc15 = out.get("BTC")?.ret15 ?? 0;
  const regimeOff = REGIME_GATE && rotation?.riskOff() ? rotation.regimeLabel() : null;
  for (const f of out.values()) { f.marketWide = marketWide; f.rs15 = f.ret15 - btc15; f.regimeOff = regimeOff; }

  const heating = [...out.entries()].filter(([, f]) => f.rvol15 >= 2 && !(f.range6h != null && f.range6h < slowBelow))
    .sort((a, b) => b[1].rvol15 - a[1].rvol15).slice(0, 60);
  if (heating.length) {
    const w1h = await windowTickers([...new Set([...heating.map(([b]) => b + "USDT"), "BTCUSDT"])], "1h");
    const btc1h = n(w1h.map.get("BTCUSDT")?.priceChangePercent);
    state.regime.btc1hPct = round(btc1h, 2);
    for (const [base, f] of heating) {
      f.btc1h = btc1h;
      const w = w1h.map.get(base + "USDT");
      if (w) {
        const exp1h = f.hourly ? expectedQuoteVolume(f.hourly, 60.5) : f.avgDaily / 24;
        f.rvol1h = exp1h > 0 ? Number(w.quoteVolume) / exp1h : null; f.ret1h = Number(w.priceChangePercent);
      }
    }
    const need = IGNITE_RVOL * (marketWide ? 1.5 : 1);
    const strong = heating.filter(([, f]) => f.rvol15 >= need && f.ret15 >= MIN_RET15 && f.ret15 <= MAX_RET15 && f.range6h != null &&
      (f.spreadBps == null || f.spreadBps <= MAX_SPREAD_BPS)).slice(0, 8);
    await mapLimit(strong, 4, async ([base, f]) => { await analyze5m(base, f); });
  }
  return out;
}

// ───────────────────────────── alerts + outcomes ─────────────────────────────
async function sendTelegram(text) {
  try {
    await fetchJson(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, retries: 1,
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    delete state.errors.Telegram;
  } catch (e) { state.errors.Telegram = e.message; }
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    writeFile(STATE_FILE, JSON.stringify({ lastAlertAt: Object.fromEntries(lastAlertAt), events: state.events })).catch(() => {});
  }, 500);
}
// Alerts saved while the process was down get a best-effort outcome from their recorded high/low.
function resolveLegacy(e) {
  const t = e.track;
  if (!t || t.outcome || !t.entry || Date.now() - e.time < OUTCOME_MS) return;
  const hi = t.hiW ?? t.high, lo = t.loW ?? t.low;
  const up = (hi / t.entry - 1) * 100, dn = (lo / t.entry - 1) * 100;
  t.outcome = up >= TARGET_PCT && dn > -STOP_PCT ? "win" : dn <= -STOP_PCT && up < TARGET_PCT ? "loss" : up >= TARGET_PCT && dn <= -STOP_PCT ? "unclear" : "flat";
  t.estimated = true;
}
async function loadPersisted() {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    for (const [k, v] of Object.entries(saved.lastAlertAt || {})) lastAlertAt.set(k, Number(v) || 0);
    if (Array.isArray(saved.events)) { state.events = saved.events.slice(0, MAX_EVENTS); state.events.forEach(resolveLegacy); }
  } catch { /* first run */ }
}

const sgn = (v) => (v == null ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
const rotationLine = (c) => {
  const r = c.rotation;
  if (!r || !r.regimeLabel) return null;
  const top = r.narratives.filter((x) => x.rank != null).slice(0, 2).map((x) => `${x.name} #${x.rank}`).join(", ");
  return `${r.regimeLabel}${top ? `; rotation rank: ${top}` : "; not in a ranked narrative"}`;
};
const structureLine = (c) => [c.breakout === true ? "broke its 12h high" : c.breakout === false ? "inside its 12h range" : null,
  c.trendUp ? "4h trend rising" : null, c.range6h != null ? `typical 6h range ${c.range6h.toFixed(1)}%` : null].filter(Boolean).join(", ");
function updateEvents(results) {
  if (!state.regime.ok) return;
  const now = Date.now();
  const fresh = [];
  const fire = (c, tier, score, message, lines) => {
    fresh.push({
      id: `${tier}:${c.symbol}-${now}`, type: tier, tier, v: LOGIC_VERSION, symbol: c.symbol, score, label: tier === "ignition" ? "Early ignition" : c.label,
      time: now, message, detail: c, track: { entry: c.price, high: c.price, low: c.price, last: c.price, hiW: c.price, loW: c.price },
    });
    lastAlertAt.set(`${tier}:${c.symbol}`, now);
    if (!DEMO && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      sendTelegram(`${tier === "ignition" ? `EARLY IGNITION: ${c.base} (ignition score ${score}/100, daily ${c.score})` : `Setup alert: ${c.base} (score ${score}/100)`}\n` +
        `Moved so far: ${sgn(c.ret15m)} 15m | ${sgn(c.ret1h)} 1h | ${sgn(c.change24h)} 24h\n` +
        lines.map((w) => "- " + w).join("\n") + `\nTracked as: win +${TARGET_PCT}% before -${STOP_PCT}% within ${OUTCOME_MS / 3_600_000}h.` +
        "\nSet entry, stop-loss and target first. Research signal only, not financial advice.");
    }
  };
  // 1) Fast tier: confirmed ignition with a high enough confidence score, price not yet run.
  // Held back briefly at startup until the time-of-day baselines have loaded, so early alerts are not noisy.
  const exclusionsReady = DEMO || meta.loaded;
  const seasonalReady = exclusionsReady && (DEMO || state.warmup.seasonal >= 0.8 * state.warmup.total || now - state.startedAt > 180_000);
  const cd1 = DEMO ? 90_000 : IGNITE_COOLDOWN_MS;
  if (seasonalReady) {
    results.filter((c) => c.ignition === "ignited" && !c.moved && (c.igScore ?? 0) >= IGNITE_MIN_SCORE)
      .sort((a, b) => b.igScore - a.igScore)
      .forEach((c) => {
        if (fresh.length >= MAX_ALERTS_PER_SCAN || now - (lastAlertAt.get(`ignition:${c.symbol}`) || 0) < cd1) return;
        fire(c, "ignition", c.igScore, `${c.base} early ignition (score ${c.igScore}/100)`, [
          `15m volume ${c.rvol15}x normal${c.seasonalBaseline ? " for this hour" : ""}, 1h ${c.rvol1h ?? "n/a"}x`,
          `volume held in ${c.persist}/${c.persistOf} recent 5m candles${c.tradesRatio != null ? `, trades ${c.tradesRatio}x normal` : ""}`,
          `${c.buyRatio15m}% of recent volume was aggressive buying`,
          `price only ${sgn(c.ret15m)} in 15m, ${sgn(c.change24h)} in 24h${c.rangePos != null ? `, ${Math.round(c.rangePos * 100)}% up its 2h range` : ""}`,
          structureLine(c), rotationLine(c),
          ...c.reasons.slice(0, 2)].filter(Boolean));
      });
  }
  // 2) Setup tier (off unless SCREENER_SETUP_ALERTS=1): strong daily context that has NOT already moved.
  if (SETUP_ALERTS) {
    const cd2 = DEMO ? 90_000 : COOLDOWN_MS;
    for (const c of results) { // sorted by score, high to low
      if (c.score < MIN_SCORE_ALERT) break;
      if (c.moved || fresh.length >= MAX_ALERTS_PER_SCAN || fresh.some((f) => f.symbol === c.symbol)) continue;
      if (now - (lastAlertAt.get(`setup:${c.symbol}`) || 0) < cd2) continue;
      fire(c, "setup", c.score, `${c.base} early setup (score ${c.score}/100)`, c.reasons);
    }
  }
  if (fresh.length) {
    state.events = [...fresh, ...state.events].slice(0, MAX_EVENTS);
    persist();
  }
}

// Follows every alert (sampled at each scan). Outcome: win = +TARGET% reached first (exit at the target),
// loss = -STOP% reached first (exit at the sampled price, so slippage past the stop counts), flat = neither within
// OUTCOME_HOURS (exit at the price when the window ends). hiW/loW = best/worst price inside the window.
function updateTracking(priceByBase) {
  const now = Date.now();
  let changed = false;
  for (const e of state.events) {
    const t = e.track;
    if (!t || !e.detail || !t.entry) continue;
    const p = priceByBase.get(e.detail.base), age = now - e.time;
    if (age <= DAY_MS && Number.isFinite(p)) {
      t.last = p; t.high = Math.max(t.high, p); t.low = Math.min(t.low, p); changed = true;
    }
    if (t.outcome) continue;
    if (Number.isFinite(p)) { // the scan that closes the window still counts, so a hit is never labelled "flat"
      t.hiW = Math.max(t.hiW ?? t.entry, p); t.loW = Math.min(t.loW ?? t.entry, p);
      const r = (p / t.entry - 1) * 100;
      if (r >= TARGET_PCT) { t.outcome = "win"; t.exitPct = TARGET_PCT; }
      else if (r <= -STOP_PCT) { t.outcome = "loss"; t.exitPct = round(r, 2); }
    }
    if (!t.outcome && age >= OUTCOME_MS) {
      t.outcome = "flat";
      const lp = Number.isFinite(p) ? p : t.last;
      t.exitPct = round((lp / t.entry - 1) * 100, 2);
    }
    if (t.outcome) { t.outcomeAt = now; changed = true; }
  }
  if (changed) persist();
}

// Result of one resolved alert in %, before fees. Older alerts did not record flat exits, so those count as 0.
const resultOf = (t) => (Number.isFinite(t.exitPct) ? t.exitPct : t.outcome === "win" ? TARGET_PCT : t.outcome === "loss" ? -STOP_PCT : 0);
function summarize(evs) {
  const done = evs.filter((e) => ["win", "loss", "flat"].includes(e.track?.outcome));
  const wins = done.filter((e) => e.track.outcome === "win").length, losses = done.filter((e) => e.track.outcome === "loss").length;
  const tracked = evs.filter((e) => e.track && e.track.entry);
  const gross = done.length ? mean(done.map((e) => resultOf(e.track))) : null;
  return {
    total: evs.length, resolved: done.length, wins, losses, flat: done.length - wins - losses,
    pending: evs.filter((e) => e.track && !e.track.outcome).length, unclear: evs.filter((e) => e.track?.outcome === "unclear").length,
    winRatePct: done.length ? round((wins / done.length) * 100, 1) : null,
    expectancyPct: round(gross, 2),                                    // gross, before fees
    netPct: gross == null ? null : round(gross - FEE_PCT, 2),          // after round-trip fees
    avgPeakPct: tracked.length ? round(mean(tracked.map((e) => ((e.track.hiW ?? e.track.high) / e.track.entry - 1) * 100)), 2) : null,
    avgLowPct: tracked.length ? round(mean(tracked.map((e) => ((e.track.loW ?? e.track.low) / e.track.entry - 1) * 100)), 2) : null,
  };
}
const BUCKETS = [
  ["Ignition score 80+", (c) => c.igScore >= 80], ["Ignition score 65-79", (c) => c.igScore >= 65 && c.igScore < 80],
  ["Broke 12h high", (c) => c.breakout === true], ["Inside 12h range", (c) => c.breakout === false],
  ["Typical 6h range 2x target+", (c) => c.range6h >= 2 * TARGET_PCT], ["Typical 6h range under 2x target", (c) => c.range6h != null && c.range6h < 2 * TARGET_PCT],
  ["Buyers 65%+", (c) => c.buyRatio15m >= 65], ["Buyers under 65%", (c) => c.buyRatio15m < 65],
  ["15m volume 6x+", (c) => c.rvol15 >= 6], ["15m volume under 6x", (c) => c.rvol15 < 6],
  ["Volume held 3/3 candles", (c) => c.persist >= 3], ["Volume held 2/3 candles", (c) => c.persist === 2],
  ["Hot narrative", (c) => !!c.narrative], ["No narrative", (c) => !c.narrative],
  ["Daily setup 55+", (c) => c.score >= 55], ["Daily setup under 55", (c) => c.score < 55],
  ["In a top-3 rotation narrative", (c) => !!c.rotation?.narratives?.some((x) => x.rank != null && x.rank <= 3)],
  ["Not in a top-3 rotation narrative", (c) => !!c.rotation && !c.rotation.narratives.some((x) => x.rank != null && x.rank <= 3)],
  ["BTC regime up or sideways", (c) => !!c.rotation?.regime && !c.rotation.riskOff], ["BTC regime downtrend", (c) => !!c.rotation?.riskOff],
];
function statsBlock(evs) {
  const ig = evs.filter((e) => e.tier === "ignition");
  return {
    overall: summarize(evs), byTier: { ignition: summarize(ig), setup: summarize(evs.filter((e) => e.tier !== "ignition")) },
    buckets: BUCKETS.map(([name, fn]) => {
      const s = summarize(ig.filter((e) => e.detail && fn(e.detail)));
      return { name, resolved: s.resolved, winRatePct: s.winRatePct, expectancyPct: s.expectancyPct, netPct: s.netPct };
    }).filter((b) => b.resolved > 0),
  };
}
function computeStats() {
  const evs = state.events;
  return {
    targetPct: TARGET_PCT, stopPct: STOP_PCT, horizonHours: OUTCOME_MS / 3_600_000, feePct: FEE_PCT, version: LOGIC_VERSION,
    olderCount: evs.filter((e) => e.v !== LOGIC_VERSION).length,
    current: statsBlock(evs.filter((e) => e.v === LOGIC_VERSION)), all: statsBlock(evs),
  };
}

// ───────────────────────────── scan ─────────────────────────────
async function scan() {
  const t0 = Date.now();
  const tickers = await binanceTickers();
  const btc = tickers.get("BTC");
  const btcChg = btc ? Number(btc.priceChangePercent) : 0;
  state.regime = { btcChange24hPct: round(btcChg, 2), btc1hPct: state.regime.btc1hPct ?? null, ok: btcChg > BTC_DROP_PAUSE };

  await ensureMeta();
  const funding = await fundingRates();
  const universe = buildUniverse(tickers);
  const narrativeByBase = hotNarratives(tickers);

  const eligible = [];
  let excluded = 0;
  for (const [base, info] of universe) {
    const tk = tickers.get(base);
    if (!tk || BLOCKLIST.has(base)) continue;
    if ((n(tk.quoteVolume) || 0) < MIN_QUOTE_VOLUME) continue;
    if (STABLES.has(base) || info.tags.some((t) => /stable/i.test(t)) ||
      (EXCLUDE_NONCRYPTO && !ALLOWLIST.has(base) && (NONCRYPTO.has(base) || info.tags.some((t) => NONCRYPTO_TAG.test(t))))) { excluded++; continue; }
    eligible.push([base, info, tk]);
  }
  kickDaily(eligible);
  kickHourly(eligible);
  const ready = [];
  for (const e of eligible) {
    const d = dailyCache.get(e[0]);
    if (!d) continue;
    if (!ALLOWLIST.has(e[0]) && looksPegged(d, Number(e[2].lastPrice))) { excluded++; continue; }
    ready.push(e);
  }
  state.warmup.loaded = ready.length; state.warmup.total = eligible.length;

  const fast = await fastLayer(ready);

  const pre = [];
  for (const [base, info, tk] of ready) {
    const t = techMetrics(dailyCache.get(base), Number(tk.lastPrice), Number(tk.quoteVolume));
    if (!t) continue;
    const nar = narrativeByBase.get(base) || null;
    const f = fast.get(base);
    pre.push({ base, info, tk, t, nar, f, c: buildCandidate(base, info, tk, t, nar, funding.get(base) ?? null, null, f) });
  }
  pre.sort((a, b) => b.c.score - a.c.score);

  // Add open-interest change for the best candidates only.
  const deep = pre.slice(0, DEEP_SCAN_LIMIT).filter((p) => funding.has(p.base));
  await mapLimit(deep, 4, async (p) => {
    const oi = await oiChange24h(p.base);
    p.c = buildCandidate(p.base, p.info, p.tk, p.t, p.nar, funding.get(p.base), oi, p.f);
  });

  const results = pre.map((p) => p.c).sort((a, b) => b.score - a.score);
  const top = results.slice(0, 150), inTop = new Set(top.map((c) => c.symbol));
  state.candidates = [...top, ...results.filter((c) => c.ignition && !inTop.has(c.symbol))];
  state.universe = { binance: tickers.size, eligible: eligible.length, excluded, slow: state.universe.slow,
    rankedBy: meta.coins.size ? "market cap" : "24h volume", monitoring: ready.filter(([, info]) => isMonitoring(info)).length };
  state.metaStatus = metaStatus();
  state.status = ready.length === 0 && eligible.length ? "warming_up" : "connected";
  delete state.errors["Binance Spot"];
  updateEvents(results);
  const priceByBase = new Map([...tickers].map(([b, tk]) => [b, Number(tk.lastPrice)]));
  updateTracking(priceByBase);
  rotation?.updatePrices(priceByBase);
  state.stats = computeStats();
  state.lastScanMs = Date.now() - t0;
  state.binancePausedUntil = binancePause();
}

// ───────────────────────────── demo mode (DEMO=1) ─────────────────────────────
const DEMO_TOKENS = ["SOL", "SUI", "LINK", "AVAX", "INJ", "RENDER", "FET", "ARB", "OP", "TIA", "SEI", "NEAR", "APT", "DOGE", "PEPE", "ONDO", "JUP", "PYTH", "TAO", "ENA"];
const DEMO_NARR = ["AI", "RWA", "DePIN", "Meme", "Layer 2"];
const demoBook = new Map();
const rnd = (a, b) => a + Math.random() * (b - a);
function demoRoll(i, kind) { // kind: "ignite" | "ran" | "cold"
  const hot = kind !== "cold";
  const names = hot || Math.random() < 0.35 ? [DEMO_NARR[Math.floor(Math.random() * DEMO_NARR.length)]] : null;
  const common = { spreadBps: rnd(1, 9), marketWide: false, seasonal: true, range6h: hot ? rnd(3, 8) : rnd(1.2, 6), btc1h: rnd(-0.3, 0.6) };
  return {
    kind, rank: i + 4,
    rvol: hot ? rnd(2.4, 4) : rnd(0.7, 2.2), dist: kind === "ran" ? rnd(0.1, 0.3) : hot ? rnd(-0.025, 0.05) : rnd(-0.12, 0.06),
    rsi: hot ? rnd(50, 68) : rnd(32, 80), compressed: kind === "ignite" ? Math.random() < 0.6 : Math.random() < 0.2,
    ratio: hot ? rnd(0.6, 1) : rnd(0.15, 1), narrative: names ? { change: hot ? rnd(5, 11) : rnd(3, 7), names } : null,
    funding: Math.random() < 0.85 ? rnd(-0.0002, hot ? 0.0003 : 0.0009) : null, oi: Math.random() < 0.7 ? rnd(-0.05, 0.13) : null,
    vol: rnd(8e6, 2.2e8), price: rnd(0.4, 180),
    chg: kind === "ran" ? rnd(16, 45) : kind === "ignite" ? rnd(0.5, 6) : rnd(-6, 6),
    f: kind === "ignite" ? { ...common, rvol15: rnd(4.2, 9), ret15: rnd(0.4, 3), rvol1h: rnd(1.8, 4), ret1h: rnd(0.8, 5), buy15: rnd(60, 74),
      persist: Math.random() < 0.6 ? 3 : 2, persistOf: 3, tradesRatio: rnd(1.5, 3.2), rangePos: rnd(0.65, 0.97), nearHigh: Math.random() < 0.5, rs15: rnd(0.1, 2),
      trendUp: Math.random() < 0.8, extPct: rnd(0.4, 3), fadePct: rnd(0, 0.8), wickShare: rnd(0.05, 0.45), breakout: Math.random() < 0.6, distTo12hHigh: rnd(-1.5, 1.5) }
      : kind === "ran" ? { ...common, rvol15: rnd(3, 6), ret15: rnd(3.5, 9), rvol1h: rnd(3, 6), ret1h: rnd(9, 20), buy15: rnd(55, 70),
        persist: 3, persistOf: 3, tradesRatio: rnd(2, 4), rangePos: 0.97, nearHigh: true, rs15: rnd(3, 8),
        trendUp: true, extPct: rnd(5, 12), fadePct: rnd(0, 2), wickShare: rnd(0.2, 0.6), breakout: true, distTo12hHigh: rnd(3, 9) }
        : { ...common, rvol15: rnd(2.1, 3.9), ret15: rnd(-1, 1), rvol1h: rnd(0.5, 1.6), ret1h: rnd(-2, 2), buy15: rnd(44, 56) },
  };
}
// Simulated past alerts so the performance panel can be previewed. Demo only; never written to the real state file.
function seedDemoHistory() {
  const now = Date.now(), outcomes = ["win", "win", "loss", "flat", "loss", "flat", "win", "flat", "loss", "win", "flat", "flat"];
  const seed = outcomes.map((o, i) => {
    const base = DEMO_TOKENS[(i * 3) % DEMO_TOKENS.length], d = demoRoll(i, "ignite");
    const t = { rvol: d.rvol, distToHigh: d.dist, aboveSma: true, rsi: d.rsi, compressed: d.compressed };
    const c = buildCandidate(base, { name: base, rank: d.rank, mc: 1e9, fdv: 1e9 / d.ratio }, { quoteVolume: d.vol, priceChangePercent: d.chg, lastPrice: d.price }, t, d.narrative, d.funding, d.oi, d.f);
    const entry = d.price, up = o === "win" ? 1 + rnd(0.045, 0.09) : 1 + rnd(0.004, 0.025), dn = o === "loss" ? 1 - rnd(0.026, 0.04) : 1 - rnd(0.003, 0.02);
    const exitPct = o === "win" ? TARGET_PCT : o === "loss" ? -round(rnd(2.5, 2.9), 2) : round(rnd(-1.5, 1.5), 2);
    return { id: `ignition:${base}USDT-seed${i}`, type: "ignition", tier: "ignition", v: LOGIC_VERSION, symbol: base + "USDT", score: c.igScore ?? 70, label: "Early ignition",
      time: now - (7 + i * 1.1) * 3_600_000, message: "simulated", detail: c,
      track: { entry, high: entry * up, low: entry * dn, hiW: entry * up, loW: entry * dn, last: entry * (o === "win" ? up * 0.99 : dn * 1.01), outcome: o, exitPct } };
  });
  state.events = seed;
}
function demoScan() {
  DEMO_TOKENS.forEach((base, i) => {
    if (!demoBook.has(base) || Math.random() < 0.1) {
      const r = Math.random();
      demoBook.set(base, demoRoll(i, r < 0.2 ? "ignite" : r < 0.3 ? "ran" : "cold"));
    }
  });
  const results = DEMO_TOKENS.map((base) => {
    const d = demoBook.get(base);
    d.rvol *= rnd(0.97, 1.03); d.dist += rnd(-0.004, 0.004); d.price *= 1 + rnd(-0.002, 0.003);
    const t = { rvol: d.rvol, distToHigh: d.dist, aboveSma: d.dist > -0.06, rsi: d.rsi, compressed: d.compressed };
    const tk = { quoteVolume: d.vol, priceChangePercent: d.chg, lastPrice: d.price };
    return buildCandidate(base, { name: base, rank: d.rank, mc: 1e9, fdv: 1e9 / d.ratio }, tk, t, d.narrative, d.funding, d.oi, d.f);
  }).sort((a, b) => b.score - a.score);
  state.regime = { btcChange24hPct: round(rnd(-1.5, 2.5), 2), btc1hPct: round(rnd(-0.3, 0.5), 2), ok: true };
  state.status = "demo"; state.metaStatus = { source: "demo", coins: 380, sectors: 18 }; state.futuresStatus = "demo";
  state.hotNarratives = DEMO_NARR.slice(0, 3).map((name) => ({ id: name, name, change24hPct: round(rnd(4, 11), 2) }));
  state.universe = { binance: 380, eligible: results.length, excluded: 14, slow: results.filter((c) => c.slow).length, rankedBy: "market cap", monitoring: 2 };
  state.warmup = { loaded: results.length, total: results.length, seasonal: results.length };
  state.breadth = { hotShare: 0.12, marketWide: false };
  state.candidates = results;
  updateEvents(results);
  updateTracking(new Map(results.map((c) => [c.base, c.price])));
  state.stats = computeStats();
}

// ───────────────────────────── poll + server ─────────────────────────────
async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (DEMO) demoScan();
    else {
      try { await scan(); }
      catch (e) { state.status = "error"; state.errors["Binance Spot"] = e.message; state.binancePausedUntil = binancePause(); }
    }
    state.lastUpdated = Date.now();
  } finally { polling = false; }
}

const jsonResponse = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "same-origin" });
  res.end(JSON.stringify(data));
};

if (!LIBRARY_ONLY) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/screener") return jsonResponse(res, 200, { ...state, events: state.events.slice(0, 60) });
    if (url.pathname === "/api/rotation") return jsonResponse(res, 200, { ...rotation.api(), binancePausedUntil: binancePause() });
    if (url.pathname === "/") {
      try {
        const html = await readFile(path.join(here, "public", "screener.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(html);
      } catch { res.writeHead(500).end("public/screener.html is missing"); return; }
    }
    if (url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  });
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE"
      ? `Early Setup Screener: port ${PORT} is in use. Set SCREENER_PORT to another port.`
      : `Early Setup Screener server error: ${e.message}`);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Early Setup Screener v${LOGIC_VERSION}: http://${HOST}:${PORT}`);
    console.log(`Refresh: ${POLL_MS / 1000}s | ignition: 15m vol >= ${IGNITE_RVOL}x (time-of-day adjusted), score >= ${IGNITE_MIN_SCORE}, ` +
      `typical 6h range >= ${(MIN_RANGE_RATIO * TARGET_PCT).toFixed(1)}%, BTC 1h >= ${BTC_1H_MIN}% | setup alerts: ${SETUP_ALERTS ? "on" : "off"} | ` +
      `top ${TOP_N} | demo: ${DEMO} | telegram: ${state.telegramConfigured}`);
    console.log(`BTC rotation tab: http://${HOST}:${PORT}/#rotation (history loads in the background) | regime gate: ${REGIME_GATE ? "on" : "off"} | data: Binance only, no API key`);
  });
  loadPersisted().finally(() => { if (DEMO && !state.events.length) seedDemoHistory(); poll(); setInterval(poll, POLL_MS); });
  rotation.start();
}
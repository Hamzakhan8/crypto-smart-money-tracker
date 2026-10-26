// Early-Setup Screener v2 (port of screener.py + fast intraday layer). Node.js 18+, no dependencies.
//
// Two layers:
//   SETUP layer (slow context): Binance USDT spot tokens that are also in the CoinGecko top 500, scored 0-100 on
//     volume (25) · chart setup (25) · hot narrative (20) · MC/FDV (10) · futures (10) · liquidity (10).
//   IGNITION layer (fast, every ~20s): 15-minute volume vs that token's normal 15-minute volume, confirmed by 1h
//     volume and taker-buy pressure, while price has NOT run yet. This is what catches moves early.
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

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
const HOST = env.SCREENER_HOST || env.HOST || "127.0.0.1";
const PORT = num("SCREENER_PORT", 3001);
const DEMO = env.DEMO === "1";
const POLL_MS = Math.max(10, num("SCREENER_POLL_SECONDS", 20)) * 1000;
const TOP_N = Math.min(1000, Math.max(50, num("SCREENER_TOP_N", 500)));
const MIN_QUOTE_VOLUME = num("SCREENER_MIN_QUOTE_VOLUME", 5_000_000);
const MIN_SCORE_ALERT = num("SCREENER_MIN_SCORE", 40);
const COOLDOWN_MS = num("SCREENER_COOLDOWN_HOURS", 12) * 3_600_000;
const CG_REFRESH_MS = num("SCREENER_CG_REFRESH_MIN", 10) * 60_000;
// ---- early-ignition tuning (all adjustable) ----
const IGNITE_RVOL = num("SCREENER_IGNITE_RVOL", 4);            // 15m volume vs normal 15m volume
const IGNITE_RVOL_1H = num("SCREENER_IGNITE_RVOL_1H", 1.5);    // 1h volume vs normal 1h volume (sustained, not one print)
const MIN_RET15 = num("SCREENER_MIN_MOVE_15M", 0.2);           // % price must have started turning up
const MAX_RET15 = num("SCREENER_MAX_MOVE_15M", 4);             // % above this in 15m = already running
const MAX_RET1H = num("SCREENER_MAX_MOVE_1H", 8);              // % above this in 1h = already moved
const MAX_MOVED_24H = num("SCREENER_MAX_MOVE_24H", 12);        // % above this in 24h = already moved
const MIN_BUY_RATIO = num("SCREENER_MIN_BUY_RATIO", 58);       // % of 15m volume that was aggressive buying
const IGNITE_MIN_CONTEXT = num("SCREENER_IGNITE_MIN_CONTEXT", 35); // minimum daily setup score for context
const IGNITE_COOLDOWN_MS = num("SCREENER_IGNITE_COOLDOWN_HOURS", 4) * 3_600_000;
const MOVED_SCORE_CAP = 55;
const WEIGHT_GUARD = num("SCREENER_WEIGHT_GUARD", 4800);       // skip the fast scan if Binance used-weight per minute gets this high
const DEEP_SCAN_LIMIT = 40;
const MAX_ALERTS_PER_SCAN = 4;
const HOT_CATEGORY_MIN_CHANGE = 3.0;
const MAX_HOT_CATEGORIES = 8;
const BTC_DROP_PAUSE = -3.0;
const FALLBACK_UNIVERSE = 150; // used only if CoinGecko is unreachable
const BLOCKLIST = new Set((env.SCREENER_BLOCKLIST || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
const STABLES = new Set(["USDT", "USDC", "FDUSD", "TUSD", "DAI", "USDE", "USDD", "PYUSD", "USD1", "BUSD", "USDP", "EUR", "AEUR"]);
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;
const CG = "https://api.coingecko.com/api/v3";
const BN = "https://api.binance.com";
const BF = "https://fapi.binance.com";
const cgHeaders = env.COINGECKO_KEY ? { "x-cg-demo-api-key": env.COINGECKO_KEY } : {};
const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, "screener_state.json");
const KLINE_REFRESH_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

const state = {
  startedAt: Date.now(),
  lastUpdated: null,
  lastScanMs: null,
  pollIntervalMs: POLL_MS,
  demo: DEMO,
  status: "starting",
  cgStatus: "not_checked",
  futuresStatus: "not_checked",
  errors: {},
  regime: { btcChange24hPct: null, ok: true },
  universe: { coingecko: 0, binance: 0, eligible: 0 },
  warmup: { loaded: 0, total: 0 },
  hotNarratives: [],
  candidates: [],
  events: [],
  config: {
    minScore: MIN_SCORE_ALERT, cooldownHours: COOLDOWN_MS / 3_600_000, minQuoteVolume: MIN_QUOTE_VOLUME, topN: TOP_N,
    btcDropPausePct: BTC_DROP_PAUSE, igniteRvol: IGNITE_RVOL, igniteRvol1h: IGNITE_RVOL_1H, minBuyRatio: MIN_BUY_RATIO,
    maxMove15m: MAX_RET15, maxMove1h: MAX_RET1H, maxMove24h: MAX_MOVED_24H, igniteMinContext: IGNITE_MIN_CONTEXT,
    igniteCooldownHours: IGNITE_COOLDOWN_MS / 3_600_000,
  },
  telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
  mainUrl: env.MAIN_URL || `http://${env.HOST || "127.0.0.1"}:${num("PORT", 3000)}`,
};
const lastAlertAt = new Map();
const dailyCache = new Map();   // base -> closed daily candles (refreshed hourly / on UTC day change)
const dailyRetryAt = new Map(); // base -> time before which a failed load is not retried
const oiCache = new Map();
const cg = { nextTry: 0, fetchedAt: 0, bySymbol: new Map(), narratives: new Map() };
let fundingCache = { at: 0, map: new Map() };
let binanceWeight = 0;
let polling = false, cgBusy = false, dailyBusy = false;

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

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const RETRYABLE = [418, 429, 500, 502, 503, 504];

async function fetchJson(url, { headers = {}, method = "GET", body, timeoutMs = 12_000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method, body, signal: ctrl.signal,
        headers: { "user-agent": "EarlySetupScreener/2.0", accept: "application/json", ...headers },
      });
      if (String(url).startsWith(BN) && typeof res.headers?.get === "function") {
        const w = Number(res.headers.get("x-mbx-used-weight-1m"));
        if (Number.isFinite(w) && w > 0) binanceWeight = w;
      }
      if (res.ok) return await res.json();
      const hint = res.status === 403 || res.status === 451 ? " (access blocked in this region)"
        : res.status === 429 || res.status === 418 ? " (rate limited)" : "";
      lastErr = new HttpError(`HTTP ${res.status}${hint}`, res.status);
      if (!RETRYABLE.includes(res.status)) throw lastErr;
    } catch (e) {
      if (e instanceof HttpError && !RETRYABLE.includes(e.status)) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(1500 * (attempt + 1) * (lastErr?.status === 429 ? 4 : 1));
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
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

// ───────────────────────────── scoring ─────────────────────────────
// t = techMetrics; cgRow = {mc, fdv}; narrative = {change, names}; funding = per-8h rate (0.0001 = 0.01%).
export function scoreToken(t, cgRow, narrative, funding, oiChg, quoteVol, priceChg) {
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
    reasons.push(`hot narrative: ${names} (${narrative.change >= 0 ? "+" : ""}${narrative.change.toFixed(1)}% 24h)`);
  }

  const fdv = cgRow?.fdv, mc = cgRow?.mc || 0;
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

// f = {rvol15, ret15, rvol1h?, ret1h?, buy15?} (fast layer) or undefined.
// moved: the token has already run (hide / never alert). state: ignited | heating | ran | null.
export function classifyIgnition(f, change24h, distToHigh = 0) {
  const movedWhy = [];
  if (change24h > MAX_MOVED_24H) movedWhy.push(`+${change24h.toFixed(1)}% in 24h`);
  if (distToHigh > 0.08) movedWhy.push(`${Math.round(distToHigh * 100)}% above its 20d high`);
  if (f && f.ret1h != null && f.ret1h > MAX_RET1H) movedWhy.push(`+${f.ret1h.toFixed(1)}% in 1h`);
  if (f && f.ret15 > MAX_RET15) movedWhy.push(`+${f.ret15.toFixed(1)}% in 15m`);
  const moved = movedWhy.length > 0;
  if (!f) return { state: null, moved, movedWhy };
  const hot = f.rvol15 >= 2;
  let st = null;
  if (hot && moved) st = "ran";
  else if (f.rvol15 >= IGNITE_RVOL && f.ret15 >= MIN_RET15 && (f.rvol1h ?? 0) >= IGNITE_RVOL_1H &&
    f.buy15 != null && f.buy15 >= MIN_BUY_RATIO) st = "ignited";
  else if (hot) st = "heating";
  return { state: st, moved, movedWhy };
}
const labelFor = (score) => score >= MIN_SCORE_ALERT ? "Early setup" : score >= 40 ? "Watch closely" : score >= 40 ? "Developing" : "Weak";

function buildCandidate(base, cgRow, tk, t, narrative, funding, oiChg, fast) {
  const quoteVol = n(tk.quoteVolume) || 0;
  const priceChg = n(tk.priceChangePercent) || 0;
  const s = scoreToken(t, cgRow, narrative, funding, oiChg, quoteVol, priceChg);
  const ig = classifyIgnition(fast, priceChg, t.distToHigh);
  let score = s.score, label = labelFor(score);
  if (ig.moved) { score = Math.min(score, MOVED_SCORE_CAP); label = "Already moved"; }
  return {
    symbol: base + "USDT", base, name: cgRow?.name || base, rank: cgRow?.rank ?? null,
    price: n(tk.lastPrice), change24h: priceChg, quoteVolume: quoteVol,
    rvol: round(t.rvol, 2), distToHigh: round(t.distToHigh, 4), aboveSma: t.aboveSma,
    rsi: round(t.rsi, 1), compressed: t.compressed,
    mcFdv: cgRow?.fdv && cgRow?.mc ? round(cgRow.mc / cgRow.fdv, 3) : null,
    narrative: narrative ? { change24hPct: round(narrative.change, 2), names: [...new Set(narrative.names)] } : null,
    fundingPct: funding == null ? null : round(funding * 100, 4),
    oiChange24hPct: oiChg == null ? null : round(oiChg * 100, 2),
    // fast layer
    rvol15: round(fast?.rvol15, 2), rvol1h: round(fast?.rvol1h, 2), ret15m: round(fast?.ret15, 2), ret1h: round(fast?.ret1h, 2),
    buyRatio15m: round(fast?.buy15, 1), ignition: ig.state, moved: ig.moved, movedWhy: ig.movedWhy,
    score, label, reasons: s.reasons, parts: s.parts, updatedAt: Date.now(),
  };
}

// ───────────────────────────── data: CoinGecko ─────────────────────────────
async function cgTopMarkets(limit) {
  const rows = [];
  for (let page = 1; page <= Math.ceil(limit / 250); page++) {
    const r = await fetchJson(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`, { headers: cgHeaders });
    if (!Array.isArray(r)) throw new Error("Unexpected CoinGecko markets response");
    rows.push(...r);
    await sleep(2000);
  }
  return rows.slice(0, limit);
}

async function cgHotNarratives() {
  const cats = await fetchJson(`${CG}/coins/categories`, { headers: cgHeaders });
  if (!Array.isArray(cats)) throw new Error("Unexpected CoinGecko categories response");
  const hot = cats
    .filter((c) => (c.market_cap_change_24h || 0) >= HOT_CATEGORY_MIN_CHANGE && (c.volume_24h || 0) > 50_000_000)
    .sort((a, b) => b.market_cap_change_24h - a.market_cap_change_24h)
    .slice(0, MAX_HOT_CATEGORIES);
  const mapping = new Map();
  for (const c of hot) {
    await sleep(2000);
    try {
      const rows = await fetchJson(
        `${CG}/coins/markets?vs_currency=usd&category=${encodeURIComponent(c.id)}&order=market_cap_desc&per_page=250&page=1`,
        { headers: cgHeaders });
      for (const r of rows) {
        const prev = mapping.get(r.id) || { change: 0, names: [] };
        mapping.set(r.id, { change: Math.max(prev.change, c.market_cap_change_24h), names: [...prev.names, c.name] });
      }
    } catch { /* one category failing should not drop the rest */ }
  }
  return { mapping, list: hot.map((c) => ({ id: c.id, name: c.name, change24hPct: round(c.market_cap_change_24h, 2) })) };
}

// CoinGecko data changes slowly, so it is cached; a failure keeps the previous data.
async function refreshCoinGecko() {
  try {
    const markets = await cgTopMarkets(TOP_N);
    const bySymbol = new Map();
    for (const m of markets) { // largest market cap wins when symbols collide
      const sym = String(m.symbol || "").toUpperCase();
      if (sym && !bySymbol.has(sym)) {
        bySymbol.set(sym, { id: m.id, name: m.name, rank: m.market_cap_rank, mc: n(m.market_cap), fdv: n(m.fully_diluted_valuation) });
      }
    }
    cg.bySymbol = bySymbol;
    cg.fetchedAt = Date.now();
    state.cgStatus = "connected";
    delete state.errors.CoinGecko;
    try {
      const nar = await cgHotNarratives();
      cg.narratives = nar.mapping;
      state.hotNarratives = nar.list;
      delete state.errors.Narratives;
    } catch (e) { state.errors.Narratives = `${e.message}; using previous narrative data`; }
  } catch (e) {
    cg.nextTry = Date.now() + 2 * 60_000;
    state.cgStatus = cg.bySymbol.size ? "stale" : "unavailable";
    state.errors.CoinGecko = cg.bySymbol.size ? `${e.message}; using cached data` : `${e.message}; ranking by Binance volume only (no rank, FDV or narrative data)`;
  }
}
// First run waits for CoinGecko once; afterwards it refreshes in the background so scans are never blocked by it.
async function ensureCoinGecko() {
  const now = Date.now();
  if (now < cg.nextTry || cgBusy) return;
  if (cg.fetchedAt && now - cg.fetchedAt < CG_REFRESH_MS) return;
  cgBusy = true;
  const job = refreshCoinGecko().finally(() => { cgBusy = false; });
  if (!cg.fetchedAt) await job;
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
    closes: closed.map((x) => Number(x[4])), highs: closed.map((x) => Number(x[2])), qvols: closed.map((x) => Number(x[7])),
  };
}
const dailyStale = (d) => !d || Date.now() - d.at > KLINE_REFRESH_MS || d.day !== Math.floor(Date.now() / DAY_MS);

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

// Share of the last ~15 minutes of volume that was aggressive buying (taker buy), from 5-minute candles.
async function takerBuyRatio(base) {
  try {
    const k = await fetchJson(`${BN}/api/v3/klines?symbol=${encodeURIComponent(base)}USDT&interval=5m&limit=3`, { retries: 0 });
    let total = 0, buy = 0;
    for (const c of k) { total += Number(c[7]); buy += Number(c[10]); }
    return total > 0 ? (buy / total) * 100 : null;
  } catch { return null; }
}

// Returns Map(base -> {rvol15, ret15, rvol1h?, ret1h?, buy15?}). "Normal" volume = that token's 20-day average.
async function fastLayer(ready) {
  const out = new Map();
  if (binanceWeight > WEIGHT_GUARD) {
    state.errors["Rate guard"] = `Binance used-weight is ${binanceWeight}/min; fast scan skipped this cycle to avoid a ban`;
    return out;
  }
  delete state.errors["Rate guard"];
  const w15 = await windowTickers(ready.map(([b]) => b + "USDT"), "15m");
  if (w15.error) state.errors["15m windows"] = w15.error; else delete state.errors["15m windows"];
  for (const [base] of ready) {
    const w = w15.map.get(base + "USDT");
    const avgDaily = dailyCache.get(base) ? mean(dailyCache.get(base).qvols.slice(-20)) : 0;
    if (!w || !(avgDaily > 0)) continue;
    out.set(base, { avgDaily, rvol15: Number(w.quoteVolume) / (avgDaily / 96), ret15: Number(w.priceChangePercent) });
  }
  const heating = [...out.entries()].filter(([, f]) => f.rvol15 >= 2).sort((a, b) => b[1].rvol15 - a[1].rvol15).slice(0, 60);
  if (heating.length) {
    const w1h = await windowTickers(heating.map(([b]) => b + "USDT"), "1h");
    for (const [base, f] of heating) {
      const w = w1h.map.get(base + "USDT");
      if (w) { f.rvol1h = Number(w.quoteVolume) / (f.avgDaily / 24); f.ret1h = Number(w.priceChangePercent); }
    }
    const strong = heating.filter(([, f]) => f.rvol15 >= IGNITE_RVOL && f.ret15 >= MIN_RET15 && f.ret15 <= MAX_RET15).slice(0, 8);
    await mapLimit(strong, 4, async ([base, f]) => { f.buy15 = await takerBuyRatio(base); });
  }
  return out;
}

// ───────────────────────────── alerts ─────────────────────────────
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
async function loadPersisted() {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    for (const [k, v] of Object.entries(saved.lastAlertAt || {})) lastAlertAt.set(k, Number(v) || 0);
    if (Array.isArray(saved.events)) state.events = saved.events.slice(0, 200);
  } catch { /* first run */ }
}

const sgn = (v) => (v == null ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
function updateEvents(results) {
  if (!state.regime.ok) return;
  const now = Date.now();
  const fresh = [];
  const fire = (c, tier, message, lines) => {
    fresh.push({
      id: `${tier}:${c.symbol}-${now}`, type: tier, tier, symbol: c.symbol, score: c.score, label: tier === "ignition" ? "Early ignition" : c.label,
      time: now, message, detail: c, track: { entry: c.price, high: c.price, low: c.price, last: c.price },
    });
    lastAlertAt.set(`${tier}:${c.symbol}`, now);
    if (!DEMO && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      sendTelegram(`${tier === "ignition" ? "EARLY IGNITION" : "Setup alert"}: ${c.base} (daily score ${c.score}/100)\n` +
        `Moved so far: ${sgn(c.ret15m)} 15m | ${sgn(c.ret1h)} 1h | ${sgn(c.change24h)} 24h\n` +
        lines.map((w) => "- " + w).join("\n") + "\nSet entry, stop-loss and target first. Research signal only, not financial advice.");
    }
  };
  // 1) Fast tier: volume igniting, buyers in control, price has not run yet.
  const cd1 = DEMO ? 90_000 : IGNITE_COOLDOWN_MS;
  results.filter((c) => c.ignition === "ignited" && !c.moved && c.score >= IGNITE_MIN_CONTEXT)
    .sort((a, b) => b.rvol15 - a.rvol15)
    .forEach((c) => {
      if (fresh.length >= MAX_ALERTS_PER_SCAN || now - (lastAlertAt.get(`ignition:${c.symbol}`) || 0) < cd1) return;
      fire(c, "ignition", `${c.base} early ignition: 15m volume ${c.rvol15}x normal`,
        [`15m volume ${c.rvol15}x normal, 1h ${c.rvol1h ?? "n/a"}x`, `${c.buyRatio15m}% of recent volume was aggressive buying`,
          `price only ${sgn(c.ret15m)} in 15m, ${sgn(c.change24h)} in 24h`, ...c.reasons.slice(0, 2)]);
    });
  // 2) Setup tier: strong daily context that has NOT already moved.
  const cd2 = DEMO ? 90_000 : COOLDOWN_MS;
  for (const c of results) { // sorted by score, high to low
    if (c.score < MIN_SCORE_ALERT) break;
    if (c.moved || fresh.length >= MAX_ALERTS_PER_SCAN || fresh.some((f) => f.symbol === c.symbol)) continue;
    if (now - (lastAlertAt.get(`setup:${c.symbol}`) || 0) < cd2) continue;
    fire(c, "setup", `${c.base} early setup (score ${c.score}/100)`, c.reasons);
  }
  if (fresh.length) {
    state.events = [...fresh, ...state.events].slice(0, 200);
    persist();
  }
}

// Tracks what happened after each alert (sampled at scan intervals) so thresholds can be tuned with real data.
function updateTracking(priceByBase) {
  const now = Date.now();
  let changed = false;
  for (const e of state.events) {
    if (!e.track || !e.detail || now - e.time > DAY_MS) continue;
    const p = priceByBase.get(e.detail.base);
    if (!Number.isFinite(p)) continue;
    e.track.last = p; e.track.high = Math.max(e.track.high, p); e.track.low = Math.min(e.track.low, p);
    changed = true;
  }
  if (changed) persist();
}

// ───────────────────────────── scan ─────────────────────────────
async function scan() {
  const t0 = Date.now();
  const tickers = await binanceTickers();
  const btc = tickers.get("BTC");
  const btcChg = btc ? Number(btc.priceChangePercent) : 0;
  state.regime = { btcChange24hPct: round(btcChg, 2), ok: btcChg > BTC_DROP_PAUSE };

  await ensureCoinGecko();
  const funding = await fundingRates();

  const universe = cg.bySymbol.size
    ? [...cg.bySymbol.entries()]
    : [...tickers.entries()].sort((a, b) => Number(b[1].quoteVolume) - Number(a[1].quoteVolume)).slice(0, FALLBACK_UNIVERSE).map(([b]) => [b, null]);

  const eligible = [];
  for (const [base, cgRow] of universe) {
    const tk = tickers.get(base);
    if (!tk || STABLES.has(base) || BLOCKLIST.has(base)) continue;
    if ((n(tk.quoteVolume) || 0) < MIN_QUOTE_VOLUME) continue;
    eligible.push([base, cgRow, tk]);
  }
  kickDaily(eligible);
  const ready = eligible.filter(([b]) => dailyCache.has(b));
  state.warmup = { loaded: ready.length, total: eligible.length };

  const fast = await fastLayer(ready);

  const pre = [];
  for (const [base, cgRow, tk] of ready) {
    const t = techMetrics(dailyCache.get(base), Number(tk.lastPrice), Number(tk.quoteVolume));
    if (!t) continue;
    const nar = cgRow ? cg.narratives.get(cgRow.id) : null;
    const f = fast.get(base);
    pre.push({ base, cgRow, tk, t, nar, f, c: buildCandidate(base, cgRow, tk, t, nar, funding.get(base) ?? null, null, f) });
  }
  pre.sort((a, b) => b.c.score - a.c.score);

  // Add open-interest change for the best candidates only.
  const deep = pre.slice(0, DEEP_SCAN_LIMIT).filter((p) => funding.has(p.base));
  await mapLimit(deep, 4, async (p) => {
    const oi = await oiChange24h(p.base);
    p.c = buildCandidate(p.base, p.cgRow, p.tk, p.t, p.nar, funding.get(p.base), oi, p.f);
  });

  const results = pre.map((p) => p.c).sort((a, b) => b.score - a.score);
  const top = results.slice(0, 150), inTop = new Set(top.map((c) => c.symbol));
  state.candidates = [...top, ...results.filter((c) => c.ignition && !inTop.has(c.symbol))];
  state.universe = { coingecko: cg.bySymbol.size, binance: tickers.size, eligible: eligible.length };
  state.status = ready.length === 0 && eligible.length ? "warming_up" : cg.bySymbol.size ? "connected" : "binance_only";
  delete state.errors["Binance Spot"];
  updateEvents(results);
  updateTracking(new Map([...tickers].map(([b, tk]) => [b, Number(tk.lastPrice)])));
  state.lastScanMs = Date.now() - t0;
}

// ───────────────────────────── demo mode (DEMO=1) ─────────────────────────────
const DEMO_TOKENS = ["SOL", "SUI", "LINK", "AVAX", "INJ", "RENDER", "FET", "ARB", "OP", "TIA", "SEI", "NEAR", "APT", "DOGE", "PEPE", "ONDO", "JUP", "PYTH", "TAO", "ENA"];
const DEMO_NARR = ["AI", "RWA", "DePIN", "Meme", "Layer 2"];
const demoBook = new Map();
const rnd = (a, b) => a + Math.random() * (b - a);
function demoRoll(i, kind) { // kind: "ignite" | "ran" | "cold"
  const hot = kind !== "cold";
  const names = hot || Math.random() < 0.35 ? [DEMO_NARR[Math.floor(Math.random() * DEMO_NARR.length)]] : null;
  return {
    kind, rank: i + 4,
    rvol: hot ? rnd(2.4, 4) : rnd(0.7, 2.2), dist: kind === "ran" ? rnd(0.1, 0.3) : hot ? rnd(-0.025, 0.05) : rnd(-0.12, 0.06),
    rsi: hot ? rnd(50, 68) : rnd(32, 80), compressed: kind === "ignite" ? Math.random() < 0.6 : Math.random() < 0.2,
    ratio: hot ? rnd(0.6, 1) : rnd(0.15, 1), narrative: names ? { change: hot ? rnd(5, 11) : rnd(3, 7), names } : null,
    funding: Math.random() < 0.85 ? rnd(-0.0002, hot ? 0.0003 : 0.0009) : null, oi: Math.random() < 0.7 ? rnd(-0.05, 0.13) : null,
    vol: rnd(8e6, 2.2e8), price: rnd(0.4, 180),
    chg: kind === "ran" ? rnd(16, 45) : kind === "ignite" ? rnd(0.5, 6) : rnd(-6, 6),
    f: kind === "ignite" ? { rvol15: rnd(4.2, 8), ret15: rnd(0.4, 3), rvol1h: rnd(1.8, 4), ret1h: rnd(0.8, 5), buy15: rnd(60, 74) }
      : kind === "ran" ? { rvol15: rnd(3, 6), ret15: rnd(3.5, 9), rvol1h: rnd(3, 6), ret1h: rnd(9, 20), buy15: rnd(55, 70) }
        : { rvol15: rnd(0.4, 2.4), ret15: rnd(-1, 1), rvol1h: rnd(0.5, 1.6), ret1h: rnd(-2, 2), buy15: rnd(44, 56) },
  };
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
  state.regime = { btcChange24hPct: round(rnd(-1.5, 2.5), 2), ok: true };
  state.status = "demo"; state.cgStatus = "demo"; state.futuresStatus = "demo";
  state.hotNarratives = DEMO_NARR.slice(0, 3).map((name) => ({ id: name, name, change24hPct: round(rnd(4, 11), 2) }));
  state.universe = { coingecko: 500, binance: 380, eligible: results.length };
  state.warmup = { loaded: results.length, total: results.length };
  state.candidates = results;
  updateEvents(results);
  updateTracking(new Map(results.map((c) => [c.base, c.price])));
}

// ───────────────────────────── poll + server ─────────────────────────────
async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (DEMO) demoScan();
    else {
      try { await scan(); }
      catch (e) { state.status = "error"; state.errors["Binance Spot"] = e.message; }
    }
    state.lastUpdated = Date.now();
  } finally { polling = false; }
}

const jsonResponse = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "same-origin" });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/screener") return jsonResponse(res, 200, { ...state, events: state.events.slice(0, 60) });
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
  console.log(`Early Setup Screener v2: http://${HOST}:${PORT}`);
  console.log(`Refresh: ${POLL_MS / 1000}s | ignition: 15m vol >= ${IGNITE_RVOL}x, price <= +${MAX_RET15}% | setup alert >= ${MIN_SCORE_ALERT} | top ${TOP_N} | demo: ${DEMO} | telegram: ${state.telegramConfigured}`);
});
loadPersisted().finally(() => { poll(); setInterval(poll, POLL_MS); });
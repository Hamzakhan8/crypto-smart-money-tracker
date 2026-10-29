// AI trade desk (/ai): asks Gemini whether to take a long trade on a coin the ignition screener flagged.
//
// Design (same rules as agent.js):
//   • Code gathers and computes the facts; the model only interprets them. Every number in the answer must come from the
//     dossier, and every plan is checked in code (stop below entry, target above, sensible distances, reward:risk).
//   • Deterministic guards after the model: TAKE only for coins that are igniting now (early / confirmed tier), never
//     for coins that already ran; weak reward:risk becomes WAIT; simulated data is labelled and capped.
//   • Base rates are part of the prompt: most ignitions fail, so the model starts from how often this kind of alert hit
//     its target and its stop (replay, or live once 30+ resolved) and may move that by at most 15 points with evidence.
//   • Decisions are expected-value based: chance of target x target - chance of stop x stop - costs. The code checks the
//     arithmetic, applies hard stops (selling now, wide spread, thin book, BTC falling) and lets
//     TAKE stand only with +0.5% or more expected per trade (AI_MIN_EV_PCT) and reward:risk 1.5+. Default: no trade.
//
// Dossier per coin: the screener's signal (tier, ignition score and parts, 5m/15m/1h volume, buyers, daily RSI, trend,
// what it still lacks), the Market Flow Radar's taker flow (flow score, 1m / 5m aggressive buying, net flow, relative
// volume; computed on demand for coins the Radar does not follow), Binance Web3 smart-money wallet signals, fresh
// Binance candles (15m / 1h / 4h: trend, momentum, ATR, VWAP, support and resistance), the order book (depth bands,
// imbalance, walls), futures positioning (funding, open interest, long/short and taker ratios, when the coin has a
// perpetual), large Ethereum transfers and exchange flows (whale tracker), DEX buying and selling (DEX tracker), BTC
// and the market backdrop, and a reference plan from the screener's own +target / -stop rule.
//
// Single coin: POST /api/ai/analyze runs the AI committee (ai-committee.js): a data analyst and a news researcher (web
// search) report first, a bull and a bear argue the trade, a trader decides, the code checks the trader's numbers, and
// the Final Boss audits all of it on every analysis and gives the final call: YES, WATCH or NO. All ignition coins: POST /api/ai/analyze-all (one batched triage call). Facts only, no AI:
// GET /api/ai/dossier?symbol=. Track record, watched WAIT triggers and today's Gemini use: GET /api/ai/record
// (ai-tracker.js). Research tool, not financial advice.

import { Type } from "@google/genai";
import { fileURLToPath } from "node:url";
import { screenerSnapshot, fetchJson, CONFIG, assetInfo, matchingGroups, alphaTokenFor, alphaSnapshot, alphaMatchingFor, noteAiVerdict, freshAiVerdicts } from "./screener.js";
import { alphaKlinesUrl, parseKlines } from "./alpha.js";
import { tokenWhaleSummary } from "./whales.js";
import { tokenFlowSummary } from "./flows.js";
import { analyzeDepth, generate, jsonFrom, MODELS, MODEL_PATTERN, readJsonBody, AgentError } from "./agent.js";
import { sendTelegram, telegramWants } from "./telegram.js";
import { dataReview, newsResearch, debate, traderDecision, finalBoss, committeeChecks, roleConfig, usage } from "./ai-committee.js";
import { createAiTracker, cleanTrigger, triggerFromWatch, TF } from "./ai-tracker.js";

const env = process.env;
const BN = (env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");
const BF = "https://fapi.binance.com";
const MIN = 60_000, HOUR = 3_600_000;
const DOSSIER_TTL = 60_000, RESULT_TTL = 3 * MIN;
const BATCH_MAX = 12;
const LEVELS = ["low", "medium", "high"];
// From the 90-day replay of 96 Binance crypto tokens on 5-minute candles, Aug 1 - Oct 29 2026 (screener v7 rules, each
// coin counted only while it had $5M+ 24h volume as live, 0.2% fees + 0.1% slippage). hitTargetPct = target before stop,
// hitStopPct = stop first, the rest ended flat.
const REPLAY = {
  source: "90-day replay of 96 Binance crypto tokens on 5-minute candles, Aug 1 - Oct 29 2026 (screener-backtest.js, v7 rules)",
  rule: `take profit +${CONFIG.targetPct}%, stop -${CONFIG.stopPct}%, else exit after ${CONFIG.outcomeHours}h; ${CONFIG.feePct}% fees + ${CONFIG.slippagePct}% slippage`,
  confirmed: { signals: 102, hitTargetPct: 25, hitStopPct: 32, flatPct: 43, avgNetPct: 0.49 }, early: { signals: 230, hitTargetPct: 26, hitStopPct: 36, flatPct: 38, avgNetPct: 0.46 },
};
const COST_PCT = (CONFIG.feePct || 0) + (CONFIG.slippagePct || 0);
const MIN_EV_PCT = Number.isFinite(Number(env.AI_MIN_EV_PCT)) && env.AI_MIN_EV_PCT !== "" && env.AI_MIN_EV_PCT !== undefined ? Number(env.AI_MIN_EV_PCT) : 0.5;
// How often each kind of alert reached its target before its stop (hitTargetPct) or its stop first (hitStopPct); the
// rest ended flat. The AI starts from these numbers. Live results replace them once 30+ alerts of a tier have resolved.
export const BASE_RATES = {
  confirmed: { ...REPLAY.confirmed, source: REPLAY.source },
  early: { ...REPLAY.early, source: REPLAY.source },
  bigmove: { hitTargetPct: 8.5, hitStopPct: 39, avgNetPct: 1.55, source: "90-day replay of every Binance USDT pair (bigmove-backtest.js)",
    note: "made money in the Aug-Sep altcoin rally and lost in October: it depends on the market" },
  none: { hitTargetPct: 15, hitStopPct: 40, source: "no ignition signal: assumed below the early tier" },
};
const ruleFor = (tier) => (tier === "bigmove" && CONFIG.bigmove
  ? { targetPct: CONFIG.bigmove.targetPct, stopPct: CONFIG.bigmove.stopPct, holdHours: CONFIG.bigmove.outcomeHours }
  : { targetPct: CONFIG.targetPct, stopPct: CONFIG.stopPct, holdHours: CONFIG.outcomeHours });
// What the alert is tracked as and the starting probabilities for the AI.
export function alertContext(tier, snap = {}) {
  const t = BASE_RATES[tier] ? tier : "none", base = BASE_RATES[t];
  const live = { confirmed: "ignition", early: "early", bigmove: "bigmove" }[t] ? snap.stats?.current?.byTier?.[{ confirmed: "ignition", early: "early", bigmove: "bigmove" }[t]] : null;
  const useLive = !!live && live.resolved >= 30;
  return {
    tier: t, label: { confirmed: "confirmed ignition", early: "early ignition", bigmove: "big-move ignition (small coin waking up)", none: "no ignition signal" }[t],
    trackedAs: ruleFor(t), costPct: r(COST_PCT, 2), baseRate: base,
    live: live && live.resolved ? { resolved: live.resolved, hitTargetPct: live.winRatePct, hitStopPct: r((live.losses / live.resolved) * 100, 1), avgNetPct: live.netPct } : null,
    anchorProbTargetPct: Math.round(useLive ? live.winRatePct : base.hitTargetPct),
    anchorProbStopPct: Math.round(useLive ? (live.losses / live.resolved) * 100 : base.hitStopPct),
    anchorFrom: useLive ? "live results" : t === "none" ? "an assumption: no replay exists for coins without a signal" : "replay",
  };
}
// Breadth of the screener's coins: is the market lifting most coins or few?
export function marketRegime(snap = {}) {
  const cs = (snap.candidates || []).filter((c) => c.core !== false && Number.isFinite(c.change24h));
  if (cs.length < 10) return null;
  const ch = cs.map((c) => c.change24h).sort((a, b) => a - b), med = ch[ch.length >> 1];
  const up = (cs.filter((c) => c.change24h > 0).length / cs.length) * 100, above = (cs.filter((c) => c.aboveSma).length / cs.length) * 100;
  return { coins: cs.length, shareUp24hPct: Math.round(up), median24hPct: r(med), shareAbove20dAvgPct: Math.round(above),
    label: above >= 60 && med > 0 ? "broad strength" : above <= 35 || med < -2 ? "weak market" : "mixed" };
}

const r = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const sig = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : null);
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b ? (a / b - 1) * 100 : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const normSymbol = (s) => {
  const base = String(s || "").trim().toUpperCase().replace(/USDT$/, "");
  if (!/^[A-Z0-9]{2,15}$/.test(base)) throw new AgentError("Enter a Binance coin like PEPE or PEPEUSDT", 400);
  return base + "USDT";
};

// ───────────────────────────── market data ─────────────────────────────
const candles = (raw) => (Array.isArray(raw) ? raw : []).map((k) => ({
  t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]), qv: Number(k[7]), buy: Number(k[10]),
}));
function ema(values, len) {
  if (values.length < len) return null;
  const k = 2 / (len + 1);
  let e = values.slice(0, len).reduce((a, b) => a + b, 0) / len;
  const out = [e];
  for (let i = len; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function atrPct(cs, len = 14) {
  if (cs.length < len + 1) return null;
  const tr = [];
  for (let i = 1; i < cs.length; i++) tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
  const a = tr.slice(-len).reduce((x, y) => x + y, 0) / len;
  return (a / cs[cs.length - 1].c) * 100;
}
function trendOf(cs) {
  const closes = cs.map((c) => c.c), e20 = ema(closes, 20), e50 = ema(closes, 50), last = closes[closes.length - 1];
  if (!e20) return null;
  const now20 = e20[e20.length - 1], prev20 = e20[Math.max(0, e20.length - 6)], now50 = e50 ? e50[e50.length - 1] : null;
  const state = now50 == null ? (last > now20 ? "above EMA20" : "below EMA20")
    : last > now20 && now20 > now50 ? "uptrend (price > EMA20 > EMA50)" : last < now20 && now20 < now50 ? "downtrend (price < EMA20 < EMA50)" : "mixed";
  return { state, priceVsEma20Pct: r(pct(last, now20)), priceVsEma50Pct: r(pct(last, now50)), ema20SlopePct: r(pct(now20, prev20), 3) };
}
const hiLo = (cs) => ({ high: Math.max(...cs.map((c) => c.h)), low: Math.min(...cs.map((c) => c.l)) });

// Price levels around the price. Above: the given highs, 1h swing highs of the last 2 days (a candle whose high tops the
// 2 before and the 2 after it) and the 1h / 4h EMA20 and EMA50 (in a downtrend the falling EMA is often the first
// ceiling). Below: the given lows and 1h swing lows (EMAs below are listed but are not used as support for stops).
// Levels within 0.2% of the price are ignored. resistance / support = the nearest one, with what it is.
export function keyLevels(price, h1, h4, highs = [], lows = []) {
  const up = highs.filter((x) => x.price > 0), down = lows.filter((x) => x.price > 0), sw = h1.slice(-50);
  for (let i = 2; i < sw.length - 2; i++) {
    const near = [sw[i - 2], sw[i - 1], sw[i + 1], sw[i + 2]];
    if (near.every((x) => sw[i].h > x.h)) up.push({ price: sw[i].h, what: "1h swing high" });
    if (near.every((x) => sw[i].l < x.l)) down.push({ price: sw[i].l, what: "1h swing low" });
  }
  for (const [cs, tf] of [[h1, "1h"], [h4, "4h"]]) for (const len of [20, 50]) {
    const e = ema(cs.map((c) => c.c), len), v = e ? e[e.length - 1] : null;
    if (v) (v > price ? up : down).push({ price: v, what: `${tf} EMA${len}`, dynamic: true });
  }
  const above = up.filter((x) => x.price > price * 1.002).sort((a, b) => a.price - b.price);
  const below = down.filter((x) => x.price < price * 0.998).sort((a, b) => b.price - a.price);
  const view = (x) => ({ price: sig(x.price), pct: r(pct(x.price, price)), what: x.what });
  return { resistance: above[0] || null, support: below.find((x) => !x.dynamic) || null, overhead: above.slice(0, 6).map(view), underneath: below.slice(0, 6).map(view) };
}

// The liquidity hard stop spelled out: bids within 1% of the price under $20,000, or a spread above 30 bps. A thin 0.1%
// band is normal for small coins and is not the test. When the 100-level book snapshot does not reach 1%, the widest
// band it covers is a lower bound for the bids within 1%.
export function liquidityCheck(ob) {
  if (!ob?.bands) return { rule: "bids within 1% under $20,000 or spread above 30 bps = hard stop", passes: null, note: "no order book data" };
  const b1 = ob.bands.find((x) => x.withinPct === 1), widest = ob.bands[ob.bands.length - 1], wideSpread = ob.spreadBps > 30;
  const enough = b1 ? b1.bidUsd >= 20_000 : widest && widest.bidUsd >= 20_000 ? true : null; // a smaller band is only a lower bound
  return { rule: "bids within 1% under $20,000 or spread above 30 bps = hard stop", bidsWithin1PctUsd: b1 ? b1.bidUsd : null, spreadBps: ob.spreadBps,
    passes: wideSpread ? false : enough, note: b1 ? null : widest ? `the 100-level book reaches only ${ob.depthReachPct}%: at least $${widest.bidUsd} of bids within ${widest.withinPct}%` : "no depth bands" };
}

async function spot(symbol) {
  const q = (path) => fetchJson(`${BN}${path}`, { retries: 1, timeoutMs: 10_000 });
  const [t24, k15, k1h, k4h, book] = await Promise.all([
    q(`/api/v3/ticker/24hr?symbol=${symbol}`), q(`/api/v3/klines?symbol=${symbol}&interval=15m&limit=96`),
    q(`/api/v3/klines?symbol=${symbol}&interval=1h&limit=120`), q(`/api/v3/klines?symbol=${symbol}&interval=4h&limit=90`),
    q(`/api/v3/depth?symbol=${symbol}&limit=100`).catch(() => null),
  ]);
  return { t24, m15: candles(k15).slice(0, -1), h1: candles(k1h).slice(0, -1), h4: candles(k4h).slice(0, -1), book }; // finished candles only
}

async function futures(symbol) {
  const q = (path) => fetchJson(`${BF}${path}`, { retries: 0, timeoutMs: 8000 });
  try {
    const [prem, oi, ls, taker] = await Promise.all([
      q(`/fapi/v1/premiumIndex?symbol=${symbol}`), q(`/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=25`),
      q(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`).catch(() => null),
      q(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=6`).catch(() => null),
    ]);
    const oiv = (oi || []).map((x) => Number(x.sumOpenInterestValue)).filter(Number.isFinite);
    const takerAvg = Array.isArray(taker) && taker.length ? taker.reduce((s, x) => s + Number(x.buySellRatio), 0) / taker.length : null;
    return {
      available: true, fundingPctPer8h: r(Number(prem.lastFundingRate) * 100, 4), markPremiumPct: r(pct(Number(prem.markPrice), Number(prem.indexPrice)), 3),
      openInterestUsd: oiv.length ? Math.round(oiv[oiv.length - 1]) : null,
      oiChange1hPct: oiv.length >= 2 ? r(pct(oiv[oiv.length - 1], oiv[oiv.length - 2])) : null,
      oiChange24hPct: oiv.length >= 25 ? r(pct(oiv[oiv.length - 1], oiv[0])) : null,
      longShortAccountRatio: Array.isArray(ls) && ls[0] ? r(Number(ls[0].longShortRatio)) : null,
      takerBuySellRatio30m: r(takerAvg),
    };
  } catch (e) {
    return { available: false, reason: /400|-1121|Invalid symbol/i.test(e.message) ? "no Binance perpetual for this coin" : `futures data unavailable (${e.message})` };
  }
}

// ───────────────────────────── Market Flow Radar data ─────────────────────────────
// server.js registers the Radar here (its live state plus a function that applies the Radar's formula to any coin).
let flowSource = null;
export function setMarketFlowSource(src) { flowSource = src; }

export async function marketFlowFor(symbol) {
  if (!flowSource) return { available: false, reason: "Market Flow Radar is not running" };
  const st = flowSource.state() || {}, coins = st.coins || [], base = symbol.replace(/USDT$/, "");
  const tracked = coins.find((c) => c.symbol === symbol);
  let m = tracked, source = `Radar live data (top ${coins.length} coins by volume, refreshed every ${Math.round((st.pollIntervalMs || 30000) / 1000)}s)`;
  if (!m) {
    try { m = await flowSource.flowFor(symbol); source = "computed now with the Radar's formula (coin is outside the Radar's top list)"; }
    catch (e) { return { available: false, reason: `Market Flow data unavailable (${e.message})` }; }
  }
  const signals = (st.web3Signals || []).filter((s) => String(s.ticker || "").toUpperCase() === base)
    .sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 5)
    .map((s) => ({ chain: s.chain, direction: s.direction, wallets: s.wallets, exitRate: s.exitRate, ageMin: s.time ? Math.round((Date.now() - s.time) / MIN) : null, status: s.status }));
  return {
    available: true, source, simulated: !!st.demo && !!tracked, // computed-on-demand numbers are always live
    flowScore: m.score, label: m.label, reasons: m.reasons, rankAmongRadarCoins: tracked ? `${coins.indexOf(tracked) + 1} of ${coins.length}` : null,
    buyRatio1mPct: r(m.buyRatio1m, 1), buyRatio5mPct: r(m.buyRatio5m, 1), netFlow5mUsd: Number.isFinite(m.netFlow5m) ? Math.round(m.netFlow5m) : null,
    change5mPct: r(m.change5m, 2), lastMinuteVolumeVsAvg: r(m.relativeVolume, 2), trades1m: m.trades1m,
    smartMoneyWallets: { feedStatus: st.web3Status || "unknown", matchingSignals: signals },
  };
}
// Taker-flow breadth across the Radar's coins: is aggressive buying broad or narrow right now?
function flowBreadth() {
  const coins = flowSource?.state()?.coins || [];
  if (!coins.length) return null;
  const buy = coins.reduce((a, c) => a + (c.buyQuote5m || 0), 0), sell = coins.reduce((a, c) => a + (c.sellQuote5m || 0), 0);
  return { coins: coins.length, buyDominant5m: coins.filter((c) => c.buyRatio5m >= 55).length, sellDominant5m: coins.filter((c) => c.buyRatio5m <= 45).length,
    aggregateBuyRatio5mPct: buy + sell > 0 ? r((buy / (buy + sell)) * 100, 1) : null };
}

// ───────────────────────────── dossier ─────────────────────────────
// The track record the AI sees: this tier only. With nothing for this tier: "no track record for this tier", and the
// AI uses the base rate only.
export function performanceFor({ tier, live, groups = [], committee = null, aiCalls = [] }) {
  const out = { tier };
  if (live?.resolved) out.thisTier = { resolved: live.resolved, hitTargetPct: live.winRatePct ?? live.winPct ?? null, avgNetPct: live.netPct ?? live.avgNetPct ?? null };
  if (groups.length) out.matchingGroups = groups;
  if (aiCalls.length) out.aiCallsThisTier = aiCalls.map((b) => ({ call: b.name.replace("AI said ", ""), resolved: b.resolved, hitTargetPct: b.winRatePct, avgNetPct: b.netPct }));
  if (committee && committee.resolved >= 5) out.aiCommittee = committee;
  if (!out.thisTier && !out.matchingGroups && !out.aiCommittee) out.note = "no track record for this tier";
  return out;
}
// The average move of this tier's trades that ended at the time limit (before costs), for the expected value: from this
// tier's live alerts (10+ time-outs), else from the AI's own calls on this tier (5+), else 0 (no data yet).
function timeoutFor(kind, tier, live) {
  if (live?.flat >= 10 && Number.isFinite(live.flatAvgPct)) return { pct: live.flatAvgPct, from: `live alerts of this tier that timed out (${live.flat})` };
  const t = tracker.timeoutAverage(kind, tier);
  if (t) return { pct: t.pct, from: `AI calls of this tier that timed out (${t.n})` };
  return { pct: 0, from: "no time-out data for this tier yet: counted as flat" };
}
const dossierCache = new Map();
export async function buildDossier(symbol, tierHint = null) {
  const key = `${symbol}:${tierHint || ""}`, hit = dossierCache.get(key);
  if (hit && Date.now() - hit.at < DOSSIER_TTL) return hit.d;
  const snap = screenerSnapshot();
  const cand = (snap.candidates || []).find((c) => c.symbol === symbol) || null;
  const [s, fut, flow] = await Promise.all([spot(symbol), futures(symbol), marketFlowFor(symbol)]);
  if (!s.h1.length || !s.h4.length) throw new AgentError(`${symbol}: no candle data from Binance`, 502);
  const price = Number(s.t24.lastPrice) || s.m15[s.m15.length - 1]?.c;
  const atr1h = atrPct(s.h1), atr4h = atrPct(s.h4);
  const h24 = hiLo(s.h1.slice(-24)), h12 = hiLo(s.h1.slice(-12)), d7 = hiLo(s.h4.slice(-42)), d15 = hiLo(s.h4);
  const lv = keyLevels(price, s.h1, s.h4, [{ price: h24.high, what: "24h high" }, { price: d7.high, what: "7-day high" }, { price: d15.high, what: "15-day high" }],
    [{ price: h12.low, what: "12h low" }, { price: h24.low, what: "24h low" }, { price: d7.low, what: "7-day low" }]);
  const resistance = lv.resistance?.price ?? null, support = lv.support?.price ?? null;
  const base = symbol.replace(/USDT$/, ""), tags = assetInfo(base)?.tags || [];
  const ob = s.book && Array.isArray(s.book.bids) && s.book.bids.length ? analyzeDepth(s.book) : { available: false };
  if (ob.bands) ob.liquidityCheck = liquidityCheck(ob);
  const todayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000, today = s.m15.filter((c) => c.t >= todayStart);
  const vwap = today.length ? today.reduce((a, c) => a + c.qv, 0) / today.reduce((a, c) => a + c.v, 0) : null;
  const last8 = s.m15.slice(-8);
  const vol1h = s.h1.map((c) => c.qv), medVol = [...vol1h.slice(-25, -1)].sort((a, b) => a - b)[12];
  const ret = (cs, n) => (cs.length > n ? r(pct(cs[cs.length - 1].c, cs[cs.length - 1 - n].c)) : null);

  // Reference plan from the alert's own exit rule plus structure / volatility alternatives (long only).
  const tier = tierHint || (cand?.ignition === "ignited" ? ((cand.igScore ?? 0) >= CONFIG.igniteMinScore ? "confirmed" : "early") : cand?.bigmove === "ignited" ? "bigmove" : null);
  const alert = alertContext(tier, snap), rule = alert.trackedAs, liveKey = { confirmed: "ignition", early: "early", bigmove: "bigmove" }[alert.tier] || null;
  alert.timeout = timeoutFor("spot", alert.tier, liveKey ? snap.stats?.current?.byTier?.[liveKey] : null);
  const stopRule = price * (1 - rule.stopPct / 100);
  const stopStructure = support && pct(support, price) > -8 ? support * (1 - (0.15 * (atr1h || 1)) / 100) : null;
  const stopAtr = atr1h ? price * (1 - (1.5 * atr1h) / 100) : null;
  const tRule = price * (1 + rule.targetPct / 100), tRes = resistance && pct(resistance, price) < Math.max(25, rule.targetPct) && resistance * 0.997 > price * 1.002 ? resistance * 0.997 : null;
  const rr = (stop, target) => (stop && target && price > stop ? r((target - price) / (price - stop)) : null);
  const plan = {
    entry: sig(price), entryZone: [sig(price * (1 - Math.min(0.4, 0.25 * (atr1h || 1)) / 100)), sig(price)],
    stops: { screenerRule: sig(stopRule), belowSupport: sig(stopStructure), atr1_5x: sig(stopAtr) },
    targets: { screenerRule: sig(tRule), nearResistance: sig(tRes), twoR: sig(price + 2 * (price - stopRule)) },
    rewardRisk: { ruleTargetRuleStop: rr(stopRule, tRule), resistanceRuleStop: rr(stopRule, tRes), ruleTargetSupportStop: rr(stopStructure, tRule) },
  };

  const live = snap.stats?.current?.byTier || {};
  const liveRate = (b) => (b && b.resolved ? { resolved: b.resolved, winRatePct: b.winRatePct, avgNetPct: b.netPct } : { resolved: 0 });
  const d = {
    symbol, asOf: new Date().toISOString(), price: sig(price), alert, dataQuality: {
      demo: !!snap.demo, screenerStatus: snap.status, inScreener: !!cand,
      notes: [snap.demo ? "Screener is in DEMO mode: its signal is simulated (market data below is live)." : null,
        !cand ? "Not in the screener's current list (no ignition data); judged on market data only." : null,
        flow.simulated ? "Market Flow Radar is in DEMO mode: its flow numbers are simulated." : null].filter(Boolean),
    },
    screener: cand ? {
      state: cand.ignition || "none", tier, bigmove: cand.bigmove || null, moved: cand.moved, movedWhy: cand.movedWhy, stillNeeds: cand.missing,
      ignitionScore: cand.igScore, ignitionParts: cand.igParts, dailySetupScore: cand.score, dailySetupReasons: cand.reasons?.slice(0, 4),
      volume: { last2x5mVsNormal: [cand.prevR5, cand.r5], rolling15mVsNormal: cand.rvol15, last1hVsNormal: cand.rvol1h, tradesVsNormal: cand.tradesRatio },
      buyersPct: { last10m: cand.buyRatio10m, last15m: cand.buyRatio15m },
      movePct: { last10m: cand.ret10m, last15m: cand.ret15m, last1h: cand.ret1h, last24h: cand.change24h },
      dailyRsi: cand.rsi, vs20dHighPct: cand.distToHigh != null ? r(cand.distToHigh * 100) : null, trend4hRising: cand.trendUp,
      stretchAbove4hAvgPct: cand.extPct, offSpikeHighPct: cand.fadePct, broke12hHigh: cand.breakout, typical6hRangePct: cand.range6h,
      spreadBps: cand.spreadBps, narrative: cand.narrative, rank: cand.rank, marketCapUsd: cand.marketCap, monitoringList: cand.monitoring,
    } : null,
    chart: {
      trend1h: trendOf(s.h1), trend4h: trendOf(s.h4),
      returnsPct: { "1h": ret(s.h1, 1), "4h": ret(s.h1, 4), "24h": ret(s.h1, 24), "7d": ret(s.h4, 42) },
      atrPct: { "1h": r(atr1h), "4h": r(atr4h) },
      priceVsVwapTodayPct: r(pct(price, vwap)),
      last2hOf15m: { buyersPct: r((last8.reduce((a, c) => a + c.buy, 0) / Math.max(1, last8.reduce((a, c) => a + c.qv, 0))) * 100, 1), movePct: r(pct(price, last8[0]?.o)) },
      lastHourVolumeVsMedian24h: r(medVol ? vol1h[vol1h.length - 1] / medVol : null),
      volume24hUsd: Math.round(Number(s.t24.quoteVolume) || 0),
    },
    levels: {
      resistance: sig(resistance), resistanceIs: lv.resistance?.what || null, roomToResistancePct: r(pct(resistance, price)),
      support: sig(support), supportIs: lv.support?.what || null, distanceToSupportPct: r(pct(support, price)), overhead: lv.overhead, underneath: lv.underneath,
      high24h: sig(h24.high), low24h: sig(h24.low), high7d: sig(d7.high), low7d: sig(d7.low), high15d: sig(d15.high), low15d: sig(d15.low),
      note: resistance == null ? "No level above the price in this data (highs, swing highs, EMAs)." : null,
    },
    exchangeTags: { monitoring: tags.some((t) => /monitoring/i.test(t)) || !!cand?.monitoring, seed: tags.some((t) => /seed/i.test(t)), all: tags.slice(0, 8) },
    marketFlow: flow,
    orderBook: ob,
    futures: fut,
    whales: tokenWhaleSummary(base),
    dexFlows: tokenFlowSummary(base),
    market: {
      btcChange24hPct: snap.regime?.btcChange24hPct, btc1hPct: snap.regime?.btc1hPct, btc4hPct: snap.regime?.btc4hPct,
      marketWideSurge: !!snap.breadth?.marketWide, shareOfTokensSurging: snap.breadth?.hotShare, takerFlowBreadth: flowBreadth(),
      btcRegime: cand?.rotation?.regimeLabel || null, narrativeRanks: cand?.rotation?.narratives?.filter((x) => x.rank != null).slice(0, 3) || null,
      regime: marketRegime(snap),
    },
    // this alert tier's own record only (other tiers behave differently): live results, past alerts of this tier with the
    // same conditions (10+ resolved each, with the older / newer half), and the committee's calls on this tier
    livePerformance: performanceFor({ tier: alert.tier, live: liveKey ? live[liveKey] : null, groups: cand && liveKey && liveKey !== "bigmove" ? matchingGroups(cand, 10, liveKey) : [],
      committee: tracker.trackRecord("spot", alert.tier),
      aiCalls: liveKey && liveKey !== "bigmove" ? (snap.stats?.current?.bucketsByTier?.[liveKey] || []).filter((b) => /^AI said/.test(b.name) && b.resolved >= 10) : [] }),
    referencePlan: plan,
  };
  dossierCache.set(key, { at: Date.now(), d });
  if (dossierCache.size > 60) dossierCache.delete(dossierCache.keys().next().value);
  return d;
}

// ───────────────────────────── prompts + schemas ─────────────────────────────
const RULES = `
You decide whether to buy one Binance spot coin RIGHT NOW. Long only, no leverage. The default answer is SKIP (no trade):
TAKE has to be earned by the evidence. Most ignition alerts fail, and a skipped trade costs nothing.

Use ONLY the DOSSIER (and your colleagues' reports when you have them) and quote its numbers exactly. Never invent
prices, levels, news or data. null or "unavailable" means
unknown, and unknown is not good news. marketFlow is aggressive buying on Binance spot in the last 1-5 minutes, not
"smart money"; smartMoneyWallets are separate on-chain signals.

Work through these steps in order and show them in your answer:
1. HARD STOPS. If any one applies, the answer is SKIP: the coin already ran (screener.moved); BTC down more than 1% in 1h
   or 2% in 4h; aggressive selling right now (marketFlow 5m buyers under 45% with negative net flow); spread above 30 bps
   or less than $20k of bids within 1% (you could not get out). List the ones that apply in hardStops (empty if none).
2. CHECKLIST. For each item give pass / fail / unknown and the dossier number that decides it:
   trigger (alert.tier, volume vs normal, how many candles held it), executed buying (screener buyers %, marketFlow),
   trend (1h and 4h direction vs the trade), room (distance to resistance vs distance to the stop: an ignition just under
   a recent high is normal, but a 15d or 7d high right overhead caps the move), liquidity (spread, depth),
   positioning (futures funding / open interest / long-short, whale exchange deposits, DEX net selling),
   market (BTC, market.regime breadth, market-wide surge), track record (livePerformance: THIS tier only; trust a
   matching group more when its older and newer halves agree; if it says "no track record for this tier", write that
   and use the base rate only).
3. PROBABILITY. Start from alert.anchorProbTargetPct (how often this kind of alert hit its target before its stop) and
   alert.anchorProbStopPct (how often it hit the stop first); the rest end flat. Move them only for checklist evidence,
   at most 15 points each way, and say which items moved them. A weak market regime, BTC weakness or poor live results
   (including matchingGroups well below this tier's average) lower the target chance; strong confirmed volume with
   buyers in control and room to run raise it.
4. EXPECTED VALUE per trade = P_target x target% - P_stop x stop% + P_timeout x alert.timeout.pct - alert.costPct, with
   P_timeout = 100 - P_target - P_stop, using your plan's target and stop. Write the full calculation in probReason. The
   code recomputes it.
5. DECIDE.
   TAKE only if there is no hard stop, the expected value is at least +0.5% per trade, reward:risk is at least 1.5 and
   the price is inside the entry zone now. The Final Boss then wants reward:risk of 2 or more with the target capped at
   the nearest resistance (levels.resistance), so plan the target and stop with that in mind.
   WAIT when the setup is close and one specific thing is missing: waitFor must name a price level, a condition and a
   time limit, e.g. "a 5m close above 0.0512 with buyers 55%+ within 30 minutes; otherwise no trade". Put the same
   price event in trigger (breakout = a candle closes above the price; pullback = the price trades down to it; the
   candle timeframe; the time limit in minutes): the code watches it and the committee checks the coin again when it
   happens. For TAKE and SKIP leave trigger empty.
   SKIP (no trade) for everything else, including when the data is too thin to judge.
6. PLAN. Entry from dossier.price. Stop just below the nearest real support (levels.support or levels.low24h), never
   a fixed percentage. Target 1 at or below the nearest resistance (levels.resistance): the code caps the target there
   and moves the stop below support, so plan with that in mind. Holding time from alert.trackedAs. Risk at most 1% of
   the account per trade.
Be concise and concrete.`.trim();

const TRIAGE_SYSTEM = `You are a disciplined crypto spot trader triaging several setups from a volume-ignition screener at once.\n\n${RULES}
For each coin give a decision, the chance of its target and of its stop (starting from that coin's alert anchors), and the
single most important reason and risk. Rank the best setups highest.`;

const strArr = { type: Type.ARRAY, items: { type: Type.STRING } };
const DECISION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    decision: { type: Type.STRING, enum: ["TAKE", "WAIT", "SKIP"] },
    hardStops: { ...strArr, description: "Hard stops that apply; empty if none" },
    checklist: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { item: { type: Type.STRING }, status: { type: Type.STRING, enum: ["pass", "fail", "unknown"] }, evidence: { type: Type.STRING } },
        required: ["item", "status", "evidence"] },
    },
    probTargetPct: { type: Type.INTEGER, description: "Chance (0-100) the target is hit before the stop within the holding time" },
    probStopPct: { type: Type.INTEGER, description: "Chance (0-100) the stop is hit first" },
    probReason: { type: Type.STRING, description: "Which checklist items moved the chances away from the anchors" },
    confidence: { type: Type.STRING, enum: LEVELS },
    setupScore: { type: Type.INTEGER, description: "Setup quality 0-10" },
    headline: { type: Type.STRING, description: "One line" },
    thesis: { type: Type.STRING, description: "2-3 sentences" },
    bullishPoints: strArr, bearishPoints: strArr,
    plan: {
      type: Type.OBJECT,
      properties: {
        entryLow: { type: Type.NUMBER }, entryHigh: { type: Type.NUMBER }, stop: { type: Type.NUMBER },
        target1: { type: Type.NUMBER }, target2: { type: Type.NUMBER, nullable: true }, holdHours: { type: Type.NUMBER },
      },
      required: ["entryLow", "entryHigh", "stop", "target1", "holdHours"],
    },
    waitFor: { type: Type.STRING, description: "For WAIT: price level, condition and time limit; otherwise empty" },
    trigger: {
      type: Type.OBJECT, nullable: true, description: "For WAIT only: the price event that would make it a TAKE; null for TAKE and SKIP",
      properties: { event: { type: Type.STRING, enum: ["breakout", "pullback"] }, price: { type: Type.NUMBER }, timeframe: { type: Type.STRING, enum: ["5m", "15m", "1h"] },
        expiresMinutes: { type: Type.INTEGER } },
      required: ["event", "price", "timeframe", "expiresMinutes"],
    },
    invalidation: { type: Type.STRING },
    keyRisk: { type: Type.STRING },
  },
  required: ["decision", "hardStops", "checklist", "probTargetPct", "probStopPct", "probReason", "confidence", "setupScore", "headline", "thesis",
    "bullishPoints", "bearishPoints", "plan", "waitFor", "invalidation", "keyRisk"],
};
const TRIAGE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    marketView: { type: Type.STRING, description: "One sentence on the backdrop" },
    coins: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          symbol: { type: Type.STRING }, decision: { type: Type.STRING, enum: ["TAKE", "WAIT", "SKIP"] }, confidence: { type: Type.STRING, enum: LEVELS },
          probTargetPct: { type: Type.INTEGER }, probStopPct: { type: Type.INTEGER },
          setupScore: { type: Type.INTEGER }, reason: { type: Type.STRING }, keyRisk: { type: Type.STRING },
        },
        required: ["symbol", "decision", "confidence", "probTargetPct", "probStopPct", "setupScore", "reason", "keyRisk"],
      },
    },
  },
  required: ["marketView", "coins"],
};

// ───────────────────────────── guards (code, not the model) ─────────────────────────────
const lower = (c) => LEVELS[Math.max(0, LEVELS.indexOf(c) - 1)];
const cap = (c, max) => LEVELS[Math.min(Math.max(0, LEVELS.indexOf(c)), LEVELS.indexOf(max))];

const isIgniting = (d) => d.screener?.state === "ignited" || (d.alert?.tier === "bigmove" && d.screener?.bigmove === "ignited");
export function applyGuards(d, out) {
  const notes = [];
  let decision = ["TAKE", "WAIT", "SKIP"].includes(out.decision) ? out.decision : "SKIP";
  let confidence = LEVELS.includes(out.confidence) ? out.confidence : "low";
  const sc = d.screener;
  if (sc?.moved) { if (decision !== "SKIP") notes.push(`Already moved (${(sc.movedWhy || []).join(", ")}): the screener never chases.`); decision = "SKIP"; }
  if (decision === "TAKE" && !isIgniting(d)) { decision = "WAIT"; notes.push("Not igniting right now (screener: " + (sc ? sc.state : "no signal") + "), so TAKE becomes WAIT."); }
  if (sc?.tier !== "confirmed") confidence = cap(confidence, "medium");
  if (d.dataQuality.demo) { confidence = "low"; notes.push("Screener signal is simulated (demo mode)."); }
  if (d.market.marketWideSurge || (d.market.btc4hPct != null && d.market.btc4hPct < -1)) confidence = lower(confidence);
  if (decision === "TAKE" && /^downtrend/.test(d.chart.trend4h?.state || "")) {
    confidence = lower(confidence); notes.push("Buying against a 4h downtrend: confidence lowered one step.");
  }
  return { decision, confidence, notes };
}

// Hard stops the code can check itself (the model is asked for the same ones).
export function hardStops(d, plan) {
  const out = [], m = d.market || {}, mf = d.marketFlow, ob = d.orderBook;
  if ((m.btc1hPct ?? 0) < -1 || (m.btc4hPct ?? 0) < -2) out.push(`BTC falling (${m.btc1hPct ?? "n/a"}% 1h, ${m.btc4hPct ?? "n/a"}% 4h)`);
  if (mf?.available && mf.buyRatio5mPct < 45 && mf.netFlow5mUsd < 0) out.push(`aggressive selling now (${mf.buyRatio5mPct}% buyers over 5m, net ${mf.netFlow5mUsd} USD)`);
  if (ob?.spreadBps > 30) out.push(`spread ${ob.spreadBps} bps`);
  const b1 = (ob?.bands || []).find((x) => x.withinPct === 1);
  if (b1 && b1.bidUsd < 20_000) out.push(`only $${b1.bidUsd} of bids within 1%`);
  if (d.exchangeTags?.monitoring || d.screener?.monitoringList) out.push("Binance monitoring tag (delisting risk)");
  return out;
}

// Expected value per trade from the (anchored) probabilities, then the final call. TAKE needs no hard stop, EV >=
// AI_MIN_EV_PCT and reward:risk >= 1.5; a TAKE that fails becomes WAIT (EV not far below zero) or SKIP.
// Expected value per trade, the full calculation: P_target × target% − P_stop × stop% + P_timeout × average time-out% −
// costs, with P_timeout = 100 − P_target − P_stop. timeoutPct = the average move of this tier's trades that ended at the
// time limit (alert.timeout); 0 when there is no data yet. Returns the numbers and the formula as text.
export function evCalc({ pT, pS, targetPct, stopPct, timeoutPct = 0, costPct = 0, timeoutFrom = null }) {
  const pTO = Math.max(0, 100 - pT - pS), S = Math.abs(stopPct ?? 0), T = targetPct ?? 0, TO = Number(timeoutPct) || 0, f = (x) => Number(x).toFixed(2);
  const ev = r((pT / 100) * T - (pS / 100) * S + (pTO / 100) * TO - costPct, 2);
  return { pTargetPct: pT, targetPct: r(T), pStopPct: pS, stopPct: r(S), pTimeoutPct: pTO, timeoutPct: r(TO), timeoutFrom, costPct: r(costPct), ev,
    formula: `${f(pT / 100)} × ${f(T)}% − ${f(pS / 100)} × ${f(S)}% + ${f(pTO / 100)} × ${f(TO)}% − ${f(costPct)}% costs = ${ev >= 0 ? "+" : ""}${f(ev)}%` };
}
export function decide(d, out, plan, minEv = MIN_EV_PCT) {
  const a = d.alert || alertContext(d.screener?.tier || null), notes = [];
  const anT = a.anchorProbTargetPct, anS = a.anchorProbStopPct, n = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
  let pT = clamp(n(out.probTargetPct, anT), Math.max(0, anT - 15), Math.min(100, anT + 15));
  let pS = clamp(n(out.probStopPct, anS), Math.max(0, anS - 15), Math.min(100, anS + 15));
  if (pT + pS > 100) pS = 100 - pT;
  if (pT !== n(out.probTargetPct, anT) || pS !== n(out.probStopPct, anS)) notes.push(`Chances held within 15 points of this alert's base rate (${anT}% target / ${anS}% stop).`);
  const calc = evCalc({ pT, pS, targetPct: plan.target1Pct, stopPct: plan.stopPct, timeoutPct: a.timeout?.pct, timeoutFrom: a.timeout?.from, costPct: a.costPct }), ev = calc.ev;
  const hard = hardStops(d, plan);
  let decision = out.decision;
  if (hard.length && decision !== "SKIP") { notes.push(`Hard stop: ${hard.join("; ")}. No trade.`); decision = "SKIP"; }
  if (decision === "TAKE" && !(ev >= minEv)) { decision = ev >= -0.5 ? "WAIT" : "SKIP"; notes.push(`Expected value ${ev}% per trade is below +${minEv}%, so TAKE became ${decision === "SKIP" ? "no trade" : "WAIT"}.`); }
  if (decision === "TAKE" && !(plan.rewardRisk >= 1.5)) { decision = "WAIT"; notes.push(`Reward:risk ${plan.rewardRisk} is under 1.5, so TAKE became WAIT.`); }
  return { decision, probTargetPct: pT, probStopPct: pS, expectedValuePct: ev, evCalc: calc, hardStops: hard, notes };
}

// Long plan sanity: numbers in order and within believable distances; otherwise the reference plan is used.
export function checkPlan(d, plan, { maxEntryPct = 3 } = {}) {
  const p = plan || {}, price = d.price;
  const ok = [p.entryLow, p.entryHigh, p.stop, p.target1].every((x) => Number.isFinite(x) && x > 0)
    && p.entryLow <= p.entryHigh && p.stop < p.entryLow && p.target1 > p.entryHigh
    && Math.abs(pct(p.entryHigh, price)) <= maxEntryPct && pct(p.stop, p.entryHigh) >= -12 && pct(p.stop, p.entryHigh) <= -0.3 && pct(p.target1, p.entryHigh) <= 40;
  const ref = d.referencePlan;
  const use = ok ? p : { entryLow: ref.entryZone[0], entryHigh: ref.entryZone[1], stop: ref.stops.screenerRule, target1: ref.targets.screenerRule,
    target2: ref.targets.nearResistance, holdHours: (d.alert?.trackedAs || ruleFor(null)).holdHours };
  const mid = (use.entryLow + use.entryHigh) / 2;
  return {
    plan: { ...use, entryLow: sig(use.entryLow), entryHigh: sig(use.entryHigh), stop: sig(use.stop), target1: sig(use.target1),
      target2: Number.isFinite(use.target2) && use.target2 > use.target1 ? sig(use.target2) : null,
      stopPct: r(pct(use.stop, mid)), target1Pct: r(pct(use.target1, mid)), rewardRisk: r((use.target1 - mid) / (mid - use.stop)) },
    replaced: !ok,
  };
}

// Reward:risk and the target % with the target capped at the nearest resistance above the entry (the Final Boss's rule).
export function realisticPlan(d, plan) {
  const mid = (plan.entryLow + plan.entryHigh) / 2, res = Number(d.levels?.resistance);
  const target = res > mid && res < plan.target1 ? res : plan.target1;
  return { target: sig(target), targetPct: r(pct(target, mid)), rewardRisk: mid > plan.stop ? r((target - mid) / (mid - plan.stop)) : null, cappedAtResistance: target !== plan.target1 };
}

// The plan rule: the target shown is the one used for reward:risk, capped at the nearest resistance above the entry; the
// stop sits just below the nearest real support (levels.support or the 24h low) that is at least half a normal 1h move
// (and 0.3%) under the entry, never at a fixed percentage. With no such support within 11%, the plan's stop stays.
export function alignPlan(d, plan) {
  const lv = d.levels || {}, atr = Number(d.chart?.atrPct?.["1h"]) || 1, notes = [];
  let { stop, target1, target2 } = plan, stopAt = null;
  const res = Number(lv.resistance);
  if (res > plan.entryHigh * 1.002 && res < target1) {
    notes.push(`Target set at the nearest resistance ${sig(res)} (${lv.resistanceIs || "level"}) instead of ${sig(target1)}.`);
    target2 = target1; target1 = res;
  }
  const gap = Math.max(0.3, 0.5 * atr), level = [{ price: Number(lv.support), what: lv.supportIs || "support" }, { price: Number(lv.low24h), what: "24h low" }]
    .filter((x) => x.price > 0 && pct(x.price, plan.entryLow) <= -gap && pct(x.price, plan.entryLow) >= -11).sort((a, b) => b.price - a.price)[0];
  if (level) {
    const s = level.price * (1 - Math.max(0.1, 0.15 * atr) / 100);
    if (Math.abs(s / stop - 1) > 0.001) notes.push(`Stop set just below the nearest support ${sig(level.price)} (${level.what}): ${sig(s)} instead of ${sig(stop)}.`);
    stop = s; stopAt = { price: sig(level.price), what: level.what };
  } else notes.push(`No support at least ${r(gap)}% below the entry (within 11%): the plan's stop ${sig(stop)} is kept.`);
  const mid = (plan.entryLow + plan.entryHigh) / 2;
  return { plan: { ...plan, stop: sig(stop), target1: sig(target1), target2: Number.isFinite(target2) && target2 > target1 ? sig(target2) : null, stopAt,
    stopPct: r(pct(stop, mid)), target1Pct: r(pct(target1, mid)), rewardRisk: mid > stop ? r((target1 - mid) / (mid - stop)) : null }, notes };
}

// The final call after the Final Boss: YES = TAKE, WATCH = WAIT (with its triggers), NO = no trade. The code keeps the
// last word on safety: a YES needs no hard stop (the code's, confirmed news, or the boss's own), a coin that has not run
// and is igniting now, a plan that fits the price, realistic reward:risk of 2+ and expected value of +AI_MIN_EV_PCT after
// costs with the boss's chances (held within 15 points of the base rate); otherwise it becomes WATCH. If the boss cannot
// answer: the code's own call on the trader's plan, and never a YES.
const VERDICT_DECISION = { YES: "TAKE", WATCH: "WAIT", NO: "SKIP" };
export function finalVerdict(d, { boss, code, traderPlan, traderTrigger = null, dataPoor = false, minEv = MIN_EV_PCT }) {
  const notes = [];
  if (!boss?.available) {
    const decision = code.decision === "TAKE" ? "WAIT" : code.decision;
    notes.push(`The final boss could not answer (${boss?.reason || "unavailable"}), so this is the code's own call on the trader's plan${code.decision === "TAKE" ? ", never a YES without the boss: run it again in a minute" : ""}.`);
    return { decision, final: decision === "WAIT" ? "WATCH" : "NO", plan: traderPlan, probTargetPct: code.probTargetPct, probStopPct: code.probStopPct,
      expectedValuePct: code.expectedValuePct, evCalc: code.evCalc, realistic: realisticPlan(d, traderPlan), trigger: decision === "WAIT" ? traderTrigger : null, notes };
  }
  let verdict = boss.verdict, plan = traderPlan, planOk = true;
  if (verdict !== "NO") {
    const bp = boss.plan || {};
    const pc = bp.entryZone && bp.stop && bp.targets?.length ? checkPlan(d, { entryLow: bp.entryZone[0], entryHigh: bp.entryZone[1], stop: bp.stop, target1: bp.targets[0],
      target2: bp.targets[1] ?? null, holdHours: bp.maxHoldHours || traderPlan.holdHours }, { maxEntryPct: verdict === "WATCH" ? 10 : 3 }) : null;
    if (pc && !pc.replaced) { const al = alignPlan(d, pc.plan); plan = al.plan; notes.push(...al.notes); }
    else { planOk = false; notes.push(`The final boss's plan ${pc ? "did not fit the price levels" : "was incomplete"}, so the trader's plan is shown.`); }
  }
  const a = d.alert, c = boss.corrected || {};
  const held = (v, anchor, fallback) => clamp(Number.isFinite(v) ? v : fallback, Math.max(0, anchor - 15), Math.min(100, anchor + 15));
  const pT = held(c.pTargetPct, a.anchorProbTargetPct, code.probTargetPct);
  const pS = Math.min(held(c.pStopPct, a.anchorProbStopPct, code.probStopPct), 100 - pT);
  if ((Number.isFinite(c.pTargetPct) && pT !== c.pTargetPct) || (Number.isFinite(c.pStopPct) && pS !== c.pStopPct))
    notes.push(`The boss's chances were held within 15 points of this alert's base rate (${a.anchorProbTargetPct}% target / ${a.anchorProbStopPct}% stop).`);
  const real = realisticPlan(d, plan);
  const calc = evCalc({ pT, pS, targetPct: real.targetPct, stopPct: plan.stopPct, timeoutPct: a.timeout?.pct, timeoutFrom: a.timeout?.from, costPct: a.costPct }), ev = calc.ev;
  if (Number.isFinite(c.expectedValuePct) && Math.abs(c.expectedValuePct - ev) > 0.5)
    notes.push(`The boss's expected value (${c.expectedValuePct}%) differs from the code's: ${calc.formula}.`);
  if (verdict === "YES") {
    const why = [];
    if (code.hardStops.length) why.push(`hard stop (${code.hardStops.join("; ")})`);
    if (boss.hardStopFailures?.length) why.push("the boss itself listed a hard-stop failure");
    if (code.moved) why.push("the coin already ran");
    else if (!code.igniting) why.push("the coin is not igniting right now");
    if (!planOk) why.push("no usable plan from the boss");
    if (!(real.rewardRisk >= 2)) why.push(`realistic reward:risk ${real.rewardRisk} is under 2`);
    if (!(ev >= minEv)) why.push(`expected value ${ev}% is under +${minEv}%`);
    if (dataPoor) why.push("the data was rated poor");
    if (why.length) { verdict = "WATCH"; notes.push(`The final boss said YES, but the code made it WATCH: ${why.join("; ")}.`); }
  }
  const decision = VERDICT_DECISION[verdict];
  return { decision, final: verdict, plan, probTargetPct: pT, probStopPct: pS, expectedValuePct: ev, evCalc: calc, realistic: real,
    trigger: decision === "WAIT" ? triggerFromWatch(boss.watchTriggers, boss.watchExpiresHours, d.price) || traderTrigger : null, notes };
}

// ───────────────────────────── analysis ─────────────────────────────
const results = new Map(); // key -> { at, result }
const inflight = new Map();
const pickModel = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string" || !MODEL_PATTERN.test(v)) throw new AgentError("Invalid model name", 400);
  return v;
};

// The AI committee (ai-committee.js) around the code's guards: the data analyst and the news researcher work at the same
// time, the bull and the bear argue with their reports, the trader decides as referee, the code checks the trader's
// numbers (guards, plan, expected value, hard stops), and the Final Boss audits all of it and gives the final call
// (finalVerdict). 4 Gemini requests without the debate, 6 with it.
const newsOn = (opts) => opts.news !== false && env.AI_NEWS !== "0";
const debateOn = (opts) => opts.debate !== false && env.AI_DEBATE !== "0";
const flags = (opts) => (newsOn(opts) ? "n" : "-") + (debateOn(opts) ? "d" : "-");
// Fast path, OFF by default (the Final Boss runs on every analysis): with AI_FAST_NO=1, a coin checked by hand with no
// alert signal skips the debate, and when the trader and the code both say no trade, the Final Boss too. Alert reviews
// and trigger re-checks always get the full committee.
const noSignal = (d) => d.alert?.tier === "none" || !d.screener?.tier;
const fastPath = (d, opts) => (env.AI_FAST_NO === "1" || opts.fastNo === true) && opts.fastNo !== false && !["alert", "trigger"].includes(opts.source) && noSignal(d);
const noTradeWords = (t) => (typeof t === "string" ? t.replace(/\bSKIP\b/g, "NO TRADE") : t);
const CONF_CAP = { good: "high", partial: "medium", poor: "low" };

// Issues the code can see in the committee's work, handed to the Final Boss to audit one by one.
export function auditHints(d, { out, pc, dz, data, news, dbt, code }) {
  const h = [], a = d.alert || {}, sign = (v) => (v > 0 ? "+" : "") + v;
  if (news?.available && news.verified === false) h.push(`NEWS REPORT: no web search ran${news.requests > 1 ? " (asked twice)" : ""}, so the news is unknown and nothing from the model's memory is used`);
  if (!news?.available && !news?.off) h.push(`NEWS REPORT unavailable (${news?.error || "no answer"}): the news is unknown`);
  const mT = Math.round(Number(out.probTargetPct) - a.anchorProbTargetPct), mS = Math.round(Number(out.probStopPct) - a.anchorProbStopPct);
  if (Number.isFinite(mT) && Number.isFinite(mS)) h.push(mT || mS ? `TRADER moved the chances from the base rate by ${sign(mT)} points (target) and ${sign(mS)} (stop): check the evidence for each (probReason)`
    : `TRADER kept the base-rate chances (${a.anchorProbTargetPct}% / ${a.anchorProbStopPct}%): check whether the evidence should move them`);
  const real = code.realisticRewardRisk;
  if (real?.cappedAtResistance) h.push(`the plan's target ${pc.plan.target1} lies beyond the nearest resistance ${real.target} (${d.levels?.resistanceIs || "level"}): realistic R:R ${real.rewardRisk} instead of ${pc.plan.rewardRisk}`);
  if (!(real?.rewardRisk >= 2)) h.push(`realistic reward:risk ${real?.rewardRisk ?? "n/a"} is under 2`);
  h.push(`the code's expected value ${dz.expectedValuePct}% counts time-outs as flat (p_timeout = ${Math.max(0, 100 - dz.probTargetPct - dz.probStopPct)}%): give your own time-out estimate`);
  if (pc.replaced) h.push("the trader's plan did not fit the price, so the reference plan was used");
  if (!data?.available) h.push("the data analyst did not answer: data quality is unknown");
  else if (data.dataQuality?.rating !== "good") h.push(`data rated ${data.dataQuality?.rating} (${(data.dataQuality?.issues || []).length} issues): confidence at most ${CONF_CAP[data.dataQuality?.rating] || "medium"}`);
  if (dbt && !dbt.off && dbt.bull?.available && dbt.bull.strength <= 3) h.push(`the bull rated its own case ${dbt.bull.strength}/10: check whether it missed a stronger argument in the data`);
  const lc = d.orderBook?.liquidityCheck;
  if (lc) h.push(`liquidity test (orderBook.liquidityCheck): bids within 1% ${lc.bidsWithin1PctUsd != null ? `$${lc.bidsWithin1PctUsd}` : `not reached (${lc.note})`}, spread ${lc.spreadBps} bps: ${lc.passes === false ? "FAILS" : lc.passes ? "passes" : "unknown"}`);
  const missing = [d.marketFlow && d.marketFlow.available === false ? "market flow" : null, d.futures && d.futures.available === false ? "futures" : null,
    d.whales && d.whales.tracked === false ? "whale transfers" : null, d.dexFlows && d.dexFlows.tracked === false ? "DEX flows" : null].filter(Boolean);
  if (missing.length) h.push(`not tracked for this coin: ${missing.join(", ")}`);
  return h;
}
// Progress for the page while the committee works (opts.onStep): { id, status: working / done / failed / skipped, detail }.
// ids: dossier, data, news, bull, bear, trader, checks, boss. A broken listener never breaks an analysis.
const stepper = (opts) => (id, status, detail = "") => { try { opts.onStep?.({ id, status, detail: String(detail || "").slice(0, 200), at: Date.now() }); } catch { /* ignore */ } };
const newsDone = (x) => (!x.available ? x.error : x.cached ? `saved news from the last 30 minutes: ${x.riskLevel || "unknown"} risk`
  : x.status === "unknown" ? "unknown: no search came back" : `${x.riskLevel} risk · ${(x.items || []).length} relevant of ${x.evidence?.appResults ?? (x.sources || []).length} results`);
export async function runCommittee(ai, d, { desk, rules, identity, extraStops = () => [], opts }) {
  const hold = d.alert?.trackedAs?.holdHours || 24, fast = fastPath(d, opts), step = stepper(opts), relay = (e) => step(e.id, e.status, e.detail);
  step("data", "working", "checking the numbers");
  if (!newsOn(opts)) step("news", "skipped", "news search switched off");
  const [data, news] = await Promise.all([
    dataReview(ai, { desk, dossier: d, model: MODELS.analyst })
      .then((x) => (step("data", x.available ? "done" : "failed", x.available ? `data ${x.dataQuality?.rating} · ${(x.redFlags || []).length} red flags` : x.error), x)),
    newsResearch(ai, { identity, holdHours: hold, model: MODELS.analyst, enabled: newsOn(opts), onStep: relay, ...(opts.newsSearch ? { search: opts.newsSearch } : {}) })
      .then((x) => (newsOn(opts) && step("news", x.available ? "done" : "failed", newsDone(x)), x)),
  ]);
  const debating = debateOn(opts) && !fast;
  if (!debating) for (const id of ["bull", "bear"]) step(id, "skipped", fast ? "fast NO path: no alert signal" : "debate switched off");
  const dbt = await debate(ai, { desk, dossier: d, data, news, model: MODELS.analyst, enabled: debating, onStep: relay });
  if (fast && debateOn(opts)) dbt.skipped = "no alert signal: the fast path skips the debate";
  step("trader", "working", debating ? "judging the debate and deciding" : "deciding");
  let tr;
  try { tr = await traderDecision(ai, { desk, rules, schema: DECISION_SCHEMA, dossier: d, data, news, debate: dbt, model: opts.model }); }
  catch (e) { step("trader", "failed", e.message); throw e; }
  const out = tr.out;
  step("trader", "done", LABEL[out.decision] || out.decision);
  out.headline = noTradeWords(out.headline); out.thesis = noTradeWords(out.thesis);
  if (!dbt.off) dbt.verdict = out.debate && ["bull", "bear", "even"].includes(out.debate.winner) ? { winner: out.debate.winner, reason: out.debate.reason } : null;
  const g = applyGuards(d, out), pc = checkPlan(d, out.plan);
  if (pc.replaced) g.notes.push("The trader's plan did not fit the levels, so the reference plan is shown.");
  const al = alignPlan(d, pc.plan);
  pc.plan = al.plan; g.notes.push(...al.notes);
  const dz = decide(d, { ...out, decision: g.decision }, pc.plan);
  g.notes.push(...dz.notes);
  const extra = extraStops(d);
  if (extra.length && dz.decision !== "SKIP") { g.notes.push(`Hard stop: ${extra.join("; ")}. No trade.`); dz.decision = "SKIP"; }
  const pre = committeeChecks(dz.decision, { news, data });
  g.notes.push(...pre.notes);
  const hard = [...new Set([...(dz.hardStops || []), ...extra, ...(news.hardStop ? [`news: ${news.hardStopReason}`] : [])])];
  step("checks", "done", `EV ${dz.expectedValuePct > 0 ? "+" : ""}${dz.expectedValuePct}% · R:R ${pc.plan.rewardRisk}${hard.length ? ` · hard stop: ${hard[0]}` : " · no hard stop"}`);
  const checklist = Array.isArray(out.checklist) ? out.checklist.slice(0, 14) : [];
  // The Final Boss audits everything, whatever the trader decided (fast path: only when the trader or the code is not a no).
  const code = { decision: pre.decision, hardStops: hard, expectedValuePct: dz.expectedValuePct, evCalc: dz.evCalc, probTargetPct: dz.probTargetPct, probStopPct: dz.probStopPct,
    rewardRisk: pc.plan.rewardRisk, realisticRewardRisk: realisticPlan(d, pc.plan), costPct: d.alert.costPct, moved: !!d.screener?.moved, igniting: isIgniting(d),
    traderPlanReplaced: pc.replaced, notes: [...g.notes] };
  code.auditHints = auditHints(d, { out, pc, dz, data, news, dbt, code });
  const fastNo = fast && out.decision === "SKIP" && pre.decision === "SKIP";
  step("boss", fastNo ? "skipped" : "working", fastNo ? "fast NO: the trader and the code both say no trade" : "auditing the whole committee");
  const boss = fastNo ? { asked: false, skipped: "fast", verdict: null, reason: "Skipped: fast NO (no alert signal, and the trader and the code both say no trade; AI_FAST_NO=1 is on)." }
    : { asked: true, ...await finalBoss(ai, { desk, model: opts.reviewModel || MODELS.reviewer, fallbackModel: MODELS.analyst, onStep: relay, data, news, debate: dbt, dossier: d, code,
    trader: { decision: out.decision, confidence: out.confidence, setupScore: out.setupScore, probTargetPct: out.probTargetPct, probStopPct: out.probStopPct,
      probReason: out.probReason, plan: pc.plan, waitFor: out.waitFor, trigger: out.trigger || null, hardStopsNamed: out.hardStops, checklist, headline: out.headline,
      thesis: out.thesis, bullishPoints: out.bullishPoints, bearishPoints: out.bearishPoints, keyRisk: out.keyRisk, invalidation: out.invalidation, debateWinner: dbt.verdict || null } }) };
  if (boss.asked) step("boss", boss.available ? "done" : "failed", boss.available
    ? `${boss.verdict}${boss.agreesWithTrader ? "" : " (overturned the trader)"}${boss.fallbackFrom ? ` · answered by ${boss.model}` : ""}` : boss.reason);
  // The boss's confidence is capped by the data rating, and lowered one step when it audited nothing the code had flagged.
  if (boss.available) {
    const capTo = data.available ? CONF_CAP[data.dataQuality?.rating] || "medium" : "medium";
    if (LEVELS.indexOf(boss.confidence) > LEVELS.indexOf(capTo)) {
      g.notes.push(`The Final Boss said ${boss.confidence} confidence, but the data was ${data.available ? `rated ${data.dataQuality?.rating}` : "not checked"}: ${capTo} at most.`);
      boss.confidenceSaid = boss.confidence; boss.confidence = capTo;
    }
    if (!boss.auditFindings?.length && code.auditHints.length >= 2) {
      g.notes.push(`The Final Boss reported no audit findings although the code listed ${code.auditHints.length} issues for it: its confidence was lowered one step.`);
      boss.confidenceSaid ??= boss.confidence; boss.confidence = lower(boss.confidence);
    }
  }
  const fin = fastNo ? { decision: "SKIP", final: "NO", plan: pc.plan, probTargetPct: dz.probTargetPct, probStopPct: dz.probStopPct, expectedValuePct: dz.expectedValuePct, evCalc: dz.evCalc,
    realistic: realisticPlan(d, pc.plan), trigger: null, notes: [] }
    : finalVerdict(d, { boss, code, traderPlan: pc.plan, traderTrigger: cleanTrigger(out.trigger, d.price), dataPoor: !!data.available && data.dataQuality?.rating === "poor" });
  g.notes.push(...fin.notes);
  const confidence = boss.available ? LEVELS[Math.min(LEVELS.indexOf(g.confidence), Math.max(0, LEVELS.indexOf(boss.confidence)))] : lower(g.confidence);
  const watch = fin.final === "WATCH" && boss.available && boss.watchTriggers?.length ? { triggers: boss.watchTriggers, expiresHours: boss.watchExpiresHours } : null;
  return {
    decision: fin.decision, final: fin.final, modelDecision: out.decision, confidence, setupScore: clamp(Math.round(out.setupScore || 0), 0, 10),
    tier: d.alert.tier, probTargetPct: fin.probTargetPct, probStopPct: fin.probStopPct, expectedValuePct: fin.expectedValuePct, evCalc: fin.evCalc, realistic: fin.realistic, probReason: out.probReason,
    hardStops: [...new Set([...hard, ...(boss.hardStopFailures || []), ...(out.hardStops || [])])], checklist,
    headline: out.headline, thesis: out.thesis, bullishPoints: out.bullishPoints || [], bearishPoints: out.bearishPoints || [],
    plan: fin.plan, sizePct: boss.available && fin.final !== "NO" ? boss.plan?.sizePct ?? null : null,
    waitFor: watch ? `${watch.triggers.map((t) => `${t.condition} (${t.field} ${t.threshold})`).join("; ")}${watch.expiresHours ? `; within ${watch.expiresHours} hours` : ""}` : out.waitFor,
    watch, trigger: fin.trigger, invalidation: out.invalidation, keyRisk: out.keyRisk, guardNotes: g.notes, fastNo,
    committee: { data, news, debate: dbt, trader: { decision: out.decision, model: opts.model, ms: tr.ms, tokens: tr.tokens }, boss, auditHints: code.auditHints },
  };
}
// Which models ran, how many requests were made and the tokens they used (news from the 30-minute cache costs nothing).
function committeeMeta(opts, c, t0) {
  const { data, news, debate: dbt, trader, boss } = c.committee, fresh = (x) => x && !x.cached && x.tokens;
  const parts = [data, fresh(news) ? news : null, dbt.bull, dbt.bear, trader, boss.asked ? boss : null].filter((x) => x && x.tokens);
  return { model: opts.model, dataModel: MODELS.analyst, newsModel: news.off ? null : MODELS.analyst, debateModel: dbt.off ? null : MODELS.analyst,
    bossModel: boss.asked ? boss.model || opts.reviewModel || MODELS.reviewer : null,
    calls: 2 + (news.off || news.cached ? 0 : news.requests || 1) + (dbt.off ? 0 : 2) + (boss.asked ? 1 + (boss.fallbackFrom ? 1 : 0) : 0),
    tokens: ["in", "out", "think"].reduce((o, k) => ({ ...o, [k]: parts.reduce((s, x) => s + (x.tokens[k] || 0), 0) }), {}),
    deepThinking: env.AI_DEEP_THINKING !== "0", source: opts.source || "manual", depth: opts.depth || 0, durationMs: Date.now() - t0, at: Date.now(), cached: false };
}

async function analyzeOne(ai, symbol, opts) {
  const t0 = Date.now(), step = stepper(opts);
  step("dossier", "working", "prices, chart, order book, futures and flows");
  const d = await buildDossier(symbol, opts.tier || null).catch((e) => { step("dossier", "failed", e.message); throw e; });
  step("dossier", "done", `price ${d.price} · ${d.alert.label}`);
  const base = symbol.replace(/USDT$/, ""), info = assetInfo(base);
  const c = await runCommittee(ai, d, { desk: "spot", rules: RULES, identity: { symbol: base, name: info?.name || null }, opts });
  return { symbol, ...c, dossier: d, meta: committeeMeta(opts, c, t0) };
}

// The important fields only, for triaging many coins in one call.
const compact = (d) => ({
  symbol: d.symbol, price: d.price, alert: { tier: d.alert.tier, trackedAs: d.alert.trackedAs, anchorProbTargetPct: d.alert.anchorProbTargetPct, anchorProbStopPct: d.alert.anchorProbStopPct },
  screener: d.screener && { state: d.screener.state, tier: d.screener.tier, moved: d.screener.moved, stillNeeds: d.screener.stillNeeds?.slice(0, 3),
    ignitionScore: d.screener.ignitionScore, volume: d.screener.volume, buyersPct: d.screener.buyersPct, movePct: d.screener.movePct, dailyRsi: d.screener.dailyRsi },
  trend1h: d.chart.trend1h?.state, trend4h: d.chart.trend4h?.state, returnsPct: d.chart.returnsPct, atr1hPct: d.chart.atrPct["1h"],
  roomToResistancePct: d.levels.roomToResistancePct, distanceToSupportPct: d.levels.distanceToSupportPct, referenceRewardRisk: d.referencePlan.rewardRisk,
  marketFlow: d.marketFlow?.available ? { flowScore: d.marketFlow.flowScore, buyRatio5mPct: d.marketFlow.buyRatio5mPct, netFlow5mUsd: d.marketFlow.netFlow5mUsd,
    lastMinuteVolumeVsAvg: d.marketFlow.lastMinuteVolumeVsAvg, smartMoneySignals: d.marketFlow.smartMoneyWallets.matchingSignals.length } : null,
  orderBook: d.orderBook.bands ? { spreadBps: d.orderBook.spreadBps, imbalance: d.orderBook.bands.map((b) => [b.withinPct, b.imbalance]) } : null,
  futures: d.futures.available ? { fundingPctPer8h: d.futures.fundingPctPer8h, oiChange24hPct: d.futures.oiChange24hPct, longShort: d.futures.longShortAccountRatio } : null,
  whaleNetToExchanges24h: d.whales.tracked && d.whales.transfers24h ? Math.round(d.whales.netToExchanges24h) : null,
  dexNet24h: d.dexFlows.tracked ? d.dexFlows.last24h.netUsd : null,
});

async function analyzeMany(ai, symbols, opts) {
  const t0 = Date.now(), dossiers = [], failed = [];
  for (let i = 0; i < symbols.length; i += 3) { // fresh data, three coins at a time
    const got = await Promise.allSettled(symbols.slice(i, i + 3).map((s) => buildDossier(s)));
    got.forEach((g, j) => (g.status === "fulfilled" ? dossiers.push(g.value) : failed.push({ symbol: symbols[i + j], error: g.reason.message })));
  }
  if (!dossiers.length) throw new AgentError("Could not load market data for any coin", 502);
  const first = dossiers[0];
  const res = await generate(ai, {
    model: opts.model,
    contents: `MARKET (JSON)\n${JSON.stringify(first.market)}\n\nLIVE PERFORMANCE (JSON)\n${JSON.stringify(first.livePerformance)}\n\nCOST PER TRADE: ${first.alert.costPct}%\n\nCOINS (JSON)\n${JSON.stringify(dossiers.map(compact))}\n\nTriage every coin.`,
    config: { systemInstruction: TRIAGE_SYSTEM, ...roleConfig(opts.model, "triage"), responseMimeType: "application/json", responseSchema: TRIAGE_SCHEMA },
  });
  const out = jsonFrom(res, "Triage");
  const bySym = new Map((out.coins || []).map((c) => [String(c.symbol).toUpperCase().replace(/USDT$/, "") + "USDT", c]));
  const coins = dossiers.map((d) => {
    const c = bySym.get(d.symbol) || { decision: "SKIP", confidence: "low", setupScore: 0, reason: "The model did not return this coin.", keyRisk: "" };
    const g = applyGuards(d, c), rule = d.alert.trackedAs;
    const dz = decide(d, { ...c, decision: g.decision }, { target1Pct: rule.targetPct, stopPct: -rule.stopPct, rewardRisk: d.referencePlan.rewardRisk.ruleTargetRuleStop });
    return { symbol: d.symbol, price: d.price, tier: d.alert.tier === "none" ? null : d.alert.tier, state: d.screener?.state || "none", decision: dz.decision, modelDecision: c.decision,
      confidence: g.confidence, setupScore: clamp(Math.round(c.setupScore || 0), 0, 10), reason: c.reason, keyRisk: c.keyRisk, guardNotes: [...g.notes, ...dz.notes],
      probTargetPct: dz.probTargetPct, probStopPct: dz.probStopPct, expectedValuePct: dz.expectedValuePct,
      referenceRewardRisk: d.referencePlan.rewardRisk.ruleTargetRuleStop };
  });
  const order = { TAKE: 0, WAIT: 1, SKIP: 2 };
  coins.sort((a, b) => order[a.decision] - order[b.decision] || b.setupScore - a.setupScore);
  return { marketView: out.marketView, coins, failed, meta: { model: opts.model, durationMs: Date.now() - t0, at: Date.now(), cached: false } };
}

// Every fresh analysis is remembered per coin for the "AI: TAKE" tabs (Alpha tokens under "A:" + their Alpha id).
function remember(result) {
  const at = result?.meta?.at || Date.now();
  if (result?.committee) tracker.record(result, { source: result.meta?.source || "manual", depth: result.meta?.depth || 0 });
  if (result?.kind === "alpha") noteAiVerdict("A:" + (result.dossier?.alpha?.token?.alphaId || result.alphaId || result.symbol), { ...result, at });
  else if (result?.decision && result.symbol) noteAiVerdict(result.symbol, { ...result, at });
  for (const c of result?.coins || []) noteAiVerdict(c.symbol, { ...c, at });
}
// run(emit) does the work and reports progress through emit; listener gets that progress. A second request for an
// analysis that is already running joins it: it gets the steps so far, then the rest live.
function cached(key, ttl, refresh, run, listener = null) {
  const hit = results.get(key);
  if (!refresh && hit && Date.now() - hit.at < ttl) return Promise.resolve({ ...hit.result, meta: { ...hit.result.meta, cached: true } });
  const live = inflight.get(key);
  if (live) { if (listener) { live.history.forEach(listener); live.listeners.add(listener); } return live.promise; }
  const job = { listeners: new Set(listener ? [listener] : []), history: [] };
  const emit = (e) => { job.history.push(e); for (const l of job.listeners) { try { l(e); } catch { /* a closed page */ } } };
  job.promise = run(emit).then((result) => { results.set(key, { at: Date.now(), result }); if (results.size > 80) results.delete(results.keys().next().value); remember(result); return result; })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job.promise;
}

// ───────────────────────────── track record, WAIT triggers, daily limit ─────────────────────────────
// Every committee answer is followed with its own plan; WAIT triggers are watched and, when one hits, the committee checks
// the coin again (from the daily budget) and Telegram gets the new answer. AI_DAILY_REQUESTS (default 400, 0 = no limit)
// caps Gemini requests per UTC day for automatic work; your own analyses always run.
const DAILY_LIMIT = env.AI_DAILY_REQUESTS === "0" ? 0 : Math.max(1, Math.trunc(Number(env.AI_DAILY_REQUESTS)) || 400);
const FULL_RUN = 6; // the most requests one analysis can make
let aiClient = null;
async function barsFor(x, { interval, startTime, limit }) {
  if (x.kind === "alpha") {
    const j = await fetchJson(alphaKlinesUrl(x.alphaId, { interval, startTime, limit, quote: x.quote || "USDT" }), { retries: 1, timeoutMs: 12_000 });
    return { barMs: TF[interval], bars: parseKlines(j?.data ?? j).map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4] })) };
  }
  const raw = await fetchJson(`${BN}/api/v3/klines?symbol=${encodeURIComponent(x.symbol)}&interval=${interval}&startTime=${startTime}&limit=${limit}`, { retries: 1 });
  return { barMs: TF[interval], bars: (Array.isArray(raw) ? raw : []).map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) })) };
}
async function onTriggerHit(tr) {
  const coin = tr.symbol.replace(/USDT$/, ""), mins = Math.max(1, Math.round((tr.hitAt - tr.armedAt) / MIN));
  const head = `⏰ AI TRIGGER HIT: ${coin} ${tr.event === "breakout" ? `closed above ${tr.price} (${tr.timeframe})` : `dipped to ${tr.price}`}, ${mins} min after the AI said WAIT.`;
  if (!aiClient || !tracker.canSpend(FULL_RUN)) {
    const why = aiClient ? "today's AI limit is reached" : "Gemini is not set up";
    await telegram(`${head}\nNo fresh AI check: ${why}. Check the chart yourself.`, { kind: "ai" });
    return { checked: false, reason: why, at: Date.now() };
  }
  const opts = { model: MODELS.analyst, reviewModel: MODELS.reviewer, news: true, debate: true, source: "trigger", depth: (tr.depth || 0) + 1, tier: tr.tier };
  const out = await cached(`trig:${tr.id}`, RESULT_TTL, true, (emit) => (tr.kind === "alpha" ? analyzeAlpha(aiClient, tr.alphaId, { ...opts, onStep: emit }) : analyzeOne(aiClient, tr.symbol, { ...opts, onStep: emit })));
  await telegram(`${head}\n${tgSingle(out, "(fresh committee check)")}`, { kind: "ai" });
  return { checked: true, decision: out.decision, final: out.final, headline: out.headline, at: Date.now() };
}
const tracker = createAiTracker({
  file: env.SCREENER_LIBRARY_ONLY === "1" ? null : fileURLToPath(new URL("./ai_calls.json", import.meta.url)), bars: barsFor, dailyLimit: DAILY_LIMIT, onTriggerHit,
  onWarn: (level, u) => telegram(`AI DESK: ${u.requests} of ${u.limit} Gemini requests used today (UTC)${level >= 2
    ? ". The daily limit is reached: automatic reviews and trigger re-checks pause until midnight UTC; your own analyses still run. Raise AI_DAILY_REQUESTS in .env if needed."
    : " (80%)."}`, { kind: "ai" }),
});
// Counts every Gemini request and its tokens (wraps the client once, in server.js).
export function meterAi(client) {
  if (!client) return client;
  const gen = client.models.generateContent.bind(client.models);
  const models = Object.create(client.models, { generateContent: { value: async (params) => {
    tracker.countRequest();
    const res = await gen(params);
    tracker.countTokens(usage(res));
    return res;
  } } });
  return Object.create(client, { models: { value: models } });
}
// Room for one more automatic analysis today? (server.js checks it before each automatic review)
export const aiCanSpend = () => tracker.canSpend(FULL_RUN);
// Starts following calls (every 2 minutes) and watching WAIT triggers (every minute).
export function startAiDesk(client) { aiClient = client; return tracker.start(); }
export const aiTracker = tracker;

// ───────────────────────────── Telegram ─────────────────────────────
// Shared queue (telegram.js): retried until delivered. Default: you asked for it (the "send to Telegram" box), so it is
// sent even if AI verdicts are switched off; automatic reviews pass { kind: "ai" } and follow that switch.
const telegram = (text, opts = { kind: "ai", force: true }) => sendTelegram(text, opts);
export const LABEL = { TAKE: "TAKE", WAIT: "WAIT", SKIP: "NO TRADE" };
const ICON = { TAKE: "🟢", WAIT: "🟡", SKIP: "🔴" };
const FINAL_LABEL = { YES: "YES", WATCH: "WATCH", NO: "NO TRADE" };
export const tgSingle = (x, intro = "") => [`${ICON[x.decision] || ""} ${x.final ? FINAL_LABEL[x.final] || x.final : LABEL[x.decision] || x.decision}: ${x.symbol.replace(/USDT$/, "")}${intro ? " " + intro : ""}`,
  x.headline, x.committee ? tgCommittee(x) : null,
  `Chance: ${x.probTargetPct}% target / ${x.probStopPct}% stop · expected ${x.expectedValuePct >= 0 ? "+" : ""}${x.expectedValuePct}% per trade · ${x.confidence} confidence · setup ${x.setupScore}/10`,
  x.evCalc ? `EV = ${x.evCalc.formula}` : null,
  x.decision === "TAKE" ? `Entry ${x.plan.entryLow}-${x.plan.entryHigh} | stop ${x.plan.stop} (${x.plan.stopPct}%) | target ${x.plan.target1} (+${x.plan.target1Pct}%) | R:R ${x.realistic?.rewardRisk ?? x.plan.rewardRisk} | hold ${x.plan.holdHours}h${x.sizePct != null ? ` | size ${x.sizePct}% of normal` : ""}` : null,
  x.decision === "WAIT" && x.waitFor ? `${x.watch ? "Watch for" : "Trigger"}: ${x.waitFor}` : null,
  x.decision === "WAIT" && x.watch ? `Plan if it triggers: entry ${x.plan.entryLow}-${x.plan.entryHigh} | stop ${x.plan.stop} | target ${x.plan.target1}${x.sizePct != null ? ` | size ${x.sizePct}% of normal` : ""}` : null,
  x.decision === "WAIT" && x.trigger ? `Watching: ${x.trigger.event === "breakout" ? `a ${x.trigger.timeframe} close above ${x.trigger.price}` : `a dip to ${x.trigger.price}`} for ${x.trigger.expiresMinutes} min; the AI checks again if it happens.` : null,
  x.hardStops?.length ? `Hard stop: ${x.hardStops.join("; ")}` : null, `Key risk: ${x.keyRisk}`,
  x.committee?.news?.available && x.committee.news.status !== "unknown" && x.committee.news.items?.length ? `News: ${x.committee.news.summary}` : null,
  "AI opinion on screener data. Research only, not financial advice."].filter(Boolean).join("\n");

// "bull 7 vs bear 5, bear won" (the strengths are the sides' own scores; the winner is the trader's call).
const debateLine = (dbt) => (!dbt || dbt.off ? null
  : `bull ${dbt.bull?.available ? dbt.bull.strength : "n/a"} vs bear ${dbt.bear?.available ? dbt.bear.strength : "n/a"}${dbt.verdict ? `, ${dbt.verdict.winner === "even" ? "even" : dbt.verdict.winner + " won"}` : ""}`);
// One line on how each member voted (data quality, news risk, the debate, the trader, the Final Boss), then the boss's
// summary and the factor that decided it.
const bossVote = (b) => (!b?.asked ? (b?.skipped === "fast" ? "skipped (fast NO)" : "not asked") : !b.available ? "no answer" : `${b.verdict}${b.agreesWithTrader ? "" : " (overturned the trader)"}`);
const tgCommittee = (x) => {
  const { data, news, debate: dbt, trader, boss } = x.committee;
  return [[`Final: ${x.final || (x.decision === "TAKE" ? "YES" : "NO")}${x.fastNo ? " (fast NO)" : ""}`, `data ${data?.available ? data.dataQuality?.rating : "n/a"}`,
    `news ${news?.available ? (news.status === "unknown" ? "unknown" : `${news.riskLevel} risk`) : news?.off ? "off" : "n/a"}`, debateLine(dbt), `trader ${LABEL[trader?.decision] || "?"}`,
    `boss ${bossVote(boss)}`].filter(Boolean).join(" · "),
    boss?.available && boss.summary ? `Boss: ${boss.summary}` : null, boss?.available && boss.decidingFactor ? `Deciding factor: ${boss.decidingFactor}` : null].filter(Boolean).join("\n");
};

// What is saved with an alert after its automatic review: the call, the numbers and how each committee member voted.
const reviewSummary = (out, tg) => {
  const c = out.committee || {};
  return { decision: out.decision, final: out.final, confidence: out.confidence, setupScore: out.setupScore, headline: out.headline, rewardRisk: out.plan.rewardRisk,
    probTargetPct: out.probTargetPct, probStopPct: out.probStopPct, expectedValuePct: out.expectedValuePct, model: out.meta.model, at: Date.now(),
    committee: { data: c.data?.available ? c.data.dataQuality?.rating : null, news: c.news?.available ? (c.news.status === "unknown" ? "unknown" : c.news.riskLevel) : null, newsHardStop: !!c.news?.hardStop,
      debate: debateLine(c.debate), debateWinner: c.debate?.verdict?.winner || null,
      trader: c.trader?.decision || null, boss: c.boss?.available ? c.boss.verdict : null, bossAgrees: c.boss?.available ? c.boss.agreesWithTrader : null,
      bossSummary: c.boss?.available ? c.boss.summary : c.boss?.reason || null }, sizePct: out.sizePct ?? null,
    telegram: tg ? (tg.sent ? "sent" : tg.error || tg.skipped) : null };
};

// Automatic review of a new screener alert (called by server.js): the full committee with the default models, a short
// summary saved with the alert, and a Telegram follow-up while "AI verdicts" are switched on (default; AI_REVIEW_TELEGRAM=0 = off).
export async function reviewAlert(ai, symbol, tier = null) {
  const opts = { model: MODELS.analyst, reviewModel: MODELS.reviewer, news: true, debate: true, source: "alert", tier: tier === "ignition" ? "confirmed" : tier };
  const out = await cached(`one:${symbol}:${opts.model}:${opts.reviewModel}:${flags(opts)}:${opts.tier || ""}`, RESULT_TTL, false, (emit) => analyzeOne(ai, symbol, { ...opts, onStep: emit }));
  const tg = telegramWants("ai") && !out.meta.cached ? await telegram(tgSingle(out, `(AI review of the new ${out.tier === "none" ? "" : out.tier + " "}alert)`), { kind: "ai" }) : null;
  return reviewSummary(out, tg);
}

// ───────────────────────────── Binance Alpha tokens ─────────────────────────────
// Alpha tokens are on-chain DEX tokens (not spot pairs): no order book, no futures, no taker side. The dossier uses
// Alpha's own 1h / 4h candles, DexScreener buys vs sells, pool liquidity, holders and supply, and the Alpha tab's
// replay and live results. The same guards decide the call (expected value, reward:risk, hard stops), with the
// Alpha alert's own rule (+40% before -10% within 7 days by default) and its 1% costs.
const ALPHA_REPLAY = {
  confirmed: { hitTargetPct: 16.7, hitStopPct: 65, avgNetPct: 0.56, source: "60-day replay of every Binance Alpha token not on spot (alpha-backtest.js), Aug 29 - Oct 28 2026" },
  early: { hitTargetPct: 11.2, hitStopPct: 59, avgNetPct: -1.23, source: "60-day replay of every Binance Alpha token not on spot (alpha-backtest.js), Aug 29 - Oct 28 2026",
    note: "no better than buying at a random time" },
};
const ALPHA_RULES = `
You decide whether to buy one Binance Alpha token RIGHT NOW: an early on-chain token traded in Binance Wallet / Binance
Alpha, with a thin DEX pool. Long only, no leverage. The default answer is SKIP (no trade): most Alpha volume ignitions
fade, pools are thin (a market order moves the price) and tokens can be delisted.

Use ONLY the DOSSIER (and your colleagues' reports when you have them) and quote its numbers exactly. Never invent
prices, levels, news or data. null means unknown, and unknown is not good news. There is no order book and no futures data for these tokens.

Work through these steps in order and show them in your answer:
1. HARD STOPS. If any one applies, the answer is SKIP: already up more than 30% in 24 hours (screener.moved); BTC down
   more than 1% in 1h or 2% in 4h; DEX sellers in control (alpha.dex buyers under 40% over 5 minutes and under 45% over
   1 hour); pool liquidity under $50k. List the ones that apply in hardStops (empty if none).
2. CHECKLIST, each pass / fail / unknown with the dossier number that decides it: trigger (alert tier, volume vs normal,
   dollars and trades per candle, 24h volume), DEX buying (alpha.dex buys vs sells, 5 min and 1 hour), trend (1h and 4h),
   room (distance to resistance vs distance to the stop), liquidity and holders (pool size vs a normal order, holders),
   supply (circulating share, FDV vs market cap), market (BTC, alt season meter, BTC regime), track record
   (livePerformance: THIS tier only; if it says "no track record for this tier", write that and use the base rate only).
3. PROBABILITY. Start from alert.anchorProbTargetPct and alert.anchorProbStopPct; move them only for checklist evidence,
   at most 15 points each way, and say which items moved them.
4. EXPECTED VALUE per trade = P_target x target% - P_stop x stop% + P_timeout x alert.timeout.pct - alert.costPct
   (P_timeout = 100 - P_target - P_stop); write the full calculation in probReason. The code recomputes it.
5. DECIDE. TAKE only with no hard stop, expected value of at least +0.5% per trade, reward:risk 1.5+ and price inside the
   entry zone now (the Final Boss wants 2+ with the target capped at levels.resistance). WAIT must name a price level, a condition and a time limit, with the same price event in trigger
   (breakout or pullback, timeframe, minutes): the code watches it and asks the committee again. SKIP for everything else.
6. PLAN. Entry from dossier.price; stop just below the nearest real support (levels.support or levels.low24h), never a
   fixed percentage; target 1 at or below the nearest resistance (levels.resistance); holding time from alert.trackedAs.
   Keep the position small next to the pool (alpha.liquidityNote) and risk at most 1% of the account.
Be concise and concrete.`.trim();

const alertMatching = (a, tier) => { try { return a ? alphaMatchingFor(a, tier) : []; } catch { return []; } };
async function alphaCandles(id, interval, limit, quote) {
  const j = await fetchJson(alphaKlinesUrl(id, { interval, limit, quote }), { retries: 1, timeoutMs: 12_000 });
  return parseKlines(j?.data ?? j).map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], qv: k[5] }));
}
// Alpha dossier. alert = the Alpha alert being reviewed (its numbers at alert time), or null for a manual check now.
export async function buildAlphaDossier(key, alert = null) {
  const tok = alphaTokenFor(alert?.alphaId || key);
  if (!tok && !alert) throw new AgentError(`${key}: not in the Alpha tab's current scan (only tokens it scans can be analysed)`, 404);
  const snap = screenerSnapshot(), aSnap = alphaSnapshot() || {}, cfg = aSnap.config || { targetPct: 40, stopPct: 10, outcomeDays: 7, costPct: 1, maxChg24Pct: 30 };
  const token = alert?.token || tok, f = alert?.f || tok?.f || {}, dex = alert?.dex || tok?.dex || null, tier = alert?.tier || tok?.tier || null;
  const id = token.alphaId || alert?.alphaId, quote = tok?.quote || "USDT";
  const [h1, h4] = await Promise.all([alphaCandles(id, "1h", 72, quote), alphaCandles(id, "4h", 42, quote)]);
  if (h1.length < 24) throw new AgentError(`${token.symbol}: not enough Alpha candle history`, 502);
  const price = alert ? f.close : (h1[h1.length - 1]?.c || tok.price);
  const atr1h = atrPct(h1), d1 = hiLo(h1.slice(-24)), d3 = hiLo(h1), d7 = h4.length ? hiLo(h4) : d3;
  const lv = keyLevels(price, h1, h4, [{ price: d1.high, what: "24h high" }, { price: d3.high, what: "3-day high" }, { price: d7.high, what: "7-day high" }],
    [{ price: d1.low, what: "24h low" }, { price: d3.low, what: "3-day low" }]);
  const resistance = lv.resistance?.price ?? null, support = lv.support?.price ?? null;
  const ret = (cs, n) => (cs.length > n ? r(pct(cs[cs.length - 1].c, cs[cs.length - 1 - n].c)) : null);
  const R = aSnap.replay, res = aSnap.results ? { confirmed: aSnap.results, early: aSnap.resultsEarly } : {};
  const t = tier === "confirmed" ? "confirmed" : "early";
  const base = t === "confirmed" && R?.rule?.n ? { hitTargetPct: r(R.rule.winPct, 1), hitStopPct: r(R.rule.lossPct, 0), avgNetPct: r(R.rule.net), source: ALPHA_REPLAY.confirmed.source }
    : t === "early" && R?.planned?.n ? { hitTargetPct: r(R.planned.winPct, 1), hitStopPct: r(R.planned.lossPct, 0), avgNetPct: r(R.planned.net), source: ALPHA_REPLAY.early.source, note: ALPHA_REPLAY.early.note }
    : ALPHA_REPLAY[t];
  const live = res[t], useLive = live?.closed >= 30;
  const alertCtx = {
    tier: t, label: tier ? `Alpha ${t} ignition` : "Alpha token, no ignition right now", trackedAs: { targetPct: cfg.targetPct, stopPct: cfg.stopPct, holdHours: cfg.outcomeDays * 24 },
    costPct: cfg.costPct, baseRate: base, live: live?.closed ? { resolved: live.closed, hitTargetPct: live.winPct, hitStopPct: r((live.losses / live.closed) * 100, 0), avgNetPct: live.avgNetPct } : null,
    anchorProbTargetPct: Math.round(useLive ? live.winPct : base.hitTargetPct), anchorProbStopPct: Math.round(useLive ? (live.losses / live.closed) * 100 : base.hitStopPct),
    anchorFrom: useLive ? "live results" : "replay", timeout: timeoutFor("alpha", t, null),
  };
  const stopRule = price * (1 - cfg.stopPct / 100), tRule = price * (1 + cfg.targetPct / 100);
  const stopStructure = support && pct(support, price) > -12 ? support * (1 - (0.15 * (atr1h || 1)) / 100) : null;
  const tRes = resistance && pct(resistance, price) < cfg.targetPct && resistance * 0.997 > price * 1.002 ? resistance * 0.997 : null;
  const rr = (stop, target) => (stop && target && price > stop ? r((target - price) / (price - stop)) : null);
  const order = 1000, poolShare = token.liquidity > 0 ? r((order / token.liquidity) * 100, 2) : null;
  const moved = f.chg24 > (cfg.maxChg24Pct ?? 30);
  const mctx = snap.regime || {};
  return {
    symbol: token.symbol, asOf: new Date().toISOString(), price: sig(price), alert: alertCtx,
    dataQuality: { demo: false, notes: [alert ? `Reviewed with the numbers at alert time (${new Date(alert.t).toISOString()}); candles are fresh.` : "Manual check with the latest scan."] },
    screener: { state: alert ? "ignited" : tok?.state || "quiet", tier: tier ? t : null, moved, movedWhy: moved ? [`up ${f.chg24}% in 24 hours`] : [], stillNeeds: alert ? [] : (tok?.fails || []).slice(0, 4) },
    alpha: {
      token: { alphaId: id, symbol: token.symbol, name: token.name, chain: token.chain, contract: token.contract || null, quote, liquidityUsd: token.liquidity, holders: token.holders, marketCapUsd: token.mcap, fdvUsd: token.fdv,
        circulatingPct: token.circPct, daysOnAlpha: token.ageDays, volume24hUsd: token.vol24 },
      signal: { volumeVsNormal: [f.r1, f.r2], usdPer5m: [f.usd1, f.usd2], tradesPer5m: [f.trades1, f.trades2], move10mPct: f.move10, change1hPct: f.chg1h, change24hPct: f.chg24, volume24hUsd: f.qv24 },
      dex: dex ? { buys5m: dex.m5?.buys, sells5m: dex.m5?.sells, buyers5mPct: dex.buyShare5m, buyers1hPct: dex.buyShare1h, poolLiquidityUsd: dex.liquidity, dex: dex.dex } : { available: false },
      liquidityNote: poolShare != null ? `a $${order} order is about ${poolShare}% of the pool; keep orders well under 1% of it` : null,
    },
    chart: { trend1h: trendOf(h1), trend4h: h4.length >= 21 ? trendOf(h4) : null, returnsPct: { "1h": ret(h1, 1), "4h": ret(h1, 4), "24h": ret(h1, 24), "3d": ret(h1, 71) }, atrPct: { "1h": r(atr1h) } },
    levels: { resistance: sig(resistance), resistanceIs: lv.resistance?.what || null, roomToResistancePct: r(pct(resistance, price)), support: sig(support),
      supportIs: lv.support?.what || null, distanceToSupportPct: r(pct(support, price)), overhead: lv.overhead, underneath: lv.underneath,
      high24h: sig(d1.high), low24h: sig(d1.low), high3d: sig(d3.high), low3d: sig(d3.low), high7d: sig(d7.high), low7d: sig(d7.low) },
    marketFlow: { available: false }, orderBook: { available: false },
    market: { btcChange24hPct: mctx.btcChange24hPct, btc1hPct: mctx.btc1hPct, btc4hPct: mctx.btc4hPct, marketWideSurge: false,
      altSeason: alert?.ctx?.altSeason ?? null, btcRegime: alert?.ctx?.btcRegime ?? null },
    livePerformance: performanceFor({ tier: t, live: live?.closed ? { resolved: live.closed, winPct: live.winPct, avgNetPct: live.avgNetPct } : null,
      groups: alertMatching(alert || (tok ? { ...tok, token: tok } : null), t), committee: tracker.trackRecord("alpha", t) }),
    referencePlan: { entry: sig(price), entryZone: [sig(price * 0.995), sig(price)], stops: { screenerRule: sig(stopRule), belowSupport: sig(stopStructure) },
      targets: { screenerRule: sig(tRule), nearResistance: sig(tRes), twoR: sig(price + 2 * (price - stopRule)) },
      rewardRisk: { ruleTargetRuleStop: rr(stopRule, tRule), resistanceRuleStop: rr(stopRule, tRes) } },
  };
}
export function alphaHardStops(d) {
  const out = [], dx = d.alpha?.dex, liq = d.alpha?.token?.liquidityUsd;
  if (dx && dx.buyers5mPct != null && dx.buyers5mPct < 40 && (dx.buyers1hPct ?? 0) < 45) out.push(`DEX sellers in control (${dx.buyers5mPct}% buyers over 5 min, ${dx.buyers1hPct ?? "n/a"}% over 1h)`);
  if (liq != null && liq < 50_000) out.push(`pool liquidity only $${Math.round(liq)}`);
  return out;
}
async function analyzeAlpha(ai, key, opts) {
  const t0 = Date.now(), step = stepper(opts);
  step("dossier", "working", "Alpha candles, DEX buyers and sellers, pool, holders");
  const d = await buildAlphaDossier(key, opts.alert || null).catch((e) => { step("dossier", "failed", e.message); throw e; }), t = d.alpha.token;
  step("dossier", "done", `price ${d.price} · ${d.alert.label}`);
  const c = await runCommittee(ai, d, { desk: "alpha", rules: ALPHA_RULES, identity: { symbol: d.symbol, name: t.name, chain: t.chain, contract: t.contract }, opts,
    extraStops: alphaHardStops });
  return { symbol: d.symbol, alphaId: t.alphaId, kind: "alpha", ...c, dossier: d, meta: committeeMeta(opts, c, t0) };
}
// Automatic review of a new Alpha alert (server.js), saved with the alert. Telegram follow-up only when Alpha alerts
// go to Telegram and AI verdicts are switched on.
export async function reviewAlpha(ai, alert) {
  const telegramOn = telegramWants("ai") && telegramWants(alert.tier === "confirmed" ? "alpha" : "alphaEarly");
  const out = await cached(`alpha:${alert.id}`, RESULT_TTL, false, () => analyzeAlpha(ai, alert.alphaId, { model: MODELS.analyst, reviewModel: MODELS.reviewer, news: true, debate: true, source: "alert", alert }));
  const tg = telegramOn && !out.meta.cached
    ? await telegram(tgSingle({ ...out, symbol: out.symbol }, `(AI review of the new Alpha ${alert.tier} alert)`), { kind: "ai" }) : null;
  return reviewSummary(out, tg);
}

// ───────────────────────────── API ─────────────────────────────
const jsonResponse = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};
// { "stream": true }: the answer comes as lines of JSON (application/x-ndjson) while the committee works:
// { type: "step", id, status, detail, at } for each member, a ping every 15 seconds, then { type: "result", data } or
// { type: "error", error }.
export async function streamJob(res, work) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
  res.on("error", () => {});
  const send = (o) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + "\n"); };
  const ping = setInterval(() => send({ type: "ping", at: Date.now() }), 15_000);
  try { send({ type: "result", data: await work((e) => send({ type: "step", ...e })) }); }
  catch (e) {
    const known = e instanceof AgentError;
    if (!known) console.error("AI trade desk:", e);
    send({ type: "error", error: known ? e.message : `AI analysis failed: ${e.message}` });
  } finally { clearInterval(ping); res.end(); }
}
// Paid calls only from this site: JSON content type (blocks plain cross-site form posts) and a same-host Origin.
const allowedWrite = (req) => String(req.headers["content-type"] || "").includes("application/json") &&
  (!req.headers.origin || req.headers.origin.replace(/^https?:\/\//, "") === req.headers.host);

function candidatesView(ai) {
  const snap = screenerSnapshot();
  const order = { ignited: 0, heating: 1, ran: 2 };
  const list = (snap.candidates || []).filter((c) => c.ignition)
    .sort((a, b) => order[a.ignition] - order[b.ignition] || (b.igScore || 0) - (a.igScore || 0) || (b.rvol15 || 0) - (a.rvol15 || 0)).slice(0, 30);
  const verdicts = freshAiVerdicts();
  const lastFor = (sym) => {
    for (const [k, v] of results) if (k.startsWith(`one:${sym}:`)) return { decision: v.result.decision, confidence: v.result.confidence, at: v.at };
    const x = verdicts[sym.replace(/USDT$/, "")]; // e.g. the automatic review of an alert
    return x ? { decision: x.decision, confidence: null, at: x.at } : null;
  };
  return {
    configured: !!ai, demo: !!snap.demo, screenerStatus: snap.status, models: MODELS, telegramConfigured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    market: { btcChange24hPct: snap.regime?.btcChange24hPct, btc1hPct: snap.regime?.btc1hPct, btc4hPct: snap.regime?.btc4hPct, marketWide: !!snap.breadth?.marketWide },
    baseRates: { replay: REPLAY, live: snap.stats?.current?.byTier || null },
    coins: list.map((c) => ({
      symbol: c.symbol, base: c.base, state: c.ignition, tier: c.ignition === "ignited" ? ((c.igScore ?? 0) >= CONFIG.igniteMinScore ? "confirmed" : "early") : null,
      igScore: c.igScore, score: c.score, price: c.price, change24h: c.change24h, ret10m: c.ret10m, r5: c.r5, prevR5: c.prevR5, rvol15: c.rvol15,
      buy10: c.buyRatio10m, rsi: c.rsi, moved: c.moved, missing: (c.missing || []).slice(0, 3), movedWhy: c.movedWhy, narrative: c.narrative?.names?.[0] || null,
      last: lastFor(c.symbol),
    })),
  };
}

export async function handleAiRequest(req, res, url, ai) {
  if (!url.pathname.startsWith("/api/ai/")) return false;
  try {
    if (url.pathname === "/api/ai/candidates" && req.method === "GET") jsonResponse(res, 200, candidatesView(ai));
    else if (url.pathname === "/api/ai/dossier" && req.method === "GET") jsonResponse(res, 200, await buildDossier(normSymbol(url.searchParams.get("symbol"))));
    else if (url.pathname === "/api/ai/record" && req.method === "GET") { await tracker.ready; jsonResponse(res, 200, tracker.view()); }
    else if (url.pathname === "/api/ai/triggers/cancel" && req.method === "POST") {
      if (!allowedWrite(req)) return jsonResponse(res, 403, { error: "Only this site can change the AI desk" }), true;
      const body = await readJsonBody(req);
      jsonResponse(res, tracker.cancel(String(body.id || "")) ? 200 : 404, tracker.view());
    }
    else if (url.pathname === "/api/ai/alpha-dossier" && req.method === "GET") jsonResponse(res, 200, await buildAlphaDossier(String(url.searchParams.get("key") || "").slice(0, 40)));
    else if (url.pathname === "/api/ai/alpha" && req.method === "POST") {
      if (!allowedWrite(req)) return jsonResponse(res, 403, { error: "AI requests are only accepted from this site" }), true;
      if (!ai) return jsonResponse(res, 503, { error: "Add GEMINI_API_KEY to your .env file and restart the server to use the AI." }), true;
      const body = await readJsonBody(req), key = String(body.key || "").slice(0, 40);
      const opts = { model: pickModel(body.model, MODELS.analyst), reviewModel: pickModel(body.reviewModel, MODELS.reviewer), news: body.news !== false, debate: body.debate !== false };
      const work = async (onStep) => {
        const out = await cached(`alpha-now:${key}:${opts.model}:${opts.reviewModel}:${flags(opts)}`, RESULT_TTL, body.refresh === true,
          (emit) => analyzeAlpha(ai, key, { ...opts, onStep: emit }), onStep);
        const tg = body.notify === true && !out.meta.cached ? await telegram(tgSingle(out, "(Alpha token)")) : null;
        return { ...out, telegram: tg };
      };
      if (body.stream === true) await streamJob(res, work);
      else jsonResponse(res, 200, await work(null));
    }
    else if ((url.pathname === "/api/ai/analyze" || url.pathname === "/api/ai/analyze-all") && req.method === "POST") {
      if (!allowedWrite(req)) return jsonResponse(res, 403, { error: "AI requests are only accepted from this site" }), true;
      if (!ai) return jsonResponse(res, 503, { error: "Add GEMINI_API_KEY to your .env file and restart the server to use the AI trade desk." }), true;
      const body = await readJsonBody(req);
      const opts = { model: pickModel(body.model, MODELS.analyst), reviewModel: pickModel(body.reviewModel, MODELS.reviewer), news: body.news !== false, debate: body.debate !== false };
      if (url.pathname === "/api/ai/analyze") {
        const symbol = normSymbol(body.symbol);
        const work = async (onStep) => {
          const out = await cached(`one:${symbol}:${opts.model}:${opts.reviewModel}:${flags(opts)}`, RESULT_TTL, body.refresh === true,
            (emit) => analyzeOne(ai, symbol, { ...opts, onStep: emit }), onStep);
          const tg = body.notify === true && !out.meta.cached ? await telegram(tgSingle(out)) : null;
          return { ...out, telegram: tg };
        };
        if (body.stream === true) await streamJob(res, work);
        else jsonResponse(res, 200, await work(null));
      } else {
        const view = candidatesView(ai);
        const limit = clamp(Math.trunc(Number(body.limit) || 8), 1, BATCH_MAX);
        const symbols = (Array.isArray(body.symbols) && body.symbols.length ? body.symbols.map(normSymbol)
          : view.coins.filter((c) => !c.moved && (c.state === "ignited" || c.state === "heating")).map((c) => c.symbol)).slice(0, limit);
        if (!symbols.length) return jsonResponse(res, 200, { marketView: "No igniting or heating coins right now.", coins: [], failed: [], meta: { at: Date.now() } }), true;
        const out = await cached(`many:${symbols.join(",")}:${opts.model}`, RESULT_TTL, body.refresh === true, () => analyzeMany(ai, symbols, opts));
        const n = (k) => out.coins.filter((c) => c.decision === k).length;
        const tg = body.notify === true && !out.meta.cached && out.coins.length
          ? await telegram([`AI TRADE DESK: ${n("TAKE")} TAKE · ${n("WAIT")} WAIT · ${n("SKIP")} NO TRADE (of ${out.coins.length} coins)`, out.marketView,
            ...out.coins.slice(0, 12).map((c) => `${ICON[c.decision]} ${LABEL[c.decision]} ${c.symbol.replace(/USDT$/, "")}: ${c.probTargetPct}% target / ${c.probStopPct}% stop, expected ${c.expectedValuePct}% · ${c.reason}`),
            "AI opinion on screener data. Research only, not financial advice."].join("\n")) : null;
        jsonResponse(res, 200, { ...out, telegram: tg });
      }
    } else jsonResponse(res, 404, { error: "Not found" });
  } catch (e) {
    const known = e instanceof AgentError;
    if (!known) console.error("AI trade desk:", e);
    jsonResponse(res, known ? e.status : 502, { error: known ? e.message : `AI analysis failed: ${e.message}` });
  }
  return true;
}

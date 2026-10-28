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
// Single coin: POST /api/ai/analyze (optional second-model risk review). All ignition coins: POST /api/ai/analyze-all
// (one batched triage call). Facts only, no AI: GET /api/ai/dossier?symbol=. Research tool, not financial advice.

import { Type } from "@google/genai";
import { screenerSnapshot, fetchJson, CONFIG } from "./screener.js";
import { tokenWhaleSummary } from "./whales.js";
import { tokenFlowSummary } from "./flows.js";
import { analyzeDepth, generate, jsonFrom, MODELS, MODEL_PATTERN, readJsonBody, AgentError } from "./agent.js";
import { sendTelegram } from "./telegram.js";

const env = process.env;
const BN = (env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");
const BF = "https://fapi.binance.com";
const MIN = 60_000, HOUR = 3_600_000;
const DOSSIER_TTL = 60_000, RESULT_TTL = 3 * MIN;
const BATCH_MAX = 12;
const LEVELS = ["low", "medium", "high"];
// From the 60-day replay of 47 Binance crypto tokens on 5-minute candles, Aug 29 - Oct 28 2026 (screener v6 exit rule,
// 0.2% fees + 0.1% slippage). hitTargetPct = target before stop, hitStopPct = stop first, the rest ended flat.
const REPLAY = {
  source: "60-day replay of 47 Binance crypto tokens on 5-minute candles, Aug 29 - Oct 28 2026 (screener-backtest.js)",
  rule: `take profit +${CONFIG.targetPct}%, stop -${CONFIG.stopPct}%, else exit after ${CONFIG.outcomeHours}h; ${CONFIG.feePct}% fees + ${CONFIG.slippagePct}% slippage`,
  confirmed: { signals: 122, hitTargetPct: 30, hitStopPct: 21, flatPct: 48, avgNetPct: 0.93 }, early: { signals: 266, hitTargetPct: 25, hitStopPct: 29, flatPct: 45, avgNetPct: 0.55 },
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
    anchorProbStopPct: Math.round(useLive ? (live.losses / live.resolved) * 100 : base.hitStopPct), anchorFrom: useLive ? "live results" : "replay",
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
  const above = [h24.high, d7.high, d15.high].filter((x) => x > price * 1.002).sort((a, b) => a - b);
  const below = [h12.low, h24.low, d7.low].filter((x) => x < price * 0.998).sort((a, b) => b - a);
  const resistance = above[0] ?? null, support = below[0] ?? null;
  const todayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000, today = s.m15.filter((c) => c.t >= todayStart);
  const vwap = today.length ? today.reduce((a, c) => a + c.qv, 0) / today.reduce((a, c) => a + c.v, 0) : null;
  const last8 = s.m15.slice(-8);
  const vol1h = s.h1.map((c) => c.qv), medVol = [...vol1h.slice(-25, -1)].sort((a, b) => a - b)[12];
  const ret = (cs, n) => (cs.length > n ? r(pct(cs[cs.length - 1].c, cs[cs.length - 1 - n].c)) : null);

  // Reference plan from the alert's own exit rule plus structure / volatility alternatives (long only).
  const tier = tierHint || (cand?.ignition === "ignited" ? ((cand.igScore ?? 0) >= CONFIG.igniteMinScore ? "confirmed" : "early") : cand?.bigmove === "ignited" ? "bigmove" : null);
  const alert = alertContext(tier, snap), rule = alert.trackedAs;
  const stopRule = price * (1 - rule.stopPct / 100);
  const stopStructure = support && pct(support, price) > -8 ? support * (1 - (0.15 * (atr1h || 1)) / 100) : null;
  const stopAtr = atr1h ? price * (1 - (1.5 * atr1h) / 100) : null;
  const tRule = price * (1 + rule.targetPct / 100), tRes = resistance && pct(resistance, price) < Math.max(25, rule.targetPct) ? resistance * 0.997 : null;
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
      resistance: sig(resistance), roomToResistancePct: r(pct(resistance, price)), support: sig(support), distanceToSupportPct: r(pct(support, price)),
      high24h: sig(h24.high), low24h: sig(h24.low), high7d: sig(d7.high), low7d: sig(d7.low), high15d: sig(d15.high), low15d: sig(d15.low),
      note: resistance == null ? "Price is at or above its 15-day high: no overhead level in this data." : null,
    },
    marketFlow: flow,
    orderBook: s.book && Array.isArray(s.book.bids) && s.book.bids.length ? analyzeDepth(s.book) : { available: false },
    futures: fut,
    whales: tokenWhaleSummary(symbol.replace(/USDT$/, "")),
    dexFlows: tokenFlowSummary(symbol.replace(/USDT$/, "")),
    market: {
      btcChange24hPct: snap.regime?.btcChange24hPct, btc1hPct: snap.regime?.btc1hPct, btc4hPct: snap.regime?.btc4hPct,
      marketWideSurge: !!snap.breadth?.marketWide, shareOfTokensSurging: snap.breadth?.hotShare, takerFlowBreadth: flowBreadth(),
      btcRegime: cand?.rotation?.regimeLabel || null, narrativeRanks: cand?.rotation?.narratives?.filter((x) => x.rank != null).slice(0, 3) || null,
      regime: marketRegime(snap),
    },
    livePerformance: {
      byTier: Object.fromEntries(Object.entries(live).map(([k, b]) => [k, liveRate(b)])),
      aiCalls: (snap.stats?.current?.buckets || []).filter((b) => /^AI said/.test(b.name)).map((b) => ({ call: b.name.replace("AI said ", ""), resolved: b.resolved, hitTargetPct: b.winRatePct, avgNetPct: b.netPct })),
    },
    referencePlan: plan,
    baseRates: { replay: REPLAY, live: { confirmed: liveRate(live.ignition), early: liveRate(live.early) } },
  };
  dossierCache.set(key, { at: Date.now(), d });
  if (dossierCache.size > 60) dossierCache.delete(dossierCache.keys().next().value);
  return d;
}

// ───────────────────────────── prompts + schemas ─────────────────────────────
const RULES = `
You decide whether to buy one Binance spot coin RIGHT NOW. Long only, no leverage. The default answer is SKIP (no trade):
TAKE has to be earned by the evidence. Most ignition alerts fail, and a skipped trade costs nothing.

Use ONLY the DOSSIER and quote its numbers exactly. Never invent prices, levels, news or data. null or "unavailable" means
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
   market (BTC, market.regime breadth, market-wide surge), track record (livePerformance of this tier and of AI calls).
3. PROBABILITY. Start from alert.anchorProbTargetPct (how often this kind of alert hit its target before its stop) and
   alert.anchorProbStopPct (how often it hit the stop first); the rest end flat. Move them only for checklist evidence,
   at most 15 points each way, and say which items moved them. A weak market regime, BTC weakness or poor live results
   lower the target chance; strong confirmed volume with buyers in control and room to run raise it.
4. EXPECTED VALUE per trade = probTargetPct/100 x target% - probStopPct/100 x stop% - alert.costPct, using your plan's
   target and stop. The code recomputes it.
5. DECIDE.
   TAKE only if there is no hard stop, the expected value is at least +0.5% per trade, reward:risk is at least 1.5 and
   the price is inside the entry zone now.
   WAIT when the setup is close and one specific thing is missing: waitFor must name a price level, a condition and a
   time limit, e.g. "a 5m close above 0.0512 with buyers 55%+ within 30 minutes; otherwise no trade".
   SKIP (no trade) for everything else, including when the data is too thin to judge.
6. PLAN. Entry, stop and targets from dossier.price, dossier.levels or dossier.referencePlan, sized for alert.trackedAs
   (its target, stop and holding time; a big-move alert aims for its large target over days). Risk at most 1% of the
   account per trade.
Be concise and concrete.`.trim();

const ANALYST_SYSTEM = `You are a disciplined crypto spot trader and risk manager reviewing one setup.\n\n${RULES}`;
const REVIEWER_SYSTEM = `You are a skeptical head of risk double-checking a trader's call. Find reasons it is wrong: numbers that do not
match the dossier, a missed hard stop, probabilities moved far from the alert's base rate without evidence, an expected
value that does not add up, ignored red flags (crowded futures, exchange deposits, weak trend, no room to resistance, BTC
weakness, a weak market regime), or a plan whose stop or target is not supported by the levels.\n\n${RULES}\n
Verdict: "agree" (call is sound), "downgrade" (TAKE should be WAIT, or WAIT should be SKIP), "reject" (should be SKIP).`;
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
    invalidation: { type: Type.STRING },
    keyRisk: { type: Type.STRING },
  },
  required: ["decision", "hardStops", "checklist", "probTargetPct", "probStopPct", "probReason", "confidence", "setupScore", "headline", "thesis",
    "bullishPoints", "bearishPoints", "plan", "waitFor", "invalidation", "keyRisk"],
};
const REVIEW_SCHEMA = {
  type: Type.OBJECT,
  properties: { verdict: { type: Type.STRING, enum: ["agree", "downgrade", "reject"] }, reason: { type: Type.STRING }, risks: strArr },
  required: ["verdict", "reason", "risks"],
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
const STEP_DOWN = { TAKE: "WAIT", WAIT: "SKIP", SKIP: "SKIP" };

export function applyGuards(d, out) {
  const notes = [];
  let decision = ["TAKE", "WAIT", "SKIP"].includes(out.decision) ? out.decision : "SKIP";
  let confidence = LEVELS.includes(out.confidence) ? out.confidence : "low";
  const sc = d.screener;
  if (sc?.moved) { if (decision !== "SKIP") notes.push(`Already moved (${(sc.movedWhy || []).join(", ")}): the screener never chases.`); decision = "SKIP"; }
  const igniting = sc?.state === "ignited" || (d.alert?.tier === "bigmove" && sc?.bigmove === "ignited");
  if (decision === "TAKE" && !igniting) { decision = "WAIT"; notes.push("Not igniting right now (screener: " + (sc ? sc.state : "no signal") + "), so TAKE becomes WAIT."); }
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
  return out;
}

// Expected value per trade from the (anchored) probabilities, then the final call. TAKE needs no hard stop, EV >=
// AI_MIN_EV_PCT and reward:risk >= 1.5; a TAKE that fails becomes WAIT (EV not far below zero) or SKIP.
export function decide(d, out, plan, minEv = MIN_EV_PCT) {
  const a = d.alert || alertContext(d.screener?.tier || null), notes = [];
  const anT = a.anchorProbTargetPct, anS = a.anchorProbStopPct, n = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
  let pT = clamp(n(out.probTargetPct, anT), Math.max(0, anT - 15), Math.min(100, anT + 15));
  let pS = clamp(n(out.probStopPct, anS), Math.max(0, anS - 15), Math.min(100, anS + 15));
  if (pT + pS > 100) pS = 100 - pT;
  if (pT !== n(out.probTargetPct, anT) || pS !== n(out.probStopPct, anS)) notes.push(`Chances held within 15 points of this alert's base rate (${anT}% target / ${anS}% stop).`);
  const ev = r((pT / 100) * (plan.target1Pct ?? 0) - (pS / 100) * Math.abs(plan.stopPct ?? 0) - a.costPct, 2);
  const hard = hardStops(d, plan);
  let decision = out.decision;
  if (hard.length && decision !== "SKIP") { notes.push(`Hard stop: ${hard.join("; ")}. No trade.`); decision = "SKIP"; }
  if (decision === "TAKE" && !(ev >= minEv)) { decision = ev >= -0.5 ? "WAIT" : "SKIP"; notes.push(`Expected value ${ev}% per trade is below +${minEv}%, so TAKE became ${decision === "SKIP" ? "no trade" : "WAIT"}.`); }
  if (decision === "TAKE" && !(plan.rewardRisk >= 1.5)) { decision = "WAIT"; notes.push(`Reward:risk ${plan.rewardRisk} is under 1.5, so TAKE became WAIT.`); }
  return { decision, probTargetPct: pT, probStopPct: pS, expectedValuePct: ev, hardStops: hard, notes };
}

// Long plan sanity: numbers in order and within believable distances; otherwise the reference plan is used.
export function checkPlan(d, plan) {
  const p = plan || {}, price = d.price;
  const ok = [p.entryLow, p.entryHigh, p.stop, p.target1].every((x) => Number.isFinite(x) && x > 0)
    && p.entryLow <= p.entryHigh && p.stop < p.entryLow && p.target1 > p.entryHigh
    && Math.abs(pct(p.entryHigh, price)) <= 3 && pct(p.stop, p.entryHigh) >= -12 && pct(p.stop, p.entryHigh) <= -0.3 && pct(p.target1, p.entryHigh) <= 40;
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

// ───────────────────────────── analysis ─────────────────────────────
const results = new Map(); // key -> { at, result }
const inflight = new Map();
const pickModel = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string" || !MODEL_PATTERN.test(v)) throw new AgentError("Invalid model name", 400);
  return v;
};

async function analyzeOne(ai, symbol, opts) {
  const t0 = Date.now();
  const d = await buildDossier(symbol, opts.tier || null);
  const res = await generate(ai, {
    model: opts.model, contents: `DOSSIER (JSON)\n${JSON.stringify(d)}\n\nWork through the steps, then decide: TAKE, WAIT or SKIP (no trade).`,
    config: { systemInstruction: ANALYST_SYSTEM, temperature: 0.2, responseMimeType: "application/json", responseSchema: DECISION_SCHEMA },
  });
  const out = jsonFrom(res, "Analyst");
  let review = null;
  if (opts.deep) {
    try {
      review = jsonFrom(await generate(ai, {
        model: opts.reviewModel, contents: `DOSSIER (JSON)\n${JSON.stringify(d)}\n\nTRADER'S CALL (JSON)\n${JSON.stringify(out)}\n\nReview it.`,
        config: { systemInstruction: REVIEWER_SYSTEM, temperature: 0.2, responseMimeType: "application/json", responseSchema: REVIEW_SCHEMA },
      }), "Reviewer");
    } catch (e) { review = { verdict: "unavailable", reason: e.message, risks: [] }; }
  }
  const analystDecision = out.decision;
  if (review?.verdict === "downgrade") out.decision = STEP_DOWN[out.decision] || "SKIP";
  if (review?.verdict === "reject") out.decision = "SKIP";
  const g = applyGuards(d, out);
  if (out.decision !== analystDecision) g.notes.unshift(`Risk review (${review.verdict}): ${analystDecision} became ${out.decision}.`);
  const pc = checkPlan(d, out.plan);
  if (pc.replaced) g.notes.push("The model's plan did not fit the levels, so the screener's reference plan is shown.");
  const dz = decide(d, { ...out, decision: g.decision }, pc.plan);
  g.notes.push(...dz.notes);
  if (dz.decision !== "TAKE" && g.decision === "TAKE") g.confidence = lower(g.confidence);
  return {
    symbol, decision: dz.decision, modelDecision: analystDecision, confidence: g.confidence, setupScore: clamp(Math.round(out.setupScore || 0), 0, 10),
    tier: d.alert.tier, probTargetPct: dz.probTargetPct, probStopPct: dz.probStopPct, expectedValuePct: dz.expectedValuePct, probReason: out.probReason,
    hardStops: [...new Set([...(dz.hardStops || []), ...(out.hardStops || [])])], checklist: Array.isArray(out.checklist) ? out.checklist.slice(0, 12) : [],
    headline: out.headline, thesis: out.thesis, bullishPoints: out.bullishPoints || [], bearishPoints: out.bearishPoints || [],
    plan: pc.plan, waitFor: out.waitFor, invalidation: out.invalidation, keyRisk: out.keyRisk, guardNotes: g.notes, review,
    dossier: d, meta: { model: opts.model, reviewModel: opts.deep ? opts.reviewModel : null, durationMs: Date.now() - t0, at: Date.now(), cached: false },
  };
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
    config: { systemInstruction: TRIAGE_SYSTEM, temperature: 0.2, responseMimeType: "application/json", responseSchema: TRIAGE_SCHEMA },
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

function cached(key, ttl, refresh, run) {
  const hit = results.get(key);
  if (!refresh && hit && Date.now() - hit.at < ttl) return Promise.resolve({ ...hit.result, meta: { ...hit.result.meta, cached: true } });
  if (inflight.has(key)) return inflight.get(key);
  const p = run().then((result) => { results.set(key, { at: Date.now(), result }); if (results.size > 80) results.delete(results.keys().next().value); return result; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ───────────────────────────── Telegram ─────────────────────────────
const telegram = (text) => sendTelegram(text); // shared sender: failures are logged and shown on the screener page
export const LABEL = { TAKE: "TAKE", WAIT: "WAIT", SKIP: "NO TRADE" };
const ICON = { TAKE: "🟢", WAIT: "🟡", SKIP: "🔴" };
export const tgSingle = (x, intro = "") => [`${ICON[x.decision] || ""} ${LABEL[x.decision] || x.decision}: ${x.symbol.replace(/USDT$/, "")}${intro ? " " + intro : ""}`,
  x.headline,
  `Chance: ${x.probTargetPct}% target / ${x.probStopPct}% stop · expected ${x.expectedValuePct >= 0 ? "+" : ""}${x.expectedValuePct}% per trade · ${x.confidence} confidence · setup ${x.setupScore}/10`,
  x.decision === "TAKE" ? `Entry ${x.plan.entryLow}-${x.plan.entryHigh} | stop ${x.plan.stop} (${x.plan.stopPct}%) | target ${x.plan.target1} (+${x.plan.target1Pct}%) | R:R ${x.plan.rewardRisk} | hold ${x.plan.holdHours}h` : null,
  x.decision === "WAIT" && x.waitFor ? `Trigger: ${x.waitFor}` : null,
  x.hardStops?.length ? `Hard stop: ${x.hardStops.join("; ")}` : null, `Key risk: ${x.keyRisk}`,
  "AI opinion on screener data. Research only, not financial advice."].filter(Boolean).join("\n");

// Automatic review of a new screener alert (called by server.js): one analysis with the default model, a short summary
// saved with the alert, and a Telegram follow-up unless AI_REVIEW_TELEGRAM=0.
export async function reviewAlert(ai, symbol, tier = null) {
  const opts = { model: MODELS.analyst, reviewModel: MODELS.reviewer, deep: false, tier: tier === "ignition" ? "confirmed" : tier };
  const out = await cached(`one:${symbol}:${opts.model}:-:${opts.tier || ""}`, RESULT_TTL, false, () => analyzeOne(ai, symbol, opts));
  const tg = env.AI_REVIEW_TELEGRAM !== "0" && !out.meta.cached ? await telegram(tgSingle(out, `(AI review of the new ${out.tier === "none" ? "" : out.tier + " "}alert)`)) : null;
  return { decision: out.decision, confidence: out.confidence, setupScore: out.setupScore, headline: out.headline, rewardRisk: out.plan.rewardRisk,
    probTargetPct: out.probTargetPct, expectedValuePct: out.expectedValuePct, model: out.meta.model, at: Date.now(),
    telegram: tg ? (tg.sent ? "sent" : tg.error || tg.skipped) : null };
}

// ───────────────────────────── API ─────────────────────────────
const jsonResponse = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};
// Paid calls only from this site: JSON content type (blocks plain cross-site form posts) and a same-host Origin.
const allowedWrite = (req) => String(req.headers["content-type"] || "").includes("application/json") &&
  (!req.headers.origin || req.headers.origin.replace(/^https?:\/\//, "") === req.headers.host);

function candidatesView(ai) {
  const snap = screenerSnapshot();
  const order = { ignited: 0, heating: 1, ran: 2 };
  const list = (snap.candidates || []).filter((c) => c.ignition)
    .sort((a, b) => order[a.ignition] - order[b.ignition] || (b.igScore || 0) - (a.igScore || 0) || (b.rvol15 || 0) - (a.rvol15 || 0)).slice(0, 30);
  const lastFor = (sym) => { for (const [k, v] of results) if (k.startsWith(`one:${sym}:`)) return { decision: v.result.decision, confidence: v.result.confidence, at: v.at }; return null; };
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
    else if ((url.pathname === "/api/ai/analyze" || url.pathname === "/api/ai/analyze-all") && req.method === "POST") {
      if (!allowedWrite(req)) return jsonResponse(res, 403, { error: "AI requests are only accepted from this site" }), true;
      if (!ai) return jsonResponse(res, 503, { error: "Add GEMINI_API_KEY to your .env file and restart the server to use the AI trade desk." }), true;
      const body = await readJsonBody(req);
      const opts = { model: pickModel(body.model, MODELS.analyst), reviewModel: pickModel(body.reviewModel, MODELS.reviewer), deep: body.deep === true };
      if (url.pathname === "/api/ai/analyze") {
        const symbol = normSymbol(body.symbol);
        const out = await cached(`one:${symbol}:${opts.model}:${opts.deep ? opts.reviewModel : "-"}`, RESULT_TTL, body.refresh === true, () => analyzeOne(ai, symbol, opts));
        const tg = body.notify === true && !out.meta.cached ? await telegram(tgSingle(out)) : null;
        jsonResponse(res, 200, { ...out, telegram: tg });
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

// AI trade desk (/ai): asks Gemini whether to take a long trade on a coin the ignition screener flagged.
//
// Design (same rules as agent.js):
//   • Code gathers and computes the facts; the model only interprets them. Every number in the answer must come from the
//     dossier, and every plan is checked in code (stop below entry, target above, sensible distances, reward:risk).
//   • Deterministic guards after the model: TAKE only for coins that are igniting now (early / confirmed tier), never
//     for coins that already ran; weak reward:risk becomes WAIT; simulated data is labelled and capped.
//   • Base rates are part of the prompt: most ignitions fail, so the model is told how often this tier won in the replay
//     and live, and that profits depend on small losses.
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

const env = process.env;
const BN = (env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");
const BF = "https://fapi.binance.com";
const MIN = 60_000, HOUR = 3_600_000;
const DOSSIER_TTL = 60_000, RESULT_TTL = 3 * MIN;
const BATCH_MAX = 12;
const LEVELS = ["low", "medium", "high"];
// From the 60-day replay of 51 crypto tokens on 5-minute candles (screener v6 exit rule, 0.2% fees + 0.1% slippage).
// hitTargetPct = reached the target before the stop; profitablePct = closed with a profit after costs.
const REPLAY = {
  source: "60-day replay of 51 Binance crypto tokens on 5-minute candles (screener-backtest.js)",
  rule: `take profit +${CONFIG.targetPct}%, stop -${CONFIG.stopPct}%, else exit after ${CONFIG.outcomeHours}h; ${CONFIG.feePct}% fees + ${CONFIG.slippagePct}% slippage`,
  confirmed: { hitTargetPct: 31, profitablePct: 51, avgNetPct: 1.09 }, early: { hitTargetPct: 23, profitablePct: 45, avgNetPct: 0.19 },
};

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
export async function buildDossier(symbol) {
  const hit = dossierCache.get(symbol);
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

  // Reference plan from the screener's own exit rule plus structure / volatility alternatives (long only).
  const stopRule = price * (1 - CONFIG.stopPct / 100);
  const stopStructure = support && pct(support, price) > -8 ? support * (1 - (0.15 * (atr1h || 1)) / 100) : null;
  const stopAtr = atr1h ? price * (1 - (1.5 * atr1h) / 100) : null;
  const tRule = price * (1 + CONFIG.targetPct / 100), tRes = resistance && pct(resistance, price) < 25 ? resistance * 0.997 : null;
  const rr = (stop, target) => (stop && target && price > stop ? r((target - price) / (price - stop)) : null);
  const plan = {
    entry: sig(price), entryZone: [sig(price * (1 - Math.min(0.4, 0.25 * (atr1h || 1)) / 100)), sig(price)],
    stops: { screenerRule: sig(stopRule), belowSupport: sig(stopStructure), atr1_5x: sig(stopAtr) },
    targets: { screenerRule: sig(tRule), nearResistance: sig(tRes), twoR: sig(price + 2 * (price - stopRule)) },
    rewardRisk: { ruleTargetRuleStop: rr(stopRule, tRule), resistanceRuleStop: rr(stopRule, tRes), ruleTargetSupportStop: rr(stopStructure, tRule) },
  };

  const tier = cand?.ignition === "ignited" ? ((cand.igScore ?? 0) >= CONFIG.igniteMinScore ? "confirmed" : "early") : null;
  const live = snap.stats?.current?.byTier || {};
  const liveRate = (b) => (b && b.resolved ? { resolved: b.resolved, winRatePct: b.winRatePct, avgNetPct: b.netPct } : { resolved: 0 });
  const d = {
    symbol, asOf: new Date().toISOString(), price: sig(price), dataQuality: {
      demo: !!snap.demo, screenerStatus: snap.status, inScreener: !!cand,
      notes: [snap.demo ? "Screener is in DEMO mode: its signal is simulated (market data below is live)." : null,
        !cand ? "Not in the screener's current list (no ignition data); judged on market data only." : null,
        flow.simulated ? "Market Flow Radar is in DEMO mode: its flow numbers are simulated." : null].filter(Boolean),
    },
    screener: cand ? {
      state: cand.ignition || "none", tier, moved: cand.moved, movedWhy: cand.movedWhy, stillNeeds: cand.missing,
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
    },
    referencePlan: plan,
    baseRates: { replay: REPLAY, live: { confirmed: liveRate(live.ignition), early: liveRate(live.early) } },
  };
  dossierCache.set(symbol, { at: Date.now(), d });
  if (dossierCache.size > 60) dossierCache.delete(dossierCache.keys().next().value);
  return d;
}

// ───────────────────────────── prompts + schemas ─────────────────────────────
const RULES = `
- This is a long-only spot setup flagged by a volume-ignition screener. Decide whether to buy now.
- Use ONLY numbers in the DOSSIER and quote them exactly. No news, no invented levels or targets. If something is null or
  unavailable, say so and do not guess.
- Base rates matter: most ignitions do not reach the target (see baseRates: about a quarter to a third do), and only about
  half close in profit. A trade only pays if losses stay small, so reward:risk and a clear invalidation level matter more
  than excitement. Early-tier signals barely break even on average; confirmed ones did clearly better.
- marketFlow is the Market Flow Radar's Binance spot taker flow for the last 1-5 minutes (flow score 0-100, share of
  aggressive buying, net buy-minus-sell USD). It shows aggressive buying on one exchange, not informed or "smart" money.
  smartMoneyWallets are on-chain wallet signals from Binance Web3; keep them separate from the spot flow.
- Weigh together: the screener tier (confirmed > early > not igniting), 1h and 4h trend alignment, live taker flow
  (does aggressive buying still dominate, or has it turned to selling?), room to resistance vs
  distance to the stop, order-book support, futures crowding (funding above ~0.05% per 8h, open interest jumping while
  price stalls, a high long/short ratio), whale deposits to exchanges (supply), DEX net selling, BTC falling or a
  market-wide surge, and data quality.
- TAKE = buy now inside the entry zone. WAIT = interesting, but name the exact confirmation that is missing. SKIP = no trade.
  Choose TAKE only when the evidence lines up and reward:risk is at least 1.5; when unsure, WAIT or SKIP.
- Plans: long only, no leverage. Entry, stop and targets must come from dossier.price, dossier.levels or
  dossier.referencePlan. Risk at most 1% of the account per trade.
- Be concise and concrete.`.trim();

const ANALYST_SYSTEM = `You are a disciplined crypto spot trader and risk manager reviewing one setup.\n\n${RULES}`;
const REVIEWER_SYSTEM = `You are a skeptical head of risk double-checking a trader's call. Find reasons it is wrong: numbers that do not
match the dossier, ignored red flags (crowded futures, exchange deposits, weak trend, no room to resistance, BTC weakness),
or a plan whose stop or target is not supported by the levels.\n\n${RULES}\n
Verdict: "agree" (call is sound), "downgrade" (TAKE should be WAIT, or WAIT should be SKIP), "reject" (should be SKIP).`;
const TRIAGE_SYSTEM = `You are a disciplined crypto spot trader triaging several setups from a volume-ignition screener at once.\n\n${RULES}
For each coin give a decision and the single most important reason and risk. Rank the best setups highest.`;

const strArr = { type: Type.ARRAY, items: { type: Type.STRING } };
const DECISION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    decision: { type: Type.STRING, enum: ["TAKE", "WAIT", "SKIP"] },
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
    waitFor: { type: Type.STRING, description: "For WAIT: the exact confirmation needed; otherwise empty" },
    invalidation: { type: Type.STRING },
    keyRisk: { type: Type.STRING },
  },
  required: ["decision", "confidence", "setupScore", "headline", "thesis", "bullishPoints", "bearishPoints", "plan", "waitFor", "invalidation", "keyRisk"],
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
          setupScore: { type: Type.INTEGER }, reason: { type: Type.STRING }, keyRisk: { type: Type.STRING },
        },
        required: ["symbol", "decision", "confidence", "setupScore", "reason", "keyRisk"],
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
  if (decision === "TAKE" && sc?.state !== "ignited") { decision = "WAIT"; notes.push("Not igniting right now (screener: " + (sc ? sc.state : "no signal") + "), so TAKE becomes WAIT."); }
  if (sc?.tier !== "confirmed") confidence = cap(confidence, "medium");
  if (d.dataQuality.demo) { confidence = "low"; notes.push("Screener signal is simulated (demo mode)."); }
  if (d.market.marketWideSurge || (d.market.btc4hPct != null && d.market.btc4hPct < -1)) confidence = lower(confidence);
  if (decision === "TAKE" && /^downtrend/.test(d.chart.trend4h?.state || "")) {
    confidence = lower(confidence); notes.push("Buying against a 4h downtrend: confidence lowered one step.");
  }
  return { decision, confidence, notes };
}

// Long plan sanity: numbers in order and within believable distances; otherwise the reference plan is used.
export function checkPlan(d, plan) {
  const p = plan || {}, price = d.price;
  const ok = [p.entryLow, p.entryHigh, p.stop, p.target1].every((x) => Number.isFinite(x) && x > 0)
    && p.entryLow <= p.entryHigh && p.stop < p.entryLow && p.target1 > p.entryHigh
    && Math.abs(pct(p.entryHigh, price)) <= 3 && pct(p.stop, p.entryHigh) >= -12 && pct(p.stop, p.entryHigh) <= -0.3 && pct(p.target1, p.entryHigh) <= 40;
  const ref = d.referencePlan;
  const use = ok ? p : { entryLow: ref.entryZone[0], entryHigh: ref.entryZone[1], stop: ref.stops.screenerRule, target1: ref.targets.screenerRule,
    target2: ref.targets.nearResistance, holdHours: CONFIG.outcomeHours };
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
  const d = await buildDossier(symbol);
  const res = await generate(ai, {
    model: opts.model, contents: `DOSSIER (JSON)\n${JSON.stringify(d)}\n\nDecide: TAKE, WAIT or SKIP.`,
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
  if (g.decision === "TAKE" && !(pc.plan.rewardRisk >= 1.2)) { g.decision = "WAIT"; g.notes.push(`Reward:risk ${pc.plan.rewardRisk} is too low for TAKE.`); }
  return {
    symbol, decision: g.decision, modelDecision: analystDecision, confidence: g.confidence, setupScore: clamp(Math.round(out.setupScore || 0), 0, 10),
    headline: out.headline, thesis: out.thesis, bullishPoints: out.bullishPoints || [], bearishPoints: out.bearishPoints || [],
    plan: pc.plan, waitFor: out.waitFor, invalidation: out.invalidation, keyRisk: out.keyRisk, guardNotes: g.notes, review,
    dossier: d, meta: { model: opts.model, reviewModel: opts.deep ? opts.reviewModel : null, durationMs: Date.now() - t0, at: Date.now(), cached: false },
  };
}

// The important fields only, for triaging many coins in one call.
const compact = (d) => ({
  symbol: d.symbol, price: d.price, screener: d.screener && { state: d.screener.state, tier: d.screener.tier, moved: d.screener.moved, stillNeeds: d.screener.stillNeeds?.slice(0, 3),
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
    contents: `MARKET (JSON)\n${JSON.stringify(first.market)}\n\nBASE RATES (JSON)\n${JSON.stringify(first.baseRates)}\n\nCOINS (JSON)\n${JSON.stringify(dossiers.map(compact))}\n\nTriage every coin.`,
    config: { systemInstruction: TRIAGE_SYSTEM, temperature: 0.2, responseMimeType: "application/json", responseSchema: TRIAGE_SCHEMA },
  });
  const out = jsonFrom(res, "Triage");
  const bySym = new Map((out.coins || []).map((c) => [String(c.symbol).toUpperCase().replace(/USDT$/, "") + "USDT", c]));
  const coins = dossiers.map((d) => {
    const c = bySym.get(d.symbol) || { decision: "SKIP", confidence: "low", setupScore: 0, reason: "The model did not return this coin.", keyRisk: "" };
    const g = applyGuards(d, c);
    return { symbol: d.symbol, price: d.price, tier: d.screener?.tier || null, state: d.screener?.state || "none", decision: g.decision, modelDecision: c.decision,
      confidence: g.confidence, setupScore: clamp(Math.round(c.setupScore || 0), 0, 10), reason: c.reason, keyRisk: c.keyRisk, guardNotes: g.notes,
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
async function telegram(text) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, skipped: "Telegram is not configured" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
    return res.ok ? { sent: true } : { sent: false, error: `HTTP ${res.status}` };
  } catch (e) { return { sent: false, error: e.message }; }
}
const tgSingle = (x) => [`AI TRADE DESK: ${x.symbol} -> ${x.decision} (${x.confidence} confidence, setup ${x.setupScore}/10)`, x.headline,
  x.decision === "TAKE" ? `Entry ${x.plan.entryLow}-${x.plan.entryHigh} | stop ${x.plan.stop} (${x.plan.stopPct}%) | target ${x.plan.target1} (+${x.plan.target1Pct}%) | R:R ${x.plan.rewardRisk}` : null,
  x.decision === "WAIT" && x.waitFor ? `Wait for: ${x.waitFor}` : null, `Key risk: ${x.keyRisk}`, ...x.guardNotes,
  "AI opinion on screener data. Research only, not financial advice."].filter(Boolean).join("\n");

// Automatic review of a new screener alert (called by server.js): one analysis with the default model, a short summary
// saved with the alert, and a Telegram follow-up unless AI_REVIEW_TELEGRAM=0.
export async function reviewAlert(ai, symbol) {
  const opts = { model: MODELS.analyst, reviewModel: MODELS.reviewer, deep: false };
  const out = await cached(`one:${symbol}:${opts.model}:-`, RESULT_TTL, false, () => analyzeOne(ai, symbol, opts));
  if (env.AI_REVIEW_TELEGRAM !== "0" && !out.meta.cached) telegram(`(AI review of the new ${symbol.replace(/USDT$/, "")} alert)\n${tgSingle(out)}`);
  return { decision: out.decision, confidence: out.confidence, setupScore: out.setupScore, headline: out.headline, rewardRisk: out.plan.rewardRisk,
    model: out.meta.model, at: Date.now() };
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
        const takes = out.coins.filter((c) => c.decision === "TAKE");
        const tg = body.notify === true && !out.meta.cached && takes.length
          ? await telegram([`AI TRADE DESK: ${takes.length} TAKE of ${out.coins.length} coins`, out.marketView, ...takes.map((c) => `- ${c.symbol} (${c.confidence}, ${c.setupScore}/10): ${c.reason}`),
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

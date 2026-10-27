// agent.js — Market Flow analysis agent (Gemini)
//
// Pipeline
//   fast: snapshot ─► analyst
//   deep: snapshot ─► investigator (tool calls) ─► analyst ─► risk reviewer ─► merge
//
// Design rules
//   • Code computes facts (breadth, depth bands, data quality); the LLM only interprets them.
//   • Every model stage returns schema-validated JSON; the markdown brief is rendered in code.
//   • The reviewer's verdicts are applied deterministically (drop / downgrade), not just pasted in.
//   • Optional stages degrade gracefully: if investigation or review fails, you still get a report.

import { Type } from "@google/genai";

const env = process.env;

export const MODELS = {
  analyst: env.GEMINI_ANALYST_MODEL || "gemini-3.5-flash",
  reviewer: env.GEMINI_REVIEW_MODEL || "gemini-3.1-pro-preview",
};
export const MODEL_PATTERN = /^gemini-[a-z0-9.\-]+$/i;
const LEVELS = ["low", "medium", "high"];
const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_CALLS = 6;
const MAX_WATCHLIST = 4;
const CACHE_MAX = 10;

// ───────────────────────────── utilities ─────────────────────────────

export class AgentError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const sig = (v, n = 6) => (Number.isFinite(v) ? Number(v.toPrecision(n)) : null);
const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const levelIndex = (c) => Math.max(0, LEVELS.indexOf(c));
const lower = (c) => LEVELS[Math.max(0, levelIndex(c) - 1)];
const capLevel = (c, max) => LEVELS[Math.min(levelIndex(c), levelIndex(max))];

export async function readJsonBody(req, limit = 16_384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AgentError("Request body too large", 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AgentError("Invalid JSON body", 400); }
}

// ───────────────────────────── prompts ─────────────────────────────

const SHARED_RULES = `
Data you receive comes from a live dashboard:
- "Spot" metrics are Binance spot taker-flow measurements per USDT pair. buyRatio = share of traded
  volume where the buyer was the aggressor. It shows aggressive buying on one exchange. It is NOT
  proof of informed or "smart" money.
- Wallet signals (web3) are the only data about smart-money wallets. Keep them separate from spot flow,
  and never claim a spot move reflects smart money. exitRate is passed through from the source API
  unmodified; do not assume its unit.
- "score" is a heuristic composite (0-100) built from the same metrics. It is not a probability and
  not independent confirmation of them.
- Use only numbers present in the snapshot or tool results and quote them exactly. If a value is null
  or missing, say it is unavailable. Never invent figures, price targets, or news.
- If dataQuality shows simulated, stale, or degraded data, say so and lower confidence accordingly.`.trim();

const ANALYST_SYSTEM = `You are a quantitative crypto market-flow analyst writing for a trader's dashboard.

${SHARED_RULES}

How to analyze:
- Weigh 5m flow, relative volume, trade count, and price confirmation together. 1m metrics are noisy.
- A high score on low trades1m or modest volume24hUsd is weak evidence.
- Look for divergences: buying while price falls (absorption or a failing bid); price rising while
  sell-dominant (weak, fragile move).
- Treat BTCUSDT as the benchmark. Separate market-wide moves from coin-specific ones using vsBtc5mPct
  and breadth.
- Use any investigation results (order-book depth, wallet signals) to confirm or contradict the flow story.
- Write hypotheses to monitor, each with a concrete invalidation condition. No leverage, position sizing,
  price targets, or certainty.
- Pick at most ${MAX_WATCHLIST} watchlist items. Fewer is better than padding. An empty watchlist is a valid answer.
- confidence: "high" only when flow, volume, price, and (if checked) depth all agree.
- Be concise. Every sentence should carry information.`;

const REVIEWER_SYSTEM = `You are a skeptical senior risk manager reviewing a junior analyst's report.
Your job is to find reasons it could be wrong, not to rewrite it.

${SHARED_RULES}

Check for:
- Claims the data does not support, or numbers that do not match the snapshot.
- Fake-out patterns: low relVolume (<1.5), low trades1m, a single noisy window, 1m vs 5m disagreement,
  thin or one-sided order book, BTC-driven moves presented as coin-specific.
- Conflicts between spot flow and wallet signals (e.g. strong buy ratio but high exitRate).
- Overstated confidence, or watchlist items without a testable invalidation.

For each watchlist item choose:
- "keep": supported by the data.
- "downgrade": plausible but fragile. Confidence should drop one level.
- "drop": unsupported or contradicted by the data.
Be strict but fair. Do not downgrade without naming the specific weakness.`;

const INVESTIGATOR_SYSTEM = `You are the investigation stage of a market-flow analysis pipeline.
You do not write the report. You verify the most interesting candidates using tools so the analyst
can rely on facts.

${SHARED_RULES}

Guidelines:
- Check order-book depth for at most 3 top candidates: does resting liquidity support the taker-flow
  story, or is the book thin or one-sided?
- Cross-check wallet signals when a ticker plausibly matches a candidate.
- Skip tools that add nothing. Never call a tool twice with the same arguments.
- When done, reply with a one-line note on what you checked.`;

// ───────────────────────────── schemas ─────────────────────────────

const strArr = { type: Type.ARRAY, items: { type: Type.STRING } };

const REPORT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    regime: { type: Type.STRING, enum: ["risk_on", "risk_off", "mixed", "unclear"] },
    headline: { type: Type.STRING, description: "One-line takeaway" },
    summary: { type: Type.STRING, description: "2-3 sentences on what the flow shows" },
    watchlist: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          symbol: { type: Type.STRING },
          bias: { type: Type.STRING, enum: ["bullish", "bearish", "neutral"] },
          confidence: { type: Type.STRING, enum: LEVELS },
          thesis: { type: Type.STRING },
          evidence: strArr,
          invalidation: { type: Type.STRING },
          risks: strArr,
        },
        required: ["symbol", "bias", "confidence", "thesis", "evidence", "invalidation", "risks"],
      },
    },
    onchain_note: { type: Type.STRING, description: "What wallet signals show; say so if none or unavailable" },
    data_caveats: strArr,
  },
  required: ["regime", "headline", "summary", "watchlist", "onchain_note", "data_caveats"],
};

const REVIEW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    overall_verdict: { type: Type.STRING, enum: ["agree", "agree_with_caveats", "disagree"] },
    summary: { type: Type.STRING, description: "At most 3 sentences" },
    item_reviews: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          symbol: { type: Type.STRING },
          action: { type: Type.STRING, enum: ["keep", "downgrade", "drop"] },
          reason: { type: Type.STRING },
        },
        required: ["symbol", "action", "reason"],
      },
    },
    missed_risks: strArr,
  },
  required: ["overall_verdict", "summary", "item_reviews", "missed_risks"],
};

// ───────────────────────────── snapshot ─────────────────────────────

function compactCoin(c, btc) {
  return {
    symbol: c.symbol,
    price: sig(c.price),
    score: c.score,
    label: c.label,
    buyRatio1mPct: r(c.buyRatio1m, 1),
    buyRatio5mPct: r(c.buyRatio5m, 1),
    netFlow5mUsd: r(c.netFlow5m, 0),
    change5mPct: r(c.change5m, 3),
    change24hPct: r(c.change24h, 2),
    vsBtc5mPct: btc && c.symbol !== btc.symbol ? r(c.change5m - btc.change5m, 3) : null,
    relVolume: r(c.relativeVolume, 2),
    trades1m: c.trades1m,
    volume24hUsd: r(c.volume24h, 0),
    flags: c.reasons,
  };
}

function compactSignal(s, now) {
  return {
    ticker: s.ticker,
    chain: s.chain,
    direction: s.direction,
    wallets: s.wallets,
    exitRate: s.exitRate,
    ageMin: s.time ? Math.max(0, Math.round((now - s.time) / 60_000)) : null,
    status: s.status,
    address: s.address ? `${s.address.slice(0, 6)}…${s.address.slice(-4)}` : null,
  };
}

function buildSnapshot(state) {
  const now = Date.now();
  const coins = state.coins || [];
  if (!coins.length) throw new AgentError("No market data yet. Wait for the first poll to finish.", 503);

  const marketUpdatedAt = Math.max(...coins.map((c) => c.updatedAt || 0));
  const marketAgeSec = Math.round((now - marketUpdatedAt) / 1000);
  const stale = marketAgeSec > (state.pollIntervalMs / 1000) * 3 + 10;

  const caveats = [];
  if (state.demo) caveats.push("All data is SIMULATED demo data, not live market data.");
  if (stale) caveats.push(`Market data is ${marketAgeSec}s old (stale).`);
  if (state.marketStatus === "error") caveats.push("Binance spot polling is failing; showing the last successful data.");
  if (state.errors?.["Some candles"]) caveats.push(state.errors["Some candles"]);
  if (!state.demo && state.web3Status !== "connected") caveats.push(`Wallet-signal feed status: ${state.web3Status}.`);

  const quality = {
    demo: !!state.demo,
    marketAgeSec,
    stale,
    marketStatus: state.marketStatus,
    web3Status: state.web3Status,
    caveats,
  };

  const btc = coins.find((c) => c.symbol === "BTCUSDT") || null;
  const buyQ = sum(coins, (c) => c.buyQuote5m);
  const sellQ = sum(coins, (c) => c.sellQuote5m);

  const web3 = state.web3Signals || [];
  const byChainDirection = {};
  for (const s of web3) {
    const k = `${s.chain}:${s.direction}`;
    byChainDirection[k] = (byChainDirection[k] || 0) + 1;
  }

  const snapshot = {
    asOf: new Date(now).toISOString(),
    dataQuality: quality,
    benchmark: btc ? compactCoin(btc, null) : null,
    breadth: {
      tracked: coins.length,
      buyDominant: coins.filter((c) => c.buyRatio5m >= 55).length,
      sellDominant: coins.filter((c) => c.buyRatio5m <= 45).length,
      volumeSpikes: coins.filter((c) => c.relativeVolume >= 2).length,
      medianBuyRatio5mPct: r(median(coins.map((c) => c.buyRatio5m)), 1),
      aggregateBuyRatio5mPct: buyQ + sellQ > 0 ? r((buyQ / (buyQ + sellQ)) * 100, 1) : null,
      aggregateNetFlow5mUsd: r(buyQ - sellQ, 0),
    },
    leaders: coins.slice(0, 8).map((c) => compactCoin(c, btc)),
    sellPressure: [...coins].sort((a, b) => a.buyRatio5m - b.buyRatio5m).slice(0, 3).map((c) => compactCoin(c, btc)),
    recentAlerts: (state.events || []).slice(0, 5).map((e) => ({
      symbol: e.symbol, score: e.score, ageMin: Math.round((now - e.time) / 60_000),
    })),
    web3: {
      status: state.web3Status,
      totalSignals: web3.length,
      byChainDirection,
      top: [...web3].sort((a, b) => (b.wallets || 0) - (a.wallets || 0)).slice(0, 8).map((s) => compactSignal(s, now)),
    },
  };

  return { snapshot, quality, marketUpdatedAt, tracked: new Set(coins.map((c) => c.symbol)) };
}

// ───────────────────────────── tools ─────────────────────────────

const TOOL_DECLARATIONS = [
  {
    name: "get_coin_detail",
    description: "Full flow metrics for one tracked symbol, including 5m buy/sell volume in USD.",
    parameters: {
      type: Type.OBJECT,
      properties: { symbol: { type: Type.STRING, description: "Tracked Binance USDT pair, e.g. SUIUSDT" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_order_book_depth",
    description: "Live Binance order-book snapshot analysis for a tracked symbol: spread, bid/ask notional within " +
      "price bands, imbalance (-1..1), and the largest wall on each side.",
    parameters: {
      type: Type.OBJECT,
      properties: { symbol: { type: Type.STRING, description: "Tracked Binance USDT pair" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_smart_money_signals",
    description: "On-chain smart-money wallet signals from Binance Web3, optionally filtered.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticker: { type: Type.STRING, description: "Token ticker, e.g. SUI (a trailing USDT is ignored)" },
        chain: { type: Type.STRING, description: "BSC or Solana" },
        direction: { type: Type.STRING, enum: ["buy", "sell"] },
        limit: { type: Type.INTEGER, description: "Max signals to return (1-20, default 10)" },
      },
    },
  },
];

function findCoin(coins, symbol) {
  const s = String(symbol || "").toUpperCase();
  const c = coins.find((x) => x.symbol === s);
  if (!c) throw new Error(`${s || "(empty)"} is not a tracked symbol`);
  return c;
}

async function fetchDepth(symbol) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=100`, {
      signal: ctrl.signal,
      headers: { "user-agent": "MarketFlowRadar/1.0" },
    });
    if (!res.ok) throw new Error(`Binance depth HTTP ${res.status}`);
    const book = await res.json();
    if (!Array.isArray(book.bids) || !Array.isArray(book.asks) || !book.bids.length || !book.asks.length) {
      throw new Error("Unexpected order-book response");
    }
    return book;
  } finally {
    clearTimeout(timer);
  }
}

// Exported for testing.
export function analyzeDepth(book) {
  const side = (levels) => levels.map(([p, q]) => ({ p: Number(p), notional: Number(p) * Number(q) }));
  const bids = side(book.bids);
  const asks = side(book.asks);
  const bestBid = bids[0].p;
  const bestAsk = asks[0].p;
  const mid = (bestBid + bestAsk) / 2;

  // Only report bands the 100-level snapshot actually covers, otherwise imbalance is misleading.
  const reachPct = Math.min(((mid - bids[bids.length - 1].p) / mid) * 100, ((asks[asks.length - 1].p - mid) / mid) * 100);
  const within = (lv, pct) => sum(lv.filter((l) => (Math.abs(l.p - mid) / mid) * 100 <= pct), (l) => l.notional);
  const bands = [0.1, 0.25, 0.5, 1].filter((w) => w <= reachPct).map((w) => {
    const b = within(bids, w);
    const a = within(asks, w);
    return { withinPct: w, bidUsd: r(b, 0), askUsd: r(a, 0), imbalance: b + a > 0 ? r((b - a) / (b + a), 3) : null };
  });
  const wall = (lv) => {
    const m = lv.reduce((best, l) => (l.notional > best.notional ? l : best));
    return { price: m.p, notionalUsd: r(m.notional, 0), distancePct: r((Math.abs(m.p - mid) / mid) * 100, 3) };
  };

  return {
    spreadBps: r(((bestAsk - bestBid) / mid) * 1e4, 2),
    depthReachPct: r(reachPct, 3),
    bands,
    largestBidWall: wall(bids),
    largestAskWall: wall(asks),
    note: bands.length
      ? "imbalance = (bid - ask) / (bid + ask); positive means more resting bids."
      : "The 100-level snapshot reaches less than 0.1% from mid, so no bands are reported.",
  };
}

async function execTool(name, args, ctx) {
  if (ctx.calls >= MAX_TOOL_CALLS) return { error: "Tool-call budget exhausted. Work with what you have." };
  ctx.calls++;
  try {
    const coins = ctx.state.coins || [];
    switch (name) {
      case "get_coin_detail": {
        const c = findCoin(coins, args.symbol);
        return {
          ...compactCoin(c, coins.find((x) => x.symbol === "BTCUSDT")),
          buyQuote5mUsd: r(c.buyQuote5m, 0),
          sellQuote5mUsd: r(c.sellQuote5m, 0),
          lastMinuteQuoteUsd: r(c.oneMinQuote, 0),
          avg1mQuoteUsd: r(c.average1mQuote, 0),
        };
      }
      case "get_order_book_depth": {
        const c = findCoin(coins, args.symbol);
        return { symbol: c.symbol, ...analyzeDepth(await fetchDepth(c.symbol)) };
      }
      case "get_smart_money_signals": {
        const now = Date.now();
        const ticker = args.ticker ? String(args.ticker).toUpperCase().replace(/USDT$/, "") : null;
        const chain = args.chain ? String(args.chain).toLowerCase() : null;
        const limit = clamp(Math.trunc(Number(args.limit) || 10), 1, 20);
        const matches = (ctx.state.web3Signals || []).filter((s) =>
          (!ticker || String(s.ticker).toUpperCase() === ticker) &&
          (!chain || String(s.chain).toLowerCase() === chain) &&
          (!args.direction || s.direction === args.direction));
        return {
          sourceStatus: ctx.state.web3Status,
          matches: matches.length,
          signals: matches.sort((a, b) => (b.wallets || 0) - (a.wallets || 0)).slice(0, limit).map((s) => compactSignal(s, now)),
        };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ───────────────────────────── LLM helpers ─────────────────────────────

// Shared with ai-trade.js (the AI trade desk).
export async function generate(ai, params, { retries = 2, timeoutMs = 60_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await ai.models.generateContent({
        ...params,
        config: { ...params.config, abortSignal: ctrl.signal },
      });
    } catch (e) {
      const status = Number(e?.status ?? e?.code);
      const retryable = [429, 500, 503, 504].includes(status) || e?.name === "AbortError";
      if (!retryable || attempt >= retries) throw e;
      await sleep(800 * 2 ** attempt + Math.random() * 300);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function jsonFrom(res, label) {
  const text = (res.text || "").replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
  if (!text) throw new AgentError(`${label} returned an empty response`, 502);
  try { return JSON.parse(text); }
  catch { throw new AgentError(`${label} returned invalid JSON`, 502); }
}

// ───────────────────────────── pipeline stages ─────────────────────────────

async function investigate({ ai, model, snapshot, ctx }) {
  const contents = [{
    role: "user",
    parts: [{ text: `SNAPSHOT (JSON)\n${JSON.stringify(snapshot)}\n\nVerify the most interesting candidates with your tools, then reply with a one-line note on what you checked.` }],
  }];
  let note = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await generate(ai, {
      model,
      contents,
      config: { systemInstruction: INVESTIGATOR_SYSTEM, temperature: 0.2, tools: [{ functionDeclarations: TOOL_DECLARATIONS }] },
    });
    const calls = res.functionCalls || [];
    const content = res.candidates?.[0]?.content;
    if (!calls.length || !content) {
      note = (res.text || "").trim().slice(0, 400);
      break;
    }
    contents.push(content); // keep the model turn verbatim (preserves thought signatures)
    const parts = await Promise.all(calls.map(async (call) => {
      const args = call.args || {};
      const result = await execTool(call.name, args, ctx);
      ctx.log.push({ tool: call.name, args, result });
      return { functionResponse: { id: call.id, name: call.name, response: { result } } };
    }));
    contents.push({ role: "user", parts });
  }
  return note;
}

async function writeReport({ ai, model, snapshot, ctx, note }) {
  const prompt =
    `SNAPSHOT (JSON)\n${JSON.stringify(snapshot)}\n\n` +
    `INVESTIGATION RESULTS (JSON; empty if none were run)\n${JSON.stringify(ctx.log)}\n\n` +
    `INVESTIGATOR NOTE: ${note || "none"}\n\nWrite the report.`;
  const res = await generate(ai, {
    model,
    contents: prompt,
    config: { systemInstruction: ANALYST_SYSTEM, temperature: 0.3, responseMimeType: "application/json", responseSchema: REPORT_SCHEMA },
  });
  return jsonFrom(res, "Analyst");
}

async function reviewReport({ ai, model, snapshot, ctx, report }) {
  const prompt =
    `SNAPSHOT (JSON)\n${JSON.stringify(snapshot)}\n\n` +
    `INVESTIGATION RESULTS (JSON)\n${JSON.stringify(ctx.log)}\n\n` +
    `ANALYST REPORT (JSON)\n${JSON.stringify(report)}\n\nReview it.`;
  const res = await generate(ai, {
    model,
    contents: prompt,
    config: { systemInstruction: REVIEWER_SYSTEM, temperature: 0.2, responseMimeType: "application/json", responseSchema: REVIEW_SCHEMA },
  });
  return jsonFrom(res, "Reviewer");
}

// Applies reviewer verdicts and hard guards in code rather than trusting prose.
function mergeReview(report, review, quality, tracked) {
  const reviews = new Map((review?.item_reviews || []).map((x) => [String(x.symbol).toUpperCase(), x]));
  const maxConfidence = quality.demo ? "low" : quality.stale ? "medium" : "high";
  const kept = [];
  const dropped = [];

  for (const raw of (report.watchlist || []).slice(0, MAX_WATCHLIST)) {
    const symbol = String(raw.symbol || "").toUpperCase();
    if (!tracked.has(symbol)) {
      dropped.push({ symbol, reason: "Not a tracked symbol (possible hallucination)." });
      continue;
    }
    const verdict = reviews.get(symbol);
    if (verdict?.action === "drop") {
      dropped.push({ symbol, reason: verdict.reason });
      continue;
    }
    let confidence = LEVELS.includes(raw.confidence) ? raw.confidence : "low";
    if (verdict?.action === "downgrade") confidence = lower(confidence);
    kept.push({
      ...raw,
      symbol,
      confidence: capLevel(confidence, maxConfidence),
      review: verdict ? { action: verdict.action, reason: verdict.reason } : null,
    });
  }
  return { kept, dropped };
}

// ───────────────────────────── rendering ─────────────────────────────

const REGIME_LABEL = { risk_on: "Risk-on", risk_off: "Risk-off", mixed: "Mixed", unclear: "Unclear" };
const VERDICT_LABEL = { agree: "Agrees", agree_with_caveats: "Agrees with caveats", disagree: "Disagrees" };

function renderBrief({ report, review, kept, dropped, quality, mode, models, caveats }) {
  const L = [];
  const dataTag = quality.demo ? "SIMULATED data"
    : quality.stale ? `stale data (${quality.marketAgeSec}s old)`
    : `live data (${quality.marketAgeSec}s old)`;

  L.push(`**${report.headline}**`);
  L.push(`Regime: ${REGIME_LABEL[report.regime] || "Unclear"} · ${dataTag}`);
  L.push("", report.summary);

  L.push("", "**Watchlist**");
  if (!kept.length) L.push("No setup clears the evidence bar right now.");
  for (const w of kept) {
    L.push(`- **${w.symbol}**: ${w.bias}, confidence ${w.confidence}`);
    L.push(`  ${w.thesis}`);
    if (w.evidence?.length) L.push(`  Evidence: ${w.evidence.join("; ")}`);
    L.push(`  Invalidated if: ${w.invalidation}`);
    if (w.risks?.length) L.push(`  Risks: ${w.risks.join("; ")}`);
    if (w.review && w.review.action !== "keep") L.push(`  Reviewer (${w.review.action}): ${w.review.reason}`);
  }
  if (dropped.length) {
    L.push("", "**Removed after review**");
    for (const d of dropped) L.push(`- ${d.symbol}: ${d.reason}`);
  }

  if (report.onchain_note) L.push("", "**Wallet signals**", report.onchain_note);

  if (review) {
    L.push("", `**Risk review** (${models.reviewer}): ${VERDICT_LABEL[review.overall_verdict] || "n/a"}`, review.summary);
    if (review.missed_risks?.length) L.push(...review.missed_risks.map((x) => `- ${x}`));
  } else if (mode === "deep") {
    L.push("", "**Risk review**", "Unavailable for this run; treat the watchlist with extra caution.");
  }

  if (caveats.length) {
    L.push("", "**Data caveats**", ...caveats.map((x) => `- ${x}`));
  }
  L.push("", "_Research signal only, not financial advice._");
  return L.join("\n");
}

// ───────────────────────────── orchestration ─────────────────────────────

function resolveOptions(body = {}) {
  const pick = (v, fallback) => {
    if (v === undefined || v === null || v === "") return fallback;
    if (typeof v !== "string" || !MODEL_PATTERN.test(v)) throw new AgentError("Invalid model name", 400);
    return v;
  };
  return {
    mode: body.mode === "deep" || body.recursive === true ? "deep" : "fast", // `recursive` kept for back-compat
    models: { analyst: pick(body.model, MODELS.analyst), reviewer: pick(body.reviewModel, MODELS.reviewer) },
    refresh: body.refresh === true,
  };
}

async function execute(ai, state, opts) {
  const t0 = Date.now();
  const { snapshot, quality, tracked } = buildSnapshot(state);
  const ctx = { state, calls: 0, log: [] };
  const caveats = [...quality.caveats];
  let note = "";

  // Stage 1 (deep only): tool-using verification. Skipped for simulated data since depth would be real.
  if (opts.mode === "deep" && !quality.demo) {
    try { note = await investigate({ ai, model: opts.models.analyst, snapshot, ctx }); }
    catch (e) {
      console.error("Investigation stage failed:", e.message);
      caveats.push("Order-book and wallet cross-checks failed for this run.");
    }
  }

  // Stage 2: analyst report (required).
  const report = await writeReport({ ai, model: opts.models.analyst, snapshot, ctx, note });

  // Stage 3 (deep only): independent risk review with a stronger model.
  let review = null;
  if (opts.mode === "deep") {
    try { review = await reviewReport({ ai, model: opts.models.reviewer, snapshot, ctx, report }); }
    catch (e) { console.error("Review stage failed:", e.message); }
  }

  const { kept, dropped } = mergeReview(report, review, quality, tracked);
  for (const c of report.data_caveats || []) if (!caveats.includes(c)) caveats.push(c);

  return {
    analysis: renderBrief({ report, review, kept, dropped, quality, mode: opts.mode, models: opts.models, caveats }),
    structured: { regime: report.regime, headline: report.headline, watchlist: kept, dropped, review, caveats },
    meta: {
      mode: opts.mode,
      models: opts.mode === "deep" ? opts.models : { analyst: opts.models.analyst },
      toolCalls: ctx.log.map((x) => ({ tool: x.tool, args: x.args, ok: !x.result?.error })),
      dataAgeSec: quality.marketAgeSec,
      demo: quality.demo,
      cached: false,
      durationMs: Date.now() - t0,
    },
  };
}

const cache = new Map();    // key -> result
const inflight = new Map(); // key -> Promise

export async function runAnalysis(ai, state, body = {}) {
  const opts = resolveOptions(body);
  const latest = Math.max(0, ...(state.coins || []).map((c) => c.updatedAt || 0));
  const key = [latest, state.lastUpdated, opts.mode, opts.models.analyst, opts.models.reviewer].join("|");

  if (!opts.refresh && cache.has(key)) {
    const hit = cache.get(key);
    return { ...hit, meta: { ...hit.meta, cached: true } };
  }
  if (inflight.has(key)) return inflight.get(key); // collapse double-clicks into one paid run

  const p = execute(ai, state, opts)
    .then((result) => {
      cache.set(key, result);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
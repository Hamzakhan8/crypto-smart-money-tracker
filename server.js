// Smart Money / Market Flow Radar
// Node.js 18+. No third-party dependencies (except @google/genai).

import "./env.js"; // first: loads .env before any module reads its settings
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { runAnalysis, readJsonBody, AgentError } from "./agent.js";
import { startScreener, handleScreenerRequest, serveScreenerPage, onIgnitionAlert, annotateEvent, onAlphaAlert, annotateAlpha, setFlowContext, freshAiVerdicts } from "./screener.js";
import { handleAiRequest, reviewAlert, reviewAlpha, setMarketFlowSource } from "./ai-trade.js";
import { sendTelegram as tgQueue, telegramWants, telegramConfigured } from "./telegram.js";
const env = process.env;
const HOST = env.HOST || "127.0.0.1";
const PORT = Number(env.PORT || 3000);
const DEMO = env.DEMO === "1";
const POLL_MS = Math.max(15, Number(env.POLL_SECONDS || 30)) * 1000;
const MAX_SYMBOLS = Math.min(60, Math.max(10, Number(env.MAX_SYMBOLS || 40)));
const MIN_QUOTE_VOLUME = Number(env.MIN_QUOTE_VOLUME || 1_000_000);
const RADAR_TELEGRAM = env.RADAR_TELEGRAM === "1"; // Radar "Strong flow" messages are off by default: Telegram is for the screener and AI
const BN = (env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");
const WEB3_API = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/web/signal/smart-money/ai";
const CHAINS = [{ id: "56", name: "BSC" }, { id: "CT_501", name: "Solana" }];
const here = path.dirname(fileURLToPath(import.meta.url));

// Initialize Gemini using environment variable securely
const ai = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;

// Every new ignition alert gets one automatic AI review (TAKE / WAIT / SKIP), saved with the alert, so the screener's
// performance panel can show whether the AI's calls really do better. AI_AUTO_REVIEW=0 turns it off;
// AI_REVIEWS_PER_HOUR caps the cost (default 12).
const AI_AUTO_REVIEW = !!ai && env.AI_AUTO_REVIEW !== "0";
const AI_REVIEWS_PER_HOUR = Math.max(1, Number(env.AI_REVIEWS_PER_HOUR) || 12);
let aiReviewTimes = [];
const aiBudget = () => {
  const now = Date.now();
  aiReviewTimes = aiReviewTimes.filter((t) => now - t < 3_600_000);
  if (aiReviewTimes.length >= AI_REVIEWS_PER_HOUR) return false;
  aiReviewTimes.push(now);
  return true;
};
if (AI_AUTO_REVIEW) onIgnitionAlert(async (ev) => {
  if (!aiBudget()) return;
  try { annotateEvent(ev.id, { ai: await reviewAlert(ai, ev.symbol, ev.tier) }); }
  catch (e) { annotateEvent(ev.id, { ai: { error: e.message, at: Date.now() } }); }
});
// Confirmed Alpha alerts get the same automatic review (ALPHA_AI_REVIEW=all: early ones too, =0: none), from the same
// hourly budget. Its Telegram follow-up is sent only when Alpha alerts go to Telegram.
if (AI_AUTO_REVIEW && env.ALPHA_AI_REVIEW !== "0") onAlphaAlert(async (a) => {
  if (a.tier !== "confirmed" && env.ALPHA_AI_REVIEW !== "all") return;
  if (!aiBudget()) return;
  try { annotateAlpha(a.id, { ai: await reviewAlpha(ai, a) }); }
  catch (e) { annotateAlpha(a.id, { ai: { error: e.message, at: Date.now() } }); }
});
// Saved with every alert: the share of Market Flow Radar coins whose last 5 minutes were mostly aggressive buying.
setFlowContext(() => {
  const cs = (state.coins || []).filter((c) => Number.isFinite(c.buyRatio5m));
  return cs.length >= 10 ? { buyShare: Math.round((cs.filter((c) => c.buyRatio5m >= 55).length / cs.length) * 100) } : null;
});

const state = {
  startedAt: Date.now(),
  lastUpdated: null,
  pollIntervalMs: POLL_MS,
  demo: DEMO,
  marketStatus: "starting",
  web3Status: "not_checked",
  errors: {},
  coins: [],
  web3Signals: [],
  events: [],
};
let polling = false;
let previousScores = new Map();
let lastAlertAt = new Map();

const n = (v) => {
  const x = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(x) ? null : x;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "user-agent": "MarketFlowRadar/1.0", ...(options.headers || {}) },
    });
    if (!res.ok) {
      const suffix = res.status === 403 || res.status === 451 ? " (access blocked)" :
        res.status === 429 || res.status === 418 ? " (rate limited)" : "";
      throw new Error(`HTTP ${res.status}${suffix}`);
    }
    const type = res.headers.get("content-type") || "";
    if (!type.includes("application/json")) throw new Error("API returned non-JSON data");
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
function isUsdtSpot(t) {
  const s = t.symbol || "";
  return s.endsWith("USDT") &&
    !/(UP|DOWN|BULL|BEAR)USDT$/.test(s) &&
    n(t.quoteVolume) >= MIN_QUOTE_VOLUME;
}
function candleMetrics(klines) {
  const candles = (klines || []).map(k => ({
    openTime: n(k[0]), open: n(k[1]), high: n(k[2]), low: n(k[3]),
    close: n(k[4]), baseVolume: n(k[5]) || 0, quoteVolume: n(k[7]) || 0,
    trades: n(k[8]) || 0, takerBuyQuote: n(k[10]) || 0,
  })).filter(c => c.close !== null && c.quoteVolume !== null)
    .filter(c => c.openTime + 60_000 <= Date.now()); // finished minutes only: a half-built candle made scores depend on timing
  if (!candles.length) throw new Error("No usable candles");
  const last = candles[candles.length - 1];
  const closed = candles.slice(0, -1);
  const buyQ = last.takerBuyQuote;
  const sellQ = Math.max(0, last.quoteVolume - buyQ);
  const buyRatio = last.quoteVolume > 0 ? buyQ / last.quoteVolume * 100 : 50;
  const five = candles.slice(-5);
  const fiveQuote = five.reduce((a, c) => a + c.quoteVolume, 0);
  const fiveBuy = five.reduce((a, c) => a + c.takerBuyQuote, 0);
  const fiveSell = Math.max(0, fiveQuote - fiveBuy);
  const fiveBuyRatio = fiveQuote > 0 ? fiveBuy / fiveQuote * 100 : 50;
  const priceStart = candles[Math.max(0, candles.length - 5)].open;
  const change5m = priceStart ? (last.close / priceStart - 1) * 100 : 0;
  const baseline = closed.slice(-20);
  const avgQuote = baseline.length ? baseline.reduce((a, c) => a + c.quoteVolume, 0) / baseline.length : 0;
  const relativeVolume = avgQuote > 0 ? last.quoteVolume / avgQuote : null;
  const net5m = fiveBuy - fiveSell;
  return {
    price: last.close, candleTime: last.openTime, oneMinQuote: last.quoteVolume,
    buyQuote1m: buyQ, sellQuote1m: sellQ, buyRatio1m: buyRatio,
    buyQuote5m: fiveBuy, sellQuote5m: fiveSell, buyRatio5m: fiveBuyRatio,
    netFlow5m: net5m, change5m, relativeVolume,
    average1mQuote: avgQuote, trades1m: last.trades,
  };
}
function scoreCoin(ticker, m) {
  let score = 0;
  const reasons = [];
  const ratio = m.buyRatio5m;
  if (ratio >= 60) { score += 28; reasons.push("strong 5m taker-buy imbalance"); }
  else if (ratio >= 55) { score += 18; reasons.push("positive 5m taker-buy imbalance"); }
  else if (ratio >= 52) { score += 9; reasons.push("mild buy-side advantage"); }
  else if (ratio <= 40) { score += 0; reasons.push("strong sell-side pressure"); }
  else if (ratio < 48) { score += 3; reasons.push("sell-side pressure"); }
  else { score += 8; reasons.push("near-balanced taker flow"); }

  const rv = m.relativeVolume;
  if (rv !== null && rv >= 3) { score += 25; reasons.push("volume ≥3× recent baseline"); }
  else if (rv !== null && rv >= 2) { score += 19; reasons.push("volume ≥2× recent baseline"); }
  else if (rv !== null && rv >= 1.5) { score += 12; reasons.push("volume elevated vs baseline"); }
  else if (rv !== null && rv >= 1.1) score += 6;

  if (m.change5m > 0.1 && ratio >= 52) { score += 18; reasons.push("price rising with buy pressure"); }
  else if (m.change5m > 0 && ratio >= 50) score += 10;
  else if (m.change5m < -0.5 && ratio >= 55) { score += 10; reasons.push("possible absorption: buying while price falls"); }
  else if (m.change5m < -0.5 && ratio < 48) { score += 0; reasons.push("price weakness confirms sell pressure"); }
  else score += 5;

  if (m.trades1m >= 1000) score += 10;
  else if (m.trades1m >= 250) score += 7;
  else if (m.trades1m >= 50) score += 4;

  const volume24h = n(ticker.quoteVolume) || 0;
  if (volume24h >= 100_000_000) score += 10;
  else if (volume24h >= 20_000_000) score += 7;
  else if (volume24h >= 5_000_000) score += 4;

  score = clamp(Math.round(score), 0, 100);
  let label = "Neutral";
  if (ratio < 45 && m.change5m < 0) label = "Distribution risk";
  else if (score >= 75) label = "Strong flow";
  else if (score >= 60) label = "Watch closely";
  else if (score >= 45) label = "Developing";
  return { score, label, reasons };
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
      await sleep(35);
    }
  }));
  return results;
}
async function fetchMarket() {
  const tickerData = await fetchJson(`${BN}/api/v3/ticker/24hr`, {}, 12000);
  if (!Array.isArray(tickerData)) throw new Error("Unexpected 24h ticker response");
  const tickers = tickerData.filter(isUsdtSpot).sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0, MAX_SYMBOLS);
  const rows = await mapLimit(tickers, 5, async (t) => {
    const klines = await fetchJson(`${BN}/api/v3/klines?symbol=${encodeURIComponent(t.symbol)}&interval=1m&limit=22`);
    const m = candleMetrics(klines);
    const signal = scoreCoin(t, m);
    return {
      symbol: t.symbol, price: m.price, change24h: n(t.priceChangePercent),
      volume24h: n(t.quoteVolume) || 0, trades1m: m.trades1m,
      ...m, ...signal, dataSource: "Binance Spot klines",
      updatedAt: Date.now(),
    };
  });
  const good = rows.filter(r => r && !r._error);
  const failed = rows.filter(r => r && r._error);
  if (!good.length) throw new Error(`All ${tickers.length} candle requests failed`);
  state.coins = good.sort((a, b) => b.score - a.score);
  if (failed.length) state.errors["Some candles"] = `${failed.length}/${rows.length} symbols failed; showing successful results`;
  else delete state.errors["Some candles"];
  state.marketStatus = "connected";
  delete state.errors["Binance Spot"];
  updateEvents(state.coins);
}
function updateEvents(coins) {
  const now = Date.now();
  const fresh = [];
  for (const c of coins) {
    const old = previousScores.get(c.symbol);
    if (c.score >= 75 && (!old || old < 75) && now - (lastAlertAt.get(c.symbol) || 0) > 15 * 60_000) {
      fresh.push({
        id: `${c.symbol}-${now}`, symbol: c.symbol, score: c.score,
        label: c.label, message: `${c.symbol} entered Strong flow (score ${c.score}/100)`,
        time: now, type: "flow",
      });
      lastAlertAt.set(c.symbol, now);
      if (!DEMO && telegramWants("radar")) sendTelegram(`${c.symbol}: Strong flow score ${c.score}/100. ${c.reasons.join("; ")}. Research signal only.`);
    }
    previousScores.set(c.symbol, c.score);
  }
  state.events = [...fresh, ...state.events].slice(0, 100);
}
async function sendTelegram(message) { // shared queue (telegram.js): retried until delivered
  const r = await tgQueue(message, { kind: "radar" });
  if (r.sent) delete state.errors.Telegram; else if (r.error) state.errors.Telegram = r.error;
}
// Market Flow data for the AI trade desk: the Radar's live numbers for the coins it follows, and the same formula computed
// on demand for any other coin (most ignition coins are smaller than the Radar's top coins).
async function radarFlowFor(symbol) {
  const [t, k] = await Promise.all([
    fetchJson(`${BN}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`),
    fetchJson(`${BN}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=22`),
  ]);
  const m = candleMetrics(k);
  return { symbol, ...m, ...scoreCoin(t, m), volume24h: n(t.quoteVolume) || 0, updatedAt: Date.now() };
}
setMarketFlowSource({ state: () => state, flowFor: radarFlowFor });

function normalizeWeb3(row, chain) {
  const wallets = n(row.smartMoneyCount ?? row.walletCount ?? row.smartMoneyWalletCount);
  const exitRate = n(row.exitRate);
  const trigger = n(row.signalTriggerTime ?? row.createTime ?? row.timestamp);
  const directionRaw = String(row.direction ?? row.side ?? row.signalType ?? "").toLowerCase();
  return {
    id: `${chain.id}:${row.signalId ?? row.id ?? row.contractAddress ?? row.tokenAddress ?? Math.random().toString(36).slice(2)}`,
    chain: chain.name, ticker: row.ticker ?? row.symbol ?? row.tokenSymbol ?? "Unknown",
    address: row.contractAddress ?? row.tokenAddress ?? row.address ?? "",
    direction: /sell|out|exit/.test(directionRaw) ? "sell" : /buy|in|entry/.test(directionRaw) ? "buy" : "unknown",
    wallets, exitRate, time: trigger ? (trigger < 1e12 ? trigger * 1000 : trigger) : null,
    currentPrice: n(row.currentPrice ?? row.price), status: row.status ?? "unverified",
  };
}
async function fetchWeb3() {
  const all = [];
  const errors = [];
  for (const chain of CHAINS) {
    try {
      const json = await fetchJson(WEB3_API, {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ chainId: chain.id, page: 1, pageSize: 100 }),
      });
      const data = json?.data;
      const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data :
        Array.isArray(data?.list) ? data.list : Array.isArray(data?.records) ? data.records : null;
      if (!list) throw new Error("Unrecognized response schema; signal fields were not assumed");
      all.push(...list.map(r => normalizeWeb3(r, chain)));
    } catch (e) { errors.push(`${chain.name}: ${e.message}`); }
  }
  state.web3Signals = all;
  if (errors.length) {
    state.web3Status = all.length ? "partial" : "unavailable";
    state.errors["Binance Web3"] = errors.join(" | ");
  } else {
    state.web3Status = "connected";
    delete state.errors["Binance Web3"];
  }
}
function demoData() {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT", "DOGEUSDT", "LINKUSDT", "AVAXUSDT", "PEPEUSDT"];
  state.coins = symbols.map((symbol, i) => {
    const buyRatio5m = 44 + Math.random() * 25;
    const relativeVolume = 0.7 + Math.random() * 3.5;
    const change5m = (Math.random() - .45) * 1.2;
    const volume24h = (20 + Math.random() * 300) * 1e6;
    const t = { quoteVolume: String(volume24h) };
    const m = { price: symbol.startsWith("BTC") ? 65000 + Math.random()*1000 : 0.05 + Math.random()*150,
      change24h: (Math.random()-.4)*10, volume24h, trades1m: Math.floor(30+Math.random()*1800),
      buyRatio1m: buyRatio5m, sellQuote1m: 1e5, buyQuote1m: 1e5, oneMinQuote: 2e5,
      buyQuote5m: 1e6*buyRatio5m/100, sellQuote5m: 1e6*(1-buyRatio5m/100),
      netFlow5m: (buyRatio5m-50)*20000, buyRatio5m, change5m, relativeVolume,
      average1mQuote: 100000, candleTime: Date.now() - 60000 };
    return { symbol, ...m, ...scoreCoin(t,m), dataSource: "SIMULATED DEMO DATA", updatedAt: Date.now() };
  }).sort((a,b)=>b.score-a.score);
  state.marketStatus = "demo";
  state.web3Status = "demo_unavailable";
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (DEMO) demoData();
    else {
      try { await fetchMarket(); }
      catch (e) { state.marketStatus = "error"; state.errors["Binance Spot"] = e.message; }
      await fetchWeb3();
    }
    state.lastUpdated = Date.now();
  } finally { polling = false; }
}
const jsonResponse = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};
// One server for everything: Market Flow Radar at /, the Early Setup Screener (with its BTC rotation and whale tracker
// tabs) at /screener, the AI trade desk at /ai, and every API under /api.
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (await handleScreenerRequest(req, res, url)) return;
  if (await handleAiRequest(req, res, url, ai)) return;
  if (url.pathname === "/screener" || url.pathname === "/screener/") return serveScreenerPage(res);
  if (url.pathname === "/ai" || url.pathname === "/ai/") {
    try {
      const html = await readFile(path.join(here, "public", "ai.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    } catch { res.writeHead(500).end("public/ai.html is missing"); return; }
  }
  
  if (url.pathname === "/api/health") return jsonResponse(res, 200, {
    ok: true, marketStatus: state.marketStatus, web3Status: state.web3Status,
    lastUpdated: state.lastUpdated, pollIntervalMs: state.pollIntervalMs, demo: state.demo,
    errors: state.errors,
  });
  
  if (url.pathname === "/api/signals") return jsonResponse(res, 200, {
    ...state, coins: state.coins, spot: state.coins, signals: state.web3Signals, aiVerdicts: freshAiVerdicts(), telegramConfigured: telegramConfigured(),
  });

  // NEW RECURSIVE GEMINI API ENDPOINT
  if (url.pathname === "/api/analyze" && req.method === "POST") {
    // Paid Gemini call: only from this site (JSON content type and same-host Origin), so other web pages cannot trigger it.
    const sameSite = String(req.headers["content-type"] || "").includes("application/json") &&
      (!req.headers.origin || req.headers.origin.replace(/^https?:\/\//, "") === req.headers.host);
    if (!sameSite) return jsonResponse(res, 403, { error: "AI requests are only accepted from this site." });
    if (!ai) return jsonResponse(res, 500, { error: "Gemini API key is not configured on the server." });
    try {
      const body = await readJsonBody(req);
      const out = await runAnalysis(ai, state, body);
      // "Send to Telegram" ticked: the brief as plain text, through the shared queue (sent even if other kinds are off)
      const text = String(out.analysis || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)_(.+?)_(?=\s|$|[.,;])/g, "$1$2");
      const tg = body.notify === true && text ? await tgQueue(`AI MARKET BRIEF\n${text}`, { kind: "system", force: true }) : null;
      return jsonResponse(res, 200, tg ? { ...out, telegram: tg } : out);
    } catch (e) {
      const known = e instanceof AgentError;
      if (!known) console.error("Gemini agent error:", e);
      return jsonResponse(res, known ? e.status : 502, { error: known ? e.message : "Failed to generate AI analysis." });
    }
  }
  
  if (url.pathname === "/api/orderbook") {
    const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
    if (!/^[A-Z0-9]{3,20}USDT$/.test(symbol)) return jsonResponse(res, 400, { error: "Provide a valid Binance USDT spot symbol, e.g. SUIUSDT" });
    try {
      if (DEMO) {
        const mid = symbol.startsWith("BTC") ? 65000 : symbol.startsWith("ETH") ? 3200 : symbol.startsWith("SOL") ? 150 : 1.25;
        const bids = [], asks = [];
        for (let i = 1; i <= 20; i++) {
          bids.push([String(mid * (1 - i * 0.0001)), String((Math.random() * 800 + 20).toFixed(4))]);
          asks.push([String(mid * (1 + i * 0.0001)), String((Math.random() * 800 + 20).toFixed(4))]);
        }
        return jsonResponse(res, 200, { symbol, lastUpdateId: null, bids, asks, source: "SIMULATED DEMO ORDER BOOK", demo: true, updatedAt: Date.now() });
      }
      const book = await fetchJson(`${BN}/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=100`, {}, 9000);
      if (!Array.isArray(book.bids) || !Array.isArray(book.asks)) throw new Error("Unexpected Binance order-book response");
      return jsonResponse(res, 200, { symbol, lastUpdateId: book.lastUpdateId, bids: book.bids, asks: book.asks, source: "Binance Spot REST depth snapshot", demo: false, updatedAt: Date.now() });
    } catch (e) { return jsonResponse(res, 502, { error: `Order book unavailable: ${e.message}`, symbol }); }
  }
  
  if (url.pathname === "/") {
    try {
      const html = await readFile(path.join(here, "public", "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    } catch { res.writeHead(500).end("public/index.html is missing"); return; }
  }
  if (url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
});
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE"
    ? `Port ${PORT} is already in use: another copy of the app may be running. Close it, or set PORT=3005 (any free port) in .env.`
    : `Server error: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const base = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  console.log(`\nAll apps are running on one server:`);
  console.log(`  Market Flow Radar      ${base}/`);
  console.log(`  Early Setup Screener   ${base}/screener`);
  console.log(`  BTC rotation           ${base}/screener#rotation`);
  console.log(`  Whale tracker          ${base}/screener#whales`);
  console.log(`  Early 2x movers        ${base}/screener#early2x`);
  console.log(`  AI trade desk          ${base}/ai${ai ? (AI_AUTO_REVIEW ? `  (reviews every new alert, up to ${AI_REVIEWS_PER_HOUR}/hour)` : "") : "  (add GEMINI_API_KEY to .env to enable)"}\n`);
  startScreener(`${base}/screener`);
  console.log(`Refresh: ${POLL_MS / 1000}s | symbols: ${MAX_SYMBOLS} | demo: ${DEMO}`);
  if (ai) console.log("Gemini AI integration enabled.");
});
poll();
setInterval(poll, POLL_MS);

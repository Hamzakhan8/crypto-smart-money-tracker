// Smart Money / Market Flow Radar
// Node.js 22.6+. No third-party dependencies (except @google/genai).

import "./env.ts"; // first: loads .env before any module reads its settings
import type { IncomingMessage, ServerResponse } from "node:http";
import { GoogleGenAI } from "@google/genai";
import { runAnalysis, readJsonBody, AgentError, generate, MODELS, geminiErrorText } from "./agent.ts";
import { startScreener, handleScreenerRequest, onIgnitionAlert, annotateEvent, onAlphaAlert, annotateAlpha, setFlowContext, freshAiVerdicts, healthSources } from "./screener.ts";
import { createHealth } from "./health.ts";
import { handleAiRequest, reviewAlert, reviewAlpha, setMarketFlowSource, meterAi, aiCanSpend, startAiDesk } from "./ai-trade.ts";
import { sendTelegram as tgQueue, telegramWants, telegramConfigured, telegramStatus } from "./telegram.ts";
import { createNews } from "./news.ts";
import { PRESETS, pickProvider, ollamaRunning, createOpenAiClient } from "./ai-provider.ts";
import { clamp, fromThisSite, jsonResponse, sleep } from "./util.ts";
const env = process.env;
const HOST = env.HOST || "127.0.0.1";
const PORT = Number(env.PORT || 3000);
const DEMO = env.DEMO === "1";
const POLL_MS = Math.max(15, Number(env.POLL_SECONDS || 30)) * 1000;
const MAX_SYMBOLS = Math.min(60, Math.max(10, Number(env.MAX_SYMBOLS || 40)));
const MIN_QUOTE_VOLUME = Number(env.MIN_QUOTE_VOLUME || 1_000_000);
const BN = (env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");
const WEB3_API = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/web/signal/smart-money/ai";
const CHAINS = [{ id: "56", name: "BSC" }, { id: "CT_501", name: "Solana" }];

// Initialize Gemini using environment variable securely. Every request is counted for the AI desk's daily limit.
// Every Gemini request's outcome, for the status bar: the last success and the last error (a wrong key or model name shows here).
const aiStat: { lastOk: number | null; lastError: string | null; lastErrorAt: number | null } = { lastOk: null, lastError: null, lastErrorAt: null };
// Gemini, or an OpenAI-style client for a free open model (which also says which provider and model it is).
type AiClient = (GoogleGenAI & { provider?: undefined }) | ReturnType<typeof createOpenAiClient>;
function watchAi<T extends { models: { generateContent(params: unknown): Promise<unknown> } }>(client: T): T {
  if (!client) return client;
  const gen = client.models.generateContent.bind(client.models);
  const models = Object.create(client.models, { generateContent: { value: async (params: unknown) => {
    try { const r = await gen(params); aiStat.lastOk = Date.now(); return r; }
    catch (e) { aiStat.lastError = geminiErrorText(e); aiStat.lastErrorAt = Date.now(); throw e; }
  } } });
  return Object.create(client, { models: { value: models } });
}
// The AI: Gemini when GEMINI_API_KEY is set (and AI_PROVIDER does not name another), else a free open-source model
// (ai-provider.js): AI_PROVIDER=ollama for Ollama on this PC, or a free GROQ_API_KEY / OPENROUTER_API_KEY / CEREBRAS_API_KEY.
// With nothing set, Ollama is used if it is running on this PC.
async function createAi(): Promise<AiClient | null> {
  const want = String(env.AI_PROVIDER || "").toLowerCase().trim();
  if (env.GEMINI_API_KEY && (!want || want === "gemini" || want === "auto")) return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  let p = pickProvider(env);
  if (!p && (!want || want === "auto") && await ollamaRunning()) {
    const model = env.AI_MODEL || PRESETS.ollama.model;
    p = { id: "ollama", name: PRESETS.ollama.name, base: PRESETS.ollama.base, key: null, model, reviewModel: env.AI_REVIEW_MODEL || model, local: true };
  }
  if (!p) return null;
  MODELS.analyst = p.model; MODELS.reviewer = p.reviewModel; // every AI member uses the open model
  return createOpenAiClient(p);
}
const aiClient = await createAi();
const ai = aiClient ? watchAi(meterAi(aiClient)) : null;
const AI_NAME = aiClient?.provider ? `${aiClient.provider.name}: ${aiClient.provider.model}` : "Gemini";

// Every new ignition alert gets one automatic AI review (TAKE / WAIT / SKIP) by the AI committee (6 Gemini requests with
// the bull vs bear debate and the Final Boss), saved with the alert, so the screener's performance panel can show
// whether the AI's calls really do better. AI_AUTO_REVIEW=0 turns it off; AI_REVIEWS_PER_HOUR caps the cost (default 12)
// and AI_DAILY_REQUESTS caps Gemini requests per day (default 400; checked before each review).
const AI_AUTO_REVIEW = !!ai && env.AI_AUTO_REVIEW !== "0";
// News tab (screener page): market news from Google News, Binance announcements and CoinDesk (COINDESK_API_KEY), each
// marked bullish / bearish / neutral (Gemini when set up, at most one request every 30 minutes; else keyword rules).
const news = env.NEWS === "0" ? null : createNews({ ai, canSpend: () => aiCanSpend() });
// Status bar (top of the screener page) and Telegram warnings when a part stops working (health.js)
const health = createHealth({
  sendTelegram: (t, kind) => tgQueue(t, { kind }), wantTelegram: telegramWants,
  sources: [
    ...healthSources(),
    { key: "news", name: "News", every: 10, get: () => (news ? (({ status, error, updatedAt, items, labeller }) => ({ status, error, updatedAt,
      warn: /failed/.test(labeller || "") ? labeller : null, detail: `${(items || []).length} stories` }))(news.api()) : { off: true, detail: "off (NEWS=0)" }) },
    { key: "ai", name: "AI", every: 1e6, get: () => {
      if (!ai) return { off: true, detail: "not set up: add GEMINI_API_KEY to .env, or a free open-source model (AI_PROVIDER=ollama, or a free GROQ_API_KEY): see the README" };
      if (aiStat.lastErrorAt && !(aiStat.lastOk > aiStat.lastErrorAt)) return { error: `the last AI request (${AI_NAME}) failed: ${aiStat.lastError}`, updatedAt: aiStat.lastOk };
      return { updatedAt: Date.now(), warn: aiCanSpend() ? null : "today's AI limit is used up (AI_DAILY_REQUESTS): automatic reviews pause until midnight UTC",
        detail: `${AI_NAME} · ${aiStat.lastOk ? `working, last answer ${new Date(aiStat.lastOk).toISOString().slice(11, 16)} UTC` : "set up, checking it"}` };
    } },
    { key: "telegram", name: "Telegram", every: 5, alert: false, get: () => { const t = telegramStatus();
      if (!t.configured) return { off: true, detail: "not set up: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env" };
      if (t.lastError && !(t.lastSentAt > t.lastErrorAt)) return { error: t.lastError }; // red after the startup grace: messages are not going out
      return { updatedAt: Date.now(), warn: t.queued ? `${t.queued} messages waiting to send` : null, detail: t.lastSentAt ? `last message ${new Date(t.lastSentAt).toISOString().slice(11, 16)} UTC` : "ready" };
    } },
  ],
});
const AI_REVIEWS_PER_HOUR = Math.max(1, Number(env.AI_REVIEWS_PER_HOUR) || 12);
let aiReviewTimes: number[] = [];
const aiBudget = () => {
  const now = Date.now();
  aiReviewTimes = aiReviewTimes.filter((t) => now - t < 3_600_000);
  if (aiReviewTimes.length >= AI_REVIEWS_PER_HOUR) return false;
  aiReviewTimes.push(now);
  return true;
};
if (AI_AUTO_REVIEW) onIgnitionAlert(async (ev) => {
  if (!aiCanSpend() || !aiBudget()) return;
  try { annotateEvent(ev.id, { ai: await reviewAlert(ai, ev.symbol, ev.tier) }); }
  catch (e) { annotateEvent(ev.id, { ai: { error: e.message, at: Date.now() } }); }
});
// Confirmed Alpha alerts get the same automatic review while Alpha alerts go to Telegram (ALPHA_AI_REVIEW=all: early
// ones too and always, =0: none), from the same hourly budget.
if (AI_AUTO_REVIEW && env.ALPHA_AI_REVIEW !== "0") onAlphaAlert(async (a) => {
  if (env.ALPHA_AI_REVIEW !== "all" && (a.tier !== "confirmed" || !telegramWants("alpha"))) return;
  if (!aiCanSpend() || !aiBudget()) return;
  try { annotateAlpha(a.id, { ai: await reviewAlpha(ai, a) }); }
  catch (e) { annotateAlpha(a.id, { ai: { error: e.message, at: Date.now() } }); }
});
// Saved with every alert: the share of Market Flow Radar coins whose last 5 minutes were mostly aggressive buying.
setFlowContext(() => {
  const cs = (state.coins || []).filter((c) => Number.isFinite(c.buyRatio5m));
  return cs.length >= 10 ? { buyShare: Math.round((cs.filter((c) => c.buyRatio5m >= 55).length / cs.length) * 100) } : null;
});

// One Market Flow Radar coin: its last 1-minute candles' flow numbers and score.
type RadarCoin = CandleMetrics & ReturnType<typeof scoreCoin> & { symbol: string; change24h: number | null; volume24h: number; dataSource: string; updatedAt: number };
interface FlowEvent { id: string; symbol: string; score: number; label: string; message: string; time: number; type: string }
const state: {
  startedAt: number; lastUpdated: number | null; pollIntervalMs: number; demo: boolean; marketStatus: string; web3Status: string;
  errors: Record<string, string>; coins: RadarCoin[]; web3Signals: ReturnType<typeof normalizeWeb3>[]; events: FlowEvent[];
} = {
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
let previousScores = new Map<string, number>();
let lastAlertAt = new Map<string, number>();

const n = (v: unknown): number | null => {
  const x = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(x) ? null : x;
};

async function fetchJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}, timeoutMs = 9000): Promise<any> {
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
// A Binance 24h ticker (the fields used here; numbers come as text).
interface Ticker24h { symbol: string; quoteVolume: string | number; priceChangePercent?: string | number }
type Kline = (string | number)[];
type CandleMetrics = ReturnType<typeof candleMetrics>;
function isUsdtSpot(t: Ticker24h) {
  const s = t.symbol || "";
  return s.endsWith("USDT") &&
    !/(UP|DOWN|BULL|BEAR)USDT$/.test(s) &&
    n(t.quoteVolume) >= MIN_QUOTE_VOLUME;
}
function candleMetrics(klines: Kline[]) {
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
function scoreCoin(ticker: Pick<Ticker24h, "quoteVolume">, m: CandleMetrics) {
  let score = 0;
  const reasons: string[] = [];
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
// A failed item's result is { _error, _item } instead of fn's value.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<(R & { _error?: string; _item?: T })[]> {
  const results: (R | { _error: string; _item: T })[] = new Array(items.length);
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
  return results as (R & { _error?: string; _item?: T })[];
}
async function fetchMarket() {
  const tickerData = await fetchJson(`${BN}/api/v3/ticker/24hr`, {}, 12000);
  if (!Array.isArray(tickerData)) throw new Error("Unexpected 24h ticker response");
  const tickers: Ticker24h[] = tickerData.filter(isUsdtSpot).sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0, MAX_SYMBOLS);
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
function updateEvents(coins: RadarCoin[]) {
  const now = Date.now();
  const fresh: FlowEvent[] = [];
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
async function sendTelegram(message: string) { // shared queue (telegram.js): retried until delivered
  const r = await tgQueue(message, { kind: "radar" });
  if (r.sent) delete state.errors.Telegram; else if (r.error) state.errors.Telegram = r.error;
}
// Market Flow data for the AI trade desk: the Radar's live numbers for the coins it follows, and the same formula computed
// on demand for any other coin (most ignition coins are smaller than the Radar's top coins).
async function radarFlowFor(symbol: string) {
  const [t, k] = await Promise.all([
    fetchJson(`${BN}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`),
    fetchJson(`${BN}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=22`),
  ]);
  const m = candleMetrics(k);
  return { symbol, ...m, ...scoreCoin(t, m), volume24h: n(t.quoteVolume) || 0, updatedAt: Date.now() };
}
setMarketFlowSource({ state: () => state, flowFor: radarFlowFor });

// One smart-money signal as Binance Web3 sends it (field names differ between versions, so each has fallbacks).
type Web3Field = string | number | null;
interface Web3Row {
  smartMoneyCount?: Web3Field; walletCount?: Web3Field; smartMoneyWalletCount?: Web3Field; exitRate?: Web3Field; signalTriggerTime?: Web3Field;
  createTime?: Web3Field; timestamp?: Web3Field; direction?: Web3Field; side?: Web3Field; signalType?: Web3Field; signalId?: Web3Field; id?: Web3Field;
  contractAddress?: string; tokenAddress?: string; address?: string; ticker?: string; symbol?: string; tokenSymbol?: string;
  currentPrice?: Web3Field; price?: Web3Field; status?: string;
}
function normalizeWeb3(row: Web3Row, chain: { id: string; name: string }) {
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
  const all: ReturnType<typeof normalizeWeb3>[] = [];
  const errors: string[] = [];
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
      all.push(...list.map((r: Web3Row) => normalizeWeb3(r, chain)));
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
// Every API under /api (the pages are the Next.js app in src/, served by next-server.ts). fallback answers the rest.
type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;
const notFound: Handler = (req, res) => res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
export function createHandler({ fallback = notFound }: { fallback?: Handler } = {}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/status") return jsonResponse(res, 200, health.api());
    if (url.pathname === "/api/news") return jsonResponse(res, 200, news ? news.api() : { status: "off", error: "The News tab is off (NEWS=0 in .env)" });
    if (await handleScreenerRequest(req, res, url)) return;
    if (await handleAiRequest(req, res, url, ai)) return;
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
      const sameSite = fromThisSite(req);
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
          const bids: [string, string][] = [], asks: [string, string][] = [];
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
    if (url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
    return fallback(req, res);
  };
}
export const listenOn = { PORT, HOST, base: `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}` };
export const onListenError = (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE"
    ? `Port ${PORT} is already in use: another copy of the app may be running. Close it, or set PORT=3005 (any free port) in .env.`
    : `Server error: ${e.message}`);
  process.exit(1);
};
// Starts every part (the scanners, the AI desk, news, the status bar, the Market Flow poll) once the server listens.
export function startServices(base = listenOn.base) {
  console.log(`\nAll apps are running on one server:`);
  console.log(`  Market Flow Radar      ${base}/`);
  console.log(`  Early Setup Screener   ${base}/screener`);
  console.log(`  BTC rotation           ${base}/screener#rotation`);
  console.log(`  Early 2x movers        ${base}/screener#early2x`);
  console.log(`  Spot plan, Pump watch  ${base}/screener (Ignition tab, tags "Spot plan" and "Pump watch")`);
  console.log(`  Perps, Scalp, bot      ${base}/screener#perps (tags "Swing signals", "Scalp", "Paper bot")`);
  console.log(`  News                   ${base}/screener#news`);
  console.log(`  Whales, whale signals  ${base}/screener#whales (crowd vs smart money: tag "Crowd vs smart money")`);
  console.log(`  AI trade desk          ${base}/ai${ai ? `  (${AI_NAME}${AI_AUTO_REVIEW ? `, reviews every new alert, up to ${AI_REVIEWS_PER_HOUR}/hour` : ""})` : "  (add GEMINI_API_KEY, or a free open model: AI_PROVIDER=ollama or GROQ_API_KEY)"}\n`);
  startScreener(`${base}/screener`);
  startAiDesk(ai); // follows every AI answer and watches WAIT triggers
  if (news) news.start();
  health.start();
  // check the Gemini key and model once at start (one tiny request), so a wrong key shows in the status bar right away
  if (ai) generate(ai, { model: MODELS.analyst, contents: "Reply with the single word OK." }, { retries: 0, timeoutMs: 30_000 })
    .then(() => console.log(`AI (${AI_NAME}): key and model ${MODELS.analyst} work`)).catch((e) => console.log(`AI (${AI_NAME}): the test request failed: ${geminiErrorText(e)}`));
  console.log(`Refresh: ${POLL_MS / 1000}s | symbols: ${MAX_SYMBOLS} | demo: ${DEMO}`);
  if (ai) console.log(`AI enabled: ${AI_NAME}.`);
  poll();
  setInterval(poll, POLL_MS);
}

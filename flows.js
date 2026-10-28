// DEX rotations (part of the "Whale tracker" tab): follows DEX swaps (who swapped which token into which) and alerts on them.
// Node.js 18+, no dependencies, no API key.
//
// Where the swaps come from
//   - Ethereum: every swap on every DEX and aggregator, rebuilt by the whale tracker from the blocks it already reads
//     (whales.js, swapsFromLegs). Any token with $50k+ of DEX liquidity is covered.
//   - Other networks (FLOWS_NETWORKS, default Base, Solana, BNB Chain): the public GeckoTerminal API (about 10-30 calls/min
//     free), so only some pools: the trending pools and the ones with the most real traders (not the most volume, which
//     is easy to fake), the pools of every pair you watch, and for 6 hours the pools of every token with a new Binance
//     Alpha alert. If the Ethereum feed stops for 15 minutes, Ethereum falls back to GeckoTerminal pools.
//   - Every swap above FLOWS_MIN_TRADE_USD is recorded: token sold, token bought, wallet, USD.
//   - Router trades that hop through several pools in one transaction are joined (ETH -> USDC -> PEPE = ETH -> PEPE),
//     and loops that end in the token they started with (arbitrage) are dropped.
//   - Bot-like wallets are left out of flows and alerts: round trips within 5 minutes (MEV sandwiches) or 40+ swaps/hour.
//
// Alerts (Telegram + popups on the page)
//   - Whale swap: one swap >= FLOWS_WHALE_USD into or out of a token (ETH <-> stablecoin swaps are ignored).
//   - Pair watch: any swap on a watched route (e.g. ETH -> PEPE) at or above that watch's minimum.
//   - Rotation surge: in the last 15 minutes, FROM -> TO flow >= FLOWS_SURGE_USD from FLOWS_SURGE_WALLETS+ wallets,
//     mostly one-way, and FLOWS_SURGE_MULT x its normal 15-minute level over the past day.
//   - Wallet rotation: one wallet sells token A and buys token B within FLOWS_ROTATION_MINUTES, >= FLOWS_ROTATION_USD.
//
// Runs inside the Early Setup Screener: the DEX section of the "Whale tracker" tab (/api/flows), started by screener.js.
// Own state file. Set SCREENER_WHALES=0 to switch it off. It shows what wallets did; it cannot tell why or what comes
// next. Not financial advice.

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendTelegram as tgQueue, telegramWants } from "./telegram.js";
import { labelOf } from "./whales.js"; // names of Ethereum routers / DEXes, which can arrive after the swap

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO = env.DEMO === "1";
const NETWORKS = (env.FLOWS_NETWORKS || "eth,base,solana,bsc").split(",").map((s) => s.trim()).filter(Boolean);
const POOLS_PER_NETWORK = num("FLOWS_POOLS_PER_NETWORK", 6);   // GeckoTerminal networks: token pools followed per network
const MIN_TRADERS_1H = num("FLOWS_MIN_TRADERS_1H", 20);        // a pool needs this many different wallets trading in the last hour
const FOLLOW_HOURS = num("FLOWS_FOLLOW_HOURS", 6);             // pools of a token with a new Alpha alert are followed this long
const FOLLOW_MIN_RESERVE_USD = 20_000;
const MIN_TRADE_USD = num("FLOWS_MIN_TRADE_USD", 2000);        // smaller swaps are not fetched
const MIN_RESERVE_USD = num("FLOWS_MIN_RESERVE_USD", 250_000); // skip thin pools (easy to fake volume)
const CALLS_PER_MIN = clamp(num("FLOWS_CALLS_PER_MIN", 10), 1, 30); // free GeckoTerminal tier; slows down further after a 429
const WHALE_USD = num("FLOWS_WHALE_USD", 100_000);
const SURGE_USD = num("FLOWS_SURGE_USD", 50_000);
const SURGE_WALLETS = num("FLOWS_SURGE_WALLETS", 3);
const SURGE_MULT = num("FLOWS_SURGE_MULT", 3);
const SURGE_ONE_WAY = 0.7;                                      // share of the pair's two-way flow going FROM -> TO
const ROTATION_USD = num("FLOWS_ROTATION_USD", 25_000);
const ROTATION_MS = num("FLOWS_ROTATION_MINUTES", 30) * 60_000;
const COOLDOWN_MS = num("FLOWS_COOLDOWN_MINUTES", 60) * 60_000; // per route, for surge alerts
const DEFAULT_WATCH = env.FLOWS_WATCH ?? "eth:ETH-PEPE:10000"; // first run only: "network:FROM-TO:minUsd", comma-separated
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;
const TELEGRAM_ON = () => telegramWants("flows"); // off by default (FLOWS_TELEGRAM=1 or the switch on the page)
const GT = "https://api.geckoterminal.com/api/v2";
const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const DISCOVERY_MS = 30 * MIN;
const FRESH_MS = 10 * MIN;       // only swaps newer than this can alert (a pool's first fetch returns up to 24h of history)
const BASELINE_MIN_MS = 3 * HOUR; // surge "vs normal" needs at least this much history
const BOT_SWAPS_PER_HOUR = 40;
const BOT_ROUND_TRIP_MS = 5 * MIN;
const MAX_EVENTS = 300;
const WINDOWS = { "15m": 15 * MIN, "1h": HOUR, "24h": DAY };
const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, DEMO ? "flows_state.demo.json" : "flows_state.json");

const CHAINS = {
  eth: { name: "Ethereum", native: ["ETH", "WETH"], explorer: "https://etherscan.io" },
  base: { name: "Base", native: ["ETH", "WETH"], explorer: "https://basescan.org" },
  arbitrum: { name: "Arbitrum", native: ["ETH", "WETH"], explorer: "https://arbiscan.io" },
  bsc: { name: "BNB Chain", native: ["BNB", "WBNB"], explorer: "https://bscscan.com" },
  polygon_pos: { name: "Polygon", native: ["POL", "WPOL", "MATIC", "WMATIC"], explorer: "https://polygonscan.com" },
  solana: { name: "Solana", native: ["SOL", "WSOL"], explorer: "https://solscan.io", account: "account" },
};
const chain = (net) => CHAINS[net] || { name: net, native: [], explorer: null };
const txUrl = (net, tx) => (chain(net).explorer ? `${chain(net).explorer}/tx/${tx}` : null);
const walletUrl = (net, a) => (chain(net).explorer ? `${chain(net).explorer}/${chain(net).account || "address"}/${a}` : null);
const poolUrl = (net, a) => `https://www.geckoterminal.com/${net}/pools/${a}`;
const STABLE_RE = /USD|^DAI$|^EUR/i;
const STOCK_RE = /^[A-Z]{1,6}[cx]$/; // tokenized stocks: a ticker with a lowercase c or x (MSTRc, SNDKc, TSLAx, SPYx)
// Wrapped / staked BTC and ETH move with their underlying, so like ETH and stablecoins they count as "majors", not tokens.
const MAJOR_RE = /^(W|CB|T|Z|LB|SOL)?BTC(B)?$|^BTC\.B$|^(ST|WST|WE|CB|R|EZ|RS)ETH$/i;
const classOf = (net, symbol) => (isNativeSym(net, symbol) ? "native" : STABLE_RE.test(symbol || "") ? "stable" : MAJOR_RE.test(symbol || "") ? "major" : "token");
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "?");
export const fmtUsd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${Math.round(v)}`);

const state = {
  startedAt: Date.now(), lastUpdated: null, demo: DEMO, status: "starting", errors: {},
  events: [], watches: [],
  telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
};
const tokens = new Map();     // token key -> { key, net, address, symbol, cls: native | stable | major | token }
const addrIndex = new Map();  // "net:address" -> token key
const pools = new Map();      // "net:address" -> pool
const swaps = [];             // recent swaps (24h), unsorted between prunes
const seen = new Set();       // GeckoTerminal trade ids already recorded
const lastAlertAt = new Map();
const discoveredAt = new Map(), discoverRetryAt = new Map();
const callLog = [];           // timestamps of API calls (last minute)
const washPools = new Set();  // pools whose swaps were mostly bot-like: skipped at the next refresh
const onchain = new Map();    // network -> { since, lastAt, count } for networks whose swaps come from the blocks (Ethereum)
const pendingFollows = [];    // { net, address, symbol, reason }
let pausedUntil = 0, nextCallAt = 0, callRate = CALLS_PER_MIN, lastLimitAt = 0;

// ───────────────────────────── tokens + pools ─────────────────────────────
const normAddr = (net, a) => (net === "solana" ? String(a || "") : String(a || "").toLowerCase());
const isNativeSym = (net, sym) => chain(net).native.includes(String(sym || "").toUpperCase());
const tokenKey = (net, address, symbol) => (isNativeSym(net, symbol) ? `${net}:native` : `${net}:${normAddr(net, address)}`);
const isMajor = (key) => { const t = tokens.get(key); return !!t && t.cls !== "token"; };
const sym = (key) => tokens.get(key)?.symbol || "?";

function registerToken(net, t) {
  const key = tokenKey(net, t.address, t.symbol);
  if (!tokens.has(key)) {
    const native = key.endsWith(":native");
    const symbol = native ? chain(net).native[0] : String(t.symbol || "?");
    tokens.set(key, { key, net, address: native ? null : t.address, symbol, cls: classOf(net, symbol) });
  }
  addrIndex.set(`${net}:${normAddr(net, t.address)}`, key);
  return key;
}

// Pools from a GeckoTerminal list response (needs include=base_token,quote_token).
function parsePools(json, net) {
  const inc = new Map((json?.included || []).map((t) => [t.id, t.attributes || {}]));
  const out = [];
  for (const p of json?.data || []) {
    const a = p.attributes || {}, rel = p.relationships || {};
    const b = inc.get(rel.base_token?.data?.id), q = inc.get(rel.quote_token?.data?.id);
    const pnet = net || String(p.id || "").slice(0, String(p.id || "").lastIndexOf("_"));
    if (!b || !q || !a.address || (!CHAINS[pnet] && !NETWORKS.includes(pnet))) continue;
    out.push({
      net: pnet, address: a.address, name: a.name, dex: rel.dex?.data?.id || "dex",
      base: { address: b.address, symbol: b.symbol }, quote: { address: q.address, symbol: q.symbol },
      volume24h: Number(a.volume_usd?.h24) || 0, reserveUsd: Number(a.reserve_in_usd) || 0,
      traders1h: (Number(a.transactions?.h1?.buyers) || 0) + (Number(a.transactions?.h1?.sellers) || 0),
    });
  }
  return out;
}

function addPool(d, source) {
  const key = `${d.net}:${normAddr(d.net, d.address)}`;
  const baseKey = registerToken(d.net, d.base), quoteKey = registerToken(d.net, d.quote);
  let p = pools.get(key);
  if (!p) {
    p = { key, net: d.net, address: d.address, name: d.name, dex: d.dex, baseKey, quoteKey, volume24h: d.volume24h, reserveUsd: d.reserveUsd,
      top: false, watch: false, lastPoll: 0, coverageStart: null, swaps24h: 0, error: null, desc: d };
    pools.set(key, p);
  }
  if (source === "top") p.top = true;
  if (source === "watch") p.watch = true;
  if (source === "follow") p.follow = true;
  p.volume24h = d.volume24h || p.volume24h;
  return p;
}

// ───────────────────────────── GeckoTerminal client (paced) ─────────────────────────────
async function gt(pathQuery) {
  const now = Date.now(), at = Math.max(now, nextCallAt, pausedUntil);
  if (callRate < CALLS_PER_MIN && now - lastLimitAt > 10 * MIN) { callRate++; lastLimitAt = now; } // creep back up
  nextCallAt = at + 60_000 / callRate;
  if (at > now) await sleep(at - now);
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    callLog.push(Date.now());
    const res = await fetch(GT + pathQuery, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "OnchainRotationTracker/1.0" } });
    if (res.status === 429) {
      callRate = Math.max(4, Math.floor(callRate * 0.6)); lastLimitAt = pausedUntil = Date.now() + 60_000;
      throw new Error(`HTTP 429 (rate limited: pausing 60s, then ${callRate} requests/min)`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

// Ranks candidate pools by real activity: different wallets trading in the last hour, not volume (one bot can fake
// millions of volume; it cannot fake hundreds of wallets). Pools without real liquidity are dropped.
export function pickPools(list, net, n = POOLS_PER_NETWORK, skip = () => false) {
  const cls = (t) => classOf(net, t.symbol);
  const majorsOnly = (d) => cls(d.base) !== "token" && cls(d.quote) !== "token";
  const stock = (d) => [d.base, d.quote].some((t) => STOCK_RE.test(String(t.symbol || ""))); // tokenized stocks: not crypto flows
  const seenAddr = new Set(), ok = [];
  for (const d of list) {
    const k = normAddr(net, d.address);
    if (seenAddr.has(k) || skip(d) || stock(d) || d.reserveUsd < MIN_RESERVE_USD) continue;
    seenAddr.add(k); ok.push(d);
  }
  const byTraders = (a, b) => (b.traders1h || 0) - (a.traders1h || 0);
  // The most active token pools, plus the single most active native <-> stablecoin pool as a gauge of risk-on / risk-off.
  return [...ok.filter((d) => !majorsOnly(d) && (d.traders1h || 0) >= MIN_TRADERS_1H).sort(byTraders).slice(0, n),
    ...ok.filter((d) => majorsOnly(d) && (cls(d.base) === "native" || cls(d.quote) === "native")).sort(byTraders).slice(0, 1).map((d) => ({ ...d, gauge: true }))];
}

async function discover(net) {
  try {
    const list = [];
    for (const q of [`/networks/${net}/trending_pools?page=1&include=base_token,quote_token`, `/networks/${net}/pools?page=1&sort=h24_tx_count_desc&include=base_token,quote_token`]) {
      try { list.push(...parsePools(await gt(q), net)); } catch (e) { if (!list.length && q.includes("sort=")) throw e; }
    }
    const picked = pickPools(list, net, POOLS_PER_NETWORK, (d) => washPools.has(`${net}:${normAddr(net, d.address)}`));
    const keep = new Set(picked.map((d) => { const p = addPool(d, "top"); p.gauge = !!d.gauge; return p.key; }));
    for (const p of pools.values()) if (p.net === net && p.top && !keep.has(p.key)) { p.top = false; if (!p.watch && !p.follow) pools.delete(p.key); }
    discoveredAt.set(net, Date.now());
    delete state.errors[`Pools ${chain(net).name}`];
  } catch (e) {
    discoverRetryAt.set(net, Date.now() + 2 * MIN);
    if (!/429/.test(e.message)) state.errors[`Pools ${chain(net).name}`] = e.message; // a 429 just slows the queue down
  }
}

// Log index is the second-to-last part of a trade id ("eth_<block>_<tx>_<logIndex>_<time>").
const logIndex = (id) => { const parts = String(id).split("_"); return Number(parts[parts.length - 2]) || 0; };

async function pollPool(p) {
  const now = Date.now();
  let rows;
  try {
    const json = await gt(`/networks/${p.net}/pools/${p.address}/trades?trade_volume_in_usd_greater_than=${MIN_TRADE_USD}`);
    rows = Array.isArray(json?.data) ? json.data : [];
    p.error = null;
  } catch (e) {
    p.error = /429/.test(e.message) ? "rate limited, will retry" : e.message; p.lastPoll = now;
    if (!/429/.test(e.message)) state.errors.GeckoTerminal = `${p.name}: ${e.message}`;
    return;
  }
  delete state.errors.GeckoTerminal;
  let overlap = false, oldest = Infinity;
  for (const r of rows) {
    const a = r.attributes || {}, t = Date.parse(a.block_timestamp);
    if (Number.isFinite(t)) oldest = Math.min(oldest, t);
    if (seen.has(r.id)) { overlap = true; continue; }
    if (a.is_anomalous || !(now - t < DAY)) continue;
    const from = addrIndex.get(`${p.net}:${normAddr(p.net, a.from_token_address)}`);
    const to = addrIndex.get(`${p.net}:${normAddr(p.net, a.to_token_address)}`);
    const usd = Number(a.volume_in_usd);
    if (!from || !to || from === to || !(usd > 0)) continue;
    seen.add(r.id);
    swaps.push({ id: r.id, net: p.net, pool: p.key, dex: p.dex, t, tx: a.tx_hash, log: logIndex(r.id), wallet: a.tx_from_address,
      from, to, usd, fromAmt: Number(a.from_token_amount), toAmt: Number(a.to_token_amount) });
  }
  // Up to 300 trades come back. Fewer means the whole past day is covered; a full page with nothing already seen
  // means trades may have been missed in between, so the "normal level" history restarts there.
  if (!p.lastPoll || (!overlap && rows.length >= 300)) p.coverageStart = rows.length >= 300 && Number.isFinite(oldest) ? oldest : now - DAY;
  p.lastPoll = now;
}

// ───────────────────────────── swaps from the blocks (Ethereum) ─────────────────────────────
// A network whose swaps come from the blocks is "on-chain": its GeckoTerminal pools are not used (they would count the
// same trades twice) while the feed delivers. screener.js declares Ethereum at start when the whale tracker runs.
const ONCHAIN_STALE_MS = 15 * MIN;
export const onchainActive = (net) => { const o = onchain.get(net); return !!o && Date.now() - o.lastAt < ONCHAIN_STALE_MS; };
export function useOnchain(net) { if (!onchain.has(net)) onchain.set(net, { since: Date.now(), lastAt: Date.now(), count: 0 }); }
let analyzeTimer = null;
// swaps: [{ id, tx, t, wallet, from: { address, symbol }, to: { address, symbol }, fromAmt, toAmt, usd, dex, safe }]
export function ingestOnchain(net, list) {
  const now = Date.now();
  useOnchain(net);
  const o = onchain.get(net);
  o.lastAt = now;
  for (const x of list) {
    const id = `oc:${x.id}`;
    if (seen.has(id) || !(now - x.t < DAY) || !(x.usd >= MIN_TRADE_USD)) continue;
    const from = registerToken(net, x.from), to = registerToken(net, x.to);
    if (from === to) continue;
    seen.add(id);
    o.since = Math.min(o.since, x.t); o.count++;
    swaps.push({ id, net, pool: `${net}:onchain`, dex: x.dex || "DEX", router: x.router || null, t: x.t, tx: x.tx, log: 0, wallet: x.wallet, safe: !!x.safe,
      from, to, usd: x.usd, fromAmt: x.fromAmt, toAmt: x.toAmt });
  }
  if (!analyzeTimer && started) analyzeTimer = setTimeout(() => { analyzeTimer = null; try { analyze(); } catch (e) { state.errors.Scanner = e.message; } }, 1500);
}

// ───────────────────────────── analysis ─────────────────────────────
function prune(now) {
  swaps.sort((a, b) => a.t - b.t);
  let cut = 0;
  while (cut < swaps.length && now - swaps[cut].t > DAY) seen.delete(swaps[cut++].id);
  if (cut) swaps.splice(0, cut);
  for (const [k, t] of lastAlertAt) if (now - t > DAY) lastAlertAt.delete(k);
}

// Swaps in one transaction, in log order, are joined while each leg starts with the token the last one ended with.
export function buildRoutes(list) {
  const byTx = new Map();
  for (const s of list) {
    const k = `${s.net}:${s.tx}`;
    if (!byTx.has(k)) byTx.set(k, []);
    byTx.get(k).push(s);
  }
  const routes = [];
  for (const legs of byTx.values()) {
    legs.sort((a, b) => a.log - b.log);
    let cur = null;
    for (const s of legs) {
      if (cur && cur.to === s.from) {
        cur.to = s.to; cur.toAmt = s.toAmt; cur.usd = Math.max(cur.usd, s.usd); cur.hops++; cur.pools.add(s.pool);
        continue;
      }
      if (cur) routes.push(cur);
      cur = { id: s.id, net: s.net, tx: s.tx, t: s.t, wallet: s.wallet, from: s.from, to: s.to, usd: s.usd, fromAmt: s.fromAmt,
        toAmt: s.toAmt, dex: s.dex, router: s.router || null, safe: !!s.safe, hops: 1, pools: new Set([s.pool]) };
    }
    if (cur) routes.push(cur);
  }
  return routes.filter((r) => r.from !== r.to).sort((a, b) => a.t - b.t); // A -> ... -> A is an arbitrage loop
}

// Bot-like wallets: a round trip on the same pair within minutes (sandwich / arbitrage), or very many swaps per hour.
export function findBots(routes, now) {
  const byWallet = new Map(), bots = new Set();
  for (const r of routes) {
    if (!byWallet.has(r.wallet)) byWallet.set(r.wallet, []);
    byWallet.get(r.wallet).push(r);
  }
  for (const [w, list] of byWallet) {
    if (list.filter((r) => now - r.t <= HOUR).length >= BOT_SWAPS_PER_HOUR) { bots.add(w); continue; }
    for (let i = 0; i < list.length && !bots.has(w); i++) {
      for (let j = i + 1; j < list.length && list[j].t - list[i].t <= BOT_ROUND_TRIP_MS; j++) {
        if (list[j].from === list[i].to && list[j].to === list[i].from) { bots.add(w); break; }
      }
    }
  }
  return bots;
}

const coverageOf = (k) => (k.endsWith(":onchain") ? onchain.get(k.slice(0, k.indexOf(":")))?.since : pools.get(k)?.coverageStart);
const poolCoverage = (r) => Math.max(...[...r.pools].map((k) => coverageOf(k) ?? Infinity));

// FROM -> TO totals for one window, with the reverse flow and the route's normal level for a window of that length.
export function edgesFor(routes, now, windowMs, coverageOf = poolCoverage) {
  const map = new Map();
  for (const r of routes) {
    const k = `${r.from}>${r.to}`;
    let e = map.get(k);
    if (!e) map.set(k, (e = { key: k, net: r.net, from: r.from, to: r.to, usd: 0, n: 0, wallets: new Set(), largest: 0, prior: 0, covStart: 0 }));
    const cov = coverageOf(r);
    e.covStart = Math.max(e.covStart, Number.isFinite(cov) ? cov : now);
    if (now - r.t <= windowMs) { e.usd += r.usd; e.n++; e.wallets.add(r.wallet); e.largest = Math.max(e.largest, r.usd); }
    else if (r.t >= cov) e.prior += r.usd;
  }
  const out = [];
  for (const e of map.values()) {
    if (!(e.usd > 0)) continue;
    const rev = map.get(`${e.to}>${e.from}`)?.usd || 0;
    const baseMs = Math.min(DAY, now - e.covStart) - windowMs;
    const normal = baseMs >= BASELINE_MIN_MS ? (e.prior / baseMs) * windowMs : null;
    out.push({ ...e, wallets: e.wallets.size, reverse: rev, oneWay: e.usd / (e.usd + rev), normal,
      vsNormal: normal == null ? null : normal > 0 ? e.usd / normal : Infinity });
  }
  return out.sort((a, b) => b.usd - a.usd);
}

// A wallet that sells token A (for ETH/SOL/stablecoins) and buys token B within ROTATION_MS rotated A -> B.
export function walletRotations(routes, isMajorKey = isMajor, windowMs = ROTATION_MS) {
  const sells = new Map(), out = [];
  for (const r of routes) {
    const w = `${r.net}:${r.wallet}`;
    if (!isMajorKey(r.from) && isMajorKey(r.to)) { if (!sells.has(w)) sells.set(w, []); sells.get(w).push(r); continue; }
    if (!(isMajorKey(r.from) && !isMajorKey(r.to))) continue;
    const s = (sells.get(w) || []).filter((x) => x.from !== r.to && r.t - x.t <= windowMs && r.t >= x.t).pop();
    if (s) out.push({ id: `${s.id}|${r.id}`, net: r.net, wallet: r.wallet, from: s.from, to: r.to, via: r.from, t: r.t,
      usd: Math.min(s.usd, r.usd), sellUsd: s.usd, buyUsd: r.usd, sellTx: s.tx, buyTx: r.tx, gapMin: Math.round((r.t - s.t) / MIN) });
  }
  return out;
}

let cache = null; // latest analysis, rebuilt after every poll
function analyze() {
  const now = Date.now();
  prune(now);
  const all = buildRoutes(swaps.filter((x) => x.pool.endsWith(":onchain") || !onchainActive(x.net))); // on-chain networks: no double counting
  const bots = findBots(all, now);
  const routes = all.filter((r) => !bots.has(r.wallet));
  for (const p of pools.values()) { p.swaps24h = 0; p.botSwaps = 0; }
  for (const s of swaps) { const p = pools.get(s.pool); if (p) { p.swaps24h++; if (bots.has(s.wallet)) p.botSwaps++; } }
  for (const p of pools.values()) if (!p.watch && !p.follow && !p.gauge && p.swaps24h >= 50 && p.botSwaps / p.swaps24h >= 0.8) washPools.add(p.key);
  cache = { now, all, routes, bots, rotations: walletRotations(routes), edges: {} };
  for (const [w, ms] of Object.entries(WINDOWS)) cache.edges[w] = edgesFor(routes, now, ms);
  checkAlerts(cache);
  state.lastUpdated = now;
}

// ───────────────────────────── alerts ─────────────────────────────
const normSym = (s) => { const u = String(s || "").trim().toUpperCase(); for (const c of Object.values(CHAINS)) if (c.native.includes(u)) return c.native[0]; return u; };
const routeLabel = (from, to) => `${sym(from)} → ${sym(to)}`;

function fire(key, type, ev, cooldown = 0) {
  const now = Date.now();
  if (lastAlertAt.has(key) && now - lastAlertAt.get(key) < (cooldown || DAY)) return;
  lastAlertAt.set(key, now);
  const e = { id: `${type}:${now}:${Math.random().toString(36).slice(2, 7)}`, type, time: now, ...ev };
  state.events = [e, ...state.events].slice(0, MAX_EVENTS);
  if (!DEMO && TELEGRAM_ON() && state.telegramConfigured) {
    const label = { whale: "WHALE SWAP", watch: "PAIR WATCH", surge: "ROTATION SURGE", rotation: "WALLET ROTATION" }[type] || type.toUpperCase();
    sendTelegram([`${label} · ${chain(e.net).name}`, e.title, ...(e.lines || []), ...(e.links || []).map((l) => `${l.label}: ${l.url}`),
      "Research signal only, not financial advice."].join("\n"));
  }
  persist();
}

function checkAlerts({ now, routes, rotations, edges }) {
  const fresh = (t) => now - t <= FRESH_MS && t >= state.startedAt - FRESH_MS;
  for (const r of routes) {
    if (!fresh(r.t)) continue;
    const links = [{ label: "tx", url: txUrl(r.net, r.tx) }, { label: "wallet", url: walletUrl(r.net, r.wallet) }].filter((l) => l.url);
    const lines = [`Wallet ${short(r.wallet)} · ${r.dex}${r.hops > 1 ? ` · ${r.hops} hops` : ""}`];
    for (const w of state.watches) {
      const fwd = sym(r.from) === w.from && sym(r.to) === w.to, back = w.both && sym(r.from) === w.to && sym(r.to) === w.from;
      if ((fwd || back) && (w.net === "*" || w.net === r.net) && r.usd >= w.minUsd) {
        fire(`watch:${w.id}:${r.net}:${r.tx}`, "watch", { net: r.net, from: sym(r.from), to: sym(r.to), usd: r.usd,
          title: `${fmtUsd(r.usd)} ${routeLabel(r.from, r.to)}`, lines: [...lines, `Watch: ${w.from}-${w.to} from ${fmtUsd(w.minUsd)}`], links });
      }
    }
    if (r.usd >= WHALE_USD && !(isMajor(r.from) && isMajor(r.to))) {
      fire(`whale:${r.net}:${r.tx}`, "whale", { net: r.net, from: sym(r.from), to: sym(r.to), usd: r.usd,
        title: `${fmtUsd(r.usd)} ${routeLabel(r.from, r.to)}`, lines, links });
    }
  }
  for (const e of edges["15m"]) {
    if (isMajor(e.from) && isMajor(e.to)) continue;
    if (e.usd < SURGE_USD || e.wallets < SURGE_WALLETS || e.oneWay < SURGE_ONE_WAY) continue;
    if (e.vsNormal == null ? e.usd < 2 * SURGE_USD : e.vsNormal < SURGE_MULT) continue; // no history yet: ask for twice the size
    fire(`surge:${e.key}`, "surge", { net: e.net, from: sym(e.from), to: sym(e.to), usd: e.usd,
      title: `${fmtUsd(e.usd)} rotated ${routeLabel(e.from, e.to)} in 15 min`,
      lines: [`${e.n} swaps by ${e.wallets} wallets, ${Math.round(e.oneWay * 100)}% one-way (${fmtUsd(e.reverse)} back)`,
        e.vsNormal == null ? "Not enough history yet for a normal level" : e.vsNormal === Infinity ? "No flow on this route earlier today" : `${e.vsNormal.toFixed(1)}x its normal 15-min level`,
        `Largest swap ${fmtUsd(e.largest)}`],
      links: [] }, COOLDOWN_MS);
  }
  for (const r of rotations) {
    if (r.usd < ROTATION_USD || !fresh(r.t)) continue;
    fire(`rotation:${r.id}`, "rotation", { net: r.net, from: sym(r.from), to: sym(r.to), usd: r.usd,
      title: `Wallet ${short(r.wallet)} rotated ${fmtUsd(r.usd)} ${routeLabel(r.from, r.to)}`,
      lines: [`Sold ${fmtUsd(r.sellUsd)} ${sym(r.from)} for ${sym(r.via)}, bought ${fmtUsd(r.buyUsd)} ${sym(r.to)} ${r.gapMin} min later`],
      links: [{ label: "sell tx", url: txUrl(r.net, r.sellTx) }, { label: "buy tx", url: txUrl(r.net, r.buyTx) }, { label: "wallet", url: walletUrl(r.net, r.wallet) }].filter((l) => l.url) });
  }
}

async function sendTelegram(text) { // shared queue (telegram.js): retried until delivered
  const r = await tgQueue(text, { kind: "flows" });
  if (r.sent) delete state.errors.Telegram; else if (r.error) state.errors.Telegram = r.error;
}

// ───────────────────────────── watches ─────────────────────────────
const pendingSearches = []; // { watchId, symbol, net }

export function parsePair(text) {
  const m = String(text || "").trim().match(/^([A-Za-z0-9.$_]{1,20})\s*(->|>|-|\/|→)\s*([A-Za-z0-9.$_]{1,20})$/);
  return m ? { from: normSym(m[1]), to: normSym(m[3]) } : null;
}

function addWatch({ pair, network = "*", minUsd = 10_000, both = false }) {
  const p = parsePair(pair);
  if (!p || p.from === p.to) throw Object.assign(new Error("Write the pair as FROM-TO, e.g. ETH-PEPE"), { status: 400 });
  const net = network && network !== "*" ? String(network) : "*";
  if (net !== "*" && !NETWORKS.includes(net)) throw Object.assign(new Error(`Network must be one of: ${NETWORKS.join(", ")}`), { status: 400 });
  const w = { id: Math.random().toString(36).slice(2, 10), net, from: p.from, to: p.to, minUsd: Math.max(0, Number(minUsd) || 0), both: !!both,
    createdAt: Date.now(), status: "finding pools" };
  state.watches.push(w);
  if (DEMO) w.status = "ready (demo)"; else queueWatchSearch(w);
  persist();
  return w;
}

function queueWatchSearch(w) {
  const nets = (w.net === "*" ? NETWORKS : [w.net]).filter((n) => !onchain.has(n)); // on-chain networks see every pool already
  const syms = [w.from, w.to].filter((s) => !nets.some((n) => isNativeSym(n, s)) && !STABLE_RE.test(s));
  if (!nets.length || !syms.length) { w.status = "ready"; return; } // e.g. ETH-USDC: the native/stablecoin pool is followed anyway
  for (const s of syms) pendingSearches.push({ watchId: w.id, symbol: s, net: w.net });
}

// Finds the busiest pools of a watched token (exact symbol match) and follows the top two.
async function resolveSearch(job) {
  const w = state.watches.find((x) => x.id === job.watchId);
  if (!w) return;
  try {
    const json = await gt(`/search/pools?query=${encodeURIComponent(job.symbol)}${job.net !== "*" ? `&network=${job.net}` : ""}&include=base_token,quote_token`);
    const found = parsePools(json, job.net !== "*" ? job.net : null)
      .filter((d) => NETWORKS.includes(d.net) && !onchainActive(d.net) && [d.base.symbol, d.quote.symbol].some((s) => String(s).toUpperCase() === job.symbol))
      .sort((a, b) => b.volume24h - a.volume24h).slice(0, 2);
    for (const d of found) { const p = addPool(d, "watch"); p.watchIds = [...new Set([...(p.watchIds || []), w.id])]; }
    w.status = found.length ? "ready" : `no pools found for ${job.symbol}`;
    w.pools = [...new Set([...(w.pools || []), ...found.map((d) => `${d.net}:${normAddr(d.net, d.address)}`)])];
  } catch (e) {
    w.status = `search failed (${e.message}), retrying`;
    setTimeout(() => pendingSearches.push(job), 60_000);
  }
  persist();
}

function removeWatch(id) {
  state.watches = state.watches.filter((w) => w.id !== id);
  for (const p of pools.values()) {
    if (!p.watchIds) continue;
    p.watchIds = p.watchIds.filter((x) => x !== id);
    if (!p.watchIds.length) { p.watch = false; if (!p.top) pools.delete(p.key); }
  }
  persist();
}

// Follows the DEX pools of one token for FOLLOW_HOURS (called when a Binance Alpha alert fires), so its buyers and
// sellers show here. chain = the Alpha chain name ("BSC", "Base", "Solana", "Ethereum", "Arbitrum") or a network id.
const CHAIN_IDS = { bsc: "bsc", "bnb chain": "bsc", base: "base", solana: "solana", ethereum: "eth", eth: "eth", arbitrum: "arbitrum", polygon: "polygon_pos" };
export function followToken({ chain: c, address, symbol, reason = "" }) {
  const net = CHAIN_IDS[String(c || "").toLowerCase()];
  if (!net || !address || DEMO || !started) return false;
  if (onchainActive(net)) return true; // every Ethereum pool is seen already
  const until = Date.now() + FOLLOW_HOURS * HOUR;
  for (const p of pools.values()) if (p.follow && p.net === net && (normAddr(net, p.desc.base.address) === normAddr(net, address) || normAddr(net, p.desc.quote.address) === normAddr(net, address))) { p.followUntil = until; return true; }
  if (!pendingFollows.some((f) => f.net === net && f.address === address)) pendingFollows.push({ net, address, symbol, reason, until });
  return true;
}
async function resolveFollow(f) {
  try {
    const found = parsePools(await gt(`/networks/${f.net}/tokens/${encodeURIComponent(f.address)}/pools?page=1&include=base_token,quote_token`), f.net)
      .filter((d) => d.reserveUsd >= FOLLOW_MIN_RESERVE_USD).sort((a, b) => b.reserveUsd - a.reserveUsd).slice(0, 2);
    for (const d of found) { const p = addPool(d, "follow"); p.followUntil = f.until; p.followReason = f.reason; }
    if (!found.length) state.followMisses = [...(state.followMisses || []), `${f.symbol} (${chain(f.net).name}): no pool with ${fmtUsd(FOLLOW_MIN_RESERVE_USD)}+ liquidity`].slice(-5);
  } catch (e) {
    if (Date.now() < f.until) setTimeout(() => pendingFollows.push(f), 60_000);
  }
}
function expireFollows(now) {
  for (const p of [...pools.values()]) if (p.follow && p.followUntil < now) { p.follow = false; if (!p.top && !p.watch) pools.delete(p.key); }
}

// ───────────────────────────── persistence ─────────────────────────────
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const watchPools = [...pools.values()].filter((p) => p.watch).map((p) => ({ ...p.desc, watchIds: p.watchIds || [] }));
    const data = JSON.stringify({ events: state.events, watches: state.watches, lastAlertAt: Object.fromEntries(lastAlertAt), watchPools });
    writeFile(STATE_FILE + ".tmp", data).then(() => rename(STATE_FILE + ".tmp", STATE_FILE)).catch(() => {}); // a crash mid-write never corrupts the file
  }, 500);
}
async function loadPersisted() {
  let saved = null;
  try { saved = JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { /* first run */ }
  if (saved) {
    state.events = (saved.events || []).slice(0, MAX_EVENTS);
    state.watches = saved.watches || [];
    for (const [k, v] of Object.entries(saved.lastAlertAt || {})) if (Date.now() - v < DAY) lastAlertAt.set(k, v);
    for (const d of saved.watchPools || []) { const p = addPool(d, "watch"); p.watchIds = d.watchIds; }
    return;
  }
  for (const spec of DEFAULT_WATCH.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [net, pair, minUsd] = spec.includes(":") ? spec.split(":") : ["*", spec, 10_000];
    try { addWatch({ pair, network: net, minUsd: Number(minUsd) || 10_000 }); } catch (e) { console.error(`FLOWS_WATCH "${spec}": ${e.message}`); }
  }
}

// ───────────────────────────── demo mode (DEMO=1) ─────────────────────────────
const rnd = (a, b) => a + Math.random() * (b - a);
function demoInit() {
  const mk = (net, symbol, address, base) => addPool({ net, address, name: `${symbol} / ${base.symbol}`, dex: net === "solana" ? "raydium" : "uniswap_v2",
    base: { address: `${address}t`, symbol }, quote: base, volume24h: rnd(2e6, 4e7), reserveUsd: 5e6 }, "top");
  const weth = { address: "0xweth", symbol: "WETH" }, sol = { address: "So11111111111111111111111111111111111111112", symbol: "SOL" };
  ["PEPE", "MOG", "SPX", "WOJAK", "NEIRO"].forEach((s, i) => mk("eth", s, `0xpool${i}`, weth));
  ["BONK", "WIF", "POPCAT"].forEach((s, i) => mk("solana", s, `SoPool${i}`, sol));
  addPool({ net: "eth", address: "0xusdcweth", name: "USDC / WETH", dex: "uniswap_v3", base: { address: "0xusdc", symbol: "USDC" }, quote: weth, volume24h: 9e7, reserveUsd: 9e7 }, "top");
  for (const p of pools.values()) p.coverageStart = Date.now() - DAY;
  // a day of quiet history so "vs normal" works, then live swaps with a few whales and rotations
  for (let t = Date.now() - DAY; t < Date.now() - 20 * MIN; t += rnd(20_000, 90_000)) demoSwap(t, 1);
}
const demoWallets = Array.from({ length: 60 }, (_, i) => `0x${(i * 2654435761 % 2 ** 32).toString(16).padStart(8, "0")}${"ab".repeat(16)}`);
function demoSwap(t, scale = 1) {
  const list = [...pools.values()], p = Math.random() < 0.35 ? list[0] : list[Math.floor(Math.random() * list.length)];
  const buy = p === list[0] ? Math.random() < 0.8 : Math.random() < 0.5;
  const usd = (Math.random() < 0.03 ? rnd(1e5, 4e5) : rnd(2e3, 3e4)) * scale;
  const s = { id: `${p.net}_${Math.floor(t)}_0x${Math.random().toString(16).slice(2)}_${Math.floor(rnd(1, 200))}_${Math.floor(t / 1000)}`, net: p.net, pool: p.key,
    dex: p.dex, t, wallet: demoWallets[Math.floor(Math.random() * demoWallets.length)], usd, fromAmt: usd, toAmt: usd,
    from: buy ? p.quoteKey : p.baseKey, to: buy ? p.baseKey : p.quoteKey };
  s.tx = s.id.split("_")[2]; s.log = logIndex(s.id);
  swaps.push(s);
}

// ───────────────────────────── main loop ─────────────────────────────
async function step() {
  if (DEMO) {
    for (let i = 0; i < 1 + Math.floor(Math.random() * 3); i++) demoSwap(Date.now(), 1);
    state.status = "demo";
    analyze();
    return sleep(2500);
  }
  const now = Date.now();
  expireFollows(now);
  const due = NETWORKS.find((n) => !onchainActive(n) && now - (discoveredAt.get(n) || 0) > DISCOVERY_MS && now >= (discoverRetryAt.get(n) || 0));
  if (due) return discover(due);
  if (pendingFollows.length) return resolveFollow(pendingFollows.shift());
  if (pendingSearches.length) return resolveSearch(pendingSearches.shift());
  // Watched and followed pools are polled a little more often than the rest; on-chain networks need no pool polling.
  const head = (p) => p.lastPoll - (p.watch || p.follow ? 30_000 : 0);
  const next = [...pools.values()].filter((p) => !onchainActive(p.net)).sort((a, b) => head(a) - head(b))[0];
  if (!next) { if (cache == null || now - (state.lastUpdated || 0) > 5000) analyze(); return sleep(2000); }
  await pollPool(next);
  state.status = "connected";
  analyze();
}
async function loop() {
  for (;;) {
    try { await step(); }
    catch (e) { state.status = "error"; state.errors.Scanner = e.message; await sleep(3000); }
  }
}

// ───────────────────────────── API ─────────────────────────────
// Per token (not ETH/BTC/SOL/stablecoins): bought and sold in USD, by how many wallets, and what it was bought with /
// sold for. routes = [{ from, to, usd, wallet, net }] (token keys).
export function tokenFlowsOf(routes, isMajorKey = isMajor) {
  const m = new Map();
  const get = (k, net) => { let f = m.get(k); if (!f) m.set(k, (f = { key: k, net, inUsd: 0, outUsd: 0, majorUsd: 0, buys: 0, sells: 0, buyers: new Set(), sellers: new Set(), with: new Map(), for: new Map(), biggestBuy: 0, biggestSell: 0 })); return f; };
  for (const r of routes) {
    if (!isMajorKey(r.to)) { const f = get(r.to, r.net); f.inUsd += r.usd; f.buys++; f.buyers.add(r.wallet); f.with.set(r.from, (f.with.get(r.from) || 0) + r.usd); f.biggestBuy = Math.max(f.biggestBuy, r.usd); if (isMajorKey(r.from)) f.majorUsd += r.usd; }
    if (!isMajorKey(r.from)) { const f = get(r.from, r.net); f.outUsd += r.usd; f.sells++; f.sellers.add(r.wallet); f.for.set(r.to, (f.for.get(r.to) || 0) + r.usd); f.biggestSell = Math.max(f.biggestSell, r.usd); if (isMajorKey(r.to)) f.majorUsd += r.usd; }
  }
  // Ranked by money from or to ETH / SOL / BNB / stablecoins: token-to-token loops (often wash trading) sink to the bottom.
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([key, usd]) => ({ key, usd }));
  return [...m.values()].map((f) => ({ key: f.key, net: f.net, inUsd: f.inUsd, outUsd: f.outUsd, netUsd: f.inUsd - f.outUsd, buys: f.buys, sells: f.sells,
    buyers: f.buyers.size, sellers: f.sellers.size, wallets: new Set([...f.buyers, ...f.sellers]).size, biggestBuy: f.biggestBuy, biggestSell: f.biggestSell,
    majorUsd: f.majorUsd, tokenOnly: f.majorUsd === 0, boughtWith: top(f.with), soldFor: top(f.for) }))
    .sort((a, b) => b.majorUsd - a.majorUsd || (b.inUsd + b.outUsd) - (a.inUsd + a.outUsd));
}

function snapshot(windowKey) {
  const w = WINDOWS[windowKey] ? windowKey : "1h";
  const c = cache || { now: Date.now(), all: [], routes: [], bots: new Set(), rotations: [], edges: { "15m": [], "1h": [], "24h": [] } };
  const tok = (k) => { const t = tokens.get(k) || {}; return { symbol: t.symbol || "?", cls: t.cls || "token", address: t.address || null }; };
  const routeOut = (r) => ({ id: r.id, t: r.t, net: r.net, chain: chain(r.net).name, wallet: r.wallet, walletUrl: walletUrl(r.net, r.wallet),
    from: { ...tok(r.from), amount: r.fromAmt }, to: { ...tok(r.to), amount: r.toAmt }, usd: r.usd, dex: (r.router && labelOf(r.router)?.name) || r.dex, hops: r.hops, safe: !!r.safe,
    txUrl: txUrl(r.net, r.tx), bot: c.bots.has(r.wallet) });
  const hour = c.routes.filter((r) => c.now - r.t <= HOUR);
  const inWin = c.routes.filter((r) => c.now - r.t <= WINDOWS[w]);
  const tokenFlows = tokenFlowsOf(inWin).map((f) => ({ ...f, token: tok(f.key), chain: chain(f.net).name,
    boughtWith: f.boughtWith.map((x) => ({ symbol: sym(x.key), usd: x.usd })), soldFor: f.soldFor.map((x) => ({ symbol: sym(x.key), usd: x.usd })) }));
  const flows = tokenFlows.map((f) => ({ token: f.token, net: f.net, chain: f.chain, inUsd: f.inUsd, outUsd: f.outUsd, netUsd: f.netUsd, wallets: f.wallets }));
  return {
    demo: DEMO, status: state.status, startedAt: state.startedAt, lastUpdated: state.lastUpdated, errors: state.errors,
    telegramConfigured: state.telegramConfigured, telegramOn: TELEGRAM_ON(), window: w,
    networks: [...new Set([...NETWORKS, ...[...pools.values()].map((p) => p.net)])].map((n) => ({ id: n, name: chain(n).name,
      source: onchainActive(n) ? "onchain" : "geckoterminal", pools: onchainActive(n) ? null : [...pools.values()].filter((p) => p.net === n).length,
      followed: [...pools.values()].filter((p) => p.net === n && p.follow).map((p) => p.name), swaps1h: hour.filter((r) => r.net === n).length,
      since: onchain.get(n)?.since || null, discoveredAt: discoveredAt.get(n) || null })),
    tokenFlows: tokenFlows.slice(0, 60),
    config: { minTradeUsd: MIN_TRADE_USD, whaleUsd: WHALE_USD, surgeUsd: SURGE_USD, surgeWallets: SURGE_WALLETS, surgeMult: SURGE_MULT,
      rotationUsd: ROTATION_USD, rotationMinutes: ROTATION_MS / MIN, callsPerMin: callRate, maxCallsPerMin: CALLS_PER_MIN, poolsPerNetwork: POOLS_PER_NETWORK },
    health: { callsLastMin: callLog.filter((t) => Date.now() - t < MIN).length, pausedUntil: pausedUntil > Date.now() ? pausedUntil : null,
      swaps24h: swaps.length, bots: c.bots.size },
    totals: { swaps1h: hour.length, usd1h: hour.reduce((a, r) => a + r.usd, 0), wallets1h: new Set(hour.map((r) => r.wallet)).size, pools: pools.size },
    edges: c.edges[w].slice(0, 80).map((e) => ({ key: e.key, net: e.net, chain: chain(e.net).name, from: tok(e.from), to: tok(e.to), usd: e.usd, n: e.n,
      wallets: e.wallets, oneWay: e.oneWay, reverse: e.reverse, vsNormal: e.vsNormal === Infinity ? "new" : e.vsNormal, largest: e.largest,
      majors: isMajor(e.from) && isMajor(e.to) })),
    inflow: flows.filter((f) => f.netUsd > 0).sort((a, b) => b.netUsd - a.netUsd).slice(0, 15),
    outflow: flows.filter((f) => f.netUsd < 0).sort((a, b) => a.netUsd - b.netUsd).slice(0, 15),
    rotations: c.rotations.slice(-40).reverse().map((r) => ({ ...r, chain: chain(r.net).name, from: tok(r.from), to: tok(r.to), via: tok(r.via),
      walletUrl: walletUrl(r.net, r.wallet), sellTxUrl: txUrl(r.net, r.sellTx), buyTxUrl: txUrl(r.net, r.buyTx) })),
    feed: c.all.slice(-150).reverse().map(routeOut),
    events: state.events.slice(0, 60),
    watches: state.watches,
    pools: [...pools.values()].filter((p) => !onchainActive(p.net)).sort((a, b) => b.volume24h - a.volume24h).map((p) => ({ name: p.name, net: p.net, chain: chain(p.net).name, dex: p.dex,
      top: p.top, watch: p.watch, follow: !!p.follow, followReason: p.followReason || null, gauge: !!p.gauge, swaps24h: p.swaps24h, wash: washPools.has(p.key),
      lastPoll: p.lastPoll || null, error: p.error, url: poolUrl(p.net, p.address) })),
    followMisses: state.followMisses || [],
  };
}

const jsonResponse = (res, code, data) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};
async function readBody(req, limit = 4096) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 }); chunks.push(c); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}
// Changes only from the screener page: JSON content type (blocks plain cross-site form posts) and a same-host Origin.
const allowedWrite = (req) => String(req.headers["content-type"] || "").includes("application/json") &&
  (!req.headers.origin || req.headers.origin.replace(/^https?:\/\//, "") === req.headers.host);

// DEX swaps into and out of one token (matched by symbol, any followed network) over the last 24h, for the AI trade desk.
export function tokenFlowSummary(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (!started || !cache) return { tracked: false, reason: "DEX tracker not running yet" };
  const now = Date.now(), hit = (k) => String(sym(k)).toUpperCase() === s;
  const routes = cache.routes.filter((r) => hit(r.from) || hit(r.to));
  if (!routes.length) return { tracked: false, reason: `no followed DEX pool trades ${s}` };
  const win = (ms) => {
    const rs = routes.filter((r) => now - r.t <= ms), bought = rs.filter((r) => hit(r.to)), sold = rs.filter((r) => hit(r.from));
    const usd = (a) => Math.round(a.reduce((x, r) => x + r.usd, 0));
    return { boughtUsd: usd(bought), soldUsd: usd(sold), netUsd: usd(bought) - usd(sold), swaps: rs.length, wallets: new Set(rs.map((r) => r.wallet)).size };
  };
  const by = (pick) => {
    const m = new Map();
    for (const r of routes) { const k = pick(r); if (k) m.set(sym(k), (m.get(sym(k)) || 0) + r.usd); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => ({ token: k, usd: Math.round(v) }));
  };
  return { tracked: true, networks: [...new Set(routes.map((r) => chain(r.net).name))], last1h: win(HOUR), last24h: win(DAY),
    boughtWith: by((r) => (hit(r.to) ? r.from : null)), soldFor: by((r) => (hit(r.from) ? r.to : null)) };
}

let started = false;
export function startFlows() {
  if (started) return;
  started = true;
  const gtNets = NETWORKS.filter((n) => !onchain.has(n)).map((n) => chain(n).name);
  console.log(`DEX rotations: ${[...onchain.keys()].map((n) => chain(n).name + " every DEX (from the blocks)").concat(gtNets.length ? [`${gtNets.join(", ")} via GeckoTerminal`] : []).join(" + ")} | swaps >= ${fmtUsd(MIN_TRADE_USD)} | whale >= ${fmtUsd(WHALE_USD)} | no API key`);
  loadPersisted().finally(() => { if (DEMO) demoInit(); loop(); });
}

// Serves /api/flows (GET, ?window=15m|1h|24h, ?only=events for the popup check) and the watch endpoints (POST).
// Returns false for any other path so the caller can carry on.
export async function handleFlowsRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/flows")) return false;
  try {
    if (url.pathname === "/api/flows" && req.method === "GET") {
      if (!started) jsonResponse(res, 200, { disabled: true, events: [], watches: [] });
      else if (url.searchParams.get("only") === "events") jsonResponse(res, 200, { events: state.events.slice(0, 20) });
      else jsonResponse(res, 200, snapshot(url.searchParams.get("window")));
    } else if ((url.pathname === "/api/flows/watch" || url.pathname === "/api/flows/unwatch") && req.method === "POST") {
      if (!allowedWrite(req)) jsonResponse(res, 403, { error: "Changes are only accepted from the screener page" });
      else {
        const body = await readBody(req);
        if (url.pathname.endsWith("/unwatch")) { removeWatch(String(body.id || "")); jsonResponse(res, 200, { ok: true }); }
        else jsonResponse(res, 200, addWatch(body));
      }
    } else jsonResponse(res, 404, { error: "Not found" });
  } catch (e) {
    jsonResponse(res, e.status || 500, { error: e.status ? e.message : "Server error" });
    if (!e.status) console.error("flows:", e);
  }
  return true;
}

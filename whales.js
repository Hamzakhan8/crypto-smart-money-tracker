// Whale tracker (Arkham-style): every large token and ETH transfer on Ethereum, who sent it and who received it.
// Node.js 18+, no dependencies, no API key.
//
// Data
//   - Blocks are read straight from public Ethereum RPC nodes (WHALES_RPC, several for fallback): one request per block
//     returns every ERC-20 transfer plus the block's ETH transfers, so every token is covered, not a fixed list.
//   - Prices and liquidity come from DexScreener. Tokens without real liquidity (WHALES_MIN_LIQUIDITY_USD) are ignored,
//     and a transfer can't be worth much more than its token's liquidity, so scam tokens with fake prices never alert.
//     Stablecoins and wrapped BTC/ETH come from a short verified list (symbol checked against DexScreener).
//   - Who is who: ~10k labelled addresses (exchanges, funds / market makers, stablecoin issuers, bridges, DEXes, DeFi,
//     MEV bots, mixers, flagged addresses) from the open Etherscan label set in data/eth-labels.json (see
//     scripts/build-labels.js), plus your own labels from the watchlist.
//
// What it derives
//   - Wallet or contract: every address is checked once. Moves between two unlabelled contracts are DeFi plumbing (vaults,
//     routers): hidden by default and never alerted. "Biggest unlabelled wallets" lists real wallets only.
//   - Transfer type: exchange deposit (possible sell) / withdrawal (possible accumulation), exchange-to-exchange,
//     internal exchange shuffle, mint / burn, DEX, bridge, DeFi, wallet-to-wallet.
//   - Exchange net flow per token and per exchange, the most active labelled entities and the biggest unlabelled wallets.
//
// Alerts (popup on every screener tab + Telegram): transfers >= WHALES_ALERT_USD (stablecoins: WHALES_STABLE_ALERT_USD;
// DEX swap legs are left to the DEX section), exchange deposits / withdrawals of
// non-stablecoins >= WHALES_EXCHANGE_ALERT_USD, stablecoin mints / burns and issuer treasury moves >= WHALES_MINT_ALERT_USD,
// and any move by a watched wallet or of a watched token above its minimum.
//
// Labels come from a public 2023 snapshot: newer wallets of an exchange may show as unlabelled. Deposits reach exchange
// hot wallets in batches, so they show when the exchange sweeps them. It shows what moved, not why. Not financial advice.

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendTelegram as tgQueue, telegramWants } from "./telegram.js";

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO = env.DEMO === "1";
// Free nodes that serve what the tracker needs (block-wide log queries, batches, full blocks), best first; each one's
// limits are learned from its own errors. WHALES_RPC replaces the list (e.g. your own Alchemy / Infura URL first).
const RPCS = (env.WHALES_RPC || "https://eth-mainnet.public.blastapi.io,https://gateway.tenderly.co/public/mainnet,https://rpc.mevblocker.io,https://eth.drpc.org,https://rpc.flashbots.net,https://ethereum-rpc.publicnode.com").split(",").map((s) => s.trim()).filter(Boolean);
const MIN_USD = num("WHALES_MIN_USD", 100_000);                    // transfers below this are not kept (watched wallets excepted)
const ALERT_USD = num("WHALES_ALERT_USD", 1_000_000);                 // non-stablecoin transfers
const STABLE_ALERT_USD = num("WHALES_STABLE_ALERT_USD", 25_000_000);  // stablecoins move in size all day; alert only on very large ones
const TELEGRAM_PER_HOUR = num("WHALES_TELEGRAM_PER_HOUR", 30);        // all alerts still show on the page
const TELEGRAM_ON = () => telegramWants("whales");                     // off by default (WHALES_TELEGRAM=1 or the switch on the page)
const EXCHANGE_ALERT_USD = num("WHALES_EXCHANGE_ALERT_USD", 500_000);
const MINT_ALERT_USD = num("WHALES_MINT_ALERT_USD", 10_000_000);
const MIN_LIQUIDITY = num("WHALES_MIN_LIQUIDITY_USD", 250_000);
const BACKFILL_BLOCKS = num("WHALES_BACKFILL_BLOCKS", 300);         // ~1 hour of history at start
const SWAP_MIN_USD = num("FLOWS_MIN_TRADE_USD", 2000);               // DEX swaps rebuilt from the blocks (DEX section)
const SWAP_MIN_LIQUIDITY = num("WHALES_SWAP_MIN_LIQUIDITY_USD", 50_000); // a token needs this much DEX liquidity to be valued in a swap
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;
const DEXSCREENER = "https://api.dexscreener.com/tokens/v1/ethereum/";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;
const FRESH_MS = 10 * MIN;  // only transfers newer than this alert (history loaded at start never does)
const MAX_EVENTS = 300;
const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(here, DEMO ? "whales_state.demo.json" : "whales_state.json");

// Verified contracts: stablecoins count as $1 and, like wrapped BTC/ETH, are not capped by their DEX liquidity.
const STABLES = { "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI", "0x4c9edd5852cd905f086c759e8383e09bff1e68b3": "USDe",
  "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": "FDUSD", "0x6c3ea9036406852006290770bedfcaba0e23a0e8": "PYUSD",
  "0xdc035d45d973e3ec169d2276ddab16f1e407384f": "USDS" };
const BLUECHIPS = { "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
  "0xae7ab96520de3a18e5e111b5eaab095312d7fe84": "stETH", "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wstETH",
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC" };
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const state = {
  startedAt: Date.now(), lastUpdated: null, demo: DEMO, status: "starting", errors: {},
  head: null, lastBlock: null, lastBlockTime: null, backfill: { from: null, next: null, to: null, done: false },
  events: [], watches: [], telegramConfigured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
};
const transfers = [];      // kept transfers (24h), sorted by time
const seen = new Set();    // transfer ids
const tokens = new Map();  // address -> { symbol, decimals, price, liquidity, fdv, ok, at, kind: stable | bluechip | token }
const lastAlertAt = new Map();
let labels = {};           // address -> [name, category]
const isContract = new Map(); // address -> true (contract) | false (wallet), checked once with eth_getCode
const isSafe = new Set();     // Safe multisig wallets (contracts that act as a wallet: funds, teams, DAOs)
const swapSeen = new Map();   // swap id -> time
const swapListeners = [];
let swapTimes = [];           // swaps found in the last hour (health)
const rpcStats = RPCS.map((url) => ({ url, ok: 0, fail: 0, lastError: null, lastErrorAt: null, maxBatch: 40, cannot: new Map(), streak: 0, restUntil: 0 }));
let rpcIndex = 0, rpcCalls = [];

// ───────────────────────────── labels ─────────────────────────────
const CATEGORY_NAMES = { exchange: "Exchange", fund: "Fund / market maker", issuer: "Stablecoin issuer", bridge: "Bridge", dex: "DEX", defi: "DeFi",
  mev: "MEV bot", mixer: "Mixer", flagged: "Flagged", watched: "Your label", safe: "Multisig / smart wallet", ens: "ENS name", token: "Token contract" };
const watchedWallet = (a) => state.watches.find((w) => w.kind === "wallet" && w.address === a);
// Who an address is: your label, the public label list, a learned exchange address, then a Blockscout name.
export function labelOf(a) {
  const w = watchedWallet(a);
  if (w && w.name) return { name: w.name, category: "watched", entity: w.name };
  const l = labels[a];
  if (l) return { name: l[0], category: l[1], entity: entityOf(l[0], l[1]) };
  const d = learned.get(a);
  if (d) return { name: `${d.entity} address (learned)`, category: "exchange", entity: d.entity, learned: true };
  const n = names.get(a);
  if (n?.name) return { name: n.name, category: n.cat, entity: n.cat === "ens" || n.cat === "safe" ? null : n.name, looked: true };
  if (isSafe.has(a)) return { name: "Safe multisig", category: "safe", entity: null };
  return null;
}

// ───────────────────────────── names the label list does not have ─────────────────────────────
// The public label list is a 2023 snapshot, so newer protocols, routers, vaults and wallets are missing. Two fixes:
//  - Blockscout's free API (no key) names any address once: verified contract names (Uniswap pools and routers, lending
//    markets, vaults, bridges), Safe multisigs and the ENS names of wallets. Kept in whales_names.json; the biggest
//    movers are looked up first, about one address a second.
//  - Exchange addresses are learned from the transfers: an unlabelled address that hands its tokens to one exchange's
//    labelled wallet is that exchange's (deposit) address, the way Arkham and Nansen find them. Later deposits into it
//    then count as exchange deposits at once, before the exchange sweeps them. An address that also sends to another
//    exchange or to an ordinary wallet is dropped (a trader, not an exchange address).
const NAMES_FILE = path.join(here, DEMO ? "whales_names.demo.json" : "whales_names.json");
const BLOCKSCOUT = (env.WHALES_BLOCKSCOUT || "https://eth.blockscout.com").replace(/\/$/, "");
const names = new Map();     // address -> { name, cat, at }  cat: dex | defi | bridge | token | safe | ens | contract | wallet
const learned = new Map();   // address -> { entity, at, n }
const notExchange = new Set();
const nameQueue = new Map(); // address -> priority (USD moved)
const nameStats = { looked: 0, named: 0, failed: 0, lastError: null, pausedUntil: 0 };
const prettyName = (n) => String(n).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([0-9])([A-Z][a-z])/g, "$1 $2").replace(/_/g, " ").slice(0, 40);
const SMART_WALLET = /safe|gnosis|msca|smart ?account|smart ?wallet|light ?account|kernel|biconomy|ambire|argent|coinbase ?smart|simple ?account|account ?proxy|modular ?account/i;
export function nameFromBlockscout(j) {
  const ens = j?.ens_domain_name || null;
  if (!j?.is_contract) return { name: ens, cat: ens ? "ens" : "wallet" };
  const impl = (j.implementations || []).map((i) => i.name).filter(Boolean);
  const name = (j.name && !/proxy$/i.test(j.name) ? j.name : impl[0] || j.name) || null, token = j.token;
  const all = [j.name, ...impl].filter(Boolean).join(" ");
  if (/safe|gnosis/i.test(all)) return { name: ens || "Safe multisig", cat: "safe" };
  if (SMART_WALLET.test(all)) return { name: ens || `Smart wallet (${prettyName(name || all)})`, cat: "safe" }; // a person's or fund's wallet
  if (!name && !token?.name) return { name: null, cat: "contract" };
  const n = name || token.name;
  if (/pool|pair|swap|router|uniswap|sushi|curve|balancer|1inch|aggregat|settlement|paraswap|augustus|kyber|odos|cow|pancake|maverick|zeroex|metamask|ekubo|bebop|hashflow/i.test(n)) return { name: prettyName(n), cat: "dex" };
  if (/bridge|portal|gateway|inbox|messenger|wormhole|stargate|layerzero|hyperlane|tokenmessenger|spokepool|cctp/i.test(n)) return { name: prettyName(n), cat: "bridge" };
  return { name: prettyName(n), cat: token && !name ? "token" : "defi" };
}
function queueName(a, usd) {
  if (DEMO || !a || a === ZERO || a === DEAD || labels[a] || learned.has(a) || names.has(a)) return;
  if (nameQueue.size >= 5000 && !nameQueue.has(a) && usd < 1e6) return;
  nameQueue.set(a, Math.max(nameQueue.get(a) || 0, usd));
}
let namesTimer = null;
function saveNames() {
  if (namesTimer) return;
  namesTimer = setTimeout(() => {
    namesTimer = null;
    if (names.size > 100_000) for (const k of [...names.keys()].slice(0, 20_000)) names.delete(k);
    const data = JSON.stringify({ version: 1, names: Object.fromEntries([...names].map(([a, n]) => [a, [n.name, n.cat, n.at]])),
      learned: Object.fromEntries([...learned].map(([a, d]) => [a, [d.entity, d.at, d.n]])), notExchange: [...notExchange].slice(-20_000) });
    writeFile(NAMES_FILE + ".tmp", data).then(() => rename(NAMES_FILE + ".tmp", NAMES_FILE)).catch(() => {});
  }, 20_000);
  namesTimer.unref?.();
}
async function loadNames() {
  try {
    const j = JSON.parse(await readFile(NAMES_FILE, "utf8"));
    for (const [a, [name, cat, at]] of Object.entries(j.names || {})) { names.set(a, { name, cat, at }); if (cat === "safe") isSafe.add(a); }
    for (const [a, [entity, at, n]] of Object.entries(j.learned || {})) learned.set(a, { entity, at, n });
    for (const a of j.notExchange || []) notExchange.add(a);
  } catch { /* first run */ }
}
async function nameLoop() {
  for (;;) {
    await sleep(1300);
    if (!nameQueue.size || Date.now() < nameStats.pausedUntil) continue;
    let a = null, best = -1;
    for (const [k, p] of nameQueue) if (p > best) { a = k; best = p; }
    nameQueue.delete(a);
    if (labels[a] || learned.has(a) || names.has(a)) continue;
    try {
      const res = await fetch(`${BLOCKSCOUT}/api/v2/addresses/${a}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
      if (res.status === 429) { nameStats.pausedUntil = Date.now() + 60_000; nameQueue.set(a, best); continue; }
      if (res.status === 404) { names.set(a, { name: null, cat: isContract.get(a) ? "contract" : "wallet", at: Date.now() }); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const n = nameFromBlockscout(await res.json());
      names.set(a, { ...n, at: Date.now() });
      nameStats.looked++; if (n.name) nameStats.named++; nameStats.lastError = null;
      if (n.cat === "safe") isSafe.add(a);
      saveNames();
    } catch (e) { nameStats.failed++; nameStats.lastError = e.name === "TimeoutError" ? "timeout" : e.message; nameStats.pausedUntil = Date.now() + 30_000; }
  }
}
// Learns exchange addresses from new transfers (see above).
const PERSONAL = new Set(["safe", "ens"]);
function learnExchanges(list) {
  for (const tr of list) {
    const from = tr.from;
    if (from === ZERO || labels[from] || watchedWallet(from)) continue;
    const known = learned.get(from), to = labelOf(tr.to), toEntity = to?.category === "exchange" ? to.entity : null;
    if (known) {
      if (toEntity === known.entity) known.n++;                                       // another sweep
      else { learned.delete(from); notExchange.add(from); saveNames(); }               // sent elsewhere: a trader, not an exchange address
      continue;
    }
    const pub = labels[tr.to];
    if (!pub || pub[1] !== "exchange" || /deposit\)$/i.test(pub[0]) || notExchange.has(from)) continue;
    const n = names.get(from);
    if (isSafe.has(from) || (n && n.cat !== "wallet" && n.cat !== "contract")) continue; // a named protocol, Safe or ENS wallet
    // First sweep seen: if the deposit into this address was already kept, that one counts; else this sweep does.
    if (!transfers.some((x) => x.to === from && x.t <= tr.t && x !== tr)) tr.forceKind = "deposit";
    learned.set(from, { entity: entityOf(pub[0], "exchange"), at: Date.now(), n: 1 });
    nameQueue.delete(from);
    saveNames();
  }
}
// "Binance 14" -> Binance, "Crypto.com: MultiSig 7" -> Crypto.com, "Wintermute (Binance deposit)" -> Binance.
export function entityOf(name, category) {
  const dep = name.match(/\((.+) deposit\)$/i);
  if (dep && category === "exchange") return dep[1];
  return name.replace(/:.*$/, "").replace(/\s+(\d+|Old Address.*|Hot Wallet.*|Cold Wallet.*)$/i, "").trim();
}
const catOf = (a) => labelOf(a)?.category || null;
const refreshKind = (tr) => { tr.kind = tr.forceKind || kindOf(tr.from, tr.to); return tr; }; // labels can arrive later

// ───────────────────────────── RPC (with fallback) ─────────────────────────────
// Free nodes differ: some cap a batch at a few requests (drpc: 3), some refuse a log query without a token address
// (publicnode). Both are learned from the node's own error, then batches are split or the node is skipped for that call.
async function rpcSend(st, calls) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    rpcCalls.push(Date.now());
    const res = await fetch(st.url, { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c[0], params: c[1] }))) });
    const out = await res.json().catch(() => null);
    if (!Array.isArray(out)) throw new Error(out?.error?.message || (res.ok ? "unexpected reply" : `HTTP ${res.status}`));
    const byId = new Map(out.map((r) => [r.id, r]));
    return calls.map((c, i) => {
      const r = byId.get(i);
      if (!r || r.error) throw Object.assign(new Error(r?.error?.message || "missing result"), { method: c[0] }); // which call the node refused
      return r.result;
    });
  } finally { clearTimeout(timer); }
}
// What a call needs from a node, beyond the basics: a log query over a whole block (no token address) or full blocks.
const NEEDS = { wideLogs: "block-wide log queries", fullBlocks: "full blocks" };
function needsOf(calls) {
  const n = new Set();
  for (const [m, p] of calls) {
    if (m === "eth_getLogs" && !p?.[0]?.address) n.add("wideLogs");
    if (m === "eth_getBlockByNumber" && p?.[1] === true) n.add("fullBlocks");
  }
  return n;
}
const BATCH_ERR = /batch|max messages/i;  // "Batch of more than 3 requests", "too many RPC calls in batch", "Max messages exceeded (Limit: 5)"
const REFUSED = /specify an address|address is required|not available|not supported|unsupported|not allowed|whitelist|method not found|does not exist|plan/i;
// Node order for one call: nodes that cannot serve it are left out; resting nodes (failed recently) go last; a big
// batch goes first to a node that takes it whole; otherwise the node that worked last time.
function nodeOrder(n, needs) {
  const now = Date.now(), resting = (st) => (now < st.restUntil ? 1 : 0), turn = (i) => (i - rpcIndex + RPCS.length) % RPCS.length;
  return rpcStats.map((st, i) => ({ st, i })).filter((x) => ![...needs].some((k) => x.st.cannot.has(k)))
    .sort((a, b) => resting(a.st) - resting(b.st) || (n > 3 ? (b.st.maxBatch >= n) - (a.st.maxBatch >= n) : 0) || turn(a.i) - turn(b.i));
}
async function rpcBatch(calls) {
  const needs = needsOf(calls);
  let lastErr;
  for (let round = 0; round < 2; round++) {
    for (const { st, i } of nodeOrder(calls.length, needs)) {
      for (let shrink = 0; shrink < 7; shrink++) {
        try {
          const results = [];
          for (let k = 0; k < calls.length; k += st.maxBatch) results.push(...await rpcSend(st, calls.slice(k, k + st.maxBatch)));
          st.ok++; st.streak = 0; st.restUntil = 0; rpcIndex = i;
          return results;
        } catch (e) {
          lastErr = e;
          const msg = e.name === "AbortError" ? "timeout (20 s)" : String(e.message || "error");
          if (BATCH_ERR.test(msg) && st.maxBatch > 1) { // learn its batch size: the number it states, else half
            const n = Number(msg.match(/(?:more than|limit:?)\s*(\d+)/i)?.[1]);
            st.maxBatch = n >= 1 && n < st.maxBatch ? n : Math.max(1, Math.floor(st.maxBatch / 2));
            continue;
          }
          const kind = e.method === "eth_getLogs" ? "wideLogs" : e.method === "eth_getBlockByNumber" ? "fullBlocks" : null;
          if (kind && needs.has(kind) && REFUSED.test(msg)) { st.cannot.set(kind, msg.slice(0, 100)); break; } // it never serves this: skip it for such calls
          // Anything else (rate limit, timeout, blocked, down): rest it, longer each time it fails again (30 s ... 30 min)
          st.fail++; st.streak++; st.lastError = msg.slice(0, 140); st.lastErrorAt = Date.now();
          st.restUntil = Date.now() + Math.min(30 * MIN, 30_000 * 2 ** Math.min(st.streak - 1, 6));
          break;
        }
      }
    }
    await sleep(1000);
  }
  throw new Error(`All RPC nodes failed (${lastErr?.message})`);
}
export const __rpcForTests = { rpcBatch: (calls) => rpcBatch(calls), stats: () => rpcStats };
const shownUrl = (u) => u.replace(/^https?:\/\//, "").replace(/\/v\d+\/[^/]{12,}$/, "/v…/(your key)"); // never show an API key
const rpc = async (method, params) => (await rpcBatch([[method, params]]))[0];
const hex = (n) => "0x" + n.toString(16);

// ───────────────────────────── tokens + prices ─────────────────────────────
let dexCalls = [];
async function ensureTokens(addrs) {
  const now = Date.now();
  const need = [...new Set(addrs)].filter((a) => { const t = tokens.get(a); return !t || now - t.at > (t.tradable ? 5 * MIN : 6 * HOUR); });
  for (let i = 0; i < need.length; i += 30) {
    const chunk = need.slice(i, i + 30);
    let pairs = [];
    try {
      if (i) await sleep(300); // DexScreener allows ~300 requests/min
      dexCalls.push(Date.now());
      const res = await fetch(DEXSCREENER + chunk.join(","), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      pairs = await res.json();
      delete state.errors.DexScreener;
    } catch (e) { state.errors.DexScreener = `prices: ${e.message}`; continue; }
    const best = new Map();
    for (const p of Array.isArray(pairs) ? pairs : []) {
      const a = String(p.baseToken?.address || "").toLowerCase(), liq = Number(p.liquidity?.usd) || 0;
      if (chunk.includes(a) && (!best.has(a) || liq > best.get(a).liq)) best.set(a, { p, liq });
    }
    const fresh = [];
    for (const a of chunk) {
      const b = best.get(a), prev = tokens.get(a);
      const symbol = b ? String(b.p.baseToken.symbol || "?") : prev?.symbol || "?";
      const verified = (STABLES[a] && STABLES[a].toUpperCase() === symbol.toUpperCase()) ? "stable"
        : (BLUECHIPS[a] && BLUECHIPS[a].toUpperCase() === symbol.toUpperCase()) ? "bluechip" : "token";
      const price = verified === "stable" ? 1 : Number(b?.p.priceUsd) || 0;
      const ok = !!b && price > 0 && (verified !== "token" || b.liq >= MIN_LIQUIDITY);         // whale transfers
      const tradable = !!b && price > 0 && (verified !== "token" || b.liq >= SWAP_MIN_LIQUIDITY); // DEX swaps
      tokens.set(a, { symbol, price, liquidity: b?.liq || 0, fdv: Number(b?.p.fdv || b?.p.marketCap) || 0, ok, tradable, at: now, kind: verified,
        decimals: prev?.decimals ?? null, url: b?.p.url || null });
      if (tradable && prev?.decimals == null) fresh.push(a);
    }
    // decimals straight from each contract (one batched call)
    if (fresh.length) {
      try {
        const res = await rpcBatch(fresh.map((a) => ["eth_call", [{ to: a, data: "0x313ce567" }, "latest"]]));
        res.forEach((r, i) => { const d = parseInt(r, 16); const t = tokens.get(fresh[i]); if (Number.isFinite(d) && d <= 36) t.decimals = d; else t.ok = t.tradable = false; });
      } catch { for (const a of fresh) tokens.get(a).at = 0; } // retry next time
    }
  }
}
// Largest believable value for one transfer: verified tokens are uncapped; others can't exceed their liquidity by much.
const capOf = (t) => (t.kind !== "token" ? Infinity : t.liquidity < 5e6 ? 50 * t.liquidity : Math.max(50 * t.liquidity, 0.1 * t.fdv));

// Wallet or contract, for every address in new transfers (batched, cached). EIP-7702 wallets carry a 0xef0100 stub; a
// Safe multisig is a small proxy whose code answers masterCopy() (selector a619486e).
async function ensureCodeFor(addrs) {
  const need = [...new Set(addrs)].filter((a) => !isContract.has(a) && a !== ZERO && a !== DEAD);
  for (let i = 0; i < need.length; i += 40) {
    const chunk = need.slice(i, i + 40);
    try {
      const codes = await rpcBatch(chunk.map((a) => ["eth_getCode", [a, "latest"]]));
      codes.forEach((c, j) => {
        const code = typeof c === "string" ? c : "0x";
        isContract.set(chunk[j], code.length > 2 && !code.startsWith("0xef0100"));
        if (code.length < 1200 && code.includes("a619486e")) isSafe.add(chunk[j]);
      });
    } catch { /* unknown for now; retried with the next transfers */ }
  }
  if (isContract.size > 300_000) for (const k of [...isContract.keys()].slice(0, 100_000)) isContract.delete(k); // memory cap
}
const ensureCode = (list) => ensureCodeFor(list.flatMap((tr) => [tr.from, tr.to]));
// Both sides contracts with no business label (vaults, routers, pools): DeFi plumbing rather than a holder moving funds.
const KEEP_CATS = new Set(["exchange", "fund", "issuer", "bridge", "watched", "flagged", "mixer"]);
const plumbing = (tr) => [tr.from, tr.to].every((a) => isContract.get(a) === true && !isSafe.has(a) && !KEEP_CATS.has(catOf(a)));

// ───────────────────────────── DEX swaps from the same logs ─────────────────────────────
// Every DEX trade moves tokens with Transfer events, so swaps can be rebuilt from the logs already read for whale
// transfers: every DEX and aggregator on Ethereum at once, with no extra request. In one transaction, a wallet that gave
// token A and got token B swapped A -> B (several wallets in one batch, e.g. CoW, each count). ETH legs leave no Transfer
// event, so: ETH sent with the transaction is ETH given; a wallet that only gave tokens while a contract was left holding
// WETH (unwrapped and sent back as ETH) got that ETH; a wallet that only got tokens while a contract sent WETH it never
// received (wrapped from ETH) paid that ETH. Mints and burns (vault deposits, staking) are not trades and are left out.
// legs: [{ token, from, to, amount }] with WETH as token "eth"; valueOf(token, amount) = USD or null for unknown tokens.
export function swapsFromLegs(legs, { isWallet, valueOf, isMajor = (tok) => tok === "eth", txFrom = null, txValueEth = 0 }) {
  const net = new Map();
  const add = (a, tok, v) => { let m = net.get(a); if (!m) net.set(a, (m = new Map())); m.set(tok, (m.get(tok) || 0) + v); };
  for (const l of legs) {
    if (l.from === ZERO || l.to === ZERO || l.to === DEAD || l.from === l.to || !(l.amount > 0)) continue;
    add(l.from, l.token, -l.amount); add(l.to, l.token, l.amount);
  }
  if (txFrom && txValueEth > 0) add(txFrom, "eth", -txValueEth);
  let wethLeft = 0, wethMade = 0;
  const sides = [];
  for (const [a, m] of net) {
    if (a !== txFrom && isWallet(a) !== true) { const w = m.get("eth") || 0; if (w > 0) wethLeft += w; else wethMade -= w; continue; }
    const neg = [], pos = [];
    for (const [tok, v] of m) {
      if (Math.abs(v) < 1e-12) continue;
      (v < 0 ? neg : pos).push({ tok, amount: Math.abs(v), usd: valueOf(tok, Math.abs(v)) });
    }
    if (neg.length || pos.length) sides.push({ a, neg, pos });
  }
  // The trader behind ETH that only shows as WETH: the transaction sender if it qualifies, else a clear largest wallet.
  // The ETH must be worth about what the wallet gave or got (so a fee wallet in the same transaction is never matched).
  const worth = (s) => [...s.neg, ...s.pos].reduce((x, y) => x + (y.usd || 0), 0);
  const pick = (cands) => {
    if (txFrom) { const t = cands.find((s) => s.a === txFrom); if (t) return t; }
    const sorted = [...cands].sort((x, y) => worth(y) - worth(x));
    return sorted.length === 1 || (sorted.length > 1 && worth(sorted[0]) >= 3 * worth(sorted[1])) ? sorted[0] : null;
  };
  const addEth = (s, side, amount) => {
    const usd = valueOf("eth", amount), other = worth(s);
    if (usd != null && other > 0 && usd >= other / 2 && usd <= other * 2) s[side].push({ tok: "eth", amount, usd });
  };
  const noEth = (list) => !list.some((x) => x.tok === "eth");
  const seller = wethLeft > 0 ? pick(sides.filter((s) => s.neg.length && !s.pos.length && noEth(s.neg))) : null;
  if (seller) addEth(seller, "pos", wethLeft);
  const buyer = wethMade > 0 ? pick(sides.filter((s) => s.pos.length && !s.neg.length && noEth(s.pos))) : null;
  if (buyer) addEth(buyer, "neg", wethMade);
  const out = [];
  for (const s of sides) {
    if (!s.neg.length || !s.pos.length || [...s.neg, ...s.pos].some((x) => x.usd == null)) continue; // an unknown token: not valued
    const top = (list) => list.reduce((b, x) => (x.usd > b.usd ? x : b));
    const from = top(s.neg), to = top(s.pos);
    // Value: the ETH / stablecoin side when there is one (its price is reliable), else the smaller side.
    const usd = isMajor(from.tok) && isMajor(to.tok) ? Math.min(from.usd, to.usd) : isMajor(from.tok) ? from.usd : isMajor(to.tok) ? to.usd : Math.min(from.usd, to.usd);
    out.push({ wallet: s.a, from: from.tok, fromAmt: from.amount, to: to.tok, toAmt: to.amount, usd });
  }
  return out;
}

// ───────────────────────────── transfers ─────────────────────────────
export function kindOf(from, to, cat = catOf, entity = (a) => labelOf(a)?.entity, contractOf = (a) => isContract.get(a) === true && !isSafe.has(a)) {
  if (from === ZERO) return "mint";
  if (to === ZERO || to === DEAD) return "burn";
  const fc = cat(from), tc = cat(to);
  if (fc === "exchange" && tc === "exchange") return entity(from) === entity(to) ? "internal" : "exchange_to_exchange";
  if (tc === "exchange") return "deposit";
  if (fc === "exchange") return "withdrawal";
  if (fc === "issuer" || tc === "issuer") return "issuer";
  if (fc === "dex" || tc === "dex") return "dex";
  if (fc === "bridge" || tc === "bridge") return "bridge";
  if (fc === "defi" || tc === "defi" || fc === "token" || tc === "token") return "defi";
  if (contractOf(from) || contractOf(to)) return "contract"; // an unnamed contract (vault, router, game...): not a holder's move
  return "transfer";
}

function record(tr) {
  if (seen.has(tr.id)) return null;
  seen.add(tr.id);
  tr.kind = kindOf(tr.from, tr.to);
  transfers.push(tr);
  return tr;
}

const watchedSet = () => new Set(state.watches.filter((w) => w.kind === "wallet").map((w) => w.address));

// One batched request: all ERC-20 Transfer logs in [from, to] and, for live blocks, the full block for ETH transfers.
async function processBlocks(fromBlock, toBlock, withNative) {
  const calls = [["eth_getLogs", [{ fromBlock: hex(fromBlock), toBlock: hex(toBlock), topics: [TRANSFER] }]]];
  if (withNative) for (let b = fromBlock; b <= toBlock; b++) calls.push(["eth_getBlockByNumber", [hex(b), true]]);
  const [logs, ...blocks] = await rpcBatch(calls);
  const erc20 = (logs || []).filter((l) => l.topics?.length === 3 && l.data?.length === 66 && !l.removed);
  const blockTime = new Map(blocks.filter(Boolean).map((b) => [parseInt(b.number, 16), parseInt(b.timestamp, 16) * 1000]));
  const timeOf = (l) => (l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : blockTime.get(parseInt(l.blockNumber, 16)) || Date.now());
  await ensureTokens([...erc20.map((l) => l.address.toLowerCase()), WETH]);
  const watched = watchedSet(), fresh = [];
  for (const l of erc20) {
    const t = tokens.get(l.address.toLowerCase());
    if (!t?.ok || t.decimals == null) continue;
    const from = "0x" + l.topics[1].slice(26).toLowerCase(), to = "0x" + l.topics[2].slice(26).toLowerCase();
    const amount = Number(BigInt(l.data)) / 10 ** t.decimals, usd = amount * t.price;
    if (!(usd > 0) || usd > capOf(t)) continue;
    if (usd < MIN_USD && !watched.has(from) && !watched.has(to)) continue;
    const tr = record({ id: `${l.transactionHash}:${parseInt(l.logIndex, 16)}`, t: timeOf(l), block: parseInt(l.blockNumber, 16), tx: l.transactionHash,
      token: l.address.toLowerCase(), symbol: t.symbol, amount, usd, from, to });
    if (tr) fresh.push(tr);
  }
  const ethPrice = tokens.get(WETH)?.price || 0;
  for (const b of blocks.filter(Boolean)) {
    const time = parseInt(b.timestamp, 16) * 1000;
    for (const x of b.transactions || []) {
      const wei = BigInt(x.value || "0x0");
      if (wei === 0n || !x.to) continue;
      const amount = Number(wei) / 1e18, usd = amount * ethPrice;
      const from = x.from.toLowerCase(), to = x.to.toLowerCase();
      if (usd < MIN_USD && !watched.has(from) && !watched.has(to)) continue;
      const tr = record({ id: `${x.hash}:eth`, t: time, block: parseInt(b.number, 16), tx: x.hash, token: "eth", symbol: "ETH", amount, usd, from, to });
      if (tr) fresh.push(tr);
    }
  }
  if (fresh.length) transfers.sort((a, b) => a.t - b.t);
  if (swapListeners.length) {
    const swaps = await findSwaps(erc20, blocks.filter(Boolean));
    if (swaps.length || withNative) for (const fn of swapListeners) { try { fn(swaps); } catch (e) { console.error("whales: swap listener", e); } } // live blocks also say "still running"
  }
  return fresh;
}

// DEX swaps in these blocks (see swapsFromLegs), for the DEX section (flows.js).
async function findSwaps(erc20, blocks) {
  const txInfo = new Map();
  for (const b of blocks) for (const x of b.transactions || []) txInfo.set(x.hash, { from: x.from.toLowerCase(), to: x.to ? x.to.toLowerCase() : null, value: Number(BigInt(x.value || "0x0")) / 1e18 });
  const byTx = new Map();
  for (const l of erc20) {
    const a = l.address.toLowerCase(), t = tokens.get(a), raw = Number(BigInt(l.data));
    let e = byTx.get(l.transactionHash);
    if (!e) byTx.set(l.transactionHash, (e = { legs: [], t: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) * 1000 : Date.now(), block: parseInt(l.blockNumber, 16) }));
    e.legs.push({ token: a === WETH ? "eth" : a, from: "0x" + l.topics[1].slice(26).toLowerCase(), to: "0x" + l.topics[2].slice(26).toLowerCase(),
      amount: t?.decimals != null ? raw / 10 ** t.decimals : raw }); // unknown token: raw amount, only its sign is used
  }
  const ethPrice = tokens.get(WETH)?.price || 0;
  const known = (tok) => tok === "eth" || (!!tokens.get(tok)?.tradable && tokens.get(tok).decimals != null);
  const valueOf = (tok, amt) => (tok === "eth" ? (ethPrice ? amt * ethPrice : null) : known(tok) ? amt * tokens.get(tok).price : null);
  const isMajor = (tok) => tok === "eth" || (tokens.get(tok)?.kind || "token") !== "token";
  // Check wallet-or-contract first, only for addresses that moved enough to make a swap worth showing.
  const need = new Set();
  for (const [h, e] of byTx) {
    const f = txInfo.get(h)?.from;
    for (const l of e.legs) {
      if ((valueOf(l.token, l.amount) || 0) < SWAP_MIN_USD) continue;
      for (const a of [l.from, l.to]) if (a !== f && !isContract.has(a)) need.add(a);
    }
  }
  if (need.size) await ensureCodeFor([...need]);
  const BUSINESS = new Set(["exchange", "issuer", "bridge", "dex", "defi", "mev"]); // their moves are not their own trades
  const isWallet = (a) => (isSafe.has(a) || isContract.get(a) === false) && !BUSINESS.has(catOf(a));
  const out = [], now = Date.now();
  for (const [h, e] of byTx) {
    const x = txInfo.get(h);
    for (const sw of swapsFromLegs(e.legs, { isWallet, valueOf, isMajor, txFrom: x && !BUSINESS.has(catOf(x.from)) ? x.from : null, txValueEth: x?.value || 0 })) {
      const id = `${h}:${sw.wallet}`;
      if (sw.usd < SWAP_MIN_USD || swapSeen.has(id)) continue;
      swapSeen.set(id, e.t);
      const tok = (k) => (k === "eth" ? { address: WETH, symbol: "ETH" } : { address: k, symbol: tokens.get(k).symbol });
      const via = x?.to ? labelOf(x.to) : null;
      if (x?.to && !via) queueName(x.to, sw.usd * 5); // routers repeat: naming one names many swaps
      queueName(sw.wallet, sw.usd);
      out.push({ id, tx: h, t: e.t, block: e.block, wallet: sw.wallet, safe: isSafe.has(sw.wallet), from: tok(sw.from), to: tok(sw.to),
        fromAmt: sw.fromAmt, toAmt: sw.toAmt, usd: sw.usd, dex: via?.name || "DEX", router: x?.to || null });
      if (now - e.t < HOUR) swapTimes.push(e.t);
    }
  }
  return out;
}
// The DEX section subscribes to the swaps found in each new block.
export const onWhaleSwaps = (fn) => { swapListeners.push(fn); };

function prune() {
  const now = Date.now();
  let cut = 0;
  while (cut < transfers.length && now - transfers[cut].t > DAY) seen.delete(transfers[cut++].id);
  if (cut) transfers.splice(0, cut);
  for (const [k, t] of lastAlertAt) if (now - t > DAY) lastAlertAt.delete(k);
  rpcCalls = rpcCalls.filter((t) => now - t < MIN); dexCalls = dexCalls.filter((t) => now - t < MIN); telegramSent = telegramSent.filter((t) => now - t < HOUR);
  swapTimes = swapTimes.filter((t) => now - t < HOUR);
  for (const [k, t] of swapSeen) if (now - t > DAY) swapSeen.delete(k);
}

// ───────────────────────────── alerts ─────────────────────────────
export const fmtUsd = (v) => (v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${Math.round(v)}`);
const fmtAmt = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v >= 1 ? v.toFixed(2) : v.toPrecision(3));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const who = (a) => { const l = labelOf(a); return l ? l.name : short(a); };
const isStable = (tr) => tokens.get(tr.token)?.kind === "stable";
const links = (tr) => [{ label: "tx", url: `https://etherscan.io/tx/${tr.tx}` },
  { label: "sender on Arkham", url: `https://intel.arkm.com/explorer/address/${tr.from}` },
  { label: "receiver on Arkham", url: `https://intel.arkm.com/explorer/address/${tr.to}` }];
const KIND_TEXT = { deposit: "deposit to an exchange", withdrawal: "withdrawal from an exchange", exchange_to_exchange: "exchange to exchange",
  internal: "internal exchange move", mint: "minted", burn: "burned", issuer: "stablecoin issuer move", dex: "DEX trade", bridge: "bridge",
  defi: "DeFi", transfer: "wallet to wallet" };

let telegramSent = [];
function fire(key, type, tr, title, extra = []) {
  const now = Date.now();
  if (lastAlertAt.has(key)) return;
  lastAlertAt.set(key, now);
  const lines = [`${who(tr.from)} → ${who(tr.to)}`, `${fmtAmt(tr.amount)} ${tr.symbol} · ${KIND_TEXT[tr.kind] || tr.kind}`, ...extra];
  const e = { id: `${type}:${now}:${Math.random().toString(36).slice(2, 7)}`, type, time: now, net: "eth", from: tr.symbol, to: "", usd: tr.usd,
    title, lines, links: links(tr) };
  state.events = [e, ...state.events].slice(0, MAX_EVENTS);
  if (!DEMO && TELEGRAM_ON() && state.telegramConfigured && telegramSent.length < TELEGRAM_PER_HOUR) {
    telegramSent.push(now);
    const label = { whale: "WHALE TRANSFER", deposit: "EXCHANGE DEPOSIT", withdrawal: "EXCHANGE WITHDRAWAL", mint: "STABLECOIN MINT", burn: "STABLECOIN BURN",
      issuer: "ISSUER MOVE", wallet: "WATCHED WALLET", token: "WATCHED TOKEN" }[type] || type.toUpperCase();
    sendTelegram([`${label} · Ethereum`, title, ...lines, `tx: ${links(tr)[0].url}`, "Research signal only, not financial advice."].join("\n"));
  }
  persist();
}

function checkAlerts(fresh) {
  const now = Date.now(), byTx = new Map();
  for (const tr of fresh) {
    refreshKind(tr);
    if (now - tr.t > FRESH_MS || tr.t < state.startedAt - FRESH_MS) continue;
    // watched wallets and tokens: any size above the watch minimum
    for (const w of state.watches) {
      if (w.kind === "wallet" && (tr.from === w.address || tr.to === w.address) && tr.usd >= w.minUsd) {
        const dir = tr.from === w.address ? "sent" : "received";
        fire(`wallet:${w.id}:${tr.id}`, "wallet", tr, `${w.name || short(w.address)} ${dir} ${fmtUsd(tr.usd)} ${tr.symbol}`);
      }
      if (w.kind === "token" && tr.token === w.token && tr.usd >= w.minUsd && tr.kind !== "internal") {
        fire(`token:${w.id}:${tr.id}`, "token", tr, `${fmtUsd(tr.usd)} ${tr.symbol} moved`);
      }
    }
    if (tr.kind === "internal" || plumbing(tr) || catOf(tr.from) === "mev" || catOf(tr.to) === "mev") continue;
    const stable = isStable(tr);
    if ((tr.kind === "mint" || tr.kind === "burn") && stable && tr.usd >= MINT_ALERT_USD) {
      fire(`mint:${tr.id}`, tr.kind, tr, `${fmtUsd(tr.usd)} ${tr.symbol} ${tr.kind === "mint" ? "minted" : "burned"}`); continue;
    }
    if (tr.kind === "issuer" && stable && tr.usd >= MINT_ALERT_USD) { fire(`issuer:${tr.id}`, "issuer", tr, `${who(tr.from)} moved ${fmtUsd(tr.usd)} ${tr.symbol}`); continue; }
    if ((tr.kind === "deposit" || tr.kind === "withdrawal") && !stable && tr.usd >= EXCHANGE_ALERT_USD) {
      const ex = labelOf(tr.kind === "deposit" ? tr.to : tr.from)?.entity || "an exchange";
      fire(`${tr.kind}:${tr.id}`, tr.kind, tr, tr.kind === "deposit" ? `${fmtUsd(tr.usd)} ${tr.symbol} deposited to ${ex}` : `${fmtUsd(tr.usd)} ${tr.symbol} withdrawn from ${ex}`,
        [tr.kind === "deposit" ? "Deposits are often made to sell" : "Withdrawals often mean holding off-exchange"]);
      continue;
    }
    if (tr.usd >= (stable ? STABLE_ALERT_USD : ALERT_USD) && !["mint", "burn", "dex", "defi", "contract"].includes(tr.kind)) { // holders' moves, not DeFi plumbing
      const best = byTx.get(tr.tx);
      if (!best || tr.usd > best.usd) byTx.set(tr.tx, tr); // one whale alert per transaction (a swap has two legs)
    }
  }
  for (const tr of byTx.values()) fire(`whale:${tr.tx}`, "whale", tr, `${fmtUsd(tr.usd)} ${tr.symbol} moved`);
}

async function sendTelegram(text) { // shared queue (telegram.js): retried until delivered
  const r = await tgQueue(text, { kind: "whales" });
  if (r.sent) delete state.errors.Telegram; else if (r.error) state.errors.Telegram = r.error;
}

// ───────────────────────────── watchlist ─────────────────────────────
const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || "").trim());
function addWatch({ target, name = "", minUsd = 0 }) {
  const t = String(target || "").trim();
  const min = Math.max(0, Number(minUsd) || 0), label = String(name || "").trim().slice(0, 40);
  let w;
  if (isAddress(t)) {
    const address = t.toLowerCase(), known = tokens.get(address);
    w = known?.ok ? { kind: "token", token: address, symbol: known.symbol } : { kind: "wallet", address, name: label };
  } else {
    const sym = t.replace(/^\$/, "").toUpperCase();
    if (!/^[A-Z0-9.]{1,15}$/.test(sym)) throw Object.assign(new Error("Enter a wallet address (0x…) or a token symbol like PEPE"), { status: 400 });
    const match = [...tokens.entries()].filter(([, x]) => x.ok && x.symbol.toUpperCase() === sym).sort((a, b) => (b[1].liquidity || 0) - (a[1].liquidity || 0))[0];
    if (!match) throw Object.assign(new Error(`${sym} has not moved on Ethereum since the tracker started; paste its contract address instead`), { status: 400 });
    w = { kind: "token", token: match[0], symbol: match[1].symbol };
  }
  Object.assign(w, { id: Math.random().toString(36).slice(2, 10), minUsd: min, createdAt: Date.now() });
  state.watches.push(w);
  persist();
  return w;
}
function removeWatch(id) { state.watches = state.watches.filter((w) => w.id !== id); persist(); }

// ───────────────────────────── persistence ─────────────────────────────
let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const data = JSON.stringify({ events: state.events, watches: state.watches, lastAlertAt: Object.fromEntries(lastAlertAt) });
    writeFile(STATE_FILE + ".tmp", data).then(() => rename(STATE_FILE + ".tmp", STATE_FILE)).catch(() => {});
  }, 500);
}
async function loadState() {
  await loadNames();
  try { labels = JSON.parse(await readFile(path.join(here, "data", "eth-labels.json"), "utf8")).labels || {}; }
  catch (e) { state.errors.Labels = `data/eth-labels.json missing (${e.message}); run node scripts/build-labels.js`; }
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    state.events = (saved.events || []).slice(0, MAX_EVENTS);
    state.watches = saved.watches || [];
    for (const [k, v] of Object.entries(saved.lastAlertAt || {})) if (Date.now() - v < DAY) lastAlertAt.set(k, v);
  } catch { /* first run */ }
}

// ───────────────────────────── demo mode (DEMO=1) ─────────────────────────────
function demoTick() {
  const ex = Object.entries(labels).filter(([, l]) => l[1] === "exchange").slice(0, 30).map(([a]) => a);
  const funds = Object.entries(labels).filter(([, l]) => l[1] === "fund").map(([a]) => a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const wallet = () => "0x" + Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  const toks = [["0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT", 1, "stable"], ["0x6982508145454ce325ddbe47a25d4ec3d2311933", "PEPE", 0.0000043, "token"],
    ["0x514910771af9ca656af840dff83e8264ecf986ca", "LINK", 11.3, "token"], ["eth", "ETH", 2300, "bluechip"], ["0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "WBTC", 79000, "bluechip"]];
  for (const [a, s, p, k] of toks) if (a !== "eth") tokens.set(a, { symbol: s, price: p, liquidity: 5e7, fdv: 1e10, ok: true, at: Date.now(), kind: k, decimals: 18 });
  const fresh = [];
  for (let i = 0; i < 1 + Math.floor(Math.random() * 2); i++) {
    const [token, symbol, price] = pick(toks), usd = Math.random() < 0.15 ? 1e6 + Math.random() * 2e7 : 1e5 + Math.random() * 8e5;
    const r = Math.random(), from = r < 0.35 ? wallet() : r < 0.6 ? pick(ex) : r < 0.7 && funds.length ? pick(funds) : wallet();
    const to = r < 0.35 ? pick(ex) : r < 0.6 ? wallet() : wallet();
    const tx = "0x" + Math.random().toString(16).slice(2).padEnd(64, "0");
    const tr = record({ id: `${tx}:0`, t: Date.now(), block: (state.lastBlock = (state.lastBlock || 21_000_000) + 1), tx, token, symbol, amount: usd / price, usd, from, to });
    for (const a of [from, to]) if (!isContract.has(a)) isContract.set(a, false);
    if (tr) fresh.push(tr);
  }
  return fresh;
}

// New transfers: learn exchange addresses, and queue unknown addresses for a name lookup (biggest first).
function afterTransfers(list) {
  learnExchanges(list);
  for (const tr of list) for (const a of [tr.from, tr.to]) if (!labelOf(a)) queueName(a, tr.usd);
}

// ───────────────────────────── main loop ─────────────────────────────
async function step() {
  if (DEMO) { checkAlerts(demoTick()); state.status = "demo"; state.lastUpdated = Date.now(); prune(); return sleep(3000); }
  const head = parseInt(await rpc("eth_blockNumber", []), 16);
  state.head = head;
  if (state.lastBlock == null) {
    state.lastBlock = head - 1;
    state.backfill = { from: head - BACKFILL_BLOCKS, next: head - BACKFILL_BLOCKS, to: head - 1, done: BACKFILL_BLOCKS <= 0 };
  }
  if (head - state.lastBlock > 25) { state.errors.Gap = `Fell ${head - state.lastBlock} blocks behind; skipped ahead`; state.lastBlock = head - 3; }
  if (head > state.lastBlock) {
    const to = Math.min(head, state.lastBlock + 3);
    const fresh = await processBlocks(state.lastBlock + 1, to, true);
    await ensureCode(fresh);
    afterTransfers(fresh);
    state.lastBlock = to;
    state.lastBlockTime = fresh.length ? Math.max(...fresh.map((x) => x.t)) : state.lastBlockTime || Date.now();
    checkAlerts(fresh);
  } else if (!state.backfill.done) {
    const b = state.backfill, end = Math.min(b.to, b.next + 9); // history: token transfers only, 10 blocks per request
    const old = await processBlocks(b.next, end, false);
    await ensureCode(old);
    afterTransfers(old);
    b.next = end + 1;
    if (b.next > b.to) b.done = true;
  } else await sleep(3000);
  state.status = "connected";
  delete state.errors.RPC;
  state.lastUpdated = Date.now();
  prune();
}
async function loop() {
  for (;;) {
    try { await step(); }
    catch (e) { state.status = "error"; state.errors.RPC = e.message; await sleep(5000); }
  }
}

// ───────────────────────────── API ─────────────────────────────
const party = (a) => { const l = labelOf(a); return { address: a, name: l?.name || null, category: l?.category || null, entity: l?.entity || null,
  learned: !!l?.learned, looked: !!l?.looked, contract: isContract.has(a) ? isContract.get(a) : null, safe: isSafe.has(a),
  special: a === ZERO ? "mint/burn" : a === DEAD ? "burn" : null }; };
function transferOut(tr) {
  return { id: tr.id, t: tr.t, block: tr.block, tx: tr.tx, txUrl: `https://etherscan.io/tx/${tr.tx}`, token: tr.token, symbol: tr.symbol, amount: tr.amount,
    usd: tr.usd, kind: tr.kind, stable: isStable(tr), plumbing: plumbing(tr), from: party(tr.from), to: party(tr.to) };
}

function snapshot(windowKey) {
  const win = windowKey === "24h" ? DAY : HOUR, now = Date.now();
  const list = transfers.filter((tr) => now - tr.t <= win).map(refreshKind);
  const big = list.filter((tr) => tr.usd >= MIN_USD);
  const tokenFlow = new Map(), exchangeFlow = new Map(), entities = new Map(), wallets = new Map();
  const add = (map, key, init) => { if (!map.has(key)) map.set(key, init()); return map.get(key); };
  for (const tr of big) {
    if (tr.kind === "internal") continue;
    if (tr.kind === "deposit" || tr.kind === "withdrawal") {
      const ex = labelOf(tr.kind === "deposit" ? tr.to : tr.from).entity;
      const f = add(tokenFlow, tr.token, () => ({ token: tr.token, symbol: tr.symbol, stable: isStable(tr), deposits: 0, withdrawals: 0, n: 0 }));
      const e = add(exchangeFlow, ex, () => ({ exchange: ex, deposits: 0, withdrawals: 0, n: 0, stableIn: 0, stableOut: 0 }));
      if (tr.kind === "deposit") { f.deposits += tr.usd; e.deposits += tr.usd; if (isStable(tr)) e.stableIn += tr.usd; }
      else { f.withdrawals += tr.usd; e.withdrawals += tr.usd; if (isStable(tr)) e.stableOut += tr.usd; }
      f.n++; e.n++;
    }
    if (plumbing(tr)) continue;
    for (const [a, dir] of [[tr.from, -1], [tr.to, 1]]) {
      const l = labelOf(a), personal = !l || PERSONAL.has(l.category); // a wallet with no label, an ENS name or a Safe
      if (a === ZERO || a === DEAD || (l && ["dex", "mev", "token"].includes(l.category)) || (l?.looked && l.category === "defi")) continue; // protocols named by Blockscout: too many to list
      if (personal && isContract.get(a) !== false && !isSafe.has(a)) continue; // wallets only
      const target = !personal ? add(entities, l.entity, () => ({ name: l.entity, category: l.category, inUsd: 0, outUsd: 0, n: 0, addresses: new Set() }))
        : add(wallets, a, () => ({ address: a, name: l?.name || null, category: l?.category || null, inUsd: 0, outUsd: 0, n: 0, tokens: new Map() }));
      if (dir > 0) target.inUsd += tr.usd; else target.outUsd += tr.usd;
      target.n++;
      if (!personal) target.addresses.add(a); else target.tokens.set(tr.symbol, (target.tokens.get(tr.symbol) || 0) + tr.usd);
    }
  }
  const nonStable = big.filter((tr) => !isStable(tr));
  const sum = (arr) => arr.reduce((s, tr) => s + tr.usd, 0);
  const headLag = state.lastBlockTime ? Math.round((now - state.lastBlockTime) / 1000) : null;
  return {
    demo: DEMO, status: state.status, errors: state.errors, lastUpdated: state.lastUpdated, telegramConfigured: state.telegramConfigured, telegramOn: TELEGRAM_ON(),
    window: windowKey === "24h" ? "24h" : "1h",
    chain: { name: "Ethereum", head: state.head, lastBlock: state.lastBlock, lagSec: headLag, backfill: state.backfill },
    config: { minUsd: MIN_USD, alertUsd: ALERT_USD, stableAlertUsd: STABLE_ALERT_USD, telegramPerHour: TELEGRAM_PER_HOUR, exchangeAlertUsd: EXCHANGE_ALERT_USD, mintAlertUsd: MINT_ALERT_USD, minLiquidity: MIN_LIQUIDITY,
      labels: Object.keys(labels).length, labelsAsOf: "June 2023", categories: CATEGORY_NAMES, swapMinUsd: SWAP_MIN_USD },
    health: { rpcCallsLastMin: rpcCalls.filter((t) => now - (t || 0) < MIN).length, dexCallsLastMin: dexCalls.filter((t) => now - t < MIN).length,
      rpc: rpcStats.map((s) => ({ url: shownUrl(s.url), ok: s.ok, fail: s.fail, lastError: s.lastError, lastErrorAt: s.lastErrorAt,
        restUntil: s.restUntil > now ? s.restUntil : null, maxBatch: s.maxBatch, cannot: [...s.cannot].map(([k, why]) => ({ what: NEEDS[k], why })) })),
      tokensPriced: [...tokens.values()].filter((t) => t.ok).length, transfers24h: transfers.length, addressesChecked: isContract.size,
      swaps1h: swapTimes.length, names: { ...nameStats, cached: names.size, queue: nameQueue.size, learned: learned.size, safes: isSafe.size, source: BLOCKSCOUT.replace(/^https?:\/\//, "") } },
    kinds: list.filter((x) => x.usd >= MIN_USD).reduce((m, x) => ((m[x.kind] = (m[x.kind] || 0) + 1), m), {}),
    totals: { transfers: big.length, usd: sum(big), deposits: sum(nonStable.filter((x) => x.kind === "deposit")),
      withdrawals: sum(nonStable.filter((x) => x.kind === "withdrawal")),
      stableMinted: sum(big.filter((x) => x.kind === "mint" && isStable(x))), stableBurned: sum(big.filter((x) => x.kind === "burn" && isStable(x))) },
    // the newest 250 ordinary transfers plus the newest 80 internal / contract-to-contract ones (hidden by default on the page)
    transfers: [...big.filter((x) => x.kind !== "internal" && !plumbing(x)).slice(-250), ...big.filter((x) => x.kind === "internal" || plumbing(x)).slice(-80)]
      .sort((a, b) => b.t - a.t).map(transferOut),
    tokenFlows: [...tokenFlow.values()].map((f) => ({ ...f, net: f.deposits - f.withdrawals })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 25),
    exchangeFlows: [...exchangeFlow.values()].map((f) => ({ ...f, net: f.deposits - f.withdrawals })).sort((a, b) => (b.deposits + b.withdrawals) - (a.deposits + a.withdrawals)).slice(0, 20),
    entities: [...entities.values()].map((e) => ({ name: e.name, category: e.category, inUsd: e.inUsd, outUsd: e.outUsd, net: e.inUsd - e.outUsd, n: e.n, addresses: e.addresses.size }))
      .sort((a, b) => (b.inUsd + b.outUsd) - (a.inUsd + a.outUsd)).slice(0, 25),
    whales: [...wallets.values()].map((w) => ({ address: w.address, name: w.name, category: w.category, inUsd: w.inUsd, outUsd: w.outUsd, net: w.inUsd - w.outUsd, n: w.n,
      topToken: [...w.tokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null })).sort((a, b) => (b.inUsd + b.outUsd) - (a.inUsd + a.outUsd)).slice(0, 25),
    events: state.events.slice(0, 60),
    watches: state.watches,
  };
}

function addressView(a) {
  const address = String(a || "").toLowerCase();
  if (!isAddress(address)) throw Object.assign(new Error("Not an Ethereum address"), { status: 400 });
  const list = transfers.filter((tr) => tr.from === address || tr.to === address).map(refreshKind);
  const counter = new Map();
  let inUsd = 0, outUsd = 0;
  for (const tr of list) {
    const other = tr.from === address ? tr.to : tr.from;
    if (tr.to === address) inUsd += tr.usd; else outUsd += tr.usd;
    counter.set(other, (counter.get(other) || 0) + tr.usd);
  }
  return {
    ...party(address), categoryName: CATEGORY_NAMES[labelOf(address)?.category] || null, inUsd, outUsd, n: list.length,
    counterparties: [...counter.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([c, usd]) => ({ ...party(c), usd })),
    transfers: list.slice(-100).reverse().map(transferOut),
    links: [{ label: "Arkham", url: `https://intel.arkm.com/explorer/address/${address}` }, { label: "Etherscan", url: `https://etherscan.io/address/${address}` },
      { label: "DeBank", url: `https://debank.com/profile/${address}` }],
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
const allowedWrite = (req) => String(req.headers["content-type"] || "").includes("application/json") &&
  (!req.headers.origin || req.headers.origin.replace(/^https?:\/\//, "") === req.headers.host);

// Large Ethereum transfers of one token (matched by symbol) over the last 24h, for the AI trade desk.
export function tokenWhaleSummary(symbol) {
  const sym = String(symbol || "").toUpperCase(), now = Date.now();
  if (!started) return { tracked: false, reason: "whale tracker is off" };
  const list = transfers.filter((tr) => String(tr.symbol).toUpperCase() === sym && now - tr.t <= DAY).map(refreshKind).filter((tr) => tr.kind !== "internal" && !plumbing(tr));
  const sum = (k) => list.filter((x) => x.kind === k).reduce((s, x) => s + x.usd, 0);
  const deposits = sum("deposit"), withdrawals = sum("withdrawal");
  return {
    tracked: true, chain: "Ethereum (ERC-20 and ETH transfers >= " + fmtUsd(MIN_USD) + ")", transfers24h: list.length,
    totalUsd24h: list.reduce((s, x) => s + x.usd, 0), exchangeDeposits24h: deposits, exchangeWithdrawals24h: withdrawals,
    netToExchanges24h: deposits - withdrawals,
    largest: [...list].sort((a, b) => b.usd - a.usd).slice(0, 5).map((x) => ({ usd: Math.round(x.usd), kind: x.kind, from: who(x.from), to: who(x.to),
      ageMin: Math.round((now - x.t) / 60_000) })),
  };
}

let started = false;
export function startWhales() {
  if (started) return;
  started = true;
  console.log(`Whale tracker: Ethereum transfers >= ${fmtUsd(MIN_USD)}, alerts >= ${fmtUsd(ALERT_USD)} | RPC: ${RPCS.map(shownUrl).join(", ")}${env.WHALES_RPC ? "" : " (free public nodes, no API key)"}`);
  loadState().finally(() => { loop(); if (!DEMO) nameLoop(); });
}

// GET /api/whales (?window=1h|24h, ?only=events), GET /api/whales/address?a=0x…, POST /api/whales/watch | unwatch.
export async function handleWhalesRequest(req, res, url) {
  if (!url.pathname.startsWith("/api/whales")) return false;
  try {
    if (url.pathname === "/api/whales" && req.method === "GET") {
      if (!started) jsonResponse(res, 200, { disabled: true, events: [], watches: [] });
      else if (url.searchParams.get("only") === "events") jsonResponse(res, 200, { events: state.events.slice(0, 20) });
      else jsonResponse(res, 200, snapshot(url.searchParams.get("window")));
    } else if (url.pathname === "/api/whales/address" && req.method === "GET") jsonResponse(res, 200, addressView(url.searchParams.get("a")));
    else if ((url.pathname === "/api/whales/watch" || url.pathname === "/api/whales/unwatch") && req.method === "POST") {
      if (!allowedWrite(req)) jsonResponse(res, 403, { error: "Changes are only accepted from the screener page" });
      else {
        const body = await readBody(req);
        if (url.pathname.endsWith("/unwatch")) { removeWatch(String(body.id || "")); jsonResponse(res, 200, { ok: true }); }
        else jsonResponse(res, 200, addWatch(body));
      }
    } else jsonResponse(res, 404, { error: "Not found" });
  } catch (e) {
    jsonResponse(res, e.status || 500, { error: e.status ? e.message : "Server error" });
    if (!e.status) console.error("whales:", e);
  }
  return true;
}

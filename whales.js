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

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO = env.DEMO === "1";
const RPCS = (env.WHALES_RPC || "https://ethereum-rpc.publicnode.com,https://eth.drpc.org,https://eth-mainnet.public.blastapi.io,https://rpc.mevblocker.io").split(",").map((s) => s.trim()).filter(Boolean);
const MIN_USD = num("WHALES_MIN_USD", 100_000);                    // transfers below this are not kept (watched wallets excepted)
const ALERT_USD = num("WHALES_ALERT_USD", 1_000_000);                 // non-stablecoin transfers
const STABLE_ALERT_USD = num("WHALES_STABLE_ALERT_USD", 25_000_000);  // stablecoins move in size all day; alert only on very large ones
const TELEGRAM_PER_HOUR = num("WHALES_TELEGRAM_PER_HOUR", 30);        // all alerts still show on the page
const TELEGRAM_ON = env.WHALES_TELEGRAM === "1";                      // off by default: Telegram is for ignition alerts and the AI
const EXCHANGE_ALERT_USD = num("WHALES_EXCHANGE_ALERT_USD", 500_000);
const MINT_ALERT_USD = num("WHALES_MINT_ALERT_USD", 10_000_000);
const MIN_LIQUIDITY = num("WHALES_MIN_LIQUIDITY_USD", 250_000);
const BACKFILL_BLOCKS = num("WHALES_BACKFILL_BLOCKS", 300);         // ~1 hour of history at start
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
const rpcStats = RPCS.map((url) => ({ url, ok: 0, fail: 0, lastError: null }));
let rpcIndex = 0, rpcCalls = [];

// ───────────────────────────── labels ─────────────────────────────
const CATEGORY_NAMES = { exchange: "Exchange", fund: "Fund / market maker", issuer: "Stablecoin issuer", bridge: "Bridge", dex: "DEX", defi: "DeFi",
  mev: "MEV bot", mixer: "Mixer", flagged: "Flagged", watched: "Your label" };
const watchedWallet = (a) => state.watches.find((w) => w.kind === "wallet" && w.address === a);
export function labelOf(a) {
  const w = watchedWallet(a);
  if (w && w.name) return { name: w.name, category: "watched", entity: w.name };
  const l = labels[a];
  if (!l) return null;
  return { name: l[0], category: l[1], entity: entityOf(l[0], l[1]) };
}
// "Binance 14" -> Binance, "Crypto.com: MultiSig 7" -> Crypto.com, "Wintermute (Binance deposit)" -> Binance.
export function entityOf(name, category) {
  const dep = name.match(/\((.+) deposit\)$/i);
  if (dep && category === "exchange") return dep[1];
  return name.replace(/:.*$/, "").replace(/\s+(\d+|Old Address.*|Hot Wallet.*|Cold Wallet.*)$/i, "").trim();
}
const catOf = (a) => labelOf(a)?.category || null;

// ───────────────────────────── RPC (with fallback) ─────────────────────────────
async function rpcBatch(calls) {
  let lastErr;
  for (let attempt = 0; attempt < RPCS.length * 2; attempt++) {
    const st = rpcStats[rpcIndex % RPCS.length];
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      rpcCalls.push(Date.now());
      const res = await fetch(st.url, { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c[0], params: c[1] }))) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      if (!Array.isArray(out)) throw new Error(out?.error?.message || "unexpected reply");
      const byId = new Map(out.map((r) => [r.id, r]));
      const results = calls.map((_, i) => {
        const r = byId.get(i);
        if (!r || r.error) throw new Error(r?.error?.message || "missing result");
        return r.result;
      });
      st.ok++; st.lastError = null;
      return results;
    } catch (e) {
      lastErr = e; st.fail++; st.lastError = e.name === "AbortError" ? "timeout" : e.message;
      rpcIndex++; // try the next node
      await sleep(400);
    } finally { clearTimeout(timer); }
  }
  throw new Error(`All RPC nodes failed (${lastErr?.message})`);
}
const rpc = async (method, params) => (await rpcBatch([[method, params]]))[0];
const hex = (n) => "0x" + n.toString(16);

// ───────────────────────────── tokens + prices ─────────────────────────────
let dexCalls = [];
async function ensureTokens(addrs) {
  const now = Date.now();
  const need = [...new Set(addrs)].filter((a) => { const t = tokens.get(a); return !t || now - t.at > (t.ok ? 5 * MIN : 6 * HOUR); });
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
      const ok = !!b && price > 0 && (verified !== "token" || b.liq >= MIN_LIQUIDITY);
      tokens.set(a, { symbol, price, liquidity: b?.liq || 0, fdv: Number(b?.p.fdv || b?.p.marketCap) || 0, ok, at: now, kind: verified,
        decimals: prev?.decimals ?? null, url: b?.p.url || null });
      if (ok && prev?.decimals == null) fresh.push(a);
    }
    // decimals straight from each contract (one batched call)
    if (fresh.length) {
      try {
        const res = await rpcBatch(fresh.map((a) => ["eth_call", [{ to: a, data: "0x313ce567" }, "latest"]]));
        res.forEach((r, i) => { const d = parseInt(r, 16); const t = tokens.get(fresh[i]); if (Number.isFinite(d) && d <= 36) t.decimals = d; else t.ok = false; });
      } catch { for (const a of fresh) tokens.get(a).at = 0; } // retry next time
    }
  }
}
// Largest believable value for one transfer: verified tokens are uncapped; others can't exceed their liquidity by much.
const capOf = (t) => (t.kind !== "token" ? Infinity : t.liquidity < 5e6 ? 50 * t.liquidity : Math.max(50 * t.liquidity, 0.1 * t.fdv));

// Wallet or contract, for every address in new transfers (batched, cached). EIP-7702 wallets carry a 0xef0100 stub.
async function ensureCode(list) {
  const need = [...new Set(list.flatMap((tr) => [tr.from, tr.to]))].filter((a) => !isContract.has(a) && a !== ZERO && a !== DEAD);
  for (let i = 0; i < need.length; i += 80) {
    const chunk = need.slice(i, i + 80);
    try {
      const codes = await rpcBatch(chunk.map((a) => ["eth_getCode", [a, "latest"]]));
      codes.forEach((c, j) => isContract.set(chunk[j], typeof c === "string" && c.length > 2 && !c.startsWith("0xef0100")));
    } catch { /* unknown for now; retried with the next transfers */ }
  }
}
// Both sides unlabelled contracts: vault / router plumbing rather than a holder moving funds.
const plumbing = (tr) => !labelOf(tr.from) && !labelOf(tr.to) && isContract.get(tr.from) === true && isContract.get(tr.to) === true;

// ───────────────────────────── transfers ─────────────────────────────
export function kindOf(from, to, cat = catOf, entity = (a) => labelOf(a)?.entity) {
  if (from === ZERO) return "mint";
  if (to === ZERO || to === DEAD) return "burn";
  const fc = cat(from), tc = cat(to);
  if (fc === "exchange" && tc === "exchange") return entity(from) === entity(to) ? "internal" : "exchange_to_exchange";
  if (tc === "exchange") return "deposit";
  if (fc === "exchange") return "withdrawal";
  if (fc === "issuer" || tc === "issuer") return "issuer";
  if (fc === "dex" || tc === "dex") return "dex";
  if (fc === "bridge" || tc === "bridge") return "bridge";
  if (fc === "defi" || tc === "defi") return "defi";
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
  return fresh;
}

function prune() {
  const now = Date.now();
  let cut = 0;
  while (cut < transfers.length && now - transfers[cut].t > DAY) seen.delete(transfers[cut++].id);
  if (cut) transfers.splice(0, cut);
  for (const [k, t] of lastAlertAt) if (now - t > DAY) lastAlertAt.delete(k);
  rpcCalls = rpcCalls.filter((t) => now - t < MIN); dexCalls = dexCalls.filter((t) => now - t < MIN); telegramSent = telegramSent.filter((t) => now - t < HOUR);
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
  if (!DEMO && TELEGRAM_ON && state.telegramConfigured && telegramSent.length < TELEGRAM_PER_HOUR) {
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
    if (tr.usd >= (stable ? STABLE_ALERT_USD : ALERT_USD) && !["mint", "burn", "dex"].includes(tr.kind)) {
      const best = byTx.get(tr.tx);
      if (!best || tr.usd > best.usd) byTx.set(tr.tx, tr); // one whale alert per transaction (a swap has two legs)
    }
  }
  for (const tr of byTx.values()) fire(`whale:${tr.tx}`, "whale", tr, `${fmtUsd(tr.usd)} ${tr.symbol} moved`);
}

async function sendTelegram(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    delete state.errors.Telegram;
  } catch (e) { state.errors.Telegram = e.message; }
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
    state.lastBlock = to;
    state.lastBlockTime = fresh.length ? Math.max(...fresh.map((x) => x.t)) : state.lastBlockTime || Date.now();
    checkAlerts(fresh);
  } else if (!state.backfill.done) {
    const b = state.backfill, end = Math.min(b.to, b.next + 9); // history: token transfers only, 10 blocks per request
    await ensureCode(await processBlocks(b.next, end, false));
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
  contract: isContract.has(a) ? isContract.get(a) : null, special: a === ZERO ? "mint/burn" : a === DEAD ? "burn" : null }; };
function transferOut(tr) {
  return { id: tr.id, t: tr.t, block: tr.block, tx: tr.tx, txUrl: `https://etherscan.io/tx/${tr.tx}`, token: tr.token, symbol: tr.symbol, amount: tr.amount,
    usd: tr.usd, kind: tr.kind, stable: isStable(tr), plumbing: plumbing(tr), from: party(tr.from), to: party(tr.to) };
}

function snapshot(windowKey) {
  const win = windowKey === "24h" ? DAY : HOUR, now = Date.now();
  const list = transfers.filter((tr) => now - tr.t <= win);
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
      const l = labelOf(a);
      if (a === ZERO || a === DEAD || (l && ["dex", "mev"].includes(l.category)) || (!l && isContract.get(a) !== false)) continue; // wallets only
      const target = l ? add(entities, l.entity, () => ({ name: l.entity, category: l.category, inUsd: 0, outUsd: 0, n: 0, addresses: new Set() }))
        : add(wallets, a, () => ({ address: a, inUsd: 0, outUsd: 0, n: 0, tokens: new Map() }));
      if (dir > 0) target.inUsd += tr.usd; else target.outUsd += tr.usd;
      target.n++;
      if (l) target.addresses.add(a); else target.tokens.set(tr.symbol, (target.tokens.get(tr.symbol) || 0) + tr.usd);
    }
  }
  const nonStable = big.filter((tr) => !isStable(tr));
  const sum = (arr) => arr.reduce((s, tr) => s + tr.usd, 0);
  const headLag = state.lastBlockTime ? Math.round((now - state.lastBlockTime) / 1000) : null;
  return {
    demo: DEMO, status: state.status, errors: state.errors, lastUpdated: state.lastUpdated, telegramConfigured: state.telegramConfigured, telegramOn: TELEGRAM_ON,
    window: windowKey === "24h" ? "24h" : "1h",
    chain: { name: "Ethereum", head: state.head, lastBlock: state.lastBlock, lagSec: headLag, backfill: state.backfill },
    config: { minUsd: MIN_USD, alertUsd: ALERT_USD, stableAlertUsd: STABLE_ALERT_USD, telegramPerHour: TELEGRAM_PER_HOUR, exchangeAlertUsd: EXCHANGE_ALERT_USD, mintAlertUsd: MINT_ALERT_USD, minLiquidity: MIN_LIQUIDITY,
      labels: Object.keys(labels).length, labelsAsOf: "June 2023", categories: CATEGORY_NAMES },
    health: { rpcCallsLastMin: rpcCalls.filter((t) => now - (t || 0) < MIN).length, dexCallsLastMin: dexCalls.filter((t) => now - t < MIN).length,
      rpc: rpcStats.map((s) => ({ url: s.url.replace(/^https?:\/\//, ""), ok: s.ok, fail: s.fail, lastError: s.lastError })),
      tokensPriced: [...tokens.values()].filter((t) => t.ok).length, transfers24h: transfers.length, addressesChecked: isContract.size },
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
    whales: [...wallets.values()].map((w) => ({ address: w.address, inUsd: w.inUsd, outUsd: w.outUsd, net: w.inUsd - w.outUsd, n: w.n,
      topToken: [...w.tokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null })).sort((a, b) => (b.inUsd + b.outUsd) - (a.inUsd + a.outUsd)).slice(0, 25),
    events: state.events.slice(0, 60),
    watches: state.watches,
  };
}

function addressView(a) {
  const address = String(a || "").toLowerCase();
  if (!isAddress(address)) throw Object.assign(new Error("Not an Ethereum address"), { status: 400 });
  const list = transfers.filter((tr) => tr.from === address || tr.to === address);
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
  const list = transfers.filter((tr) => String(tr.symbol).toUpperCase() === sym && now - tr.t <= DAY && tr.kind !== "internal" && !plumbing(tr));
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
  console.log(`Whale tracker: Ethereum transfers >= ${fmtUsd(MIN_USD)}, alerts >= ${fmtUsd(ALERT_USD)} | RPC: ${RPCS.map((u) => u.replace(/^https?:\/\//, "")).join(", ")} | no API key`);
  loadState().finally(loop);
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

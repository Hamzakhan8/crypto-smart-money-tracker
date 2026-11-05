// Whales tab, "Whale signals": TAKE / LEAVE calls from what big wallets do on-chain. Free data, no API key.
//
// Sources:
//   1. Hyperliquid, an on-chain futures exchange where every wallet's open positions are public. From its leaderboard,
//      the largest profitable accounts are followed (account $1M+, in profit all-time and over the last 30 days; market
//      makers left out: they trade 300x+ their account a month). Their positions are read every 2 minutes, so the tab
//      knows per coin how much whale money is long and short, and how much they opened or closed in the last hour
//      (measured in coins, so a price move alone does not count as buying).
//   2. Ethereum (whales.ts): exchange deposits (often made to sell) and withdrawals (often accumulation), last 24h.
//   3. DEX swaps (flows.ts): the token bought vs sold on DEXes, last 24h.
//   4. Binance futures positioning (onchain.ts): the crowd vs the top traders.
// Per coin these add up to a score from -100 (whales selling) to +100 (whales buying):
//   Hyperliquid whales' long/short balance  up to ±60   (needs 5+ whales and $2M+ in the coin)
//   their last hour, opened minus closed    ±20         (at least $500k and 5% of their position)
//   Ethereum exchange flow, 24h             ±10         ($1M+ net withdrawn = +, net deposited = -)
//   DEX flow, 24h                           ±5          ($250k+ net bought by 5+ wallets)
//   Binance crowd vs top traders            ±10         (crowd short + top traders long = +, the mirror = -)
// And a call:
//   TAKE LONG   score 60+, the whales added longs in the last hour, 3+ whales long
//   TAKE SHORT  score -60 or less, the whales added shorts in the last hour, 3+ whales short (futures only)
//   LEAVE       the whales were long and cut 30%+ of it in the last hour, or $5M+ of an ERC-20 token went onto
//               exchanges in 24h: sell or do not buy
//   WATCH       anything else
// Every TAKE / LEAVE is followed: the price 4h, 24h and 3 days later, and whether it went the called way.
//
// Honest note: this is NEW and NOT backtested. Hyperliquid publishes positions now, not a history of them, so the
// live record on the page is the only test. Following the wallets that did best so far also means following some that
// were lucky. Research, not financial advice.
import { readFile } from "node:fs/promises";
import { num, pool, r2, writeAtomic } from "./util.ts";

const MIN = 60_000, HOUR = 3_600_000;
export const RULE = Object.freeze({
  whales: num("WHALESIG_WALLETS", 200),           // accounts followed
  minAccount: num("WHALESIG_MIN_ACCOUNT", 1_000_000),
  maxTurnover: num("WHALESIG_MAX_TURNOVER", 300), // 30-day volume / account above this = a market maker, left out
  minWhales: 5, minNotional: 2_000_000,           // enough whale money in a coin to read it
  minFlow: 500_000, minFlowShare: 0.05,           // a real last-hour move
  exFlow: 1_000_000, exLeave: 5_000_000, dexFlow: 250_000, dexWallets: 5,
  take: 60, takeWhales: 3, leaveCut: 0.3,
  cooldownH: 12, follow: [4, 24, 72],
});
type Rule = typeof RULE;
type FetchJson = (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; retries?: number; timeoutMs?: number }) => Promise<any>;
/** A row of Hyperliquid's leaderboard (the fields used). */
export interface LeaderboardRow {
  ethAddress: string; displayName?: string | null; accountValue: string;
  windowPerformances?: [window: string, perf: { pnl: string; roi: string; vlm: string }][];
}
/** A followed whale, with what the last scan read of it. */
interface Whale { address: string; name: string | null; account: number; pnlAll: number; pnlMonth: number; roiMonth: number | null; positions?: number; notional?: number }
/** One open position of a whale. */
interface Position { coin: string; size: number; px?: number | null; entry?: number | null; lev?: number | null }
interface Holder { address: string; size: number; usd: number; entry?: number | null; lev?: number | null }
/** Whale money in one coin: sizes in coins, notional in dollars, how many whales are long and short. */
interface WhaleMoney { longSize: number; shortSize: number; longUsd: number; shortUsd: number; nLong: number; nShort: number }
interface CoinBook extends WhaleMoney { coin: string; holders: Holder[] }
/** What judge reads from whales.ts's tokenWhaleSummary, flows.ts's tokenFlowSummary and an onchain.ts row. */
interface ExchangeFlow { tracked: boolean; netToExchanges24h?: number }
interface DexFlow { tracked: boolean; last24h?: { netUsd: number; wallets: number } }
interface Crowd { state?: string | null; label?: string; acc?: number | null; top?: number | null }
type Judgement = ReturnType<typeof judge>;
/** One coin on the Whales tab: the whale money in it and the call. */
interface CoinRow extends Judgement { coin: string; base: string; px: number; longUsd: number; shortUsd: number; nLong: number; nShort: number; top: Holder[] }
/** A TAKE / LEAVE call, and the price 4h, 24h and 3 days later. */
interface Signal {
  id: string; coin: string; base: string; call: string; t: number; px: number; score: number; why: string[]; longUsd: number; shortUsd: number; nLong: number; nShort: number;
  after: Record<number, { px: number; pct: number | null; right: boolean | null }>;
}
interface Store { version: number; whales: Whale[]; signals: Signal[]; whalesAt?: number | null }
interface ScanStatus {
  status: string; error: string | null; updatedAt: number | null; scanMs: number | null; whalesAt: number | null; read: number; failed: number;
  hourAgo?: number | null; nextScanAt?: number;
}
export interface WhaleSignalsOptions {
  fetchJson: FetchJson; base?: string; board?: string; stateFile?: string | null; now?: () => number;
  exchangeFlow?: (base: string) => ExchangeFlow | null; dexFlow?: (base: string) => DexFlow | null; crowdOf?: (base: string) => Crowd | null;
  sendTelegram?: ((text: string, kind: string) => unknown) | null; wantTelegram?: (kind: string) => boolean; demo?: boolean; p?: Rule; everyMs?: number;
}
export const fmtUsd = (v: number) => { const a = Math.abs(v), s = v < 0 ? "-" : ""; return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(0)}k` : `${s}$${Math.round(a)}`; };
// Hyperliquid names some coins per 1000 (kPEPE = 1000 PEPE): the coin as Binance names it, and the size factor.
export const binanceOf = (coin: string) => (/^k[A-Z]/.test(coin) ? { base: coin.slice(1), mult: 1000 } : { base: coin, mult: 1 });

// The leaderboard rows -> the whales to follow, best all-time profit first.
export function pickWhales(rows: LeaderboardRow[], p: Rule = RULE): Whale[] {
  const perf = (r: LeaderboardRow, w: string) => { const x: { pnl?: string; roi?: string; vlm?: string } = (r.windowPerformances || []).find((y) => y[0] === w)?.[1] || {}; return { pnl: +x.pnl || 0, roi: +x.roi || 0, vlm: +x.vlm || 0 }; };
  return (rows || []).map((r) => ({ address: String(r.ethAddress).toLowerCase(), name: r.displayName || null, account: +r.accountValue || 0, all: perf(r, "allTime"), month: perf(r, "month") }))
    .filter((w) => w.account >= p.minAccount && w.all.pnl > 0 && w.month.pnl > 0 && w.month.vlm / w.account <= p.maxTurnover)
    .sort((a, b) => b.all.pnl - a.all.pnl).slice(0, p.whales)
    .map((w) => ({ address: w.address, name: w.name, account: Math.round(w.account), pnlAll: Math.round(w.all.pnl), pnlMonth: Math.round(w.month.pnl), roiMonth: r2(w.month.roi * 100, 1) }));
}
// One snapshot of every followed whale's positions -> per coin: long / short size (coins) and notional, who holds it.
export function bookOf(positions: { address: string; list: Position[] }[], mids: Record<string, number>): Map<string, CoinBook> {
  const m = new Map<string, CoinBook>();
  for (const { address, list } of positions) for (const x of list) {
    const px = mids[x.coin] ?? x.px; if (!(px > 0) || !x.size) continue;
    const c = m.get(x.coin) || { coin: x.coin, longSize: 0, shortSize: 0, longUsd: 0, shortUsd: 0, nLong: 0, nShort: 0, holders: [] };
    if (x.size > 0) { c.longSize += x.size; c.longUsd += x.size * px; c.nLong++; } else { c.shortSize -= x.size; c.shortUsd -= x.size * px; c.nShort++; }
    c.holders.push({ address, size: x.size, usd: Math.round(x.size * px), entry: x.entry, lev: x.lev });
    m.set(x.coin, c);
  }
  return m;
}
// The score and the call for one coin. now = this snapshot's coin entry, then = the one about an hour ago (or null),
// px = the price, ex = whales.ts summary, dex = flows.ts summary, crowd = onchain.ts row (or null).
export function judge({ now: c, then, px, ex = null, dex = null, crowd = null }:
  { now: WhaleMoney | null; then: WhaleMoney | null; px: number; ex?: ExchangeFlow | null; dex?: DexFlow | null; crowd?: Crowd | null }, p: Rule = RULE) {
  const why: string[] = [], parts: { whales?: number; flow?: number; exchanges?: number; dex?: number; crowd?: number } = {};
  const total = (c?.longUsd || 0) + (c?.shortUsd || 0), n = (c?.nLong || 0) + (c?.nShort || 0);
  const net = (x: WhaleMoney | null) => (x ? x.longSize - x.shortSize : 0);
  let score = 0, flowUsd = null;
  if (c && n >= p.minWhales && total >= p.minNotional) {
    const bias = (c.longUsd - c.shortUsd) / total;
    parts.whales = Math.round(bias * 60); score += parts.whales;
    why.push(`${c.nLong} whales long ${fmtUsd(c.longUsd)}, ${c.nShort} short ${fmtUsd(c.shortUsd)}`);
    if (then) {
      flowUsd = (net(c) - net(then)) * px;
      if (Math.abs(flowUsd) >= Math.max(p.minFlow, p.minFlowShare * total)) {
        parts.flow = Math.sign(flowUsd) * 20; score += parts.flow;
        why.push(`last hour: whales ${flowUsd > 0 ? "added longs / cut shorts" : "added shorts / cut longs"} worth ${fmtUsd(Math.abs(flowUsd))}`);
      }
    }
  } else why.push(c ? `only ${n} whale${n === 1 ? "" : "s"} / ${fmtUsd(total)} in it: too little to read` : "no followed whale holds it");
  if (ex?.tracked && Math.abs(ex.netToExchanges24h || 0) >= p.exFlow) {
    parts.exchanges = ex.netToExchanges24h < 0 ? 10 : -10; score += parts.exchanges;
    why.push(`Ethereum: ${fmtUsd(Math.abs(ex.netToExchanges24h))} net ${ex.netToExchanges24h < 0 ? "withdrawn from" : "sent to"} exchanges in 24h`);
  }
  const d = dex?.tracked ? dex.last24h : null;
  if (d && Math.abs(d.netUsd) >= p.dexFlow && d.wallets >= p.dexWallets) {
    parts.dex = Math.sign(d.netUsd) * 5; score += parts.dex;
    why.push(`DEX: ${fmtUsd(Math.abs(d.netUsd))} net ${d.netUsd > 0 ? "bought" : "sold"} by ${d.wallets} wallets in 24h`);
  }
  if (crowd?.state === "crowdShort" || crowd?.state === "crowdLong") {
    parts.crowd = crowd.state === "crowdShort" ? 10 : -10; score += parts.crowd;
    why.push(`Binance: ${crowd.label} (crowd ${crowd.acc}, top traders ${crowd.top})`);
  }
  score = Math.max(-100, Math.min(100, score));
  let call = "WATCH";
  const cutLongs = then && then.longSize > 0 && then.longUsd >= p.minNotional && (then.longUsd - then.shortUsd) / (then.longUsd + then.shortUsd) >= 0.3
    && net(c) < net(then) * (1 - p.leaveCut);
  if (score >= p.take && flowUsd > 0 && (c?.nLong || 0) >= p.takeWhales) call = "TAKE LONG";
  else if (score <= -p.take && flowUsd < 0 && (c?.nShort || 0) >= p.takeWhales) call = "TAKE SHORT";
  else if (cutLongs) { call = "LEAVE"; why.unshift(`whales cut ${Math.round((1 - net(c) / net(then)) * 100)}% of their net long in the last hour`); }
  else if (ex?.tracked && (ex.netToExchanges24h || 0) >= p.exLeave) { call = "LEAVE"; why.unshift(`${fmtUsd(ex.netToExchanges24h)} moved onto exchanges in 24h (often before selling)`); }
  return { score, call, why, parts, flowUsd: flowUsd == null ? null : Math.round(flowUsd) };
}
// Did a call go the right way? (LEAVE is right when the price fell)
export const rightWay = (call: string, pct: number | null): boolean | null => (pct == null ? null : call === "TAKE LONG" ? pct > 0 : pct < 0);

export function createWhaleSignals({ fetchJson, base = "https://api.hyperliquid.xyz", board = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
  stateFile = null, now = () => Date.now(), exchangeFlow = () => null, dexFlow = () => null, crowdOf = () => null, sendTelegram = null, wantTelegram = () => false,
  demo = false, p = RULE, everyMs = 2 * MIN }: WhaleSignalsOptions) {
  const st: ScanStatus = { status: demo ? "off" : "starting", error: demo ? "Whale signals use live Hyperliquid data only (not in demo mode)" : null, updatedAt: null, scanMs: null,
    whalesAt: null, read: 0, failed: 0 };
  let store: Store = { version: 1, whales: [], signals: [] }, snaps: { t: number; book: Map<string, WhaleMoney> }[] = [], coins: CoinRow[] = [],
    mids: Record<string, number> = {}, busy = false, loaded = false, timer: ReturnType<typeof setTimeout> | null = null, started = false;
  const save = () => (stateFile ? writeAtomic(stateFile, JSON.stringify({ ...store, snaps: snaps.slice(-40) })).catch(() => {}) : null);
  const info = (body: Record<string, unknown>) => fetchJson(base + "/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), retries: 1, timeoutMs: 15_000 });
  async function load() {
    if (loaded) return; loaded = true;
    try { const s = JSON.parse(await readFile(stateFile, "utf8")); if (s?.version === 1) { store = { version: 1, whales: s.whales || [], signals: s.signals || [], whalesAt: s.whalesAt }; snaps = (s.snaps || []).map((x) => ({ t: x.t, book: new Map(x.book) })); st.whalesAt = s.whalesAt || null; } } catch { /* first run */ }
  }
  // The whale list, from the leaderboard (about 40 MB), once every 6 hours.
  async function refreshWhales() {
    const j = await fetchJson(board, { retries: 1, timeoutMs: 90_000 });
    const list = pickWhales(j?.leaderboardRows || j, p);
    if (!list.length) throw new Error("the Hyperliquid leaderboard had no accounts that pass the filter");
    store.whales = list; store.whalesAt = st.whalesAt = now();
  }
  async function scan() {
    if (busy) return; busy = true;
    const t0 = now();
    try {
      await load();
      if (!store.whales.length || now() - (store.whalesAt || 0) > 6 * HOUR) await refreshWhales();
      mids = Object.fromEntries(Object.entries(await info({ type: "allMids" })).map(([k, v]) => [k, +v]));
      const positions: { address: string; list: Position[] }[] = []; let failed = 0;
      await pool(store.whales, 4, async (w) => {
        try {
          const s = await info({ type: "clearinghouseState", user: w.address });
          const list = (s?.assetPositions || []).map((a) => a.position).filter(Boolean)
            .map((x) => ({ coin: x.coin, size: +x.szi, px: +x.positionValue / Math.abs(+x.szi) || null, entry: +x.entryPx || null, lev: x.leverage?.value ?? null }));
          w.positions = list.length; w.notional = Math.round(list.reduce((a, x) => a + Math.abs(x.size) * (mids[x.coin] ?? x.px ?? 0), 0));
          positions.push({ address: w.address, list });
        } catch { failed++; }
      });
      if (failed > store.whales.length / 2) throw new Error(`Hyperliquid positions failed for ${failed}/${store.whales.length} whales`);
      const book = bookOf(positions, mids), t = now();
      snaps.push({ t, book: new Map([...book].map(([k, v]) => [k, { ...v, holders: undefined }])) });
      snaps = snaps.filter((s) => t - s.t <= 3 * HOUR);
      const then = snaps.filter((s) => t - s.t >= 50 * MIN).at(-1) || null; // the snapshot about an hour ago
      const fresh: Signal[] = [];
      coins = [...book.values()].map((c): CoinRow => {
        const { base } = binanceOf(c.coin), px = mids[c.coin];
        const j = judge({ now: c, then: then?.book.get(c.coin) || null, px, ex: exchangeFlow(base), dex: dexFlow(base), crowd: crowdOf(base) }, p);
        const row = { coin: c.coin, base, px, longUsd: Math.round(c.longUsd), shortUsd: Math.round(c.shortUsd), nLong: c.nLong, nShort: c.nShort, ...j,
          top: c.holders.sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)).slice(0, 5) };
        if (row.call !== "WATCH") {
          const prev = store.signals.find((s) => s.coin === c.coin && s.call === row.call);
          if (!prev || t - prev.t >= p.cooldownH * HOUR) {
            const s: Signal = { id: `ws-${c.coin}-${t}`, coin: c.coin, base, call: row.call, t, px, score: j.score, why: j.why, longUsd: row.longUsd, shortUsd: row.shortUsd, nLong: c.nLong, nShort: c.nShort, after: {} };
            store.signals.unshift(s); fresh.push(s);
          }
        }
        return row;
      }).sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || (b.longUsd + b.shortUsd) - (a.longUsd + a.shortUsd));
      follow();
      store.signals = store.signals.slice(0, 400);
      Object.assign(st, { status: "ok", error: null, updatedAt: t, scanMs: now() - t0, read: positions.length, failed, hourAgo: then ? then.t : null });
      await save();
      if (sendTelegram && wantTelegram("whalesig")) for (const s of fresh) sendTelegram(telegramText(s), "whalesig");
    } catch (e) {
      if (st.error !== e.message) console.log(`Whale signals: ${e.message}`);
      st.status = st.updatedAt ? "ok" : "error"; st.error = e.message;
    } finally { busy = false; }
  }
  // Each call's price 4h, 24h and 3 days later (Hyperliquid's price at the first scan after that time).
  function follow() {
    const t = now();
    for (const s of store.signals) for (const h of p.follow) {
      if (s.after[h] || t - s.t < h * HOUR || t - s.t > h * HOUR + 6 * HOUR) continue;
      const px = mids[s.coin]; if (!(px > 0) || !(s.px > 0)) continue;
      const pct = r2((px / s.px - 1) * 100, 2);
      s.after[h] = { px, pct, right: rightWay(s.call, pct) };
    }
  }
  function record() {
    const out: Record<string, Record<number, { n: number; rightPct?: number; avgPct?: number | null }>> = {};
    for (const call of ["TAKE LONG", "TAKE SHORT", "LEAVE"]) {
      out[call] = Object.fromEntries(p.follow.map((h) => {
        const done = store.signals.filter((s) => s.call === call && s.after[h]);
        const side = call === "TAKE LONG" ? 1 : -1;
        return [h, done.length ? { n: done.length, rightPct: Math.round((done.filter((s) => s.after[h].right).length / done.length) * 100),
          avgPct: r2(done.reduce((a, s) => a + side * s.after[h].pct, 0) / done.length, 2) } : { n: 0 }];
      }));
    }
    return out;
  }
  function telegramText(s: Signal) {
    const what = s.call === "TAKE LONG" ? "TAKE LONG: whales are buying" : s.call === "TAKE SHORT" ? "TAKE SHORT: whales are shorting" : "LEAVE: whales are selling (exit or do not buy)";
    return `WHALE SIGNAL ${s.base}: ${what}\nScore ${s.score > 0 ? "+" : ""}${s.score} (-100 to +100)\n${s.why.map((w) => "- " + w).join("\n")}\nPrice ${s.px}\n` +
      `New signal, not backtested: the live record on the Whales tab is its only test. Research signal only.`;
  }
  function schedule() { timer = setTimeout(() => { scan().finally(schedule); }, everyMs); timer.unref?.(); st.nextScanAt = now() + everyMs; }
  function start() { if (started || demo) return; started = true; scan().finally(schedule); }
  function stop() { clearTimeout(timer); started = false; }
  function api() {
    return { ...st, rule: p, whales: store.whales.length, whaleList: store.whales.slice(0, 25), coins: coins.slice(0, 80),
      signals: store.signals.slice(0, 80), record: record(), snapshots: snaps.length };
  }
  return { start, stop, scan, api, load };
}

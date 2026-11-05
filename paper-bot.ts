import { num, r2 } from "./util.ts";
// Paper trading bot (Perps tab): a pretend account (default $100) that takes every scalp signal and every Perps A+ TAKE
// trade (long or short) on its own, with each one's tested plan (scalp: the signal's stop and target, out after 1 hour;
// Perps A+: target 4x the risk, the stop, or 14 days, with real funding),
// sized from the account's risk, with a margin check at the chosen leverage and the same fees as the test. No money and
// no API key: it follows the signals' tracked results. Saved with the Scalp state, so it survives restarts.
//
// Real trading later: everything that touches an exchange goes through the broker (paperBroker below). A Binance broker
// would place the entry and the stop / take-profit orders there, with an API key that cannot withdraw, an IP whitelist,
// a daily loss limit and a kill switch; the rest of the bot stays the same. Research, not financial advice.
export const PAPER = Object.freeze({
  start: num("SCALP_PAPER_START", 100),         // starting balance in USDT
  riskPct: num("SCALP_PAPER_RISK_PCT", 1),       // % of the balance lost if the stop is hit
  leverage: num("SCALP_PAPER_LEVERAGE", 5),      // caps the position at balance x leverage (margin check)
  maxOpen: num("SCALP_PAPER_MAX_OPEN", 3),       // trades open at the same time, for each strategy (scalp, perps)
  minNotional: 5,                                // Binance futures' smallest order on most coins, in USDT
});
export interface PaperSettings { start: number; riskPct: number; leverage: number; maxOpen: number }
const LIMITS: Record<keyof PaperSettings, [lo: number, hi: number]> = { start: [10, 1e6], riskPct: [0.1, 5], leverage: [1, 20], maxOpen: [1, 10] };

// A signal the bot can take: a scalp signal, or a Perps A+ TAKE (strategy "perps"). entry = null until the entry candle
// has opened; status "closed" with its exit (and its own net % after fees and funding, when tracked).
export interface PaperSignal {
  id: string; strategy?: string; setup?: string | null; sym: string; base: string; side?: string; at: number;
  entry: number | null; stop: number; target: number | null; closeBy: number;
  status: string; why?: string | null; exit?: number | null; exitT?: number | null; netPct?: number | null; price?: number | null;
}
export interface Size { qty: number; notional: number; margin: number; riskUsd: number }
// A position size, or why there is none.
export type Sizing = (Size & { skip?: undefined }) | { skip: "bad levels" | "small"; qty?: undefined; notional?: undefined; margin?: undefined; riskUsd?: undefined };
export interface Position extends Size {
  id: string; strategy: string; setup: string | null; sym: string; base: string; side: string; entry: number; stop: number; target: number | null;
  closeBy: number; openedAt: number;
}
export interface ClosedTrade extends Position { exit: number; why: string; closedAt: number; pnl: number; pnlPctOfBalance: number; balanceAfter: number }
export interface Account extends PaperSettings {
  version: number; balance: number; peak: number; maxDrawdownPct: number; startedAt: number;
  open: Position[]; trades: ClosedTrade[]; seen: string[]; skipped: { busy: number; small: number };
}
export interface Broker {
  open: (acct: Account, sig: PaperSignal, size: Size, now: number) => Position;
  close: (acct: Account, pos: Position, exit: number, why: string, costPct: number, now: number, netPct?: number | null) => { exit: number; why: string; closedAt: number; pnl: number };
}

// A fresh account. opts: start, riskPct, leverage, maxOpen (each kept inside safe limits).
export function newAccount(opts: Partial<PaperSettings> = {}, now = Date.now()): Account {
  const set = {} as PaperSettings; // filled below: every LIMITS key
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) { const v = Number(opts[k] ?? PAPER[k]); set[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : PAPER[k]; }
  set.maxOpen = Math.round(set.maxOpen);
  return { version: 1, ...set, balance: set.start, peak: set.start, maxDrawdownPct: 0, startedAt: now, open: [], trades: [], seen: [], skipped: { busy: 0, small: 0 } };
}
// How big a trade: risk = balance x risk%; the quantity that loses exactly that at the stop, cut down if the margin
// (notional / leverage) would not fit in the free balance. { qty, notional, margin, riskUsd } or { skip }.
export function sizePosition(acct: Account, entry: number, stop: number, side = "long"): Sizing {
  const dist = side === "short" ? stop - entry : entry - stop;
  if (!(entry > 0) || !(dist > 0)) return { skip: "bad levels" };
  const used = acct.open.reduce((a, x) => a + x.margin, 0), free = Math.max(0, acct.balance - used);
  let qty = (acct.balance * acct.riskPct / 100) / dist, notional = qty * entry;
  if (notional > free * acct.leverage) { notional = free * acct.leverage; qty = notional / entry; }
  if (notional < PAPER.minNotional) return { skip: "small" };
  return { qty, notional, margin: notional / acct.leverage, riskUsd: qty * dist };
}
// The paper broker: fills at the given price. A live broker would send orders here instead.
// The result: the signal's own tracked net % when it has one (fees, and funding for perps, included), else from the prices.
export const paperBroker: Broker = {
  open: (acct, sig, size, now) => ({ id: sig.id, strategy: sig.strategy || "scalp", setup: sig.setup || null, sym: sig.sym, base: sig.base, side: sig.side || "long", entry: sig.entry, stop: sig.stop, target: sig.target,
    closeBy: sig.closeBy, qty: size.qty, notional: size.notional, margin: size.margin, riskUsd: size.riskUsd, openedAt: sig.at ?? now }),
  close: (acct, pos, exit, why, costPct, now, netPct = null) => ({ exit, why, closedAt: now,
    pnl: Number.isFinite(netPct) ? pos.notional * netPct / 100 : pos.notional * ((pos.side === "short" ? -1 : 1) * (exit / pos.entry - 1) - costPct / 100) }),
};
// One step after each scan: open the new signals, close the ones whose signal has closed. Mutates acct; returns what
// happened ({ opened, closed }) for messages.
export function stepBot(acct: Account, signals: PaperSignal[], { now = Date.now(), costPct = 0.12, broker = paperBroker }: { now?: number; costPct?: number; broker?: Broker } = {}) {
  const opened: Position[] = [], closed: ClosedTrade[] = [], seen = new Set(acct.seen);
  for (const s of [...signals].sort((a, b) => a.at - b.at)) {
    // a signal found in the first scan after a (re)start counts: its entry candle opened at most one candle earlier
    if (seen.has(s.id) || s.at < acct.startedAt - 6 * 60_000 || s.entry == null || s.why === "gap") continue;
    seen.add(s.id);
    if (acct.open.filter((x) => (x.strategy || "scalp") === (s.strategy || "scalp")).length >= acct.maxOpen) { acct.skipped.busy++; continue; }
    const size = sizePosition(acct, s.entry, s.stop, s.side);
    if (size.skip) { acct.skipped.small++; continue; }
    const pos = broker.open(acct, s, size as Size, now); // not skipped: a full size
    acct.open.push(pos); opened.push(pos);
  }
  for (const pos of [...acct.open]) {
    const s = signals.find((x) => x.id === pos.id);
    if (!s || s.status !== "closed") continue;
    const exit = s.exit > 0 ? s.exit : pos.entry; // "no data": out at the entry price
    const r = broker.close(acct, pos, exit, s.why, costPct, s.exitT ?? now, s.netPct);
    const before = acct.balance;
    acct.balance += r.pnl;
    acct.peak = Math.max(acct.peak, acct.balance);
    acct.maxDrawdownPct = Math.max(acct.maxDrawdownPct, (1 - acct.balance / acct.peak) * 100);
    acct.open = acct.open.filter((x) => x.id !== pos.id);
    const t = { ...pos, exit: r.exit, why: r.why, closedAt: r.closedAt, pnl: r2(r.pnl, 4), pnlPctOfBalance: r2((r.pnl / before) * 100, 2), balanceAfter: r2(acct.balance, 4) };
    acct.trades.unshift(t); closed.push(t);
  }
  acct.trades = acct.trades.slice(0, 500);
  acct.seen = [...seen].slice(-1000);
  return { opened, closed };
}
// What the page shows: balance, equity with open trades at the live price, results.
export function accountView(acct: Account | null, priceOf: (sym: string) => number | null = () => null) {
  if (!acct) return null;
  const open = acct.open.map((x) => { const px = priceOf(x.sym); return { ...x, price: px, uPnl: px ? r2((x.side === "short" ? -1 : 1) * x.qty * (px - x.entry), 4) : null }; });
  const equity = acct.balance + open.reduce((a, x) => a + (x.uPnl || 0), 0), t = acct.trades;
  const wins = t.filter((x) => x.pnl > 0).length;
  return { start: acct.start, riskPct: acct.riskPct, leverage: acct.leverage, maxOpen: acct.maxOpen, startedAt: acct.startedAt,
    balance: r2(acct.balance, 2), equity: r2(equity, 2), returnPct: r2((acct.balance / acct.start - 1) * 100, 2), maxDrawdownPct: r2(acct.maxDrawdownPct, 2),
    trades: t.length, wins, winPct: t.length ? Math.round((wins / t.length) * 100) : null, targets: t.filter((x) => x.why === "target").length, stops: t.filter((x) => x.why === "stop").length,
    totalPnl: r2(acct.balance - acct.start, 2), skipped: acct.skipped, open, closed: t.slice(0, 40),
    byStrategy: Object.fromEntries(["scalp", "perps"].map((k) => { const s = t.filter((x) => (x.strategy || "scalp") === k); return [k, { trades: s.length, pnl: r2(s.reduce((a, x) => a + x.pnl, 0), 2), wins: s.filter((x) => x.pnl > 0).length }]; })) };
}
export const paperLimits = LIMITS;

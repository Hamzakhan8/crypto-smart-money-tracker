// Paper trading bot for the Scalp signals (Perps tab): a pretend account (default $100) that takes every scalp signal
// on its own, with the tested plan (entry at the next candle's open, the signal's stop and target, out after 1 hour),
// sized from the account's risk, with a margin check at the chosen leverage and the same fees as the test. No money and
// no API key: it follows the signals' tracked results. Saved with the Scalp state, so it survives restarts.
//
// Real trading later: everything that touches an exchange goes through the broker (paperBroker below). A Binance broker
// would place the entry and the stop / take-profit orders there, with an API key that cannot withdraw, an IP whitelist,
// a daily loss limit and a kill switch; the rest of the bot stays the same. Research, not financial advice.
const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
export const PAPER = Object.freeze({
  start: num("SCALP_PAPER_START", 100),         // starting balance in USDT
  riskPct: num("SCALP_PAPER_RISK_PCT", 1),       // % of the balance lost if the stop is hit
  leverage: num("SCALP_PAPER_LEVERAGE", 5),      // caps the position at balance x leverage (margin check)
  maxOpen: num("SCALP_PAPER_MAX_OPEN", 3),       // trades open at the same time
  minNotional: 5,                                // Binance futures' smallest order on most coins, in USDT
});
const LIMITS = { start: [10, 1e6], riskPct: [0.1, 5], leverage: [1, 20], maxOpen: [1, 10] };
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

// A fresh account. opts: start, riskPct, leverage, maxOpen (each kept inside safe limits).
export function newAccount(opts = {}, now = Date.now()) {
  const set = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) { const v = Number(opts[k] ?? PAPER[k]); set[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : PAPER[k]; }
  set.maxOpen = Math.round(set.maxOpen);
  return { version: 1, ...set, balance: set.start, peak: set.start, maxDrawdownPct: 0, startedAt: now, open: [], trades: [], seen: [], skipped: { busy: 0, small: 0 } };
}
// How big a trade: risk = balance x risk%; the quantity that loses exactly that at the stop, cut down if the margin
// (notional / leverage) would not fit in the free balance. { qty, notional, margin, riskUsd } or { skip }.
export function sizePosition(acct, entry, stop) {
  const dist = entry - stop;
  if (!(entry > 0) || !(dist > 0)) return { skip: "bad levels" };
  const used = acct.open.reduce((a, x) => a + x.margin, 0), free = Math.max(0, acct.balance - used);
  let qty = (acct.balance * acct.riskPct / 100) / dist, notional = qty * entry;
  if (notional > free * acct.leverage) { notional = free * acct.leverage; qty = notional / entry; }
  if (notional < PAPER.minNotional) return { skip: "small" };
  return { qty, notional, margin: notional / acct.leverage, riskUsd: qty * dist };
}
// The paper broker: fills at the given price. A live broker would send orders here instead.
export const paperBroker = {
  open: (acct, sig, size, now) => ({ id: sig.id, sym: sig.sym, base: sig.base, side: "long", entry: sig.entry, stop: sig.stop, target: sig.target, closeBy: sig.closeBy,
    qty: size.qty, notional: size.notional, margin: size.margin, riskUsd: size.riskUsd, openedAt: sig.at ?? now }),
  close: (acct, pos, exit, why, costPct, now) => ({ pnl: pos.notional * (exit / pos.entry - 1) - pos.notional * costPct / 100, exit, why, closedAt: now }),
};
// One step after each scan: open the new signals, close the ones whose signal has closed. Mutates acct; returns what
// happened ({ opened, closed }) for messages.
export function stepBot(acct, signals, { now = Date.now(), costPct = 0.12, broker = paperBroker } = {}) {
  const opened = [], closed = [], seen = new Set(acct.seen);
  for (const s of [...signals].sort((a, b) => a.at - b.at)) {
    // a signal found in the first scan after a (re)start counts: its entry candle opened at most one candle earlier
    if (seen.has(s.id) || s.at < acct.startedAt - 6 * 60_000 || s.entry == null || s.why === "gap") continue;
    seen.add(s.id);
    if (acct.open.length >= acct.maxOpen) { acct.skipped.busy++; continue; }
    const size = sizePosition(acct, s.entry, s.stop);
    if (size.skip) { acct.skipped.small++; continue; }
    const pos = broker.open(acct, s, size, now);
    acct.open.push(pos); opened.push(pos);
  }
  for (const pos of [...acct.open]) {
    const s = signals.find((x) => x.id === pos.id);
    if (!s || s.status !== "closed") continue;
    const exit = s.exit > 0 ? s.exit : pos.entry; // "no data": out at the entry price
    const r = broker.close(acct, pos, exit, s.why, costPct, s.exitT ?? now);
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
export function accountView(acct, priceOf = () => null) {
  if (!acct) return null;
  const open = acct.open.map((x) => { const px = priceOf(x.sym); return { ...x, price: px, uPnl: px ? r2(x.qty * (px - x.entry), 4) : null }; });
  const equity = acct.balance + open.reduce((a, x) => a + (x.uPnl || 0), 0), t = acct.trades;
  const wins = t.filter((x) => x.pnl > 0).length;
  return { start: acct.start, riskPct: acct.riskPct, leverage: acct.leverage, maxOpen: acct.maxOpen, startedAt: acct.startedAt,
    balance: r2(acct.balance, 2), equity: r2(equity, 2), returnPct: r2((acct.balance / acct.start - 1) * 100, 2), maxDrawdownPct: r2(acct.maxDrawdownPct, 2),
    trades: t.length, wins, winPct: t.length ? Math.round((wins / t.length) * 100) : null, targets: t.filter((x) => x.why === "target").length, stops: t.filter((x) => x.why === "stop").length,
    totalPnl: r2(acct.balance - acct.start, 2), skipped: acct.skipped, open, closed: t.slice(0, 40) };
}
export const paperLimits = LIMITS;

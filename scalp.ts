// Scalp (a section of the Perps tab): 5-minute "flush bounce" longs on the 50 most liquid Binance USDⓈ-M perpetuals. Signals only: the app
// finds the setup on each closed 5-minute candle and tells you entry, stop and target; you place the trade.
//
// The setup (tested by scalp-backtest.ts with this same code, on every 5-minute candle of the top-50 perps since
// July 2024, after 0.12% fees per trade):
//   1. a flush: one 5-minute candle falls 2.5x+ the coin's normal 5-minute range (ATR), on 4x+ its normal volume
//      (forced selling, often liquidations),
//   2. the next candle closes green and above the middle of the flush candle (buyers stepped back in),
//   3. on a volatile coin: its normal 5-minute range is 0.6%+ of the price (on calm coins the bounce is too small
//      to beat the fees).
// Trade: buy at the next candle's open, stop just under the flush low, target 1.5x the risk, else sell after 1 hour.
// Six other common scalp setups were tested the same way and lost money after fees (see the README); so did the
// short version of this one (selling a spike up). Research signals, not financial advice.
import { readFile } from "node:fs/promises";
import { EXCLUDED, weekendShare } from "./perps-history.ts";
import type { FetchJson, FuturesSymbol, Ticker24h } from "./perps-history.ts";
import { newAccount, stepBot, accountView } from "./paper-bot.ts";
import type { Account, ClosedTrade, PaperSettings, PaperSignal } from "./paper-bot.ts";
import type { Candle } from "./perps.ts";
import { fmtPx, num, pool, r2, writeAtomic } from "./util.ts";

const M5 = 300_000, MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export interface ScalpRule {
  minDropAtr: number; minVolRatio: number; minAtrPct: number; targetR: number; holdCandles: number; stopPadAtr: number; costPct: number; top: number;
}
export const SCALP: Readonly<ScalpRule> = Object.freeze({
  minDropAtr: num("SCALP_MIN_DROP_ATR", 2.5),     // flush candle: open minus close, in ATRs of the candles before it
  minVolRatio: num("SCALP_MIN_VOLUME_RATIO", 4),  // flush candle volume vs the average of the 20 before it
  minAtrPct: num("SCALP_MIN_ATR_PCT", 0.6),       // the coin's 5-minute ATR as % of the price (volatile coins only)
  targetR: 1.5, holdCandles: 12, stopPadAtr: 0.1, // the tested exit: 1.5x the risk, else after 12 candles (1 hour)
  costPct: num("SCALP_COST_PCT", 0.12),           // fees + slippage per trade, in and out (taker 0.05% per side)
  top: 50,
});

// bars: [{ t, o, h, l, c, qv }] oldest first, closed candles. ATR (Wilder, 14) and volume vs the 20 candles before.
export interface ScalpSeries { bars: Candle[]; atr: Float64Array; vr: Float64Array }
export function scalpSeries(bars: Candle[]): ScalpSeries {
  const n = bars.length, atr = new Float64Array(n), vr = new Float64Array(n);
  let vs = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)) : b.h - b.l;
    atr[i] = i < 14 ? (i ? (atr[i - 1] * i + tr) / (i + 1) : tr) : (atr[i - 1] * 13 + tr) / 14;
    vr[i] = i >= 20 && vs > 0 ? b.qv / (vs / 20) : 0;
    vs += b.qv; if (i >= 20) vs -= bars[i - 20].qv;
  }
  return { bars, atr, vr };
}
// The setup on candle i (the green candle after the flush candle i-1). null = no signal.
export function flushBounce(x: ScalpSeries, i: number, p: ScalpRule = SCALP) {
  if (i < 22 || i >= x.bars.length) return null;
  const f = x.bars[i - 1], b = x.bars[i], pa = x.atr[i - 2];
  if (!(pa > 0)) return null;
  const dropAtr = (f.o - f.c) / pa, atrPct = (pa / x.bars[i - 2].c) * 100;
  if (!(dropAtr >= p.minDropAtr) || !(x.vr[i - 1] >= p.minVolRatio) || !(atrPct >= p.minAtrPct)) return null;
  if (!(b.c > b.o) || !(b.c > (f.o + f.c) / 2)) return null;
  return { t: b.t, close: b.c, stop: Math.min(f.l, b.l) - p.stopPadAtr * x.atr[i], flushPct: (f.c / f.o - 1) * 100, flushLowPct: (f.l / f.o - 1) * 100,
    dropAtr, volRatio: x.vr[i - 1], atrPct, bouncePct: (b.c / f.l - 1) * 100 };
}
// The tested exit from the signal on candle i: buy at the open of candle i+1, stop first when a candle touches both.
// done = false while the hour is not over (live).
export interface ScalpResult {
  done: boolean; why: string; entry: number | null; stop?: number; target?: number; exit?: number; pct?: number; netPct?: number; candles?: number;
  exitT?: number; peakPct?: number; lowPct?: number;
}
export function scalpTrade(x: ScalpSeries, i: number, stop: number, p: ScalpRule = SCALP): ScalpResult {
  const B = x.bars, n = B.length;
  if (i + 1 >= n) return { done: false, why: "waiting", entry: null };
  const e = B[i + 1].o, risk = e - stop;
  if (!(risk > 0)) return { done: true, why: "gap", entry: e, pct: 0, netPct: 0, candles: 0 }; // opened under the stop: no trade
  const target = e + p.targetR * risk, last = Math.min(i + p.holdCandles, n - 1);
  let peak = e, low = e;
  const out = (why: string, px: number, j: number): ScalpResult => ({ done: true, why, entry: e, stop, target, exit: px, pct: (px / e - 1) * 100, netPct: (px / e - 1) * 100 - p.costPct, candles: j - i,
    exitT: B[j].t + M5, peakPct: (peak / e - 1) * 100, lowPct: (low / e - 1) * 100 });
  for (let j = i + 1; j <= last; j++) {
    peak = Math.max(peak, B[j].h); low = Math.min(low, B[j].l);
    if (B[j].l <= stop) return out("stop", stop, j);
    if (B[j].h >= target) return out("target", target, j);
  }
  if (last === i + p.holdCandles) return out("time", B[last].c, last);
  return { done: false, why: "open", entry: e, stop, target, candles: last - i, peakPct: (peak / e - 1) * 100, lowPct: (low / e - 1) * 100 };
}

const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

export interface ScalpOptions {
  fetchJson: FetchJson;
  base?: string;                 // Binance futures API
  stateFile?: string | null;     // signals and the paper bot, kept across restarts
  reportFile?: string | null;    // your own scalp-backtest report (scalp_report.json)
  bundledReport?: string | null; // the copy shipped in data/
  sendTelegram?: ((text: string, kind: string) => unknown) | null;
  wantTelegram?: (kind: string) => boolean;
  now?: () => number;
  demo?: boolean;
  p?: ScalpRule;
  delayMs?: number;              // after each 5-minute close
  extraSignals?: () => PaperSignal[]; // more trades for the paper bot (the Perps A+ TAKE signals)
}
// A scalp signal, followed with the tested exit (and taken by the paper bot)
interface ScalpSignal extends PaperSignal {
  t: number; ref: number; riskPct: number | null; flushPct: number | null; flushLowPct: number | null; dropAtr: number | null; volRatio: number | null;
  atrPct: number | null; price: number; oiChg15?: number | null; liquidations?: boolean; pct?: number | null; candles?: number; peakPct?: number | null; lowPct?: number | null;
}
// One coin of the table: its 5-minute range, the last hour, and the biggest drop of the last 2 hours
interface ScalpCoin {
  sym: string; base: string; price: number; atrPct: number | null; volatile: boolean; change1h: number | null;
  bigDrop: { dropAtr: number | null; volRatio: number | null; pct: number | null; t: number } | null;
}
// Half a setup: a flush on the last closed candle, waiting for the next one
interface Watch { sym: string; base: string; t: number; flushPct: number | null; dropAtr: number | null; volRatio: number | null; bounceAbove: number; decidedAt: number }
// scalp_report.json (scalp-backtest), passed on to the page
interface ScalpReport {
  own: boolean; generatedAt: string; from: string; to: string; split: string; coins: number; all: unknown; older: unknown; newer: unknown;
  late: unknown; worse: unknown; calm: unknown; short: unknown; months: unknown[]; recent?: unknown[];
}

// The live tab. fetchJson from the screener; base = Binance futures API.
export function createScalp({ fetchJson, base = "https://fapi.binance.com", stateFile = null, reportFile = null, bundledReport = null, sendTelegram = null,
  wantTelegram = () => false, now = () => Date.now(), demo = false, p = SCALP, delayMs = 4_000, extraSignals = () => [] }: ScalpOptions) {
  base = base.replace(/\/$/, "");
  const st: {
    status: string; error: string | null; updatedAt: number | null; scanMs: number | null; universeAt: number | null; coins: ScalpCoin[]; lastCandle: number | null;
    watching?: Watch[]; nextScanAt?: number;
  } = { status: demo ? "off" : "starting", error: demo ? "Scalp signals use live Binance futures data only (not in demo mode)" : null,
    updatedAt: null, scanMs: null, universeAt: null, coins: [], lastCandle: null };
  let store: { version: number; signals: ScalpSignal[]; paper?: Account } = { version: 1, signals: [] }, report: ScalpReport | null = null, universe: string[] = [],
    busy = false, started = false, loaded = false, timer: ReturnType<typeof setTimeout> | null = null;
  const lastSig = new Map<string, number>(); // sym -> candle time of its last signal (one per coin per hour)
  const save = () => (stateFile ? writeAtomic(stateFile, JSON.stringify(store)).catch(() => {}) : null);
  const get = (path: string) => fetchJson(base + path, { retries: 1, timeoutMs: 15_000 });
  const klines = async (sym: string, interval: string, limit: number): Promise<Candle[]> => (await get(`/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`))
    .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[7] }));
  async function load() {
    if (loaded) return; loaded = true;
    try { const s = JSON.parse(await readFile(stateFile, "utf8")); if (s?.version === 1) store = s; } catch { /* first run */ }
    for (const x of store.signals) lastSig.set(x.sym, Math.max(lastSig.get(x.sym) || 0, x.t));
    if (!store.paper) store.paper = newAccount({}, now()); // the paper bot starts with the first run (default $100)
    for (const [file, own] of [[reportFile, true], [bundledReport, false]] as const) {
      if (!file) continue;
      try { report = { ...JSON.parse(await readFile(file, "utf8")), own }; break; } catch { /* next */ }
    }
  }
  // The 50 most liquid USDT perpetuals by 30-day volume (as in the backtest), without stablecoins and perpetuals on
  // stocks, ETFs or commodities. Refreshed every 6 hours.
  async function refreshUniverse() {
    const [info, tick]: [{ symbols?: FuturesSymbol[] }, Ticker24h[]] = await Promise.all([get("/fapi/v1/exchangeInfo"), get("/fapi/v1/ticker/24hr")]);
    const ok = new Set<string>();
    for (const x of info.symbols || []) {
      if (x.contractType !== "PERPETUAL" || x.quoteAsset !== "USDT" || x.status !== "TRADING" || EXCLUDED.has(x.baseAsset)) continue;
      if ((x.underlyingType && x.underlyingType !== "COIN") || (x.underlyingSubType || []).some((t) => /tradfi|stock|equit|commodit|metal|etf/i.test(t))) continue;
      ok.add(x.symbol);
    }
    const cands = (tick || []).filter((x) => ok.has(x.symbol)).sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, p.top + 25);
    const vol: [string, number][] = [];
    await pool(cands, 6, async (c) => {
      try {
        const d = (await klines(c.symbol, "1d", 31)).filter((x) => x.t + DAY <= now());
        if (d.length >= 25 && !(weekendShare(d.map((x) => [x.t, x.o, x.h, x.l, x.c, x.qv])) < 0.35)) vol.push([c.symbol, d.reduce((a, x) => a + x.qv, 0)]);
      } catch { /* skipped this time */ }
    });
    if (!vol.length) throw new Error("No futures coins loaded");
    universe = vol.sort((a, b) => b[1] - a[1]).slice(0, p.top).map((x) => x[0]);
    st.universeAt = now();
  }
  // Every 5 minutes, a few seconds after the candle closes: look for the setup and follow the open signals.
  async function scan() {
    if (busy) return; busy = true;
    const t0 = now();
    try {
      await load();
      if (!universe.length || now() - (st.universeAt || 0) > 6 * HOUR) await refreshUniverse();
      const open = store.signals.filter((x) => x.status === "open");
      const syms = [...new Set([...universe, ...open.map((x) => x.sym)])], coins: ScalpCoin[] = [], fresh: ScalpSignal[] = [], watching: Watch[] = [];
      let failed = 0;
      await pool(syms, 8, async (sym) => {
        let raw: Candle[];
        try { raw = await klines(sym, "5m", 150); } catch { failed++; return; }
        const bars = raw.filter((b) => b.t + M5 <= now()); // closed candles only
        if (bars.length < 40) return;
        const x = scalpSeries(bars), last = bars.length - 1, price = raw[raw.length - 1].c;
        for (const s of open.filter((y) => y.sym === sym)) follow(s, x, price);
        if (!universe.includes(sym)) return;
        const a = x.atr[last - 1], atrPct = a > 0 ? (a / bars[last - 1].c) * 100 : null;
        // the biggest down candle of the last 2 hours, in the rule's terms: shows the scan is alive and how close a coin came
        let big: ScalpCoin["bigDrop"] = null;
        for (let j = Math.max(22, last - 23); j <= last; j++) {
          const b = bars[j], pa = x.atr[j - 1], d = pa > 0 ? (b.o - b.c) / pa : 0;
          if (d > 0 && (!big || d > big.dropAtr)) big = { dropAtr: r2(d, 1), volRatio: r2(x.vr[j], 1), pct: r2((b.c / b.o - 1) * 100, 2), t: b.t };
        }
        coins.push({ sym, base: sym.replace(/USDT$/, ""), price, atrPct: r2(atrPct, 2), volatile: atrPct >= p.minAtrPct, change1h: r2((bars[last].c / bars[last - 12].c - 1) * 100, 2), bigDrop: big });
        // half a setup: the last closed candle is a flush (the same tests as flushBounce); the next candle decides
        { const f = bars[last], pa = x.atr[last - 1], d = pa > 0 ? (f.o - f.c) / pa : 0;
          if (d >= p.minDropAtr && x.vr[last] >= p.minVolRatio && pa / bars[last - 1].c * 100 >= p.minAtrPct)
            watching.push({ sym, base: sym.replace(/USDT$/, ""), t: f.t, flushPct: r2((f.c / f.o - 1) * 100, 2), dropAtr: r2(d, 1), volRatio: r2(x.vr[last], 1), bounceAbove: (f.o + f.c) / 2, decidedAt: f.t + 2 * M5 }); }
        for (const i of [last - 1, last]) { // the last two closed candles, in case a scan was missed
          const sig = flushBounce(x, i, p);
          if (!sig || sig.t <= (lastSig.get(sym) || 0) + (p.holdCandles - 1) * M5) continue;
          lastSig.set(sym, sig.t);
          const s: ScalpSignal = { id: `scalp-${sym}-${sig.t}`, sym, base: sym.replace(/USDT$/, ""), t: sig.t, at: sig.t + M5, ref: sig.close, stop: sig.stop,
            target: sig.close + p.targetR * (sig.close - sig.stop), riskPct: r2((1 - sig.stop / sig.close) * 100, 2), closeBy: sig.t + M5 + p.holdCandles * M5,
            flushPct: r2(sig.flushPct, 2), flushLowPct: r2(sig.flushLowPct, 2), dropAtr: r2(sig.dropAtr, 1), volRatio: r2(sig.volRatio, 1), atrPct: r2(sig.atrPct, 2),
            status: "open", entry: null, price };
          store.signals.unshift(s); fresh.push(s);
          follow(s, x, price);
          // liquidations: open interest over the 15 minutes up to the flush's close (from Binance's 5-minute history).
          // In the test, flushes where it fell 2%+ bounced a little better in both periods (small samples): a label only.
          try {
            const oi: [number, number][] = (await get(`/futures/data/openInterestHist?symbol=${sym}&period=5m&limit=12`)).map((r) => [+r.timestamp, +r.sumOpenInterest]).filter((r) => r[1] > 0);
            const tf = sig.t - M5, at = (t: number): number | null => { let b: [number, number] | null = null; for (const r of oi) if (r[0] <= t && (!b || r[0] > b[0])) b = r; return b && t - b[0] <= 10 * MIN ? b[1] : null; };
            const a0 = at(tf - 2 * M5), a1 = at(tf + M5);
            if (a0 && a1) { s.oiChg15 = r2((a1 / a0 - 1) * 100, 2); s.liquidations = s.oiChg15 <= -2; }
          } catch { /* no open-interest history: no label */ }
        }
      });
      if (syms.length && failed > syms.length / 2) { // most coins failed: still send what was found (its cooldown would hide it on the next scan)
        if (fresh.length) { await save(); if (sendTelegram && wantTelegram("scalp")) for (const s of fresh.filter((y) => y.status === "open")) sendTelegram(telegramText(s), "scalp"); }
        throw new Error(`5-minute candles failed for ${failed}/${syms.length} coins`);
      }
      store.signals = store.signals.slice(0, 500);
      let extra: PaperSignal[] = []; try { extra = extraSignals() || []; } catch { /* the swing side is not ready */ }
      const bot = stepBot(store.paper, [...store.signals, ...extra], { now: now(), costPct: p.costPct }); // the paper bot takes and closes trades (scalp + Perps A+)
      st.coins = coins.sort((a, b) => (b.atrPct ?? 0) - (a.atrPct ?? 0));
      st.watching = watching;
      Object.assign(st, { status: "ok", error: null, updatedAt: now(), scanMs: now() - t0, lastCandle: Math.floor(now() / M5) * M5 - M5 });
      await save();
      if (sendTelegram && wantTelegram("scalp")) for (const s of fresh.filter((y) => y.status === "open")) sendTelegram(telegramText(s), "scalp");
      if (sendTelegram && wantTelegram("scalpBot")) for (const t of bot.closed) sendTelegram(botText(t), "scalpBot");
    } catch (e) {
      if (st.error !== e.message) console.log(`Perps scalp: scan failed: ${e.message}${/451|403/.test(e.message) ? " (Binance futures is blocked on this connection)" : ""}`); // once per new error
      st.status = st.updatedAt ? "ok" : "error"; st.error = e.message;
    } finally { busy = false; }
  }
  // Follow a signal with the tested exit on the candles just read.
  function follow(s: ScalpSignal, x: ScalpSeries, price: number) {
    const i = x.bars.findIndex((b) => b.t === s.t);
    s.price = price;
    if (i < 0) { if (now() - s.at > 3 * HOUR) Object.assign(s, { status: "closed", why: "no data", netPct: null }); return; }
    const r = scalpTrade(x, i, s.stop, p);
    if (r.entry != null) Object.assign(s, { entry: r.entry, target: r.target ?? s.target, peakPct: r2(r.peakPct, 2), lowPct: r2(r.lowPct, 2) });
    if (r.done) Object.assign(s, { status: "closed", why: r.why, exit: r.exit ?? null, pct: r2(r.pct, 2), netPct: r2(r.netPct, 2), candles: r.candles, exitT: r.exitT ?? null });
  }
  function telegramText(s: ScalpSignal): string {
    return `SCALP: LONG (BUY) ${s.sym} (flush bounce, 5m)\nBuy now near ${fmtPx(s.ref)}\nStop ${fmtPx(s.stop)} (-${s.riskPct}%)\nTarget ${fmtPx(s.target)} (+${r2(s.riskPct * p.targetR, 2)}%)\n` +
      `Close by ${hhmm(s.closeBy)} UTC if neither is hit (1 hour)\n${s.liquidations ? `Liquidations confirmed: open interest fell ${Math.abs(s.oiChg15)}% in 15 minutes (these bounced a little better in the test).\n` : ""}Why: one 5m candle fell ${Math.abs(s.flushPct)}% (${s.dropAtr}x its normal range) on ${s.volRatio}x volume, then the next closed back above its middle.\n` +
      `Size from your risk: with a ${s.riskPct}% stop, risking 1% of the account = a position of about ${Math.round(100 / s.riskPct)}% of the account. Research signal only.`;
  }
  function botText(t: ClosedTrade): string {
    const a = store.paper, why = t.why === "target" ? "hit the target" : t.why === "stop" ? "hit the stop" : t.why === "time" ? (t.strategy === "perps" ? "time limit" : "closed after 1 hour") : t.why;
    return `PAPER BOT (${t.strategy === "perps" ? "Perps A+" : "Scalp"}): closed ${t.base} ${String(t.side || "long").toUpperCase()}: ${t.pnl >= 0 ? "+" : "-"}$${Math.abs(t.pnl).toFixed(2)} (${t.pnlPctOfBalance >= 0 ? "+" : ""}${t.pnlPctOfBalance}% of the balance), ${why}.\n` +
      `Balance $${a.balance.toFixed(2)} (${a.balance >= a.start ? "+" : ""}${((a.balance / a.start - 1) * 100).toFixed(1)}% since the $${a.start} start, ${a.trades.length} trades). Paper money only.`;
  }
  // The live price of a coin: from the last scan, else from its latest signal.
  const priceOf = (sym: string): number | null => st.coins.find((c) => c.sym === sym)?.price ?? store.signals.find((x) => x.sym === sym)?.price ?? (() => { try { return extraSignals().find((x) => x.sym === sym)?.price ?? null; } catch { return null; } })();
  async function resetPaper(opts: Partial<PaperSettings> = {}) { await load(); store.paper = newAccount(opts, now()); await save(); return accountView(store.paper, priceOf); }
  function record() {
    const done = store.signals.filter((x) => x.status === "closed" && x.netPct != null && x.why !== "gap");
    if (!done.length) return { n: 0 };
    return { n: done.length, avgPct: r2(done.reduce((a, x) => a + x.netPct, 0) / done.length, 2), winPct: r2((done.filter((x) => x.netPct > 0).length / done.length) * 100, 0),
      targets: done.filter((x) => x.why === "target").length, stops: done.filter((x) => x.why === "stop").length, timeouts: done.filter((x) => x.why === "time").length,
      totalPct: r2(done.reduce((a, x) => a + x.netPct, 0), 1) };
  }
  function schedule() {
    const next = Math.floor(now() / M5) * M5 + M5 + delayMs;
    st.nextScanAt = next;
    timer = setTimeout(() => { scan().finally(schedule); }, Math.max(1000, next - now()));
  }
  function start() { if (started || demo) return; started = true; scan().finally(schedule); }
  function stop() { clearTimeout(timer); started = false; }
  function api() {
    return { ...st, rule: p, signals: store.signals.slice(0, 60), open: store.signals.filter((x) => x.status === "open").length, record: record(),
      report: report ? { own: report.own, generatedAt: report.generatedAt, from: report.from, to: report.to, coins: report.coins, all: report.all, older: report.older, newer: report.newer,
        late: report.late, worse: report.worse, calm: report.calm, short: report.short, months: report.months, split: report.split, recent: (report.recent || []).slice(0, 12) } : null,
      paper: accountView(store.paper, priceOf) };
  }
  return { start, stop, scan, api, load, resetPaper, signalById: (id: string) => store.signals.find((x) => x.id === id) || null, priceOf: (sym: string) => store.signals.find((x) => x.sym === sym)?.price ?? null };
}

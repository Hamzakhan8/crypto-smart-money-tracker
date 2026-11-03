// On-chain tab: "crowd vs smart money" positioning on the 50 most liquid Binance USDⓈ-M perpetuals.
//
// The idea comes from @ArslanOnChain's posts. His one worked example: on Binance, retail accounts were heavily short
// (long/short account ratio 0.397) while the top traders were long (top-trader position ratio 1.31). "The crowd is
// shorting the exact move that hurts them." He has not published a full method, so the rules here are that idea,
// turned into exact numbers and tested on 4.8 years of Binance's own archive (onchain-backtest.js):
//   crowd  = Binance's global long/short ACCOUNT ratio (all accounts with a position: above 1 = more accounts long)
//   smart  = Binance's TOP-TRADER long/short POSITION ratio (the top 20% of accounts by margin: above 1 = net long)
// Every setup is followed with the tested exit and its result is kept, so the page shows how the rule really does.
// Signals only: the app never places orders. Research, not financial advice.
import { readFile, writeFile, rename } from "node:fs/promises";
import { EXCLUDED, weekendShare } from "./perps-history.js";

const H4 = 14_400_000, HOUR = 3_600_000, DAY = 86_400_000;
const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
export const CROWD = Object.freeze({
  top: num("ONCHAIN_TOP", 50),                    // most liquid perpetuals (30-day volume), as in the test
  // LONG, his example (crowd 0.397, top traders 1.31): the crowd heavily short while the top traders are long
  crowdShortMax: num("ONCHAIN_CROWD_SHORT", 0.5), // crowd short: global account long/short ratio at or under this
  smartLongMin: num("ONCHAIN_SMART_LONG", 1.2),   // smart money long: top-trader position ratio at or over this
  // SHORT, the mirror: the crowd's account ratio in the top 10% of its own last 30 days, top traders not long, lower highs
  crowdLongPct: num("ONCHAIN_CROWD_LONG_PCT", 90), // percentile of the coin's own 30-day account ratio history
  smartShortMax: num("ONCHAIN_SMART_SHORT", 1),    // smart money not long: top-trader position ratio at or under this
  stopAtr: 2, targetAtr: null, holdBars: 18,      // the tested exit: stop 2x the 4h ATR, no target, close after 3 days
  cooldownBars: 18,                               // one signal per coin and side every 3 days
  costPct: num("ONCHAIN_COST_PCT", 0.16),         // fees + slippage, in and out
  sides: String(env.ONCHAIN_SIDES || "long,short").split(",").map((s) => s.trim()).filter(Boolean), // which setups are signals
});
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const fmtPx = (v) => (!(v > 0) ? "—" : v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));

// ATR (simple, 14) at bar i. bars: [{ t, o, h, l, c }] oldest first.
export function atrAt(bars, i, n = 14) {
  if (i < n) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
  return s / n;
}
// Price structure over the last 24 hours: higher lows (the last 6 bars' low above the 6 before) / lower highs.
export function structure(bars, i) {
  if (i < 11) return { higherLows: null, lowerHighs: null };
  let l1 = Infinity, l0 = Infinity, h1 = -Infinity, h0 = -Infinity;
  for (let j = i - 5; j <= i; j++) { l1 = Math.min(l1, bars[j].l); h1 = Math.max(h1, bars[j].h); }
  for (let j = i - 11; j <= i - 6; j++) { l0 = Math.min(l0, bars[j].l); h0 = Math.max(h0, bars[j].h); }
  return { higherLows: l1 > l0, lowerHighs: h1 < h0 };
}
// Where the crowd and the top traders stand. x = { acc, top, accPct }: the two ratios at the close of the bar, and
// accPct = where the account ratio sits in the coin's own last 30 days (0-100; null if unknown).
export function positioning(x, p = CROWD) {
  const acc = x?.acc, top = x?.top, pct = x?.accPct;
  if (!(acc > 0) || !(top > 0)) return { state: null, label: "no data", gap: null };
  const gap = top / acc;
  const state = acc <= p.crowdShortMax && top >= p.smartLongMin ? "crowdShort"
    : pct != null && pct >= p.crowdLongPct && top <= p.smartShortMax ? "crowdLong"
    : acc < 1 && top > 1 ? "leanShort" : acc > 1 && top < 1 ? "leanLong" : "aligned";
  const label = { crowdShort: "Crowd short, smart money long", crowdLong: "Crowd long, smart money short", leanShort: "Crowd leans short",
    leanLong: "Crowd leans long", aligned: "Crowd and smart money agree" }[state];
  return { state, label, gap: r2(gap, 2) };
}
// The setup on a closed bar: { side: 1 long / -1 short, setup } or null. pos = positioning() of that bar, sx = structure().
export function crowdSetup(pos, sx = {}, p = CROWD) {
  if (pos.state === "crowdShort" && p.sides.includes("long")) return { side: 1, setup: "crowdShort" };
  if (pos.state === "crowdLong" && sx.lowerHighs === true && p.sides.includes("short")) return { side: -1, setup: "crowdLong" };
  return null;
}
// Percentile (0-100) of value v among the earlier values hist (null with under 60 of them: 10 days of 4h readings).
export function percentileOf(hist, v) {
  const h = hist.filter((x) => x > 0);
  if (h.length < 60 || !(v > 0)) return null;
  return (h.filter((x) => x < v).length / h.length) * 100;
}
// The tested exit, from the open of bar i+1: a stop stopAtr x ATR away, a target targetAtr x ATR away (null = none),
// else the close of bar i+holdBars. A bar that touches both counts as a stop; a stop gapped through fills at the bar's
// open. Returns what is known so far.
export function crowdTrade(bars, i, side, p = CROWD, a = atrAt(bars, i)) {
  const e = bars[i + 1]?.o;
  if (!(e > 0) || !(a > 0)) return { entry: null, done: false };
  const stop = e - side * p.stopAtr * a, target = p.targetAtr ? e + side * p.targetAtr * a : null;
  let peak = 0, low = 0;
  for (let j = i + 1; j < bars.length && j <= i + p.holdBars; j++) {
    const b = bars[j];
    peak = Math.max(peak, side * ((side > 0 ? b.h : b.l) / e - 1) * 100); low = Math.min(low, side * ((side > 0 ? b.l : b.h) / e - 1) * 100);
    const hitS = side > 0 ? b.l <= stop : b.h >= stop, hitT = target != null && (side > 0 ? b.h >= target : b.l <= target);
    if (hitS) { const x = side > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o), pct = side * (x / e - 1) * 100;
      return { entry: e, stop, target, done: true, why: "stop", exit: x, pct, netPct: pct - p.costPct, bars: j - i, peakPct: peak, lowPct: low, exitT: b.t }; }
    if (hitT) { const pct = side * (target / e - 1) * 100; return { entry: e, stop, target, done: true, why: "target", exit: target, pct, netPct: pct - p.costPct, bars: j - i, peakPct: peak, lowPct: low, exitT: b.t }; }
    if (j === i + p.holdBars) { const pct = side * (b.c / e - 1) * 100; return { entry: e, stop, target, done: true, why: "time", exit: b.c, pct, netPct: pct - p.costPct, bars: j - i, peakPct: peak, lowPct: low, exitT: b.t + H4 }; }
  }
  return { entry: e, stop, target, done: false, peakPct: peak, lowPct: low };
}
// Joins Binance's 4h ratio history to 4h candles. A ratio sample taken at time T belongs to the bar that closes at T.
export function joinRatios(bars, accRows, topRows, oiRows = []) {
  const at = (rows) => { const m = new Map(); for (const [t, v] of rows) if (v > 0) m.set(Math.floor((t - 1) / H4) * H4, v); return m; };
  const A = at(accRows), T = at(topRows), O = at(oiRows);
  return bars.map((b) => ({ ...b, acc: A.get(b.t) ?? null, top: T.get(b.t) ?? null, oi: O.get(b.t) ?? null }));
}

export function createOnchain({ fetchJson, base = "https://fapi.binance.com", stateFile = null, reportFile = null, bundledReport = null, sendTelegram = null,
  wantTelegram = () => false, now = () => Date.now(), demo = false, p = CROWD, delayMs = 90_000 }) {
  base = base.replace(/\/$/, "");
  const st = { status: demo ? "off" : "starting", error: demo ? "The On-chain tab uses live Binance futures data only (not in demo mode)" : null,
    updatedAt: null, scanMs: null, universeAt: null, coins: [], lastBar: null, nextScanAt: null };
  let store = { version: 1, signals: [] }, report = null, universe = [], busy = false, started = false, loaded = false, timer = null;
  const save = () => (stateFile ? writeFile(stateFile + ".tmp", JSON.stringify(store)).then(() => rename(stateFile + ".tmp", stateFile)).catch(() => {}) : null);
  const get = (path) => fetchJson(base + path, { retries: 1, timeoutMs: 15_000 });
  const klines = async (sym, interval, limit) => (await get(`/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`))
    .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[7] }));
  const ratios = async (what, sym) => (await get(`/futures/data/${what}?symbol=${sym}&period=4h&limit=180`)).map((r) => [+r.timestamp, +r.longShortRatio]);
  async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }
  async function load() {
    if (loaded) return; loaded = true;
    try { const s = JSON.parse(await readFile(stateFile, "utf8")); if (s?.version === 1) store = s; } catch { /* first run */ }
    for (const [file, own] of [[reportFile, true], [bundledReport, false]]) {
      if (!file) continue;
      try { report = { ...JSON.parse(await readFile(file, "utf8")), own }; break; } catch { /* next */ }
    }
  }
  // The most liquid USDT perpetuals by 30-day volume, without stablecoins and perpetuals on stocks, ETFs or commodities.
  async function refreshUniverse() {
    const [info, tick] = await Promise.all([get("/fapi/v1/exchangeInfo"), get("/fapi/v1/ticker/24hr")]);
    const ok = new Set();
    for (const x of info.symbols || []) {
      if (x.contractType !== "PERPETUAL" || x.quoteAsset !== "USDT" || x.status !== "TRADING" || EXCLUDED.has(x.baseAsset)) continue;
      if ((x.underlyingType && x.underlyingType !== "COIN") || (x.underlyingSubType || []).some((t) => /tradfi|stock|equit|commodit|metal|etf/i.test(t))) continue;
      ok.add(x.symbol);
    }
    const cands = (tick || []).filter((x) => ok.has(x.symbol)).sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, p.top + 25);
    const vol = [];
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
  // After each 4h close (and every 30 minutes for the table): positioning of every coin, new setups, open signals.
  async function scan() {
    if (busy) return; busy = true;
    const t0 = now();
    try {
      await load();
      if (!universe.length || now() - (st.universeAt || 0) > 6 * HOUR) await refreshUniverse();
      const open = store.signals.filter((x) => x.status === "open");
      const syms = [...new Set([...universe, ...open.map((x) => x.sym)])], coins = [], fresh = [];
      let failed = 0;
      await pool(syms, 5, async (sym) => {
        let raw, acc, top, oi = [];
        try {
          [raw, acc, top] = await Promise.all([klines(sym, "4h", 200), ratios("globalLongShortAccountRatio", sym), ratios("topLongShortPositionRatio", sym)]);
          try { oi = (await get(`/futures/data/openInterestHist?symbol=${sym}&period=4h&limit=30`)).map((r) => [+r.timestamp, +r.sumOpenInterestValue]); } catch { /* label only */ }
        } catch { failed++; return; }
        const closed = raw.filter((b) => b.t + H4 <= now());
        if (closed.length < 30) return;
        const bars = joinRatios(closed, acc, top, oi), i = bars.length - 1, price = raw[raw.length - 1].c;
        for (const s of open.filter((y) => y.sym === sym)) follow(s, bars, price);
        if (!universe.includes(sym)) return;
        const hist = acc.map((r) => r[1]).filter((v) => v > 0);
        const latest = { acc: acc.length ? acc[acc.length - 1][1] : null, top: top.length ? top[top.length - 1][1] : null }; // the newest reading, for the table
        latest.accPct = percentileOf(hist.slice(0, -1), latest.acc);
        const pos = positioning(latest, p), b = bars[i], sx = structure(bars, i);
        const oiNow = bars[i].oi, oiThen = bars[i - 18]?.oi;
        coins.push({ sym, base: sym.replace(/USDT$/, ""), price, acc: r2(latest.acc, 3), top: r2(latest.top, 3), ...pos,
          accPct30d: r2(latest.accPct, 0), change24h: r2((b.c / bars[i - 6].c - 1) * 100, 2),
          oiChg3d: oiNow > 0 && oiThen > 0 ? r2((oiNow / oiThen - 1) * 100, 1) : null, ...sx,
          accTrend: hist.length >= 7 ? r2(latest.acc - hist[hist.length - 7], 3) : null });
        // the setup on the last two closed bars (in case a scan was missed), with the bar's own closing ratios
        const accAt = new Map(acc.map(([t, v]) => [Math.floor((t - 1) / H4) * H4, v]));
        for (const k of [i - 1, i]) {
          const before = [...accAt.entries()].filter(([t]) => t < bars[k].t && t >= bars[k].t - 30 * DAY).map(([, v]) => v);
          const sxk = structure(bars, k), sig = crowdSetup(positioning({ ...bars[k], accPct: percentileOf(before, bars[k].acc) }, p), sxk, p);
          if (!sig) continue;
          const prev = store.signals.find((x) => x.sym === sym && x.side === sig.side);
          if (prev && bars[k].t - prev.t < p.cooldownBars * H4) continue;
          const a = atrAt(bars, k);
          if (!(a > 0)) continue;
          const s = { id: `crowd-${sym}-${bars[k].t}-${sig.side}`, sym, base: sym.replace(/USDT$/, ""), t: bars[k].t, at: bars[k].t + H4, side: sig.side, setup: sig.setup,
            acc: r2(bars[k].acc, 3), top: r2(bars[k].top, 3), gap: r2(bars[k].top / bars[k].acc, 2), higherLows: sxk.higherLows, lowerHighs: sxk.lowerHighs, atr: a,
            ref: bars[k].c, status: "open", entry: null, price, closeBy: bars[k].t + H4 * (p.holdBars + 1) };
          s.stop = s.ref - sig.side * p.stopAtr * a; s.target = p.targetAtr ? s.ref + sig.side * p.targetAtr * a : null; s.riskPct = r2((p.stopAtr * a / s.ref) * 100, 2);
          store.signals.unshift(s); fresh.push(s);
          follow(s, bars, price);
        }
      });
      if (syms.length && failed > syms.length / 2) throw new Error(`futures data failed for ${failed}/${syms.length} coins`);
      store.signals = store.signals.slice(0, 500);
      st.coins = coins.sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0));
      Object.assign(st, { status: "ok", error: null, updatedAt: now(), scanMs: now() - t0, lastBar: Math.floor(now() / H4) * H4 - H4 });
      await save();
      if (sendTelegram && wantTelegram("onchain")) for (const s of fresh.filter((y) => y.status === "open")) sendTelegram(telegramText(s), "onchain");
    } catch (e) {
      if (st.error !== e.message) console.log(`On-chain: scan failed: ${e.message}${/451|403/.test(e.message) ? " (Binance futures is blocked on this connection)" : ""}`);
      st.status = st.updatedAt ? "ok" : "error"; st.error = e.message;
    } finally { busy = false; }
  }
  function follow(s, bars, price) {
    s.price = price;
    const i = bars.findIndex((b) => b.t === s.t);
    if (i < 0) { if (now() - s.at > 9 * DAY) Object.assign(s, { status: "closed", why: "no data", netPct: null }); return; }
    const r = crowdTrade(bars, i, s.side, p, s.atr);
    if (r.entry != null) Object.assign(s, { entry: r.entry, stop: r.stop, target: r.target, peakPct: r2(r.peakPct, 2), lowPct: r2(r.lowPct, 2) });
    if (r.done) Object.assign(s, { status: "closed", why: r.why, exit: r.exit, pct: r2(r.pct, 2), netPct: r2(r.netPct, 2), bars: r.bars, exitT: r.exitT });
  }
  function telegramText(s) {
    const dir = s.side > 0 ? "LONG (BUY)" : "SHORT (SELL)", days = Math.round((p.holdBars * 4) / 24);
    return `ON-CHAIN: ${dir} ${s.sym} (crowd vs smart money, 4h)\n` +
      `${s.side > 0 ? `Crowd short: account long/short ratio ${s.acc}; top traders long: position ratio ${s.top}` : `Crowd long: account long/short ratio ${s.acc} (top 10% of its 30 days); top traders not long: position ratio ${s.top}; lower highs`}\n` +
      `Entry near ${fmtPx(s.ref)}\nStop ${fmtPx(s.stop)} (${s.side > 0 ? "-" : "+"}${s.riskPct}%)\n${s.target ? `Target ${fmtPx(s.target)}\n` : ""}Close after ${days} days${s.target ? " if neither is hit" : " if the stop is not hit"}\n` +
      `Size from your risk: with a ${s.riskPct}% stop, risking 1% of the account = a position of about ${Math.round(100 / s.riskPct)}% of the account. Research signal only.`;
  }
  function record(side = null) {
    const done = store.signals.filter((x) => x.status === "closed" && x.netPct != null && (side == null || x.side === side));
    if (!done.length) return { n: 0 };
    return { n: done.length, avgPct: r2(done.reduce((a, x) => a + x.netPct, 0) / done.length, 2), winPct: r2((done.filter((x) => x.netPct > 0).length / done.length) * 100, 0),
      targets: done.filter((x) => x.why === "target").length, stops: done.filter((x) => x.why === "stop").length, timeouts: done.filter((x) => x.why === "time").length };
  }
  function schedule() {
    // a minute and a half after each 4h close (Binance publishes the 4h ratio a little after the close), else every 30 minutes
    const nextClose = Math.floor(now() / H4) * H4 + H4 + delayMs, next = Math.min(nextClose, now() + 30 * 60_000);
    st.nextScanAt = next;
    timer = setTimeout(() => { scan().finally(schedule); }, Math.max(1000, next - now()));
  }
  function start() { if (started || demo) return; started = true; scan().finally(schedule); }
  function stop() { clearTimeout(timer); started = false; }
  function api() {
    return { ...st, rule: p, signals: store.signals.slice(0, 60), open: store.signals.filter((x) => x.status === "open").length, record: record(),
      recordLong: record(1), recordShort: record(-1), report: report ? { own: report.own, ...report, trades: undefined } : null };
  }
  return { start, stop, scan, api, load };
}

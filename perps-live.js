// Perps tab (Binance USDⓈ-M perpetuals, swing trades, long and short). The setups tested by perps-backtest.js, found
// live on CLOSED 4h candles with the same code (perps.js), each with a TAKE / WAIT / SKIP verdict from the setup's
// tested record and the conditions that helped or hurt it in both test periods, then followed to its result with the
// tested exit (target 2.5R or stop, at most 10 days) including fees and real funding. "Check a trade" judges your own
// idea on any perpetual the same way. Node.js 18+, no dependencies.
//
// Data: Binance's futures API (fapi.binance.com, or BINANCE_FUTURES_URL), no key. Coins: the most liquid USDT
// perpetuals by 30-day volume, without stablecoins and without perpetuals on stocks, ETFs or commodities (found by
// their weekend volume, as in the backtest). Research signals, not financial advice.
import { readFile, writeFile, rename } from "node:fs/promises";
import * as P from "./perps.js";
import { EXCLUDED, weekendShare } from "./perps-history.js";

const MIN = 60_000, HOUR = 3_600_000, H4 = 14_400_000, DAY = 86_400_000;
// Listed as signals: the setups worth watching after the test. Others are used only to explain a "check".
export const LIVE_SETUPS = new Set(["breakout", "crowded"]);
// Lost money in the test: a check that matches these gets SKIP.
export const AVOID = new Set(["pullback|1", "flush|1"]);
const SETUP_NAMES = { breakout: "20-day breakout", crowded: "Crowded fade", pullback: "Trend pullback", flush: "Flush reversal", strength: "Relative strength", trend: "Plain trend" };
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const sideOf = (dir) => (dir > 0 ? "long" : "short");
const fmtPx = (v) => (!(v > 0) ? "—" : v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));

export function createPerps({ fetchJson, base = "https://fapi.binance.com", stateFile = null, reportFile = null, bundledReport = null, sendTelegram = null,
  wantTelegram = () => false, telegramConfigured = () => false, now = () => Date.now(), top = 50, costPct = 0.08, demo = false }) {
  base = base.replace(/\/$/, "");
  const st = { status: demo ? "demo" : "starting", error: null, updatedAt: null, nextScanAt: null, scanMs: null, universeAt: null, btc: null, excluded: { tradfi: [], other: 0 }, rows: [], lastBar: null };
  let store = { version: 1, signals: [] }, report = null, universe = [], dailyCache = new Map(), busy = false, started = false;
  const fundCache = new Map(), coinCache = new Map(), premium = new Map(), symbols = new Map();
  const save = () => (stateFile ? writeFile(stateFile + ".tmp", JSON.stringify(store)).then(() => rename(stateFile + ".tmp", stateFile)).catch(() => {}) : null);
  const get = (path) => fetchJson(base + path, { retries: 1, timeoutMs: 15_000 });
  const klines = async (sym, interval, limit) => (await get(`/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`))
    .map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], qv: +k[7] }));
  async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }

  // ───────────── the tested record of each setup (perps_report.json) ─────────────
  // Your own `node perps-backtest.js` report, else the copy shipped in data/ (so verdicts work from the first start)
  async function loadReport() {
    for (const [file, own] of [[reportFile, true], [bundledReport, false]]) if (file && await loadReportFrom(file, own)) return;
    report = null;
  }
  async function loadReportFrom(file, own) {
    try {
      const r = JSON.parse(await readFile(file, "utf8"));
      const recent = new Map();
      for (const t of r.trades || []) { const k = `${t[0]}|${t[1]}`; if (!recent.has(k)) recent.set(k, []); recent.get(k).push(t); }
      report = { own, generatedAt: r.generatedAt, from: r.from, to: r.to, split: r.split, top: r.top, coins: r.coins, costPctPerSide: r.costPctPerSide,
        setups: r.setups, exits: r.exits, combined: r.combined || null,
        results: Object.fromEntries((r.results || []).map((x) => [`${x.setup}|${x.side === "long" ? 1 : -1}`, { ...x, rules: undefined,
          rulesBrief: Object.fromEntries(Object.entries(x.rules || {}).map(([k, v]) => [k, { avgR: v.all.avgR, olderR: v.older.avgR, newerR: v.newer.avgR, verdict: v.verdict }])),
          last: (recent.get(`${x.setup}|${x.side === "long" ? 1 : -1}`) || []).sort((a, b) => b[3] - a[3]).slice(0, 8) }])) };
      return true;
    } catch { return false; }
  }
  const recordOf = (setup, dir) => report?.results?.[`${setup}|${dir}`] || null;

  // ───────────── coins ─────────────
  // The most liquid USDT perpetuals by 30-day volume, refreshed after each daily close. Stocks, ETFs and commodities
  // are left out by Binance's own labels where present, and by their weekend volume.
  async function refreshUniverse() {
    const [info, tick] = await Promise.all([get("/fapi/v1/exchangeInfo"), get("/fapi/v1/ticker/24hr")]);
    symbols.clear();
    for (const x of info.symbols || []) {
      if (x.contractType !== "PERPETUAL" || x.quoteAsset !== "USDT" || x.status !== "TRADING") continue;
      const tradfi = (x.underlyingType && x.underlyingType !== "COIN") || (x.underlyingSubType || []).some((t) => /tradfi|stock|equit|commodit|metal|etf/i.test(t));
      symbols.set(x.symbol, { base: x.baseAsset, excluded: EXCLUDED.has(x.baseAsset) || tradfi });
    }
    const cands = tick.filter((x) => symbols.has(x.symbol) && !symbols.get(x.symbol).excluded).sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, top + 25);
    const daily = new Map(), tradfi = [];
    await pool(cands, 6, async (c) => { try { daily.set(c.symbol, await klines(c.symbol, "1d", 120)); } catch { /* skipped this time */ } });
    if (!daily.has("BTCUSDT")) daily.set("BTCUSDT", await klines("BTCUSDT", "1d", 120));
    const vol30 = [];
    for (const [sym, rows] of daily) {
      const done = rows.filter((d) => d.t + DAY <= now());
      if (weekendShare(done.map((d) => [d.t, d.o, d.h, d.l, d.c, d.qv])) < 0.35) { tradfi.push(sym); continue; }
      if (done.length >= 25) vol30.push([sym, done.slice(-30).reduce((a, d) => a + d.qv, 0)]);
    }
    universe = vol30.sort((a, b) => b[1] - a[1]).slice(0, top).map((x) => x[0]);
    dailyCache = daily;
    st.excluded = { tradfi: tradfi.map((s) => s.replace(/USDT$/, "")), other: [...symbols.values()].filter((x) => x.excluded).length };
    st.universeAt = now();
  }
  // BTC trend after the last daily close: up / down / mixed (close vs 50-day EMA, 20 vs 50), as in the backtest
  function btcRegime() {
    const d = (dailyCache.get("BTCUSDT") || []).filter((x) => x.t + DAY <= now());
    const e20 = P.ema(d.map((x) => x.c), 20), e50 = P.ema(d.map((x) => x.c), 50), k = d.length - 1;
    if (k < 50 || !e50[k]) return null;
    return d[k].c > e50[k] && e20[k] > e50[k] ? "up" : d[k].c < e50[k] && e20[k] < e50[k] ? "down" : "mixed";
  }
  // 30-day return minus BTC's, ranked among the liquid coins (1 = strongest)
  function rsRanks() {
    const at = (sym) => { const d = (dailyCache.get(sym) || []).filter((x) => x.t + DAY <= now()); return d.length > 31 ? d[d.length - 1].c / d[d.length - 31].c - 1 : null; };
    const b = at("BTCUSDT");
    if (b == null) return new Map();
    const rows = universe.map((s) => [s, at(s)]).filter((x) => x[1] != null).map(([s, v]) => [s, v - b]).sort((x, y) => y[1] - x[1]);
    return new Map(rows.map(([s], k) => [s, { rank: k + 1, n: rows.length }]));
  }
  // Funding history (cached, topped up), 4h candles with open interest / long-short / taker data, daily candles.
  async function coinData(sym, { fresh = false } = {}) {
    const hit = coinCache.get(sym);
    if (hit && !fresh && now() - hit.at < 2 * MIN) return hit.coin;
    const f = fundCache.get(sym) || [];
    const fr = await get(`/fapi/v1/fundingRate?symbol=${sym}&limit=1000${f.length ? `&startTime=${f[f.length - 1][0] + 1}` : ""}`);
    for (const x of fr || []) f.push([+x.fundingTime, +x.fundingRate]);
    fundCache.set(sym, f.slice(-3000));
    const [bars, oi, top, acc, taker] = await Promise.all([
      klines(sym, "4h", 220),
      get(`/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=100`).catch(() => []),
      get(`/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=12`).catch(() => []),
      get(`/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=12`).catch(() => []),
      get(`/futures/data/takerlongshortRatio?symbol=${sym}&period=1h&limit=12`).catch(() => []),
    ]);
    // the last value at or before each 4h close (taker: the average over the bar), as the backtest's archive metrics
    const lastAt = (rows, key, t) => { let v = null; for (const r of rows || []) if (+r.timestamp <= t) v = +r[key]; return v > 0 ? v : null; };
    const avgIn = (rows, key, a, b) => { const v = (rows || []).filter((r) => +r.timestamp > a && +r.timestamp <= b).map((r) => +r[key]).filter((x) => x > 0); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
    const firstOi = oi?.length ? +oi[0].timestamp : Infinity;
    for (const b of bars) {
      const close = b.t + H4;
      b.oi = close >= firstOi ? lastAt(oi, "sumOpenInterestValue", close) : null;
      b.top = lastAt(top, "longShortRatio", close); b.acc = lastAt(acc, "longShortRatio", close); b.taker = avgIn(taker, "buySellRatio", b.t, close);
    }
    let daily = dailyCache.get(sym);
    if (!daily) { daily = await klines(sym, "1d", 120); dailyCache.set(sym, daily); }
    const coin = { sym, bars, funding: fundCache.get(sym), daily: daily.filter((d) => d.t + DAY <= now()) };
    coinCache.set(sym, { at: now(), coin });
    return coin;
  }
  // The series up to the last closed 4h candle (the one still forming is left out, as in the backtest)
  const closedSeries = (coin) => P.prepare({ ...coin, bars: coin.bars.filter((b) => b.t + H4 <= now()) });
  const fund8hNow = (sym) => { const p = premium.get(sym); if (!p) return null; const f = coinCache.get(sym)?.coin.funding || []; const hrs = f.length > 1 ? Math.round((f[f.length - 1][0] - f[f.length - 2][0]) / HOUR) : 8; return +p.lastFundingRate * 100 * 8 / (hrs >= 1 && hrs <= 8 ? hrs : 8); };

  // ───────────── one scan, after each 4h close ─────────────
  async function scan() {
    const t0 = now();
    if (!universe.length || Math.floor((st.universeAt || 0) / DAY) !== Math.floor(t0 / DAY)) await refreshUniverse();
    else { try { dailyCache.set("BTCUSDT", await klines("BTCUSDT", "1d", 120)); } catch { /* keep */ } }
    for (const p of await get("/fapi/v1/premiumIndex")) premium.set(p.symbol, p);
    const regime = btcRegime(), ranks = rsRanks(), rows = [], fresh = [];
    st.btc = regime;
    const series = new Map();
    await pool(universe, 5, async (sym) => {
      try {
        const s = closedSeries(await coinData(sym, { fresh: true })), i = s.bars.length - 1;
        if (i < 140) return;
        series.set(sym, s);
        const tClose = s.bars[i].t + H4, dayClose = tClose % DAY === 0;
        const ctx = { btcRegime: regime, rs: dayClose ? ranks.get(sym) || null : null, dayClose };
        // features with exactly the backtest's context (strength vs BTC only on the daily close), so verdicts match the record
        const sigs = P.signalsAt(s, i, ctx), f = P.features(s, i, ctx), lv = P.levels(s, i), rs = ranks.get(sym) || null;
        st.lastBar = Math.max(st.lastBar || 0, s.bars[i].t);
        const b24 = s.bars[i - 6];
        rows.push({ sym, base: sym.replace(/USDT$/, ""), price: lv.price, ch24: b24 ? r2((lv.price / b24.c - 1) * 100) : null, fund8h: r2(f.fund8h, 4), fundPct: f.fundPct != null ? Math.round(f.fundPct * 100) : null,
          oi24h: f.oi24h != null ? r2(f.oi24h * 100, 1) : null, oi3d: f.oi3d != null ? r2(f.oi3d * 100, 1) : null, topVsAcc: r2(f.topVsAcc), dTrend: f.dTrend, rs, vol: r2(f.vol),
          toHi20: lv.toHi20Pct, toLo20: lv.toLo20Pct, signals: sigs.map((x) => ({ setup: x.setup, side: sideOf(x.dir) })) });
        for (const sig of sigs) if (LIVE_SETUPS.has(sig.setup)) fresh.push({ sym, s, i, sig, f });
      } catch (e) { st.error = `${sym}: ${e.message}`; }
    });
    for (const x of fresh) addSignal(x);
    await track(series);
    st.rows = rows.sort((a, b) => universe.indexOf(a.sym) - universe.indexOf(b.sym));
    st.status = "ready"; st.updatedAt = now(); st.scanMs = now() - t0;
    if (rows.length) st.error = null;
    save();
  }
  function addSignal({ sym, s, i, sig, f }) {
    const b = s.bars[i], key = `${sym}|${sig.setup}|${sig.dir}`;
    if (store.signals.some((x) => x.key === key && (x.t === b.t || x.track.status === "open"))) return; // one at a time, as tested
    const j = P.judge(sig.setup, sig.dir, f, recordOf(sig.setup, sig.dir));
    const risk = sig.dir * (b.c - sig.stop);
    const x = { id: `${key}|${b.t}`, key, sym, base: sym.replace(/USDT$/, ""), setup: sig.setup, side: sideOf(sig.dir), dir: sig.dir, t: b.t, at: now(), price: b.c,
      stop: sig.stop, target: b.c + sig.dir * P.EXITS.main.tp * risk, riskPct: r2(risk / b.c * 100), verdict: j.verdict, reasons: j.reasons, plus: j.plus, minus: j.minus,
      conditions: P.conditionsMet(sig.dir, f), f: { ...f, rs: f.rs }, fund8h: f.fund8h, track: { status: "open" } };
    store.signals.push(x);
    if (store.signals.length > 600) store.signals = store.signals.slice(-600);
    if (x.verdict !== "SKIP" && sendTelegram && wantTelegram("perps")) sendTelegram(telegramText(x), "perps").catch?.(() => {});
  }
  function telegramText(x) {
    const r = recordOf(x.setup, x.dir);
    return [`PERPS ${x.verdict}: ${x.side.toUpperCase()} ${x.base} (${SETUP_NAMES[x.setup] || x.setup}, 4h close)`,
      `Entry ~${fmtPx(x.price)} | stop ${fmtPx(x.stop)} (${x.riskPct}%) | target ${fmtPx(x.target)} (2.5R) | max 10 days`,
      r ? `Tested: ${r.all.trades} trades, ${r.all.avgR}R per trade (before 2025 ${r.older.avgR}R, 2025-26 ${r.newer.avgR}R)` : null,
      ...x.plus.map((p) => `+ ${p}`), ...x.minus.map((m) => `- ${m}`),
      x.fund8h != null ? `Funding ${x.fund8h.toFixed(4)}% per 8h (${x.dir * x.fund8h > 0 ? "you pay" : "you receive"})` : null,
      "Size from your risk, isolated margin, liquidation beyond the stop. Research signal, not financial advice."].filter(Boolean).join("\n");
  }
  // Open signals: followed on closed 4h candles with the tested exit, fees and funding.
  async function track(series) {
    for (const x of store.signals.filter((y) => y.track.status === "open")) {
      try {
        const s = series.get(x.sym) || closedSeries(await coinData(x.sym));
        const i = s.bars.findIndex((b) => b.t === x.t);
        if (i < 0) { if (s.bars[0]?.t > x.t) x.track = { status: "closed", why: "no data", r: null }; continue; }
        const done = P.simulate(s, { i, dir: x.dir, stop: x.stop }, P.EXITS.main, costPct, null);
        if (done) { x.track = { status: "closed", ...done }; continue; }
        const e = s.bars[i + 1];
        if (!e) continue;
        const last = s.bars[s.bars.length - 1], risk = x.dir * (e.o - x.stop);
        let fund = 0;
        for (const [ft, rate] of s.funding) if (ft > e.t && ft <= last.t + H4) fund -= x.dir * rate * 100;
        const net = x.dir * (last.c / e.o - 1) * 100 - 2 * costPct + fund;
        x.track = { status: "open", entry: e.o, last: last.c, r: r2(net / (risk / e.o * 100)), netPct: r2(net), fundingPct: r2(fund, 3), days: r2((last.t + H4 - e.t) / DAY, 1) };
      } catch { /* try again next scan */ }
    }
  }

  // ───────────── check a trade ─────────────
  // Your idea (coin, long or short, optional entry and stop) judged like a signal: a tested setup now or in the last
  // 12 hours, a setup that lost money in the test, or nothing tested yet (then: what to wait for).
  async function check({ sym, side, entry = null, stop = null }) {
    sym = String(sym || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!sym) throw Object.assign(new Error("Enter a coin, e.g. SOL"), { status: 400 });
    if (!sym.endsWith("USDT")) sym += "USDT";
    if (!symbols.size) await refreshUniverse();
    if (!symbols.has(sym)) throw Object.assign(new Error(`${sym} is not a Binance USDⓈ-M perpetual`), { status: 400 });
    const dir = side === "short" ? -1 : 1;
    if (!premium.size) for (const p of await get("/fapi/v1/premiumIndex")) premium.set(p.symbol, p);
    const s = closedSeries(await coinData(sym)), i = s.bars.length - 1;
    if (i < 140) throw Object.assign(new Error(`${sym} has too little history (needs about 25 days of 4h candles)`), { status: 400 });
    const regime = btcRegime() ?? st.btc, ranks = rsRanks(), ctx = { btcRegime: regime, rs: null }; // as a 4h signal in the backtest
    const f = P.features(s, i, ctx), lv = P.levels(s, i);
    const notCrypto = symbols.get(sym).excluded || weekendShare(s.daily.map((d) => [d.t, d.o, d.h, d.l, d.c, d.qv])) < 0.35;
    // signals on this side in the last 3 closed candles
    const recent = [];
    for (let k = i; k >= i - 2; k--) for (const sig of P.signalsAt(s, k, { ...ctx, dayClose: false })) if (sig.dir === dir) recent.push({ ...sig, k, hoursAgo: (i - k) * 4 });
    const live = recent.find((x) => LIVE_SETUPS.has(x.setup)), avoid = recent.find((x) => AVOID.has(`${x.setup}|${dir}`));
    const price = +premium.get(sym)?.markPrice || lv.price, out = { sym, base: sym.replace(/USDT$/, ""), side: sideOf(dir), dir, price, at: now(), btc: regime, levels: lv,
      features: { ...f, fundPct: f.fundPct != null ? Math.round(f.fundPct * 100) : null }, conditions: P.conditionsMet(dir, f), waitFor: [] };
    if (live) {
      const j = P.judge(live.setup, dir, f, recordOf(live.setup, dir));
      Object.assign(out, { verdict: j.verdict, setup: live.setup, headline: `${SETUP_NAMES[live.setup]} ${sideOf(dir)} ${live.hoursAgo ? `fired ${live.hoursAgo}h ago` : "fired on the last 4h close"}`,
        reasons: j.reasons, plus: j.plus, minus: j.minus, signalStop: live.stop });
      if (live.hoursAgo) out.reasons.push(`Price then ${fmtPx(s.bars[live.k].c)}, now ${fmtPx(price)}: ${Math.abs(price / s.bars[live.k].c - 1) * 100 > 2 ? "it has moved, the risk to the stop is different now" : "close to the signal price"}`);
    } else if (avoid) {
      const r = recordOf(avoid.setup, dir);
      Object.assign(out, { verdict: "SKIP", setup: avoid.setup, headline: `This is a ${SETUP_NAMES[avoid.setup].toLowerCase()} ${sideOf(dir)}: it lost money in the test`,
        reasons: [r ? `Tested: ${r.all.trades} trades, ${r.all.avgR}R per trade (before 2025 ${r.older.avgR}R, 2025-26 ${r.newer.avgR}R) after fees and funding` : "Lost money in the test after fees and funding",
          avoid.setup === "pullback" ? "Buying a dip in an uptrend on perps lost money in every version tested" : "Buying right after a crash that wiped out open interest lost money in every version tested"], plus: [], minus: [] });
    } else {
      Object.assign(out, { verdict: "WAIT", setup: null, headline: "No tested setup on this coin right now", reasons: [`${f.dTrend === (dir > 0 ? "up" : "down") ? "The daily trend is with you" : f.dTrend === "mixed" ? "The daily trend is mixed" : "The daily trend is against you"}; BTC trend: ${regime || "unknown"}`], plus: [], minus: [] });
    }
    if (notCrypto) {
      if (out.verdict === "TAKE") out.verdict = "WAIT";
      out.reasons.unshift("Not a crypto coin (a perpetual on a stock, ETF, commodity or stablecoin): the tests did not include these");
    }
    out.rs = ranks.get(sym) || null;
    // what would make it a tested trade (both live setups, this side)
    const volNeed = s.qvAvg[i] > 0 ? 1.5 : null;
    const away = (p) => (dir > 0 ? (p < 0 ? "already above it" : `+${p}% from here`) : p > 0 ? "already below it" : `${p}% from here`);
    if (dir > 0) out.waitFor.push(`20-day breakout long: a fresh 4h close above ${fmtPx(lv.hi20)} (${away(lv.toHi20Pct)}) on ${volNeed}x its usual volume, with the daily close above its 50-day average. Best when funding is negative (now ${f.fund8h != null ? f.fund8h.toFixed(4) + "%" : "—"})`);
    else out.waitFor.push(`20-day breakdown short: a fresh 4h close below ${fmtPx(lv.lo20)} (${away(lv.toLo20Pct)}) on ${volNeed}x its usual volume, with the daily close below its 50-day average. Best while BTC itself trends up (now ${regime || "—"})`);
    out.waitFor.push(dir > 0 ? `Crowded-fade long: funding at -0.01% per 8h or lower and in the bottom 10% of its 90 days (now ${f.fund8h != null ? f.fund8h.toFixed(4) + "%" : "—"}, ${out.features.fundPct ?? "—"}th percentile), open interest +10% in 3 days (now ${f.oi3d != null ? (f.oi3d * 100).toFixed(1) + "%" : "—"}), then a 4h close back above the 20 EMA`
      : `Crowded-fade short: funding at +0.03% per 8h or higher and in the top 10% of its 90 days (now ${f.fund8h != null ? f.fund8h.toFixed(4) + "%" : "—"}, ${out.features.fundPct ?? "—"}th percentile), open interest +10% in 3 days (now ${f.oi3d != null ? (f.oi3d * 100).toFixed(1) + "%" : "—"}), then a 4h close back below the 20 EMA`);
    // the trade's numbers: your entry and stop, or the signal's stop, or 2.5 ATR(4h)
    const e = entry > 0 ? +entry : price;
    let sp = stop > 0 ? +stop : out.signalStop ?? (dir > 0 ? e - 2.5 * lv.atr : e + 2.5 * lv.atr);
    const wrongSide = dir * (e - sp) <= 0, tooFar = !wrongSide && dir * (e - sp) / e > 0.5, bad = wrongSide || tooFar;
    if (bad) {
      out.reasons.push(wrongSide ? `Your stop must be ${dir > 0 ? "below" : "above"} the entry for a ${sideOf(dir)}: using 2.5 ATR(4h) instead` : "Your stop is more than 50% away: using 2.5 ATR(4h) instead");
      sp = dir > 0 ? e - 2.5 * lv.atr : e + 2.5 * lv.atr;
    }
    const riskPct = dir * (e - sp) / e * 100, f8 = fund8hNow(sym) ?? f.fund8h, perDay = f8 != null ? -dir * f8 * 3 : null;
    out.risk = { entry: e, stop: sp, stopSource: stop > 0 && !bad ? "yours" : out.signalStop ? "the signal's" : "2.5 ATR(4h)", target: e + dir * 2.5 * (dir * (e - sp)), riskPct: r2(riskPct),
      fund8h: f8 != null ? r2(f8, 4) : null, fundingPerDayPct: r2(perDay, 3), funding10dPct: r2(perDay != null ? perDay * 10 : null, 2), funding10dR: perDay != null && riskPct > 0 ? r2(perDay * 10 / riskPct) : null, costPct: 2 * costPct };
    if (riskPct > 15) { out.reasons.push(`The stop is ${r2(riskPct)}% away: wider than any tested setup allows (15%)`); if (out.verdict === "TAKE") out.verdict = "WAIT"; }
    if (out.risk.funding10dR != null && out.risk.funding10dR < -0.25) out.reasons.push(`Funding would cost about ${-out.risk.funding10dR}R over 10 days at today's rate`);
    return out;
  }

  // ───────────── results of the live signals ─────────────
  function liveStats() {
    const closed = store.signals.filter((x) => x.track.status === "closed" && Number.isFinite(x.track.r)).map((x) => ({ ...x.track, sym: x.sym, setup: x.setup, dir: x.dir, verdict: x.verdict }));
    const by = (fn) => { const m = {}; for (const t of closed) { const k = fn(t); (m[k] ||= []).push(t); } return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, P.summary(v)])); };
    return { closed: closed.length, open: store.signals.filter((x) => x.track.status === "open").length, all: P.summary(closed),
      bySetup: by((t) => `${t.setup}|${sideOf(t.dir)}`), byVerdict: by((t) => t.verdict) };
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try { await scan(); }
    catch (e) { st.error = e.message; st.status = st.rows.length ? "ready" : "error"; }
    finally { busy = false; schedule(); }
  }
  // 90 seconds after each 4h close (open interest and long/short data for the hour land shortly after)
  function schedule() {
    const t = now(), next = Math.floor(t / H4) * H4 + H4 + 90_000;
    st.nextScanAt = next;
    setTimeout(tick, next - t).unref?.();
  }
  return {
    start() {
      if (started) return; started = true;
      console.log(`Perps swing signals: /screener#perps | Binance USDⓈ-M, ${top} most liquid | setups ${[...LIVE_SETUPS].join(", ")} | after each 4h close | Telegram: ${wantTelegram("perps") ? "on" : "off"}`);
      const boot = async () => { if (stateFile) { try { const s = JSON.parse(await readFile(stateFile, "utf8")); if (s?.version === 1 && Array.isArray(s.signals)) store = s; } catch { /* first run */ } } await loadReport(); };
      boot().finally(() => { if (!demo) setTimeout(tick, 20_000).unref?.(); });
      setInterval(loadReport, 10 * MIN).unref?.(); // picks up a fresh `node perps-backtest.js` report
    },
    scan, loadReport, check: (q) => check(q), // scan and loadReport: for tests and a manual refresh
    api() {
      return { status: st.status, error: st.error, updatedAt: st.updatedAt, nextScanAt: st.nextScanAt, scanMs: st.scanMs, lastBar: st.lastBar, source: base.replace(/^https?:\/\//, ""),
        coins: universe.length, top, costPctPerSide: costPct, btc: st.btc, excluded: st.excluded, telegramOn: wantTelegram("perps") && telegramConfigured(), demo,
        rows: st.rows, signals: store.signals.slice(-120).reverse(), live: liveStats(), setupNames: SETUP_NAMES, liveSetups: [...LIVE_SETUPS],
        report: report ? { ...report, results: Object.values(report.results) } : null };
    },
    // a signal's own tracked result, for the journal's "you vs the signal"
    signalById(id) {
      const x = store.signals.find((y) => y.id === id);
      return x ? { price: x.track.entry ?? x.price, netPct: x.track.status === "closed" ? x.track.netPct : null, status: x.track.status === "closed" ? x.track.why : "open", label: `Perps ${SETUP_NAMES[x.setup] || x.setup} ${x.side}`, time: x.t } : null;
    },
    priceOf(symOrBase) { const s = String(symOrBase || "").toUpperCase().replace(/USDT$/, "") + "USDT"; return +premium.get(s)?.markPrice || null; },
  };
}

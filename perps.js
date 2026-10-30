// Swing-trade setups on Binance USDⓈ-M perpetuals, long and short, and their simulation with fees, slippage and the
// real funding paid or received while a trade is open. Pure functions: used by perps-backtest.js on years of history
// (and later by the live Perps tab, so the live signals are exactly the tested ones). Node.js 18+, no dependencies.
//
// Every signal is judged on a CLOSED 4h candle and entered at the next candle's open. Inside one candle the stop is
// checked before the target (a candle that touches both counts as a loss), and a trailing stop only moves after the
// candle that set the new extreme. The daily trend comes from the last COMPLETED daily candle. Research tool, not advice.

const H4 = 14_400_000, DAY = 86_400_000;

export const SETUPS = {
  pullback: "Trend pullback: daily trend, a real 4h pullback into the 4h 50 EMA zone, then a strong 4h close back with the trend",
  breakout: "20-day breakout: a 4h close through the 20-day high (low) on 1.5x volume, daily trend not against it",
  flush: "Flush reversal: a fast 3.5 ATR drop (spike) that cuts open interest by 5%+ (liquidations), then a 4h close back past the middle",
  crowded: "Crowded fade: funding in the top (bottom) 10% of the coin's 90 days, open interest +10% in 3 days, price stalling, then a 4h close through the 20 EMA against the crowd",
  strength: "Relative strength: once a day, the 5 strongest (weakest) coins vs BTC in a daily uptrend (downtrend), when BTC itself trends that way",
  trend: "Benchmark, not a setup: once a day, any coin in a daily uptrend (long) or downtrend (short). A setup has to beat this",
};

// ───────────────────────────── indicators ─────────────────────────────
export function ema(values, n) {
  const out = new Array(values.length).fill(null), k = 2 / (n + 1);
  let e = null, seen = 0, sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { out[i] = e; continue; }
    if (e == null) { sum += v; if (++seen === n) e = sum / n; }
    else e = v * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
export function atr(bars, n = 14) { // Wilder
  const out = new Array(bars.length).fill(null);
  let a = null, sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c, tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (a == null) { sum += tr; if (i === n) a = sum / n; }
    else a = (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
}
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
const maxOf = (arr, a, b, key) => { let m = -Infinity; for (let i = Math.max(0, a); i <= b; i++) m = Math.max(m, arr[i][key]); return m; };
const minOf = (arr, a, b, key) => { let m = Infinity; for (let i = Math.max(0, a); i <= b; i++) m = Math.min(m, arr[i][key]); return m; };
const pct = (a, b) => (a > 0 && b > 0 ? b / a - 1 : null);

// ───────────────────────────── one coin's series ─────────────────────────────
// coin = { sym, bars: [{ t, o, h, l, c, qv, oi, top, acc, taker }], funding: [[t, rate]], daily: [{ t, o, h, l, c, qv }] }
export function prepare(coin) {
  const bars = coin.bars, d = coin.daily, n = bars.length;
  const c = bars.map((b) => b.c);
  const s = { sym: coin.sym, bars, funding: coin.funding, daily: d,
    ema20: ema(c, 20), ema50: ema(c, 50), atr: atr(bars, 14), rsi: rsi(c, 14), qvAvg: new Array(n).fill(null),
    dIdx: new Array(n).fill(-1), fund8h: new Array(n).fill(null), fundPct: new Array(n).fill(null),
    dEma20: ema(d.map((x) => x.c), 20), dEma50: ema(d.map((x) => x.c), 50), dAtr: atr(d, 14) };
  let sum = 0;
  for (let i = 0; i < n; i++) { sum += bars[i].qv; if (i >= 30) sum -= bars[i - 30].qv; if (i >= 30) s.qvAvg[i] = (sum - bars[i].qv) / 29; }
  // last completed daily candle at each 4h close
  for (let i = 0, j = -1; i < n; i++) { const close = bars[i].t + H4; while (j + 1 < d.length && d[j + 1].t + DAY <= close) j++; s.dIdx[i] = j; }
  // funding known at each 4h close, as % per 8 hours, and where it sits in the coin's own last 90 days (0..1)
  const f = coin.funding, norm = f.map((x, k) => { const hrs = k > 0 ? Math.round((x[0] - f[k - 1][0]) / 3_600_000) : 8; return x[1] * 100 * 8 / (hrs >= 1 && hrs <= 8 ? hrs : 8); });
  for (let i = 0, k = -1, lo = 0; i < n; i++) {
    const close = bars[i].t + H4;
    while (k + 1 < f.length && f[k + 1][0] <= close) k++;
    if (k < 0) continue;
    while (lo < k && f[lo][0] < close - 90 * DAY) lo++;
    s.fund8h[i] = norm[k];
    if (k - lo >= 60) { let below = 0; for (let m = lo; m <= k; m++) if (norm[m] <= norm[k]) below++; s.fundPct[i] = below / (k - lo + 1); }
  }
  return s;
}

const oiChange = (s, i, back) => { const a = s.bars[i - back]?.oi, b = s.bars[i]?.oi; return a > 0 && b > 0 ? b / a - 1 : null; };

// What is known at the close of 4h bar i, saved with every signal (the report groups results by these).
export function features(s, i, ctx = {}) {
  const b = s.bars[i], di = s.dIdx[i], dd = s.daily[di];
  return { btc: ctx.btcRegime ?? null, atrPct: s.atr[i] > 0 ? s.atr[i] / b.c : null, oi24h: oiChange(s, i, 6), oi3d: oiChange(s, i, 18), fund8h: s.fund8h[i], fundPct: s.fundPct[i],
    topVsAcc: b.top > 0 && b.acc > 0 ? b.top / b.acc : null, taker: b.taker, vol: s.qvAvg[i] > 0 ? b.qv / s.qvAvg[i] : null,
    rs: ctx.rs ?? null, dTrend: dd ? (dd.c > s.dEma50[di] && s.dEma20[di] > s.dEma50[di] ? "up" : dd.c < s.dEma50[di] && s.dEma20[di] < s.dEma50[di] ? "down" : "mixed") : null };
}

// ───────────────────────────── the setups ─────────────────────────────
// Signals at the close of bar i: [{ setup, dir: 1 long / -1 short, stop }]. ctx = { btcRegime: "up" | "down" | "mixed",
// rs: { rank, n } of the coin among the liquid coins today (1 = strongest vs BTC over 30 days), dayClose: true on the
// 4h bar that closes a day }.
export function signalsAt(s, i, ctx = {}) {
  const bars = s.bars, b = bars[i], p = bars[i - 1], a = s.atr[i], di = s.dIdx[i];
  if (i < 130 || di < 55 || !(a > 0) || !s.ema50[i] || !s.dEma50[di]) return [];
  const dd = s.daily[di], up = dd.c > s.dEma50[di] && s.dEma20[di] > s.dEma50[di], down = dd.c < s.dEma50[di] && s.dEma20[di] < s.dEma50[di];
  const out = [], add = (setup, dir, stop) => {
    const dist = dir * (b.c - stop) / b.c;
    if (dist >= 0.01 && dist <= 0.15) out.push({ setup, dir, stop });
  };
  // 1. Trend pullback
  const lo6 = minOf(bars, i - 5, i, "l"), hi6 = maxOf(bars, i - 5, i, "h");
  let rsiLo = 100, rsiHi = 0;
  for (let k = i - 5; k <= i; k++) { rsiLo = Math.min(rsiLo, s.rsi[k] ?? 100); rsiHi = Math.max(rsiHi, s.rsi[k] ?? 0); }
  if (up && maxOf(bars, i - 59, i, "h") - lo6 >= 1.5 * a && lo6 <= s.ema50[i] * 1.01 && rsiLo < 45 && b.c > s.ema20[i] && b.c > p.h && b.c > b.o) add("pullback", 1, lo6 - 0.2 * a);
  if (down && hi6 - minOf(bars, i - 59, i, "l") >= 1.5 * a && hi6 >= s.ema50[i] * 0.99 && rsiHi > 55 && b.c < s.ema20[i] && b.c < p.l && b.c < b.o) add("pullback", -1, hi6 + 0.2 * a);
  // 2. 20-day breakout on volume
  const hi20 = maxOf(bars, i - 120, i - 1, "h"), lo20 = minOf(bars, i - 120, i - 1, "l"), volOk = s.qvAvg[i] > 0 && b.qv >= 1.5 * s.qvAvg[i];
  if (b.c > hi20 && p.c <= hi20 && volOk && dd.c > s.dEma50[di]) add("breakout", 1, b.c - 2.5 * a);
  if (b.c < lo20 && p.c >= lo20 && volOk && dd.c < s.dEma50[di]) add("breakout", -1, b.c + 2.5 * a);
  // 3. Flush reversal (needs open interest): in the last 7 candles a range of 3.5+ ATR that cut open interest by 5%+.
  //    High first then low = a long flush (buy the reclaim); low first then high = a short squeeze (sell the loss).
  const a6 = s.atr[i - 6], oi24 = oiChange(s, i, 6);
  if (a6 > 0 && oi24 != null && oi24 <= -0.05) {
    let hiK = i - 6, loK = i - 6;
    for (let k = i - 6; k <= i; k++) { if (bars[k].h >= bars[hiK].h) hiK = k; if (bars[k].l <= bars[loK].l) loK = k; }
    const top = bars[hiK].h, bottom = bars[loK].l, mid = (top + bottom) / 2;
    if (top - bottom >= 3.5 * a6) {
      if (hiK < loK && b.c > mid && b.c > b.o) add("flush", 1, bottom - 0.25 * a);
      if (loK < hiK && b.c < mid && b.c < b.o) add("flush", -1, top + 0.25 * a);
    }
  }
  // 4. Crowded fade (funding extreme, positions piling in, price stalling)
  const oi3 = oiChange(s, i, 18), ch3 = pct(bars[i - 18].c, b.c), f8 = s.fund8h[i], fp = s.fundPct[i];
  if (oi3 != null && oi3 >= 0.10 && f8 != null && fp != null && ch3 != null) {
    if (f8 >= 0.03 && fp >= 0.9 && ch3 >= -0.03 && ch3 <= 0.08 && b.c < s.ema20[i] && p.c >= s.ema20[i - 1]) add("crowded", -1, maxOf(bars, i - 11, i, "h") + 0.25 * a);
    if (f8 <= -0.01 && fp <= 0.1 && ch3 <= 0.03 && ch3 >= -0.08 && b.c > s.ema20[i] && p.c <= s.ema20[i - 1]) add("crowded", 1, minOf(bars, i - 11, i, "l") - 0.25 * a);
  }
  // 5. Relative strength, and the plain-trend benchmark: once a day, on the bar that closes the day
  if (ctx.dayClose) {
    const da = s.dAtr[di];
    if (da > 0) {
      if (ctx.rs && ctx.btcRegime === "up" && up && ctx.rs.rank <= 5) add("strength", 1, b.c - 2 * da);
      if (ctx.rs && ctx.btcRegime === "down" && down && ctx.rs.rank > ctx.rs.n - 5) add("strength", -1, b.c + 2 * da);
      if (up) add("trend", 1, b.c - 2 * da);
      if (down) add("trend", -1, b.c + 2 * da);
    }
  }
  return out;
}

// ───────────────────────────── exits and costs ─────────────────────────────
// tp = target in R (null = none), hold = max days, be = move the stop to entry after +be R, trail = trail at peak -
// trail x ATR(4h at entry) once +trailAfter R.
export const EXITS = {
  main: { label: "Target 2.5R or stop, max 10 days", tp: 2.5, hold: 10 },
  t2: { label: "Target 2R or stop, max 10 days", tp: 2, hold: 10 },
  t3: { label: "Target 3R or stop, max 14 days", tp: 3, hold: 14 },
  trail: { label: "Stop to break-even at +1R, then trail 2.5 ATR(4h) from +1.5R, max 20 days", tp: null, hold: 20, be: 1, trail: 2.5, trailAfter: 1.5 },
  time5: { label: "No target: stop, or sell after 5 days", tp: null, hold: 5 },
  wide: { label: "Target 4R or stop, max 14 days", tp: 4, hold: 14 },
};

// ───────────────────────────── A+ setups ─────────────────────────────
// A base setup plus the condition that decided it in the test, each with a reason. Found in the Oct 2026 research on
// Dec 2021 - Sep 2026 (filters picked on the years before 2025, then checked on 2025-26, which they never saw):
//   weakshort: a 20-day breakdown short made about 0R per trade when the coin was not in its own daily downtrend, and
//     about +0.5R when it was AND BTC was in a daily uptrend (the coin falls on its own: real weakness, not the market).
//     Positive in every year 2022-2026. With the wider 4R target: +0.99R before 2025, +0.65R in 2025-26.
//   squeeze: a 20-day breakout long made about 0R per trade with funding positive, and +0.52R / +0.22R with funding
//     negative (shorts crowded and paying: the breakout forces them out). 4R target: +0.74R / +0.47R.
// Both use the wider exit (4R, 14 days): a wider target did better for both in both periods.
export const APLUS = {
  weakshort: { setup: "breakout", dir: -1, exit: "wide", label: "Weak-coin breakdown short: a 20-day breakdown on volume while the coin is in its own daily downtrend and BTC is in a daily uptrend",
    test: (f) => f.btc === "up" && f.dTrend === "down" },
  squeeze: { setup: "breakout", dir: 1, exit: "wide", label: "Short-squeeze breakout long: a 20-day breakout on volume while funding is negative (shorts crowded and paying)",
    test: (f) => f.fund8h != null && f.fund8h < 0 },
};
// The A+ setup a base signal belongs to (its key), or null. f = features() at the signal's bar.
export const aplusOf = (sig, f) => Object.entries(APLUS).find(([, a]) => a.setup === sig.setup && a.dir === sig.dir && a.test(f || {}))?.[0] ?? null;
export const exitOf = (setup) => EXITS[APLUS[setup]?.exit || "main"];
// A very volatile coin (4h ATR 5%+ of the price) lost money in both periods across the setups.
export const WILD_ATR = 0.05;

const firstAfter = (rows, t) => { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= t) lo = m + 1; else hi = m; } return lo; };
// One trade. sig = { i (signal bar), dir, stop }. costPct = fee + slippage per side, in %. dataEnd = when the history
// ends: a coin whose candles stop earlier was delisted, and an open trade is closed at its last price (dropping it
// would hide the losses of coins that crashed and were delisted).
// Returns null when there is no next candle, or the trade is still open at the end of the history.
export function simulate(s, sig, rule = EXITS.main, costPct = 0.08, dataEnd = null) {
  const bars = s.bars, e = sig.i + 1;
  if (e >= bars.length) return null;
  const dir = sig.dir, entry = bars[e].o, t0 = bars[e].t, risk = dir * (entry - sig.stop);
  if (!(risk > 0)) return null;
  const a0 = s.atr[sig.i], target = rule.tp ? entry + dir * rule.tp * risk : null, end = t0 + rule.hold * DAY;
  let stop = sig.stop, peak = entry, exit = null, why = null, at = null, mfe = 0, mae = 0, open = true;
  for (let j = e; j < bars.length && open; j++) {
    const b = bars[j];
    if (j > e && b.t > bars[j - 1].t + 3 * H4) { exit = bars[j - 1].c; why = "data gap"; at = bars[j - 1].t + H4; break; } // missing candles (delisting, outage)
    const worst = dir > 0 ? b.l : b.h, best = dir > 0 ? b.h : b.l;
    mae = Math.min(mae, dir * (worst - entry) / risk); mfe = Math.max(mfe, dir * (best - entry) / risk);
    if (dir * (worst - stop) <= 0) { exit = dir * (b.o - stop) < 0 ? b.o : stop; why = dir * (stop - entry) >= 0 ? "trailing stop" : "stop"; at = b.t; break; }
    if (target != null && dir * (best - target) >= 0) { exit = target; why = "target"; at = b.t; break; }
    if (b.t + H4 >= end) { exit = b.c; why = "time"; at = b.t + H4; break; }
    // after the candle closes: break-even and trailing stop
    peak = dir > 0 ? Math.max(peak, b.h) : Math.min(peak, b.l);
    const gain = dir * (peak - entry) / risk;
    if (rule.be != null && gain >= rule.be) stop = dir > 0 ? Math.max(stop, entry) : Math.min(stop, entry);
    if (rule.trail != null && gain >= rule.trailAfter && a0 > 0) stop = dir > 0 ? Math.max(stop, peak - rule.trail * a0) : Math.min(stop, peak + rule.trail * a0);
    if (j === bars.length - 1) {
      open = false;
      if (dataEnd != null && b.t + H4 < dataEnd - DAY) { exit = b.c; why = "delisted"; at = b.t + H4; }
    }
  }
  if (exit == null) return null; // still open at the end of the history
  // Funding paid (-) or received (+) for every funding time the position was open
  let funding = 0;
  for (let k = firstAfter(s.funding, t0); k < s.funding.length && s.funding[k][0] <= at; k++) funding -= dir * s.funding[k][1] * 100;
  const gross = dir * (exit / entry - 1) * 100, riskPct = risk / entry * 100, net = gross - 2 * costPct + funding;
  return { sym: s.sym, dir, t: t0, exitT: at, entry, stop: sig.stop, exit, why, riskPct: +riskPct.toFixed(3), grossPct: +gross.toFixed(3),
    fundingPct: +funding.toFixed(3), netPct: +net.toFixed(3), r: +(net / riskPct).toFixed(3), mfeR: +mfe.toFixed(2), maeR: +mae.toFixed(2),
    days: +((at - t0) / DAY).toFixed(2) };
}

// ───────────────────────────── conditions and verdicts ─────────────────────────────
// Conditions known when a signal fires. The backtest reports each setup's result with and without them, older and
// newer period; the live tab uses the ones that helped (or hurt) in BOTH periods. t = { dir, f: features() }.
export const CONDITIONS = [
  ["BTC trend with the trade", (t) => t.f.btc === (t.dir > 0 ? "up" : "down")],
  ["BTC trend against the trade", (t) => t.f.btc === (t.dir > 0 ? "down" : "up")],
  ["Daily trend with the trade", (t) => t.f.dTrend === (t.dir > 0 ? "up" : "down")],
  ["Open interest rising (+3% in 24h)", (t) => t.f.oi24h >= 0.03],
  ["Open interest falling (-3% in 24h)", (t) => t.f.oi24h != null && t.f.oi24h <= -0.03],
  ["Crowd on the other side (funding against the trade)", (t) => t.f.fund8h != null && (t.dir > 0 ? t.f.fund8h < 0 : t.f.fund8h > 0.01)],
  ["Crowd on the same side (funding in its top/bottom 20%)", (t) => t.f.fundPct != null && (t.dir > 0 ? t.f.fundPct >= 0.8 : t.f.fundPct <= 0.2)],
  ["Top traders more on the trade's side than everyone", (t) => t.f.topVsAcc != null && (t.dir > 0 ? t.f.topVsAcc > 1.05 : t.f.topVsAcc < 0.95)],
  ["Volume 2x its average", (t) => t.f.vol >= 2],
  ["Coin strong vs BTC (top 10) / weak (bottom 10) for shorts", (t) => t.f.rs && (t.dir > 0 ? t.f.rs.rank <= 10 : t.f.rs.rank > t.f.rs.n - 10)],
  ["Very volatile coin (4h ATR 5%+ of the price)", (t) => t.f.atrPct >= WILD_ATR],
];
export const conditionsMet = (dir, f) => CONDITIONS.filter(([, fn]) => { try { return !!fn({ dir, f }); } catch { return false; } }).map(([name]) => name);

// TAKE / WAIT / SKIP for one signal, from its setup's tested record (a perps_report.json result) and the conditions
// met now. A condition counts only if it changed the setup's result by MARGIN R or more in both periods (smaller gaps
// are noise). TAKE = the setup made money in both periods AND a condition that helped is met AND none that hurt.
// SKIP = the setup lost money in either period, or 2+ conditions that hurt are met. Otherwise WAIT.
export const MARGIN_R = 0.05;
export function judge(setup, dir, f, record) {
  const side = dir > 0 ? "long" : "short", met = new Set(conditionsMet(dir, f));
  if (!record?.all?.trades) return { verdict: "WAIT", reasons: ["No backtest report yet: run node perps-backtest.js to give this setup a record"], plus: [], minus: [] };
  const o = record.older?.avgR, n = record.newer?.avgR, both = o > 0 && n > 0;
  const m = MARGIN_R - 1e-9; // R values are rounded to 0.01: 0.12 - 0.07 must count as 0.05
  const plus = (record.groups || []).filter((g) => g.holds === "better in both" && met.has(g.name) && g.olderR - o >= m && g.newerR - n >= m);
  const minus = (record.groups || []).filter((g) => g.holds === "worse in both" && met.has(g.name) && g.olderR - o <= -m && g.newerR - n <= -m);
  const reasons = [`Tested: ${record.all.trades} ${setup} ${side} trades, ${record.all.avgR >= 0 ? "+" : ""}${record.all.avgR}R per trade (before 2025 ${o ?? "—"}R, 2025-26 ${n ?? "—"}R), ${record.all.winRatePct}% won`];
  for (const g of plus) reasons.push(`Helps: ${g.name} (${g.olderR}R / ${g.newerR}R in those trades)`);
  for (const g of minus) reasons.push(`Hurts: ${g.name} (${g.olderR}R / ${g.newerR}R in those trades)`);
  let verdict;
  if (!both) { verdict = "SKIP"; reasons.push("This setup did not make money in both periods"); }
  else if (minus.length >= 2) verdict = "SKIP";
  else if (plus.length && !minus.length) verdict = "TAKE";
  else { verdict = "WAIT"; if (!plus.length) reasons.push("No condition that helped this setup in both periods is met now"); }
  return { verdict, reasons, plus: plus.map((g) => g.name), minus: minus.map((g) => g.name) };
}
// TAKE / WAIT for an A+ signal: TAKE when its own record holds (made money in both periods with its exit, enough trades,
// not from 2-3 coins) and the coin is not very volatile; WAIT otherwise. record = the A+ setup's result in perps_report.json.
export function judgeAplus(key, f, record) {
  const a = APLUS[key], side = a.dir > 0 ? "long" : "short";
  const reasons = [`A+ setup: ${a.label}`];
  if (!record?.all?.trades) return { verdict: "WAIT", reasons: [...reasons, "No backtest report with A+ setups yet: run node perps-backtest.js"], plus: [], minus: [] };
  const o = record.older?.avgR, n = record.newer?.avgR;
  reasons.push(`Tested: ${record.all.trades} ${side} trades, ${record.all.avgR >= 0 ? "+" : ""}${record.all.avgR}R per trade (before 2025 ${o ?? "—"}R, 2025-26 ${n ?? "—"}R), ${record.all.winRatePct}% won, exit: ${EXITS[a.exit].label}`);
  if (!(o > 0 && n > 0)) return { verdict: "WAIT", reasons: [...reasons, "This A+ setup did not make money in both periods in this report"], plus: [], minus: [] };
  if (record.ok === false) {
    const conc = [record.older, record.newer].some((x) => x?.top3SharePct > 60);
    return { verdict: "WAIT", reasons: [...reasons, `Not proven yet (${record.verdict})${conc ? ": in one period most of the profit came from 3 coins" : ""}`], plus: [], minus: [] };
  }
  if (f?.atrPct >= WILD_ATR) return { verdict: "WAIT", reasons: [...reasons, `Very volatile coin (4h ATR ${(f.atrPct * 100).toFixed(1)}% of the price): lost money in both periods across the setups`], plus: [], minus: ["Very volatile coin (4h ATR 5%+ of the price)"] };
  return { verdict: "TAKE", reasons, plus: [a.dir > 0 ? "Funding negative: shorts crowded" : "Coin in its own downtrend while BTC rises"], minus: [] };
}

// Price levels at the close of bar i, for "check a trade": the 20-day high / low, distances, ATR and EMAs.
export function levels(s, i) {
  const b = s.bars[i], a = s.atr[i], hi20 = maxOf(s.bars, i - 120, i - 1, "h"), lo20 = minOf(s.bars, i - 120, i - 1, "l");
  return { price: b.c, atr: a, atrPct: a ? +(a / b.c * 100).toFixed(2) : null, hi20, lo20, toHi20Pct: +((hi20 / b.c - 1) * 100).toFixed(2), toLo20Pct: +((lo20 / b.c - 1) * 100).toFixed(2),
    ema20: s.ema20[i], ema50: s.ema50[i], volVsAvg: s.qvAvg[i] > 0 ? +(b.qv / s.qvAvg[i]).toFixed(2) : null };
}

// ───────────────────────────── results ─────────────────────────────
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
export function summary(trades) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const rs = trades.map((t) => t.r), pos = rs.filter((x) => x > 0), neg = rs.filter((x) => x <= 0);
  const sorted = [...trades].sort((a, b) => a.exitT - b.exitT);
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const t of sorted) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); streak = t.r <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  const bySym = new Map();
  for (const t of trades) bySym.set(t.sym, (bySym.get(t.sym) || 0) + t.r);
  const total = rs.reduce((a, b) => a + b, 0), top3 = [...bySym.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { trades: n, winRatePct: Math.round((pos.length / n) * 100), targetPct: Math.round((trades.filter((t) => t.why === "target").length / n) * 100),
    avgR: r2(total / n), profitFactor: neg.length ? r2(pos.reduce((a, b) => a + b, 0) / Math.abs(neg.reduce((a, b) => a + b, 0) || 1e-9)) : pos.length ? 99 : null, // 99 = no losing trade
    totalR: r2(total, 1), maxDrawdownR: r2(dd, 1), worstLosingStreak: worst, avgNetPct: r2(avg(trades.map((t) => t.netPct))),
    avgFundingPct: r2(avg(trades.map((t) => t.fundingPct)), 3), avgDays: r2(avg(trades.map((t) => t.days)), 1), coins: bySym.size,
    top3SharePct: total > 0 ? Math.round((top3 / total) * 100) : null };
}
// The same trades taken as one account: at most maxOpen at a time (first come), each risking 1% (1R = 1%).
export function portfolio(trades, maxOpen = 5) {
  const sorted = [...trades].sort((a, b) => a.t - b.t), open = [], taken = [];
  for (const t of sorted) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exitT <= t.t) open.splice(k, 1);
    if (open.length >= maxOpen || open.some((o) => o.sym === t.sym)) continue;
    open.push(t); taken.push(t);
  }
  const s = summary(taken);
  return { maxOpen, taken: taken.length, skipped: trades.length - taken.length, returnPct: s.totalR, maxDrawdownPct: s.maxDrawdownR, avgR: s.avgR };
}
// A setup only "holds" when it made money in both the older and the newer period, with enough trades, not from 2-3 coins.
export function verdict(train, test) {
  if (!train.trades || !test.trades || train.trades + test.trades < 100 || test.trades < 30) return { verdict: "too few trades", ok: false };
  const good = (x) => x.avgR >= 0.05 && (x.profitFactor ?? 0) >= 1.15;
  const conc = (x) => x.top3SharePct != null && x.top3SharePct > 60;
  if (good(train) && good(test) && !conc(train) && !conc(test)) return { verdict: "holds", ok: true };
  if (test.avgR > 0 && train.avgR > 0) return { verdict: "weak: positive but thin", ok: false };
  if (good(test) || good(train)) return { verdict: "mixed: worked in one period only", ok: false };
  return { verdict: "fails", ok: false };
}

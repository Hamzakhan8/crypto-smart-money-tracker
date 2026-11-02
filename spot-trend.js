// Spot tab: the spot strategy that held up best in the test (spot-backtest.js, this same code): hold BTC and ETH, half
// each, but only while each one's daily close is above its 50-day average; otherwise that half waits in USDT.
// Decided once a day, a few minutes after the 00:00 UTC close. About 3 switches a month for the two coins together.
//
// Test, Jan 2021 - Oct 2026 on Binance daily candles, 0.15% cost per switch: +702% (43% a year), worst drop -56%,
// against +188% and -77% for simply holding BTC and ETH; ahead in both halves (2021-23 and 2024-26), and in every year
// but 2022 (-41%, holding lost about -65%). Rotating into strong altcoins, altcoin breakouts and dip buying all lost
// money over the same years (most altcoins kept falling against BTC). Research, not financial advice.
import { readFile, writeFile, rename } from "node:fs/promises";

const DAY = 86_400_000, MIN = 60_000;
const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
export const SPOT = Object.freeze({ coins: ["BTC", "ETH"], avgDays: num("SPOT_AVG_DAYS", 50), costPct: 0.15 });
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

// closes: daily closes, oldest first, all closed. The state after the last one: hold while above the average.
export function trendState(closes, n = SPOT.avgDays) {
  if (closes.length < n) return null;
  const last = closes[closes.length - 1];
  let s = 0; for (let j = closes.length - n; j < closes.length; j++) s += closes[j];
  const avg = s / n;
  return { hold: last > avg, close: last, avg, distPct: (last / avg - 1) * 100 };
}
// The strategy on aligned daily closes { BTC: [...], ETH: [...] } (same days), from day `from`: decide at each close, hold to
// the next, cost on each switch. Returns the equity curve and the switches.
export function simulate(series, { n = SPOT.avgDays, costPct = SPOT.costPct, from = n } = {}) {
  const coins = Object.keys(series), len = series[coins[0]].length, w = Object.fromEntries(coins.map((c) => [c, 0]));
  let eq = 1;
  const curve = [], switches = [];
  for (let d = Math.max(from, n - 1); d < len - 1; d++) {
    for (const c of coins) {
      const st = trendState(series[c].slice(d - n + 1, d + 1), n), tgt = st?.hold ? 1 / coins.length : 0;
      if (st && tgt !== w[c]) { eq *= 1 - Math.abs(tgt - w[c]) * (costPct / 100); w[c] = tgt; switches.push({ d, coin: c, hold: tgt > 0, close: st.close, avg: st.avg }); }
    }
    let r = 0; for (const c of coins) if (w[c] > 0) r += w[c] * (series[c][d + 1] / series[c][d] - 1);
    eq *= 1 + r;
    curve.push({ d: d + 1, eq, r });
  }
  return { curve, switches, weights: w };
}
// Summary numbers of an equity curve (daily steps).
export function curveStats(curve) {
  if (!curve.length) return null;
  let pk = 1, dd = 0;
  for (const x of curve) { pk = Math.max(pk, x.eq); dd = Math.max(dd, 1 - x.eq / pk); }
  const rs = curve.map((x) => x.r), m = rs.reduce((a, b) => a + b, 0) / rs.length, sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / rs.length), eq = curve.at(-1).eq;
  return { totalPct: r2((eq - 1) * 100, 1), perYearPct: r2((eq ** (365 / curve.length) - 1) * 100, 1), maxDrawdownPct: r2(dd * 100, 1), sharpe: sd > 0 ? r2((m / sd) * Math.sqrt(365), 2) : null };
}

const fmt = (v) => (!(v > 0) ? "—" : v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2));
// The live tab. fetchJson from the screener; base = Binance spot API. Prices come from the screener's scan (onTickers).
export function createSpot({ fetchJson, base, stateFile = null, reportFile = null, bundledReport = null, sendTelegram = null, wantTelegram = () => false,
  now = () => Date.now(), demo = false, p = SPOT, delayMin = 2 }) {
  base = String(base || "").replace(/\/$/, "");
  const st = { status: demo ? "off" : "starting", error: demo ? "The Spot tab uses live Binance data only (not in demo mode)" : null, updatedAt: null };
  let store = { version: 1, day: null, coins: {}, switches: [] }, report = null, busy = false, loaded = false, nextTry = 0;
  const prices = new Map();
  const save = () => (stateFile ? writeFile(stateFile + ".tmp", JSON.stringify(store)).then(() => rename(stateFile + ".tmp", stateFile)).catch(() => {}) : null);
  async function load() {
    if (loaded) return; loaded = true;
    try { const s = JSON.parse(await readFile(stateFile, "utf8")); if (s?.version === 1) store = s; } catch { /* first run */ }
    for (const [file, own] of [[reportFile, true], [bundledReport, false]]) {
      if (!file) continue;
      try { report = { ...JSON.parse(await readFile(file, "utf8")), own }; break; } catch { /* next */ }
    }
  }
  function onTickers(tickers) {
    for (const c of p.coins) { const px = Number(tickers.get(c)?.lastPrice); if (px > 0) prices.set(c, px); }
    tick();
  }
  function tick() {
    if (demo || busy) return;
    const t = now(), closed = Math.floor(t / DAY) * DAY - DAY;
    if (t - (closed + DAY) < delayMin * MIN || t < nextTry || (loaded && store.day === closed)) return;
    busy = true;
    run(closed).catch((e) => { st.error = e.message; st.status = st.updatedAt ? "ok" : "error"; nextTry = now() + 10 * MIN; }).finally(() => { busy = false; });
  }
  async function run(closed) {
    await load();
    if (store.day === closed) return;
    const fresh = [];
    for (const c of p.coins) {
      const k = (await fetchJson(`${base}/api/v3/klines?symbol=${c}USDT&interval=1d&limit=${p.avgDays + 30}`, { retries: 1, timeoutMs: 15_000 }))
        .map((x) => [Number(x[0]), Number(x[4])]).filter((x) => x[0] <= closed);
      if (!k.length || k.at(-1)[0] !== closed) throw new Error(`No daily candle for ${c} yet`);
      const s = trendState(k.map((x) => x[1]), p.avgDays);
      if (!s) throw new Error(`Not enough daily candles for ${c}`);
      const prev = store.coins[c], changed = !!prev && prev.hold !== s.hold;
      // since when: the first day of the current state within the candles read (null = longer than that)
      let since = null;
      for (let j = k.length - 2; j >= p.avgDays - 1; j--) { const sj = trendState(k.slice(0, j + 1).map((x) => x[1]), p.avgDays); if (sj.hold !== s.hold) { since = k[j + 1][0]; break; } }
      store.coins[c] = { hold: s.hold, close: s.close, avg: r2(s.avg, 6), distPct: r2(s.distPct, 2), day: closed, since };
      if (changed) { const x = { t: closed, coin: c, hold: s.hold, close: s.close, avg: r2(s.avg, 6) }; store.switches.unshift(x); fresh.push(x); }
    }
    store.switches = store.switches.slice(0, 200);
    store.day = closed;
    Object.assign(st, { status: "ok", error: null, updatedAt: now() });
    await save();
    if (fresh.length && sendTelegram && wantTelegram("spot")) sendTelegram(telegramText(fresh), "spot");
  }
  const planLine = () => p.coins.map((c) => `${c} ${store.coins[c]?.hold ? Math.round(100 / p.coins.length) + "%" : "0%"}`).join(", ") +
    `, USDT ${Math.round((100 * p.coins.filter((c) => !store.coins[c]?.hold).length) / p.coins.length)}%`;
  function telegramText(fresh) {
    const lines = fresh.map((x) => `${x.coin}: ${x.hold ? "BUY / HOLD" : "SELL to USDT"} (closed ${fmt(x.close)}, ${x.hold ? "above" : "below"} its ${p.avgDays}-day average ${fmt(x.avg)})`);
    return `SPOT PLAN (BTC + ETH trend)\n${lines.join("\n")}\nNow: ${planLine()}.\nRule: hold each coin only while its daily close is above its ${p.avgDays}-day average. Research signal only.`;
  }
  function api() {
    const coins = p.coins.map((c) => { const x = store.coins[c] || null, px = prices.get(c) ?? null;
      return { coin: c, ...(x || {}), price: px, nowVsAvgPct: px && x?.avg ? r2((px / x.avg - 1) * 100, 2) : null, weightPct: x?.hold ? Math.round(100 / p.coins.length) : 0 }; });
    return { ...st, rule: p, day: store.day, coins, plan: store.day != null ? planLine() : null, switches: store.switches.slice(0, 40),
      nextAt: store.day != null ? store.day + 2 * DAY + delayMin * MIN : null, report: report ? { ...report, curve: undefined } : null };
  }
  return { onTickers, tick, api, run, load, get store() { return store; } };
}

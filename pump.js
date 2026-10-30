// Pump watch (Ignition tab): once a day, after the daily close, the Binance spot coins that look most likely to make a
// big move up. The rule was found by testing every Binance USDT pair on daily candles (pump-backtest.js, same code):
//   the close is within 15% of its 90-day high, the day's volume is 2x+ its 20-day average, and the day rose less
//   than 15% (not already running), with at least $1M traded that day.
// About 7% of these rose +50% within 7 days, against about 3% of random coin-days: twice the odds, but most of them
// still do not pump. Plan tested: buy at the daily close, sell at +100% or -25%, else after 14 days. That made money
// on average while most coins in the market were up over 30 days ("market mood" 40%+) and lost money when they were
// not. One pick per coin per 14 days. Research signals, not financial advice.
import { readFile, writeFile, rename } from "node:fs/promises";

const DAY = 86_400_000, MIN = 60_000;
const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== "" && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
// The tested rule. Every number is a setting (PUMP_* in .env), but the test only speaks for these defaults.
export const PUMP = Object.freeze({
  nearHighPct: num("PUMP_NEAR_HIGH_PCT", 15),      // close within this % of its 90-day high
  minVolRatio: num("PUMP_MIN_VOLUME_RATIO", 2),    // the day's volume vs its 20-day average
  maxDayPct: num("PUMP_MAX_DAY_PCT", 15),          // the day rose less than this (else it is already running)
  minQuoteVolume: num("PUMP_MIN_QUOTE_VOLUME", 1e6), // USDT traded that day
  targetPct: 100, stopPct: 25, days: 14,           // the tested exit
  gapDays: 14,                                     // one pick per coin per 14 days
  moodMin: num("PUMP_MOOD_MIN", 40),               // % of coins up over 30 days; under it the test lost money
  costPct: 0.3,                                    // fees + slippage per trade, in and out
  minHistory: 60,                                  // days of candles a coin needs
});
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

// Daily candles as rows [openTime, open, high, low, close, quoteVolume], oldest first, all closed.
export const rowsOf = (klines) => klines.map((c) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[7])]);

// What the rule looks at, on the candle i (no data after it).
export function pumpFeatures(k, i, p = PUMP) {
  if (i < p.minHistory || i >= k.length) return null;
  let avg20 = 0; for (let j = i - 20; j < i; j++) avg20 += k[j][5]; avg20 /= 20;
  let hi90 = -Infinity; for (let j = Math.max(0, i - 89); j <= i; j++) hi90 = Math.max(hi90, k[j][2]);
  let hi20 = -Infinity, lo20 = Infinity; for (let j = i - 19; j <= i; j++) { hi20 = Math.max(hi20, k[j][2]); lo20 = Math.min(lo20, k[j][3]); }
  const close = k[i][4];
  return {
    t: k[i][0], close, qv: k[i][5], avg20, volRatio: avg20 > 0 ? k[i][5] / avg20 : null,
    dayPct: (close / k[i - 1][4] - 1) * 100, r30Pct: (close / k[i - 30][4] - 1) * 100,
    fromHigh90Pct: (close / hi90 - 1) * 100, hi90,
    pegged: lo20 > 0 && hi20 / lo20 - 1 < 0.03, // a coin that stayed within 3% for 20 days (a stablecoin, whatever its name)
  };
}
// Does the candle pass? miss = what is missing, in plain words.
export function pumpCheck(f, p = PUMP) {
  if (!f) return { ok: false, miss: ["not enough daily history"] };
  const miss = [];
  if (!(f.qv >= p.minQuoteVolume)) miss.push(`$${(p.minQuoteVolume / 1e6).toFixed(1)}M+ traded that day`);
  if (f.pegged) miss.push("a price that moves (it stayed within 3% for 20 days)");
  if (!(f.fromHigh90Pct > -p.nearHighPct)) miss.push(`a close within ${p.nearHighPct}% of its 90-day high (${f.fromHigh90Pct.toFixed(0)}%)`);
  if (!(f.volRatio >= p.minVolRatio)) miss.push(`volume ${p.minVolRatio}x+ its 20-day average (${f.volRatio == null ? "n/a" : f.volRatio.toFixed(1) + "x"})`);
  if (!(f.dayPct < p.maxDayPct)) miss.push(`a day up less than ${p.maxDayPct}% (it rose ${f.dayPct.toFixed(0)}%: already running)`);
  return { ok: !miss.length, miss };
}
// The tested exit, on daily candles after the entry candle i: target or stop (a day that touches both = the stop),
// else the close after `days` days. done = false while the window is still open (live picks).
export function pumpTrade(k, i, p = PUMP) {
  const entry = k[i][4], up = entry * (1 + p.targetPct / 100), dn = entry * (1 - p.stopPct / 100);
  let peak = entry, low = entry;
  const last = Math.min(i + p.days, k.length - 1);
  for (let j = i + 1; j <= last; j++) {
    peak = Math.max(peak, k[j][2]); low = Math.min(low, k[j][3]);
    const out = (why, pct) => ({ done: true, why, pct, days: j - i, exitT: k[j][0] + DAY, peakPct: (peak / entry - 1) * 100, lowPct: (low / entry - 1) * 100 });
    if (k[j][3] <= dn) return out("stop", -p.stopPct);
    if (k[j][2] >= up) return out("target", p.targetPct);
  }
  const days = last - i, pct = (k[last][4] / entry - 1) * 100;
  return { done: days >= p.days, why: days >= p.days ? "time" : "open", pct, days, exitT: days >= p.days ? k[last][0] + DAY : null,
    peakPct: (peak / entry - 1) * 100, lowPct: (low / entry - 1) * 100 };
}
// Market mood: the share of coins (with $1M+ traded) whose price is up over 30 days.
export function marketMood(features, p = PUMP) {
  const s = features.filter((f) => f && !f.pegged && f.qv >= p.minQuoteVolume && Number.isFinite(f.r30Pct));
  if (!s.length) return null;
  const share = (s.filter((f) => f.r30Pct > 0).length / s.length) * 100;
  return { share: r2(share, 0), coins: s.length, ok: share >= p.moodMin };
}

const fmtPx = (v) => (!(v > 0) ? "—" : v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));
const sgn = (v, d = 1) => (v == null ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(d) + "%");
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

// The live list. fetchJson and the coin list come from the screener (onTickers is called on every scan).
export function createPump({ fetchJson, base, stateFile = null, reportFile = null, bundledReport = null, sendTelegram = null,
  wantTelegram = () => false, now = () => Date.now(), excluded = () => false, demo = false, p = PUMP, delayMin = 3 }) {
  base = String(base || "").replace(/\/$/, "");
  const st = { status: demo ? "off" : "starting", error: demo ? "Pump watch uses live Binance data only (not in demo mode)" : null, updatedAt: null, day: null, scanned: 0, mood: null, scanMs: null };
  let store = { version: 1, day: null, mood: null, picks: [] }, report = null, bases = [], prices = new Map(), busy = false, loaded = false, nextTry = 0;
  const save = () => (stateFile ? writeFile(stateFile + ".tmp", JSON.stringify(store)).then(() => rename(stateFile + ".tmp", stateFile)).catch(() => {}) : null);
  async function load() {
    if (loaded) return; loaded = true;
    try { const s = JSON.parse(await readFile(stateFile, "utf8")); if (s?.version === 1) store = s; } catch { /* first run */ }
    for (const [file, own] of [[reportFile, true], [bundledReport, false]]) {
      if (!file) continue;
      try { report = { ...JSON.parse(await readFile(file, "utf8")), own }; break; } catch { /* next */ }
    }
  }
  const klines = async (b) => rowsOf(await fetchJson(`${base}/api/v3/klines?symbol=${encodeURIComponent(b)}USDT&interval=1d&limit=100`, { retries: 1, timeoutMs: 15_000 }));
  async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }

  // From the screener's 24h tickers: the coins to look at (USDT pairs with $0.5M+ in 24h) and their live prices.
  function onTickers(tickers) {
    const list = [];
    for (const [b, tk] of tickers) {
      const px = Number(tk.lastPrice);
      if (px > 0) prices.set(b, px);
      if (Number(tk.quoteVolume) >= p.minQuoteVolume / 2 && !excluded(b)) list.push(b);
    }
    bases = list;
    tick();
  }
  // Runs the daily job once per UTC day, a few minutes after the close (and at start for the last closed day).
  function tick() {
    if (demo || busy || !bases.length) return;
    const t = now(), closed = Math.floor(t / DAY) * DAY - DAY; // open time of the last closed daily candle
    if (t - (closed + DAY) < delayMin * MIN || t < nextTry) return;
    if (loaded && store.day === closed) return;
    busy = true;
    run(closed).catch((e) => { st.error = e.message; nextTry = now() + 10 * MIN; }).finally(() => { busy = false; });
  }
  async function run(closed) {
    await load();
    if (store.day === closed) return;
    const t0 = now(), seen = new Map(), feats = [];
    const want = [...new Set([...bases, ...store.picks.filter((x) => x.status === "open").map((x) => x.base)])];
    let failed = 0;
    await pool(want, 4, async (b) => {
      try {
        const k = (await klines(b)).filter((r) => r[0] <= closed);
        if (!k.length || k.at(-1)[0] !== closed) return; // no candle for that day (delisted or paused)
        seen.set(b, k);
        if (bases.includes(b)) feats.push([b, pumpFeatures(k, k.length - 1, p)]);
      } catch { failed++; }
    });
    if (want.length && failed > want.length / 2) throw new Error(`Daily candles failed for ${failed}/${want.length} coins; retrying in 10 min`);
    // follow the open picks with the tested exit
    for (const x of store.picks) {
      if (x.status !== "open") continue;
      const k = seen.get(x.base), i = k ? k.findIndex((r) => r[0] === x.t) : -1;
      if (i < 0) { if (closed - x.t > (p.days + 3) * DAY) { x.status = "closed"; x.why = "no data"; x.pct = null; } continue; }
      const r = pumpTrade(k, i, p);
      Object.assign(x, { peakPct: r2(r.peakPct, 1), lowPct: r2(r.lowPct, 1), daysHeld: r.days });
      if (r.done) Object.assign(x, { status: "closed", why: r.why, pct: r2(r.pct, 1), netPct: r2(r.pct - p.costPct, 1), exitT: r.exitT });
    }
    const mood = marketMood(feats.map(([, f]) => f), p);
    const lastPick = new Map(); for (const x of store.picks) lastPick.set(x.base, Math.max(lastPick.get(x.base) || 0, x.t));
    const fresh = feats.filter(([b, f]) => pumpCheck(f, p).ok && closed - (lastPick.get(b) ?? -Infinity) >= p.gapDays * DAY)
      .sort((a, b) => b[1].volRatio - a[1].volRatio)
      .map(([b, f]) => ({ id: `pump-${b}-${dayOf(closed)}`, base: b, symbol: b + "USDT", t: closed, entry: f.close, qv: Math.round(f.qv),
        volRatio: r2(f.volRatio, 1), dayPct: r2(f.dayPct, 1), fromHigh90Pct: r2(f.fromHigh90Pct, 1), r30Pct: r2(f.r30Pct, 0),
        target: f.close * (1 + p.targetPct / 100), stop: f.close * (1 - p.stopPct / 100), moodShare: mood?.share ?? null, moodOk: mood?.ok ?? null,
        status: "open", peakPct: 0, lowPct: 0, daysHeld: 0 }));
    store.picks = [...fresh, ...store.picks].slice(0, 400);
    store.day = closed; store.mood = mood;
    Object.assign(st, { status: "ok", error: null, updatedAt: now(), day: closed, scanned: feats.length, mood, scanMs: now() - t0 });
    await save();
    if (fresh.length && sendTelegram && wantTelegram("pump")) sendTelegram(telegramText(fresh, mood), "pump");
  }
  function telegramText(fresh, mood) {
    const lines = fresh.slice(0, 8).map((x) => `${x.symbol} ${fmtPx(x.entry)}: volume ${x.volRatio}x, ${Math.abs(x.fromHigh90Pct).toFixed(0)}% under its 90-day high, day ${sgn(x.dayPct, 0)}`);
    const more = fresh.length > 8 ? `\n...and ${fresh.length - 8} more on the page` : "";
    const moodLine = mood ? (mood.ok ? `Market mood ${mood.share}% (coins up over 30 days): OK` : `Market mood ${mood.share}% (coins up over 30 days): WEAK. In the test these lost money when under ${p.moodMin}%: skip or go very small.`) : "";
    return `PUMP WATCH ${dayOf(fresh[0].t)}: ${fresh.length} coin${fresh.length > 1 ? "s" : ""} near the 90-day high on 2x+ volume\n${lines.join("\n")}${more}\n${moodLine}\n` +
      `Tested plan: buy near the daily close, sell at +${p.targetPct}% or -${p.stopPct}%, else after ${p.days} days. Most do not pump (about 7% rose +50% in a week). Research signal only.`;
  }
  // The live record of closed picks, after costs, split by market mood.
  function record() {
    const done = store.picks.filter((x) => x.status === "closed" && x.netPct != null);
    const sum = (s) => (s.length ? { n: s.length, avgPct: r2(s.reduce((a, x) => a + x.netPct, 0) / s.length, 1), winPct: r2((s.filter((x) => x.netPct > 0).length / s.length) * 100, 0),
      targets: s.filter((x) => x.why === "target").length, stops: s.filter((x) => x.why === "stop").length } : { n: 0 });
    return { all: sum(done), moodOk: sum(done.filter((x) => x.moodOk)), moodWeak: sum(done.filter((x) => x.moodOk === false)) };
  }
  const withNow = (x) => { const px = prices.get(x.base); return { ...x, price: px ?? null, nowPct: px ? r2((px / x.entry - 1) * 100, 1) : null }; };
  function api() {
    const today = store.picks.filter((x) => x.t === store.day).map(withNow);
    const open = store.picks.filter((x) => x.status === "open" && x.t !== store.day).map(withNow);
    const nextAt = store.day != null ? store.day + 2 * DAY + delayMin * MIN : null;
    return { ...st, rule: p, day: store.day, mood: store.mood, nextAt, today, open, closed: store.picks.filter((x) => x.status === "closed").slice(0, 40), record: record(),
      report: report ? { own: report.own, generatedAt: report.generatedAt, from: report.from, to: report.to, coins: report.coins, random: report.random, watch: report.watch,
        moodOk: report.moodOk, moodWeak: report.moodWeak, periods: report.periods, foundOn: report.foundOn, older: report.older } : null };
  }
  return { onTickers, tick, api, run, load, get store() { return store; } };
}

// Pump watch (Ignition tab): once a day, after the daily close, the Binance spot coins that look most likely to make a
// big move up. The rule was found by testing every Binance USDT pair on daily candles (pump-backtest.js, same code):
//   the close is within 15% of its 90-day high, the day's volume is 2x+ its 20-day average, and the day rose less
//   than 15% (not already running), with at least $1M traded that day.
// About 7% of these rose +50% within 7 days, against about 3% of random coin-days: twice the odds, but most of them
// still do not pump. Plan tested: buy at the daily close, sell at +100% or -25%, else after 14 days. That made money
// on average while most coins in the market were up over 30 days ("market mood" 40%+) and lost money when they were
// not. One pick per coin per 14 days. Research signals, not financial advice.
import { readFile } from "node:fs/promises";
import { fmtPx, num, pool, r2, writeAtomic } from "./util.ts";

const DAY = 86_400_000, MIN = 60_000;
const env = process.env;

/** The screener's fetchJson: raw JSON from Binance. */
type FetchJson = (url: string, opts?: { retries?: number; timeoutMs?: number }) => Promise<any>;
/** A Binance kline: [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]. */
type Kline = (number | string)[];
/** The fields used from the screener's 24h tickers. */
interface Ticker { lastPrice?: string; quoteVolume?: string }
export interface PumpRule {
  nearHighPct: number; minVolRatio: number; maxDayPct: number; minQuoteVolume: number; targetPct: number; stopPct: number; days: number;
  gapDays: number; moodMin: number; costPct: number; minHistory: number;
}
/** A pick on the list, followed with the tested exit (saved in pump_state.json). */
export interface PumpPick {
  id: string; base: string; symbol: string; t: number; entry: number; qv: number; volRatio: number | null; dayPct: number | null;
  fromHigh90Pct: number | null; r30Pct: number | null; target: number; stop: number; moodShare: number | null; moodOk: boolean | null;
  status: string; peakPct: number | null; lowPct: number | null; daysHeld: number; why?: string; pct?: number | null; netPct?: number | null; exitT?: number | null;
}
/** Saved in pump_state.json. */
interface PumpStore { version: number; day: number | null; mood: Mood | null; picks: PumpPick[]; updatedAt?: number; scanned?: number }
export interface PumpOptions {
  fetchJson: FetchJson; base: string; stateFile?: string | null; reportFile?: string | null; bundledReport?: string | null;
  sendTelegram?: ((text: string, kind: string) => unknown) | null; wantTelegram?: (kind: string) => boolean; now?: () => number;
  excluded?: (base: string) => boolean; demo?: boolean; p?: Readonly<PumpRule>; delayMin?: number;
  heldTelegram?: (kind: string, text: string, reason: string) => void;
}
// The tested rule. Every number is a setting (PUMP_* in .env), but the test only speaks for these defaults.
export const PUMP: Readonly<PumpRule> = Object.freeze({
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

// Daily candles as rows [openTime, open, high, low, close, quoteVolume], oldest first, all closed.
export const rowsOf = (klines: Kline[]): number[][] => klines.map((c) => [Number(c[0]), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4]), Number(c[7])]);

// What the rule looks at, on the candle i (no data after it).
export function pumpFeatures(k: number[][], i: number, p = PUMP) {
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
export type PumpFeatures = NonNullable<ReturnType<typeof pumpFeatures>>;
// Does the candle pass? miss = what is missing, in plain words.
export function pumpCheck(f: PumpFeatures | null, p = PUMP): { ok: boolean; miss: string[] } {
  if (!f) return { ok: false, miss: ["not enough daily history"] };
  const miss: string[] = [];
  if (!(f.qv >= p.minQuoteVolume)) miss.push(`$${(p.minQuoteVolume / 1e6).toFixed(1)}M+ traded that day`);
  if (f.pegged) miss.push("a price that moves (it stayed within 3% for 20 days)");
  if (!(f.fromHigh90Pct > -p.nearHighPct)) miss.push(`a close within ${p.nearHighPct}% of its 90-day high (${f.fromHigh90Pct.toFixed(0)}%)`);
  if (!(f.volRatio >= p.minVolRatio)) miss.push(`volume ${p.minVolRatio}x+ its 20-day average (${f.volRatio == null ? "n/a" : f.volRatio.toFixed(1) + "x"})`);
  if (!(f.dayPct < p.maxDayPct)) miss.push(`a day up less than ${p.maxDayPct}% (it rose ${f.dayPct.toFixed(0)}%: already running)`);
  return { ok: !miss.length, miss };
}
// The tested exit, on daily candles after the entry candle i: target or stop (a day that touches both = the stop),
// else the close after `days` days. done = false while the window is still open (live picks).
export function pumpTrade(k: number[][], i: number, p = PUMP) {
  const entry = k[i][4], up = entry * (1 + p.targetPct / 100), dn = entry * (1 - p.stopPct / 100);
  let peak = entry, low = entry;
  const last = Math.min(i + p.days, k.length - 1);
  for (let j = i + 1; j <= last; j++) {
    peak = Math.max(peak, k[j][2]); low = Math.min(low, k[j][3]);
    const out = (why: string, pct: number) => ({ done: true, why, pct, days: j - i, exitT: k[j][0] + DAY, peakPct: (peak / entry - 1) * 100, lowPct: (low / entry - 1) * 100 });
    if (k[j][3] <= dn) return out("stop", -p.stopPct);
    if (k[j][2] >= up) return out("target", p.targetPct);
  }
  const days = last - i, pct = (k[last][4] / entry - 1) * 100;
  return { done: days >= p.days, why: days >= p.days ? "time" : "open", pct, days, exitT: days >= p.days ? k[last][0] + DAY : null,
    peakPct: (peak / entry - 1) * 100, lowPct: (low / entry - 1) * 100 };
}
// Market mood: the share of coins (with $1M+ traded) whose price is up over 30 days.
export function marketMood(features: (Pick<PumpFeatures, "r30Pct" | "qv" | "pegged"> | null)[], p = PUMP) {
  const s = features.filter((f) => f && !f.pegged && f.qv >= p.minQuoteVolume && Number.isFinite(f.r30Pct));
  if (!s.length) return null;
  const share = (s.filter((f) => f.r30Pct > 0).length / s.length) * 100;
  return { share: r2(share, 0), coins: s.length, ok: share >= p.moodMin };
}
export type Mood = NonNullable<ReturnType<typeof marketMood>>;

const sgn = (v: number | null, d = 1) => (v == null ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(d) + "%");
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

// The live list. fetchJson and the coin list come from the screener (onTickers is called on every scan).
export function createPump({ fetchJson, base, stateFile = null, reportFile = null, bundledReport = null, sendTelegram = null,
  wantTelegram = () => false, now = () => Date.now(), excluded = () => false, demo = false, p = PUMP, delayMin = 3, heldTelegram = () => {} }: PumpOptions) {
  base = String(base || "").replace(/\/$/, "");
  const st: { status: string; error: string | null; updatedAt: number | null; day: number | null; scanned: number; mood: Mood | null; scanMs: number | null } = { status: demo ? "off" : "starting", error: demo ? "Pump watch uses live Binance data only (not in demo mode)" : null, updatedAt: null, day: null, scanned: 0, mood: null, scanMs: null };
  let store: PumpStore = { version: 1, day: null, mood: null, picks: [] }, report: ({ own: boolean } & Record<string, unknown>) | null = null;
  let bases: string[] = [], prices = new Map<string, number>(), busy = false, loaded = false, nextTry = 0;
  const save = () => (stateFile ? writeAtomic(stateFile, JSON.stringify(store)).catch(() => {}) : null);
  async function load() {
    if (loaded) return; loaded = true;
    try { const s = JSON.parse(await readFile(stateFile, "utf8")); if (s?.version === 1) store = s; } catch { /* first run */ }
    for (const [file, own] of [[reportFile, true], [bundledReport, false]] as const) {
      if (!file) continue;
      try { report = { ...JSON.parse(await readFile(file, "utf8")), own }; break; } catch { /* next */ }
    }
  }
  const klines = async (b: string) => rowsOf(await fetchJson(`${base}/api/v3/klines?symbol=${encodeURIComponent(b)}USDT&interval=1d&limit=100`, { retries: 1, timeoutMs: 15_000 }));

  // From the screener's 24h tickers: the coins to look at (USDT pairs with $0.5M+ in 24h) and their live prices.
  function onTickers(tickers: Map<string, Ticker>) {
    const list: string[] = [];
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
    if (loaded && store.day === closed && st.updatedAt) return;
    busy = true;
    run(closed).catch((e) => { st.error = e.message; nextTry = now() + 10 * MIN; }).finally(() => { busy = false; });
  }
  async function run(closed: number) {
    await load();
    // today's list was already made (before a restart): ready, with the time it was made
    if (store.day === closed) { Object.assign(st, { status: "ok", error: null, updatedAt: store.updatedAt ?? closed + DAY + delayMin * MIN, day: closed, scanned: store.scanned ?? 0, mood: store.mood }); return; }
    const t0 = now(), seen = new Map<string, number[][]>(), feats: [string, PumpFeatures | null][] = [];
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
    const lastPick = new Map<string, number>(); for (const x of store.picks) lastPick.set(x.base, Math.max(lastPick.get(x.base) || 0, x.t));
    const fresh = feats.filter(([b, f]) => pumpCheck(f, p).ok && closed - (lastPick.get(b) ?? -Infinity) >= p.gapDays * DAY)
      .sort((a, b) => b[1].volRatio - a[1].volRatio)
      .map(([b, f]): PumpPick => ({ id: `pump-${b}-${dayOf(closed)}`, base: b, symbol: b + "USDT", t: closed, entry: f.close, qv: Math.round(f.qv),
        volRatio: r2(f.volRatio, 1), dayPct: r2(f.dayPct, 1), fromHigh90Pct: r2(f.fromHigh90Pct, 1), r30Pct: r2(f.r30Pct, 0),
        target: f.close * (1 + p.targetPct / 100), stop: f.close * (1 - p.stopPct / 100), moodShare: mood?.share ?? null, moodOk: mood?.ok ?? null,
        status: "open", peakPct: 0, lowPct: 0, daysHeld: 0 }));
    store.picks = [...fresh, ...store.picks].slice(0, 400);
    store.day = closed; store.mood = mood; store.updatedAt = now(); store.scanned = feats.length;
    Object.assign(st, { status: "ok", error: null, updatedAt: store.updatedAt, day: closed, scanned: feats.length, mood, scanMs: now() - t0 });
    await save();
    // Telegram only when the market mood is OK (PUMP_TELEGRAM=all: always): under it, picks barely made money in the test
    if (fresh.length && sendTelegram && wantTelegram("pump") && (mood?.ok || env.PUMP_TELEGRAM === "all")) sendTelegram(telegramText(fresh, mood), "pump");
    else if (fresh.length && !(mood?.ok || env.PUMP_TELEGRAM === "all")) heldTelegram("pump", `PUMP WATCH: ${fresh.length} new pick(s): ${fresh.slice(0, 5).map((x) => x.base).join(", ")}`, `not sent: market mood is WEAK (${mood?.share != null ? Math.round(mood.share) + "% of coins up over 30 days, " : ""}picks barely made money then; PUMP_TELEGRAM=all sends anyway)`);
  }
  function telegramText(fresh: PumpPick[], mood: Mood | null) {
    const lines = fresh.slice(0, 8).map((x) => `${x.symbol} ${fmtPx(x.entry)}: volume ${x.volRatio}x, ${Math.abs(x.fromHigh90Pct).toFixed(0)}% under its 90-day high, day ${sgn(x.dayPct, 0)}`);
    const more = fresh.length > 8 ? `\n...and ${fresh.length - 8} more on the page` : "";
    const moodLine = mood ? (mood.ok ? `Market mood ${mood.share}% (coins up over 30 days): OK` : `Market mood ${mood.share}% (coins up over 30 days): WEAK. In the test these lost money when under ${p.moodMin}%: skip or go very small.`) : "";
    return `PUMP WATCH ${dayOf(fresh[0].t)}: ${fresh.length} coin${fresh.length > 1 ? "s" : ""} near the 90-day high on 2x+ volume\n${lines.join("\n")}${more}\n${moodLine}\n` +
      `Tested plan: buy near the daily close, sell at +${p.targetPct}% or -${p.stopPct}%, else after ${p.days} days. Most do not pump (about 7% rose +50% in a week). Research signal only.`;
  }
  // The live record of closed picks, after costs, split by market mood.
  function record() {
    const done = store.picks.filter((x) => x.status === "closed" && x.netPct != null);
    const sum = (s: PumpPick[]) => (s.length ? { n: s.length, avgPct: r2(s.reduce((a, x) => a + x.netPct, 0) / s.length, 1), winPct: r2((s.filter((x) => x.netPct > 0).length / s.length) * 100, 0),
      targets: s.filter((x) => x.why === "target").length, stops: s.filter((x) => x.why === "stop").length } : { n: 0 });
    return { all: sum(done), moodOk: sum(done.filter((x) => x.moodOk)), moodWeak: sum(done.filter((x) => x.moodOk === false)) };
  }
  const withNow = (x: PumpPick) => { const px = prices.get(x.base); return { ...x, price: px ?? null, nowPct: px ? r2((px / x.entry - 1) * 100, 1) : null }; };
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

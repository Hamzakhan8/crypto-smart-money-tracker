// BTC-regime narrative rotation: backtest + live screener. Node.js 18+, no dependencies.
// Used by screener.js (the "BTC rotation" tab, /api/rotation) and by rotation-backtest.js (command-line report).
//
// Idea: altcoin narratives behave differently depending on what Bitcoin is doing. Every day, BTC's daily price action
// is put into one of six regimes. Each narrative is an equal-weight index of its biggest Binance-listed coins. Over the
// past history the module measures how every narrative did over the next 7 days compared with BTC, per regime.
// Narratives are Binance's own sector tags (AI, Meme, RWA ...), so only Binance data is used and no API key is needed.
// The live ranking combines that history (50%) with current price action: 14-day strength vs BTC (30%) and the share of
// the narrative's coins above their 20-day average (20%). The same ranking is backtested week by week; at each week it
// only uses regime statistics from weeks that had already finished (no look-ahead).
//
// Known biases (also shown on the page): narrative membership and Binance listings are as of today, so coins that died
// or were delisted are missing, and coins that joined a narrative later count for the whole history. Both make the
// narratives look better than they really were. A few years of data give only a few dozen independent weeks per regime.
// Research tool, not financial advice.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DAY = 86_400_000;
const BN = "https://api.binance.com";

export const REGIMES = {
  breakout: { label: "BTC breaking out", desc: "BTC is up 8% or more over 7 days and at a 30-day high.", riskOff: false },
  calmUp: { label: "BTC uptrend, calm", desc: "BTC is above rising 20- and 50-day averages, moved less than 4% this week, and its volatility is shrinking.", riskOff: false },
  up: { label: "BTC uptrend", desc: "BTC is above its 50-day average and its 20-day average is rising.", riskOff: false },
  range: { label: "BTC sideways", desc: "BTC is not trending clearly either way.", riskOff: false },
  down: { label: "BTC downtrend", desc: "BTC is below its 50-day average and its 20-day average is falling.", riskOff: true },
  dump: { label: "BTC falling hard", desc: "BTC is down 8% or more over 7 days.", riskOff: true },
};
export const REGIME_KEYS = Object.keys(REGIMES);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

function sma(a, i, len) {
  if (i < len - 1) return NaN;
  let s = 0;
  for (let j = i - len + 1; j <= i; j++) { const v = a[j]; if (!(v > 0)) return NaN; s += v; }
  return s / len;
}
function sdReturns(c, i, len) {
  const r = [];
  for (let j = i - len + 1; j <= i; j++) r.push(c[j] / c[j - 1] - 1);
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / r.length) * 100;
}

// ───────────────────────────── signals (pure) ─────────────────────────────
// BTC daily price action at day i (closed daily closes).
export function btcFeatures(c, i) {
  if (i < 61 || !(c[i] > 0) || !(c[i - 61] > 0)) return null;
  const close = c[i], sma20 = sma(c, i, 20), sma50 = sma(c, i, 50), sma20prev = sma(c, i - 5, 20);
  let high30 = -Infinity;
  for (let j = i - 29; j <= i; j++) high30 = Math.max(high30, c[j]);
  return {
    close, sma20, sma50, slope20: (sma20 / sma20prev - 1) * 100,
    ret7: (close / c[i - 7] - 1) * 100, ret30: (close / c[i - 30] - 1) * 100,
    distHigh30: (close / high30 - 1) * 100, vol14: sdReturns(c, i, 14), vol60: sdReturns(c, i, 60),
  };
}
export function classifyRegime(f) {
  if (!f) return null;
  if (f.ret7 <= -8) return "dump";
  if (f.ret7 >= 8 && f.distHigh30 >= -2) return "breakout";
  if (f.close < f.sma50 && f.slope20 < 0) return "down";
  if (f.close > f.sma20 && f.sma20 > f.sma50 && f.slope20 > 0 && Math.abs(f.ret7) < 4 && f.vol14 < f.vol60) return "calmUp";
  if (f.close > f.sma50 && f.slope20 > 0) return "up";
  return "range";
}

// Equal-weight daily-rebalanced index (starts at 100 once 3 members trade; daily moves clipped at ±50%).
export function narrativeIndex(closes, n, minMembers = 3) {
  const idx = new Float64Array(n).fill(NaN);
  let level = NaN;
  for (let i = 1; i < n; i++) {
    let s = 0, k = 0;
    for (const c of closes) { const a = c[i - 1], b = c[i]; if (a > 0 && b > 0) { s += clamp(b / a - 1, -0.5, 0.5); k++; } }
    if (!Number.isFinite(level)) { if (k >= minMembers) level = 100; }
    else if (k > 0) level *= 1 + s / k;
    if (Number.isFinite(level)) idx[i] = level;
  }
  return idx;
}

// Daily price-action score for one coin (0-100): trend, strength vs BTC, near its highs, not stretched, volume rising.
export function tokenSignal(c, qv, btc, i) {
  if (i < 50 || !(c[i] > 0) || !(c[i - 50] > 0) || !(btc[i - 14] > 0)) return null;
  const close = c[i], s20 = sma(c, i, 20), s50 = sma(c, i, 50), s20p = sma(c, i - 5, 20);
  if (!Number.isFinite(s20) || !Number.isFinite(s50) || !Number.isFinite(s20p)) return null;
  const rs14 = ((close / c[i - 14] - 1) - (btc[i] / btc[i - 14] - 1)) * 100;
  let hi30 = -Infinity, v7 = 0, k7 = 0, v30 = 0, k30 = 0;
  for (let j = i - 29; j <= i; j++) {
    hi30 = Math.max(hi30, c[j]);
    if (Number.isFinite(qv[j])) { v30 += qv[j]; k30++; if (j > i - 7) { v7 += qv[j]; k7++; } }
  }
  const distHigh = (close / hi30 - 1) * 100, ext = (close / s20 - 1) * 100;
  const volTrend = k7 && k30 && v30 > 0 ? (v7 / k7) / (v30 / k30) : null;
  const parts = {
    trend: (close > s20 ? 10 : 0) + (close > s50 ? 8 : 0) + (s20 > s20p ? 7 : 0),
    strength: rs14 >= 15 ? 25 : rs14 >= 8 ? 20 : rs14 >= 3 ? 14 : rs14 > 0 ? 8 : 0,
    nearHigh: distHigh >= -3 ? 20 : distHigh >= -7 ? 15 : distHigh >= -12 ? 8 : 0,
    notStretched: ext <= 8 ? 15 : ext <= 15 ? 10 : ext <= 25 ? 4 : 0,
    volume: volTrend == null ? 5 : volTrend >= 1.5 ? 15 : volTrend >= 1.15 ? 10 : volTrend >= 0.9 ? 5 : 0,
  };
  const score = Object.values(parts).reduce((a, x) => a + x, 0);
  return { score, parts, rs14, distHigh, ext, volTrend, aboveSma20: close > s20, aboveSma50: close > s50, sma20Rising: s20 > s20p, close };
}

// ───────────────────────────── analysis + backtest (pure) ─────────────────────────────
// data = { t0, n, btc: closes, narratives: [{ name, category, members: [{ base, close, qv }] }] } (daily, closed candles)
export function analyze(data, opts = {}) {
  const H = opts.holdDays ?? 7, feeSide = (opts.feePct ?? 0.2) / 200, TOPN = opts.topNarratives ?? 2;
  const TOPTOK = opts.topTokens ?? 5, TOKMIN = opts.tokenMinScore ?? 65, WARM = opts.warmupDays ?? 180, SHRINK = 30;
  const { t0, n, btc } = data;
  const day = (i) => new Date(t0 + i * DAY).toISOString().slice(0, 10);
  const narrs = data.narratives.map((nr) => ({ ...nr, idx: narrativeIndex(nr.members.map((m) => m.close), n) }))
    .filter((nr) => nr.idx.some((v) => v > 0));
  const byName = new Map(narrs.map((nr) => [nr.name, nr]));
  const tokens = new Map();
  for (const nr of narrs) for (const m of nr.members) if (!tokens.has(m.base)) tokens.set(m.base, m);
  const feat = new Array(n), regime = new Array(n);
  for (let i = 0; i < n; i++) { feat[i] = btcFeatures(btc, i); regime[i] = classifyRegime(feat[i]); }

  const lastAt = (a, i) => { for (let j = i; j >= 0; j--) if (a[j] > 0) return a[j]; return NaN; };
  const move = (a, i, j) => { const x = a[i], y = lastAt(a, j); return x > 0 && y > 0 ? y / x - 1 : 0; };

  // Regime statistics, added incrementally: only forward windows that had finished by the decision day.
  const S = new Map();
  let added = 61;
  const addUpTo = (cutoff) => {
    for (; added + H <= cutoff; added++) {
      const i = added, r = regime[i];
      if (!r) continue;
      const b = btc[i + H] / btc[i] - 1;
      for (const nr of narrs) {
        const a = nr.idx[i], z = nr.idx[i + H];
        if (!(a > 0 && z > 0)) continue;
        const x = (z / a - 1 - b) * 100, k = r + "|" + nr.name;
        let s = S.get(k);
        if (!s) S.set(k, (s = { n: 0, sum: 0, sq: 0, hits: 0 }));
        s.n++; s.sum += x; s.sq += x * x; if (x > 0) s.hits++;
      }
    }
  };
  const edgeOf = (s) => (s && s.n ? (s.sum / s.n) * (s.n / (s.n + SHRINK)) : 0); // small samples pulled toward 0

  function rank(i) {
    const r = regime[i];
    const rows = [];
    for (const nr of narrs) {
      const v = nr.idx[i], s20 = sma(nr.idx, i, 20);
      if (!(v > 0) || !(nr.idx[i - 14] > 0) || !Number.isFinite(s20)) continue;
      let up = 0, tot = 0;
      for (const m of nr.members) { const c = m.close[i], s = sma(m.close, i, 20); if (c > 0 && Number.isFinite(s)) { tot++; if (c > s) up++; } }
      const st = r ? S.get(r + "|" + nr.name) : null;
      rows.push({ nr, st, edge: edgeOf(st), mom14: ((v / nr.idx[i - 14] - 1) - (btc[i] / btc[i - 14] - 1)) * 100, trend: v > s20, breadth: tot ? up / tot : 0 });
    }
    const pr = (key, out) => {
      const sorted = [...rows].sort((a, b) => a[key] - b[key]);
      sorted.forEach((x, k) => { x[out] = rows.length > 1 ? k / (rows.length - 1) : 1; });
    };
    pr("edge", "edgeRank"); pr("mom14", "momRank");
    for (const x of rows) x.score = Math.round(100 * (0.5 * x.edgeRank + 0.3 * x.momRank + 0.2 * x.breadth));
    return rows.sort((a, b) => b.score - a.score);
  }
  function tokenRows(i, narrRows) {
    const seen = new Map();
    for (const row of narrRows) for (const m of row.nr.members) {
      const sig = tokenSignal(m.close, m.qv, btc, i);
      if (!sig) continue;
      const hit = seen.get(m.base);
      if (hit) { hit.narratives.push(row.nr.name); continue; }
      seen.set(m.base, { base: m.base, narratives: [row.nr.name], ...sig });
    }
    return [...seen.values()].sort((a, b) => b.score - a.score);
  }

  // Decision rules, identical for backtest and live. Weights: { BTC, CASH, "N:name", "T:base" }.
  const RULES = {
    btc: () => ({ BTC: 1 }),
    btcFilter: (i) => (REGIMES[regime[i]]?.riskOff ? { CASH: 1 } : { BTC: 1 }),
    equal: (i) => { const live = narrs.filter((nr) => nr.idx[i] > 0); return live.length ? Object.fromEntries(live.map((nr) => ["N:" + nr.name, 1 / live.length])) : { BTC: 1 }; },
    regimeMap: (i, rows) => {
      if (REGIMES[regime[i]]?.riskOff) return { CASH: 1 };
      const best = [...rows].filter((x) => x.st && x.st.n >= 21 && x.edge > 0).sort((a, b) => b.edge - a.edge)[0];
      return best ? { ["N:" + best.nr.name]: 1 } : { BTC: 1 };
    },
    momentum: (i, rows) => {
      if (REGIMES[regime[i]]?.riskOff) return { CASH: 1 };
      const top = rows.filter((x) => x.trend && x.mom14 > 0).sort((a, b) => b.mom14 - a.mom14).slice(0, TOPN);
      return top.length ? Object.fromEntries(top.map((x) => ["N:" + x.nr.name, 1 / top.length])) : { BTC: 1 };
    },
    combined: (i, rows) => {
      if (REGIMES[regime[i]]?.riskOff) return { CASH: 1 };
      const top = rows.filter((x) => x.trend).slice(0, TOPN);
      return top.length ? Object.fromEntries(top.map((x) => ["N:" + x.nr.name, 1 / top.length])) : { BTC: 1 };
    },
    tokens: (i, rows) => {
      if (REGIMES[regime[i]]?.riskOff) return { CASH: 1 };
      const top = rows.filter((x) => x.trend).slice(0, TOPN);
      const picks = tokenRows(i, top).filter((t) => t.score >= TOKMIN).slice(0, TOPTOK);
      return picks.length ? Object.fromEntries(picks.map((t) => ["T:" + t.base, 1 / picks.length])) : { BTC: 1 };
    },
  };
  const LABELS = {
    combined: "Rotation ranking: top 2 narratives (this tab)", tokens: "Token picks in the top 2 narratives (this tab)",
    regimeMap: "Best narrative for the regime, history only", momentum: "Strongest 2 narratives vs BTC (14 days)",
    equal: "All narratives, equal weight", btcFilter: "BTC, cash when BTC is in a downtrend", btc: "Hold BTC",
  };
  const ret = (key, i, j) => (key === "CASH" ? 0 : key === "BTC" ? btc[j] / btc[i] - 1
    : key.startsWith("N:") ? move(byName.get(key.slice(2)).idx, i, j) : move(tokens.get(key.slice(2)).close, i, j));

  const firstIdx = narrs.length ? Math.min(...narrs.map((nr) => nr.idx.findIndex((v) => v > 0)).filter((v) => v >= 0)) : n;
  const startI = Math.max(61 + WARM + H, firstIdx + 30);
  const keys = Object.keys(RULES);
  const run = Object.fromEntries(keys.map((k) => [k, { rets: [], w: {}, switches: 0, cash: 0, eq: [1] }]));
  const dates = [], recent = [];
  for (let t = startI; t + H < n; t += H) {
    addUpTo(t);
    const rows = rank(t);
    dates.push(day(t));
    for (const k of keys) {
      const st = run[k], w = RULES[k](t, rows);
      let turn = 0;
      for (const key of new Set([...Object.keys(w), ...Object.keys(st.w)])) if (key !== "CASH") turn += Math.abs((w[key] || 0) - (st.w[key] || 0));
      if (turn > 1e-9) st.switches++;
      if (w.CASH) st.cash++;
      let g = 0;
      for (const [key, wt] of Object.entries(w)) g += wt * ret(key, t, t + H);
      const net = g - turn * feeSide;
      st.rets.push(net); st.eq.push(st.eq[st.eq.length - 1] * (1 + net)); st.w = w;
    }
    recent.push({ date: day(t), regime: regime[t], hold: Object.keys(run.combined.w).map((k) => k.replace(/^[NT]:/, "")),
      tokens: Object.keys(run.tokens.w).map((k) => k.replace(/^[NT]:/, "")),
      combinedPct: r2(run.combined.rets.at(-1) * 100), tokensPct: r2(run.tokens.rets.at(-1) * 100), btcPct: r2(run.btc.rets.at(-1) * 100) });
  }
  const weeks = dates.length, perYear = 365 / H;
  const metrics = (k) => {
    const st = run[k], rets = st.rets, eq = st.eq.at(-1);
    let peak = 1, dd = 0;
    for (const e of st.eq) { peak = Math.max(peak, e); dd = Math.min(dd, e / peak - 1); }
    const m = rets.length ? rets.reduce((a, x) => a + x, 0) / rets.length : 0;
    const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / (rets.length - 1)) : 0;
    const years = (rets.length * H) / 365;
    return {
      key: k, label: LABELS[k], totalPct: r2((eq - 1) * 100, 1), cagrPct: years > 0 && eq > 0 ? r2((eq ** (1 / years) - 1) * 100, 1) : null,
      maxDdPct: r2(dd * 100, 1), sharpe: sd > 0 ? r2((m / sd) * Math.sqrt(perYear)) : null,
      beatBtcPct: rets.length ? r2((rets.filter((x, j) => x > run.btc.rets[j]).length / rets.length) * 100, 0) : null,
      cashPct: rets.length ? r2((st.cash / rets.length) * 100, 0) : null, switches: st.switches,
      curve: st.eq.map((v) => r2(v, 4)),
    };
  };

  // Everything below uses all finished windows (what the live tab shows today).
  addUpTo(n - 1);
  const now = n - 1, rNow = regime[now], f = feat[now];
  const rows = rank(now);
  const regimeDays = Object.fromEntries(REGIME_KEYS.map((k) => [k, 0]));
  for (let i = 0; i < n; i++) if (regime[i]) regimeDays[regime[i]]++;
  const conf = (s) => {
    if (!s || s.n < 8 * H) return "low";
    const m = s.sum / s.n, sd = Math.sqrt(Math.max(0, s.sq / s.n - m * m)), se = sd / Math.sqrt(s.n / H);
    const t = se > 0 ? Math.abs(m) / se : 0;
    return t >= 2 ? "high" : t >= 1 ? "medium" : "low";
  };
  const statOut = (s) => (s ? { avgPct: r2(s.sum / s.n), hitPct: r2((s.hits / s.n) * 100, 0), weeks: Math.round(s.n / H), confidence: conf(s) } : null);
  const top = rows.filter((x) => x.trend).slice(0, TOPN);
  const riskOff = !!REGIMES[rNow]?.riskOff;
  const picks = tokenRows(now, rows.slice(0, 3)).slice(0, 30);
  const buyNow = new Set(riskOff ? [] : tokenRows(now, top).filter((t) => t.score >= TOKMIN).slice(0, TOPTOK).map((t) => t.base));

  return {
    asOf: day(now), historyFrom: day(0), days: n, holdDays: H, feePct: opts.feePct ?? 0.2,
    regimeNow: rNow ? { key: rNow, ...REGIMES[rNow] } : null,
    btc: f ? { close: r2(f.close, 2), ret7: r2(f.ret7), ret30: r2(f.ret30), vsSma20: r2((f.close / f.sma20 - 1) * 100), vsSma50: r2((f.close / f.sma50 - 1) * 100),
      slope20: r2(f.slope20), distHigh30: r2(f.distHigh30), vol14: r2(f.vol14), vol60: r2(f.vol60) } : null,
    ranking: rows.map((x, k) => ({
      rank: k + 1, name: x.nr.name, category: x.nr.category, score: x.score, members: x.nr.members.length,
      regimeStat: statOut(x.st), mom14: r2(x.mom14), trend: x.trend, breadthPct: r2(x.breadth * 100, 0),
      ret30: r2((x.nr.idx[now] / x.nr.idx[now - 30] - 1) * 100), held: !riskOff && top.includes(x),
    })),
    holdingsNow: {
      combined: riskOff ? ["Cash (USDT)"] : top.length ? top.map((x) => x.nr.name) : ["BTC"],
      tokens: riskOff ? ["Cash (USDT)"] : buyNow.size ? [...buyNow] : ["BTC"],
    },
    picks: picks.map((t) => ({
      base: t.base, narratives: t.narratives, score: t.score, parts: t.parts, rs14: r2(t.rs14), distHigh: r2(t.distHigh), ext: r2(t.ext),
      volTrend: r2(t.volTrend), aboveSma20: t.aboveSma20, aboveSma50: t.aboveSma50, sma20Rising: t.sma20Rising, inStrategy: buyNow.has(t.base),
    })),
    heatmap: {
      regimes: REGIME_KEYS,
      regimeWeeks: Object.fromEntries(REGIME_KEYS.map((k) => [k, Math.round(regimeDays[k] / H)])),
      rows: narrs.map((nr) => ({ name: nr.name, cells: Object.fromEntries(REGIME_KEYS.map((k) => [k, statOut(S.get(k + "|" + nr.name))])) })),
      bestByRegime: Object.fromEntries(REGIME_KEYS.map((k) => {
        const best = narrs.map((nr) => ({ name: nr.name, s: S.get(k + "|" + nr.name) })).filter((x) => x.s && x.s.n >= 21)
          .sort((a, b) => edgeOf(b.s) - edgeOf(a.s))[0];
        return [k, best ? { name: best.name, ...statOut(best.s) } : null];
      })),
    },
    backtest: weeks ? { from: dates[0], to: day(startI + weeks * H), weeks, dates, strategies: keys.map(metrics).sort((a, b) => (b.totalPct ?? -1e9) - (a.totalPct ?? -1e9)), recent: recent.slice(-12).reverse() } : null,
    coverage: { narratives: narrs.length, tokens: tokens.size, perNarrative: narrs.map((nr) => ({ name: nr.name, members: nr.members.map((m) => m.base) })) },
  };
}

// ───────────────────────────── data loading (cached) ─────────────────────────────
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; try { await fn(items[i], i); } catch { /* skip */ } await sleep(150); }
  }));
}
// getNarratives(priceByBase) comes from screener.js (Binance sector tags, largest coins first).
// A coin that fails to download is skipped (the next rebuild retries it); only a BTC failure stops the build.
export async function loadHistory({ fetchJson, getNarratives, cacheDir, days = 1000, stables = new Set(), nonCrypto = new Set(),
  membersPer = 12, only = [], maxNarratives = 20, onProgress = () => {}, refresh = false, usedWeight = () => 0 }) {
  await mkdir(cacheDir, { recursive: true });
  const today = Math.floor(Date.now() / DAY);
  const prices = await fetchJson(`${BN}/api/v3/ticker/price`, { retries: 1 });
  const priceByBase = new Map(prices.filter((p) => p.symbol.endsWith("USDT")).map((p) => [p.symbol.slice(0, -4), Number(p.price)]));
  const onBinance = new Set(priceByBase.keys());

  onProgress("Reading Binance sector tags", 0, 1);
  let list = await getNarratives(priceByBase);
  if (only.length) list = list.filter((x) => only.includes(x.name.toLowerCase()));
  list = list.slice(0, maxNarratives);
  if (!list.length) throw new Error(only.length ? `None of ROTATION_NARRATIVES (${only.join(", ")}) was found` : "No narratives available");
  for (const nr of list) nr.bases = [...new Set(nr.coins)].filter((b) => b !== "BTC" && onBinance.has(b) && !stables.has(b) && !nonCrypto.has(b)).slice(0, membersPer);

  const dailyCandles = async (base) => {
    const file = path.join(cacheDir, `1d_${base}.json`);
    if (!refresh) { try { const c = JSON.parse(await readFile(file, "utf8")); if (c.day === today && c.days >= days) return c.rows; } catch { /* none */ } }
    const rows = [];
    let end = today * DAY - 1;
    while (rows.length < days) {
      while (usedWeight() > 4000) await sleep(15_000); // leave room for the live scanner on the same IP
      const lim = Math.min(1000, days - rows.length);
      const k = await fetchJson(`${BN}/api/v3/klines?symbol=${base}USDT&interval=1d&endTime=${end}&limit=${lim}`, { retries: 1 });
      if (!Array.isArray(k) || !k.length) break;
      const before = rows.length, first = rows.length ? rows[0][0] : Infinity;
      rows.unshift(...k.filter((x) => Number(x[0]) < Math.min(today * DAY, first)).map((x) => [Number(x[0]), Number(x[4]), Number(x[7])]));
      if (rows.length === before || k.length < lim) break; // nothing new: listing date reached
      end = Number(k[0][0]) - 1;
    }
    await writeFile(file, JSON.stringify({ day: today, days, rows }));
    return rows;
  };
  const all = ["BTC", ...new Set(list.flatMap((nr) => nr.bases))];
  const series = new Map(), failed = [];
  let done = 0, btcErr = null;
  await mapLimit(all, 2, async (b) => {
    try { series.set(b, await dailyCandles(b)); }
    catch (e) { failed.push(b); if (b === "BTC") btcErr = e; }
    finally { onProgress("Loading daily candles from Binance", ++done, all.length); }
  });
  const btcRows = series.get("BTC");
  if (!btcRows?.length) throw btcErr || new Error("No BTC daily history");
  const t0 = btcRows[0][0], n = Math.round((btcRows.at(-1)[0] - t0) / DAY) + 1;
  const align = (rows, col) => {
    const a = new Float64Array(n).fill(NaN);
    for (const r of rows) { const i = Math.round((r[0] - t0) / DAY); if (i >= 0 && i < n) a[i] = r[col]; }
    return a;
  };
  return {
    t0, n, btc: align(btcRows, 1), failed,
    narratives: list.map((nr) => ({ name: nr.name, category: nr.category,
      members: nr.bases.filter((b) => series.get(b)?.length >= 60).map((b) => ({ base: b, close: align(series.get(b), 1), qv: align(series.get(b), 2) })) }))
      .filter((nr) => nr.members.length >= 3),
  };
}

// Synthetic history for DEMO=1 (regime-dependent narrative behaviour, so every part of the tab has something to show).
export function demoHistory(days = 1000, names = []) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const t0 = (Math.floor(Date.now() / DAY) - days) * DAY;
  const btc = new Float64Array(days);
  let p = 30000, drift = 0;
  for (let i = 0; i < days; i++) { if (i % 45 === 0) drift = [0.004, 0.002, -0.003, 0, 0.006, -0.005][Math.floor(rnd() * 6)]; p *= 1 + drift + gauss() * 0.025; btc[i] = p; }
  const regime = Array.from({ length: days }, (_, i) => classifyRegime(btcFeatures(btc, i)));
  const pool = [...names];
  const take = (k) => Array.from({ length: k }, (_, j) => pool.shift() || `ALT${Math.floor(rnd() * 900 + 100)}`);
  const DEF = [ // name, beta, edge per regime (daily, vs BTC)
    ["AI", 1.6, { calmUp: 0.004, up: 0.002, breakout: 0.001, down: -0.003 }, ["FET", "RENDER", "TAO"]],
    ["Meme", 2.0, { breakout: 0.008, up: 0.001, down: -0.005, dump: -0.006 }, ["DOGE", "PEPE"]],
    ["Layer 1", 1.3, { up: 0.001, calmUp: 0.001, range: 0.0005 }, ["SOL", "AVAX", "SUI", "APT", "SEI", "NEAR"]],
    ["Layer 2", 1.4, { up: 0.0005, down: -0.002 }, ["ARB", "OP"]],
    ["DeFi", 1.3, { calmUp: 0.002, range: 0.001 }, ["JUP", "ENA", "INJ"]],
    ["RWA", 1.1, { down: 0.002, range: 0.002, dump: 0.001 }, ["ONDO"]],
    ["Gaming", 1.7, { breakout: 0.003, down: -0.004 }, []],
    ["DePIN", 1.5, { calmUp: 0.002, up: 0.001 }, []],
    ["Oracles", 1.2, { range: 0.001 }, ["LINK", "PYTH"]],
  ];
  const narratives = DEF.map(([name, beta, edge, fixed]) => {
    const bases = [...fixed, ...take(Math.max(0, 6 - fixed.length))];
    const members = bases.map((base, j) => {
      const close = new Float64Array(days).fill(NaN), qv = new Float64Array(days).fill(NaN), start = Math.floor(rnd() * 200) * (j > 2 ? 1 : 0);
      let c = 1 + rnd() * 20;
      for (let i = start; i < days; i++) {
        const br = i > 0 ? btc[i] / btc[i - 1] - 1 : 0, r = regime[i - 1] || "range";
        c *= 1 + clamp(beta * br + (edge[r] || 0) + gauss() * 0.04, -0.4, 0.6);
        close[i] = c; qv[i] = 2e7 * (1 + Math.abs(br) * 20) * Math.exp(gauss() * 0.3);
      }
      return { base, close, qv };
    });
    return { name, category: name, members };
  });
  return { t0, n: days, btc, narratives };
}

// ───────────────────────────── live manager ─────────────────────────────
export function createRotation({ fetchJson, getNarratives, cacheDir, stables, nonCrypto, demo = false, demoNames = [], days = 1000,
  holdDays = 7, feePct = 0.2, only = [], startDelayMs = 45_000, usedWeight = () => 0 }) {
  const st = { status: "starting", progress: null, error: null, warning: null, updatedAt: null, builtDay: null, nextRetryAt: null, btcNow: null, result: null };
  let memberOf = new Map(), busy = false, nextTry = 0, failures = 0, partialRetries = 0, partialDay = null;
  async function rebuild() {
    if (busy) return;
    busy = true;
    try {
      st.status = st.result ? "refreshing" : "loading";
      const data = demo ? demoHistory(days, demoNames)
        : await loadHistory({ fetchJson, getNarratives, cacheDir, days, stables, nonCrypto, only, usedWeight,
          onProgress: (step, done, total) => { st.progress = { step, done, total }; } });
      st.result = analyze(data, { holdDays, feePct });
      const map = new Map();
      for (const nr of st.result.coverage.perNarrative) for (const b of nr.members) map.set(b, [...(map.get(b) || []), nr.name]);
      memberOf = map;
      const today = Math.floor(Date.now() / DAY);
      if (partialDay !== today) { partialDay = today; partialRetries = 0; }
      const missing = data.failed?.length || 0;
      st.warning = missing ? `${data.failed?.length || 0} coins could not be downloaded this time` : null;
      st.status = "ready"; st.error = null; st.progress = null; st.updatedAt = Date.now(); failures = 0;
      if (missing && partialRetries < 3) { partialRetries++; st.builtDay = null; nextTry = Date.now() + 10 * 60_000; st.nextRetryAt = nextTry; } // fill the gaps from cache + retries
      else { st.builtDay = today; st.nextRetryAt = null; nextTry = 0; }
    } catch (e) {
      failures++;
      nextTry = Date.now() + Math.min(30, 2 ** failures) * 60_000; // 2, 4, 8, 16, then every 30 minutes
      st.error = e.message; st.nextRetryAt = nextTry; st.status = st.result ? "ready" : "error"; st.progress = null;
    } finally { busy = false; }
  }
  // Rebuild once per UTC day (shortly after the daily candle closes); after a failure, retry with growing pauses.
  const tick = () => {
    const now = Date.now(), today = Math.floor(now / DAY);
    if (now < nextTry) return;
    if (!st.result || (st.builtDay !== today && now - today * DAY > 5 * 60_000)) rebuild();
  };
  return {
    start() { setTimeout(() => { tick(); setInterval(tick, 60_000); }, demo ? 0 : startDelayMs); },
    updatePrices(priceByBase) { const p = priceByBase.get("BTC"); if (Number.isFinite(p)) st.btcNow = p; },
    riskOff: () => !!st.result?.regimeNow?.riskOff,
    regimeLabel: () => st.result?.regimeNow?.label || null,
    // Rotation context for one token (used by the ignition screener and its alerts).
    context(base) {
      const r = st.result;
      if (!r) return null;
      const names = memberOf.get(base) || [];
      return {
        regime: r.regimeNow?.key ?? null, regimeLabel: r.regimeNow?.label ?? null, riskOff: !!r.regimeNow?.riskOff,
        narratives: names.map((name) => ({ name, rank: r.ranking.find((x) => x.name === name)?.rank ?? null })).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)),
      };
    },
    api: () => ({ status: st.status, progress: st.progress, error: st.error, warning: st.warning, nextRetryAt: st.nextRetryAt, updatedAt: st.updatedAt,
      btcNow: st.btcNow, demo, regimes: REGIMES, ...(st.result || {}) }),
  };
}
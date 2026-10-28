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

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

const DAY = 86_400_000;
const BN = (process.env.BINANCE_SPOT_URL || "https://api.binance.com").replace(/\/$/, "");

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

// Alt season meter: is money rotating from BTC into altcoins? Three independent votes, each +1 / 0 / -1: the ETH/BTC
// trend, the median narrative's 30-day return vs BTC, and the share of altcoins above their 20-day average.
export const ALT_STATES = {
  altsLead: { label: "Alts leading", desc: "ETH/BTC is rising, most narratives beat BTC over 30 days and most coins are above their 20-day average." },
  mixed: { label: "Mixed", desc: "The three alt season signals disagree." },
  btcLeads: { label: "BTC leading", desc: "ETH/BTC is falling, most narratives lag BTC and most coins are below their 20-day average: altcoins usually underperform." },
};
export function altState(x) {
  if (!x) return null;
  const vote = (v, up, dn) => (v == null ? 0 : v >= up ? 1 : v <= dn ? -1 : 0);
  const score = (x.ethTrend ?? 0) + vote(x.altVsBtc30, 2, -2) + vote(x.breadthPct, 55, 35);
  return score >= 2 ? "altsLead" : score <= -2 ? "btcLeads" : "mixed";
}
// How long BTC regimes last and what usually follows. regimes: one key (or null) per day.
export function regimeStats(regimes, H = 7) {
  const runs = [];
  for (let i = 0; i < regimes.length; i++) {
    const r = regimes[i];
    if (!r) continue;
    if (runs.length && runs[runs.length - 1].r === r && runs[runs.length - 1].end === i - 1) runs[runs.length - 1].end = i;
    else runs.push({ r, start: i, end: i });
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
  const medianDays = {}, transitions = {};
  for (const k of REGIME_KEYS) {
    const done = runs.slice(0, -1).filter((x) => x.r === k);
    medianDays[k] = med(done.map((x) => x.end - x.start + 1));
    const next = {};
    for (let j = 0; j < runs.length - 1; j++) if (runs[j].r === k && runs[j + 1].start === runs[j].end + 1) next[runs[j + 1].r] = (next[runs[j + 1].r] || 0) + 1;
    const tot = Object.values(next).reduce((a, x) => a + x, 0);
    transitions[k] = tot ? Object.fromEntries(Object.entries(next).map(([to, c]) => [to, Math.round((c / tot) * 100)])) : {};
  }
  const last = runs[runs.length - 1] || null, now = last?.r ?? null;
  const later = {};
  let m = 0;
  for (let i = 0; i + H < regimes.length; i++) if (regimes[i] === now && regimes[i + H]) { later[regimes[i + H]] = (later[regimes[i + H]] || 0) + 1; m++; }
  return { now, ageDays: last ? last.end - last.start + 1 : null, medianDays, transitions, [`in${H}Days`]: m ? Object.fromEntries(Object.entries(later).map(([k, c]) => [k, Math.round((c / m) * 100)])) : {}, samples: m };
}
// Life-cycle stage of a narrative from its breadth now vs a week ago, the share of its coins near 30-day highs and the
// money flow (share of altcoin volume, 7 days vs 30 days).
export const STAGES = { early: "Early", running: "Running", late: "Late", cooling: "Cooling", quiet: "Quiet" };
export function narrativeStage({ breadthPct, breadthPrevPct, atHighsPct, flow, mom14 }) {
  if (atHighsPct >= 70 || (mom14 > 10 && flow != null && flow < 0.9 && breadthPct < breadthPrevPct)) return "late";
  if (breadthPct < breadthPrevPct - 10 && mom14 < 0) return "cooling";
  if (breadthPct > breadthPrevPct + 10 && atHighsPct < 40 && mom14 > 0 && (flow == null || flow >= 1)) return "early";
  if (breadthPct >= 60 && atHighsPct >= 25) return "running";
  return "quiet";
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

  // Alt season meter per day (backward-looking only).
  const ethBtc = data.eth ? Float64Array.from({ length: n }, (_, i) => (data.eth[i] > 0 && btc[i] > 0 ? data.eth[i] / btc[i] : NaN)) : null;
  const tokList = [...tokens.values()];
  const alt = new Array(n).fill(null);
  for (let i = 60; i < n; i++) {
    let ethTrend = 0, ethBtc30 = null;
    if (ethBtc && ethBtc[i] > 0 && ethBtc[i - 30] > 0) {
      const s50 = sma(ethBtc, i, 50), s20 = sma(ethBtc, i, 20), s20p = sma(ethBtc, i - 5, 20);
      ethBtc30 = (ethBtc[i] / ethBtc[i - 30] - 1) * 100;
      if (Number.isFinite(s50) && Number.isFinite(s20p)) ethTrend = ethBtc[i] > s50 && s20 > s20p ? 1 : ethBtc[i] < s50 && s20 < s20p ? -1 : 0;
    }
    const rel = [];
    for (const nr of narrs) if (nr.idx[i] > 0 && nr.idx[i - 30] > 0 && btc[i - 30] > 0) rel.push(((nr.idx[i] / nr.idx[i - 30]) - (btc[i] / btc[i - 30])) * 100);
    rel.sort((a, b) => a - b);
    let up = 0, tot = 0;
    for (const m of tokList) { const c = m.close[i], s = sma(m.close, i, 20); if (c > 0 && Number.isFinite(s)) { tot++; if (c > s) up++; } }
    const x = { ethTrend, ethBtc30: r2(ethBtc30), altVsBtc30: rel.length >= 3 ? r2(rel[rel.length >> 1]) : null, breadthPct: tot >= 10 ? r2((up / tot) * 100, 0) : null };
    x.state = altState(x);
    alt[i] = x;
  }
  // Money flow: each narrative's share of altcoin trading volume (unique coins), 7 days vs 30 days.
  const psum = (arr) => { const p = new Float64Array(n + 1); for (let i = 0; i < n; i++) p[i + 1] = p[i] + (arr[i] > 0 ? arr[i] : 0); return p; };
  const totQv = new Float64Array(n);
  for (const m of tokList) for (let i = 0; i < n; i++) if (m.qv[i] > 0) totQv[i] += m.qv[i];
  const totP = psum(totQv);
  for (const nr of narrs) { const q = new Float64Array(n); for (const m of nr.members) for (let i = 0; i < n; i++) if (m.qv[i] > 0) q[i] += m.qv[i]; nr.qvP = psum(q); }
  const share = (nr, i, k) => { const t = totP[i + 1] - totP[Math.max(0, i + 1 - k)]; return t > 0 ? (nr.qvP[i + 1] - nr.qvP[Math.max(0, i + 1 - k)]) / t : null; };
  const flowOf = (nr, i) => { const a = share(nr, i, 7), b = share(nr, i, 30); return a != null && b > 0 ? a / b : null; };

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
      rows.push({ nr, st, edge: edgeOf(st), mom14: ((v / nr.idx[i - 14] - 1) - (btc[i] / btc[i - 14] - 1)) * 100, trend: v > s20, breadth: tot ? up / tot : 0, flow: flowOf(nr, i) ?? 1 });
    }
    const pr = (key, out) => {
      const sorted = [...rows].sort((a, b) => a[key] - b[key]);
      sorted.forEach((x, k) => { x[out] = rows.length > 1 ? k / (rows.length - 1) : 1; });
    };
    pr("edge", "edgeRank"); pr("mom14", "momRank"); pr("flow", "flowRank");
    for (const x of rows) {
      x.score = Math.round(100 * (0.5 * x.edgeRank + 0.3 * x.momRank + 0.2 * x.breadth));
      x.scoreFlow = Math.round(100 * (0.4 * x.edgeRank + 0.25 * x.momRank + 0.15 * x.breadth + 0.2 * x.flowRank)); // variant: + money flow
    }
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
    combinedAlt: (i, rows) => { // variant: hold BTC instead of narratives while BTC leads the alts
      if (REGIMES[regime[i]]?.riskOff) return { CASH: 1 };
      if (alt[i]?.state === "btcLeads") return { BTC: 1 };
      const top = rows.filter((x) => x.trend).slice(0, TOPN);
      return top.length ? Object.fromEntries(top.map((x) => ["N:" + x.nr.name, 1 / top.length])) : { BTC: 1 };
    },
    combinedFlow: (i, rows) => { // variant: money flow (volume share) as a fifth of the score
      if (REGIMES[regime[i]]?.riskOff) return { CASH: 1 };
      const top = rows.filter((x) => x.trend).sort((a, b) => b.scoreFlow - a.scoreFlow).slice(0, TOPN);
      return top.length ? Object.fromEntries(top.map((x) => ["N:" + x.nr.name, 1 / top.length])) : { BTC: 1 };
    },
    tokensAlt: (i, rows) => { // variant: token picks, BTC while BTC leads the alts
      if (REGIMES[regime[i]]?.riskOff) return { CASH: 1 };
      if (alt[i]?.state === "btcLeads") return { BTC: 1 };
      const top = rows.filter((x) => x.trend).slice(0, TOPN);
      const picks = tokenRows(i, top).filter((t) => t.score >= TOKMIN).slice(0, TOPTOK);
      return picks.length ? Object.fromEntries(picks.map((t) => ["T:" + t.base, 1 / picks.length])) : { BTC: 1 };
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
    combinedAlt: "Variant: rotation ranking, BTC while BTC leads the alts", combinedFlow: "Variant: rotation ranking + money flow",
    tokensAlt: "Variant: token picks, BTC while BTC leads the alts",
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
      // the same strategy on the older and the newer half of the weeks: a rule worth keeping should hold up in both
      olderPct: r2((rets.slice(0, rets.length >> 1).reduce((e, x) => e * (1 + x), 1) - 1) * 100, 1),
      newerPct: r2((rets.slice(rets.length >> 1).reduce((e, x) => e * (1 + x), 1) - 1) * 100, 1),
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
  const breadthAt = (nr, i) => { let up = 0, tot = 0; for (const m of nr.members) { const c = m.close[i], s = sma(m.close, i, 20); if (c > 0 && Number.isFinite(s)) { tot++; if (c > s) up++; } } return tot ? (up / tot) * 100 : 0; };
  const atHighs = (nr, i) => { let k = 0, tot = 0; for (const m of nr.members) { let hi = -Infinity; for (let j = i - 29; j <= i; j++) if (m.close[j] > 0) hi = Math.max(hi, m.close[j]); if (m.close[i] > 0 && hi > 0) { tot++; if (m.close[i] >= hi * 0.97) k++; } } return tot ? (k / tot) * 100 : 0; };
  const a = alt[now];
  const buyNow = new Set(riskOff ? [] : tokenRows(now, top).filter((t) => t.score >= TOKMIN).slice(0, TOPTOK).map((t) => t.base));

  return {
    asOf: day(now), historyFrom: day(0), days: n, holdDays: H, feePct: opts.feePct ?? 0.2,
    regimeNow: rNow ? { key: rNow, ...REGIMES[rNow] } : null,
    btc: f ? { close: r2(f.close, 2), ret7: r2(f.ret7), ret30: r2(f.ret30), vsSma20: r2((f.close / f.sma20 - 1) * 100), vsSma50: r2((f.close / f.sma50 - 1) * 100),
      slope20: r2(f.slope20), distHigh30: r2(f.distHigh30), vol14: r2(f.vol14), vol60: r2(f.vol60) } : null,
    ranking: rows.map((x, k) => {
      const prev = breadthAt(x.nr, now - 7), hi = atHighs(x.nr, now), vs = share(x.nr, now, 7);
      return {
        rank: k + 1, name: x.nr.name, category: x.nr.category, score: x.score, members: x.nr.members.length,
        regimeStat: statOut(x.st), mom14: r2(x.mom14), trend: x.trend, breadthPct: r2(x.breadth * 100, 0),
        ret30: r2((x.nr.idx[now] / x.nr.idx[now - 30] - 1) * 100), held: !riskOff && top.includes(x),
        volShare7Pct: vs == null ? null : r2(vs * 100, 1), flow: r2(x.flow), breadthPrevPct: r2(prev, 0), atHighsPct: r2(hi, 0),
        stage: narrativeStage({ breadthPct: x.breadth * 100, breadthPrevPct: prev, atHighsPct: hi, flow: x.flow, mom14: x.mom14 }),
      };
    }),
    altSeason: a ? { ...a, label: ALT_STATES[a.state].label, desc: ALT_STATES[a.state].desc, hasEth: !!ethBtc,
      history: alt.slice(-120).map((x, j) => ({ date: day(n - 120 + j), state: x?.state ?? null })) } : null,
    regimeStats: regimeStats(regime, H),
    holdingsNow: {
      combined: riskOff ? ["Cash (USDT)"] : top.length ? top.map((x) => x.nr.name) : ["BTC"],
      tokens: riskOff ? ["Cash (USDT)"] : buyNow.size ? [...buyNow] : ["BTC"],
      combinedAlt: riskOff ? ["Cash (USDT)"] : a?.state === "btcLeads" ? ["BTC"] : top.length ? top.map((x) => x.nr.name) : ["BTC"], // variant
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
  const all = [...new Set(["BTC", "ETH", ...list.flatMap((nr) => nr.bases)])]; // ETH for the ETH/BTC trend (alt season meter)
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
  const ethRows = series.get("ETH");
  return {
    t0, n, btc: align(btcRows, 1), eth: ethRows?.length ? align(ethRows, 1) : null, failed,
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
  // ETH drifts up vs BTC in strong BTC regimes and down in weak ones, for the alt season meter
  const eth = new Float64Array(days);
  let eb = 0.05;
  for (let i = 0; i < days; i++) { const r = regime[i - 1]; eb *= 1 + gauss() * 0.015 + (r === "breakout" || r === "calmUp" ? 0.001 : r === "down" || r === "dump" ? -0.001 : 0); eth[i] = btc[i] * eb; }
  return { t0, n: days, btc, eth, narratives };
}

// ───────────────────────────── forward record (pure) ─────────────────────────────
// A live weekly decision with its entry prices, judged H days later with prices that came afterwards. closeAt(base, t)
// returns a coin's daily close on day t (or its last close before t if it stopped trading), so coins that were dropped
// or delisted stay in the result instead of disappearing.
export function makeDecision(result, data, H) {
  const i = data.n - 1, t = data.t0 + i * DAY, members = new Map();
  for (const nr of data.narratives) members.set(nr.name, nr.members);
  const close = (m) => (m && m.close[i] > 0 ? m.close[i] : null);
  const all = new Map(); for (const ms of members.values()) for (const m of ms) all.set(m.base, m);
  const h = result.holdingsNow || {}, cash = (h.combined || [])[0] === "Cash (USDT)";
  return {
    date: new Date(t).toISOString().slice(0, 10), t, exitT: t + H * DAY, holdDays: H, regime: result.regimeNow?.key ?? null, altState: result.altSeason?.state ?? null,
    cash, btc: data.btc[i],
    narratives: cash ? [] : (h.combined || []).filter((nm) => members.has(nm)).map((nm) => ({ name: nm, members: members.get(nm).filter((m) => close(m)).map((m) => ({ base: m.base, close: close(m) })) })),
    tokens: cash ? [] : (h.tokens || []).filter((b) => all.has(b) && close(all.get(b))).map((b) => ({ base: b, close: close(all.get(b)) })),
    btcFallback: !cash && (h.combined || [])[0] === "BTC", tokensBtc: !cash && (h.tokens || [])[0] === "BTC", // the rule held BTC instead
  };
}
export async function evaluateDecision(dec, closeAt, feePct = 0.2) {
  const ret = async (base, entry) => { const c = await closeAt(base, dec.exitT); return c > 0 && entry > 0 ? clamp(c / entry - 1, -0.95, 5) : null; };
  const avg = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const btcExit = await closeAt("BTC", dec.exitT), btcPct = btcExit > 0 && dec.btc > 0 ? (btcExit / dec.btc - 1) * 100 : null;
  const narrs = [];
  for (const nr of dec.narratives) narrs.push(avg(await Promise.all(nr.members.map((m) => ret(m.base, m.close)))));
  const toks = await Promise.all(dec.tokens.map((x) => ret(x.base, x.close)));
  const fee = feePct; // one round trip per week, as in the backtest's worst case
  const combined = dec.cash ? 0 : dec.btcFallback ? btcPct : narrs.length ? avg(narrs) * 100 - fee : null;
  const tokensPct = dec.cash ? 0 : toks.length ? avg(toks) * 100 - fee : dec.btcFallback || dec.tokensBtc ? btcPct : null;
  return { combinedPct: r2(combined), tokensPct: r2(tokensPct), btcPct: r2(btcPct), narrativePcts: narrs.map((x) => r2(x == null ? null : x * 100)), missing: toks.filter((x) => x == null).length };
}
export function recordSummary(decisions) {
  const done = decisions.filter((d) => d.result && d.result.combinedPct != null && d.result.btcPct != null);
  const comp = (k) => r2((done.reduce((e, d) => e * (1 + (d.result[k] ?? 0) / 100), 1) - 1) * 100, 1);
  return { weeks: done.length, combinedPct: comp("combinedPct"), tokensPct: comp("tokensPct"), btcPct: comp("btcPct"),
    beatBtcPct: done.length ? Math.round((done.filter((d) => d.result.combinedPct > d.result.btcPct).length / done.length) * 100) : null };
}

// ───────────────────────────── live manager ─────────────────────────────
export function createRotation({ fetchJson, getNarratives, cacheDir, stables, nonCrypto, demo = false, demoNames = [], days = 1000,
  holdDays = 7, feePct = 0.2, only = [], startDelayMs = 45_000, usedWeight = () => 0, recordFile = null, sendTelegram = null, telegramOn = false }) {
  const st = { status: "starting", progress: null, error: null, warning: null, updatedAt: null, builtDay: null, nextRetryAt: null, btcNow: null, result: null };
  // Saved across restarts: daily snapshots of each narrative's coins, the live weekly decisions and their results.
  let record = { version: 1, memberships: {}, changes: [], decisions: [], last: null };
  let recordLoaded = !recordFile;
  async function loadRecord() {
    if (recordLoaded) return;
    try { const r = JSON.parse(await readFile(recordFile, "utf8")); if (r && r.version === 1) record = { ...record, ...r }; } catch { /* first run */ }
    recordLoaded = true;
  }
  const saveRecord = () => (recordFile ? writeFile(recordFile + ".tmp", JSON.stringify(record)).then(() => rename(recordFile + ".tmp", recordFile)).catch(() => {}) : null);
  async function updateRecord(result, data) {
    await loadRecord();
    const today = new Date(data.t0 + (data.n - 1) * DAY).toISOString().slice(0, 10);
    // 1) coins in each narrative today (point-in-time lists for future backtests) and what changed since the last snapshot
    const snap = Object.fromEntries(result.coverage.perNarrative.map((nr) => [nr.name, nr.members]));
    const prevDay = Object.keys(record.memberships).sort().pop();
    if (prevDay !== today) {
      const prev = prevDay ? record.memberships[prevDay] : null;
      if (prev) for (const [nm, ms] of Object.entries(snap)) {
        const added = ms.filter((b) => !(prev[nm] || []).includes(b)), removed = (prev[nm] || []).filter((b) => !ms.includes(b));
        if (added.length || removed.length) record.changes.unshift({ date: today, narrative: nm, added, removed });
      }
      record.changes = record.changes.slice(0, 50);
      record.memberships[today] = snap;
    }
    // 2) judge decisions whose holding period has ended, with closes from the history (or Binance for coins no longer in it)
    const byBase = new Map([["BTC", data.btc]]);
    for (const nr of data.narratives) for (const m of nr.members) byBase.set(m.base, m.close);
    const closeAt = async (base, t) => {
      const a = byBase.get(base), i = Math.round((t - data.t0) / DAY);
      if (a && i >= 0 && i < data.n) { for (let j = i; j >= Math.max(0, i - 10); j--) if (a[j] > 0) return a[j]; }
      try { const k = await fetchJson(`${BN}/api/v3/klines?symbol=${base}USDT&interval=1d&endTime=${t + DAY - 1}&limit=1`, { retries: 1 }); return Number(k?.[0]?.[4]) || null; } catch { return null; }
    };
    const lastClosed = data.t0 + (data.n - 1) * DAY;
    for (const d of record.decisions) {
      if (d.result) continue;
      if (d.exitT > lastClosed) { // still open: remember each held coin's latest close, used if it is delisted before the exit
        d.lastSeen ||= {};
        for (const b of [...d.narratives.flatMap((nr) => nr.members.map((m) => m.base)), ...d.tokens.map((x) => x.base)]) { const a = byBase.get(b); if (a?.[data.n - 1] > 0) d.lastSeen[b] = a[data.n - 1]; }
        continue;
      }
      d.result = await evaluateDecision(d, async (b, t) => (await closeAt(b, t)) ?? d.lastSeen?.[b] ?? null, feePct);
    }
    // 3) a new decision every holdDays days, made from the same ranking the tab shows
    const lastDec = record.decisions[record.decisions.length - 1];
    if (!lastDec || lastClosed - lastDec.t >= holdDays * DAY) record.decisions.push(makeDecision(result, data, holdDays));
    record.decisions = record.decisions.slice(-160);
    // 4) optional Telegram message when the regime or the holdings change (ROTATION_TELEGRAM=1)
    const now = { regime: result.regimeNow?.key ?? null, altState: result.altSeason?.state ?? null, holdings: (result.holdingsNow?.combined || []).join(" + ") };
    if (telegramOn && sendTelegram && record.last && (record.last.regime !== now.regime || record.last.holdings !== now.holdings)) {
      const a = result.altSeason;
      sendTelegram([`BTC ROTATION: ${record.last.regime !== now.regime ? `regime changed: ${REGIMES[record.last.regime]?.label || "?"} -> ${REGIMES[now.regime]?.label || "?"}` : "holdings changed"}`,
        a ? `Alt season: ${a.label} (ETH/BTC ${a.ethBtc30 ?? "n/a"}% in 30d, median narrative ${a.altVsBtc30 ?? "n/a"}% vs BTC, ${a.breadthPct ?? "n/a"}% of coins above their 20-day average)` : null,
        `Holding: ${now.holdings}${record.last.holdings !== now.holdings ? ` (was: ${record.last.holdings})` : ""}`,
        result.holdingsNow?.tokens?.length && !/^(Cash|BTC)/.test(result.holdingsNow.tokens[0]) ? `Coins: ${result.holdingsNow.tokens.join(", ")}` : null,
        "Research tool, not financial advice."].filter(Boolean).join("\n")).catch(() => {});
    }
    record.last = now;
    await saveRecord();
  }
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
      const recErr = demo ? null : await updateRecord(st.result, data).then(() => null, (e) => e.message);
      const map = new Map();
      for (const nr of st.result.coverage.perNarrative) for (const b of nr.members) map.set(b, [...(map.get(b) || []), nr.name]);
      memberOf = map;
      const today = Math.floor(Date.now() / DAY);
      if (partialDay !== today) { partialDay = today; partialRetries = 0; }
      const missing = data.failed?.length || 0;
      st.warning = [missing ? `${missing} coins could not be downloaded this time` : null, recErr ? `forward record not saved: ${recErr}` : null].filter(Boolean).join("; ") || null;
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
    start() { loadRecord().catch(() => {}); setTimeout(() => { tick(); setInterval(tick, 60_000); }, demo ? 0 : startDelayMs); },
    updatePrices(priceByBase) { const p = priceByBase.get("BTC"); if (Number.isFinite(p)) st.btcNow = p; },
    riskOff: () => !!st.result?.regimeNow?.riskOff,
    regimeLabel: () => st.result?.regimeNow?.label || null,
    regimeKey: () => st.result?.regimeNow?.key || null,
    altSeason: () => (st.result?.altSeason ? { state: st.result.altSeason.state, label: st.result.altSeason.label } : null),
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
    api: () => {
      const decs = record.decisions, last = decs[decs.length - 1];
      const holdOf = (d) => (d.cash ? "Cash" : d.btcFallback ? "BTC" : d.narratives.map((x) => x.name).join(" + ") || "BTC");
      let changeAt = -1;
      for (let j = decs.length - 1; j > 0; j--) if (holdOf(decs[j]) !== holdOf(decs[j - 1])) { changeAt = j; break; }
      return {
        status: st.status, progress: st.progress, error: st.error, warning: st.warning, nextRetryAt: st.nextRetryAt, updatedAt: st.updatedAt,
        btcNow: st.btcNow, demo, regimes: REGIMES, altStates: ALT_STATES, stages: STAGES, telegramOn, ...(st.result || {}),
        record: {
          since: decs[0]?.date ?? null, snapshots: Object.keys(record.memberships).length, firstSnapshot: Object.keys(record.memberships).sort()[0] ?? null,
          changes: record.changes.slice(0, 12), summary: recordSummary(decs),
          decisions: decs.slice(-26).reverse().map((d) => ({ date: d.date, exitDate: new Date(d.exitT).toISOString().slice(0, 10), regime: d.regime, altState: d.altState,
            hold: d.cash ? ["Cash (USDT)"] : d.btcFallback ? ["BTC"] : d.narratives.map((x) => x.name), tokens: d.tokensBtc ? ["BTC"] : d.tokens.map((x) => x.base), result: d.result || null })),
          nextDecision: last ? new Date(last.t + holdDays * DAY).toISOString().slice(0, 10) : null,
          lastChange: changeAt > 0 ? { date: decs[changeAt].date, from: holdOf(decs[changeAt - 1]), to: holdOf(decs[changeAt]) } : null,
        },
      };
    },
  };
}
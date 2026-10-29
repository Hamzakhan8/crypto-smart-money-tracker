// AI call tracker: the AI desk's memory and its scorekeeper.
//
//   • Every committee answer (your analyses, automatic alert reviews, Alpha checks, trigger re-checks) is followed like a
//     trade with its own plan: bought at the price of the answer, closed at the plan's stop or target (the stop is
//     checked first inside a candle), or at the last price when its holding time ends, after costs. WATCH and NO
//     answers are followed too ("if bought anyway"), so the scorecard shows whether each committee member's no was right.
//   • WAIT answers come with a price event (a breakout close above a level, or a pullback to one) and a time limit. The
//     tracker watches it and calls back when it happens, so the committee can check the coin again.
//   • Gemini requests are counted against a daily limit (AI_DAILY_REQUESTS), with a warning at 80% and at 100%.
//   • trackRecord() is a short summary of the committee's own results that goes back into its prompts.
//
// Saved in ai_calls.json (kept out of git). Candles come from an injected bars() function. Node.js 18+, no dependencies.

import { readFile, writeFile, rename } from "node:fs/promises";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const avg = (a) => (a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null);
const share = (g, fn) => (g.length ? Math.round((g.filter(fn).length / g.length) * 100) : null);
export const TF = { "1m": MIN, "5m": 5 * MIN, "15m": 15 * MIN, "1h": HOUR };
const DUP_MS = 30 * MIN, KEEP_CALLS = 3000, KEEP_TRIGGERS = 300, MAX_ARMED = 30, MAX_DEPTH = 2;
export const RESOLVED = ["win", "loss", "timeout"];
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const keyOf = (c) => `${c.kind}:${c.kind === "alpha" ? c.alphaId || c.symbol : c.symbol}`;
const newId = (p, t) => `${p}${t.toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ───────────────────────────── calls ─────────────────────────────
// One committee answer as a tracked call, or null when it has no usable plan (or the screener data was simulated).
// The stop and target are the plan's distances applied to the price at the moment of the answer.
export function callFromResult(x, { source = "manual", at = Date.now(), depth = 0 } = {}) {
  const d = x?.dossier || {}, p = x?.plan || {}, c = x?.committee || {}, entry = Number(d.price);
  if (!x?.committee || !(entry > 0) || d.dataQuality?.demo || !(p.stopPct < 0) || !(p.target1Pct > 0)) return null;
  const dbt = c.debate && !c.debate.off ? c.debate : null;
  return {
    id: newId("c", at), at, source, depth,
    kind: x.kind === "alpha" ? "alpha" : "spot", symbol: x.symbol, alphaId: x.alphaId || null, quote: d.alpha?.token?.quote || null, tier: x.tier || null,
    entry, stopPx: entry * (1 + p.stopPct / 100), targetPx: entry * (1 + p.target1Pct / 100), stopPct: p.stopPct, targetPct: p.target1Pct,
    holdHours: clamp(Number(p.holdHours) || d.alert?.trackedAs?.holdHours || 12, 1, 24 * 14), costPct: Number(d.alert?.costPct) || 0,
    decision: x.decision, final: x.final || (x.decision === "TAKE" ? "YES" : "NO"), trader: c.trader?.decision || x.modelDecision || null,
    boss: c.boss?.asked ? (c.boss.available === false ? "none" : c.boss.verdict) : null, bossAgrees: c.boss?.available ? c.boss.agreesWithTrader === true : null,
    bossReason: c.boss?.asked ? String(c.boss.summary || c.boss.reason || "").slice(0, 300) : null, sizePct: x.sizePct ?? null,
    debate: dbt ? { winner: dbt.verdict?.winner || null, bull: dbt.bull?.available ? dbt.bull.strength : null, bear: dbt.bear?.available ? dbt.bear.strength : null,
      bearPath: dbt.bear?.available ? String(dbt.bear.path || "").slice(0, 200) : null } : null,
    news: c.news?.available ? (c.news.status === "unknown" ? "unknown" : c.news.riskLevel) : null, fastNo: !!x.fastNo, newsStop: !!c.news?.hardStop, data: c.data?.available ? c.data.dataQuality?.rating || null : null,
    probTargetPct: x.probTargetPct ?? null, probStopPct: x.probStopPct ?? null, expectedValuePct: x.expectedValuePct ?? null, headline: String(x.headline || "").slice(0, 160),
    track: { status: "open", hi: entry, lo: entry, last: entry, to: null, bars: 0 },
  };
}

// Applies finished candles {t, o, h, l, c} (barMs long) to an open call, in time order. Inside a candle the stop is
// checked before the target (a candle touching both counts as a loss). Once every candle of the holding time is in, the
// call closes at the last price; with no candles at all after 6 more hours it is "nodata" (left out of the scores).
// Returns true when something changed.
export function applyBars(call, bars, barMs, now = Date.now()) {
  const t = call.track;
  if (t.status !== "open") return false;
  const first = Math.ceil(call.at / barMs) * barMs, end = call.at + call.holdHours * HOUR;
  let changed = false;
  const close = (status, exitPct, at) => { Object.assign(t, { status, exitPct: r2(exitPct), netPct: r2(exitPct - call.costPct), closedAt: at }); changed = true; };
  for (const b of bars) {
    if (b.t < first || (t.to != null && b.t < t.to) || b.t + barMs > now) continue;
    if (b.t >= end) break;
    t.hi = Math.max(t.hi, b.h); t.lo = Math.min(t.lo, b.l); t.last = b.c; t.to = b.t + barMs; t.bars++; changed = true;
    if (b.l <= call.stopPx) { close("loss", (Math.min(call.stopPx, b.o) / call.entry - 1) * 100, b.t + barMs); break; }
    if (b.h >= call.targetPx) { close("win", (call.targetPx / call.entry - 1) * 100, b.t + barMs); break; }
  }
  if (t.status === "open" && now >= end + barMs) {
    const lastStart = Math.ceil(end / barMs) * barMs - barMs, complete = t.to != null && t.to >= lastStart + barMs;
    if (complete || now >= end + 6 * HOUR) {
      if (t.bars) close("timeout", (t.last / call.entry - 1) * 100, end);
      else { t.status = "nodata"; changed = true; }
    }
  }
  return changed;
}

// ───────────────────────────── scorecard ─────────────────────────────
// [section, key, label, test]: each group's results on resolved calls.
export const GROUPS = [
  ["final", "yes", "Final YES (the trade was taken)", (c) => c.final === "YES"],
  ["final", "watch", "Final WATCH (if bought anyway)", (c) => c.final === "WATCH"],
  ["final", "no", "Final NO (if bought anyway)", (c) => c.final === "NO"],
  ["trader", "take", "Trader said TAKE", (c) => c.trader === "TAKE"],
  ["trader", "wait", "Trader said WAIT", (c) => c.trader === "WAIT"],
  ["trader", "skip", "Trader said NO TRADE", (c) => c.trader === "SKIP"],
  ["boss", "blocked", "Boss stopped a trader TAKE (if bought anyway)", (c) => c.trader === "TAKE" && c.final !== "YES" && ["YES", "WATCH", "NO"].includes(c.boss)],
  ["boss", "upgraded", "Boss turned a trader WAIT / NO TRADE into YES", (c) => c.trader !== "TAKE" && c.final === "YES"],
  ["boss", "agreed", "Boss agreed with the trader", (c) => c.bossAgrees === true],
  ["boss", "overturned", "Boss overturned the trader", (c) => c.bossAgrees === false],
  ["debate", "bull", "Bull won the debate", (c) => c.debate?.winner === "bull"],
  ["debate", "bear", "Bear won the debate", (c) => c.debate?.winner === "bear"],
  ["debate", "even", "Debate even", (c) => c.debate?.winner === "even"],
  ["news", "calm", "News risk none or low", (c) => c.news === "none" || c.news === "low"],
  ["news", "risky", "News risk medium or high", (c) => c.news === "medium" || c.news === "high"],
  ["data", "good", "Data rated good", (c) => c.data === "good"],
  ["data", "partial", "Data rated partial", (c) => c.data === "partial"],
  ["data", "poor", "Data rated poor", (c) => c.data === "poor"],
  ["source", "manual", "Your analyses", (c) => c.source === "manual"],
  ["source", "alert", "Automatic alert reviews", (c) => c.source === "alert"],
  ["source", "trigger", "Trigger re-checks", (c) => c.source === "trigger"],
  ["kind", "spot", "Spot coins", (c) => c.kind === "spot"],
  ["kind", "alpha", "Alpha tokens", (c) => c.kind === "alpha"],
];
const stat = (g) => (g.length ? { n: g.length, hitTargetPct: share(g, (c) => c.track.status === "win"), hitStopPct: share(g, (c) => c.track.status === "loss"),
  inProfitPct: share(g, (c) => c.track.netPct > 0), avgNetPct: avg(g.map((c) => c.track.netPct)) } : { n: 0 });

export function scorecard(calls) {
  const done = calls.filter((c) => RESOLVED.includes(c.track.status));
  const groups = GROUPS.map(([section, key, label, fn]) => ({ section, key, label, ...stat(done.filter(fn)) })).filter((g) => g.n > 0);
  const yes = groups.find((g) => g.section === "final" && g.key === "yes") || { n: 0 }, no = stat(done.filter((c) => c.final !== "YES"));
  // Does the trader's stated chance of the target match what happened?
  const calibration = [[0, 20], [20, 30], [30, 40], [40, 101]].map(([lo, hi]) => {
    const g = done.filter((c) => Number.isFinite(c.probTargetPct) && c.probTargetPct >= lo && c.probTargetPct < hi);
    return { band: hi > 100 ? `${lo}%+` : `${lo}-${hi - 1}%`, n: g.length, saidPct: avg(g.map((c) => c.probTargetPct)), hitPct: share(g, (c) => c.track.status === "win") };
  }).filter((b) => b.n > 0);
  return { total: calls.length, open: calls.filter((c) => c.track.status === "open").length, resolved: done.length,
    // average result of a YES minus that of a WATCH or NO bought anyway: above 0 = the committee picks better than its rejects
    edgePct: yes.n && no.n ? r2(yes.avgNetPct - no.avgNetPct) : null, notYes: no, groups, calibration };
}

// The committee's own record for its prompts, on calls of the SAME kind of coin and the SAME alert tier only (other
// tiers behave differently): groups with 5+ resolved calls, the calibration bands with 5+, and the latest losing YES
// calls with what the bear had said. Fewer than 5 resolved: "no track record for this tier".
export function trackRecord(calls, kind = null, now = Date.now(), tier = null) {
  const pool = calls.filter((c) => RESOLVED.includes(c.track.status) && (!kind || c.kind === kind) && (!tier || c.tier === tier));
  if (pool.length < 5) return { resolved: pool.length, tier, note: "no track record for this tier" };
  const sc = scorecard(pool);
  const pick = (s, k) => { const g = sc.groups.find((x) => x.section === s && x.key === k); return g && g.n >= 5 ? { n: g.n, hitTargetPct: g.hitTargetPct, hitStopPct: g.hitStopPct, avgNetPct: g.avgNetPct } : null; };
  return {
    resolved: pool.length, scope: `${kind || "all"} calls${tier ? `, tier ${tier}` : ""}`, tier, edgeYesMinusNoPct: sc.edgePct,
    finalYes: pick("final", "yes"), finalWatchIfBought: pick("final", "watch"), finalNoIfBought: pick("final", "no"),
    bossStoppedTakes: pick("boss", "blocked"), bossTurnedIntoYes: pick("boss", "upgraded"), bullWon: pick("debate", "bull"), bearWon: pick("debate", "bear"),
    calibration: sc.calibration.filter((b) => b.n >= 5),
    recentLosingYes: pool.filter((c) => c.final === "YES" && c.track.status === "loss").sort((a, b) => b.at - a.at).slice(0, 3)
      .map((c) => ({ symbol: c.symbol, daysAgo: r2((now - c.at) / DAY, 1), resultPct: c.track.netPct, bearHadSaid: c.debate?.bearPath || null })),
  };
}

// Average move of the calls of this kind and tier that ended at the time limit (before costs), from 5 or more.
export function timeoutAverage(calls, kind, tier) {
  const g = calls.filter((c) => c.track.status === "timeout" && c.kind === kind && c.tier === tier && Number.isFinite(c.track.exitPct));
  return g.length >= 5 ? { pct: avg(g.map((c) => c.track.exitPct)), n: g.length } : null;
}

// ───────────────────────────── WAIT triggers ─────────────────────────────
// Cleans a trigger: breakout = a candle closes above the price (0.05-10% above now); pullback = the price trades down to
// it (0.05-10% below now). Timeframe 5m / 15m / 1h, time limit 10 minutes to 24 hours. Null if unusable.
export function cleanTrigger(t, price) {
  if (!t || typeof t !== "object" || !(price > 0)) return null;
  const event = ["breakout", "pullback"].includes(t.event) ? t.event : null, px = Number(t.price);
  if (!event || !(px > 0)) return null;
  const dist = (px / price - 1) * 100;
  if (event === "breakout" ? !(dist > 0.05 && dist <= 10) : !(dist < -0.05 && dist >= -10)) return null;
  return { event, price: px, timeframe: ["5m", "15m", "1h"].includes(t.timeframe) ? t.timeframe : "5m",
    expiresMinutes: clamp(Math.round(Number(t.expiresMinutes) || 60), 10, 1440), distPct: r2(dist) };
}
// The Final Boss's WATCH triggers are free text ({condition, field, threshold}). The first one that names a price
// (field "price", or words like close / break / dip / pullback) with a level within 10% of the price becomes a watched
// trigger: "above / break / reclaim / >" = breakout, "below / dip / pullback / retest / <" = pullback (else by side of
// the price). Percent thresholds (buyers, funding) are left to the committee's re-check. Null if none can be watched.
export function triggerFromWatch(list, expiresHours, price) {
  for (const t of Array.isArray(list) ? list : []) {
    const text = `${t?.condition || ""} ${t?.threshold || ""}`.toLowerCase(), field = String(t?.field || "").toLowerCase(), th = String(t?.threshold || "");
    if (/%/.test(th) || !(/price|level|close|resist|support/.test(field) || /close|break|dip|pull ?back|retest|reclaim/.test(text))) continue;
    const nums = (th.replace(/,/g, "").replace(/\b\d+\s*(m|h|d|min|mins|minutes|hours?)\b/gi, " ").match(/\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number).filter((x) => x > 0);
    if (!nums.length) continue;
    const px = nums.sort((a, b) => Math.abs(a / price - 1) - Math.abs(b / price - 1))[0];
    const up = /above|break|reclaim|>|over\b|higher/.test(text), down = /below|dip|pull ?back|retest|<|falls? to|drops? to|touch/.test(text);
    const event = up && !down ? "breakout" : down && !up ? "pullback" : px > price ? "breakout" : "pullback";
    const c = cleanTrigger({ event, price: px, timeframe: (text.match(/\b(5m|15m|1h)\b/) || [])[1] || "5m", expiresMinutes: Math.round((Number(expiresHours) || 4) * 60) }, price);
    if (c) return c;
  }
  return null;
}
// Did the event happen after the trigger was armed? breakout: a candle that closed after arming closed above the price;
// pullback: a candle that started after arming traded down to it. Returns { at, price } or null.
export function triggerHit(tr, bars, barMs, now = Date.now()) {
  for (const b of bars) {
    if (tr.event === "breakout" && b.t + barMs > tr.armedAt && b.t + barMs <= now && b.c > tr.price) return { at: b.t + barMs, price: b.c };
    if (tr.event === "pullback" && b.t >= tr.armedAt && b.l <= tr.price) return { at: Math.min(now, b.t + barMs), price: tr.price };
  }
  return null;
}

// ───────────────────────────── the store ─────────────────────────────
// bars(x, { interval, startTime, limit }) -> { bars: [{t, o, h, l, c}], barMs } for a call or a trigger (x.kind spot /
// alpha, x.symbol, x.alphaId, x.quote). onTriggerHit(trigger) -> what the fresh check said (saved with the trigger).
// onWarn(level, usage): level 1 at 80% of the daily limit, 2 at 100%. dailyLimit 0 = no limit.
export function createAiTracker({ file = null, bars, now = () => Date.now(), dailyLimit = 400, onWarn = () => {}, onTriggerHit = async () => null } = {}) {
  const fresh = (day) => ({ day, requests: 0, in: 0, out: 0, think: 0, warned: 0 });
  const st = { calls: [], triggers: [], usage: fresh(dayOf(now())) };
  let timer = null, tracking = false, watching = false;
  const ready = !file ? Promise.resolve() : readFile(file, "utf8").then((s) => {
    const j = JSON.parse(s);
    st.calls = [...(Array.isArray(j.calls) ? j.calls : []), ...st.calls];
    st.triggers = [...(Array.isArray(j.triggers) ? j.triggers : []), ...st.triggers];
    if (j.usage?.day === st.usage.day) { // same day: add what was used before the restart
      for (const k of ["requests", "in", "out", "think"]) st.usage[k] += Number(j.usage[k]) || 0;
      st.usage.warned = Math.max(st.usage.warned, Number(j.usage.warned) || 0);
    }
  }).catch(() => {});
  const persist = () => {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      const body = JSON.stringify({ version: 1, calls: st.calls.slice(-KEEP_CALLS), triggers: st.triggers.slice(-KEEP_TRIGGERS), usage: st.usage });
      writeFile(file + ".tmp", body).then(() => rename(file + ".tmp", file)).catch(() => {});
    }, 1500);
    timer.unref?.();
  };

  // daily limit
  const roll = () => { const d = dayOf(now()); if (st.usage.day !== d) st.usage = fresh(d); return st.usage; };
  function countRequest() {
    const u = roll();
    u.requests++;
    const level = dailyLimit > 0 ? (u.requests >= dailyLimit ? 2 : u.requests >= dailyLimit * 0.8 ? 1 : 0) : 0;
    if (level > u.warned) { u.warned = level; try { onWarn(level, { ...u, limit: dailyLimit }); } catch { /* a warning never breaks a request */ } }
    persist();
  }
  function countTokens(t = {}) { const u = roll(); u.in += t.in || 0; u.out += t.out || 0; u.think += t.think || 0; persist(); }
  const canSpend = (n = 1) => dailyLimit <= 0 || roll().requests + n <= dailyLimit;
  const usage = () => { const u = roll(); return { day: u.day, requests: u.requests, tokens: { in: u.in, out: u.out, think: u.think }, limit: dailyLimit || null,
    left: dailyLimit > 0 ? Math.max(0, dailyLimit - u.requests) : null }; };

  // calls and triggers
  function arm(call, trig, waitFor) {
    const armed = st.triggers.filter((t) => t.status === "armed");
    for (const t of armed) if (keyOf(t) === keyOf(call)) t.status = "replaced"; // one watched event per coin: the newest
    const left = st.triggers.filter((t) => t.status === "armed");
    if (left.length >= MAX_ARMED) left[0].status = "dropped";
    const tr = { id: newId("t", call.at), callId: call.id, kind: call.kind, symbol: call.symbol, alphaId: call.alphaId, quote: call.quote, tier: call.tier, depth: call.depth,
      ...trig, waitFor: String(waitFor || "").slice(0, 240), priceAtCall: call.entry, armedAt: call.at, expiresAt: call.at + trig.expiresMinutes * MIN, status: "armed" };
    st.triggers.push(tr);
    if (st.triggers.length > KEEP_TRIGGERS + 50) st.triggers.splice(0, st.triggers.length - KEEP_TRIGGERS);
    return tr;
  }
  // Records one committee result (skipped if the same coin was recorded in the last 30 minutes, except trigger
  // re-checks) and watches its WAIT trigger. Returns { call, trigger } (either can be null).
  function record(result, { source = "manual", depth = 0 } = {}) {
    let call = callFromResult(result, { source, depth, at: now() });
    if (!call) return { call: null, trigger: null };
    const dup = source !== "trigger" && st.calls.findLast((c) => keyOf(c) === keyOf(call) && call.at - c.at >= 0 && call.at - c.at < DUP_MS);
    if (dup) call = dup;
    else { st.calls.push(call); if (st.calls.length > KEEP_CALLS + 200) st.calls.splice(0, st.calls.length - KEEP_CALLS); }
    const trigger = result.decision === "WAIT" && result.trigger && depth < MAX_DEPTH ? arm({ ...call, at: now(), depth }, result.trigger, result.waitFor) : null;
    persist();
    return { call, trigger };
  }
  function cancel(id) {
    const t = st.triggers.find((x) => x.id === id && x.status === "armed");
    if (t) { t.status = "cancelled"; persist(); }
    return !!t;
  }

  // Follows open calls with new candles: 1-minute candles for spot coins, 5-minute for Alpha tokens.
  async function trackOpen(max = 30) {
    await ready;
    if (tracking) return 0;
    tracking = true;
    try {
      const t = now(), open = st.calls.filter((c) => c.track.status === "open" && t - (c.track.checkedAt || 0) >= 2 * MIN)
        .sort((a, b) => (a.track.checkedAt || 0) - (b.track.checkedAt || 0)).slice(0, max);
      let changed = 0;
      for (let i = 0; i < open.length; i += 4) {
        await Promise.all(open.slice(i, i + 4).map(async (c) => {
          const interval = c.kind === "alpha" ? "5m" : "1m";
          c.track.checkedAt = t;
          try {
            const got = await bars(c, { interval, startTime: c.track.to ?? Math.floor(c.at / TF[interval]) * TF[interval], limit: 1000 });
            if (applyBars(c, got.bars || [], got.barMs || TF[interval], t)) changed++;
          } catch { if (applyBars(c, [], TF[interval], t)) changed++; } // no data for a long time: timeout / nodata
        }));
      }
      if (changed) persist();
      return changed;
    } finally { tracking = false; }
  }

  // Checks armed triggers; a hit is saved, then onTriggerHit runs (the fresh committee check) and its answer is saved.
  async function checkTriggers() {
    await ready;
    if (watching) return [];
    watching = true;
    try {
      const t = now(), hits = [];
      for (const tr of st.triggers.filter((x) => x.status === "armed")) {
        if (t >= tr.expiresAt) { tr.status = "expired"; persist(); continue; }
        const interval = tr.event === "pullback" ? (tr.kind === "alpha" ? "5m" : "1m") : tr.timeframe;
        try {
          const got = await bars(tr, { interval, startTime: Math.floor(tr.armedAt / TF[interval]) * TF[interval], limit: 500 });
          const hit = triggerHit(tr, got.bars || [], got.barMs || TF[interval], t);
          if (hit) { Object.assign(tr, { status: "hit", hitAt: hit.at, hitPrice: hit.price }); persist(); hits.push(tr); }
        } catch { /* try again next minute */ }
      }
      await Promise.all(hits.map(async (tr) => {
        try { tr.result = (await onTriggerHit(tr)) || null; } catch (e) { tr.result = { error: e.message }; }
        persist();
      }));
      return hits;
    } finally { watching = false; }
  }

  function view({ recent = 40 } = {}) {
    const armed = st.triggers.filter((t) => t.status === "armed").reverse(), past = st.triggers.filter((t) => t.status !== "armed").slice(-15).reverse();
    return { scorecard: scorecard(st.calls), calls: st.calls.slice(-recent).reverse(), triggers: { armed, past }, usage: usage() };
  }
  function start({ trackMs = 2 * MIN, watchMs = MIN } = {}) {
    const a = setInterval(() => trackOpen().catch(() => {}), trackMs), b = setInterval(() => checkTriggers().catch(() => {}), watchMs);
    a.unref?.(); b.unref?.();
    setTimeout(() => { trackOpen().catch(() => {}); checkTriggers().catch(() => {}); }, 20_000).unref?.();
    return () => { clearInterval(a); clearInterval(b); };
  }
  return { ready, record, cancel, trackOpen, checkTriggers, view, start, countRequest, countTokens, canSpend, usage,
    trackRecord: (kind, tier) => trackRecord(st.calls, kind, now(), tier), timeoutAverage: (kind, tier) => timeoutAverage(st.calls, kind, tier), _state: st };
}

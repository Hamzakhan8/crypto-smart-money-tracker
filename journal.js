// Trade journal: your own trades, usually started from an alert ("I took it"), with your real entry, exit, size and
// fees, so your results can be compared with the alerts' tracked results. The gap shows what slippage and timing cost
// you. Saved in journal.json (kept out of git). Nothing is ever sent to an exchange. Node.js 18+, no dependencies.

import { readFile, writeFile, rename } from "node:fs/promises";

const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const TOOLS = ["ignition", "early", "bigmove", "alpha", "early2x", "perps", "other"];
const dirOf = (j) => (j.side === "short" ? -1 : 1); // shorts (perps) gain when price falls
const pos = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };

// One trade's result. P&L in $ after your fees; % of the position; R = result in units of the planned risk (needs a stop
// on the right side: below the entry for a long, above for a short).
export function tradeResult(j, livePrice = null) {
  const exit = j.exitPrice ?? livePrice, size = j.sizeUsd ?? null, dir = dirOf(j);
  if (!(j.entryPrice > 0) || !(exit > 0)) return { open: j.exitPrice == null, pnlPct: null, pnlUsd: null, r: null };
  const move = dir * (exit / j.entryPrice - 1), fees = j.feesUsd ?? 0;
  const pnlUsd = size ? size * move - fees : null, pnlPct = size ? (pnlUsd / size) * 100 : move * 100;
  const risk = j.stopPrice > 0 && dir * (j.entryPrice - j.stopPrice) > 0 ? Math.abs(j.entryPrice - j.stopPrice) / j.entryPrice : null;
  return { open: j.exitPrice == null, pnlPct: r2(pnlPct), pnlUsd: r2(pnlUsd), r: risk ? r2(move / risk) : null,
    holdMin: j.exitTime && j.entryTime ? Math.round((j.exitTime - j.entryTime) / 60_000) : null };
}

// Summary of closed trades, and "you vs the alerts" on trades that came from a tracked alert.
export function journalSummary(rows) {
  const closed = rows.filter((x) => !x.result.open && Number.isFinite(x.result.pnlPct)), open = rows.filter((x) => x.result.open);
  const avg = (a) => (a.length ? r2(a.reduce((s, v) => s + v, 0) / a.length) : null);
  const pcts = closed.map((x) => x.result.pnlPct), rs = closed.map((x) => x.result.r).filter(Number.isFinite);
  const usd = closed.map((x) => x.result.pnlUsd).filter(Number.isFinite);
  const linked = closed.filter((x) => x.alert && Number.isFinite(x.alert.netPct));
  const slip = rows.filter((x) => x.alert?.price > 0 && x.entryPrice > 0).map((x) => dirOf(x) * (x.entryPrice / x.alert.price - 1) * 100);
  return {
    trades: rows.length, open: open.length, closed: closed.length, wins: closed.filter((x) => x.result.pnlPct > 0).length,
    winRatePct: closed.length ? Math.round((closed.filter((x) => x.result.pnlPct > 0).length / closed.length) * 100) : null,
    totalPnlUsd: usd.length ? r2(usd.reduce((s, v) => s + v, 0)) : null, avgPnlPct: avg(pcts), avgR: avg(rs),
    bestPct: pcts.length ? r2(Math.max(...pcts)) : null, worstPct: pcts.length ? r2(Math.min(...pcts)) : null,
    openPnlUsd: r2(open.map((x) => x.result.pnlUsd).filter(Number.isFinite).reduce((s, v) => s + v, 0)),
    avgEntryVsAlertPct: avg(slip), // + = a worse fill than the alert price (above it for a long, below it for a short)
    vsAlerts: { trades: linked.length, yourAvgPct: avg(linked.map((x) => x.result.pnlPct)), alertAvgPct: avg(linked.map((x) => x.alert.netPct)) },
    byTool: TOOLS.map((t) => { const g = closed.filter((x) => x.tool === t); return { tool: t, closed: g.length, avgPnlPct: avg(g.map((x) => x.result.pnlPct)),
      winRatePct: g.length ? Math.round((g.filter((x) => x.result.pnlPct > 0).length / g.length) * 100) : null }; }).filter((x) => x.closed),
  };
}

// Cleans a trade sent from the page. Returns { trade } or { error }.
export function cleanTrade(b, prev = null) {
  const t = { ...(prev || {}) };
  if (b.symbol !== undefined) { const s = String(b.symbol || "").trim().slice(0, 30); if (!s) return { error: "Symbol is missing" }; t.symbol = s; }
  if (b.tool !== undefined) t.tool = TOOLS.includes(b.tool) ? b.tool : "other";
  if (b.side !== undefined) t.side = b.side === "short" ? "short" : "long";
  for (const k of ["entryPrice", "exitPrice", "sizeUsd", "stopPrice", "targetPrice"]) if (b[k] !== undefined) t[k] = b[k] === null || b[k] === "" ? null : pos(b[k]);
  if (b.feesUsd !== undefined) { const f = Number(b.feesUsd); t.feesUsd = Number.isFinite(f) && f >= 0 ? f : null; }
  for (const k of ["entryTime", "exitTime"]) if (b[k] !== undefined) { const v = Number(b[k]); t[k] = Number.isFinite(v) && v > 1e12 ? v : b[k] === null ? null : Date.now(); }
  if (b.note !== undefined) t.note = String(b.note || "").slice(0, 500);
  if (b.alertId !== undefined) t.alertId = b.alertId ? String(b.alertId).slice(0, 120) : null;
  if (b.alphaId !== undefined) t.alphaId = b.alphaId ? String(b.alphaId).slice(0, 30) : null;
  if (!t.symbol) return { error: "Symbol is missing" };
  if (!(t.entryPrice > 0)) return { error: "Entry price must be a positive number" };
  if (t.exitPrice != null && !t.exitTime) t.exitTime = Date.now();
  if (t.exitPrice == null) t.exitTime = null;
  t.tool ||= "other"; t.side ||= "long"; t.entryTime ||= Date.now();
  return { trade: t };
}

export function createJournal({ file, priceOf = async () => null, alertResult = () => null }) {
  let trades = null, priceCache = new Map();
  const load = async () => { if (trades) return; try { const j = JSON.parse(await readFile(file, "utf8")); trades = Array.isArray(j.trades) ? j.trades : []; } catch { trades = []; } };
  const save = () => writeFile(file + ".tmp", JSON.stringify({ version: 1, trades })).then(() => rename(file + ".tmp", file));
  async function live(j) {
    const key = `${j.tool}:${j.alphaId || j.symbol}`, hit = priceCache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.p;
    const p = await priceOf(j).catch(() => null);
    priceCache.set(key, { at: Date.now(), p });
    return p;
  }
  async function view() {
    await load();
    const rows = await Promise.all(trades.map(async (j) => {
      const lp = j.exitPrice == null ? await live(j) : null, a = j.alertId ? alertResult(j.alertId) : null;
      return { ...j, livePrice: lp, result: tradeResult(j, lp), alert: a };
    }));
    rows.sort((a, b) => (b.entryTime || 0) - (a.entryTime || 0));
    return { trades: rows, summary: journalSummary(rows) };
  }
  const json = (res, code, d) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(d)); };
  // Changes only from this site: JSON content type and a same-host Origin.
  const sameSite = (req) => String(req.headers["content-type"] || "").includes("application/json") && (!req.headers.origin || req.headers.origin.replace(/^https?:\/\//, "") === req.headers.host);
  const body = (req) => new Promise((ok, bad) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 20_000) { bad(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { bad(new Error("invalid JSON")); } }); req.on("error", bad); });
  return {
    view,
    async handle(req, res, url) {
      if (!url.pathname.startsWith("/api/journal")) return false;
      try {
        if (url.pathname === "/api/journal" && req.method === "GET") return json(res, 200, await view()), true;
        if (req.method !== "POST") return json(res, 405, { error: "Use POST" }), true;
        if (!sameSite(req)) return json(res, 403, { error: "Only this site can change the journal" }), true;
        await load();
        const b = await body(req);
        if (url.pathname === "/api/journal") {
          const c = cleanTrade(b);
          if (c.error) return json(res, 400, c), true;
          trades.push({ ...c.trade, id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() });
        } else if (url.pathname === "/api/journal/update") {
          const i = trades.findIndex((x) => x.id === b.id);
          if (i < 0) return json(res, 404, { error: "Trade not found" }), true;
          const c = cleanTrade(b, trades[i]);
          if (c.error) return json(res, 400, c), true;
          trades[i] = { ...c.trade, id: trades[i].id, createdAt: trades[i].createdAt, updatedAt: Date.now() };
        } else if (url.pathname === "/api/journal/delete") {
          trades = trades.filter((x) => x.id !== b.id);
        } else return json(res, 404, { error: "Not found" }), true;
        await save();
        priceCache = new Map();
        return json(res, 200, await view()), true;
      } catch (e) { return json(res, 400, { error: e.message }), true; }
    },
  };
}

"use client";
// Setup leaderboard (the classic page's drawTable): daily setup quality of every coin, with search, filters and sort.
// Click a token to see exactly how its score was built.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useLayoutEffect, useState } from "react";
import { useScreener, type Candidate } from "../context";
import { useStateTabs } from "../ui";
import { Flags } from "../coin";
import { money, pct, price } from "@/lib/format";
import { cfg, cx, fx, tabBar } from "./util";

const SORTS: Record<string, (c: Candidate) => number | null | undefined> = { score: (c) => c.score, rvol: (c) => c.rvol, chg: (c) => c.change24h, vol: (c) => c.quoteVolume, rank: (c) => (c.rank == null ? -Infinity : -c.rank) };
const HINTS = { strong: "Igniting now, or a strong daily setup", heating: "Volume heating up, or a setup scoring 55+", running: "Already moved: do not chase (shown even with \"Hide already moved\")", take: "The AI said TAKE in the last 2 hours" };
function distText(c: Candidate) { const d = c.distToHigh; if (d == null) return "—"; return d < 0 ? `${(Math.abs(d) * 100).toFixed(1)}% below 20d high` : `+${(d * 100).toFixed(1)}% above 20d high`; }

export interface BoardFilters { q: string; minScore: string; hideMoved: string; narrOnly: string; sortBy: string; rowLimit: string }
export const BOARD_DEFAULTS: BoardFilters = { q: "", minScore: "0", hideMoved: "1", narrOnly: "0", sortBy: "score", rowLimit: "15" };

export function Leaderboard({ f, setF }: { f: BoardFilters; setF: (f: BoardFilters) => void }) {
  const { data, aiTake, openDetail } = useScreener();
  const min = cfg(data).minScore;
  // "Hide already moved" does not apply under the "Already running" tab: mirror the tab picked in the bar
  const [tabNow, setTabNow] = useState("all");
  const q = f.q.trim().toLowerCase(), ms = Number(f.minScore), no = f.narrOnly === "1", hm = f.hideMoved === "1" && tabNow !== "running";
  const all0 = (data?.candidates || []).filter((c) => c.core !== false && (c.base.toLowerCase().includes(q) || String(c.name).toLowerCase().includes(q)) && c.score >= ms && (!no || c.narrative) && (!hm || !c.moved));
  const st = useStateTabs("board", all0, (c) => ({
    strong: !c.moved && (c.ignition === "ignited" || c.score >= min), heating: !c.moved && c.ignition !== "ignited" && c.score < min && (c.ignition === "heating" || c.score >= 55),
    running: !!c.moved, take: aiTake(c.base),
  }), HINTS);
  useLayoutEffect(() => { if (st.current !== tabNow) setTabNow(st.current); }, [st.current, tabNow]);
  const all = st.rows, key = SORTS[f.sortBy] || SORTS.score, lim = Number(f.rowLimit);
  const sorted = [...all].sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity));
  const rows = lim > 0 ? sorted.slice(0, lim) : sorted, w = data?.warmup;
  const set = (k: keyof BoardFilters) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Setup leaderboard</h2><p>Daily setup quality. Click a token to see exactly how its score was built</p></div>
        <span className="chip" id="count">{data ? `${rows.length < all.length ? `${rows.length} of ${all.length}` : all.length} tokens` : "—"}</span></div>
      <div className="section-head" style={{ paddingTop: 0 }}><div className="filters">
        <input id="search" placeholder="Search token, e.g. SUI" aria-label="Search tokens" value={f.q} onChange={set("q")} />
        <select id="minScore" aria-label="Minimum score" value={f.minScore} onChange={set("minScore")}><option value="0">All scores</option><option value="40">Score 40+</option><option value="55">Score 55+</option><option value="70">Score 70+</option></select>
        <select id="hideMoved" aria-label="Already moved filter" value={f.hideMoved} onChange={set("hideMoved")}><option value="1">Hide already moved</option><option value="0">Show already moved</option></select>
        <select id="narrOnly" aria-label="Narrative filter" value={f.narrOnly} onChange={set("narrOnly")}><option value="0">All narratives</option><option value="1">Hot narrative only</option></select>
        <select id="sortBy" aria-label="Sort tokens" value={f.sortBy} onChange={set("sortBy")}><option value="score">Sort: score</option><option value="rvol">Sort: relative volume</option><option value="chg">Sort: 24h change</option><option value="vol">Sort: 24h volume</option><option value="rank">Sort: market cap rank</option></select>
        <select id="rowLimit" aria-label="Rows to show" value={f.rowLimit} onChange={set("rowLimit")}><option value="15">Show 15</option><option value="50">Show 50</option><option value="150">Show all</option></select>
      </div></div>
      {tabBar(st.bar, "Filter tokens", !!data)}
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Token</th><th>Score</th><th>Volume</th><th>Chart setup</th><th>RSI</th><th>Market cap</th><th>Narrative</th><th>Futures</th><th>24h volume</th><th>Signal</th></tr></thead>
        <tbody id="tbody">
          {!data ? <tr><td colSpan={10} className="empty">Waiting for the first scan… the first run loads daily candles and can take a minute.</td></tr>
            : rows.length ? rows.map((c) => {
              const klass = c.moved ? "risk" : c.score >= min ? "strong" : c.score >= 55 ? "watch" : "";
              return (
                <tr key={c.symbol}>
                  <td><button className="coin-link sym" data-sym={c.symbol} title="See score breakdown" onClick={() => openDetail(c)}>{c.base} ↗</button><Flags c={c} /><span className="sub">{c.rank ? `Rank #${c.rank}` : "Rank n/a"} · {price(c.price)}</span></td>
                  <td><span className="score mono">{c.score}<span className="scorebar"><i style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} /></span></span></td>
                  <td className={cx("mono", c.rvol >= 2 && "green")}>{c.rvol == null ? "—" : `${fx(c.rvol, 2)}×`}<span className="sub">24h vs 20-day avg</span></td>
                  <td>{distText(c)}<span className="sub">{c.compressed ? "volatility compressed" : "normal volatility"}{c.aboveSma ? " · above 20d avg" : ""}</span></td>
                  <td className={cx("mono", c.rsi > 72 && "red")}>{c.rsi == null ? "—" : fx(c.rsi, 0)}</td>
                  <td className="mono">{money(c.marketCap)}</td>
                  <td>{c.narrative ? <>{c.narrative.names.slice(0, 2).join(", ")}<span className="sub green">coins {pct(c.narrative.change24hPct)} 24h</span></> : <span className="muted">—</span>}</td>
                  <td>{c.fundingPct == null ? <span className="muted">no futures</span>
                    : <><span className={cx("mono", c.fundingPct > 0.05 && "red")}>{fx(c.fundingPct, 3)}%</span><span className="sub">OI 24h {c.oiChange24hPct == null ? "—" : pct(c.oiChange24hPct)}</span></>}</td>
                  <td className="mono">{money(c.quoteVolume)}<span className={`sub ${c.change24h >= 0 ? "green" : "red"}`}>{pct(c.change24h)}</span></td>
                  <td><span className={cx("badge", klass)}>{c.label}</span><span className="sub">{c.moved ? (c.movedWhy || []).join(" · ") : c.slow ? "moves too little for the target" : (c.reasons || []).slice(0, 2).join(" · ")}</span></td>
                </tr>);
            }) : <tr><td colSpan={10} className="empty">{w && w.loaded < w.total ? `Warming up: loaded daily charts for ${w.loaded} of ${w.total} tokens…` : "No tokens match these filters."}</td></tr>}
        </tbody></table></div>
    </section>
  );
}

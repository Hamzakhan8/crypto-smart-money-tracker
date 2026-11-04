"use client";
// Live ignition watch (the classic page's drawIgnite): every coin whose 15-minute volume is igniting, heating up or
// already ran, best first. Click a coin for its setup detail.
import { useScreener, type Candidate } from "../context";
import { useStateTabs } from "../ui";
import { Flags, IGN_STATE, RotTag, structure } from "../coin";
import { col, pct1, price } from "@/lib/format";
import { cfg, cx, fx, tabBar } from "./util";

const ORDER: Record<string, number> = { ignited: 0, heating: 1, ran: 2 };
const HINTS = { strong: "Igniting now: both 5m candles passed the rule", heating: "Volume building, the rule is not met yet", running: "Already ran: do not chase", take: "The AI said TAKE in the last 2 hours" };

function Row({ c, igniteMin, onOpen }: { c: Candidate; igniteMin: number | undefined; onOpen: () => void }) {
  const [txt, k] = IGN_STATE[c.ignition as string] || ["—", ""];
  const g = c.gate;
  const sub = c.moved ? <span className="sub red">{(c.movedWhy || []).slice(0, 2).join(" · ")}</span>
    : c.ignition === "heating" && (c.missing || []).length ? <span className="sub amber">needs: {c.missing.slice(0, 3).join(", ")}</span>
      : c.ignition === "ignited" ? <span className="sub green">{structure(c)}
        {(c.igScore ?? 0) < (igniteMin as number) && c.earlySigns != null ? ` · early ${c.earlySigns}/4 quality signs${c.earlySigns >= 3 ? " (A+)" : ""}` : ""}
        {g ? (g.pass ? " · quality gate passed" : <>{" · "}<span className="muted">gate failed: {g.smallTickets === false ? "big trades" : ""}{g.smallTickets === false && g.calmRange === false ? ", " : ""}
          {g.calmRange === false ? "wide 24h range" : ""}{g.smallTickets == null || g.calmRange == null ? "data missing" : ""}</span></>) : ""}</span> : null;
  return (
    <tr>
      <td><button className="coin-link sym" data-sym={c.symbol} onClick={onOpen}>{c.base} ↗</button><Flags c={c} /><span className="sub">{c.rank ? `Rank #${c.rank}` : "Rank n/a"} · {price(c.price)}</span></td>
      <td><span className={`badge ${k}`}>{txt}</span>{sub}</td>
      <td className={cx("mono", c.r5 >= 3 && c.prevR5 >= 3 && "green")}>{c.r5 == null ? "—" : `${fx(c.prevR5, 1)}× → ${fx(c.r5, 1)}×`} · {c.rvol15 == null ? "—" : `${fx(c.rvol15, 1)}×`}
        <span className="sub">last two 5m candles · 15m · 1h {c.rvol1h == null ? "—" : `${fx(c.rvol1h, 1)}×`}{c.tradesRatio != null ? ` · trades ${fx(c.tradesRatio, 1)}×` : ""}</span></td>
      <td className="mono"><span className={cx(col(c.ret15m))}>{pct1(c.ret15m)}</span> 15m<span className="sub">{pct1(c.ret1h)} 1h · {pct1(c.change24h)} 24h</span></td>
      <td className={cx("mono", c.buyRatio15m >= 58 ? "green" : c.buyRatio15m < 50 ? "red" : "")}>{c.buyRatio15m == null ? "—" : `${fx(c.buyRatio15m, 0)}% buy`}
        {c.spreadBps != null && <span className="sub">spread {fx(c.spreadBps, 1)} bps</span>}</td>
      <td className="mono">{c.igScore == null ? "—" : <span className="score">{c.igScore}<span className="scorebar"><i style={{ width: `${c.igScore}%` }} /></span></span>}
        <span className="sub">daily {c.score} · {c.label}</span></td>
      <td><RotTag c={c} /></td>
    </tr>
  );
}

export function LiveWatch() {
  const { data, aiTake, openDetail } = useScreener();
  const all = (data?.candidates || []).filter((c) => c.ignition)
    .sort((a, b) => ORDER[a.ignition as string] - ORDER[b.ignition as string] || (b.igScore || 0) - (a.igScore || 0) || (b.rvol15 || 0) - (a.rvol15 || 0));
  const st = useStateTabs("live", all, (c) => ({ strong: c.ignition === "ignited" && !c.moved, heating: c.ignition === "heating" && !c.moved, running: c.ignition === "ran" || !!c.moved, take: aiTake(c.base) }), HINTS);
  const rows = st.rows.slice(0, 20), w = data?.warmup, igniteMin = cfg(data).igniteMinScore;
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="section-head"><div><h2>Live ignition watch</h2><p>15-minute volume vs the token&apos;s normal for this hour of the day. Green = confirmed early, amber = building (shows what it still lacks), red = already running (do not chase).</p></div>
        <span className="chip" id="igCount">{data ? `${all.length} tokens` : "—"}</span></div>
      {tabBar(st.bar, "Filter tokens", !!data)}
      {data?.breadth?.marketWide && <div className="notice" id="mwBanner" style={{ display: "block", margin: "0 18px 12px" }}><b>Market-wide volume surge:</b> many tokens are surging together, so the ignition bar is raised 50% to avoid alerting on a market move that is not specific to one token.</div>}
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Token</th><th>State</th><th>Volume (5m · 15m)</th><th>Price move</th><th>Buyers (15m)</th><th>Ignition score</th><th>Narrative</th></tr></thead>
        <tbody id="igBody">
          {!data ? <tr><td colSpan={7} className="empty">Waiting for the first scan…</td></tr>
            : rows.length ? rows.map((c) => <Row key={c.symbol} c={c} igniteMin={igniteMin} onOpen={() => openDetail(c)} />)
              : <tr><td colSpan={7} className="empty">{w && w.loaded < w.total ? `Warming up: loaded daily charts for ${w.loaded} of ${w.total} tokens…` : st.empty("Nothing is igniting right now. Quiet is normal.")}</td></tr>}
        </tbody></table></div>
    </section>
  );
}

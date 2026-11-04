"use client";
// The Early 2x tab's rows: one candidate in the list, one recent snapshot, and the measured-results tables.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { col, money, pct1, price, when } from "@/lib/format";
import { XSTATE, xfam, xn, type X2Candidate } from "./shared";

// ---------- one candidate ----------
export function CandidateRow({ c, onOpen }: { c: X2Candidate; onOpen: () => void }) {
  const [st, k] = XSTATE[c.state || ""] || ["—", ""], v = c.vol, f = c.flow, p = c.px, l = c.liq, d = c.deriv;
  const pr = c.priority === "high" ? <span className="badge strong">High priority</span> : c.priority === "watch" ? <span className="badge watch">Watch</span> : null;
  const tg = c.targets.map((t: any) => `+${t.pct}% ${price(t.price)}`).join(" · ");
  const fut = !d ? <span className="muted">unavailable</span> : d.available === false ? <span className="muted">no perpetual</span>
    : <>OI 24h {pct1(d.oi24hPct)}<span className="sub">1h {pct1(d.oi1hPct)} · 48h {pct1(d.oi48hPct)}</span>
      <span className={`sub ${d.crowded ? "red" : ""}`}>funding {d.fundingPct == null ? "—" : `${d.fundingPct.toFixed(4)}%`}{d.transition ? ` · ${d.transition}` : ""}</span></>;
  const oc = c.onchain || {}, ocTxt = [oc.whales ? `whales: ${oc.whales.netToExchangesUsd24h > 0 ? "+" : ""}${money(oc.whales.netToExchangesUsd24h)} net to exchanges (${oc.whales.transfers24h})` : "",
    oc.dex ? `DEX net ${oc.dex.netUsd24h >= 0 ? "+" : "-"}${money(Math.abs(oc.dex.netUsd24h))} (${oc.dex.swaps24h} swaps)` : ""].filter(Boolean);
  const sup = c.supply && c.supply.circulatingShare != null ? `${Math.round(c.supply.circulatingShare * 100)}% circulating` : <span className="muted">supply n/a</span>;
  const un = c.unlock.state === "major" ? <span className="sub red">unlock: {c.unlock.text}</span> : c.unlock.state === "clear" ? <span className="sub green">no major unlock (verified)</span> : <span className="sub muted">unlocks not verified</span>;
  const cat = c.catalysts.length ? <span className="sub green">{c.catalysts[0].title} ({c.catalysts[0].date})</span> : null;
  const miss = c.state === "moved" ? <span className="red">{c.late.filter((x: any) => x.severity === "reject").map((x: any) => x.why).join(" · ")}</span>
    : c.missing.length ? <><span className="amber">{c.missing.slice(0, 2).join(" · ")}</span>{c.missing.length > 2 ? <span className="sub">+{c.missing.length - 2} more (click the token)</span> : null}</>
    : <span className="green">nothing</span>;
  const monitoring = (c.tags || []).some((t: string) => /monitoring/i.test(t));
  return (
    <tr>
      <td><button className="coin-link sym" onClick={onOpen}>{c.base} ↗</button>{monitoring ? <> <span className="badge risk">Monitoring</span></> : null}<span className="sub">{c.pair} · {c.name}</span>
        {c.history && c.history.recent ? <span className="sub amber">listed {c.history.days} days ago</span> : null}</td>
      <td><span className="score mono">{c.score}<span className="scorebar"><i style={{ width: `${c.score}%` }} /></span></span><span className="sub"><span className={`badge ${k}`}>{st}</span> {pr}</span>
        <span className="sub">{c.confirmations}/5 confirmed: {c.families.filter((x: any) => x.ok).map((x: any) => xfam[x.key]).join(", ") || "none"}</span>
        {c.flags.length ? <span className="sub red">{c.flags.length} risk flag{c.flags.length > 1 ? "s" : ""}</span> : null}</td>
      <td className="mono">{money(c.mcap)}<span className="sub">{c.preferred ? "preferred range" : "extended range"} · {c.mcapBand || ""}</span>
        <span className="sub">{c.mcapSource.startsWith("Binance") ? "Binance supply" : "CoinGecko"}{c.mcapCoinGecko ? ` · CoinGecko ${money(c.mcapCoinGecko)}` : ""}</span></td>
      <td className="mono">{price(c.price)}<span className="sub">{tg}</span><span className="sub">2x market cap {money(c.mcapAt2x)} (same supply)</span></td>
      <td className={`mono ${v.r24 >= 2 ? "green" : ""}`}>24h {xn(v.r24)} · 1h {xn(v.r1h, 1)}<span className="sub">5m {xn(v.r5, 1)} · 15m {xn(v.r15, 1)} · held {v.persist12 ?? "—"}/12h</span>
        <span className="sub">trades {xn(v.trades24)} (24h){v.consec5 ? ` · ${v.consec5} hot 5m candle${v.consec5 > 1 ? "s" : ""}` : ""}</span></td>
      <td className={`mono ${f.buy24 >= 53 ? "green" : f.buy24 < 50 ? "red" : ""}`}>{f.buy24 == null ? "—" : `${f.buy24.toFixed(1)}%`} buy
        <span className="sub">{f.buyDelta == null ? "" : `${f.buyDelta >= 0 ? "+" : ""}${f.buyDelta.toFixed(1)} pts vs 7d`} · 15m {f.buy15 == null ? "—" : `${f.buy15.toFixed(0)}%`}</span>
        <span className="sub">CVD {f.cvdAccel ? <span className="green">accelerating</span> : f.cvdLast12 > 0 ? "positive" : "negative"}{f.large && f.large.buyShare != null ? ` · big trades ${f.large.buyShare.toFixed(0)}% buys` : ""}</span></td>
      <td className="mono"><span className={col(p.ret24) || undefined}>{pct1(p.ret24)}</span> 24h<span className="sub">{pct1(p.ret1h)} 1h · {pct1(p.ret4h)} 4h · {pct1(p.ret7d)} 7d</span>
        <span className="sub">vs BTC {pct1(p.rs24)}{p.rsImproving ? " ↑" : ""} · {p.aboveRange > 0 ? `${pct1(p.aboveRange)} above 7d high` : p.distToHigh == null ? "—" : `${p.distToHigh.toFixed(1)}% below 7d high`}{p.tests >= 2 ? ` (${p.tests} tests)` : ""}</span></td>
      <td className="mono">{l.spreadPct == null ? "—" : `${l.spreadPct.toFixed(3)}%`}<span className="sub">vol {money(l.quoteVolume24h)}{l.spreadTrend ? ` · ${l.spreadTrend}` : ""}</span>
        <span className="sub">{l.depthBid == null ? "depth not checked" : `±2%: ${money(l.depthBid)} bids / ${money(l.depthAsk)} asks`}</span></td>
      <td className="mono">{fut}{ocTxt.map((t, i) => <span key={i} className="sub">{t}</span>)}</td>
      <td>{sup}{un}{cat}</td>
      <td style={{ whiteSpace: "normal", minWidth: 220, fontSize: 11 }}>{miss}</td>
    </tr>
  );
}

// ---------- one recent snapshot ----------
export function RecentRow({ s }: { s: any }) {
  const t = s.track || {}, hz = Object.entries((t.horizons || {}) as Record<string, any>).pop();
  const now = t.entry ? (t.last / t.entry - 1) * 100 : null, hi = t.entry ? (t.hi / t.entry - 1) * 100 : null, lo = t.entry ? (t.lo / t.entry - 1) * 100 : null;
  const hits = Object.entries((t.targets || {}) as Record<string, any>).filter(([, v]) => v)
    .map(([k, v]) => `+${k}% in ${v.hours < 48 ? `${v.hours.toFixed(0)}h` : `${(v.hours / 24).toFixed(1)}d`}${v.beforeStop ? "" : " (after stop)"}`);
  const [st, k] = XSTATE[s.state] || ["—", ""];
  return (
    <div className="event" style={{ cursor: "default" }}>
      <div><strong><span className={`badge tier ${k}`}>{st}</span>{s.base} · {s.score}/100{s.priority === "high" ? <> <span className="badge strong">High</span></> : null}</strong>
        <small>{money(s.mcap)} · entry {price(s.price)} · {(s.confirmations || []).map((x: string) => xfam[x] || x).join(", ")}</small>
        <span className="track mono">{t.entry ? <>now <b className={col(now) || undefined}>{pct1(now)}</b> · peak {pct1(hi)} · low {pct1(lo)}{hz ? ` · ${hz[0]} ${pct1(hz[1].ret)}` : ""}
          {hits.length ? <> · <b className="green">{hits.join(", ")}</b></> : null}{t.dataEnded ? <> · <span className="red">stopped trading</span></> : null}</> : "tracking starts within minutes"}</span></div>
      <small className="mono">{when(s.at)}</small>
    </div>
  );
}

// ---------- measured results ----------
const GROUP_NAMES: Record<string, Record<string, string>> = { byState: { quiet: "Quiet accumulation", prebreakout: "Pre-breakout", ignition: "Early ignition", moved: "Already moved" }, byPriority: { high: "High priority", watch: "Watch" } };
function groups(r: any, sel: string): [string, any][] {
  if (sel === "all") return [["All candidates", r.all]];
  if (sel === "control") return [["Already moved (control)", r.controlAlreadyMoved]];
  if (sel === "chronological") return [["Older 60%", r.chronological.earlier], ["Newer 40%", r.chronological.later]];
  return Object.entries((r[sel] || {}) as Record<string, any>).map(([k, b]) => [(GROUP_NAMES[sel] || {})[k] || k, b]);
}
// The grouping stays while the page is open (the classic page kept it when you switched tabs).
let keptGroup = "all";

export function ResultsPanel({ loaded, r }: { loaded: boolean; r: any }) {
  const [sel, setSel] = useState(keptGroup);
  const gs = r ? groups(r, sel) : [], H: string[] = r ? (r.all.horizons || []).map((h: any) => h.horizon) : [];
  const cell = (t: any, w: string) => { const x = t[w]; return x.n ? <>{x.hitPct}%<span className="sub">{x.hits} of {x.n}</span></> : "—"; };
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Measured results</h2>
        <p>{r ? `Every snapshot is tracked for 42 days from its snapshot price. Returns are after ${r.feePct}% fees and ${r.slippagePct}% slippage (${r.costPct}% per trade). The -${r.stopPct}% stop is only a reference for ordering: tracking continues after it.` : "Every snapshot is tracked for 42 days."}</p></div>
        <div className="filters"><select aria-label="Group results by" value={sel} onChange={(e) => { keptGroup = e.target.value; setSel(e.target.value); }}>
          <option value="all">All candidates</option><option value="byState">By state</option><option value="byPriority">By priority</option><option value="byMcap">By market cap</option><option value="byScore">By score</option><option value="chronological">Older vs newer signals</option><option value="control">Control: already moved</option>
        </select></div></div>
      <p className="perf-note">{!loaded ? null : !r ? "No results yet." : <><b>{r.verdict}</b>{r.chronological.splitAt ? ` Older/newer split at ${when(r.chronological.splitAt)}.` : ""}</>}</p>
      <div className="table-wrap"><table className="table">
        <thead>{r && <tr><th>Group</th><th>Signals</th>{H.map((h) => <th key={h}>{h}</th>)}</tr>}</thead>
        <tbody>{r && (gs.length ? gs.map(([name, b], i) => (
          <tr key={`${name}-${i}`}><td><b>{name}</b><span className="sub">{b.open} open{b.dataEnded ? ` · ${b.dataEnded} stopped trading` : ""}{b.ambiguousBars ? ` · ${b.ambiguousBars} ambiguous bars` : ""}</span></td><td className="mono">{b.signals}</td>
            {b.horizons.map((h: any, j: number) => <td key={j} className={`mono ${col(h.avgNetPct)}`}>{h.n ? pct1(h.avgNetPct) : "—"}<span className="sub">{h.n ? `n=${h.n} · ${h.positivePct}% up · peak ${pct1(h.avgMfePct)}` : "n=0"}</span></td>)}</tr>))
          : <tr><td colSpan={11} className="empty">No signals in this group yet.</td></tr>)}</tbody>
      </table></div>
      <div className="section-head" style={{ paddingBottom: 6 }}><div><h2 style={{ fontSize: 13 }}>Targets</h2><p>Share of matured signals that reached each target, how long it took and how far price fell first. A row means little until it has 30+ signals.</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Group</th><th>Matured (14d)</th><th>+25% in 14d</th><th>+50% in 14d</th><th>+100% in 14d</th><th>+100% in 42d</th><th>Days to +100%</th><th>Fall before +25%</th><th>Hit before -<span>{r ? r.stopPct : 20}</span>% stop</th><th>False positives</th></tr></thead>
        <tbody>{gs.map(([name, b], i) => {
          const [t25, t50, t100] = b.targets;
          return (
            <tr key={`${name}-${i}`}><td><b>{name}</b></td><td className="mono">{t25["14d"].n}</td><td className="mono">{cell(t25, "14d")}</td><td className="mono">{cell(t50, "14d")}</td><td className="mono">{cell(t100, "14d")}</td><td className="mono">{cell(t100, "42d")}</td>
              <td className="mono">{t100["42d"].medianHours == null ? "—" : (t100["42d"].medianHours / 24).toFixed(1)}</td><td className="mono red">{t25["42d"].medianDrawdownPct == null ? "—" : pct1(t25["42d"].medianDrawdownPct)}</td>
              <td className="mono">{t25["42d"].beforeStopPct == null ? "—" : `${t25["42d"].beforeStopPct}%`}</td>
              <td className="mono">{b.falsePositives.pct == null ? "—" : `${b.falsePositives.pct}%`}<span className="sub">{b.falsePositives.count} of {b.falsePositives.n}</span></td></tr>);
        })}</tbody></table></div>
    </section>
  );
}

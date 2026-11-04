"use client";
// The Early 2x detail window: every number behind a candidate's score, its confirmations, the mandatory and late-entry
// checks, and what is still missing for a high-priority call. Opened by clicking a token in the candidates list.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment, useEffect, type ReactNode } from "react";
import { col, money, pct1, price } from "@/lib/format";
import { SafeLink } from "../ui";
import { XSTATE, xn, type X2Candidate } from "./shared";

export function DetailWindow({ c, onClose }: { c: X2Candidate; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  const [st] = XSTATE[c.state || ""] || ["—"];
  const stat = (l: string, v: ReactNode, k = "") => <div className="book-stat" key={l}><span>{l}</span><strong className={`mono ${k}`}>{v}</strong></div>;
  const d = c.deriv, oc = c.onchain || {}, ctx: string[] = [];
  if (d && d.available) ctx.push(`futures: open interest ${pct1(d.oi1hPct)} 1h, ${pct1(d.oi24hPct)} 24h, ${pct1(d.oi48hPct)} 48h; funding ${d.fundingPct == null ? "—" : d.fundingPct.toFixed(4) + "%"}${d.transition ? ` (${d.transition})` : ""}${d.crowded ? ` · crowded: ${d.crowdedWhy}` : ""}`);
  else ctx.push(d && d.available === false ? "futures: no USDT perpetual" : "futures: unavailable");
  ctx.push(oc.whales ? `Ethereum whale transfers 24h: ${oc.whales.transfers24h} worth ${money(oc.whales.totalUsd24h)}, net ${money(oc.whales.netToExchangesUsd24h)} to exchanges` : "on-chain transfers: none tracked for this token");
  if (oc.dex) ctx.push(`DEX (${oc.dex.networks.join(", ")}): net ${money(oc.dex.netUsd24h)} bought minus sold in 24h, ${oc.dex.swaps24h} swaps, ${oc.dex.wallets24h} wallets`);

  return (
    <div className="modal-backdrop open" role="dialog" aria-modal="true" aria-labelledby="xmTitle" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal" style={{ width: "min(860px,100%)" }}>
        <div className="modal-head"><div><div className="eyebrow">Early 2x candidate</div><h2 id="xmTitle">{c.base} / USDT · {c.score}/100</h2>
          <p>{c.name} · {st}{c.priority ? ` · ${c.priority === "high" ? "high priority" : "watch"}` : ""} · market cap {money(c.mcap)} ({c.mcapSource})</p></div>
          <button className="btn" onClick={onClose} aria-label="Close detail">✕</button></div>
        <div className="book-meta">
          {stat("Price", price(c.price))}
          {c.targets.map((t: any) => stat(`+${t.pct}% target`, price(t.price)))}
          {stat("Market cap at 2x", money(c.mcapAt2x))}
          {stat("24h volume", `${xn(c.vol.r24)} baseline`, c.vol.r24 >= 2 ? "green" : "")}
          {stat("Buyers 24h", c.flow.buy24 == null ? "—" : `${c.flow.buy24.toFixed(1)}%`)}
          {stat("24h move", pct1(c.px.ret24), col(c.px.ret24))}
          {stat("vs BTC 24h", pct1(c.px.rs24), col(c.px.rs24))}
          {stat("Typical daily range", c.px.typicalDailyRange == null ? "—" : `${c.px.typicalDailyRange}%`)}
          {stat("Already-moved limit 24h", `${c.limits.ext24}%`)}
          {stat("Spread", c.liq.spreadPct == null ? "—" : `${c.liq.spreadPct.toFixed(3)}%`)}
          {stat("Depth ±2%", c.liq.depthBid == null ? "not checked" : `${money(Math.min(c.liq.depthBid, c.liq.depthAsk))} min side`)}
        </div>
        <div className="sec">Independent confirmations</div>
        <ul className="reasons">
          {c.families.map((x: any) => <li key={x.key}><b className={x.ok ? "green" : "muted"}>{x.ok ? "✓" : "✗"} {x.label}</b>: {x.ok ? x.evidence : `needs ${x.need}`}</li>)}
          {ctx.map((x, i) => <li key={`c${i}`} className="muted">{x}</li>)}
          <li className="muted">Futures and on-chain data are context only and never count as a confirmation or as proof of whale buying.</li>
        </ul>
        <div className="sec" style={{ paddingTop: 8 }}>Mandatory checks and late-entry checks</div>
        <ul className="reasons">
          {c.mandatory.map((x: any, i: number) => <li key={`m${i}`}><b className={x.ok ? "green" : "red"}>{x.ok ? "✓" : "✗"} {x.key}</b>: {x.why}</li>)}
          {c.late.map((x: any, i: number) => <li key={`l${i}`} className={x.severity === "reject" ? "red" : "amber"}>{x.severity === "reject" ? "Late entry" : "Risk"}: {x.why}</li>)}
          {c.flags.filter((f: string) => !c.late.some((x: any) => x.why === f)).map((f: string, i: number) => <li key={`f${i}`} className="amber">{f}</li>)}
        </ul>
        <div className="sec" style={{ paddingTop: 8 }}>Exactly how the score was calculated</div>
        <div style={{ padding: "6px 20px 4px" }}>
          {Object.values(c.components as Record<string, any>).map((k, i) => <Fragment key={i}>
            <div style={{ margin: "10px 0 4px", display: "flex", justifyContent: "space-between", gap: 10 }}><b>{k.label}</b><b className="mono">{k.points}/{k.max}</b></div>
            {k.rules.map((r: any, j: number) => <div key={j} className="part" style={{ gridTemplateColumns: "1fr 150px 56px" }}><span className="muted">{r.rule}</span><span className={`mono ${r.missing ? "muted" : ""}`}>{r.value}</span><b className="mono">{r.points}/{r.max}</b></div>)}
          </Fragment>)}
          <p className="muted" style={{ fontSize: 11, lineHeight: 1.6 }}>Missing data earns 0 points. The score is not a probability of doubling unless it is calibrated on the tracked results below.</p>
        </div>
        <div className="sec" style={{ paddingTop: 8 }}>Still missing for a high-priority call</div>
        <ul className="reasons">{c.missing.length ? c.missing.map((m: string, i: number) => <li key={i}>{m}</li>) : <li className="green">Nothing: all checks pass.</li>}</ul>
        <div className="modal-foot"><SafeLink className="btn" url={`https://www.binance.com/en/trade/${encodeURIComponent(c.base)}_USDT?type=spot`}>Open on Binance</SafeLink>
          <span>A 2x move is a research target, not a prediction. Set your own risk limits. Not financial advice.</span></div>
      </section>
    </div>
  );
}

"use client";
// One trade card (the classic page's pCardHtml): a signal's card under the Signals table and the Check a trade result.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { time } from "@/lib/format";
import { useScreener } from "../context";
import { PSETUP, Side, Vd, pPx, pR, pSize, type Risk } from "./lib";

const reasonClass = (x: string) => (/^Helps/.test(x) ? "plus" : /^Hurts|lost money|did not make|wider than|cost about|Not a crypto/.test(x) ? "minus" : undefined);

export function PCard({ c, risk }: { c: any; risk: Risk }) {
  const { openJournal } = useScreener();
  const dir = c.side === "short" ? -1 : 1, r = c.risk || {}, z = pSize(risk, dir, r.entry, r.stop, r.costPct), rec = c.record;
  const fund = r.funding10dPct != null
    ? `${r.funding10dPct > 0 ? "+" : ""}${r.funding10dPct}% over 10 days (${r.funding10dR > 0 ? "+" : ""}${r.funding10dR ?? "—"}R)${r.fund8h != null ? ` · ${r.fund8h}% per 8h, ${dir * r.fund8h > 0 ? "you pay" : "you receive"}` : ""}`
    : "—";
  const took = () => openJournal({ tool: "perps", side: c.side, symbol: c.base, price: Number(r.entry), alertPrice: Number(r.entry), stop: Number(r.stop), target: Number(r.target), alertId: c.id || "" });
  return (
    <div className="pcard">
      <h3><Vd v={c.verdict} /> <Side side={c.side} /> {String(c.base ?? "")} <span className="muted" style={{ fontSize: 13, fontWeight: 600 }}>{c.headline || ""}</span></h3>
      <div className="head">{`${c.at ? `as of ${time(c.at)} · ` : ""}price ${pPx(c.price)}${c.btc ? ` · BTC trend ${c.btc}` : ""}`}</div>
      <div className="pgrid">
        <div><span>Entry</span><b>{pPx(r.entry)}</b></div>
        <div><span>{`Stop (${r.stopSource || "signal"})`}</span><b>{pPx(r.stop)}</b> <small className="muted">{`${r.riskPct}%`}</small></div>
        <div><span>{`Target ${r.tp ?? 2.5}R`}</span><b>{pPx(r.target)}</b></div>
        <div><span>Max hold</span><b>{`${r.holdDays ?? 10} days`}</b></div>
        <div><span>{`Size for ${z.R.risk}% risk`}</span><b>{`$${Math.round(z.notional).toLocaleString()}`}</b> <small className="muted">{`${pPx(z.qty)} coins`}</small></div>
        <div><span>{`Margin at ${z.R.lev}x`}</span><b className={z.tooBig ? "red" : undefined}>{`$${Math.round(z.margin).toLocaleString()}`}</b></div>
        <div><span>Liquidation (approx.)</span><b className={z.ok ? "green" : "red"}>{pPx(z.liq)}</b> <small className={z.ok ? "muted" : "red"}>{z.ok ? "well beyond the stop" : `too close: use ${z.safeLev}x or less`}</small></div>
        <div><span>Funding</span><b style={{ fontSize: 12 }}>{fund}</b></div>
      </div>
      <ul>{(c.reasons || []).map((x: string, i: number) => <li key={i} className={reasonClass(x)}>{x}</li>)}</ul>
      {(c.waitFor || []).length > 0 && <div className="note"><b>What would make it a tested trade:</b><ul>{c.waitFor.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>}
      {rec && <div className="note">{`Backtest of ${PSETUP[rec.setup] || rec.setup} ${rec.side}: ${rec.all.trades} trades, ${rec.all.winRatePct}% won, ${pR(rec.all.avgR)} per trade, profit factor ${rec.all.profitFactor} · last tested trades: ${
        (rec.last || []).slice(0, 6).map((t: any[]) => `${String(t[2]).replace(/USDT$/, "")} ${new Date(t[3]).toISOString().slice(0, 10)} ${pR(t[8])}`).join(", ") || "—"}`}</div>}
      <div className="note">{z.tooBig && <><span className="red">The margin is larger than your account: lower the risk or raise the leverage carefully.</span> </>}{`Conditions met now: ${(c.conditions || []).join(" · ") || "none"}.`}</div>
      {c.verdict !== "SKIP" && <div style={{ marginTop: 10 }}><button className="btn xs" type="button" onClick={took}>I took it</button></div>}
    </div>
  );
}

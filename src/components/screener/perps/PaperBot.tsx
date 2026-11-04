"use client";
// Perps › Paper bot (the classic page's drawBot): the pretend account in /api/scalp's "paper" that takes every scalp
// signal and every Perps A+ TAKE, its open and closed trades, and the settings form that starts a new paper account
// (POST /api/scalp/paper/reset).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FormEvent } from "react";
import { col } from "@/lib/format";
import { Kpi } from "../ui";
import { Side, dt, pPx, usd, type ScalpData } from "./lib";

export type BotForm = { start: string; riskPct: string; leverage: string; maxOpen: string };
export const BOT_FORM0: BotForm = { start: "100", riskPct: "1", leverage: "5", maxOpen: "3" };

export function PaperBot({ d, form, setForm, msg, onReset }: { d: ScalpData | null; form: BotForm; setForm: (f: BotForm) => void; msg: string; onReset: () => void }) {
  const a = d?.paper, bs = a?.byStrategy || {};
  const field = (k: keyof BotForm) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) });
  const submit = (e: FormEvent) => { e.preventDefault(); onReset(); };
  return (
    <section className="panel" style={{ marginTop: 14 }} id="botPanel">
      <div className="section-head"><div><h2>Paper bot (Scalp + Perps A+)</h2><p>{a ? <>A pretend account that takes, on its own, <b>every scalp signal</b>{` (long: the signal's stop and target, out after 1 hour, ${(d?.rule || {}).costPct ?? 0.12}% fees) and `}<b>every Perps A+ TAKE trade</b>{" (long or short: target 4x the risk, the stop, or 14 days, with fees and real funding). Each trade risks "}<b>{`${a.riskPct}%`}</b>{` of the balance (about ${usd(a.balance * a.riskPct / 100)} now), at most ${a.leverage}x leverage, up to ${a.maxOpen} scalp and ${a.maxOpen} perps trades at once. So far: scalp ${bs.scalp?.trades || 0} trades ${usd(bs.scalp?.pnl || 0)}, Perps A+ ${bs.perps?.trades || 0} trades ${usd(bs.perps?.pnl || 0)}. In the test, 1% risk per trade made about +90% over 27 months (worst drop 12%), so expect small, slow gains, and losing runs. Paper money only.`}</>
        : "A pretend account that takes every scalp signal and every Perps A+ trade on its own, with the tested plans and fees. No money, no API key."}</p></div>
        <span className="chip">{!d ? "—" : a ? `started ${new Date(a.startedAt).toLocaleDateString()} with $${a.start}` : d.status === "off" ? "off" : "starting"}</span></div>
      <div className="kpis" style={{ padding: "0 18px", margin: "0 0 6px" }}>
        <Kpi label="Balance" cls={a ? col(a.returnPct) : undefined} value={a ? usd(a.balance) : "—"} hint={a ? `${a.returnPct > 0 ? "+" : ""}${a.returnPct}% since the start · with open trades ${usd(a.equity)}` : "—"} />
        <Kpi label="Trades" value={a ? a.trades : "—"} hint={a ? (a.trades ? `${a.winPct}% won · ${a.targets} target, ${a.stops} stop · total ${usd(a.totalPnl)}` : "none yet: it takes the next scalp signal") : "—"} />
        <Kpi label="Worst drop" cls="red" value={a ? (a.maxDrawdownPct ? `-${a.maxDrawdownPct}%` : "0%") : "—"} hint="from the highest balance" />
        <Kpi label="Open now" value={a ? a.open.length : "—"} hint={a ? `max ${a.maxOpen}${a.skipped && (a.skipped.busy || a.skipped.small) ? ` · skipped ${a.skipped.busy} (full), ${a.skipped.small} (too small)` : ""}` : "—"} />
      </div>
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Open trade</th><th>Entry · stop · target</th><th>Size</th><th>Now</th><th>Profit / loss</th></tr></thead>
        <tbody>{!a ? null : a.open.length ? a.open.map((x: any, i: number) => (
          <tr key={x.id ?? i}><td><Side side={x.side || "long"} /> <b>{x.base}</b><span className="sub">{`${x.strategy === "perps" ? "Perps A+" : "Scalp"} · opened ${dt(x.openedAt)} · close by ${dt(x.closeBy)}`}</span></td>
            <td className="mono">{pPx(x.entry)}<span className="sub red">{`stop ${pPx(x.stop)}`}</span><span className="sub green">{`target ${pPx(x.target)}`}</span></td>
            <td className="mono">{usd(x.notional)}<span className="sub">{`${pPx(x.qty)} coins · margin ${usd(x.margin)} · risk ${usd(x.riskUsd)}`}</span></td>
            <td className="mono">{pPx(x.price)}</td><td className={`mono ${col(x.uPnl)}`}>{usd(x.uPnl)}</td></tr>))
          : <tr><td colSpan={5} className="empty">No open trade. The bot trades the next scalp signal or Perps A+ TAKE.</td></tr>}</tbody></table></div>
      <div className="subhead2"><div><h2>Closed trades</h2><p>Each trade&apos;s result after fees, and the balance after it.</p></div></div>
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Closed</th><th>Coin</th><th>Entry → exit</th><th>Result</th><th>Why</th><th>Balance after</th></tr></thead>
        <tbody>{!a ? null : a.closed.length ? a.closed.map((x: any, i: number) => (
          <tr key={x.id ?? i}><td className="mono">{dt(x.closedAt)}</td><td><Side side={x.side || "long"} /> <b>{x.base}</b><span className="sub">{x.strategy === "perps" ? "Perps A+" : "Scalp"}</span></td>
            <td className="mono">{`${pPx(x.entry)} → ${pPx(x.exit)}`}</td><td className={`mono ${col(x.pnl)}`}><b>{usd(x.pnl)}</b><span className="sub">{`${x.pnlPctOfBalance > 0 ? "+" : ""}${x.pnlPctOfBalance}% of the balance`}</span></td>
            <td>{x.why === "target" ? "hit the target" : x.why === "stop" ? "hit the stop" : x.why === "time" ? (x.strategy === "perps" ? "time limit" : "1 hour up") : (x.why || "")}</td><td className="mono">{usd(x.balanceAfter)}</td></tr>))
          : <tr><td colSpan={6} className="empty">No closed trade yet.</td></tr>}</tbody></table></div>
      <div className="subhead2"><div><h2>Settings and reset</h2><p>Starts a new paper account with these settings (the old trades are cleared). Later the same bot can trade a real Binance account.</p></div></div>
      <form className="pform" autoComplete="off" style={{ padding: "0 18px 16px" }} onSubmit={submit}>
        <label>Start ($)<input type="number" step="any" min="10" {...field("start")} /></label>
        <label>Risk per trade (%)<input type="number" step="0.1" min="0.1" max="5" {...field("riskPct")} /></label>
        <label>Leverage (x)<input type="number" step="1" min="1" max="20" {...field("leverage")} /></label>
        <label>Max open trades<input type="number" step="1" min="1" max="10" {...field("maxOpen")} /></label>
        <button className="btn" type="submit">Reset paper account</button><span className="muted" style={{ fontSize: 12 }}>{msg}</span>
      </form>
    </section>
  );
}

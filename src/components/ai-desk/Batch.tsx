"use client";
import type { BatchResponse } from "@/lib/ai-desk";
import { arr, base, lbl, num, tx } from "./ui";

// "Analyze all": a quick triage of every igniting / heating coin in one request, each with a "Full analysis" button.
export function BatchView({ b, onAnalyze }: { b: BatchResponse; onAnalyze: (symbol: string) => void }) {
  const coins = arr(b.coins), failed = arr(b.failed), tg = b.telegram;
  return (
    <>
      <div className="thesis">{tx(b.marketView)}</div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Coin</th><th>Decision</th><th>Why</th><th>Key risk</th><th></th></tr></thead>
        <tbody>{coins.length ? coins.map((c) => {
          const gn = arr(c.guardNotes);
          return (
            <tr key={c.symbol}>
              <td><b>{base(c.symbol)}</b>{c.tier
                ? <> <span className={`badge ${c.tier === "bigmove" ? "confirmed" : c.tier}`}>{c.tier === "confirmed" ? "Confirmed" : c.tier === "bigmove" ? "Big move" : "Early"}</span></>
                : <> <span className="badge heating">{tx(c.state)}</span></>}<span className="sub">ref. R:R {num(c.referenceRewardRisk)}</span></td>
              <td><span className={`dec ${c.decision}`}>{lbl(c.decision)}</span>
                <span className="sub">{tx(c.probTargetPct)}% target / {tx(c.probStopPct)}% stop · EV {Number(c.expectedValuePct) > 0 ? "+" : ""}{tx(c.expectedValuePct)}%</span>
                <span className="sub">{tx(c.confidence)} · {tx(c.setupScore)}/10</span>
                {c.modelDecision !== c.decision && <span className="sub amber">AI: {lbl(c.modelDecision)}</span>}</td>
              <td>{tx(c.reason)}{gn.length > 0 && <span className="sub amber">{gn.map(tx).join(" ")}</span>}</td>
              <td className="muted">{tx(c.keyRisk)}</td>
              <td><button className="btn sm" onClick={() => onAnalyze(c.symbol)}>Full analysis</button></td>
            </tr>
          );
        }) : <tr><td colSpan={5} className="empty">Nothing to analyze.</td></tr>}</tbody>
      </table></div>
      {failed.length > 0 && <div className="callout red">No data for: {failed.map((f) => `${tx(f.symbol)} (${tx(f.error)})`).join(", ")}</div>}
      <div className="meta">Quick triage on the most important facts per coin, in one request. Open &quot;Full analysis&quot; for a trade plan with entry, stop and targets.
        {tg ? (tg.sent ? <> · <span className="green">TAKE calls sent to Telegram</span></> : ` · Telegram: ${(tg.skipped || tg.error || "") + (tg.queued ? " (not sent yet, it will keep retrying)" : "")}`) : null}</div>
    </>
  );
}

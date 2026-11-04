"use client";
import type { Analysis } from "@/lib/ai-desk";
import { CommitteeView } from "./Committee";
import { DossierJson, Facts } from "./Facts";
import { ProgressView, type Timeline } from "./Progress";
import { arr, evLabel, kTok, lbl, num, pct, price, Stat, tx } from "./ui";

// One coin's answer: the verdict, the committee, the plan, how it decided and the data it used.
function EvText({ x }: { x: Analysis }) {
  if (x.expectedValuePct == null) return null;
  const ev = Number(x.expectedValuePct), c = x.evCalc;
  return <>
    chance {tx(x.probTargetPct)}% target / {tx(x.probStopPct)}% stop{c ? ` / ${tx(c.pTimeoutPct)}% time-out` : ""} · expected{" "}
    <b className={ev >= 0.5 ? "green" : ev < 0 ? "red" : "amber"}>{ev > 0 ? "+" : ""}{tx(x.expectedValuePct)}%</b> per trade
    {c && <span className="sub mono" title={c.timeoutFrom || ""}>EV = P(target) × target − P(stop) × stop + P(time-out) × avg time-out − costs = {tx(c.formula)}</span>}
  </>;
}

export function ResultView({ x, timeline }: { x: Analysis; timeline: Timeline | null }) {
  const p = x.plan || {}, take = x.decision === "TAKE", m = x.meta || {}, bo = x.committee?.boss || {};
  const fin = x.final || (take ? "YES" : "NO"), al = x.dossier?.alert || {}, hard = arr(x.hardStops), checklist = arr(x.checklist);
  const real = x.realistic, guard = arr(x.guardNotes), tg = x.telegram;
  const plan = <>
    <div className="sec">{take ? "Trade plan" : x.watch ? "Plan if the watch triggers hit (not a signal now)" : x.final === "NO" ? "The trader's plan (no trade)" : "Plan if it triggers (not a signal now)"}
      {x.sizePct != null && x.final !== "NO" ? ` · size ${num(x.sizePct, 0)}% of normal` : ""}</div>
    <div className={`plan${take ? "" : " dim"}`}>
      <Stat k="Entry zone" v={`${price(p.entryLow)} – ${price(p.entryHigh)}`} />
      <Stat k="Stop loss" v={price(p.stop)} sub={`${pct(p.stopPct)} from entry${p.stopAt ? ` · below ${tx(p.stopAt.what)} ${price(p.stopAt.price)}` : ""}`} cls="red" />
      <Stat k="Target 1" v={price(p.target1)} sub={`${pct(p.target1Pct)} · the tested target`} cls="green" />
      <Stat k="Target 2" v={price(p.target2)} />
      {real ? <Stat k="Reward : risk" v={`${num(real.rewardRisk)} : 1`}
        sub={real.hurdle ? `hurdle on the way: ${tx(real.hurdle.what)} ${price(real.hurdle.price)} (${pct(real.hurdle.pct)})` : "to the plan's target"}
        cls={Number(real.rewardRisk) >= 2 ? "green" : Number(real.rewardRisk) < 1.5 ? "red" : "amber"} />
        : <Stat k="Reward : risk" v={`${num(p.rewardRisk)} : 1`} cls={Number(p.rewardRisk) >= 1.5 ? "green" : Number(p.rewardRisk) < 1.2 ? "red" : ""} />}
      <Stat k="Hold" v={`${num(p.holdHours, 0)}h`} sub="then exit if neither hit" />
    </div>
  </>;
  return (
    <>
      <div className="hero">
        <div className={`big ${x.decision}`} title={lbl(x.decision)}>{fin}
          {x.final !== "NO" && <span className="sub" style={{ textAlign: "center" }}>{x.final === "WATCH" ? "wait for triggers" : lbl(x.decision)}</span>}</div>
        <div>
          <h3>{tx(x.headline)}</h3>
          <p><EvText x={x} /></p>
          <p>{tx(x.confidence)} confidence · setup {tx(x.setupScore)}/10 · price {price(x.dossier?.price)}</p>
          {x.modelDecision && x.modelDecision !== x.decision && <span className="sub">The trader said {lbl(x.modelDecision)}; {bo.available && !bo.agreesWithTrader ? "the Final Boss overturned it" : "the rules changed it"} (see below)</span>}
        </div>
      </div>
      <CommitteeView x={x} />
      <div className="thesis">{tx(x.thesis)}</div>
      {guard.length > 0 && <div className="callout">{guard.map((g, i) => <span key={i}>{i ? <br /> : null}{tx(g)}</span>)}</div>}
      {x.decision === "WAIT" && x.waitFor && <div className="callout blue"><b>{x.watch ? "Watch for" : "Wait for"}:</b> {tx(x.waitFor)}
        {x.trigger && <><br /><b>Watching:</b> {evLabel(x.trigger)} for {tx(x.trigger.expiresMinutes)} min. When it happens, the committee checks the coin again and Telegram gets the answer (see &quot;Watching&quot; below).</>}</div>}
      {x.final === "NO" ? <details><summary>The trader&apos;s plan, for reference only (no trade)</summary>{plan}</details> : plan}
      <div className="callout red"><b>Invalidated if:</b> {tx(x.invalidation)}<br /><b>Key risk:</b> {tx(x.keyRisk)}</div>
      <div className="cols">
        <div><div className="sec green">For the trade</div><ul>{arr(x.bullishPoints).length ? arr(x.bullishPoints).map((b, i) => <li key={i}>{tx(b)}</li>) : <li className="muted">none</li>}</ul></div>
        <div><div className="sec red">Against the trade</div><ul>{arr(x.bearishPoints).length ? arr(x.bearishPoints).map((b, i) => <li key={i}>{tx(b)}</li>) : <li className="muted">none</li>}</ul></div>
      </div>
      {(hard.length > 0 || checklist.length > 0) && <>
        <div className="sec">How the AI decided</div>
        {hard.length > 0 && <div className="callout red"><b>Hard stop:</b> {hard.map(tx).join("; ")}</div>}
        <div className="table-wrap"><table className="table"><tbody>{checklist.map((c, i) => (
          <tr key={i}><td><b>{tx(c.item)}</b></td><td><span className={`dec ${c.status === "pass" ? "TAKE" : c.status === "fail" ? "SKIP" : "WAIT"}`}>{tx(c.status)}</span></td><td className="muted">{tx(c.evidence)}</td></tr>
        ))}</tbody></table></div>
        <p className="meta">Started from this alert&apos;s base rate: {tx(al.anchorProbTargetPct)}% hit the target, {tx(al.anchorProbStopPct)}% hit the stop ({tx(al.anchorFrom)}; {tx(al.label)}, tracked
          as +{al.trackedAs ? tx(al.trackedAs.targetPct) : "?"}% / -{al.trackedAs ? tx(al.trackedAs.stopPct) : "?"}%). {tx(x.probReason)}</p>
      </>}
      <Facts d={x.dossier || {}} />
      <DossierJson d={x.dossier || {}} open={false} />
      <div className="meta">
        Trader {tx(m.model)}{m.bossModel ? ` · final boss ${m.bossModel}` : ""}{m.calls ? ` · ${m.calls} AI requests` : ""}
        {m.tokens ? ` · ${kTok(m.tokens.in)} tokens in, ${kTok(m.tokens.out)} out, ${kTok(m.tokens.think)} thinking` : ""}{m.deepThinking === false ? " · deep thinking off" : ""} · {num(Number(m.durationMs) / 1000, 1)}s
        {tg ? (tg.sent ? <> · <span className="green">sent to Telegram</span></> : ` · Telegram: ${(tg.skipped || tg.error || "") + (tg.queued ? " (not sent yet, it will keep retrying)" : "")}`) : ""}
        <br />Long only. Risk at most 1% of your account. AI opinion on data, not financial advice.
      </div>
      {timeline && <details><summary>Committee timeline ({timeline.total})</summary><ProgressView prog={timeline.prog} now={timeline.now} /></details>}
    </>
  );
}

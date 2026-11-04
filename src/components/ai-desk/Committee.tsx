"use client";
import type { ReactNode } from "react";
import type { Analysis, DebateSide } from "@/lib/ai-desk";
import { ago, arr, LBL, num, pct, Pill, price, safeUrl, tone, tx } from "./ui";

// The committee, one card per member: what each one found and how it voted. All of it is model-written text.
const SEV_TONE: Record<string, string> = { high: "SKIP", medium: "WAIT", low: "TAKE" };

function Card({ role, name, model, badge, q, children }: { role: string; name: string; model?: string | null; badge: ReactNode; q?: string; children: ReactNode }) {
  return (
    <div className="member">
      <span className="role">{role}{model ? ` · ${model}` : ""}{q === "weak" ? <> · <span className="amber">boss: weak</span></> : q === "ok" ? " · boss: ok" : ""}</span>
      <h4>{name}{badge}</h4>
      {children}
    </div>
  );
}

export function CommitteeView({ x }: { x: Analysis }) {
  const c = x.committee;
  if (!c) return null;
  const d = c.data || {}, n = c.news || {}, b = c.boss || {}, m = x.meta || {};
  const issues = arr(d.dataQuality?.issues), areas = arr(d.areas);

  const dataCard = d.available ? <>
    <p>{tx(d.summary)}</p>
    {arr(d.keyNumbers).length > 0 && <ul>{arr(d.keyNumbers).map((k, i) => <li key={i} className="mono">{tx(k)}</li>)}</ul>}
    {arr(d.redFlags).length > 0 && <p className="red"><b>Red flags:</b> {arr(d.redFlags).map(tx).join("; ")}</p>}
    {arr(d.conflicts).length > 0 && <p className="amber"><b>Conflicts:</b> {arr(d.conflicts).map(tx).join("; ")}</p>}
    {issues.length > 0 && <p className="muted"><b>Data issues:</b> {issues.map((i) => `${tx(i.field)}: ${tx(i.problem)}`).join("; ")}</p>}
    {areas.length > 0 && <details><summary>Evidence by area</summary><ul>{areas.map((a, i) => (
      <li key={i}><b>{tx(a.area)}</b> <Pill txt={tx(a.reading)} t={a.reading === "supports" ? "TAKE" : a.reading === "against" ? "SKIP" : "WAIT"} /> {tx(a.note)}
        {arr(a.evidence).length > 0 && <span className="sub mono">{arr(a.evidence).map(tx).join(" · ")}</span>}</li>
    ))}</ul></details>}
  </> : <p className="muted">Not available ({d.error || "no answer"}). The trader worked from the raw data.</p>;

  const ev = n.evidence, items = arr(n.items), upcoming = arr(n.upcoming), sources = arr(n.sources), searchedBy = arr(n.searchedBy);
  const newsCard = n.available && n.status === "unknown" ? <>
    <p className="amber"><b>Unknown:</b> no web search ran{Number(n.requests) > 1 ? " (asked twice)" : ""}. Nothing from the model&apos;s memory is shown or used.</p>
    {ev && <span className="sub">Search check: Google returned {arr(ev.fields).length ? `only ${arr(ev.fields).join(", ")}` : "no search data"}; {tx(ev.toolTokens)} tokens of search results
      {ev.discardedItems ? `; ${ev.discardedItems} items from memory were thrown away` : ""}.</span>}
  </> : n.available ? <>
    <p>{n.summary || "No relevant news found."}</p>
    {searchedBy.length > 0 && <span className="sub">Searched by {searchedBy.join(" and ")}
      {ev && ev.droppedItems ? ` · ${ev.droppedItems} item${ev.droppedItems === 1 ? "" : "s"} without a source left out` : ""}</span>}
    {items.length > 0 && <ul>{items.map((i, k) => (
      <li key={k}><span className="mono muted">{tx(i.date)}</span> {i.url ? <a href={safeUrl(i.url)} target="_blank" rel="noopener noreferrer">{tx(i.title)}</a> : tx(i.title)}{" "}
        <span className="sub"><span className={i.impact === "negative" ? "red" : i.impact === "positive" ? "green" : "muted"}>{tx(i.impact)}</span> · {tx(i.severity)} · priced in: {tx(i.pricedIn)}{i.source ? ` · ${i.source}` : ""}</span></li>
    ))}</ul>}
    {upcoming.length > 0 && <p><b>Coming up:</b> {upcoming.map((u) => `${tx(u.date)} ${tx(u.event)} (${tx(u.impact)})`).join("; ")}</p>}
    {n.hardStop && <p className="red"><b>Hard stop:</b> {tx(n.hardStopReason)}</p>}
    {sources.length > 0 && <details><summary>{sources.length} source{sources.length === 1 ? "" : "s"} searched</summary><ul>{sources.map((s, k) => (
      <li key={k}><a href={safeUrl(s.url)} target="_blank" rel="noopener noreferrer">{tx(s.title)}</a></li>
    ))}</ul></details>}
    {n.cached && <span className="sub">Saved news from {ago(n.at)}</span>}
  </> : <p className="muted">{n.off ? "Switched off." : `Not available (${n.error || "no answer"}).`} News is unknown: the trader was told not to treat that as good news.</p>;

  const db = c.debate || { off: true }, vd = db.verdict;
  const pts = (a: { point: string; evidence: string }[]) => (a.length ? <ul>{a.map((p, i) => <li key={i}>{tx(p.point)}<span className="sub mono">{tx(p.evidence)}</span></li>)}</ul> : null);
  const sideCard = (sd: DebateSide | undefined, isBull: boolean) => !sd || !sd.available
    ? <p className="muted">{db.off ? (db.skipped ? `${db.skipped}.` : "Debate switched off.") : `No answer (${sd?.error || "unavailable"}). The trader judged without this side.`}</p>
    : <>
      <p>{tx(sd.thesis)}</p>
      {!isBull && arr(sd.rebuttals).length > 0 && <><p><b>Answers to the bull:</b></p><ul>{arr(sd.rebuttals).map((r, i) => (
        <li key={i}><Pill txt={tx(r.verdict)} t={r.verdict === "holds" ? "TAKE" : r.verdict === "wrong" ? "SKIP" : "WAIT"} /> {tx(r.bullPoint)}<span className="sub">{tx(r.evidence)}</span></li>
      ))}</ul></>}
      {arr(sd.points).length > 0 && <><p><b>{isBull ? "Reasons to buy" : "Reasons not to buy"}:</b></p>{pts(arr(sd.points))}</>}
      <p><b>{isBull ? "Path to the target" : "Most likely path to the stop"}:</b> {tx(sd.path)}</p>
      <details><summary>Weak spot and red flags</summary><p><b>Weakest point:</b> {tx(sd.weakestPoint)}</p><p><b>Would change its mind:</b> {tx(sd.wouldChangeMyMind)}</p>
        {isBull && arr(sd.redFlagAnswers).length > 0 && <ul>{arr(sd.redFlagAnswers).map((r, i) => (
          <li key={i}><Pill txt={r.stands ? "stands" : "answered"} t={r.stands ? "SKIP" : "TAKE"} /> {tx(r.flag)}<span className="sub">{tx(r.answer)}</span></li>
        ))}</ul>}</details>
    </>;
  const sideBadge = (sd: DebateSide | undefined, isBull: boolean) => sd && sd.available
    ? <Pill txt={`${isBull ? "for " : "against "}${tx(sd.strength)}/10`} t={vd && vd.winner === (isBull ? "bull" : "bear") ? (isBull ? "TAKE" : "SKIP") : "WAIT"} />
    : <Pill txt={db.off ? "off" : "n/a"} />;

  const traderCard = <>
    <p>{tx(x.headline)}</p>
    <p className="mono">{tx(x.probTargetPct)}% target / {tx(x.probStopPct)}% stop · expected {Number(x.expectedValuePct) > 0 ? "+" : ""}{tx(x.expectedValuePct)}% per trade</p>
    {vd && <p><b>Debate:</b> {vd.winner === "even" ? "even" : `${tx(vd.winner)} won`}. {tx(vd.reason)}</p>}
    {c.trader && c.trader.decision && c.trader.decision !== x.decision && <p className="amber">Changed to {LBL[x.decision] ?? ""} after the trader: see the notes below.</p>}
  </>;

  const cn = b.corrected || null, findings = arr(b.auditFindings), hints = arr(c.auditHints), wt = arr(b.watchTriggers), hsf = arr(b.hardStopFailures);
  const bossCard = !b.asked ? <p className="muted">{b.reason || "Not asked."}</p>
    : b.available === false ? <p className="amber">No answer ({tx(b.reason)}), so there is no YES. Run it again in a minute.</p>
    : <>
      {b.fallbackFrom && <p className="amber">Answered by {tx(b.model)} because {tx(b.fallbackFrom.model)} failed ({b.fallbackFrom.error || ""}).</p>}
      <p><b>{tx(b.summary)}</b></p><p><b>Deciding factor:</b> {tx(b.decidingFactor)}</p>
      <p className="muted">{tx(b.confidence)} confidence{b.confidenceSaid && b.confidenceSaid !== b.confidence ? ` (it said ${b.confidenceSaid}; capped by the code)` : ""} · {b.agreesWithTrader ? "agrees with the trader" : "overturned the trader"}
        {b.plan && b.verdict !== "NO" ? ` · size ${num(b.plan.sizePct, 0)}% of normal` : ""}</p>
      {hsf.length > 0 && <p className="red"><b>Hard-stop failures:</b> {hsf.map(tx).join("; ")}</p>}
      {wt.length > 0 && <><p><b>Watch for{b.watchExpiresHours ? ` (next ${num(b.watchExpiresHours, 0)} h)` : ""}:</b></p><ul>{wt.map((t, i) => (
        <li key={i}>{tx(t.condition)}<span className="sub mono">{tx(t.field)} {tx(t.threshold)}</span></li>
      ))}</ul></>}
      {cn && <p className="mono" style={{ fontSize: "11.5px" }}>Corrected: {num(cn.pTargetPct, 0)}% target / {num(cn.pStopPct, 0)}% stop / {num(cn.pTimeoutPct, 0)}% time-out · realistic target {price(cn.realisticTarget)} · R:R {num(cn.realisticRr)} · EV {pct(cn.expectedValuePct, 2)}</p>}
      {findings.length ? <details open={findings.some((f) => f.severity === "high")}><summary>Audit: {findings.length} finding{findings.length === 1 ? "" : "s"}</summary><ul>{findings.map((f, i) => (
        <li key={i}><Pill txt={tx(f.severity)} t={SEV_TONE[f.severity]} /> {tx(f.issue)}<span className="sub mono">{tx(f.field)}</span><span className="sub">{tx(f.correction)}</span></li>
      ))}</ul></details> : <p className="amber">No audit findings.</p>}
      {hints.length > 0 && <details><summary>What the code asked it to audit ({hints.length})</summary><ul>{hints.map((h, i) => <li key={i}>{tx(h)}</li>)}</ul></details>}
    </>;

  const aq: Partial<Record<string, string>> = (b.available && b.agentQuality) || {};
  const nTrader = db.off ? 3 : 5, rating = d.dataQuality?.rating;
  return (
    <>
      <div className="sec">The committee</div>
      {x.fastNo ? <div className="callout blue"><b>Fast NO</b> (AI_FAST_NO=1): no alert signal, and the trader and the code both say no trade, so the debate and the Final Boss were skipped ({m.calls ? `${m.calls} Gemini requests` : "fewer requests"} instead of 6 or more).</div>
        : db.skipped ? <p className="meta">{db.skipped}.</p> : null}
      <div className="crew">
        <Card role="1 · Data analyst" name="Checks the numbers" model={m.dataModel} q={aq.dataAnalyst}
          badge={d.available ? <Pill txt={`data ${rating || "?"}`} t={tone(rating)} /> : <Pill txt="n/a" />}>{dataCard}</Card>
        <Card role="2 · News researcher" name="Searches the web" model={m.newsModel} q={aq.news}
          badge={n.available ? (n.status === "unknown" ? <Pill txt="unknown" t="WAIT" /> : <Pill txt={`${n.riskLevel || "none"} risk`} t={tone(n.riskLevel)} />) : <Pill txt={n.off ? "off" : "n/a"} />}>{newsCard}</Card>
        {!db.off && <>
          <Card role="3 · Bull" name="The case for" model={m.debateModel} badge={sideBadge(db.bull, true)} q={aq.bull}>{sideCard(db.bull, true)}</Card>
          <Card role="4 · Bear" name="The case against" model={m.debateModel} badge={sideBadge(db.bear, false)} q={aq.bear}>{sideCard(db.bear, false)}</Card>
        </>}
        <Card role={`${nTrader} · Trader`} name="Makes the call" model={m.model} q={aq.trader}
          badge={<Pill txt={LBL[tx(c.trader?.decision)] || "?"} t={c.trader?.decision} />}>{traderCard}</Card>
        <Card role={`${nTrader + 1} · Final Boss`} name="Audits it all: YES, WATCH or NO" model={m.bossModel}
          badge={b.available && b.verdict ? <Pill txt={b.verdict} t={tone(b.verdict)} /> : <Pill txt={b.asked ? "no answer" : "not asked"} t="WAIT" />}>{bossCard}</Card>
      </div>
    </>
  );
}

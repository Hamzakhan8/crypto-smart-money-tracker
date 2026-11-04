"use client";
// "Ask AI" on an Alpha token: POST /api/ai/alpha { key, stream: true } asks the same AI committee as the AI desk. While
// it works, one line per committee member (the server streams each step); then the verdict, the committee's view, the
// plan and the checklist (the classic page's drawAiBox). All model-written text is rendered as React text.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { postStream } from "@/lib/ai-desk";
import { col, pct } from "@/lib/format";
import { arr, tx } from "./bits";

const ST = [["dossier", "Market data"], ["data", "Data analyst"], ["news", "News researcher"], ["bull", "Bull"], ["bear", "Bear"], ["trader", "Trader"], ["checks", "Code checks"], ["boss", "Final Boss"]] as const;
const LBL: Record<string, string> = { TAKE: "TAKE", WAIT: "WAIT", SKIP: "NO TRADE" };
interface Box { run: number; title: string; t0: number; st: Record<string, { status: string; detail?: string }>; result?: any; error?: string }

/** The AI check panel's state; lives in the Alpha tab so it survives switching the section tags. */
export function useAiCheck() {
  const [box, setBox] = useState<Box | null>(null);
  const run = useRef(0);
  const ask = async (key: string, symbol: string) => {
    const id = ++run.current;
    setBox({ run: id, title: `AI check · ${symbol}`, t0: Date.now(), st: {} });
    const mine = (f: (b: Box) => Box) => setBox((b) => (b && b.run === id ? f(b) : b)); // only the latest question writes to the box
    try {
      const out = await postStream<any>("/api/ai/alpha", { key }, (m) => mine((b) => ({ ...b, st: { ...b.st, [m.id]: { status: m.status, detail: m.detail } } })));
      mine((b) => ({ ...b, result: out }));
    } catch (e) { mine((b) => ({ ...b, error: (e as Error).message })); }
  };
  const close = () => { run.current++; setBox(null); };
  const scrolled = useRef(0); // the question the panel last scrolled to (not again when a section tag shows it again)
  return { box, ask, close, scrolled };
}

/** The panel (shown under the Alerts / Replay row once Ask AI was pressed). */
export function AiCheckPanel({ box, onClose, scrolled }: { box: Box; onClose: () => void; scrolled: { current: number } }) {
  const ref = useRef<HTMLElement>(null);
  const busy = box.result == null && box.error == null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (scrolled.current === box.run) return;
    scrolled.current = box.run; ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [box.run, scrolled]);
  useEffect(() => { if (!busy) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [busy]);
  return (
    <section ref={ref} className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>{box.title}</h2><p>Gemini&apos;s call on this Alpha token, checked by the same rules as the AI desk (expected value, reward:risk, hard stops).</p></div>
        <button className="btn sm" onClick={onClose}>Close</button></div>
      <div className="aibox">
        {box.error != null ? <div className="red">{box.error}</div>
          : box.result != null ? <AiResult x={box.result} />
          : <>
            <div className="muted">The AI committee is working · {Math.round((Date.now() - box.t0) / 1000)}s</div>
            <ul>{ST.map(([id, n]) => {
              const x = box.st[id];
              return <li key={id} className={!x ? "muted" : x.status === "done" ? "green" : x.status === "failed" ? "red" : x.status === "working" ? "amber" : "muted"}>
                {!x ? "○" : x.status === "done" ? "✓" : x.status === "failed" ? "✗" : x.status === "skipped" ? "–" : "…"} {n}{x && x.detail ? `: ${x.detail}` : x ? "" : " (waiting)"}</li>;
            })}</ul>
          </>}
      </div>
    </section>
  );
}

function AiResult({ x }: { x: any }) {
  const cls = x.decision === "TAKE" ? "green" : x.decision === "WAIT" ? "amber" : "red", p = x.plan || {};
  const cm = x.committee || {}, cd = cm.data || {}, cn = cm.news || {}, cb = cm.boss || {}, dbt = cm.debate || { off: true };
  const side = (v: any) => (v && v.available ? `${v.strength}/10` : "n/a");
  const crew = x.committee ? <>
    <div><b>Committee:</b>{` data ${cd.available ? tx(cd.dataQuality && cd.dataQuality.rating) : "n/a"} · news ${cn.available ? (cn.status === "unknown" ? "unknown" : `${tx(cn.riskLevel)} risk`) : cn.off ? "off" : "n/a"}`
      + `${dbt.off ? "" : ` · bull ${side(dbt.bull)} vs bear ${side(dbt.bear)}${dbt.verdict ? ` (${dbt.verdict.winner === "even" ? "even" : `${tx(dbt.verdict.winner)} won`})` : ""}`}`
      + ` · trader ${LBL[cm.trader && cm.trader.decision] || "?"} · Final Boss ${cb.available ? tx(cb.verdict) : cb.asked ? "no answer" : x.fastNo ? "skipped (fast NO)" : "not asked"}`}</div>
    {cd.available && arr(cd.redFlags).length > 0 && <div className="red"><b>Red flags:</b> {arr(cd.redFlags).map(tx).join("; ")}</div>}
    {dbt.verdict && dbt.verdict.reason && <div><b>Debate:</b> {tx(dbt.verdict.reason)}</div>}
    {dbt.bear && dbt.bear.available && dbt.bear.path && <div className="red"><b>Bear&apos;s path to the stop:</b> {tx(dbt.bear.path)}</div>}
    {cn.available && cn.status !== "unknown" && <div><b>News:</b> {tx(cn.summary || "no relevant news")}{arr(cn.sources).length > 0 && <> <small>({arr(cn.sources).length} sources)</small></>}</div>}
    {cb.available && cb.summary ? <div className={cb.verdict === "YES" ? "green" : cb.verdict === "WATCH" ? "amber" : "red"}><b>Final Boss ({tx(cb.verdict)}{cb.agreesWithTrader ? "" : ", overturned the trader"}):</b> {tx(cb.summary)}</div>
      : cb.asked && cb.reason ? <div className="amber"><b>Final Boss:</b> no answer ({tx(cb.reason)})</div> : null}
  </> : null;
  const tr = x.trigger;
  return <>
    <div><div className={`big ${cls}`}>{x.final ? tx(x.final) : LBL[x.decision] || tx(x.decision)}: {tx(x.symbol)}{x.sizePct != null && x.final === "YES" && <> <small>(size {`${x.sizePct}`}% of normal)</small></>}</div><small>{tx(x.headline)}</small></div>
    {crew}
    <div>{`Chance ${x.probTargetPct}% target / ${x.probStopPct}% stop · expected `}<b className={col(x.expectedValuePct)}>{pct(x.expectedValuePct)}</b> per trade
      {x.evCalc && <> <small className="mono">({tx(x.evCalc.formula)})</small></>}{` · ${tx(x.confidence)} confidence · setup ${x.setupScore}/10`}</div>
    {x.decision !== "SKIP" && <div className="mono">{`Entry ${p.entryLow}-${p.entryHigh} · stop ${p.stop} (${p.stopPct}%) · target ${p.target1} (+${p.target1Pct}%) · R:R ${p.rewardRisk}`}</div>}
    {x.waitFor && x.decision === "WAIT" && <div><b>Wait for:</b> {tx(x.waitFor)}{tr && <> <small>{`(watched for ${tr.expiresMinutes} min: the AI checks again if ${tr.event === "breakout" ? `a ${tx(tr.timeframe)} candle closes above ${tr.price}` : `the price dips to ${tr.price}`}; see the AI desk)`}</small></>}</div>}
    {arr(x.hardStops).length > 0 && <div className="red"><b>Hard stop:</b> {arr(x.hardStops).map(tx).join("; ")}</div>}
    <div><b>Checklist</b><ul>{arr(x.checklist).map((c, i) => <li key={i}><span className={c.status === "pass" ? "green" : c.status === "fail" ? "red" : "muted"}>{tx(c.status)}</span> {tx(c.item)}: {tx(c.evidence)}</li>)}</ul></div>
    <div><b>Key risk:</b> {tx(x.keyRisk)}</div>{arr(x.guardNotes).length > 0 && <small>{arr(x.guardNotes).map(tx).join(" ")}</small>}<small>AI opinion on the Alpha tab&apos;s data. Research only, not financial advice.</small>
  </>;
}

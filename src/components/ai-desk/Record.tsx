"use client";
import type { RecordResponse, ScoreGroup, TrackedCall } from "@/lib/ai-desk";
import { ago, arr, base, col, evLabel, kTok, lbl, left, num, pct, price, Stat, tx } from "./ui";

// The AI track record: watched WAIT triggers ("Stop watching"), the scorecard by committee member and the latest answers,
// each followed like a trade. Data: GET /api/ai/record every 60 seconds.
const SRC: Record<string, string> = { manual: "you", alert: "alert review", trigger: "trigger re-check" };

/** The "AI today" chip: requests and tokens used today against the daily limit. */
export function UsageChip({ rec }: { rec: RecordResponse | null }) {
  if (!rec) return <span className="chip">AI today: …</span>;
  const u = rec.usage || {}, tk = u.tokens || {}, req = u.requests || 0;
  const cls = u.limit && req >= u.limit ? " red" : u.limit && req >= 0.8 * u.limit ? " amber" : "";
  const title = u.limit ? `${tx(u.left)} requests left today (UTC). At the limit, automatic reviews and trigger re-checks pause; your own analyses still run. AI_DAILY_REQUESTS in .env.`
    : "No daily limit (AI_DAILY_REQUESTS=0).";
  return <span className={`chip${cls}`} title={title}>AI today: {req}{u.limit ? ` / ${u.limit}` : ""} requests · {kTok((tk.in || 0) + (tk.out || 0) + (tk.think || 0))} tokens</span>;
}

function Outcome({ c }: { c: TrackedCall }) {
  const t: Partial<NonNullable<TrackedCall["track"]>> = c.track || {};
  if (t.status === "open") return <><span className="muted">open</span><span className="sub">now {pct((Number(t.last) / c.entry - 1) * 100)} · {left(c.at + c.holdHours * 3600000 - Date.now())}</span></>;
  if (t.status === "nodata") return <span className="muted">no data</span>;
  return <span className={Number(t.netPct) > 0 ? "green" : "red"}>{t.status === "win" ? "target" : t.status === "loss" ? "stop" : "time up"} {pct(t.netPct, 2)}</span>;
}

export function RecordView({ rec, cancelling, onCancel }: { rec: RecordResponse; cancelling: Set<string>; onCancel: (id: string) => void }) {
  const sc = rec.scorecard || {}, groups = arr(sc.groups), armed = arr(rec.triggers?.armed), past = arr(rec.triggers?.past), calls = arr(rec.calls);
  const g = (s: string, k: string): ScoreGroup => groups.find((x) => x.section === s && x.key === k) || { n: 0 };
  const yes = g("final", "yes"), no = sc.notYes || { n: 0 }, blocked = g("boss", "blocked"), calibration = arr(sc.calibration);
  const avg = (x: ScoreGroup) => (x.n ? <b className={col(x.avgNetPct)}>{pct(x.avgNetPct, 2)}</b> : "—");
  return (
    <>
      <div className="sec">Watching (WAIT triggers)</div>
      {armed.length ? <div className="table-wrap"><table className="table">
        <thead><tr><th>Coin</th><th>Waiting for</th><th>Time</th><th>The AI said</th><th></th></tr></thead>
        <tbody>{armed.map((t) => (
          <tr key={t.id}>
            <td><b>{base(t.symbol)}</b>{t.kind === "alpha" && <> <span className="badge early">Alpha</span></>}<span className="sub">at the call {price(t.priceAtCall)}</span></td>
            <td>{evLabel(t)}<span className="sub">{pct(t.distPct, 2)} from the call</span></td>
            <td className="mono">{left(t.expiresAt - Date.now())}</td>
            <td className="muted">{tx(t.waitFor)}</td>
            <td><button className="btn sm" disabled={cancelling.has(t.id)} onClick={() => onCancel(t.id)}>Stop watching</button></td>
          </tr>
        ))}</tbody>
      </table></div>
        : <p className="meta">Nothing to watch right now. When the AI says WAIT with a clear price event, it is watched here and the committee checks again when it happens.</p>}
      {past.length > 0 && <details><summary>Recent triggers ({past.length})</summary><ul>{past.map((t) => (
        <li key={t.id}><b>{base(t.symbol)}</b> {evLabel(t)}: <span className={t.status === "hit" ? "green" : "muted"}>{tx(t.status)}</span>{t.hitAt ? ` ${ago(t.hitAt)}` : ""}
          {t.result ? (t.result.checked ? ` → ${lbl(t.result.decision)} (${tx(t.result.final)}): ${tx(t.result.headline)}` : ` → no AI check (${t.result.reason || t.result.error || ""})`) : ""}</li>
      ))}</ul></details>}

      <div className="recgrid">
        <Stat k="Final YES" v={yes.n ? <>{avg(yes)} per trade</> : "no results yet"} sub={yes.n ? `${yes.n} trades · ${tx(yes.hitTargetPct)}% hit target` : "each call is followed for its holding time"} />
        <Stat k="WATCH / NO, if bought" v={no.n ? <>{avg(no)} per trade</> : "—"} sub={no.n ? `${no.n} calls · ${tx(no.hitTargetPct)}% would have hit target` : ""} />
        <Stat k="Edge: YES − NO" v={sc.edgePct == null ? "—" : <b className={col(sc.edgePct)}>{pct(sc.edgePct, 2)}</b>} sub="above 0 = the committee picks better than its rejects" />
        <Stat k="Boss stopped a TAKE" v={blocked.n ? <>{avg(blocked)} per trade</> : "—"}
          sub={blocked.n ? `${blocked.n} trades; below 0 = the boss saved money` : "trader TAKEs the Final Boss did not approve"} />
      </div>
      {groups.length > 0 && <details open={Number(sc.resolved) >= 10}><summary>Results by committee member ({tx(sc.resolved)} resolved)</summary>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Group</th><th>Calls</th><th>Hit target</th><th>Hit stop</th><th>In profit</th><th>Avg after costs</th></tr></thead>
          <tbody>{groups.map((x) => (
            <tr key={`${x.section}:${x.key}`}><td>{tx(x.label)}</td><td className="mono">{x.n}</td><td className="mono">{tx(x.hitTargetPct)}%</td><td className="mono">{tx(x.hitStopPct)}%</td>
              <td className="mono">{tx(x.inProfitPct)}%</td><td className={`mono ${col(x.avgNetPct)}`}>{pct(x.avgNetPct, 2)}</td></tr>
          ))}</tbody>
        </table></div>
        {calibration.length > 0 && <p className="meta"><b>Said vs real chance of the target:</b> {calibration.map((b) => `said ${b.band} (avg ${num(b.saidPct, 0)}%) → hit ${tx(b.hitPct)}% of ${b.n}`).join(" · ")}</p>}
      </details>}

      {calls.length ? <>
        <div className="sec">Latest AI answers</div>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Coin</th><th>Answer</th><th>Members</th><th>Plan</th><th>Result (if bought)</th></tr></thead>
          <tbody>{calls.slice(0, 25).map((c) => (
            <tr key={c.id}>
              <td><b>{base(c.symbol)}</b>{c.kind === "alpha" && <> <span className="badge early">Alpha</span></>}<span className="sub">{ago(c.at)} · {SRC[c.source] || tx(c.source)}</span></td>
              <td><span className={`dec ${c.decision}`}>{tx(c.final)}</span>{c.sizePct != null && c.final === "YES" && <span className="sub">size {num(c.sizePct, 0)}%</span>}</td>
              <td className="muted" style={{ fontSize: 11 }}>trader {lbl(c.trader) || "?"}{c.boss ? ` · boss ${c.boss}${c.bossAgrees === false ? " (overturned)" : ""}` : ""}
                {c.debate && c.debate.winner ? ` · ${c.debate.winner} won` : ""}{c.news ? ` · news ${c.news}` : ""}{c.data ? ` · data ${c.data}` : ""}</td>
              <td className="mono">{pct(c.targetPct)} / {pct(c.stopPct)}<span className="sub">{num(c.holdHours, 0)}h · from {price(c.entry)}</span></td>
              <td className="mono"><Outcome c={c} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      </> : <p className="meta">No AI answers recorded yet. Each analysis from now on is followed here.</p>}
    </>
  );
}

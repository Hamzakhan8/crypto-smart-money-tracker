"use client";
// Result tables shared by Ignition and Alpha (the classic page's exitRows / speedRows / groupRows / aiTables): each
// returns the <tr> rows for a table whose header the tab writes.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { col, pct } from "@/lib/format";

const Small = ({ n }: { n?: number }) => (n && n < 20 ? <> <span className="muted">(small sample)</span></> : null);
export const Pctc = ({ v }: { v?: number | null }) => (v == null ? <>—</> : <span className={col(v)}>{pct(v)}</span>);

/** Exit rules compared (7 columns). */
export function ExitRows({ rows }: { rows?: any[] }) {
  if (!rows || !rows.some((x) => x.resolved)) return <tr><td colSpan={7} className="empty">Fills in with alerts from now on: every new alert is followed under each exit until the longest one ends.</td></tr>;
  return <>{rows.map((x) => (
    <tr key={x.key}><td>{x.key === "main" ? <b>{x.label}</b> : x.label}</td><td className="mono">{x.resolved}<Small n={x.resolved} /></td>
      <td className="mono">{x.inProfitPct == null ? "—" : `${x.inProfitPct}%`}</td><td className="mono"><Pctc v={x.avgNetPct} /></td>
      <td className="mono"><Pctc v={x.olderPct} /></td><td className="mono"><Pctc v={x.newerPct} /></td>
      <td className="mono">{x.bestPct == null ? "—" : `${pct(x.bestPct)} / ${pct(x.worstPct)}`}</td></tr>))}</>;
}
/** Alert speed (5 columns). */
export function SpeedRows({ sp, empty }: { sp?: any; empty: string }) {
  if (!sp || !sp.alerts) return <tr><td colSpan={5} className="empty">{empty}</td></tr>;
  return <>
    <tr><td>Delay after the 5-minute candle closed</td><td className="mono">{sp.avgLagSec == null ? "—" : `${sp.avgLagSec} s`}</td><td className="mono">{sp.alerts}</td><td colSpan={2} className="muted">from candle close to alert</td></tr>
    {(sp.marks || []).map((m: any) => (
      <tr key={m.minutes}><td>Price {m.minutes} min after the alert</td><td className="mono"><Pctc v={m.avgPct} /></td><td className="mono">{m.n}</td>
        <td className="mono">{m.ranAwayPct == null ? "—" : `${m.ranAwayPct}%`}</td><td className="mono">{m.fellPct == null ? "—" : `${m.fellPct}%`}</td></tr>))}
  </>;
}
const HOLDS: Record<string, React.ReactNode> = { better: <span className="green">Better in both</span>, worse: <span className="red">Worse in both</span>, mixed: <span className="muted">Mixed</span> };
/** What separates winners from losers (8 columns). */
export function GroupRows({ gs, empty }: { gs?: any[]; empty: string }) {
  if (!(gs || []).length) return <tr><td colSpan={8} className="empty">{empty}</td></tr>;
  return <>{gs!.map((b, i) => {
    const inProfit = b.inProfitPct ?? b.profitablePct;
    return (
      <tr key={`${b.name}-${i}`}><td>{b.name}</td><td className="mono">{b.resolved}<Small n={b.resolved} /></td>
        <td className="mono">{b.winRatePct == null ? "—" : `${Number(b.winRatePct).toFixed(0)}%`}</td>
        <td className="mono">{inProfit == null ? "—" : `${Number(inProfit).toFixed(0)}%`}</td>
        <td className="mono"><Pctc v={b.avgNetPct ?? b.netPct} /></td><td className="mono"><Pctc v={b.olderPct} /></td><td className="mono"><Pctc v={b.newerPct} /></td>
        <td>{b.holds ? HOLDS[b.holds] : <span className="muted">needs 6+</span>}</td></tr>);
  })}</>;
}
const VERDICT: Record<string, string> = { TAKE: "TAKE", WAIT: "WAIT", SKIP: "NO TRADE" };
/** Is the AI helping? Results by verdict (4 columns). */
export function AiVerdictRows({ ai }: { ai?: any }) {
  if (!ai || !ai.reviewed) return <tr><td colSpan={4} className="empty">Needs closed alerts with an AI verdict (an AI set up in .env: Gemini or a free open model).</td></tr>;
  return <>{(ai.verdicts || []).map((v: any) => (
    <tr key={v.decision}><td><b>{VERDICT[v.decision] || v.decision}</b></td><td className="mono">{v.resolved}<Small n={v.resolved} /></td>
      <td className="mono">{v.hitTargetPct == null ? "—" : `${v.hitTargetPct}%`}</td><td className="mono"><Pctc v={v.avgNetPct} /></td></tr>))}</>;
}
/** Said vs real chance of the target (4 columns). */
export function AiCalibrationRows({ ai }: { ai?: any }) {
  if (!ai || !ai.reviewed) return <tr><td colSpan={4} className="empty">A well-calibrated AI that says 30% should hit about 30%.</td></tr>;
  return <>{(ai.bands || []).map((b: any) => (
    <tr key={b.band}><td>{b.band}</td><td className="mono">{b.resolved}</td><td className="mono">{b.saidPct == null ? "—" : `${b.saidPct}%`}</td>
      <td className="mono">{b.hitTargetPct == null ? "—" : `${b.hitTargetPct}%`}</td></tr>))}</>;
}

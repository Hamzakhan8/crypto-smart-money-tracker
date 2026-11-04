// Coin helpers shared by the Ignition tab and the alert popups (the classic page's moveLine, structure, flags, rotTag).
import type { Candidate } from "./context";
import { pct1 } from "@/lib/format";

export const moveLine = (c: Candidate) => `${pct1(c.ret15m)} 15m · ${pct1(c.ret1h)} 1h · ${pct1(c.change24h)} 24h`;
export const structure = (c: Candidate) => [c.breakout === true ? "broke 12h high" : c.breakout === false ? "inside 12h range" : "", c.trendUp ? "4h trend rising" : "",
  c.range6h != null ? `moves ~${c.range6h.toFixed(1)}% per 6h` : ""].filter(Boolean).join(" · ");
/** Ignition state of a candidate: label and badge class. */
export const IGN_STATE: Record<string, [string, string]> = { ignited: ["Ignition", "strong"], heating: ["Heating up", "watch"], ran: ["Already running", "risk"] };
/** Monitoring-list and Seed badges. */
export function Flags({ c }: { c: Candidate }) {
  return <>
    {c.monitoring && <> <span className="badge risk" title="On Binance's Monitoring list: delisting risk">Monitoring</span></>}
    {c.seed && <> <span className="badge watch" title="Binance Seed tag: early-stage, very volatile">Seed</span></>}
  </>;
}
/** The coin's narratives and their BTC-rotation rank. */
export function RotTag({ c }: { c: Candidate }) {
  const r = c.rotation, ranked: { name: string; rank: number }[] = r && r.narratives ? r.narratives.filter((x: { rank: number | null }) => x.rank != null) : [];
  if (ranked.length) return <>{ranked.slice(0, 2).map((x, i) => <span key={x.name}>{i ? ", " : ""}<span className={x.rank <= 3 ? "green" : undefined}>{x.name} #{x.rank}</span></span>)}<span className="sub">rotation rank</span></>;
  return c.narrative ? <>{c.narrative.names.slice(0, 2).join(", ")}</> : <span className="muted">—</span>;
}

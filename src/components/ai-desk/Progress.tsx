"use client";
import type { StepStatus } from "@/lib/ai-desk";
import { secs } from "./ui";

// Live progress while an analysis runs: which committee member is working, from the streamed step lines.
export const STEPS = [
  ["dossier", "Market data", "prices, chart, order book, futures, flows"], ["data", "1 · Data analyst", "checks the numbers"],
  ["news", "2 · News researcher", "searches Google News and Binance, then judges"], ["bull", "3 · Bull", "the case for"],
  ["bear", "4 · Bear", "the case against"], ["trader", "5 · Trader", "makes the call"], ["checks", "Code checks", "hard stops, plan, expected value"],
  ["boss", "6 · Final Boss", "audits it all: YES, WATCH or NO"],
] as const;

export interface StepState { status: StepStatus | "waiting"; detail?: string; since?: number; end?: number | null }
export interface Progress { t0: number; st: Record<string, StepState> }
/** The progress as it was when the analysis ended (shown under the result as the committee timeline). */
export interface Timeline { prog: Progress; now: number; total: string }

const ICON: Record<string, string> = { done: "✓", failed: "✗", skipped: "–", working: "", waiting: "" };
const short = (name: string) => name.replace(/^\d+ · /, "");

export function ProgressView({ prog, now }: { prog: Progress; now: number }) {
  const working = STEPS.filter(([id]) => prog.st[id]?.status === "working").map(([, n]) => short(n));
  const next = STEPS.find(([id]) => !prog.st[id]), started = Object.keys(prog.st).some((id) => prog.st[id].status !== "skipped");
  return (
    <>
      <p className="meta" style={{ margin: "0 0 6px" }}>
        {working.length ? <><b>Working now:</b> {working.join(" and ")}</> : started && next ? <><b>Next:</b> {short(next[1])}</> : "Starting…"} · {secs(now - prog.t0)} so far
      </p>
      <ul className="steps">
        {STEPS.map(([id, name, role]) => {
          const x: StepState = prog.st[id] || { status: "waiting" };
          return (
            <li key={id} className={x.status}>
              <span className="ic">{ICON[x.status] ?? ""}</span>
              <div><b>{name}</b> <span className="muted" style={{ fontSize: "11.5px" }}>{role}</span><span className="dt">{x.status === "waiting" ? "waiting" : x.detail || x.status}</span></div>
              <span className="tm">{x.since ? secs((x.end || now) - x.since) : ""}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

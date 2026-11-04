"use client";
import { Component, type ReactNode } from "react";

// Formats and small pieces shared by the AI desk (the same formats as the classic ai.html, which differ a little from
// the other pages: prices without "$", one decimal for percentages by default).
type V = unknown;
const finite = (v: V): boolean => v != null && Number.isFinite(Number(v));
export const num = (v: V, d = 2): string => (finite(v) ? Number(v).toFixed(d) : "—");
export const pct = (v: V, d = 1): string => (finite(v) ? `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(d)}%` : "—");
export const usd = (v: V): string => {
  if (!finite(v)) return "—";
  const n = Number(v), a = Math.abs(n);
  return a >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`;
};
export const price = (v: V): string => {
  if (v == null) return "—";
  const n = Number(v);
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toPrecision(5);
};
export const ago = (t: V): string => {
  if (!t) return "";
  const s = Math.round((Date.now() - Number(t)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
/** green above 0, red below (JavaScript comparison rules, like the classic page: null counts as 0). */
export const col = (v: V): string => (Number(v) > 0 ? "green" : Number(v) < 0 ? "red" : "");
export const secs = (ms: number): string => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`);
export const kTok = (v: V): string => (v == null ? "—" : Number(v) >= 1e6 ? `${(Number(v) / 1e6).toFixed(2)}M` : Number(v) >= 1000 ? `${(Number(v) / 1000).toFixed(1)}k` : String(v));
export const left = (ms: number): string => (ms <= 0 ? "ending" : ms < 3600000 ? `${Math.round(ms / 60000)} min left` : `${(ms / 3600000).toFixed(1)} h left`);
/** Links from the model or the web only when they are http(s). */
export const safeUrl = (u: V): string => (/^https?:\/\//i.test(String(u ?? "")) ? String(u) : "#");
/** Model-written or server text as plain text (React escapes it; null shows nothing, never "[object]" errors). */
export const tx = (v: V): string => (v == null ? "" : String(v));
/** A list from the server, or an empty one if the model returned something else. */
export const arr = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
export const base = (symbol: V): string => tx(symbol).replace(/USDT$/, "");

export const LBL: Record<string, string> = { TAKE: "TAKE", WAIT: "WAIT", SKIP: "NO TRADE" };
export const lbl = (d: V): string => LBL[tx(d)] || tx(d);
export const TONE: Record<string, string> = { good: "TAKE", partial: "WAIT", poor: "SKIP", none: "TAKE", low: "TAKE", medium: "WAIT", high: "SKIP", YES: "TAKE", WATCH: "WAIT", NO: "SKIP" };
export const tone = (k: V): string | undefined => TONE[tx(k)];
/** A watched price event: "a 5m close above 1.234" or "a dip to 1.2". */
export const evLabel = (t: { event?: string; timeframe?: string; price?: V }): string =>
  t.event === "breakout" ? `a ${tx(t.timeframe)} close above ${price(t.price)}` : `a dip to ${price(t.price)}`;

export function Pill({ txt, t }: { txt: ReactNode; t?: string | null }) {
  return <span className={`dec ${t || "WAIT"}`}>{txt}</span>;
}
export function Stat({ k, v, sub, cls }: { k: string; v: ReactNode; sub?: ReactNode; cls?: string }) {
  return <div className="stat"><span>{k}</span><strong className={cls || undefined}>{v}</strong>{sub ? <small>{sub}</small> : null}</div>;
}

/** If a server answer has a shape the page does not expect, show the error in place instead of a blank page. */
export class Safe extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <div className="callout red">{this.state.error.message}</div> : this.props.children; }
}

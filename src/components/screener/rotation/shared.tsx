// Pieces the BTC rotation tab's panels share: the /api/rotation answer, regime names, holdings text, small cells.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment, type ReactNode } from "react";

/** GET /api/rotation (only the top level is typed; the rows are read exactly as the classic page read them). */
export interface RotationData {
  status?: string; progress?: { step: string; done: number; total: number } | null; error?: string | null; warning?: string | null;
  nextRetryAt?: number | null; binancePausedUntil?: number | null; demo?: boolean; btcNow?: number | null; asOf?: string;
  regimes?: Record<string, { label: string; desc: string; riskOff?: boolean }>; altStates?: Record<string, { label: string; desc: string }>;
  stages?: Record<string, string>; telegramOn?: boolean; holdDays?: number; feePct?: number;
  regimeNow?: { key: string; label: string; desc: string; riskOff?: boolean } | null;
  btc?: any; ranking?: any[]; altSeason?: any; regimeStats?: any; holdingsNow?: any; picks?: any[]; heatmap?: any; backtest?: any; record?: any;
  [k: string]: any;
}
export type Regimes = RotationData["regimes"];

export const holdName = (x: string) => (x === "CASH" ? "Cash" : x);
export const holdTxt = (a?: string[] | null) => (a || []).map(holdName).join(" + ") || "—";
/** "Uptrend, calm" from "BTC uptrend, calm" (the regime's label without "BTC ", capitalised). */
export const rName = (RG: Regimes, k: string) => {
  const t = ((RG || {})[k] || { label: k }).label.replace("BTC ", "");
  return t[0].toUpperCase() + t.slice(1);
};
export const conf = (c?: string) => (c === "high" ? <span className="green">high</span> : c === "medium" ? <span className="amber">medium</span> : <span className="muted">low</span>);
/** Joins pieces of JSX with a separator (the classic page's .map(...).join(" · ")). */
export function joined(items: ReactNode[], sep: string): ReactNode {
  return items.map((x, i) => <Fragment key={i}>{i ? sep : ""}{x}</Fragment>);
}

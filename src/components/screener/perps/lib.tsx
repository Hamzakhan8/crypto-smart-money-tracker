// Shared pieces of the Perps tab (the classic page's PSETUP, pPx, pR, pSide, pVd, usd, hm, pRisk and pSize).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";

// GET /api/perps and GET /api/scalp: the JSON has many fields; the tab reads them as the classic page did.
export type PerpsData = Record<string, any>;
export type ScalpData = Record<string, any>;

export const PSETUP: Record<string, string> = {
  weakshort: "Weak-coin breakdown (A+)", squeeze: "Short-squeeze breakout (A+)", breakout: "20-day breakout", crowded: "Crowded fade",
  pullback: "Trend pullback", flush: "Flush reversal", strength: "Relative strength", trend: "Plain trend",
};
/** A futures price (no $ sign). */
export const pPx = (v: any): string => (!(v > 0) ? "—" : v >= 1000 ? Number(v).toFixed(1) : v >= 1 ? Number(v).toFixed(4) : Number(v).toPrecision(4));
/** A result in R (multiples of the risk). */
export const pR = (v: any): string => (v == null || !Number.isFinite(v) ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(2) + "R");
/** Dollars with cents, "-$" for a loss. */
export const usd = (v: any): string => (v == null || !Number.isFinite(Number(v)) ? "—" : (Number(v) < 0 ? "-$" : "$") + Math.abs(Number(v)).toFixed(2));
/** Hours and minutes. */
export const hm = (t: any): string => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");
/** "Nov 4, 08:00" (no check for a missing time, as the classic page). */
export const dt = (t: any): string => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const Side = ({ side }: { side: any }) => <span className={`side ${side}`}>{side === "short" ? "SHORT" : "LONG"}</span>;
export const Vd = ({ v }: { v: any }) => <span className={`vd ${String(v ?? "")}`}>{String(v ?? "")}</span>;

// ---------- risk settings (this browser only: localStorage "perps:acct", "perps:risk"…) ----------
export type RiskKey = "acct" | "risk" | "lev" | "mmr" | "max";
export interface Risk { acct: number; risk: number; lev: number; mmr: number; max: number }
export type RiskInputs = Record<RiskKey, string>;
export const RISK_FIELDS: [key: RiskKey, label: string, def: number, step: string, min: string, max?: string][] = [
  ["acct", "Account ($)", 1000, "any", "0"], ["risk", "Risk per trade (%)", 1, "0.1", "0.1", "10"], ["lev", "Leverage (x)", 5, "1", "1", "125"],
  ["mmr", "Maintenance margin (%)", 0.5, "0.1", "0", "10"], ["max", "Max open positions", 5, "1", "1", "20"],
];
/** The five risk inputs as typed, remembered in this browser (a value is saved on every keystroke, as the classic page). */
export function useRiskInputs(): [RiskInputs, (k: RiskKey, v: string) => void] {
  const [vals, setVals] = useState<RiskInputs>(() => Object.fromEntries(RISK_FIELDS.map(([k, , d]) => [k, String(d)])) as RiskInputs);
  useEffect(() => {
    const saved: Partial<RiskInputs> = {};
    for (const [k] of RISK_FIELDS) { try { const v = localStorage.getItem("perps:" + k); if (v != null && v !== "") saved[k] = v; } catch { /* not available */ } }
    if (Object.keys(saved).length) setVals((o) => ({ ...o, ...saved }));
  }, []);
  const set = (k: RiskKey, v: string) => { setVals((o) => ({ ...o, [k]: v })); try { localStorage.setItem("perps:" + k, v); } catch { /* not available */ } };
  return [vals, set];
}
/** The numbers used for sizing: a missing, zero or invalid input falls back to its default. */
export const riskOf = (vals: RiskInputs): Risk => {
  const o = {} as Risk;
  for (const [k, , d] of RISK_FIELDS) { const v = Number(vals[k]); o[k] = Number.isFinite(v) && v > 0 ? v : d; }
  return o;
};
/** Size from the risk; isolated-margin liquidation (approximate: Binance's real tiers differ a little). */
export function pSize(R: Risk, dir: number, entry: number, stop: number, costPct?: number | null) {
  const dist = Math.abs(entry - stop) / entry, cost = (costPct ?? 0.16) / 100, riskUsd = R.acct * R.risk / 100, notional = riskUsd / (dist + cost), margin = notional / R.lev;
  const liq = dir > 0 ? entry * (1 - 1 / R.lev + R.mmr / 100) : entry * (1 + 1 / R.lev - R.mmr / 100), liqDist = Math.abs(entry - liq) / entry, safeLev = Math.max(1, Math.floor(1 / (2 * dist + R.mmr / 100)));
  return { R, riskUsd, notional, qty: notional / entry, margin, liq, ok: dir * (stop - liq) > 0 && liqDist >= 1.5 * dist, safeLev, tooBig: margin > R.acct };
}
/** The backtest record of one setup and side (from the perps report). */
export const pRecord = (pd: PerpsData | null, setup: string, side: string) => (pd?.report?.results || []).find((x: any) => x.setup === setup && x.side === side) || null;
/** Binance futures blocked (451 / 403): the hint the classic page adds to the error. */
export const blockedHint = (err: string) => (/451|403|blocked/.test(err) ? " · Binance futures is blocked on this connection: use a VPN or set BINANCE_FUTURES_URL (README: Troubleshooting)." : "");

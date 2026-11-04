"use client";
// Small pieces of the Alpha tab (the classic page's wusd, aPx, aAgo, aBuys, aiBadge and the explorer links).
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Dollar amounts with k / M / B (the classic page's wusd: negative values too, "—" for anything not a number). */
export const wusd = (v: any): string => v == null || !Number.isFinite(v) ? "—" : Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B`
  : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${Math.round(v)}`;
/** Alpha token prices: 4 decimals from $1, else 4 significant digits. */
export const aPx = (v: any): string => (v == null ? "—" : v >= 1 ? `$${Number(v).toFixed(4)}` : `$${Number(v).toPrecision(4)}`);
export const aAgo = (t: number): string => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
/** Hours and minutes of a time, "—" without one. */
export const hm = (t: any): string => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");
/** Block explorers per chain (token pages). */
export const EXPL: Record<string, string> = {
  BSC: "https://bscscan.com/token/", Base: "https://basescan.org/token/", Ethereum: "https://etherscan.io/token/",
  Arbitrum: "https://arbiscan.io/token/", Solana: "https://solscan.io/token/", Sui: "https://suiscan.xyz/mainnet/coin/",
};
/** Model or server text as plain text (the classic page's esc(): null shows nothing). */
export const tx = (v: any): string => (v == null ? "" : String(v));
/** A list from the server, or an empty one if it sent something else. */
export const arr = (v: any): any[] => (Array.isArray(v) ? v : []);

/** The state of a token that has no ignition tier. */
export function StateBadge({ state }: { state: string }) {
  if (state === "ignited") return <span className="badge strong">Ignited</span>;
  if (state === "heating") return <span className="badge watch" style={{ color: "var(--amber)", borderColor: "#6d5621", background: "#2b2414" }}>Heating up</span>;
  if (state === "ran") return <span className="badge risk">Already moved</span>;
  if (state === "quiet") return <span className="badge">Quiet</span>;
  return <>{tx(state)}</>;
}

/** DEX buys vs sells in the last 5 minutes and the last hour (DexScreener). */
export function Buys({ d }: { d: any }) {
  if (!d) return <span className="muted">no DEX pool found</span>;
  const s = d.buyShare5m;
  return <>
    <b className={s >= 55 ? "green" : s != null && s < 45 ? "red" : ""}>{`${d.m5?.buys ?? "?"} / ${d.m5?.sells ?? "?"}`}</b>{s != null ? ` (${s}%)` : ""}
    <span className="sub">{`last hour ${d.buyShare1h ?? "—"}% buys`}</span>
  </>;
}

/** The AI's verdict on an alert (TAKE / WAIT / NO TRADE), its error, or "—". */
export function AiBadge({ x }: { x: any }) {
  if (x && x.decision) {
    return <span className={`badge ${x.decision === "TAKE" ? "strong" : x.decision === "WAIT" ? "watch" : "risk"}`}
      title={`${tx(x.headline)}${x.expectedValuePct != null ? ` · expected ${x.expectedValuePct}% per trade` : ""}`}>{x.decision === "SKIP" ? "NO TRADE" : tx(x.decision)}</span>;
  }
  if (x && x.error) return <span className="badge risk" title={tx(x.error)}>AI error</span>;
  return <span className="muted">—</span>;
}

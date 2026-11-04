// Formats and names of the Whales tab (the classic page's wusd, snet, wamt, wago, wclock, wshort, wsUsd, ocPx,
// WTYPES, KINDS, CATS and wMatch).

export const WTYPES: Record<string, string> = {
  whale: "WHALE TRANSFER", deposit: "EXCHANGE DEPOSIT", withdrawal: "EXCHANGE WITHDRAWAL", mint: "STABLECOIN MINT", burn: "STABLECOIN BURN",
  issuer: "ISSUER MOVE", wallet: "WATCHED WALLET", token: "WATCHED TOKEN", watch: "PAIR WATCH", surge: "ROTATION SURGE", rotation: "WALLET ROTATION",
};
export const KINDS: Record<string, string> = {
  deposit: "Exchange deposit", withdrawal: "Exchange withdrawal", exchange_to_exchange: "Exchange → exchange", internal: "Internal exchange",
  mint: "Mint", burn: "Burn", issuer: "Issuer", dex: "DEX", bridge: "Bridge", defi: "DeFi", contract: "Wallet ↔ contract", transfer: "Wallet → wallet",
};
export const CATS: Record<string, string> = {
  exchange: "Exchange", fund: "Fund", issuer: "Issuer", bridge: "Bridge", dex: "DEX", defi: "DeFi", mev: "MEV bot", mixer: "Mixer",
  flagged: "Flagged", watched: "Your label", safe: "Multisig / smart wallet", ens: "ENS", token: "Token",
};

/** Joins the class names that are set. */
export const cx = (...c: (string | false | null | undefined)[]): string => c.filter(Boolean).join(" ");

type N = number | null | undefined;
/** $1.23B / $4.56M / $7.8k / $12 */
export const wusd = (v: N): string => v == null || !Number.isFinite(v) ? "—"
  : Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${Math.round(v)}`;
/** A signed amount: +$1.2M / −$3.4k */
export const snet = (v: N): string => (v != null && v > 0 ? "+" : v != null && v < 0 ? "−" : "") + wusd(v == null ? NaN : Math.abs(v));
/** A token amount: 1.23B / 4.56M / 7.8k / 12.34 / 0.0123 */
export const wamt = (v: N): string => v == null || !Number.isFinite(v) ? ""
  : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
export const wago = (t: N): string => {
  if (!t) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
export const wclock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const wshort = (a: string | null | undefined): string => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "?");
/** Whale signals' dollars: -$1.2M / $340k */
export const wsUsd = (v: N): string => {
  const a = Math.abs(v || 0);
  return (v != null && v < 0 ? "-" : "") + (a >= 1e9 ? `$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}k` : `$${Math.round(a)}`);
};
/** On-chain prices */
export const ocPx = (v: N): string => (v == null || !(v > 0) ? "—" : v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));
/** Upper-case text of a possibly missing value. */
export const S = (x: unknown): string => String(x || "").toUpperCase();
/** The DEX filter: "PEPE" matches either side, "ETH-PEPE" (or ETH>PEPE, ETH/PEPE, ETH→PEPE) that pair either way. */
export function wMatch(q: string, from: string, to: string): boolean {
  if (!q) return true;
  const m = q.toUpperCase().replace(/\s/g, "").split(/->|>|-|\/|→/).filter(Boolean);
  if (m.length >= 2) return (from === m[0] && to === m[1]) || (from === m[1] && to === m[0]);
  return from.includes(m[0]) || to.includes(m[0]);
}

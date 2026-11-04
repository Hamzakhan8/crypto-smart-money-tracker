// Number and time formats shared by the React pages (the same as the classic pages).
type Num = number | string | null | undefined;
const ok = (v: Num): v is number | string => v != null && v !== "" && Number.isFinite(Number(v));

export const money = (v: Num): string => {
  if (!ok(v)) return "—";
  const n = Number(v);
  return n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
};
export const price = (v: Num): string => {
  if (!ok(v)) return "—";
  const n = Number(v);
  return n >= 1000 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : n >= 1 ? `$${n.toFixed(3)}` : `$${n.toPrecision(5)}`;
};
export const pct = (v: Num): string => (ok(v) ? `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)}%` : "—");
export const pct1 = (v: Num): string => (ok(v) ? `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(1)}%` : "—");
export const time = (v: Num): string => (ok(v) && Number(v) > 0 ? new Date(Number(v)).toLocaleTimeString() : "—");
export const when = (v: Num): string => (ok(v) && Number(v) > 0 ? new Date(Number(v)).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
/** "green" / "red" / "" for a signed number (the classic pages' col()). */
export const col = (v: Num): string => (!ok(v) ? "" : Number(v) > 0 ? "green" : Number(v) < 0 ? "red" : "");
export const bookPrice = (v: Num): string => {
  const n = Number(v);
  return n >= 1000 ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(5) : n.toPrecision(6);
};
export const amount = (v: Num, digits = 5): string => Number(v).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });

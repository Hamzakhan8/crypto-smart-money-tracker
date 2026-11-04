"use client";
// Small pieces every screener tab uses: polling an API, the state tabs above a list, KPI tiles, data-health rows.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getJson } from "@/lib/api";
import { useStored } from "@/components/useStored";

/** Fetches `path` now and every `ms` while the component is shown (a tab's components unmount when the tab closes).
 *  path = null: nothing is fetched. Keeps the last good data when a refresh fails. */
export function usePoll<T>(path: string | null, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const reload = useCallback(async () => {
    if (!path) return;
    try { const d = await getJson<T>(path); if (live.current) { setData(d); setError(null); } }
    catch (e) { if (live.current) setError((e as Error).message); }
  }, [path]);
  useEffect(() => {
    live.current = true;
    reload();
    const t = ms > 0 ? setInterval(reload, ms) : null;
    return () => { live.current = false; if (t) clearInterval(t); };
  }, [reload, ms]);
  return { data, error, reload, setData };
}

// ---------- state tabs in a list: All · Strong flow · Heating up · Already running · AI: TAKE ----------
export const STATE_TABS = [["all", "All"], ["strong", "Strong flow"], ["heating", "Heating up"], ["running", "Already running"], ["take", "AI: TAKE"]] as const;
export type StateKey = (typeof STATE_TABS)[number][0];
export type StateCat = Partial<Record<Exclude<StateKey, "all">, boolean>>;
/** The state tabs of one list (`list` = its name, remembered per browser as "st:" + list). `cat` says which groups a
 *  row is in; `hints` what each group means in this list. Returns the rows of the chosen tab, the tab bar and the text
 *  for an empty list. */
export function useStateTabs<T>(list: string, rows: T[], cat: (r: T) => StateCat, hints: Partial<Record<StateKey, string>> = {}) {
  const [cur, setCur] = useStored("st:" + list, "all");
  const n: Record<string, number> = { all: rows.length, strong: 0, heating: 0, running: 0, take: 0 };
  const cats = rows.map((r) => { const c = cat(r) || {}; for (const k of ["strong", "heating", "running", "take"] as const) if (c[k]) n[k]++; return c; });
  const shown = cur === "all" ? rows : rows.filter((_, i) => cats[i][cur as Exclude<StateKey, "all">]);
  const bar = (
    <div className="sttabs" role="tablist" aria-label="Filter the list">
      {STATE_TABS.map(([k, l]) => (
        <button key={k} type="button" role="tab" data-st={k} className={k === cur ? "on" : undefined} aria-selected={k === cur} title={hints[k] || ""} onClick={() => setCur(k)}>
          {l}<span>{n[k]}</span></button>))}
    </div>
  );
  const empty = (txt: string) => (cur === "all" ? txt : `Nothing under "${STATE_TABS.find((x) => x[0] === cur)?.[1] ?? ""}" right now.`);
  return { rows: shown, bar, empty, current: cur };
}

export function Kpi({ label, value, hint, cls, style }: { label: ReactNode; value: ReactNode; hint?: ReactNode; cls?: string; style?: React.CSSProperties }) {
  return <div className="kpi"><div className="label">{label}</div><div className={`value${cls ? ` ${cls}` : ""}`} style={style}>{value}</div>{hint != null && <div className="hint">{hint}</div>}</div>;
}
/** One "Data health" row: a label and a status pill (cls: green / amber / red). */
export function SourceRow({ label, children, cls, wrap }: { label: ReactNode; children: ReactNode; cls?: string; wrap?: boolean }) {
  return <div className="source-row"><span>{label}</span><b className={`status-pill${cls ? ` ${cls}` : ""}`} style={wrap ? { whiteSpace: "normal" } : undefined}>{children}</b></div>;
}
/** The red error box at the top of a tab (hidden when there is nothing to say). */
export function ErrorBox({ children }: { children?: ReactNode }) {
  return children ? <div className="error" style={{ display: "block" }}>{children}</div> : null;
}
/** A link that only opens https:// addresses (data from outside sources must never become a javascript: link). */
export function SafeLink({ url, children, className }: { url?: string | null; children: ReactNode; className?: string }) {
  return url && /^https:\/\//.test(url) ? <a className={className} href={url} target="_blank" rel="noopener noreferrer">{children}</a> : <>{children}</>;
}

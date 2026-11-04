// Small helpers of the Ignition tab (the classic page's cfg(), join(" · "), the state-tab bars and the Telegram state
// shared by Data health and the Telegram panel).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { cloneElement, Fragment, useRef, useState, type ReactElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { ScreenerData } from "../context";

/** The scanner settings (the classic page's cfg()). */
export const cfg = (data: ScreenerData | null): any => data?.config || { minScore: 70 };

/** Nodes with a separator between them (the classic page's .join(" · ")). */
export function join(nodes: ReactNode[], sep: ReactNode = " · "): ReactNode {
  return nodes.map((n, i) => <Fragment key={i}>{i ? sep : null}{n}</Fragment>);
}

/** A class attribute from parts; nothing when every part is empty. */
export const cx = (...parts: (string | false | null | undefined)[]): string | undefined => parts.filter(Boolean).join(" ") || undefined;

/** A list's state-tab bar with the classic list's own aria-label. Before the first scan the classic bar is empty. */
export function tabBar(bar: ReactNode, label: string, ready: boolean): ReactNode {
  return ready ? cloneElement(bar as ReactElement<any>, { "aria-label": label }) : <div className="sttabs" role="tablist" aria-label={label} />;
}

/** A number with fixed decimals, or "—" (guards the classic page's .toFixed() calls). */
export const fx = (v: any, d: number): string => (v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(d));

// ---------- Telegram: test message, a switch per kind of message ----------
export interface TgTest { at: number; ok: boolean; text: string }
export interface TgState {
  t: any; // the Telegram status (data.telegram, or the newer copy a test / switch returned)
  res: TgTest | null; // the last test result, for 60 seconds
  sending: string | null; // which "Send test message" button is sending ("tgTest" / "tgTest2")
  pending: Record<string, boolean>; // switches being saved: kind -> the new value
  sendTest: (button: string) => void;
  setPref: (kind: string, on: boolean) => void;
}
export function useTelegram(data: ScreenerData | null): TgState {
  const [over, setOver] = useState<{ base: ScreenerData | null; t: any } | null>(null);
  const [test, setTest] = useState<TgTest | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const latest = useRef(data); latest.current = data;
  const overRef = useRef(over); overRef.current = over;
  // like the classic page, a returned status replaces data.telegram until the next /api/screener poll
  const t = over && over.base === data ? over.t : data?.telegram || {};
  const current = () => (overRef.current && overRef.current.base === latest.current ? overRef.current.t : latest.current?.telegram || {});

  const sendTest = async (button: string) => {
    setSending(button);
    try {
      const r = await fetch("/api/telegram/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = await r.json();
      setTest({ at: Date.now(), ok: !!j.sent, text: j.sent ? "sent, check Telegram" : (j.error || j.skipped || "not sent") + (j.queued ? " (it will keep retrying)" : "") });
      if (j.telegram) setOver({ base: latest.current, t: j.telegram });
    } catch (err) { setTest({ at: Date.now(), ok: false, text: (err as Error).message }); }
    setSending(null);
  };
  const setPref = async (kind: string, on: boolean) => {
    setPending((p) => ({ ...p, [kind]: on }));
    const done = () => setPending((p) => { const n = { ...p }; delete n[kind]; return n; });
    try {
      const r = await fetch("/api/telegram/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, on }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      setOver({ base: latest.current, t: { ...current(), ...j } });
      done();
    } catch (err) {
      flushSync(done); // the switch flips back before the message, as on the classic page
      alert("Could not change it: " + (err as Error).message);
    }
  };
  return { t, res: test && Date.now() - test.at < 60000 ? test : null, sending, pending, sendTest, setPref };
}

"use client";
// The system status bar under the title (/api/status, health.js): one dot per part of the app. Click it for each part's
// last update and its exact error.
import { useState } from "react";
import { usePoll } from "./ui";

interface Part { key: string; name: string; state: "ok" | "warn" | "error" | "off"; text?: string; detail?: string; updatedAt?: number | null; since?: number | null }
const ST_LABEL: Record<string, string> = { ok: "working", warn: "warning", error: "not working", off: "off" };

export function StatusBar() {
  const { data } = usePoll<{ parts: Part[] }>("/api/status", 30_000);
  const [open, setOpen] = useState(false);
  if (!data?.parts) return <div className="statusbar" aria-label="System status" />;
  const bad = data.parts.filter((p) => p.state === "error").length;
  return (
    <>
      <div className="statusbar" aria-label="System status">
        <span className="lbl">{bad ? <span className="red">{bad} part{bad > 1 ? "s" : ""} not working</span> : "System:"}</span>
        {data.parts.map((p) => (
          <button key={p.key} type="button" className={`stc ${p.state}`} title={`${p.name}: ${ST_LABEL[p.state] || p.state} · ${p.text || ""}`} onClick={() => setOpen(!open)}>
            <i />{p.name.replace(/ \(.*\)$/, "")}</button>))}
      </div>
      {open && <div className="statusdetail source-list">
        {data.parts.map((p) => (
          <div className="source-row" key={p.key}>
            <span><b style={{ color: "var(--ink)" }}>{p.name}</b><br /><span style={{ fontSize: 12 }}>{p.text || ""}{p.detail && p.detail !== p.text ? ` · ${p.detail}` : ""}</span></span>
            <b className={`status-pill ${p.state === "ok" ? "green" : p.state === "warn" ? "amber" : p.state === "error" ? "red" : ""}`} style={{ whiteSpace: "nowrap" }}>
              {ST_LABEL[p.state] || p.state}
              {p.updatedAt && p.state !== "off" ? <><br /><span className="muted" style={{ fontWeight: 600 }}>updated {new Date(p.updatedAt).toLocaleTimeString()}</span></> : null}
              {p.since ? <><br /><span className="red" style={{ fontWeight: 600 }}>since {new Date(p.since).toLocaleTimeString()}</span></> : null}
            </b>
          </div>))}
        <div className="source-row"><span style={{ fontSize: 12 }}>Green = working, amber = a warning, red = not working, grey = switched off. Telegram warns you when a part is red for 30 minutes (Ignition › Telegram, &quot;Warnings&quot;).</span>
          <button className="btn sm" type="button" onClick={() => setOpen(false)}>Close</button></div>
      </div>}
    </>
  );
}

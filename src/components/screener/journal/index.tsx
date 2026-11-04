"use client";
// The Journal tab: your own trades next to the alerts they came from (the classic page's #view-journal). Data: GET
// /api/journal every 30 s; add a trade (POST /api/journal), close it with your exit (POST /api/journal/update) or delete
// it (POST /api/journal/delete). "I took it" on an alert opens this tab with the form filled in (takeJournalPrefill).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { postJson } from "@/lib/api";
import { col, pct } from "@/lib/format";
import { Sec, useScreener } from "../context";
import { ErrorBox, Kpi, usePoll } from "../ui";

// GET /api/journal (and the answer of every POST): the trades with their live results, and the summary.
interface JournalData { trades?: any[]; summary?: any }
const TOOLN: Record<string, string> = { ignition: "Confirmed ignition", early: "Early ignition", bigmove: "Big move", alpha: "Alpha", early2x: "Early 2x", perps: "Perps", other: "Other" };
const BLANK = { tool: "ignition", side: "long", symbol: "", entry: "", size: "", stop: "", target: "", fees: "", note: "", alertId: "", alphaId: "" };
type Form = typeof BLANK;
const TITLE = "Add a trade", NOTE = "Your real fill. Size and fees are optional but give you dollar results.";

const jPx = (v: any): string => (v == null ? "—" : Number(v) >= 1 ? Number(v).toFixed(4) : Number(v).toPrecision(4));
const jUsd = (v: any): string => (v == null ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const jWhen = (t: any): string => (t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const tx = (v: any): string => (v == null ? "" : String(v));
const p6 = (v: any): string => (v ? String(Number(Number(v).toPrecision(6))) : ""); // a price as the form shows it (6 significant digits)
const SideTag = ({ x }: { x: any }) => (x.side === "short" ? <> <span className="kind deposit">SHORT</span></> : null);

export default function JournalTab() {
  const { takeJournalPrefill } = useScreener();
  const { data: jd, error, setData } = usePoll<JournalData>("/api/journal", 30_000);
  const [msg, setMsg] = useState<string | null>(null); // the red box: the last error (a failed load, save, close or delete)
  const posted = useRef(false);
  // a successful load hides the box; a successful save, close or delete does not (as on the classic page)
  useEffect(() => { if (posted.current) { posted.current = false; return; } setMsg(null); }, [jd]);
  useEffect(() => { if (error) setMsg(`Cannot load the journal: ${error}`); }, [error]);

  const [f, setF] = useState<Form>(BLANK);
  const [title, setTitle] = useState(TITLE), [note, setNote] = useState(NOTE);
  const entryRef = useRef<HTMLInputElement>(null);
  const exitRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [focusEntry, setFocusEntry] = useState(0);
  const field = (k: keyof Form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => { const v = e.target.value; setF((s) => ({ ...s, [k]: v })); };
  const reset = () => { setF(BLANK); setTitle(TITLE); setNote(NOTE); };

  // "I took it" on an alert: open with the alert's details filled in, the entry price selected for your real fill
  useEffect(() => {
    const o = takeJournalPrefill();
    if (!o) return;
    setF({ ...BLANK, tool: o.tool || "other", side: o.side === "short" ? "short" : "long", symbol: o.symbol || "", entry: p6(o.price),
      stop: p6(o.stop), target: p6(o.target), alertId: o.alertId || "", alphaId: o.alphaId || "" });
    setTitle(`I took it: ${o.symbol || ""}`);
    setNote(`Alert price ${jPx(o.alertPrice)}. Change the entry to your real fill price, add your size, then save.`);
    setFocusEntry((n) => n + 1);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the tab opens
  useEffect(() => { if (focusEntry) { entryRef.current?.focus(); entryRef.current?.select(); } }, [focusEntry]);

  const jPost = async (path: string, body: object) => { const j = await postJson<JournalData>(path, body); posted.current = true; setData(j); };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const num = (v: string) => (v === "" ? null : Number(v));
    try {
      await jPost("/api/journal", { tool: f.tool, side: f.side, symbol: f.symbol, entryPrice: num(f.entry), sizeUsd: num(f.size), stopPrice: num(f.stop), targetPrice: num(f.target),
        feesUsd: num(f.fees), note: f.note, alertId: f.alertId || null, alphaId: f.alphaId || null, entryTime: Date.now() });
      reset();
    } catch (err) { setMsg((err as Error).message); }
  };
  const close = async (id: string) => {
    const inp = exitRefs.current[id], px = Number(inp && inp.value);
    if (!(px > 0)) { inp?.focus(); return; }
    try { await jPost("/api/journal/update", { id, exitPrice: px, exitTime: Date.now() }); } catch (err) { setMsg((err as Error).message); }
  };
  const del = async (id: string) => {
    try { if (confirm("Delete this trade from the journal?")) await jPost("/api/journal/delete", { id }); } catch (err) { setMsg((err as Error).message); }
  };

  const loaded = jd != null, S = jd?.summary || {}, T = jd?.trades || [], v = S.vsAlerts || {};
  const open = T.filter((x) => x.result && x.result.open), done = T.filter((x) => x.result && !x.result.open);
  return (
    <>
      <details className="notice"><summary><b>Your trades, not the alerts&apos;:</b> press &quot;I took it&quot; on any alert, or add a trade by hand, then close it with your real exit.</summary>
        <div>The journal compares your real results with the alerts&apos; tracked results: the gap is what slippage, timing and hesitation cost you. Prices for open trades are live (Binance spot, or the Alpha tab for Alpha tokens). Saved in journal.json on your PC. Nothing is ever sent to an exchange.</div></details>
      <ErrorBox>{msg}</ErrorBox>
      <div className="kpis">
        <Kpi label="Closed trades" value={loaded ? S.closed ?? 0 : "—"} hint={loaded ? (S.closed ? `${S.winRatePct}% in profit · ${S.open} open` : `${S.open || 0} open`) : "win rate"} />
        <Kpi label="Total profit / loss" value={loaded && S.totalPnlUsd != null ? jUsd(S.totalPnlUsd) : "—"} cls={loaded ? col(S.totalPnlUsd) : undefined}
          hint={`closed trades, after your fees${loaded && S.openPnlUsd ? ` · open ${jUsd(S.openPnlUsd)}` : ""}`} />
        <Kpi label="Average per trade" value={loaded && S.avgPnlPct != null ? pct(S.avgPnlPct) : "—"} cls={loaded ? col(S.avgPnlPct) : undefined}
          hint={loaded && S.closed ? `best ${pct(S.bestPct)} · worst ${pct(S.worstPct)}${S.avgR != null ? ` · ${S.avgR}R average` : ""}` : "best · worst"} />
        <Kpi label="You vs the alerts" value={loaded && v.trades ? `${pct(v.yourAvgPct)} vs ${pct(v.alertAvgPct)}` : "—"}
          hint={loaded ? (v.trades ? `you vs the same ${v.trades} alerts` : "needs closed trades from alerts")
            + (S.avgEntryVsAlertPct != null ? ` · your fills ${pct(S.avgEntryVsAlertPct)} ${S.avgEntryVsAlertPct > 0 ? "worse" : "better"} than the alert price` : "") : "same alerts, tracked result"} />
      </div>
      <Sec id="add"><section className="panel"><div className="section-head"><div><h2>{title}</h2><p>{note}</p></div></div>
        <form className="jform" autoComplete="off" onSubmit={save}>
          <label>Tool<select value={f.tool} onChange={field("tool")}><option value="ignition">Confirmed ignition</option><option value="early">Early ignition</option><option value="bigmove">Big move</option><option value="alpha">Alpha</option><option value="early2x">Early 2x</option><option value="perps">Perps (futures)</option><option value="other">Other</option></select></label>
          <label>Side<select value={f.side} onChange={field("side")}><option value="long">Long</option><option value="short">Short</option></select></label>
          <label>Coin<input value={f.symbol} onChange={field("symbol")} placeholder="e.g. SUI or EVAA" required /></label>
          <label>Entry price<input ref={entryRef} value={f.entry} onChange={field("entry")} type="number" step="any" min="0" required /></label>
          <label>Size ($)<input value={f.size} onChange={field("size")} type="number" step="any" min="0" placeholder="optional" /></label>
          <label>Stop<input value={f.stop} onChange={field("stop")} type="number" step="any" min="0" placeholder="optional" /></label>
          <label>Target<input value={f.target} onChange={field("target")} type="number" step="any" min="0" placeholder="optional" /></label>
          <label>Fees ($, round trip)<input value={f.fees} onChange={field("fees")} type="number" step="any" min="0" placeholder="optional" /></label>
          <label>Note<input value={f.note} onChange={field("note")} placeholder="why you took it" maxLength={500} /></label>
          <input type="hidden" value={f.alertId} readOnly /><input type="hidden" value={f.alphaId} readOnly />
          <div className="actions"><button className="btn" type="submit">Save trade</button><button className="btn" type="button" onClick={reset}>Clear</button></div>
        </form></section></Sec>
      <Sec id="open"><section className="panel" style={{ marginTop: 14 }}><div className="section-head"><div><h2>Open trades</h2><p>Live price and unrealized result. Enter your exit price to close a trade.</p></div>
        <span className="chip">{loaded ? `${open.length} open` : "—"}</span></div>
        <div className="table-wrap"><table className="table cards"><thead><tr><th>Opened</th><th>Coin</th><th>Entry</th><th>Stop · target</th><th>Now</th><th>Result</th><th>Close</th></tr></thead>
          <tbody>{loaded && (open.length ? open.map((x) => {
            const exit = x.livePrice != null ? String(Number(Number(x.livePrice).toPrecision(6))) : "";
            return (
              <tr key={x.id}><td className="mono">{jWhen(x.entryTime)}<span className="sub">{TOOLN[x.tool] || tx(x.tool)}</span></td>
                <td><b>{tx(x.symbol)}</b><SideTag x={x} />{x.note ? <span className="sub">{tx(x.note)}</span> : null}</td>
                <td className="mono">{jPx(x.entryPrice)}<span className="sub">{x.sizeUsd ? jUsd(x.sizeUsd) : "no size"}{x.alert && x.alert.price ? ` · alert ${jPx(x.alert.price)}` : ""}</span></td>
                <td className="mono">{jPx(x.stopPrice)} · {jPx(x.targetPrice)}</td><td className="mono">{jPx(x.livePrice)}</td>
                <td className="mono">{x.result.pnlPct == null ? "—" : <b className={col(x.result.pnlPct)}>{pct(x.result.pnlPct)}</b>}
                  <span className="sub">{x.result.pnlUsd == null ? "" : jUsd(x.result.pnlUsd)}{x.result.r != null ? ` · ${x.result.r}R` : ""}</span></td>
                {/* the exit box starts at the live price, and again whenever the live price changes (the classic redraw) */}
                <td><input key={`${x.id}:${exit}`} ref={(el) => { exitRefs.current[x.id] = el; }} className="jexit" data-id={x.id} type="number" step="any" min="0" placeholder="exit price" defaultValue={exit} style={{ width: 110 }} />{" "}
                  <button className="btn xs" onClick={() => close(x.id)}>Close</button>{" "}<button className="btn xs" title="Delete" onClick={() => del(x.id)}>✕</button></td></tr>);
          }) : <tr><td colSpan={7} className="empty">No open trades. Press &quot;I took it&quot; on an alert, or add one above.</td></tr>)}</tbody></table></div></section></Sec>
      <Sec id="closed"><section className="panel" style={{ marginTop: 14 }}><div className="section-head"><div><h2>Closed trades</h2><p>Your result after fees, next to the alert&apos;s own tracked result (after its standard costs).</p></div>
        <span className="chip">{loaded ? `${done.length} closed` : "—"}</span></div>
        <div className="table-wrap"><table className="table cards"><thead><tr><th>Closed</th><th>Coin</th><th>Entry → exit</th><th>Your result</th><th>R</th><th>Alert&apos;s result</th><th>Note</th><th></th></tr></thead>
          <tbody>{loaded && (done.length ? done.map((x) => {
            const a = x.alert, h = x.result.holdMin;
            return (
              <tr key={x.id}><td className="mono">{jWhen(x.exitTime)}<span className="sub">{TOOLN[x.tool] || tx(x.tool)}{h != null ? ` · held ${h < 120 ? `${h} min` : `${Math.round(h / 60)} h`}` : ""}</span></td>
                <td><b>{tx(x.symbol)}</b><SideTag x={x} /></td>
                <td className="mono">{jPx(x.entryPrice)} → {jPx(x.exitPrice)}</td>
                <td className="mono"><b className={col(x.result.pnlPct)}>{pct(x.result.pnlPct)}</b><span className="sub">{x.result.pnlUsd == null ? "" : jUsd(x.result.pnlUsd)}</span></td>
                <td className="mono">{x.result.r ?? "—"}</td>
                <td className="mono">{a ? <>{a.netPct == null ? <span className="muted">{tx(a.status)}</span> : <span className={col(a.netPct)}>{pct(a.netPct)}</span>}<span className="sub">{tx(a.label)}</span></> : <span className="muted">no alert</span>}</td>
                <td>{tx(x.note)}</td><td><button className="btn xs" title="Delete" onClick={() => del(x.id)}>✕</button></td></tr>);
          }) : <tr><td colSpan={8} className="empty">No closed trades yet.</td></tr>)}</tbody></table></div>
        <div className="changes">{(S.byTool || []).length > 0 && <><b>By tool:</b> {S.byTool.map((t: any) => `${TOOLN[t.tool] || tx(t.tool)} ${t.closed} trades, ${t.winRatePct}% in profit, ${pct(t.avgPnlPct)} average`).join(" · ")}</>}</div></section></Sec>
    </>
  );
}

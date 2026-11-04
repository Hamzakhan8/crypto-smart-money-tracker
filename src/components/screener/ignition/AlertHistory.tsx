"use client";
// Alert history (the classic page's drawHist / histRow): every popup that fired, how it is doing, the AI's review and
// "I took it". Tabs: Strong flow = confirmed and big-move alerts, Heating up = early (first-signal) alerts, Already
// running = price is already half way to the target (or hit it), AI: TAKE = the AI's review of the alert.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useScreener, type AlertEvent, type JournalPrefill } from "../context";
import { useStateTabs } from "../ui";
import { col, pct1, when } from "@/lib/format";
import { cx, tabBar } from "./util";

const HINTS = { strong: "Confirmed ignition and big-move alerts", heating: "Early (first-signal) alerts", running: "Price already half way to the target or past it: too late to enter", take: "The AI's review of this alert said TAKE" };
const runOf = (e: AlertEvent) => {
  const t = e.track; if (!t || !t.entry) return false;
  const r = t.rule || { targetPct: 6 };
  return t.outcome === "win" || (t.last / t.entry - 1) * 100 >= r.targetPct / 2;
};
/** What "I took it" hands to the journal (the classic page's tookIt({...}) call). */
const tookOf = (ev: AlertEvent): JournalPrefill => ({
  tool: ev.tier === "ignition" ? "ignition" : ev.tier === "early" ? "early" : ev.tier === "bigmove" ? "bigmove" : "other",
  symbol: (ev.detail && ev.detail.base) || ev.symbol.replace(/USDT$/, ""),
  price: ev.track && (ev.track.last || ev.track.entry), alertPrice: ev.track && ev.track.entry, alertId: ev.id,
  stop: ev.track && ev.track.rule ? ev.track.entry * (1 - ev.track.rule.stopPct / 100) : null,
  target: ev.track && ev.track.rule ? ev.track.entry * (1 + ev.track.rule.targetPct / 100) : null,
});

function HistRow({ e, version, onOpen, onTook }: { e: AlertEvent; version: any; onOpen: () => void; onTook: () => void }) {
  const t = e.track, c: any = e.detail || {};
  let since = null;
  if (t && t.entry) {
    const now = (t.last / t.entry - 1) * 100, hi = ((t.hiW ?? t.high) / t.entry - 1) * 100, lo = ((t.loW ?? t.low) / t.entry - 1) * 100;
    const oc = t.outcome, ocTxt = oc === "win" ? "WIN" : oc === "loss" ? "LOSS" : oc === "flat" ? "FLAT" : oc === "unclear" ? "UNCLEAR" : "PENDING", ocCls = oc === "win" ? "green" : oc === "loss" ? "red" : "muted";
    since = <span className="track mono"><b className={ocCls}>{ocTxt}</b>{Number.isFinite(t.exitPct) && <>{" "}<b className={cx(col(t.exitPct))}>{pct1(t.exitPct)}</b></>}
      {" · now "}<b className={cx(col(now))}>{pct1(now)}</b> · peak {pct1(hi)} · low {pct1(lo)}{t.hiW != null ? " (in window)" : ""}</span>;
  }
  const tier = e.tier === "ignition" ? [(e.v ?? 0) >= 5 ? "Confirmed" : "Ignition", "strong"] : e.tier === "early" ? [e.aplus ? "Early A+" : "Early", "strong"] : e.tier === "bigmove" ? ["Big move", "strong"] : ["Setup", "watch"];
  const a = e.ai;
  const ai = a && a.decision ? <>{" "}<span className={`badge ${a.decision === "TAKE" ? "strong" : a.decision === "WAIT" ? "watch" : "risk"}`} title={`${a.headline || ""}${a.expectedValuePct != null ? ` · expected ${a.expectedValuePct}% per trade` : ""}`}>AI: {a.decision === "SKIP" ? "NO TRADE" : a.decision}</span>
    {a.telegram && a.telegram !== "sent" ? <>{" "}<span className="badge risk" title={a.telegram}>Telegram failed</span></> : null}</>
    : a && a.error ? <>{" "}<span className="badge risk" title={a.error}>AI error</span></> : null;
  const g = e.gate;
  const gate = g ? <span className={g.pass ? "green" : "muted"} title={`Quality gate: average trade size ${g.ticketSize ?? "?"}x normal (max 1.5x), 24h range ${g.range24 ?? "?"}% (max 13%)`}>{g.pass ? "quality gate passed" : `gate: ${e.quietWhy || "failed"}`}</span> : null;
  const tgNote = e.quiet ? `not sent to Telegram${!e.quality && e.quietWhy && !g ? ` (${e.quietWhy})` : ""}` : "";
  const reasons: string[] = c.reasons || [];
  const took = e.tier !== "setup" && Date.now() - e.time < 2 * 86400000;
  return (
    <div className="event" data-ev={e.id} onClick={onOpen}>
      <div>
        <strong><span className={`badge tier ${tier[1]}`}>{tier[0]}</span>{c.base || e.symbol} · {e.score}/100{ai}{version && e.v !== version ? <span className="badge old">older logic</span> : null}</strong>
        <small>
          {e.quality && <><span className={e.quality.n >= 3 ? "green" : "muted"} title={(e.quality.has || []).join(" · ") || "no quality signs"}>{e.quality.n}/4 quality signs</span> · </>}
          {gate && <>{gate} · </>}
          {tgNote && <><span className="muted">{tgNote}</span>{reasons.length ? " · " : ""}</>}
          {reasons.slice(0, 3).join(" · ")}
        </small>
        {since}
        {took && <button className="btn xs took" data-took={e.id} title="Add this trade to your journal" onClick={(ev) => { ev.stopPropagation(); onTook(); }}>I took it</button>}
      </div>
      <small className="mono">{when(e.time)}</small>
    </div>
  );
}

export function AlertHistory() {
  const { data, openDetail, openJournal } = useScreener();
  const ev = data?.events || [];
  const st = useStateTabs("hist", ev, (e) => ({ strong: e.tier === "ignition" || e.tier === "bigmove", heating: e.tier === "early" || e.tier === "setup", running: runOf(e), take: !!(e.ai && e.ai.decision === "TAKE") }), HINTS);
  const version = data?.stats?.version;
  return (
    <section className="panel"><div className="section-head"><div><h2>Alert history</h2><p>Every popup that fired. Click one to review the setup as it was.</p></div></div>
      {tabBar(st.bar, "Filter alerts", !!data)}
      <div className="events" id="events">
        {!data ? <div className="empty">No alerts yet. A quiet feed is okay.</div>
          : st.rows.length ? st.rows.slice(0, 15).map((e) => <HistRow key={e.id} e={e} version={version}
            onOpen={() => openDetail(e.detail, `Alert as it fired · ${when(e.time)}`)} onTook={() => openJournal(tookOf(e))} />)
            : <div className="empty">{st.empty("No alerts yet. A quiet feed is okay.")}</div>}
      </div>
    </section>
  );
}

"use client";
// Telegram panel (the classic page's drawTg): the delivery status, a switch per kind of message (saved on the server
// with POST /api/telegram/prefs) and the delivery log.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactNode } from "react";
import { useScreener } from "../context";
import { time } from "@/lib/format";
import { join, type TgState } from "./util";

const TG_ORDER = ["ignition", "pump", "bigmove", "alpha", "alphaEarly", "early2x", "perps", "scalp", "scalpBot", "spot", "health", "ai", "system", "rotation", "whales", "flows", "radar"];
const TG_NOTE: Record<string, string> = { ignition: "a few a day", bigmove: "about 30 a day; off by default: lost money live (0 of 14) and in the October replay", pump: "one message a day after the 00:00 UTC close, only when market mood is OK", alpha: "about 8 a day; off by default: lost money live (2 of 15 won)", alphaEarly: "about 50 a day, no proven edge", early2x: "high priority only", perps: "TAKE only: a few a month, after 4h closes", scalp: "about 20 a month, act within minutes", scalpBot: "one per closed paper trade, with the balance", spot: "about 3 a month: BTC or ETH crossing its 50-day average", health: "only when a part has been broken for 30 minutes, and when it works again", ai: "follow-up on each new alert (needs Gemini)",
  system: "so you know it works on quiet days", rotation: "when the regime or holdings change", whales: "big Ethereum transfers", flows: "DEX swaps and rotations", radar: "Market Flow score 75+" };
const TG_STATUS: Record<string, ReactNode> = { sent: <b className="green">sent</b>, retrying: <b className="amber">retrying</b>, expired: <b className="red">expired</b>, dropped: <b className="red">dropped</b>, held: <b className="muted">held back</b> };

export function TelegramPanel({ tg }: { tg: TgState }) {
  const { data } = useScreener();
  const t = tg.t, k: Record<string, any> = t.kinds || {}, res = tg.res;
  // a problem = something waiting with an error, or an error newer than the last message that went out
  const err = t.waitingError || (t.lastError && !(t.lastSentAt > t.lastErrorAt) ? t.lastError : null);
  const chip = !data ? ["—", ""] : !t.configured ? ["not set up", "amber"] : err ? ["problem", "red"] : t.queued ? [`${t.queued} waiting`, "amber"] : t.lastSentAt ? ["working", "green"] : ["ready", ""];
  const log: any[] = t.log || [];
  const parts: ReactNode[] = [t.bot ? <>Bot <b>{t.bot}</b></> : "Bot configured", t.lastSentAt ? `last message ${time(t.lastSentAt)}` : "no message sent yet", `${t.sent || 0} sent since start`,
    t.queued ? <span className="amber">{t.queued} waiting{t.nextRetryAt ? `, next try ${time(t.nextRetryAt)}` : ""}</span> : null, `daily check-in ${String(t.checkinHourUtc ?? 8).padStart(2, "0")}:00 UTC`,
    t.quiet?.text ? <><br /><span className="muted">{t.quiet.text}</span></> : null,
    res ? <>test: <b className={res.ok ? "green" : "red"}>{!res.ok && err && res.text.startsWith(err) ? "not sent yet (reason above), it will keep retrying" : res.text}</b></> : null].filter(Boolean);
  return (
    <section className="panel" style={{ marginTop: 14 }} id="tgPanel">
      <div className="section-head"><div><h2>Telegram notifications</h2><p>Every alert goes through one delivery queue: sent at Telegram&apos;s pace, retried when Telegram or the network fails, kept across restarts, and dropped only when older than 3 hours (a late message says how late). Switch each kind on or off here; the choice is saved.</p></div>
        <span className={`chip${chip[1] ? ` ${chip[1]}` : ""}`} id="tgChip">{chip[0]}</span></div>
      <div className="tgstatus"><div className="grow" id="tgStatus">
        {!data ? "—" : !t.configured ? <span className="amber"><b>Not set up.</b> Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env and restart (README: &quot;Set up Telegram alerts&quot;).</span>
          : <>{err && <><b className="red">Not working: {err}</b><br /></>}{join(parts)}</>}</div>
        <button className="btn sm" id="tgTest2" disabled={(!!data && !t.configured) || tg.sending === "tgTest2"} onClick={() => tg.sendTest("tgTest2")}>{tg.sending === "tgTest2" ? "Sending…" : "Send test message"}</button></div>
      <div className="tgkinds" id="tgKinds">
        {TG_ORDER.filter((x) => k[x]).map((x) => {
          const busy = x in tg.pending;
          return (
            <label key={x} className={k[x].on ? "on" : undefined}>
              <input type="checkbox" data-tgkind={x} checked={busy ? tg.pending[x] : !!k[x].on} disabled={busy} onChange={(e) => tg.setPref(x, e.target.checked)} />
              <span><b>{k[x].label}</b><small>{TG_NOTE[x] || ""}{k[x].on !== k[x].def ? " · changed from the default" : ""}</small></span>
            </label>);
        })}
      </div>
      <div className="subhead2"><div><h2>Delivery log</h2><p>The last messages and what happened to each. &quot;Retrying&quot; = Telegram or the network failed; the queue keeps trying. &quot;Held back&quot; = the app found a signal but its rules kept it off Telegram (the reason is shown).</p></div></div>
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Time</th><th>Kind</th><th>Message</th><th>Status</th><th>Tries</th><th>Delay</th></tr></thead>
        <tbody id="tgLog">
          {data && (log.length ? log.slice(0, 25).map((x, i) => (
            <tr key={`${x.at}-${i}`}><td className="mono">{time(x.at)}</td><td>{(k[x.kind] || {}).label || x.kind}</td>
              <td>{x.title}{x.error ? <span className={`sub ${x.status === "held" ? "muted" : "red"}`}>{x.error}</span> : null}</td>
              <td>{TG_STATUS[x.status] || x.status}</td><td className="mono">{x.tries}</td><td className="mono">{x.delaySec < 60 ? `${x.delaySec} s` : `${Math.round(x.delaySec / 60)} min`}</td></tr>))
            : <tr><td colSpan={6} className="empty">{t.configured ? "Nothing sent yet. Press \"Send test message\" to check the connection." : "Telegram is not set up yet."}</td></tr>)}
        </tbody></table></div>
    </section>
  );
}

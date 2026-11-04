"use client";
// Crowd vs smart money (the old On-chain tab, the classic page's loadOc / drawOc): Binance's crowd long/short account
// ratio against its top traders' position ratio on the 50 most liquid perpetuals, the signals, their backtest and data
// health. Data: GET /api/onchain every 60 seconds.
import { useState } from "react";
import { when } from "@/lib/format";
import { useScreener } from "../context";
import { ErrorBox, Kpi, SourceRow, usePoll } from "../ui";
import { ocPx } from "./fmt";
import type { OcCoin, OcPart, OcSignal, OnchainData } from "./types";

const OC_STATE: Record<string, [string, string]> = {
  crowdShort: ["CROWD SHORT · SMART LONG", "strong"], crowdLong: ["CROWD LONG · SMART NOT", "risk"], leanShort: ["Crowd leans short", "watch"],
  leanLong: ["Crowd leans long", ""], aligned: ["Agree", ""],
};
const OcR = ({ v, good }: { v?: number | null; good: boolean }) => (v == null ? <>—</> : <b className={good ? "green" : undefined}>{v.toFixed(2)}</b>);
const OcPct = ({ v }: { v?: number | null }) => (v == null ? <>—</> : <span className={v > 0 ? "green" : v < 0 ? "red" : undefined}>{v > 0 ? "+" : ""}{v}%</span>);
const pf = (x?: OcPart) => (x && x.n ? `${(x.avg ?? 0) > 0 ? "+" : ""}${x.avg}%` : "—");

function OcRow({ c, rule }: { c: OcCoin; rule: OnchainData["rule"] }) {
  const st = OC_STATE[c.state || ""] || ["no data", ""];
  const acc = c.acc, top = c.top;
  return (
    <tr>
      <td><b>{c.base}</b><span className="sub mono">{ocPx(c.price)}</span></td>
      <td className="mono"><OcR v={acc} good={acc != null && acc <= (rule?.crowdShortMax ?? 0.7)} />
        <span className="sub">{acc == null ? "" : acc < 1 ? `${Math.round(100 / (1 + acc))}% of accounts short` : `${Math.round((100 * acc) / (1 + acc))}% of accounts long`}{c.accPct30d != null ? ` · above ${c.accPct30d}% of its last 30 days` : ""}</span></td>
      <td className="mono"><OcR v={top} good={top != null && top >= (rule?.smartLongMin ?? 1)} />
        <span className="sub">{top == null ? "" : top >= 1 ? "top traders net long" : "top traders net short"}</span></td>
      <td className="mono"><b>{c.gap ?? "—"}</b></td>
      <td>{st[1] ? <span className={`badge ${st[1]}`}>{st[0]}</span> : <span className="muted">{st[0]}</span>}</td>
      <td className="mono"><OcPct v={c.change24h} /><span className="sub">OI <OcPct v={c.oiChg3d} /></span></td>
      <td>{c.higherLows ? <span className="green">higher lows</span> : c.lowerHighs ? <span className="red">lower highs</span> : <span className="muted">mixed</span>}</td>
    </tr>
  );
}

function OcSig({ s }: { s: OcSignal }) {
  const long = s.side > 0, done = s.status === "closed";
  const res = done
    ? (s.netPct == null ? <span className="muted">{s.why || "closed"}</span>
      : <><b className={s.netPct > 0 ? "green" : "red"}>{s.netPct > 0 ? "+" : ""}{s.netPct}%</b><span className="sub">{s.why === "target" ? "hit the target" : s.why === "stop" ? "hit the stop" : "closed on time"}</span></>)
    : s.entry ? <><span className="muted">open · now <OcPct v={+((long ? Number(s.price) / s.entry - 1 : 1 - Number(s.price) / s.entry) * 100).toFixed(2)} /></span><span className="sub">peak {s.peakPct ?? 0}% · low {s.lowPct ?? 0}%</span></>
    : <span className="muted">entry at the next 4h open</span>;
  return (
    <tr>
      <td><span className={`side ${long ? "long" : "short"}`}>{long ? "LONG" : "SHORT"}</span> <b>{s.base}</b></td>
      <td className="muted" style={{ fontSize: 12 }}>{long ? "crowd short" : "crowd long"}: accounts {s.acc} · top traders {s.top} (gap {s.gap}){long ? (s.higherLows ? " · higher lows" : "") : " · lower highs"}</td>
      <td className="mono">{ocPx(s.entry ?? s.ref)}<span className="sub">stop {ocPx(s.stop)}{s.target ? ` · target ${ocPx(s.target)}` : ""} · risk {s.riskPct}% · close by {when(s.closeBy)}</span></td>
      <td>{res}</td>
      <td className="mono">{when(s.at)}</td>
    </tr>
  );
}

export function OnChain() {
  const { show } = useScreener();
  const { data: d, error } = usePoll<OnchainData>("/api/onchain", 60_000);
  const [filter, setFilter] = useState("all");

  const cs = d?.coins || [], r = d?.rule || {}, rec = d?.record || {}, R = d?.report;
  const rows = cs.filter((c) => filter === "all" || (filter === "lean" ? c.state === "leanShort" || c.state === "crowdShort" : c.state === filter));
  const sg = d?.signals || [];
  const err = error ? `On-chain: ${error}`
    : d?.error ? `On-chain: ${d.error}${/451|403/.test(d.error) ? " (Binance futures is blocked on this connection: it works from most home connections)" : ""}` : null;
  const kCount = (state: string) => (d ? cs.filter((c) => c.state === state).length || (cs.length ? 0 : "—") : "—");

  return (
    <div id="ocBlock">
      {show("crowd") && <details className="notice" style={{ marginTop: 14 }}><summary><b>Read this first:</b> this tab follows one idea from @ArslanOnChain&apos;s posts: when most traders bet against a coin while the biggest traders are on the other side, the crowd is often wrong. Signals only; the app never places orders.</summary><div><b>The two numbers</b> (Binance&apos;s own futures data, every 4 hours): <b>Crowd</b> = the long/short <i>account</i> ratio of everyone with a position (0.5 = two accounts short for every one long). <b>Smart money</b> = the long/short <i>position</i> ratio of Binance&apos;s top traders (the top 20% of accounts by margin; above 1 = more money long than short). His example: crowd 0.397, top traders 1.31, so the crowd was heavily short while the big money was long. <b>The signals</b>, checked after every 4-hour close on the 50 most liquid perpetuals: <span id="ocRuleTxt">{r.crowdShortMax != null
        ? <><b>LONG</b> when the crowd is at {r.crowdShortMax} or less and top traders at {r.smartLongMin} or more (his example). <b>SHORT</b> (the mirror) when the crowd&apos;s ratio is in the top {100 - (r.crowdLongPct ?? 0)}% of its own last 30 days, top traders are at {r.smartShortMax} or less and price makes lower highs</>
        : <><b>LONG</b> when the crowd is at 0.5 or less and top traders at 1.2 or more (his example). <b>SHORT</b> (the mirror) when the crowd&apos;s ratio is in the top 10% of its own last 30 days, top traders are not long (1.0 or less) and price makes lower highs</>}</span>. Each is followed with the tested exit: a stop 2x the coin&apos;s normal 4-hour range (ATR), no target, close after 3 days. <b>Honest note:</b> he has not published a full method, so these exact numbers are ours. The Backtest section shows how they did on 4.8 years of Binance&apos;s archive. This is positioning data from Binance, not wallet tracking. For wallets and exchange flows, see the Whales tab. Research, not financial advice.</div></details>}
      <ErrorBox>{err}</ErrorBox>
      {show("crowd") && <>
        <div className="kpis" style={{ marginTop: 14 }}>
          <Kpi label="Crowd short, smart money long" value={kCount("crowdShort")} hint="coins right now (the signal)" cls="green" />
          <Kpi label="Crowd long, smart money not" value={kCount("crowdLong")} hint="coins right now (the mirror)" cls="red" />
          <Kpi label="Open signals" value={d?.open ?? "—"} hint="followed to their exit" />
          <Kpi label="Live record" value={rec.n ? `${(rec.avgPct ?? 0) > 0 ? "+" : ""}${rec.avgPct}%` : "—"} cls={rec.n ? ((rec.avgPct ?? 0) > 0 ? "green" : "red") : undefined}
            hint={!d ? "closed signals, after fees" : rec.n ? `${rec.n} closed · win ${rec.winPct}% · avg per trade after fees` : "no closed signal yet"} />
        </div>
        <section className="panel">
          <div className="section-head"><div><h2>Crowd vs smart money now</h2><p>The 50 most liquid Binance perpetuals, the biggest gap between top traders and the crowd first. Gap = smart money ratio ÷ crowd ratio (above 1 = the big money is more bullish than the crowd).</p></div>
            <div className="filters"><select id="ocFilter" aria-label="Which coins" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All coins</option><option value="crowdShort">Crowd short, smart long</option><option value="lean">Crowd leans short</option><option value="crowdLong">Crowd long, smart money not</option></select>
              <span className="chip" id="ocChip">{d?.updatedAt ? `${cs.length} coins · updated ${new Date(d.updatedAt).toLocaleTimeString()}` : "—"}</span></div></div>
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Coin</th><th>Crowd (accounts L/S)</th><th>Smart money (top traders L/S)</th><th>Gap</th><th>Reading</th><th>Price 24h · OI 3d</th><th>Structure</th></tr></thead><tbody id="ocCoins">
            {!d ? <tr><td colSpan={7} className="empty">Loading…</td></tr>
              : rows.length ? rows.map((c, i) => <OcRow key={`${c.sym || c.base}-${i}`} c={c} rule={d.rule} />)
              : <tr><td colSpan={7} className="empty">{d.status === "starting" ? "First scan in a moment (about a minute)…" : d.status === "off" ? d.error || "off" : cs.length ? "No coin in this view." : "No data yet."}</td></tr>}
          </tbody></table></div>
        </section>
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="section-head"><div><h2>Crowd vs smart money: signals</h2><p>Every time a coin&apos;s 4-hour close showed the setup. Entry = the next 4h open; each signal is followed to its stop or its 3-day close.</p></div><span className="chip" id="ocSigChip">{d ? `${sg.length} signals` : "—"}</span></div>
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Signal</th><th>Why</th><th>Entry · stop</th><th>Result</th><th>When</th></tr></thead><tbody id="ocSignals">
            {!d ? <tr><td colSpan={5} className="empty">Loading…</td></tr>
              : sg.length ? sg.slice(0, 40).map((s, i) => <OcSig key={`${s.base}-${s.at}-${i}`} s={s} />)
              : <tr><td colSpan={5} className="empty">No signal yet. The setup is rare: it is checked after every 4-hour close (00, 04, 08, 12, 16, 20 UTC).</td></tr>}
          </tbody></table></div>
        </section>
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="section-head"><div><h2>Crowd vs smart money: backtest</h2><p id="ocTestedSub">{R
            ? `Binance's archive ${R.from} to ${R.to}, the ${R.top || 50} most liquid perpetuals of each month (${R.coins} coins, delisted ones included), entry at the next 4h open, stop ${R.exit?.stopAtr ?? 2} ATR, close after ${Math.round((R.exit?.holdBars ?? 18) / 6)} days, ${R.costPct}% fees in and out (funding not counted). Older = before ${R.split}, newer = from then on. A rule holds only if it made money in both periods and beat random trades.`
            : "Binance's archive, the 50 most liquid perpetuals of each month (delisted coins included), entry at the next 4h open, 0.16% fees in and out. A rule \"holds\" only if it made money in both periods."}</p></div></div>
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Rule</th><th>Signals</th><th>Win</th><th>Avg per trade</th><th>Before 2025 · 2025-26</th><th>Other exit (2R, 7 days)</th><th>Verdict</th></tr></thead><tbody id="ocTested">
            {R ? (R.rules || []).map((x, i) => (
              <tr key={`${x.label}-${i}`} className={x.live || x.note ? undefined : "faded"}>
                <td><b>{x.label}</b>{x.live ? <span className="sub green">used live</span> : x.note ? <span className="sub">{x.note}</span> : null}</td>
                <td className="mono">{x.all.n}</td><td className="mono">{x.all.win}%</td>
                <td className={`mono ${(x.all.avg ?? 0) > 0 ? "green" : "red"}`}>{pf(x.all)}</td>
                <td className="mono">{pf(x.older)} · {pf(x.newer)}</td>
                <td className="mono">{pf(x.swing?.older)} · {pf(x.swing?.newer)}</td>
                <td>{x.verdict}</td>
              </tr>)) : <tr><td colSpan={7} className="empty">—</td></tr>}
          </tbody></table></div>
          <p className="muted" id="ocTestedNote" style={{ fontSize: 12, margin: "10px 2px 0" }}>{R ? R.note || "" : ""}</p>
        </section>
      </>}
      {show("health") && <section className="panel" style={{ marginTop: 14 }}><div className="section-head"><div><h2>Data health: crowd vs smart money</h2><p>Binance USDⓈ-M futures public data, no API key. Some countries and networks block it (error 451).</p></div></div>
        <div className="source-list" id="ocHealth">{d && <>
          <SourceRow label="Binance futures (ratios, candles, open interest)" cls={d.status === "ok" && !d.error ? "green" : "amber"} wrap>
            {d.status === "ok" && !d.error ? `ok · scan took ${((d.scanMs || 0) / 1000).toFixed(0)}s` : d.error || d.status || "—"}</SourceRow>
          <SourceRow label="Next scan">{d.nextScanAt ? new Date(d.nextScanAt).toLocaleTimeString() : "—"}</SourceRow>
        </>}</div></section>}
    </div>
  );
}

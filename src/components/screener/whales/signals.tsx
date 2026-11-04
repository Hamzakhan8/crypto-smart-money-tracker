"use client";
// Whale signals (the classic page's loadWs / drawWs): TAKE LONG, TAKE SHORT or LEAVE per coin from the positions of
// Hyperliquid's biggest profitable wallets, the calls and their results, the followed whales and their data health.
// Data: GET /api/whalesig every 30 seconds.
import { Fragment, useState } from "react";
import { when } from "@/lib/format";
import { useScreener } from "../context";
import { ErrorBox, Kpi, SafeLink, SourceRow, usePoll } from "../ui";
import { wsUsd } from "./fmt";
import type { WhaleSig, WsSignal } from "./types";

const CALLS = ["TAKE LONG", "TAKE SHORT", "LEAVE"] as const;
const WSC: Record<string, string> = { "TAKE LONG": "green", "TAKE SHORT": "red", LEAVE: "amber" };
const WsCall = ({ c }: { c: string }) => (c === "WATCH" ? <span className="muted">watch</span> : <span className={`badge ${WSC[c] ?? ""}`}>{c}</span>);
const WsAfter = ({ s, h }: { s: WsSignal; h: number }) => {
  const a = (s.after || {})[h];
  return a ? <span className={a.right ? "green" : "red"}>{a.pct > 0 ? "+" : ""}{a.pct}%</span> : <span className="muted">—</span>;
};
const signCls = (v: number) => (v > 0 ? "green" : v < 0 ? "red" : undefined);
const Lines = ({ xs }: { xs: string[] }) => <>{xs.map((x, i) => <Fragment key={i}>{i ? <br /> : null}{x}</Fragment>)}</>;

export function WhaleSignals() {
  const { show } = useScreener();
  const { data: d, error } = usePoll<WhaleSig>("/api/whalesig", 30_000);
  const [filter, setFilter] = useState("calls");
  const [q, setQ] = useState("");

  const cs = d?.coins || [];
  const n = (k: string) => cs.filter((c) => c.call === k).length;
  const rec = d?.record || {};
  const day = CALLS.map((k) => (rec[k] || {})[24]).filter((x): x is NonNullable<typeof x> => !!x && !!x.n);
  const tot = day.reduce((a, x) => a + x.n, 0), right = day.reduce((a, x) => a + (x.n * x.rightPct) / 100, 0);
  const qq = q.trim().toUpperCase();
  const rows = cs.filter((c) => (filter === "all" || (filter === "calls" ? c.call !== "WATCH" : filter === "long" ? c.score > 0 : c.score < 0))
    && (!qq || c.base.includes(qq) || c.coin.toUpperCase().includes(qq)));
  const sg = d?.signals || [];
  const wl = d?.whaleList || [];
  const err = error ? `Whale signals: ${error}` : d?.error ? `Whale signals: ${d.error}` : null;

  return (
    <>
      {show("signals") && <details className="notice"><summary><b>Whale signals, read this first:</b> TAKE LONG, TAKE SHORT or LEAVE from what big wallets do on-chain, scored from -100 (whales selling) to +100 (whales buying). <b>New and not backtested</b>: the live record below is its only test.</summary><div><b>Sources</b> (free, no API key): <b>Hyperliquid</b>, an on-chain futures exchange where every wallet&apos;s open positions are public: the largest profitable accounts on its leaderboard (account $1M+, in profit all-time and over the last 30 days, market makers left out) are read every 2 minutes. <b>Ethereum</b> exchange deposits and withdrawals (the whale tracker below), <b>DEX</b> buying and selling, and Binance&apos;s <b>crowd vs top traders</b>. <b>Score:</b> the whales&apos; long/short balance (up to ±60, needs 5+ whales and $2M+ in the coin), what they opened or closed in the last hour, counted in coins so a price move alone does not count (±20, at least $500k), Ethereum exchange flow over 24h (±10, $1M+), DEX flow over 24h (±5, $250k+ by 5+ wallets), Binance crowd short and top traders long or the mirror (±10). <b>Calls:</b> <b className="green">TAKE LONG</b> = score 60+ and the whales added longs in the last hour; <b className="red">TAKE SHORT</b> = -60 or less and they added shorts (futures only); <b className="amber">LEAVE</b> = the whales cut 30%+ of their net long in the last hour, or $5M+ of an ERC-20 token went onto exchanges in 24h: sell, or do not buy. <b>Honest notes:</b> Hyperliquid shows positions now, not a history of them, so this could not be backtested. Many whales hedge (for example long BTC and short altcoins), so a short on one coin is not always a view on that coin. Following the wallets that did best so far also means following some that were lucky. Research, not financial advice.</div></details>}
      <ErrorBox>{err}</ErrorBox>
      {show("signals") && <>
        <div className="kpis">
          <Kpi label="TAKE LONG now" value={cs.length ? n("TAKE LONG") : "—"} hint="whales long and adding" cls="green" />
          <Kpi label="TAKE SHORT now" value={cs.length ? n("TAKE SHORT") : "—"} hint="whales short and adding" cls="red" />
          <Kpi label="LEAVE now" value={cs.length ? n("LEAVE") : "—"} hint="whales cutting longs, or coins going to exchanges" cls="amber" />
          <Kpi label="Live record" value={tot ? `${Math.round((right / tot) * 100)}%` : "—"}
            hint={!d ? "calls that went the called way after 24h" : tot ? `${tot} calls followed for 24h went the called way` : "no call followed for 24h yet"} />
        </div>
        <section className="panel">
          <div className="section-head"><div><h2>Whale signals now</h2><p>Every coin the followed whales hold on Hyperliquid, the strongest reading first. Last hour = what they opened minus what they closed, in dollars at today&apos;s price.</p></div>
            <div className="filters">
              <select id="wsFilter" aria-label="Which coins" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="calls">Calls only (TAKE / LEAVE)</option><option value="all">All coins</option><option value="long">Whales net long</option><option value="short">Whales net short</option></select>
              <input id="wsQ" placeholder="Coin" aria-label="Find a coin" style={{ width: 90 }} value={q} onChange={(e) => setQ(e.target.value)} />
              <span className="chip" id="wsChip">{d?.updatedAt ? `${cs.length} coins · ${d.read}/${d.whales} whales read · ${new Date(d.updatedAt).toLocaleTimeString()}` : "—"}</span>
            </div></div>
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Coin</th><th>Call</th><th>Score</th><th>Whales long · short</th><th>Last hour</th><th>Why</th></tr></thead><tbody id="wsCoins">
            {!d ? <tr><td colSpan={6} className="empty">Loading…</td></tr>
              : rows.length ? rows.map((c) => (
                <tr key={c.coin}>
                  <td><b>{c.base}</b><span className="sub mono">{c.px ?? "—"}{c.coin !== c.base ? ` · Hyperliquid ${c.coin}` : ""}</span></td>
                  <td><WsCall c={c.call} /></td>
                  <td className="mono"><b className={signCls(c.score)}>{c.score > 0 ? "+" : ""}{c.score}</b></td>
                  <td className="mono"><span className="green">{wsUsd(c.longUsd)}</span> · <span className="red">{wsUsd(c.shortUsd)}</span><span className="sub">{c.nLong} long · {c.nShort} short</span></td>
                  <td className="mono">{c.flowUsd == null ? <span className="muted">—</span> : <span className={signCls(c.flowUsd)}>{c.flowUsd > 0 ? "+" : ""}{wsUsd(c.flowUsd)}</span>}
                    <span className="sub">{c.flowUsd == null ? "needs an hour of data" : c.flowUsd > 0 ? "net long added" : c.flowUsd < 0 ? "net short added" : "no change"}</span></td>
                  <td className="muted" style={{ fontSize: 12 }}><Lines xs={c.why || []} /></td>
                </tr>))
              : <tr><td colSpan={6} className="empty">{d.status === "starting" ? "Reading the whales (about 30 seconds)…" : d.status === "off" ? d.error || "off"
                : filter === "calls" && cs.length ? "No TAKE / LEAVE call right now. A call needs an hour of history (what the whales added) and a strong reading. Pick All coins to see every reading." : "No coin in this view."}</td></tr>}
          </tbody></table></div>
        </section>
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="section-head"><div><h2>Calls and their results</h2><p>Every TAKE / LEAVE call (one per coin and kind every 12 hours) and the price 4 hours, 24 hours and 3 days later. A call is right when the price moved the called way (LEAVE: the price fell).</p></div><span className="chip" id="wsSigChip">{d ? `${sg.length} calls` : "—"}</span></div>
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Call</th><th>After 4h</th><th>After 24h</th><th>After 3 days</th></tr></thead><tbody id="wsRecord">
            {!d ? <tr><td colSpan={4} className="empty">—</td></tr> : CALLS.map((k) => {
              const r = rec[k] || {};
              const cell = (h: number) => {
                const x = r[h];
                return x && x.n ? <><b className={x.rightPct >= 50 ? "green" : "red"}>{x.rightPct}% right</b><span className="sub">{x.n} calls · avg {x.avgPct > 0 ? "+" : ""}{x.avgPct}% the called way</span></> : <span className="muted">no call yet</span>;
              };
              return <tr key={k}><td><WsCall c={k} /></td><td>{cell(4)}</td><td>{cell(24)}</td><td>{cell(72)}</td></tr>;
            })}
          </tbody></table></div>
          <div className="table-wrap" style={{ marginTop: 10 }}><table className="table cards"><thead><tr><th>Call</th><th>Why</th><th>Price then</th><th>4h · 24h · 3 days</th><th>When</th></tr></thead><tbody id="wsSignals">
            {!d ? <tr><td colSpan={5} className="empty">Loading…</td></tr>
              : sg.length ? sg.slice(0, 40).map((s, i) => (
                <tr key={`${s.base}-${s.call}-${s.t}-${i}`}>
                  <td><WsCall c={s.call} /> <b>{s.base}</b><span className="sub">score {s.score > 0 ? "+" : ""}{s.score}</span></td>
                  <td className="muted" style={{ fontSize: 12 }}><Lines xs={(s.why || []).slice(0, 3)} /></td>
                  <td className="mono">{s.px ?? "—"}</td>
                  <td className="mono"><WsAfter s={s} h={4} /> · <WsAfter s={s} h={24} /> · <WsAfter s={s} h={72} /></td>
                  <td className="mono">{when(s.t)}</td>
                </tr>))
              : <tr><td colSpan={5} className="empty">No call yet. Calls start once the tab has an hour of whale positions to compare.</td></tr>}
          </tbody></table></div>
        </section>
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="section-head"><div><h2>Followed whales</h2><p>The largest profitable Hyperliquid accounts, best all-time profit first (the top 25 of those followed). Open a wallet to see its positions on Hyperliquid.</p></div><span className="chip" id="wsWhChip">{d?.whales ? `${d.whales} followed` : "—"}</span></div>
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Wallet</th><th>Account</th><th>Profit all-time · 30 days</th><th>Open positions</th></tr></thead><tbody id="wsWhales">
            {d && wl.length ? wl.map((w) => (
              <tr key={w.address}>
                <td><SafeLink className="mono" url={`https://app.hyperliquid.xyz/explorer/address/${encodeURIComponent(w.address)}`}>{w.name || `${w.address.slice(0, 8)}…${w.address.slice(-4)}`}</SafeLink></td>
                <td className="mono">{wsUsd(w.account)}</td>
                <td className="mono"><span className="green">{wsUsd(w.pnlAll)}</span> · {wsUsd(w.pnlMonth)}<span className="sub">{w.roiMonth}% in 30 days</span></td>
                <td className="mono">{w.positions ?? "—"}<span className="sub">{w.notional != null ? `${wsUsd(w.notional)} open` : ""}</span></td>
              </tr>))
              : <tr><td colSpan={4} className="empty">{d ? "Loading the Hyperliquid leaderboard (about 40 MB, once every 6 hours)…" : "Loading…"}</td></tr>}
          </tbody></table></div>
        </section>
      </>}
      {show("health") && <section className="panel" style={{ marginTop: 14 }}><div className="section-head"><div><h2>Data health: whale signals</h2><p>Hyperliquid&apos;s public API (no key): the leaderboard every 6 hours, positions every 2 minutes.</p></div></div>
        <div className="source-list" id="wsHealth">{d && <>
          <SourceRow label="Hyperliquid positions" cls={d.status === "ok" && !d.error ? "green" : "amber"} wrap>
            {d.status === "ok" && !d.error ? `ok · ${d.read}/${d.whales} whales · read in ${((d.scanMs || 0) / 1000).toFixed(0)}s` : d.error || d.status || "—"}</SourceRow>
          <SourceRow label="Whale list (leaderboard)">{d.whalesAt ? `updated ${when(d.whalesAt)}` : "—"}</SourceRow>
          <SourceRow label="Hour of history for calls" cls={d.hourAgo ? "green" : "amber"}>{d.hourAgo ? "ready" : `building (${d.snapshots || 0} reads so far)`}</SourceRow>
        </>}</div></section>}
    </>
  );
}

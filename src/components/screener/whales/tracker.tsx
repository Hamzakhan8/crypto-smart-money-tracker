"use client";
// The Ethereum whale tracker and DEX flows (the classic page's loadW, drawWh, drawShared, rpcTable): the watchlist
// (POST /api/whales/watch, /api/whales/unwatch), the address lookup, whale transfers, exchange flows, entities, the DEX
// part (dex.tsx), the alert history and data health. Data: GET /api/whales?window= and /api/flows?window= every 6 s
// while the tab is open, and at once when a time window changes. The popups are shown by the screener page itself.
import { Fragment, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getJson, postJson } from "@/lib/api";
import { when } from "@/lib/format";
import { useScreener } from "../context";
import { ErrorBox, Kpi } from "../ui";
import { AddrContext, CatTag, PartyBtn, WLink } from "./address";
import { Dex } from "./dex";
import { cx, KINDS, S, snet, wago, wamt, wclock, wshort, wusd, WTYPES } from "./fmt";
import type { FlowsData, Network, RpcNode, WhalesData } from "./types";

/** Net into an entity or wallet: green = more received. */
const inCls = (v: number) => (v > 0 ? "green" : v < 0 ? "red" : "");
/** Net onto an exchange: red = more deposited. */
const exCls = (v: number) => (v > 0 ? "red" : v < 0 ? "green" : "");

/** The tracker data: both endpoints every 6 s, both time windows, the networks of the first DEX answer. */
export function useTracker() {
  const [wd, setWd] = useState<WhalesData>({});
  const [fd, setFd] = useState<FlowsData>({});
  const [fetchErrs, setFetchErrs] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [nets, setNets] = useState<Network[] | null>(null); // the network choices, filled once (as the classic page)
  const [whWin, setWhWinState] = useState("1h"), [wWin, setWWinState] = useState("1h");
  const win = useRef({ whWin: "1h", wWin: "1h" });
  const seq = useRef(0), applied = useRef(0), live = useRef(true);

  const load = useCallback(async () => {
    const my = ++seq.current, asked = { ...win.current };
    const [a, b] = await Promise.allSettled([
      getJson<WhalesData>("/api/whales?window=" + encodeURIComponent(asked.whWin)),
      getJson<FlowsData>("/api/flows?window=" + encodeURIComponent(asked.wWin)),
    ]);
    // drop an answer that is older than one already shown, or that is for a time window no longer chosen
    if (!live.current || my < applied.current || asked.whWin !== win.current.whWin || asked.wWin !== win.current.wWin) return;
    applied.current = my;
    const errs: string[] = [];
    if (a.status === "fulfilled") setWd(a.value); else errs.push("Whale data: " + (a.reason as Error).message);
    if (b.status === "fulfilled") {
      const f = b.value;
      setFd(f);
      if (!f.disabled && f.networks) setNets((n) => n ?? f.networks ?? null);
    } else errs.push("DEX data: " + (b.reason as Error).message);
    setFetchErrs(errs); setLoaded(true);
  }, []);
  useEffect(() => {
    live.current = true;
    load();
    const t = setInterval(load, 6000);
    return () => { live.current = false; clearInterval(t); };
  }, [load]);
  const setWhWin = useCallback((v: string) => { setWhWinState(v); win.current.whWin = v; load(); }, [load]);
  const setWWin = useCallback((v: string) => { setWWinState(v); win.current.wWin = v; load(); }, [load]);
  return { wd, fd, fetchErrs, loaded, nets, load, whWin, setWhWin, wWin, setWWin };
}
export type TrackerState = ReturnType<typeof useTracker>;

export function Tracker({ tr }: { tr: TrackerState }) {
  const { show } = useScreener();
  const openAddr = useContext(AddrContext);
  const { wd: d, fd, loaded, load } = tr;
  // transfer filters
  const [kind, setKind] = useState(""), [minSel, setMinSel] = useState("1000000"), [qRaw, setQ] = useState("");
  const [stable, setStable] = useState(true), [internal, setInternal] = useState(false), [plumb, setPlumb] = useState(false);
  // the watch form and the address lookup
  const [target, setTarget] = useState(""), [label, setLabel] = useState(""), [wmin, setWmin] = useState("100000"), [err, setErr] = useState("");
  const [lookup, setLookup] = useState("");

  const on = loaded && !d.disabled, dexOn = loaded && !fd.disabled; // the classic page draws nothing while a tracker is switched off
  const t = d.totals || {}, ch = d.chain || {};
  const q = qRaw.trim().toUpperCase(), kinds = kind ? kind.split(",") : null, min = Number(minSel) || 0;
  const rows = (d.transfers || []).filter((r) => r.usd >= min && (stable || !r.stable) && (internal || r.kind !== "internal") && (plumb || !r.plumbing)
    && (!kinds || kinds.includes(r.kind))
    && (!q || S(r.symbol).includes(q) || S(r.from.name).includes(q) || S(r.to.name).includes(q) || S(r.from.entity).includes(q) || S(r.to.entity).includes(q)));

  const watch = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try { await postJson("/api/whales/watch", { target, name: label, minUsd: Number(wmin) || 0 }); setTarget(""); setLabel(""); load(); }
    catch (x) { setErr((x as Error).message); }
  };
  const unwatch = async (id: string) => {
    try { await postJson("/api/whales/unwatch", { id }); load(); } catch (x) { setErr((x as Error).message); }
  };
  const look = (e: React.FormEvent) => {
    e.preventDefault();
    const a = lookup.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { alert("Enter a full Ethereum address (0x followed by 40 characters)."); return; }
    openAddr(a.toLowerCase());
  };

  // errors, alert history and data health (drawShared): drawn after every load
  const errs = loaded ? [...tr.fetchErrs, ...Object.entries(d.errors || {}).map(([k, v]) => `${k}: ${v}`), ...Object.entries(fd.errors || {}).map(([k, v]) => `DEX ${k}: ${v}`)] : [];
  if (loaded && d.disabled) errs.unshift("Whale tracker is switched off (SCREENER_WHALES=0).");
  const events = [...(d.events || []), ...(fd.events || [])].sort((x, y) => y.time - x.time).slice(0, 30);

  return (
    <>
      {show("transfers") && <details className="notice" style={{ marginTop: 14 }}><summary><b>How to read this:</b> every Ethereum transfer above the minimum, read straight from the blockchain, with who sent it and who received it. Names come from ~10,000 public labels (exchanges, funds, issuers, bridges; a June 2023 snapshot), from Blockscout for newer contracts, Safe multisigs and ENS names, from exchange addresses the tracker learns by itself, and from your own labels.</summary><div>Exchange addresses are learned the way Arkham does it: an unlabelled address that hands its tokens to one exchange&apos;s wallet is that exchange&apos;s deposit address, so later deposits into it count at once (shown as &quot;address (learned)&quot;). Unlabelled does not mean unknown to everyone: open any address on Arkham for its full profile. Exchange deposits are often made to sell, but not always. Not financial advice.</div></details>}
      <ErrorBox>{errs.length ? errs.map((x, i) => <Fragment key={i}>{i ? <br /> : null}{x}</Fragment>) : null}</ErrorBox>
      {show("watch") && <div className="watchrow">
        <section className="panel">
          <div className="section-head"><div><h2>Watchlist</h2><p>Alert on any move by a wallet (give it your own label, it shows everywhere) or any large transfer of a token.</p></div></div>
          <form className="watchbar" id="whForm" onSubmit={watch}>
            <input name="target" placeholder="0x… wallet / token, or PEPE" aria-label="Wallet address, token address or token symbol" required style={{ width: 260 }} value={target} onChange={(e) => setTarget(e.target.value)} />
            <input name="name" placeholder="Your label (optional)" aria-label="Label" style={{ width: 160 }} value={label} onChange={(e) => setLabel(e.target.value)} />
            <input name="min" type="number" min="0" step="10000" aria-label="Minimum value in USD" title="Minimum value in USD" value={wmin} onChange={(e) => setWmin(e.target.value)} />
            <button className="btn" type="submit">Watch</button>
            <span className="red" id="whFormErr" style={{ fontSize: 12 }}>{err}</span>
          </form>
          <div className="watches" id="whWatches">{on && ((d.watches || []).length ? (d.watches || []).map((w) => (
            <span className="wchip" key={w.id}>{w.kind === "wallet" ? w.name || wshort(w.address) : w.symbol} <small>{w.kind === "wallet" ? `wallet ${wshort(w.address)}` : "token"} · from {wusd(w.minUsd)}</small>
              <button type="button" title="Stop watching" data-whunwatch={w.id} onClick={() => unwatch(w.id)}>×</button></span>))
            : <span className="muted" style={{ fontSize: 12 }}>Nothing watched yet. Paste a wallet (e.g. a fund you follow) or a token.</span>)}</div>
        </section>
        <section className="panel">
          <div className="section-head"><div><h2>Look up an address</h2><p>Label, recent transfers and top counterparties seen by the tracker.</p></div></div>
          <form className="watchbar" id="whLookup" onSubmit={look}><input name="a" placeholder="0x…" aria-label="Ethereum address" required style={{ flex: 1, minWidth: 180 }} value={lookup} onChange={(e) => setLookup(e.target.value)} /><button className="btn" type="submit">Look up</button></form>
        </section>
      </div>}
      {show("transfers") && <>
        <div className="kpis">
          <Kpi label="Whale transfers" value={on ? t.transfers ?? "—" : "—"} hint={on ? `${d.demo ? "SIMULATED · " : ""}${wusd(t.usd)} moved, transfers over ${wusd(d.config?.minUsd)}` : "—"} />
          <Kpi label="Deposited to exchanges" value={on ? wusd(t.deposits) : "—"} hint="non-stablecoin, possible selling" cls="red" />
          <Kpi label="Withdrawn from exchanges" value={on ? wusd(t.withdrawals) : "—"} hint="non-stablecoin, moved off exchanges" cls="green" />
          <Kpi label="Ethereum" value={on && ch.lastBlock ? `#${ch.lastBlock.toLocaleString()}` : "—"}
            hint={!on ? "—" : d.status === "connected" ? (ch.lagSec != null ? `latest block ${ch.lagSec}s ago` : "live") : d.status === "demo" ? "demo data" : d.status === "error" ? "RPC error, retrying" : "connecting…"} />
        </div>
        <section className="panel">
          <div className="section-head">
            <div><h2>Live whale transfers</h2><p>Newest first. Click any sender or receiver for its profile.</p></div>
            <div className="filters">
              <select id="whWin" aria-label="Time window" value={tr.whWin} onChange={(e) => tr.setWhWin(e.target.value)}><option value="1h">Last hour</option><option value="24h">Last 24 hours</option></select>
              <select id="whKind" aria-label="Transfer type" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option><option value="deposit">Exchange deposits</option><option value="withdrawal">Exchange withdrawals</option><option value="exchange_to_exchange">Exchange to exchange</option><option value="mint,burn,issuer">Mint, burn, issuer</option><option value="transfer">Wallet to wallet</option><option value="defi,bridge">DeFi and bridges</option><option value="contract">Wallet ↔ contract</option><option value="dex">DEX</option></select>
              <select id="whMin" aria-label="Minimum value" value={minSel} onChange={(e) => setMinSel(e.target.value)}><option value="0">Any size</option><option value="500000">$500k+</option><option value="1000000">$1M+</option><option value="10000000">$10M+</option></select>
              <input id="whQ" placeholder="Token or name, e.g. PEPE, Binance" aria-label="Filter by token or name" value={qRaw} onChange={(e) => setQ(e.target.value)} />
              <label className="wcheck"><input type="checkbox" id="whStable" checked={stable} onChange={(e) => setStable(e.target.checked)} /> stablecoins</label>
              <label className="wcheck"><input type="checkbox" id="whInternal" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> internal exchange moves</label>
              <label className="wcheck" title="Moves between two unlabelled contracts, e.g. lending vaults and routers"><input type="checkbox" id="whPlumbing" checked={plumb} onChange={(e) => setPlumb(e.target.checked)} /> contract-to-contract</label>
            </div>
          </div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Token</th><th>Value</th><th>From</th><th>To</th><th>Type</th><th>Tx</th></tr></thead><tbody id="whFeed">
            {!on ? <tr><td colSpan={7} className="empty">Loading…</td></tr>
              : rows.length ? rows.slice(0, 50).map((r, i) => (
                <tr key={`${r.id}-${i}`}>
                  <td className="mono">{wclock(r.t)}<span className="sub">{wago(r.t)}</span></td>
                  <td><b>{r.symbol}</b><span className="sub mono">{wamt(r.amount)}</span></td>
                  <td className="mono"><b>{wusd(r.usd)}</b></td>
                  <td><PartyBtn p={r.from} /></td><td><PartyBtn p={r.to} /></td>
                  <td><span className={`kind ${r.kind}`}>{KINDS[r.kind] || r.kind}</span></td>
                  <td className="mono"><WLink url={r.txUrl}>view</WLink></td>
                </tr>))
              : <tr><td colSpan={7} className="empty">{(d.transfers || []).length ? "Nothing matches the filters." : "No whale transfers yet. The first hour of history loads in the background."}</td></tr>}
          </tbody></table></div>
        </section>
      </>}
      {show("flows") && <div className="lower">
        <section className="panel"><div className="section-head"><div><h2>Exchange flows by token</h2><p>Deposited minus withdrawn. Red = more going onto exchanges.</p></div></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Token</th><th>Deposited</th><th>Withdrawn</th><th>Net</th><th>Transfers</th></tr></thead><tbody id="whTok">
            {on && ((d.tokenFlows || []).length ? (d.tokenFlows || []).filter((f) => stable || !f.stable).slice(0, 12).map((f, i) => (
              <tr key={`${f.token || f.symbol}-${i}`}><td><b>{f.symbol}</b>{f.stable ? <span className="cat">stable</span> : null}</td><td className="mono">{wusd(f.deposits)}</td><td className="mono">{wusd(f.withdrawals)}</td>
                <td className={cx("mono", exCls(f.net))}><b>{snet(f.net)}</b></td><td className="mono">{f.n}</td></tr>))
              : <tr><td colSpan={5} className="empty">No exchange flows yet.</td></tr>)}
          </tbody></table></div></section>
        <section className="panel"><div className="section-head"><div><h2>Exchange flows by exchange</h2><p>All tokens, with the stablecoin part shown below.</p></div></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Exchange</th><th>Deposited</th><th>Withdrawn</th><th>Net</th><th>Transfers</th></tr></thead><tbody id="whEx">
            {on && ((d.exchangeFlows || []).length ? (d.exchangeFlows || []).slice(0, 12).map((f, i) => (
              <tr key={`${f.exchange}-${i}`}><td><b>{f.exchange}</b></td><td className="mono">{wusd(f.deposits)}<span className="sub">stables {wusd(f.stableIn)}</span></td>
                <td className="mono">{wusd(f.withdrawals)}<span className="sub">stables {wusd(f.stableOut)}</span></td>
                <td className={cx("mono", exCls(f.net))}><b>{snet(f.net)}</b></td><td className="mono">{f.n}</td></tr>))
              : <tr><td colSpan={5} className="empty">No exchange flows yet.</td></tr>)}
          </tbody></table></div></section>
      </div>}
      {show("entities") && <div className="lower">
        <section className="panel"><div className="section-head"><div><h2>Most active entities</h2><p>Labelled exchanges, funds, issuers and protocols by value moved.</p></div></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Entity</th><th>Received</th><th>Sent</th><th>Net</th><th>Transfers</th></tr></thead><tbody id="whEnt">
            {on && ((d.entities || []).length ? (d.entities || []).slice(0, 12).map((e, i) => (
              <tr key={`${e.name}-${i}`}><td><b>{e.name}</b><CatTag c={e.category} /><span className="sub">{e.addresses} address{e.addresses === 1 ? "" : "es"}</span></td>
                <td className="mono">{wusd(e.inUsd)}</td><td className="mono">{wusd(e.outUsd)}</td><td className={cx("mono", inCls(e.net))}>{snet(e.net)}</td><td className="mono">{e.n}</td></tr>))
              : <tr><td colSpan={5} className="empty">Nothing yet.</td></tr>)}
          </tbody></table></div></section>
        <section className="panel"><div className="section-head"><div><h2>Biggest unlabelled wallets</h2><p>Addresses with no public label, by value moved. Open them on Arkham.</p></div></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Wallet</th><th>Received</th><th>Sent</th><th>Net</th><th>Main token</th></tr></thead><tbody id="whWal">
            {on && ((d.whales || []).length ? (d.whales || []).slice(0, 12).map((w, i) => (
              <tr key={`${w.address}-${i}`}><td><PartyBtn p={{ address: w.address, name: w.name, category: w.category }} /></td>
                <td className="mono">{wusd(w.inUsd)}</td><td className="mono">{wusd(w.outUsd)}</td><td className={cx("mono", inCls(w.net))}>{snet(w.net)}</td><td>{w.topToken || "—"}</td></tr>))
              : <tr><td colSpan={5} className="empty">Nothing yet.</td></tr>)}
          </tbody></table></div></section>
      </div>}

      <Dex fd={fd} on={dexOn} nets={tr.nets} wWin={tr.wWin} setWWin={tr.setWWin} reload={load} />

      {(show("alerts") || show("health")) && <div className="lower">
        {show("alerts") && <section className="panel"><div className="section-head"><div><h2>Alert history</h2><p>Whale and DEX alerts that popped up.</p></div></div>
          <div className="events" id="wEvents">{!loaded ? <div className="empty">No alerts yet.</div>
            : events.length ? events.map((e) => (
              <div className="event" style={{ cursor: "default" }} key={e.id}>
                <div><strong><span className={`badge ${e.type}`}>{WTYPES[e.type] || e.type}</span> {e.title}</strong>
                  <small>{(e.lines || []).join(" · ")}{(e.links || []).length ? <><br />{(e.links || []).map((l, i) => <Fragment key={i}>{i ? " · " : ""}<WLink url={l.url}>{l.label}</WLink></Fragment>)}</> : null}</small></div>
                <small className="mono">{when(e.time)}</small>
              </div>))
            : <div className="empty">No alerts yet. Quiet is normal.</div>}</div></section>}
        {show("health") && <section className="panel"><div className="section-head"><div><h2>Data health</h2><p>Where the data comes from right now.</p></div></div>
          <div className="source-list" id="wHealth">{loaded && <Health wd={d} fd={fd} />}</div></section>}
      </div>}
    </>
  );
}

function Health({ wd, fd }: { wd: WhalesData; fd: FlowsData }) {
  const h = wd.health || {}, c = wd.config || {}, fh = fd.health || {}, fc = fd.config || {}, ch = wd.chain || {};
  const rs = h.rpc || [], used = rs.filter((r) => r.ok > 0 && !r.restUntil).length, standby = rs.filter((r) => !r.ok && !r.fail).length, resting = rs.filter((r) => r.restUntil).length;
  const nm = h.names || {};
  const misses = fd.followMisses || [];
  const rows: [string, React.ReactNode][] = [
    ["Ethereum nodes (RPC)", <span key="r" className={used + standby >= 2 ? "green" : "amber"}>{used} in use · {standby} standing by · {resting} resting after errors</span>],
    ["History loaded", ch.backfill ? (ch.backfill.done ? `last ${ch.backfill.to - ch.backfill.from + 1} blocks` : `loading… block ${ch.backfill.next || "—"}`) : "—"],
    ["Tokens priced (DexScreener)", `${h.tokensPriced ?? 0} · ${h.dexCallsLastMin ?? 0} requests/min`],
    ["Address labels", `${(c.labels || 0).toLocaleString()} (public snapshot, ${c.labelsAsOf || ""})`],
    ["Names (Blockscout) and learned addresses", <>{`${(nm.cached || 0).toLocaleString()} looked up · ${(nm.named || 0).toLocaleString()} named · ${nm.queue ?? 0} waiting · ${(nm.learned || 0).toLocaleString()} exchange addresses learned · ${(nm.safes || 0).toLocaleString()} multisigs / smart wallets`}{nm.lastError ? <> · <span className="amber">{nm.lastError}</span></> : null}</>],
    ["DEX swaps on Ethereum (from the blocks)", `${h.swaps1h ?? 0} in the last hour, from ${wusd(c.swapMinUsd)}`],
    ["Whale alerts", `transfers ${wusd(c.alertUsd)} (stablecoins ${wusd(c.stableAlertUsd)}) · exchange moves ${wusd(c.exchangeAlertUsd)} · mints ${wusd(c.mintAlertUsd)}`],
    ["Telegram", wd.telegramOn || fd.telegramOn
      ? (wd.telegramConfigured ? <><span className="green">on</span> · {[wd.telegramOn ? `whales (max ${c.telegramPerHour}/hour)` : null, fd.telegramOn ? "DEX" : null].filter(Boolean).join(" · ")}</>
        : <span className="amber">not set (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)</span>)
      : "off · on screen only (switch on \"Whale transfers\" / \"DEX rotations\" in Ignition › Telegram)"],
    ["DEX data, other networks (GeckoTerminal)", <>{`${fh.callsLastMin ?? 0}/min of ${fc.callsPerMin ?? "—"}`}{fh.pausedUntil ? <> · <span className="amber">rate limited, slowing down</span></> : null}{` · ${(fd.pools || []).length} pools`}{misses.length ? <> · <span className="muted">not followed: {misses.join("; ")}</span></> : null}</>],
  ];
  return <>
    {rows.map(([k, v]) => <div className="source-row" key={k}><span>{k}</span><b className="status-pill">{v}</b></div>)}
    <RpcTable rs={rs} />
  </>;
}

// Each Ethereum node: what it served, its limits, and why it last failed (a failing node rests, longer each time)
function RpcTable({ rs }: { rs: RpcNode[] }) {
  if (!rs.length) return null;
  const used = rs.filter((r) => r.ok > 0 && !r.restUntil).length, standby = rs.filter((r) => !r.ok && !r.fail).length;
  const st = (r: RpcNode) => (r.restUntil ? <span className="amber">resting until {wclock(r.restUntil)}</span> : r.ok ? <span className="green">in use</span>
    : r.fail ? <span className="muted">not working yet</span> : <span className="muted">standing by</span>);
  const notes = (r: RpcNode) => [r.maxBatch < 40 ? `${r.maxBatch} requests per batch` : null, ...(r.cannot || []).map((c) => `not used for ${c.what} (it refuses them)`)].filter((x): x is string => !!x);
  return <>
    <div className="table-wrap" style={{ marginTop: 8 }}><table className="table"><thead><tr><th>Ethereum node</th><th>OK</th><th>Failed</th><th>Status</th><th>Notes</th><th>Last error</th></tr></thead><tbody>
      {rs.map((r, i) => {
        const ns = notes(r);
        return (
          <tr key={`${r.url}-${i}`}>
            <td className="mono">{r.url}</td><td className="mono">{r.ok}</td><td className="mono">{r.fail}</td><td>{st(r)}</td>
            <td className="muted" style={{ fontSize: 12 }}>{ns.length ? ns.map((x, j) => <Fragment key={j}>{j ? <br /> : null}{x}</Fragment>) : "—"}</td>
            <td style={{ fontSize: 12, maxWidth: 340 }} title={r.lastError || ""}>{r.lastError
              ? <><span className={r.restUntil ? "red" : "muted"}>{r.lastError.length > 90 ? `${r.lastError.slice(0, 88)}…` : r.lastError}</span><span className="sub">{r.lastErrorAt ? wago(r.lastErrorAt) : ""}</span></>
              : <span className="muted">—</span>}</td>
          </tr>
        );
      })}
    </tbody></table></div>
    <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>{used + standby >= 2
      ? "Errors on some nodes are normal: free nodes rate-limit or refuse some requests. The tracker switches to another node and tries the failing one again later, waiting longer each time (30 seconds up to 30 minutes)."
      : "Few nodes are working on your connection. The tracker keeps going on what works, but a free Alchemy or Infura key in WHALES_RPC makes it steady (README: Troubleshooting, \"Whale tracker: Ethereum nodes failing\")."}</p>
  </>;
}

"use client";
// DEX flows (the classic page's drawDex and drawTokens): the networks, the filters, where the money went, tokens bought
// and sold, the pair watches (POST /api/flows/watch, /api/flows/unwatch), the top rotations, wallet rotations and live
// swaps. The data comes from the tab's whale tracker poll (GET /api/flows?window= every 6 s).
import { Fragment, useState } from "react";
import { postJson } from "@/lib/api";
import { useScreener } from "../context";
import { WLink } from "./address";
import { MoneyMap } from "./map";
import { cx, S, snet, wamt, wago, wclock, wMatch, wshort, wusd } from "./fmt";
import type { FlowsData, Network, Tok } from "./types";

const signCls = (v: number) => (v > 0 ? "green" : v < 0 ? "red" : "");
const WTok = ({ t }: { t: Tok }) => <span className={cx("wtok", t.cls !== "token" && "major")}>{t.symbol}</span>;
export const Route = ({ f, t }: { f: Tok; t: Tok }) => <span className="wroute"><WTok t={f} /><span className="arrow">→</span><WTok t={t} /></span>;
const Lst = ({ a }: { a: { symbol: string; usd: number }[] }) => (a.length
  ? <>{a.map((x, i) => <Fragment key={i}>{i ? <br /> : null}{x.symbol} <span className="muted mono">{wusd(x.usd)}</span></Fragment>)}</>
  : <span className="muted">—</span>);

interface Props {
  fd: FlowsData; on: boolean; // on = the DEX data was drawn at least once and the DEX tracker is not switched off
  nets: Network[] | null; wWin: string; setWWin: (v: string) => void; reload: () => void;
}

export function Dex({ fd: d, on, nets, wWin, setWWin, reload }: Props) {
  const { show } = useScreener();
  const [nf, setNf] = useState(""), [qRaw, setQ] = useState(""), [majors, setMajors] = useState(false), [tSort, setTSort] = useState("");
  const [pair, setPair] = useState(""), [network, setNetwork] = useState("*"), [min, setMin] = useState("10000"), [both, setBoth] = useState(false), [err, setErr] = useState("");

  const q = qRaw.trim();
  const edgesAll = d.edges || [];
  const base = edgesAll.filter((e) => (majors || !e.majors) && (!nf || e.net === nf) && wMatch(q, S(e.from.symbol), S(e.to.symbol)));
  // token <-> token routes going both ways about equally are left off the map (typical of wash trading rings)
  const mapList = base.filter((e) => q || !(e.from.cls === "token" && e.to.cls === "token" && e.oneWay < 0.7));
  const edges = base.slice(0, 30);
  const t = d.totals || {}, c = d.config || {};
  const wnet = (id: string) => (id === "eth" && !(d.networks || []).length ? "Ethereum" : (d.networks || []).find((n) => n.id === id)?.name || id || "");

  // tokens bought and sold
  const parts = q.toUpperCase().replace(/\s/g, "").split(/->|>|-|\/|→/).filter(Boolean);
  let toks = (d.tokenFlows || []).filter((f) => (!nf || f.net === nf) && (!parts.length || parts.some((x) => S(f.token.symbol).includes(x))));
  if (tSort === "net") toks = [...toks].sort((a, b) => b.netUsd - a.netUsd);
  else if (tSort === "sell") toks = [...toks].sort((a, b) => a.netUsd - b.netUsd);
  else if (tSort === "buyers") toks = [...toks].sort((a, b) => b.buyers - a.buyers);
  const nSym: Record<string, number> = {}; // same symbol, different contracts (copycats): show the address
  for (const f of d.tokenFlows || []) nSym[f.token.symbol] = (nSym[f.token.symbol] || 0) + 1;

  const rots = (d.rotations || []).filter((r) => (!nf || r.net === nf) && wMatch(q, S(r.from.symbol), S(r.to.symbol)));
  const feed = (d.feed || []).filter((r) => (!nf || r.net === nf) && wMatch(q, S(r.from.symbol), S(r.to.symbol)));

  const watch = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try { await postJson("/api/flows/watch", { pair, network, minUsd: Number(min) || 0, both }); setPair(""); reload(); }
    catch (x) { setErr((x as Error).message); }
  };
  const unwatch = async (id: string) => {
    try { await postJson("/api/flows/unwatch", { id }); reload(); } catch (x) { setErr((x as Error).message); }
  };
  const netOptions = (nets || []).map((n) => <option key={n.id} value={n.id}>{n.name}</option>);

  return (
    <>
      {show("map dex") && <>
        <h2 className="subhead">DEX flows: which token went where</h2>
        <p>Every swap on every Ethereum DEX and aggregator, rebuilt from the blocks the whale tracker already reads (any token with $50k+ of DEX liquidity), plus the most active pools on Base, Solana and BNB Chain from GeckoTerminal&apos;s free API, and for 6 hours the pools of every token with a new Binance Alpha alert. Swaps from $2,000. Bot-like wallets are left out of the totals.</p>
        <div className="netchips" id="wNets">{on && (d.networks || []).map((n) => (
          <div key={n.id} className={cx("netchip", n.source === "onchain" && "onchain")}><b>{n.name}</b>{n.source === "onchain" ? "every DEX, from the blocks" : `${n.pools ?? 0} pools · GeckoTerminal`} · {n.swaps1h} swaps last hour
            {(n.followed || []).length ? <span className="wsub">following {(n.followed || []).join(", ")} (Alpha alert)</span> : null}</div>))}</div>
        <div className="dexbar">
          <select id="wWin" aria-label="Time window" value={wWin} onChange={(e) => setWWin(e.target.value)}><option value="15m">Last 15 min</option><option value="1h">Last hour</option><option value="24h">Last 24 hours</option></select>
          <select id="wNetFilter" aria-label="Network filter" value={nf} onChange={(e) => setNf(e.target.value)}><option value="">All networks</option>{netOptions}</select>
          <input id="wQ" placeholder="Filter: PEPE or ETH-PEPE" aria-label="Filter by token or pair" value={qRaw} onChange={(e) => setQ(e.target.value)} />
          <label className="wcheck"><input type="checkbox" id="wMajors" checked={majors} onChange={(e) => setMajors(e.target.checked)} /> ETH/BTC/SOL ↔ stablecoins</label>
        </div>
      </>}
      {show("map") && <>
        <section className="panel" style={{ marginBottom: 14 }}>
          <div className="section-head"><div><h2>Where the money went</h2><p>Each band is money swapped from a token on the left into a token on the right, in the window above. Width = USD. Hover a band for the details.</p></div>
            <span className="chip" id="wMapChip">{on && mapList.length ? `${wusd(mapList.reduce((a, e) => a + e.usd, 0))} · ${mapList.length} routes` : "—"}</span></div>
          <div className="wlegend"><span><i style={{ background: "var(--green)" }} />into a token (buying)</span><span><i style={{ background: "var(--red)" }} />out of a token into ETH / SOL / BNB / stablecoins (selling)</span><span><i style={{ background: "#a78bfa" }} />token into token</span><span><i style={{ background: "var(--muted)" }} />between ETH / BTC / stablecoins</span></div>
          <MoneyMap list={on ? mapList : null} anyEdges={edgesAll.length > 0} />
        </section>
        <section className="panel" style={{ marginBottom: 14 }}>
          <div className="section-head"><div><h2>Tokens bought and sold on DEXes</h2><p>Per token: how much was bought and sold, by how many wallets, and what it was bought with or sold for. Ranked by money from or to ETH / SOL / BNB / stablecoins; tokens only swapped into other small tokens (often wash trading) are faded at the bottom.</p></div>
            <div className="filters"><select id="tSort" aria-label="Sort tokens" value={tSort} onChange={(e) => setTSort(e.target.value)}><option value="">Most traded</option><option value="net">Most net buying</option><option value="sell">Most net selling</option><option value="buyers">Most buyers</option></select></div></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Token</th><th>Bought</th><th>Sold</th><th>Net</th><th>Buyers / sellers</th><th>Bought with</th><th>Sold for</th><th>Biggest buy</th></tr></thead><tbody id="wTok">
            {!on ? <tr><td colSpan={8} className="empty">Loading…</td></tr>
              : toks.length ? toks.slice(0, 30).map((f, i) => (
                <tr key={`${f.key}-${i}`} className={f.tokenOnly ? "faded" : undefined}>
                  <td><button type="button" className="coin-link" data-wtok={f.token.symbol} onClick={() => setQ(f.token.symbol)}><b>{f.token.symbol}</b></button><span className="badge net">{f.chain}</span>
                    {nSym[f.token.symbol] > 1 && f.token.address ? <span className="wsub mono">{wshort(f.token.address)}</span> : null}{f.tokenOnly ? <span className="wsub">token ↔ token only</span> : null}</td>
                  <td className="mono green">{wusd(f.inUsd)}<span className="sub">{f.buys} buy{f.buys === 1 ? "" : "s"}</span></td>
                  <td className="mono red">{wusd(f.outUsd)}<span className="sub">{f.sells} sell{f.sells === 1 ? "" : "s"}</span></td>
                  <td className={cx("mono", signCls(f.netUsd))}><b>{snet(f.netUsd)}</b></td>
                  <td className="mono">{f.buyers} / {f.sellers}</td>
                  <td><Lst a={f.boughtWith || []} /></td><td><Lst a={f.soldFor || []} /></td>
                  <td className="mono">{f.biggestBuy ? wusd(f.biggestBuy) : "—"}</td>
                </tr>))
              : <tr><td colSpan={8} className="empty">{(d.tokenFlows || []).length ? "Nothing matches the filters." : "No token swaps in this window yet."}</td></tr>}
          </tbody></table></div>
        </section>
      </>}
      {show("dex") && <>
        <section className="panel" style={{ marginBottom: 14 }}>
          <div className="section-head"><div><h2>Watch a pair</h2><p>Popup on every swap from one token into another, e.g. ETH-PEPE, SOL-BONK, USDC-ETH.</p></div><span className="chip" id="wkLine">{on ? `${t.swaps1h ?? 0} swaps · ${wusd(t.usd1h)} last hour` : "—"}</span></div>
          <form className="watchbar" id="wForm" onSubmit={watch}>
            <input name="pair" placeholder="ETH-PEPE" aria-label="Pair, FROM-TO" required value={pair} onChange={(e) => setPair(e.target.value)} />
            <select name="network" id="wNet" aria-label="Network" value={network} onChange={(e) => setNetwork(e.target.value)}><option value="*">Any network</option>{netOptions}</select>
            <input name="min" type="number" min="0" step="1000" aria-label="Minimum swap in USD" title="Minimum swap size in USD" value={min} onChange={(e) => setMin(e.target.value)} />
            <label className="wcheck"><input type="checkbox" name="both" checked={both} onChange={(e) => setBoth(e.target.checked)} /> both directions</label>
            <button className="btn" type="submit">Watch</button>
            <span className="red" id="wFormErr" style={{ fontSize: 12 }}>{err}</span>
          </form>
          <div className="watches" id="wWatches">{on && ((d.watches || []).length ? (d.watches || []).map((w) => (
            <span className="wchip" key={w.id}>{w.from} {w.both ? "⇄" : "→"} {w.to} <small>{w.net === "*" ? "any network" : wnet(w.net)} · from {wusd(w.minUsd)} · {w.status || ""}</small>
              <button type="button" title="Stop watching" data-unwatch={w.id} onClick={() => unwatch(w.id)}>×</button></span>))
            : <span className="muted" style={{ fontSize: 12 }}>No pairs watched.</span>)}</div>
        </section>
        <section className="panel">
          <div className="section-head"><div><h2>Top rotations</h2><p>Money moving FROM one token TO another. One-way = share of the pair&apos;s two-way flow going this direction. vs normal = compared with this route&apos;s usual level today.</p></div></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Route</th><th>Value</th><th>Swaps</th><th>Wallets</th><th>One-way</th><th>vs normal</th><th>Largest swap</th></tr></thead><tbody id="wEdges">
            {!on ? <tr><td colSpan={7} className="empty">Loading…</td></tr>
              : edges.length ? edges.map((e, i) => {
                const v = e.vsNormal, ow = Math.round(e.oneWay * 100);
                const vs = v === "new" ? <span className="green">new today</span> : v == null ? <span className="muted">building history</span>
                  : <span className={v >= 3 ? "green" : v < 1 ? "muted" : undefined}>{v.toFixed(1)}x</span>;
                return (
                  <tr key={`${e.key}-${i}`}>
                    <td><Route f={e.from} t={e.to} /><span className="badge net">{e.chain}</span></td>
                    <td className="mono"><b>{wusd(e.usd)}</b><span className="sub">{wusd(e.reverse)} went back</span></td>
                    <td className="mono">{e.n}</td><td className="mono">{e.wallets}</td>
                    <td className={cx("mono", ow >= 70 ? "green" : ow < 50 ? "muted" : "")}>{ow}%<span className="wbar"><i style={{ width: `${ow}%` }} /></span></td>
                    <td className="mono">{vs}</td><td className="mono">{wusd(e.largest)}</td>
                  </tr>
                );
              })
              : <tr><td colSpan={7} className="empty">{edgesAll.length ? "Nothing matches the filter." : "No swaps recorded in this window yet."}</td></tr>}
          </tbody></table></div>
        </section>
        <div className="lower">
          <section className="panel"><div className="section-head"><div><h2>Wallet rotations</h2><p id="wRotHint">{on
            ? `Wallets that sold one token and bought another within ${c.rotationMinutes ?? 30} minutes (last 24 hours). Alerts from ${wusd(c.rotationUsd)}.`
            : "Wallets that sold one token and bought another soon after (last 24 hours)."}</p></div></div>
            <div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Wallet</th><th>Rotation</th><th>Value</th><th>Gap</th></tr></thead><tbody id="wRot">
              {on && (rots.length ? rots.slice(0, 15).map((r, i) => (
                <tr key={`${r.wallet}-${r.t}-${i}`}>
                  <td className="mono">{wclock(r.t)}<span className="sub">{wago(r.t)}</span></td>
                  <td className="mono"><WLink url={r.walletUrl}>{wshort(r.wallet)}</WLink><span className="sub">{r.chain}</span></td>
                  <td><Route f={r.from} t={r.to} /><span className="sub">via {r.via?.symbol}</span></td>
                  <td className="mono"><b>{wusd(r.usd)}</b></td><td className="mono">{r.gapMin} min</td>
                </tr>))
                : <tr><td colSpan={5} className="empty">No wallet rotations seen yet.</td></tr>)}
            </tbody></table></div></section>
          <section className="panel"><div className="section-head"><div><h2>Live swaps</h2><p>Newest first, with the DEX or router used. Faded rows are bot-like wallets.</p></div></div>
            <div className="table-wrap"><table className="table"><thead><tr><th>Time</th><th>Swap</th><th>Value</th><th>Wallet</th><th>Tx</th></tr></thead><tbody id="wFeed">
              {on && (feed.length ? feed.slice(0, 30).map((r, i) => (
                <tr key={`${r.id}-${i}`} className={r.bot ? "bot" : undefined}>
                  <td className="mono">{wclock(r.t)}<span className="sub">{r.chain}{r.dex ? ` · ${r.dex}` : ""}</span></td>
                  <td><Route f={r.from} t={r.to} /><span className="sub mono">{wamt(r.from.amount)} → {wamt(r.to.amount)}{r.hops > 1 ? ` · ${r.hops} hops` : ""}</span></td>
                  <td className="mono"><b>{wusd(r.usd)}</b></td>
                  <td className="mono"><WLink url={r.walletUrl}>{wshort(r.wallet)}</WLink>{r.bot ? <span className="sub">bot-like</span> : r.safe ? <span className="sub">multisig / smart wallet</span> : null}</td>
                  <td className="mono"><WLink url={r.txUrl}>view</WLink></td>
                </tr>))
                : <tr><td colSpan={5} className="empty">No swaps yet.</td></tr>)}
            </tbody></table></div></section>
        </div>
      </>}
    </>
  );
}

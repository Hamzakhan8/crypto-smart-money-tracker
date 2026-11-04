"use client";
// Senders and receivers (the classic page's party(), catTag(), wlink()) and the address profile window (openAddr):
// label, received / sent, top counterparties and recent transfers of one Ethereum address, with a "Watch this wallet"
// button. Data: GET /api/whales/address?a= each time the window opens.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getJson, postJson } from "@/lib/api";
import { SafeLink } from "../ui";
import { CATS, KINDS, wago, wamt, wclock, wshort, wusd } from "./fmt";
import type { AddressProfile, Party } from "./types";

/** Opens the address window (any sender or receiver can be clicked). */
export const AddrContext = createContext<(address: string) => void>(() => {});

/** An outside link (the classic wlink): only https:// addresses become links. */
export const WLink = ({ url, children }: { url?: string | null; children: ReactNode }) => <SafeLink url={url} className="wlink">{children}</SafeLink>;

export const CatTag = ({ c }: { c?: string | null }) => (c ? <span className={`cat ${c}`}>{CATS[c] || c}</span> : null);

/** A sender or receiver: its name (or short address) and category; a click opens its profile. */
export function PartyBtn({ p }: { p: Party }) {
  const open = useContext(AddrContext);
  if (p.special) return <span className="muted">{p.special === "burn" ? "Burn address" : "Mint / burn (0x0)"}</span>;
  return (
    <button type="button" className={p.name ? "addr" : "addr unk"} data-addr={p.address} title={p.address} onClick={(e) => { e.preventDefault(); open(p.address); }}>
      <span className="nm">{p.name || wshort(p.address)}</span>
      {p.learned ? <span className="cat exchange" title="Learned from its transfers: it hands its tokens to this exchange">Exchange · learned</span>
        : p.category ? <CatTag c={p.category} /> : p.contract ? <span className="cat">contract</span> : null}
    </button>
  );
}

/** The address window. `req.n` changes on every open, so opening the same address again reloads it. */
export function AddressModal({ req, onClose, reload }: { req: { a: string; n: number }; onClose: () => void; reload: () => void }) {
  const a = req.a;
  const [v, setV] = useState<AddressProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    let live = true;
    setV(null); setErr(null); setWatching(false);
    getJson<AddressProfile>("/api/whales/address?a=" + encodeURIComponent(a))
      .then((d) => { if (live) setV(d); })
      .catch((e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [a, req.n]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);

  const watch = async () => {
    if (!v) return;
    const name = prompt("Your label for this wallet (optional):", v.name || "");
    if (name === null) return;
    try { await postJson("/api/whales/watch", { target: v.address, name, minUsd: 0 }); setWatching(true); reload(); }
    catch (e) { alert((e as Error).message); }
  };

  return createPortal(
    <div className="modal-backdrop wmodal open" id="whModal" role="dialog" aria-modal="true" aria-labelledby="whMTitle" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal">
        <div className="modal-head">
          <div>
            <div className="eyebrow" id="whMEyebrow">{v ? (v.category ? <>{v.categoryName || v.category}{v.entity && v.entity !== v.name ? <> · {v.entity}</> : null}</> : "No public label") : "Address"}</div>
            <h2 id="whMTitle">{v ? v.name || "Unlabelled wallet" : wshort(a)}</h2>
            <p id="whMSub" className="mono">{a}</p>
          </div>
          <button className="btn" id="whMClose" aria-label="Close address" onClick={onClose}>✕</button>
        </div>
        <div className="wstats" id="whMStats">
          {v && ([["Received", wusd(v.inUsd)], ["Sent", wusd(v.outUsd)], ["Tracked transfers", v.n]] as const).map(([k, x]) => (
            <div className="book-stat" key={k}><span>{k}</span><strong>{x}</strong></div>))}
        </div>
        <div className="sec">Top counterparties (tracked transfers, 24h)</div>
        <div className="table-wrap"><table className="table"><tbody id="whMCp">
          {v && (v.counterparties.length ? v.counterparties.map((c, i) => (
            <tr key={`${c.address}-${i}`}><td><PartyBtn p={c} /></td><td className="mono">{wusd(c.usd)}</td></tr>))
            : <tr><td className="empty">No tracked transfers in the last 24 hours (only transfers over the minimum are kept).</td></tr>)}
        </tbody></table></div>
        <div className="sec" style={{ paddingTop: 12 }}>Recent transfers</div>
        <div className="table-wrap"><table className="table"><tbody id="whMTx">
          {err ? <tr><td className="red">{err}</td></tr>
            : !v ? <tr><td className="empty">Loading…</td></tr>
            : v.transfers.slice(0, 40).map((r, i) => {
              const out = r.from.address === v.address;
              return (
                <tr key={`${r.id}-${i}`}>
                  <td className="mono">{wclock(r.t)}<span className="sub">{wago(r.t)}</span></td>
                  <td className={out ? "red" : "green"}>{out ? "Sent" : "Received"}</td>
                  <td><b>{wamt(r.amount)} {r.symbol}</b><span className="sub mono">{wusd(r.usd)}</span></td>
                  <td>{out ? "to " : "from "}<PartyBtn p={out ? r.to : r.from} /></td>
                  <td><span className={`kind ${r.kind}`}>{KINDS[r.kind] || r.kind}</span></td>
                  <td className="mono"><WLink url={r.txUrl}>tx</WLink></td>
                </tr>
              );
            })}
        </tbody></table></div>
        <div className="modal-foot" id="whMLinks">
          {v && <>
            {v.links.map((l, i) => <SafeLink key={i} url={l.url} className="btn">Open on {l.label}</SafeLink>)}
            <button className="btn" type="button" id="whMWatch" onClick={watch}>{watching ? "Watching" : "Watch this wallet"}</button>
          </>}
        </div>
      </section>
    </div>,
    document.body, // after the page, as on the classic page
  );
}

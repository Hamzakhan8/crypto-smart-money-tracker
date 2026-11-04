"use client";
// The setup detail window: every number behind a coin's ignition score and daily setup score, and why it flagged.
// Opened from the leaderboard, the live watch, the alert history and the popups.
import { useEffect } from "react";
import type { Candidate } from "./context";
import { col, money, pct, pct1, price } from "@/lib/format";

const IG_LABELS: Record<string, string> = { volume: "15m volume", persistence: "Persistence", buyers: "Buyers", structure: "Price structure", strength: "vs BTC", context: "Daily context", quality: "Spread / room" };
const PART_LABELS: Record<string, string> = { volume: "Volume (24h)", technical: "Chart setup", narrative: "Narrative", tokenomics: "Supply (n/a)", futures: "Futures", liquidity: "Liquidity" };
const yesNo = (v: unknown, y: string, n: string) => (v == null ? "—" : v ? y : n);
type Part = { pts: number; max: number };

export function DetailModal({ c, eyebrow, onClose }: { c: Candidate; eyebrow: string; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);
  const r = c.rotation, rot = r?.regimeLabel ? ` · ${r.regimeLabel}${(r.narratives || []).filter((x: { rank: number | null }) => x.rank != null).slice(0, 2).map((x: { name: string; rank: number }) => `, ${x.name} #${x.rank}`).join("")}` : "";
  const stat = (l: string, v: string, k = "") => <div className="book-stat" key={l}><span>{l}</span><strong className={`mono ${k}`}>{v}</strong></div>;
  const why = [...(c.reasons || [])];
  if (c.ignition === "heating" && (c.missing || []).length) why.push("still needs: " + c.missing.join(", "));
  const fx = (v: number | null | undefined, d = 1, s = "") => (v == null ? "—" : v.toFixed(d) + s);
  return (
    <div className="modal-backdrop open" role="dialog" aria-modal="true" aria-labelledby="mTitle" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal">
        <div className="modal-head"><div><div className="eyebrow">{eyebrow || "Setup detail"}</div><h2 id="mTitle">{c.base} / USDT · daily score {c.score}/100</h2>
          <p>{c.name || c.base} · {c.rank ? `market cap rank #${c.rank}` : "rank n/a"} · {c.label}{c.moved && c.movedWhy ? ` (${c.movedWhy.join(", ")})` : ""}{rot}</p></div>
          <button className="btn" onClick={onClose} aria-label="Close detail">✕</button></div>
        <div className="book-meta">
          {stat("Price", price(c.price))}
          {stat("Ignition score", c.igScore == null ? "—" : `${c.igScore}/100`, c.igScore >= 65 ? "green" : "")}
          {stat("15m volume", c.rvol15 == null ? "—" : `${c.rvol15.toFixed(1)}× normal`, c.rvol15 >= 4 ? "green" : "")}
          {stat("Last two 5m candles", c.r5 == null ? "—" : `${c.prevR5.toFixed(1)}× · ${c.r5.toFixed(1)}×`, c.r5 >= 3 && c.prevR5 >= 3 ? "green" : "")}
          {stat("Move 15m / 1h", `${pct1(c.ret15m)} / ${pct1(c.ret1h)}`)}
          {stat("Buyers (15m)", fx(c.buyRatio15m, 0, "%"), c.buyRatio15m >= 58 ? "green" : "")}
          {stat("Volume held", c.persist == null ? "—" : `${c.persist}/${c.persistOf} candles`, c.persist >= 2 ? "green" : "")}
          {stat("Trades vs normal", fx(c.tradesRatio, 1, "×"))}
          {stat("Spread", fx(c.spreadBps, 1, " bps"))}
          {stat("4h trend", yesNo(c.trendUp, "Rising", "Not rising"), c.trendUp ? "green" : c.trendUp === false ? "red" : "")}
          {stat("12h high", c.breakout == null ? "—" : c.breakout ? "Broken" : `${pct1(c.distTo12hHigh)} away`, c.breakout ? "green" : c.distTo12hHigh != null && c.distTo12hHigh > -1 ? "red" : "")}
          {stat("24h high", c.distTo24hHigh == null ? "—" : c.distTo24hHigh > 0 ? "Broken" : `${pct1(c.distTo24hHigh)} away`, c.distTo24hHigh > 0 ? "green" : c.distTo24hHigh != null && c.distTo24hHigh > -1.5 ? "red" : "")}
          {stat("Off spike high", fx(c.fadePct, 1, "%"), c.fadePct > 1 ? "red" : "")}
          {stat("Typical 6h range", fx(c.range6h, 1, "%"), c.slow ? "red" : "")}
          {stat("24h change", pct(c.change24h), col(c.change24h))}
          {stat("24h volume", c.rvol == null ? "—" : `${c.rvol.toFixed(2)}× avg`, c.rvol >= 2 ? "green" : "")}
          {stat("RSI (14d)", fx(c.rsi, 0), c.rsi > 65 ? "red" : "")}
          {stat("BTC 4h", c.btc4h == null ? "—" : pct1(c.btc4h), c.btc4h < -0.1 ? "red" : "")}
          {stat("vs 20d high", c.distToHigh == null ? "—" : pct(c.distToHigh * 100))}
          {stat("Market cap", money(c.marketCap))}
          {stat("Funding / 8h", c.fundingPct == null ? "none" : `${c.fundingPct.toFixed(3)}%`)}
          {stat("OI 24h", c.oiChange24hPct == null ? "—" : pct(c.oiChange24hPct))}
          {stat("vs BTC (15m)", c.rs15 == null ? "—" : pct1(c.rs15), col(c.rs15))}
        </div>
        {c.igParts && <><div className="sec">How the ignition score was built</div>
          <div className="parts">{Object.entries(c.igParts as Record<string, Part>).map(([k, p]) => (
            <div className="part" key={k}><span>{IG_LABELS[k] || k}</span><span className="bar"><i style={{ width: `${Math.min(100, (Math.abs(p.pts) / p.max) * 100)}%` }} /></span><b className="mono">{p.pts}/{p.max}</b></div>))}</div></>}
        <div className="sec" style={{ paddingTop: 12 }}>How the daily setup score was built</div>
        <div className="parts">{Object.entries((c.parts || {}) as Record<string, Part>).map(([k, p]) => (
          <div className="part" key={k}><span>{PART_LABELS[k] || k}</span><span className="bar"><i className={p.pts < 0 ? "neg" : undefined} style={{ width: `${Math.min(100, (Math.abs(p.pts) / p.max) * 100)}%` }} /></span>
            <b className={`mono ${p.pts < 0 ? "red" : ""}`}>{p.pts}/{p.max}</b></div>))}</div>
        <div className="sec" style={{ paddingTop: 12 }}>Why it flagged</div>
        <ul className="reasons">{why.length ? why.map((x, i) => <li key={i}>{x}</li>) : <li className="muted">No standout factors.</li>}</ul>
        <div className="modal-foot"><a className="btn" href={`https://www.binance.com/en/trade/${encodeURIComponent(c.base)}_USDT?type=spot`} target="_blank" rel="noopener noreferrer">Open on Binance</a>
          <span>Set your entry, stop-loss and target before acting. Not financial advice.</span></div>
      </section>
    </div>
  );
}

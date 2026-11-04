"use client";
// The Liquidity tab's smaller pieces: the current order book next to the heatmap, one screener row and the data health rows.
import { Fragment } from "react";
import { col, pct } from "@/lib/format";
import { SourceRow } from "../ui";
import { SIG_CLASS, exName, hhmm, money, px, type HeatStatus, type Heatmap, type Level, type LiqRow, type LiquidityApi } from "./types";

/** A signed % in green / red ("—" when missing). */
function Pct({ v }: { v: number | null | undefined }) {
  return v == null || !Number.isFinite(Number(v)) ? <>—</> : <span className={col(v)}>{pct(v)}</span>;
}

// The current book (OrderBookPanel): best prices, spread, imbalance, the book grouped into the heatmap's price rows, the biggest walls.
export function OrderBook({ hm }: { hm: Heatmap | null }) {
  const b = hm?.book;
  if (!hm || !b) return (
    <aside className="lq-side" aria-label="Current order book"><div className="empty" style={{ padding: 20 }}>
      {hm?.status?.needsResync ? "Rebuilding the order book…" : hm?.status?.lastError || "Connecting to the order book…"}</div></aside>
  );
  const g = b.grouped, asks = (g?.asks || b.asks.map(([p, q]): Level => [p, p * q])).slice(0, 12), bids = (g?.bids || b.bids.map(([p, q]): Level => [p, p * q])).slice(0, 12);
  const max = Math.max(1, ...asks.map((x) => x[1]), ...bids.map((x) => x[1]));
  const row = (x: Level, cls: string, color: string, i: number) => (
    <tr key={`${cls}${i}`}><td className={cls}>{px(x[0])}</td><td className="v"><i style={{ width: `${((x[1] / max) * 100).toFixed(1)}%`, background: color }} />{money(x[1])}</td></tr>
  );
  const walls = (list: Level[] | undefined, cls: string) => (list || []).length
    ? list!.map((w, i) => <div key={i}><span className={cls}>{px(w[0])}</span> · {money(w[1])}</div>) : <div className="muted">—</div>;
  const imb = b.imbalance;
  return (
    <aside className="lq-side" aria-label="Current order book">
      <h3>Order book <span className="chip" style={{ padding: "4px 8px", fontSize: 11 }}>{hm.symbol}</span></h3>
      <div className="lq-stats">
        <div><span>Best bid</span><b className="green">{px(b.bestBid)}</b></div><div><span>Best ask</span><b className="red">{px(b.bestAsk)}</b></div>
        <div><span>Spread</span><b>{b.spreadPct != null ? b.spreadPct.toFixed(4) + "%" : "—"}</b></div>
        <div><span>Imbalance (top 20)</span><b className={imb != null && imb > 0 ? "green" : imb != null && imb < 0 ? "red" : ""}>{imb != null ? (imb > 0 ? "+" : "") + (imb * 100).toFixed(1) + "%" : "—"}</b></div>
      </div>
      <table className="lq-ob" aria-label="Order book grouped by price"><tbody>
        {asks.slice().reverse().map((x, i) => row(x, "red", "var(--red)", i))}
        <tr className="mid"><td colSpan={2}>{px(b.mid)}{g ? ` · rows of ${px(g.binWidth)}` : ""}</td></tr>
        {bids.map((x, i) => row(x, "green", "var(--green)", i))}
      </tbody></table>
      <div className="lq-walls"><div><div className="sub">Biggest buy walls</div>{walls(b.walls?.bids, "green")}</div><div><div className="sub">Biggest sell walls</div>{walls(b.walls?.asks, "red")}</div></div>
    </aside>
  );
}

/** One coin of the screener. onCoin: show that coin's Binance order book in the heatmap. */
export function ScreenerRow({ r, onCoin }: { r: LiqRow; onCoin: (coin: string) => void }) {
  const band = r.band || "cold", sc = r.score, im = r.imbalance, exs = r.exchanges || [];
  return (
    <tr>
      <td><button type="button" className="coin-link sym" title={`Show ${r.coin}USDT's Binance order book`} onClick={() => onCoin(r.coin)}>{r.coin}</button>
        <span className="sub">{r.lead ? "hottest on " + exName(r.lead) : ""}</span></td>
      <td>{sc == null ? "—" : <><span className="score"><span className={`badge lq-b-${band}`}>{sc}</span><span className="scorebar"><i className={band} style={{ width: `${Math.max(3, sc)}%` }} /></span></span>
        <span className="sub">{band}</span></>}</td>
      <td>{r.signals.length ? <div className="lq-sigs">{r.signals.map((s) => (
        <span key={s.type} className={`badge ${SIG_CLASS[s.type] || ""}`} title={`${s.message}${s.venues.length ? " · " + s.venues.map(exName).join(", ") : ""}`}>
          {s.label}{s.venues.length > 1 ? ` ×${s.venues.length}` : ""}</span>))}</div> : <span className="muted">—</span>}</td>
      <td className="mono">{px(r.price)}<span className="sub"><Pct v={r.change24h} /></span></td>
      <td className="mono"><Pct v={r.change5m} /><span className="sub">1h <Pct v={r.change1h} /></span></td>
      <td className="mono">{money(r.volumeUsd)}<span className="sub">{exs.length} exchange{exs.length === 1 ? "" : "s"}</span></td>
      <td className="mono">{r.spreadPct == null ? "—" : r.spreadPct.toFixed(3) + "%"}<span className="sub">{im == null ? "" : <>book {im > 0 ? <span className="green">{Math.round(im * 100)}% bids</span>
        : im < 0 ? <span className="red">{Math.round(-im * 100)}% asks</span> : "even"}</>}</span></td>
      <td><span className="lq-ex">{exs.map((x, i) => <Fragment key={x}>{i ? " · " : ""}{x === r.lead ? <b>{exName(x)}</b> : exName(x)}</Fragment>)}</span>
        <span className="sub">{r.priceGapPct == null ? "" : "gap " + r.priceGapPct.toFixed(2) + "%"}</span></td>
    </tr>
  );
}

/** Data health: each exchange, then the heatmap feed. */
export function Health({ data }: { data: LiquidityApi }) {
  const pill = (st: string) => (st === "ok" ? "green" : st === "error" ? "red" : "amber");
  const h: HeatStatus = data.heatmap || {};
  return (
    <>
      {(data.exchanges || []).map((x) => (
        <SourceRow key={x.id} wrap cls={pill(x.status)} label={<>{x.name} spot<span className="sub">
          {x.listed ? `${x.listed} coins listed · ${x.coins} followed · full check on ${x.deep}/${x.top}` : "loading the coin list…"}
          {x.cycleMs != null ? ` · last read ${(x.cycleMs / 1000).toFixed(1)} s` : ""}{x.error ? ` · ${x.error}` : ""}</span></>}>
          {x.status === "ok" ? "OK · " + hhmm(x.updatedAt, true) : x.pausedUntil && x.pausedUntil > Date.now() ? "Paused until " + hhmm(x.pausedUntil) : x.status}
        </SourceRow>))}
      <SourceRow cls={h.mode === "websocket" && !h.needsResync ? "green" : h.mode === "rest" ? "amber" : h.mode === "stopped" ? "" : "amber"}
        label={<>Heatmap feed (Binance {h.symbol || ""})<span className="sub">
          {h.mode === "websocket" ? "live diff-depth + trade streams" : h.mode === "rest" ? "REST polling every 2 s (no WebSocket)" : h.mode || "—"}
          {` · ${h.samples || 0} samples (${Math.round((h.historyMs || 0) / 60000)} min) · ${h.resyncs || 0} resyncs`}{h.lastError ? " · " + h.lastError : ""}</span></>}>
        {h.mode === "websocket" ? (h.needsResync ? "Rebuilding book" : "Live") : h.mode || "—"}
      </SourceRow>
    </>
  );
}

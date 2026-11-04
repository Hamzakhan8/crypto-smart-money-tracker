"use client";
import { useCallback, useEffect, useState } from "react";
import { getJson, type OrderBook } from "@/lib/api";
import { amount, bookPrice, money, time } from "@/lib/format";

// A coin's Binance spot order book: the top 20 bids and asks, refreshed every 5 seconds while open.
export function OrderBookModal({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const [book, setBook] = useState<OrderBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const b = await getJson<OrderBook>(`/api/orderbook?symbol=${encodeURIComponent(symbol)}`);
      if (!b.bids?.length || !b.asks?.length) throw new Error("No bid/ask levels returned");
      setBook(b); setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [symbol]);
  useEffect(() => { setBook(null); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [onClose]);

  const bid = book ? Number(book.bids[0][0]) : 0, ask = book ? Number(book.asks[0][0]) : 0, spread = ask - bid, mid = (ask + bid) / 2;
  const side = (rows: [string, string][], cls: "green" | "red") => {
    const top = rows.slice(0, 20), usd = top.map(([p, q]) => Number(p) * Number(q)), max = Math.max(...usd, 1);
    return { total: usd.reduce((a, x) => a + x, 0), body: top.map(([p, q], i) => (
      <tr key={p}><td className={cls}>{bookPrice(p)}</td><td>{amount(q)}</td>
        <td className="depth-cell"><i className="depth-bar" style={{ width: `${(usd[i] / max) * 100}%`, background: `var(--${cls})` }} /><span>{money(usd[i])}</span></td></tr>
    )) };
  };
  const bids = book ? side(book.bids, "green") : null, asks = book ? side(book.asks, "red") : null;
  const loading = <tr><td colSpan={3}>Loading…</td></tr>;

  return (
    <div className="modal-backdrop open" role="dialog" aria-modal="true" aria-labelledby="bookTitle" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="modal">
        <div className="modal-head">
          <div><div className="eyebrow">Binance spot depth snapshot</div><h2 id="bookTitle">{symbol.replace("USDT", "")} / USDT</h2>
            <p>{book ? `Top ${Math.min(20, book.bids.length)} bid and ask levels · refreshed ${time(book.updatedAt)}` : "Loading current Binance Spot depth…"}</p></div>
          <div className="book-actions"><button className="btn" onClick={load}>↻ Refresh</button><button className="btn" onClick={onClose} aria-label="Close order book">✕</button></div>
        </div>
        <div className="book-meta">
          <div className="book-stat"><span>Best bid</span><strong className="green mono">{book ? bookPrice(bid) : "—"}</strong></div>
          <div className="book-stat"><span>Best ask</span><strong className="red mono">{book ? bookPrice(ask) : "—"}</strong></div>
          <div className="book-stat"><span>Spread</span><strong className="mono">{book ? bookPrice(spread) : "—"}</strong></div>
          <div className="book-stat"><span>Spread %</span><strong className="mono">{book ? `${(mid ? (spread / mid) * 100 : 0).toFixed(4)}%` : "—"}</strong></div>
        </div>
        <div className="book-grid">
          <div className="book-side"><h3>BUY ORDERS / BIDS <span className="green">{bids ? money(bids.total) : "—"}</span></h3>
            <table className="book-table"><thead><tr><th>Price (USDT)</th><th>Amount</th><th>Total (USDT)</th></tr></thead><tbody>{bids ? bids.body : loading}</tbody></table></div>
          <div className="book-side"><h3>SELL ORDERS / ASKS <span className="red">{asks ? money(asks.total) : "—"}</span></h3>
            <table className="book-table"><thead><tr><th>Price (USDT)</th><th>Amount</th><th>Total (USDT)</th></tr></thead><tbody>{asks ? asks.body : loading}</tbody></table></div>
        </div>
        <div className={error ? "book-status error" : "book-status"}>
          {error || (book ? `${book.demo ? "DEMO — simulated values, not real market data. " : ""}Source: ${book.source}. Snapshot refreshes every 5 seconds while open. Depth is cancellable and may change before an order executes.` : "Fetching order book snapshot…")}
        </div>
      </section>
    </div>
  );
}

"use client";
// The Liquidity tab: the order-book heatmap of one Binance pair (where resting orders sat over the last 15 minutes to
// 2 hours, with trade candles, the current book and trade volume) and the multi-exchange screener (Binance, Bybit, OKX,
// Coinbase, Kraken: each coin's 0-100 hotness, its signals, prices and volume, filters by exchange and by signal, and
// each exchange's health). Data: GET /api/liquidity every 15 s, GET /api/liquidity/heatmap every 4 s (skipped while the
// page is hidden), POST /api/liquidity/symbol to switch the pair (liquidity.js). Choices are remembered per browser
// under the same "liq:" keys as the classic tab (public/liquidity-tab.js).
import "./liquidity.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson, postJson } from "@/lib/api";
import { useStored } from "@/components/useStored";
import { Sec } from "../context";
import { ErrorBox, Kpi, usePoll } from "../ui";
import { HeatmapChart } from "./HeatmapChart";
import { Health, OrderBook, ScreenerRow } from "./parts";
import { EX_NAMES, SIGNALS, hhmm, type HeatStatus, type Heatmap, type LiqRow, type LiquidityApi } from "./types";

const LOOKBACKS: [number, string][] = [[15, "15m"], [30, "30m"], [60, "1h"], [120, "2h"]];
const PRESETS: [string, string][] = [["deep", "Deep liquidity"], ["balanced", "Balanced"], ["walls", "Strong walls only"], ["weak", "Show weak liquidity"], ["clean", "Clean"], ["classic", "Classic colours"]];
const SIDES: [string, string][] = [["combined", "Both sides"], ["bids", "Buy orders"], ["asks", "Sell orders"], ["imbalance", "Imbalance"]];
const VOLS: [string, string][] = [["volume", "Volume"], ["delta", "Buy − sell (delta)"]];
const SORTS: [string, string][] = [["score", "Hotness"], ["signals", "Signals"], ["change5m", "5m move"], ["change24h", "24h move"], ["volumeUsd", "Volume"], ["spreadPct", "Spread"], ["priceGapPct", "Price gap"], ["coin", "Coin"]];
const COLUMNS: [string, string][] = [["coin", "Coin"], ["score", "Hotness"], ["signals", "Signals"], ["change24h", "Price · 24h"], ["change5m", "5m · 1h"], ["volumeUsd", "Volume 24h"],
  ["spreadPct", "Spread · book"], ["priceGapPct", "Exchanges · price gap"]];
const DEFAULT_SUB = "Resting buy orders (teal) and sell orders (pink) on Binance by price, over time. Bright = big orders. Candles = trades in each time slice.";

// With one exchange picked, each row shows that exchange's own numbers.
function view(r: LiqRow, ex: string): LiqRow | null {
  if (ex === "all") return r;
  const v = r.venues.find((x) => x.ex === ex);
  if (!v) return null;
  return { ...r, score: v.score, band: v.band, lead: v.deep ? v.ex : null, price: v.price, change24h: v.change24h, change5m: v.change5m, change1h: v.change1h, volumeUsd: v.volumeUsd,
    spreadPct: v.spreadPct, imbalance: v.imbalance, signals: v.signals.map((s) => ({ ...s, label: SIGNALS.find((x) => x[0] === s.type)?.[1] ?? s.type, venues: [v.ex] })) };
}
const sortVal = (r: LiqRow, k: string): number | string | null => (k === "signals" ? r.signals.length : k === "coin" ? r.coin : ((r as unknown as Record<string, number | null | undefined>)[k] ?? null));
const opts = (list: [string, string][], prefix = "") => list.map(([v, l]) => <option key={v} value={v}>{prefix}{l}</option>);

export default function Liquidity() {
  // ---- choices (the classic tab's localStorage keys) ----
  const [lookbackS, setLookbackS] = useStored("liq:lookback", "30");
  const [preset, setPreset] = useStored("liq:preset", "deep");
  const [side, setSide] = useStored("liq:side", "combined");
  const [vol, setVol] = useStored("liq:vol", "volume");
  const [candlesS, setCandlesS] = useStored("liq:candles", "1");
  const [sort, setSort] = useStored("liq:sort", "score");
  const [dirS, setDirS] = useStored("liq:dir", "-1");
  const [ex, setEx] = useStored("liq:ex", "all");
  const [sig, setSig] = useStored("liq:sig", "all");
  const lookback = Number(lookbackS) || 30, candles = candlesS === "1", dir = Number(dirS) || -1;
  // The stored choices arrive in the effects of the first render: the heatmap starts loading one render later, so its
  // first request already asks for the remembered lookback.
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);

  // ---- screener: /api/liquidity every 15 s ----
  const { data, error } = usePoll<LiquidityApi>("/api/liquidity", 15_000);

  // ---- heatmap: /api/liquidity/heatmap every 4 s while the page is shown ----
  const [hm, setHm] = useState<Heatmap | null>(null);
  const [hmSub, setHmSub] = useState(DEFAULT_SUB);
  const [msg, setMsg] = useState<{ text: string; bad: boolean }>({ text: "", bad: false });
  const [symIn, setSymIn] = useState("");
  const alive = useRef(true), hmBusy = useRef(false);
  const lookbackRef = useRef(lookback); lookbackRef.current = lookback;
  const heatRef = useRef<HTMLElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const loadHeatmap = useCallback(async (force: boolean) => {
    if (hmBusy.current || (!force && document.hidden)) return;
    hmBusy.current = true;
    try {
      const h = await getJson<Heatmap>(`/api/liquidity/heatmap?lookback=${lookbackRef.current}`);
      if (!alive.current) return;
      setHm(h);
      if (h.prices?.length && h.times?.length) setHmSub(`Resting buy orders (teal) and sell orders (pink) on Binance by price, over the last ${h.lookbackMin >= 60 ? h.lookbackMin / 60 + " h" : h.lookbackMin + " min"}. Bright = big orders. Candles = trades in each ${h.bucketMs / 1000}-second slice.`);
    } catch (e) { if (alive.current) setMsg({ text: "Heatmap: " + (e as Error).message, bad: true }); }
    finally { hmBusy.current = false; }
  }, []);
  useEffect(() => {
    if (!ready) return;
    loadHeatmap(true);
    const t = setInterval(() => loadHeatmap(false), 4_000);
    return () => clearInterval(t);
  }, [ready, loadHeatmap]);

  const setSymbol = async (sym: string) => {
    const s = String(sym || "").trim().toUpperCase();
    if (!s) return;
    setMsg({ text: `Switching to ${s}…`, bad: false });
    try {
      const r = await postJson<{ symbol: string }>("/api/liquidity/symbol", { symbol: s });
      if (!alive.current) return;
      setMsg({ text: `Now showing ${r.symbol}. The heatmap fills in as the seconds go by (history starts now).`, bad: false });
      setSymIn(""); loadHeatmap(true);
    } catch (e) { if (alive.current) setMsg({ text: (e as Error).message, bad: true }); }
  };
  const pickLookback = (v: number) => { setLookbackS(String(v)); lookbackRef.current = v; loadHeatmap(true); };
  const onCoin = (coin: string) => { setSymbol(coin + "USDT"); heatRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); };

  // ---- the screener's rows ----
  const all = data?.rows || [];
  const rows = useMemo(() => {
    let out = all.map((r) => view(r, ex)).filter((r): r is LiqRow => !!r);
    if (sig === "any") out = out.filter((r) => r.signals.length);
    else if (sig !== "all") out = out.filter((r) => r.signals.some((s) => s.type === sig));
    return out.sort((a, b) => {
      const x = sortVal(a, sort), y = sortVal(b, sort);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number)) * dir;
    });
  }, [all, ex, sig, sort, dir]);
  const pickSort = (k: string) => { setSort(k); setDirS(k === "coin" ? "1" : "-1"); };
  const clickHead = (k: string) => { if (sort === k) setDirS(String(-dir)); else pickSort(k); };
  const exs = data?.exchanges, okN = (exs || []).filter((x) => x.status === "ok").length;
  const nSig = all.reduce((a, r) => a + r.signals.filter((s) => s.type !== "HOT_MARKET").length, 0);
  const st: HeatStatus = hm?.status || {};

  return (
    <>
      <details className="notice"><summary><b>Read this first:</b> a market scanner across five exchanges plus a live order-book heatmap. It shows where activity and resting orders are; it does not predict price.</summary><div><b>Hotness</b> (0-100) = momentum 25% (5-minute move, 5% = full marks) + volume 25% (last 5 minutes vs the 20 before, 5x = full) + volatility 20% + 24h volume 15% ($100M = full) + order-book imbalance 15%. Cold 0-30, normal 31-60, hot 61-80, extreme 81+. <b>Signals</b>: volume spike (over 3x), pump or dump (over 2% in 5 minutes), volatility expansion (over 2x), wide spread (over 0.15%), book imbalance (over 65% one side, top 20 levels), breakout (beyond the last 20 one-minute candles), hot market (81+). Each exchange&apos;s 15 most traded coins get the full check every 15 to 60 seconds; a coin&apos;s row shows its hottest exchange. <b>Heatmap</b>: resting orders on Binance, in dollars per price band, sampled every second and kept for about 2 hours; bright bands are big resting orders (&quot;walls&quot;). Walls can be pulled at any moment (spoofing), so treat them as context, not support or resistance. Stablecoins and tokenized stocks are left out. Public data, no API keys. The scoring, signal rules and heatmap drawing come from the open-source crypto-liquidity-terminal project (MIT License, Copyright (c) 2026 Crypto Market Screener contributors). Not financial advice.</div></details>
      <ErrorBox>{error ? `Liquidity: ${error}` : null}</ErrorBox>
      <Sec id="screener"><div className="kpis">
        <Kpi label="Coins checked" value={all.length || "—"} hint={data ? `top ${data.perExchange || 15} of each exchange, refreshed every ${Math.round((data.refreshMs || 15000) / 1000)} s` : "top coins of five exchanges"} />
        <Kpi label="Hot or extreme now" value={all.length ? all.filter((r) => (r.score ?? 0) >= 61).length : "—"} hint="hotness 61 or more" cls="amber" />
        <Kpi label="Signals firing" value={all.length ? nSig : "—"} hint={all.length ? `on ${all.filter((r) => r.signals.length).length} coins` : "across all coins"} cls="green" />
        <Kpi label="Exchanges answering" value={exs ? `${okN}/${exs.length}` : "—"} cls={!data ? undefined : exs && okN === exs.length ? "green" : okN ? "amber" : "red"}
          hint={(exs || []).filter((x) => x.status !== "ok").map((x) => `${x.name}: ${x.status}`).join(" · ") || "public APIs, no keys"} />
      </div></Sec>
      <Sec id="heatmap"><section className="panel" style={{ marginBottom: 14 }} ref={heatRef}>
        <div className="section-head"><div><h2>Order-book heatmap · <span>{hm?.symbol || "—"}</span></h2><p>{hmSub}</p></div>
          <span className="chip">{hm ? <><span className={`dot${st.mode === "websocket" && !st.needsResync ? "" : " bad"}`} />
            {st.mode === "websocket" ? (st.needsResync ? "rebuilding book" : "live") : st.mode === "rest" ? "REST polling" : st.mode || "connecting"}
            {st.samples ? ` · ${Math.round((st.historyMs || 0) / 60000)} min history` : ""}</> : "—"}</span></div>
        <div className="lq-controls">
          <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); setSymbol(symIn); }}>
            <input type="text" aria-label="Binance spot pair" placeholder="BTCUSDT" maxLength={20} spellCheck={false} value={symIn} onChange={(e) => setSymIn(e.target.value)} />
            <button className="btn" type="submit">Show</button></form>
          <span className="lq-seg" role="group" aria-label="Lookback">{LOOKBACKS.map(([v, l]) => (
            <button key={v} type="button" className={`btn${v === lookback ? " on" : ""}`} aria-pressed={v === lookback} onClick={() => pickLookback(v)}>{l}</button>))}</span>
          <select aria-label="Heatmap style" value={preset} onChange={(e) => setPreset(e.target.value)}>{opts(PRESETS)}</select>
          <select aria-label="Which side" value={side} onChange={(e) => setSide(e.target.value)}>{opts(SIDES)}</select>
          <select aria-label="Lower panel" value={vol} onChange={(e) => setVol(e.target.value)}>{opts(VOLS)}</select>
          <label className="lq-check"><input type="checkbox" checked={candles} onChange={(e) => setCandlesS(e.target.checked ? "1" : "0")} /> Candles</label>
        </div>
        <div className={`lq-msg${msg.bad ? " bad" : ""}`} hidden={!msg.text}>{msg.text}</div>
        <div className="lq-grid">
          <HeatmapChart hm={hm} preset={preset} side={side} vol={vol} candles={candles} />
          <OrderBook hm={hm} />
        </div>
      </section></Sec>
      <Sec id="screener"><section className="panel">
        <div className="section-head"><div><h2>Hot markets on five exchanges</h2><p>Binance, Bybit, OKX, Coinbase and Kraken spot, one row per coin. Click a coin to see its Binance order book above.</p></div>
          <div className="filters">
            <select aria-label="Exchange" value={ex} onChange={(e) => setEx(e.target.value)}>{opts([["all", "All exchanges"], ...Object.entries(EX_NAMES)])}</select>
            <select aria-label="Signal" value={sig} onChange={(e) => setSig(e.target.value)}>{opts([["all", "All coins"], ["any", "Any signal"], ...SIGNALS])}</select>
            <select aria-label="Sort by" value={sort} onChange={(e) => pickSort(e.target.value)}>{opts(SORTS, "Sort: ")}</select>
            <span className="chip">{data?.updatedAt ? `${rows.length} coins · ${hhmm(data.updatedAt, true)}` : data?.status === "starting" ? "first scan…" : "—"}</span></div></div>
        <div className="table-wrap"><table className="table cards"><thead><tr>
          {COLUMNS.map(([k, l]) => { const on = !!data && k === sort; // the arrow is drawn by CSS, so the column names stay clean for the phone layout
            return <th key={k}><button type="button" className={`lq-sort${on ? " on" : ""}`} data-sort={k} data-dir={on ? (dir > 0 ? "up" : "down") : undefined} onClick={() => clickHead(k)}>{l}</button></th>; })}
        </tr></thead>
          <tbody>{!data ? <tr><td colSpan={8} className="empty">Loading…</td></tr>
            : rows.length ? rows.map((r) => <ScreenerRow key={r.coin} r={r} onCoin={onCoin} />)
            : <tr><td colSpan={8} className="empty">{data.status === "starting" || !data.updatedAt ? "First scan in a few seconds… each exchange's coins fill in over the first minute." : all.length ? "No coin in this view." : data.error || "No data yet."}</td></tr>}</tbody>
        </table></div>
      </section></Sec>
      <Sec id="health"><section className="panel" style={{ marginTop: 14 }}><div className="section-head"><div><h2>Data health</h2><p>Each exchange is read on its own: one that fails or rate-limits is shown here and the others carry on.</p></div></div>
        <div className="source-list">{data && <Health data={data} />}</div></section></Sec>
    </>
  );
}

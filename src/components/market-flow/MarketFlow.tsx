"use client";
// Market Flow Radar (/): the live leaderboard of buying pressure on Binance spot coins, Web3 smart-money signals,
// strong-flow events, data health, the order book of any coin and the AI market brief. Data: GET /api/signals every
// 5 seconds (the engine polls Binance every 30 seconds).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppBar } from "@/components/AppBar";
import { useStored } from "@/components/useStored";
import { getJson, postJson, type AiDeskInfo, type AnalyzeResponse, type FlowCoin, type SignalsResponse } from "@/lib/api";
import { money, pct, price, time } from "@/lib/format";
import { OrderBookModal } from "./OrderBookModal";
import { BriefMeta, BriefText } from "./AiBrief";

const STATE_TABS = [["all", "All"], ["strong", "Strong flow"], ["heating", "Heating up"], ["running", "Already running"], ["take", "AI: TAKE"]] as const;
type StateTab = (typeof STATE_TABS)[number][0];
const STATE_HINTS: Record<string, string> = {
  strong: "Flow score 75+: strong aggressive buying now", heating: "Flow score 45-74: buying building (Watch closely / Developing)",
  running: "Already up 15%+ in 24h or 3%+ in 5 minutes: do not chase", take: "The AI said TAKE in the last 2 hours (AI desk or an alert review)",
};
const SECTIONS = [["board", "Leaderboard"], ["events", "Strong-flow events"], ["health", "Data health"]] as const;
const SORTS: Record<string, (c: FlowCoin) => number | null> = { score: (c) => c.score, buy: (c) => c.buyRatio5m, rv: (c) => c.relativeVolume, chg: (c) => c.change5m, vol: (c) => c.volume24h };
const running = (c: FlowCoin) => (c.change24h ?? 0) >= 15 || c.change5m >= 3;

export function MarketFlow() {
  const [data, setData] = useState<SignalsResponse | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const last = useRef<number | null>(null);
  const [view, setView] = useState<"flow" | "wallets">("flow");
  const [search, setSearch] = useState(""), [minScore, setMinScore] = useState(0), [minVol, setMinVol] = useState(0);
  const [sortBy, setSortBy] = useState("score"), [rowLimit, setRowLimit] = useState(25);
  const [stTab, setStTab] = useStored("st:radar", "all");
  const [sec, setSec] = useStored("sec:radar", "all");
  const [book, setBook] = useState<string | null>(null);
  const closeBook = useCallback(() => setBook(null), []);

  const load = useCallback(async (force = false) => {
    try {
      const next = await getJson<SignalsResponse>("/api/signals");
      setOffline(null);
      if (force || next.lastUpdated !== last.current) { last.current = next.lastUpdated; setData(next); } // skip the redraw when nothing changed
    } catch (e) { setOffline(`Cannot load /api/signals: ${(e as Error).message}`); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const coins = data?.coins || [];
  const aiTake = (sym: string) => data?.aiVerdicts?.[sym.toUpperCase().replace(/USDT$/, "")]?.decision === "TAKE";
  const cats = (c: FlowCoin): Record<string, boolean> => ({ strong: c.label === "Strong flow" && !running(c),
    heating: (c.label === "Watch closely" || c.label === "Developing") && !running(c), running: running(c), take: aiTake(c.symbol) });
  const filtered = useMemo(() => coins.filter((c) => c.symbol.toLowerCase().includes(search.trim().toLowerCase()) && c.score >= minScore && c.volume24h >= minVol),
    [coins, search, minScore, minVol]);
  const counts = useMemo(() => {
    const n: Record<string, number> = { all: filtered.length, strong: 0, heating: 0, running: 0, take: 0 };
    for (const c of filtered) for (const [k, v] of Object.entries(cats(c))) if (v) n[k]++;
    return n;
  }, [filtered, data?.aiVerdicts]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabbed = stTab === "all" ? filtered : filtered.filter((c) => cats(c)[stTab]);
  const key = SORTS[sortBy] || SORTS.score;
  const sorted = [...tabbed].sort((a, b) => (key(b) ?? -Infinity) - (key(a) ?? -Infinity));
  const rows = rowLimit > 0 ? sorted.slice(0, rowLimit) : sorted;

  const live = data?.marketStatus === "connected" || data?.marketStatus === "demo";
  const errors = Object.entries(data?.errors || {});
  const show = (s: string) => sec === "all" || sec === s;

  return (
    <>
      <AppBar active="/" right={<span className="chip"><span className={`dot ${live && !offline ? "" : "bad"}`} />
        {offline ? "Server offline" : data?.demo ? "DEMO DATA" : data?.marketStatus === "connected" ? "Market data connected" : data?.marketStatus === "error" ? "Market data error" : "Connecting…"}</span>} />
      <main className={`wrap${sec !== "all" ? " filtered" : ""}`}>
        <header>
          <div><div className="eyebrow">Market intelligence · Spot only</div><h1>Market Flow Radar</h1>
            <p className="lede">Find unusual trading activity, aggressive buyer/seller imbalance and early momentum changes across liquid Binance USDT spot pairs.</p></div>
          <div className="header-right">
            <AiControls telegramConfigured={!!data?.telegramConfigured} />
            <button className="btn" onClick={() => load(true)}>↻ Refresh</button>
          </div>
        </header>
        <nav className="sectags" aria-label="Sections of this page">
          {[["all", "All"] as const, ...SECTIONS].map(([k, l]) => <button key={k} type="button" className={k === sec ? "on" : undefined} aria-pressed={k === sec} onClick={() => setSec(k)}>{l}</button>)}
        </nav>
        <details className="notice"><summary><b>Signal honesty:</b> Exchange order flow is not proof of smart-money or whale activity.</summary>
          <div>Scores rank observable market conditions; they do not predict returns. Web3 wallet signals are shown separately and may be unavailable if the upstream API blocks access or changes its schema.</div></details>
        {(offline || errors.length > 0) && <div className="error" style={{ display: "block" }}>
          {offline || errors.map(([k, v]) => <div key={k}><b>{k}:</b> {v}</div>)}</div>}

        {show("board") && <>
          <div className="kpis">
            <Kpi label="Pairs monitored" value={data ? coins.length : "—"} hint="Liquid USDT spot pairs" />
            <Kpi label="Strong flow" value={data ? coins.filter((c) => c.score >= 75).length : "—"} hint="Score ≥ 75 / 100" cls="green" />
            <Kpi label="Buy pressure leaders" value={data ? coins.filter((c) => c.buyRatio5m >= 55).length : "—"} hint="5-minute taker buy ratio ≥ 55%" />
            <Kpi label="Last market update" value={time(data?.lastUpdated)} hint={`Refresh every ${Math.round((data?.pollIntervalMs || 30000) / 1000)} seconds`} small />
          </div>
          <section className="panel">
            <div className="section-head"><div><h2>Live flow leaderboard</h2><p>Ranked by transparent 0–100 heuristic, not a buy recommendation</p></div>
              <div className="tabs"><button className={`tab${view === "flow" ? " active" : ""}`} onClick={() => setView("flow")}>Market flow</button>
                <button className={`tab${view === "wallets" ? " active" : ""}`} onClick={() => setView("wallets")}>Web3 signals</button></div></div>
            <div className="section-head" style={{ paddingTop: 0 }}>
              {view === "flow" && <div className="filters">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search coin, e.g. SUI" aria-label="Search coins" />
                <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} aria-label="Minimum score"><option value={0}>All scores</option><option value={45}>Score 45+</option><option value={60}>Score 60+</option><option value={75}>Score 75+</option></select>
                <select value={minVol} onChange={(e) => setMinVol(Number(e.target.value))} aria-label="Minimum 24h volume"><option value={0}>Any 24h volume</option><option value={5e6}>$5M+ volume</option><option value={2e7}>$20M+ volume</option><option value={1e8}>$100M+ volume</option></select>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort pairs by"><option value="score">Sort: flow score</option><option value="buy">Sort: 5m buy ratio</option><option value="rv">Sort: relative volume</option><option value="chg">Sort: 5m price change</option><option value="vol">Sort: 24h volume</option></select>
                <select value={rowLimit} onChange={(e) => setRowLimit(Number(e.target.value))} aria-label="Rows to show"><option value={25}>Show 25</option><option value={50}>Show 50</option><option value={100}>Show 100</option><option value={0}>Show all</option></select>
              </div>}
              <span className="chip">{view === "flow" ? `${rows.length < tabbed.length ? `${rows.length} of ${tabbed.length}` : tabbed.length} pairs` : `${(data?.web3Signals || []).length} signals`}</span>
            </div>
            {view === "flow" && <div className="sttabs" role="tablist" aria-label="Filter pairs">
              {STATE_TABS.map(([k, l]) => <button key={k} type="button" role="tab" data-st={k} className={k === stTab ? "on" : undefined} aria-selected={k === stTab} title={STATE_HINTS[k] || ""} onClick={() => setStTab(k as StateTab)}>{l}<span>{counts[k] ?? 0}</span></button>)}
            </div>}
            <div className="table-wrap">{view === "flow" ? <FlowTable rows={rows} empty={!data ? "Waiting for market data…" : stTab === "all" ? "No pairs match these filters. Try lowering the minimum score or volume." : `Nothing under "${STATE_TABS.find((x) => x[0] === stTab)?.[1]}" right now.`} onBook={setBook} />
              : <WalletTable data={data} />}</div>
          </section>
        </>}

        <div className="lower">
          {show("events") && <section className="panel"><div className="section-head"><div><h2>New strong-flow events</h2><p>Fires when a coin crosses the score threshold</p></div></div>
            <div className="events">{(data?.events || []).length ? data!.events.slice(0, 8).map((e) => (
              <div className="event" key={e.id}><div><strong>{e.symbol} · {e.label}</strong><small>{e.message}</small></div><small className="mono">{time(e.time)}</small></div>
            )) : <div className="empty">No threshold-crossing events yet.</div>}</div></section>}
          {show("health") && <section className="panel"><div className="section-head"><div><h2>Data health</h2><p>See what is connected before trusting a signal</p></div></div>
            <div className="source-list">
              <Source label="Binance Spot candles" cls={data?.marketStatus === "connected" ? "green" : data?.marketStatus === "demo" ? "amber" : "red"} value={data?.marketStatus || "starting"} />
              <Source label="Binance Web3 wallet signals" cls={data?.web3Status === "connected" ? "green" : "amber"} value={data?.web3Status || "not checked"} />
              <Source label="Telegram alerts" value={data?.telegramConfigured ? "Configured" : "Optional · env vars"} />
              <Source label="Last successful update" value={time(data?.lastUpdated)} mono />
            </div></section>}
        </div>
        <div className="foot">How to use: look for multiple confirming signals, inspect the chart and liquidity, and compare activity across timeframes before acting. Relative volume compares the latest 1-minute candle with up to 20 prior closed candles. The newest candle can still be forming. This tool uses public market data and does not place trades. Demo mode is simulated and must never be treated as live market data.</div>
      </main>
      {book && <OrderBookModal symbol={book} onClose={closeBook} />}
    </>
  );
}

function Kpi({ label, value, hint, cls, small }: { label: string; value: string | number; hint: string; cls?: string; small?: boolean }) {
  return <div className="kpi"><div className="label">{label}</div><div className={`value${cls ? ` ${cls}` : ""}`} style={small ? { fontSize: 19 } : undefined}>{value}</div><div className="hint">{hint}</div></div>;
}
function Source({ label, value, cls, mono }: { label: string; value: string; cls?: string; mono?: boolean }) {
  return <div className="source-row"><span>{label}</span><b className={`status-pill${cls ? ` ${cls}` : ""}${mono ? " mono" : ""}`}>{value}</b></div>;
}

function FlowTable({ rows, empty, onBook }: { rows: FlowCoin[]; empty: string; onBook: (s: string) => void }) {
  return (
    <table className="table">
      <thead><tr><th>Pair</th><th>Flow score</th><th>5m taker flow</th><th>Relative volume</th><th>5m price</th><th>24h volume</th><th>Trades / 1m</th><th>Signal</th></tr></thead>
      <tbody>{rows.length ? rows.map((c) => {
        const klass = c.label === "Strong flow" ? "strong" : c.label === "Distribution risk" ? "risk" : c.score >= 60 ? "watch" : "";
        const buy = Number(c.buyRatio5m) || 0, delta = Number(c.change5m) || 0;
        return (
          <tr key={c.symbol}>
            <td><button className="coin-link sym" onClick={() => onBook(c.symbol)} title="Open spot order book">{c.symbol.replace("USDT", "")} ↗</button><span className="sub">USDT spot · click for order book</span></td>
            <td><span className="score mono">{c.score}<span className="scorebar"><i style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} /></span></span></td>
            <td><span className={`mono ${buy >= 55 ? "green" : buy < 48 ? "red" : ""}`}>{buy.toFixed(1)}% buy</span><div className="buybar"><i style={{ width: `${Math.max(0, Math.min(100, buy))}%` }} /></div><span className="sub">Net {money(c.netFlow5m)}</span></td>
            <td className={`mono ${(c.relativeVolume ?? 0) >= 2 ? "green" : ""}`}>{c.relativeVolume == null ? "—" : `${c.relativeVolume.toFixed(2)}×`}<span className="sub">vs prior 20 candles</span></td>
            <td className={`mono ${delta > 0 ? "green" : delta < 0 ? "red" : ""}`}>{pct(delta)}<span className="sub">{price(c.price)}</span></td>
            <td className="mono">{money(c.volume24h)}</td><td className="mono">{Number(c.trades1m || 0).toLocaleString()}</td>
            <td><span className={`badge ${klass}`}>{c.label}</span><span className="sub">{(c.reasons || []).slice(0, 2).join(" · ")}</span></td>
          </tr>
        );
      }) : <tr><td colSpan={8} className="empty">{empty}</td></tr>}</tbody>
    </table>
  );
}

function WalletTable({ data }: { data: SignalsResponse | null }) {
  const rows = data?.web3Signals || [];
  return (
    <table className="table">
      <thead><tr><th>Token</th><th>Chain</th><th>Direction</th><th>Wallet count</th><th>Exit rate</th><th>Time</th><th>Contract</th></tr></thead>
      <tbody>{rows.length ? rows.map((s) => (
        <tr key={s.id}><td><span className="sym">{s.ticker}</span></td><td>{s.chain}</td>
          <td><span className={`badge ${s.direction === "buy" ? "strong" : s.direction === "sell" ? "risk" : ""}`}>{s.direction}</span></td>
          <td className="mono">{s.wallets ?? "—"}</td><td className="mono">{s.exitRate == null ? "—" : `${Math.round(s.exitRate)}%`}</td>
          <td className="mono">{time(s.time)}</td><td className="mono">{s.address ? `${s.address.slice(0, 7)}…${s.address.slice(-5)}` : "—"}</td></tr>
      )) : <tr><td colSpan={7} className="empty">No validated Web3 signals currently available. Check Data health for API errors; no wallet activity is being invented.</td></tr>}</tbody>
    </table>
  );
}

// ✨ AI Analysis: the model picker (the AI's own models: Gemini, or the free open model), risk review, Telegram.
function AiControls({ telegramConfigured }: { telegramConfigured: boolean }) {
  const [models, setModels] = useState<AiDeskInfo["models"] | null>(null);
  const [model, setModel] = useState(""), [deep, setDeep] = useState(false), [tg, setTg] = useState(true);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => { getJson<AiDeskInfo>("/api/ai/candidates").then((d) => { setModels(d.models); setModel(d.models.analyst); }).catch(() => {}); }, []);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); }; document.addEventListener("keydown", k); return () => document.removeEventListener("keydown", k); }, [open]);
  const run = async () => {
    setOpen(true);
    if (busy) return; // a run is already in progress
    setBusy(true); setResult(null); setError(null);
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 120_000);
    try { setResult(await postJson<AnalyzeResponse>("/api/analyze", { model, mode: deep ? "deep" : "fast", notify: tg && telegramConfigured }, { signal: ctrl.signal })); }
    catch (e) { setError((e as Error).name === "AbortError" ? "The analysis timed out after 120 seconds. Try fast mode." : (e as Error).message); }
    finally { clearTimeout(timer); setBusy(false); }
  };
  return (
    <>
      <select value={model} onChange={(e) => setModel(e.target.value)} title="Model for the analyst stage" style={{ padding: 8, fontSize: 12 }}>
        {models ? <><option value={models.analyst}>{models.analyst} (fast)</option>{models.reviewer !== models.analyst && <option value={models.reviewer}>{models.reviewer} (accurate)</option>}</> : <option value="">AI model…</option>}
      </select>
      <label title="Verifies top candidates with order-book and wallet checks, then adds an independent risk review. Slower and uses more API calls." style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
        <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} /> risk review</label>
      <label title={telegramConfigured ? "Also send the finished brief to your Telegram chat" : "Telegram isn't configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env."} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 5, cursor: "pointer", opacity: telegramConfigured ? 1 : 0.5 }}>
        <input type="checkbox" checked={tg} disabled={!telegramConfigured} onChange={(e) => setTg(e.target.checked)} /> Send to Telegram</label>
      <button className="btn" onClick={run} disabled={busy && !open} style={{ color: "var(--blue)", borderColor: "var(--blue)" }}>{busy ? (deep ? "Analyzing (deep)…" : "Analyzing…") : "✨ AI Analysis"}</button>
      {open && <div className="modal-backdrop open" role="dialog" aria-modal="true" aria-labelledby="aiTitle" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
        <section className="modal" style={{ maxWidth: 760 }}>
          <div className="modal-head"><div><div className="eyebrow">AI agent</div><h2 id="aiTitle">AI Market Brief</h2></div><button className="btn" onClick={() => setOpen(false)} aria-label="Close AI brief">✕</button></div>
          <div style={{ padding: 20, lineHeight: 1.6 }} id="aiContent" aria-live="polite">
            {error ? <span className="red">Error: {error}</span> : result ? <><BriefText text={result.analysis || ""} /><BriefMeta meta={result.meta} telegram={result.telegram} /></>
              : deep ? <><p>Running deep analysis…</p><p className="muted">1. Verifying top candidates (order book, wallet signals)<br />2. Writing the brief<br />3. Independent risk review<br /><br />This usually takes 20–60 seconds.</p></>
              : <p>Analyzing current market flow…</p>}
          </div>
        </section>
      </div>}
    </>
  );
}

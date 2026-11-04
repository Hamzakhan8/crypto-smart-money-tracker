"use client";
// AI Trade Desk (/ai): pick a coin the ignition screener flagged and an AI committee (data analyst, news researcher,
// bull, bear, trader, Final Boss) decides YES, WATCH or NO, with code checks on every plan. Data: GET /api/ai/candidates
// every 20 seconds, GET /api/ai/record every 60 seconds; an analysis streams each member's progress (POST /api/ai/analyze).
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AppBar } from "@/components/AppBar";
import { useStored } from "@/components/useStored";
import { getJson, postJson } from "@/lib/api";
import { postStream, type AiCoin, type Analysis, type BatchResponse, type CandidatesResponse, type Dossier, type LiveRate, type RecordResponse, type StepEvent } from "@/lib/ai-desk";
import { BatchView } from "./Batch";
import { DossierJson, Facts } from "./Facts";
import { ProgressView, type Progress, type Timeline } from "./Progress";
import { RecordView, UsageChip } from "./Record";
import { ResultView } from "./Result";
import { ago, arr, col, lbl, num, pct, price, Safe, secs, tx } from "./ui";
import s from "./AiDesk.module.css";

const SECTIONS = [["coins", "Ignition coins"], ["analysis", "Analysis"], ["record", "Track record"]] as const;
const STATE_TABS = [["all", "All"], ["strong", "Strong flow"], ["heating", "Heating up"], ["running", "Already running"], ["take", "AI: TAKE"]] as const;
const STATE_HINTS: Record<string, string> = {
  strong: "Igniting now (early or confirmed)", heating: "Volume building, not igniting yet", running: "Already ran: do not chase",
  take: "The AI said TAKE (the AI desk or an alert review) in the last 2 hours",
};
const cats = (x: AiCoin): Record<string, boolean> => ({ strong: x.state === "ignited" && !x.moved, heating: x.state === "heating" && !x.moved,
  running: x.state === "ran" || !!x.moved, take: !!(x.last && x.last.decision === "TAKE") });
const TG_ON = "Send the decision to your Telegram", TG_OFF = "Telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID in .env)";
const START_TITLE = "Analysis", START_SUB = "Choose a coin on the left, or analyze all of them at once.";

/** What the Analysis panel shows. */
type View =
  | { kind: "empty" } | { kind: "loading"; text: string } | { kind: "progress" }
  | { kind: "result"; x: Analysis; timeline: Timeline | null } | { kind: "error"; message: string; timeline?: Timeline | null }
  | { kind: "batch"; b: BatchResponse } | { kind: "dossier"; d: Dossier };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AiDesk() {
  const [cand, setCand] = useState<CandidatesResponse | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (v: boolean) => { busyRef.current = v; setBusyState(v); };
  const [selected, setSelected] = useState<string | null>(null);
  // the model picker: the AI's own two models from /api/ai/candidates (Gemini or a free open model), filled once
  const [models, setModels] = useState<{ list: string[]; analyst: string } | null>(null);
  const [model, setModel] = useState("");
  const [news, setNews] = useState(true), [debate, setDebate] = useState(true), [notify, setNotify] = useState(false);
  const [symInput, setSymInput] = useState("");
  const [secRaw, setSec] = useStored("sec:ai", "all");
  const sec = SECTIONS.some(([k]) => k === secRaw) ? secRaw : "all";
  const [stRaw, setStTab] = useStored("st:aicoins", "all");
  const stTab = STATE_TABS.some(([k]) => k === stRaw) ? stRaw : "all";
  const [title, setTitle] = useState(START_TITLE), [sub, setSub] = useState(START_SUB);
  const [view, setViewState] = useState<View & { n: number }>({ kind: "empty", n: 0 });
  const seq = useRef(0);
  const setView = (v: View) => setViewState({ ...v, n: ++seq.current });
  const [rec, setRec] = useState<RecordResponse | null>(null), [recErr, setRecErr] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Set<string>>(() => new Set());
  // live progress of the running analysis (redrawn every second and on every step)
  const prog = useRef<Progress | null>(null), progTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, setTick] = useState(0);
  const barRef = useRef<HTMLElement>(null);

  const modelsFilled = useRef(false);
  const loadCandidates = useCallback(async () => {
    try {
      const c = await getJson<CandidatesResponse>("/api/ai/candidates");
      setCand(c); setOffline(null);
      if (!modelsFilled.current && c.models) { // the first one (the analyst) is the default
        modelsFilled.current = true;
        const list = [...new Set([c.models.analyst, c.models.reviewer])];
        setModels({ list, analyst: c.models.analyst }); setModel(list[0]);
      }
    } catch (e) { setOffline(`Cannot load /api/ai/candidates: ${msg(e)}`); }
  }, []);
  const loadRecord = useCallback(async () => {
    try { setRec(await getJson<RecordResponse>("/api/ai/record")); setRecErr(null); }
    catch (e) { setRecErr(msg(e)); }
  }, []);
  useEffect(() => { loadCandidates(); const t = setInterval(() => { if (!busyRef.current) loadCandidates(); }, 20000); return () => clearInterval(t); }, [loadCandidates]);
  useEffect(() => { loadRecord(); const t = setInterval(loadRecord, 60000); return () => clearInterval(t); }, [loadRecord]);
  useEffect(() => () => { if (progTimer.current) clearInterval(progTimer.current); }, []);
  // the section tags stick right under the app bar
  useEffect(() => {
    const stick = () => { if (barRef.current) barRef.current.style.top = `${(document.querySelector(".appbar") as HTMLElement | null)?.offsetHeight || 52}px`; };
    stick(); window.addEventListener("resize", stick); return () => window.removeEventListener("resize", stick);
  }, []);

  const configured = !!cand?.configured;
  const notifyDisabled = cand ? !cand.telegramConfigured : false;
  const opts = () => ({ model: model || undefined, news, debate, notify: notify && !notifyDisabled });

  // ---------- live progress: which committee member is working ----------
  const startProgress = (newsOn: boolean, debateOn: boolean) => {
    const st: Progress["st"] = {};
    if (!newsOn) st.news = { status: "skipped", detail: "news search switched off" };
    if (!debateOn) st.bull = st.bear = { status: "skipped", detail: "debate switched off" };
    prog.current = { t0: Date.now(), st };
    if (progTimer.current) clearInterval(progTimer.current);
    progTimer.current = setInterval(() => setTick((t) => t + 1), 1000);
    setView({ kind: "progress" });
  };
  const onStep = (e: StepEvent) => {
    const p = prog.current;
    if (!p) return;
    const cur = p.st[e.id] || { status: "waiting" }, now = Date.now();
    p.st[e.id] = { status: e.status, detail: e.detail || cur.detail || "", since: e.status === "working" ? (cur.status === "working" ? cur.since : now) : cur.since,
      end: e.status === "working" ? null : now };
    setTick((t) => t + 1);
  };
  const stopProgress = (): Timeline | null => {
    const p = prog.current, now = Date.now();
    if (progTimer.current) clearInterval(progTimer.current);
    progTimer.current = null; prog.current = null;
    return p ? { prog: { t0: p.t0, st: { ...p.st } }, now, total: secs(now - p.t0) } : null;
  };

  const loading = (t: string, text: string) => {
    setBusy(true);
    if (sec !== "all" && sec !== "analysis") setSec("all"); // show the Analysis panel
    setTitle(t); setSub(text); setView({ kind: "loading", text });
  };
  const analyze = async (symbol: string) => {
    setSelected(symbol);
    loading(symbol, "The AI committee is working (about 1-2 minutes). Each member's progress is shown below.");
    startProgress(news, debate);
    try {
      const x = await postStream<Analysis>("/api/ai/analyze", { symbol, ...opts() }, onStep), tl = stopProgress();
      setTitle(x.symbol);
      setSub(x.meta?.cached ? `Saved result from ${ago(x.meta.at)} (re-run with Analyze after 3 minutes)` : "Fresh analysis");
      setView({ kind: "result", x, timeline: x.meta?.cached ? null : tl });
    } catch (e) { setView({ kind: "error", message: msg(e), timeline: stopProgress() }); }
    finally { if (prog.current) stopProgress(); setBusy(false); loadCandidates(); loadRecord(); }
  };
  const analyzeAll = async () => {
    setSelected(null);
    loading("All ignition coins", "Gathering data for each coin and triaging them in one AI request…");
    try {
      const b = await postJson<BatchResponse>("/api/ai/analyze-all", { limit: 8, ...opts() });
      setTitle("All ignition coins");
      setSub((b.meta?.cached ? `Saved result from ${ago(b.meta.at)}` : "Fresh triage") + (b.meta?.model ? ` · ${b.meta.model}` : ""));
      setView({ kind: "batch", b });
    } catch (e) { setView({ kind: "error", message: msg(e) }); }
    finally { setBusy(false); loadCandidates(); }
  };
  const dataOnly = async (symbol: string) => {
    setSelected(symbol);
    loading(symbol, "Gathering market data (no AI)…");
    try {
      const d = await getJson<Dossier>(`/api/ai/dossier?symbol=${encodeURIComponent(symbol)}`);
      setSub("Facts only: nothing was sent to the AI.");
      setView({ kind: "dossier", d });
    } catch (e) { setView({ kind: "error", message: msg(e) }); }
    finally { setBusy(false); }
  };
  /** A coin's Analyze / Full analysis button: the committee, or its data only while the AI is not set up. */
  const onAnalyze = (symbol: string) => { if (busyRef.current) return; if (!cand?.configured) dataOnly(symbol); else analyze(symbol); };
  const typed = () => symInput.trim().toUpperCase().replace(/USDT$/, "");
  const onSubmit = (e: FormEvent) => { e.preventDefault(); const sym = typed(); if (!sym || busyRef.current) return; if (!cand?.configured) dataOnly(`${sym}USDT`); else analyze(`${sym}USDT`); };
  const onDataOnly = () => { const sym = typed(); if (sym && !busyRef.current) dataOnly(`${sym}USDT`); };
  const cancelTrigger = async (id: string) => {
    setCancelling((c) => new Set(c).add(id));
    try { setRec(await postJson<RecordResponse>("/api/ai/triggers/cancel", { id })); setRecErr(null); }
    catch (err) { alert(msg(err)); }
    finally { setCancelling((c) => { const n = new Set(c); n.delete(id); return n; }); }
  };
  const pickSection = (k: string) => {
    setSec(k);
    requestAnimationFrame(() => {
      const bar = barRef.current, appbar = (document.querySelector(".appbar") as HTMLElement | null)?.offsetHeight || 52;
      if (!bar) return;
      const top = bar.getBoundingClientRect().top + window.scrollY - appbar - 14;
      if (window.scrollY > top) window.scrollTo({ top, behavior: "smooth" });
    });
  };

  // ---------- the coin list ----------
  const list0 = arr(cand?.coins);
  const counts: Record<string, number> = { all: list0.length, strong: 0, heating: 0, running: 0, take: 0 };
  for (const x of list0) for (const [k, v] of Object.entries(cats(x))) if (v) counts[k]++;
  const list = stTab === "all" ? list0 : list0.filter((x) => cats(x)[stTab]);
  const canAll = Math.min(8, list0.filter((x) => !x.moved && (x.state === "ignited" || x.state === "heating")).length);
  const show = (k: string) => sec === "all" || sec === k;

  const m: NonNullable<CandidatesResponse["market"]> = cand?.market || {};
  const rep: NonNullable<NonNullable<CandidatesResponse["baseRates"]>["replay"]> = cand?.baseRates?.replay || {};
  const live: Record<string, LiveRate | null | undefined> = cand?.baseRates?.live || {};
  const liveTxt = (b: LiveRate | null | undefined, n: string): ReactNode => b && b.resolved
    ? <>{n} <b>{num(b.profitablePct ?? b.winRatePct, 0)}%</b> in profit of {b.resolved}</> : `${n} no resolved alerts yet`;

  let result: ReactNode;
  const v = view;
  if (v.kind === "empty") result = <div className="empty">No analysis yet.<br />Each analysis is an AI committee: 6 AI requests with the debate (4 without), the last one the Final Boss&apos;s audit. Results are kept for 3 minutes.</div>;
  else if (v.kind === "loading") result = <div className="empty"><span className="spin" />{v.text}</div>;
  else if (v.kind === "progress") result = prog.current ? <ProgressView prog={prog.current} now={Date.now()} /> : null;
  else if (v.kind === "result") result = <ResultView x={v.x} timeline={v.timeline} />;
  else if (v.kind === "error") result = <><div className="callout red">{v.message}</div>{v.timeline && <ProgressView prog={v.timeline.prog} now={v.timeline.now} />}</>;
  else if (v.kind === "batch") result = <BatchView b={v.b} onAnalyze={onAnalyze} />;
  else result = <><Facts d={v.d} /><DossierJson d={v.d} open /></>;

  return (
    <div className={s.page}>
      <AppBar active="/ai" right={<span className="chip"><span className={`dot${offline || cand?.screenerStatus === "error" ? " bad" : ""}`} />
        {offline ? "Server offline" : !cand ? "Connecting…" : cand.demo ? "Screener: DEMO data" : `Screener: ${cand.screenerStatus || "starting"}`}</span>} />
      <main className={`${s.desk} wrap${sec !== "all" ? " filtered" : ""}`}>
        <header>
          <div><div className="eyebrow">AI committee · screener signals · live market data</div><h1>AI Trade Desk</h1>
            <p className="lede">Pick a coin the ignition screener flagged. The desk gathers everything that matters about it (the signal, Market Flow taker data, 15m / 1h / 4h chart, support and resistance, order book, futures positioning, whale and DEX flows, smart-money wallets, BTC) and hands it to an AI committee: a <b>data analyst</b> checks the numbers, a <b>news researcher</b> searches the web, a <b>bull</b> and a <b>bear</b> argue for and against, a <b>trader</b> decides, and the <b>Final Boss</b> audits all of it and answers <b>YES, WATCH or NO</b>. Code checks every plan and overrides calls that break the rules.</p></div>
        </header>
        <nav className="sectags" ref={barRef} aria-label="Sections of this page">
          {[["all", "All"] as const, ...SECTIONS].map(([k, l]) => <button key={k} type="button" className={k === sec ? "on" : undefined} aria-pressed={k === sec} onClick={() => pickSection(k)}>{l}</button>)}
        </nav>
        {cand && !cand.configured && <div className="notice"><b>The AI is not set up.</b> Add <span className="mono">GEMINI_API_KEY=your_key</span> to the <span className="mono">.env</span> file in the project folder, or a free open-source model (<span className="mono">AI_PROVIDER=ollama</span>, or a free <span className="mono">GROQ_API_KEY</span>: see the README), and restart the app. You can still open any coin&apos;s data with &quot;Data only&quot;.</div>}
        {offline && <div className="error" style={{ display: "block" }}>{offline}</div>}
        <div className="strip">{cand && <>
          <span>BTC <b className={col(m.btc1hPct)}>{pct(m.btc1hPct)}</b> 1h · <b className={col(m.btc4hPct)}>{pct(m.btc4hPct)}</b> 4h · <b className={col(m.btcChange24hPct)}>{pct(m.btcChange24hPct)}</b> 24h</span>
          {m.marketWide && <span className="amber">Market-wide surge: signals are less token-specific</span>}
          {rep.confirmed && <span title={`${tx(rep.source)} · ${tx(rep.rule)}`}>Replay: confirmed hit target <b>{tx(rep.confirmed.hitTargetPct)}%</b>, stop <b>{tx(rep.confirmed.hitStopPct)}%</b>, avg <b>{pct(rep.confirmed.avgNetPct, 2)}</b> · early avg <b>{pct(rep.early?.avgNetPct, 2)}</b></span>}
          <span>Live: {liveTxt(live.ignition, "confirmed")} · {liveTxt(live.early, "early")}</span>
        </>}</div>
        <div className="strip">
          <label className="check">Model <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models?.list.map((x) => <option key={x} value={x}>{x}{x === models.analyst ? " (default)" : ""}</option>)}</select></label>
          <label className="check" title="The news researcher searches the web (Google) for news and events about the coin: delistings, hacks, unlocks, listings. Turn off to save one request per analysis.">
            <input type="checkbox" checked={news} onChange={(e) => setNews(e.target.checked)} /> news search</label>
          <label className="check" title="A bull argues for the trade, then a bear attacks it; the trader judges the debate. Two more requests per analysis, about 15 seconds.">
            <input type="checkbox" checked={debate} onChange={(e) => setDebate(e.target.checked)} /> bull vs bear debate</label>
          <label className="check" title={cand && !cand.telegramConfigured ? TG_OFF : TG_ON}>
            <input type="checkbox" checked={notify} disabled={notifyDisabled} onChange={(e) => setNotify(e.target.checked)} /> send to Telegram</label>
        </div>

        {(show("coins") || show("analysis")) && <div className="grid">
          {show("coins") && <section className="panel">
            <div className="section-head"><div><h2>Ignition coins</h2>
              <p>{cand ? `${list0.filter((x) => x.state === "ignited").length} igniting, ${list0.filter((x) => x.state === "heating").length} heating up. Refreshes every 20 seconds.` : "Igniting first, then heating up. Refreshes every 20 seconds."}</p></div>
              <button className="btn primary" disabled={busy || !configured} onClick={() => { if (!busyRef.current) analyzeAll(); }}>{cand ? `Analyze all (${canAll})` : "Analyze all"}</button></div>
            <form className="anyrow" onSubmit={onSubmit}>
              <input name="sym" value={symInput} onChange={(e) => setSymInput(e.target.value)} placeholder="Any coin, e.g. SOL" aria-label="Coin symbol" required />
              <button className="btn" type="submit">Analyze</button>
              <button className="btn" type="button" title="Show the facts without calling the AI" onClick={onDataOnly}>Data only</button>
            </form>
            <div className="sttabs" role="tablist" aria-label="Filter coins">
              {cand && STATE_TABS.map(([k, l]) => <button key={k} type="button" role="tab" data-st={k} className={k === stTab ? "on" : undefined} aria-selected={k === stTab}
                title={STATE_HINTS[k] || ""} onClick={() => setStTab(k)}>{l}<span>{counts[k]}</span></button>)}
            </div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Coin</th><th>Signal</th><th>Move</th><th>AI</th><th></th></tr></thead>
              <tbody>{!cand ? <tr><td colSpan={5} className="empty">Loading…</td></tr>
                : list.length ? list.map((x) => <CoinRow key={x.symbol} x={x} selected={selected === x.symbol} disabled={busy || !configured} onAnalyze={onAnalyze} />)
                : <tr><td colSpan={5} className="empty">{stTab === "all" ? <>No igniting or heating coins right now.<br />The screener checks every 20 seconds; you can still analyze any coin above.</>
                  : `Nothing under "${STATE_TABS.find((x) => x[0] === stTab)?.[1]}" right now.`}</td></tr>}</tbody>
            </table></div>
          </section>}
          {show("analysis") && <section className="panel">
            <div className="section-head"><div><h2>{title}</h2><p>{sub}</p></div></div>
            <div className="result"><Safe key={view.n}>{result}</Safe></div>
          </section>}
        </div>}
        {show("record") && <section className="panel" style={{ marginTop: 14 }}>
          <div className="section-head"><div><h2>AI track record</h2><p>Every AI answer is followed like a trade with its own plan: bought at the price of the answer, closed at its stop, its target or the end of its holding time, after costs. NO answers are followed too (&quot;if bought anyway&quot;), so you can see whose no was right. The committee sees this record in its prompts.</p></div>
            <UsageChip rec={rec} /></div>
          <div className="result">
            {recErr ? <div className="callout red">Cannot load the AI track record: {recErr}</div>
              : rec ? <Safe><RecordView rec={rec} cancelling={cancelling} onCancel={cancelTrigger} /></Safe> : <div className="empty">Loading…</div>}
          </div>
        </section>}
        {sec === "all" && <div className="foot">How it decides: code first builds a dossier from live data and computes every number (trend, ATR, support and resistance, reward:risk, order-book depth, futures crowding, exchange flows). Then the AI members work in turn: the data analyst reports data quality, evidence and red flags; the news researcher searches the web for delistings, hacks, unlocks and listings (with sources); the bull makes the case for the trade and the bear attacks it; the trader decides as the referee, with deep thinking, under rules that include how often this kind of signal won in the past; and the Final Boss (a stronger model) audits the whole committee on every analysis: hard stops, reward:risk to the tested target (levels above are hurdles, not caps), expected value with time-outs, probability adjustments, contradictions and missing data. It answers YES, WATCH (with measurable triggers and an expiry) or NO, with a corrected plan and a position size, and can overturn the trader either way. Code still checks every YES and turns it into WATCH unless: no hard stop (the code&apos;s own, a confirmed bad news item, or one the boss listed), the coin is igniting now and has not already run, the plan fits the price, realistic reward:risk (target capped at the nearest resistance) is 2 or more, and expected value after costs is +0.5% or more per trade with the boss&apos;s chances held within 15 points of the base rate. Confidence is capped for early signals, demo data and weak markets. If the boss cannot answer, there is no YES. Long only, no leverage, risk at most 1% of your account per trade. This is an AI opinion on data, not financial advice.</div>}
      </main>
    </div>
  );
}

function CoinRow({ x, selected, disabled, onAnalyze }: { x: AiCoin; selected: boolean; disabled: boolean; onAnalyze: (symbol: string) => void }) {
  const tag = x.state === "ignited" ? <span className={`badge ${x.tier}`}>{x.tier === "confirmed" ? "Confirmed" : "Early"}</span>
    : x.state === "ran" ? <span className="badge ran">Already ran</span> : <span className="badge heating">Heating</span>;
  const missing = arr(x.missing);
  return (
    <tr className={selected ? "sel" : undefined}>
      <td><b>{x.base}</b> {tag}<span className="sub">{price(x.price)}{x.narrative ? ` · ${x.narrative}` : ""}{x.igScore != null ? ` · score ${x.igScore}` : ""}</span></td>
      <td className="mono">{x.r5 != null ? `5m ${num(x.prevR5, 1)}× → ${num(x.r5, 1)}×` : `15m ${num(x.rvol15, 1)}×`}<span className="sub">buyers {num(x.buy10, 0)}% · RSI {num(x.rsi, 0)}</span>
        {x.state === "heating" && missing.length > 0 && <span className="sub amber">needs: {missing.join(", ")}</span>}
        {!!x.moved && <span className="sub red">{arr(x.movedWhy).join(", ")}</span>}</td>
      <td className="mono"><span className={col(x.ret10m)}>{pct(x.ret10m)}</span> 10m<span className="sub">{pct(x.change24h)} 24h</span></td>
      <td>{x.last ? <><span className={`dec ${x.last.decision}`}>{lbl(x.last.decision)}</span><span className="sub">{tx(x.last.confidence)} · {ago(x.last.at)}</span></> : <span className="muted">—</span>}</td>
      <td><button className="btn sm" disabled={disabled} onClick={() => onAnalyze(x.symbol)}>Analyze</button></td>
    </tr>
  );
}

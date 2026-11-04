"use client";
// Perps swing signals (the classic page's drawP): the KPIs, the signal list and its card, Check a trade, the risk
// settings, the coins scanned, live results, the backtest and data health. Data: /api/perps (index.tsx polls it).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment, type FormEvent, type ReactNode, type RefObject } from "react";
import { time } from "@/lib/format";
import { Kpi, SourceRow } from "../ui";
import { PCard } from "./Card";
import { PSETUP, RISK_FIELDS, Side, Vd, dt, pPx, pR, pRecord, type PerpsData, type Risk, type RiskInputs, type RiskKey } from "./lib";

export function PerpsNotice() {
  return (
    <details className="notice"><summary><b>Read this first:</b> perpetual futures use leverage, and a wrong trade can cost far more than on spot, fast. These signals come from setups tested on 4.8 years of Binance history after fees and every funding payment. One has passed every test (the A+ weak-coin breakdown short); start small anyway and let the live results below build up.</summary>
      <div><b>TAKE</b> = an <b>A+ setup</b> whose own record passed every test (made money before 2025 and in 2025-26, 100+ trades, not from 2-3 coins) on a coin that is not wildly volatile. Today that is the <b>weak-coin breakdown short</b>: a 20-day breakdown on volume while the coin is in its own daily downtrend and BTC is in a daily uptrend (+0.73R per trade, positive every year 2022-2026). Its exit: target at 4x the risk, or the stop, or 14 days. <b>WAIT</b> = a tested setup fired, but it has not passed every test (for example the short-squeeze breakout long: good on average, but in 2025-26 most of its profit came from 3 coins). <b>SKIP</b> = the setup (or this kind of trade) lost money in the test, or two conditions that hurt are met. Other signals use the base exit: 2.5x the risk, the stop, or 10 days. Only TAKE goes to Telegram. Size every trade from your risk (settings below), use isolated margin, and keep the liquidation price well beyond the stop. Several signals at once usually means one market move: take at most your maximum open positions. Research, not financial advice.</div></details>
  );
}

export function SwingKpis({ d, rk }: { d: PerpsData | null; rk: Risk }) {
  const sig: any[] = d?.signals || [], open = sig.filter((x) => x.track?.status === "open"), take = open.filter((x) => x.verdict === "TAKE").length;
  return (
    <div className="kpis">
      <Kpi label="Open signals" value={d ? open.length : "—"} hint={d ? `${sig.length} signals so far` : "being followed"} />
      <Kpi label="TAKE now" cls="green" value={d ? take : "—"} hint={d && take > rk.max ? `more than your ${rk.max} max positions: pick` : "open signals with TAKE"} />
      <Kpi label="BTC trend" cls={d?.btc === "up" ? "green" : d?.btc === "down" ? "red" : undefined} value={d?.btc || "—"} hint="daily close vs 50-day average" />
      <Kpi label="Last scan" value={d?.updatedAt ? time(d.updatedAt) : d?.demo ? "demo" : "—"} hint={d?.nextScanAt ? `next ${time(d.nextScanAt)}` : "after each 4h close"} />
    </div>
  );
}

/** A signal as a card: its headline, funding over the hold and its backtest record (the classic page's sigCard). */
function sigCard(pd: PerpsData, x: any) {
  const dir = x.dir, f8 = x.fund8h, perDay = f8 != null ? -dir * f8 * 3 : null, riskPct = x.riskPct;
  return { ...x, headline: `${PSETUP[x.setup] || x.setup} on the ${new Date(x.t + 4 * 3600000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} 4h close`, at: x.at, btc: x.f?.btc,
    risk: { entry: x.price, stop: x.stop, target: x.target, tp: x.tp ?? 2.5, holdDays: x.holdDays ?? 10, riskPct, stopSource: "signal", fund8h: f8 != null ? +f8.toFixed(4) : null,
      funding10dPct: perDay != null ? +(perDay * 10).toFixed(2) : null, funding10dR: perDay != null && riskPct ? +(perDay * 10 / riskPct).toFixed(2) : null, costPct: 2 * (pd.costPctPerSide ?? 0.08) },
    record: pRecord(pd, x.setup, x.side) };
}

export function SignalsPanel({ d, rk, view, setView, sel, onPick, cardRef }: {
  d: PerpsData | null; rk: Risk; view: string; setView: (v: string) => void; sel: string | null; onPick: (id: string) => void; cardRef: RefObject<HTMLDivElement | null>;
}) {
  const sig: any[] = d?.signals || [], open = sig.filter((x) => x.track?.status === "open");
  const tabs: [string, string, number][] = [["all", "All", sig.length], ["TAKE", "TAKE", sig.filter((x) => x.verdict === "TAKE").length], ["WAIT", "WAIT", sig.filter((x) => x.verdict === "WAIT").length],
    ["SKIP", "SKIP", sig.filter((x) => x.verdict === "SKIP").length], ["open", "Open", open.length], ["closed", "Closed", sig.length - open.length]];
  const rows = sig.filter((x) => view === "all" || (view === "open" ? x.track?.status === "open" : view === "closed" ? x.track?.status !== "open" : x.verdict === view));
  const picked = d ? sig.find((y) => y.id === sel) : null;
  return (
    <section className="panel">
      <div className="section-head"><div><h2>Signals</h2><p>Found on each closed 4h candle with the tested rules: 20-day breakouts (long and short) and crowded fades. <b>A+</b> = the version that passed the test (TAKE; target 4R, 14 days). Click a row for its card.</p></div>
        <span className="chip">{d?.coins ? `${d.coins} coins · ${d.liveSetups?.map((k: string) => PSETUP[k]).join(", ")} · A+: ${Object.keys(d.aplus || {}).map((k) => PSETUP[k] || k).join(", ")}` : "—"}</span></div>
      <div className="sttabs">{d && tabs.map(([k, l, n]) => <button key={k} type="button" data-pv={k} className={k === view ? "on" : undefined} onClick={() => setView(k)}>{l}<span>{n}</span></button>)}</div>
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Signal</th><th>Coin</th><th>Setup</th><th>Verdict</th><th>Entry · stop · target</th><th>Now</th><th>Result</th></tr></thead>
        <tbody>{!d ? <tr><td colSpan={7} className="empty">Loading…</td></tr> : rows.length ? rows.slice(0, 60).map((x) => {
          const t = x.track || {};
          const res = t.status === "closed" ? <><b className={t.r > 0 ? "green" : "red"}>{pR(t.r)}</b><span className="sub">{`${t.why || ""} · ${t.netPct > 0 ? "+" : ""}${t.netPct}%`}</span></> : <span className="muted">open</span>;
          return (
            <tr key={x.id} className={x.id === sel ? "sel" : undefined} data-psig={x.id} style={{ cursor: "pointer" }} onClick={() => onPick(x.id)}>
              <td className="mono">{dt(x.t + 4 * 3600000)}</td><td><b>{x.base}</b> <Side side={x.side} /></td><td>{PSETUP[x.setup] || x.setup}</td>
              <td><Vd v={x.verdict} />{x.plus?.length ? <span className="sub green">{x.plus[0]}</span> : null}</td>
              <td className="mono">{`${pPx(x.price)} · ${pPx(x.stop)} · ${pPx(x.target)}`}<span className="sub">{`risk ${x.riskPct}%`}</span></td>
              <td className="mono">{t.status === "open" && t.last ? <>{pPx(t.last)}<span className="sub">{`${pR(t.r)} · ${t.days} d`}</span></> : "—"}</td>
              <td className="mono">{res}</td>
            </tr>);
        }) : <tr><td colSpan={7} className="empty">{d.status === "starting" ? "First scan in a moment…" : d.demo ? "Live signals need live Binance futures data (not in demo mode)." : sig.length ? "Nothing in this view." : "No signal yet. They come after 4h closes (00, 04, 08, 12, 16, 20 UTC); quiet days are normal."}</td></tr>}</tbody></table></div>
      <div ref={cardRef}>{picked && d ? <PCard c={sigCard(d, picked)} risk={rk} /> : null}</div>
    </section>
  );
}

export type CheckForm = { sym: string; side: string; entry: string; stop: string };
export function CheckPanel({ d, rk, form, setForm, busy, err, res, onCheck, formRef }: {
  d: PerpsData | null; rk: Risk; form: CheckForm; setForm: (f: CheckForm) => void; busy: boolean; err: string; res: any; onCheck: () => void; formRef: RefObject<HTMLFormElement | null>;
}) {
  const submit = (e: FormEvent) => { e.preventDefault(); onCheck(); };
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Check a trade</h2><p>Your own idea on any Binance USDⓈ-M perpetual, judged with the same tested rules: a tested setup now (or in the last 12 hours), a kind of trade that lost money in the test, or nothing tested yet and what to wait for.</p></div></div>
      <form className="pform" autoComplete="off" ref={formRef} onSubmit={submit}>
        <label>Coin<input placeholder="e.g. SOL" required value={form.sym} onChange={(e) => setForm({ ...form, sym: e.target.value })} /></label>
        <label>Side<select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value })}><option value="long">Long</option><option value="short">Short</option></select></label>
        <label>Entry (optional)<input type="number" step="any" min="0" placeholder="market" value={form.entry} onChange={(e) => setForm({ ...form, entry: e.target.value })} /></label>
        <label>Stop (optional)<input type="number" step="any" min="0" placeholder="suggested" value={form.stop} onChange={(e) => setForm({ ...form, stop: e.target.value })} /></label>
        <button className="btn" type="submit" disabled={busy}>{busy ? "Checking…" : "Check"}</button><span className="red" style={{ fontSize: 12 }}>{err}</span>
      </form>
      <div>{res ? <PCard c={{ ...res, record: res.setup ? pRecord(d, res.setup, res.side) : null }} risk={rk} /> : null}</div>
    </section>
  );
}

export function RiskPanel({ vals, set }: { vals: RiskInputs; set: (k: RiskKey, v: string) => void }) {
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Your risk settings</h2><p>Used for the size, margin and liquidation price on every card. Saved in this browser only.</p></div></div>
      <form className="pform" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        {RISK_FIELDS.map(([k, label, , step, min, max]) => (
          <label key={k}>{label}<input type="number" step={step} min={min} max={max} value={vals[k]} onChange={(e) => set(k, e.target.value)} /></label>))}
      </form>
    </section>
  );
}

export function CoinsPanel({ d, onPick }: { d: PerpsData | null; onPick: (base: string) => void }) {
  const cr: any[] = d?.rows || [];
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Coins scanned</h2><p>The most liquid USDⓈ-M perpetuals by 30-day volume (no stablecoins, no perpetuals on stocks, ETFs or commodities). Funding is per 8 hours, with where it sits in the coin&apos;s own last 90 days.</p></div>
        <span className="chip">{cr.length ? `${cr.length} coins${d?.excluded?.tradfi?.length ? ` · ${d.excluded.tradfi.length} stock/ETF/commodity perps left out` : ""}` : "—"}</span></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Coin</th><th>Price · 24h</th><th>Funding (8h)</th><th>Open interest 24h · 3d</th><th>Top traders vs all</th><th>Daily trend</th><th>vs BTC (30d)</th><th>To 20-day high · low</th><th>Fired now</th></tr></thead>
        <tbody>{!d ? null : cr.length ? cr.map((c, i) => (
          <tr key={c.sym ?? i}><td><button type="button" className="coin-link" onClick={() => onPick(c.base)}><b>{c.base}</b></button></td>
            <td className="mono">{pPx(c.price)}<span className={`sub ${c.ch24 > 0 ? "green" : c.ch24 < 0 ? "red" : ""}`}>{`${c.ch24 > 0 ? "+" : ""}${c.ch24 ?? "—"}%`}</span></td>
            <td className={`mono ${c.fund8h < 0 ? "green" : c.fund8h > 0.03 ? "red" : ""}`}>{c.fund8h != null ? c.fund8h.toFixed(4) + "%" : "—"}<span className="sub">{c.fundPct != null ? c.fundPct + "th pct of 90d" : ""}</span></td>
            <td className="mono">{c.oi24h != null ? (c.oi24h > 0 ? "+" : "") + c.oi24h + "%" : "—"}<span className="sub">{c.oi3d != null ? (c.oi3d > 0 ? "+" : "") + c.oi3d + "% 3d" : ""}</span></td>
            <td className="mono">{c.topVsAcc ?? "—"}</td><td>{c.dTrend || "—"}</td><td className="mono">{c.rs ? `#${c.rs.rank} of ${c.rs.n}` : "—"}</td><td className="mono">{`${c.toHi20 > 0 ? "+" : ""}${c.toHi20}% · ${c.toLo20}%`}</td>
            <td>{(c.signals || []).length ? c.signals.map((x: any, j: number) => (
              <Fragment key={j}>{j ? <br /> : null}<Side side={x.side} /> {PSETUP[x.setup] || x.setup}{["pullback|long", "flush|long"].includes(x.setup + "|" + x.side) ? <> <span className="muted">(lost money in test)</span></> : null}</Fragment>))
              : <span className="muted">—</span>}</td></tr>))
          : <tr><td colSpan={9} className="empty">Waiting for the first scan.</td></tr>}</tbody></table></div>
    </section>
  );
}

function LiveRow({ name, x, bt }: { name: ReactNode; x: any; bt: number | null | undefined }) {
  x = x || {};
  return <tr><td>{name}</td><td className="mono">{x.trades || 0}</td><td className="mono">{x.trades ? x.winRatePct + "%" : "—"}</td><td className={`mono ${x.avgR > 0 ? "green" : x.avgR < 0 ? "red" : ""}`}>{pR(x.avgR)}</td>
    <td className="mono">{x.totalR != null ? pR(x.totalR) : "—"}</td><td className="mono">{bt != null ? pR(bt) : "—"}</td></tr>;
}
export function LivePanel({ d }: { d: PerpsData | null }) {
  const L = d?.live || {};
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Live results</h2><p>Every signal since the tab started, followed with the tested exit after fees and funding. This is the real test: compare it with the backtest below after 4-8 weeks.</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Group</th><th>Closed</th><th>Won</th><th>Average</th><th>Total</th><th>Backtest average</th></tr></thead>
        <tbody>{!d ? null : L.closed ? <>
          <LiveRow name={<b>All signals</b>} x={L.all} bt={null} />
          {Object.entries(L.byVerdict || {}).map(([k, x]) => <LiveRow key={"v" + k} name={<Vd v={k} />} x={x} bt={null} />)}
          {Object.entries(L.bySetup || {}).map(([k, x]) => { const [st, sd] = k.split("|"); return <LiveRow key={"s" + k} name={<>{PSETUP[st] || st} <Side side={sd} /></>} x={x} bt={pRecord(d, st, sd)?.all?.avgR} />; })}
        </> : <tr><td colSpan={6} className="empty">{L.open ? `${L.open} signal${L.open === 1 ? "" : "s"} still open; results appear as they close (up to 10 days).` : "No closed signal yet."}</td></tr>}</tbody></table></div>
    </section>
  );
}

export function TestedPanel({ d }: { d: PerpsData | null }) {
  const R = d?.report, live: string[] = d?.liveSetups || [];
  const leads: string[] = R ? (R.results || []).filter((x: any) => live.includes(x.setup)).flatMap((x: any) => (x.groups || [])
    .filter((g: any) => g.holds === "better in both" && g.olderR - x.older.avgR >= 0.049 && g.newerR - x.newer.avgR >= 0.049 && x.older.avgR > 0 && x.newer.avgR > 0)
    .map((g: any) => `${PSETUP[x.setup] || x.setup} ${x.side} + ${g.name}: ${pR(g.olderR)} / ${pR(g.newerR)} (${g.trades} trades)`)) : [];
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Backtest</h2><p>{!d ? "From perps_report.json (node perps-backtest.js)." : R ? `${R.from} to ${R.to}, the ${R.top} most liquid perpetuals of each month (${R.coins} coins over time), ${R.costPctPerSide}% per side + every funding payment, target 2.5R / stop / 10 days (A+ setups: 4R / 14 days). Run node perps-backtest.js monthly to refresh.` : "No report yet: run node perps-backtest.js once (about 1-2 hours the first time)."}</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Setup</th><th>Trades</th><th>Won</th><th>Average</th><th>Before 2025 · 2025-26</th><th>One account, 5 open</th><th>Verdict</th></tr></thead>
        <tbody>{!d ? null : R ? (R.results || []).map((x: any, i: number) => (
          <tr key={`${x.setup}|${x.side}|${i}`} className={x.aplus || live.includes(x.setup) ? undefined : "faded"}>
            <td><b>{PSETUP[x.setup] || x.setup}</b> <Side side={x.side} />{x.setup === "trend" ? <span className="sub">benchmark</span> : x.aplus ? <span className="sub">target 4R, 14 days</span> : null}</td>
            <td className="mono">{x.all.trades}</td><td className="mono">{`${x.all.winRatePct}%`}</td><td className={`mono ${x.all.avgR > 0 ? "green" : "red"}`}>{pR(x.all.avgR)}</td>
            <td className="mono">{`${pR(x.older.avgR)} · ${pR(x.newer.avgR)}`}</td>
            <td className="mono">{x.portfolio ? (x.portfolio.returnPct > 0 ? "+" : "") + x.portfolio.returnPct + "%" : "—"}<span className="sub">{`max drawdown ${x.portfolio?.maxDrawdownPct ?? "—"}%`}</span></td>
            <td>{x.verdict}</td></tr>))
          : <tr><td colSpan={7} className="empty">—</td></tr>}</tbody></table></div>
      <div className="note" style={{ padding: "0 18px 16px", fontSize: 13 }}>{leads.length ? <><b>Conditions that helped in both periods (shown on the signal; TAKE is kept for the A+ setups):</b><br />
        {leads.map((l, i) => <Fragment key={i}>{l}<br /></Fragment>)}<span className="muted">Found after looking at both periods: the live results decide if they last.</span></> : null}</div>
      <p className="perf-note"><b>Professional-style strategies also tested</b> (top 50 perps, daily, Dec 2021 - Sep 2026, with fees and real funding; total · worst drop · losing years): holding BTC +60% · -68%; trend following long and short +35% · -66% (2022, 2024 lost); funding carry, short the 5 highest-funding coins and long the 5 lowest, +158% · -67% (2025 -33%); carry with a trend filter +182% · -71% (2023 -50%); long the most negative-funding coins -68%. They made money overall but with deep drops and bad years, so the A+ weak-coin breakdown short (positive every year, worst account drop 16% at 1% risk) stays the main perps trade.</p>
    </section>
  );
}

export function HealthPanel({ d }: { d: PerpsData | null }) {
  const R = d?.report, tf: string[] | undefined = d?.excluded?.tradfi;
  return (
    <section className="panel" style={{ marginTop: 14 }}><div className="section-head"><div><h2>Data health</h2><p>Binance futures data, no API key.</p></div></div>
      <div className="source-list">{d && <>
        <SourceRow label="Binance futures data">{`${d.source || "—"} · `}{d.status === "ready" ? <span className="green">connected</span> : (d.status || "—")}</SourceRow>
        <SourceRow label="Last scan">{d.updatedAt ? `${time(d.updatedAt)}${d.scanMs != null ? " · " + (d.scanMs / 1000).toFixed(1) + "s" : ""}` : "—"}</SourceRow>
        <SourceRow label="Next scan">{d.nextScanAt ? time(d.nextScanAt) : "—"}</SourceRow>
        <SourceRow label="Coins scanned">{`${d.coins || 0} of the most liquid (PERPS_TOP=${d.top || 50})`}</SourceRow>
        <SourceRow label="Left out">{d.excluded ? `${tf?.length || 0} stock/ETF/commodity perps by their weekend volume${tf?.length ? ": " + tf.slice(0, 12).join(", ") + (tf.length > 12 ? "…" : "") : ""}` : "—"}</SourceRow>
        <SourceRow label="Costs used">{`${d.costPctPerSide ?? 0.08}% per side + real funding (PERPS_COST_PCT)`}</SourceRow>
        <SourceRow label="Backtest report">{R ? <>{`${new Date(R.generatedAt).toLocaleDateString()} · ${R.from} to ${R.to}`}{!R.own && <> · <span className="amber">the copy shipped with the app: run node perps-backtest.js for your own</span></>}</> : "none yet"}</SourceRow>
        <SourceRow label="Telegram">{d.telegramOn ? <><span className="green">on</span> (TAKE signals only)</> : "off · switch on \"Perps swing signals\" in Ignition › Telegram"}</SourceRow>
      </>}</div></section>
  );
}

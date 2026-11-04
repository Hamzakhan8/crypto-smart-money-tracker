"use client";
// Spot plan (the classic page's drawSp / drawSpAll, /api/spot every minute): hold BTC and ETH only while each daily
// close is above its 50-day average, the same trend check on every liquid coin, the backtest and the switches.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactNode } from "react";
import { Kpi, SafeLink } from "../ui";
import { col, money, pct, pct1, price } from "@/lib/format";
import { cx, join } from "./util";

const big = (v: any) => (v == null ? "—" : Number(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : Number(v).toFixed(2));
const dshort = (t: any) => (t ? new Date(t).toISOString().slice(0, 10) : "—");
const plus = (v: any) => (v > 0 ? "+" : "");
const DAY = 86400000;

function TestRow({ name, s }: { name: ReactNode; s: any }) {
  if (!s) return null;
  return <tr><td>{name}</td><td className={cx("mono", col(s.totalPct))}>{plus(s.totalPct)}{s.totalPct}%</td><td className="mono">{plus(s.perYearPct)}{s.perYearPct}%</td>
    <td className="mono red">-{s.maxDrawdownPct}%</td><td className="mono">{s.sharpe ?? "—"}</td></tr>;
}
const SwitchBadge = ({ hold }: { hold: boolean }) => <span className={`badge ${hold ? "strong" : "risk"}`}>{hold ? "BUY / HOLD" : "SELL to USDT"}</span>;

export interface SpotView { filter: string; more: boolean }
export function SpotPlan({ d, error, view, setView }: { d: any; error: string | null; view: SpotView; setView: (v: SpotView) => void }) {
  const R = d?.report, rule = d?.rule || {}, n = rule.avgDays || 50;
  // a failed load shows its error (the last good data stays); otherwise the plan's own error
  const err = error ? `Spot: ${error}` : d?.error ? `Spot: ${d.error}` : null;
  const A = d?.all, f = view.filter;
  const rows: any[] = A ? A.rows.filter((x: any) => (f === "ok" ? x.ok : f === "up" ? x.above : f === "down" ? !x.above : true)) : [];
  const shown = view.more ? rows : rows.slice(0, 25);
  const live: any[] = d?.switches || [], test: any[] = (R?.recentSwitches || []).slice(0, 12);
  return (
    <section className="panel" style={{ marginBottom: 14 }} id="spotPanel">
      <div className="section-head"><div><h2>Spot plan: what to hold (BTC + ETH)</h2>
        <p id="spRule">{d ? `Hold BTC and ETH, half each, only while each one's daily close is above its ${n}-day average; otherwise that half waits in USDT. Decided once a day after the 00:00 UTC close.`
          : "Hold BTC and ETH, half each, only while each one's daily close is above its 50-day average; otherwise that half waits in USDT."}</p></div>
        <span className="chip" id="spChip">{!d ? "—" : d.status === "off" ? "off" : d.day != null ? `${d.plan} · checked ${dshort(d.day + DAY)}` : "starting"}</span></div>
      {err && <div className="error" id="spErrors" style={{ display: "block", margin: "0 18px 10px" }}>{err}</div>}
      <div className="kpis" id="spCoins" style={{ padding: "0 18px", margin: "0 0 6px" }}>
        {d && <>
          {(d.coins || []).map((c: any) => {
            const on = c.hold === true, known = c.hold != null;
            return <Kpi key={c.coin} label={c.coin} cls={on ? "green" : known ? "red" : undefined} value={known ? (on ? "HOLD" : "CASH") : "—"}
              hint={known ? <>close {big(c.close)} · {n}-day avg {big(c.avg)} ({pct(c.distPct)}){c.since ? ` · since ${dshort(c.since)}` : ""}<br />
                {on ? `sell to USDT if a daily close is under ${big(c.avg)}` : `buy back if a daily close is above ${big(c.avg)}`}{c.price ? ` · now ${big(c.price)} (${pct(c.nowVsAvgPct)} vs the average)` : ""}</> : "waiting for the first daily check"} />;
          })}
          <Kpi label="Plan now" value={d.plan || "—"} style={{ fontSize: 20 }}
            hint={d.day != null ? `as of the ${dshort(d.day + DAY)} 00:00 UTC close · next check ${d.nextAt ? new Date(d.nextAt).toLocaleString() : "after the next close"}` : "first check a few minutes after start"} />
        </>}
      </div>
      <details className="notice" style={{ margin: "4px 18px 12px" }}><summary><b>How to use it:</b> check once a day after the 00:00 UTC close (5:00 AM Pakistan time). HOLD = keep (or buy) that coin with its half of the money; CASH = keep that half in USDT. Telegram tells you when one switches (about 3 times a month).</summary>
        <div>Example with $1,000: $500 is for BTC, $500 for ETH. A coin whose daily close is above its 50-day average is held; below it, that $500 waits in USDT. Only daily closes count: a dip under the average during the day does not. Of every spot strategy tested on 6 years of Binance data, this did best: it trails simply holding in strong bull years (it sells on dips that recover) and loses much less in bad years (2022: -41% vs -67% for holding; 2025: +42% vs -9%). The worst drop in the test was still -56%: use money you can leave for years. Research, not financial advice.</div></details>
      <div className="subhead2"><div><h2>All coins: trend check (every coin trading $2M+ a day)</h2>
        <p id="spAllHint">{A ? <>{A.coins} spot coins trading $2M+ a day (up to 100), checked after the {dshort(A.day + DAY)} close. <b>BUY OK</b> = above its own {n}-day average, stronger than BTC over the same {n} days, <b>and</b> BTC above its own average ({A.btcUp ? <span className="green">yes now</span> : <span className="red">not now, so nothing is BUY OK</span>}). {A.rows.filter((x: any) => x.ok).length} BUY OK · {A.rows.filter((x: any) => x.above).length} above their average. In the test on every Binance coin (2021-26), altcoins held only while BUY OK made +48% (top 50) against +1% for altcoins simply above their average, but far less than the BTC + ETH plan (+692%), and they lost money in 2025 and 2026: use it to pick altcoins, with small size.</>
          : "The same idea for every liquid spot coin. BUY OK = above its own 50-day average, stronger than BTC over the same 50 days, and BTC above its own average."}</p></div>
        <select id="spFilter" aria-label="Which coins" value={f} onChange={(e) => setView({ filter: e.target.value, more: false })}>
          <option value="all">All coins</option><option value="ok">BUY OK only</option><option value="up">Above its average</option><option value="down">Under its average</option></select></div>
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Coin</th><th>Price</th><th>vs its 50-day average</th><th>vs BTC (50 days)</th><th>30 days</th><th>Status</th></tr></thead>
        <tbody id="spAll">
          {!d ? <tr><td colSpan={6} className="empty">Loading…</td></tr>
            : !A ? <tr><td colSpan={6} className="empty">{d.allError ? d.allError : "Checked a few minutes after the daily close (the first time a few minutes after start)."}</td></tr>
              : shown.length ? shown.map((x) => (
                <tr key={x.coin}>
                  <td><SafeLink className="sym" url={`https://www.binance.com/en/trade/${encodeURIComponent(x.coin)}_USDT`}>{x.coin} ↗</SafeLink><span className="sub">{money(x.vol30)} a day</span></td>
                  <td className="mono">{price(x.price ?? x.close)}</td>
                  <td className={`mono ${x.above ? "green" : "red"}`}>{pct1(x.distPct)}<span className="sub">avg {price(x.avg)}</span></td>
                  <td className={`mono ${x.strongerThanBtc ? "green" : "red"}`}>{pct1(x.vsBtcPct)}<span className="sub">{x.strongerThanBtc ? "stronger than BTC" : "weaker than BTC"}</span></td>
                  <td className={cx("mono", col(x.r30Pct))}>{pct1(x.r30Pct)}</td>
                  <td>{x.ok ? <span className="badge strong">BUY OK</span> : <><span className="badge">WAIT</span><span className="sub">{(x.why || []).join(", ")}</span></>}</td>
                </tr>)) : <tr><td colSpan={6} className="empty">No coin matches this filter now.</td></tr>}
        </tbody></table></div>
      {A && rows.length > 25 && <button className="btn sm more" id="spMore" onClick={() => setView({ ...view, more: !view.more })}>{view.more ? "Show fewer" : `Show all ${rows.length}`}</button>}
      <div className="subhead2"><div><h2>How it did in the test</h2>
        <p id="spTestHint">{!d ? "From spot_report.json (node spot-backtest.js)." : R ? <>Binance daily candles {R.from} to {R.to}, decided at each close, {rule.costPct}% cost per switch. {R.strategy?.switches} switches ({R.strategy?.perMonth} a month), in the market {R.strategy?.timeInMarketPct}% of the time.
          {R.own ? "" : <>{" "}<span className="amber">The copy shipped with the app; run <span className="mono">node spot-backtest.js</span> for your own.</span></>}</> : ""}</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>What</th><th>Total</th><th>Per year</th><th>Worst drop</th><th>Sharpe</th></tr></thead>
        <tbody id="spTest">
          {d && (R ? <>
            <TestRow name={<><b>This plan</b> (BTC + ETH, 50-day trend)</>} s={R.strategy} />
            <TestRow name="Holding BTC + ETH (half each), never selling" s={R.hold} />
            <TestRow name="Holding BTC only" s={R.holdBtc} />
            {(R.halves || []).map((h: any, i: number) => <TestRow key={i} s={h.strategy}
              name={<>… this plan {String(h.from).slice(0, 4)}-{String(h.to).slice(0, 4)} <span className="muted">(holding: {plus(h.hold?.totalPct)}{h.hold?.totalPct}%)</span></>} />)}
            <TestRow name="… with double the fees" s={R.doubleCost} />
            <TestRow name="Same rule, BTC only" s={R.btcOnly} />
            <TestRow name="Same rule, ETH only" s={R.ethOnly} />
          </> : <tr><td colSpan={5} className="muted">No test report: run <span className="mono">node spot-backtest.js</span>.</td></tr>)}
        </tbody></table></div>
      <p className="perf-note" id="spYears" style={{ marginTop: 10 }}>{R && R.strategy?.years ? <><b>Every year</b> (this plan vs holding BTC + ETH): {join(Object.entries(R.strategy.years).map(([y, v]: [string, any]) => <>{y} <b className={cx(col(v))}>{plus(v)}{v}%</b> <span className="muted">vs {plus(R.hold?.years?.[y])}{R.hold?.years?.[y]}%</span></>))}. It trails holding in strong bull years and loses much less in bad ones.</> : null}</p>
      <p className="perf-note" id="spVariants">{R && R.variants ? <><b>Other average lengths</b> (total): {join(R.variants.map((v: any) => <>{v.avgDays} days <b className={cx(col(v.totalPct))}>{plus(v.totalPct)}{v.totalPct}%</b></>))}. 40-60 days all did well, so 50 is not a lucky pick.</> : null}</p>
      <p className="perf-note" id="spAlso">{R && R.alsoTested ? <><b>Tested on every Binance coin and not used</b> (2021-2026, total · worst drop): {join(R.alsoTested.map((a: any) => <>{a.name} <b className={cx(col(a.totalPct))}>{plus(a.totalPct)}{a.totalPct}%</b> <span className="muted">(-{Math.abs(a.maxDrawdownPct)}%)</span></>))}. Most altcoins kept falling against BTC, so strategies that hold altcoins lost money.</> : null}</p>
      <div className="subhead2"><div><h2>Switches</h2><p>Each time BTC or ETH crossed its 50-day average at a daily close: on this PC, then the last ones in the test.</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Day (close)</th><th>Coin</th><th>Switch</th><th>Close</th><th>Where</th></tr></thead>
        <tbody id="spSw">
          {d && (live.length || test.length ? <>
            {live.map((x, i) => <tr key={`l${i}`}><td className="mono">{dshort(x.t + DAY)}</td><td><b>{x.coin}</b></td><td><SwitchBadge hold={x.hold} /></td><td className="mono">{big(x.close)}</td><td>this PC</td></tr>)}
            {test.map((x, i) => <tr key={`t${i}`}><td className="mono">{x.day}</td><td><b>{x.coin}</b></td><td><SwitchBadge hold={x.hold} /></td><td className="mono">{big(x.close)}</td><td className="muted">test</td></tr>)}
          </> : <tr><td colSpan={5} className="empty">No switches yet.</td></tr>)}
        </tbody></table></div>
    </section>
  );
}

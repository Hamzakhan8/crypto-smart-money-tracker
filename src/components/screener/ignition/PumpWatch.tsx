"use client";
// Pump watch (the classic page's drawPump, /api/pump every minute): once a day after the daily close, coins near their
// 90-day high on 2×+ normal volume that have not run yet, the open picks and how the rule did.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactNode } from "react";
import { SafeLink } from "../ui";
import { col, money, pct, pct1, price } from "@/lib/format";
import { cx, join } from "./util";

const sp = (v: any) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(0)}%`);
const day = (t: any) => new Date(t).toISOString().slice(0, 10);
const binance = (base: string) => `https://www.binance.com/en/trade/${encodeURIComponent(base)}_USDT`;

function PumpRow({ x, rule }: { x: any; rule: any }) {
  const left = Math.max(0, rule.days - (x.daysHeld || 0));
  return (
    <tr>
      <td><SafeLink className="sym" url={binance(x.base)}>{x.base} ↗</SafeLink><span className="sub">{day(x.t)} close</span></td>
      <td>volume {x.volRatio}× its 20-day average · {Math.abs(x.fromHigh90Pct).toFixed(0)}% under its 90-day high<span className="sub">day {sp(x.dayPct)} · 30 days {sp(x.r30Pct)} · {money(x.qv)} traded</span></td>
      <td className="mono">{price(x.entry)}</td>
      <td className="mono"><span className={cx(col(x.nowPct))}>{pct1(x.nowPct)}</span><span className="sub">{x.daysHeld ? `best ${pct1(x.peakPct)} · worst ${pct1(x.lowPct)} (daily)` : "vs the close: new today"}</span></td>
      <td className="mono green">{price(x.target)}<span className="sub red">stop {price(x.stop)}</span></td>
      <td className="mono">{left} day{left === 1 ? "" : "s"}</td>
    </tr>
  );
}
function RecRow({ name, s, note = "" }: { name: ReactNode; s: any; note?: string }) {
  if (!s || !s.n) return <tr><td>{name}</td><td colSpan={7} className="muted">{note || "none yet"}</td></tr>;
  return (
    <tr><td>{name}</td><td className="mono">{s.n}</td><td className="mono">{s.perWeek ?? "—"}</td><td className="mono">{s.up50in7Pct == null ? "—" : `${s.up50in7Pct}%`}</td>
      <td className="mono">{s.up100in14Pct == null ? "—" : `${s.up100in14Pct}%`}</td>
      <td className="mono">{s.stopPct != null ? `${s.stopPct}%` : s.stops != null ? `${Math.round((s.stops / s.n) * 100)}%` : "—"}</td>
      <td className={cx("mono", col(s.avgPct))}>{pct(s.avgPct)}</td><td className="mono">{s.winPct}%</td></tr>
  );
}

export function PumpWatch({ p }: { p: any }) {
  const off = p?.status === "off", rule = p?.rule || {}, m = p?.mood, R = p?.report, L = p?.record || {};
  const today: any[] = p?.today || [], open: any[] = p?.open || [], closed: any[] = p?.closed || [];
  const on = p && !off;
  return (
    <section className="panel" style={{ marginBottom: 14 }} id="pumpPanel">
      <div className="section-head"><div><h2>Pump watch: coins that could pump hard</h2>
        <p id="pumpHint">{on ? <>Once a day, right after the daily close (00:00 UTC): coins whose close is within {rule.nearHighPct}% of their 90-day high, with volume {rule.minVolRatio}×+ their 20-day average and a day up less than {rule.maxDayPct}% (not already running), ${(rule.minQuoteVolume / 1e6).toFixed(0)}M+ traded. One pick per coin per {rule.gapDays} days. Tested plan: buy near the daily close, sell at <b>+{rule.targetPct}%</b> or <b>-{rule.stopPct}%</b>, else after {rule.days} days. Most picks do not pump: this doubles the odds, it does not make them high. Next list {p.nextAt ? new Date(p.nextAt).toLocaleString() : "after the next close"}.</>
          : "Once a day, right after the daily close (00:00 UTC): coins near their 90-day high on 2×+ normal volume that have not run yet."}</p></div>
        <span className="chip" id="pumpChip">{!p ? "—" : off ? "off" : p.day == null ? (p.error ? "error" : "first list loading…") : `${today.length} new · list of ${day(p.day)}`}</span></div>
      <p className="perf-note" id="pumpMood">{off ? p.error || "" : on ? <>{p.error && <><b className="red">{p.error}</b><br /></>}
        {m ? <><b>Market mood: {m.share}%</b> of {m.coins} coins are up over 30 days. {m.ok ? <><b className="green">OK</b>: in the test, picks made money on average when this was {rule.moodMin}% or more.</>
          : <><b className="red">WEAK</b>: in the test, picks lost money on average when this was under {rule.moodMin}%. Skip them or go very small.</>}</> : "Market mood: waiting for the first list."}</> : null}</p>
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Token</th><th>Why it is on the list</th><th>Entry (daily close)</th><th>Now</th><th>Plan: target · stop</th><th>Time left</th></tr></thead>
        <tbody id="pumpBody">
          {!p ? <tr><td colSpan={6} className="empty">Loading…</td></tr>
            : off ? <tr><td colSpan={6} className="empty">{p.error || "Pump watch is off"}</td></tr>
              : today.length ? today.map((x, i) => <PumpRow key={`${x.base}-${x.t}-${i}`} x={x} rule={rule} />)
                : <tr><td colSpan={6} className="empty">{p.day == null ? "The first list appears a few minutes after start (it reads every coin's daily candles)." : "No coin passed the rule on the last close. Quiet days are normal."}</td></tr>}
        </tbody></table></div>
      <div className="subhead2"><div><h2>Open picks from earlier days</h2><p>Still inside their 14 days. Results are judged on daily candles, like the test.</p></div></div>
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Token</th><th>Why it is on the list</th><th>Entry (daily close)</th><th>Now</th><th>Plan: target · stop</th><th>Time left</th></tr></thead>
        <tbody id="pumpOpen">
          {on && (open.length ? open.map((x, i) => <PumpRow key={`${x.base}-${x.t}-${i}`} x={x} rule={rule} />) : <tr><td colSpan={6} className="empty">No open picks from earlier days.</td></tr>)}
        </tbody></table></div>
      <div className="subhead2"><div><h2>How it did</h2>
        <p id="pumpRecHint">{!on ? "The test on every Binance USDT pair (delisted ones too), and the picks made on this PC. After 0.3% costs."
          : R ? <>Test: {R.from} to {R.to}, {R.coins} Binance USDT coins (delisted ones too), daily candles, the same code as the live list. After {rule.costPct}% costs per trade.
            {R.own ? "" : <>{" "}<span className="amber">This is the copy shipped with the app; run <span className="mono">node pump-backtest.js</span> for your own.</span></>}</> : ""}</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Group</th><th>Picks</th><th>Per week</th><th>Rose +50% within 7 days</th><th>Doubled within 14 days</th><th>Hit the -25% stop</th><th>Avg per trade</th><th>In profit</th></tr></thead>
        <tbody id="pumpRec">
          {on && <>
            {R ? <>
              <RecRow name="Any coin, any day (for comparison)" s={R.random} />
              <RecRow name={<><b>Pump watch</b>, test</>} s={R.watch} />
              <RecRow name={`… when market mood was ${rule.moodMin}%+`} s={R.moodOk} />
              <RecRow name={`… when market mood was under ${rule.moodMin}%`} s={R.moodWeak} />
              {R.older && R.older.watch && <RecRow name={`… years not used to find it (${String(R.older.from).slice(0, 7)} to ${String(R.older.to).slice(0, 7)})`} s={R.older.watch} />}
              <RecRow name={`… the period it was found on (${String(R.foundOn?.from).slice(0, 7)} on)`} s={R.foundOn?.watch} />
            </> : <tr><td colSpan={8} className="muted">No test report yet: run <span className="mono">node pump-backtest.js</span>.</td></tr>}
            <RecRow name={<b>Live picks on this PC</b>} s={L.all} note="none closed yet: each pick takes up to 14 days" />
            {L.all && L.all.n ? <>
              <RecRow name={`… live, mood ${rule.moodMin}%+`} s={L.moodOk} />
              <RecRow name={`… live, mood under ${rule.moodMin}%`} s={L.moodWeak} />
            </> : null}
          </>}
        </tbody></table></div>
      <p className="perf-note" id="pumpPeriods" style={{ marginTop: 10 }}>{on && R && R.periods ? <><b>Every half-year</b> (pump watch avg per trade vs any coin): {join(R.periods.map((x: any) => <>{x.label} <b className={cx(col(x.watch.avgPct))}>{x.watch.n ? pct1(x.watch.avgPct) : "—"}</b> <span className="muted">vs {x.random.n ? pct1(x.random.avgPct) : "—"} ({x.watch.n || 0})</span></>))}</> : null}</p>
      <p className="perf-note" id="pumpClosed">{on && closed.length ? <><b>Closed picks on this PC:</b> {join(closed.slice(0, 20).map((x: any) => <>{x.base} <b className={cx(col(x.netPct))}>{pct1(x.netPct)}</b> <span className="muted">({x.why === "target" ? `hit +${rule.targetPct}%` : x.why === "stop" ? "stopped" : x.why === "time" ? `${rule.days} days up` : x.why}, {new Date(x.t).toISOString().slice(5, 10)})</span></>))}</> : null}</p>
    </section>
  );
}

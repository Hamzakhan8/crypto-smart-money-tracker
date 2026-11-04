"use client";
// Perps › Scalp (the classic page's drawS): 5-minute flush-bounce longs from /api/scalp, how the setup did in the test,
// and the coins scanned. The paper bot is in PaperBot.tsx.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment, type ReactNode } from "react";
import { col, pct, pct1 } from "@/lib/format";
import { ErrorBox, Kpi } from "../ui";
import { Side, blockedHint, dt, hm, pPx, pR, type Risk, type ScalpData } from "./lib";

export function ScalpNotice() {
  return (
    <details className="notice" style={{ marginTop: 22 }}><summary><b>Read this first:</b> scalping with leverage is the fastest way to lose money. Of the seven 5-minute strategies tested, only this one made money after fees, and it fires only about 20 times a month. Most of the time this page is quiet, and that is fine.</summary>
      <div><b>The setup (long only):</b> one 5-minute candle falls hard (2.5x+ the coin&apos;s normal 5-minute range) on 4x+ normal volume, forced selling that is often liquidations; then the next candle closes green and back above the middle of that drop. Only on volatile coins (normal 5-minute range 0.6%+ of the price). <b>The plan:</b> buy right away, stop just under the low of the drop, target 1.5x the risk, and close after 1 hour if neither is hit. The stop is often 2-5% away, so <b>size the position from your risk</b> (the size shown uses your Perps › Risk settings), use isolated margin, and keep the liquidation price far beyond the stop. Expect losing runs: the test had 17 losses in a row once. Signals only: the app never places orders. Research, not financial advice.</div></details>
  );
}

/** The red box: a failed request, or the scan's own error. */
export function ScalpError({ d, fetchError }: { d: ScalpData | null; fetchError: string | null }) {
  return <ErrorBox>{fetchError ? `Scalp: ${fetchError}` : d?.error ? `Scalp: ${d.error}${blockedHint(d.error)}` : null}</ErrorBox>;
}

export function ScalpKpis({ d }: { d: ScalpData | null }) {
  const sig: any[] = d?.signals || [], open = sig.filter((x) => x.status === "open"), L = d?.record || {};
  const day0 = new Date(); day0.setUTCHours(0, 0, 0, 0);
  return (
    <div className="kpis">
      <Kpi label="Open now" cls="green" value={!d ? "—" : d.status === "off" ? "off" : open.length}
        hint={!d ? "signals inside their hour" : d.status === "off" ? (d.error || "") : `${sig.length} signal${sig.length === 1 ? "" : "s"} so far`} />
      <Kpi label="Signals today" value={!d ? "—" : sig.filter((x) => x.at >= day0.getTime()).length} hint="about 20 a month in the test" />
      <Kpi label="Live results" cls={d && L.n ? col(L.avgPct) : undefined} value={d && L.n ? pct(L.avgPct) : "—"}
        hint={!d ? "after fees, since the tab started" : L.n ? `${L.n} closed · ${L.winPct}% won · ${L.targets} target, ${L.stops} stop, ${L.timeouts} 1-hour exits` : "none closed yet"} />
      <Kpi label="Last scan" value={d?.updatedAt ? hm(d.updatedAt) : "—"}
        hint={d?.nextScanAt ? `next ${hm(d.nextScanAt)}${d.scanMs ? ` · took ${(d.scanMs / 1000).toFixed(1)}s` : ""}` : "after each 5-minute close"} />
    </div>
  );
}

function SignalRow({ x, rule, rk }: { x: any; rule: any; rk: Risk }) {
  const cost = (rule.costPct ?? 0.12) / 100;
  const e = x.entry ?? x.ref, risk = (e - x.stop) / e, notional = rk.acct * rk.risk / 100 / (risk + cost), margin = notional / rk.lev, liq = e * (1 - 1 / rk.lev + rk.mmr / 100), liqOk = liq < x.stop - (e - x.stop) * 0.5;
  const nowPct = x.price && e ? ((x.price / e - 1) * 100) : null, left = Math.max(0, Math.round((x.closeBy - Date.now()) / 60000));
  const res = x.status === "open" ? <><span className="badge watch">open</span><span className="sub">{`${left} min left`}</span></>
    : x.why === "gap" ? <><span className="badge">no trade</span><span className="sub">opened under the stop</span></>
      : <><b className={col(x.netPct)}>{pct(x.netPct)}</b><span className="sub">{x.why === "target" ? "hit the target" : x.why === "stop" ? "stopped" : x.why === "time" ? "closed after 1 hour" : (x.why || "")}</span></>;
  return (
    <tr>
      <td><Side side="long" /> <b>{x.base}</b> <b className="green">BUY</b><span className="sub">{`${dt(x.at)} · close by ${hm(x.closeBy)}`}</span></td>
      <td>{`flush ${pct1(x.flushPct)}${x.flushLowPct != null && x.flushLowPct < x.flushPct - 0.5 ? ` (low ${pct1(x.flushLowPct)})` : ""} on ${x.volRatio}× volume`}
        <span className="sub">{`${x.dropAtr}× its normal 5m range (${x.atrPct}%) · then a green close above its middle`}</span>
        {x.liquidations ? <span className="sub green">{`liquidations confirmed: open interest ${pct1(x.oiChg15)} in 15 min`}</span> : x.oiChg15 != null ? <span className="sub">{`open interest ${pct1(x.oiChg15)} in 15 min`}</span> : null}</td>
      <td className="mono">{`${x.entry ? "" : "~"}${pPx(e)}`}<span className="sub red">{`stop ${pPx(x.stop)} (-${(risk * 100).toFixed(2)}%)`}</span><span className="sub green">{`target ${pPx(x.target)} (+${(risk * 100 * (rule.targetR ?? 1.5)).toFixed(2)}%)`}</span></td>
      <td className="mono">{`$${Math.round(notional).toLocaleString()}`}<span className="sub">{`margin $${Math.round(margin).toLocaleString()} at ${rk.lev}x · risk $${Math.round(rk.acct * rk.risk / 100)}`}</span>
        <span className={`sub ${liqOk ? "muted" : "red"}`}>{liqOk ? "liquidation well beyond the stop" : "liquidation too close: lower the leverage"}</span></td>
      <td className="mono"><span className={col(nowPct)}>{nowPct == null ? "—" : pct1(nowPct)}</span><span className="sub">{x.peakPct != null ? `best ${pct1(x.peakPct)} · worst ${pct1(x.lowPct)}` : ""}</span></td>
      <td>{res}</td>
    </tr>
  );
}

export function ScalpSignals({ d, rk }: { d: ScalpData | null; rk: Risk }) {
  const sig: any[] = d?.signals || [], open = sig.filter((x) => x.status === "open"), rule = d?.rule || {}, w: any[] = d?.watching || [];
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Scalp signals (5 minutes to 1 hour)</h2><p>Every scalp signal is <b>LONG</b> (buy): the flush bounce on the top-50 perpetuals, found a few seconds after each 5-minute candle closes. The plan: buy now, stop and target below, close within 1 hour. No short scalp passed the test (every short version lost money after fees); for shorts use the <b>Swing signals</b> (the A+ weak-coin breakdown short). Size uses your Perps › Risk settings.</p></div>
        <span className="chip">{d ? `${open.length} open · ${sig.length} total` : "—"}</span></div>
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Signal</th><th>Why</th><th>Entry · stop · target</th><th>Size for your risk</th><th>Now</th><th>Result</th></tr></thead>
        <tbody>{!d ? <tr><td colSpan={6} className="empty">Loading…</td></tr>
          : sig.length ? sig.slice(0, 40).map((x, i) => <SignalRow key={x.id ?? `${x.sym}-${x.at}-${i}`} x={x} rule={rule} rk={rk} />)
            : <tr><td colSpan={6} className="empty">{d.status === "off" ? (d.error || "off") : d.updatedAt ? "No signal yet. This setup is rare (about 20 a month across 50 coins), usually when the market drops fast." : "The first scan runs a few seconds after the next 5-minute close."}</td></tr>}</tbody></table></div>
      <p className="perf-note" style={{ marginTop: 10 }}>{!d ? null : w.length ? <><b>Watching for a bounce</b> (half a setup: a flush just happened; if it bounces the signal is <b className="green">LONG</b>): {w.map((x, i) => (
        <Fragment key={i}>{i ? " · " : ""}<b>{x.base}</b>{` fell ${pct1(x.flushPct)} at ${hm(x.t)} (${x.dropAtr}× its normal range, ${x.volRatio}× volume): a signal comes if the ${hm(x.t + 300000)} candle closes green above `}<b>{pPx(x.bounceAbove)}</b>{`, decided at ${hm(x.decidedAt)}`}</Fragment>))}</>
        : d.status === "ok" ? "No flush on the last candle: nothing half-way to a signal right now." : ""}</p>
    </section>
  );
}

function TestRow({ name, s, note = "" }: { name: ReactNode; s: any; note?: string }) {
  if (!s || !s.n) return <tr><td>{name}</td><td colSpan={5} className="muted">none</td></tr>;
  return <tr><td>{name}</td><td className="mono">{s.n}</td><td className="mono">{`${s.winPct}%`}</td><td className={`mono ${col(s.avgPct)}`}>{pct(s.avgPct)}</td><td className="mono">{s.avgR != null ? pR(s.avgR) : "—"}</td><td className="muted" style={{ fontSize: 12 }}>{note}</td></tr>;
}

export function ScalpTest({ d }: { d: ScalpData | null }) {
  const R = d?.report, rule = d?.rule || {}, L = d?.record || {};
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Scalp: how it did in the test</h2><p>{!d ? "From scalp_report.json (node scalp-backtest.js)." : R ? <>{`${R.from} to ${R.to}, every 5-minute candle of the 50 most liquid perps of each month (${R.coins} coins had a signal), after ${rule.costPct}% fees per trade.`}
        {!R.own && <> <span className="amber">The copy shipped with the app; run <span className="mono">node scalp-backtest.js</span> for your own.</span></>}</> : ""}</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Group</th><th>Trades</th><th>Won</th><th>Average per trade</th><th>In R</th><th>Note</th></tr></thead>
        <tbody>{!d ? null : R ? <>
          <TestRow name={<><b>Flush bounce</b> (these signals)</>} s={R.all} note={`${R.all?.perMonth} a month · ${R.all?.coins} coins · top 3 coins ${R.all?.top3SharePct}% of the profit`} />
          <TestRow name={`… before ${R.split}`} s={R.older} note="the period the filters were picked on" />
          <TestRow name={`… from ${R.split}`} s={R.newer} note="never seen when picking the filters" />
          <TestRow name="… entering 5 minutes late" s={R.late} note="if you act one candle later" />
          <TestRow name="… worse fill (+0.3%) and 0.2% fees" s={R.worse} note="a fast market" />
          <TestRow name="Same setup on calm coins" s={R.calm} note="not used: the bounce is too small to beat fees" />
          <TestRow name="Short version (sell a spike up)" s={R.short} note="not used: about zero after fees" />
          <TestRow name={<b>Live on this PC</b>} s={L.n ? { n: L.n, winPct: L.winPct, avgPct: L.avgPct } : null} />
        </> : <tr><td colSpan={6} className="muted">No test report: run <span className="mono">node scalp-backtest.js</span>.</td></tr>}</tbody></table></div>
      <p className="perf-note" style={{ marginTop: 10 }}>{R && R.months ? <><b>Risking 1% of the account per trade</b>{` (size from the stop): ${R.all.totalR > 0 ? "+" : ""}${R.all.totalR}% over the whole test, worst drop ${R.all.maxDrawdownR}% of the account, longest losing run ${R.all.longestLosingStreak} trades. The stop was ${R.all.medianRiskPct}% below the entry on a typical trade and ${R.all.p90RiskPct}%+ on 1 in 10 (deep wicks): size every trade from its stop.`}<br />
        <b>Every month</b> (avg per trade, trades): {R.months.map((m: any, i: number) => <Fragment key={m.m ?? i}>{i ? " · " : ""}{m.m.slice(2)} <b className={col(m.avgPct)}>{pct1(m.avgPct)}</b> <span className="muted">({m.n})</span></Fragment>)}</> : null}</p>
      <p className="perf-note">{d && <><b>Liquidations:</b> when open interest fell 2%+ over the 15 minutes of the flush (positions forced out), the bounce did a little better in both periods (+0.84% vs +0.59% older, +1.51% vs +1.09% newer; 76 trades): shown as a label on the signal, not a filter. A market-wide flush (many coins in the same candle) did not help. <b>Tested and not used</b> (same coins and period, after 0.12% fees, avg per trade): breakout of the 4-hour range on 3x volume -0.12% to -0.15%; pullback to the 20 EMA in a trend -0.10% to -0.14%; snapback from 2.5 standard deviations -0.05% to -0.12%; Bollinger squeeze breakout -0.10% to -0.17%; following a BTC jump on lagging coins about -0.05%; fading a spike up about 0%. They roughly break even before fees, and fees turn them into losses.</>}</p>
    </section>
  );
}

export function ScalpCoins({ d }: { d: ScalpData | null }) {
  const cs: any[] = d?.coins || [], rule = d?.rule || {};
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Scalp: coins scanned</h2><p>The 50 most liquid USDⓈ-M perpetuals by 30-day volume, read every 5 minutes. Only volatile ones (normal 5-minute range 0.6%+) can give a signal. &quot;Biggest drop&quot; is the largest 5-minute down candle of the last 2 hours: a signal needs one of 2.5×+ the normal range on 4×+ volume, then a green candle back above its middle.</p></div>
        <span className="chip">{d ? `${cs.length} coins · ${cs.filter((c) => c.volatile).length} volatile enough` : "—"}</span></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Coin</th><th>Price</th><th>Normal 5m range</th><th>Can signal</th><th>Last hour</th><th>Biggest drop (2h)</th></tr></thead>
        <tbody>{!d ? null : cs.length ? cs.map((c, i) => (
          <tr key={c.sym ?? i}><td><b>{c.base}</b></td><td className="mono">{pPx(c.price)}</td><td className="mono">{c.atrPct == null ? "—" : c.atrPct.toFixed(2) + "%"}</td>
            <td>{c.volatile ? <span className="green">yes</span> : <span className="muted">no (calm)</span>}</td><td className={`mono ${col(c.change1h)}`}>{pct(c.change1h)}</td>
            <td className="mono">{c.bigDrop ? <><span className={c.bigDrop.dropAtr >= (rule.minDropAtr ?? 2.5) && c.bigDrop.volRatio >= (rule.minVolRatio ?? 4) ? "green" : "muted"}>{pct1(c.bigDrop.pct)}</span>
              <span className="sub">{`${c.bigDrop.dropAtr}× range · ${c.bigDrop.volRatio}× vol · ${hm(c.bigDrop.t + 300000)}`}</span></> : <span className="muted">none</span>}</td></tr>))
          : <tr><td colSpan={6} className="empty">{d.status === "error" ? "The scan failed: see the error above (and the terminal where node server.js runs)." : "Loaded after the first scan (a few seconds after the next 5-minute close)."}</td></tr>}</tbody></table></div>
    </section>
  );
}

export function ScalpFoot() {
  return <div className="foot">How it works: a few seconds after every 5-minute candle closes, the app reads the last 150 five-minute candles of the 50 most liquid Binance USDⓈ-M perpetuals (by 30-day volume; no stablecoins, no perpetuals on stocks, ETFs or commodities). A signal needs a flush candle (open minus close at least 2.5x the coin&apos;s ATR(14) before it, and volume at least 4x the average of the 20 candles before it) followed by a green candle that closes above the middle of the flush, on a coin whose ATR is 0.6%+ of the price. It is followed with the tested plan: entry at the next candle&apos;s open, stop 0.1 ATR under the lower of the two lows, target 1.5x the risk, otherwise closed at the end of the 12th candle; a candle touching both counts as the stop; 0.12% fees per trade. One signal per coin per hour. Settings: SCALP_MIN_DROP_ATR, SCALP_MIN_VOLUME_RATIO, SCALP_MIN_ATR_PCT, SCALP_COST_PCT, SCALP_TELEGRAM, SCALP=0 to switch the tab off.</div>;
}

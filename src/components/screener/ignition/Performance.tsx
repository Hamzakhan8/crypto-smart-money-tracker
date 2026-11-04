"use client";
// Alert performance (the classic page's drawPerf): how the alerts turned out, per tier, what separates winners from
// losers, the exit rules compared, alert speed and whether the AI helps.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useScreener } from "../context";
import { Kpi } from "../ui";
import { AiCalibrationRows, AiVerdictRows, ExitRows, GroupRows, SpeedRows } from "../results";
import { col, pct } from "@/lib/format";
import { cfg, cx, fx } from "./util";

const n0 = (v: any) => (v == null ? "—" : `${fx(v, 0)}%`);
const pc = (v: any) => (v == null ? "—" : pct(v));

function TierRow({ name, x = {} }: { name: string; x?: any }) {
  return (
    <tr><td><b>{name}</b></td><td className="mono">{x.resolved}</td><td className="mono green">{x.wins}</td><td className="mono red">{x.losses}</td><td className="mono">{x.flat}</td><td className="mono">{x.pending}</td>
      <td className="mono">{n0(x.winRatePct)}</td><td className="mono">{n0(x.profitablePct)}</td>
      <td className={cx("mono", col(x.expectancyPct))}>{pc(x.expectancyPct)}</td><td className={cx("mono", col(x.netPct))}>{pc(x.netPct)}</td>
      <td className={cx("mono", col(x.avgPeakPct))}>{pc(x.avgPeakPct)}</td><td className={cx("mono", col(x.avgLowPct))}>{pc(x.avgLowPct)}</td></tr>
  );
}

export function Performance({ scope, setScope, exitTier, setExitTier }: { scope: string; setScope: (v: string) => void; exitTier: string; setExitTier: (v: string) => void }) {
  const { data } = useScreener();
  const st = data?.stats, c = cfg(data);
  const ready = !!(st && st.current);
  const blk = ready ? st[scope] || st.current : null, o = blk?.overall || {}, bm = st?.bigmove, byTier = blk?.byTier || {};
  const s = (n: number) => (n === 1 ? "" : "s");
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Alert performance</h2>
        <p id="perfRule">{ready ? `Exit rule: take profit at +${st.targetPct}%, stop at -${st.stopPct}%, otherwise sell after ${st.horizonHours}h (judged on 1-minute candles). Results are after ${st.feePct}% fees and ${st.slippagePct ?? 0}% slippage.`
          + (bm && bm.on ? ` Big-move alerts have their own rule: +${bm.targetPct}% before -${bm.stopPct}% within ${bm.horizonHours / 24} days (their own row; not in the totals above).` : "") : "How alerts actually turned out."}</p></div>
        <div className="filters"><select id="perfScope" aria-label="Which alerts to include" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="current">This version only</option><option value="all">All alerts, incl. older versions</option></select>
          <span className="chip" id="perfChip">{!data ? "—" : ready ? `${o.total} alerts tracked` : "no data yet"}</span></div></div>
      <p className="perf-note" id="perfNote">{!ready ? null : scope === "current"
        ? (st.olderCount ? `Showing only alerts from scanner v${st.version}. ${st.olderCount} older alert${s(st.olderCount)} used earlier rules, so they are kept out of these numbers (switch to "All alerts" to see them).` : `Showing alerts from scanner v${st.version}.`)
        : `Includes ${st.olderCount} alert${s(st.olderCount)} from earlier logic. Their flat results were not recorded, so they count as 0%.`}</p>
      <div className="kpis" style={{ padding: "0 18px", margin: "0 0 8px" }}>
        <Kpi label="Resolved alerts" value={ready ? o.resolved : "—"} hint={ready ? `${o.wins} win · ${o.losses} loss · ${o.flat} flat` : "win / loss / flat"} />
        <Kpi label="Closed in profit" value={ready ? (o.profitablePct == null ? n0(o.winRatePct) : n0(o.profitablePct)) : "—"}
          hint={ready ? `after costs · hit the +${st.targetPct}% target ${n0(o.winRatePct)}` : "after fees and slippage"} />
        <Kpi label="Avg result per alert" value={ready ? pc(o.netPct) : "—"} cls={ready ? (o.netPct > 0 ? "green" : o.netPct < 0 ? "red" : undefined) : undefined}
          hint={ready ? `After ${st.costPct ?? st.feePct}% fees and slippage · gross ${pc(o.expectancyPct)}` : "After fees"} />
        <Kpi label="Still pending" value={ready ? o.pending : "—"} hint="Not yet resolved" />
      </div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Tier</th><th>Resolved</th><th>Wins</th><th>Losses</th><th>Flat</th><th>Pending</th><th>Hit target</th><th>In profit</th><th>Avg (gross)</th><th>Avg (after fees)</th><th>Avg peak</th><th>Avg low</th></tr></thead>
        <tbody id="perfTiers">{ready && <>
          <TierRow name="Confirmed ignition" x={byTier.ignition} />
          {byTier.early && <TierRow name={`Early ignition${c.earlyAlerts === false ? " (alerts off)" : ""}`} x={byTier.early} />}
          <TierRow name={`Daily setup${c.setupAlerts ? "" : " (alerts off)"}`} x={byTier.setup} />
          {bm && byTier.bigmove && <TierRow name={`Big move (+${bm.targetPct}% / -${bm.stopPct}% / ${bm.horizonHours / 24}d)${bm.on ? "" : " (off)"}`} x={byTier.bigmove} />}
        </>}</tbody></table></div>
      <div className="section-head" style={{ paddingBottom: 6 }}><div><h2 style={{ fontSize: 13 }}>What separates winners from losers</h2><p>Ignition alerts split by feature. Do not trust a row until it has 20+ resolved alerts.</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Group</th><th>Resolved</th><th>Hit target</th><th>In profit</th><th>Avg (after costs)</th><th>Older half</th><th>Newer half</th><th>Both halves</th></tr></thead>
        <tbody id="perfBuckets">{ready && <GroupRows gs={blk.buckets} empty="Groups appear once ignition alerts from this version have resolved." />}</tbody></table></div>
      <div className="subhead2"><div><h2>Exit rules compared</h2><p>Every alert since this update is also followed under these exits, on the same 1-minute candles. Pick the exit only once it has 30+ alerts and wins in both halves.</p></div>
        <select id="exitTier" aria-label="Which alerts" value={exitTier} onChange={(e) => setExitTier(e.target.value)}><option value="ignition">Confirmed ignition</option><option value="early">Early ignition</option><option value="bigmove">Big move</option></select></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Exit rule</th><th>Resolved</th><th>In profit</th><th>Avg (after costs)</th><th>Older half</th><th>Newer half</th><th>Best / worst</th></tr></thead>
        <tbody id="perfExits">{ready && <ExitRows rows={(blk.exits || {})[exitTier]} />}</tbody></table></div>
      <div className="subhead2"><div><h2>Alert speed</h2><p>How long after the 5-minute candle closed each alert fired, and where price was 1, 2 and 5 minutes later. If price usually runs before you can act, speed is costing you money.</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Measure</th><th>Average</th><th>Alerts</th><th>Ran away (+1%+)</th><th>Fell (-1%+)</th></tr></thead>
        <tbody id="perfSpeed">{ready && <SpeedRows sp={blk.speed} empty="Fills in with alerts from now on: each alert records its price 1, 2 and 5 minutes later." />}</tbody></table></div>
      <div className="subhead2"><div><h2>Is the AI helping?</h2><p>Outcomes by the automatic AI verdict, and whether its stated chance of hitting the target matches what happened.</p></div></div>
      <div className="lower" style={{ margin: 0, padding: "0 0 4px" }}><div className="table-wrap"><table className="table"><thead><tr><th>AI said</th><th>Resolved</th><th>Hit target</th><th>Avg (after costs)</th></tr></thead>
        <tbody id="perfAi">{ready && <AiVerdictRows ai={blk.ai} />}</tbody></table></div>
        <div className="table-wrap"><table className="table"><thead><tr><th>AI&apos;s chance of target</th><th>Alerts</th><th>AI said (avg)</th><th>Actually hit</th></tr></thead>
          <tbody id="perfCal">{ready && <AiCalibrationRows ai={blk.ai} />}</tbody></table></div></div>
      <div className="foot" style={{ padding: "0 18px 16px", margin: "12px 0 0" }}>Prices are sampled at each scan (about every 20 seconds), so a fast spike can be missed. A flat alert counts at its price when the window ends, a loss at the price where the stop was seen. Slippage and your own entry delay are not included. For a much bigger sample than live alerts, run <span className="mono">node screener-backtest.js</span>.</div>
    </section>
  );
}

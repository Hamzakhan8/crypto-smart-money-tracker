"use client";
// The BTC rotation tab's bigger panels: this week, the alt season meter, the forward record, the backtest (chart,
// strategies, recent decisions) and the narrative × regime heatmap. Same markup and wording as the classic page.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment, type ReactNode } from "react";
import { col, pct, pct1 } from "@/lib/format";
import { holdName, holdTxt, joined, rName, type RotationData } from "./shared";

// ---------- this week ----------
export function Week({ r }: { r: RotationData }) {
  const h = r.holdingsNow || {}, rec = r.record || {}, a = r.altSeason;
  const stat = (l: string, v: ReactNode, sub: ReactNode = "") => <div className="book-stat"><span>{l}</span><strong>{v}</strong>{sub ? <small>{sub}</small> : null}</div>;
  const same = holdTxt(h.combinedAlt) === holdTxt(h.combined);
  return (
    <div className="week">
      <div><div className="big">{holdTxt(h.combined)}</div><small>Narrative rule: the top 2 ranked narratives that are in an uptrend, equal weight.</small></div>
      <div><div className="big" style={{ fontSize: 17 }}>{(h.tokens || []).map(holdName).join(", ") || "—"}</div><small>Token rule: up to 5 coins scoring 65+ inside those narratives, equal weight.</small></div>
      {h.combinedAlt ? <div className="variant">Variant that holds BTC while the alt season meter says <b>BTC leading</b>: {same ? "same holdings this week" : <>would hold <b>{holdTxt(h.combinedAlt)}</b></>}. In the backtest it did a little better than the rule in both halves of the history (see Older / Newer half below), but the gain in the newer half is small, so it is shown for comparison and not used.</div> : null}
      <div className="stats">
        {stat("Next decision", rec.nextDecision ? rec.nextDecision : "—", rec.nextDecision ? "" : r.demo ? "not recorded in demo mode" : "after the first live load")}
        {stat("Last change", rec.lastChange ? rec.lastChange.to : "—", rec.lastChange ? `${rec.lastChange.date}, was ${rec.lastChange.from}` : "no change recorded yet")}
        {stat("Alt season", a ? <span className={a.state === "altsLead" ? "green" : a.state === "btcLeads" ? "red" : "amber"}>{a.label}</span> : "—")}
        {stat("Telegram on change", r.telegramOn ? <span className="green">On</span> : <span className="muted">Off</span>, r.telegramOn ? "regime or holdings change" : "switch on in Ignition › Telegram")}
      </div>
    </div>
  );
}

// ---------- alt season meter ----------
export function Alt({ r }: { r: RotationData }) {
  const a = r.altSeason;
  if (!a) return <div className="week"><div className="empty">Not enough history yet.</div></div>;
  const v = (n: number | null | undefined, up: number, dn: number) => (n == null ? 0 : n >= up ? 1 : n <= dn ? -1 : 0);
  const ic = (x: number) => (x > 0 ? <span className="v green">▲</span> : x < 0 ? <span className="v red">▼</span> : <span className="v muted">•</span>);
  const votes: [number, string, string][] = [
    [a.ethTrend ?? 0, "ETH/BTC", a.hasEth ? `${pct1(a.ethBtc30)} in 30 days, trend ${a.ethTrend > 0 ? "up" : a.ethTrend < 0 ? "down" : "flat"} (vs its 50-day average and the 20-day slope)` : "ETH history missing"],
    [v(a.altVsBtc30, 2, -2), "Typical narrative vs BTC", `median narrative ${pct1(a.altVsBtc30)} vs BTC over 30 days (up from +2%, down from −2%)`],
    [v(a.breadthPct, 55, 35), "Coins above their 20-day average", `${a.breadthPct ?? "—"}% of all narrative coins (up from 55%, down from 35%)`],
  ];
  const hist: { date: string; state: string | null }[] = a.history || [], first = hist.find((x) => x.state), last = hist[hist.length - 1];
  const cnt = (k: string) => hist.filter((x) => x.state === k).length;
  return (
    <div className="week">
      <div><span className={`altstate ${a.state}`}>{a.label}</span><small>{a.desc} Two or more votes the same way decide it.</small></div>
      <div className="votes">{votes.map(([x, l, d]) => <div className="vote" key={l}>{ic(x)}<div><b>{l}</b><small>{d}</small></div></div>)}</div>
      <div><div className="altbar" role="img" aria-label={`Alt season meter, last ${hist.length} days`}>
        {hist.map((x, i) => <i key={i} className={x.state || undefined} title={`${x.date}: ${x.state ? (r.altStates || {})[x.state].label : "no data"}`} />)}</div>
        <div className="altbar-l"><span>{first ? first.date : ""}</span><span>last {hist.length} days: alts led {cnt("altsLead")} · mixed {cnt("mixed")} · BTC led {cnt("btcLeads")}</span><span>{last ? last.date : ""}</span></div></div>
    </div>
  );
}

// ---------- forward record ----------
const rStat = (l: string, v: ReactNode, k = "", sub = "") => <div className="book-stat" key={l}><span>{l}</span><strong className={`mono ${k}`}>{v}</strong>{sub ? <small className="muted">{sub}</small> : null}</div>;
const open = <span className="muted">open</span>;
export function RecordPanel({ r }: { r: RotationData | null }) {
  const rec = r?.record || {}, sm = rec.summary || {}, decs: any[] = rec.decisions || [], ch: any[] = rec.changes || [];
  const RG = r?.regimes || {}, AS = r?.altStates || {};
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Forward record</h2><p>Every week the screener saves what the rule holds, with that day&apos;s prices, and judges it a week later with prices that came afterwards. Unlike the backtest it cannot be fitted to the past, and coins that are later delisted keep their last price.</p></div>
        <span className="chip">{!r ? "—" : rec.since ? `since ${rec.since} · ${sm.weeks} judged` : r.demo ? "off in demo mode" : "starts today"}</span></div>
      <div className="book-meta">{r && <>
        {rStat("Weeks judged", sm.weeks ?? 0)}
        {rStat("Rotation rule", sm.weeks ? pct1(sm.combinedPct) : "—", col(sm.combinedPct))}
        {rStat("Token picks", sm.weeks ? pct1(sm.tokensPct) : "—", col(sm.tokensPct))}
        {rStat("Hold BTC", sm.weeks ? pct1(sm.btcPct) : "—", col(sm.btcPct))}
        {rStat("Weeks beating BTC", sm.beatBtcPct == null ? "—" : `${sm.beatBtcPct}%`)}
        {rStat("Coin-list snapshots", rec.snapshots ?? 0, "", rec.firstSnapshot ? `daily since ${rec.firstSnapshot}` : "")}
        {rStat("Next decision", rec.nextDecision ? rec.nextDecision : "—")}
        {rStat("Narrative list changes", ch.length)}
      </>}</div>
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Week of</th><th>BTC regime</th><th>Alt season</th><th>Narratives held</th><th>Their return</th><th>Coins held</th><th>Their return</th><th>BTC return</th></tr></thead><tbody>
        {!r ? null : decs.length ? decs.map((d, i) => {
          const x = d.result;
          return (
            <tr key={`${d.date}-${i}`}><td className="mono">{d.date}<span className="sub">{x ? `judged ${d.exitDate}` : `open until ${d.exitDate}`}</span></td><td>{(RG[d.regime] || {}).label || d.regime || "—"}</td><td>{(AS[d.altState] || {}).label || "—"}</td>
              <td>{holdTxt(d.hold)}</td><td className={`mono ${x ? col(x.combinedPct) : ""}`}>{x ? pct1(x.combinedPct) : open}</td><td>{d.tokens.join(", ") || "—"}</td>
              <td className={`mono ${x ? col(x.tokensPct) : ""}`}>{x ? pct1(x.tokensPct) : open}</td><td className={`mono ${x ? col(x.btcPct) : ""}`}>{x ? pct1(x.btcPct) : open}</td></tr>);
        }) : <tr><td colSpan={8} className="empty">{r.demo ? "The forward record is kept only with live data (not in demo mode)." : "The first decision is saved after the first full history load; its result appears a week later."}</td></tr>}
      </tbody></table></div>
      <div className="changes">{ch.length ? <><b>Narrative list changes</b> (Binance tags, from the daily snapshots): {joined(ch.slice(0, 8).map((c) => <>{c.date} {c.narrative}
        {c.added.length ? <> <span className="green">+{c.added.join(", ")}</span></> : null}{c.removed.length ? <> <span className="red">−{c.removed.join(", ")}</span></> : null}</>), " · ")}</> : null}</div>
    </section>
  );
}

// ---------- backtest ----------
const COLORS: Record<string, string> = { combined: "var(--green)", tokens: "var(--blue)", btc: "var(--ink)", equal: "var(--amber)" };
const SHORT: Record<string, string> = { combined: "Rotation ranking", tokens: "Token picks", btc: "Hold BTC", equal: "All narratives" };
const SHOW = ["combined", "tokens", "equal", "btc"];

/** Growth of each strategy since the start, log scale (the classic page's SVG, drawn the same way). */
function Chart({ bt }: { bt: any }) {
  const S: Record<string, any> = Object.fromEntries(bt.strategies.map((s: any) => [s.key, s])), n = bt.weeks + 1;
  const W = 900, H = 270, P = { l: 52, r: 12, t: 12, b: 28 };
  const all: number[] = SHOW.flatMap((k) => (S[k] ? S[k].curve : [])).filter((v: number) => v > 0);
  let lo = Math.log(Math.min(...all)), hi = Math.log(Math.max(...all));
  if (hi - lo < 0.1) { hi += 0.05; lo -= 0.05; }
  const x = (i: number) => P.l + (i / (n - 1)) * (W - P.l - P.r), y = (v: number) => P.t + (1 - (Math.log(v) - lo) / (hi - lo)) * (H - P.t - P.b);
  const ticks = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 20, 50, 100].filter((v) => Math.log(v) >= lo && Math.log(v) <= hi);
  const mid = Math.floor((n - 1) / 2);
  const marks: [number, string, "start" | "middle" | "end"][] = [[0, bt.dates[0], "start"], [mid, bt.dates[mid], "middle"], [n - 1, bt.to, "end"]];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Growth of each strategy since ${bt.from}`}>
      {ticks.map((v) => <Fragment key={v}>
        <line x1={P.l} x2={W - P.r} y1={y(v).toFixed(1)} y2={y(v).toFixed(1)} stroke="var(--line)" strokeDasharray={v === 1 ? undefined : "3 4"} />
        <text x={P.l - 8} y={(y(v) + 4).toFixed(1)} fill="var(--muted)" fontSize="11" textAnchor="end">{v === 1 ? "start" : `${v > 1 ? "+" : ""}${Math.round((v - 1) * 100)}%`}</text>
      </Fragment>)}
      {marks.map(([i, d, a]) => <text key={a} x={x(i).toFixed(1)} y={H - 8} fill="var(--muted)" fontSize="11" textAnchor={a}>{d}</text>)}
      {[...SHOW].reverse().map((k) => {
        const s = S[k]; if (!s) return null;
        return <polyline key={k} fill="none" stroke={COLORS[k]} strokeWidth={k === "combined" ? 2.6 : 1.5} strokeLinejoin="round" points={s.curve.map((v: number, i: number) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} />;
      })}
    </svg>
  );
}

export function BacktestPanel({ r }: { r: RotationData | null }) {
  const bt = r?.backtest;
  const S: Record<string, any> = bt ? Object.fromEntries(bt.strategies.map((s: any) => [s.key, s])) : {};
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Backtest</h2>
        <p>{bt ? `Every ${r!.holdDays} days each rule decides using only what was known that day, pays ${r!.feePct}% per round trip and holds until the next decision. Log scale. Older / Newer half: the same rule on each half of the weeks; a change is only worth making if it wins in both.` : "Each week the rules decide using only what was known that day."}</p></div>
        <span className="chip">{!r ? "—" : bt ? `${bt.from} to ${bt.to} · ${bt.weeks} decisions` : "not enough history"}</span></div>
      <div className="chart">{!r ? null : bt ? <Chart bt={bt} /> : <div className="empty">The backtest needs about 300 days of narrative history.</div>}</div>
      <div className="legend">{bt && SHOW.filter((k) => S[k]).map((k) => <span key={k}><i style={{ background: COLORS[k] }} />{SHORT[k]} <b className={`mono ${col(S[k].totalPct)}`}>{pct1(S[k].totalPct)}</b></span>)}</div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Strategy</th><th>Total</th><th>Per year</th><th>Worst drop</th><th>Sharpe</th><th>Weeks beating BTC</th><th>Time in cash</th><th>Switches</th><th>Older half</th><th>Newer half</th></tr></thead><tbody>
        {bt && bt.strategies.map((s: any) => (
          <tr key={s.key}><td><b>{s.label}</b></td><td className={`mono ${col(s.totalPct)}`}>{pct1(s.totalPct)}</td><td className={`mono ${col(s.cagrPct)}`}>{pct1(s.cagrPct)}</td><td className="mono red">{pct1(s.maxDdPct)}</td>
            <td className="mono">{s.sharpe ?? "—"}</td><td className="mono">{s.key === "btc" ? "—" : `${s.beatBtcPct}%`}</td><td className="mono">{s.cashPct}%</td><td className="mono">{s.switches}</td>
            <td className={`mono ${col(s.olderPct)}`}>{pct1(s.olderPct)}</td><td className={`mono ${col(s.newerPct)}`}>{pct1(s.newerPct)}</td></tr>))}
      </tbody></table></div>
    </section>
  );
}

export function RecentPanel({ r }: { r: RotationData | null }) {
  const bt = r?.backtest;
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Recent backtest decisions</h2><p>What the ranking held each week in the replay and how it did vs BTC</p></div></div>
      <div className="table-wrap"><table className="table"><thead><tr><th>Week of</th><th>BTC regime</th><th>Narratives held</th><th>Their return</th><th>Coins held</th><th>Their return</th><th>BTC return</th></tr></thead><tbody>
        {bt && (bt.recent || []).map((w: any, i: number) => (
          <tr key={`${w.date}-${i}`}><td className="mono">{w.date}</td><td>{((r!.regimes || {})[w.regime] || {}).label || w.regime || "—"}</td><td>{w.hold.map(holdName).join(" + ") || "—"}</td>
            <td className={`mono ${col(w.combinedPct)}`}>{pct1(w.combinedPct)}</td><td>{w.tokens.map(holdName).join(", ")}</td><td className={`mono ${col(w.tokensPct)}`}>{pct1(w.tokensPct)}</td><td className={`mono ${col(w.btcPct)}`}>{pct1(w.btcPct)}</td></tr>))}
      </tbody></table></div>
    </section>
  );
}

// ---------- every narrative in every BTC regime ----------
export function HeatPanel({ r }: { r: RotationData | null }) {
  const hm = r?.ranking ? r.heatmap : null, RG = r?.regimes, keys: string[] = hm ? hm.regimes : [], now = r?.regimeNow?.key;
  const max = hm ? Math.max(1, ...hm.rows.flatMap((row: any) => keys.map((k) => Math.abs((row.cells[k] || {}).avgPct || 0)))) : 1;
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="section-head"><div><h2>Every narrative in every BTC regime</h2><p>Average return vs BTC over the following week · hit rate below. Faded cells have low confidence. The highlighted column is the regime BTC is in now.</p></div></div>
      <div className="table-wrap"><table className="table heat">
        <thead>{hm && <tr><th>Narrative</th>{keys.map((k) => <th key={k} className={k === now ? "now" : undefined}>{rName(RG, k)}<span className="sub">{hm.regimeWeeks[k]} weeks</span></th>)}</tr>}</thead>
        <tbody>{hm && hm.rows.map((row: any) => (
          <tr key={row.name}><td><b>{row.name}</b></td>{keys.map((k) => {
            const c = row.cells[k];
            if (!c) return <td key={k} className="cell muted">—</td>;
            const a = (Math.min(1, Math.abs(c.avgPct) / max) * 0.55 + 0.05).toFixed(2), bg = c.avgPct >= 0 ? `rgba(54,211,153,${a})` : `rgba(251,113,133,${a})`;
            return <td key={k} className={`cell ${c.confidence === "low" ? "lowconf" : ""}`} style={{ background: bg, boxShadow: k === now ? "inset 0 0 0 1px var(--green)" : undefined }}
              title={`${row.name} when ${RG![k].label}: ${pct(c.avgPct)} vs BTC per week on average, beat BTC ${c.hitPct}% of weeks, ${c.weeks} weeks, ${c.confidence} confidence`}>{pct1(c.avgPct)}<small>{c.hitPct}% · {c.weeks}w</small></td>;
          })}</tr>))}</tbody>
      </table></div>
    </section>
  );
}

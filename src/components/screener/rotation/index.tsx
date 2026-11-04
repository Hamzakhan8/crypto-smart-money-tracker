"use client";
// The BTC rotation tab: BTC's daily regime, what the rule holds this week, the alt season meter, how regimes behave,
// the narrative ranking, token picks, the forward record, the backtest and the narrative × regime heatmap.
// Data: GET /api/rotation every 30 seconds (the engine refreshes the history once a day after the daily close).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactNode } from "react";
import { col, pct, pct1, price } from "@/lib/format";
import { Sec, useScreener } from "../context";
import { usePoll } from "../ui";
import { Alt, BacktestPanel, HeatPanel, RecentPanel, RecordPanel, Week } from "./panels";
import { conf, joined, rName, type RotationData } from "./shared";

const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const now1 = (now: RotationData["regimeNow"], k: string) => (now && k === now.key ? <> <span className="badge strong">now</span></> : null);

/** The message box at the top: a failed or partial history refresh, Binance asking to slow down, or no answer at all. */
function MessageBox({ r, error }: { r: RotationData | null; error: string | null }) {
  let msg = "";
  if (r) {
    if (r.error) msg = `History refresh failed: ${r.error}.${r.nextRetryAt ? ` Retrying automatically at ${hm(r.nextRetryAt)}.` : ""}${r.ranking ? " Showing the last good data." : ""}`;
    else if (r.warning) msg = `${r.warning}. Retrying ${r.nextRetryAt ? `at ${hm(r.nextRetryAt)}` : "later"}; everything that did load is used below.`;
    if (r.binancePausedUntil) msg += ` Binance asked to slow down, so Binance calls resume at ${hm(r.binancePausedUntil)}.`;
  }
  // as on the classic page, a failed request keeps the box's last colour (red before the first answer)
  const cls = r && !r.error ? "notice" : "error";
  if (error) return <div className={cls} style={{ display: "block", margin: msg ? "0 0 14px" : undefined }}>Cannot load /api/rotation: {error}</div>;
  return msg ? <div className={cls} style={{ display: "block", margin: "0 0 14px" }}>{msg.trim()}</div> : null;
}

function Hero({ r }: { r: RotationData | null }) {
  const stat = (l: string, v: ReactNode, k = "") => <div className="book-stat" key={l}><span>{l}</span><strong className={`mono ${k}`}>{v}</strong></div>;
  let title = "Loading history…", desc = "The first load downloads daily candles for every narrative coin and takes a few minutes. It refreshes once a day after the daily close.";
  let asOf = "", age: ReactNode = null, strip: ReactNode = null, stats: ReactNode = null;
  if (r && !r.ranking) {
    const p = r.progress;
    title = r.status === "error" ? "Could not load history yet" : "Loading history…";
    desc = (p ? `${p.step}: ${p.done} of ${p.total}.` : "The first load downloads daily candles for every narrative coin from Binance and takes a few minutes.") + (r.status === "error" ? "" : " Later loads use the cache.");
  } else if (r) {
    const RG = r.regimes || {}, now = r.regimeNow, b = r.btc || {}, rs = r.regimeStats || {};
    const later = Object.entries((rs[`in${r.holdDays}Days`] || {}) as Record<string, number>).sort((a, z) => z[1] - a[1]).slice(0, 3);
    asOf = `· daily close ${r.asOf}`;
    title = now ? now.label : "Not enough history";
    desc = now ? now.desc + (now.riskOff ? " The rules hold cash in this regime." : "") : "";
    if (now && rs.now === now.key) age = <>Day <b>{rs.ageDays}</b> of this regime · it usually lasts <b>{rs.medianDays[now.key] ?? "?"} days</b>
      {later.length ? <> · {r.holdDays} days later, in past days like this: {joined(later.map(([k, v]) => <>{rName(RG, k)} <b>{v}%</b></>), " · ")}</> : null}</>;
    strip = Object.keys(RG).map((k) => <span key={k} className={now && k === now.key ? `on${RG[k].riskOff ? " off" : ""}` : undefined} title={`${r.heatmap.regimeWeeks[k]} weeks of history`}>{rName(RG, k)}</span>);
    stats = <>
      {stat("BTC now", price(r.btcNow || b.close))}{stat("7 days", pct1(b.ret7), col(b.ret7))}{stat("30 days", pct1(b.ret30), col(b.ret30))}
      {stat("vs 20-day avg", pct1(b.vsSma20), col(b.vsSma20))}{stat("vs 50-day avg", pct1(b.vsSma50), col(b.vsSma50))}
      {stat("Volatility 14d / 60d", b.vol14 == null ? "—" : `${b.vol14.toFixed(1)}% / ${b.vol60.toFixed(1)}%`)}
    </>;
  }
  return (
    <section className="panel regime-hero">
      <div><div className="lbl">BTC regime now <span>{asOf}</span></div><h2>{title}</h2><p>{desc}</p><p className="regime-age">{age}</p><div className="regime-strip">{strip}</div></div>
      <div className="regime-stats">{stats}</div>
    </section>
  );
}

export default function RotationTab() {
  const { show } = useScreener();
  const { data: r, error } = usePoll<RotationData>("/api/rotation", 30_000);
  const full = r?.ranking ? r : null; // everything below the regime waits for the first full history load
  const RG = full?.regimes || {}, now = full?.regimeNow, rs = full?.regimeStats || {};
  const ranking: any[] = full?.ranking || [], picks: any[] = full?.picks || [];

  return (
    <>
      <details className="notice"><summary><b>Read this first:</b> rankings come from daily price history, measured week by week against BTC.</summary><div>Narrative lists and Binance listings are today&apos;s, so coins that died or were delisted are missing, which makes every narrative look better than it really was. A few years of data hold only a few dozen weeks of each BTC regime, so treat &quot;low&quot; confidence as noise. Not financial advice.</div></details>
      <MessageBox r={r} error={error} />
      <Sec id="now"><Hero r={r} /></Sec>
      {(show("now") || show("alt")) && <div className="lower" style={{ marginTop: 0 }}>
        <Sec id="now"><section className="panel"><div className="section-head"><div><h2>This week</h2><p>What the backtested rule holds. Re-decided every <span>{full ? full.holdDays : 7}</span> days; cash when BTC is in a downtrend.</p></div></div>
          {full ? <Week r={full} /> : <div className="week" />}</section></Sec>
        <Sec id="alt"><section className="panel"><div className="section-head"><div><h2>Alt season meter</h2><p>Is money moving from BTC into altcoins? Three signals vote: ETH/BTC trend, the typical narrative vs BTC, and how many coins are above their 20-day average.</p></div></div>
          {full ? <Alt r={full} /> : <div className="week" />}</section></Sec>
      </div>}
      {show("regimes") && <div className="lower">
        <section className="panel"><div className="section-head"><div><h2>How BTC regimes behave</h2><p>From the daily history: how long each regime usually lasts and what came right after it.</p></div></div>
          <div className="table-wrap"><table className="table cards"><thead><tr><th>BTC regime</th><th>Usually lasts</th><th>What came next</th></tr></thead><tbody>
            {full && Object.keys(RG).map((k) => {
              const nx = Object.entries(((rs.transitions || {})[k] || {}) as Record<string, number>).sort((a, z) => z[1] - a[1]).slice(0, 3), md = (rs.medianDays || {})[k];
              return <tr key={k}><td>{rName(RG, k)}{now1(now, k)}</td><td className="mono">{md == null ? "—" : md + (md === 1 ? " day" : " days")}</td>
                <td>{nx.length ? joined(nx.map(([to, v]) => <>{rName(RG, to)} <span className="mono">{v}%</span></>), " · ") : <span className="muted">—</span>}</td></tr>;
            })}
          </tbody></table></div></section>
        <section className="panel"><div className="section-head"><div><h2>Best narrative in each BTC regime</h2><p>Average return vs BTC over the following week, all history</p></div></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>BTC regime</th><th>Narrative</th><th>Avg vs BTC</th><th>Hit</th><th>Weeks</th><th>Confidence</th></tr></thead><tbody>
            {full && Object.keys(RG).map((k) => {
              const x = full.heatmap.bestByRegime[k];
              return <tr key={k}><td>{rName(RG, k)}{now1(now, k)}</td><td><b>{x ? x.name : <span className="muted">not enough data</span>}</b></td><td className={`mono ${x ? col(x.avgPct) : ""}`}>{x ? pct(x.avgPct) : "—"}</td>
                <td className="mono">{x ? `${x.hitPct}%` : "—"}</td><td className="mono">{x ? x.weeks : "—"}</td><td>{x ? conf(x.confidence) : "—"}</td></tr>;
            })}
          </tbody></table></div></section>
      </div>}
      <Sec id="ranking">
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="section-head"><div><h2>Narrative ranking</h2><p>Score = 50% how it did vs BTC in past weeks with this same BTC regime + 30% its 14-day strength vs BTC now + 20% share of its coins above their 20-day average. Only narratives in an uptrend can be held. Money flow = its share of all altcoin trading volume over 7 days, with the arrow comparing it to 30 days (shown, not scored: adding it made the backtest worse). Stage: early (more coins turning up, few at highs yet), running, late (most coins at 30-day highs or money leaving a strong run), cooling, quiet.</p></div>
            <span className="chip">{full ? `${ranking.length} narratives` : "—"}</span></div>
          <div className="table-wrap"><table className="table cards"><thead><tr><th>#</th><th>Narrative</th><th>Score</th><th>In this regime (history)</th><th>14d vs BTC</th><th>30d</th><th>Coins above 20d avg</th><th>Money flow</th><th>Stage</th><th>Trend</th><th>Held</th></tr></thead><tbody>
            {ranking.map((x, i) => {
              const s = x.regimeStat;
              return (
                <tr key={`${x.name}-${i}`}><td className="mono">{x.rank}</td><td><b>{x.name}</b><span className="sub">{x.members} coins · {x.category || ""}</span></td>
                  <td className="mono"><span className="score">{x.score}<span className="scorebar"><i style={{ width: `${x.score}%` }} /></span></span></td>
                  <td className={`mono ${s ? col(s.avgPct) : ""}`}>{s ? `${pct(s.avgPct)} / week` : "—"}<span className="sub">{s ? `beat BTC ${s.hitPct}% · ${s.weeks} weeks · ${s.confidence} confidence` : "no history in this regime"}</span></td>
                  <td className={`mono ${col(x.mom14)}`}>{pct1(x.mom14)}</td><td className={`mono ${col(x.ret30)}`}>{pct1(x.ret30)}</td><td className="mono">{x.breadthPct}%<span className="sub">a week ago {x.breadthPrevPct ?? "—"}%</span></td>
                  <td className="mono">{x.volShare7Pct == null ? "—" : `${x.volShare7Pct}%`}<span className={`sub ${x.flow >= 1.1 ? "green" : x.flow <= 0.9 ? "red" : ""}`}>{x.flow == null ? "" : (x.flow >= 1.1 ? "↑ rising " : x.flow <= 0.9 ? "↓ falling " : "→ steady ") + x.flow.toFixed(2) + "× vs 30d"}</span></td>
                  <td><span className={`stage ${x.stage || ""}`} title={`${x.atHighsPct ?? "—"}% of its coins within 3% of their 30-day high`}>{(full!.stages || {})[x.stage] || x.stage || "—"}</span></td>
                  <td className={x.trend ? "green" : "red"}>{x.trend ? "Up" : "Down"}</td><td>{x.held ? <span className="badge strong">Held</span> : null}</td></tr>);
            })}
          </tbody></table></div>
        </section>
      </Sec>
      <Sec id="picks">
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="section-head"><div><h2>Token picks in the top 3 narratives</h2><p>Daily price action: trend, 14-day strength vs BTC, distance from the 30-day high, not stretched above the 20-day average, rising volume. &quot;Bought&quot; = what the token rule would hold now.</p></div>
            <span className="chip">{full ? `${picks.length} coins` : "—"}</span></div>
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Coin</th><th>Narrative</th><th>Score</th><th>14d vs BTC</th><th>vs 30d high</th><th>vs 20d avg</th><th>Volume 7d vs 30d</th><th>Trend</th><th>Rule</th></tr></thead><tbody>
            {!full ? null : picks.length ? picks.map((t, i) => (
              <tr key={`${t.base}-${i}`}><td><b>{t.base}</b></td><td>{t.narratives.join(", ")}</td>
                <td className="mono"><span className="score">{t.score}<span className="scorebar"><i style={{ width: `${t.score}%` }} /></span></span></td>
                <td className={`mono ${col(t.rs14)}`}>{pct1(t.rs14)}</td><td className="mono">{pct1(t.distHigh)}</td><td className={`mono ${t.ext > 15 ? "red" : ""}`}>{pct1(t.ext)}</td>
                <td className={`mono ${t.volTrend >= 1.15 ? "green" : ""}`}>{t.volTrend == null ? "—" : `${t.volTrend.toFixed(2)}×`}</td>
                <td>{t.aboveSma20 ? "above 20d" : "below 20d"} · {t.aboveSma50 ? "above 50d" : "below 50d"}</td><td>{t.inStrategy ? <span className="badge strong">Bought</span> : null}</td></tr>))
              : <tr><td colSpan={9} className="empty">No coins with enough history in the top narratives.</td></tr>}
          </tbody></table></div>
        </section>
      </Sec>
      <Sec id="record"><RecordPanel r={full} /></Sec>
      <Sec id="backtest"><BacktestPanel r={full} /></Sec>
      <Sec id="regimes"><HeatPanel r={full} /></Sec>
      <Sec id="backtest"><RecentPanel r={full} /></Sec>
      <Sec id=""><div className="foot">How it works: every day BTC&apos;s daily price action is put into one of six regimes (breaking out, calm uptrend, uptrend, sideways, downtrend, falling hard). Each narrative is an equal-weight index of the largest coins carrying one of Binance&apos;s sector tags (AI, Meme, RWA, Gaming and so on). For every past day the screener records how each narrative did over the next week compared with BTC, grouped by the regime BTC was in. The ranking blends that history with current price action, and the backtest replays the same ranking week by week with fees, using only weeks that had already finished. Run <span className="mono">node rotation-backtest.js</span> for the full report in a terminal.</div></Sec>
    </>
  );
}

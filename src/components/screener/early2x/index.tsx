"use client";
// The Early 2x tab: low- and mid-cap Binance spot tokens showing measurable signs of a possible large move before price
// expands (quiet accumulation, pre-breakout, early ignition), the detail window behind each score, the measured
// results of every saved snapshot, recent snapshots and data health. Data: GET /api/early2x every 30 seconds.
import { Fragment, cloneElement, useCallback, useState } from "react";
import { pct, time } from "@/lib/format";
import { Sec, useScreener } from "../context";
import { Kpi, SourceRow, usePoll, useStateTabs } from "../ui";
import { DetailWindow } from "./DetailWindow";
import { CandidateRow, RecentRow, ResultsPanel } from "./rows";
import type { Early2xData, X2Candidate } from "./shared";

const TAB_HINT = {
  quiet: "Model A: volume at 2×+ its 7-day baseline with more trades while price stays calm. Sorted by priority, then score.",
  prebreakout: "Model A accumulation pressing a 7-day high that has been tested before (or with compressed volatility).",
  ignition: "Model B: the last 3+ five-minute candles at 2×+ normal volume, accelerating, with aggressive buying, before a big move.",
  moved: "Already stretched beyond limits set by each coin's own daily range. Listed so you do not chase them; tracked as a control group.",
};
const TITLES: Record<string, string> = { all: "Candidates", strong: "Early ignition", heating: "Quiet accumulation and pre-breakout", running: "Already moved — do not chase", take: "AI said TAKE" };
const healthCls = (v?: string) => (/^connected|^live/.test(v || "") ? "green" : /unavailable|error/.test(v || "") ? "red" : "amber");

export default function Early2xTab() {
  const { show, aiTake, data } = useScreener();
  const { data: xd, error } = usePoll<Early2xData>("/api/early2x", 30_000);
  const [detail, setDetail] = useState<X2Candidate | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);

  const u = xd?.universe || {}, tabs = xd?.tabs || {}, reg = xd?.regime;
  const errs = Object.entries(xd?.errors || {});
  const exN = Object.values(u.excluded || {}).reduce((a, b) => a + b, 0);
  const all = ["quiet", "prebreakout", "ignition"].flatMap((k) => tabs[k] || []);
  const allX = ["ignition", "prebreakout", "quiet", "moved"].flatMap((k) => (tabs[k] || []).map((c) => ({ ...c, state: c.state || k })));
  const x2 = useStateTabs("x2", allX, (c) => ({ strong: c.state === "ignition", heating: c.state === "quiet" || c.state === "prebreakout", running: c.state === "moved", take: aiTake(c.base) }),
    { strong: "Early ignition (Model B)", heating: "Quiet accumulation or pre-breakout (Model A)", running: "Already moved: do not chase", take: "The AI said TAKE in the last 2 hours" });
  const snaps = useStateTabs("xsnap", xd?.recent || [], (r) => {
    const t = r.track || {}, now = t.entry ? (t.last / t.entry - 1) * 100 : 0;
    return { strong: r.state === "ignition", heating: r.state === "quiet" || r.state === "prebreakout", running: r.state === "moved" || now >= 25, take: aiTake(r.base) };
  }, { strong: "Saved as an early ignition", heating: "Saved as quiet accumulation or pre-breakout", running: "Saved as already moved, or up 25%+ since the snapshot", take: "The AI said TAKE in the last 2 hours" });
  const xs = x2.current;
  // the detail window opens on the candidate as the server sent it (the classic page looked it up by symbol)
  const open = (sym: string) => setDetail(Object.values(tabs).flat().find((c) => c.symbol === sym) || null);
  const so = xd?.sources || {}, ai = so.assetInfo || {}, ex = Object.entries(u.excluded || {}).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <details className="notice"><summary><b>Research screen, not a prediction:</b> +100% is a research target.</summary><div>Coins are listed only when their data passes the rules, and every listed coin is saved as an unchangeable snapshot whose real returns are measured afterwards. Most early signals fail. The score is not a probability of doubling. Futures data is context only, and token unlocks and catalysts count only when you have verified them (data/early2x-events.json). Nothing is traded. Not financial advice.</div></details>
      {error ? <div className="error" style={{ display: "block" }}>Cannot load /api/early2x: {error}</div>
        : errs.length ? <div className="error" style={{ display: "block" }}>{errs.map(([k, v], i) => <Fragment key={k}>{i ? <br /> : null}<b>{k}:</b> {v}</Fragment>)}</div> : null}
      <Sec id="cand">
        <div className="kpis">
          <Kpi label="Coins evaluated" value={xd ? u.evaluated ?? "—" : "—"} hint={xd ? (u.pairs ? `of ${u.pairs} USDT pairs · ${exN} left out${u.tooNew ? ` · ${u.tooNew} too new` : ""}` : "—") : "$10M-$1B market cap, liquid"} />
          <Kpi label="High priority now" cls="green" value={xd ? all.filter((c) => c.priority === "high").length : "—"} hint={xd ? `${all.length} candidates in total · ${(tabs.moved || []).length} already moved` : "3+ independent confirmations"} />
          <Kpi label="BTC (market regime)" value={reg ? pct(reg.btc24) : "—"} cls={reg && reg.deteriorating ? "red" : undefined}
            hint={reg ? `24h · 4h ${pct(reg.btc4h)} · 7d ${pct(reg.btc7d)}${reg.deteriorating ? " · weak: no high priority" : ""}` : "—"} />
          <Kpi label="Signals tracked" value={xd ? xd.signalCount ?? "—" : "—"} hint={xd?.results ? `${xd.results.all.open} still open · 42-day tracking` : "snapshots with measured returns"} />
        </div>
      </Sec>
      <Sec id="cand">
        <section className="panel">
          <div className="section-head"><div><h2>{xd ? TITLES[xs] : "Candidates"}</h2>
            <p>{!xd ? "—" : xs === "strong" ? TAB_HINT.ignition : xs === "heating" ? `${TAB_HINT.quiet} ${TAB_HINT.prebreakout}` : xs === "running" ? TAB_HINT.moved : xs === "take" ? "Candidates the AI said TAKE on in the last 2 hours." : "Every candidate: early ignitions first, then pre-breakout, quiet accumulation and coins that already moved."}</p></div>
            <span className="chip">{!xd ? "—" : xd.lastScanAt ? `scanned ${time(xd.lastScanAt)} · every ${xd.config?.scanMinutes} min` : xd.status || "starting"}</span></div>
          {xd ? cloneElement(x2.bar, { "aria-label": "Filter candidates" }) : <div className="sttabs" role="tablist" aria-label="Filter candidates" />}
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Token</th><th>Score · state</th><th>Market cap</th><th>Price · targets</th><th>Volume vs normal</th><th>Buying</th><th>Price · structure</th><th>Liquidity</th><th>Futures · on-chain</th><th>Supply · events</th><th>Still missing</th></tr></thead><tbody>
            {!xd ? <tr><td colSpan={11} className="empty">Waiting for the first scan (about 30 seconds after start)…</td></tr>
              : x2.rows.length ? x2.rows.map((c) => <CandidateRow key={`${c.symbol}-${c.state}`} c={c} onOpen={() => open(c.symbol)} />)
              : <tr><td colSpan={11} className="empty">{xd.lastScanAt ? "No coin has enough evidence for this state right now. An empty list is a valid answer." : "Waiting for the first scan…"}</td></tr>}
          </tbody></table></div>
        </section>
      </Sec>
      <Sec id="results"><ResultsPanel loaded={!!xd} r={xd?.results} /></Sec>
      {(show("snaps") || show("health")) && <div className="lower">
        <Sec id="snaps"><section className="panel"><div className="section-head"><div><h2>Recent snapshots</h2><p>Saved before the move, never changed afterwards. Returns are measured from the snapshot price.</p></div></div>
          {xd ? cloneElement(snaps.bar, { "aria-label": "Filter snapshots" }) : <div className="sttabs" role="tablist" aria-label="Filter snapshots" />}
          <div className="events">{!xd ? <div className="empty">No snapshots yet.</div>
            : snaps.rows.length ? snaps.rows.slice(0, 25).map((s, i) => <RecentRow key={s.id || i} s={s} />)
            : <div className="empty">{snaps.empty("No snapshots yet. A quiet market is normal.")}</div>}</div></section></Sec>
        <Sec id="health"><section className="panel"><div className="section-head"><div><h2>Data health</h2><p>Missing data earns no points and blocks high priority.</p></div></div>
          <div className="source-list">{xd && <>
            {([["Binance Spot (candles, trades, order book)", so.spot], ["Binance asset info (circulating supply)", ai.source ? (ai.source === "live" ? `live · ${ai.coins} coins` : ai.source) : "—"],
              ["CoinGecko (supply, market cap check)", so.coingecko], ["Binance Futures (context only)", so.futures], ["Verified unlocks and catalysts", so.events]] as [string, string | undefined][])
              .map(([k, v]) => <SourceRow key={k} label={k} cls={healthCls(v)}>{v || "—"}</SourceRow>)}
            {ex.map(([k, v]) => <SourceRow key={`x-${k}`} label={`Left out: ${k}`}>{v}</SourceRow>)}
            <SourceRow label="Telegram alerts" cls={xd.telegramOn ? "green" : "amber"}>{xd.telegramOn ? "on (high priority only)" : !(data?.telegram || {}).configured ? "Telegram is not set up (README: Set up Telegram alerts)" : "off · switch on in Ignition › Telegram"}</SourceRow>
            <SourceRow label="Last scan" cls="mono">{time(xd.lastScanAt)}{xd.lastScanMs != null ? ` · ${(xd.lastScanMs / 1000).toFixed(1)}s` : ""}</SourceRow>
          </>}</div></section></Sec>
      </div>}
      <Sec id=""><div className="foot">How it works: every few minutes the screen reads Binance spot data for USDT pairs with a verified market cap of $10M-$1B (Binance&apos;s circulating supply × price, cross-checked with CoinGecko), at least $1M of 24h volume and a spread of 0.30% or less. Stablecoins, wrapped and staked tokens, tokenized stocks and leveraged tokens are left out. <b>Model A (quiet accumulation)</b>: 24h volume at least 2× its 7-day baseline, with more trades, held over several hours, while price stays within a band set by the coin&apos;s own daily range. Pre-breakout is the same, pressing a tested 7-day high. <b>Model B (early ignition)</b>: the last 3+ five-minute candles each at 2×+ normal volume for that hour, accelerating, with aggressive buying and price rising. Evidence is grouped into five independent families (activity, executed buying, structure, order book, strength vs BTC). Volume and trade count, CVD and buy share, and large-trade buying measure overlapping things, so each group counts once. High priority needs 3+ families, a score of 50+ and passing liquidity, data, extension, BTC and supply checks (a market cap that Binance and CoinGecko disagree on, or under 40% of supply circulating, blocks it). Coins already stretched beyond limits that scale with their own volatility go to &quot;Already moved&quot;. Those are tracked too, as a control group. All settings are EARLY2X_* in .env; Telegram alerts stay off until EARLY2X_ALERTS=1.</div></Sec>
      {detail && <DetailWindow c={detail} onClose={closeDetail} />}
    </>
  );
}

"use client";
// The Alpha tab: Binance Alpha ignition (the classic page's #view-alpha). Data: GET /api/alpha every 30 s. Candidates
// with state tabs, alerts and their tracked results ("I took it" opens the journal), live results in detail, the replay
// of the same rule on past candles, data health, and "Ask AI" on any token.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useLayoutEffect, useState } from "react";
import { col, pct1 } from "@/lib/format";
import { Sec, useScreener } from "../context";
import { AiCalibrationRows, AiVerdictRows, ExitRows, GroupRows, SpeedRows } from "../results";
import { ErrorBox, Kpi, SafeLink, usePoll, useStateTabs } from "../ui";
import { AiCheckPanel, useAiCheck } from "./AiCheck";
import { AiBadge, aAgo, aPx, Buys, EXPL, hm, StateBadge, tx, wusd } from "./bits";

// GET /api/alpha (only the fields the tab reads are named; rows and alerts carry many more).
interface AlphaData {
  status?: string; error?: string | null; updatedAt?: number; nextScanAt?: number; scanMs?: number; listed?: number; eligible?: number;
  excluded?: Record<string, number>; sources?: { alpha?: string; dex?: string }; config?: any; telegramOn?: boolean; telegramKinds?: { early?: boolean };
  counts?: { ignited?: number; heating?: number }; rows?: any[]; alerts?: any[]; results?: any; resultsEarly?: any; replay?: any; stats?: any;
}
const RULE = "Early ignition: two finished 5-minute candles in a row, each at 5× the token's normal 5-minute volume (median of the last 24 hours) and $1,000+ with 10+ trades, price up over those 10 minutes (but not more than 20%), and not already up 30% in 24 hours. Confirmed: the same with $1M+ traded in the last 24 hours.";
const CAND_HINTS = { strong: "Igniting now (early or confirmed)", heating: "Volume rising, not confirmed yet", running: "Up 30%+ in 24 hours: do not chase", take: "The AI said TAKE in the last 2 hours (Ask AI or an alert review)" };
const ALERT_HINTS = { strong: "Confirmed alerts ($1M+ traded in 24h)", heating: "Early alerts (first signal)", running: "Already up 10%+ since the alert, or hit the target: too late to enter", take: "The AI's review of this alert said TAKE" };
const DAY = 86_400_000;

export default function AlphaTab() {
  const { show, aiTake, openJournal, data: screener } = useScreener();
  const { data: ad, error } = usePoll<AlphaData>("/api/alpha", 30_000);
  const [filter, setFilter] = useState("active");
  const [exitTier, setExitTier] = useState("confirmed");
  const ai = useAiCheck();
  const loaded = ad != null, d: AlphaData = ad || {}, c = d.config || {};

  // ---- candidates: "Ignited, heating, moved" leaves out quiet tokens, but only under the All state tab ----
  const all = d.rows || [];
  const [stCand, setStCand] = useState("all"); // the state tab of the candidates, as last rendered
  const cand = useStateTabs("acand", filter === "all" || stCand !== "all" ? all : all.filter((r) => r.state !== "quiet"),
    (r) => ({ strong: r.state === "ignited", heating: r.state === "heating", running: r.state === "ran", take: aiTake("A:" + r.alphaId) }), CAND_HINTS);
  useLayoutEffect(() => { if (cand.current !== stCand) setStCand(cand.current); }, [cand.current, stCand]);

  // ---- alerts ----
  const al0 = d.alerts || [];
  const alerts = useStateTabs("aalerts", al0, (a) => {
    const tr = a.track || {}, now = a.f && tr.last ? (tr.last / a.f.close - 1) * 100 : 0;
    return { strong: (a.tier || "confirmed") === "confirmed", heating: a.tier === "early", running: tr.status === "win" || (tr.status === "open" && now >= 10), take: !!(a.ai && a.ai.decision === "TAKE") };
  }, ALERT_HINTS);
  const tookIt = (a: any) => {
    const row = all.find((r) => r.alphaId === a.alphaId);
    openJournal({ tool: "alpha", symbol: a.token.symbol, alphaId: a.alphaId, price: (row && row.f && row.f.close) || (a.track && a.track.last) || a.f.close, alertPrice: a.f.close,
      alertId: a.id, stop: a.f.close * (1 - (c.stopPct || 10) / 100), target: a.f.close * (1 + (c.targetPct || 40) / 100) });
  };

  const errText = error ? `Cannot load /api/alpha: ${error}`
    : d.error ? (d.status === "off" ? d.error : `Last scan failed: ${d.error}${d.rows && d.rows.length ? " (showing the last good scan)" : ""}`) : null;
  const n = d.counts || {}, R = d.results || {}, E = d.resultsEarly || {}, S = d.stats || {}, so = d.sources || {}, rp = d.replay;
  const exc = Object.entries(d.excluded || {}).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <details className="notice"><summary><b>Read this first:</b> Binance Alpha tokens are early on-chain tokens with thin pools; most volume ignitions fade.</summary>
        <div>{"Data comes from the public endpoints Binance's own Alpha pages use (not documented, so they can change) and from DexScreener for buys vs sells, because Alpha trades carry no buyer/seller side. Pool liquidity is often a few hundred thousand dollars, so a market order moves the price; tokens can be delisted from Alpha. Every alert is tracked (+40% target before -10% stop within 7 days, after costs) so you can judge it, and the replay below shows how the same rule did in the past. Not financial advice."}</div></details>
      <ErrorBox>{errText}</ErrorBox>
      <Sec id="cand">
        <div className="kpis">
          <Kpi label="Tokens scanned" value={d.eligible ?? "—"} hint={loaded && d.listed ? `of ${d.listed} Alpha tokens · next scan ${hm(d.nextScanAt)}` : "Binance Alpha, not on spot"} />
          <Kpi label="Ignited now" value={n.ignited ?? "—"} cls="green"
            hint={loaded ? `${all.filter((r) => r.tier === "early").length} early · ${all.filter((r) => r.tier === "confirmed").length} confirmed` : "early · confirmed"} />
          <Kpi label="Heating up" value={n.heating ?? "—"} cls="amber" hint="Volume rising, not confirmed yet" />
          <Kpi label="Confirmed alerts, tracked" value={loaded ? (R.closed ? `${R.winPct}% · ${pct1(R.avgNetPct)}` : R.alerts ? `${R.alerts} open` : "0") : "—"}
            hint={loaded ? (R.closed ? `${R.closed} closed (${R.wins} hit +${c.targetPct}%, ${R.losses} stopped, ${R.flats} timed out) · ${R.open} open` : `hit +${c.targetPct ?? 40}% first · average after costs`)
              + (E.alerts ? ` · early tier: ${E.closed ? `${E.winPct}% · ${pct1(E.avgNetPct)} on ${E.closed} closed` : `${E.alerts} open`}` : "") : "hit +40% first · average after costs"} />
        </div>
        <section className="panel">
          <div className="section-head"><div><h2>Ignition candidates</h2><p>{c.volMult ? `Early ignition: two finished 5-minute candles in a row, each at ${c.volMult}× the token's normal 5-minute volume (median of the last 24 hours) and $${Number(c.minCandleUsd).toLocaleString()}+ with ${c.minTrades}+ trades, price up over those 10 minutes (but not more than ${c.maxMove10mPct}%), and not already up ${c.maxChg24Pct}% in 24 hours. Confirmed: the same with ${wusd(c.min24hUsd)}+ traded in the last 24 hours. Tokens need $${Math.round(c.minLiquidityUsd / 1000)}k+ of pool liquidity and ${Number(c.minHolders).toLocaleString()}+ holders.` : RULE}</p></div>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show"><option value="active">Ignited, heating, moved</option><option value="all">All scanned tokens</option></select></div>
          {loaded ? cand.bar : <div className="sttabs" role="tablist" aria-label="Filter tokens" />}
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Token</th><th>State</th><th>Last two 5m candles</th><th>Price</th><th>DEX buys (5m · 1h)</th><th>Liquidity · holders</th><th>Market cap · FDV</th></tr></thead>
            <tbody>{!loaded ? <tr><td colSpan={7} className="empty">Waiting for the first scan (about 15 seconds after start, then every 5 minutes)…</td></tr>
              : cand.rows.length ? cand.rows.map((r) => <CandRow key={r.alphaId} r={r} c={c} onAsk={() => ai.ask(r.alphaId, r.symbol)} />)
              : <tr><td colSpan={7} className="empty">{d.status === "starting" ? "First scan in progress (it reads 5-minute candles for every token, about a minute)…" : all.length ? "Nothing ignited, heating up or moved right now. Choose \"All scanned tokens\" to see every token." : "No tokens yet."}</td></tr>}
            </tbody></table></div>
        </section>
      </Sec>
      {(show("alerts") || show("replay")) && <div className="stack">
        <Sec id="alerts"><section className="panel"><div className="section-head"><div><h2>Alerts and results</h2>
          <p>{loaded ? `Every alert, tracked from its price: +${c.targetPct ?? 40}% target before -${c.stopPct ?? 10}% stop within ${c.outcomeDays ?? 7} days, after ${c.costPct ?? 1}% costs.` : "Every alert, tracked from its price: +40% target before -10% stop within 7 days, after costs."}</p></div>
          <span className="chip">{loaded ? (al0.length ? `${al0.length} recent` : "none yet") : "—"}</span></div>
          {loaded ? alerts.bar : <div className="sttabs" role="tablist" aria-label="Filter alerts" />}
          <div className="table-wrap"><table className="table cards"><thead><tr><th>Alert</th><th>Token</th><th>Tier</th><th>Entry</th><th>Volume</th><th>DEX buys</th><th>AI</th><th>Result</th></tr></thead>
            <tbody>{loaded && (alerts.rows.length ? alerts.rows.map((a) => <AlertRow key={a.id} a={a} onTook={() => tookIt(a)} />)
              : <tr><td colSpan={8} className="empty">{alerts.empty("No alerts yet. In the replay the confirmed tier fired about 8 times a day across all Alpha tokens, the early tier about 50.")}</td></tr>)}</tbody></table></div>
        </section></Sec>
        <Sec id="replay"><section className="panel"><div className="section-head"><div><h2>Replay</h2><p>The same rule on past Alpha candles, delisted tokens included, from <span className="mono">node alpha-backtest.js</span>.</p></div>
          <span className="chip">{!loaded ? "—" : rp ? `${rp.from} to ${rp.to} · ${rp.days} days` : "not run yet"}</span></div>
          <div className="hold">{loaded && <Replay rp={rp} />}</div></section></Sec>
      </div>}
      {show("cand") && ai.box && <AiCheckPanel box={ai.box} onClose={ai.close} scrolled={ai.scrolled} />}
      <Sec id="live"><section className="panel" style={{ marginTop: 14 }}>
        <div className="section-head"><div><h2>Live results in detail</h2><p>Every Alpha alert since this update: alternative exits on the same candles, alert speed, the conditions that paid, and the AI&apos;s record. Trust a row only with 30+ closed alerts.</p></div></div>
        <div className="subhead2"><div><h2>Exit rules compared</h2><p>Pick an exit only once it has 30+ alerts and wins in both halves.</p></div>
          <select value={exitTier} onChange={(e) => setExitTier(e.target.value)} aria-label="Which tier"><option value="confirmed">Confirmed</option><option value="early">Early</option></select></div>
        <div className="table-wrap"><table className="table"><thead><tr><th>Exit rule</th><th>Resolved</th><th>In profit</th><th>Avg (after costs)</th><th>Older half</th><th>Newer half</th><th>Best / worst</th></tr></thead>
          <tbody>{loaded && <ExitRows rows={(S.exits || {})[exitTier]} />}</tbody></table></div>
        <div className="subhead2"><div><h2>Alert speed</h2><p>Delay after the candle closed, and price 5 and 15 minutes after the alert.</p></div></div>
        <div className="table-wrap"><table className="table"><thead><tr><th>Measure</th><th>Average</th><th>Alerts</th><th>Ran away (+2%+)</th><th>Fell (-2%+)</th></tr></thead>
          <tbody>{loaded && <SpeedRows sp={S.speed} empty="Fills in with alerts from now on: each alert records its price 5 and 15 minutes later." />}</tbody></table></div>
        <div className="subhead2"><div><h2>What separates winners from losers</h2><p>Closed alerts split by the conditions saved when they fired.</p></div></div>
        <div className="table-wrap"><table className="table"><thead><tr><th>Group</th><th>Resolved</th><th>Hit target</th><th>In profit</th><th>Avg (after costs)</th><th>Older half</th><th>Newer half</th><th>Both halves</th></tr></thead>
          <tbody>{loaded && <GroupRows gs={S.groups} empty="Groups appear once Alpha alerts have closed (7 days or the target / stop)." />}</tbody></table></div>
        <div className="subhead2"><div><h2>Is the AI helping?</h2><p>Confirmed alerts get an automatic AI verdict (with a Gemini key).</p></div></div>
        <div className="lower" style={{ margin: 0, padding: "0 0 4px" }}>
          <div className="table-wrap"><table className="table"><thead><tr><th>AI said</th><th>Resolved</th><th>Hit target</th><th>Avg (after costs)</th></tr></thead><tbody>{loaded && <AiVerdictRows ai={S.ai} />}</tbody></table></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>AI&apos;s chance of target</th><th>Alerts</th><th>AI said (avg)</th><th>Actually hit</th></tr></thead><tbody>{loaded && <AiCalibrationRows ai={S.ai} />}</tbody></table></div>
        </div>
      </section></Sec>
      <Sec id="health"><section className="panel" style={{ marginTop: 14 }}><div className="section-head"><div><h2>Data health</h2><p>Sources, scan time and why tokens were left out.</p></div></div>
        <div className="book-meta">{loaded && <>
          <Stat l="Binance Alpha (list, candles)">{so.alpha || "—"}</Stat>
          <Stat l="DexScreener (buys / sells)">{so.dex || "—"}</Stat>
          <Stat l="Last scan">{d.updatedAt ? hm(d.updatedAt) + (d.scanMs ? ` · ${Math.round(d.scanMs / 1000)}s` : "") : "—"}</Stat>
          <Stat l="Telegram">{d.telegramOn ? <><span className="green">On</span>{d.telegramKinds && d.telegramKinds.early ? " · early too" : ""}</>
            : !(screener?.telegram || {}).configured ? <span className="amber">Telegram not set up</span> : <span className="muted">Off (switch on in Ignition › Telegram)</span>}</Stat>
        </>}</div>
        <div className="changes">{exc.length > 0 && <><b>Left out:</b> {exc.map(([k, v]) => `${k} ${v}`).join(" · ")}</>}</div></section></Sec>
      <Sec id=""><details className="foot"><summary>How it works</summary>every 5 minutes, 5 seconds after the candle closes (the hottest tokens first), the scanner reads Binance&apos;s Alpha token list, keeps tokens that still trade, are not on Binance spot (the Ignition tab covers those), have $50k+ of pool liquidity and 1,000+ holders, and reads their 5-minute candles. &quot;Normal&quot; is the median 5-minute volume of the previous 24 hours (at least $100). <b>Early ignition</b> = the rule passed on the last two finished candles; <b>confirmed</b> = the same with $1M+ traded in the last 24 hours (in the replay the early tier did no better than buying at a random time and fired about 50 times a day; the confirmed tier did better than a random entry on the same kind of tokens, but it would have missed EVAA&apos;s Oct 27 start, because by the time $1M had traded EVAA was already up more than 30%); <b>heating up</b> = the last candle at 3× normal with price up, or the last hour at 3× normal; <b>already moved</b> = up more than 30% in 24 hours, do not chase. One alert per token and tier per 24 hours. Buys vs sells come from DexScreener (counts of DEX trades in the token&apos;s biggest pool). Telegram only with ALPHA_TELEGRAM=1 (confirmed alerts) or ALPHA_TELEGRAM=all (early too). Settings: ALPHA_VOL_MULT, ALPHA_MIN_5M_USD, ALPHA_MIN_24H_USD, ALPHA_MIN_LIQUIDITY, ALPHA_MIN_HOLDERS, ALPHA_TARGET_PCT, ALPHA_STOP_PCT, ALPHA_OUTCOME_DAYS, ALPHA_COST_PCT.</details></Sec>
    </>
  );
}

function Stat({ l, children }: { l: string; children: React.ReactNode }) {
  return <div className="book-stat"><span>{l}</span><strong>{children}</strong></div>;
}

function CandRow({ r, c, onAsk }: { r: any; c: any; onAsk: () => void }) {
  const f = r.f || {}, x = r.dex, ex = EXPL[r.chain], dex = !!(x && x.url);
  return (
    <tr>
      <td><b className="sym">{tx(r.symbol)}</b><span className="sub">{`${tx(r.chain)} · ${tx(r.name)}${r.ageDays != null ? ` · on Alpha ${r.ageDays}d` : ""}`}</span>
        <span className="sub">{dex && <SafeLink url={x.url}>DexScreener</SafeLink>}{ex && r.contract && <>{dex ? " · " : ""}<SafeLink url={ex + r.contract}>Contract</SafeLink></>}</span>
        <button className="btn xs" title="Ask Gemini about this token now" onClick={onAsk}>Ask AI</button></td>
      <td>{r.tier === "confirmed" ? <span className="badge strong">Confirmed</span>
        : r.tier === "early" ? <span className="badge strong" style={{ color: "var(--blue)", borderColor: "#2c4a77", background: "#111d30" }}>Early ignition</span>
        : <StateBadge state={r.state} />}
        {r.state !== "ignited" && r.fails && r.fails.length > 0 && <span className="sub">{r.fails.slice(0, 2).map(tx).join(" · ")}</span>}</td>
      <td className="mono">{f.r1 != null ? <><b className={f.r1 >= c.volMult && f.r2 >= c.volMult ? "green" : ""}>{`${f.r1}× / ${f.r2}×`}</b>
        <span className="sub">{`${wusd(f.usd1)} / ${wusd(f.usd2)} · ${f.trades1} / ${f.trades2} trades`}</span></> : <span className="muted">under 24h of history</span>}</td>
      <td className="mono">{aPx(f.close ?? r.price)}<span className="sub"><span className={col(f.move10)}>{pct1(f.move10)} 10m</span> · <span className={col(f.chg1h)}>{pct1(f.chg1h)} 1h</span> · <span className={col(f.chg24)}>{pct1(f.chg24 ?? r.chg24List)} 24h</span></span></td>
      <td className="mono"><Buys d={x} /></td>
      <td className="mono">{wusd(r.liquidity)}<span className="sub">{r.holders != null ? Number(r.holders).toLocaleString() : "—"} holders</span></td>
      <td className="mono">{wusd(r.mcap)}<span className="sub">FDV {wusd(r.fdv)}{r.circPct != null ? ` · ${r.circPct}% circulating` : ""}</span></td>
    </tr>
  );
}

function AlertRow({ a, onTook }: { a: any; onTook: () => void }) {
  const tr = a.track || {}, f = a.f || {}, tok = a.token || {};
  const best = <span className="sub">best {pct1(tr.peakPct)} · worst {pct1(tr.lowPct)}</span>;
  const res = tr.status === "open" ? <><span className="amber">open</span>{best}</>
    : <><b className={tr.status === "win" ? "green" : tr.status === "loss" ? "red" : ""}>{tr.status === "win" ? "Target" : tr.status === "loss" ? "Stopped" : "Timed out"} {pct1(tr.resultPct)}</b>{best}</>;
  return (
    <tr>
      <td className="mono">{new Date(a.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}<span className="sub">{aAgo(a.t)}</span></td>
      <td><b>{tx(tok.symbol)}</b><span className="sub">{tx(tok.chain)}</span></td>
      <td>{(a.tier || "confirmed") === "confirmed" ? <span className="badge strong">Confirmed</span> : <span className="badge">Early</span>}</td>
      <td className="mono">{aPx(f.close)}</td>
      <td className="mono">{`${f.r1}× / ${f.r2}×`}<span className="sub">{wusd(f.usd1)} / {wusd(f.usd2)}</span></td>
      <td className="mono"><Buys d={a.dex} /></td>
      <td><AiBadge x={a.ai} /></td>
      <td className="mono">{res}{(tr.status === "open" || Date.now() - a.t < 2 * DAY) && <button className="btn xs" title="Add this trade to your journal" onClick={onTook}>I took it</button>}</td>
    </tr>
  );
}

/** The replay panel: the rule on past candles vs buying the same tokens at a random time. */
function Replay({ rp }: { rp: any }) {
  if (!(rp && rp.rule)) return <div className="empty" style={{ padding: 18 }}>Run <span className="mono">node alpha-backtest.js</span> once (20-40 minutes the first time). This panel then shows how the same rule did on the last 60 days of Alpha candles.</div>;
  const line = (l: string, x: any, sub = "") => x && x.n ? (
    <div><div className="big" style={{ fontSize: 17 }}>{l}: {x.winPct.toFixed(1)}% hit +40% first · <span className={col(x.net)}>{pct1(x.net)}</span> per trade</div>
      <small>{`${x.n} trades on ${x.tokens} tokens, ${x.lossPct.toFixed(0)}% stopped first${sub}`}</small></div>) : null;
  const halves = (a: any, b: any) => (a && b && a.n && b.n ? ` · older two thirds ${pct1(a.net)}, newest third ${pct1(b.net)} per trade` : "");
  const ev = rp.evaa, evl = (x: any, l: string) => (x ? `${l}: ${x.n} alerts, ${x.win} hit +40%, ${x.loss} stopped, ${x.flat} timed out` : "");
  return <>
    {line("Confirmed", rp.rule, `${halves(rp.ruleTune, rp.ruleTest)}${rp.perDay ? ` · about ${rp.perDay} a day` : ""}`)}
    {line("Same tokens bought at a random time", rp.base, `${halves(rp.baseTune, rp.baseTest)} · tokens with $1M+ traded in 24 hours, once a day`)}
    {line("Early", rp.planned, `${rp.plannedPerDay ? ` · about ${rp.plannedPerDay} a day` : ""}`)}
    {line("Any token bought at a random time", rp.baseAll, " · every active token once a day")}
    <div><small>{`Costs ${rp.cost}% per trade. ${rp.universe ? `${rp.universe.traded} tokens traded in the window, ${rp.universe.delistedTraded ?? "some"} of them delisted since; Binance no longer serves candles for most long-delisted tokens, so those are missing.` : ""}${ev ? ` EVAA: ${evl(ev.early, "early tier")}; ${evl(ev.confirmed, "confirmed tier")}.` : ""} The $1M rule was picked after looking at these results, so the confirmed tier's record may be flattered: judge it by the live results above.`}</small></div>
  </>;
}

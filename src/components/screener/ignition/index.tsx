"use client";
// The Ignition tab (the classic page's #view-ignition): KPIs, the live ignition watch, the Spot plan (/api/spot), Pump
// watch (/api/pump), the big-move watch, alert history, data health, the Telegram panel, alert performance and the setup
// leaderboard. /api/screener comes from the page around it (polled every 3 s). Choices a section keeps (filters, "Show
// all") live here, so they survive a section tag hiding that section, as on the classic page.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fragment, useState } from "react";
import { Sec, useScreener } from "../context";
import { ErrorBox, Kpi, usePoll } from "../ui";
import { useStored } from "@/components/useStored";
import { pct } from "@/lib/format";
import { AlertHistory } from "./AlertHistory";
import { BigMove } from "./BigMove";
import { DataHealth } from "./DataHealth";
import { BOARD_DEFAULTS, Leaderboard, type BoardFilters } from "./Leaderboard";
import { LiveWatch } from "./LiveWatch";
import { Performance } from "./Performance";
import { PumpWatch } from "./PumpWatch";
import { SpotPlan, type SpotView } from "./SpotPlan";
import { TelegramPanel } from "./TelegramPanel";
import { cfg, useTelegram } from "./util";

function Kpis() {
  const { data } = useScreener();
  const cs = data?.candidates || [], c = cfg(data), reg = data?.regime || {}, u = data?.universe || {}, w = data?.warmup, bc = c.bigmove || {};
  const b1 = reg.btc1hPct, b1bad = b1 != null && c.btc1hMin != null && b1 < c.btc1hMin;
  return (
    <div className="kpis">
      <Kpi label="Tokens scanned" value={data?.universe ? u.eligible : "—"} hint={!data ? "Binance USDT pairs, liquid only"
        : w && w.loaded < w.total ? `Warming up: ${w.loaded}/${w.total} daily charts loaded`
          : data.universe ? `of ${u.binance} Binance USDT pairs · ranked by ${u.rankedBy || "market cap"}${data.lastScanMs != null ? ` · scan ${(data.lastScanMs / 1000).toFixed(1)}s` : ""}` : ""} />
      <Kpi label="Early ignitions now" cls="green" value={data ? cs.filter((x) => x.ignition === "ignited").length : "—"} hint="Volume igniting, price not yet run" />
      <Kpi label="Big-move ignitions now" cls="green" value={!data ? "—" : bc.on === false ? "off" : cs.filter((x) => x.bigmove === "ignited").length}
        hint={!data ? "small coins waking up, +40% research tier" : bc.on === false ? "SCREENER_BIGMOVE=0" : `${cs.filter((x) => x.bigmove === "watch").length} more waking up · +${bc.targetPct}% / -${bc.stopPct}% research tier`} />
      <Kpi label="BTC (market filter)" cls={data && reg.ok === false ? "red" : undefined} value={reg.btcChange24hPct == null ? "—" : pct(reg.btcChange24hPct)}
        hint={!data ? "Alerts pause if BTC drops sharply" : reg.ok === false ? "BTC is dumping: alerts are paused" : `24h · 1h ${b1 == null ? "—" : pct(b1)}${b1bad ? ": ignitions on hold" : ": alerts enabled"}`} />
    </div>
  );
}

export default function Ignition() {
  const { data, dataError, show } = useScreener();
  const pump = usePoll<any>("/api/pump", 60_000);
  const spot = usePoll<any>("/api/spot", 60_000);
  const tg = useTelegram(data);
  const [bigAll, setBigAll] = useState(false);
  const [spotView, setSpotView] = useState<SpotView>({ filter: "all", more: false });
  const [board, setBoard] = useState<BoardFilters>(BOARD_DEFAULTS);
  const [exitTier, setExitTier] = useState("ignition");
  const [scopeRaw, setScope] = useStored("screenerPerfScope", "current");
  const scope = scopeRaw === "all" ? "all" : "current";
  const errs = Object.entries((data?.errors || {}) as Record<string, string>);
  return (
    <>
      <details className="notice"><summary><b>Signal honesty:</b> Alerts fire within a minute or two of volume igniting, never before it.</summary>
        <div>Many early signals still fail, and no setting makes most of them win. Stablecoins, tokenized stocks and gold, wrapped tokens and tokens that rarely move enough are left out, and coins on Binance&apos;s Monitoring list never alert. Whale flows and unlock dates are not checked, so check them yourself before acting. Not financial advice.</div></details>
      <ErrorBox>{dataError || (errs.length ? errs.map(([k, v], i) => <Fragment key={k}>{i ? <br /> : null}<b>{k}:</b> {v}</Fragment>) : null)}</ErrorBox>
      <Sec id="watch big"><Kpis /></Sec>
      <Sec id="watch"><LiveWatch /></Sec>
      <Sec id="spot"><SpotPlan d={spot.data} error={spot.error} view={spotView} setView={setSpotView} /></Sec>
      <Sec id="pump"><PumpWatch p={pump.data} /></Sec>
      <Sec id="big"><BigMove showAll={bigAll} setShowAll={setBigAll} /></Sec>
      {show("alerts health") && <div className="lower">
        <Sec id="alerts"><AlertHistory /></Sec>
        <Sec id="health"><DataHealth tg={tg} /></Sec>
      </div>}
      <Sec id="telegram"><TelegramPanel tg={tg} /></Sec>
      <Sec id="perf"><Performance scope={scope} setScope={setScope} exitTier={exitTier} setExitTier={setExitTier} /></Sec>
      <Sec id="board"><Leaderboard f={board} setF={setBoard} /></Sec>
      <Sec id=""><details className="foot"><summary>How it works</summary>every ~20 seconds the scanner compares each token&apos;s rolling 15-minute volume with its own normal for this hour of the day (14-day median), so busy hours do not look like surges. For the hottest tokens it then checks the last two finished 5-minute candles: an ignition needs both of them at 3× normal volume or more, price up over those 10 minutes, mostly aggressive buying, 1h volume confirming, and the quality checks that held up in the replay: daily RSI 65 or lower, price above its 20-day average, room above (not less than 1% under its 12-hour high or 1.5% under its 24-hour high: it waits for the break), the last candle not an exhausted spike that closed at its high, not the top tick of the 2-hour range, above a rising 4-hour average and not stretched, no long selling wicks, BTC not falling over the last hour or 4 hours, a tight spread, and no market-wide surge. <b>Early ignition</b> alerts fire as soon as that passes; <b>confirmed ignition</b> alerts also need an ignition score of 65+ (it rewards volume that keeps running), which the replay found more accurate but usually a few minutes later. Tokens whose typical 6-hour range is too small to reach the target are skipped, as are stablecoins, tokenized stocks and gold, and wrapped tokens. Daily setups are shown as a watchlist; their alerts are off unless SCREENER_SETUP_ALERTS=1. Tokens that already ran are capped at score 55 and never alert. Every alert is tracked as a trade: take profit at the target, stop at the stop, otherwise sell when the window ends, judged on 1-minute candles and counted after fees and slippage (see the performance panel). Demo mode data is simulated.</details></Sec>
    </>
  );
}

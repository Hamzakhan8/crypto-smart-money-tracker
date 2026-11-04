"use client";
import type { Dossier } from "@/lib/ai-desk";
import { arr, col, num, pct, price, Stat, tx, usd } from "./ui";

// "Data the AI used": the dossier's key numbers as tiles (also shown alone by "Data only").
export function Facts({ d }: { d: Dossier }) {
  const ch = d.chart || {}, lv = d.levels || {}, ob = d.orderBook || {}, fu = d.futures || {}, wh = d.whales || {}, dx = d.dexFlows || {};
  const mk = d.market || {}, sc = d.screener, mf = d.marketFlow || {}, sm = arr(mf.smartMoneyWallets?.matchingSignals);
  const bands = arr(ob.bands), imb = bands.length ? bands[Math.min(1, bands.length - 1)] : null, lq = ob.liquidityCheck || null;
  const tags = d.exchangeTags, br = mk.takerFlowBreadth, dx24 = dx.last24h || {};
  return (
    <>
      <div className="sec">Data the AI used</div>
      <div className="facts">
        <Stat k="Screener" v={sc ? (sc.tier ? `${sc.tier} ignition` : tx(sc.state)) : "not flagged"} sub={sc && sc.ignitionScore != null ? `score ${sc.ignitionScore}` : ""} />
        <Stat k="Trend 1h" v={ch.trend1h ? tx(ch.trend1h.state).split(" (")[0] : "—"} sub={ch.trend1h ? `vs EMA20 ${pct(ch.trend1h.priceVsEma20Pct)}` : ""} />
        <Stat k="Trend 4h" v={ch.trend4h ? tx(ch.trend4h.state).split(" (")[0] : "—"} sub={ch.trend4h ? `vs EMA20 ${pct(ch.trend4h.priceVsEma20Pct)}` : ""} />
        <Stat k="ATR (1h)" v={`${num(ch.atrPct?.["1h"])}%`} sub="typical hourly move" />
        <Stat k="To resistance" v={lv.roomToResistancePct == null ? "none overhead" : pct(lv.roomToResistancePct)}
          sub={lv.resistance ? price(lv.resistance) + (lv.resistanceIs ? ` · ${lv.resistanceIs}` : "") : ""} />
        <Stat k="To support" v={lv.distanceToSupportPct == null ? "—" : pct(lv.distanceToSupportPct)}
          sub={lv.support ? price(lv.support) + (lv.supportIs ? ` · ${lv.supportIs}` : "") : ""} />
        <Stat k="Order book" v={imb ? (imb.imbalance > 0 ? "more bids" : "more asks") : "—"}
          sub={imb ? `imbalance ${num(imb.imbalance)} within ${imb.withinPct}% · spread ${num(ob.spreadBps, 1)} bps` : ""} cls={imb ? col(imb.imbalance) : ""} />
        {lq && <Stat k="Liquidity test" v={lq.passes === false ? "fails" : lq.passes ? "passes" : "unknown"}
          sub={lq.bidsWithin1PctUsd != null ? `${usd(lq.bidsWithin1PctUsd)} of bids within 1% (needs $20k)` : tx(lq.note)} cls={lq.passes === false ? "red" : lq.passes ? "green" : ""} />}
        {tags && (tags.monitoring || tags.seed) && <Stat k="Binance tag" v={tags.monitoring ? "Monitoring" : "Seed"}
          sub={tags.monitoring ? "delisting risk: hard stop" : "high-volatility young project"} cls={tags.monitoring ? "red" : "amber"} />}
        <Stat k="Funding / 8h" v={fu.available ? `${num(fu.fundingPctPer8h, 4)}%` : "n/a"} sub={fu.available ? `OI 24h ${pct(fu.oiChange24hPct)}` : tx(fu.reason)}
          cls={fu.available && Number(fu.fundingPctPer8h) > 0.05 ? "red" : ""} />
        <Stat k="Long/short" v={fu.available ? num(fu.longShortAccountRatio) : "n/a"} sub={fu.available ? `taker buy/sell ${num(fu.takerBuySellRatio30m)}` : ""} />
        <Stat k="Whales → exchanges" v={wh.tracked && wh.transfers24h ? usd(wh.netToExchanges24h) : "none seen"}
          sub={wh.tracked && wh.transfers24h ? `${wh.transfers24h} big transfers 24h (ETH chain)` : wh.reason || "Ethereum only"}
          cls={Number(wh.netToExchanges24h) > 0 ? "red" : Number(wh.netToExchanges24h) < 0 ? "green" : ""} />
        <Stat k="DEX net 24h" v={dx.tracked ? usd(dx24.netUsd) : "not tracked"} sub={dx.tracked ? `${tx(dx24.swaps)} swaps` : tx(dx.reason)} cls={dx.tracked ? col(dx24.netUsd) : ""} />
        <Stat k="BTC 4h" v={pct(mk.btc4hPct)} sub={mk.btcRegime ? mk.btcRegime : ""} cls={col(mk.btc4hPct)} />
        <Stat k="Market flow" v={mf.available ? `${num(mf.flowScore, 0)}/100 · ${tx(mf.label)}` : "n/a"}
          sub={mf.available ? `5m buyers ${num(mf.buyRatio5mPct, 0)}% · net ${usd(mf.netFlow5mUsd)}` : tx(mf.reason)}
          cls={mf.available ? (Number(mf.flowScore) >= 60 ? "green" : Number(mf.buyRatio5mPct) < 45 ? "red" : "") : ""} />
        <Stat k="Smart-money wallets" v={mf.available ? (sm.length ? `${sm.length} signal${sm.length === 1 ? "" : "s"}` : "none") : "n/a"}
          sub={mf.available && sm.length ? sm.map((x) => `${tx(x.direction)} · ${x.wallets ?? "?"} wallets`).slice(0, 2).join(" | ") : "Binance Web3 feed"}
          cls={sm.some((x) => x.direction === "buy") ? "green" : sm.some((x) => x.direction === "sell") ? "red" : ""} />
        <Stat k="Flow breadth" v={br ? `${br.buyDominant5m} buying · ${br.sellDominant5m} selling` : "—"} sub={br ? `of the Radar's ${br.coins} coins (5m)` : ""} />
      </div>
    </>
  );
}

/** Everything the AI was given, as JSON (open when it is all there is: "Data only"). */
export function DossierJson({ d, open }: { d: Dossier; open: boolean }) {
  return <details open={open}><summary>Full data sent to the AI (JSON)</summary><pre>{JSON.stringify(d, null, 2)}</pre></details>;
}

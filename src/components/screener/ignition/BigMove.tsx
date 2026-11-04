"use client";
// Big-move watch (the classic page's drawBig): smaller coins whose daily volume is already expanding, tracked as
// +40% before -10%. Hidden when the tier is off (SCREENER_BIGMOVE=0).
import { useScreener } from "../context";
import { useStateTabs } from "../ui";
import { Flags } from "../coin";
import { col, money, pct1, price } from "@/lib/format";
import { cfg, cx, fx, tabBar } from "./util";

const HINTS = { strong: "Big-move ignition: the 5m trigger fired", heating: "Waking up: daily volume expanding, waiting for the trigger", running: "Already moved (or up 25%+ in 24h): do not chase", take: "The AI said TAKE in the last 2 hours" };

export function BigMove({ showAll, setShowAll }: { showAll: boolean; setShowAll: (v: boolean) => void }) {
  const { data, aiTake, openDetail } = useScreener();
  const b = cfg(data).bigmove || {};
  const all0 = (data?.candidates || []).filter((c) => c.bigmove)
    .sort((a, z) => Number(z.bigmove === "ignited") - Number(a.bigmove === "ignited") || (z.rvol || 0) - (a.rvol || 0));
  const st = useStateTabs("big", all0, (c) => ({ strong: c.bigmove === "ignited" && !c.moved, heating: c.bigmove !== "ignited" && !c.moved, running: !!c.moved || c.change24h >= 25, take: aiTake(c.base) }), HINTS);
  if (b.on === false) return null;
  const all = st.rows, rows = showAll ? all : all.slice(0, 8);
  return (
    <section className="panel" style={{ marginBottom: 14 }} id="bigPanel">
      <div className="section-head"><div><h2>Big-move watch: +40% before -10%</h2>
        <p id="bigHint">{data ? `Smaller coins (${money(b.minVolume)}-${money(b.maxVolume)} of 24h volume) whose daily volume is already ${b.minDailyRvol}×+ their 20-day average. Green = the 5-minute ignition fired too (alert); amber = waking up, waiting for the trigger. Tracked as +${b.targetPct}% before -${b.stopPct}% within ${b.outcomeHours / 24} days, separately from the quick tiers. In a 90-day replay of every Binance USDT pair it made money in the Aug-Sep altcoin rally and lost in October: a research tier, not a proven edge. Telegram: ${!b.telegram ? "off (switch on in Ignition › Telegram)" : data.telegram?.configured ? "on" : "on, but Telegram is not set up"}.`
          : "Smaller coins whose daily volume is already expanding."}</p></div>
        <span className="chip" id="bigCount">{data ? `${all0.length} coins` : "—"}</span></div>
      {tabBar(st.bar, "Filter coins", !!data)}
      <div className="table-wrap"><table className="table cards"><thead><tr><th>Token</th><th>State</th><th>Daily volume</th><th>Last two 5m candles</th><th>Moved</th><th>Market cap</th><th>Target · stop</th></tr></thead>
        <tbody id="bigBody">
          {!data ? <tr><td colSpan={7} className="empty">Waiting for the first scan…</td></tr>
            : rows.length ? rows.map((c) => {
              const g = c.big || {}, ign = c.bigmove === "ignited";
              return (
                <tr key={c.symbol}>
                  <td><button className="coin-link sym" data-sym={c.symbol} onClick={() => openDetail(c)}>{c.base} ↗</button><Flags c={c} /><span className="sub">{price(c.price)}{c.core ? "" : " · small coin"}</span></td>
                  <td><span className={`badge ${ign ? "strong" : "watch"}`}>{ign ? "Big-move ignition" : "Waking up"}</span>{!ign && (c.bigMissing || []).length ? <span className="sub amber">needs: {c.bigMissing.slice(0, 2).join(", ")}</span> : null}</td>
                  <td className="mono green">{c.rvol == null ? "—" : `${fx(c.rvol, 2)}×`} of 20d avg<span className="sub">{money(c.quoteVolume)} in 24h</span></td>
                  <td className="mono">{g.r5 == null ? "—" : `${fx(g.prevR5, 1)}× → ${fx(g.r5, 1)}×`}<span className="sub">{g.buyRatio10m == null ? "" : `${fx(g.buyRatio10m, 0)}% buyers`}</span></td>
                  <td className="mono"><span className={cx(col(c.change24h))}>{pct1(c.change24h)}</span> 24h<span className="sub">{g.ret10m == null ? "" : `${pct1(g.ret10m)} 10m`}</span></td>
                  <td className="mono">{money(c.marketCap)}</td>
                  <td className="mono green">{price((c.price as number) * (1 + b.targetPct / 100))}<span className="sub red">stop {price((c.price as number) * (1 - b.stopPct / 100))}</span></td>
                </tr>);
            }) : <tr><td colSpan={7} className="empty">{st.empty("No smaller coin is waking up right now.")}</td></tr>}
        </tbody></table></div>
      {data && all.length > 8 && <button className="btn sm more" id="bigMore" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${all.length}`}</button>}
    </section>
  );
}

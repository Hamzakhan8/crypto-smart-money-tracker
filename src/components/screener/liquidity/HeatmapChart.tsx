"use client";
// The heatmap's two canvases (the order-book heatmap and the volume / delta bars under it), the tooltip and the legend.
// Drawing is queued to the next animation frame (several changes in a row draw once) and redone on every new heatmap,
// style change and window resize. While the window is hidden no frame runs; the queued draw then runs when the page
// shows again.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { drawLiquidity, yToPrice, type Cfg, type DrawUi } from "./draw";
import { hhmm, money, px, type Heatmap } from "./types";

interface Tip { x: number; y: number; cw: number; t: number; lo: number; hi: number; b: number; a: number; traded: [number, number] | null }

export function HeatmapChart({ hm, preset, side, vol, candles }: { hm: Heatmap | null } & DrawUi) {
  const mainRef = useRef<HTMLCanvasElement>(null), volRef = useRef<HTMLCanvasElement>(null), tipRef = useRef<HTMLDivElement>(null);
  const latest = useRef<{ hm: Heatmap | null; ui: DrawUi }>({ hm, ui: { preset, side, vol, candles } });
  latest.current = { hm, ui: { preset, side, vol, candles } };
  const cfgRef = useRef<Cfg | null>(null); // what the last draw used (the tooltip reads it)
  const frame = useRef<number | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const draw = useCallback(() => {
    const m = mainRef.current, v = volRef.current;
    if (!m || !v) return; // unmounted
    cfgRef.current = drawLiquidity(m, v, latest.current.hm, latest.current.ui);
  }, []);
  const queueDraw = useCallback(() => {
    if (frame.current != null) return;
    const id = requestAnimationFrame(() => { if (frame.current !== id) return; frame.current = null; draw(); });
    frame.current = id;
  }, [draw]);

  useEffect(() => { queueDraw(); }, [hm, preset, side, vol, candles, queueDraw]);
  useEffect(() => {
    const onResize = () => queueDraw();
    // a draw queued while the window was hidden: draw now that it shows (do not wait on a frame that may come late)
    const onVisible = () => { if (document.hidden || frame.current == null) return; cancelAnimationFrame(frame.current); frame.current = null; draw(); };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisible);
      if (frame.current != null) cancelAnimationFrame(frame.current);
      frame.current = null; // a later mount queues its own draw
    };
  }, [draw, queueDraw]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const h = latest.current.hm, cfg = cfgRef.current;
    if (!h || !cfg || !h.prices?.length) { setTip(null); return; }
    const rect = e.currentTarget.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top, { timeScale: ts, priceScale: ps } = cfg;
    if (x < ts.xLeft || x > ts.xRight || y < ps.yTop || y > ps.yBottom) { setTip(null); return; }
    const c = Math.min(h.times.length - 1, Math.floor(((x - ts.xLeft) / (ts.xRight - ts.xLeft)) * h.times.length));
    const r = Math.floor((yToPrice(y, ps) - h.prices[0]) / h.binWidth);
    if (r < 0 || r >= h.prices.length) { setTip(null); return; }
    const b = (h.bids[c]?.[r] || 0) * h.unit, a = (h.asks[c]?.[r] || 0) * h.unit, V = h.volume;
    setTip({ x, y, cw: e.currentTarget.clientWidth, t: h.times[c], lo: h.prices[r], hi: h.prices[r] + h.binWidth, b, a, traded: V && V.trades[c] ? [V.buy[c], V.sell[c]] : null });
  };
  useLayoutEffect(() => { // next to the mouse, inside the chart
    const el = tipRef.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    el.style.left = Math.max(0, Math.min(tip.cw - w, tip.x + 14)) + "px"; el.style.top = Math.max(0, tip.y + 14) + "px";
  }, [tip]);

  const hasData = !!hm && !!hm.prices?.length && !!hm.times?.length;
  return (
    <div className="lq-chart">
      <canvas className="lq-main" ref={mainRef} role="img" aria-label="Order-book heatmap" onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      <canvas className="lq-volc" ref={volRef} role="img" aria-label="Trade volume per time slice" />
      <div className="lq-tip" ref={tipRef} hidden={!tip}>
        {tip && <><b>{hhmm(tip.t, true)}</b> · {px(tip.lo)} – {px(tip.hi)}<br />Buy orders <span className="green">{money(tip.b)}</span> · sell orders <span className="red">{money(tip.a)}</span>
          {tip.traded && <><br />Traded: bought {money(tip.traded[0])} · sold {money(tip.traded[1])}</>}</>}
      </div>
      <div className="lq-legend">
        <span><i style={{ background: "rgb(60,200,220)" }} />buy orders</span><span><i style={{ background: "rgb(245,120,160)" }} />sell orders</span>
        <span><i style={{ background: "rgb(160,130,220)" }} />both</span>
        <span><i style={{ background: "transparent", borderTop: "1px dashed var(--ink)", height: 0, width: 14 }} />current price</span>
        <span>{hasData ? `each row ${px(hm.binWidth)} · each column ${hm.bucketMs / 1000} s${hm.note ? " · " + hm.note : ""}` : ""}</span>
      </div>
    </div>
  );
}

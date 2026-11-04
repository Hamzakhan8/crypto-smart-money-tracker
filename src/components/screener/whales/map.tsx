"use client";
// "Where the money went" (the classic page's drawMap): bands from the token sold (left) to the token bought (right),
// width = USD, for the 16 biggest routes. The drawing is as wide as its box, measured on every redraw and after a
// window resize (200 ms after the last resize event).
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { wusd } from "./fmt";
import type { Edge, Tok } from "./types";

interface MapNode { k: string; t: Tok; chain: string; usd: number; off: number; h: number; y: number }
const boxWidth = (el: HTMLElement) => Math.max(320, Math.round(el.clientWidth - 36 || 900));
const bandCls = (e: Edge) => (e.majors ? "major" : e.to.cls === "token" ? (e.from.cls === "token" ? "swap" : "buy") : e.from.cls === "token" ? "sell" : "major");

/** list = the routes after the filters (null before the first data); anyEdges = the window has routes at all. */
export function MoneyMap({ list, anyEdges }: { list: Edge[] | null; anyEdges: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState<number | null>(null);
  useLayoutEffect(() => { if (box.current) setW(boxWidth(box.current)); });
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => { clearTimeout(t); t = setTimeout(() => { if (box.current) setW(boxWidth(box.current)); }, 200); };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); clearTimeout(t); };
  }, []);

  if (!list) return <div className="wmap" id="wMap" ref={box}><div className="empty">Loading…</div></div>;
  const top = list.slice(0, 16), total = top.reduce((a, e) => a + e.usd, 0);
  if (!top.length || !(total > 0)) return <div className="wmap" id="wMap" ref={box}><div className="empty">{anyEdges ? "Nothing matches the filters." : "No swaps in this window yet."}</div></div>;
  if (W == null) return <div className="wmap" id="wMap" ref={box} />;

  const multi = new Set(top.map((e) => e.net)).size > 1, key = (t: Tok, e: Edge) => `${t.symbol}|${e.net}`;
  const L = new Map<string, MapNode>(), R = new Map<string, MapNode>();
  for (const e of top) {
    for (const [m, t] of [[L, e.from], [R, e.to]] as const) {
      const k = key(t, e), x = m.get(k) || { k, t, chain: e.chain, usd: 0, off: 0, h: 0, y: 0 };
      x.usd += e.usd; m.set(k, x);
    }
  }
  const ln = [...L.values()].sort((a, b) => b.usd - a.usd), rn = [...R.values()].sort((a, b) => b.usd - a.usd);
  const narrow = W < 600, lab = narrow ? 92 : 170, nw = 10, gap = 10, n = Math.max(ln.length, rn.length);
  const sc = Math.max(140, n * 22) / total, pitch = (h: number) => Math.max(h, 18) + gap;
  const place = (nodes: MapNode[]) => { let y = 8; for (const x of nodes) { x.h = Math.max(2, x.usd * sc); x.y = y + (pitch(x.h) - gap - x.h) / 2; y += pitch(x.h); } return y; };
  const H = Math.max(place(ln), place(rn)) + 4, x0 = lab, x1 = W - lab - nw, mid = (x0 + nw + x1) / 2;
  const li = new Map(ln.map((x, i) => [x.k, i])), ri = new Map(rn.map((x, i) => [x.k, i]));
  const LI = (e: Edge) => li.get(key(e.from, e)) ?? 0, RI = (e: Edge) => ri.get(key(e.to, e)) ?? 0;
  const bh = (e: Edge) => Math.max(1, e.usd * sc), yR = new Map<Edge, number>();
  for (const e of [...top].sort((a, b) => RI(a) - RI(b) || LI(a) - LI(b))) { const r = R.get(key(e.to, e))!; yR.set(e, r.y + r.off); r.off += bh(e); }
  const bands = [...top].sort((a, b) => LI(a) - LI(b) || RI(a) - RI(b)).map((e, i) => {
    const l = L.get(key(e.from, e))!, h = bh(e), a = l.y + l.off, b = yR.get(e) ?? 0;
    l.off += h;
    const d = `M${x0 + nw},${a.toFixed(1)} C${mid},${a.toFixed(1)} ${mid},${b.toFixed(1)} ${x1},${b.toFixed(1)} L${x1},${(b + h).toFixed(1)} C${mid},${(b + h).toFixed(1)} ${mid},${(a + h).toFixed(1)} ${x0 + nw},${(a + h).toFixed(1)} Z`;
    return <path key={`${e.key}-${i}`} className={`band ${bandCls(e)}`} d={d}><title>{`${wusd(e.usd)}: ${e.from.symbol} → ${e.to.symbol} on ${e.chain} · ${e.n} swaps by ${e.wallets} wallet${e.wallets === 1 ? "" : "s"} · ${Math.round(e.oneWay * 100)}% one-way`}</title></path>;
  });
  const label = (x: MapNode, side: "l" | "r") => {
    const cy = (x.y + x.h / 2 + 4).toFixed(1);
    const sym = <>{x.t.symbol.length > 14 ? `${x.t.symbol.slice(0, 13)}…` : x.t.symbol}{multi && !narrow ? <> <tspan className="v">{x.chain}</tspan></> : null}</>;
    return side === "l"
      ? <Fragment key={`l:${x.k}`}><rect className="node" x={x0} y={x.y.toFixed(1)} width={nw} height={x.h.toFixed(1)} rx={2} /><text x={x0 - 6} y={cy} textAnchor="end">{sym} <tspan className="v">{wusd(x.usd)}</tspan></text></Fragment>
      : <Fragment key={`r:${x.k}`}><rect className="node" x={x1} y={x.y.toFixed(1)} width={nw} height={x.h.toFixed(1)} rx={2} /><text x={x1 + nw + 6} y={cy}>{sym} <tspan className="v">{wusd(x.usd)}</tspan></text></Fragment>;
  };
  return (
    <div className="wmap" id="wMap" ref={box}>
      <svg viewBox={`0 0 ${W} ${Math.ceil(H)}`} role="img" aria-label="Money flow between tokens on DEXes">{bands}{ln.map((x) => label(x, "l"))}{rn.map((x) => label(x, "r"))}</svg>
      {list.length > top.length && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Biggest {top.length} of {list.length} routes. Use the filter above for one token or network.</div>}
    </div>
  );
}

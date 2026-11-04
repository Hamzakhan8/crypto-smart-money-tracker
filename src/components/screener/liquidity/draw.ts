// The Liquidity tab's canvas drawing: the order-book heatmap of one Binance pair (density scale, colour map, candles,
// price line, axes, the "collection started" marker) and the volume / delta bars under it. Plain functions, called by
// HeatmapChart from its effects. The same maths as public/liquidity-tab.js.
//
// The heatmap drawing (density scale, colour map, canvas renderer, volume / delta bars) is ported from
// crypto-liquidity-terminal (https://github.com/AIUngated/crypto-liquidity-terminal, apps/web/src/lib/liquidity).
// Used under the MIT License:
//
//   Copyright (c) 2026 Crypto Market Screener contributors
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
//   the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
//   WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
//   OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
//   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { hhmm, money, type Heatmap } from "./types";

type Ctx = CanvasRenderingContext2D;
type BookSide = "bid" | "ask" | "balanced";

// ---------------------------------------------------------------- densityScale.ts (ported)
// Single outlier walls must not blow out the scale (percentile cap); weak liquidity stays readable (gamma < 1).
type DensityMode = "raw" | "log" | "percentile" | "zscore";
export interface DensityOpts {
  mode: DensityMode; capPercentile: number; gamma: number; minOpacity: number; maxOpacity: number; hideWeakBelow: number; strongOnlyAbove: number; glow: boolean;
}
export const DENSITY_PRESETS: Record<string, DensityOpts> = {
  balanced: { mode: "percentile", capPercentile: 0.99, gamma: 0.75, minOpacity: 0.06, maxOpacity: 0.9, hideWeakBelow: 0, strongOnlyAbove: 0, glow: false },
  deep: { mode: "zscore", capPercentile: 0.99, gamma: 0.6, minOpacity: 0.08, maxOpacity: 0.95, hideWeakBelow: 0, strongOnlyAbove: 0, glow: true },
  walls: { mode: "percentile", capPercentile: 0.995, gamma: 0.85, minOpacity: 0, maxOpacity: 0.95, hideWeakBelow: 0.85, strongOnlyAbove: 0.85, glow: true },
  weak: { mode: "log", capPercentile: 0.95, gamma: 0.5, minOpacity: 0.12, maxOpacity: 0.85, hideWeakBelow: 0, strongOnlyAbove: 0, glow: false },
  clean: { mode: "zscore", capPercentile: 0.99, gamma: 0.7, minOpacity: 0, maxOpacity: 0.9, hideWeakBelow: 0.55, strongOnlyAbove: 0, glow: false },
};
interface Stats { count: number; max: number; mean: number; std: number; p50: number; p90: number; p95: number; p99: number; cap: number }
interface CellStyle { alpha: number; intensity: number; side: BookSide; isStrong: boolean }
interface Liq { bidLiquidity: number; askLiquidity: number }

function applyGamma(i: number, gamma: number): number {
  if (!Number.isFinite(i) || i <= 0) return 0;
  if (i >= 1) return 1;
  return Math.pow(i, Math.max(0.05, Math.min(4, gamma)));
}
function computeLiquidityStats(values: number[], capPercentile = 0.99): Stats {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b), n = sorted.length;
  if (!n) return { count: 0, max: 0, mean: 0, std: 0, p50: 0, p90: 0, p95: 0, p99: 0, cap: 0 };
  const mean = sorted.reduce((a, v) => a + v, 0) / n;
  let vs = 0; for (const v of sorted) vs += (v - mean) * (v - mean);
  const pick = (q: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
  return { count: n, max: sorted[n - 1], mean, std: Math.sqrt(vs / n), p50: pick(0.5), p90: pick(0.9), p95: pick(0.95), p99: pick(0.99), cap: pick(Math.max(0, Math.min(0.999, capPercentile))) };
}
const normalizeRaw = (v: number, s: Stats) => (s.cap <= 0 || !Number.isFinite(v) || v <= 0 ? 0 : Math.min(1, v / s.cap));
const normalizeLog = (v: number, s: Stats) => (s.cap <= 0 || !Number.isFinite(v) || v <= 0 ? 0 : Math.log1p(Math.min(v, s.cap)) / Math.log1p(s.cap));
function normalizePercentile(v: number, arr: number[]): number {
  if (!arr.length || !Number.isFinite(v) || v <= 0) return 0;
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] <= v) lo = m + 1; else hi = m; }
  return lo / arr.length;
}
// z < 0.5 hidden; 0.5-1.5 notable (0.30-0.55); 1.5-2.5 strong wall (0.55-0.80); 2.5+ extreme (0.80-1.00, clamped at z = 4)
function normalizeZScore(v: number, s: Stats): number {
  if (s.std <= 0 || !Number.isFinite(v) || v <= 0) return 0;
  const z = (v - s.mean) / s.std;
  if (z < 0.5) return 0;
  if (z < 1.5) return 0.3 + (z - 0.5) * 0.25;
  if (z < 2.5) return 0.55 + (z - 1.5) * 0.25;
  return 0.8 + Math.min(1, (z - 2.5) / 1.5) * 0.2;
}
const normalize = (v: number, mode: DensityMode, s: Stats, sorted: number[]) => (mode === "raw" ? normalizeRaw(v, s) : mode === "log" ? normalizeLog(v, s)
  : mode === "percentile" ? normalizePercentile(v, sorted) : mode === "zscore" ? normalizeZScore(v, s) : normalizeLog(v, s));
function buildStyleFn(values: number[], o: DensityOpts) {
  const stats = computeLiquidityStats(values, o.capPercentile), sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const none: CellStyle = { alpha: 0, intensity: 0, side: "balanced", isStrong: false };
  return { stats, styleFor(c: Liq): CellStyle {
    const total = c.bidLiquidity + c.askLiquidity;
    if (total <= 0) return none;
    const raw = normalize(total, o.mode, stats, sorted);
    if (raw <= 0 || raw < o.hideWeakBelow || (o.strongOnlyAbove > 0 && raw < o.strongOnlyAbove)) return none;
    const intensity = applyGamma(raw, o.gamma);
    const alpha = intensity > 0 ? Math.min(o.maxOpacity, Math.max(o.minOpacity, o.minOpacity + (o.maxOpacity - o.minOpacity) * intensity)) : 0;
    const bs = c.bidLiquidity / total;
    return { alpha, intensity, side: bs > 0.6 ? "bid" : bs < 0.4 ? "ask" : "balanced", isStrong: raw >= 0.85 };
  } };
}
const colorForSide = (side: BookSide, a: number) => (side === "bid" ? `rgba(60, 200, 220, ${a.toFixed(3)})` : side === "ask" ? `rgba(245, 120, 160, ${a.toFixed(3)})` : `rgba(160, 130, 220, ${a.toFixed(3)})`);
function glowColorForSide(side: BookSide, alpha: number): string {
  const a = Math.min(0.35, alpha).toFixed(3);
  return side === "bid" ? `rgba(180, 255, 255, ${a})` : side === "ask" ? `rgba(255, 200, 220, ${a})` : `rgba(220, 200, 255, ${a})`;
}

// ---------------------------------------------------------------- heatmapColor.ts (ported): the classic colour map
interface ColorOpts { intensityMultiplier: number; logScale: boolean; sideMode: string }
interface Cell extends Liq { t: number; price: number; totalLiquidity: number; intensity: number }
function applyIntensity(i: number, o: ColorOpts): number { let v = Math.max(0, Math.min(1, i)); if (o.logScale) v = Math.log1p(9 * v) / Math.log(10); return Math.min(1, v * o.intensityMultiplier); }
const rgba = (r: number, g: number, b: number, a: number) => `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
function colorForCell(cell: Cell, o: ColorOpts): string | null {
  const total = cell.bidLiquidity + cell.askLiquidity;
  if (total <= 0) return null;
  const i = applyIntensity(cell.intensity, o);
  if (i <= 0.005) return null;
  if (o.sideMode === "bids") return cell.bidLiquidity > 0 ? rgba(80, 220, 200, i) : null;
  if (o.sideMode === "asks") return cell.askLiquidity > 0 ? rgba(240, 130, 80, i) : null;
  if (o.sideMode === "imbalance") { const imb = (cell.bidLiquidity - cell.askLiquidity) / total; return imb >= 0 ? rgba(80, 220, 200, Math.min(1, Math.abs(imb) * i + 0.1)) : rgba(240, 130, 80, Math.min(1, Math.abs(imb) * i + 0.1)); }
  const bs = cell.bidLiquidity / total;
  return rgba(Math.round(80 * bs + 240 * (1 - bs)), Math.round(220 * bs + 130 * (1 - bs)), Math.round(200 * bs + 80 * (1 - bs)), i);
}

// ---------------------------------------------------------------- chartMath.ts + plotLayout.ts (ported)
export interface PriceScale { priceMin: number; priceMax: number; yTop: number; yBottom: number }
export interface TimeScale { timeMin: number; timeMax: number; xLeft: number; xRight: number }
export const priceToY = (p: number, s: PriceScale) => (s.priceMax === s.priceMin ? s.yBottom : s.yBottom - ((p - s.priceMin) / (s.priceMax - s.priceMin)) * (s.yBottom - s.yTop));
export const yToPrice = (y: number, s: PriceScale) => (s.yBottom === s.yTop ? s.priceMin : s.priceMin + ((s.yBottom - y) / (s.yBottom - s.yTop)) * (s.priceMax - s.priceMin));
export const timeToX = (t: number, s: TimeScale) => (s.timeMax === s.timeMin ? s.xLeft : s.xLeft + ((t - s.timeMin) / (s.timeMax - s.timeMin)) * (s.xRight - s.xLeft));
const RIGHT_PRICE_AXIS_PX = 60, BOTTOM_TIME_AXIS_PX = 18, LEFT_INSET_PX = 4, CANDLE_BODY_FRAC = 0.7;
const getPlotArea = (w: number) => { const xLeft = LEFT_INSET_PX, xRight = Math.max(LEFT_INSET_PX + 8, w - RIGHT_PRICE_AXIS_PX); return { xLeft, xRight, innerWidth: Math.max(0, xRight - xLeft) }; };
function computeCandleSlot(open: number, close: number, ts: TimeScale) {
  const slotX = timeToX(open, ts), slotXEnd = timeToX(close, ts), slotW = Math.max(1, slotXEnd - slotX), bodyW = Math.max(1, slotW * CANDLE_BODY_FRAC);
  return { slotX, slotXEnd, slotW, bodyX: slotX + (slotW - bodyW) / 2, bodyW, offscreen: slotXEnd < ts.xLeft || slotX > ts.xRight };
}

// ---------------------------------------------------------------- canvasRenderer.ts (ported)
/** What one draw used: the tooltip maps the mouse back to a price row and a time column with it. */
export interface Cfg {
  priceScale: PriceScale; timeScale: TimeScale; binWidth: number; timeBucketMs: number; candleMs: number;
  colorOpts: ColorOpts; density?: DensityOpts; densitySide: string;
}
interface Candle { t: number; open: number; high: number; low: number; close: number; volume: number }
function renderHeatmap(ctx: Ctx, cells: Cell[], cfg: Cfg) {
  const { priceScale: ps, timeScale: ts, binWidth, timeBucketMs } = cfg;
  ctx.clearRect(ts.xLeft, ps.yTop, Math.max(1, ts.xRight - ts.xLeft), Math.max(1, ps.yBottom - ps.yTop));
  if (!cells.length || binWidth <= 0) return;
  const xRange = ts.xRight - ts.xLeft;
  const cellW = Math.max(2, Math.min(xRange, (timeBucketMs / Math.max(1, ts.timeMax - ts.timeMin)) * xRange));
  const cellH = Math.max(1, Math.abs(priceToY(ps.priceMin, ps) - priceToY(ps.priceMin + binWidth, ps)));
  if (cfg.density) { renderHeatmapDensity(ctx, cells, cfg, cfg.density, cellW, cellH); return; }
  for (const c of cells) { // the classic colour map
    const fill = colorForCell(c, cfg.colorOpts);
    if (!fill) continue;
    ctx.fillStyle = fill;
    ctx.fillRect(timeToX(c.t, ts), priceToY(c.price + binWidth, ps), cellW, cellH);
  }
}
function renderHeatmapDensity(ctx: Ctx, cells: Cell[], cfg: Cfg, density: DensityOpts, cellW: number, cellH: number) {
  const { priceScale: ps, timeScale: ts, binWidth } = cfg;
  const visible = cells.filter((c) => !(c.t + cfg.timeBucketMs < ts.timeMin || c.t > ts.timeMax || c.price + binWidth < ps.priceMin || c.price > ps.priceMax));
  if (!visible.length) return;
  const side = cfg.densitySide || "combined";
  const valueFor = (c: Cell) => (side === "bids" ? c.bidLiquidity : side === "asks" ? c.askLiquidity : side === "imbalance" ? Math.abs(c.bidLiquidity - c.askLiquidity) : c.bidLiquidity + c.askLiquidity);
  const input = (c: Cell): Liq => (side === "bids" ? { bidLiquidity: c.bidLiquidity, askLiquidity: 0 } : side === "asks" ? { bidLiquidity: 0, askLiquidity: c.askLiquidity } : c);
  const { styleFor } = buildStyleFn(visible.map(valueFor), density);
  const styles = visible.map((c) => styleFor(input(c)));
  for (let i = 0; i < visible.length; i++) { // base fills
    const s = styles[i]; if (s.alpha <= 0) continue;
    ctx.fillStyle = colorForSide(s.side, s.alpha);
    ctx.fillRect(timeToX(visible[i].t, ts), priceToY(visible[i].price + binWidth, ps), cellW, cellH);
  }
  if (!density.glow) return; // additive glow on the strongest cells
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < visible.length; i++) {
    const s = styles[i]; if (!s.isStrong) continue;
    ctx.fillStyle = glowColorForSide(s.side, s.alpha);
    ctx.fillRect(timeToX(visible[i].t, ts), priceToY(visible[i].price + binWidth, ps), cellW, cellH);
  }
  ctx.globalCompositeOperation = prev;
}
function renderCandles(ctx: Ctx, candles: Candle[], cfg: Cfg) {
  const { priceScale: ps, timeScale: ts } = cfg, ms = cfg.candleMs || 60_000;
  for (const c of candles) {
    const slot = computeCandleSlot(c.t, c.t + ms, ts);
    if (slot.offscreen) continue;
    const up = c.close >= c.open, yO = priceToY(c.open, ps), yC = priceToY(c.close, ps);
    ctx.strokeStyle = up ? "rgba(140,230,160,0.95)" : "rgba(230,100,110,0.95)";
    ctx.fillStyle = up ? "rgba(140,230,160,0.55)" : "rgba(230,100,110,0.55)";
    ctx.lineWidth = 1;
    const wx = slot.slotX + slot.slotW / 2;
    ctx.beginPath(); ctx.moveTo(wx, priceToY(c.high, ps)); ctx.lineTo(wx, priceToY(c.low, ps)); ctx.stroke();
    ctx.fillRect(slot.bodyX, Math.min(yO, yC), slot.bodyW, Math.max(1, Math.abs(yC - yO)));
  }
}
function renderPriceLine(ctx: Ctx, price: number | undefined, cfg: Cfg, color: string) {
  if (price == null || !Number.isFinite(price) || price <= 0 || price < cfg.priceScale.priceMin || price > cfg.priceScale.priceMax) return;
  const y = priceToY(price, cfg.priceScale);
  ctx.save(); ctx.strokeStyle = color; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cfg.timeScale.xLeft, y); ctx.lineTo(cfg.timeScale.xRight, y); ctx.stroke(); ctx.restore();
}
function drawAxes(ctx: Ctx, cfg: Cfg, h: number, color: string, withSeconds: boolean) {
  const { priceScale: ps, timeScale: ts } = cfg;
  ctx.save(); ctx.fillStyle = color; ctx.font = "11px Manrope, system-ui, sans-serif";
  for (let i = 0; i <= 6; i++) {
    const p = ps.priceMin + ((ps.priceMax - ps.priceMin) * i) / 6;
    ctx.fillText(p.toFixed(p > 1000 ? 1 : p > 1 ? 4 : 8), ts.xRight + 4, priceToY(p, ps) + 3);
  }
  const narrow = ts.xRight - ts.xLeft < 480, n = narrow ? 3 : 5;
  let right = -Infinity;
  for (let i = 0; i <= n; i++) {
    const t = ts.timeMin + ((ts.timeMax - ts.timeMin) * i) / n, x = ts.xLeft + ((ts.xRight - ts.xLeft) * i) / n, label = hhmm(t, withSeconds && !narrow), w = ctx.measureText(label).width;
    const lx = Math.min(ts.xRight - w, Math.max(ts.xLeft, x - w / 2));
    if (lx < right + 8) continue; // no overlapping labels
    ctx.fillText(label, lx, h - 4); right = lx + w;
  }
  ctx.restore();
}
// The "heatmap collection started" marker: left of it there is no order-book history yet (by design, not missing data).
function drawCollectionStart(ctx: Ctx, cfg: Cfg, startedMs: number | null | undefined) {
  const { timeScale: ts, priceScale: ps } = cfg;
  if (!startedMs || startedMs <= ts.timeMin || startedMs >= ts.timeMax) return;
  const x = timeToX(startedMs, ts), label = "heatmap collection started";
  ctx.save(); ctx.strokeStyle = "rgba(245,165,36,0.55)"; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(x, ps.yTop); ctx.lineTo(x, ps.yBottom); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "rgba(245,165,36,0.95)"; ctx.font = "11px Manrope, system-ui, sans-serif";
  const w = ctx.measureText(label).width;
  ctx.fillText(label, x + 6 + w < ts.xRight ? x + 6 : Math.max(ts.xLeft + 6, x - 6 - w), ps.yTop + 14); ctx.restore();
}

// ---------------------------------------------------------------- volumeRenderer.ts (ported): one bar per column, under the candle bodies
interface Layout { xLeft: number; xRight: number; yTop: number; yBottom: number }
interface Bar { x: number; y: number; width: number; height: number; color: string }
interface Bucket { t: number; delta: number; cumulativeDelta: number; n: number }
function buildVolumeBars(candles: Candle[], ts: TimeScale, layout: Layout, ms: number): Bar[] {
  const vis = candles.filter((c) => { const s = computeCandleSlot(c.t, c.t + ms, ts); return !s.offscreen; });
  if (!vis.length) return [];
  const H = Math.max(1, layout.yBottom - layout.yTop), max = Math.max(1, ...vis.map((c) => c.volume));
  return vis.map((c) => {
    const s = computeCandleSlot(c.t, c.t + ms, ts), x1 = Math.max(ts.xLeft, s.bodyX), x2 = Math.min(ts.xRight, s.bodyX + s.bodyW), h = (Math.max(0, c.volume) / max) * H;
    return { x: x1, y: layout.yBottom - h, width: Math.max(1, x2 - x1), height: h, color: c.close >= c.open ? "rgba(120,210,140,0.85)" : "rgba(220,90,100,0.85)" };
  });
}
function buildDeltaBars(buckets: Bucket[], ts: TimeScale, layout: Layout, ms: number): Bar[] {
  const vis = buckets.filter((b) => !computeCandleSlot(b.t, b.t + ms, ts).offscreen);
  if (!vis.length) return [];
  const half = Math.max(1, layout.yBottom - layout.yTop) / 2, base = layout.yTop + half, max = Math.max(1, ...vis.map((b) => Math.abs(b.delta)));
  return vis.map((b) => {
    const s = computeCandleSlot(b.t, b.t + ms, ts), x1 = Math.max(ts.xLeft, s.bodyX), x2 = Math.min(ts.xRight, s.bodyX + s.bodyW), h = (Math.abs(b.delta) / max) * half;
    return { x: x1, y: b.delta >= 0 ? base - h : base, width: Math.max(1, x2 - x1), height: h, color: b.delta >= 0 ? "rgba(120,210,140,0.85)" : "rgba(220,90,100,0.85)" };
  });
}
function renderBars(ctx: Ctx, bars: Bar[], layout: Layout, baseline: number, line: string) {
  ctx.save(); ctx.strokeStyle = line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(layout.xLeft, baseline); ctx.lineTo(layout.xRight, baseline); ctx.stroke(); ctx.restore();
  for (const b of bars) if (b.height > 0) { ctx.fillStyle = b.color; ctx.fillRect(b.x, b.y, b.width, b.height); }
}
function renderCumDelta(ctx: Ctx, buckets: Bucket[], ts: TimeScale, layout: Layout, ms: number, color: string) {
  const max = Math.max(0, ...buckets.map((b) => Math.abs(b.cumulativeDelta)));
  if (!(max > 0)) return;
  const half = (layout.yBottom - layout.yTop) / 2, base = layout.yTop + half;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
  let on = false;
  for (const b of buckets) { const x = timeToX(b.t + ms / 2, ts); if (x < layout.xLeft || x > layout.xRight) continue; const y = base - (b.cumulativeDelta / max) * half; if (on) ctx.lineTo(x, y); else { ctx.moveTo(x, y); on = true; } }
  ctx.stroke(); ctx.restore();
}

// ---------------------------------------------------------------- the tab's draw
/** The heatmap's style choices (the selects and the Candles box above the chart). */
export interface DrawUi { preset: string; side: string; vol: string; candles: boolean }
const alpha = (c: string, a: number) => (/^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c); // a theme colour, see-through
function sizeCanvas(cv: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(200, cv.clientWidth), h = Math.max(60, cv.clientHeight);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
/** Draws the heatmap (main canvas) and the volume / delta bars (vol canvas) of `h`. Returns what the draw used (for the
 *  tooltip), or null when there was nothing to draw. */
export function drawLiquidity(mainCv: HTMLCanvasElement, volCv: HTMLCanvasElement, h: Heatmap | null, ui: DrawUi): Cfg | null {
  const main = sizeCanvas(mainCv), vol = sizeCanvas(volCv);
  if (!main || !vol) return null;
  const css = (name: string, d: string) => { try { return getComputedStyle(mainCv).getPropertyValue(name).trim() || d; } catch { return d; } };
  const muted = css("--muted", "#8fa0b4"), ink = css("--ink", "#eef4fa"), line = css("--line", "#253243");
  const prices = h?.prices || [], times = h?.times || [];
  if (!h || !prices.length || !times.length) {
    main.ctx.fillStyle = muted; main.ctx.font = "12px Manrope, system-ui, sans-serif";
    main.ctx.fillText(h?.warning || "Loading…", 14, 24); return null;
  }
  const plot = getPlotArea(main.w), bucket = h.bucketMs, unit = h.unit || 1;
  const cfg: Cfg = {
    priceScale: { priceMin: h.priceMin, priceMax: h.priceMax, yTop: 4, yBottom: main.h - BOTTOM_TIME_AXIS_PX },
    timeScale: { timeMin: times[0], timeMax: times[times.length - 1] + bucket, xLeft: plot.xLeft, xRight: plot.xRight },
    binWidth: h.binWidth, timeBucketMs: bucket, candleMs: bucket,
    colorOpts: { intensityMultiplier: 1.6, logScale: true, sideMode: ui.side },
    density: ui.preset === "classic" ? undefined : DENSITY_PRESETS[ui.preset] || DENSITY_PRESETS.deep, densitySide: ui.side,
  };
  const cells: Cell[] = [];
  let max = 0;
  for (let c = 0; c < times.length; c++) {
    const B = h.bids[c], A = h.asks[c];
    if (!B) continue;
    for (let r = 0; r < prices.length; r++) {
      const b = B[r] * unit, a = A[r] * unit;
      if (b + a > 0) { cells.push({ t: times[c], price: prices[r], bidLiquidity: b, askLiquidity: a, totalLiquidity: b + a, intensity: 0 }); if (b + a > max) max = b + a; }
    }
  }
  for (const c of cells) c.intensity = max > 0 ? c.totalLiquidity / max : 0;
  renderHeatmap(main.ctx, cells, cfg);
  const V = h.volume;
  const candles: Candle[] = V ? times.flatMap((t, c) => (V.o[c] == null ? [] : [{ t, open: V.o[c] as number, high: V.h[c] as number, low: V.l[c] as number, close: V.c[c] as number, volume: V.buy[c] + V.sell[c] }])) : [];
  if (ui.candles && candles.length) renderCandles(main.ctx, candles, cfg);
  else if (h.mids?.some((m) => m)) { // without candles: the mid price through time
    const ctx = main.ctx;
    ctx.save(); ctx.strokeStyle = ink; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.2; ctx.beginPath();
    let on = false;
    h.mids.forEach((m, c) => { if (!m) return; const x = timeToX(times[c] + bucket / 2, cfg.timeScale), y = priceToY(m, cfg.priceScale); if (on) ctx.lineTo(x, y); else { ctx.moveTo(x, y); on = true; } });
    ctx.stroke(); ctx.restore();
  }
  renderPriceLine(main.ctx, h.book?.mid, cfg, alpha(ink, 0.6));
  drawCollectionStart(main.ctx, cfg, h.collectionStartedAt);
  drawAxes(main.ctx, cfg, main.h, muted, h.lookbackMin <= 15);
  // volume / delta under the chart, the same x geometry
  const layout: Layout = { xLeft: plot.xLeft, xRight: plot.xRight, yTop: 6, yBottom: vol.h - 6 };
  const vts = { ...cfg.timeScale };
  const buckets: Bucket[] = V ? times.map((t, c) => ({ t, delta: V.delta[c], cumulativeDelta: V.cum[c], n: V.trades[c] })).filter((b) => b.n > 0) : [];
  const delta = ui.vol === "delta" && buckets.length >= 2;
  if (delta) {
    renderBars(vol.ctx, buildDeltaBars(buckets, vts, layout, bucket), layout, layout.yTop + (layout.yBottom - layout.yTop) / 2, line);
    renderCumDelta(vol.ctx, buckets, vts, layout, bucket, alpha(ink, 0.7));
  } else renderBars(vol.ctx, buildVolumeBars(candles, vts, layout, bucket), layout, layout.yBottom, line);
  vol.ctx.fillStyle = muted; vol.ctx.font = "10px Manrope, system-ui, sans-serif";
  const vmax = delta ? Math.max(...buckets.map((b) => Math.abs(b.delta))) : Math.max(0, ...candles.map((c) => c.volume));
  vol.ctx.fillText(`${delta ? "delta ±" : "vol "}${money(vmax)}`, plot.xRight + 4, 14);
  return cfg;
}

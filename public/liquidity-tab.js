// Liquidity tab, browser side. Plain script, no build step. It fills the element with id "view-liquidity":
//   - the multi-exchange screener (Binance, Bybit, OKX, Coinbase, Kraken): a sortable table with each coin's 0-100
//     hotness, its signals, prices and volume, filters by exchange and by signal, and each exchange's health;
//   - the order-book heatmap of one Binance pair: where resting orders sat over the last 15 minutes to 2 hours, with
//     trade candles, the current book (best prices, the book grouped by price, the biggest walls) and trade volume.
// window.liquidityTab.start() loads the data and starts the timers; stop() stops them. Data: /api/liquidity (liquidity.js).
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
(() => {
  "use strict";
  if (window.liquidityTab) return;

  // ---------------------------------------------------------------- small helpers (same formats as the rest of the page)
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + Number(v).toFixed(0));
  const px = (v) => (v == null || !(v > 0) ? "—" : v >= 1000 ? Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 }) : v >= 1 ? Number(v).toFixed(4) : Number(v).toPrecision(4));
  const pct = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? "—" : `<span class="${v > 0 ? "green" : v < 0 ? "red" : ""}">${v > 0 ? "+" : ""}${Number(v).toFixed(d)}%</span>`);
  const hhmm = (t, sec) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}) });
  const store = { get(k, d) { try { return localStorage.getItem("liq:" + k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem("liq:" + k, v); } catch { /* private mode */ } } };
  const EX_NAMES = { binance: "Binance", bybit: "Bybit", okx: "OKX", coinbase: "Coinbase", kraken: "Kraken" };
  const SIGNALS = [["VOLUME_SPIKE", "Volume spike"], ["PRICE_PUMP", "Pump"], ["PRICE_DUMP", "Dump"], ["VOLATILITY_EXPANSION", "Volatility"], ["SPREAD_WIDENING", "Wide spread"],
    ["ORDER_BOOK_IMBALANCE", "Book imbalance"], ["BREAKOUT", "Breakout"], ["HOT_MARKET", "Hot market"]];
  const SIG_CLASS = { PRICE_PUMP: "strong", PRICE_DUMP: "risk", HOT_MARKET: "watch", VOLUME_SPIKE: "lq-blue", BREAKOUT: "lq-blue" };

  // ---------------------------------------------------------------- densityScale.ts (ported)
  // Single outlier walls must not blow out the scale (percentile cap); weak liquidity stays readable (gamma < 1).
  const DENSITY_PRESETS = {
    balanced: { mode: "percentile", capPercentile: 0.99, gamma: 0.75, minOpacity: 0.06, maxOpacity: 0.9, hideWeakBelow: 0, strongOnlyAbove: 0, glow: false },
    deep: { mode: "zscore", capPercentile: 0.99, gamma: 0.6, minOpacity: 0.08, maxOpacity: 0.95, hideWeakBelow: 0, strongOnlyAbove: 0, glow: true },
    walls: { mode: "percentile", capPercentile: 0.995, gamma: 0.85, minOpacity: 0, maxOpacity: 0.95, hideWeakBelow: 0.85, strongOnlyAbove: 0.85, glow: true },
    weak: { mode: "log", capPercentile: 0.95, gamma: 0.5, minOpacity: 0.12, maxOpacity: 0.85, hideWeakBelow: 0, strongOnlyAbove: 0, glow: false },
    clean: { mode: "zscore", capPercentile: 0.99, gamma: 0.7, minOpacity: 0, maxOpacity: 0.9, hideWeakBelow: 0.55, strongOnlyAbove: 0, glow: false },
  };
  function applyGamma(i, gamma) {
    if (!Number.isFinite(i) || i <= 0) return 0;
    if (i >= 1) return 1;
    return Math.pow(i, Math.max(0.05, Math.min(4, gamma)));
  }
  function computeLiquidityStats(values, capPercentile = 0.99) {
    const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b), n = sorted.length;
    if (!n) return { count: 0, max: 0, mean: 0, std: 0, p50: 0, p90: 0, p95: 0, p99: 0, cap: 0 };
    const mean = sorted.reduce((a, v) => a + v, 0) / n;
    let vs = 0; for (const v of sorted) vs += (v - mean) * (v - mean);
    const pick = (q) => sorted[Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))];
    return { count: n, max: sorted[n - 1], mean, std: Math.sqrt(vs / n), p50: pick(0.5), p90: pick(0.9), p95: pick(0.95), p99: pick(0.99), cap: pick(Math.max(0, Math.min(0.999, capPercentile))) };
  }
  const normalizeRaw = (v, s) => (s.cap <= 0 || !Number.isFinite(v) || v <= 0 ? 0 : Math.min(1, v / s.cap));
  const normalizeLog = (v, s) => (s.cap <= 0 || !Number.isFinite(v) || v <= 0 ? 0 : Math.log1p(Math.min(v, s.cap)) / Math.log1p(s.cap));
  function normalizePercentile(v, arr) {
    if (!arr.length || !Number.isFinite(v) || v <= 0) return 0;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] <= v) lo = m + 1; else hi = m; }
    return lo / arr.length;
  }
  // z < 0.5 hidden; 0.5-1.5 notable (0.30-0.55); 1.5-2.5 strong wall (0.55-0.80); 2.5+ extreme (0.80-1.00, clamped at z = 4)
  function normalizeZScore(v, s) {
    if (s.std <= 0 || !Number.isFinite(v) || v <= 0) return 0;
    const z = (v - s.mean) / s.std;
    if (z < 0.5) return 0;
    if (z < 1.5) return 0.3 + (z - 0.5) * 0.25;
    if (z < 2.5) return 0.55 + (z - 1.5) * 0.25;
    return 0.8 + Math.min(1, (z - 2.5) / 1.5) * 0.2;
  }
  const normalize = (v, mode, s, sorted) => (mode === "raw" ? normalizeRaw(v, s) : mode === "log" ? normalizeLog(v, s) : mode === "percentile" ? normalizePercentile(v, sorted) : mode === "zscore" ? normalizeZScore(v, s) : normalizeLog(v, s));
  function buildStyleFn(values, o) {
    const stats = computeLiquidityStats(values, o.capPercentile), sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    const none = { alpha: 0, intensity: 0, side: "balanced", isStrong: false };
    return { stats, styleFor(c) {
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
  const colorForSide = (side, a) => (side === "bid" ? `rgba(60, 200, 220, ${a.toFixed(3)})` : side === "ask" ? `rgba(245, 120, 160, ${a.toFixed(3)})` : `rgba(160, 130, 220, ${a.toFixed(3)})`);
  function glowColorForSide(side, alpha) {
    const a = Math.min(0.35, alpha).toFixed(3);
    return side === "bid" ? `rgba(180, 255, 255, ${a})` : side === "ask" ? `rgba(255, 200, 220, ${a})` : `rgba(220, 200, 255, ${a})`;
  }

  // ---------------------------------------------------------------- heatmapColor.ts (ported): the classic colour map
  function applyIntensity(i, o) { let v = Math.max(0, Math.min(1, i)); if (o.logScale) v = Math.log1p(9 * v) / Math.log(10); return Math.min(1, v * o.intensityMultiplier); }
  const rgba = (r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
  function colorForCell(cell, o) {
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
  const priceToY = (p, s) => (s.priceMax === s.priceMin ? s.yBottom : s.yBottom - ((p - s.priceMin) / (s.priceMax - s.priceMin)) * (s.yBottom - s.yTop));
  const yToPrice = (y, s) => (s.yBottom === s.yTop ? s.priceMin : s.priceMin + ((s.yBottom - y) / (s.yBottom - s.yTop)) * (s.priceMax - s.priceMin));
  const timeToX = (t, s) => (s.timeMax === s.timeMin ? s.xLeft : s.xLeft + ((t - s.timeMin) / (s.timeMax - s.timeMin)) * (s.xRight - s.xLeft));
  const RIGHT_PRICE_AXIS_PX = 60, BOTTOM_TIME_AXIS_PX = 18, LEFT_INSET_PX = 4, CANDLE_BODY_FRAC = 0.7;
  const getPlotArea = (w) => { const xLeft = LEFT_INSET_PX, xRight = Math.max(LEFT_INSET_PX + 8, w - RIGHT_PRICE_AXIS_PX); return { xLeft, xRight, innerWidth: Math.max(0, xRight - xLeft) }; };
  function computeCandleSlot(open, close, ts) {
    const slotX = timeToX(open, ts), slotXEnd = timeToX(close, ts), slotW = Math.max(1, slotXEnd - slotX), bodyW = Math.max(1, slotW * CANDLE_BODY_FRAC);
    return { slotX, slotXEnd, slotW, bodyX: slotX + (slotW - bodyW) / 2, bodyW, offscreen: slotXEnd < ts.xLeft || slotX > ts.xRight };
  }

  // ---------------------------------------------------------------- canvasRenderer.ts (ported)
  // cells: [{ t, price, bidLiquidity, askLiquidity, totalLiquidity, intensity }]; cfg: { priceScale, timeScale, binWidth, timeBucketMs, colorOpts, density?, densitySide }
  function renderHeatmap(ctx, cells, cfg) {
    const { priceScale: ps, timeScale: ts, binWidth, timeBucketMs } = cfg;
    ctx.clearRect(ts.xLeft, ps.yTop, Math.max(1, ts.xRight - ts.xLeft), Math.max(1, ps.yBottom - ps.yTop));
    if (!cells.length || binWidth <= 0) return;
    const xRange = ts.xRight - ts.xLeft;
    const cellW = Math.max(2, Math.min(xRange, (timeBucketMs / Math.max(1, ts.timeMax - ts.timeMin)) * xRange));
    const cellH = Math.max(1, Math.abs(priceToY(ps.priceMin, ps) - priceToY(ps.priceMin + binWidth, ps)));
    if (cfg.density) { renderHeatmapDensity(ctx, cells, cfg, cellW, cellH); return; }
    for (const c of cells) { // the classic colour map
      const fill = colorForCell(c, cfg.colorOpts);
      if (!fill) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(timeToX(c.t, ts), priceToY(c.price + binWidth, ps), cellW, cellH);
    }
  }
  function renderHeatmapDensity(ctx, cells, cfg, cellW, cellH) {
    const { priceScale: ps, timeScale: ts, binWidth, density } = cfg;
    const visible = cells.filter((c) => !(c.t + cfg.timeBucketMs < ts.timeMin || c.t > ts.timeMax || c.price + binWidth < ps.priceMin || c.price > ps.priceMax));
    if (!visible.length) return;
    const side = cfg.densitySide || "combined";
    const valueFor = (c) => (side === "bids" ? c.bidLiquidity : side === "asks" ? c.askLiquidity : side === "imbalance" ? Math.abs(c.bidLiquidity - c.askLiquidity) : c.bidLiquidity + c.askLiquidity);
    const input = (c) => (side === "bids" ? { bidLiquidity: c.bidLiquidity, askLiquidity: 0 } : side === "asks" ? { bidLiquidity: 0, askLiquidity: c.askLiquidity } : c);
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
  function renderCandles(ctx, candles, cfg) {
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
  function renderPriceLine(ctx, price, cfg, color) {
    if (!Number.isFinite(price) || price <= 0 || price < cfg.priceScale.priceMin || price > cfg.priceScale.priceMax) return;
    const y = priceToY(price, cfg.priceScale);
    ctx.save(); ctx.strokeStyle = color; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cfg.timeScale.xLeft, y); ctx.lineTo(cfg.timeScale.xRight, y); ctx.stroke(); ctx.restore();
  }
  function drawAxes(ctx, cfg, h, color, withSeconds) {
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
  function drawCollectionStart(ctx, cfg, startedMs) {
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
  function buildVolumeBars(candles, ts, layout, ms) {
    const vis = candles.filter((c) => { const s = computeCandleSlot(c.t, c.t + ms, ts); return !s.offscreen; });
    if (!vis.length) return [];
    const H = Math.max(1, layout.yBottom - layout.yTop), max = Math.max(1, ...vis.map((c) => c.volume));
    return vis.map((c) => {
      const s = computeCandleSlot(c.t, c.t + ms, ts), x1 = Math.max(ts.xLeft, s.bodyX), x2 = Math.min(ts.xRight, s.bodyX + s.bodyW), h = (Math.max(0, c.volume) / max) * H;
      return { x: x1, y: layout.yBottom - h, width: Math.max(1, x2 - x1), height: h, color: c.close >= c.open ? "rgba(120,210,140,0.85)" : "rgba(220,90,100,0.85)" };
    });
  }
  function buildDeltaBars(buckets, ts, layout, ms) {
    const vis = buckets.filter((b) => !computeCandleSlot(b.t, b.t + ms, ts).offscreen);
    if (!vis.length) return [];
    const half = Math.max(1, layout.yBottom - layout.yTop) / 2, base = layout.yTop + half, max = Math.max(1, ...vis.map((b) => Math.abs(b.delta)));
    return vis.map((b) => {
      const s = computeCandleSlot(b.t, b.t + ms, ts), x1 = Math.max(ts.xLeft, s.bodyX), x2 = Math.min(ts.xRight, s.bodyX + s.bodyW), h = (Math.abs(b.delta) / max) * half;
      return { x: x1, y: b.delta >= 0 ? base - h : base, width: Math.max(1, x2 - x1), height: h, color: b.delta >= 0 ? "rgba(120,210,140,0.85)" : "rgba(220,90,100,0.85)" };
    });
  }
  function renderBars(ctx, bars, layout, baseline, line) {
    ctx.save(); ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(layout.xLeft, baseline); ctx.lineTo(layout.xRight, baseline); ctx.stroke(); ctx.restore();
    for (const b of bars) if (b.height > 0) { ctx.fillStyle = b.color; ctx.fillRect(b.x, b.y, b.width, b.height); }
  }
  function renderCumDelta(ctx, buckets, ts, layout, ms, color) {
    const max = Math.max(0, ...buckets.map((b) => Math.abs(b.cumulativeDelta)));
    if (!(max > 0)) return;
    const half = (layout.yBottom - layout.yTop) / 2, base = layout.yTop + half;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
    let on = false;
    for (const b of buckets) { const x = timeToX(b.t + ms / 2, ts); if (x < layout.xLeft || x > layout.xRight) continue; const y = base - (b.cumulativeDelta / max) * half; if (on) ctx.lineTo(x, y); else { ctx.moveTo(x, y); on = true; } }
    ctx.stroke(); ctx.restore();
  }

  // ---------------------------------------------------------------- the tab
  let root = null, running = false, timers = [], data = null, hm = null, hmBusy = false, scBusy = false, drawQueued = false, cfgNow = null;
  const ui = {
    lookback: Number(store.get("lookback", "30")) || 30, preset: store.get("preset", "deep"), side: store.get("side", "combined"), vol: store.get("vol", "volume"),
    candles: store.get("candles", "1") === "1", sort: store.get("sort", "score"), dir: Number(store.get("dir", "-1")) || -1, ex: store.get("ex", "all"), sig: store.get("sig", "all"),
  };
  const $ = (sel) => root?.querySelector(sel);
  const css = (name, d) => { try { return getComputedStyle(root).getPropertyValue(name).trim() || d; } catch { return d; } };
  const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c); // a theme colour, see-through

  const STYLE = `
#view-liquidity .lq-grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:14px;padding:0 18px 18px}
#view-liquidity .lq-chart{position:relative;min-width:0}
#view-liquidity .lq-chart canvas{display:block;width:100%}
#view-liquidity .lq-main{height:440px;border:1px solid var(--line);border-radius:12px;background:rgba(0,0,0,.18)}
#view-liquidity .lq-volc{height:90px;margin-top:6px}
#view-liquidity .lq-tip{position:absolute;pointer-events:none;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:7px 9px;font-size:11px;line-height:1.55;white-space:nowrap;z-index:3;box-shadow:0 10px 30px #0008}
#view-liquidity .lq-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:0 18px 12px}
#view-liquidity .lq-controls form{display:flex;gap:6px;margin:0}
#view-liquidity .lq-controls input[type=text]{width:128px;text-transform:uppercase;padding:8px 10px}
#view-liquidity .lq-controls select{padding:8px}
#view-liquidity .lq-controls .btn{padding:8px 11px;font-size:12px}
#view-liquidity .lq-check{display:inline-flex;gap:6px;align-items:center;color:var(--muted);font-size:12px}
#view-liquidity .lq-check input{padding:0;accent-color:var(--green)}
#view-liquidity .lq-msg{padding:0 18px 10px;font-size:12px;color:var(--muted)}
#view-liquidity .lq-msg.bad{color:var(--red)}
#view-liquidity .lq-side{border:1px solid var(--line);border-radius:12px;background:var(--panel2);padding:12px;font-size:12px;min-width:0;align-self:start}
#view-liquidity .lq-side h3{margin:0;font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:8px}
#view-liquidity .lq-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin:10px 0}
#view-liquidity .lq-stats span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em}
#view-liquidity .lq-stats b{font-family:"DM Mono",monospace;font-weight:500}
#view-liquidity .lq-ob{width:100%;border-collapse:collapse;font-family:"DM Mono",monospace;font-size:11px}
#view-liquidity .lq-ob td{padding:2px 4px;position:relative}
#view-liquidity .lq-ob td.v{text-align:right;width:46%}
#view-liquidity .lq-ob td.v i{position:absolute;right:0;top:2px;bottom:2px;border-radius:2px;opacity:.25}
#view-liquidity .lq-ob tr.mid td{color:var(--muted);text-align:center;padding:5px 0;font-family:Manrope,system-ui,sans-serif}
#view-liquidity .lq-walls{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;font-family:"DM Mono",monospace;font-size:11px}
#view-liquidity .lq-walls .sub{font-family:Manrope,system-ui,sans-serif}
#view-liquidity .lq-legend{display:flex;flex-wrap:wrap;gap:14px;padding:8px 0 0;font-size:11.5px;color:var(--muted)}
#view-liquidity .lq-legend i{display:inline-block;width:12px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
#view-liquidity .lq-sort{background:none;border:0;padding:0;color:inherit;font:inherit;letter-spacing:inherit;text-transform:inherit;cursor:pointer}
#view-liquidity .lq-sort:hover,#view-liquidity .lq-sort.on{color:var(--ink)}
#view-liquidity .lq-sigs{display:flex;flex-wrap:wrap;gap:4px;white-space:normal;max-width:260px}
#view-liquidity .badge.lq-blue{color:var(--blue);border-color:#2c4a77;background:#111d30}
#view-liquidity .badge.lq-b-extreme{color:var(--red);border-color:#6e2c3a;background:#2d1720}
#view-liquidity .badge.lq-b-hot{color:var(--amber);border-color:#6d5621;background:#2b2414}
#view-liquidity .badge.lq-b-normal{color:var(--blue);border-color:#2c4a77;background:#111d30}
#view-liquidity .badge.lq-b-cold{color:var(--muted)}
#view-liquidity .scorebar i.hot{background:var(--amber)}#view-liquidity .scorebar i.extreme{background:var(--red)}#view-liquidity .scorebar i.normal{background:var(--blue)}#view-liquidity .scorebar i.cold{background:var(--muted)}
#view-liquidity .lq-ex{font-size:11px;color:var(--muted)}#view-liquidity .lq-ex b{color:var(--ink)}
@media(max-width:900px){#view-liquidity .lq-grid{grid-template-columns:1fr}}
@media(max-width:600px){#view-liquidity .lq-main{height:300px}#view-liquidity .lq-volc{height:70px}#view-liquidity .lq-grid{padding:0 10px 14px}#view-liquidity .lq-controls{padding:0 10px 10px}#view-liquidity .lq-controls input[type=text]{width:110px}}`;

  function mount() {
    if (root) return true;
    root = document.getElementById("view-liquidity");
    if (!root) return false;
    if (!document.getElementById("liq-style")) { const s = document.createElement("style"); s.id = "liq-style"; s.textContent = STYLE; document.head.appendChild(s); }
    const opt = (v, l, cur) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`;
    root.innerHTML = `
<details class="notice"><summary><b>Read this first:</b> a market scanner across five exchanges plus a live order-book heatmap. It shows where activity and resting orders are; it does not predict price.</summary><div><b>Hotness</b> (0-100) = momentum 25% (5-minute move, 5% = full marks) + volume 25% (last 5 minutes vs the 20 before, 5x = full) + volatility 20% + 24h volume 15% ($100M = full) + order-book imbalance 15%. Cold 0-30, normal 31-60, hot 61-80, extreme 81+. <b>Signals</b>: volume spike (over 3x), pump or dump (over 2% in 5 minutes), volatility expansion (over 2x), wide spread (over 0.15%), book imbalance (over 65% one side, top 20 levels), breakout (beyond the last 20 one-minute candles), hot market (81+). Each exchange's 15 most traded coins get the full check every 15 to 60 seconds; a coin's row shows its hottest exchange. <b>Heatmap</b>: resting orders on Binance, in dollars per price band, sampled every second and kept for about 2 hours; bright bands are big resting orders ("walls"). Walls can be pulled at any moment (spoofing), so treat them as context, not support or resistance. Stablecoins and tokenized stocks are left out. Public data, no API keys. The scoring, signal rules and heatmap drawing come from the open-source crypto-liquidity-terminal project (MIT License, Copyright (c) 2026 Crypto Market Screener contributors). Not financial advice.</div></details>
<div class="error" id="lqErrors"></div>
<div class="kpis" data-sec="screener">
 <div class="kpi"><div class="label">Coins checked</div><div class="value" id="lqK1">—</div><div class="hint" id="lqK1h">top coins of five exchanges</div></div>
 <div class="kpi"><div class="label">Hot or extreme now</div><div class="value amber" id="lqK2">—</div><div class="hint">hotness 61 or more</div></div>
 <div class="kpi"><div class="label">Signals firing</div><div class="value green" id="lqK3">—</div><div class="hint" id="lqK3h">across all coins</div></div>
 <div class="kpi"><div class="label">Exchanges answering</div><div class="value" id="lqK4">—</div><div class="hint" id="lqK4h">public APIs, no keys</div></div>
</div>
<section data-sec="heatmap" class="panel" style="margin-bottom:14px">
 <div class="section-head"><div><h2>Order-book heatmap · <span id="lqSym">—</span></h2><p id="lqHmSub">Resting buy orders (teal) and sell orders (pink) on Binance by price, over time. Bright = big orders. Candles = trades in each time slice.</p></div><span class="chip" id="lqFeedChip">—</span></div>
 <div class="lq-controls">
  <form id="lqSymForm" autocomplete="off"><input type="text" id="lqSymIn" aria-label="Binance spot pair" placeholder="BTCUSDT" maxlength="20" spellcheck="false"><button class="btn" type="submit">Show</button></form>
  <span class="lq-seg" role="group" aria-label="Lookback" id="lqLb">${[[15, "15m"], [30, "30m"], [60, "1h"], [120, "2h"]].map(([v, l]) => `<button type="button" class="btn${v === ui.lookback ? " on" : ""}" data-lb="${v}" aria-pressed="${v === ui.lookback}">${l}</button>`).join("")}</span>
  <select id="lqPreset" aria-label="Heatmap style">${opt("deep", "Deep liquidity", ui.preset)}${opt("balanced", "Balanced", ui.preset)}${opt("walls", "Strong walls only", ui.preset)}${opt("weak", "Show weak liquidity", ui.preset)}${opt("clean", "Clean", ui.preset)}${opt("classic", "Classic colours", ui.preset)}</select>
  <select id="lqSide" aria-label="Which side">${opt("combined", "Both sides", ui.side)}${opt("bids", "Buy orders", ui.side)}${opt("asks", "Sell orders", ui.side)}${opt("imbalance", "Imbalance", ui.side)}</select>
  <select id="lqVol" aria-label="Lower panel">${opt("volume", "Volume", ui.vol)}${opt("delta", "Buy − sell (delta)", ui.vol)}</select>
  <label class="lq-check"><input type="checkbox" id="lqCandles"${ui.candles ? " checked" : ""}> Candles</label>
 </div>
 <div class="lq-msg" id="lqMsg" hidden></div>
 <div class="lq-grid">
  <div class="lq-chart"><canvas class="lq-main" id="lqCanvas" role="img" aria-label="Order-book heatmap"></canvas><canvas class="lq-volc" id="lqVolCanvas" role="img" aria-label="Trade volume per time slice"></canvas><div class="lq-tip" id="lqTip" hidden></div>
   <div class="lq-legend"><span><i style="background:rgb(60,200,220)"></i>buy orders</span><span><i style="background:rgb(245,120,160)"></i>sell orders</span><span><i style="background:rgb(160,130,220)"></i>both</span><span><i style="background:transparent;border-top:1px dashed var(--ink);height:0;width:14px"></i>current price</span><span id="lqBin"></span></div></div>
  <aside class="lq-side" id="lqBook" aria-label="Current order book"><div class="empty" style="padding:20px">Connecting to the order book…</div></aside>
 </div>
</section>
<section data-sec="screener" class="panel">
 <div class="section-head"><div><h2>Hot markets on five exchanges</h2><p>Binance, Bybit, OKX, Coinbase and Kraken spot, one row per coin. Click a coin to see its Binance order book above.</p></div>
  <div class="filters">
   <select id="lqEx" aria-label="Exchange">${opt("all", "All exchanges", ui.ex)}${Object.entries(EX_NAMES).map(([k, l]) => opt(k, l, ui.ex)).join("")}</select>
   <select id="lqSig" aria-label="Signal">${opt("all", "All coins", ui.sig)}${opt("any", "Any signal", ui.sig)}${SIGNALS.map(([k, l]) => opt(k, l, ui.sig)).join("")}</select>
   <select id="lqSort" aria-label="Sort by">${[["score", "Hotness"], ["signals", "Signals"], ["change5m", "5m move"], ["change24h", "24h move"], ["volumeUsd", "Volume"], ["spreadPct", "Spread"], ["priceGapPct", "Price gap"], ["coin", "Coin"]].map(([k, l]) => opt(k, "Sort: " + l, ui.sort)).join("")}</select>
   <span class="chip" id="lqChip">—</span></div></div>
 <div class="table-wrap"><table class="table cards"><thead><tr>
  <th><button class="lq-sort" data-sort="coin">Coin</button></th><th><button class="lq-sort" data-sort="score">Hotness</button></th><th><button class="lq-sort" data-sort="signals">Signals</button></th>
  <th><button class="lq-sort" data-sort="change24h">Price · 24h</button></th><th><button class="lq-sort" data-sort="change5m">5m · 1h</button></th><th><button class="lq-sort" data-sort="volumeUsd">Volume 24h</button></th>
  <th><button class="lq-sort" data-sort="spreadPct">Spread · book</button></th><th><button class="lq-sort" data-sort="priceGapPct">Exchanges · price gap</button></th></tr></thead>
  <tbody id="lqBody"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody></table></div>
</section>
<section data-sec="health" class="panel" style="margin-top:14px"><div class="section-head"><div><h2>Data health</h2><p>Each exchange is read on its own: one that fails or rate-limits is shown here and the others carry on.</p></div></div><div class="source-list" id="lqHealth"></div></section>`;
    bind();
    return true;
  }

  function bind() {
    $("#lqSymForm").addEventListener("submit", (e) => { e.preventDefault(); setSymbol($("#lqSymIn").value); });
    $("#lqLb").addEventListener("click", (e) => {
      const b = e.target.closest("[data-lb]"); if (!b) return;
      ui.lookback = Number(b.dataset.lb); store.set("lookback", ui.lookback);
      root.querySelectorAll("#lqLb [data-lb]").forEach((x) => { const on = Number(x.dataset.lb) === ui.lookback; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); });
      loadHeatmap(true);
    });
    for (const [id, key] of [["#lqPreset", "preset"], ["#lqSide", "side"], ["#lqVol", "vol"]]) $(id).addEventListener("change", (e) => { ui[key] = e.target.value; store.set(key, ui[key]); queueDraw(); });
    $("#lqCandles").addEventListener("change", (e) => { ui.candles = e.target.checked; store.set("candles", ui.candles ? "1" : "0"); queueDraw(); });
    $("#lqEx").addEventListener("change", (e) => { ui.ex = e.target.value; store.set("ex", ui.ex); drawScreener(); });
    $("#lqSig").addEventListener("change", (e) => { ui.sig = e.target.value; store.set("sig", ui.sig); drawScreener(); });
    $("#lqSort").addEventListener("change", (e) => { ui.sort = e.target.value; ui.dir = ui.sort === "coin" ? 1 : -1; store.set("sort", ui.sort); store.set("dir", ui.dir); drawScreener(); });
    root.querySelector("thead").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sort]"); if (!b) return;
      if (ui.sort === b.dataset.sort) ui.dir = -ui.dir; else { ui.sort = b.dataset.sort; ui.dir = ui.sort === "coin" ? 1 : -1; }
      store.set("sort", ui.sort); store.set("dir", ui.dir); $("#lqSort").value = ui.sort; drawScreener();
    });
    $("#lqBody").addEventListener("click", (e) => { const b = e.target.closest("[data-coin]"); if (b) { setSymbol(b.dataset.coin + "USDT"); $("#lqSym")?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" }); } });
    const cv = $("#lqCanvas");
    cv.addEventListener("mousemove", tooltip);
    cv.addEventListener("mouseleave", () => { $("#lqTip").hidden = true; });
  }

  const getJson = async (url, opts) => { const r = await fetch(url, { cache: "no-store", ...opts }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  function message(text, bad) { const m = $("#lqMsg"); if (!m) return; m.hidden = !text; m.textContent = text || ""; m.classList.toggle("bad", !!bad); }
  async function setSymbol(sym) {
    const s = String(sym || "").trim().toUpperCase();
    if (!s) return;
    message(`Switching to ${s}…`);
    try {
      const r = await getJson("/api/liquidity/symbol", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: s }) });
      message(`Now showing ${r.symbol}. The heatmap fills in as the seconds go by (history starts now).`);
      $("#lqSymIn").value = ""; hm = null; loadHeatmap(true);
    } catch (e) { message(e.message, true); }
  }

  // ---------------------------------------------------------------- screener
  async function loadScreener() {
    if (scBusy) return; scBusy = true;
    try { data = await getJson("/api/liquidity"); $("#lqErrors").style.display = "none"; drawScreener(); }
    catch (e) { const el = $("#lqErrors"); if (el) { el.style.display = "block"; el.textContent = "Liquidity: " + e.message; } }
    finally { scBusy = false; }
  }
  // With one exchange picked, each row shows that exchange's own numbers.
  function view(r) {
    if (ui.ex === "all") return r;
    const v = r.venues.find((x) => x.ex === ui.ex);
    if (!v) return null;
    return { ...r, score: v.score, band: v.band, lead: v.deep ? v.ex : null, price: v.price, change24h: v.change24h, change5m: v.change5m, change1h: v.change1h, volumeUsd: v.volumeUsd,
      spreadPct: v.spreadPct, imbalance: v.imbalance, signals: v.signals.map((s) => ({ ...s, label: (SIGNALS.find((x) => x[0] === s.type) || [, s.type])[1], venues: [v.ex] })) };
  }
  const sortVal = (r, k) => (k === "signals" ? r.signals.length : k === "coin" ? r.coin : r[k] ?? null);
  function drawScreener() {
    if (!root || !data) return;
    const d = data, all = d.rows || [], ok = (d.exchanges || []).filter((x) => x.status === "ok").length;
    $("#lqK1").textContent = all.length || "—";
    $("#lqK1h").textContent = `top ${d.perExchange || 15} of each exchange, refreshed every ${Math.round((d.refreshMs || 15000) / 1000)} s`;
    $("#lqK2").textContent = all.length ? all.filter((r) => r.score >= 61).length : "—";
    const nSig = all.reduce((a, r) => a + r.signals.filter((s) => s.type !== "HOT_MARKET").length, 0);
    $("#lqK3").textContent = all.length ? nSig : "—";
    $("#lqK3h").textContent = all.length ? `on ${all.filter((r) => r.signals.length).length} coins` : "across all coins";
    $("#lqK4").textContent = d.exchanges ? `${ok}/${d.exchanges.length}` : "—";
    $("#lqK4").className = "value " + (d.exchanges && ok === d.exchanges.length ? "green" : ok ? "amber" : "red");
    $("#lqK4h").textContent = (d.exchanges || []).filter((x) => x.status !== "ok").map((x) => `${x.name}: ${x.status}`).join(" · ") || "public APIs, no keys";
    let rows = all.map(view).filter(Boolean);
    if (ui.sig === "any") rows = rows.filter((r) => r.signals.length);
    else if (ui.sig !== "all") rows = rows.filter((r) => r.signals.some((s) => s.type === ui.sig));
    rows.sort((a, b) => {
      const x = sortVal(a, ui.sort), y = sortVal(b, ui.sort);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * ui.dir;
    });
    root.querySelectorAll("thead .lq-sort").forEach((b) => { const on = b.dataset.sort === ui.sort; b.classList.toggle("on", on); b.textContent = b.textContent.replace(/ [▲▼]$/, "") + (on ? (ui.dir > 0 ? " ▲" : " ▼") : ""); });
    $("#lqChip").textContent = d.updatedAt ? `${rows.length} coins · ${hhmm(d.updatedAt, true)}` : d.status === "starting" ? "first scan…" : "—";
    const tb = $("#lqBody");
    tb.innerHTML = rows.length ? rows.map(rowHtml).join("") : `<tr><td colspan="8" class="empty">${d.status === "starting" || !d.updatedAt ? "First scan in a few seconds… each exchange's coins fill in over the first minute." : all.length ? "No coin in this view." : esc(d.error || "No data yet.")}</td></tr>`;
    const hs = [...root.querySelectorAll("thead th")].map((th) => th.textContent.replace(/ [▲▼]$/, "").trim());
    for (const tr of tb.rows) [...tr.cells].forEach((td, i) => { if (td.colSpan > 1) return; td.dataset.label = hs[i] || ""; if (/^[—–-]?$/.test(td.textContent.trim())) td.dataset.empty = ""; else delete td.dataset.empty; });
    drawHealth();
  }
  function rowHtml(r) {
    const band = r.band || "cold", sc = r.score;
    const sigs = r.signals.map((s) => `<span class="badge ${SIG_CLASS[s.type] || ""}" title="${esc(s.message)}${s.venues.length ? " · " + esc(s.venues.map((v) => EX_NAMES[v] || v).join(", ")) : ""}">${esc(s.label)}${s.venues.length > 1 ? ` ×${s.venues.length}` : ""}</span>`).join("");
    const exs = (r.exchanges || []).map((x) => (x === r.lead ? `<b>${esc(EX_NAMES[x] || x)}</b>` : esc(EX_NAMES[x] || x))).join(" · ");
    const im = r.imbalance;
    return `<tr><td><button class="coin-link sym" data-coin="${esc(r.coin)}" title="Show ${esc(r.coin)}USDT's Binance order book">${esc(r.coin)}</button><span class="sub">${r.lead ? "hottest on " + esc(EX_NAMES[r.lead] || r.lead) : ""}</span></td>
<td>${sc == null ? "—" : `<span class="score"><span class="badge lq-b-${band}">${sc}</span><span class="scorebar"><i class="${band}" style="width:${Math.max(3, sc)}%"></i></span></span><span class="sub">${band}</span>`}</td>
<td>${sigs ? `<div class="lq-sigs">${sigs}</div>` : '<span class="muted">—</span>'}</td>
<td class="mono">${px(r.price)}<span class="sub">${pct(r.change24h)}</span></td>
<td class="mono">${pct(r.change5m)}<span class="sub">1h ${pct(r.change1h)}</span></td>
<td class="mono">${money(r.volumeUsd)}<span class="sub">${(r.exchanges || []).length} exchange${(r.exchanges || []).length === 1 ? "" : "s"}</span></td>
<td class="mono">${r.spreadPct == null ? "—" : r.spreadPct.toFixed(3) + "%"}<span class="sub">${im == null ? "" : `book ${im > 0 ? '<span class="green">' + Math.round(im * 100) + "% bids</span>" : im < 0 ? '<span class="red">' + Math.round(-im * 100) + "% asks</span>" : "even"}`}</span></td>
<td><span class="lq-ex">${exs}</span><span class="sub">${r.priceGapPct == null ? "" : "gap " + r.priceGapPct.toFixed(2) + "%"}</span></td></tr>`;
  }
  function drawHealth() {
    const el = $("#lqHealth"); if (!el || !data) return;
    const pill = (st) => (st === "ok" ? "green" : st === "error" ? "red" : "amber");
    const ex = (data.exchanges || []).map((x) => `<div class="source-row"><span>${esc(x.name)} spot<span class="sub">${x.listed ? `${x.listed} coins listed · ${x.coins} followed · full check on ${x.deep}/${x.top}` : "loading the coin list…"}${x.cycleMs != null ? ` · last read ${(x.cycleMs / 1000).toFixed(1)} s` : ""}${x.error ? ` · ${esc(x.error)}` : ""}</span></span>
<b class="status-pill ${pill(x.status)}" style="white-space:normal">${x.status === "ok" ? "OK · " + hhmm(x.updatedAt, true) : x.pausedUntil && x.pausedUntil > Date.now() ? "Paused until " + hhmm(x.pausedUntil) : esc(x.status)}</b></div>`).join("");
    const h = data.heatmap || {};
    const feed = `<div class="source-row"><span>Heatmap feed (Binance ${esc(h.symbol || "")})<span class="sub">${h.mode === "websocket" ? "live diff-depth + trade streams" : h.mode === "rest" ? "REST polling every 2 s (no WebSocket)" : esc(h.mode || "—")} · ${h.samples || 0} samples (${Math.round((h.historyMs || 0) / 60000)} min) · ${h.resyncs || 0} resyncs${h.lastError ? " · " + esc(h.lastError) : ""}</span></span>
<b class="status-pill ${h.mode === "websocket" && !h.needsResync ? "green" : h.mode === "rest" ? "amber" : h.mode === "stopped" ? "" : "amber"}">${h.mode === "websocket" ? (h.needsResync ? "Rebuilding book" : "Live") : esc(h.mode || "—")}</b></div>`;
    el.innerHTML = ex + feed;
  }

  // ---------------------------------------------------------------- heatmap
  async function loadHeatmap(force) {
    if (hmBusy || (!force && document.hidden)) return; hmBusy = true;
    try { hm = await getJson(`/api/liquidity/heatmap?lookback=${ui.lookback}`); queueDraw(); }
    catch (e) { message("Heatmap: " + e.message, true); }
    finally { hmBusy = false; }
  }
  function queueDraw() { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => { drawQueued = false; drawHeatmap(); }); }
  function sizeCanvas(cv) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(200, cv.clientWidth), h = Math.max(60, cv.clientHeight);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  function drawHeatmap() {
    if (!root || !running) return;
    const h = hm, st = h?.status || {};
    $("#lqSym").textContent = h?.symbol || "—";
    $("#lqFeedChip").innerHTML = `<span class="dot${st.mode === "websocket" && !st.needsResync ? "" : " bad"}"></span>${st.mode === "websocket" ? (st.needsResync ? "rebuilding book" : "live") : st.mode === "rest" ? "REST polling" : esc(st.mode || "connecting")}${st.samples ? ` · ${Math.round((st.historyMs || 0) / 60000)} min history` : ""}`;
    drawBook(h?.book, h);
    const main = sizeCanvas($("#lqCanvas")), vol = sizeCanvas($("#lqVolCanvas"));
    const muted = css("--muted", "#8fa0b4"), ink = css("--ink", "#eef4fa"), line = css("--line", "#253243");
    const prices = h?.prices || [], times = h?.times || [];
    if (!h || !prices.length || !times.length) {
      main.ctx.fillStyle = muted; main.ctx.font = "12px Manrope, system-ui, sans-serif";
      main.ctx.fillText(h?.warning || "Loading…", 14, 24); cfgNow = null; $("#lqBin").textContent = ""; return;
    }
    const plot = getPlotArea(main.w), bucket = h.bucketMs, unit = h.unit || 1;
    const cfg = cfgNow = {
      priceScale: { priceMin: h.priceMin, priceMax: h.priceMax, yTop: 4, yBottom: main.h - BOTTOM_TIME_AXIS_PX },
      timeScale: { timeMin: times[0], timeMax: times[times.length - 1] + bucket, xLeft: plot.xLeft, xRight: plot.xRight },
      binWidth: h.binWidth, timeBucketMs: bucket, candleMs: bucket,
      colorOpts: { intensityMultiplier: 1.6, logScale: true, sideMode: ui.side },
      density: ui.preset === "classic" ? undefined : DENSITY_PRESETS[ui.preset] || DENSITY_PRESETS.deep, densitySide: ui.side,
    };
    const cells = [];
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
    const candles = V ? times.map((t, c) => (V.o[c] == null ? null : { t, open: V.o[c], high: V.h[c], low: V.l[c], close: V.c[c], volume: V.buy[c] + V.sell[c] })).filter(Boolean) : [];
    if (ui.candles && candles.length) renderCandles(main.ctx, candles, cfg);
    else if (h.mids?.some((m) => m)) { // without candles: the mid price through time
      main.ctx.save(); main.ctx.strokeStyle = ink; main.ctx.globalAlpha = 0.8; main.ctx.lineWidth = 1.2; main.ctx.beginPath();
      let on = false;
      h.mids.forEach((m, c) => { if (!m) return; const x = timeToX(times[c] + bucket / 2, cfg.timeScale), y = priceToY(m, cfg.priceScale); if (on) main.ctx.lineTo(x, y); else { main.ctx.moveTo(x, y); on = true; } });
      main.ctx.stroke(); main.ctx.restore();
    }
    renderPriceLine(main.ctx, h.book?.mid, cfg, alpha(ink, 0.6));
    drawCollectionStart(main.ctx, cfg, h.collectionStartedAt);
    drawAxes(main.ctx, cfg, main.h, muted, h.lookbackMin <= 15);
    // volume / delta under the chart, the same x geometry
    const layout = { xLeft: plot.xLeft, xRight: plot.xRight, yTop: 6, yBottom: vol.h - 6 };
    const vts = { ...cfg.timeScale };
    const buckets = V ? times.map((t, c) => ({ t, delta: V.delta[c], cumulativeDelta: V.cum[c], n: V.trades[c] })).filter((b) => b.n > 0) : [];
    if (ui.vol === "delta" && buckets.length >= 2) {
      renderBars(vol.ctx, buildDeltaBars(buckets, vts, layout, bucket), layout, layout.yTop + (layout.yBottom - layout.yTop) / 2, line);
      renderCumDelta(vol.ctx, buckets, vts, layout, bucket, alpha(ink, 0.7));
    } else renderBars(vol.ctx, buildVolumeBars(candles, vts, layout, bucket), layout, layout.yBottom, line);
    vol.ctx.fillStyle = muted; vol.ctx.font = "10px Manrope, system-ui, sans-serif";
    const vmax = ui.vol === "delta" && buckets.length >= 2 ? Math.max(...buckets.map((b) => Math.abs(b.delta))) : Math.max(0, ...candles.map((c) => c.volume));
    vol.ctx.fillText(`${ui.vol === "delta" && buckets.length >= 2 ? "delta ±" : "vol "}${money(vmax)}`, plot.xRight + 4, 14);
    $("#lqBin").textContent = `each row ${px(h.binWidth)} · each column ${bucket / 1000} s${h.note ? " · " + h.note : ""}`;
    $("#lqHmSub").textContent = `Resting buy orders (teal) and sell orders (pink) on Binance by price, over the last ${h.lookbackMin >= 60 ? h.lookbackMin / 60 + " h" : h.lookbackMin + " min"}. Bright = big orders. Candles = trades in each ${bucket / 1000}-second slice.`;
  }
  function tooltip(e) {
    const tip = $("#lqTip"), h = hm, cfg = cfgNow;
    if (!h || !cfg || !h.prices?.length) { tip.hidden = true; return; }
    const rect = e.currentTarget.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top, { timeScale: ts, priceScale: ps } = cfg;
    if (x < ts.xLeft || x > ts.xRight || y < ps.yTop || y > ps.yBottom) { tip.hidden = true; return; }
    const c = Math.min(h.times.length - 1, Math.floor(((x - ts.xLeft) / (ts.xRight - ts.xLeft)) * h.times.length));
    const r = Math.floor((yToPrice(y, ps) - h.prices[0]) / h.binWidth);
    if (r < 0 || r >= h.prices.length) { tip.hidden = true; return; }
    const b = (h.bids[c]?.[r] || 0) * h.unit, a = (h.asks[c]?.[r] || 0) * h.unit, V = h.volume;
    tip.innerHTML = `<b>${hhmm(h.times[c], true)}</b> · ${px(h.prices[r])} – ${px(h.prices[r] + h.binWidth)}<br>Buy orders <span class="green">${money(b)}</span> · sell orders <span class="red">${money(a)}</span>` +
      (V && V.trades[c] ? `<br>Traded: bought ${money(V.buy[c])} · sold ${money(V.sell[c])}` : "");
    tip.hidden = false;
    const w = tip.offsetWidth, cw = e.currentTarget.clientWidth;
    tip.style.left = Math.max(0, Math.min(cw - w, x + 14)) + "px"; tip.style.top = Math.max(0, y + 14) + "px";
  }
  // The current book (OrderBookPanel): best prices, spread, imbalance, the book grouped into the heatmap's price rows, the biggest walls.
  function drawBook(b, h) {
    const el = $("#lqBook"); if (!el) return;
    if (!b) { el.innerHTML = `<div class="empty" style="padding:20px">${esc(h?.status?.needsResync ? "Rebuilding the order book…" : h?.status?.lastError || "Connecting to the order book…")}</div>`; return; }
    const g = b.grouped, asks = (g?.asks || b.asks.map(([p, q]) => [p, p * q])).slice(0, 12), bids = (g?.bids || b.bids.map(([p, q]) => [p, p * q])).slice(0, 12);
    const max = Math.max(1, ...asks.map((x) => x[1]), ...bids.map((x) => x[1]));
    const row = (x, cls, col) => `<tr><td class="${cls}">${px(x[0])}</td><td class="v"><i style="width:${((x[1] / max) * 100).toFixed(1)}%;background:${col}"></i>${money(x[1])}</td></tr>`;
    const walls = (list, cls) => (list || []).map((w) => `<div><span class="${cls}">${px(w[0])}</span> · ${money(w[1])}</div>`).join("") || '<div class="muted">—</div>';
    el.innerHTML = `<h3>Order book <span class="chip" style="padding:4px 8px;font-size:11px">${esc(h.symbol)}</span></h3>
<div class="lq-stats"><div><span>Best bid</span><b class="green">${px(b.bestBid)}</b></div><div><span>Best ask</span><b class="red">${px(b.bestAsk)}</b></div>
<div><span>Spread</span><b>${b.spreadPct != null ? b.spreadPct.toFixed(4) + "%" : "—"}</b></div><div><span>Imbalance (top 20)</span><b class="${b.imbalance > 0 ? "green" : b.imbalance < 0 ? "red" : ""}">${b.imbalance != null ? (b.imbalance > 0 ? "+" : "") + (b.imbalance * 100).toFixed(1) + "%" : "—"}</b></div></div>
<table class="lq-ob" aria-label="Order book grouped by price">${asks.slice().reverse().map((x) => row(x, "red", "var(--red)")).join("")}
<tr class="mid"><td colspan="2">${px(b.mid)}${g ? ` · rows of ${px(g.binWidth)}` : ""}</td></tr>${bids.map((x) => row(x, "green", "var(--green)")).join("")}</table>
<div class="lq-walls"><div><div class="sub">Biggest buy walls</div>${walls(b.walls?.bids, "green")}</div><div><div class="sub">Biggest sell walls</div>${walls(b.walls?.asks, "red")}</div></div>`;
  }

  const onResize = () => queueDraw();
  function start() {
    if (!mount() || running) return;
    running = true;
    loadScreener(); loadHeatmap(true);
    timers.push(setInterval(loadScreener, 15_000), setInterval(() => loadHeatmap(false), 4_000));
    window.addEventListener("resize", onResize);
  }
  function stop() {
    running = false;
    for (const t of timers) clearInterval(t);
    timers = [];
    window.removeEventListener("resize", onResize);
    const tip = $("#lqTip"); if (tip) tip.hidden = true;
  }
  window.liquidityTab = { start, stop };
  // Build the markup right away (when the element exists) so the page's section tags can find its sections.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => mount()); else mount();
})();

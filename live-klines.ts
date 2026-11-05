// Live 5-minute candles from Binance's public WebSocket stream (no API key), for the Ignition scanner.
//
// Why: the scanner used to poll Binance every 20 seconds plus once 4 seconds after each 5-minute close, then download
// 290 candles for every hot coin again. With the stream, every subscribed coin's candle arrives as it closes, so the
// scan starts as soon as most coins have closed (usually 1-3 seconds after the close) and reads the candles from memory.
//
// The candles are kept in Binance's REST kline format ([openTime, open, high, low, close, volume, closeTime,
// quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]), so the signal code reads them exactly as it reads the REST
// answer. A coin's candles come from one REST download first (seed); the stream then replaces the forming candle and
// appends the next one. A gap (a missed candle) drops the coin's candles, so the next scan downloads them again: the
// scanner never works on candles with a hole in them.
//
// Falls back to polling by itself: without a WebSocket (Node under 22) or while the stream is down, get() returns null
// and the scanner downloads the candles as before.

const STEP: Record<string, number> = { "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };

/** One candle in Binance's REST kline format. */
export type KlineRow = [openTime: number, open: string, high: string, low: string, close: string, volume: string, closeTime: number,
  quoteVolume: string, trades: number, takerBuyBase: string, takerBuyQuote: string, ignore: string];
/** The part of a WebSocket the stream uses (Node's global WebSocket, or a fake in the tests). */
interface KlineSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen?: (ev?: Event) => void;
  onmessage?: (ev: { data: unknown }) => void;
  onerror?: (ev: Event & { message?: string }) => void;
  onclose?: (ev?: Event) => void;
}
/** A candle closed: how many of the followed coins have closed at this boundary so far. */
export interface CandleClose { sym: string; boundary: number; closed: number; of: number }
export interface LiveKlinesOptions {
  url?: string;
  interval?: string;
  keep?: number;
  WS?: new (url: string) => KlineSocket;
  now?: () => number;
  onClose?: (e: CandleClose) => void;
  log?: (m: string) => void;
}

// One stream message ({ stream, data: { e: "kline", s, k } }) -> [symbol, REST-format row, closed?]
export function klineRow(msg: any): [sym: string, row: KlineRow, closed: boolean] | null {
  const d = msg?.data ?? msg, k = d?.k;
  if (d?.e !== "kline" || !k) return null;
  return [String(k.s), [Number(k.t), k.o, k.h, k.l, k.c, k.v, Number(k.T), k.q, Number(k.n), k.V, k.Q, "0"], k.x === true];
}

export function createLiveKlines({ url = "wss://stream.binance.com:9443/stream", interval = "5m", keep = 290, WS = globalThis.WebSocket,
  now = () => Date.now(), onClose = () => {}, log = (m) => console.log(m) }: LiveKlinesOptions = {}) {
  const step = STEP[interval] ?? 300_000;
  const bars = new Map<string, KlineRow[]>(); // SYMBOL -> rows, oldest first
  const wanted = new Set<string>();           // symbols we want (upper case, e.g. "SOLUSDT")
  const live = new Set<string>();             // symbols subscribed on the open connection
  const st = { on: typeof WS === "function", connected: false, since: null as number | null, lastMsgAt: null as number | null, closes: 0, reconnects: 0,
    error: null as string | null, lastBoundary: null as number | null, closedAtBoundary: 0 };
  let ws: KlineSocket | null = null, retry = 1000, id = 1, queue: { method: string; params: string[]; id: number }[] = [], stopped = false;
  let sender: ReturnType<typeof setInterval> | null = null, timer: ReturnType<typeof setTimeout> | null = null;

  // Binance allows 5 incoming messages a second per connection: (un)subscribe in chunks of 100, 4 messages a second.
  function send(method: string, params: string[]) { for (let i = 0; i < params.length; i += 100) queue.push({ method, params: params.slice(i, i + 100), id: id++ }); pump(); }
  function pump() {
    if (sender || !queue.length) return;
    sender = setInterval(() => {
      if (!ws || ws.readyState !== 1 || !queue.length) { clearInterval(sender); sender = null; return; }
      try { ws.send(JSON.stringify(queue.shift())); } catch { /* the close handler reconnects */ }
    }, 250);
    sender.unref?.();
  }
  const stream = (sym: string) => `${sym.toLowerCase()}@kline_${interval}`;
  function sync() {
    if (!ws || ws.readyState !== 1) return;
    const add = [...wanted].filter((s) => !live.has(s)), drop = [...live].filter((s) => !wanted.has(s));
    if (add.length) { send("SUBSCRIBE", add.map(stream)); add.forEach((s) => live.add(s)); }
    if (drop.length) { send("UNSUBSCRIBE", drop.map(stream)); drop.forEach((s) => { live.delete(s); bars.delete(s); }); }
  }
  function connect() {
    if (!st.on || stopped) return;
    try { ws = new WS(url); } catch (e) { st.error = e.message; schedule(); return; }
    ws.onopen = () => { st.connected = true; st.since = now(); st.error = null; retry = 1000; live.clear(); queue = []; sync(); };
    ws.onmessage = (ev) => {
      st.lastMsgAt = now();
      let msg; try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
      const r = klineRow(msg);
      if (r) take(...r);
    };
    ws.onerror = (e) => { st.error = e?.message || "stream error"; };
    ws.onclose = () => { st.connected = false; live.clear(); schedule(); };
  }
  function schedule() {
    if (stopped) return;
    st.reconnects++;
    clearTimeout(timer);
    timer = setTimeout(connect, retry); timer.unref?.();
    retry = Math.min(retry * 2, 60_000);
  }
  function take(sym: string, row: KlineRow, closed: boolean) {
    const rows = bars.get(sym);
    if (rows?.length) {
      const last = rows[rows.length - 1][0];
      if (row[0] === last) rows[rows.length - 1] = row;
      else if (row[0] === last + step) { rows.push(row); if (rows.length > keep) rows.splice(0, rows.length - keep); }
      else if (row[0] > last) bars.delete(sym); // a gap: download again on the next scan
    }
    if (!closed) return;
    st.closes++;
    const boundary = row[0] + step;
    if (st.lastBoundary !== boundary) { st.lastBoundary = boundary; st.closedAtBoundary = 0; }
    st.closedAtBoundary++;
    onClose({ sym, boundary, closed: st.closedAtBoundary, of: live.size });
  }

  return {
    // The coins to follow (e.g. "SOLUSDT"). Coins left out are dropped.
    want(symbols: Iterable<string>) { wanted.clear(); for (const s of symbols) wanted.add(String(s).toUpperCase()); if (!ws && st.on && !stopped) connect(); else sync(); },
    // REST rows for a coin (the last one may still be forming).
    seed(sym: string, rows: KlineRow[]) { if (st.connected && wanted.has(sym) && Array.isArray(rows) && rows.length) bars.set(sym, rows.slice(-keep)); },
    // The coin's rows when they reach the newest finished candle with no gap, else null (download them instead).
    get(sym: string): KlineRow[] | null {
      const rows = bars.get(sym);
      if (!st.connected || !rows?.length) return null;
      const lastClosed = Math.floor(now() / step) * step - step;
      return rows.some((r) => r[0] === lastClosed) ? rows : null;
    },
    status: () => ({ ...st, wanted: wanted.size, subscribed: live.size, cached: bars.size }),
    stop() { stopped = true; clearTimeout(timer); clearInterval(sender); try { ws?.close(); } catch { /* closed */ } },
  };
}

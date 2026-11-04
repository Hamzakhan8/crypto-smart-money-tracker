// The Liquidity tab's data (liquidity.js: GET /api/liquidity, GET /api/liquidity/heatmap, POST /api/liquidity/symbol),
// its names and labels, and the number formats it uses. money() and px() are this tab's own formats (no cents under
// $1K, prices without a $ sign), kept as the classic tab has them so the numbers read the same.

/** [price, quantity or dollars] */
export type Level = [number, number];

/** The heatmap feed's status (createDepthFeed().status() in liquidity.js). */
export interface HeatStatus {
  symbol?: string; mode?: string; connected?: boolean; needsResync?: boolean; samples?: number; historyMs?: number;
  resyncs?: number; lastError?: string | null;
}
/** The current book (bookView()): best prices, the book grouped into the heatmap's price rows, the biggest walls. */
export interface BookView {
  bestBid: number; bestAsk: number; mid: number; spread: number; spreadPct: number | null; imbalance: number | null; bids: Level[]; asks: Level[];
  grouped?: { binWidth: number; bids: Level[]; asks: Level[] }; walls?: { bids: Level[]; asks: Level[] };
}
/** Trades per time column. */
export interface VolumeData {
  buy: number[]; sell: number[]; delta: number[]; cum: number[]; trades: number[];
  o: (number | null)[]; h: (number | null)[]; l: (number | null)[]; c: (number | null)[];
}
/** GET /api/liquidity/heatmap?lookback= (bids / asks are whole numbers of `unit` dollars). */
export interface Heatmap {
  symbol: string; exchange?: string; lookbackMin: number; bucketMs: number; binWidth: number; times: number[];
  status?: HeatStatus; book?: BookView | null; updatedAt?: number;
  prices: number[]; bids: number[][]; asks: number[][]; unit: number; mids?: (number | null)[]; volume?: VolumeData | null;
  priceMin: number; priceMax: number; collectionStartedAt?: number | null; warning?: string; note?: string;
}

export interface LiqSignal { type: string; label: string; venues: string[]; score?: number; message: string }
/** One exchange's market of a coin. */
export interface Venue {
  ex: string; sym?: string; deep: boolean; score: number | null; band: string | null; price: number; change24h: number | null;
  change5m: number | null; change1h: number | null; volumeUsd: number; spreadPct: number | null; imbalance: number | null;
  signals: { type: string; score?: number; message: string }[];
}
/** One coin of the screener (its hottest exchange's numbers; volume summed). */
export interface LiqRow {
  coin: string; score: number | null; band: string | null; lead: string | null; exchanges: string[]; price: number;
  change24h: number | null; change5m: number | null; change1h: number | null; volumeUsd: number; spreadPct: number | null;
  imbalance: number | null; priceGapPct: number | null; signals: LiqSignal[]; venues: Venue[];
}
export interface LiqExchange {
  id: string; name: string; status: string; error: string | null; updatedAt: number | null; cycleMs: number | null; pausedUntil: number | null;
  listed: number; coins: number; top: number; deep: number;
}
/** GET /api/liquidity */
export interface LiquidityApi {
  status?: string; error?: string | null; updatedAt?: number | null; refreshMs?: number; perExchange?: number;
  rows?: LiqRow[]; exchanges?: LiqExchange[]; heatmap?: HeatStatus;
}

export const EX_NAMES: Record<string, string> = { binance: "Binance", bybit: "Bybit", okx: "OKX", coinbase: "Coinbase", kraken: "Kraken" };
export const SIGNALS: [string, string][] = [["VOLUME_SPIKE", "Volume spike"], ["PRICE_PUMP", "Pump"], ["PRICE_DUMP", "Dump"], ["VOLATILITY_EXPANSION", "Volatility"],
  ["SPREAD_WIDENING", "Wide spread"], ["ORDER_BOOK_IMBALANCE", "Book imbalance"], ["BREAKOUT", "Breakout"], ["HOT_MARKET", "Hot market"]];
export const SIG_CLASS: Record<string, string> = { PRICE_PUMP: "strong", PRICE_DUMP: "risk", HOT_MARKET: "watch", VOLUME_SPIKE: "lq-blue", BREAKOUT: "lq-blue" };
export const exName = (x: string): string => EX_NAMES[x] || x;

type N = number | null | undefined;
export const money = (v: N): string => (v == null || !Number.isFinite(Number(v)) ? "—" : v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M"
  : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + Number(v).toFixed(0));
export const px = (v: N): string => (v == null || !(v > 0) ? "—" : v >= 1000 ? Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 }) : v >= 1 ? Number(v).toFixed(4) : Number(v).toPrecision(4));
export const hhmm = (t: N, sec?: boolean): string => new Date(Number(t)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}) });

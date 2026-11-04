// Typed access to the engine's API (the routes in server.js and screener.js). Same origin: the React pages and the API
// are served by one server.

export interface FlowCoin {
  symbol: string; price: number; change24h: number | null; volume24h: number; trades1m: number;
  buyRatio5m: number; netFlow5m: number; change5m: number; relativeVolume: number | null;
  score: number; label: string; reasons: string[];
}
export interface Web3Signal {
  id: string; chain: string; ticker: string; address: string; direction: "buy" | "sell" | "unknown";
  wallets: number | null; exitRate: number | null; time: number | null;
}
export interface FlowEvent { id: string; symbol: string; label: string; message: string; time: number }
/** GET /api/signals: the Market Flow Radar. */
export interface SignalsResponse {
  lastUpdated: number | null; pollIntervalMs: number; demo: boolean; marketStatus: string; web3Status: string;
  errors: Record<string, string>; coins: FlowCoin[]; web3Signals: Web3Signal[]; events: FlowEvent[];
  aiVerdicts?: Record<string, { decision: string }>; telegramConfigured: boolean;
}
/** GET /api/orderbook?symbol= */
export interface OrderBook { symbol: string; bids: [string, string][]; asks: [string, string][]; source: string; demo: boolean; updatedAt: number }
/** POST /api/analyze */
export interface AnalyzeResponse {
  analysis?: string;
  meta?: { mode?: string; models?: Record<string, string>; cached?: boolean; durationMs?: number; dataAgeSec?: number; toolCalls?: { tool?: string; args?: { symbol?: string }; ok?: boolean }[] };
  telegram?: { sent?: boolean; skipped?: string; queued?: boolean; error?: string };
}
/** GET /api/ai/candidates (only the part the pages use) */
export interface AiDeskInfo { configured: boolean; models: { analyst: string; reviewer: string } }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function read<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error || `HTTP ${res.status}`, res.status);
  return body as T;
}
export const getJson = <T>(path: string, init?: RequestInit): Promise<T> => fetch(path, { cache: "no-store", ...init }).then(read<T>);
/** POST with a JSON body (the engine only accepts paid / changing requests from this site with a JSON content type). */
export const postJson = <T>(path: string, body: unknown, init?: RequestInit): Promise<T> =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...init }).then(read<T>);

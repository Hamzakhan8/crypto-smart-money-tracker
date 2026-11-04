// Pieces the Early 2x tab's parts share: the /api/early2x answer, state names, the confirmation family names.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** One Early 2x candidate (the JSON has more fields; they are read exactly as the classic page read them). */
export type X2Candidate = { symbol: string; base: string; state?: string; priority?: string | null; score: number; [k: string]: any };
/** GET /api/early2x */
export interface Early2xData {
  status?: string; lastScanAt?: number | null; lastScanMs?: number | null; errors?: Record<string, string>; demo?: boolean;
  universe?: { pairs?: number; evaluated?: number; excluded?: Record<string, number>; tooNew?: number; [k: string]: any };
  regime?: { btc24: number; btc4h: number; btc7d: number; deteriorating?: boolean; [k: string]: any } | null;
  tabs?: Record<string, X2Candidate[]>; sources?: Record<string, any>; results?: any; config?: { scanMinutes?: number; [k: string]: any };
  recent?: any[]; signalCount?: number | null; telegramOn?: boolean;
  [k: string]: any;
}

export const XSTATE: Record<string, [string, string]> = { quiet: ["Quiet accumulation", "watch"], prebreakout: ["Pre-breakout", "watch"], ignition: ["Early ignition", "strong"], moved: ["Already moved", "risk"] };
export const xn = (v: number | null | undefined, d = 2, s = "×") => (v == null ? "—" : Number(v).toFixed(d) + s);
export const xfam: Record<string, string> = { activity: "activity", buying: "buying", structure: "structure", orderbook: "order book", strength: "vs BTC" };

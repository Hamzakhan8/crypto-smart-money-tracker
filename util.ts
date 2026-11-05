// Small helpers the engine shares. Each one used to be copied into many files (r2 into 19 of them).
import { writeFile, rename } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

/** A number setting from .env (key), or the default when it is missing or not a number. */
export const num = (k: string, d: number): number => {
  const v = process.env[k];
  return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d;
};
/** v rounded to d decimals, or null when it is not a number. */
export const r2 = (v: number | null | undefined, d = 2): number | null => (Number.isFinite(v) ? Number((v as number).toFixed(d)) : null);
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
/** A price for messages and logs: 1 decimal from 1000, 4 from 1, 4 significant digits below; "—" for none. */
export const fmtPx = (v: number | null | undefined): string => (!(v > 0) ? "—" : v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));
/** Runs fn on every item, at most n at a time. */
export async function pool<T>(items: T[], n: number, fn: (item: T, index: number) => unknown): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
/** Writes a file safely: to file.tmp first, then renamed over the file, so a crash mid-write never leaves half a file. */
export const writeAtomic = (file: string, text: string): Promise<void> => writeFile(file + ".tmp", text).then(() => rename(file + ".tmp", file));
/** A JSON answer that is never cached. */
export function jsonResponse(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
/** A request that changes something or costs money must come from this site: a JSON body, and no Origin of another site. */
export const fromThisSite = (req: IncomingMessage): boolean =>
  String(req.headers["content-type"] || "").includes("application/json") && (!req.headers.origin || req.headers.origin.replace(/^https?:\/\//, "") === req.headers.host);

// Types for what server.js (the classic engine) exports to next-server.ts.
import type { IncomingMessage, ServerResponse } from "node:http";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
/** Answers every /api route and the classic pages; `fallback` gets the rest, `skip` = page paths the React app owns. */
export function createHandler(opts?: { fallback?: Handler; skip?: Set<string> }): Handler;
/** Starts the scanners, the AI desk, news, the status bar and the Market Flow poll. */
export function startServices(base?: string): void;
export const listenOn: { PORT: number; HOST: string; base: string };
export function onListenError(e: NodeJS.ErrnoException): void;

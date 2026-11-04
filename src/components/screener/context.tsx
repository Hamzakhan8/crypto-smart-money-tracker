"use client";
// What every screener tab can use from the page around it (ScreenerShell): the current tab and section tag, the
// screener data (/api/screener, polled every 3 s on every tab for the alert popups), the AI verdicts, the setup detail
// window, the "I took it" journal hand-over and the popups.
import { createContext, useContext, type ReactNode } from "react";
import type { TabKey } from "./tabs";

/* eslint-disable @typescript-eslint/no-explicit-any */
// A screener candidate (one coin of /api/screener's candidates). The JSON has many more fields than are listed here.
export interface Candidate {
  symbol: string; base: string; name?: string; rank?: number | null; price?: number; score: number; label: string;
  ignition?: "ignited" | "heating" | "ran" | null; bigmove?: string | null; moved?: boolean; movedWhy?: string[]; reasons?: string[];
  [k: string]: any;
}
// An alert (one of /api/screener's events).
export interface AlertEvent {
  id: string; time: number; tier: "ignition" | "early" | "bigmove" | "setup" | string; symbol: string; score: number; message?: string; v?: number;
  detail?: Candidate; track?: any; ai?: any; gate?: any; quality?: any; quiet?: boolean; quietWhy?: string; aplus?: boolean;
  [k: string]: any;
}
// GET /api/screener
export interface ScreenerData {
  status?: string; errors?: Record<string, string>; events?: AlertEvent[]; candidates?: Candidate[];
  aiVerdicts?: Record<string, { decision: string; [k: string]: any }>; telegram?: any; config?: any; stats?: any;
  [k: string]: any;
}
// What "I took it" hands to the Journal tab (the classic page's tookIt()).
export interface JournalPrefill {
  tool?: string; side?: "long" | "short"; symbol?: string; price?: number | null; alertPrice?: number | null;
  stop?: number | null; target?: number | null; alertId?: string | null; alphaId?: string | null;
}
// A popup (bottom right): `className` picks its colour (e.g. "test", "deposit", "whale"), `onClick` runs when it is clicked.
export interface ToastInput {
  tag: string; title: ReactNode; lines?: ReactNode[]; className?: string; onClick?: () => void; ttlMs?: number;
  notify?: { title: string; body: string }; // also a desktop notification (when allowed) and the tab title
}

export interface ScreenerCtx {
  tab: TabKey; setTab: (t: TabKey, sec?: string) => void;
  sec: string; show: (ids: string) => boolean; // show("watch") / show("a b"): is that section shown under the current tag?
  data: ScreenerData | null; dataError: string | null; reload: () => void;
  aiTake: (key: string) => boolean; // the AI said TAKE on this coin in the last 2 hours (key = spot base, or "A:" + Alpha id)
  openDetail: (c: Candidate | undefined | null, eyebrow?: string) => void;
  openJournal: (p: JournalPrefill) => void;
  takeJournalPrefill: () => JournalPrefill | null; // the Journal tab takes the pending "I took it" once
  toast: (t: ToastInput) => void;
}
export const ScreenerContext = createContext<ScreenerCtx | null>(null);
export function useScreener(): ScreenerCtx {
  const c = useContext(ScreenerContext);
  if (!c) throw new Error("useScreener() outside the screener page");
  return c;
}
// Renders its children only when that section is shown under the current tag (ids: one or more, space separated).
export function Sec({ id, children }: { id: string; children: ReactNode }) {
  return useScreener().show(id) ? <>{children}</> : null;
}

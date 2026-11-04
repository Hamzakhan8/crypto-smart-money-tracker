// Types for the AI trade desk's API (ai-trade.js, handleAiRequest: the routes under /api/ai/*) and the streamed
// committee analysis. Model-written fields are plain text: the page renders them as React text, never as HTML.
type N = number | null | undefined;

export type Decision = "TAKE" | "WAIT" | "SKIP";
export type Verdict = "YES" | "WATCH" | "NO";

// ───────────── GET /api/ai/candidates ─────────────
/** One coin the ignition screener flagged (igniting, heating up or already ran). */
export interface AiCoin {
  symbol: string; base: string; state: "ignited" | "heating" | "ran"; tier: "confirmed" | "early" | null;
  igScore?: N; score?: N; price?: N; change24h?: N; ret10m?: N; r5?: N; prevR5?: N; rvol15?: N; buy10?: N; rsi?: N;
  moved?: unknown; missing?: string[]; movedWhy?: string[] | null; narrative?: string | null;
  /** The latest AI answer on this coin (the desk, or an automatic alert review). */
  last: { decision: string; confidence: string | null; at: number } | null;
}
export interface ReplayRate { signals?: number; hitTargetPct?: N; hitStopPct?: N; flatPct?: N; avgNetPct?: N }
export interface LiveRate { resolved?: number; profitablePct?: N; winRatePct?: N }
export interface CandidatesResponse {
  configured: boolean; demo: boolean; screenerStatus?: string | null; telegramConfigured: boolean;
  /** The AI's own models (Gemini, or a free open model): the analyst is the default, the reviewer the Final Boss. */
  models?: { analyst: string; reviewer: string };
  market?: { btcChange24hPct?: N; btc1hPct?: N; btc4hPct?: N; marketWide?: boolean };
  baseRates?: { replay?: { source?: string; rule?: string; confirmed?: ReplayRate; early?: ReplayRate } | null; live?: Record<string, LiveRate | null | undefined> | null };
  coins?: AiCoin[];
}

// ───────────── GET /api/ai/dossier?symbol= (also result.dossier) ─────────────
export interface Trend { state: string; priceVsEma20Pct?: N; priceVsEma50Pct?: N }
/** The facts the committee works from (only the fields the page shows are typed; the JSON view shows all of it). */
export interface Dossier {
  symbol?: string; price?: N;
  alert?: { tier?: string; label?: string; anchorProbTargetPct?: N; anchorProbStopPct?: N; anchorFrom?: string; trackedAs?: { targetPct?: N; stopPct?: N; holdHours?: N } };
  screener?: { state?: string; tier?: string | null; ignitionScore?: N } | null;
  chart?: { trend1h?: Trend | null; trend4h?: Trend | null; atrPct?: Record<string, N> };
  levels?: { resistance?: N; resistanceIs?: string | null; roomToResistancePct?: N; support?: N; supportIs?: string | null; distanceToSupportPct?: N };
  orderBook?: { bands?: { withinPct: number; imbalance: number }[]; spreadBps?: N; liquidityCheck?: { passes?: boolean | null; bidsWithin1PctUsd?: N; note?: string | null } };
  exchangeTags?: { monitoring?: boolean; seed?: boolean };
  futures?: { available?: boolean; reason?: string; fundingPctPer8h?: N; oiChange24hPct?: N; longShortAccountRatio?: N; takerBuySellRatio30m?: N };
  whales?: { tracked?: boolean; reason?: string; transfers24h?: N; netToExchanges24h?: N };
  dexFlows?: { tracked?: boolean; reason?: string; last24h?: { netUsd?: N; swaps?: N } };
  market?: { btc4hPct?: N; btcRegime?: string | null; takerFlowBreadth?: { coins: number; buyDominant5m: number; sellDominant5m: number } | null };
  marketFlow?: {
    available?: boolean; reason?: string; flowScore?: N; label?: string; buyRatio5mPct?: N; netFlow5mUsd?: N;
    smartMoneyWallets?: { matchingSignals?: { direction: string; wallets?: N }[] };
  };
  [key: string]: unknown;
}

// ───────────── POST /api/ai/analyze (stream: true) ─────────────
/** One line of the streamed answer: a committee member's progress, a ping, then the result or an error. */
export type StepStatus = "working" | "done" | "failed" | "skipped";
export interface StepEvent { type: "step"; id: string; status: StepStatus; detail?: string; at?: number }
export type StreamLine = StepEvent | { type: "ping"; at: number } | { type: "result"; data: unknown } | { type: "error"; error: string };

export interface TelegramResult { sent?: boolean; skipped?: string; queued?: boolean; error?: string }
export interface Plan {
  entryLow?: N; entryHigh?: N; stop?: N; stopPct?: N; stopAt?: { what: string; price: N } | null;
  target1?: N; target1Pct?: N; target2?: N; rewardRisk?: N; holdHours?: N;
}
export interface PriceTrigger { event: "breakout" | "pullback"; price: N; timeframe: string; expiresMinutes: N; distPct?: N }
export interface DataReport {
  available?: boolean; error?: string; summary?: string; keyNumbers?: string[]; redFlags?: string[]; conflicts?: string[];
  dataQuality?: { rating?: "good" | "partial" | "poor"; issues?: { field: string; problem: string }[] };
  areas?: { area: string; reading: string; note: string; evidence?: string[] }[];
}
export interface NewsReport {
  available?: boolean; off?: boolean; error?: string; status?: string; requests?: number; summary?: string; riskLevel?: string;
  searchedBy?: string[]; cached?: boolean; at?: number; hardStop?: boolean; hardStopReason?: string;
  evidence?: { fields?: string[]; toolTokens?: N; discardedItems?: N; droppedItems?: N } | null;
  items?: { date?: string; url?: string; title?: string; impact?: string; severity?: string; pricedIn?: string; source?: string }[];
  upcoming?: { date?: string; event?: string; impact?: string }[];
  sources?: { url?: string; title?: string }[];
}
export interface DebateSide {
  available?: boolean; error?: string; strength?: N; thesis?: string; path?: string; weakestPoint?: string; wouldChangeMyMind?: string;
  points?: { point: string; evidence: string }[];
  rebuttals?: { verdict: string; bullPoint: string; evidence: string }[];
  redFlagAnswers?: { stands: boolean; flag: string; answer: string }[];
}
export interface Debate { off?: boolean; skipped?: string; verdict?: { winner: string; reason: string } | null; bull?: DebateSide; bear?: DebateSide }
export interface BossReport {
  asked?: boolean; available?: boolean; reason?: string; model?: string; fallbackFrom?: { model: string; error?: string } | null;
  verdict?: Verdict | null; summary?: string; decidingFactor?: string; confidence?: string; confidenceSaid?: string; agreesWithTrader?: boolean;
  plan?: { sizePct?: N } | null; hardStopFailures?: string[]; watchTriggers?: { condition: string; field: string; threshold: string }[]; watchExpiresHours?: N;
  corrected?: { pTargetPct?: N; pStopPct?: N; pTimeoutPct?: N; realisticTarget?: N; realisticRr?: N; expectedValuePct?: N } | null;
  auditFindings?: { severity: "high" | "medium" | "low"; issue: string; field: string; correction: string }[];
  agentQuality?: Partial<Record<"dataAnalyst" | "news" | "bull" | "bear" | "trader", string>>;
}
export interface Committee {
  data?: DataReport; news?: NewsReport; debate?: Debate; boss?: BossReport; auditHints?: string[];
  trader?: { decision?: string; model?: string; ms?: number };
}
export interface AnalysisMeta {
  model?: string; dataModel?: string | null; newsModel?: string | null; debateModel?: string | null; bossModel?: string | null;
  calls?: N; tokens?: { in?: number; out?: number; think?: number }; deepThinking?: boolean; source?: string; durationMs?: N; at?: number; cached?: boolean;
}
/** The committee's answer on one coin. */
export interface Analysis {
  symbol: string; kind?: string; decision: Decision; final?: Verdict; modelDecision?: string; confidence?: string; setupScore?: N;
  probTargetPct?: N; probStopPct?: N; expectedValuePct?: N; evCalc?: { pTimeoutPct?: N; timeoutFrom?: string; formula?: string } | null;
  realistic?: { rewardRisk?: N; hurdle?: { what: string; price: N; pct: N } | null } | null; probReason?: string;
  hardStops?: string[]; checklist?: { item: string; status: string; evidence: string }[];
  headline?: string; thesis?: string; bullishPoints?: string[]; bearishPoints?: string[]; plan?: Plan; sizePct?: N;
  waitFor?: string; watch?: { triggers: unknown[]; expiresHours?: N } | null; trigger?: PriceTrigger | null;
  invalidation?: string; keyRisk?: string; guardNotes?: string[]; fastNo?: boolean;
  committee?: Committee; dossier?: Dossier; meta?: AnalysisMeta; telegram?: TelegramResult | null;
}

// ───────────── POST /api/ai/analyze-all ─────────────
export interface BatchCoin {
  symbol: string; price?: N; tier: string | null; state: string; decision: string; modelDecision?: string; confidence?: string; setupScore?: N;
  reason?: string; keyRisk?: string; guardNotes?: string[]; probTargetPct?: N; probStopPct?: N; expectedValuePct?: N; referenceRewardRisk?: N;
}
export interface BatchResponse {
  marketView?: string; coins?: BatchCoin[]; failed?: { symbol: string; error: string }[];
  meta?: { model?: string; durationMs?: number; at?: number; cached?: boolean }; telegram?: TelegramResult | null;
}

// ───────────── GET /api/ai/record, POST /api/ai/triggers/cancel ─────────────
export interface ScoreGroup { section?: string; key?: string; label?: string; n: number; hitTargetPct?: N; hitStopPct?: N; inProfitPct?: N; avgNetPct?: N }
export interface Scorecard {
  total?: number; open?: number; resolved?: number; edgePct?: N; notYes?: ScoreGroup; groups?: ScoreGroup[];
  calibration?: { band: string; n: number; saidPct?: N; hitPct?: N }[];
}
/** One AI answer followed like a trade. */
export interface TrackedCall {
  id: string; at: number; source: string; kind: string; symbol: string; entry: number; stopPct?: N; targetPct?: N; holdHours: number;
  decision: string; final: string; trader?: string | null; boss?: string | null; bossAgrees?: boolean | null; sizePct?: N;
  debate?: { winner?: string | null } | null; news?: string | null; data?: string | null;
  track?: { status: "open" | "win" | "loss" | "timeout" | "nodata"; last?: number; netPct?: N };
}
/** A watched WAIT trigger (armed) or a past one (hit, expired, replaced, cancelled, dropped). */
export interface WatchedTrigger {
  id: string; kind: string; symbol: string; event: "breakout" | "pullback"; price: N; timeframe: string; distPct?: N;
  waitFor?: string; priceAtCall?: N; armedAt?: number; expiresAt: number; status: string; hitAt?: number | null;
  result?: { checked: boolean; decision?: string; final?: string; headline?: string; reason?: string; error?: string } | null;
}
export interface RecordResponse {
  scorecard?: Scorecard; calls?: TrackedCall[]; triggers?: { armed: WatchedTrigger[]; past: WatchedTrigger[] };
  usage?: { day?: string; requests?: number; tokens?: { in?: number; out?: number; think?: number }; limit?: number | null; left?: number | null };
}

/** POST with { stream: true }: the server sends one JSON line per committee step, then the result (or an error). */
export async function postStream<T>(path: string, body: object, onStep: (e: StepEvent) => void): Promise<T> {
  const r = await fetch(path, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j as { error?: string }).error || `HTTP ${r.status}`); }
  let result: T | null = null;
  if (r.body) {
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m: StreamLine;
        try { m = JSON.parse(line) as StreamLine; } catch { continue; }
        if (m.type === "step") onStep(m);
        else if (m.type === "result") result = m.data as T;
        else if (m.type === "error") throw new Error(m.error);
      }
    }
  }
  if (!result) throw new Error("The analysis stopped without an answer (the connection closed). Try again.");
  return result;
}

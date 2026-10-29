// The AI committee: four Gemini roles, each with one job, so no single answer carries the whole decision.
//
//   1. DATA ANALYST    reads the dossier (live facts computed by code) and reports data quality, the evidence per area,
//                      conflicts and red flags. It does not decide.
//   2. NEWS RESEARCHER searches the web (Gemini's Google Search) for news and scheduled events that could move this coin
//                      during the trade. Runs at the same time as the analyst. Sources come from Google's own grounding
//                      data, not from the model's text.
//   3. TRADER          decides TAKE / WAIT / SKIP with probabilities, expected value and a plan, from the dossier and both
//                      reports. Code then re-checks everything (hard stops, expected value, reward:risk, the plan).
//   4. FINAL BOSS      the chief risk officer, called only for a TAKE that passed the code checks: YES (take it now, as
//                      planned) or NO. A stronger model by default. It can only say no, never turn a WAIT into a TAKE.
//
// Every stage returns JSON in a fixed shape. If the analyst or the news search fails, the committee carries on and says
// so (unknown, never "fine"); if the final boss cannot answer, there is no TAKE. Prompts are written for Gemini but are
// plain text: each one names the role, the method, the rules and the exact answer shape. Not financial advice.
import { Type } from "@google/genai";
import { generate, jsonFrom, AgentError } from "./agent.js";

const strArr = { type: Type.ARRAY, items: { type: Type.STRING } };
const NEWS_TTL = 30 * 60_000;
const newsCache = new Map(); // identity key -> { at, report }

// ───────────────────────────── what each desk is ─────────────────────────────
// The trading desks the committee serves. glossary = what the dossier fields mean; areas = how the analyst groups them.
export const DESKS = {
  spot: {
    what: "a Binance spot coin flagged by a volume-ignition screener (long only, no leverage)",
    areas: ["trigger", "buying", "trend", "room", "liquidity", "positioning", "market", "track record"],
    glossary: `
- alert: the kind of alert (tier confirmed / early / bigmove / none), trackedAs (its target %, stop %, holding hours),
  anchorProbTargetPct / anchorProbStopPct (how often this kind of alert hit its target / its stop first: the base rate),
  costPct (fees + slippage per trade).
- screener: the ignition signal. state, moved (already ran: never chase), stillNeeds, ignitionScore, volume (x normal),
  buyersPct (share of volume bought aggressively), movePct, dailyRsi, spreadBps, monitoringList (Binance warning tag).
- marketFlow: aggressive buying on Binance spot in the last 1-5 minutes (flowScore, buyRatio5mPct, netFlow5mUsd). It is
  not "smart money"; smartMoneyWallets are separate on-chain wallet signals.
- chart: trend1h / trend4h, returnsPct, atrPct (a normal move per candle), priceVsVwapTodayPct, last2hOf15m.
- levels: resistance and support with their distances in %, 24h / 7d / 15d highs and lows.
- orderBook: spreadBps and depth bands (bids and asks in USD within x%, imbalance > 0 = more bids).
- futures: funding per 8h, open interest change, long/short and taker ratios (only when a perpetual exists).
- whales: large Ethereum transfers of the token and exchange deposits / withdrawals in 24h (Ethereum only).
- dexFlows: DEX buying and selling of the token (only for followed pools).
- market: BTC 1h / 4h / 24h, share of coins surging, taker-flow breadth, BTC regime and narrative ranks.
- livePerformance: live results of this tier, of past AI calls, and matchingGroups (past alerts with the same
  conditions, with older / newer halves).
- referencePlan: entries, stops, targets and reward:risk computed by code. dataQuality: demo / missing-data notes.`.trim(),
  },
  alpha: {
    what: "a Binance Alpha token: an early on-chain token traded in Binance Wallet with a thin DEX pool (long only, no leverage)",
    areas: ["trigger", "DEX buying", "trend", "room", "liquidity and holders", "supply", "market", "track record"],
    glossary: `
- alert: tier, trackedAs (target %, stop %, holding hours), anchorProbTargetPct / anchorProbStopPct (base rates), costPct.
- screener: state, tier, moved (already up too much: never chase), stillNeeds.
- alpha.token: pool liquidity (USD), holders, market cap, FDV, circulating %, days on Alpha, 24h volume.
- alpha.signal: volume vs normal and USD / trades in the last two 5-minute candles, 10-minute move, 1h and 24h change.
- alpha.dex: DEX buys vs sells over 5 minutes and buyers % over 5 minutes / 1 hour, pool liquidity. liquidityNote: how
  big a normal order is next to the pool.
- chart: trend1h / trend4h, returnsPct, atrPct. levels: resistance / support and distances, 24h / 3d / 7d highs and lows.
- market: BTC moves, alt season meter, BTC regime. No order book, no futures data for these tokens.
- livePerformance: live results by tier and matchingGroups (past Alpha alerts with the same conditions).
- referencePlan: entries, stops, targets and reward:risk computed by code.`.trim(),
  },
};

// ───────────────────────────── 1. data analyst ─────────────────────────────
export const dataAnalystPrompt = (desk) => `You are the DATA ANALYST on a four-member crypto trading committee. The trade under review: ${desk.what}.
Your only job is to read the DOSSIER (live market data, every number computed by code) and turn it into a clean, honest
evidence report for the trader who decides next. You do NOT decide whether to trade, and you do not give price
predictions.

WHAT THE DOSSIER FIELDS MEAN
${desk.glossary}

METHOD
1. DATA QUALITY. List every field the decision depends on that is null, "unavailable", simulated (dataQuality notes) or
   contradicts another field (e.g. screener buyers 70% but marketFlow 5-minute buyers 40%). Rate the whole dossier:
   good (all key areas known and consistent), partial (one or two key areas unknown), poor (the trigger, the buying or
   the liquidity is unknown, or the data is simulated).
2. EVIDENCE BY AREA. For each area (${desk.areas.join(", ")}): a reading (supports = speaks for buying now; against =
   speaks against; neutral; unknown = the deciding number is missing), the 1-3 exact numbers behind it written as
   field = value, and one plain sentence. Unknown is never a mild positive.
3. CONFLICTS. Where the evidence disagrees: e.g. strong 5-minute buying inside a 4h downtrend, an ignition right under a
   7-day high, a high ignition score with sellers in the order book.
4. RED FLAGS. Anything a risk manager would stop the trade for: already moved, BTC falling, sellers in control, wide
   spread or thin bids, crowded longs (high funding with rising open interest), whale deposits to exchanges, DEX net
   selling, a weak live record for this tier, matchingGroups clearly below the tier's average, a Binance monitoring tag.
5. KEY NUMBERS. The 3-5 numbers that should weigh most in the decision, most important first, each as field = value
   with a few words on why.

RULES
- Quote numbers exactly as they appear in the dossier. Never round them into different values, never invent one.
- No news, no opinions about the project, no forecasts: other committee members cover those.
- Be short and concrete. A finding without a number is not a finding.`;

export const DATA_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    dataQuality: {
      type: Type.OBJECT,
      properties: {
        rating: { type: Type.STRING, enum: ["good", "partial", "poor"] },
        issues: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { field: { type: Type.STRING }, problem: { type: Type.STRING } }, required: ["field", "problem"] } },
      },
      required: ["rating", "issues"],
    },
    areas: {
      type: Type.ARRAY,
      items: { type: Type.OBJECT, properties: { area: { type: Type.STRING }, reading: { type: Type.STRING, enum: ["supports", "against", "neutral", "unknown"] }, evidence: strArr, note: { type: Type.STRING } },
        required: ["area", "reading", "evidence", "note"] },
    },
    conflicts: strArr,
    redFlags: strArr,
    keyNumbers: { ...strArr, description: "3-5 items, most important first, each 'field = value: why'" },
    summary: { type: Type.STRING, description: "Two sentences: what the data says overall" },
  },
  required: ["dataQuality", "areas", "conflicts", "redFlags", "keyNumbers", "summary"],
};

export async function dataReview(ai, { desk, dossier, model }) {
  const t0 = Date.now();
  try {
    const res = await generate(ai, {
      model, contents: `DOSSIER (JSON)\n${JSON.stringify(dossier)}\n\nWrite the evidence report.`,
      config: { systemInstruction: dataAnalystPrompt(DESKS[desk]), temperature: 0.1, responseMimeType: "application/json", responseSchema: DATA_SCHEMA },
    });
    return { available: true, ...jsonFrom(res, "Data analyst"), model, ms: Date.now() - t0 };
  } catch (e) { return { available: false, error: e.message, model, ms: Date.now() - t0 }; }
}

// ───────────────────────────── 2. news researcher ─────────────────────────────
// identity = { symbol, name, chain?, contract?, tags? } ; holdHours = how long the trade would be held.
export const newsResearcherPrompt = (id, holdHours, now = new Date()) => `You are the NEWS RESEARCHER on a four-member crypto trading committee. Today is ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.
The committee is considering BUYING ${id.symbol}${id.name ? ` (${id.name})` : ""}${id.chain ? ` on ${id.chain}` : ""}${id.contract ? `, contract ${id.contract}` : ""} and holding it for up to ${holdHours} hours.
Use Google Search to find news from the LAST 7 DAYS, and events scheduled in the NEXT 14 DAYS, that could move this
token's price during the trade.

WHAT TO LOOK FOR, MOST IMPORTANT FIRST
1. Exchange events: delisting, "monitoring" or "seed" tag, deposit / withdrawal suspension, new listings on major
   exchanges, margin or futures changes (Binance first).
2. Security: hack, exploit, bridge or wallet compromise, rug pull, team or insider wallets selling, depeg.
3. Supply: token unlocks and vesting releases (date, and size as % of the circulating supply), large airdrops, burns,
   buybacks.
4. Legal and regulatory: lawsuits, SEC / CFTC or other regulator actions, ETF decisions, bans.
5. The project: mainnet or upgrade launches, important partnerships, team departures, delays, funding rounds.
6. Macro (FOMC, CPI, big market events) only when it falls inside the holding time.

RULES
- Report only what you found in the search results, with its date and source. Never rely on memory. If nothing
  relevant turns up, say so: "no relevant news" is a valid and common answer.
- Make sure each item is about THIS token (ticker AND name${id.contract ? " or contract" : ""}), not another project with a similar ticker.
  If you cannot tell, leave the item out.
- Prefer primary sources: exchange announcements, the project's official site or accounts, major crypto media.
  Social-media rumors count only as rumors (severity low unless confirmed).
- pricedIn: "yes" if it happened more than ~48 hours ago and the price already reacted, "no" if it is still ahead or
  just happened, "unclear" otherwise.
- severity: high = can move the price more than 10% or make the trade impossible; medium = about 3-10%; low = minor.
- hardStop = true ONLY for a confirmed, high-severity item that is bad for a buyer: delisting or monitoring tag,
  an active hack or exploit, a deposit / withdrawal halt, an unlock above 2% of the circulating supply inside the
  holding time, a depeg or insolvency.

ANSWER with ONLY one JSON object, no markdown, in exactly this shape:
{"summary": "two sentences", "overall": "positive|negative|mixed|none", "riskLevel": "none|low|medium|high",
 "hardStop": false, "hardStopReason": "",
 "items": [{"date": "YYYY-MM-DD", "title": "", "type": "exchange|security|supply|legal|project|macro|other",
            "impact": "positive|negative|neutral", "severity": "low|medium|high", "pricedIn": "yes|no|unclear",
            "source": "site or account name"}],
 "upcoming": [{"date": "YYYY-MM-DD", "event": "", "impact": "positive|negative|neutral|unclear"}]}`;

const NEWS_ENUMS = { overall: ["positive", "negative", "mixed", "none"], riskLevel: ["none", "low", "medium", "high"] };
// Parses and cleans the researcher's JSON; sources come from Google's grounding data (what was actually searched).
export function cleanNews(text, grounding) {
  let j = null;
  const s = String(text || "").replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
  try { j = JSON.parse(s); } catch { const m = s.match(/\{[\s\S]*\}/); if (m) { try { j = JSON.parse(m[0]); } catch { /* not JSON */ } } }
  if (!j || typeof j !== "object") return { available: false, error: "The news researcher did not return JSON" };
  const sources = [], seen = new Set();
  for (const c of grounding?.groundingChunks || []) { const u = c?.web?.uri; if (u && !seen.has(u)) { seen.add(u); sources.push({ title: String(c.web.title || "source").slice(0, 120), url: u }); } }
  const searched = sources.length > 0 || (grounding?.webSearchQueries || []).length > 0;
  const items = (Array.isArray(j.items) ? j.items : []).slice(0, 10).map((x) => ({ date: String(x.date || "").slice(0, 10), title: String(x.title || "").slice(0, 200),
    type: String(x.type || "other"), impact: ["positive", "negative", "neutral"].includes(x.impact) ? x.impact : "neutral",
    severity: ["low", "medium", "high"].includes(x.severity) ? x.severity : "low", pricedIn: ["yes", "no", "unclear"].includes(x.pricedIn) ? x.pricedIn : "unclear", source: String(x.source || "").slice(0, 80) }));
  return {
    available: true, searched, queries: (grounding?.webSearchQueries || []).slice(0, 6), sources: sources.slice(0, 12),
    summary: String(j.summary || "").slice(0, 600), overall: NEWS_ENUMS.overall.includes(j.overall) ? j.overall : "none",
    riskLevel: NEWS_ENUMS.riskLevel.includes(j.riskLevel) ? j.riskLevel : "none",
    // a hard stop counts only when the answer is backed by an actual search
    hardStop: j.hardStop === true && searched, hardStopReason: String(j.hardStopReason || "").slice(0, 300), unverifiedHardStop: j.hardStop === true && !searched,
    items, upcoming: (Array.isArray(j.upcoming) ? j.upcoming : []).slice(0, 6).map((x) => ({ date: String(x.date || "").slice(0, 10), event: String(x.event || "").slice(0, 200), impact: String(x.impact || "unclear") })),
  };
}
export async function newsResearch(ai, { identity, holdHours, model, enabled = true }) {
  if (!enabled) return { available: false, error: "News research is switched off (AI_NEWS=0)", off: true };
  const key = `${identity.symbol}|${identity.contract || ""}|${Math.round(holdHours)}`, hit = newsCache.get(key);
  if (hit && Date.now() - hit.at < NEWS_TTL) return { ...hit.report, cached: true };
  const t0 = Date.now();
  try {
    const res = await generate(ai, { model, contents: `Research the news for ${identity.symbol}${identity.name ? ` (${identity.name})` : ""} now.`,
      config: { systemInstruction: newsResearcherPrompt(identity, holdHours), temperature: 0.1, tools: [{ googleSearch: {} }] } }, { retries: 1, timeoutMs: 90_000 });
    const report = { ...cleanNews(res.text, res.candidates?.[0]?.groundingMetadata), model, ms: Date.now() - t0, at: Date.now() };
    if (report.available) { newsCache.set(key, { at: Date.now(), report }); if (newsCache.size > 200) newsCache.delete(newsCache.keys().next().value); }
    return report;
  } catch (e) { return { available: false, error: e.message, model, ms: Date.now() - t0 }; }
}

// ───────────────────────────── 3. trader ─────────────────────────────
// rules = the desk's decision rules (ai-trade.js RULES / ALPHA_RULES); schema = the decision schema.
export const traderPrompt = (deskKey, rules) => `You are the TRADER on a four-member crypto trading committee. The trade under review: ${DESKS[deskKey].what}.
A data analyst and a news researcher have prepared reports for you. You make the call. If you say TAKE, code re-checks
your numbers and the chief risk officer (the final boss) gives the final YES or NO, so a TAKE must survive a skeptical
reader: every claim needs a dossier number.

${rules}

HOW TO USE YOUR COLLEAGUES' REPORTS
- DATA ANALYST REPORT: a structured reading of the dossier. Use it to work faster, but the DOSSIER is the source of
  truth: where they differ, use the dossier number and say so. Answer every red flag and conflict it lists in your
  checklist (confirmed, or shown wrong with a dossier number). If its data quality is "poor", the answer is SKIP.
- NEWS REPORT: what a web search found. A confirmed high-severity item that is bad for a buyer (delisting or
  monitoring tag, hack or exploit, deposit / withdrawal halt, an unlock above 2% of the supply inside the holding time)
  is a HARD STOP. A medium negative item inside the holding time lowers the target chance (within the 15-point limit)
  or makes the call WAIT. Positive news that is already priced in does not raise the chance, and rumors do not count.
  "Unavailable" means unknown: say so; do not treat it as good news.
- Add a checklist item "news" with the decisive item, or "no relevant news found", or "news unavailable".`;

export async function traderDecision(ai, { desk, rules, schema, dossier, data, news, model }) {
  const res = await generate(ai, {
    model,
    contents: `DOSSIER (JSON)\n${JSON.stringify(dossier)}\n\nDATA ANALYST REPORT (JSON)\n${JSON.stringify(data?.available ? stripMeta(data) : { available: false, note: data?.error || "unavailable" })}\n\n` +
      `NEWS REPORT (JSON)\n${JSON.stringify(news?.available ? stripMeta(news) : { available: false, note: news?.error || "unavailable" })}\n\nWork through the steps, then decide: TAKE, WAIT or SKIP (no trade).`,
    config: { systemInstruction: traderPrompt(desk, rules), temperature: 0.2, responseMimeType: "application/json", responseSchema: schema },
  });
  return jsonFrom(res, "Trader");
}
const stripMeta = (x) => { const { model, ms, at, cached, available, ...rest } = x; return rest; };

// ───────────────────────────── 4. final boss ─────────────────────────────
export const bossPrompt = (deskKey) => `You are the CHIEF RISK OFFICER and the final decision maker of a crypto trading committee. The trade: ${DESKS[deskKey].what}.
The trader proposes to BUY now, and the code checks passed. You answer YES (we take this trade now, exactly as planned)
or NO (we do not). Capital comes first: a missed trade costs nothing, a bad trade costs money. When in doubt, NO.

YOU RECEIVE
- TRADE: the plan (entry, stop, target, holding time), the trader's probabilities and the expected value RECOMPUTED BY
  CODE, reward:risk, the code's notes.
- TRADER'S REASONING: checklist, thesis, points for and against, key risk.
- DATA ANALYST REPORT: data quality, conflicts, red flags, key numbers.
- NEWS REPORT: what the web search found (or that it was unavailable).
- KEY FACTS: the dossier numbers that matter most.

RUN THESE TESTS (pass or fail, with the number behind it)
1. Data: quality is not "poor", and no number the decision depends on is missing or contradictory.
2. Red flags: every red flag and conflict from the analyst was answered with evidence, not explained away.
3. News: risk is not high, and no medium-negative item falls inside the holding time unpriced. Unavailable news is
   acceptable only when everything else is strong.
4. Probabilities: moved from the base rate only for named evidence; the expected value is at least +0.5% per trade
   without an optimistic target (e.g. a target beyond nearby resistance with little room).
5. Stop: at a level that proves the idea wrong, and not inside normal noise (at least about 1x the 1h ATR away).
6. Market: BTC and the market backdrop do not fight the trade.
YES only if all six pass. Otherwise NO, and say exactly what would have to be true for a YES.
Do not re-argue small details. Look for the one thing that would make this trade a mistake. Quote numbers exactly.`;

export const BOSS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ["YES", "NO"] },
    reason: { type: Type.STRING, description: "The decisive reason, one sentence" },
    biggestRisk: { type: Type.STRING },
    mustBeTrue: { type: Type.STRING, description: "For NO: what would have to change for a YES. For YES: what would make you exit early" },
    checks: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { test: { type: Type.STRING }, pass: { type: Type.BOOLEAN }, note: { type: Type.STRING } }, required: ["test", "pass", "note"] } },
  },
  required: ["verdict", "reason", "biggestRisk", "mustBeTrue", "checks"],
};

export async function finalBoss(ai, { desk, trade, reasoning, data, news, keyFacts, model }) {
  const t0 = Date.now();
  try {
    const res = await generate(ai, {
      model,
      contents: `TRADE (JSON)\n${JSON.stringify(trade)}\n\nTRADER'S REASONING (JSON)\n${JSON.stringify(reasoning)}\n\nDATA ANALYST REPORT (JSON)\n${JSON.stringify(data?.available ? stripMeta(data) : { available: false })}\n\n` +
        `NEWS REPORT (JSON)\n${JSON.stringify(news?.available ? stripMeta(news) : { available: false, note: news?.error || "unavailable" })}\n\nKEY FACTS (JSON)\n${JSON.stringify(keyFacts)}\n\nRun the tests and answer YES or NO.`,
      config: { systemInstruction: bossPrompt(desk), temperature: 0.1, responseMimeType: "application/json", responseSchema: BOSS_SCHEMA },
    });
    const b = jsonFrom(res, "Final boss");
    return { available: true, verdict: b.verdict === "YES" ? "YES" : "NO", reason: b.reason, biggestRisk: b.biggestRisk, mustBeTrue: b.mustBeTrue, checks: Array.isArray(b.checks) ? b.checks.slice(0, 8) : [], model, ms: Date.now() - t0 };
  } catch (e) { return { available: false, verdict: null, reason: e.message, model, ms: Date.now() - t0 }; }
}

// ───────────────────────────── the final call ─────────────────────────────
// After the code's own checks (decision = TAKE / WAIT / SKIP), before the final boss: a confirmed news hard stop means
// no trade, and so does a TAKE on data the analyst rated poor. Returns { decision, notes }.
export function committeeChecks(decision, { news, data } = {}) {
  const notes = [];
  if (news?.hardStop && decision !== "SKIP") { notes.push(`News hard stop: ${news.hardStopReason || "a confirmed high-severity negative item"}. No trade.`); decision = "SKIP"; }
  if (decision === "TAKE" && data?.available && data.dataQuality?.rating === "poor") { notes.push("The data analyst rated the data poor, so there is no TAKE."); decision = "SKIP"; }
  return { decision, notes };
}
// The final boss decides a TAKE: YES keeps it, NO means no trade, no answer means no TAKE (WAIT: run it again).
// Anything that was not a TAKE is a NO without asking. Returns { decision, final: "YES" | "NO", notes }.
export function bossCall(decision, boss) {
  const notes = [];
  if (decision === "TAKE") {
    if (!boss?.available) { decision = "WAIT"; notes.push(`The final boss could not answer (${boss?.reason || "unavailable"}), so there is no TAKE: run it again in a minute.`); }
    else if (boss.verdict !== "YES") { decision = "SKIP"; notes.push(`Final boss said NO: ${boss.reason}`); }
  }
  return { decision, final: decision === "TAKE" ? "YES" : "NO", notes };
}
export const _test = { newsCache };

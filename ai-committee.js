// The AI committee: Gemini roles, each with one job, so no single answer carries the whole decision.
//
//   1. DATA ANALYST    reads the dossier (live facts computed by code) and reports data quality, the evidence per area,
//                      conflicts and red flags. It does not decide.
//   2. NEWS RESEARCHER searches the web (Gemini's Google Search) for news and scheduled events that could move this coin
//                      during the trade. Runs at the same time as the analyst. Sources come from Google's own grounding
//                      data, not from the model's text.
//   3. BULL and BEAR   the debate: the bull makes the strongest honest case for buying, then the bear sees that case,
//                      tests every bull point and makes the case against, with the most likely path to the stop.
//                      AI_DEBATE=0 (or the page's switch) leaves it out.
//   4. TRADER          decides TAKE / WAIT / SKIP with probabilities, expected value and a plan, from the dossier, both
//                      reports and the debate, as its referee. Code then re-checks everything (hard stops, expected
//                      value, reward:risk, the plan).
//   5. FINAL BOSS      the chief risk officer, called only for a TAKE that passed the code checks: YES (take it now, as
//                      planned) or NO. A stronger model by default. It can only say no, never turn a WAIT into a TAKE.
//
// Every stage returns JSON in a fixed shape. If a member fails, the committee carries on and says so (unknown, never
// "fine"); if the final boss cannot answer, there is no TAKE. Each role has its own thinking depth (roleConfig): quick
// for checking and arguing, deep for deciding and approving. Not financial advice.
import { Type, ThinkingLevel } from "@google/genai";
import { generate, jsonFrom, AgentError } from "./agent.js";

const strArr = { type: Type.ARRAY, items: { type: Type.STRING } };
const NEWS_TTL = 30 * 60_000;
const newsCache = new Map(); // identity key -> { at, report }

// ───────────────────────────── model settings per role ─────────────────────────────
// How hard each member thinks. Gemini 3 models take a thinking level and keep their default temperature (Google advises
// against lowering it on Gemini 3: it can make the model loop or reason worse); Gemini 2.5 takes a thinking budget and a
// low temperature; other models get a low temperature only. Checking, searching and arguing are quick jobs (low);
// deciding and approving get deep thinking (high), and more time. AI_DEEP_THINKING=0: every member thinks "low".
export const THINKING = { data: "low", news: "low", bull: "low", bear: "low", triage: "low", trader: "high", boss: "high" };
const LOW_TEMP = { data: 0.1, news: 0.1, bull: 0.4, bear: 0.4, triage: 0.2, trader: 0.2, boss: 0.1 };
export function roleConfig(model, role, env = process.env) {
  const deep = env.AI_DEEP_THINKING !== "0" && THINKING[role] === "high", m = String(model || "").toLowerCase();
  if (/gemini-[3-9]/.test(m)) return { thinkingConfig: { thinkingLevel: deep ? ThinkingLevel.HIGH : ThinkingLevel.LOW } };
  if (/gemini-2\.5/.test(m)) return { temperature: LOW_TEMP[role] ?? 0.2, thinkingConfig: { thinkingBudget: deep ? 8192 : 1024 } };
  return { temperature: LOW_TEMP[role] ?? 0.2 };
}
// Deep thinking takes longer: one retry, a longer wait.
const callOpts = (role) => (THINKING[role] === "high" ? { retries: 1, timeoutMs: 120_000 } : role === "news" ? { retries: 1, timeoutMs: 90_000 } : {});
// Tokens used by one request (thinking tokens are billed as output).
export const usage = (res) => { const u = res?.usageMetadata || {}; return { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0, think: u.thoughtsTokenCount || 0 }; };

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
  conditions, with older / newer halves). aiCommittee: this committee's own past answers, each followed with its own
  plan (final YES, final NO if bought anyway, trades the boss blocked, debate winners, said vs real target chances,
  recent losing YES calls).
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
- livePerformance: live results by tier and matchingGroups (past Alpha alerts with the same conditions). aiCommittee:
  this committee's own past answers, each followed with its own plan.
- referencePlan: entries, stops, targets and reward:risk computed by code.`.trim(),
  },
};

// ───────────────────────────── 1. data analyst ─────────────────────────────
export const dataAnalystPrompt = (desk) => `You are the DATA ANALYST on a crypto trading committee. The trade under review: ${desk.what}.
Your only job is to read the DOSSIER (live market data, every number computed by code) and turn it into a clean, honest
evidence report for the debaters and the trader who decides. You do NOT decide whether to trade, and you do not give price
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
      config: { systemInstruction: dataAnalystPrompt(DESKS[desk]), ...roleConfig(model, "data"), responseMimeType: "application/json", responseSchema: DATA_SCHEMA },
    }, callOpts("data"));
    return { available: true, ...jsonFrom(res, "Data analyst"), model, ms: Date.now() - t0, tokens: usage(res) };
  } catch (e) { return { available: false, error: e.message, model, ms: Date.now() - t0 }; }
}

// ───────────────────────────── 2. news researcher ─────────────────────────────
// identity = { symbol, name, chain?, contract?, tags? } ; holdHours = how long the trade would be held.
export const newsResearcherPrompt = (id, holdHours, now = new Date()) => `You are the NEWS RESEARCHER on a crypto trading committee. Today is ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.
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
      config: { systemInstruction: newsResearcherPrompt(identity, holdHours), ...roleConfig(model, "news"), tools: [{ googleSearch: {} }] } }, callOpts("news"));
    const report = { ...cleanNews(res.text, res.candidates?.[0]?.groundingMetadata), model, ms: Date.now() - t0, at: Date.now(), tokens: usage(res) };
    if (report.available) { newsCache.set(key, { at: Date.now(), report }); if (newsCache.size > 200) newsCache.delete(newsCache.keys().next().value); }
    return report;
  } catch (e) { return { available: false, error: e.message, model, ms: Date.now() - t0 }; }
}

// ───────────────────────────── 3. the debate: bull and bear ─────────────────────────────
const debateIntro = (deskKey) => `The trade under review: ${DESKS[deskKey].what}.
You receive the DOSSIER (live data, every number computed by code), the DATA ANALYST REPORT and the NEWS REPORT.`;

export const bullPrompt = (deskKey) => `You are the BULL on a crypto trading committee. ${debateIntro(deskKey)}
Your job: make the strongest HONEST case for buying now. A bear will read your case and attack every point, and the
trader judges on evidence only, so an argument without a dossier number is worthless.

METHOD
1. POINTS: the 3-5 strongest reasons to buy now, most important first, each with the exact dossier number(s) behind it.
2. RED FLAGS: answer every red flag and conflict in the analyst's report with a number, or admit that it stands.
3. PATH: how the price reaches the target within the holding time, step by step (e.g. "holds above VWAP 1.02, breaks
   the 7-day high 1.08 on volume, BTC flat or up").
4. WEAKEST POINT of your own case, and the one fact that would make you drop it.
5. STRENGTH 0-10: how strong the case for buying really is. Be honest: 5 is an average ignition, most are 3-6, and
   overselling a weak setup costs the committee money.

RULES
- Quote numbers exactly. Never invent data or news. Unknown is not a reason to buy.
- You argue; you do not decide. Short, concrete sentences.`;

export const bearPrompt = (deskKey) => `You are the BEAR on a crypto trading committee. ${debateIntro(deskKey)}
You also receive the BULL'S CASE. Your job: test every bull argument and make the strongest HONEST case AGAINST
buying now. The trader judges on evidence only, so an argument without a dossier number is worthless.

METHOD
1. REBUTTALS: for each bull point, say whether it holds, is overstated or is wrong, with the dossier number that shows it.
   A point that holds, holds: say so.
2. POINTS: the 3-5 strongest reasons NOT to buy now, most important first, each with the exact dossier number(s). Think
   of: a fake-out (volume without follow-through), sellers in the book or the flow, resistance overhead, BTC weakness,
   crowded futures, thin liquidity, whale deposits to exchanges, the base rate (most alerts of this kind fail), news.
3. PATH: the most likely way this trade ends at the stop within the holding time, step by step.
4. WEAKEST POINT of your own case, and the one fact that would make you drop it.
5. STRENGTH 0-10: how strong the case against buying really is. Be honest: inventing risks the data does not show costs
   the committee good trades.

RULES
- Quote numbers exactly. Never invent data or news.
- You argue; you do not decide. Short, concrete sentences.`;

const point = { type: Type.OBJECT, properties: { point: { type: Type.STRING }, evidence: { type: Type.STRING, description: "field = value from the dossier" } }, required: ["point", "evidence"] };
const caseProps = {
  strength: { type: Type.INTEGER, description: "0-10, honest" }, thesis: { type: Type.STRING, description: "Two sentences" },
  points: { type: Type.ARRAY, items: point }, weakestPoint: { type: Type.STRING }, wouldChangeMyMind: { type: Type.STRING },
};
export const BULL_SCHEMA = {
  type: Type.OBJECT,
  properties: { ...caseProps, path: { type: Type.STRING, description: "How the price reaches the target within the holding time" },
    redFlagAnswers: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { flag: { type: Type.STRING }, answer: { type: Type.STRING }, stands: { type: Type.BOOLEAN } }, required: ["flag", "answer", "stands"] } } },
  required: ["strength", "thesis", "points", "path", "redFlagAnswers", "weakestPoint", "wouldChangeMyMind"],
};
export const BEAR_SCHEMA = {
  type: Type.OBJECT,
  properties: { ...caseProps, path: { type: Type.STRING, description: "The most likely way the trade ends at the stop" },
    rebuttals: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { bullPoint: { type: Type.STRING }, verdict: { type: Type.STRING, enum: ["holds", "overstated", "wrong"] }, evidence: { type: Type.STRING } }, required: ["bullPoint", "verdict", "evidence"] } } },
  required: ["strength", "thesis", "rebuttals", "points", "path", "weakestPoint", "wouldChangeMyMind"],
};
const reportJson = (x, what) => JSON.stringify(x?.available ? stripMeta(x) : { available: false, note: x?.error || `${what} unavailable` });
const caseJson = (x) => JSON.stringify(x?.available ? stripMeta(x) : { available: false, note: x?.error || "unavailable" });
const evidenceText = (dossier, data, news) => `DOSSIER (JSON)\n${JSON.stringify(dossier)}\n\nDATA ANALYST REPORT (JSON)\n${reportJson(data, "data report")}\n\nNEWS REPORT (JSON)\n${reportJson(news, "news")}`;

async function argue(ai, side, { desk, model, contents }) {
  const t0 = Date.now();
  try {
    const res = await generate(ai, { model, contents,
      config: { systemInstruction: (side === "bull" ? bullPrompt : bearPrompt)(desk), ...roleConfig(model, side), responseMimeType: "application/json", responseSchema: side === "bull" ? BULL_SCHEMA : BEAR_SCHEMA } }, callOpts(side));
    const j = jsonFrom(res, side === "bull" ? "Bull" : "Bear");
    return { available: true, ...j, strength: Math.max(0, Math.min(10, Math.round(Number(j.strength) || 0))), points: (j.points || []).slice(0, 6), model, ms: Date.now() - t0, tokens: usage(res) };
  } catch (e) { return { available: false, error: e.message, model, ms: Date.now() - t0 }; }
}
// The bull argues first; the bear sees the bull's case and answers it. Never throws: a side that fails is "unavailable".
export async function debate(ai, { desk, dossier, data, news, model, enabled = true }) {
  if (!enabled) return { off: true, bull: null, bear: null };
  const facts = evidenceText(dossier, data, news);
  const bull = await argue(ai, "bull", { desk, model, contents: `${facts}\n\nMake the case for buying now.` });
  const bear = await argue(ai, "bear", { desk, model, contents: `${facts}\n\nBULL'S CASE (JSON)\n${caseJson(bull)}\n\nTest the bull's case and make the case against buying now.` });
  return { off: false, bull, bear };
}

// ───────────────────────────── 4. trader ─────────────────────────────
// rules = the desk's decision rules (ai-trade.js RULES / ALPHA_RULES); schema = the decision schema.
export const traderPrompt = (deskKey, rules, { debate = false } = {}) => `You are the TRADER on a crypto trading committee. The trade under review: ${DESKS[deskKey].what}.
A data analyst and a news researcher have prepared reports for you${debate ? ", and a bull and a bear have argued the trade" : ""}. You make the call. If you say
TAKE, code re-checks your numbers and the chief risk officer (the final boss) gives the final YES or NO, so a TAKE must
survive a skeptical reader: every claim needs a dossier number.

${rules}

HOW TO USE YOUR COLLEAGUES' WORK
- DATA ANALYST REPORT: a structured reading of the dossier. Use it to work faster, but the DOSSIER is the source of
  truth: where they differ, use the dossier number and say so. Answer every red flag and conflict it lists in your
  checklist (confirmed, or shown wrong with a dossier number). If its data quality is "poor", the answer is SKIP.
- NEWS REPORT: what a web search found. A confirmed high-severity item that is bad for a buyer (delisting or
  monitoring tag, hack or exploit, deposit / withdrawal halt, an unlock above 2% of the supply inside the holding time)
  is a HARD STOP. A medium negative item inside the holding time lowers the target chance (within the 15-point limit)
  or makes the call WAIT. Positive news that is already priced in does not raise the chance, and rumors do not count.
  "Unavailable" means unknown: say so; do not treat it as good news.
- Add a checklist item "news" with the decisive item, or "no relevant news found", or "news unavailable".${debate ? `
- THE DEBATE: the bull argued for buying; then the bear read the bull's case and attacked it. Judge it like a referee:
  only arguments backed by a dossier number count; a bull point the bear showed wrong with a number is gone; a bear
  point or red flag the bull could not answer stands. Ignore tone, confidence and the strength scores they gave
  themselves. The bear spoke last; that is not a reason to agree with it. If the bear's path to the stop is more likely
  than the bull's path to the target, there is no TAKE. Fill "debate" with the winner (bull, bear or even) and the
  argument that decided it, and let the unanswered points move your probabilities. A side marked unavailable did not
  argue: judge from the dossier.` : ""}

THE COMMITTEE'S OWN RECORD (dossier livePerformance.aiCommittee: this committee's past answers, each followed with its
own plan; ignore it while it says there are too few calls)
- If final YES calls have lost money on average, or the calibration shows your target chances ran well above what
  really happened, be stricter: move the target chance toward what happened and demand clearer evidence for TAKE.
- If final NO calls (bought anyway) did clearly better than final YES calls over 10+ each, the committee's own doubts
  are costing trades: weigh the base rate and the data more, and vague worries less.
- If one of the recent losing YES calls looks like this setup, name the difference that makes this one better, or do
  not take it.`;

const DEBATE_VERDICT = { type: Type.OBJECT, properties: { winner: { type: Type.STRING, enum: ["bull", "bear", "even"] }, reason: { type: Type.STRING, description: "The argument that decided it" } }, required: ["winner", "reason"] };
export async function traderDecision(ai, { desk, rules, schema, dossier, data, news, debate: dbt, model }) {
  const t0 = Date.now(), withDebate = !!dbt && !dbt.off;
  const sch = withDebate ? { ...schema, properties: { ...schema.properties, debate: DEBATE_VERDICT }, required: [...schema.required, "debate"] } : schema;
  const res = await generate(ai, {
    model,
    contents: `${evidenceText(dossier, data, news)}\n\n` + (withDebate ? `BULL'S CASE (JSON)\n${caseJson(dbt.bull)}\n\nBEAR'S CASE (JSON)\n${caseJson(dbt.bear)}\n\n` : "") +
      "Work through the steps, then decide: TAKE, WAIT or SKIP (no trade).",
    config: { systemInstruction: traderPrompt(desk, rules, { debate: withDebate }), ...roleConfig(model, "trader"), responseMimeType: "application/json", responseSchema: sch },
  }, callOpts("trader"));
  return { out: jsonFrom(res, "Trader"), ms: Date.now() - t0, tokens: usage(res) };
}
const stripMeta = (x) => { const { model, ms, at, cached, available, tokens, ...rest } = x; return rest; };

// ───────────────────────────── 5. final boss ─────────────────────────────
export const bossPrompt = (deskKey) => `You are the CHIEF RISK OFFICER and the final decision maker of a crypto trading committee. The trade: ${DESKS[deskKey].what}.
The trader proposes to BUY now, and the code checks passed. You answer YES (we take this trade now, exactly as planned)
or NO (we do not). Capital comes first: a missed trade costs nothing, a bad trade costs money. When in doubt, NO.

YOU RECEIVE
- TRADE: the plan (entry, stop, target, holding time), the trader's probabilities and the expected value RECOMPUTED BY
  CODE, reward:risk, the code's notes.
- TRADER'S REASONING: checklist, thesis, points for and against, key risk.
- DATA ANALYST REPORT: data quality, conflicts, red flags, key numbers.
- NEWS REPORT: what the web search found (or that it was unavailable).
- DEBATE: the bull's case for, the bear's case against (it saw the bull's case first), and who the trader said won.
  It may be missing (switched off).
- KEY FACTS: the dossier numbers that matter most, and aiCommittee: this committee's own record (its past YES calls,
  trades you blocked, said vs real target chances).

RUN THESE TESTS (pass or fail, with the number behind it)
1. Data: quality is not "poor", and no number the decision depends on is missing or contradictory.
2. Red flags and the bear: every red flag and conflict from the analyst, and every bear point backed by a number, was
   answered with evidence, not explained away; the bear's path to the stop is less likely than the bull's path to the
   target.
3. News: risk is not high, and no medium-negative item falls inside the holding time unpriced. Unavailable news is
   acceptable only when everything else is strong.
4. Probabilities: moved from the base rate only for named evidence; the expected value is at least +0.5% per trade
   without an optimistic target (e.g. a target beyond nearby resistance with little room); and when the committee's
   record shows its target chances running above what really happened, the chance here is not just as high.
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

const debateBrief = (d) => {
  if (!d || d.off) return { off: true };
  const side = (x, extra) => (x?.available ? { strength: x.strength, thesis: x.thesis, points: x.points, path: x.path, weakestPoint: x.weakestPoint, ...extra(x) } : { available: false });
  return { bull: side(d.bull, (x) => ({ redFlagAnswers: x.redFlagAnswers })), bear: side(d.bear, (x) => ({ rebuttals: x.rebuttals })), traderVerdict: d.verdict || null };
};
export async function finalBoss(ai, { desk, trade, reasoning, data, news, debate: dbt, keyFacts, model }) {
  const t0 = Date.now();
  try {
    const res = await generate(ai, {
      model,
      contents: `TRADE (JSON)\n${JSON.stringify(trade)}\n\nTRADER'S REASONING (JSON)\n${JSON.stringify(reasoning)}\n\nDATA ANALYST REPORT (JSON)\n${JSON.stringify(data?.available ? stripMeta(data) : { available: false })}\n\n` +
        `NEWS REPORT (JSON)\n${JSON.stringify(news?.available ? stripMeta(news) : { available: false, note: news?.error || "unavailable" })}\n\nDEBATE (JSON)\n${JSON.stringify(debateBrief(dbt))}\n\n` +
        `KEY FACTS (JSON)\n${JSON.stringify(keyFacts)}\n\nRun the tests and answer YES or NO.`,
      config: { systemInstruction: bossPrompt(desk), ...roleConfig(model, "boss"), responseMimeType: "application/json", responseSchema: BOSS_SCHEMA },
    }, callOpts("boss"));
    const b = jsonFrom(res, "Final boss");
    return { available: true, verdict: b.verdict === "YES" ? "YES" : "NO", reason: b.reason, biggestRisk: b.biggestRisk, mustBeTrue: b.mustBeTrue, checks: Array.isArray(b.checks) ? b.checks.slice(0, 8) : [], model, ms: Date.now() - t0, tokens: usage(res) };
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

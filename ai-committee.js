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
//   5. FINAL BOSS      audits the whole committee on every analysis (hard stops, reward:risk to the nearest resistance,
//                      expected value, probability adjustments, contradictions) and gives the final call: YES, WATCH
//                      (with measurable triggers and an expiry) or NO, with a corrected plan and a position size. It can
//                      overturn the trader either way; code still turns an unsafe YES into WATCH. A stronger model.
//
// Every stage returns JSON in a fixed shape. If a member fails, the committee carries on and says so (unknown, never
// "fine"); if the final boss cannot answer, there is no YES. Each role has its own thinking depth (roleConfig): quick
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
    hardStops: `
- the coin already ran (screener.moved)
- BTC down more than 1% in 1h or 2% in 4h (market.btc1hPct, market.btc4hPct)
- aggressive selling now: marketFlow.buyRatio5mPct under 45 with a negative marketFlow.netFlow5mUsd
- spread above 30 bps or bids within 1% under $20,000 (orderBook.liquidityCheck)
- a Binance monitoring tag (exchangeTags.monitoring or screener.monitoringList)
- a confirmed high-severity bad news item from a real web search (NEWS REPORT hardStop, verified true): delisting,
  hack or exploit, deposit / withdrawal halt, an unlock above 2% of the supply inside the holding time`.trim(),
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
- levels: resistance (resistanceIs = what it is: a high, a 1h swing high or a 1h / 4h EMA) and support with their
  distances in %; overhead / underneath = the nearest levels above / below; 24h / 7d / 15d highs and lows.
- orderBook: spreadBps and depth bands (bids and asks in USD within withinPct 0.1 / 0.25 / 0.5 / 1%, imbalance > 0 =
  more bids). A thin 0.1% band is normal for small coins and is NOT the liquidity test: orderBook.liquidityCheck is
  (bids within 1% under $20,000 or spread above 30 bps = hard stop).
- exchangeTags: Binance tags. monitoring = delisting risk (a hard stop); seed = Binance's high-volatility tag for young
  projects (a risk, not a hard stop).
- futures: funding per 8h, open interest change, long/short and taker ratios (only when a perpetual exists).
- whales: large Ethereum transfers of the token and exchange deposits / withdrawals in 24h (Ethereum only).
- dexFlows: DEX buying and selling of the token (only for followed pools).
- market: BTC 1h / 4h / 24h, share of coins surging, taker-flow breadth, BTC regime and narrative ranks.
- livePerformance: live results of this tier, of past AI calls, and matchingGroups (past alerts with the same
  conditions, with older / newer halves). aiCommittee: this committee's own past answers, each followed with its own
  plan (final YES, final WATCH / NO if bought anyway, trader TAKEs the boss stopped, debate winners, said vs real target
  chances, recent losing YES calls).
- referencePlan: entries, stops, targets and reward:risk computed by code. dataQuality: demo / missing-data notes.`.trim(),
  },
  alpha: {
    what: "a Binance Alpha token: an early on-chain token traded in Binance Wallet with a thin DEX pool (long only, no leverage)",
    hardStops: `
- already up more than 30% in 24 hours (screener.moved)
- BTC down more than 1% in 1h or 2% in 4h (market.btc1hPct, market.btc4hPct)
- DEX sellers in control: alpha.dex.buyers5mPct under 40 and alpha.dex.buyers1hPct under 45
- pool liquidity under $50,000 (alpha.token.liquidityUsd)
- a confirmed high-severity bad news item from a real web search (NEWS REPORT hardStop, verified true): delisting,
  hack or exploit, deposit / withdrawal halt, an unlock above 2% of the supply inside the holding time`.trim(),
    areas: ["trigger", "DEX buying", "trend", "room", "liquidity and holders", "supply", "market", "track record"],
    glossary: `
- alert: tier, trackedAs (target %, stop %, holding hours), anchorProbTargetPct / anchorProbStopPct (base rates), costPct.
- screener: state, tier, moved (already up too much: never chase), stillNeeds.
- alpha.token: pool liquidity (USD), holders, market cap, FDV, circulating %, days on Alpha, 24h volume.
- alpha.signal: volume vs normal and USD / trades in the last two 5-minute candles, 10-minute move, 1h and 24h change.
- alpha.dex: DEX buys vs sells over 5 minutes and buyers % over 5 minutes / 1 hour, pool liquidity. liquidityNote: how
  big a normal order is next to the pool.
- chart: trend1h / trend4h, returnsPct, atrPct. levels: resistance / support (resistanceIs / supportIs: a high, a 1h
  swing high or low, a 1h / 4h EMA), distances, overhead / underneath levels, 24h / 3d / 7d highs and lows.
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
// Signs that Google Search really ran: any grounding field Google returns, or tokens the model spent reading tool
// (search) results. Source links can be missing even when a search ran, so links alone are not the test.
export function searchEvidence(grounding, usageMeta) {
  const g = grounding || {};
  const ev = { links: (g.groundingChunks || []).filter((c) => c?.web?.uri).length, queries: (g.webSearchQueries || []).length,
    entryPoint: !!g.searchEntryPoint?.renderedContent, supports: (g.groundingSupports || []).length, toolTokens: Number(usageMeta?.toolUsePromptTokenCount) || 0,
    fields: Object.keys(g).slice(0, 10) };
  ev.searched = ev.links > 0 || ev.queries > 0 || ev.entryPoint || ev.supports > 0 || ev.toolTokens > 0;
  return ev;
}
// Parses and cleans the researcher's JSON; sources come from Google's grounding data (what was actually searched).
export function cleanNews(text, grounding, usageMeta = null) {
  let j = null;
  const s = String(text || "").replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
  try { j = JSON.parse(s); } catch { const m = s.match(/\{[\s\S]*\}/); if (m) { try { j = JSON.parse(m[0]); } catch { /* not JSON */ } } }
  if (!j || typeof j !== "object") return { available: false, error: "The news researcher did not return JSON" };
  const sources = [], seen = new Set();
  for (const c of grounding?.groundingChunks || []) { const u = c?.web?.uri; if (u && !seen.has(u)) { seen.add(u); sources.push({ title: String(c.web.title || "source").slice(0, 120), url: u }); } }
  const evidence = searchEvidence(grounding, usageMeta), searched = evidence.searched;
  const items = (Array.isArray(j.items) ? j.items : []).slice(0, 10).map((x) => ({ date: String(x.date || "").slice(0, 10), title: String(x.title || "").slice(0, 200),
    type: String(x.type || "other"), impact: ["positive", "negative", "neutral"].includes(x.impact) ? x.impact : "neutral",
    severity: ["low", "medium", "high"].includes(x.severity) ? x.severity : "low", pricedIn: ["yes", "no", "unclear"].includes(x.pricedIn) ? x.pricedIn : "unclear", source: String(x.source || "").slice(0, 80) }));
  return {
    available: true, searched, verified: searched, evidence, queries: (grounding?.webSearchQueries || []).slice(0, 6), sources: sources.slice(0, 12),
    note: searched ? null : "No web search ran: these items come from the model's memory and are unverified. Treat the news as unknown, except that an unconfirmed hack, exploit, delisting or halt still means no buying until it is confirmed.",
    summary: String(j.summary || "").slice(0, 600), overall: NEWS_ENUMS.overall.includes(j.overall) ? j.overall : "none",
    riskLevel: NEWS_ENUMS.riskLevel.includes(j.riskLevel) ? j.riskLevel : "none",
    // a hard stop counts only when the answer is backed by an actual search
    hardStop: j.hardStop === true && searched, hardStopReason: String(j.hardStopReason || "").slice(0, 300), unverifiedHardStop: j.hardStop === true && !searched,
    // an unconfirmed claim of serious trouble: not a hard stop, but never a YES until it is confirmed
    unverifiedRedFlag: !searched && (j.hardStop === true || items.some((x) => x.impact === "negative" && x.severity === "high"))
      ? String(j.hardStopReason || items.find((x) => x.impact === "negative" && x.severity === "high")?.title || "a high-severity negative item").slice(0, 200) : null,
    items, upcoming: (Array.isArray(j.upcoming) ? j.upcoming : []).slice(0, 6).map((x) => ({ date: String(x.date || "").slice(0, 10), event: String(x.event || "").slice(0, 200), impact: String(x.impact || "unclear") })),
  };
}
export async function newsResearch(ai, { identity, holdHours, model, enabled = true }) {
  if (!enabled) return { available: false, error: "News research is switched off (AI_NEWS=0)", off: true };
  const key = `${identity.symbol}|${identity.contract || ""}|${Math.round(holdHours)}`, hit = newsCache.get(key);
  if (hit && Date.now() - hit.at < NEWS_TTL) return { ...hit.report, cached: true };
  const t0 = Date.now(), name = identity.name ? ` (${identity.name})` : "", tokens = { in: 0, out: 0, think: 0 };
  const ask = async (contents) => {
    const res = await generate(ai, { model, contents, config: { systemInstruction: newsResearcherPrompt(identity, holdHours), ...roleConfig(model, "news"), tools: [{ googleSearch: {} }] } }, callOpts("news"));
    const u = usage(res);
    for (const k in tokens) tokens[k] += u[k];
    return cleanNews(res.text, res.candidates?.[0]?.groundingMetadata, res.usageMetadata);
  };
  try {
    let report = await ask(`Research the news for ${identity.symbol}${name} now.`), requests = 1;
    // Gemini decides itself whether to search. If it answered from memory, ask once more, insisting on a search.
    if (report.available && !report.searched) {
      requests++;
      const again = await ask(`Use Google Search now: look up "${identity.symbol}${identity.name ? ` ${identity.name}` : ""} crypto news" and its Binance status before you answer. Do not answer from memory.`).catch(() => null);
      if (again?.available) report = again;
    }
    const out = { ...report, model, ms: Date.now() - t0, at: Date.now(), tokens, requests };
    // Recent dated items without any sign of a search are suspicious: log what Google sent back, to find out why.
    const recent = (out.items || []).some((x) => Date.parse(x.date) > Date.now() - 10 * 86_400_000);
    if (out.available && !out.verified && recent) console.warn(`AI news (${identity.symbol}): items dated in the last 10 days but no search evidence; grounding fields: [${out.evidence?.fields?.join(", ")}], tool tokens: ${out.evidence?.toolTokens}`);
    // only verified news is kept for 30 minutes; unverified news is asked again next time
    if (out.available && out.verified) { newsCache.set(key, { at: Date.now(), report: out }); if (newsCache.size > 200) newsCache.delete(newsCache.keys().next().value); }
    return out;
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
const caseObj = (x) => (x?.available ? stripMeta(x) : { available: false, note: x?.error || "unavailable" });
const caseJson = (x) => JSON.stringify(caseObj(x));
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
A data analyst and a news researcher have prepared reports for you${debate ? ", and a bull and a bear have argued the trade" : ""}. You make the call. Then code
re-checks your numbers and the Final Boss audits the whole committee and gives the final YES, WATCH or NO; it can
overturn you in either direction, so every claim needs a dossier number.

${rules}

WORDING: SKIP is only the value of "decision". In the headline, thesis and every other text write "NO TRADE", never
"SKIP".

HOW TO USE YOUR COLLEAGUES' WORK
- DATA ANALYST REPORT: a structured reading of the dossier. Use it to work faster, but the DOSSIER is the source of
  truth: where they differ, use the dossier number and say so. Answer every red flag and conflict it lists in your
  checklist (confirmed, or shown wrong with a dossier number). If its data quality is "poor", the answer is SKIP.
- NEWS REPORT: what a web search found. A confirmed high-severity item that is bad for a buyer (delisting or
  monitoring tag, hack or exploit, deposit / withdrawal halt, an unlock above 2% of the supply inside the holding time)
  is a HARD STOP. A medium negative item inside the holding time lowers the target chance (within the 15-point limit)
  or makes the call WAIT. Positive news that is already priced in does not raise the chance, and rumors do not count.
  "Unavailable", or verified: false (no web search ran, so the items come from the model's memory), means unknown:
  say so; do not treat it as good or bad news, and its items do not count. One exception, because capital comes
  first: an unverified claim of a hack, exploit, delisting, halt or monitoring tag (unverifiedRedFlag) still means no
  TAKE; WAIT at most until it is confirmed.
- Add a checklist item "news" with the decisive item, or "no relevant news found", or "news unavailable / unverified".${debate ? `
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
- If final WATCH or NO calls (bought anyway) did clearly better than final YES calls over 10+ each, the committee's own
  doubts are costing trades: weigh the base rate and the data more, and vague worries less.
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
// Runs on every analysis, whatever the trader decided: audits the committee (hard stops, reward:risk to the nearest
// resistance, expected value with timeouts, probability adjustments, contradictions, missing data, the bull's case) and
// gives the final call YES / WATCH / NO with a corrected plan. The prompt is the owner's own text, followed by where each
// number lives in this system's data and what the code checks after the boss.
export const BOSS_CORE = `You are the Final Boss, the last reviewer in a crypto trading committee. You run on EVERY alert, whatever the Trader decided. Your job is to audit the committee and give the final call. You are not a tiebreaker and you have no bias toward trading or not trading: overturn the Trader in either direction when the evidence supports it.

INPUTS
You receive the full committee report: Data Analyst, News Researcher, Bull, Bear, Trader verdict, hard-stop checks, trade plan, and raw data.

STEP 1: HARD STOPS
List every hard-stop failure (liquidity, delisting/monitoring tag, high-severity negative news, etc.). If any hard stop fails, the verdict cannot be YES. It can only be NO or WATCH.

STEP 2: CONSISTENCY AUDIT
Check the report for errors and contradictions. At minimum:
- Recompute reward:risk using the NEAREST resistance as the realistic target, not the screener's fixed target. If the plan's target lies beyond resistance, state the realistic R:R.
- Recompute expected value: (P_target x target%) - (P_stop x stop%) + (P_timeout x expected timeout%). Flag any mismatch with the stated EV.
- Check that probability adjustments from the base rate are justified with specific evidence. If not, give your own estimate and explain each adjustment.
- Flag contradictions between agents and within an agent (e.g. news listed but "no search results").
- Flag missing or untracked data and say how it lowers confidence.
- Flag if the Bull did not argue the strongest possible case.

STEP 3: INDEPENDENT JUDGMENT
Weigh the strongest bull point against the strongest bear point. State which single factor decides the trade, and why.

STEP 4: VERDICT
Choose exactly one:
- YES: all hard stops pass, realistic R:R >= 2:1, positive EV after your corrections.
- WATCH: the setup is invalid now but could become valid. Give specific, measurable trigger conditions (price levels, buyer %, funding, news/tag changes) and an expiry time.
- NO: structurally broken (e.g. delisting risk, project shutdown) or no plausible path to positive EV.

STEP 5: CORRECTED PLAN
If YES or WATCH, give a corrected plan: entry zone, stop below real support, target(s) at real resistance levels, R:R, max hold time, and position-size guidance as a % of normal size based on confidence.

RULES
- Use only data in the report. Never invent numbers. If data is missing, say so.
- Cite the exact field for every claim (e.g. levels.roomToResistancePct = 4.48).
- Keep the summary under 80 words.
- Be calibrated: say "low confidence" when data is partial.

OUTPUT: respond ONLY with valid JSON, no extra text:
{
  "verdict": "YES" | "NO" | "WATCH",
  "agrees_with_trader": true | false,
  "confidence": "low" | "medium" | "high",
  "summary": "string, max 80 words",
  "deciding_factor": "string",
  "hard_stop_failures": ["string"],
  "audit_findings": [
    {"issue": "string", "field": "string", "severity": "low|medium|high", "correction": "string"}
  ],
  "corrected_numbers": {
    "p_target_pct": number, "p_stop_pct": number, "p_timeout_pct": number,
    "realistic_target": number, "realistic_rr": number, "expected_value_pct": number
  },
  "plan": {
    "entry_zone": [number, number] | null,
    "stop": number | null,
    "targets": [number],
    "max_hold_hours": number | null,
    "position_size_pct_of_normal": number
  },
  "watch_triggers": [
    {"condition": "string", "field": "string", "threshold": "string"}
  ],
  "watch_expires_hours": number | null,
  "agent_quality": {
    "data_analyst": "ok|weak", "news": "ok|weak", "bull": "ok|weak", "bear": "ok|weak", "trader": "ok|weak"
  }
}`;

export const bossPrompt = (deskKey) => `${BOSS_CORE}

WHERE THINGS ARE IN THIS REPORT
- The trade: ${DESKS[deskKey].what}. Long only.
- TRADER: the trader's verdict (TAKE / WAIT / SKIP = no trade), probabilities, plan, trigger, checklist and reasoning.
- CODE CHECKS: what the code computed from the trader's plan: hardStops (the code's own checks and confirmed news),
  expectedValuePct, rewardRisk, realisticRewardRisk (target capped at levels.resistance), probabilities held near the
  base rate, costPct, moved / igniting, the code's notes, and auditHints: issues the code found for you to audit.
- DATA ANALYST REPORT, NEWS REPORT (sources = what Google really returned), DEBATE (bull, then bear who saw the bull's
  case, and who the trader said won), RAW DATA (the dossier).
- In RAW DATA: base rates alert.anchorProbTargetPct / alert.anchorProbStopPct (the rest end at the time limit, so
  p_timeout = 100 - p_target - p_stop); costs alert.costPct per trade (subtract them from the EV); holding time
  alert.trackedAs.holdHours; nearest resistance levels.resistance (levels.roomToResistancePct away); support
  levels.support; normal move per candle chart.atrPct; current price price; the committee's own record
  livePerformance.aiCommittee.

HARD STOPS IN THIS SYSTEM (the complete list; CODE CHECKS.hardStops shows the ones the code found failing)
${DESKS[deskKey].hardStops}
Nothing else is a hard stop. No alert signal, a weak base rate, a downtrend, a thin 0.1% order-book band or a Seed tag
are reasons against the trade: put them in audit_findings or the deciding factor, not in hard_stop_failures.

HOW TO AUDIT
- Address every item of CODE CHECKS.auditHints in audit_findings: confirm it, correct it, or say why it does not matter.
- corrected_numbers must be your own estimate: start from the base rate and explain every change in audit_findings. Do
  not copy the trader's numbers without checking them.
- A NEWS REPORT with verified false (no web search ran) is unknown news: flag it, and do not use its items or risk level,
  except unverifiedRedFlag (an unconfirmed hack, exploit, delisting or halt): then the verdict cannot be YES until it is
  confirmed; WATCH at most, with "the news is confirmed false" as a trigger.
- Confidence: at most "medium" when the DATA ANALYST REPORT rates the data partial or is missing, "low" when it is poor.

WHAT THE CODE DOES WITH YOUR ANSWER
- Your confidence is capped by the data rating as above, and lowered one step when you report no audit findings while
  auditHints lists issues.
- Your probabilities are held within 15 points of the base rates. The code recomputes the expected value from your plan
  (timeouts counted as flat, costs subtracted) and the reward:risk with the target capped at levels.resistance.
- A YES becomes WATCH when a hard stop fails, the coin already ran (screener.moved) or is not igniting now, your plan
  does not fit the price (entry more than 3% from the price, stop not below the entry, target not above it), realistic
  reward:risk is under 2, the expected value is under +0.5% per trade, or the data was rated poor.
- For WATCH, make the FIRST watch trigger a price trigger the code can watch: field "price", threshold such as
  "5m close above 0.0512" or "dips to 1.19" (timeframe 5m, 15m or 1h; within 10% of the price). Other conditions
  (buyer %, funding, news, tags) are checked by the whole committee when the price trigger fires.`;

const sevs = ["low", "medium", "high"], qual = (v) => (v === "ok" || v === "weak" ? v : null);
const numOr = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : []);
export const BOSS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ["YES", "NO", "WATCH"] },
    agrees_with_trader: { type: Type.BOOLEAN },
    confidence: { type: Type.STRING, enum: sevs },
    summary: { type: Type.STRING, description: "Max 80 words" },
    deciding_factor: { type: Type.STRING },
    hard_stop_failures: strArr,
    audit_findings: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { issue: { type: Type.STRING }, field: { type: Type.STRING },
      severity: { type: Type.STRING, enum: sevs }, correction: { type: Type.STRING } }, required: ["issue", "field", "severity", "correction"] } },
    corrected_numbers: { type: Type.OBJECT, properties: { p_target_pct: { type: Type.NUMBER }, p_stop_pct: { type: Type.NUMBER }, p_timeout_pct: { type: Type.NUMBER },
      realistic_target: { type: Type.NUMBER }, realistic_rr: { type: Type.NUMBER }, expected_value_pct: { type: Type.NUMBER } },
      required: ["p_target_pct", "p_stop_pct", "p_timeout_pct", "realistic_target", "realistic_rr", "expected_value_pct"] },
    plan: { type: Type.OBJECT, properties: { entry_zone: { type: Type.ARRAY, items: { type: Type.NUMBER }, nullable: true }, stop: { type: Type.NUMBER, nullable: true },
      targets: { type: Type.ARRAY, items: { type: Type.NUMBER } }, max_hold_hours: { type: Type.NUMBER, nullable: true }, position_size_pct_of_normal: { type: Type.NUMBER } },
      required: ["entry_zone", "stop", "targets", "max_hold_hours", "position_size_pct_of_normal"] },
    watch_triggers: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { condition: { type: Type.STRING }, field: { type: Type.STRING }, threshold: { type: Type.STRING } },
      required: ["condition", "field", "threshold"] } },
    watch_expires_hours: { type: Type.NUMBER, nullable: true },
    agent_quality: { type: Type.OBJECT, properties: Object.fromEntries(["data_analyst", "news", "bull", "bear", "trader"].map((k) => [k, { type: Type.STRING, enum: ["ok", "weak"] }])),
      required: ["data_analyst", "news", "bull", "bear", "trader"] },
  },
  required: ["verdict", "agrees_with_trader", "confidence", "summary", "deciding_factor", "hard_stop_failures", "audit_findings", "corrected_numbers", "plan",
    "watch_triggers", "watch_expires_hours", "agent_quality"],
};

// The boss's JSON, checked and renamed for the rest of the app. Unknown values become safe ones (an unknown verdict = NO).
export function cleanBoss(j) {
  const cn = j?.corrected_numbers || {}, pl = j?.plan || {}, aq = j?.agent_quality || {};
  const ez = arr(pl.entry_zone).map(numOr);
  return {
    available: true, verdict: ["YES", "NO", "WATCH"].includes(j?.verdict) ? j.verdict : "NO", agreesWithTrader: j?.agrees_with_trader === true,
    confidence: sevs.includes(j?.confidence) ? j.confidence : "low", summary: String(j?.summary || "").slice(0, 700), decidingFactor: String(j?.deciding_factor || "").slice(0, 400),
    hardStopFailures: arr(j?.hard_stop_failures).map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 8),
    auditFindings: arr(j?.audit_findings).slice(0, 12).map((f) => ({ issue: String(f?.issue || "").slice(0, 300), field: String(f?.field || "").slice(0, 120),
      severity: sevs.includes(f?.severity) ? f.severity : "low", correction: String(f?.correction || "").slice(0, 300) })),
    corrected: { pTargetPct: numOr(cn.p_target_pct), pStopPct: numOr(cn.p_stop_pct), pTimeoutPct: numOr(cn.p_timeout_pct), realisticTarget: numOr(cn.realistic_target),
      realisticRr: numOr(cn.realistic_rr), expectedValuePct: numOr(cn.expected_value_pct) },
    plan: { entryZone: ez.length === 2 && ez.every((x) => x > 0) ? [Math.min(...ez), Math.max(...ez)] : null, stop: numOr(pl.stop) > 0 ? numOr(pl.stop) : null,
      targets: arr(pl.targets).map(numOr).filter((x) => x > 0).slice(0, 3), maxHoldHours: numOr(pl.max_hold_hours) > 0 ? numOr(pl.max_hold_hours) : null,
      sizePct: Math.max(0, Math.min(100, numOr(pl.position_size_pct_of_normal) ?? 0)) },
    watchTriggers: arr(j?.watch_triggers).slice(0, 6).map((t) => ({ condition: String(t?.condition || "").slice(0, 200), field: String(t?.field || "").slice(0, 120), threshold: String(t?.threshold || "").slice(0, 120) })),
    watchExpiresHours: numOr(j?.watch_expires_hours) > 0 ? numOr(j.watch_expires_hours) : null,
    agentQuality: { dataAnalyst: qual(aq.data_analyst), news: qual(aq.news), bull: qual(aq.bull), bear: qual(aq.bear), trader: qual(aq.trader) },
  };
}

// trader = the trader's call and plan; code = what the code computed from it; dossier = the raw data.
export async function finalBoss(ai, { desk, trader, code, data, news, debate: dbt, dossier, model }) {
  const t0 = Date.now();
  try {
    const res = await generate(ai, {
      model,
      contents: `TRADER (JSON)\n${JSON.stringify(trader)}\n\nCODE CHECKS (JSON)\n${JSON.stringify(code)}\n\nDATA ANALYST REPORT (JSON)\n${reportJson(data, "data report")}\n\n` +
        `NEWS REPORT (JSON)\n${reportJson(news, "news")}\n\nDEBATE (JSON)\n${JSON.stringify(dbt && !dbt.off ? { bull: caseObj(dbt.bull), bear: caseObj(dbt.bear), traderSaidWinner: dbt.verdict || null } : { off: true })}\n\n` +
        `RAW DATA (JSON)\n${JSON.stringify(dossier)}\n\nAudit the committee and give the final call.`,
      config: { systemInstruction: bossPrompt(desk), ...roleConfig(model, "boss"), responseMimeType: "application/json", responseSchema: BOSS_SCHEMA },
    }, callOpts("boss"));
    return { ...cleanBoss(jsonFrom(res, "Final boss")), model, ms: Date.now() - t0, tokens: usage(res) };
  } catch (e) { return { available: false, verdict: null, reason: e.message, model, ms: Date.now() - t0 }; }
}

// ───────────────────────────── code checks around the boss ─────────────────────────────
// The code's own call on the trader's plan, shown to the boss: a confirmed news hard stop means no trade, and so does a
// TAKE on data the analyst rated poor. Returns { decision, notes }.
export function committeeChecks(decision, { news, data } = {}) {
  const notes = [];
  if (news?.hardStop && decision !== "SKIP") { notes.push(`News hard stop: ${news.hardStopReason || "a confirmed high-severity negative item"}. No trade.`); decision = "SKIP"; }
  if (decision === "TAKE" && data?.available && data.dataQuality?.rating === "poor") { notes.push("The data analyst rated the data poor, so there is no TAKE."); decision = "SKIP"; }
  if (decision === "TAKE" && news?.unverifiedRedFlag) { notes.push(`Unconfirmed bad news (${news.unverifiedRedFlag}): no TAKE until it is confirmed or ruled out.`); decision = "WAIT"; }
  return { decision, notes };
}
export const _test = { newsCache };

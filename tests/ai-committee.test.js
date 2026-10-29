// The AI committee (ai-committee.js + ai-trade.js runCommittee) with a fake Gemini client: each member gets its own
// prompt and thinking depth, news sources come from Google's grounding data, the bear answers the bull, the trader
// judges the debate, the code checks the trader, and only the final boss's YES makes a TAKE. No network, no API key.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SCREENER_LIBRARY_ONLY = "1"; // load the screener's logic without starting it
const cm = await import("../ai-committee.js");
const desk = await import("../ai-trade.js");

const ROLE = /^You are the (DATA ANALYST|NEWS RESEARCHER|BULL|BEAR|TRADER|CHIEF RISK OFFICER)/;
const GROUNDING = { webSearchQueries: ["ABC token news"], groundingChunks: [{ web: { uri: "https://www.binance.com/en/support/announcement/x", title: "binance.com" } }] };
// answers: { "DATA ANALYST": {...} | Error, "NEWS RESEARCHER": ..., TRADER: ..., "CHIEF RISK OFFICER": ... }
function fakeAi(answers) {
  const calls = [];
  return { calls, models: { generateContent: async (params) => {
    const role = (String(params.config.systemInstruction).match(ROLE) || [])[1] || "?";
    calls.push({ role, params });
    const a = answers[role];
    if (a instanceof Error) throw a;
    return { text: typeof a === "string" ? a : JSON.stringify(a), candidates: [{ groundingMetadata: role === "NEWS RESEARCHER" ? GROUNDING : undefined }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: role === "TRADER" || role === "CHIEF RISK OFFICER" ? 500 : 10 } };
  } } };
}
const alert = desk.alertContext("confirmed");
const dossier = (symbol = "ABCUSDT") => ({ symbol, price: 100, alert, screener: { state: "ignited", tier: "confirmed", moved: false }, dataQuality: { demo: false, notes: [] },
  market: { btc1hPct: 0.2, btc4hPct: 0.5 }, chart: { trend4h: { state: "uptrend" }, atrPct: { "1h": 0.8 } }, levels: { roomToResistancePct: 8 },
  marketFlow: { available: true, buyRatio5mPct: 62, netFlow5mUsd: 5000 }, orderBook: { spreadBps: 4, bands: [{ withinPct: 1, bidUsd: 90_000, askUsd: 70_000 }] },
  referencePlan: { entryZone: [99.8, 100], stops: { screenerRule: 97 }, targets: { screenerRule: 106, nearResistance: 104 } } });
const DATA = { dataQuality: { rating: "good", issues: [] }, areas: [{ area: "buying", reading: "supports", evidence: ["marketFlow.buyRatio5mPct = 62"], note: "buyers in control" }],
  conflicts: [], redFlags: [], keyNumbers: ["marketFlow.buyRatio5mPct = 62: buyers in control"], summary: "Clean ignition with buyers in control." };
const NEWS = { summary: "No relevant news.", overall: "none", riskLevel: "none", hardStop: false, hardStopReason: "", items: [], upcoming: [] };
const trader = (decision) => ({ decision, hardStops: [], checklist: [{ item: "news", status: "pass", evidence: "no relevant news found" }], probTargetPct: 40, probStopPct: 30,
  probReason: "volume and buyers", confidence: "high", setupScore: 8, headline: "Clean breakout", thesis: "t", bullishPoints: ["b"], bearishPoints: ["r"],
  plan: { entryLow: 99.8, entryHigh: 100, stop: 97, target1: 106, holdHours: 12 }, waitFor: decision === "WAIT" ? "5m close above 101 within 30 minutes" : "", invalidation: "below 97", keyRisk: "BTC" });
const BULL = { strength: 7, thesis: "Buyers in control with room to run.", points: [{ point: "buyers in control", evidence: "marketFlow.buyRatio5mPct = 62" }],
  path: "holds 99.8, runs to 106", redFlagAnswers: [], weakestPoint: "early in the move", wouldChangeMyMind: "buyers under 50%" };
const BEAR = { strength: 4, thesis: "Most confirmed ignitions still fail.", rebuttals: [{ bullPoint: "buyers in control", verdict: "holds", evidence: "62%" }],
  points: [{ point: "base rate", evidence: "alert.anchorProbStopPct" }], path: "fades back under 97", weakestPoint: "no seller signal", wouldChangeMyMind: "a 4h downtrend" };
const BOSS_YES = { verdict: "YES", reason: "All six tests pass.", biggestRisk: "BTC turns", mustBeTrue: "exit if buyers drop under 50%", checks: [{ test: "stop", pass: true, note: "3.7x ATR" }] };
const run = (ai, d = dossier(), opts = {}) => {
  cm._test.newsCache.clear();
  return desk.runCommittee(ai, d, { desk: "spot", rules: "RULES: decide carefully.", identity: { symbol: d.symbol.replace(/USDT$/, ""), name: "Abc Protocol" },
    keyFacts: (x) => ({ price: x.price, atrPct: x.chart.atrPct }), opts: { model: "trader-model", reviewModel: "boss-model", news: true, debate: true, ...opts } });
};

test("AI committee: every member gets its own prompt; the bear answers the bull; a TAKE needs the final boss's YES", async () => {
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": "```json\n" + JSON.stringify(NEWS) + "\n```", BULL, BEAR,
    TRADER: { ...trader("TAKE"), debate: { winner: "bull", reason: "the bear's only point is the base rate" } }, "CHIEF RISK OFFICER": BOSS_YES });
  const x = await run(ai);
  assert.equal(x.decision, "TAKE"); assert.equal(x.final, "YES");
  // the analyst and the researcher first (together), then the bull, the bear, the trader and the boss, in that order
  assert.deepEqual(ai.calls.slice(2).map((c) => c.role), ["BULL", "BEAR", "TRADER", "CHIEF RISK OFFICER"]);
  assert.deepEqual(ai.calls.slice(0, 2).map((c) => c.role).sort(), ["DATA ANALYST", "NEWS RESEARCHER"]);
  const by = Object.fromEntries(ai.calls.map((c) => [c.role, c.params]));
  assert.deepEqual(by["NEWS RESEARCHER"].config.tools, [{ googleSearch: {} }]);             // the researcher searches the web
  assert.equal(by["NEWS RESEARCHER"].config.responseSchema, undefined);                    // (search and a JSON schema do not mix)
  assert.ok(by["DATA ANALYST"].config.responseSchema && by["CHIEF RISK OFFICER"].config.responseSchema);
  assert.equal(by.TRADER.model, "trader-model"); assert.equal(by["CHIEF RISK OFFICER"].model, "boss-model");
  assert.match(by.TRADER.contents, /DATA ANALYST REPORT[\s\S]*Clean ignition[\s\S]*NEWS REPORT[\s\S]*No relevant news[\s\S]*BULL'S CASE[\s\S]*room to run[\s\S]*BEAR'S CASE[\s\S]*Most confirmed/);
  assert.match(by.BULL.contents, /DATA ANALYST REPORT[\s\S]*NEWS REPORT/); assert.doesNotMatch(by.BULL.contents, /BULL'S CASE/);
  assert.match(by.BEAR.contents, /BULL'S CASE \(JSON\)\n\{"strength":7/);                         // the bear sees the bull's case
  assert.ok(by.TRADER.config.responseSchema.required.includes("debate"));                          // the trader must name the winner
  assert.match(by.TRADER.config.systemInstruction, /THE DEBATE: [\s\S]*The bear spoke last; that is not a reason to agree/);
  assert.match(by["CHIEF RISK OFFICER"].contents, /DEBATE \(JSON\)\n\{"bull":\{"strength":7[\s\S]*"traderVerdict":\{"winner":"bull"/);
  assert.equal(x.committee.debate.verdict.winner, "bull"); assert.equal(x.committee.debate.bear.strength, 4);
  assert.match(by["CHIEF RISK OFFICER"].contents, /TRADE \(JSON\)[\s\S]*"expectedValuePct":[\d.]+[\s\S]*KEY FACTS/); // the boss sees the EV the code recomputed
  assert.equal(x.committee.news.sources[0].url, GROUNDING.groundingChunks[0].web.uri);
  assert.equal(x.committee.boss.asked, true); assert.equal(x.committee.data.dataQuality.rating, "good");
  assert.match(desk.tgSingle({ ...x, symbol: "ABCUSDT" }), /Final: YES · data good · news none risk · bull 7 vs bear 4, bull won · trader TAKE · boss YES/);
});

test("AI committee: model settings per role (Gemini 3 thinking levels, Gemini 2.5 budgets, plain temperature otherwise)", async () => {
  const { ThinkingLevel } = await import("@google/genai");
  assert.deepEqual(cm.roleConfig("gemini-3.1-pro-preview", "boss", {}), { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } }); // no temperature on Gemini 3
  assert.deepEqual(cm.roleConfig("gemini-3.5-flash", "data", {}), { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } });
  assert.deepEqual(cm.roleConfig("gemini-3.5-flash", "trader", { AI_DEEP_THINKING: "0" }), { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } });
  assert.deepEqual(cm.roleConfig("gemini-2.5-pro", "trader", {}), { temperature: 0.2, thinkingConfig: { thinkingBudget: 8192 } });
  assert.deepEqual(cm.roleConfig("gemini-2.5-flash", "bear", {}), { temperature: 0.4, thinkingConfig: { thinkingBudget: 1024 } });
  assert.deepEqual(cm.roleConfig("my-tuned-model", "news", {}), { temperature: 0.1 });
  // in a run: quick members think "low", the trader and the boss "high"; tokens are counted per member
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("TAKE"), "CHIEF RISK OFFICER": BOSS_YES });
  cm._test.newsCache.clear();
  const x = await desk.runCommittee(ai, dossier(), { desk: "spot", rules: "R", identity: { symbol: "ABC" }, keyFacts: () => ({}),
    opts: { model: "gemini-3.5-flash", reviewModel: "gemini-3.1-pro-preview" } });
  const lvl = Object.fromEntries(ai.calls.map((c) => [c.role, c.params.config.thinkingConfig?.thinkingLevel]));
  assert.deepEqual(lvl, { "DATA ANALYST": "LOW", "NEWS RESEARCHER": "LOW", BULL: "LOW", BEAR: "LOW", TRADER: "HIGH", "CHIEF RISK OFFICER": "HIGH" });
  assert.ok(ai.calls.every((c) => c.params.config.temperature === undefined));
  assert.deepEqual(x.committee.trader.tokens, { in: 1000, out: 100, think: 500 });
});

test("AI committee: the final boss's NO, or no answer, means no TAKE; a WAIT never reaches the boss", async () => {
  const no = await run(fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("TAKE"),
    "CHIEF RISK OFFICER": { ...BOSS_YES, verdict: "NO", reason: "The stop sits inside normal noise." } }));
  assert.equal(no.decision, "SKIP"); assert.equal(no.final, "NO"); assert.equal(no.modelDecision, "TAKE");
  assert.ok(no.guardNotes.some((n) => /Final boss said NO: The stop sits inside normal noise/.test(n)));
  const silent = await run(fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("TAKE"), "CHIEF RISK OFFICER": new Error("model not found") }));
  assert.equal(silent.decision, "WAIT"); assert.equal(silent.final, "NO"); assert.equal(silent.committee.boss.available, false);
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("WAIT") });
  const wait = await run(ai);
  assert.equal(wait.decision, "WAIT"); assert.equal(wait.final, "NO"); assert.equal(wait.committee.boss.asked, false);
  assert.ok(!ai.calls.some((c) => c.role === "CHIEF RISK OFFICER"));
});

test("AI committee: a confirmed bad news item is a hard stop; poor data is no TAKE; a failed member is unknown, not good", async () => {
  const bad = { ...NEWS, overall: "negative", riskLevel: "high", hardStop: true, hardStopReason: "Binance adds ABC to the monitoring tag",
    items: [{ date: "2026-10-28", title: "Binance monitoring tag", type: "exchange", impact: "negative", severity: "high", pricedIn: "no", source: "Binance" }] };
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": bad, BULL, BEAR, TRADER: trader("TAKE") });
  const x = await run(ai);
  assert.equal(x.decision, "SKIP"); assert.ok(x.hardStops.some((h) => /monitoring tag/.test(h)));
  assert.ok(!ai.calls.some((c) => c.role === "CHIEF RISK OFFICER"));
  const poor = await run(fakeAi({ "DATA ANALYST": { ...DATA, dataQuality: { rating: "poor", issues: [{ field: "marketFlow", problem: "missing" }] } }, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("TAKE") }));
  assert.equal(poor.decision, "SKIP"); assert.ok(poor.guardNotes.some((n) => /rated the data poor/.test(n)));
  // the analyst and the bull fail, news is switched off: the bear and the trader still work, and are told what is unknown
  const ai2 = fakeAi({ "DATA ANALYST": new Error("quota"), BULL: new Error("busy"), BEAR, TRADER: { ...trader("WAIT"), debate: { winner: "bear", reason: "no bull case" } } });
  const y = await run(ai2, dossier("XYZUSDT"), { news: false });
  assert.equal(y.decision, "WAIT"); assert.equal(y.committee.data.available, false); assert.equal(y.committee.news.off, true);
  assert.equal(y.committee.debate.bull.available, false); assert.equal(y.committee.debate.bear.available, true);
  const tc = ai2.calls.find((c) => c.role === "TRADER").params.contents;
  assert.match(tc, /DATA ANALYST REPORT \(JSON\)\n\{"available":false,"note":"quota"\}/); assert.match(tc, /BULL'S CASE \(JSON\)\n\{"available":false,"note":"busy"\}/);
  assert.ok(!ai2.calls.some((c) => c.role === "NEWS RESEARCHER"));
  // the debate switched off: no bull or bear, and the trader is not asked to judge one
  const ai3 = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, TRADER: trader("WAIT") });
  const z = await run(ai3, dossier("QRSUSDT"), { debate: false });
  assert.deepEqual(ai3.calls.map((c) => c.role).sort(), ["DATA ANALYST", "NEWS RESEARCHER", "TRADER"]);
  const t3 = ai3.calls.find((c) => c.role === "TRADER").params;
  assert.ok(!t3.config.responseSchema.required.includes("debate")); assert.doesNotMatch(t3.config.systemInstruction, /THE DEBATE/);
  assert.equal(z.committee.debate.off, true);
});

test("AI committee: news report is cleaned; a hard stop counts only when a search backs it; news is cached per coin", async () => {
  const chunks = { webSearchQueries: ["q"], groundingChunks: [{ web: { uri: "https://a.com/x", title: "A" } }, { web: { uri: "https://a.com/x", title: "A" } }, { web: { uri: "https://b.com", title: "B" } }] };
  const n = cm.cleanNews(JSON.stringify({ ...NEWS, hardStop: true, hardStopReason: "exploit", items: [{ date: "2026-10-28T10:00", title: "t", impact: "awful", severity: "huge", pricedIn: "maybe" }] }), chunks);
  assert.equal(n.available, true); assert.equal(n.sources.length, 2); assert.equal(n.hardStop, true);
  assert.deepEqual([n.items[0].date, n.items[0].impact, n.items[0].severity, n.items[0].pricedIn], ["2026-10-28", "neutral", "low", "unclear"]);
  const unbacked = cm.cleanNews(JSON.stringify({ hardStop: true, riskLevel: "extreme" }), {});
  assert.equal(unbacked.hardStop, false); assert.equal(unbacked.unverifiedHardStop, true); assert.equal(unbacked.riskLevel, "none");
  assert.equal(cm.cleanNews('Report: {"summary":"ok","overall":"none","riskLevel":"low","hardStop":false,"items":[]} end.', chunks).riskLevel, "low");
  assert.equal(cm.cleanNews("Sorry, I could not search.", null).available, false);
  cm._test.newsCache.clear();
  const ai = fakeAi({ "NEWS RESEARCHER": NEWS });
  const id = { symbol: "QQQ", name: "Q coin" };
  await cm.newsResearch(ai, { identity: id, holdHours: 12, model: "m" });
  const again = await cm.newsResearch(ai, { identity: id, holdHours: 12, model: "m" });
  assert.equal(again.cached, true); assert.equal(ai.calls.length, 1);
  assert.equal((await cm.newsResearch(fakeAi({ "NEWS RESEARCHER": new Error("down") }), { identity: { symbol: "ZZZ" }, holdHours: 12, model: "m" })).available, false);
});

test("AI committee: prompts name the coin, the time window and each member's job; Telegram shows the votes", () => {
  const np = cm.newsResearcherPrompt({ symbol: "ABC", name: "Abc Protocol", chain: "BSC", contract: "0xabc" }, 168, new Date("2026-10-29T12:00:00Z"));
  assert.match(np, /Today is 2026-10-29 12:00 UTC/); assert.match(np, /BUYING ABC \(Abc Protocol\) on BSC, contract 0xabc and holding it for up to 168 hours/);
  assert.match(np, /no relevant news" is a valid/);
  assert.match(cm.dataAnalystPrompt(cm.DESKS.alpha), /You do NOT decide[\s\S]*DEX buying/);
  assert.match(cm.traderPrompt("spot", "MY RULES"), /MY RULES[\s\S]*Add a checklist item "news"/);
  assert.match(cm.bullPrompt("alpha"), /BULL[\s\S]*Binance Alpha token[\s\S]*most are 3-6/);
  assert.match(cm.bearPrompt("spot"), /You also receive the BULL'S CASE[\s\S]*REBUTTALS/);
  assert.match(cm.bossPrompt("spot"), /When in doubt, NO[\s\S]*the bear's path to the stop[\s\S]*YES only if all six pass/);
  const x = { symbol: "ABCUSDT", decision: "SKIP", final: "NO", headline: "h", probTargetPct: 40, probStopPct: 30, expectedValuePct: 1.2, confidence: "medium", setupScore: 7,
    plan: { entryLow: 1, entryHigh: 1.01, stop: 0.97, stopPct: -3, target1: 1.06, target1Pct: 6, rewardRisk: 2, holdHours: 12 }, hardStops: [], keyRisk: "k",
    committee: { data: { available: true, dataQuality: { rating: "good" } }, news: { available: true, riskLevel: "low", summary: "Listing on Coinbase next week.", items: [{}] },
      trader: { decision: "TAKE" }, boss: { asked: true, available: true, verdict: "NO", reason: "Target beyond the 7-day high." } } };
  const t = desk.tgSingle(x);
  assert.match(t, /Final: NO · data good · news low risk · trader TAKE · boss NO\nBoss: Target beyond the 7-day high\./);
  assert.match(t, /News: Listing on Coinbase next week\./);
});

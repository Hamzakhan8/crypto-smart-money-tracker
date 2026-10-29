// The AI committee (ai-committee.js + ai-trade.js runCommittee) with a fake Gemini client: each member gets its own
// prompt and thinking depth, news sources come from Google's grounding data, the bear answers the bull, the trader
// judges the debate, the code checks the trader, and the Final Boss audits every analysis and gives the final YES / WATCH /
// NO, which the code still checks. No network, no API key.
import test from "node:test";
import assert from "node:assert/strict";

process.env.SCREENER_LIBRARY_ONLY = "1"; // load the screener's logic without starting it
const cm = await import("../ai-committee.js");
const desk = await import("../ai-trade.js");

const ROLE = /^You are the (DATA ANALYST|NEWS RESEARCHER|BULL|BEAR|TRADER|Final Boss)/;
const GROUNDING = { webSearchQueries: ["ABC token news"], groundingChunks: [{ web: { uri: "https://www.binance.com/en/support/announcement/x", title: "binance.com" } }] };
// answers: { "DATA ANALYST": {...} | Error, "NEWS RESEARCHER": ..., TRADER: ..., "Final Boss": ... }
function fakeAi(answers, { grounding = GROUNDING } = {}) {
  const calls = [];
  return { calls, models: { generateContent: async (params) => {
    const role = (String(params.config.systemInstruction).match(ROLE) || [])[1] || "?";
    calls.push({ role, params });
    const a = answers[role];
    if (a instanceof Error) throw a;
    return { text: typeof a === "string" ? a : JSON.stringify(a), candidates: [{ groundingMetadata: role === "NEWS RESEARCHER" ? grounding : undefined }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: role === "TRADER" || role === "Final Boss" ? 500 : 10 } };
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
// The Final Boss's answer in the owner's JSON shape.
const boss = (verdict, o = {}) => ({ verdict, agrees_with_trader: true, confidence: "medium", summary: "Clean ignition; resistance far away.", deciding_factor: "marketFlow.buyRatio5mPct = 62",
  hard_stop_failures: [], audit_findings: [{ issue: "EV ignores time-outs", field: "expectedValuePct", severity: "low", correction: "1.2 -> 1.1" }],
  corrected_numbers: { p_target_pct: 40, p_stop_pct: 30, p_timeout_pct: 30, realistic_target: 106, realistic_rr: 2.1, expected_value_pct: 1.2 },
  plan: { entry_zone: [100, 99.8], stop: 97, targets: [106], max_hold_hours: 12, position_size_pct_of_normal: 75 }, watch_triggers: [], watch_expires_hours: null,
  agent_quality: { data_analyst: "ok", news: "ok", bull: "weak", bear: "ok", trader: "ok" }, ...o });
const BOSS_YES = boss("YES");
// The app's own news search, off in tests (no network): as if Google News and Binance did not answer.
const NO_APP_SEARCH = async () => ({ ok: false, query: null, results: [], errors: ["no network in tests"] });
const run = (ai, d = dossier(), opts = {}) => {
  cm._test.newsCache.clear();
  return desk.runCommittee(ai, d, { desk: "spot", rules: "RULES: decide carefully.", identity: { symbol: d.symbol.replace(/USDT$/, ""), name: "Abc Protocol" },
    opts: { model: "trader-model", reviewModel: "boss-model", news: true, debate: true, newsSearch: NO_APP_SEARCH, ...opts } });
};

test("AI committee: every member gets its own prompt; the bear answers the bull; the Final Boss audits it all", async () => {
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": "```json\n" + JSON.stringify(NEWS) + "\n```", BULL, BEAR,
    TRADER: { ...trader("TAKE"), debate: { winner: "bull", reason: "the bear's only point is the base rate" } }, "Final Boss": BOSS_YES });
  const x = await run(ai);
  assert.equal(x.decision, "TAKE"); assert.equal(x.final, "YES");
  // the analyst and the researcher first (together), then the bull, the bear, the trader and the boss, in that order
  assert.deepEqual(ai.calls.slice(2).map((c) => c.role), ["BULL", "BEAR", "TRADER", "Final Boss"]);
  assert.deepEqual(ai.calls.slice(0, 2).map((c) => c.role).sort(), ["DATA ANALYST", "NEWS RESEARCHER"]);
  const by = Object.fromEntries(ai.calls.map((c) => [c.role, c.params]));
  assert.deepEqual(by["NEWS RESEARCHER"].config.tools, [{ googleSearch: {} }]);             // the researcher searches the web
  assert.equal(by["NEWS RESEARCHER"].config.responseSchema, undefined);                    // (search and a JSON schema do not mix)
  assert.ok(by["DATA ANALYST"].config.responseSchema && by["Final Boss"].config.responseSchema);
  assert.equal(by.TRADER.model, "trader-model"); assert.equal(by["Final Boss"].model, "boss-model");
  assert.match(by.TRADER.contents, /DATA ANALYST REPORT[\s\S]*Clean ignition[\s\S]*NEWS REPORT[\s\S]*No relevant news[\s\S]*BULL'S CASE[\s\S]*room to run[\s\S]*BEAR'S CASE[\s\S]*Most confirmed/);
  assert.match(by.BULL.contents, /DATA ANALYST REPORT[\s\S]*NEWS REPORT/); assert.doesNotMatch(by.BULL.contents, /BULL'S CASE/);
  assert.match(by.BEAR.contents, /BULL'S CASE \(JSON\)\n\{"strength":7/);                         // the bear sees the bull's case
  assert.ok(by.TRADER.config.responseSchema.required.includes("debate"));                          // the trader must name the winner
  assert.match(by.TRADER.config.systemInstruction, /THE DEBATE: [\s\S]*The bear spoke last; that is not a reason to agree/);
  assert.match(by["Final Boss"].contents, /DEBATE \(JSON\)\n\{"bull":\{"strength":7[\s\S]*"traderSaidWinner":\{"winner":"bull"/);
  assert.equal(x.committee.debate.verdict.winner, "bull"); assert.equal(x.committee.debate.bear.strength, 4);
  // the boss gets the full report: the trader, the code's checks (EV and realistic R:R recomputed), every member, the raw data
  assert.match(by["Final Boss"].contents, /^TRADER \(JSON\)[\s\S]*CODE CHECKS \(JSON\)\n\{"decision":"TAKE","hardStops":\[\],"expectedValuePct":[\d.]+[\s\S]*"realisticRewardRisk"[\s\S]*DATA ANALYST REPORT[\s\S]*NEWS REPORT[\s\S]*DEBATE[\s\S]*RAW DATA \(JSON\)\n\{"symbol":"ABCUSDT"/);
  assert.match(by["Final Boss"].config.systemInstruction, /^You are the Final Boss, the last reviewer[\s\S]*STEP 5: CORRECTED PLAN[\s\S]*WHERE THINGS ARE IN THIS REPORT/);
  assert.equal(x.sizePct, 75); assert.deepEqual([x.plan.entryLow, x.plan.entryHigh, x.plan.target1], [99.8, 100, 106]); // the boss's plan (zone sorted)
  assert.equal(x.realistic.rewardRisk, 2.1); assert.equal(x.committee.boss.agentQuality.bull, "weak");
  assert.equal(x.committee.news.sources[0].url, GROUNDING.groundingChunks[0].web.uri);
  assert.equal(x.committee.boss.asked, true); assert.equal(x.committee.data.dataQuality.rating, "good");
  const tg = desk.tgSingle({ ...x, symbol: "ABCUSDT" });
  assert.match(tg, /^🟢 YES: ABC\n[\s\S]*Final: YES · data good · news none risk · bull 7 vs bear 4, bull won · trader TAKE · boss YES\nBoss: Clean ignition/);
  assert.match(tg, /R:R 2.1 \| hold 12h \| size 75% of normal/);
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
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("TAKE"), "Final Boss": BOSS_YES });
  cm._test.newsCache.clear();
  const x = await desk.runCommittee(ai, dossier(), { desk: "spot", rules: "R", identity: { symbol: "ABC" },
    opts: { model: "gemini-3.5-flash", reviewModel: "gemini-3.1-pro-preview", newsSearch: NO_APP_SEARCH } });
  const lvl = Object.fromEntries(ai.calls.map((c) => [c.role, c.params.config.thinkingConfig?.thinkingLevel]));
  assert.deepEqual(lvl, { "DATA ANALYST": "LOW", "NEWS RESEARCHER": "LOW", BULL: "LOW", BEAR: "LOW", TRADER: "HIGH", "Final Boss": "HIGH" });
  assert.ok(ai.calls.every((c) => c.params.config.temperature === undefined));
  assert.deepEqual(x.committee.trader.tokens, { in: 1000, out: 100, think: 500 });
});

test("AI committee: the Final Boss overturns the trader either way; no answer means no YES", async () => {
  const members = { "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR };
  const no = await run(fakeAi({ ...members, TRADER: trader("TAKE"), "Final Boss": boss("NO", { agrees_with_trader: false, summary: "The stop sits inside normal noise." }) }));
  assert.equal(no.decision, "SKIP"); assert.equal(no.final, "NO"); assert.equal(no.modelDecision, "TAKE"); assert.equal(no.committee.boss.agreesWithTrader, false);
  assert.equal(no.sizePct, null);
  // the boss turns a trader WAIT into YES when the code's checks pass
  const up = await run(fakeAi({ ...members, TRADER: trader("WAIT"), "Final Boss": boss("YES", { agrees_with_trader: false }) }));
  assert.equal(up.decision, "TAKE"); assert.equal(up.final, "YES"); assert.equal(up.modelDecision, "WAIT");
  // no answer: the code's own call, never a YES
  const silent = await run(fakeAi({ ...members, TRADER: trader("TAKE"), "Final Boss": new Error("model not found") }));
  assert.equal(silent.decision, "WAIT"); assert.equal(silent.final, "WATCH"); assert.equal(silent.committee.boss.available, false);
  assert.ok(silent.guardNotes.some((n) => /could not answer[\s\S]*never a YES/.test(n)));
  // a YES with the target past the nearest resistance: realistic reward:risk under 2 -> WATCH
  const capped = await run(fakeAi({ ...members, TRADER: trader("TAKE"), "Final Boss": BOSS_YES }), { ...dossier(), levels: { resistance: 102, roomToResistancePct: 2 } });
  assert.equal(capped.final, "WATCH"); assert.equal(capped.realistic.target, 102); assert.ok(capped.realistic.rewardRisk < 2);
  assert.ok(capped.guardNotes.some((n) => /said YES, but the code made it WATCH: realistic reward:risk 0.72 is under 2/.test(n)), capped.guardNotes.join(" | "));
  // a YES while BTC is falling (a code hard stop) -> WATCH
  const btc = await run(fakeAi({ ...members, TRADER: trader("TAKE"), "Final Boss": BOSS_YES }), { ...dossier(), market: { btc1hPct: -1.6, btc4hPct: -2.5 } });
  assert.equal(btc.final, "WATCH"); assert.ok(btc.guardNotes.some((n) => /made it WATCH: hard stop \(BTC falling/.test(n)));
  // the boss's chances are held within 15 points of the base rate
  const greedy = await run(fakeAi({ ...members, TRADER: trader("TAKE"), "Final Boss": boss("YES", { corrected_numbers: { ...BOSS_YES.corrected_numbers, p_target_pct: 90, p_stop_pct: 2 } }) }));
  assert.equal(greedy.probTargetPct, alert.anchorProbTargetPct + 15); assert.ok(greedy.guardNotes.some((n) => /held within 15 points/.test(n)));
  // WATCH: the first price trigger is watched; the other conditions are shown and left to the re-check
  const watch = await run(fakeAi({ ...members, TRADER: trader("TAKE"), "Final Boss": boss("WATCH", { agrees_with_trader: false, watch_expires_hours: 6,
    watch_triggers: [{ condition: "5m close above the 24h high", field: "price", threshold: "5m close above 101.8" }, { condition: "buyers stay strong", field: "marketFlow.buyRatio5mPct", threshold: ">= 55%" }],
    plan: { entry_zone: [101.8, 102.2], stop: 99.5, targets: [108], max_hold_hours: 12, position_size_pct_of_normal: 50 } }) }));
  assert.equal(watch.decision, "WAIT"); assert.equal(watch.final, "WATCH");
  assert.deepEqual(watch.trigger, { event: "breakout", price: 101.8, timeframe: "5m", expiresMinutes: 360, distPct: 1.8 });
  assert.match(watch.waitFor, /5m close above the 24h high \(price 5m close above 101.8\); buyers stay strong \(marketFlow.buyRatio5mPct >= 55%\); within 6 hours/);
  assert.equal(watch.plan.entryLow, 101.8); assert.equal(watch.sizePct, 50); // a WATCH plan may sit at the trigger (within 10%)
  assert.match(desk.tgSingle({ ...watch, symbol: "ABCUSDT" }), /^🟡 WATCH: ABC[\s\S]*Watch for: 5m close above[\s\S]*Plan if it triggers: entry 101.8-102.2 \| stop 99.5 \| target 108 \| size 50% of normal/);
});

test("AI committee: a confirmed bad news item is a hard stop; poor data is no TAKE; a failed member is unknown, not good", async () => {
  const bad = { ...NEWS, overall: "negative", riskLevel: "high", hardStop: true, hardStopReason: "Binance adds ABC to the monitoring tag",
    items: [{ date: "2026-10-28", title: "Binance monitoring tag", type: "exchange", impact: "negative", severity: "high", pricedIn: "no", source: "Binance" }] };
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": bad, BULL, BEAR, TRADER: trader("TAKE"), "Final Boss": BOSS_YES });
  const x = await run(ai);
  assert.equal(x.final, "WATCH"); assert.ok(x.hardStops.some((h) => /monitoring tag/.test(h))); // never a YES with a hard stop
  assert.match(ai.calls.find((c) => c.role === "Final Boss").params.contents, /"hardStops":\["news: Binance adds ABC to the monitoring tag"\]/);
  const poor = await run(fakeAi({ "DATA ANALYST": { ...DATA, dataQuality: { rating: "poor", issues: [{ field: "marketFlow", problem: "missing" }] } }, "NEWS RESEARCHER": NEWS, BULL, BEAR,
    TRADER: trader("TAKE"), "Final Boss": BOSS_YES }));
  assert.equal(poor.final, "WATCH"); assert.ok(poor.guardNotes.some((n) => /made it WATCH: [\s\S]*data was rated poor/.test(n)));
  // the analyst and the bull fail, news is switched off: the bear and the trader still work, and are told what is unknown
  const ai2 = fakeAi({ "DATA ANALYST": new Error("quota"), BULL: new Error("busy"), BEAR, TRADER: { ...trader("WAIT"), debate: { winner: "bear", reason: "no bull case" } } });
  const y = await run(ai2, dossier("XYZUSDT"), { news: false });
  assert.equal(y.decision, "WAIT"); assert.equal(y.committee.data.available, false); assert.equal(y.committee.news.off, true);
  assert.equal(y.committee.debate.bull.available, false); assert.equal(y.committee.debate.bear.available, true);
  const tc = ai2.calls.find((c) => c.role === "TRADER").params.contents;
  assert.match(tc, /DATA ANALYST REPORT \(JSON\)\n\{"available":false,"note":"quota"\}/); assert.match(tc, /BULL'S CASE \(JSON\)\n\{"available":false,"note":"busy"\}/);
  assert.ok(!ai2.calls.some((c) => c.role === "NEWS RESEARCHER"));
  // the debate switched off: no bull or bear, and the trader is not asked to judge one
  const ai3 = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, TRADER: trader("WAIT"), "Final Boss": boss("NO") });
  const z = await run(ai3, dossier("QRSUSDT"), { debate: false });
  assert.deepEqual(ai3.calls.map((c) => c.role).sort(), ["DATA ANALYST", "Final Boss", "NEWS RESEARCHER", "TRADER"]); // the boss runs on every analysis
  const t3 = ai3.calls.find((c) => c.role === "TRADER").params;
  assert.ok(!t3.config.responseSchema.required.includes("debate")); assert.doesNotMatch(t3.config.systemInstruction, /THE DEBATE/);
  assert.equal(z.committee.debate.off, true);
});

test("AI committee: news report is cleaned; without a search the news is unknown and empty; news is cached per coin", async () => {
  const chunks = { webSearchQueries: ["q"], groundingChunks: [{ web: { uri: "https://a.com/x", title: "A" } }, { web: { uri: "https://a.com/x", title: "A" } }, { web: { uri: "https://b.com", title: "B" } }] };
  const n = cm.cleanNews(JSON.stringify({ ...NEWS, hardStop: true, hardStopReason: "exploit", items: [{ date: "2026-10-28T10:00", title: "t", impact: "awful", severity: "huge", pricedIn: "maybe" }] }), chunks);
  assert.equal(n.available, true); assert.equal(n.sources.length, 2);
  assert.equal(n.hardStop, false); // a hard stop needs a high-severity bad item, and this one's labels were invalid
  assert.deepEqual([n.items[0].date, n.items[0].impact, n.items[0].severity, n.items[0].pricedIn], ["2026-10-28", "neutral", "low", "unclear"]);
  const unbacked = cm.cleanNews(JSON.stringify({ hardStop: true, riskLevel: "extreme" }), {});
  assert.deepEqual([unbacked.status, unbacked.hardStop, unbacked.riskLevel, unbacked.items.length], ["unknown", false, null, 0]);
  assert.equal(cm.cleanNews('Report: {"summary":"ok","overall":"none","riskLevel":"low","hardStop":false,"items":[]} end.', chunks).riskLevel, "low");
  assert.equal(cm.cleanNews("Sorry, I could not search.", null).available, false);
  cm._test.newsCache.clear();
  const ai = fakeAi({ "NEWS RESEARCHER": NEWS });
  const id = { symbol: "QQQ", name: "Q coin" };
  await cm.newsResearch(ai, { identity: id, holdHours: 12, model: "m", search: NO_APP_SEARCH });
  const again = await cm.newsResearch(ai, { identity: id, holdHours: 12, model: "m", search: NO_APP_SEARCH });
  assert.equal(again.cached, true); assert.equal(ai.calls.length, 1);
  assert.equal((await cm.newsResearch(fakeAi({ "NEWS RESEARCHER": new Error("down") }), { identity: { symbol: "ZZZ" }, holdHours: 12, model: "m", search: NO_APP_SEARCH })).available, false);
});

test("AI committee: prompts name the coin, the time window and each member's job; Telegram shows the votes", () => {
  const np = cm.newsResearcherPrompt({ symbol: "ABC", name: "Abc Protocol", chain: "BSC", contract: "0xabc" }, 168, new Date("2026-10-29T12:00:00Z"));
  assert.match(np, /Today is 2026-10-29 12:00 UTC/); assert.match(np, /BUYING ABC \(Abc Protocol\) on BSC, contract 0xabc and holding it for up to 168 hours/);
  assert.match(np, /no relevant news" is a valid/);
  assert.match(cm.dataAnalystPrompt(cm.DESKS.alpha), /You do NOT decide[\s\S]*DEX buying/);
  assert.match(cm.traderPrompt("spot", "MY RULES"), /MY RULES[\s\S]*Add a checklist item "news"/);
  assert.match(cm.bullPrompt("alpha"), /BULL[\s\S]*Binance Alpha token[\s\S]*most are 3-6/);
  assert.match(cm.bearPrompt("spot"), /You also receive the BULL'S CASE[\s\S]*REBUTTALS/);
  assert.ok(cm.bossPrompt("spot").startsWith(cm.BOSS_CORE)); // the owner's prompt word for word, then where things are
  assert.match(cm.bossPrompt("alpha"), /Binance Alpha token[\s\S]*levels\.resistance[\s\S]*FIRST watch trigger a price trigger/);
  const cb = cm.cleanBoss({ verdict: "MAYBE", confidence: "very", plan: { entry_zone: [2, 1], stop: "x", targets: [3, -1, "4"], position_size_pct_of_normal: 250 }, agent_quality: { bull: "great" } });
  assert.deepEqual([cb.verdict, cb.confidence, cb.plan.entryZone, cb.plan.stop, cb.plan.targets, cb.plan.sizePct, cb.agentQuality.bull], ["NO", "low", [1, 2], null, [3, 4], 100, null]);
  const x = { symbol: "ABCUSDT", decision: "SKIP", final: "NO", headline: "h", probTargetPct: 40, probStopPct: 30, expectedValuePct: 1.2, confidence: "medium", setupScore: 7,
    plan: { entryLow: 1, entryHigh: 1.01, stop: 0.97, stopPct: -3, target1: 1.06, target1Pct: 6, rewardRisk: 2, holdHours: 12 }, hardStops: [], keyRisk: "k",
    committee: { data: { available: true, dataQuality: { rating: "good" } }, news: { available: true, riskLevel: "low", summary: "Listing on Coinbase next week.", items: [{}] },
      trader: { decision: "TAKE" }, boss: { asked: true, available: true, verdict: "NO", agreesWithTrader: false, summary: "Target beyond the 7-day high.", decidingFactor: "levels.roomToResistancePct = 1.2" } } };
  const t = desk.tgSingle(x);
  assert.match(t, /^🔴 NO TRADE: ABC\n/);
  assert.match(t, /Final: NO · data good · news low risk · trader TAKE · boss NO \(overturned the trader\)\nBoss: Target beyond the 7-day high\.\nDeciding factor: levels.roomToResistancePct = 1.2/);
  assert.match(t, /News: Listing on Coinbase next week\./);
});

test("AI committee: a WAIT comes with a watched price event; every Gemini request is counted for the daily limit", async () => {
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR,
    TRADER: { ...trader("WAIT"), trigger: { event: "breakout", price: 101.5, timeframe: "5m", expiresMinutes: 45 } } });
  const x = await run(ai, dossier("WWWUSDT"));
  assert.equal(x.decision, "WAIT");
  assert.deepEqual(x.trigger, { event: "breakout", price: 101.5, timeframe: "5m", expiresMinutes: 45, distPct: 1.5 });
  assert.ok(ai.calls.find((c) => c.role === "TRADER").params.config.responseSchema.properties.trigger); // the trader is asked for it
  assert.match(desk.tgSingle({ ...x, symbol: "WWWUSDT" }), /Watching: a 5m close above 101.5 for 45 min; the AI checks again if it happens\./);
  // a TAKE never carries a trigger, even if the model filled one in
  const t = await run(fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, "Final Boss": BOSS_YES,
    TRADER: { ...trader("TAKE"), trigger: { event: "breakout", price: 101.5, timeframe: "5m", expiresMinutes: 45 } } }), dossier("VVVUSDT"));
  assert.equal(t.decision, "TAKE"); assert.equal(t.trigger, null);
  // the metered client counts requests and tokens
  const before = desk.aiTracker.usage().requests;
  const metered = desk.meterAi(fakeAi({ TRADER: trader("WAIT") }));
  await metered.models.generateContent({ config: { systemInstruction: "You are the TRADER" } });
  assert.equal(desk.aiTracker.usage().requests, before + 1);
  assert.ok(desk.aiTracker.usage().tokens.think >= 500);
});

// A news researcher that searches (or not) per call: grounding = list of booleans, one per request.
function newsAi(searchedPerCall, answer = NEWS) {
  const calls = [];
  return { calls, models: { generateContent: async (params) => {
    const searched = searchedPerCall[calls.length] ?? false;
    calls.push(params);
    return { text: JSON.stringify(answer), candidates: [{ groundingMetadata: searched ? GROUNDING : {} }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } };
  } } };
}

test("fixes: news that was not searched is retried once, then unknown with nothing from memory, and not cached", async () => {
  cm._test.newsCache.clear();
  const ok = newsAi([false, true]);
  const a = await cm.newsResearch(ok, { identity: { symbol: "RRR" }, holdHours: 12, model: "m", search: NO_APP_SEARCH });
  assert.equal(ok.calls.length, 2); assert.match(ok.calls[1].contents, /Use Google Search now/);
  assert.deepEqual([a.verified, a.requests, a.note], [true, 2, null]);
  const memory = { ...NEWS, riskLevel: "medium", items: [{ date: "2026-10-21", title: "Atomic swaps launch", impact: "positive", severity: "low", pricedIn: "yes", source: "Official" }] };
  const never = newsAi([false, false], memory);
  const b = await cm.newsResearch(never, { identity: { symbol: "MARS" }, holdHours: 12, model: "m", search: NO_APP_SEARCH });
  assert.equal(b.verified, false); assert.equal(b.requests, 2); assert.equal(b.status, "unknown"); assert.match(b.note, /news is unknown\. Nothing from the model's memory is used/);
  assert.deepEqual([b.items, b.upcoming, b.summary, b.riskLevel, b.evidence.discardedItems], [[], [], "", null, 1]); // the NEWS RULE: no headlines, dates or sources
  await cm.newsResearch(never, { identity: { symbol: "MARS" }, holdHours: 12, model: "m", search: NO_APP_SEARCH });
  assert.equal(never.calls.length, 4); // not cached: asked again next time
  // the trader and the boss are told; Telegram and the record say "unverified"
  assert.match(cm.traderPrompt("spot", "R"), /status "unknown" \(no web search ran, so it has no items\), means unknown/);
  assert.match(cm.bossPrompt("spot"), /status "unknown" \(no web search ran\) has no items: the news is unknown/);
  assert.match(cm.newsResearcherPrompt({ symbol: "X" }, 12), /If you could not search, return\s+items: \[\] and upcoming: \[\]/);
});

test("fixes: the liquidity test is bids within 1% (not the 0.1% band); a Binance monitoring tag is a hard stop", () => {
  const bands = (b1) => [{ withinPct: 0.1, bidUsd: 1049 }, { withinPct: 0.25, bidUsd: 4000 }, { withinPct: 0.5, bidUsd: 9000 }, ...(b1 ? [{ withinPct: 1, bidUsd: b1 }] : [])];
  assert.deepEqual([desk.liquidityCheck({ spreadBps: 8, bands: bands(25_000) }).passes, desk.liquidityCheck({ spreadBps: 8, bands: bands(25_000) }).bidsWithin1PctUsd], [true, 25000]);
  assert.equal(desk.liquidityCheck({ spreadBps: 8, bands: bands(12_000) }).passes, false);
  assert.equal(desk.liquidityCheck({ spreadBps: 45, bands: bands(90_000) }).passes, false);
  const partial = desk.liquidityCheck({ spreadBps: 8, depthReachPct: 0.6, bands: bands(null) });
  assert.equal(partial.passes, null); assert.match(partial.note, /reaches only 0.6%: at least \$9000 of bids within 0.5%/);
  const d = { market: {}, orderBook: { spreadBps: 5, bands: bands(25_000) } };
  assert.deepEqual(desk.hardStops(d), []); // a thin 0.1% band alone is not a hard stop
  assert.deepEqual(desk.hardStops({ ...d, exchangeTags: { monitoring: true } }), ["Binance monitoring tag (delisting risk)"]);
  // the boss gets the complete hard-stop list and is told what is NOT a hard stop
  assert.match(cm.bossPrompt("spot"), /HARD STOPS IN THIS SYSTEM[\s\S]*bids within 1% under \$20,000[\s\S]*Nothing else is a hard stop\. No alert signal, a weak base rate, a downtrend, a thin 0\.1% order-book band/);
  assert.match(cm.bossPrompt("alpha"), /pool liquidity under \$50,000/);
});

test("fixes: resistance includes swing highs and the EMAs above the price; support uses lows and swing lows only", () => {
  const t0 = Date.parse("2026-10-01T00:00:00Z"), H = 3_600_000;
  // a 1h downtrend from 120 to 100 with one swing high at 104 three hours ago
  const h1 = Array.from({ length: 80 }, (_, i) => { const c = 120 - i * 0.25; return { t: t0 + i * H, o: c + 0.1, h: c + 0.3, l: c - 0.3, c }; });
  h1[76] = { ...h1[76], h: 104 };
  const price = 100.25, h4 = h1.filter((_, i) => i % 4 === 0);
  const lv = desk.keyLevels(price, h1, h4, [{ price: 112, what: "7-day high" }], [{ price: 99, what: "24h low" }]);
  assert.ok(lv.resistance.price < 104, JSON.stringify(lv.overhead)); // the falling 1h EMA20 is closer than the swing high
  assert.match(lv.resistance.what, /1h EMA20/);
  assert.ok(lv.overhead.some((x) => x.what === "1h swing high" && x.price === 104));
  assert.equal(lv.support.what, "24h low"); // EMAs are never used as support
  // with the resistance closer, the realistic reward:risk is capped there
  const real = desk.realisticPlan({ levels: { resistance: lv.resistance.price } }, { entryLow: 100, entryHigh: 100.5, stop: 98, target1: 106 });
  assert.equal(real.cappedAtResistance, true); assert.ok(real.rewardRisk < 2);
});

test("fixes: fast NO (opt-in) for a coin with no alert signal; the full committee for alerts and by default", async () => {
  const none = { ...dossier("MARSUSDT"), alert: desk.alertContext("none"), screener: { state: "heating", tier: null, moved: false } };
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: { ...trader("SKIP"), headline: "SKIP MARSUSDT: no signal" }, "Final Boss": BOSS_YES });
  const x = await run(ai, none, { fastNo: true });
  assert.deepEqual(ai.calls.map((c) => c.role).sort(), ["DATA ANALYST", "NEWS RESEARCHER", "TRADER"]); // 3 requests, not 6
  assert.equal(x.final, "NO"); assert.equal(x.fastNo, true); assert.equal(x.committee.boss.asked, false); assert.match(x.committee.debate.skipped, /fast path/);
  assert.equal(x.headline, "NO TRADE MARSUSDT: no signal"); // "SKIP" is never shown as a word
  assert.match(desk.tgSingle({ ...x, symbol: "MARSUSDT" }), /Final: NO \(fast NO\)[\s\S]*boss skipped \(fast NO\)/);
  // the trader is not a no: the boss is asked (still no debate)
  const ai2 = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, TRADER: trader("WAIT"), "Final Boss": boss("NO") });
  const y = await run(ai2, none, { fastNo: true });
  assert.deepEqual(ai2.calls.map((c) => c.role).sort(), ["DATA ANALYST", "Final Boss", "NEWS RESEARCHER", "TRADER"]);
  assert.equal(y.fastNo, false);
  // an alert review always gets the full committee
  const ai3 = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("SKIP"), "Final Boss": boss("NO") });
  await run(ai3, none, { source: "alert", fastNo: true });
  // off by default: the Final Boss runs on every analysis
  const ai4 = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("SKIP"), "Final Boss": boss("NO") });
  const z = await run(ai4, none);
  assert.equal(z.fastNo, false); assert.ok(ai4.calls.some((c) => c.role === "Final Boss"));
  assert.equal(ai3.calls.length, 6);
});

test("fixes: the boss's confidence is capped by the data rating, and it gets a list of issues to audit", async () => {
  const partial = { ...DATA, dataQuality: { rating: "partial", issues: [{ field: "dexFlows", problem: "untracked" }] } };
  const ai = fakeAi({ "DATA ANALYST": partial, "NEWS RESEARCHER": NEWS, BULL: { ...BULL, strength: 2 }, BEAR, TRADER: trader("SKIP"),
    "Final Boss": boss("NO", { confidence: "high", audit_findings: [] }) });
  const x = await run(ai, { ...dossier(), futures: { available: false } });
  const b = x.committee.boss;
  assert.equal(b.confidenceSaid, "high"); assert.equal(b.confidence, "low"); // partial -> medium, then no findings -> one lower
  assert.ok(x.guardNotes.some((n) => /said high confidence, but the data was rated partial: medium at most/.test(n)));
  assert.ok(x.guardNotes.some((n) => /no audit findings although the code listed \d+ issues/.test(n)));
  const hints = ai.calls.find((c) => c.role === "Final Boss").params.contents;
  assert.match(hints, /"auditHints":\[[^\]]*TRADER moved the chances[^\]]*data rated partial[^\]]*the bull rated its own case 2\/10[^\]]*not tracked for this coin: futures/);
  assert.match(cm.bossPrompt("spot"), /Address every item of CODE CHECKS\.auditHints[\s\S]*Do\s+not copy the trader's numbers/);
});

test("fixes 2: a search counts when Google sends any search data (also no links); nothing from memory reaches the AI", async () => {
  // Gemini searched (it read search results) but sent no source links: still a real search
  assert.equal(cm.searchEvidence({}, { toolUsePromptTokenCount: 5400 }).searched, true);
  assert.equal(cm.searchEvidence({ searchEntryPoint: { renderedContent: "<div/>" } }, {}).searched, true);
  assert.equal(cm.searchEvidence({ groundingSupports: [{}] }, null).searched, true);
  const none = cm.searchEvidence({ retrievalMetadata: {} }, { toolUsePromptTokenCount: 0 });
  assert.equal(none.searched, false); assert.deepEqual(none.fields, ["retrievalMetadata"]);
  const exploit = { ...NEWS, overall: "negative", riskLevel: "high", hardStop: true, hardStopReason: "MoveVM exploit, chain halted",
    items: [{ date: "2026-10-23", title: "Initia halts chain after $2.7M exploit", type: "security", impact: "negative", severity: "high", pricedIn: "yes", source: "Cointelegraph" }] };
  const searched = cm.cleanNews(JSON.stringify(exploit), {}, { toolUsePromptTokenCount: 3000 });
  assert.deepEqual([searched.status, searched.hardStop, searched.items.length], ["searched", true, 1]); // a real search: a hard stop
  const memory = cm.cleanNews(JSON.stringify(exploit), {}, {});
  assert.deepEqual([memory.status, memory.hardStop, memory.items.length, memory.hardStopReason], ["unknown", false, 0, ""]);
  // in a run with no search: the trader and the boss never see the remembered headlines
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": exploit, BULL, BEAR, TRADER: trader("TAKE"), "Final Boss": BOSS_YES }, { grounding: {} });
  const x = await run(ai);
  assert.equal(x.committee.news.status, "unknown"); assert.equal(x.committee.news.requests, 2);
  for (const role of ["BULL", "BEAR", "TRADER", "Final Boss"]) assert.doesNotMatch(ai.calls.find((c) => c.role === role).params.contents, /MoveVM|Cointelegraph|2026-10-23/);
  assert.match(ai.calls.find((c) => c.role === "Final Boss").params.contents, /news is unknown and nothing from the model's memory is used/);
});

test("fixes 2: a fast NO is said once; the base rate of a coin without a signal is called an assumption", async () => {
  const none = { ...dossier("INITUSDT"), alert: desk.alertContext("none"), screener: { state: "ran", tier: null, moved: true } };
  const x = await run(fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, TRADER: trader("SKIP") }), none, { fastNo: true });
  assert.equal(x.fastNo, true); assert.equal(x.committee.boss.skipped, "fast");
  assert.ok(!x.guardNotes.some((n) => /fast NO/i.test(n))); // shown once at the top of the page, not again in the notes
  assert.match(desk.tgSingle({ ...x, symbol: "INITUSDT" }), /boss skipped \(fast NO\)/);
  assert.match(desk.alertContext("none").anchorFrom, /assumption/); assert.equal(desk.alertContext("confirmed").anchorFrom, "replay");
});

test("rules: the PLAN rule (target shown = capped target; stop just below the nearest support) and the EV rule (full calculation)", async () => {
  const d = { price: 100, chart: { atrPct: { "1h": 1 } }, levels: { resistance: 104, resistanceIs: "4h EMA20", support: 97.5, supportIs: "1h swing low", low24h: 96 } };
  const { plan, notes } = desk.alignPlan(d, { entryLow: 99.8, entryHigh: 100, stop: 97, target1: 106, holdHours: 12 });
  assert.equal(plan.target1, 104); assert.equal(plan.target2, 106);             // capped at resistance, the old target kept as target 2
  assert.equal(plan.stop, 97.3538); assert.deepEqual(plan.stopAt, { price: 97.5, what: "1h swing low" }); // 0.15 x ATR below the support
  assert.equal(plan.rewardRisk, +((104 - 99.9) / (99.9 - 97.3538)).toFixed(2)); // R:R from the numbers shown
  assert.ok(notes.some((n) => /Target set at the nearest resistance 104 \(4h EMA20\)/.test(n)) && notes.some((n) => /Stop set just below the nearest support 97.5/.test(n)));
  // a support too close to the entry (inside half a normal 1h move) is skipped for the next one, the 24h low
  const close = desk.alignPlan({ ...d, levels: { ...d.levels, support: 99.7 } }, { entryLow: 99.8, entryHigh: 100, stop: 97, target1: 103, holdHours: 12 });
  assert.equal(close.plan.stopAt.what, "24h low");
  const bare = desk.alignPlan({ price: 100, chart: { atrPct: { "1h": 1 } }, levels: {} }, { entryLow: 99.8, entryHigh: 100, stop: 97, target1: 106, holdHours: 12 });
  assert.equal(bare.plan.stop, 97); assert.ok(bare.notes.some((n) => /No support at least 0.5% below the entry/.test(n)));
  // EV = P_target x target% - P_stop x stop% + P_timeout x avg time-out% - costs, written out
  const ev = desk.evCalc({ pT: 30, pS: 40, targetPct: 4, stopPct: -2.5, timeoutPct: 0.4, costPct: 0.3, timeoutFrom: "live alerts of this tier that timed out (12)" });
  assert.equal(ev.ev, +(0.3 * 4 - 0.4 * 2.5 + 0.3 * 0.4 - 0.3).toFixed(2));
  assert.equal(ev.formula, "0.30 × 4.00% − 0.40 × 2.50% + 0.30 × 0.40% − 0.30% costs = +0.02%");
  // in a run: the plan shown is the one used for R:R and EV, and the full calculation is shown
  const dd = { ...dossier(), levels: { resistance: 105, resistanceIs: "7-day high", roomToResistancePct: 5, support: 98.5, supportIs: "24h low", low24h: 98.5 },
    alert: { ...alert, timeout: { pct: 0.5, from: "AI calls of this tier that timed out (6)" } } };
  const x = await run(fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("TAKE"), "Final Boss": BOSS_YES }), dd);
  assert.equal(x.plan.target1, 105); assert.equal(x.realistic.target, x.plan.target1); assert.equal(x.realistic.rewardRisk, x.plan.rewardRisk);
  assert.equal(x.plan.stopAt.price, 98.5);
  assert.equal(x.evCalc.timeoutPct, 0.5); assert.equal(x.evCalc.ev, x.expectedValuePct);
  assert.match(desk.tgSingle({ ...x, symbol: "ABCUSDT" }), /\nEV = 0\.\d\d × [\d.]+% − 0\.\d\d × [\d.]+% \+ 0\.\d\d × 0\.50% − [\d.]+% costs = [+-][\d.]+%/);
});

test("rules: the TRACK RECORD rule (this tier only, else no track record for this tier and the base rate only)", () => {
  assert.deepEqual(desk.performanceFor({ tier: "none", live: null }), { tier: "none", note: "no track record for this tier" });
  const p = desk.performanceFor({ tier: "early", live: { resolved: 40, winRatePct: 31, netPct: 0.4 }, groups: [{ group: "BTC up", resolved: 12 }], committee: { resolved: 3, note: "no track record for this tier" } });
  assert.deepEqual(p, { tier: "early", thisTier: { resolved: 40, hitTargetPct: 31, avgNetPct: 0.4 }, matchingGroups: [{ group: "BTC up", resolved: 12 }] }); // the committee's 3 calls are left out
  assert.match(cm.traderPrompt("spot", "R"), /TRACK RECORD RULE: use only performance numbers of this alert's tier[\s\S]*write exactly that in the "track record" checklist item and use the base rate only/);
  assert.match(cm.dataAnalystPrompt(cm.DESKS.spot), /livePerformance: THIS alert tier only/);
});

// Google News RSS and Binance's announcement list, as the app fetches them
const RSS = `<?xml version="1.0"?><rss><channel><item><title>Initia halts L1 after $2.7M exploit - The Block</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Fri, 23 Oct 2026 16:00:00 GMT</pubDate><source url="https://www.theblock.co">The Block</source></item>
<item><title>Upbit flags INIT for trading caution &amp; more - TOKENPOST</title><link>https://news.google.com/rss/articles/def</link><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate><source url="https://tokenpost.com">TOKENPOST</source></item></channel></rss>`;
const ANN = (articles) => JSON.stringify({ data: { catalogs: [{ articles }] } });
const fakeGet = (annArticles) => async (url) => (url.includes("news.google.com") ? RSS : ANN(annArticles));

test("news: the app searches Google News and Binance itself; items must point to a fetched result", async () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  cm._test.annCache.at = 0;
  const r = await cm.appSearch({ symbol: "INIT", name: "Initia" }, { now, get: fakeGet([{ title: "Binance Will Delist INIT, FOO on 2026-11-05", releaseDate: now - 86_400_000, code: "c1" },
    { title: "Binance Adds INITIATIVE to Earn", releaseDate: now, code: "c2" }, { title: "Binance Will Delist INIT, BAR", releaseDate: now - 30 * 86_400_000, code: "c3" }]) });
  assert.equal(r.ok, true); assert.equal(r.query, '"Initia" INIT when:7d');
  assert.deepEqual(r.results.map((x) => [x.id, x.source, x.date]), [["R1", "The Block", "2026-10-23"], ["R2", "TOKENPOST", "2026-10-26"], ["R3", "Binance announcement", "2026-10-28"]]);
  assert.equal(r.results[0].title, "Initia halts L1 after $2.7M exploit"); assert.equal(r.results[1].title, "Upbit flags INIT for trading caution & more");
  assert.equal(r.results[2].url, "https://www.binance.com/en/support/announcement/detail/c1"); // INITIATIVE and the 30-day-old notice are left out
  // Gemini judged the results without its own search: items keep only what points to a result, with the result's facts
  const answer = { ...NEWS, overall: "negative", riskLevel: "high", hardStop: true, hardStopReason: "exploit and delisting",
    items: [{ ref: "R1", date: "2026-10-01", title: "wrong title", impact: "negative", severity: "high", pricedIn: "no", source: "made up" },
      { ref: "R3", impact: "negative", severity: "high", pricedIn: "no" }, { ref: "", date: "2026-10-20", title: "remembered rumor", impact: "negative", severity: "medium" }],
    upcoming: [{ date: "2026-11-05", event: "delisting", impact: "negative", ref: "R3" }, { date: "2026-11-09", event: "remembered unlock", impact: "negative", ref: "" }] };
  const n = cm.cleanNews(JSON.stringify(answer), {}, {}, r);
  assert.equal(n.status, "searched"); assert.deepEqual(n.searchedBy, ["the app (Google News, Binance announcements)"]);
  assert.deepEqual(n.items.map((x) => [x.ref, x.date, x.title, x.source]), [["R1", "2026-10-23", "Initia halts L1 after $2.7M exploit", "The Block"], ["R3", "2026-10-28", "Binance Will Delist INIT, FOO on 2026-11-05", "Binance announcement"]]);
  assert.equal(n.evidence.droppedItems, 1); assert.deepEqual(n.upcoming.map((x) => x.event), ["delisting"]);
  assert.equal(n.hardStop, true); assert.equal(n.sources.length, 3);
  // in a run: the results go to the researcher, and the news counts as searched without Gemini's own search
  cm._test.newsCache.clear();
  const ai = fakeAi({ "NEWS RESEARCHER": answer }, { grounding: {} });
  const rep = await cm.newsResearch(ai, { identity: { symbol: "INIT", name: "Initia" }, holdHours: 12, model: "m", search: async () => r });
  assert.match(ai.calls[0].params.contents, /^SEARCH RESULTS \(fetched by the app just now[\s\S]*"id":"R1","title":"Initia halts L1/);
  assert.equal(ai.calls.length, 1); assert.equal(rep.status, "searched"); assert.equal(rep.requests, 1); // no retry needed
  // both sources down and no Gemini search: unknown, as before
  cm._test.annCache.at = 0;
  assert.equal((await cm.appSearch({ symbol: "X" }, { get: async () => { throw new Error("offline"); } })).ok, false);
});

test("Final Boss: if its model fails, the fallback model answers; it says which one and why", async () => {
  const calls = [];
  const ai = { models: { generateContent: async (p) => {
    calls.push(p.model);
    if (p.model === "pro-model") { const e = new Error("models/pro-model is not found for API version v1beta"); e.status = 404; throw e; }
    return { text: JSON.stringify(boss("NO", { summary: "No edge." })), candidates: [{}], usageMetadata: {} };
  } } };
  const b = await cm.finalBoss(ai, { desk: "spot", trader: {}, code: {}, data: null, news: null, debate: { off: true }, dossier: {}, model: "pro-model", fallbackModel: "flash-model" });
  assert.deepEqual(calls, ["pro-model", "flash-model"]);
  assert.equal(b.available, true); assert.equal(b.verdict, "NO"); assert.equal(b.model, "flash-model");
  assert.match(b.fallbackFrom.error, /pro-model: models\/pro-model is not found/);
  const dead = { models: { generateContent: async (p) => { throw Object.assign(new Error(`quota for ${p.model}`), { status: 400 }); } } };
  const none = await cm.finalBoss(dead, { desk: "spot", trader: {}, code: {}, debate: { off: true }, dossier: {}, model: "pro-model", fallbackModel: "flash-model" });
  assert.equal(none.available, false); assert.match(none.reason, /pro-model: quota for pro-model \| flash-model: quota for flash-model/);
});

test("progress: each committee member reports working / done in order, and the answer streams as lines of JSON", async () => {
  const steps = [];
  const ai = fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("TAKE"), "Final Boss": BOSS_YES });
  await run(ai, dossier(), { onStep: (e) => steps.push(`${e.id}:${e.status}`) });
  const done = steps.filter((x) => /:(done|failed|skipped)$/.test(x)).map((x) => x.split(":")[0]);
  assert.deepEqual(done.slice(2), ["bull", "bear", "trader", "checks", "boss"]);              // in this order
  assert.deepEqual(done.slice(0, 2).sort(), ["data", "news"]);                                // these two work at the same time
  assert.ok(steps.indexOf("bull:working") < steps.indexOf("bull:done") && steps.indexOf("boss:working") < steps.indexOf("boss:done"));
  assert.ok(steps.includes("news:working")); // "searching ..." then "... results found"
  // news and debate switched off: shown as skipped, never as waiting forever
  const off = [];
  await run(fakeAi({ "DATA ANALYST": DATA, TRADER: trader("SKIP"), "Final Boss": boss("NO") }), dossier("OFFUSDT"), { news: false, debate: false, onStep: (e) => off.push(`${e.id}:${e.status}`) });
  assert.ok(["news:skipped", "bull:skipped", "bear:skipped", "boss:done"].every((x) => off.includes(x)), off.join(" "));
  // a broken listener never breaks the analysis
  const x = await run(fakeAi({ "DATA ANALYST": DATA, "NEWS RESEARCHER": NEWS, BULL, BEAR, TRADER: trader("SKIP"), "Final Boss": boss("NO") }), dossier("BRKUSDT"), { onStep: () => { throw new Error("page closed"); } });
  assert.equal(x.final, "NO");
  // the streamed answer: one JSON line per step, then the result (or the error)
  const fakeRes = () => { const r = { lines: [], head: null, ended: false, writableEnded: false, destroyed: false, writeHead(c, h) { r.head = [c, h]; }, on() {},
    write(t) { r.lines.push(...t.trim().split("\n").map((l) => JSON.parse(l))); }, end() { r.ended = true; r.writableEnded = true; } }; return r; };
  const ok = fakeRes();
  await desk.streamJob(ok, async (onStep) => { onStep({ id: "data", status: "working" }); onStep({ id: "data", status: "done", detail: "data good" }); return { final: "YES" }; });
  assert.equal(ok.head[1]["content-type"], "application/x-ndjson; charset=utf-8");
  assert.deepEqual(ok.lines.map((l) => l.type + (l.id ? ":" + l.id + ":" + l.status : "")), ["step:data:working", "step:data:done", "result"]);
  assert.equal(ok.lines[2].data.final, "YES"); assert.equal(ok.ended, true);
  const bad = fakeRes();
  await desk.streamJob(bad, async () => { throw new Error("quota exceeded"); });
  assert.deepEqual(bad.lines, [{ type: "error", error: "AI analysis failed: quota exceeded" }]);
});

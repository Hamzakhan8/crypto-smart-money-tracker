// Unit tests for the signal, tracking and safety logic. Run: npm test (Node 18+, no network, no API key).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SCREENER_LIBRARY_ONLY = "1"; // load the screener's logic without starting it
const sc = await import("../screener.js");
const wh = await import("../whales.js");
const fl = await import("../flows.js");
const desk = await import("../ai-trade.js");

const igniting = () => ({
  rvol15: 3, ret15: 0.6, ret1h: 1.2, rvol1h: 2, range6h: 3.5, marketWide: false, btc1h: 0.1, btc4h: 0.2, rsiD: 55, spreadBps: 5,
  persist: 2, persistOf: 3, trendUp: true, extPct: 1, fadePct: 0.2, wickShare: 0.2, rangePos: 0.8,
  early: { r5: 3.5, prevR5: 3.2, ret10: 0.5, buy10: 62, closePos5: 0.6, body5: 0.4 },
});

test("classifyIgnition: a clean setup ignites", () => {
  const r = sc.classifyIgnition(igniting(), 2, -0.02);
  assert.equal(r.state, "ignited", JSON.stringify(r.miss));
});

test("classifyIgnition: quality gates turn it into heating with reasons", () => {
  const cases = [
    [{ rsiD: 72 }, /daily RSI/], [{ btc4h: -0.5 }, /BTC not falling/], [{ marketWide: true }, /market-wide/],
    [{ early: { ...igniting().early, closePos5: 0.95, body5: 0.8 } }, /calmer candle/], [{ rangePos: 0.98, fadePct: 0.02 }, /pause below the top/],
    [{ early: { ...igniting().early, prevR5: 1.5 } }, /two 5m candles/], [{ trendUp: false }, /rising 4h trend/],
  ];
  for (const [patch, re] of cases) {
    const r = sc.classifyIgnition({ ...igniting(), ...patch }, 2, -0.02);
    assert.equal(r.state, "heating", JSON.stringify(patch));
    assert.ok(r.miss.some((m) => re.test(m)), `${JSON.stringify(patch)} -> ${r.miss}`);
  }
});

test("classifyIgnition v7: no ignition right under a recent high or below the 20-day average", () => {
  const ok = { ...igniting(), distTo12hHigh: -2.5, distTo24hHigh: -4, aboveSma20d: true };
  assert.equal(sc.classifyIgnition(ok, 2, -0.02).state, "ignited");
  for (const [patch, re] of [[{ distTo12hHigh: -0.4 }, /break of its 12h high \(0\.4% above\)/], [{ distTo12hHigh: 0 }, /12h high/],
    [{ distTo24hHigh: -1.2 }, /break of its 24h high/], [{ aboveSma20d: false }, /20-day average/]]) {
    const r = sc.classifyIgnition({ ...ok, ...patch }, 2, -0.02);
    assert.equal(r.state, "heating", JSON.stringify(patch));
    assert.ok(r.miss.some((m) => re.test(m)), `${JSON.stringify(patch)} -> ${r.miss}`);
  }
  // a breakout above the high, plenty of room, or unknown data does not block
  for (const patch of [{ distTo12hHigh: 0.3, distTo24hHigh: 0.3 }, { distTo12hHigh: -1, distTo24hHigh: -1.5 }, { distTo12hHigh: null, distTo24hHigh: null, aboveSma20d: null }])
    assert.equal(sc.classifyIgnition({ ...ok, ...patch }, 2, -0.02).state, "ignited", JSON.stringify(patch));
  // the checks can be switched off (SCREENER_ROOM_12H=0, SCREENER_ROOM_24H=0, SCREENER_DAILY_TREND=0)
  const off = { ...sc.DEFAULT_IGNITION, room12h: 0, room24h: 0, dailyTrend: false };
  assert.equal(sc.classifyIgnition({ ...ok, distTo12hHigh: -0.2, distTo24hHigh: -0.2, aboveSma20d: false }, 2, -0.02, off).state, "ignited");
});

test("fiveMinFeatures: distance to the prior 12h and 24h highs (last 15 minutes left out)", () => {
  const n = 289, k = { t: [], open: [], high: [], low: [], close: [], qv: [], trades: [], buy: [] };
  for (let i = 0; i < n; i++) {
    const px = 100;
    k.t.push(1.7e12 + i * 3e5); k.open.push(px); k.close.push(px); k.low.push(px - 0.5); k.qv.push(100); k.trades.push(10); k.buy.push(50);
    k.high.push(i === 10 ? 110 : i === 200 ? 102 : i >= n - 3 ? 120 : px + 0.5); // 24h high 110, 12h high 102, a fresh spike in the last 15 min
  }
  const f = sc.fiveMinFeatures(k, n - 1, k.t[n - 1] + 3e5, () => 100);
  assert.ok(Math.abs(f.distTo12hHigh - (100 / 102 - 1) * 100) < 1e-9, f.distTo12hHigh);
  assert.ok(Math.abs(f.distTo24hHigh - (100 / 110 - 1) * 100) < 1e-9, f.distTo24hHigh);
  assert.equal(sc.fiveMinFeatures(k, 200, k.t[200] + 3e5, () => 100).distTo24hHigh, null); // not enough history
});

test("classifyIgnition: tokens that already ran never ignite; slow tokens are skipped", () => {
  assert.equal(sc.classifyIgnition(igniting(), 15, 0).state, "ran");
  assert.equal(sc.classifyIgnition({ ...igniting(), ret1h: 9 }, 2, 0).state, "ran");
  assert.equal(sc.classifyIgnition({ ...igniting(), range6h: 1.5 }, 2, 0).slow, true); // under 0.5 x 4% typical range
});

test("earlyFeatures reads the last two finished 5m candles", () => {
  const k = { t: [0, 3e5, 6e5, 9e5].map((x) => x + 1.7e12), open: [1, 1, 1, 1.01], high: [1, 1, 1.02, 1.03], low: [1, 1, 0.99, 1.0], close: [1, 1, 1.01, 1.025],
    qv: [100, 100, 400, 600], buy: [50, 50, 260, 400] };
  const e = sc.earlyFeatures(k, 3, () => 100);
  assert.equal(e.r5, 6); assert.equal(e.prevR5, 4);
  assert.ok(Math.abs(e.ret10 - 2.5) < 1e-9); assert.equal(e.buy10, 66);
  assert.ok(Math.abs(e.closePos5 - (1.025 - 1.0) / 0.03) < 1e-9);
});

test("isNonCryptoInfo removes tokenized stocks and stablecoins, keeps crypto", () => {
  assert.equal(sc.isNonCryptoInfo({ name: "Tesla (bStocks)", tags: ["bStocks"] }), true);
  assert.equal(sc.isNonCryptoInfo({ name: "Blackberry（bStocks）", tags: [] }), true);
  assert.equal(sc.isNonCryptoInfo({ name: "Ripple USD", tags: ["stablecoin"] }), true);
  assert.equal(sc.isNonCryptoInfo({ name: "Pepe", tags: ["Meme"] }), false);
  assert.equal(sc.isNonCryptoInfo({ name: "Bitcoin", tags: ["Payments", "mining-zone"] }), false);
});

test("applyCandles: 1-minute outcome tracking", () => {
  const rule = { targetPct: 6, stopPct: 3, hz: 12 * 3_600_000 }, t0 = 1_700_000_030_000; // alert at :30s
  const c = (i, o, h, l, cl) => ({ t: Math.ceil(t0 / 60_000) * 60_000 + i * 60_000, o, h, l, c: cl });
  let t = { entry: 100 };
  sc.applyCandles(t, rule, t0, [{ t: Math.floor(t0 / 60_000) * 60_000, o: 90, h: 120, l: 80, c: 100 }, c(0, 100, 103, 99, 102), c(1, 102, 106.5, 101, 106)]);
  assert.equal(t.outcome, "win"); assert.equal(t.exitPct, 6); // the candle the alert fired in is ignored
  t = { entry: 100 };
  sc.applyCandles(t, rule, t0, [c(0, 100, 107, 96.5, 101)]);
  assert.equal(t.outcome, "loss"); assert.equal(t.exitPct, -3);  // touched both: counts as a loss
  t = { entry: 100 };
  sc.applyCandles(t, rule, t0, [c(0, 95, 96, 94, 95)]);
  assert.equal(t.exitPct, -5);                                    // gap below the stop fills at the open
  t = { entry: 100 };
  sc.applyCandles(t, rule, t0, [c(0, 100, 101, 99, 100.5), c(1, 100.5, 101, 100, 100.8)]);
  assert.equal(t.outcome, undefined); assert.equal(t.lastClose, 100.8); assert.equal(t.candles, true);
  assert.equal(sc.applyCandles(t, rule, t0, [c(1, 0, 999, 0, 1)]), false); // already-seen candle is skipped
  t = { entry: 100 };
  sc.applyCandles(t, rule, t0, [c(12 * 60 + 1, 100, 200, 100, 150)]);
  assert.equal(t.outcome, undefined);                              // after the window: ignored
});

test("whale tracker: transfer types and entity names", () => {
  const cats = { a: "exchange", b: "exchange", c: "exchange", d: "dex" }, ents = { a: "Binance", b: "Binance", c: "Coinbase" };
  const k = (f, t2) => wh.kindOf(f, t2, (x) => cats[x] || null, (x) => ents[x]);
  assert.equal(k("0x0000000000000000000000000000000000000000", "u"), "mint");
  assert.equal(k("a", "b"), "internal"); assert.equal(k("a", "c"), "exchange_to_exchange");
  assert.equal(k("u", "a"), "deposit"); assert.equal(k("c", "u"), "withdrawal"); assert.equal(k("u", "d"), "dex"); assert.equal(k("u", "v"), "transfer");
  assert.equal(wh.entityOf("Binance 14", "exchange"), "Binance");
  assert.equal(wh.entityOf("Wintermute (Binance deposit)", "exchange"), "Binance");
});

test("DEX tracker: routes, bots, pairs, wallet rotations", () => {
  const now = Date.now(), s = (o) => ({ net: "eth", dex: "uni", pool: "p", fromAmt: 1, toAmt: 1, ...o });
  const r = fl.buildRoutes([s({ id: "a", tx: "t", log: 2, t: now, wallet: "w", from: "USDC", to: "PEPE", usd: 5e4 }), s({ id: "b", tx: "t", log: 1, t: now, wallet: "w", from: "ETH", to: "USDC", usd: 5e4 })]);
  assert.equal(r.length, 1); assert.equal(r[0].from, "ETH"); assert.equal(r[0].to, "PEPE");
  assert.ok(fl.findBots([{ wallet: "b", from: "X", to: "Y", t: now - 60_000 }, { wallet: "b", from: "Y", to: "X", t: now }], now).has("b"));
  assert.deepEqual(fl.parsePair("weth-pepe"), { from: "ETH", to: "PEPE" });
  const rot = fl.walletRotations([{ id: 1, net: "eth", wallet: "w", from: "PEPE", to: "ETH", usd: 3e4, t: now - 600_000 }, { id: 2, net: "eth", wallet: "w", from: "ETH", to: "MOG", usd: 2e4, t: now }], (k2) => k2 === "ETH");
  assert.equal(rot.length, 1); assert.equal(rot[0].usd, 2e4);
});

test("AI desk: plans are checked and calls are overridden by the rules", () => {
  const d = { price: 100, screener: { state: "heating", tier: null, moved: false }, dataQuality: { demo: false }, market: {}, chart: { trend4h: { state: "uptrend" } },
    referencePlan: { entryZone: [99.8, 100], stops: { screenerRule: 97 }, targets: { screenerRule: 106, nearResistance: 104 } } };
  const good = desk.checkPlan(d, { entryLow: 99.8, entryHigh: 100, stop: 97, target1: 106, holdHours: 12 });
  assert.equal(good.replaced, false); assert.ok(Math.abs(good.plan.rewardRisk - 2.1) < 0.02); // measured from the middle of the entry zone
  const bad = desk.checkPlan(d, { entryLow: 100, entryHigh: 100, stop: 105, target1: 90, holdHours: 12 });
  assert.equal(bad.replaced, true); assert.equal(bad.plan.stop, 97);
  assert.equal(desk.applyGuards(d, { decision: "TAKE", confidence: "high" }).decision, "WAIT");        // not igniting
  const moved = { ...d, screener: { ...d.screener, state: "ran", moved: true, movedWhy: ["+20% in 24h"] } };
  assert.equal(desk.applyGuards(moved, { decision: "TAKE", confidence: "high" }).decision, "SKIP");    // already ran
  const conf = { ...d, screener: { state: "ignited", tier: "confirmed", moved: false } };
  assert.deepEqual(desk.applyGuards(conf, { decision: "TAKE", confidence: "high" }), { decision: "TAKE", confidence: "high", notes: [] });
  const down = { ...conf, chart: { trend4h: { state: "downtrend (price < EMA20 < EMA50)" } } };
  assert.equal(desk.applyGuards(down, { decision: "TAKE", confidence: "high" }).confidence, "medium"); // against the 4h trend
});

test("AI desk: Market Flow data from the Radar, or computed for coins it does not follow", async () => {
  desk.setMarketFlowSource({
    state: () => ({ pollIntervalMs: 30000, web3Status: "connected",
      coins: [{ symbol: "BTCUSDT", score: 81, label: "Strong flow", reasons: ["volume >=3x"], buyRatio1m: 66, buyRatio5m: 61.04, netFlow5m: 1234567.8, change5m: 0.4, relativeVolume: 3.2, trades1m: 900, buyQuote5m: 6, sellQuote5m: 4 }],
      web3Signals: [{ ticker: "PEPE", chain: "BSC", direction: "buy", wallets: 7, exitRate: 10, time: Date.now() - 120000, status: "active" }] }),
    flowFor: async (sym) => ({ symbol: sym, score: 40, label: "Neutral", reasons: [], buyRatio1m: 50, buyRatio5m: 48, netFlow5m: -5000, change5m: -0.1, relativeVolume: 0.9, trades1m: 120 }),
  });
  const btc = await desk.marketFlowFor("BTCUSDT");
  assert.equal(btc.flowScore, 81); assert.equal(btc.buyRatio5mPct, 61); assert.equal(btc.netFlow5mUsd, 1234568); assert.equal(btc.rankAmongRadarCoins, "1 of 1");
  const pepe = await desk.marketFlowFor("PEPEUSDT");
  assert.equal(pepe.flowScore, 40); assert.match(pepe.source, /computed now/); assert.equal(pepe.smartMoneyWallets.matchingSignals.length, 1);
  assert.equal(pepe.smartMoneyWallets.matchingSignals[0].direction, "buy");
});

test("big-move tier: small coin waking up + 5m ignition; size and daily-volume bounds; reasons when not yet", () => {
  const ok = { quoteVolume: 3e6, rvolD: 2.1, r5: 3.4, prevR5: 2.6, ret10: 0.8, buy10: 58 };
  assert.equal(sc.classifyBigMove(ok).state, "ignited");
  assert.equal(sc.classifyBigMove({ ...ok, quoteVolume: 0.5e6 }).state, null);           // too small to trade
  assert.equal(sc.classifyBigMove({ ...ok, quoteVolume: 40e6 }).state, null);            // too big for a +40% move
  const quiet = sc.classifyBigMove({ ...ok, rvolD: 1.1 });
  assert.equal(quiet.state, null);
  assert.match(quiet.miss[0], /20-day average/);
  const waiting = sc.classifyBigMove({ ...ok, r5: 1.2, buy10: 45 });
  assert.equal(waiting.state, "watch");
  assert.ok(waiting.miss.some((m) => /5m candles/.test(m)) && waiting.miss.some((m) => /buyers/.test(m)), JSON.stringify(waiting.miss));
  assert.equal(sc.classifyBigMove({ ...ok, ret10: -0.2 }).state, "watch");
  const tagged = sc.classifyBigMove({ ...ok, monitoring: true });                         // Binance Monitoring tag = delisting risk
  assert.equal(tagged.state, "watch");
  assert.match(tagged.miss.join(), /Monitoring/);
  assert.equal(sc.classifyBigMove({ ...ok, r5: null, prevR5: null }).miss[0], "5m check");
  assert.equal(sc.classifyBigMove(ok, { ...sc.DEFAULT_BIGMOVE, minDailyRvol: 3 }).state, null); // settings are respected
  assert.equal(sc.DEFAULT_BIGMOVE.targetPct, 40);
  assert.equal(sc.DEFAULT_BIGMOVE.stopPct, 10);
});

test("big-move tracking: +40% before -10% over days on 1-minute candles, stop checked first", () => {
  const rule = { targetPct: 40, stopPct: 10, hz: 7 * 24 * 3_600_000 }, t0 = 1_700_000_000_000;
  const win = { entry: 1 };
  const path = [[1, 1.05, 0.95, 1.02], [1.02, 1.2, 0.93, 1.18], [1.18, 1.41, 1.1, 1.4]].map(([o, h, l, c], i) => ({ t: t0 + 60_000 + i * 86_400_000, o, h, l, c }));
  sc.applyCandles(win, rule, t0, path);
  assert.equal(win.outcome, "win");
  assert.equal(win.exitPct, 40);
  const both = { entry: 1 };
  sc.applyCandles(both, rule, t0, [{ t: t0 + 60_000, o: 1, h: 1.45, l: 0.88, c: 1.2 }]);
  assert.equal(both.outcome, "loss"); // a candle touching both counts as a loss
});

test("AI desk: expected value decides; chances stay near the alert's base rate; hard stops mean no trade", () => {
  const alert = desk.alertContext("confirmed");
  const d = { price: 100, alert, screener: { state: "ignited", tier: "confirmed", moved: false }, dataQuality: { demo: false }, market: { btc1hPct: 0.2, btc4hPct: 0.5 },
    chart: { trend4h: { state: "uptrend" } }, levels: { roomToResistancePct: 8 }, marketFlow: { available: true, buyRatio5mPct: 62, netFlow5mUsd: 5000 },
    orderBook: { spreadBps: 4, bands: [{ withinPct: 1, bidUsd: 90_000, askUsd: 70_000 }] } };
  const plan = { target1Pct: 6, stopPct: -3, rewardRisk: 2 };
  const good = desk.decide(d, { decision: "TAKE", probTargetPct: 40, probStopPct: 30 }, plan);
  assert.equal(good.decision, "TAKE");
  assert.equal(good.expectedValuePct, +(0.4 * 6 - 0.3 * 3 - alert.costPct).toFixed(2)); // 2.4 - 0.9 - 0.3 = 1.2
  const greedy = desk.decide(d, { decision: "TAKE", probTargetPct: 90, probStopPct: 5 }, plan); // far above the base rate
  assert.equal(greedy.probTargetPct, alert.anchorProbTargetPct + 15);
  assert.ok(greedy.notes.some((n) => /base rate/.test(n)));
  const thin = desk.decide(d, { decision: "TAKE", probTargetPct: 25, probStopPct: 45 }, plan); // EV 1.5 - 1.35 - 0.3 < 0.5
  assert.equal(thin.decision, "WAIT");
  const bad = desk.decide({ ...d, alert: desk.alertContext("none") }, { decision: "TAKE", probTargetPct: 5, probStopPct: 55 }, plan); // EV far below zero
  assert.equal(bad.decision, "SKIP");
  assert.equal(desk.decide(d, { decision: "TAKE", probTargetPct: 40, probStopPct: 30 }, { ...plan, rewardRisk: 1.2 }).decision, "WAIT");
  assert.equal(desk.decide({ ...d, levels: { roomToResistancePct: 0.4 } }, { decision: "TAKE", probTargetPct: 40, probStopPct: 30 }, plan).decision, "TAKE"); // right under a recent high is normal for an ignition
  for (const [patch, re] of [[{ market: { btc1hPct: -1.4 } }, /BTC falling/], [{ marketFlow: { available: true, buyRatio5mPct: 38, netFlow5mUsd: -900 } }, /selling now/],
    [{ orderBook: { spreadBps: 45, bands: [] } }, /spread/], [{ orderBook: { spreadBps: 4, bands: [{ withinPct: 1, bidUsd: 8000 }] } }, /bids within 1%/]]) {
    const r = desk.decide({ ...d, ...patch }, { decision: "TAKE", probTargetPct: 40, probStopPct: 30 }, plan);
    assert.equal(r.decision, "SKIP", JSON.stringify(patch));
    assert.ok(r.hardStops.some((h) => re.test(h)), JSON.stringify(r.hardStops));
  }
});

test("AI desk: alert context per tier, live results take over once 30 have resolved, market breadth", () => {
  const big = desk.alertContext("bigmove");
  assert.equal(big.trackedAs.targetPct, 40); assert.equal(big.trackedAs.stopPct, 10);
  assert.equal(big.anchorProbTargetPct, Math.round(desk.BASE_RATES.bigmove.hitTargetPct));
  assert.equal(desk.alertContext("nonsense").tier, "none");
  const live = desk.alertContext("early", { stats: { current: { byTier: { early: { resolved: 40, winRatePct: 35, losses: 12, netPct: 0.8 } } } } });
  assert.equal(live.anchorFrom, "live results"); assert.equal(live.anchorProbTargetPct, 35); assert.equal(live.anchorProbStopPct, 30);
  const few = desk.alertContext("early", { stats: { current: { byTier: { early: { resolved: 5, winRatePct: 80, losses: 1, netPct: 3 } } } } });
  assert.equal(few.anchorFrom, "replay");
  const mk = (n, chg, sma) => Array.from({ length: n }, (_, i) => ({ core: true, change24h: chg, aboveSma: i < sma }));
  assert.equal(desk.marketRegime({ candidates: mk(20, 3, 15) }).label, "broad strength");
  assert.equal(desk.marketRegime({ candidates: mk(20, -3, 4) }).label, "weak market");
  assert.equal(desk.marketRegime({ candidates: mk(5, 1, 3) }), null); // too few coins to judge
});

test("AI desk: Telegram message says TAKE / WAIT / NO TRADE with chances and the plan", () => {
  const x = { symbol: "REZUSDT", decision: "SKIP", headline: "Sellers took over", probTargetPct: 18, probStopPct: 52, expectedValuePct: -1.7, confidence: "low", setupScore: 3,
    plan: { entryLow: 1, entryHigh: 1.01, stop: 0.97, stopPct: -3, target1: 1.06, target1Pct: 6, rewardRisk: 2, holdHours: 12 }, waitFor: "", hardStops: ["spread 45 bps"], keyRisk: "thin book" };
  const t = desk.tgSingle(x, "(AI review of the new early alert)");
  assert.match(t, /^🔴 NO TRADE: REZ \(AI review/);
  assert.match(t, /18% target \/ 52% stop · expected -1.7% per trade/);
  assert.match(t, /Hard stop: spread 45 bps/);
  assert.doesNotMatch(t, /Entry /);
  const take = desk.tgSingle({ ...x, decision: "TAKE", expectedValuePct: 1.2, hardStops: [] });
  assert.match(take, /^🟢 TAKE: REZ/); assert.match(take, /Entry 1-1.01 \| stop 0.97 \(-3%\) \| target 1.06 \(\+6%\)/);
  assert.match(desk.tgSingle({ ...x, decision: "WAIT", waitFor: "5m close above 1.02 within 30 min" }), /Trigger: 5m close above 1.02/);
});

test("Telegram: failures are explained in plain words", async () => {
  const tg = await import("../telegram.js");
  assert.match(tg.telegramHint(401, "Unauthorized"), /bot token is wrong/);
  assert.match(tg.telegramHint(400, "Bad Request: chat not found"), /chat not found.*pressed Start/);
  assert.match(tg.telegramHint(403, "Forbidden: bot was blocked by the user"), /blocked the bot/);
  assert.match(tg.telegramHint(403, "Forbidden: bot is not a member of the channel chat"), /add it to the group/);
  assert.match(tg.telegramHint(0, "ENOTFOUND"), /cannot reach api.telegram.org/);
  const saved = [process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID];
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  assert.equal((await tg.sendTelegram("hi")).sent, false);              // not configured: nothing is sent, nothing breaks
  assert.match(await tg.checkTelegram(), /not configured/);
  if (saved[0] !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved[0];
  if (saved[1] !== undefined) process.env.TELEGRAM_CHAT_ID = saved[1];
});

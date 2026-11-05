// News tab (news.ts): parsing the sources, merging the same story, bullish / bearish labels (AI, CoinDesk, rules),
// the news mood, and a refresh end to end with made-up sources and a fake Gemini. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { parseRss, parseCoindesk, ruleSentiment, rank, mood, createNews } from "../news.ts";

const NOW = Date.parse("2026-11-02T06:00:00Z"), H = 3_600_000;
const rss = (items) => `<rss><channel>${items.map(([title, source, t]) => `<item><title>${title} - ${source}</title><link>https://example.com/${encodeURIComponent(title)}</link><pubDate>${new Date(t).toUTCString()}</pubDate><source url="https://x">${source}</source></item>`).join("")}</channel></rss>`;

test("news sources: Google News RSS and CoinDesk in either field case", () => {
  const x = parseRss(rss([["Bitcoin ETFs see record outflows", "Reuters", NOW - H]]));
  assert.deepEqual([x[0].title, x[0].source, x[0].t], ["Bitcoin ETFs see record outflows", "Reuters", NOW - H]);
  const up = parseCoindesk({ Data: [{ TITLE: "Fed cuts rates", URL: "https://c.d/1", PUBLISHED_ON: (NOW - H) / 1000, SENTIMENT: "POSITIVE", SOURCE_DATA: { NAME: "CoinDesk" } }] });
  assert.deepEqual([up[0].title, up[0].t, up[0].given, up[0].source], ["Fed cuts rates", NOW - H, "bullish", "CoinDesk"]);
  const low = parseCoindesk({ data: [{ title: "Exchange hacked", url: "https://c.d/2", published_on: NOW - H, sentiment: "negative", source: "The Block" }] });
  assert.deepEqual([low[0].given, low[0].t, low[0].source], ["bearish", NOW - H, "The Block"]);
  assert.deepEqual(parseCoindesk({ Err: { message: "API key required" } }), []);
});

test("keyword rules: hacks and outflows bearish, inflows and rate cuts bullish", () => {
  assert.equal(ruleSentiment("Exchange hacked, $6.3 billion stolen").sentiment, "bearish");
  assert.equal(ruleSentiment("Bitcoin ETF inflows surge as Fed signals rate cut").sentiment, "bullish");
  assert.equal(ruleSentiment("What Bitcoin miners do on weekends").sentiment, "neutral");
  assert.match(ruleSentiment("Spot ETFs see outflows").why, /outflows/);
});

test("ranking: the same story from several sites counts once and higher; old and minor news lower", () => {
  const items = [
    { title: "Binance hack: $6.3 billion stolen in record attack", source: "Reuters", t: NOW - H, url: "u1" },
    { title: "Record Binance hack: $6.3 billion stolen", source: "CoinDesk", t: NOW - 2 * H, url: "u2" },
    { title: "Binance hack $6.3 billion stolen, withdrawals halted", source: "Decrypt", t: NOW - 3 * H, url: "u3" },
    { title: "Top 5 memecoins to watch this weekend", source: "SomeBlog", t: NOW - H, url: "u4" },
    { title: "SEC delays decision on altcoin ETF", source: "Bloomberg", t: NOW - 40 * H, url: "u5" },
  ];
  const r = rank(items, NOW);
  assert.equal(r.length, 3, "three sites, one story");
  assert.match(r[0].title, /Binance hack/); assert.equal(r[0].coverage, 3); assert.equal(r[0].source, "Reuters");
  assert.ok(r.findIndex((x) => /memecoins/.test(x.title)) > 0);
  const m = mood([{ sentiment: "bearish", importance: 8, t: NOW - H }, { sentiment: "bullish", importance: 2, t: NOW - H }, { sentiment: "bullish", importance: 9, t: NOW - 30 * H }], NOW);
  assert.equal(m.label, "Bearish"); assert.equal(m.stories, 2, "only the last 24 hours"); assert.equal(m.score, -0.6);
});

test("news refresh: sources merged, AI labels the headlines once, CoinDesk off without a key", async () => {
  const pages = {
    google: rss([["Spot bitcoin ETFs see largest outflows in four months after Binance hack", "The Block", NOW - H], ["Ethereum Price Today | Live ETH Price, Chart & Market Data", "Binance", NOW - H],
      ["Bitcoin steadies near $78,000 as market rebuilds", "Yahoo Finance", NOW - 2 * H]]),
    binance: JSON.stringify({ data: { catalogs: [{ articles: [{ title: "Security Incident | Withdrawals Resume in Phases", code: "abc", releaseDate: NOW - 3 * H }] }] } }),
  };
  const getText = async (url) => (url.includes("news.google.com") ? pages.google : url.includes("binance.com") ? pages.binance : (() => { throw new Error("not mocked"); })());
  let asked = 0, sentTitles = "";
  const ai = { models: { generateContent: async ({ contents }) => {
    asked++; sentTitles = contents;
    const lines = contents.split("\n");
    return { text: JSON.stringify(lines.map((l, i) => ({ i, sentiment: /steadies|Resume/.test(l) ? "bullish" : "bearish", impact: /ETFs/.test(l) ? "high" : "medium", coins: ["BTC"], why: "test label" }))) };
  } } };
  let clock = NOW;
  const n = createNews({ ai, getText, now: () => clock, coindeskKey: "" });
  await n.refresh();
  let a = n.api();
  assert.equal(a.status, "ok");
  assert.ok(!a.items.some((x) => /Price Today/.test(x.title)), "live price pages are not news");
  assert.equal(a.items.length, 3);
  assert.ok(a.items.every((x) => x.by === "AI"));
  assert.equal(a.items[0].impact, "high"); assert.match(a.items[0].title, /outflows/);
  assert.equal(a.items.find((x) => /steadies/.test(x.title)).sentiment, "bullish", "the AI reads context the keywords miss");
  assert.equal(a.coindesk, false);
  assert.match(a.sources.find((x) => x.name === "CoinDesk feed").error, /COINDESK_API_KEY/);
  assert.ok(["Bearish", "Mixed"].includes(a.mood.label));
  assert.equal(asked, 1);
  await n.refresh(); // within 30 minutes: no new request
  assert.equal(asked, 1);
  clock += 31 * 60_000; await n.refresh(); // nothing new to label: still no request
  assert.equal(asked, 1);

  // without the AI: keyword rules
  const plain = createNews({ getText, now: () => NOW });
  await plain.refresh();
  a = plain.api();
  assert.ok(a.items.every((x) => x.by === "rules"));
  assert.equal(a.items.find((x) => /outflows/.test(x.title)).sentiment, "bearish");
  assert.match(a.labeller, /keyword rules/);
});

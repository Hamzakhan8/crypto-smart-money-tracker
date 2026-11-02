// News tab: the most important crypto market news of the last 48 hours, each marked BULLISH, BEARISH or NEUTRAL for the
// crypto market, and the overall news mood of the last 24 hours. Refreshed every 10 minutes.
//
// Sources: Google News (crypto market, Bitcoin, Ethereum, regulation, ETFs) and Binance's own announcements, no key
// needed; CoinDesk's news feed when COINDESK_API_KEY is set (free key: developers.coindesk.com). The same story from
// several sites is merged and counts as more important. Bullish / bearish: Gemini reads the headlines when the AI is set
// up (GEMINI_API_KEY; at most one request every 30 minutes, only for new headlines), else CoinDesk's own sentiment
// label, else keyword rules (hack, lawsuit, outflows = bearish; ETF inflows, rate cut, listing = bullish).
// News moves prices in ways no rule predicts: read the mood as context, not as a trade signal.
import { generate, jsonFrom, MODELS } from "./agent.js";

const MIN = 60_000, HOUR = 3_600_000;
const env = process.env;
const GOOGLE_QUERIES = ["crypto market", "bitcoin price", "ethereum price", "crypto regulation OR SEC crypto", "bitcoin ETF OR crypto ETF", "Federal Reserve crypto OR bitcoin"];
const BINANCE_ANN = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20&catalogId=";
const BINANCE_CATALOGS = [[49, "Binance news"], [48, "Binance listing"], [161, "Binance delisting"]];
// Sites whose market news counts most (the rest still count, less)
const TOP_SOURCES = /reuters|bloomberg|coindesk|cointelegraph|the block|decrypt|cnbc|wall street journal|wsj|financial times|forbes|yahoo finance|fortune|associated press|binance|coinbase|the information|barron|marketwatch|blockworks|dl news/i;
const WIRES = /reuters|bloomberg|associated press|wall street journal|wsj|financial times/i; // preferred as the link for a story many sites ran
const tier = (src) => (WIRES.test(src) ? 2 : TOP_SOURCES.test(src) ? 1 : 0);
const BIG_TOPICS = /\b(etf|sec|fed|fomc|powell|rate cut|rate hike|interest rate|cpi|inflation|tariff|hack|hacked|exploit|security incident|lawsuit|ban|regulat|blackrock|microstrategy|strategy inc|saylor|liquidat|all-time high|record high|crash|binance|coinbase|stablecoin|treasury|trump|white house|congress|senate|bankrupt|reserve)\w*/gi;
const BEARISH = /\b(hack(ed|s)?|exploit(ed|s)?|stolen|drain(ed)?|security incident|breach|lawsuit|sues?|sued|charged|fraud|bans?|banned|crackdown|delist(s|ed|ing)?|suspend(s|ed)?|halt(s|ed)?|outflows?|sell-?offs?|plunge[sd]?|crash(es|ed)?|tumble[sd]?|slump(s|ed)?|drops?|dropped|falls?|falling|fell|declines?|declined|dump(s|ed)?|liquidat\w*|bankrupt\w*|insolven\w*|depeg\w*|fears?|bearish|recession|tariffs?|hawkish|rate hike|losses|warns?|warning|investigation|probe|slides?|sinks?|tanks?|lowest|weak(ness)?|risk-off)\b/gi;
const BULLISH = /\b(approv\w*|inflows?|rall(y|ies|ied)|surge[sd]?|soar(s|ed)?|jump(s|ed)?|gains?|gained|rises?|rising|rose|climbs?|climbed|record high|all-time high|ath|adoption|partnership|launch(es|ed)?|will list|listing|bullish|rate cuts?|dovish|accumulat\w*|buys?|bought|breakout|rebound(s|ed)?|recover(s|ed|y)?|upgrade[sd]?|resumes?|resumed|reopen\w*|highest|strong(er)?|risk-on|green)\b/gi;
// Pages that are not news: live price pages, quote pages, predictions, guides
const NOT_NEWS = /price today|live .{0,20}price|price, news, quote|quote & history|chart & market data|price prediction|price forecast|how to buy|what is |price chart|stock price/i;
const r2 = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const unxml = (v) => String(v || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").trim();

// Google News RSS: [{ title, source, t, url }], the " - Source" ending of a title cut off.
export function parseRss(xml, max = 25) {
  return [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, max).map((m) => {
    const get = (tag) => unxml((m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]);
    const title = get("title"), source = get("source"), cut = title.lastIndexOf(" - ");
    return { title: source && cut > 0 && title.slice(cut + 3) === source ? title.slice(0, cut) : title, source: source || "Google News", t: Date.parse(get("pubDate")), url: get("link"), from: "Google News" };
  }).filter((x) => x.title && Number.isFinite(x.t) && /^https?:\/\//.test(x.url));
}
// CoinDesk's news feed, read field by field in either upper or lower case (the API has used both).
export function parseCoindesk(json) {
  const list = Array.isArray(json?.Data) ? json.Data : Array.isArray(json?.data) ? json.data : Array.isArray(json?.Data?.LIST) ? json.Data.LIST : [];
  const f = (o, ...k) => { for (const x of k) if (o?.[x] != null && o[x] !== "") return o[x]; return null; };
  return list.map((a) => {
    const t = Number(f(a, "PUBLISHED_ON", "published_on", "publishedOn")), s = String(f(a, "SENTIMENT", "sentiment") || "").toUpperCase();
    return { title: String(f(a, "TITLE", "title") || "").trim(), url: String(f(a, "URL", "url", "GUID", "guid") || ""), t: t > 1e12 ? t : t * 1000,
      source: String(f(a.SOURCE_DATA || {}, "NAME", "name") || f(a.source_info || {}, "name") || f(a, "SOURCE", "source") || "CoinDesk feed"), from: "CoinDesk",
      given: s === "POSITIVE" ? "bullish" : s === "NEGATIVE" ? "bearish" : s === "NEUTRAL" ? "neutral" : null };
  }).filter((x) => x.title && /^https?:\/\//.test(x.url) && Number.isFinite(x.t));
}
// Keyword rules for the market direction of a headline: { sentiment, why }.
export function ruleSentiment(title) {
  const bear = [...new Set((title.match(BEARISH) || []).map((w) => w.toLowerCase()))], bull = [...new Set((title.match(BULLISH) || []).map((w) => w.toLowerCase()))];
  const sentiment = bull.length > bear.length ? "bullish" : bear.length > bull.length ? "bearish" : "neutral";
  return { sentiment, why: sentiment === "neutral" ? (bull.length ? `mixed words: ${[...bull, ...bear].join(", ")}` : "no market-moving words") : `words: ${(sentiment === "bullish" ? bull : bear).join(", ")}` };
}
const words = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9$ ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|with|from|this|that|are|was|has|its|into|over|after|amid|says|will|new)$/.test(w)));
const similar = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, Math.min(a.size, b.size)); };
// Merge the same story from several sites; importance from the source, the topic, how many sites ran it, and its age.
export function rank(items, now = Date.now()) {
  const clusters = [];
  for (const x of [...items].sort((a, b) => a.t - b.t)) {
    const w = words(x.title);
    const c = clusters.find((k) => similar(k.w, w) >= 0.6);
    if (c) { c.all.push(x); if (tier(x.source) > tier(c.lead.source)) c.lead = x; }
    else clusters.push({ w, lead: x, all: [x] });
  }
  return clusters.map(({ lead, all }) => {
    const sources = [...new Set(all.map((x) => x.source))], ageH = (now - Math.max(...all.map((x) => x.t))) / HOUR;
    const topics = [...new Set((lead.title.match(BIG_TOPICS) || []).map((w) => w.toLowerCase()))];
    const score = (TOP_SOURCES.test(lead.source) ? 3 : 1) + Math.min(3, topics.length) + Math.min(3, sources.length - 1);
    const fresh = ageH < 6 ? 1 : ageH < 12 ? 0.8 : ageH < 24 ? 0.6 : 0.4;
    return { ...lead, t: Math.max(...all.map((x) => x.t)), sources, coverage: sources.length, topics, importance: r2(score * fresh, 2), given: all.map((x) => x.given).find(Boolean) || null };
  }).sort((a, b) => b.importance - a.importance);
}
// The news mood of the last 24 hours: importance-weighted bullish minus bearish, from -1 to +1.
export function mood(items, now = Date.now()) {
  const day = items.filter((x) => now - x.t < 24 * HOUR);
  let s = 0, w = 0;
  for (const x of day) { const v = x.sentiment === "bullish" ? 1 : x.sentiment === "bearish" ? -1 : 0; s += v * x.importance; w += x.importance; }
  const score = w ? s / w : 0;
  return { score: r2(score, 2), label: !day.length ? "no news" : score > 0.15 ? "Bullish" : score < -0.15 ? "Bearish" : "Mixed",
    bullish: day.filter((x) => x.sentiment === "bullish").length, bearish: day.filter((x) => x.sentiment === "bearish").length, neutral: day.filter((x) => x.sentiment === "neutral").length, stories: day.length };
}

const aiPrompt = (now) => `You label crypto news headlines for traders. Today is ${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC.
For each headline decide its likely effect on the OVERALL crypto market (BTC and the large coins), not on one small token:
"bullish", "bearish" or "neutral" (opinion pieces, price recaps with no new information, unclear or minor items = neutral).
impact: "high" = can move the whole market (Fed, ETFs, major hacks, big regulation, major exchange problems),
"medium" = moves BTC/ETH or a sector a little, "low" = minor or about one small coin.
coins: tickers the headline is mainly about (e.g. ["BTC"]), [] if general. why: at most 12 words, plain English.
Judge only from the headline and source; never invent facts.
Answer with ONLY a JSON array, one object per headline, in the same order: [{"i": 0, "sentiment": "...", "impact": "...", "coins": [], "why": "..."}]`;

export function createNews({ ai = null, canSpend = () => true, getText = null, now = () => Date.now(), coindeskKey = env.COINDESK_API_KEY || "", aiOn = env.NEWS_AI !== "0", model = MODELS.analyst, everyMin = 10, aiEveryMin = 30 }) {
  const fetchText = getText || (async (url, headers = {}) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Mozilla/5.0 (smart-money-tracker)", ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
  const st = { status: "starting", updatedAt: null, items: [], sources: [], mood: null, aiAt: 0, aiError: null };
  const labels = new Map(); // headline -> { sentiment, impact, coins, why } from the AI (kept so each headline is asked once)
  let timer = null, busy = false;

  async function collect() {
    const out = [], sources = [];
    const note = (name, ok, n, error) => sources.push({ name, ok, count: n, error: error || null });
    await Promise.all(GOOGLE_QUERIES.map(async (q) => {
      try { const x = parseRss(await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:2d")}&hl=en-US&gl=US&ceid=US:en`)); out.push(...x); note(`Google News: ${q}`, true, x.length); }
      catch (e) { note(`Google News: ${q}`, false, 0, e.message); }
    }));
    await Promise.all(BINANCE_CATALOGS.map(async ([id, name]) => {
      try {
        const a = JSON.parse(await fetchText(BINANCE_ANN + id))?.data?.catalogs?.[0]?.articles || [];
        const x = a.map((r) => ({ title: String(r.title || ""), source: "Binance announcement", t: Number(r.releaseDate), url: `https://www.binance.com/en/support/announcement/detail/${r.code}`, from: name }))
          .filter((r) => r.title && now() - r.t < 48 * HOUR);
        out.push(...x); note(name, true, x.length);
      } catch (e) { note(name, false, 0, e.message); }
    }));
    if (coindeskKey) {
      try {
        const x = parseCoindesk(JSON.parse(await fetchText(`https://data-api.coindesk.com/news/v1/article/list?lang=EN&limit=60&api_key=${encodeURIComponent(coindeskKey)}`,
          { authorization: `Apikey ${coindeskKey}`, "x-api-key": coindeskKey })));
        out.push(...x); note("CoinDesk feed", true, x.length);
      } catch (e) { note("CoinDesk feed", false, 0, e.message); }
    } else note("CoinDesk feed", false, 0, "off: add COINDESK_API_KEY to .env (free key at developers.coindesk.com)");
    return { items: out.filter((x) => now() - x.t < 48 * HOUR && x.t <= now() + 10 * MIN && !NOT_NEWS.test(x.title)), sources };
  }
  // Gemini labels the most important headlines it has not seen yet (one request, at most every 30 minutes).
  async function aiLabel(ranked) {
    if (!ai || !aiOn || now() - st.aiAt < aiEveryMin * MIN || !canSpend(1)) return;
    const todo = ranked.filter((x) => !labels.has(x.title)).slice(0, 40);
    if (!todo.length) return;
    st.aiAt = now();
    try {
      const res = await generate(ai, { model, contents: todo.map((x, i) => `${i}. ${x.title} (${x.source})`).join("\n"),
        config: { systemInstruction: aiPrompt(now()), responseMimeType: "application/json" } }, { retries: 1, timeoutMs: 60_000 });
      const arr = jsonFrom(res, "News labels");
      for (const r of Array.isArray(arr) ? arr : []) {
        const x = todo[Number(r.i)];
        if (!x || !["bullish", "bearish", "neutral"].includes(r.sentiment)) continue;
        labels.set(x.title, { sentiment: r.sentiment, impact: ["high", "medium", "low"].includes(r.impact) ? r.impact : null, coins: (Array.isArray(r.coins) ? r.coins : []).slice(0, 5).map(String), why: String(r.why || "").slice(0, 120) });
      }
      if (labels.size > 800) for (const k of [...labels.keys()].slice(0, labels.size - 800)) labels.delete(k);
      st.aiError = null;
    } catch (e) { st.aiError = e.message; }
  }
  async function refresh() {
    if (busy) return; busy = true;
    try {
      const { items, sources } = await collect();
      const ranked = rank(items, now()).slice(0, 120);
      await aiLabel(ranked);
      st.items = ranked.map((x) => {
        const a = labels.get(x.title), rule = ruleSentiment(x.title);
        const s = a ? { sentiment: a.sentiment, by: "AI", why: a.why, impact: a.impact, coins: a.coins } : x.given ? { sentiment: x.given, by: "CoinDesk", why: "CoinDesk's own sentiment label" } : { sentiment: rule.sentiment, by: "rules", why: rule.why };
        // the AI's impact moves the importance a little (high news first)
        const importance = r2(x.importance * (s.impact === "high" ? 1.5 : s.impact === "low" ? 0.7 : 1), 2);
        return { title: x.title, url: x.url, source: x.source, from: x.from, t: x.t, coverage: x.coverage, sources: x.sources.slice(0, 6), topics: x.topics, importance, ...s };
      }).sort((a, b) => b.importance - a.importance);
      st.mood = mood(st.items, now());
      st.sources = sources;
      st.status = sources.some((x) => x.ok) ? "ok" : "error";
      st.error = st.status === "error" ? "No news source answered" : null;
      st.updatedAt = now();
    } finally { busy = false; }
  }
  function start() { if (timer) return; refresh().catch(() => {}); timer = setInterval(() => refresh().catch(() => {}), everyMin * MIN); timer.unref?.(); }
  function api() {
    return { status: st.status, error: st.error || null, updatedAt: st.updatedAt, nextAt: st.updatedAt ? st.updatedAt + everyMin * MIN : null, mood: st.mood, items: st.items.slice(0, 80),
      sources: st.sources, labeller: ai && aiOn ? (st.aiError ? `AI (Gemini) failed: ${st.aiError}; keyword rules meanwhile` : "AI (Gemini)") : "keyword rules (add GEMINI_API_KEY for AI labels)",
      coindesk: !!coindeskKey, aiLabelled: st.items.filter((x) => x.by === "AI").length };
  }
  return { start, refresh, api };
}

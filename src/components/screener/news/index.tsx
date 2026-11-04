"use client";
// The News tab: the most important crypto market news of the last 48 hours, each marked bullish, bearish or neutral,
// and the news mood of the last 24 hours. Data: GET /api/news every 60 seconds (the engine refreshes every 10 minutes).
// Headlines, sources and links come from outside sites: they are only ever rendered as text, and links open only
// when they are https:// (HeadlineLink).
import { useState, type ReactNode } from "react";
import { Sec } from "../context";
import { ErrorBox, Kpi, SourceRow, usePoll } from "../ui";

interface NewsItem {
  title: string; url?: string | null; source: string; from?: string | null; t: number; coverage?: number | null;
  sentiment?: string | null; impact?: string | null; coins?: string[] | null; why?: string | null; by?: string | null;
}
interface NewsSource { name: string; ok: boolean; count?: number | null; error?: string | null }
interface NewsMood { score?: number; label?: string | null; bullish?: number | null; bearish?: number | null; neutral?: number | null; stories?: number | null }
interface NewsResponse {
  status?: string; error?: string | null; updatedAt?: number | null; mood?: NewsMood | null; items?: NewsItem[];
  sources?: NewsSource[]; labeller?: string | null;
}

// The filter and search stay while the page is open (the classic page kept them when you switched tabs).
const kept = { f: "all", q: "" };

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** A headline link: opens only https:// addresses (as SafeLink), in the classic page's ink colour and bold. */
function HeadlineLink({ url, children }: { url?: string | null; children: ReactNode }) {
  const style = { color: "var(--ink)", fontWeight: 700 };
  return url && /^https:\/\//.test(url)
    ? <a href={url} target="_blank" rel="noopener noreferrer" style={style}>{children}</a>
    : <span style={style}>{children}</span>;
}

function Badge({ x }: { x: NewsItem }) {
  const k = x.sentiment === "bullish" ? "strong" : x.sentiment === "bearish" ? "risk" : "";
  return <>
    <span className={`badge${k ? ` ${k}` : ""}`}>{x.sentiment === "bullish" ? "BULLISH" : x.sentiment === "bearish" ? "BEARISH" : "NEUTRAL"}</span>
    {x.impact ? <span className="sub">{x.impact} impact</span> : null}
  </>;
}

function Row({ x }: { x: NewsItem }) {
  return (
    <tr>
      <td><Badge x={x} /></td>
      <td><HeadlineLink url={x.url}>{x.title}</HeadlineLink>{(x.coins || []).length ? <span className="sub">{x.coins!.join(", ")}</span> : null}</td>
      <td>{x.source}<span className="sub">{ago(x.t)}{(x.coverage ?? 0) > 1 ? ` · ${x.coverage} sites ran it` : ""}</span></td>
      <td className="muted" style={{ fontSize: 12 }}>{x.why || ""}<span className="sub">by {x.by}</span></td>
    </tr>
  );
}

const HEAD = <thead><tr><th>Effect</th><th>Headline</th><th>Source · when</th><th>Why</th></tr></thead>;

export default function NewsTab() {
  const { data: d, error } = usePoll<NewsResponse>("/api/news", 60_000);
  const [f, setF] = useState(kept.f), [q, setQ] = useState(kept.q);
  const m = d?.mood || {}, items = d?.items || [];
  const query = q.trim().toLowerCase();
  const rows = items.filter((x) => (f === "all" || (f === "binance" ? /binance/i.test(x.from || x.source) : x.sentiment === f))
    && (!query || x.title.toLowerCase().includes(query) || x.source.toLowerCase().includes(query)));
  const err = error ? `News: ${error}` : d?.error ? `News: ${d.error}` : null;

  return (
    <>
      <details className="notice"><summary><b>How to read it:</b> BULLISH = the story is likely good for the crypto market, BEARISH = likely bad, NEUTRAL = no clear effect. The news mood weighs the last 24 hours&apos; stories by importance.</summary><div>Importance comes from the source (Reuters, Bloomberg, CoinDesk, The Block, Binance... count more), the topic (Fed, ETFs, hacks, regulation, big exchanges), how many sites ran the same story, and how fresh it is. Labels come from Gemini when your AI is set up (it reads each headline once), from CoinDesk&apos;s own label when COINDESK_API_KEY is set, otherwise from keyword rules, which miss context (&quot;steadies after a hack&quot; still reads as bearish). News is context, not a trade signal: big news is often priced in within minutes. Research, not financial advice.</div></details>
      <ErrorBox>{err}</ErrorBox>
      <Sec id="mood">
        <div className="kpis">
          <Kpi label="News mood (24h)" value={d ? m.label || "—" : "—"} cls={d ? (m.label === "Bullish" ? "green" : m.label === "Bearish" ? "red" : "amber") : undefined}
            hint={d ? (m.stories ? `score ${(m.score ?? 0) > 0 ? "+" : ""}${m.score} (-1 to +1) · ${m.stories} stories, ${m.neutral} neutral` : "waiting for the first refresh") : "importance-weighted"} />
          <Kpi label="Bullish stories" value={d ? m.bullish ?? "—" : "—"} cls="green" hint="last 24 hours" />
          <Kpi label="Bearish stories" value={d ? m.bearish ?? "—" : "—"} cls="red" hint="last 24 hours" />
          <Kpi label="Labels by" style={{ fontSize: 18 }} value={d ? (/^AI/.test(d.labeller || "") && !/failed/.test(d.labeller || "") ? "AI (Gemini)" : "Keyword rules") : "—"}
            hint={d ? `${d.labeller || ""}${d.updatedAt ? ` · updated ${new Date(d.updatedAt).toLocaleTimeString()}` : ""}` : "—"} />
        </div>
      </Sec>
      <Sec id="top">
        <section className="panel">
          <div className="section-head"><div><h2>Top stories</h2><p>The most important market news of the last 48 hours. The same story from several sites is shown once, with how many ran it.</p></div><span className="chip">{d ? `${items.length} stories` : "—"}</span></div>
          <div className="table-wrap"><table className="table cards">{HEAD}<tbody>
            {!d ? <tr><td colSpan={4} className="empty">Loading…</td></tr>
              : items.length ? items.slice(0, 10).map((x, i) => <Row key={`${x.url || x.title}-${i}`} x={x} />)
              : <tr><td colSpan={4} className="empty">{d.status === "off" ? d.error || "off" : "The first news arrives a few seconds after start."}</td></tr>}
          </tbody></table></div>
        </section>
      </Sec>
      <Sec id="list">
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="section-head"><div><h2>All news</h2><p>Every story found, most important first.</p></div>
            <div className="filters">
              <select aria-label="Which news" value={f} onChange={(e) => { kept.f = e.target.value; setF(e.target.value); }}>
                <option value="all">All</option><option value="bullish">Bullish</option><option value="bearish">Bearish</option><option value="neutral">Neutral</option><option value="binance">Binance announcements</option>
              </select>
              <input placeholder="Search, e.g. ETF" aria-label="Search news" value={q} onChange={(e) => { kept.q = e.target.value; setQ(e.target.value); }} />
            </div></div>
          <div className="table-wrap"><table className="table cards">{HEAD}<tbody>
            {!d ? null : rows.length ? rows.map((x, i) => <Row key={`${x.url || x.title}-${i}`} x={x} />) : <tr><td colSpan={4} className="empty">No story matches.</td></tr>}
          </tbody></table></div>
        </section>
      </Sec>
      <Sec id="sources">
        <section className="panel" style={{ marginTop: 14 }}><div className="section-head"><div><h2>Sources</h2><p>Refreshed every 10 minutes. CoinDesk needs a free key (COINDESK_API_KEY in .env); AI labels need GEMINI_API_KEY.</p></div></div>
          <div className="source-list">{(d?.sources || []).map((x, i) => <SourceRow key={`${x.name}-${i}`} label={x.name} cls={x.ok ? "green" : "amber"} wrap>{x.ok ? `${x.count} stories` : x.error || "no answer"}</SourceRow>)}</div>
        </section>
      </Sec>
    </>
  );
}

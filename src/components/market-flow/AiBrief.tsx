"use client";
import { Fragment, type ReactNode } from "react";
import type { AnalyzeResponse } from "@/lib/api";

// The AI brief is model-written text and can echo token names from the Web3 feed, which anyone can choose. React
// escapes all text; only **bold**, _italic_ and "- " bullets become markup.
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*.+?\*\*|(?<=^|\s)_.+?_(?=\s|$|[.,;]))/).map((part, i) =>
    /^\*\*.+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : /^_.+_$/.test(part) ? <em key={i}>{part.slice(1, -1)}</em> : <Fragment key={i}>{part}</Fragment>);
}
export function BriefText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: ReactNode[][] | null = null;
  const flush = () => { if (list) { out.push(<ul className="ai-list" key={out.length}>{list.map((li, i) => <li key={i}>{li.map((x, j) => <Fragment key={j}>{j ? <br /> : null}{x}</Fragment>)}</li>)}</ul>); list = null; } };
  for (const raw of text.split("\n")) {
    if (/^- /.test(raw)) (list ??= []).push([inline(raw.slice(2))]);
    else if (list && /^\s{2,}\S/.test(raw)) list[list.length - 1].push(inline(raw.trim()));
    else { flush(); if (raw.trim()) out.push(<p key={out.length}>{inline(raw)}</p>); }
  }
  flush();
  return <>{out}</>;
}
export function BriefMeta({ meta, telegram }: Pick<AnalyzeResponse, "meta" | "telegram">) {
  const m = meta;
  const tools = (m?.toolCalls || []).map((t) => String(t.tool || "").replace(/^get_/, "").replace(/_/g, " ") + (t.args?.symbol ? ` ${t.args.symbol}` : "") + (t.ok ? "" : " (failed)"));
  const bits = m ? [m.mode === "deep" ? "With risk review" : "Fast mode", m.models ? Object.values(m.models).join(" → ") : "", m.cached ? "cached result" : null,
    m.durationMs != null ? `${(m.durationMs / 1000).toFixed(1)}s` : null, m.dataAgeSec != null ? `data ${m.dataAgeSec}s old` : null].filter(Boolean) : [];
  const t = telegram;
  return (
    <>
      {m && <div className="ai-meta">{bits.join(" · ")}{tools.length ? <><br />Checked: {tools.join(", ")}</> : null}</div>}
      {t && <div className={`ai-tg ${t.sent ? "green" : t.skipped ? "muted" : t.queued ? "amber" : "red"}`}>
        {t.sent ? "Sent to Telegram" : t.skipped ? `Telegram: ${t.skipped}` : t.queued ? `Telegram: not sent yet (${t.error || "error"}), it will keep retrying` : `Telegram failed: ${t.error || "unknown error"}`}
      </div>}
    </>
  );
}

"use client";
// Data health (the classic page's #sources and #narrChips in draw()): what is connected before trusting a signal, and
// the hot narratives now.
import { useScreener } from "../context";
import { SourceRow } from "../ui";
import { pct, time } from "@/lib/format";
import { cfg, type TgState } from "./util";

const cls = (v: string | undefined) => (v === "connected" ? "green" : v === "demo" || v === "stale" ? "amber" : "red");

function Sources({ tg }: { tg: TgState }) {
  const { data: d } = useScreener();
  if (!d) return null;
  const st = d.status, u = d.universe || {}, c = cfg(d), minRange = c.minRange6hPct, w = d.warmup;
  const m = d.metaStatus || {}, src: string = m.source || "none", metaOk = src === "live" || src === "demo", at = m.at ? new Date(m.at).toLocaleDateString() : "";
  const metaTxt = src === "live" ? `connected · ${m.coins} coins, ${m.sectors} sectors` : src === "demo" ? "demo" : src.startsWith("cached") ? `saved copy from ${at}` : src === "built-in" ? "built-in narrative lists" : "not loaded yet";
  const s = d.stream;
  const t = tg.t, res = tg.res;
  const tgSt = !t.configured ? <span className="amber">not set up: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env</span>
    : t.lastError ? <span className="red">{t.lastError}</span>
      : t.lastSentAt ? <span className="green">working · last message {time(t.lastSentAt)}</span>
        : <><span className="green">{t.bot ? `${t.bot} ready` : "configured"}</span> · no alert sent yet</>;
  return <>
    <SourceRow label="Binance Spot (prices, volume, candles)" cls={cls(st === "binance_only" || st === "warming_up" ? "connected" : st)}>{st || "starting"}</SourceRow>
    <SourceRow label="Binance asset info (market caps, sector tags)" cls={metaOk ? "green" : "amber"}>{metaTxt}</SourceRow>
    {s && <SourceRow label="Live 5m candles (Binance stream)" cls={s.on && s.connected ? "green" : "amber"} wrap>
      {!s.on ? s.why || "off" : !s.connected ? `reconnecting${s.error ? ` · ${s.error}` : ""} · polling meanwhile`
        : `live · ${s.subscribed} coins${s.closeScanAfterMs != null ? ` · last scan started ${(s.closeScanAfterMs / 1000).toFixed(1)}s after the 5m close` : ""} · candles from memory ${s.fromMemory}, downloaded ${s.downloaded}`}</SourceRow>}
    <SourceRow label="Binance Futures (funding, OI)" cls={cls(d.futuresStatus)}>{d.futuresStatus || "not checked"}</SourceRow>
    <SourceRow label="Time-of-day baselines" cls={w && w.seasonal >= 0.8 * w.total ? "green" : "amber"}>{w ? `${w.seasonal}/${w.total} tokens` : "—"}</SourceRow>
    <SourceRow label="Left out: stablecoins, tokenized stocks/gold, wrapped">{u.excluded == null ? "—" : `${u.excluded} tokens`}</SourceRow>
    <SourceRow label={`Too slow for +${c.targetPct ?? 4}% (typical 6h range under ${minRange == null ? "—" : `${minRange.toFixed(1)}%`})`}>{u.slow == null ? "—" : `${u.slow} tokens`}</SourceRow>
    <SourceRow label="Binance Monitoring list (never alerted)">{u.monitoring == null ? "—" : `${u.monitoring} tokens`}</SourceRow>
    {d.binancePausedUntil ? <SourceRow label="Binance rate limit" cls="red">Paused · resumes {time(d.binancePausedUntil)}</SourceRow> : null}
    <SourceRow label="Setup alerts" cls={c.setupAlerts ? "green" : "amber"}>{c.setupAlerts ? "On" : "Off · watchlist only"}</SourceRow>
    <SourceRow label="Telegram" wrap>{tgSt}</SourceRow>
    <div className="source-row"><span>{t.sent || 0} sent · {t.failed || 0} failed tries since start{t.queued ? <>{" · "}<b className="amber">{t.queued} waiting to send</b></> : null}
      {res ? <>{" · test: "}<b className={res.ok ? "green" : "red"}>{res.text}</b></> : null}</span>
      <button className="btn sm" id="tgTest" disabled={!t.configured || tg.sending === "tgTest"} onClick={() => tg.sendTest("tgTest")}>{tg.sending === "tgTest" ? "Sending…" : "Send test message"}</button></div>
    <SourceRow label="Last successful scan" cls="mono">{time(d.lastUpdated)}</SourceRow>
  </>;
}

export function DataHealth({ tg }: { tg: TgState }) {
  const { data } = useScreener();
  const hn: { name: string; change24hPct: number }[] = data?.hotNarratives || [];
  return (
    <section className="panel"><div className="section-head"><div><h2>Data health</h2><p>Check what is connected before trusting a signal</p></div></div>
      <div className="source-list" id="sources"><Sources tg={tg} /></div>
      <div className="section-head" style={{ paddingTop: 4 }}><div><h2 style={{ fontSize: 13 }}>Hot narratives now</h2><p>Median 24h change of each Binance sector&apos;s coins</p></div></div>
      <div className="chips" id="narrChips">
        {data && (hn.length ? hn.map((h, i) => <span className="badge strong" key={`${h.name}-${i}`}>{h.name} {pct(h.change24hPct)}</span>)
          : <span className="muted" style={{ fontSize: 12 }}>None above the threshold right now.</span>)}
      </div>
    </section>
  );
}

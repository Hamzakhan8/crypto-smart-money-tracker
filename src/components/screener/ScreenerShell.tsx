"use client";
// The screener page (/screener): the app bar with the tabs, the title, the status bar, the section tags, the active
// tab, the popups and the setup detail window. Tabs are picked by the address (#news, #perps…), as on the classic page,
// so old links and Telegram links keep working. Each tab's code loads only when it is opened.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { getJson } from "@/lib/api";
import { price } from "@/lib/format";
import { DetailModal } from "./DetailModal";
import { StatusBar } from "./StatusBar";
import { moveLine, structure } from "./coin";
import { ScreenerContext, type AlertEvent, type Candidate, type JournalPrefill, type ScreenerCtx, type ScreenerData, type ToastInput } from "./context";
import { EYEBROWS, HASH_ALIASES, LEDES, SECTIONS, TABS, TAB_LABELS, TITLES, type TabKey } from "./tabs";

const loading = () => <div className="empty">Loading…</div>;
const TAB_VIEWS: Record<TabKey, ComponentType> = {
  ignition: dynamic(() => import("./ignition"), { loading }),
  news: dynamic(() => import("./news"), { loading }),
  alpha: dynamic(() => import("./alpha"), { loading }),
  early2x: dynamic(() => import("./early2x"), { loading }),
  perps: dynamic(() => import("./perps"), { loading }),
  whales: dynamic(() => import("./whales"), { loading }),
  liquidity: dynamic(() => import("./liquidity"), { loading }),
  rotation: dynamic(() => import("./rotation"), { loading }),
  journal: dynamic(() => import("./journal"), { loading }),
};
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };
const tabFromHash = (): [TabKey, string | null] => {
  const h = location.hash.slice(1);
  if (HASH_ALIASES[h]) return HASH_ALIASES[h];
  return [(TABS as readonly string[]).includes(h) ? (h as TabKey) : "ignition", null];
};
// Whale and DEX popups: on the Whales tab every alert; on the other tabs only your own watches (wallet, token, pair).
const W_TYPES: Record<string, string> = { whale: "WHALE TRANSFER", deposit: "EXCHANGE DEPOSIT", withdrawal: "EXCHANGE WITHDRAWAL", mint: "STABLECOIN MINT", burn: "STABLECOIN BURN",
  issuer: "ISSUER MOVE", wallet: "WATCHED WALLET", token: "WATCHED TOKEN", watch: "PAIR WATCH", surge: "ROTATION SURGE", rotation: "WALLET ROTATION" };
const W_EVERYWHERE = new Set(["wallet", "token", "watch"]);
const NETWORKS: Record<string, string> = { eth: "Ethereum", base: "Base", solana: "Solana", bsc: "BNB Chain", arbitrum: "Arbitrum", polygon_pos: "Polygon" };
interface WhaleEvent { id: string; type: string; net?: string; title: string; lines?: string[]; links?: { label: string; url: string }[] }
interface Toast extends ToastInput { id: number }
const SAMPLE: AlertEvent = { id: "test", tier: "ignition", v: 5, symbol: "SAMPLEUSDT", score: 78, message: "Sample alert", time: Date.now(), detail: { base: "SAMPLE", name: "Sample Token", symbol: "SAMPLEUSDT", rank: 120, price: 1.2345,
  change24h: 3.1, ret15m: 1.2, ret1h: 2.4, rvol15: 5.3, rvol1h: 2.2, buyRatio15m: 67, r5: 4.1, prevR5: 5.6, buyRatio10m: 66, ret10m: 0.8, persist: 3, persistOf: 3, tradesRatio: 2.4, spreadBps: 3.1, rs15: 0.9, igScore: 78,
  trendUp: true, breakout: true, distTo12hHigh: 0.6, fadePct: 0.3, range6h: 5.4,
  igParts: { volume: { pts: 13, max: 20 }, persistence: { pts: 15, max: 15 }, buyers: { pts: 8, max: 10 }, structure: { pts: 20, max: 20 }, strength: { pts: 5, max: 5 }, context: { pts: 9, max: 15 }, quality: { pts: 8, max: 15 } },
  score: 62, label: "Watch closely", rvol: 2.1, rsi: 58, distToHigh: -0.012, mcFdv: 0.72, fundingPct: 0.008, oiChange24hPct: 6.5, compressed: true, aboveSma: true, quoteVolume: 42e6,
  reasons: ["24h volume 2.1x its 20d average", "within 3% of 20d high (coiling)", "volatility compression", "hot narrative: AI (coins +7.4% 24h)"],
  parts: { volume: { pts: 18, max: 25 }, technical: { pts: 25, max: 25 }, narrative: { pts: 15, max: 20 }, tokenomics: { pts: 10, max: 10 }, futures: { pts: 10, max: 10 }, liquidity: { pts: 7, max: 10 } } } };

export function ScreenerShell() {
  const [tab, setTabState] = useState<TabKey>("ignition");
  const [secs, setSecs] = useState<Record<string, string>>({});
  const [data, setData] = useState<ScreenerData | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ c: Candidate; eyebrow: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [soundOn, setSoundOn] = useState(false);
  const [notifyState, setNotifyState] = useState<NotificationPermission | "unsupported">("default");
  const prefill = useRef<JournalPrefill | null>(null);
  const tabRef = useRef(tab); tabRef.current = tab;
  const soundRef = useRef(soundOn); soundRef.current = soundOn;
  const audio = useRef<AudioContext | null>(null);
  const seenAlerts = useRef<Set<string> | null>(null), seenWhales = useRef<Record<string, Set<string> | null>>({ w: null, f: null });
  const toastId = useRef(0);
  const baseTitle = useRef("");
  const tagsRef = useRef<HTMLElement>(null), mainRef = useRef<HTMLElement>(null);

  // ---- tabs and section tags (remembered per tab) ----
  const sec = secs[tab] || "all";
  const setSec = useCallback((t: TabKey, key: string) => {
    if (key !== "all" && !SECTIONS[t].some((x) => x[0] === key)) key = "all";
    store.set("sec:" + t, key); setSecs((s) => ({ ...s, [t]: key }));
  }, []);
  const setTab = useCallback((t: TabKey, s?: string) => {
    setTabState(t);
    const want = t === "ignition" ? "" : "#" + t;
    if (location.hash !== want) history.replaceState(null, "", want || location.pathname);
    setSec(t, s ?? store.get("sec:" + t) ?? "all");
  }, [setSec]);
  useEffect(() => {
    baseTitle.current = document.title;
    const fromHash = () => { const [t, s] = tabFromHash(); setTab(t, s ?? undefined); };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    if (store.get("screenerSound") === "1") setSoundOn(true);
    setNotifyState("Notification" in window ? Notification.permission : "unsupported");
    const vis = () => { if (!document.hidden) document.title = baseTitle.current; };
    document.addEventListener("visibilitychange", vis);
    return () => { window.removeEventListener("hashchange", fromHash); document.removeEventListener("visibilitychange", vis); };
  }, [setTab]);

  // ---- popups ----
  const beep = useCallback(() => {
    if (!soundRef.current) return;
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audio.current = audio.current || new Ctx();
      const o = audio.current.createOscillator(), g = audio.current.createGain();
      o.type = "sine"; o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audio.current.destination); o.start(); o.stop(audio.current.currentTime + 0.18);
    } catch { /* no audio */ }
  }, []);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((x) => x.id !== id)), []);
  const toast = useCallback((t: ToastInput) => {
    const id = ++toastId.current;
    setToasts((ts) => [{ ...t, id }, ...ts].slice(0, 4));
    setTimeout(() => dismiss(id), t.ttlMs ?? 20_000);
    beep();
    if (t.notify) {
      if (document.hidden) document.title = `● ${t.notify.title} | ${baseTitle.current}`;
      if ("Notification" in window && Notification.permission === "granted") { try { new Notification(t.notify.title, { body: t.notify.body }); } catch { /* blocked */ } }
    }
  }, [beep, dismiss]);
  const openDetail = useCallback((c: Candidate | undefined | null, eyebrow?: string) => { if (c) setDetail({ c, eyebrow: eyebrow || "Setup detail" }); }, []);
  const alertToast = useCallback((ev: AlertEvent, test: boolean) => {
    const c = (ev.detail || {}) as Candidate, ign = ev.tier === "ignition" || ev.tier === "early", big = ev.tier === "bigmove", rule = ev.track?.rule || {};
    const tag = test ? "TEST ALERT" : ev.tier === "early" ? "EARLY IGNITION" : ev.tier === "ignition" ? ((ev.v ?? 0) >= 5 ? "CONFIRMED IGNITION" : "IGNITION") : big ? "BIG-MOVE IGNITION" : "NEW SETUP";
    const headline = big && c.big ? `24h volume ${c.rvol}× its 20-day average · last two 5m candles ${c.big.prevR5}× and ${c.big.r5}× normal · ${c.big.buyRatio10m}% buyers · tracked as +${rule.targetPct}% before -${rule.stopPct}%`
      : ign ? (c.r5 != null ? `last two 5m candles ${c.prevR5.toFixed(1)}× and ${c.r5.toFixed(1)}× normal volume · ${c.buyRatio10m == null ? "—" : c.buyRatio10m.toFixed(0)}% buyers`
        : `15m volume ${c.rvol15 == null ? "—" : c.rvol15.toFixed(1)}× normal for this hour · ${c.buyRatio15m == null ? "—" : c.buyRatio15m.toFixed(0)}% buyers${c.persist != null ? ` · held ${c.persist}/${c.persistOf}` : ""}`)
      : ((c.reasons || []).slice(0, 3).join(" · ") || ev.message || "");
    const struct = ign ? structure(c) : "", name = c.base || ev.symbol;
    toast({ tag, title: name, className: test ? "test" : undefined, ttlMs: 20_000,
      lines: [headline, ...(struct ? [struct] : []), <span className="mono" key="m">Moved so far: {moveLine(c)}</span>,
        <span className="mono" key="p">{price(c.price)}{c.rank ? ` · rank #${c.rank}` : ""} · {ign ? `ignition score ${ev.score} · daily ${c.score}` : `score ${ev.score}`}</span>],
      onClick: () => openDetail(c, test ? "Test alert (sample data)" : "Alert as it fired"),
      notify: test ? undefined : { title: `${name}: ${ev.tier === "early" ? "early ignition" : ev.tier === "ignition" ? "confirmed ignition" : big ? "big-move ignition" : "early setup"}`, body: `${headline} | moved ${moveLine(c)}` } });
  }, [toast, openDetail]);
  const whaleToast = useCallback((e: WhaleEvent) => {
    toast({ tag: W_TYPES[e.type] || e.type, title: NETWORKS[e.net || ""] || e.net || "", className: String(e.type).replace(/[^a-z]/g, ""), ttlMs: 25_000,
      lines: [<b style={{ color: "var(--ink)" }} key="t">{e.title}</b>, ...(e.lines || []),
        ...((e.links || []).length ? [<span key="l">{e.links!.map((l, i) => <span key={i}>{i ? " · " : ""}{/^https:\/\//.test(l.url) ? <a className="wlink" href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a> : l.label}</span>)}</span>] : [])],
      onClick: () => setTab("whales"), notify: { title: `${W_TYPES[e.type] || e.type}: ${e.title}`, body: (e.lines || []).join(" | ") } });
  }, [toast, setTab]);

  // ---- /api/screener every 3 s (alert popups on every tab) ----
  const reload = useCallback(async () => {
    try {
      const d = await getJson<ScreenerData>("/api/screener");
      setData(d); setDataError(null);
      const ev = d.events || [];
      if (seenAlerts.current === null) seenAlerts.current = new Set(ev.map((e) => e.id)); // first load: do not replay old alerts
      else for (const e of ev.filter((x) => !seenAlerts.current!.has(x.id)).reverse()) { seenAlerts.current.add(e.id); alertToast(e, false); }
    } catch (e) { setDataError(`Cannot load /api/screener: ${(e as Error).message}`); }
  }, [alertToast]);
  useEffect(() => { reload(); const t = setInterval(reload, 3000); return () => clearInterval(t); }, [reload]);
  // ---- whale and DEX alerts every 6 s ----
  useEffect(() => {
    const check = (list: WhaleEvent[] | undefined, src: "w" | "f") => {
      const ev = list || [], seen = seenWhales.current[src];
      if (seen === null) { seenWhales.current[src] = new Set(ev.map((e) => e.id)); return; }
      for (const e of ev.filter((x) => !seen.has(x.id)).reverse()) { seen.add(e.id); if (tabRef.current === "whales" || W_EVERYWHERE.has(e.type)) whaleToast(e); }
    };
    const poll = async () => {
      const [a, b] = await Promise.allSettled([getJson<{ events?: WhaleEvent[] }>("/api/whales?only=events"), getJson<{ events?: WhaleEvent[] }>("/api/flows?only=events")]);
      if (a.status === "fulfilled") check(a.value.events, "w");
      if (b.status === "fulfilled") check(b.value.events, "f");
    };
    poll(); const t = setInterval(poll, 6000); return () => clearInterval(t);
  }, [whaleToast]);

  // ---- phones: card tables show each value under its column name; tap a clamped text to read it ----
  useEffect(() => {
    const root = mainRef.current; if (!root) return;
    const label = () => {
      root.querySelectorAll<HTMLTableSectionElement>("table.cards tbody").forEach((tb) => {
        const hs = [...(tb.closest("table")?.querySelectorAll("thead th") || [])].map((th) => (th.textContent || "").trim());
        for (const tr of tb.rows) [...tr.cells].forEach((td, i) => {
          if (td.colSpan > 1) return;
          if (td.dataset.label !== (hs[i] || "")) td.dataset.label = hs[i] || "";
          const empty = /^[—–-]?$/.test((td.textContent || "").trim());
          if (empty && td.dataset.empty == null) td.dataset.empty = ""; else if (!empty && td.dataset.empty != null) delete td.dataset.empty;
        });
      });
    };
    let queued = false;
    // a timer, not requestAnimationFrame: that one pauses while the window is hidden and the labels would fall behind
    const mo = new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; label(); }, 50); } });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    label();
    const tap = (e: MouseEvent) => { const p = (e.target as HTMLElement).closest(".section-head p,.lede"); if (p && matchMedia("(max-width:700px)").matches) p.classList.toggle("open"); };
    document.addEventListener("click", tap);
    return () => { mo.disconnect(); document.removeEventListener("click", tap); };
  }, []);
  // the section tags stay just under the app bar
  useEffect(() => {
    const stick = () => { if (tagsRef.current) tagsRef.current.style.top = `${document.querySelector<HTMLElement>(".appbar")?.offsetHeight || 52}px`; };
    stick(); window.addEventListener("resize", stick); return () => window.removeEventListener("resize", stick);
  }, []);
  const pickSec = (key: string) => {
    setSec(tab, key);
    const bar = tagsRef.current; if (!bar) return;
    const top = bar.getBoundingClientRect().top + window.scrollY - (document.querySelector<HTMLElement>(".appbar")?.offsetHeight || 52) - 14;
    if (window.scrollY > top) window.scrollTo({ top, behavior: "smooth" });
  };

  const ctx: ScreenerCtx = useMemo(() => ({
    tab, setTab, sec, show: (ids: string) => sec === "all" || ids.split(" ").includes(sec),
    data, dataError, reload: () => { reload(); },
    aiTake: (key: string) => data?.aiVerdicts?.[String(key || "").toUpperCase()]?.decision === "TAKE",
    openDetail,
    openJournal: (p: JournalPrefill) => { prefill.current = p; setTab("journal", "all"); },
    takeJournalPrefill: () => { const p = prefill.current; prefill.current = null; return p; },
    toast,
  }), [tab, setTab, sec, data, dataError, reload, openDetail, toast]);

  const st = data?.status, live = st === "connected" || st === "demo" || st === "binance_only" || st === "warming_up";
  const View = TAB_VIEWS[tab];
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.indexOf(tab), n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setTab(n); document.getElementById(`tab-${n}`)?.focus();
  };
  return (
    <ScreenerContext.Provider value={ctx}>
      <div className="appbar"><div className="appbar-in">
        <a className="brand" href="/"><i /><span>Smart Money Tracker</span></a>
        <nav className="appnav" aria-label="Apps"><a href="/">Market flow</a>
          <span className="tabs" role="tablist" aria-label="Screeners" onKeyDown={onTabKey}>
            {TABS.map((t) => <button key={t} id={`tab-${t}`} role="tab" aria-selected={t === tab} aria-controls={`view-${t}`} tabIndex={t === tab ? 0 : -1} onClick={() => setTab(t)}>{TAB_LABELS[t]}</button>)}
          </span><a href="/ai">AI desk</a></nav>
        <span className="chip"><span className={`dot ${live && !dataError ? "" : "bad"}`} />
          {dataError ? "Server offline" : st === "demo" ? "DEMO DATA" : st === "connected" ? "Scanner connected" : st === "binance_only" ? "Binance-only mode" : st === "warming_up" ? "Warming up…" : st === "error" ? "Scanner error" : "Starting…"}</span>
      </div></div>
      <main className="wrap" ref={mainRef}>
        <header>
          <div><div className="eyebrow">{EYEBROWS[tab]}</div><h1>{TITLES[tab]}</h1><p className="lede">{LEDES[tab]}</p></div>
          {tab === "ignition" && <div className="header-right">
            <button className={`btn sm${soundOn ? " on" : ""}`} title="Play a short tone when a new alert arrives"
              onClick={() => { const on = !soundOn; setSoundOn(on); soundRef.current = on; store.set("screenerSound", on ? "1" : "0"); if (on) beep(); }}>Sound: {soundOn ? "on" : "off"}</button>
            {notifyState !== "unsupported" && <button className={`btn sm${notifyState === "granted" ? " on" : ""}`} title="Show desktop notifications for new alerts"
              onClick={async () => { if (Notification.permission === "default") { try { await Notification.requestPermission(); } catch { /* blocked */ } } setNotifyState(Notification.permission); }}>
              {notifyState === "granted" ? "Desktop alerts: on" : notifyState === "denied" ? "Desktop alerts: blocked" : "Desktop alerts"}</button>}
            <button className="btn sm" title="Preview what an alert popup looks like" onClick={() => alertToast(SAMPLE, true)}>Test popup</button>
          </div>}
        </header>
        <StatusBar />
        <nav className="sectags" ref={tagsRef} aria-label="Sections of this page">
          {[["all", "All"] as [string, string], ...SECTIONS[tab]].map(([k, l]) => <button key={k} type="button" className={k === sec ? "on" : undefined} aria-pressed={k === sec} onClick={() => pickSec(k)}>{l}</button>)}
        </nav>
        <div id={`view-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className={sec !== "all" ? "filtered" : undefined}><View /></div>
      </main>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.className ? ` ${t.className}` : ""}`}
            onClick={(e) => { const el = e.target as HTMLElement; if (el.closest(".x")) { dismiss(t.id); return; } if (el.closest("a")) return; t.onClick?.(); dismiss(t.id); }}>
            <h4><span><span className="tag">{t.tag}</span> &nbsp;{t.title}</span><button className="x" aria-label="Dismiss">✕</button></h4>
            {(t.lines || []).map((l, i) => <p key={i}>{l}</p>)}
          </div>))}
      </div>
      {detail && <DetailModal c={detail.c} eyebrow={detail.eyebrow} onClose={() => setDetail(null)} />}
    </ScreenerContext.Provider>
  );
}

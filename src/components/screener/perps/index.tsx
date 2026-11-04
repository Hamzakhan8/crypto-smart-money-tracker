"use client";
// The Perps tab: swing signals on Binance USDⓈ-M perpetuals (/api/perps every 60 s), Scalp flush-bounce longs and the
// paper bot (/api/scalp every 15 s), Check a trade (/api/perps/check), the risk settings saved in this browser, the
// coins scanned, live results, the backtest and data health. Ported from public/screener.html (#view-perps).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { getJson } from "@/lib/api";
import { useStored } from "@/components/useStored";
import { Sec } from "../context";
import { ErrorBox, usePoll } from "../ui";
import { BOT_FORM0, PaperBot, type BotForm } from "./PaperBot";
import { ScalpCoins, ScalpError, ScalpFoot, ScalpKpis, ScalpNotice, ScalpSignals, ScalpTest } from "./Scalp";
import { CheckPanel, CoinsPanel, HealthPanel, LivePanel, PerpsNotice, RiskPanel, SignalsPanel, SwingKpis, TestedPanel, type CheckForm } from "./Swing";
import { blockedHint, riskOf, useRiskInputs, type PerpsData, type ScalpData } from "./lib";

export default function PerpsTab() {
  const perps = usePoll<PerpsData>("/api/perps", 60_000);
  const scalp = usePoll<ScalpData>("/api/scalp", 15_000);
  const pd = perps.data, sd = scalp.data;
  const [riskVals, setRisk] = useRiskInputs();
  const rk = riskOf(riskVals);

  // ---- signal list: the view (remembered), the selected row and its card ----
  const [view, setView] = useStored("perps:view", "all");
  const [sel, setSel] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const pickSignal = (id: string) => {
    const next = sel === id ? null : id;
    flushSync(() => setSel(next));
    if (next) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  // ---- Check a trade ----
  const [ck, setCk] = useState<CheckForm>({ sym: "", side: "long", entry: "", stop: "" });
  const [ckRes, setCkRes] = useState<any>(null), [ckErr, setCkErr] = useState(""), [ckBusy, setCkBusy] = useState(false);
  const ckForm = useRef<HTMLFormElement>(null);
  const runCheck = async (f: CheckForm) => {
    setCkErr(""); setCkBusy(true);
    try {
      const q = new URLSearchParams({ sym: f.sym, side: f.side });
      if (f.entry) q.set("entry", f.entry);
      if (f.stop) q.set("stop", f.stop);
      const r = await getJson<any>("/api/perps/check?" + q);
      if (r.error) throw new Error(r.error);
      setCkRes(r);
    } catch (e) { setCkRes(null); setCkErr((e as Error).message); }
    finally { setCkBusy(false); }
  };
  // a coin in the Coins table: check it (through the form, as if submitted, when the form is on screen)
  const pickCoin = (base: string) => {
    const f = { ...ck, sym: base };
    if (ckForm.current) {
      flushSync(() => setCk(f));
      ckForm.current.requestSubmit();
      ckForm.current.scrollIntoView({ behavior: "smooth", block: "start" });
    } else { setCk(f); runCheck(f); }
  };

  // ---- paper bot: the settings form shows the account's settings once they arrive (and again after a reset) ----
  const [bot, setBot] = useState<BotForm>(BOT_FORM0), [botMsg, setBotMsg] = useState("");
  const botSet = useRef(false);
  useEffect(() => {
    const a = sd?.paper;
    if (a && !botSet.current) { botSet.current = true; setBot({ start: String(a.start), riskPct: String(a.riskPct), leverage: String(a.leverage), maxOpen: String(a.maxOpen) }); }
  }, [sd]);
  const resetBot = async () => {
    if (!confirm("Start a new paper account? The paper bot's trades so far are cleared.")) return;
    setBotMsg("Resetting…");
    try {
      const r = await fetch("/api/scalp/paper/reset", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: +bot.start, riskPct: +bot.riskPct, leverage: +bot.leverage, maxOpen: +bot.maxOpen }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      botSet.current = false;
      scalp.setData((o) => (o ? { ...o, paper: j.paper } : o));
      setBotMsg("New paper account started.");
    } catch (e) { setBotMsg("Not reset: " + (e as Error).message); }
  };

  const pErr = perps.error ? `Perps: ${perps.error}` : pd?.error ? `Perps: ${pd.error}${blockedHint(pd.error)}` : null;
  return (
    <>
      <PerpsNotice />
      <ErrorBox>{pErr}</ErrorBox>
      <Sec id="signals">
        <SwingKpis d={pd} rk={rk} />
        <SignalsPanel d={pd} rk={rk} view={view} setView={setView} sel={sel} onPick={pickSignal} cardRef={cardRef} />
      </Sec>
      <Sec id="scalp">
        <ScalpNotice />
        <ScalpError d={sd} fetchError={scalp.error} />
        <ScalpKpis d={sd} />
        <ScalpSignals d={sd} rk={rk} />
      </Sec>
      <Sec id="bot"><PaperBot d={sd} form={bot} setForm={setBot} msg={botMsg} onReset={resetBot} /></Sec>
      <Sec id="scalp">
        <ScalpTest d={sd} />
        <ScalpCoins d={sd} />
        <ScalpFoot />
      </Sec>
      <Sec id="check"><CheckPanel d={pd} rk={rk} form={ck} setForm={setCk} busy={ckBusy} err={ckErr} res={ckRes} onCheck={() => runCheck(ck)} formRef={ckForm} /></Sec>
      <Sec id="risk"><RiskPanel vals={riskVals} set={setRisk} /></Sec>
      <Sec id="coins"><CoinsPanel d={pd} onPick={pickCoin} /></Sec>
      <Sec id="live"><LivePanel d={pd} /></Sec>
      <Sec id="tested"><TestedPanel d={pd} /></Sec>
      <Sec id="health"><HealthPanel d={pd} /></Sec>
    </>
  );
}

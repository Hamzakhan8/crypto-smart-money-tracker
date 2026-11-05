// System status: every part of the app in one list (working, warning, broken or off), with its last update and exact
// error, for the status bar at the top of the screener page (/api/status). Checked every minute; when a part has been
// broken or silent for 30 minutes, Telegram gets one warning, and one "OK again" message when it recovers.
const MIN = 60_000;

// What a part reports about itself (its get()). off = switched off by a setting (never a problem).
export interface PartReport { off?: boolean; status?: string; error?: string | null; warn?: string | null; updatedAt?: number | null; detail?: string }
// A part of the app: every = minutes between updates when healthy; alert: false = shown, but no Telegram warning of its own.
export interface HealthSource { key: string; name: string; every: number; alert?: boolean; get: () => PartReport }
// One part's state on the status bar. since = when it broke (while it is broken).
export interface PartStatus { key: string; name: string; updatedAt: number | null; detail: string; state: "ok" | "warn" | "error" | "off"; text: string; since?: number }
export interface HealthOptions {
  sources?: HealthSource[]; sendTelegram?: ((text: string, kind: string) => unknown) | null; wantTelegram?: (kind: string) => boolean;
  now?: () => number; alertAfterMin?: number;
}

// One part's state from what it reports. src: { key, name, every (minutes between updates when healthy), get() }.
// get() returns { off, status, error, updatedAt, detail, warn }: off = switched off by a setting (never a problem).
export function judge(src: Pick<HealthSource, "key" | "name" | "every">, x: PartReport | null | undefined, now: number, startedAt: number): PartStatus {
  const base = { key: src.key, name: src.name, updatedAt: x?.updatedAt ?? null, detail: x?.detail || "" };
  if (!x || x.off) return { ...base, state: "off", text: x?.detail || "switched off" };
  const age = x.updatedAt ? (now - x.updatedAt) / MIN : null, young = now - startedAt < Math.max(10, src.every * 2) * MIN;
  if (x.error && !(x.updatedAt && age <= src.every * 3)) return { ...base, state: young ? "warn" : "error", text: x.error };
  if (!x.updatedAt) return young ? { ...base, state: "warn", text: x.error || "starting…" } : { ...base, state: "error", text: x.error || "has not finished a single update" };
  if (age > src.every * 3) return { ...base, state: "error", text: `no update for ${Math.round(age)} minutes${x.error ? `: ${x.error}` : ""}` };
  if (x.warn || x.error) return { ...base, state: "warn", text: x.warn || x.error };
  return { ...base, state: "ok", text: x.detail || "working" };
}

export function createHealth({ sources = [], sendTelegram = null, wantTelegram = () => false, now = () => Date.now(), alertAfterMin = 30 }: HealthOptions) {
  const startedAt = now(), bad = new Map<string, { since: number; alerted: boolean }>(); // key -> { since, alerted }
  let last: PartStatus[] = [];
  function check(): PartStatus[] {
    const t = now(), out: PartStatus[] = [];
    for (const src of sources) {
      let x: PartReport; try { x = src.get(); } catch (e) { x = { error: `status check failed: ${e.message}` }; }
      const r = judge(src, x, t, startedAt);
      out.push(r);
      const b = bad.get(src.key);
      if (r.state === "error") {
        if (!b) bad.set(src.key, { since: t, alerted: false });
        else if (!b.alerted && t - b.since >= alertAfterMin * MIN && src.alert !== false) {
          b.alerted = true;
          if (sendTelegram && wantTelegram("health")) sendTelegram(`WARNING: ${r.name} is not working (since ${new Date(b.since).toISOString().slice(11, 16)} UTC): ${r.text}. Open the screener page and check the status bar at the top.`, "health");
        }
      } else if (r.state !== "warn" && b) { // back to working (or switched off)
        if (b.alerted && sendTelegram && wantTelegram("health")) sendTelegram(`OK again: ${r.name} works again (it was down ${Math.round((t - b.since) / MIN)} minutes).`, "health");
        bad.delete(src.key);
      }
      if (r.state === "error" && bad.get(src.key)) r.since = bad.get(src.key).since;
    }
    last = out;
    return out;
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  function start() { if (timer) return; setTimeout(check, 5_000).unref?.(); timer = setInterval(check, MIN); timer.unref?.(); }
  const api = () => { const parts = last.length ? last : check(); return { checkedAt: now(), ok: parts.filter((p) => p.state === "ok").length, problems: parts.filter((p) => p.state === "error").length, parts }; };
  return { start, check, api };
}

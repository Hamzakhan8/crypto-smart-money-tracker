// One Telegram sender for every alert in the app (Ignition, big-move, Alpha, Early 2x, AI verdicts, whales, DEX, Market
// Flow, BTC rotation). Messages go through a delivery queue: sent one at a time at Telegram's pace, retried when
// Telegram or the network fails (with the wait Telegram asks for on a rate limit), kept in telegram_state.json so a
// restart does not lose them, and dropped only when they are too old to act on (3 hours). A message that arrives late
// says so. Every send is logged; failures are explained in plain words (wrong token, chat not found, bot never
// started, blocked, no network) in the terminal and on the screener's Telegram panel.
//
// Which kinds of alert go to Telegram can be switched on the page (saved in telegram_state.json); .env gives the
// defaults. A startup message and a daily check-in confirm the connection works even on days with no alerts.
import { readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "./util.ts";

const env = process.env;
const API = "https://api.telegram.org";
const MIN = 60_000, HOUR = 60 * MIN;
const GAP_MS = 1100;             // Telegram allows about one message a second per chat
const MAX_AGE_MS = 3 * HOUR;     // an alert older than this is no longer useful
const MAX_QUEUE = 300, MAX_LOG = 200, CHUNK = 3900;
const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = env.TELEGRAM_STATE_FILE || path.join(here, env.DEMO === "1" ? "telegram_state.demo.json" : "telegram_state.json"); // override: tests

/** What sendTelegram resolves to after the first try. */
export interface TgResult { sent: boolean; queued?: boolean; skipped?: string; error?: string }
/** kind = one of TG_KINDS (default "system"); force = send even if that kind is switched off. */
export interface TgOptions { kind?: string; force?: boolean }
/** A message in the delivery queue (saved in telegram_state.json). */
interface QueueItem { id: string; kind: string; text: string; createdAt: number; tries: number; next: number; lastError?: string; force?: boolean; dead?: boolean }
/** A line of the Telegram panel's log. */
export interface TgLogEntry { at: number; kind: string; title: string; status: string; tries: number; delaySec: number; error?: string }
/** The parts of Telegram's answer that are used (getMe: the bot, getChat: the chat). */
interface TgChat { username?: string; title?: string; first_name?: string; last_name?: string }
interface TgReply { ok?: boolean; result?: TgChat; description?: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } }
export interface TransportResult { ok: boolean; result?: TgChat; code?: number; description?: string; retryAfter?: number | null; migrateTo?: number | null }
type Transport = (method: string, payload?: { chat_id?: string; text?: string; disable_web_page_preview?: boolean }) => Promise<TransportResult>;

// Kinds of message, their label and their default (on unless said otherwise; .env can change the default).
const off = (v: string | undefined) => v === "0" || v === "false" || v === "off";
export const TG_KINDS: Record<string, { label: string; def: boolean }> = {
  ignition: { label: "Ignition alerts (early and confirmed)", def: !off(env.SCREENER_TELEGRAM) },
  // big-move and Alpha: off by default since Nov 2026 (both lost money live: big-move 0 of 14, Alpha confirmed 2 of 15)
  bigmove: { label: "Big-move alerts (+40% before -10%)", def: env.SCREENER_BIGMOVE_ALERTS === "1" },
  spot: { label: "Spot plan: BTC / ETH buy or sell (50-day trend)", def: !off(env.SPOT_TELEGRAM) },
  pump: { label: "Pump watch: daily list after the close (only when market mood is OK)", def: !off(env.PUMP_TELEGRAM) },
  alpha: { label: "Alpha confirmed alerts", def: env.ALPHA_TELEGRAM === "1" || env.ALPHA_TELEGRAM === "all" },
  alphaEarly: { label: "Alpha early alerts (about 50 a day)", def: env.ALPHA_TELEGRAM === "all" },
  early2x: { label: "Early 2x high-priority candidates", def: !off(env.EARLY2X_ALERTS) },
  perps: { label: "Perps swing signals (TAKE only)", def: !off(env.PERPS_TELEGRAM) },
  scalp: { label: "Perps scalp signals (flush bounce, 5m)", def: !off(env.SCALP_TELEGRAM) },
  scalpBot: { label: "Scalp paper bot: each closed trade and the balance", def: !off(env.SCALP_BOT_TELEGRAM) },
  onchain: { label: "On-chain: crowd vs smart money signals (4h, long and short)", def: !off(env.ONCHAIN_TELEGRAM) },
  // new and not backtested (Nov 2026): on the page by default, Telegram once you switch it on (or WHALESIG_TELEGRAM=1)
  whalesig: { label: "Whale signals: TAKE LONG / TAKE SHORT / LEAVE from whale wallets (new, not tested yet)", def: env.WHALESIG_TELEGRAM === "1" },
  ai: { label: "AI verdicts on new alerts", def: !off(env.AI_REVIEW_TELEGRAM) },
  rotation: { label: "BTC rotation: regime or holdings changed", def: env.ROTATION_TELEGRAM === "1" },
  whales: { label: "Whale transfers", def: env.WHALES_TELEGRAM === "1" },
  flows: { label: "DEX rotations", def: env.FLOWS_TELEGRAM === "1" },
  radar: { label: "Market Flow strong flow", def: env.RADAR_TELEGRAM === "1" },
  health: { label: "Warnings when a part stops working (and when it works again)", def: !off(env.HEALTH_TELEGRAM) },
  system: { label: "Startup message and daily check-in", def: !off(env.TELEGRAM_CHECKIN) },
};

const status: {
  bot: string | null; checkedAt: number | null; lastSentAt: number | null; lastError: string | null; lastErrorAt: number | null; sent: number; failed: number;
  saveError?: string | null; stateError?: string; chat?: string | null;
} = { bot: null, checkedAt: null, lastSentAt: null, lastError: null, lastErrorAt: null, sent: 0, failed: 0 };
const store: { prefs: Record<string, boolean>; items: QueueItem[]; log: TgLogEntry[]; lastCheckinDay: string | null } = { prefs: {}, items: [], log: [], lastCheckinDay: null };
let loaded = false, timer: NodeJS.Timeout | null = null, busy = false, lastSendAt = 0, saveTimer: NodeJS.Timeout | null = null, seq = 0;
const waiters = new Map<string, (r: TgResult) => void>(); // item id -> resolve(first attempt result)
const creds = () => ({ token: (env.TELEGRAM_BOT_TOKEN || "").trim(), chat: (env.TELEGRAM_CHAT_ID || "").trim() });
export const telegramConfigured = (): boolean => { const c = creds(); return !!(c.token && c.chat); };

export function telegramWants(kind: string): boolean {
  const k = TG_KINDS[kind] ? kind : "system";
  return store.prefs[k] ?? TG_KINDS[k].def;
}
export function setTelegramPref(kind: string, on: boolean): boolean {
  if (!TG_KINDS[kind]) return false;
  store.prefs[kind] = !!on; save();
  return true;
}

// What went wrong and how to fix it, from Telegram's HTTP status and error text.
export function telegramHint(code: number, description = "", migrateTo: number | null = null): string {
  const d = String(description || "");
  if (code === 401 || code === 404 || /unauthorized|not found: bot/i.test(d)) {
    const t = creds().token, odd = t && !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t);
    return `the bot token is wrong: copy it again from @BotFather into TELEGRAM_BOT_TOKEN in .env, then restart${odd ? ". It should look like 123456789:AAH... with nothing before or after it (no word \"bot\", no web address, no quotes or < >)" : ""}`;
  }
  if (migrateTo || /upgraded to a supergroup/i.test(d)) return `your Telegram group became a supergroup, so its id changed: set TELEGRAM_CHAT_ID=${migrateTo ?? "<the new id>"} in .env and restart`;
  if (/chat not found/i.test(d)) return "chat not found: TELEGRAM_CHAT_ID is wrong, or you never opened your bot in Telegram and pressed Start (for a group: add the bot and use the group id, which starts with -100)";
  if (/blocked by the user/i.test(d)) return "you blocked the bot: open it in Telegram and press Start (or Unblock)";
  if (/not a member|kicked|have no rights|not enough rights/i.test(d)) return "the bot cannot post in that chat: add it to the group, or as an admin of the channel";
  if (code === 429) return "Telegram rate limit (too many messages): it will work again shortly";
  if (code === 0 && /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|certificate/i.test(d)) return `a program on this PC (antivirus HTTPS scanning or a company proxy) replaces Telegram's certificate, or the PC clock is wrong: fix the clock, exclude api.telegram.org from HTTPS scanning, or run \`set NODE_OPTIONS=--use-system-ca\` and then \`npm start\` in the same terminal (${d})`;
  if (code === 0 && /ENOTFOUND|EAI_AGAIN/i.test(d)) return `cannot find api.telegram.org (DNS): check the internet connection, or your network blocks Telegram (${d})`;
  if (code === 0) return `cannot reach api.telegram.org: check the internet connection, firewall or VPN. If Telegram is blocked where you are and you use a VPN or proxy: this app does not use the Windows proxy setting, so switch the VPN to full-tunnel (TUN) mode, or run \`set HTTPS_PROXY=http://127.0.0.1:PORT\` then \`set NODE_OPTIONS=--use-env-proxy\` and \`npm start\` in the same terminal (${d})`;
  return `Telegram error ${code}: ${d || "unknown"}`;
}
// How long to wait before the next try. Setup problems (wrong token or chat) are retried every 5 minutes, so the
// messages still go out once .env is fixed and the app restarted; network and server errors back off quickly.
export function retryDelay(code: number, tries: number, retryAfterSec: number | null = null): number {
  if (code === 429) return Math.max(1, retryAfterSec ?? 5) * 1000 + 250;
  if (code === 400 || code === 401 || code === 403 || code === 404) return 5 * MIN;
  return Math.min(10 * MIN, [3, 10, 30, 60, 120, 300][Math.min(tries - 1, 5)] * 1000);
}
// Long messages are split at line breaks into Telegram-sized parts.
export function splitMessage(text: string, max = CHUNK): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of String(text).split("\n")) {
    for (let piece = line; ;) {
      const room = max - (cur ? cur.length + 1 : 0);
      if (piece.length <= room) { cur = cur ? cur + "\n" + piece : piece; break; }
      if (cur) { out.push(cur); cur = ""; continue; }
      out.push(piece.slice(0, max)); piece = piece.slice(max);
      if (!piece) break;
    }
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

let transport: Transport = async (method, payload) => {
  const { token } = creds();
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(12_000),
    });
    const j: TgReply = await res.json().catch(() => ({}));
    return res.ok && j.ok !== false ? { ok: true, result: j.result } : { ok: false, code: res.status, description: j.description || res.statusText, retryAfter: j.parameters?.retry_after ?? null, migrateTo: j.parameters?.migrate_to_chat_id ?? null };
  } catch (e) { return { ok: false, code: 0, description: e.cause?.code || e.message }; }
};
export const __setTransport = (fn: Transport) => { transport = fn; }; // tests

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = { version: 1, prefs: store.prefs, lastCheckinDay: store.lastCheckinDay, log: store.log, items: store.items.map(({ id, kind, text, createdAt, tries, next, lastError }) => ({ id, kind, text, createdAt, tries, next, lastError })) };
    writeAtomic(STATE_FILE, JSON.stringify(data)).then(() => { status.saveError = null; }).catch((e) => {
      const code = e.code || e.message;
      if (status.saveError !== code) console.warn(`Telegram: could not save telegram_state.json (${code}): switch changes may not survive a restart (a folder synced by OneDrive or an antivirus can block it)`);
      status.saveError = code;
    });
  }, 800);
  saveTimer.unref?.();
}
let loading: Promise<void> | null = null;
function load(): Promise<void> { // every caller waits for the same read, so nothing queued during it is lost
  return (loading ??= (async () => {
    let text: string | null = null;
    try { text = await readFile(STATE_FILE, "utf8"); } catch (e) { if (e.code !== "ENOENT") stateProblem(e.code || e.message); }
    if (text != null) {
      try {
        const s = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (s?.version === 1) {
          store.prefs = s.prefs || {}; store.log = Array.isArray(s.log) ? s.log.slice(0, MAX_LOG) : []; store.lastCheckinDay = s.lastCheckinDay || null;
          const items: QueueItem[] = Array.isArray(s.items) ? s.items.filter((x: QueueItem) => x && x.text) : [];
          for (const x of items.filter((y) => Date.now() - y.createdAt >= MAX_AGE_MS)) logEntry(x, "expired", { error: x.lastError || "too old to send after a restart" });
          store.items = [...items.filter((x) => Date.now() - x.createdAt < MAX_AGE_MS).map((x) => ({ ...x, next: Date.now() + 2000 })), ...store.items];
        }
      } catch (e) {
        stateProblem("damaged file");
        copyFile(STATE_FILE, STATE_FILE + ".bad").catch(() => {});
      }
    }
    loaded = true;
  })());
}
function stateProblem(why: string) {
  status.stateError = why;
  console.warn(`Telegram: telegram_state.json could not be read (${why}): the on/off switches are back to the .env defaults until you set them again on the page${why === "damaged file" ? " (the old file is kept as telegram_state.json.bad)" : ""}`);
}
const title = (text: string) => String(text).split("\n")[0].slice(0, 120);
function logEntry(it: QueueItem, st: string, extra: { error?: string } = {}) {
  store.log.unshift({ at: Date.now(), kind: it.kind, title: title(it.text), status: st, tries: it.tries, delaySec: Math.round((Date.now() - it.createdAt) / 1000), ...extra });
  if (store.log.length > MAX_LOG) store.log.length = MAX_LOG;
}
function settle(id: string, result: TgResult) { const w = waiters.get(id); if (w) { waiters.delete(id); w(result); } }
function schedule(ms: number) { clearTimeout(timer); timer = setTimeout(pump, Math.max(50, ms)); timer.unref?.(); }

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    for (const it of store.items) if (now - it.createdAt > MAX_AGE_MS) {
      it.dead = true; logEntry(it, "expired", { error: it.lastError || "too old to be useful" }); settle(it.id, { sent: false, error: it.lastError || "expired" });
    }
    if (store.items.some((x) => x.dead)) { store.items = store.items.filter((x) => !x.dead); save(); }
    if (!store.items.length) return;
    const due = store.items.filter((x) => x.next <= now).sort((a, b) => (b.force ? 1 : 0) - (a.force ? 1 : 0) || a.createdAt - b.createdAt)[0]; // a test message goes first
    if (!due) return schedule(Math.min(...store.items.map((x) => x.next)) - now);
    if (lastSendAt + GAP_MS > now) return schedule(lastSendAt + GAP_MS - now);
    if (!telegramConfigured()) { due.next = now + 5 * MIN; due.lastError = "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set"; return schedule(GAP_MS); }
    const lateMin = Math.round((now - due.createdAt) / MIN);
    lastSendAt = now; due.tries++;
    const r = await transport("sendMessage", { chat_id: creds().chat, text: (lateMin >= 2 ? `(delayed ${lateMin} min) ` : "") + due.text, disable_web_page_preview: true });
    if (r.ok) {
      status.sent++; status.lastSentAt = Date.now(); status.lastError = null;
      store.items = store.items.filter((x) => x !== due);
      logEntry(due, "sent");
      settle(due.id, { sent: true });
    } else {
      const hint = telegramHint(r.code, r.description, r.migrateTo);
      status.failed++; status.lastError = hint; status.lastErrorAt = Date.now();
      due.lastError = hint; due.next = Date.now() + retryDelay(r.code, due.tries, r.retryAfter);
      if (due.tries === 1 || due.tries % 10 === 0) console.warn(`Telegram: not sent yet (try ${due.tries}, will retry): ${hint}`);
      if (due.tries === 1) logEntry(due, "retrying", { error: hint });
      settle(due.id, { sent: false, queued: true, error: hint });
    }
    save();
    schedule(GAP_MS);
  } finally { busy = false; }
}

// A signal the app found but did not send, and why (a rule held it back, or its kind is switched off). Shown in the
// Telegram panel's log and counted in the daily check-in, so a quiet Telegram is never mistaken for a broken one.
export function noteHeld(kind: string, text: string, reason?: string): void {
  const k = TG_KINDS[kind] ? kind : "system";
  const go = () => { store.log.unshift({ at: Date.now(), kind: k, title: title(text), status: "held", tries: 0, delaySec: 0, error: String(reason || "held back") });
    if (store.log.length > MAX_LOG) store.log.length = MAX_LOG; save(); };
  if (loaded) go(); else load().then(go, go);
}

// Queues a message. Resolves after the first try: { sent: true }, { sent: false, queued: true, error } (it keeps
// retrying), or { sent: false, skipped } (Telegram not set up, or this kind is switched off).
// opts.kind = one of TG_KINDS (default "system"); opts.force = send even if that kind is switched off (you asked for it).
export async function sendTelegram(text: string, opts: TgOptions = {}): Promise<TgResult> {
  const kind = TG_KINDS[opts.kind] ? opts.kind : "system";
  if (!telegramConfigured()) return { sent: false, skipped: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set in .env" };
  await load(); // the switches saved on the page, not the .env defaults
  if (!opts.force && !telegramWants(kind)) { noteHeld(kind, text, "this kind is switched off on the page (Telegram section)"); return { sent: false, skipped: `${TG_KINDS[kind].label} are switched off` }; }
  await load();
  const parts = splitMessage(text);
  const ids = parts.map((part, i) => {
    const id = `m${Date.now().toString(36)}${(seq++).toString(36)}`;
    store.items.push({ id, kind, text: parts.length > 1 ? `${part}${i < parts.length - 1 ? "\n(continued)" : ""}` : part, createdAt: Date.now(), tries: 0, next: Date.now(), ...(opts.force ? { force: true } : {}) });
    return id;
  });
  if (store.items.length > MAX_QUEUE) { const drop = store.items.splice(0, store.items.length - MAX_QUEUE); for (const it of drop) { logEntry(it, "dropped", { error: "queue full" }); settle(it.id, { sent: false, error: "queue full" }); } }
  save();
  const first = new Promise<TgResult>((resolve) => waiters.set(ids[0], resolve));
  schedule(0);
  return first;
}

// Checks the token (getMe) once at startup; the chat is checked by the first message or the "Send test message" button.
export async function checkTelegram(): Promise<string> {
  if (!telegramConfigured()) return "not configured (add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env)";
  const r = await transport("getMe");
  status.checkedAt = Date.now();
  if (!r.ok) { status.lastError = telegramHint(r.code, r.description); status.lastErrorAt = Date.now(); return `PROBLEM: ${status.lastError}`; }
  status.bot = r.result?.username ? "@" + r.result.username : "ok";
  const c = await transport("getChat", { chat_id: creds().chat }); // a wrong chat id is found now, not at the first alert
  if (!c.ok && c.code !== 0) { status.lastError = telegramHint(c.code, c.description, c.migrateTo); status.lastErrorAt = Date.now(); return `PROBLEM: bot ${status.bot} works, but ${status.lastError}`; }
  if (status.lastError && !(status.lastSentAt > status.lastErrorAt)) status.lastError = null; // the check passed: clear an old error
  status.chat = c.ok ? (c.result?.title || [c.result?.first_name, c.result?.last_name].filter(Boolean).join(" ") || c.result?.username || null) : null;
  return `bot ${status.bot}, sending to ${status.chat ? `"${status.chat}" (${creds().chat})` : `chat ${creds().chat}`}`;
}

// One more line for the daily check-in from the app (for example why Ignition is quiet today); set by screener.ts.
let extraCheckin = (): string | null => null;
export const setCheckinExtra = (fn: () => string | null | undefined) => { extraCheckin = () => { try { return fn() || null; } catch { return null; } }; };
const onList = () => Object.keys(TG_KINDS).filter((k) => k !== "system" && telegramWants(k)).map((k) => TG_KINDS[k].label);
const CHECKIN_HOUR = Number.isFinite(Number(env.TELEGRAM_CHECKIN_HOUR)) && env.TELEGRAM_CHECKIN_HOUR !== "" && env.TELEGRAM_CHECKIN_HOUR !== undefined ? Number(env.TELEGRAM_CHECKIN_HOUR) : 8;
// Daily check-in (at CHECKIN_HOUR UTC): what was sent in the last 24 hours, so silence never means "broken" by mistake.
export function checkinText(now = Date.now()): string {
  const day = store.log.filter((x) => now - x.at < 24 * HOUR), sent = day.filter((x) => x.status === "sent" && x.kind !== "system"), held = day.filter((x) => x.status === "held");
  const by = Object.entries(sent.reduce((m: Record<string, number>, x) => ((m[x.kind] = (m[x.kind] || 0) + 1), m), {})).map(([k, n]) => `${TG_KINDS[k]?.label || k}: ${n}`);
  const bad = day.filter((x) => x.status === "expired" || x.status === "dropped").length;
  return [`Smart Money Tracker daily check-in: Telegram works.`, sent.length ? `Last 24 hours: ${sent.length} alerts sent (${by.join(", ")}).` : "Last 24 hours: no alerts fired (nothing met the rules), so nothing was sent.",
    held.length ? `${held.length} signal(s) found but held back by their rules (see the Telegram panel on the screener page for each one and why).` : null,
    bad ? `${bad} message(s) could not be delivered in time.` : null, extraCheckin(), `On: ${onList().join(", ") || "nothing"}.`].filter(Boolean).join("\n");
}
// Starts the queue (sends anything saved before a restart), the startup message and the daily check-in.
let started = false;
export async function startTelegram({ demo = false }: { demo?: boolean } = {}): Promise<string | undefined> {
  if (started) return; started = true;
  await load();
  if (store.items.length) schedule(2000);
  const ok = await checkTelegram();
  // A failed first check (often: the internet was not up yet when the PC started) must not switch off the startup
  // message and the daily check-in until the next restart: they are queued and retried like any other message.
  if (demo || !telegramConfigured()) return ok;
  if (telegramWants("system")) sendTelegram(`Smart Money Tracker started. Telegram alerts on for: ${onList().join(", ") || "nothing"}.\nDaily check-in at ${String(CHECKIN_HOUR).padStart(2, "0")}:00 UTC. Change what is sent on the screener page (Ignition tab, Telegram section).`, { kind: "system" });
  const tick = () => {
    if (!status.bot) checkTelegram().catch(() => {}); // the first check failed (no internet yet?): try again
    const d = new Date(), day = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === CHECKIN_HOUR && store.lastCheckinDay !== day && telegramWants("system")) { store.lastCheckinDay = day; save(); sendTelegram(checkinText(), { kind: "system" }); }
  };
  setInterval(tick, 5 * MIN).unref?.();
  return ok;
}

export function telegramStatus() {
  return { configured: telegramConfigured(), ...status, queued: store.items.length, nextRetryAt: store.items.length ? Math.min(...store.items.map((x) => x.next)) : null,
    waitingError: store.items.find((x) => x.lastError)?.lastError || null,
    kinds: Object.fromEntries(Object.entries(TG_KINDS).map(([k, v]) => [k, { label: v.label, on: telegramWants(k), def: v.def }])),
    checkinHourUtc: CHECKIN_HOUR, log: store.log.slice(0, 40) };
}

// One Telegram sender for every alert in the app (Ignition, big-move, Alpha, Early 2x, AI verdicts, whales, DEX, Market
// Flow, BTC rotation). Messages go through a delivery queue: sent one at a time at Telegram's pace, retried when
// Telegram or the network fails (with the wait Telegram asks for on a rate limit), kept in telegram_state.json so a
// restart does not lose them, and dropped only when they are too old to act on (3 hours). A message that arrives late
// says so. Every send is logged; failures are explained in plain words (wrong token, chat not found, bot never
// started, blocked, no network) in the terminal and on the screener's Telegram panel.
//
// Which kinds of alert go to Telegram can be switched on the page (saved in telegram_state.json); .env gives the
// defaults. A startup message and a daily check-in confirm the connection works even on days with no alerts.
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const API = "https://api.telegram.org";
const MIN = 60_000, HOUR = 60 * MIN;
const GAP_MS = 1100;             // Telegram allows about one message a second per chat
const MAX_AGE_MS = 3 * HOUR;     // an alert older than this is no longer useful
const MAX_QUEUE = 300, MAX_LOG = 200, CHUNK = 3900;
const here = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = env.TELEGRAM_STATE_FILE || path.join(here, env.DEMO === "1" ? "telegram_state.demo.json" : "telegram_state.json"); // override: tests

// Kinds of message, their label and their default (on unless said otherwise; .env can change the default).
const off = (v) => v === "0" || v === "false" || v === "off";
export const TG_KINDS = {
  ignition: { label: "Ignition alerts (early and confirmed)", def: !off(env.SCREENER_TELEGRAM) },
  bigmove: { label: "Big-move alerts (+40% before -10%)", def: !off(env.SCREENER_BIGMOVE_ALERTS) },
  alpha: { label: "Alpha confirmed alerts", def: !off(env.ALPHA_TELEGRAM) },
  alphaEarly: { label: "Alpha early alerts (about 50 a day)", def: env.ALPHA_TELEGRAM === "all" },
  early2x: { label: "Early 2x high-priority candidates", def: !off(env.EARLY2X_ALERTS) },
  ai: { label: "AI verdicts on new alerts", def: !off(env.AI_REVIEW_TELEGRAM) },
  rotation: { label: "BTC rotation: regime or holdings changed", def: env.ROTATION_TELEGRAM === "1" },
  whales: { label: "Whale transfers", def: env.WHALES_TELEGRAM === "1" },
  flows: { label: "DEX rotations", def: env.FLOWS_TELEGRAM === "1" },
  radar: { label: "Market Flow strong flow", def: env.RADAR_TELEGRAM === "1" },
  system: { label: "Startup message and daily check-in", def: !off(env.TELEGRAM_CHECKIN) },
};

const status = { bot: null, checkedAt: null, lastSentAt: null, lastError: null, lastErrorAt: null, sent: 0, failed: 0 };
const store = { prefs: {}, items: [], log: [], lastCheckinDay: null };
let loaded = false, timer = null, busy = false, lastSendAt = 0, saveTimer = null, seq = 0;
const waiters = new Map(); // item id -> resolve(first attempt result)
const creds = () => ({ token: (env.TELEGRAM_BOT_TOKEN || "").trim(), chat: (env.TELEGRAM_CHAT_ID || "").trim() });
export const telegramConfigured = () => { const c = creds(); return !!(c.token && c.chat); };

export function telegramWants(kind) {
  const k = TG_KINDS[kind] ? kind : "system";
  return store.prefs[k] ?? TG_KINDS[k].def;
}
export function setTelegramPref(kind, on) {
  if (!TG_KINDS[kind]) return false;
  store.prefs[kind] = !!on; save();
  return true;
}

// What went wrong and how to fix it, from Telegram's HTTP status and error text.
export function telegramHint(code, description = "") {
  const d = String(description || "");
  if (code === 401 || code === 404 || /unauthorized|not found: bot/i.test(d)) return "the bot token is wrong: copy it again from @BotFather into TELEGRAM_BOT_TOKEN in .env, then restart";
  if (/chat not found/i.test(d)) return "chat not found: TELEGRAM_CHAT_ID is wrong, or you never opened your bot in Telegram and pressed Start (for a group: add the bot and use the group id, which starts with -100)";
  if (/blocked by the user/i.test(d)) return "you blocked the bot: open it in Telegram and press Start (or Unblock)";
  if (/not a member|kicked|have no rights|not enough rights/i.test(d)) return "the bot cannot post in that chat: add it to the group, or as an admin of the channel";
  if (code === 429) return "Telegram rate limit (too many messages): it will work again shortly";
  if (code === 0) return `cannot reach api.telegram.org: check the internet connection, firewall, VPN or proxy (${d})`;
  return `Telegram error ${code}: ${d || "unknown"}`;
}
// How long to wait before the next try. Setup problems (wrong token or chat) are retried every 5 minutes, so the
// messages still go out once .env is fixed and the app restarted; network and server errors back off quickly.
export function retryDelay(code, tries, retryAfterSec = null) {
  if (code === 429) return Math.max(1, retryAfterSec ?? 5) * 1000 + 250;
  if (code === 400 || code === 401 || code === 403 || code === 404) return 5 * MIN;
  return Math.min(10 * MIN, [3, 10, 30, 60, 120, 300][Math.min(tries - 1, 5)] * 1000);
}
// Long messages are split at line breaks into Telegram-sized parts.
export function splitMessage(text, max = CHUNK) {
  const out = [];
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

let transport = async (method, payload) => {
  const { token } = creds();
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(12_000),
    });
    const j = await res.json().catch(() => ({}));
    return res.ok && j.ok !== false ? { ok: true, result: j.result } : { ok: false, code: res.status, description: j.description || res.statusText, retryAfter: j.parameters?.retry_after ?? null };
  } catch (e) { return { ok: false, code: 0, description: e.cause?.code || e.message }; }
};
export const __setTransport = (fn) => { transport = fn; }; // tests

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = { version: 1, prefs: store.prefs, lastCheckinDay: store.lastCheckinDay, log: store.log, items: store.items.map(({ id, kind, text, createdAt, tries, next, lastError }) => ({ id, kind, text, createdAt, tries, next, lastError })) };
    writeFile(STATE_FILE + ".tmp", JSON.stringify(data)).then(() => rename(STATE_FILE + ".tmp", STATE_FILE)).catch(() => {});
  }, 800);
  saveTimer.unref?.();
}
async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const s = JSON.parse(await readFile(STATE_FILE, "utf8"));
    if (s?.version === 1) {
      store.prefs = s.prefs || {}; store.log = Array.isArray(s.log) ? s.log.slice(0, MAX_LOG) : []; store.lastCheckinDay = s.lastCheckinDay || null;
      store.items = Array.isArray(s.items) ? s.items.filter((x) => x && x.text && Date.now() - x.createdAt < MAX_AGE_MS).map((x) => ({ ...x, next: Date.now() + 2000 })) : [];
    }
  } catch { /* first run */ }
}
const title = (text) => String(text).split("\n")[0].slice(0, 120);
function logEntry(it, st, extra = {}) {
  store.log.unshift({ at: Date.now(), kind: it.kind, title: title(it.text), status: st, tries: it.tries, delaySec: Math.round((Date.now() - it.createdAt) / 1000), ...extra });
  if (store.log.length > MAX_LOG) store.log.length = MAX_LOG;
}
function settle(id, result) { const w = waiters.get(id); if (w) { waiters.delete(id); w(result); } }
function schedule(ms) { clearTimeout(timer); timer = setTimeout(pump, Math.max(50, ms)); timer.unref?.(); }

async function pump() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    for (const it of store.items) if (now - it.createdAt > MAX_AGE_MS) {
      it.dead = true; logEntry(it, "expired", { error: it.lastError || "too old to be useful" }); settle(it.id, { sent: false, error: it.lastError || "expired" });
    }
    if (store.items.some((x) => x.dead)) { store.items = store.items.filter((x) => !x.dead); save(); }
    if (!store.items.length) return;
    const due = store.items.filter((x) => x.next <= now).sort((a, b) => a.createdAt - b.createdAt)[0];
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
      const hint = telegramHint(r.code, r.description);
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

// Queues a message. Resolves after the first try: { sent: true }, { sent: false, queued: true, error } (it keeps
// retrying), or { sent: false, skipped } (Telegram not set up, or this kind is switched off).
// opts.kind = one of TG_KINDS (default "system"); opts.force = send even if that kind is switched off (you asked for it).
export async function sendTelegram(text, opts = {}) {
  const kind = TG_KINDS[opts.kind] ? opts.kind : "system";
  if (!telegramConfigured()) return { sent: false, skipped: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set in .env" };
  if (!opts.force && !telegramWants(kind)) return { sent: false, skipped: `${TG_KINDS[kind].label} are switched off` };
  await load();
  const parts = splitMessage(text);
  const ids = parts.map((part, i) => {
    const id = `m${Date.now().toString(36)}${(seq++).toString(36)}`;
    store.items.push({ id, kind, text: parts.length > 1 ? `${part}${i < parts.length - 1 ? "\n(continued)" : ""}` : part, createdAt: Date.now(), tries: 0, next: Date.now() });
    return id;
  });
  if (store.items.length > MAX_QUEUE) { const drop = store.items.splice(0, store.items.length - MAX_QUEUE); for (const it of drop) { logEntry(it, "dropped", { error: "queue full" }); settle(it.id, { sent: false, error: "queue full" }); } }
  save();
  const first = new Promise((resolve) => waiters.set(ids[0], resolve));
  schedule(0);
  return first;
}

// Checks the token (getMe) once at startup; the chat is checked by the first message or the "Send test message" button.
export async function checkTelegram() {
  if (!telegramConfigured()) return "not configured (add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env)";
  const r = await transport("getMe");
  status.checkedAt = Date.now();
  if (r.ok) { status.bot = r.result?.username ? "@" + r.result.username : "ok"; return `bot ${status.bot}, sending to chat ${creds().chat}`; }
  status.lastError = telegramHint(r.code, r.description); status.lastErrorAt = Date.now();
  return `PROBLEM: ${status.lastError}`;
}

const onList = () => Object.keys(TG_KINDS).filter((k) => k !== "system" && telegramWants(k)).map((k) => TG_KINDS[k].label);
const CHECKIN_HOUR = Number.isFinite(Number(env.TELEGRAM_CHECKIN_HOUR)) && env.TELEGRAM_CHECKIN_HOUR !== "" && env.TELEGRAM_CHECKIN_HOUR !== undefined ? Number(env.TELEGRAM_CHECKIN_HOUR) : 8;
// Daily check-in (at CHECKIN_HOUR UTC): what was sent in the last 24 hours, so silence never means "broken" by mistake.
export function checkinText(now = Date.now()) {
  const day = store.log.filter((x) => now - x.at < 24 * HOUR), sent = day.filter((x) => x.status === "sent" && x.kind !== "system");
  const by = Object.entries(sent.reduce((m, x) => ((m[x.kind] = (m[x.kind] || 0) + 1), m), {})).map(([k, n]) => `${TG_KINDS[k]?.label || k}: ${n}`);
  const bad = day.filter((x) => x.status === "expired" || x.status === "dropped").length;
  return [`Smart Money Tracker daily check-in: Telegram works.`, sent.length ? `Last 24 hours: ${sent.length} alerts sent (${by.join(", ")}).` : "Last 24 hours: no alerts fired (nothing met the rules), so nothing was sent.",
    bad ? `${bad} message(s) could not be delivered in time.` : null, `On: ${onList().join(", ") || "nothing"}.`].filter(Boolean).join("\n");
}
// Starts the queue (sends anything saved before a restart), the startup message and the daily check-in.
let started = false;
export async function startTelegram({ demo = false } = {}) {
  if (started) return; started = true;
  await load();
  if (store.items.length) schedule(2000);
  const ok = await checkTelegram();
  if (demo || !telegramConfigured() || /^PROBLEM/.test(ok)) return ok;
  if (telegramWants("system")) sendTelegram(`Smart Money Tracker started. Telegram alerts on for: ${onList().join(", ") || "nothing"}.\nDaily check-in at ${String(CHECKIN_HOUR).padStart(2, "0")}:00 UTC. Change what is sent on the screener page (Ignition tab, Telegram section).`, { kind: "system" });
  const tick = () => {
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

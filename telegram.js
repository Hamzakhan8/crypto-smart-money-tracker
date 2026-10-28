// One Telegram sender for the screener alerts and the AI desk. It remembers the last result and explains a failure in
// plain words (wrong token, chat not found, bot never started, blocked, no network), logs it in the terminal and shows
// it on the screener's Data health panel, so a missing message is never a mystery.
const env = process.env;
const API = "https://api.telegram.org";
const status = { bot: null, checkedAt: null, lastSentAt: null, lastError: null, lastErrorAt: null, sent: 0, failed: 0 };
const creds = () => ({ token: (env.TELEGRAM_BOT_TOKEN || "").trim(), chat: (env.TELEGRAM_CHAT_ID || "").trim() });
export const telegramConfigured = () => { const c = creds(); return !!(c.token && c.chat); };

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

async function call(method, payload) {
  const { token } = creds();
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}), signal: AbortSignal.timeout(12_000),
    });
    const j = await res.json().catch(() => ({}));
    return res.ok && j.ok !== false ? { ok: true, result: j.result } : { ok: false, code: res.status, description: j.description || res.statusText };
  } catch (e) { return { ok: false, code: 0, description: e.cause?.code || e.message }; }
}

export async function sendTelegram(text) {
  if (!telegramConfigured()) return { sent: false, skipped: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set in .env" };
  const r = await call("sendMessage", { chat_id: creds().chat, text: String(text).slice(0, 4000), disable_web_page_preview: true });
  if (r.ok) { status.sent++; status.lastSentAt = Date.now(); status.lastError = null; return { sent: true }; }
  const hint = telegramHint(r.code, r.description);
  status.failed++; status.lastError = hint; status.lastErrorAt = Date.now();
  console.warn(`Telegram: message not sent: ${hint}`);
  return { sent: false, error: hint };
}

// Checks the token (getMe) once at startup; the chat is checked by the first message or the "Send test message" button.
export async function checkTelegram() {
  if (!telegramConfigured()) return "not configured (add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env)";
  const r = await call("getMe");
  status.checkedAt = Date.now();
  if (r.ok) { status.bot = r.result?.username ? "@" + r.result.username : "ok"; return `bot ${status.bot}, sending to chat ${creds().chat}`; }
  status.lastError = telegramHint(r.code, r.description); status.lastErrorAt = Date.now();
  return `PROBLEM: ${status.lastError}`;
}

export const telegramStatus = () => ({ configured: telegramConfigured(), ...status });

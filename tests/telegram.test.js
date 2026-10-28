// Telegram delivery queue: retries, rate limits, switches, splitting, check-in. Uses a fake transport, never Telegram.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";

process.env.TELEGRAM_STATE_FILE = path.join(tmpdir(), `tg_test_${process.pid}.json`);
process.env.TELEGRAM_BOT_TOKEN = "123:test"; process.env.TELEGRAM_CHAT_ID = "42";
delete process.env.ALPHA_TELEGRAM; delete process.env.EARLY2X_ALERTS; delete process.env.SCREENER_BIGMOVE_ALERTS;
const tg = await import("../telegram.js");
const sent = [];
const keepAlive = setInterval(() => {}, 1000); // the queue's own timers are unref'd so they never hold the app open
after(() => { clearInterval(keepAlive); rmSync(process.env.TELEGRAM_STATE_FILE, { force: true }); });
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); } };

test("Telegram: the alerts you asked for are on by default", () => {
  for (const k of ["ignition", "bigmove", "alpha", "early2x", "ai", "system"]) assert.equal(tg.telegramWants(k), true, k);
  assert.equal(tg.telegramWants("alphaEarly"), false); // about 50 a day: opt in
});

test("Telegram: a rate-limited message is retried and delivered", async () => {
  let calls = 0;
  tg.__setTransport(async (method, p) => {
    calls++;
    if (calls === 1) return { ok: false, code: 429, description: "Too Many Requests", retryAfter: 1 };
    sent.push(p.text); return { ok: true, result: {} };
  });
  const r = await tg.sendTelegram("🚀 IGNITION: ABC", { kind: "ignition" });
  assert.equal(r.sent, false); assert.equal(r.queued, true); assert.match(r.error, /rate limit/);
  assert.equal(tg.telegramStatus().queued, 1);
  await until(() => sent.length === 1);
  assert.equal(sent[0], "🚀 IGNITION: ABC");
  const s = tg.telegramStatus();
  assert.equal(s.queued, 0); assert.equal(s.log[0].status, "sent"); assert.equal(s.log[0].tries, 2); assert.equal(s.log[1].status, "retrying");
});

test("Telegram: a switched-off kind is skipped, a test message is forced", async () => {
  tg.__setTransport(async (m, p) => { sent.push(p.text); return { ok: true }; });
  assert.equal(tg.setTelegramPref("alpha", false), true);
  assert.equal(tg.setTelegramPref("nope", true), false);
  const r = await tg.sendTelegram("alpha alert", { kind: "alpha" });
  assert.equal(r.sent, false); assert.match(r.skipped, /switched off/);
  assert.equal((await tg.sendTelegram("test", { kind: "alpha", force: true })).sent, true);
  assert.equal(tg.telegramStatus().kinds.alpha.on, false); assert.equal(tg.telegramStatus().kinds.alpha.def, true);
  tg.setTelegramPref("alpha", true);
  assert.equal((await tg.sendTelegram("alpha alert", { kind: "alpha" })).sent, true);
});

test("Telegram: long messages are split at line breaks, setup errors retry slowly", () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} `.repeat(4)).join("\n");
  const parts = tg.splitMessage(text, 1000);
  assert.ok(parts.length > 1 && parts.every((x) => x.length <= 1000));
  assert.equal(parts.join("\n"), text);
  assert.deepEqual(tg.splitMessage("x".repeat(25), 10), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  assert.equal(tg.retryDelay(429, 1, 7), 7250);
  assert.equal(tg.retryDelay(401, 1), 300_000);
  assert.equal(tg.retryDelay(0, 1), 3000); assert.equal(tg.retryDelay(502, 9), 300_000);
});

test("Telegram: the daily check-in says what was sent", () => {
  const t = tg.checkinText();
  assert.match(t, /Telegram works/);
  assert.match(t, /Last 24 hours: 3 alerts sent \(/);
  assert.match(t, /Alpha confirmed alerts: 2/); assert.match(t, /Ignition alerts \(early and confirmed\): 1/);
  assert.match(t, /On: .*Early 2x/);
});

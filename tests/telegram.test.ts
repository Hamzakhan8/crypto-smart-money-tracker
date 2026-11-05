// Telegram delivery queue: retries, rate limits, switches, splitting, check-in. Uses a fake transport, never Telegram.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rmSync } from "node:fs";

process.env.TELEGRAM_STATE_FILE = path.join(tmpdir(), `tg_test_${process.pid}.json`);
process.env.TELEGRAM_BOT_TOKEN = "123:test"; process.env.TELEGRAM_CHAT_ID = "42";
delete process.env.ALPHA_TELEGRAM; delete process.env.EARLY2X_ALERTS; delete process.env.SCREENER_BIGMOVE_ALERTS;
const tg = await import("../telegram.ts");
const sent = [];
const keepAlive = setInterval(() => {}, 1000); // the queue's own timers are unref'd so they never hold the app open
after(() => { clearInterval(keepAlive); rmSync(process.env.TELEGRAM_STATE_FILE, { force: true }); });
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 50)); } };

test("Telegram: the alerts you asked for are on by default", () => {
  for (const k of ["ignition", "pump", "perps", "scalp", "early2x", "ai", "system"]) assert.equal(tg.telegramWants(k), true, k);
  for (const k of ["alphaEarly", "bigmove", "alpha"]) assert.equal(tg.telegramWants(k), false, k); // lost money live (or ~50 a day): opt in
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
  assert.equal(tg.telegramStatus().kinds.alpha.on, false); assert.equal(tg.telegramStatus().kinds.alpha.def, false);
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

test("Telegram: signals held back by their rules are logged with the reason and counted in the check-in", async () => {
  tg.noteHeld("ignition", "EARLY IGNITION: ABC (score 61/100)", "not sent: quality gate failed, big trades (2.3x the normal trade size)");
  tg.setCheckinExtra(() => "Ignition now: 0 coin(s) ignited, 4 heating up; most are waiting for: price above its 20-day average (4).");
  await until(() => tg.telegramStatus().log.some((x) => x.status === "held"));
  const h = tg.telegramStatus().log.find((x) => x.status === "held");
  assert.equal(h.kind, "ignition"); assert.match(h.title, /EARLY IGNITION: ABC/); assert.match(h.error, /quality gate failed/);
  const t = tg.checkinText();
  assert.match(t, /\d+ signal\(s\) found but held back by their rules/); assert.match(t, /most are waiting for: price above its 20-day average/);
  tg.setTelegramPref("pump", false);
  const r = await tg.sendTelegram("PUMP WATCH: test", { kind: "pump" });
  assert.ok(r.skipped);
  assert.ok(tg.telegramStatus().log.some((x) => x.status === "held" && x.kind === "pump" && /switched off/.test(x.error)));
  tg.setTelegramPref("pump", true);
});

test(".env reader: the last line of a repeated key wins, quoted values with a comment, UTF-16 files", async () => {
  // .env reader: the last line of a repeated key wins (an empty line copied from .env.example above a filled one),
  // a quoted value with a comment loses its quotes, and Notepad's UTF-16 files are read
  const { mkdtempSync, writeFileSync, copyFileSync } = await import("node:fs");
  const dir = mkdtempSync(path.join(tmpdir(), "envtest-"));
  copyFileSync(new URL("../env.ts", import.meta.url), path.join(dir, "env.mts")); // .mts: TypeScript, always an ES module (the temp folder has no package.json)
  writeFileSync(path.join(dir, ".env"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('TG_A_TEST=\r\nTG_A_TEST=123:abc\r\nTG_B_TEST="456:def" # my bot\r\n', "utf16le")]));
  delete process.env.TG_A_TEST; delete process.env.TG_B_TEST;
  await import(pathToFileURL(path.join(dir, "env.mts")).href); // a file URL: a plain C: path fails on Windows
  assert.equal(process.env.TG_A_TEST, "123:abc"); assert.equal(process.env.TG_B_TEST, "456:def");
  rmSync(dir, { recursive: true, force: true });
});

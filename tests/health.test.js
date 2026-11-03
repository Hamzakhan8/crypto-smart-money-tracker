// System status (health.js): working / warning / not working / off for each part, silence counts as broken, and one
// Telegram warning after 30 minutes plus one "OK again" message. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { judge, createHealth } from "../health.js";

const MIN = 60_000, T0 = Date.parse("2026-11-03T10:00:00Z");

test("status of one part: working, warning, silent, failing, off, and gentle while starting", () => {
  const src = { key: "scalp", name: "Scalp scanner", every: 5 };
  const late = T0 + 60 * MIN; // well after the start
  assert.equal(judge(src, { status: "ok", updatedAt: late - 2 * MIN }, late, T0).state, "ok");
  assert.equal(judge(src, { status: "ok", updatedAt: late - 2 * MIN, warn: "2 coins failed" }, late, T0).state, "warn");
  const silent = judge(src, { status: "ok", updatedAt: late - 40 * MIN }, late, T0);
  assert.equal(silent.state, "error"); assert.match(silent.text, /no update for 40 minutes/);
  const failing = judge(src, { status: "error", error: "Binance Futures HTTP 451", updatedAt: null }, late, T0);
  assert.equal(failing.state, "error"); assert.match(failing.text, /451/);
  assert.equal(judge(src, { status: "ok", error: "one scan failed", updatedAt: late - 3 * MIN }, late, T0).state, "warn", "a recent good update makes a single failure a warning");
  assert.equal(judge(src, { off: true, detail: "off (SCALP=0)" }, late, T0).state, "off");
  assert.equal(judge(src, { status: "starting", updatedAt: null }, T0 + 2 * MIN, T0).state, "warn", "starting up is not an error yet");
  assert.equal(judge(src, { status: "starting", updatedAt: null }, late, T0).state, "error", "but still nothing after an hour is");
});

test("Telegram: one warning after 30 minutes broken, one message when it works again, nothing for parts that are off", () => {
  let clock = T0, scalp = { status: "ok", updatedAt: T0 };
  const sent = [];
  const h = createHealth({ now: () => clock, sendTelegram: (t, k) => sent.push([k, t]), wantTelegram: (k) => k === "health",
    sources: [{ key: "scalp", name: "Scalp scanner", every: 5, get: () => scalp }, { key: "ai", name: "AI (Gemini)", every: 1e6, get: () => ({ off: true }) },
      { key: "bot", name: "Paper bot", every: 5, alert: false, get: () => ({ status: "error", error: "stopped", updatedAt: null }) }] });
  clock = T0 + 60 * MIN; scalp = { status: "error", error: "HTTP 451", updatedAt: T0 + 20 * MIN };
  h.check(); assert.equal(sent.length, 0, "just broke");
  clock += 20 * MIN; h.check(); assert.equal(sent.length, 0, "20 minutes");
  clock += 11 * MIN; h.check();
  assert.equal(sent.length, 1, "31 minutes: one warning"); assert.equal(sent[0][0], "health");
  assert.match(sent[0][1], /WARNING: Scalp scanner is not working/); assert.match(sent[0][1], /451/);
  clock += 30 * MIN; h.check(); assert.equal(sent.length, 1, "not repeated");
  scalp = { status: "ok", updatedAt: clock }; clock += MIN; h.check();
  assert.equal(sent.length, 2); assert.match(sent[1][1], /OK again: Scalp scanner works again/);
  const a = h.api();
  assert.deepEqual(a.parts.map((p) => [p.key, p.state]), [["scalp", "ok"], ["ai", "off"], ["bot", "error"]]);
  assert.equal(a.problems, 1);
  assert.ok(!sent.some((x) => /Paper bot/.test(x[1])), "parts with alert: false are shown but not sent");
});

test("Gemini errors in plain words, with what to do", async () => {
  const { geminiErrorText } = await import("../agent.js");
  assert.match(geminiErrorText(new Error(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key." } }))), /^the Gemini key is not valid: create one at aistudio\.google\.com/);
  assert.match(geminiErrorText(Object.assign(new Error("models/x is not found for API version v1beta"), { status: 404 })), /model name is not available.*GEMINI_ANALYST_MODEL/);
  assert.match(geminiErrorText(Object.assign(new Error("Resource has been exhausted"), { status: 429 })), /limit for your key is reached/);
  assert.equal(geminiErrorText(new Error("socket hang up")), "socket hang up");
});

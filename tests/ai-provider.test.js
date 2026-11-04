// Free open-source AI (ai-provider.js): the Gemini-style call the app makes becomes an OpenAI-style chat request, and
// the answer comes back in Gemini's shape (text, tool calls, tokens). A fake server in memory; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@google/genai";
import { pickProvider, createOpenAiClient, toJsonSchema, toMessages, PRESETS } from "../ai-provider.js";
import { jsonFrom, geminiErrorText, MODEL_PATTERN } from "../agent.js";

// A fake OpenAI-compatible server: answers with `reply(body)` and records every request.
function fakeServer(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body, headers: init.headers });
    const r = await reply(body, calls.length);
    return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => (typeof r.json === "string" ? r.json : JSON.stringify(r.json)) };
  };
  return { calls, fetchImpl };
}
const answer = (content, extra = {}) => ({ json: { choices: [{ message: { content, ...extra } }], usage: { prompt_tokens: 120, completion_tokens: 30 } } });

test("which provider: the settings decide, a free key is found by itself, nothing set = none", () => {
  assert.equal(pickProvider({}), null);
  assert.equal(pickProvider({ GROQ_API_KEY: "k" }).id, "groq");
  const o = pickProvider({ AI_PROVIDER: "ollama", AI_MODEL: "llama3.2:3b" });
  assert.equal(o.id, "ollama"); assert.equal(o.base, PRESETS.ollama.base); assert.equal(o.model, "llama3.2:3b"); assert.equal(o.reviewModel, "llama3.2:3b"); assert.equal(o.local, true);
  const c = pickProvider({ AI_PROVIDER: "custom", AI_BASE_URL: "http://localhost:1234/v1/", AI_API_KEY: "x" });
  assert.equal(c.base, "http://localhost:1234/v1"); assert.equal(c.key, "x");
  assert.equal(pickProvider({ AI_PROVIDER: "gemini", GROQ_API_KEY: "k" }), null, "Gemini is chosen by the server, not here");
});

test("Gemini's schema becomes a JSON schema", () => {
  const s = toJsonSchema({ type: Type.OBJECT, properties: { verdict: { type: Type.STRING, enum: ["YES", "NO"] }, why: { type: Type.ARRAY, items: { type: Type.STRING } } }, required: ["verdict"], propertyOrdering: ["verdict"] });
  assert.deepEqual(s, { type: "object", properties: { verdict: { type: "string", enum: ["YES", "NO"] }, why: { type: "array", items: { type: "string" } } }, required: ["verdict"] });
});

test("a JSON answer: schema mode first; a server without it gets JSON mode with the schema in the instructions", async () => {
  const srv = fakeServer((b) => (b.response_format?.type === "json_schema" ? { status: 400, json: { error: { message: "json_schema not supported" } } } : answer('<think>hmm</think>{"verdict":"YES"}')));
  const ai = createOpenAiClient({ id: "ollama", name: "Ollama", base: "http://x/v1", model: "qwen3:4b", reviewModel: "qwen3:4b", local: true }, { fetchImpl: srv.fetchImpl });
  const params = { model: "gemini-3.5-flash", contents: "Judge it.", config: { systemInstruction: "You are the trader.", temperature: 0.2, responseMimeType: "application/json",
    responseSchema: { type: Type.OBJECT, properties: { verdict: { type: Type.STRING } } }, thinkingConfig: { thinkingLevel: "HIGH" }, tools: [{ googleSearch: {} }] } };
  const res = await ai.models.generateContent(params);
  assert.deepEqual(jsonFrom(res, "Trader"), { verdict: "YES" }, "the <think> part is dropped");
  assert.equal(srv.calls.length, 2);
  assert.equal(srv.calls[0].body.model, "qwen3:4b", "a Gemini model name becomes the open model");
  assert.equal(srv.calls[0].body.temperature, 0.2);
  assert.equal(srv.calls[0].body.tools, undefined, "Google Search is not sent to an open model");
  assert.equal(srv.calls[1].body.response_format.type, "json_object");
  assert.match(srv.calls[1].body.messages[0].content, /^You are the trader\.[\s\S]*JSON schema/);
  assert.deepEqual(res.usageMetadata, { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 0 });
  await ai.models.generateContent(params);
  assert.equal(srv.calls[2].body.response_format.type, "json_object", "it remembers the server has no schema mode");
  assert.equal(ai.timeoutFactor, 6, "a local model gets longer");
});

test("tool calls: the model asks for a tool, the answer goes back, the conversation keeps its shape", async () => {
  const srv = fakeServer((b, n) => (n === 1 ? answer(null, { tool_calls: [{ id: "c1", type: "function", function: { name: "orderbook", arguments: '{"symbol":"SOLUSDT"}' } }] }) : answer("Checked SOL.")));
  const ai = createOpenAiClient({ id: "groq", name: "Groq", base: "https://g/v1", key: "k", model: "llama", reviewModel: "oss" }, { fetchImpl: srv.fetchImpl });
  const decl = [{ functionDeclarations: [{ name: "orderbook", description: "book", parameters: { type: Type.OBJECT, properties: { symbol: { type: Type.STRING } } } }] }];
  const contents = [{ role: "user", parts: [{ text: "Check SOL." }] }];
  const r1 = await ai.models.generateContent({ model: "gemini-3.1-pro-preview", contents, config: { tools: decl } });
  assert.deepEqual(r1.functionCalls, [{ id: "c1", name: "orderbook", args: { symbol: "SOLUSDT" } }]);
  assert.equal(srv.calls[0].body.model, "oss", "the Gemini pro model becomes the review model");
  assert.equal(srv.calls[0].headers.authorization, "Bearer k");
  assert.equal(srv.calls[0].body.tools[0].function.parameters.type, "object");
  contents.push(r1.candidates[0].content, { role: "user", parts: [{ functionResponse: { id: "c1", name: "orderbook", response: { result: { spread: 1 } } } }] });
  const r2 = await ai.models.generateContent({ model: "gemini-3.5-flash", contents, config: { tools: decl } });
  assert.equal(r2.text, "Checked SOL.");
  const m = srv.calls[1].body.messages;
  assert.equal(m[1].role, "assistant"); assert.equal(m[1].tool_calls[0].function.name, "orderbook");
  assert.deepEqual(m[2], { role: "tool", tool_call_id: "c1", content: '{"result":{"spread":1}}' });
});

test("errors in plain words: a bad key, a missing local model, Ollama not running", async () => {
  const bad = createOpenAiClient({ id: "groq", name: "Groq", base: "https://g/v1", key: "k", model: "m", reviewModel: "m" }, { fetchImpl: fakeServer(() => ({ status: 401, json: { error: { message: "Invalid API Key" } } })).fetchImpl });
  await assert.rejects(bad.models.generateContent({ contents: "hi" }), (e) => /Groq: the API key is not valid \(GROQ_API_KEY\)/.test(e.message) && e.status === 401 && geminiErrorText(e) === e.message);
  const local = { id: "ollama", name: "Ollama (on this PC)", base: "http://x/v1", model: "qwen3:4b", reviewModel: "qwen3:4b", local: true };
  const missing = createOpenAiClient(local, { fetchImpl: fakeServer(() => ({ status: 404, json: { error: { message: "model not found" } } })).fetchImpl });
  await assert.rejects(missing.models.generateContent({ contents: "hi" }), /ollama pull qwen3:4b/);
  const down = createOpenAiClient(local, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(down.models.generateContent({ contents: "hi" }), (e) => /is not running: install it from ollama\.com/.test(e.message) && e.status === 503);
});

test("open model names are accepted by the AI desk", () => {
  for (const m of ["gemini-3.5-flash", "qwen3:4b", "llama-3.3-70b-versatile", "openai/gpt-oss-120b", "meta-llama/llama-3.3-70b-instruct:free"]) assert.ok(MODEL_PATTERN.test(m), m);
  assert.ok(!MODEL_PATTERN.test("../etc"), "no paths");
  assert.deepEqual(toMessages("hi", "sys"), [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
});

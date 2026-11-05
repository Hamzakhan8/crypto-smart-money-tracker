// Free, open-source AI next to Gemini: any server that speaks the OpenAI chat API, used through the same
// `ai.models.generateContent()` call the app makes to Gemini, so the AI desk, the alert reviews, the Market Flow brief
// and the News labels all work with it unchanged.
//
//   AI_PROVIDER=ollama      Ollama on this PC (ollama.com): free, open-source, nothing leaves the PC. Install it, then
//                           `ollama pull qwen3:4b` (or any model) and set AI_MODEL. Runs on the CPU when there is no
//                           graphics card: fine for news labels, slow (minutes) for the full AI committee.
//   AI_PROVIDER=groq        Groq's free key (console.groq.com/keys) -> GROQ_API_KEY: open models (Llama, Qwen, gpt-oss), fast
//   AI_PROVIDER=openrouter  OpenRouter's free models (openrouter.ai/keys) -> OPENROUTER_API_KEY
//   AI_PROVIDER=cerebras    Cerebras (cloud.cerebras.ai) -> CEREBRAS_API_KEY
//   AI_PROVIDER=custom      any OpenAI-compatible server: AI_BASE_URL, AI_API_KEY (LM Studio, vLLM, llama.cpp server...)
// With no AI_PROVIDER: Gemini if GEMINI_API_KEY is set, else the first free key found, else Ollama if it is running.
// AI_MODEL / AI_REVIEW_MODEL pick the models (the review model is used by the Final Boss and the risk review).
//
// What differs from Gemini: no Google Search grounding (the news researcher uses the app's own Google News and Binance
// search, which it does first anyway), and Gemini's thinking settings are ignored. JSON answers use the server's JSON
// schema mode when it has one, else JSON mode with the schema written into the instructions.
import type { Schema, ThinkingLevel } from "@google/genai";

// ───────────────────────────── the AI client ─────────────────────────────
// The parts of a Gemini request and answer the app uses. Gemini's own client (@google/genai) and the open-model client
// below both fit AiClient, so every part of the app takes either one.
export interface AiFunctionCall { id?: string; name?: string; args?: Record<string, unknown> }
export interface AiPart { text?: string; functionCall?: AiFunctionCall; functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> } }
/** One turn of a conversation: role "user" or "model". */
export interface AiTurn { role?: string; parts?: AiPart[] }
/** What the model reads: plain text, or turns. */
export type AiContents = string | AiTurn | AiTurn[];
export interface AiTool { googleSearch?: Record<string, never>; functionDeclarations?: { name: string; description?: string; parameters?: Schema }[] }
export interface AiConfig {
  systemInstruction?: string; temperature?: number; responseMimeType?: string; responseSchema?: Schema; tools?: AiTool[];
  thinkingConfig?: { thinkingLevel?: ThinkingLevel; thinkingBudget?: number }; abortSignal?: AbortSignal;
}
export interface AiRequest { model: string; contents: AiContents; config?: AiConfig }
/** Google's grounding data: what its search really returned. */
export interface AiGrounding { groundingChunks?: { web?: { uri?: string; title?: string } }[]; webSearchQueries?: string[]; searchEntryPoint?: { renderedContent?: string }; groundingSupports?: unknown[]; retrievalMetadata?: unknown }
export interface AiUsage { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number }
export interface AiAnswer { text?: string; functionCalls?: AiFunctionCall[]; candidates?: { content?: AiTurn; groundingMetadata?: AiGrounding }[]; usageMetadata?: AiUsage }
/** The open model behind an OpenAI-compatible client (none for Gemini). */
export interface ProviderInfo { id: string; name: string; model: string; reviewModel: string; local: boolean; search: boolean }
export interface AiClient {
  models: { generateContent(params: AiRequest): Promise<AiAnswer> };
  provider?: ProviderInfo;
  timeoutFactor?: number; // each request may take this many times longer (a local model on a CPU)
}

interface Preset { name: string; base?: string; keyEnv?: string; model: string; review?: string; local?: boolean }
/** An open model server: what pickProvider() found, or the Ollama preset. */
export interface Provider { id: string; name: string; base: string; key?: string | null; model: string; reviewModel: string; local?: boolean }
/** The part of fetch() the client uses (the tests pass a fake server). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const PRESETS: Record<string, Preset> = {
  ollama: { name: "Ollama (on this PC)", base: "http://127.0.0.1:11434/v1", model: "qwen3:4b", local: true },
  groq: { name: "Groq", base: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", model: "llama-3.3-70b-versatile", review: "openai/gpt-oss-120b" },
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", model: "meta-llama/llama-3.3-70b-instruct:free" },
  cerebras: { name: "Cerebras", base: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", model: "llama-3.3-70b" },
  custom: { name: "OpenAI-compatible server", keyEnv: "AI_API_KEY", model: "default" },
};

// Which open provider the settings ask for (null = none). Gemini is chosen by the caller before this.
export function pickProvider(env: Record<string, string | undefined> = process.env): Provider | null {
  const want = String(env.AI_PROVIDER || "").toLowerCase().trim();
  if (want === "gemini") return null; // asked for Gemini: never switch to another one by itself
  const id = want && want !== "auto" ? want
    : ["groq", "openrouter", "cerebras"].find((p) => env[PRESETS[p].keyEnv]) || (env.AI_BASE_URL ? "custom" : null);
  if (!id || !PRESETS[id]) return null;
  const p = PRESETS[id], base = String(env.AI_BASE_URL || p.base || "").replace(/\/$/, "");
  if (!base) return null;
  const model = env.AI_MODEL || p.model;
  return { id, name: p.name, base, key: p.keyEnv ? env[p.keyEnv] || null : null, model, reviewModel: env.AI_REVIEW_MODEL || p.review || model, local: !!p.local };
}

// Is Ollama running on this PC? (used when nothing else is set up)
export async function ollamaRunning(base: string = PRESETS.ollama.base, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try { const r = await fetchImpl(base.replace(/\/v1$/, "") + "/api/tags", { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

// Gemini's schema (Type.OBJECT, "STRING"...) -> JSON schema (object, string...).
export function toJsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
    else if (k === "nullable" || k === "propertyOrdering") continue;
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    else out[k] = toJsonSchema(v);
  }
  return out;
}

// An OpenAI chat message.
interface ChatMessage { role: string; content: string | null; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }
const textOf = (x: string | AiTurn): string => (typeof x === "string" ? x : Array.isArray(x?.parts) ? x.parts.map((p) => p.text || "").join("") : Array.isArray(x) ? x.map(textOf).join("\n") : "");
// Gemini contents (a string, or turns of { role, parts }) -> OpenAI messages, tool calls and answers included.
export function toMessages(contents: AiContents, system?: string): ChatMessage[] {
  const msgs: ChatMessage[] = system ? [{ role: "system", content: textOf(system) }] : [];
  if (typeof contents === "string") return [...msgs, { role: "user", content: contents }];
  for (const turn of Array.isArray(contents) ? contents : [contents]) {
    const parts = turn?.parts || [], text = parts.filter((p) => p.text).map((p) => p.text).join("");
    const calls = parts.filter((p) => p.functionCall), answers = parts.filter((p) => p.functionResponse);
    if (calls.length) msgs.push({ role: "assistant", content: text || null, tool_calls: calls.map(({ functionCall: c }, i) =>
      ({ id: c.id || `call_${c.name}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) });
    else if (answers.length) for (const [i, { functionResponse: r }] of answers.entries()) msgs.push({ role: "tool", tool_call_id: r.id || `call_${r.name}_${i}`, content: JSON.stringify(r.response ?? {}) });
    else msgs.push({ role: turn?.role === "model" ? "assistant" : "user", content: text });
  }
  return msgs;
}
// Reasoning models (Qwen3, DeepSeek R1...) may put their thinking in <think> tags: only the answer is kept.
const answerOnly = (t: string | null | undefined): string => String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();

// A plain-words error for the status bar and the AI desk (error.provider marks it as already explained).
function failure(p: Provider, status: number, raw: string) {
  let msg: unknown = raw;
  try { const j = JSON.parse(raw); msg = j?.error?.message || j?.error || j?.message || raw; } catch { /* plain text */ }
  msg = String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 200);
  const text = status === 401 || status === 403 ? `${p.name}: the API key is not valid (${p.id === "custom" ? "AI_API_KEY" : PRESETS[p.id]?.keyEnv}); ${msg}`
    : status === 404 && p.local ? `${p.name}: model not found: run "ollama pull ${p.model}" (or set AI_MODEL to a model you have); ${msg}`
    : status === 404 ? `${p.name}: model not found: set AI_MODEL (and AI_REVIEW_MODEL) to a model it has; ${msg}`
    : status === 429 ? `${p.name}: free limit reached for now, it works again later; ${msg}`
    : `${p.name}: HTTP ${status}; ${msg}`;
  return Object.assign(new Error(text), { status, provider: p.id });
}

// The fields of an OpenAI-style chat answer the client reads.
interface ChatAnswerMessage { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }
interface ChatCompletion { choices?: { message?: ChatAnswerMessage }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } }
// A Gemini-style request to the open model: without a model the open model is used, and Gemini's thinking settings are ignored.
interface OpenAiRequest { model?: string; contents: AiContents; config?: Omit<AiConfig, "thinkingConfig"> & { thinkingConfig?: unknown } }

// The client. p = pickProvider() (or the Ollama preset). fetchImpl for tests.
export function createOpenAiClient(p: Provider, { fetchImpl = fetch }: { fetchImpl?: FetchLike } = {}) {
  let schemaMode = true; // the server's JSON schema mode; switched off once if the server rejects it
  const modelFor = (m: string | undefined): string => (!m || /^gemini/i.test(m) ? (/pro|review/i.test(m || "") ? p.reviewModel : p.model) : m);
  async function post(body: object, signal: AbortSignal | undefined): Promise<ChatCompletion> {
    let r: Awaited<ReturnType<FetchLike>>;
    try {
      r = await fetchImpl(`${p.base}/chat/completions`, { method: "POST", signal,
        headers: { "content-type": "application/json", ...(p.key ? { authorization: `Bearer ${p.key}` } : {}), ...(p.id === "openrouter" ? { "x-title": "Smart Money Tracker" } : {}) },
        body: JSON.stringify(body) });
    } catch (e) {
      if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e;
      throw Object.assign(new Error(p.local ? `${p.name} is not running: install it from ollama.com, then run "ollama pull ${p.model}" (${e.message})` : `${p.name} cannot be reached: ${e.message}`), { status: 503, provider: p.id });
    }
    const raw = await r.text();
    if (!r.ok) throw failure(p, r.status, raw);
    try { return JSON.parse(raw); } catch { throw Object.assign(new Error(`${p.name} answered with something that is not JSON`), { status: 502, provider: p.id }); }
  }
  async function generateContent({ model, contents, config = {} }: OpenAiRequest): Promise<AiAnswer> {
    const c = config, schema = c.responseSchema ? toJsonSchema(c.responseSchema) : null;
    const wantJson = c.responseMimeType === "application/json";
    let system = c.systemInstruction ? textOf(c.systemInstruction) : "";
    const tools = (c.tools || []).flatMap((t) => t.functionDeclarations || []).map((f) => ({ type: "function",
      function: { name: f.name, description: f.description || "", parameters: toJsonSchema(f.parameters || { type: "OBJECT", properties: {} }) } }));
    const body = (useSchema: boolean) => ({
      model: modelFor(model),
      messages: toMessages(contents, wantJson && schema && !useSchema ? `${system}\n\nAnswer with one JSON object only, matching this JSON schema:\n${JSON.stringify(schema)}` : wantJson && !schema ? `${system}\n\nAnswer with one JSON object only.` : system),
      ...(c.temperature != null ? { temperature: c.temperature } : {}),
      ...(tools.length ? { tools } : {}),
      ...(wantJson ? { response_format: schema && useSchema ? { type: "json_schema", json_schema: { name: "answer", schema, strict: false } } : { type: "json_object" } } : {}),
      stream: false,
    });
    let j: ChatCompletion;
    try { j = await post(body(schemaMode), c.abortSignal); }
    catch (e) {
      // a server without JSON schema mode: JSON mode with the schema in the instructions, from now on
      if (!(wantJson && schema && schemaMode && e.status === 400)) throw e;
      schemaMode = false;
      j = await post(body(false), c.abortSignal);
    }
    const msg: ChatAnswerMessage = j?.choices?.[0]?.message || {}, text = answerOnly(msg.content);
    const functionCalls = (msg.tool_calls || []).map((t) => { let args: Record<string, unknown> = {}; try { args = JSON.parse(t.function?.arguments || "{}"); } catch { /* none */ } return { id: t.id, name: t.function?.name, args }; });
    const u: ChatCompletion["usage"] = j?.usage || {};
    return {
      text, functionCalls,
      candidates: [{ content: { role: "model", parts: [...(text ? [{ text }] : []), ...functionCalls.map((f) => ({ functionCall: f }))] } }],
      usageMetadata: { promptTokenCount: u.prompt_tokens || 0, candidatesTokenCount: u.completion_tokens || 0, thoughtsTokenCount: u.completion_tokens_details?.reasoning_tokens || 0 },
    };
  }
  // local models on a CPU are slow: the app gives each request this many times longer (AI_TIMEOUT_FACTOR)
  const timeoutFactor = Number(process.env.AI_TIMEOUT_FACTOR) || (p.local ? 6 : 1);
  return { models: { generateContent }, provider: { id: p.id, name: p.name, model: p.model, reviewModel: p.reviewModel, local: p.local, search: false }, timeoutFactor };
}

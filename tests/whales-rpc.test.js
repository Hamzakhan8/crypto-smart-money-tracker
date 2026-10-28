// Ethereum node handling: batch limits learned from errors, nodes that refuse a kind of call are skipped for it,
// failing nodes rest longer each time. Fake nodes, no network.
import test from "node:test";
import assert from "node:assert/strict";

process.env.WHALES_RPC = "http://a.test,http://b.test,http://c.test";
let aDown = false;
const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
globalThis.fetch = async (url, opts) => {
  const calls = JSON.parse(opts.body), host = new URL(url).host;
  if (host === "a.test") {
    if (aDown) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (calls.length > 3) return reply(calls.map((c) => ({ id: c.id, error: { message: "Batch of more than 3 requests are not allowed on free plan" } })));
  }
  if (host === "b.test" && calls.some((c) => c.method === "eth_getLogs" && !c.params[0].address))
    return reply(calls.map((c) => ({ id: c.id, error: { message: "Please specify an address in your request" } })));
  if (host === "c.test") return reply({ error: { message: "Too Many Requests" } }, 429);
  return reply(calls.map((c) => ({ id: c.id, result: c.method === "eth_getLogs" ? [] : "0x60" })));
};
const { __rpcForTests: rpc } = await import("../whales.js");
const code = (n) => Array.from({ length: n }, (_, i) => ["eth_getCode", [`0x${i}`, "latest"]]);
const node = (h) => rpc.stats().find((s) => s.url.includes(h));

test("RPC: a node's batch limit is learned and the batch is split", async () => {
  const out = await rpc.rpcBatch(code(5));
  assert.equal(out.length, 5);
  assert.equal(node("a.test").maxBatch, 3);
  assert.equal(node("a.test").fail, 0); // a batch limit is not a failure
});

test("RPC: a node that refuses block-wide log queries is skipped for them; a failing node rests, longer each time", async () => {
  aDown = true;
  await assert.rejects(rpc.rpcBatch([["eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2", topics: ["0xddf2"] }]]]), /All RPC nodes failed/);
  const a = node("a.test"), b = node("b.test"), c = node("c.test");
  assert.ok(b.cannot.has("wideLogs")); assert.equal(b.fail, 0);
  assert.equal(a.streak, 2); assert.ok(a.restUntil - Date.now() > 50_000);   // 30 s, then 60 s
  assert.ok(c.fail >= 1 && c.restUntil > Date.now());
  // Other calls still work on b, which is not resting
  assert.deepEqual(await rpc.rpcBatch(code(1)), ["0x60"]);
  assert.ok(b.ok >= 1);
  // a recovers: a success clears its rest
  aDown = false; b.restUntil = c.restUntil = Date.now() + 60_000; b.ok = 0;
  await rpc.rpcBatch([["eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2", topics: ["0xddf2"] }]]]);
  assert.equal(a.streak, 0); assert.equal(a.restUntil, 0);
});

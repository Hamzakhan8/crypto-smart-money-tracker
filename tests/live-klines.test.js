// Live 5m candles (live-klines.js): stream messages become REST-format rows, the forming candle is replaced, the next
// one appended, a gap drops the coin (so it is downloaded again), and the close trigger fires once per close. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { createLiveKlines, klineRow } from "../live-klines.js";

const FIVE = 300_000, T0 = Date.parse("2026-11-03T10:00:00Z");
// A fake WebSocket: opens at once, records what is sent, and lets the test push messages.
function fakeWs() {
  const socks = [];
  class WS { constructor(url) { this.url = url; this.readyState = 1; this.sent = []; socks.push(this); setTimeout(() => this.onopen?.(), 0); }
    send(m) { this.sent.push(JSON.parse(m)); } close() { this.readyState = 3; this.onclose?.(); } }
  return { WS, socks };
}
const msg = (s, t, c, x) => ({ data: JSON.stringify({ stream: `${s.toLowerCase()}@kline_5m`, data: { e: "kline", s,
  k: { t, T: t + FIVE - 1, s, i: "5m", o: "1", c: String(c), h: String(c), l: "1", v: "10", n: 5, x, q: "100", V: "6", Q: "60" } } }) });
const row = (t, c) => [t, "1", String(c), "1", String(c), "10", t + FIVE - 1, "100", 5, "6", "60", "0"];

test("stream message -> the REST kline row", () => {
  const [s, r, closed] = klineRow(JSON.parse(msg("SOLUSDT", T0, 2, true).data));
  assert.equal(s, "SOLUSDT"); assert.equal(closed, true);
  assert.deepEqual(r, row(T0, 2));
  assert.equal(klineRow({ data: { e: "trade" } }), null);
});

test("live candles: subscribe, seed, replace the forming candle, append the next, drop the coin on a gap", async () => {
  const { WS, socks } = fakeWs();
  let clock = T0 + 2 * FIVE + 1000; const closes = [];
  const lk = createLiveKlines({ WS, now: () => clock, onClose: (e) => closes.push(e) });
  lk.want(["SOLUSDT", "ETHUSDT"]);
  await new Promise((r) => setTimeout(r, 300));
  const ws = socks[0];
  assert.deepEqual(ws.sent[0].params.sort(), ["ethusdt@kline_5m", "solusdt@kline_5m"]);
  assert.equal(lk.get("SOLUSDT"), null, "nothing before the first download");
  lk.seed("SOLUSDT", [row(T0, 1), row(T0 + FIVE, 1.1), row(T0 + 2 * FIVE, 1.2)]); // the last one is still forming
  assert.equal(lk.get("SOLUSDT").length, 3);
  ws.onmessage(msg("SOLUSDT", T0 + 2 * FIVE, 1.25, false));                       // forming candle updated
  assert.equal(lk.get("SOLUSDT").at(-1)[4], "1.25");
  clock = T0 + 3 * FIVE + 200;                                                    // the candle closes
  ws.onmessage(msg("SOLUSDT", T0 + 2 * FIVE, 1.3, true));
  assert.equal(lk.get("SOLUSDT").length, 3, "the closed candle is the newest finished one");
  assert.equal(closes.length, 1); assert.equal(closes[0].boundary, T0 + 3 * FIVE);
  ws.onmessage(msg("SOLUSDT", T0 + 3 * FIVE, 1.31, false));                       // the next candle starts
  assert.equal(lk.get("SOLUSDT").length, 4);
  ws.onmessage(msg("SOLUSDT", T0 + 5 * FIVE, 1.4, false));                        // a gap: one candle missing
  assert.equal(lk.get("SOLUSDT"), null, "a coin with a hole in its candles is downloaded again");
  lk.want(["ETHUSDT"]);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(ws.sent.at(-1), { method: "UNSUBSCRIBE", params: ["solusdt@kline_5m"], id: ws.sent.at(-1).id });
  lk.stop();
});

test("live candles: no WebSocket (Node under 22) means off, and the scanner downloads as before", () => {
  const lk = createLiveKlines({ WS: null });
  lk.want(["SOLUSDT"]);
  assert.equal(lk.status().on, false);
  lk.seed("SOLUSDT", [row(T0, 1)]);
  assert.equal(lk.get("SOLUSDT"), null);
});

// Whale tracker and DEX flows: swap detection from Transfer logs, names, transfer types, pool picking, token flows.
import test from "node:test";
import assert from "node:assert/strict";

const wh = await import("../whales.js");
const fl = await import("../flows.js");

const ZERO = "0x0000000000000000000000000000000000000000";
const W = "0xwallet", ROUTER = "0xrouter", POOL = "0xpool", POOL2 = "0xpool2", FEE = "0xfeewallet", SETTLE = "0xsettle";
const PRICES = { eth: 2000, pepe: 0.00001, usdc: 1, link: 10 };
const opts = (extra = {}) => ({
  isWallet: (a) => [W, FEE, "0xuser1", "0xuser2"].includes(a),
  valueOf: (tok, amt) => (PRICES[tok] != null ? amt * PRICES[tok] : null),
  isMajor: (tok) => tok === "eth" || tok === "usdc",
  ...extra,
});

test("swaps: buying a token with ETH sent to a router", () => {
  const legs = [{ token: "eth", from: ROUTER, to: POOL, amount: 1 }, { token: "pepe", from: POOL, to: W, amount: 2e8 }];
  const [s, ...rest] = wh.swapsFromLegs(legs, opts({ txFrom: W, txValueEth: 1 }));
  assert.equal(rest.length, 0);
  assert.deepEqual([s.wallet, s.from, s.to, s.fromAmt, s.toAmt, s.usd], [W, "eth", "pepe", 1, 2e8, 2000]);
});

test("swaps: selling for ETH (the router unwraps WETH, which leaves no Transfer to the wallet)", () => {
  const legs = [{ token: "pepe", from: W, to: POOL, amount: 3e8 }, { token: "eth", from: POOL, to: ROUTER, amount: 1.5 }];
  const [s] = wh.swapsFromLegs(legs, opts({ txFrom: W }));
  assert.deepEqual([s.from, s.to, s.toAmt, s.usd], ["pepe", "eth", 1.5, 3000]);
  // Without the sender known (history), the only one-sided wallet still gets the ETH
  assert.equal(wh.swapsFromLegs(legs, opts())[0].to, "eth");
});

test("swaps: token to token through a WETH hop is not counted as ETH", () => {
  const legs = [{ token: "link", from: W, to: POOL, amount: 100 }, { token: "eth", from: POOL, to: POOL2, amount: 0.5 }, { token: "pepe", from: POOL2, to: W, amount: 1e8 }];
  const [s, ...rest] = wh.swapsFromLegs(legs, opts({ txFrom: W }));
  assert.equal(rest.length, 0);
  assert.deepEqual([s.from, s.to, s.usd], ["link", "pepe", 1000]); // no ETH/stable side: the smaller side
});

test("swaps: a batch settlement (CoW) counts each user, not the solver or the contracts", () => {
  const legs = [{ token: "usdc", from: "0xuser1", to: SETTLE, amount: 5000 }, { token: "pepe", from: SETTLE, to: "0xuser1", amount: 5e8 },
    { token: "link", from: "0xuser2", to: SETTLE, amount: 300 }, { token: "usdc", from: SETTLE, to: "0xuser2", amount: 2990 }];
  const out = wh.swapsFromLegs(legs, opts({ txFrom: "0xsolver" }));
  assert.deepEqual(out.map((s) => `${s.wallet}:${s.from}>${s.to}:${s.usd}`).sort(), ["0xuser1:usdc>pepe:5000", "0xuser2:link>usdc:2990"]);
});

test("swaps: a fee wallet in the same transaction is never matched with the ETH", () => {
  const legs = [{ token: "pepe", from: W, to: POOL, amount: 3e8 }, { token: "pepe", from: W, to: FEE, amount: 1e6 }, { token: "eth", from: POOL, to: ROUTER, amount: 1.5 }];
  const out = wh.swapsFromLegs(legs, opts({ txFrom: W }));
  assert.equal(out.length, 1); assert.equal(out[0].wallet, W); assert.equal(out[0].to, "eth");
  // ETH far off the token's value is not trusted (here: a wallet that only received a little)
  const odd = [{ token: "pepe", from: POOL, to: FEE, amount: 1e6 }, { token: "eth", from: ROUTER, to: POOL, amount: 5 }];
  assert.equal(wh.swapsFromLegs(odd, opts()).length, 0);
});

test("swaps: mints, burns, plain transfers and unknown tokens are not swaps", () => {
  assert.equal(wh.swapsFromLegs([{ token: "pepe", from: ZERO, to: W, amount: 1e9 }], opts({ txFrom: W, txValueEth: 1 })).length, 0); // staking / vault mint
  assert.equal(wh.swapsFromLegs([{ token: "usdc", from: W, to: "0xfriend", amount: 9000 }], opts({ txFrom: W })).length, 0);
  const unknown = [{ token: "usdc", from: W, to: POOL, amount: 5000 }, { token: "0xscam", from: POOL, to: W, amount: 123 }];
  assert.equal(wh.swapsFromLegs(unknown, opts({ txFrom: W })).length, 0);
});

test("names: Blockscout answers become categories", () => {
  const n = (j) => wh.nameFromBlockscout(j);
  assert.deepEqual(n({ is_contract: true, name: "UniswapV3Pool" }), { name: "Uniswap V3 Pool", cat: "dex" });
  assert.deepEqual(n({ is_contract: true, name: "GnosisSafeProxy", implementations: [{ name: "Safe" }] }), { name: "Safe multisig", cat: "safe" });
  assert.equal(n({ is_contract: true, name: "SingleOwnerMSCA" }).cat, "safe");          // smart wallet = a wallet
  assert.deepEqual(n({ is_contract: false, ens_domain_name: "vitalik.eth" }), { name: "vitalik.eth", cat: "ens" });
  assert.deepEqual(n({ is_contract: true, name: "TransparentUpgradeableProxy", implementations: [{ name: "L1StandardBridge" }] }), { name: "L1 Standard Bridge", cat: "bridge" });
  assert.equal(n({ is_contract: true, name: "Aave v3 USDT" }).name, "Aave v3 USDT");
  assert.deepEqual(n({ is_contract: true, name: null }), { name: null, cat: "contract" });
});

test("transfer types: an unnamed contract is not 'wallet to wallet'", () => {
  const k = (f, t2, contracts = []) => wh.kindOf(f, t2, () => null, () => null, (a) => contracts.includes(a));
  assert.equal(k("0xa", "0xb"), "transfer");
  assert.equal(k("0xa", "0xvault", ["0xvault"]), "contract");
});

test("DEX pools: ranked by different wallets trading, not by volume", () => {
  const p = (address, base, quote, reserveUsd, traders1h, volume24h = 1e6) => ({ address, base: { symbol: base, address: base }, quote: { symbol: quote, address: quote }, reserveUsd, traders1h, volume24h });
  const picked = fl.pickPools([
    p("fake", "FAKE", "USDC", 0, 3, 9e7),        // huge volume, no liquidity, 3 traders: wash
    p("busy", "AERO", "USDC", 7e6, 400),
    p("thin", "DRB", "WETH", 1e6, 5),            // too few traders
    p("mid", "VVV", "WETH", 8e6, 60),
    p("gauge", "WETH", "USDC", 9e7, 900),
    p("stock", "MSTRc", "USDC", 5e6, 800),       // a tokenized stock, not crypto
  ], "base", 5);
  assert.deepEqual(picked.map((x) => x.address), ["busy", "mid", "gauge"]);
  assert.equal(picked[2].gauge, true);
});

test("token flows: bought / sold per token, ranked by real money (token-to-token loops last)", () => {
  const major = (k) => k === "ETH" || k === "USDC";
  const r = (wallet, from, to, usd) => ({ wallet, from, to, usd, net: "eth" });
  const f = fl.tokenFlowsOf([r("a", "ETH", "PEPE", 5000), r("b", "USDC", "PEPE", 3000), r("c", "PEPE", "ETH", 1000),
    r("x", "WASH1", "WASH2", 90000), r("y", "WASH2", "WASH1", 90000)], major);
  assert.equal(f[0].key, "PEPE");
  assert.deepEqual([f[0].inUsd, f[0].outUsd, f[0].netUsd, f[0].buyers, f[0].sellers], [8000, 1000, 7000, 2, 1]);
  assert.deepEqual(f[0].boughtWith.map((x) => x.key), ["ETH", "USDC"]);
  assert.deepEqual(f.slice(1).map((x) => x.tokenOnly), [true, true]);
});

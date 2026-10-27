// Builds data/eth-labels.json (address -> [name, category]) from the open Etherscan label dump at
// https://github.com/brianleect/etherscan-labels (MIT License, Copyright (c) 2022 Brian Lee Cheow Teng; scraped June 2023).
// Only entities that matter for whale tracking are kept: exchanges, funds / market makers, stablecoin issuers, bridges,
// DEXes, DeFi protocols, MEV bots, mixers and flagged addresses (exploiters, hackers, sanctioned). Run: node scripts/build-labels.js
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "https://raw.githubusercontent.com/brianleect/etherscan-labels/main/data/etherscan/combined/combinedAllLabels.json";
const here = path.dirname(fileURLToPath(import.meta.url));
const EXCHANGE_TAGS = new Set(["binance", "coinbase", "kraken", "okx", "huobi", "kucoin", "gate-io", "bitfinex", "crypto-com", "gemini", "bitstamp",
  "upbit", "bithumb", "poloniex", "bittrex", "ftx", "hotbit", "deribit", "fiat-gateway", "binance-deposit"]);
const EXCHANGES = "Binance|Coinbase|Kraken|OKX|OKEx|Huobi|HTX|KuCoin|Gate\\.io|Bitfinex|Bybit|Crypto\\.com|Gemini|Bitstamp|Upbit|Bithumb|MEXC|Bitget|" +
  "Poloniex|Bittrex|FTX|Deribit|Robinhood|Bitpanda|Bitvavo|Hotbit|BitMEX|Bitso|Luno|CoinDCX|WazirX|Paribu|BtcTurk|Korbit|Coinone|Bitkub|Indodax|" +
  "bitFlyer|LBank|BingX|Phemex|CoinEx|AscendEX|Bitrue|WhiteBIT|Coincheck|Bitpoint|Zaif|Liquid|Cobo|Bitzlato|Bilaxy|Hoo";
const EXCHANGE_NAME = new RegExp(`^(${EXCHANGES})\\b`, "i");
const DEPOSIT_AT = new RegExp(`:\\s*(${EXCHANGES})\\s+Deposit`, "i"); // "Wintermute: Binance Deposit" = an address at Binance
const FUNDS = new RegExp("^(Wintermute|Jump Trading|Jump Crypto|Cumberland|Alameda Research|Galaxy Digital|a16z|Andreessen Horowitz|Paradigm|DWF Labs|" +
  "Amber Group|GSR|B2C2|Flow Traders|Three Arrows Capital|Genesis Trading|Celsius Network|BlockFi|Polychain Capital|Pantera Capital|Multicoin Capital|" +
  "Dragonfly Capital|Framework Ventures|Nexo|FalconX|QCP Capital|Abraxas Capital|Fenbushi Capital|Spartan Group|Hashed|DeFiance Capital|Arrington|" +
  "Coinbase Ventures|Binance Labs|Matrixport|Electric Capital|Delphi Digital|Mechanism Capital|Laser Digital|Auros|Kronos Research|Selini Capital|" +
  "Wintermute Trading|Cumberland DRW|Grayscale|MicroStrategy|BitGo|Anchorage|Fidelity|BlackRock|21Shares|Bitwise|VanEck)\\b", "i");
const ISSUER = /^(Tether: (Treasury|Multisig)|Circle\b|Paxos(:|\s\d|$)|TrueUSD: (Treasury|Multisig)|Ethena: (Minting|Treasury))/i;
const BRIDGE = /bridge|portal|wormhole|multichain|stargate|hop protocol|across protocol|optimism: gateway|arbitrum: (delayed )?inbox|l1 (erc20|eth) gateway/i;
const DEX_TAGS = new Set(["uniswap", "sushiswap", "balancer", "bancor", "curve-fi", "1inch", "0x-protocol", "kyberswap", "dex", "paraswap", "cow-protocol", "dodo", "dex-aggregator"]);
const DEFI_TAGS = new Set(["aave", "compound", "lido", "rocket-pool", "yearn-finance", "convex-finance", "synthetix", "maker", "frax-finance", "liquity", "euler", "morpho", "eigenlayer", "pendle"]);

const TOKEN_CONTRACT = /\([A-Z0-9.$]{2,12}\)$|\bToken\b/; // e.g. "Tether USD (USDT)", "Binance: BNB Token"
const FLAGGED = /exploiter|hacker|fake_phishing|heist/i;

function classify(name, tags) {
  if (!name || /alert|^Null Address/i.test(name)) return null; // drops the mass "Hack Alert" / "Scam ALERT" lists; mints are handled in code
  if (/^Tornado\.Cash/i.test(name)) return ["mixer", name];
  if (TOKEN_CONTRACT.test(name)) return null;
  if (tags.includes("blocked") || tags.includes("ofac-sanctions-lists") || FLAGGED.test(name)) return ["flagged", name];
  if (ISSUER.test(name) || tags.includes("centre")) return ["issuer", name];
  const at = name.match(DEPOSIT_AT);
  if (at) return ["exchange", `${name.split(":")[0].trim()} (${at[1]} deposit)`];
  if (tags.some((t) => EXCHANGE_TAGS.has(t)) || EXCHANGE_NAME.test(name)) return ["exchange", name];
  if (tags.includes("mev-bot")) return ["mev", name];
  if (FUNDS.test(name)) return ["fund", name];
  if (tags.includes("bridge") || BRIDGE.test(name)) return ["bridge", name];
  if (tags.some((t) => DEX_TAGS.has(t))) return ["dex", name];
  if (tags.some((t) => DEFI_TAGS.has(t))) return ["defi", name];
  return null;
}

const res = await fetch(SRC);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const all = await res.json();
const out = {}, counts = {};
for (const [addr, v] of Object.entries(all)) {
  const c = classify(String(v.name || ""), v.labels || []);
  if (!c) continue;
  out[addr.toLowerCase()] = [c[1], c[0]];
  counts[c[0]] = (counts[c[0]] || 0) + 1;
}
await mkdir(path.join(here, "..", "data"), { recursive: true });
await writeFile(path.join(here, "..", "data", "eth-labels.json"), JSON.stringify({ source: SRC, license: "MIT (c) 2022 Brian Lee Cheow Teng", scraped: "2023-06-18", labels: out }));
console.log("kept", Object.keys(out).length, "of", Object.keys(all).length, counts);

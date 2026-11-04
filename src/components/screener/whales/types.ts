// The JSON of the Whales tab's endpoints (whales.js, flows.js, whale-signals.js, the on-chain scan in screener.js).
// Only the fields the tab reads are listed. Names, labels and token symbols come from the blockchain: anyone can pick
// them, so they are only ever rendered as React text.

// ---------- GET /api/whales?window= (the Ethereum whale tracker) ----------
/** A sender or receiver of a transfer, or a counterparty in an address profile. */
export interface Party {
  address: string; name?: string | null; category?: string | null; entity?: string | null;
  learned?: boolean; contract?: boolean; safe?: boolean; special?: string | null; usd?: number;
}
export interface Transfer {
  id: string; t: number; txUrl?: string | null; symbol: string; amount: number; usd: number; kind: string;
  stable?: boolean; plumbing?: boolean; from: Party; to: Party;
}
export interface Link { label: string; url: string }
/** A whale or DEX alert (also shown as a popup by the screener page). */
export interface WEvent { id: string; type: string; time: number; net?: string; title: string; lines?: string[]; links?: Link[] }
export interface RpcNode {
  url: string; ok: number; fail: number; lastError?: string | null; lastErrorAt?: number | null; restUntil?: number | null;
  maxBatch: number; cannot?: { what: string }[];
}
export interface WhaleWatch { id: string; kind: string; name?: string | null; address?: string; symbol?: string; minUsd: number }
export interface ExTokenFlow { token?: string; symbol: string; stable?: boolean; deposits: number; withdrawals: number; net: number; n: number }
export interface ExFlow { exchange: string; deposits: number; withdrawals: number; stableIn: number; stableOut: number; net: number; n: number }
export interface Entity { name: string; category?: string | null; inUsd: number; outUsd: number; net: number; n: number; addresses: number }
export interface BigWallet { address: string; name?: string | null; category?: string | null; inUsd: number; outUsd: number; net: number; topToken?: string | null }
export interface WhalesData {
  disabled?: boolean; demo?: boolean; status?: string; errors?: Record<string, string>;
  telegramConfigured?: boolean; telegramOn?: boolean;
  chain?: { lastBlock?: number; lagSec?: number | null; backfill?: { from: number; to: number; next?: number | null; done?: boolean } | null };
  config?: {
    minUsd?: number; alertUsd?: number; stableAlertUsd?: number; exchangeAlertUsd?: number; mintAlertUsd?: number;
    telegramPerHour?: number; labels?: number; labelsAsOf?: string; swapMinUsd?: number;
  };
  health?: {
    rpc?: RpcNode[]; tokensPriced?: number; dexCallsLastMin?: number; swaps1h?: number;
    names?: { cached?: number; named?: number; queue?: number; learned?: number; safes?: number; lastError?: string | null };
  };
  totals?: { transfers?: number; usd?: number; deposits?: number; withdrawals?: number };
  transfers?: Transfer[]; tokenFlows?: ExTokenFlow[]; exchangeFlows?: ExFlow[]; entities?: Entity[]; whales?: BigWallet[];
  events?: WEvent[]; watches?: WhaleWatch[];
}

// ---------- GET /api/whales/address?a= (the address window) ----------
export interface AddressProfile extends Party {
  categoryName?: string | null; inUsd: number; outUsd: number; n: number;
  counterparties: Party[]; transfers: Transfer[]; links: Link[];
}

// ---------- GET /api/flows?window= (DEX flows) ----------
/** A token in a swap: cls "token" for a normal token, otherwise a major (ETH, BTC, SOL, BNB, stablecoins). */
export interface Tok { symbol: string; cls: string; address?: string; amount?: number }
export interface Edge {
  key: string; net: string; chain: string; from: Tok; to: Tok; usd: number; n: number; wallets: number;
  oneWay: number; reverse: number; vsNormal: number | "new" | null; largest: number; majors: boolean;
}
export interface DexTokenFlow {
  key: string; net: string; chain: string; token: Tok; inUsd: number; outUsd: number; netUsd: number;
  buys: number; sells: number; buyers: number; sellers: number; biggestBuy?: number; tokenOnly?: boolean;
  boughtWith: { symbol: string; usd: number }[]; soldFor: { symbol: string; usd: number }[];
}
export interface Rotation { t: number; net: string; chain: string; wallet: string; walletUrl?: string | null; from: Tok; to: Tok; via: Tok; usd: number; gapMin: number }
export interface Swap {
  id: string; t: number; net: string; chain: string; wallet: string; walletUrl?: string | null; from: Tok; to: Tok; usd: number;
  dex?: string | null; hops: number; safe?: boolean; bot?: boolean; txUrl?: string | null;
}
export interface Network { id: string; name: string; source: string; pools?: number | null; followed?: string[]; swaps1h: number }
export interface PairWatch { id: string; net: string; from: string; to: string; minUsd: number; both: boolean; status?: string }
export interface FlowsData {
  disabled?: boolean; status?: string; errors?: Record<string, string>; telegramOn?: boolean;
  networks?: Network[]; totals?: { swaps1h?: number; usd1h?: number };
  edges?: Edge[]; tokenFlows?: DexTokenFlow[]; rotations?: Rotation[]; feed?: Swap[]; events?: WEvent[]; watches?: PairWatch[];
  config?: { rotationMinutes?: number; rotationUsd?: number; callsPerMin?: number };
  health?: { callsLastMin?: number; pausedUntil?: number | null };
  pools?: unknown[]; followMisses?: string[];
}

// ---------- GET /api/whalesig (Whale signals) ----------
export interface WsCoin {
  base: string; coin: string; px?: number | string | null; call: string; score: number; longUsd: number; shortUsd: number;
  nLong: number; nShort: number; flowUsd?: number | null; why?: string[];
}
export interface WsAfter { pct: number; right: boolean }
export interface WsSignal { base: string; call: string; score: number; why?: string[]; px?: number | string | null; after?: Record<string, WsAfter | undefined>; t: number }
export interface WsRecordCell { n: number; rightPct: number; avgPct: number }
export interface WsWhale { address: string; name?: string | null; account: number; pnlAll: number; pnlMonth: number; roiMonth: number; positions?: number | null; notional?: number | null }
export interface WhaleSig {
  status?: string; error?: string | null; updatedAt?: number; scanMs?: number; whalesAt?: number; read?: number; whales?: number;
  hourAgo?: unknown; snapshots?: number; coins?: WsCoin[]; signals?: WsSignal[];
  record?: Record<string, Record<string, WsRecordCell | undefined> | undefined>; whaleList?: WsWhale[];
}

// ---------- GET /api/onchain (Crowd vs smart money) ----------
export interface OcCoin {
  sym?: string; base: string; price?: number; acc?: number | null; top?: number | null; state?: string; gap?: number | null;
  accPct30d?: number | null; change24h?: number | null; oiChg3d?: number | null; higherLows?: boolean; lowerHighs?: boolean;
}
export interface OcSignal {
  side: number; status?: string; base: string; netPct?: number | null; why?: string | null; entry?: number | null; ref?: number | null;
  price?: number; peakPct?: number | null; lowPct?: number | null; acc?: number; top?: number; gap?: number; higherLows?: boolean;
  stop?: number; target?: number | null; riskPct?: number; closeBy?: number; at?: number;
}
export interface OcPart { n?: number; avg?: number; win?: number }
export interface OcRule { label: string; live?: boolean; note?: string | null; all: OcPart; older?: OcPart; newer?: OcPart; swing?: { older?: OcPart; newer?: OcPart }; verdict?: string }
export interface OnchainData {
  status?: string; error?: string | null; updatedAt?: number; scanMs?: number; nextScanAt?: number; open?: number | null;
  coins?: OcCoin[]; signals?: OcSignal[];
  rule?: { crowdShortMax?: number; smartLongMin?: number; crowdLongPct?: number; smartShortMax?: number };
  record?: { n?: number; avgPct?: number; winPct?: number };
  report?: {
    from?: string; to?: string; top?: number; coins?: number; exit?: { stopAtr?: number; holdBars?: number }; costPct?: number;
    split?: string; rules?: OcRule[]; note?: string | null;
  } | null;
}

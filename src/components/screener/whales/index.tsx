"use client";
// The Whales tab (the classic page's view-whales): whale signals (Hyperliquid), crowd vs smart money (the old On-chain
// tab), then the Ethereum whale tracker with the watchlist, exchange flows, entities, DEX flows, alert history and data
// health, and the address profile window. The whale and DEX popups are shown by the screener page on every tab.
import { useCallback, useState } from "react";
import { useScreener } from "../context";
import { AddrContext, AddressModal } from "./address";
import { OnChain } from "./onchain";
import { WhaleSignals } from "./signals";
import { Tracker, useTracker } from "./tracker";

export default function WhalesTab() {
  const { sec } = useScreener();
  const tr = useTracker();
  const [addr, setAddr] = useState<{ a: string; n: number } | null>(null);
  const openAddr = useCallback((a: string) => setAddr((x) => ({ a, n: (x?.n ?? 0) + 1 })), []);
  const closeAddr = useCallback(() => setAddr(null), []);

  return (
    <AddrContext.Provider value={openAddr}>
      <WhaleSignals />
      <OnChain />
      <Tracker tr={tr} />
      {sec === "all" && <div className="foot">How it works: the tracker reads every new Ethereum block from public RPC nodes (no key) and keeps every token or ETH transfer worth at least the minimum, priced with DexScreener. Tokens without real DEX liquidity are ignored, so fake tokens cannot create fake whales. Senders and receivers are matched against the label list, Blockscout names and learned exchange addresses; a transfer into an exchange is a deposit, out of one a withdrawal, between two wallets of the same exchange an internal move (hidden by default), into or out of an unnamed contract &quot;wallet ↔ contract&quot;. Deposits into a learned exchange address count at once; into an unknown one they show when the exchange sweeps them to its hot wallet. DEX swaps on Ethereum are rebuilt from the same blocks: in one transaction, a wallet that gave token A and got token B swapped A → B. Alerts: large transfers, non-stablecoin exchange deposits and withdrawals, stablecoin mints, burns and issuer moves, and anything on your watchlist.</div>}
      {addr && <AddressModal req={addr} onClose={closeAddr} reload={tr.load} />}
    </AddrContext.Provider>
  );
}

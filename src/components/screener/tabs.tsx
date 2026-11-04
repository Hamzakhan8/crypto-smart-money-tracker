import type { ReactNode } from "react";

// The screener page's tabs: order, titles, the line under the title, the intro text and the section tags of each.
export const TABS = ["ignition", "news", "alpha", "early2x", "perps", "whales", "liquidity", "rotation", "journal"] as const;
export type TabKey = (typeof TABS)[number];
export const TAB_LABELS: Record<TabKey, string> = {
  ignition: "Ignition", news: "News", alpha: "Alpha", early2x: "Early 2x", perps: "Perps", whales: "Whales", liquidity: "Liquidity", rotation: "BTC rotation", journal: "Journal",
};
export const TITLES: Record<TabKey, string> = {
  ignition: "Early ignition", news: "Market news", alpha: "Binance Alpha ignition", early2x: "Early 2x movers", perps: "Perps signals",
  whales: "Whales: on-chain signals and tracker", liquidity: "Liquidity: order-book heatmap and 5-exchange screener", rotation: "BTC rotation", journal: "Trade journal",
};
export const EYEBROWS: Record<TabKey, string> = {
  ignition: "Binance spot · no API key", news: "Google News · Binance · CoinDesk", alpha: "Binance Alpha · no API key", early2x: "Binance spot · no API key",
  perps: "Binance USDⓈ-M futures · no API key", whales: "Hyperliquid · Ethereum · DEX · Binance futures · no API key",
  liquidity: "Binance · Bybit · OKX · Coinbase · Kraken · no API key", rotation: "Binance spot · no API key", journal: "Your trades · saved on your PC",
};
export const LEDES: Record<TabKey, ReactNode> = {
  ignition: <>Catches tokens when volume ignites <b>before</b> price runs: 15-minute volume surging, buyers in control, a rising trend, price barely moved. Tokens that already ran are flagged so you do not chase them. New alerts appear here as popups.</>,
  news: "The most important crypto market news of the last 48 hours, each marked bullish, bearish or neutral for the market, and the overall news mood of the last 24 hours. From Google News, Binance's own announcements and CoinDesk (with a free API key), refreshed every 10 minutes.",
  alpha: "The same ignition idea for Binance Alpha tokens (Binance Wallet), the early on-chain tokens that are not Binance spot pairs, like EVAA: volume igniting on 5-minute candles before price runs, with pool liquidity, holders and DEX buyers vs sellers. Every alert is tracked, and a replay shows how the rule did before.",
  early2x: "Low- and mid-cap Binance spot tokens ($10M-$1B) showing measurable signs of a possible large move up before price expands: quiet accumulation, a tested range high, or an early volume ignition. +100% is a research target, not a prediction; every listed coin is tracked so the results can be checked.",
  perps: "Swing trades on Binance USDⓈ-M perpetuals, long and short: the setups that held up best in a 4.8-year backtest (after fees and every funding payment), found live after each 4h close. TAKE is kept for the A+ setups that passed every test. Each signal gets TAKE / WAIT / SKIP from its tested record, a size and liquidation check for your account, and is followed to its result. Check any trade idea of your own the same way. Scalp (the Scalp tag): 5-minute flush-bounce longs, the only one of seven tested scalp setups that made money after fees.",
  whales: <><b>Whale signals</b>: TAKE LONG, TAKE SHORT or LEAVE from the positions of Hyperliquid&apos;s biggest profitable wallets, Ethereum exchange flows, DEX flows and Binance&apos;s crowd vs top traders (the old On-chain tab is here now). Below that, Arkham-style whale tracking: every large Ethereum transfer of any token, who sent it and who received it (exchanges, funds, protocols, Safe multisigs, ENS names, learned exchange addresses), exchange inflows and outflows, the most active entities and wallets, plus where DEX money went: every Ethereum DEX swap and the most active pools on Base, Solana and BNB Chain. Watch any wallet, token or pair; alerts pop up on every tab.</>,
  liquidity: "Where the buy and sell orders sit (a live Binance order-book heatmap: brighter = more money waiting at that price) and which coins are hottest across Binance, Bybit, OKX, Coinbase and Kraken right now (a 0-100 hotness score and 10 signal checks). Ported from the open-source crypto-liquidity-terminal (MIT). Orders can be pulled at any moment: a wall is not a promise.",
  rotation: "Ranks altcoin narratives by what Bitcoin is doing. Every day BTC's daily chart is put into a regime, and each narrative is scored on how it did against BTC in past weeks with the same regime plus its price action now. The same rules are backtested week by week, with fees.",
  journal: "Your own trades next to the alerts they came from. Press \"I took it\" on an alert (Ignition or Alpha), enter your real fill, and close it with your real exit: the journal shows your results, and how far they are from the alerts' tracked results.",
};
// Section tags: one button per part of each page; a click shows only that part (All shows everything). Remembered per tab.
export const SECTIONS: Record<TabKey, [key: string, label: string][]> = {
  ignition: [["watch", "Live watch"], ["spot", "Spot plan"], ["pump", "Pump watch"], ["big", "Big-move"], ["alerts", "Alert history"], ["perf", "Performance"], ["board", "Setup leaderboard"], ["telegram", "Telegram"], ["health", "Data health"]],
  alpha: [["cand", "Candidates"], ["alerts", "Alerts"], ["live", "Live results"], ["replay", "Replay"], ["health", "Data health"]],
  early2x: [["cand", "Candidates"], ["results", "Measured results"], ["snaps", "Recent snapshots"], ["health", "Data health"]],
  news: [["mood", "Mood"], ["top", "Top stories"], ["list", "All news"], ["sources", "Sources"]],
  perps: [["signals", "Swing signals"], ["scalp", "Scalp"], ["bot", "Paper bot"], ["check", "Check a trade"], ["risk", "Risk settings"], ["coins", "Coins"], ["live", "Live results"], ["tested", "Backtest"], ["health", "Data health"]],
  liquidity: [["heatmap", "Heatmap"], ["screener", "Screener"], ["health", "Data health"]],
  whales: [["signals", "Whale signals"], ["crowd", "Crowd vs smart money"], ["watch", "Watchlist"], ["transfers", "Whale transfers"], ["flows", "Exchange flows"], ["entities", "Entities"], ["map", "DEX: where money went"], ["dex", "DEX rotations"], ["alerts", "Alert history"], ["health", "Data health"]],
  rotation: [["now", "This week"], ["alt", "Alt season"], ["ranking", "Narratives"], ["picks", "Token picks"], ["record", "Forward record"], ["backtest", "Backtest"], ["regimes", "BTC regimes"]],
  journal: [["add", "Add a trade"], ["open", "Open trades"], ["closed", "Closed trades"]],
};
// Old links that point into a tab's section: #scalp -> Perps › Scalp, #onchain -> Whales › Crowd vs smart money.
export const HASH_ALIASES: Record<string, [TabKey, string]> = { scalp: ["perps", "scalp"], onchain: ["whales", "crowd"] };

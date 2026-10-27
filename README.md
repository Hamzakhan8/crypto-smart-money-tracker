# Market Flow Radar

A real-time dashboard that tracks crypto market momentum, buyer/seller imbalances, and smart money flow for Binance spot pairs.

## Quick Start (How to run the app)

1. Make sure you have Node.js installed.
2. Open your terminal in the project folder and run:
   ```bash
   node --env-file=.env Screener.js
Open your web browser and go to: http://localhost:3000

(Optional: To enable the AI features, add a .env file with GEMINI_API_KEY=your_api_key and run the app using node --env-file=.env Screener.js)

📖 User Guide: How to use the app
Once the dashboard is open, here is how you can use it to spot market trends:

1. The Market Flow Leaderboard
This is the main table you see. It ranks coins based on real-time buying pressure.

Flow Score (0-100): A higher score (75+) means strong, aggressive buying activity right now. A lower score means selling pressure.

5m Taker Flow: Shows the exact percentage of market buys vs. market sells over the last 5 minutes.

Relative Volume: Shows if the current trading volume is unusually high compared to the recent average (e.g., "2.0x" means double the normal volume).

2. Inspecting the Order Book
If you see a coin with a high score and want to look deeper:

Click directly on the Coin Symbol (e.g., SUI ↗) in the table.

A popup will appear showing the live Order Book for that coin.

Here you can see the actual "Bids" (buyers waiting to buy) and "Asks" (sellers waiting to sell) to see where the support and resistance levels are.

3. Filtering the Noise
At the top of the table, use the drop-down filters to hide low-quality signals:

Min Score: Set this to "Score 60+" to only see coins with active momentum.

Min Volume: Set this to "$20M+ volume" to filter out low-liquidity coins that might be easily manipulated.

4. Web3 Signals Tab
Click the "Web3 signals" tab at the top of the table to switch views.

This shows recent "Smart Money" wallet activity tracked on-chain.

It tells you if profitable wallets are entering (Buy) or exiting (Sell) specific tokens.

5. Using the AI Agent
In the top right corner of the app, there is an "✨ AI Analysis" button.

Click it to have the AI instantly read the current top coins and wallet signals, generating a simple summary of where the market is flowing.

Recursive Mode: If you check the "Recursive Agent" box before clicking the button, a second "Risk Manager" AI will review the first report and point out potential fake-outs, low-volume risks, or traps.

6. Whale Tracker tab (Arkham-style)
Open the screener at http://localhost:3001 and click "Whale tracker" (or go to http://localhost:3001/#whales). It starts with `node server.js` or `node screener.js`. No API key needed.

Live whale transfers: every Ethereum transfer of any token (or ETH) above $100k, read straight from the blockchain, with who sent it and who received it. About 10,000 addresses are labelled: exchanges (Binance, Coinbase, Kraken, OKX…), funds and market makers, stablecoin issuers (Tether, Circle), bridges, DeFi protocols, MEV bots, mixers and flagged hacker addresses. Each transfer gets a type: exchange deposit (often before selling), exchange withdrawal, exchange to exchange, mint / burn, DeFi, bridge or wallet to wallet.

Exchange flows: how much of each token went onto and off exchanges, and each exchange's inflows and outflows.

Most active entities and biggest unlabelled wallets: who moved the most money in the last hour or day.

Click any address for its profile (label, transfers, top counterparties) with one-click links to Arkham, Etherscan and DeBank.

Watchlist: paste any wallet (give it your own label, it shows everywhere) or token (PEPE or its contract address) and get an alert on every move above your minimum.

DEX rotations: swaps on Ethereum, Base and Solana DEXes, e.g. ETH → PEPE. Watch a pair to be alerted on every swap above your size.

Alerts pop up on every tab and go to Telegram: transfers over $1M (stablecoins over $25M), non-stablecoin exchange deposits and withdrawals over $500k, stablecoin mints / burns and issuer moves over $10M, watched wallets / tokens / pairs, and DEX rotation surges.

Data: public Ethereum RPC nodes (blocks and transfers), DexScreener (prices, liquidity), GeckoTerminal (DEX swaps) and an open Etherscan label snapshot from June 2023 (data/eth-labels.json, rebuilt with `node scripts/build-labels.js`). Newer exchange wallets can show as unlabelled. Settings (optional, in .env): WHALES_MIN_USD=100000 · WHALES_ALERT_USD=1000000 · WHALES_STABLE_ALERT_USD=25000000 · WHALES_EXCHANGE_ALERT_USD=500000 · WHALES_MINT_ALERT_USD=10000000 · WHALES_TELEGRAM_PER_HOUR=30 · WHALES_RPC=your own node URL(s) · FLOWS_NETWORKS=eth,base,solana · SCREENER_WHALES=0 to switch it all off. Run with DEMO=1 to preview with simulated data.

⚠️ Disclaimer
The scores and AI analyses are tools for research, not financial advice. A high score means buyers are currently aggressive, but it does not guarantee the price will continue to go up. Always check the charts before making a trade. This app does not place trades for you.


<FollowUp> Does this user guide cover the dashboard features in a way that is easy for non-technical users to understand?</FollowUp>

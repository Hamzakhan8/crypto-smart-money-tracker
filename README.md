# Market Flow Radar

A real-time dashboard that tracks crypto market momentum, buyer/seller imbalances, and smart money flow for Binance spot pairs.

## Quick Start (How to run the app)

1. Install Node.js 18 or newer.
2. Open a terminal in the project folder and run:
   ```bash
   npm install
   node server.js
   ```
   (or `npm start`). Everything runs on one server, on one port:

   | App | Address |
   |---|---|
   | Market Flow Radar | http://localhost:3000 |
   | Early Setup Screener | http://localhost:3000/screener |
   | BTC rotation | http://localhost:3000/screener#rotation |
   | Whale tracker | http://localhost:3000/screener#whales |

3. Optional settings go in a `.env` file in the project folder; it is loaded automatically, no `--env-file` needed. For example `GEMINI_API_KEY=your_key` for the AI analysis, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for alerts, or `PORT=3005` if port 3000 is taken.

If you see "Port 3000 is already in use", another copy of the app is still running: close that terminal window, or pick another port in `.env`. You can still run the screener on its own with `node screener.js` (it then uses port 3001).

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
Open http://localhost:3000/screener and click "Whale tracker" (or go straight to http://localhost:3000/screener#whales). It starts with `node server.js`. No API key needed.

Live whale transfers: every Ethereum transfer of any token (or ETH) above $100k, read straight from the blockchain, with who sent it and who received it. About 10,000 addresses are labelled: exchanges (Binance, Coinbase, Kraken, OKX…), funds and market makers, stablecoin issuers (Tether, Circle), bridges, DeFi protocols, MEV bots, mixers and flagged hacker addresses. Each transfer gets a type: exchange deposit (often before selling), exchange withdrawal, exchange to exchange, mint / burn, DeFi, bridge or wallet to wallet.

Exchange flows: how much of each token went onto and off exchanges, and each exchange's inflows and outflows.

Most active entities and biggest unlabelled wallets: who moved the most money in the last hour or day.

Click any address for its profile (label, transfers, top counterparties) with one-click links to Arkham, Etherscan and DeBank.

Watchlist: paste any wallet (give it your own label, it shows everywhere) or token (PEPE or its contract address) and get an alert on every move above your minimum.

DEX rotations: swaps on Ethereum, Base and Solana DEXes, e.g. ETH → PEPE. Watch a pair to be alerted on every swap above your size.

Alerts pop up on every tab and go to Telegram: transfers over $1M (stablecoins over $25M), non-stablecoin exchange deposits and withdrawals over $500k, stablecoin mints / burns and issuer moves over $10M, watched wallets / tokens / pairs, and DEX rotation surges.

Data: public Ethereum RPC nodes (blocks and transfers), DexScreener (prices, liquidity), GeckoTerminal (DEX swaps) and an open Etherscan label snapshot from June 2023 (data/eth-labels.json, rebuilt with `node scripts/build-labels.js`). Newer exchange wallets can show as unlabelled. Settings (optional, in .env): WHALES_MIN_USD=100000 · WHALES_ALERT_USD=1000000 · WHALES_STABLE_ALERT_USD=25000000 · WHALES_EXCHANGE_ALERT_USD=500000 · WHALES_MINT_ALERT_USD=10000000 · WHALES_TELEGRAM_PER_HOUR=30 · WHALES_RPC=your own node URL(s) · FLOWS_NETWORKS=eth,base,solana · SCREENER_WHALES=0 to switch it all off. Run with DEMO=1 to preview with simulated data.

7. Early Setup Screener: ignition alerts (v5)
The "Early ignition" tab on http://localhost:3000/screener watches every liquid Binance USDT pair for volume igniting before price runs.

Early ignition alert: the last two finished 5-minute candles both traded at least 3x that token's normal volume for this hour of the day, price rose over those 10 minutes and most of the volume was aggressive buying. It also has to pass the quality checks: daily RSI 65 or lower, the last candle not an exhausted spike that closed at its high, not the top tick of the 2-hour range, a rising 4-hour trend, BTC not falling over 1 and 4 hours, and no market-wide surge.

Confirmed ignition alert: the same, plus an ignition score of 65+ (volume that keeps running). It usually comes a few minutes later and was the more accurate tier in testing.

In a 60-day replay of 65 tokens (node screener-backtest.js), the confirmed tier won 26% of the time at +4% / -2.5% within 6 hours and averaged +0.55% per alert after fees, against 21% and -0.04% for the previous version. Past results do not guarantee future results; the performance panel tracks every live alert per tier. Settings (optional): SCREENER_EARLY_RVOL=3 · SCREENER_MAX_DAILY_RSI=65 · SCREENER_BTC_4H_MIN=-0.1 · SCREENER_EARLY_ALERTS=0 to keep only confirmed alerts · SCREENER_IGNITE_MIN_SCORE=65.

⚠️ Disclaimer
The scores and AI analyses are tools for research, not financial advice. A high score means buyers are currently aggressive, but it does not guarantee the price will continue to go up. Always check the charts before making a trade. This app does not place trades for you.


<FollowUp> Does this user guide cover the dashboard features in a way that is easy for non-technical users to understand?</FollowUp>

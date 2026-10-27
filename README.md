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

6. Whale Moves tab (on-chain swaps)
Open the screener at http://localhost:3001 and click the "Whale moves" tab (or go straight to http://localhost:3001/#whales). It starts together with `node server.js` or `node screener.js`.

It follows real swaps on decentralized exchanges (Ethereum, Base and Solana by default) and shows where money is rotating: which token big wallets sold and which one they bought, for example ETH → PEPE.

Watch a pair: type a pair like ETH-PEPE, SOL-BONK or USDC-ETH, choose a minimum swap size and click "Watch". Every swap on that route above your size pops up on screen and goes to Telegram.

Top rotations: the biggest FROM → TO flows in the last 15 minutes, hour or day, how many wallets took part, how one-sided the flow was, and how it compares with that route's normal level.

Wallet rotations: wallets that sold one token and bought another within 30 minutes.

Alerts (popup on every tab + Telegram): whale swaps ($100k+), your watched pairs, sudden one-way rotation surges, and wallet rotations ($25k+). Bot-like wallets (MEV round trips, very high-frequency traders) are filtered out.

Data comes from the free GeckoTerminal API, no key needed. Wallets are anonymous addresses: the tab shows what big wallets did, not who they are. Settings (all optional, in .env): FLOWS_NETWORKS=eth,base,solana · FLOWS_WHALE_USD=100000 · FLOWS_MIN_TRADE_USD=2000 · FLOWS_SURGE_USD=50000 · FLOWS_ROTATION_USD=25000 · SCREENER_WHALES=0 to switch it off. Telegram uses the same TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as the other screeners. Run with DEMO=1 to preview with simulated data.

⚠️ Disclaimer
The scores and AI analyses are tools for research, not financial advice. A high score means buyers are currently aggressive, but it does not guarantee the price will continue to go up. Always check the charts before making a trade. This app does not place trades for you.


<FollowUp> Does this user guide cover the dashboard features in a way that is easy for non-technical users to understand?</FollowUp>

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
   | Early 2x movers | http://localhost:3000/screener#early2x |
   | AI trade desk | http://localhost:3000/ai |

3. Optional settings go in a `.env` file in the project folder; it is loaded automatically, no `--env-file` needed. For example `GEMINI_API_KEY=your_key` for the AI analysis, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for alerts, or `PORT=3005` if port 3000 is taken.

Telegram (needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env): only ignition alerts (early and confirmed) and AI messages are sent: the AI's verdict on each new alert and results you send from the AI desk. Everything else stays on screen. To also send them: RADAR_TELEGRAM=1 (Market Flow Radar "Strong flow"), WHALES_TELEGRAM=1 (whale transfers), FLOWS_TELEGRAM=1 (DEX rotations). AI_REVIEW_TELEGRAM=0 stops the AI follow-ups.

Tests: `npm test` checks the signal, outcome-tracking, AI safety and Early 2x scoring / tracking logic (no internet or API key needed).

Keeping git clean (one time): packages and files the app rewrites while it runs are listed in .gitignore, but copies that were committed earlier are still tracked, which causes merge trouble. To stop tracking them while keeping them on your PC, run once:
   ```bash
   git rm -r --cached node_modules rotation_cache binance_meta.json coingecko_cache.json screener_state.json
   git commit -m "Stop tracking packages, caches and live data files"
   git push origin main
   ```
   `--cached` removes them from git only; your files stay where they are. Run `npm install` on any other computer after cloning.

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

Alerts pop up on every tab (Telegram only with WHALES_TELEGRAM=1 / FLOWS_TELEGRAM=1): transfers over $1M (stablecoins over $25M), non-stablecoin exchange deposits and withdrawals over $500k, stablecoin mints / burns and issuer moves over $10M, watched wallets / tokens / pairs, and DEX rotation surges.

Data: public Ethereum RPC nodes (blocks and transfers), DexScreener (prices, liquidity), GeckoTerminal (DEX swaps) and an open Etherscan label snapshot from June 2023 (data/eth-labels.json, rebuilt with `node scripts/build-labels.js`). Newer exchange wallets can show as unlabelled. Settings (optional, in .env): WHALES_MIN_USD=100000 · WHALES_ALERT_USD=1000000 · WHALES_STABLE_ALERT_USD=25000000 · WHALES_EXCHANGE_ALERT_USD=500000 · WHALES_MINT_ALERT_USD=10000000 · WHALES_TELEGRAM_PER_HOUR=30 · WHALES_RPC=your own node URL(s) · FLOWS_NETWORKS=eth,base,solana · SCREENER_WHALES=0 to switch it all off. Run with DEMO=1 to preview with simulated data.

7. Early Setup Screener: ignition alerts (v6)
The "Early ignition" tab on http://localhost:3000/screener watches every liquid Binance USDT pair for volume igniting before price runs.

Early ignition alert: the last two finished 5-minute candles both traded at least 3x that token's normal volume for this hour of the day, price rose over those 10 minutes and most of the volume was aggressive buying. It also has to pass the quality checks: daily RSI 65 or lower, the last candle not an exhausted spike that closed at its high, not the top tick of the 2-hour range, a rising 4-hour trend, BTC not falling over 1 and 4 hours, and no market-wide surge.

Confirmed ignition alert: the same, plus an ignition score of 65+ (volume that keeps running). It usually comes a few minutes later and is the tier worth trading; treat early alerts as a heads-up.

Every alert is tracked as a trade: take profit at +6%, stop at -3%, otherwise sell after 12 hours, judged on 1-minute candles, after 0.2% fees and 0.1% slippage. The performance panel shows "hit target" and "closed in profit" for each tier, and splits results by the AI's verdict.

In a 60-day replay of 51 crypto tokens (node screener-backtest.js), the confirmed tier hit the target 31% of the time, closed in profit 51% of the time and averaged +1.09% per trade after costs (the old +4% / -2.5% / 6h exit: +0.45%). Early alerts averaged +0.19%. Past results do not guarantee future results. Settings (optional): SCREENER_TARGET_PCT=6 · SCREENER_STOP_PCT=3 · SCREENER_OUTCOME_HOURS=12 · SCREENER_SLIPPAGE_PCT=0.1 · SCREENER_EARLY_RVOL=3 · SCREENER_MAX_DAILY_RSI=65 · SCREENER_BTC_4H_MIN=-0.1 · SCREENER_EARLY_ALERTS=0 to keep only confirmed alerts · SCREENER_IGNITE_MIN_SCORE=65.

8. AI Trade Desk (Gemini)
Open http://localhost:3000/ai (needs GEMINI_API_KEY in .env). It lists the coins the screener flags as igniting or heating up.

Analyze: the desk gathers everything that matters about the coin and asks Gemini whether to take the trade: the screener's signal and what it still lacks, the 15-minute / 1-hour / 4-hour chart (trend, momentum, typical move, VWAP), support and resistance, the order book, futures positioning (funding, open interest, long/short ratio), the Market Flow Radar's live numbers for the coin (flow score, 5-minute buyers vs sellers, net flow, volume surge, and how many coins are seeing buyers right now), smart-money wallet signals, whale transfers and exchange flows, DEX buying and selling, BTC, and how often this kind of signal won in the past. The answer is TAKE, WAIT or SKIP with a plan: entry zone, stop loss, targets, reward:risk and how long to hold, plus the reasons for and against and what would invalidate it.

Analyze all: one request triages every igniting coin at once and ranks them; open "Full analysis" on any of them for a trade plan. "Data only" shows all the facts without calling Gemini (free). Tick "risk review" for a second, stronger model to double-check the call, and "send to Telegram" to get the result on your phone.

Automatic review: with a Gemini key set, every new ignition alert gets one AI analysis (TAKE / WAIT / SKIP) that is saved with the alert, shown in the alert history, sent to Telegram as a follow-up, and used by the performance panel ("AI said TAKE / WAIT / SKIP") so you can see after a few weeks whether the AI's calls really do better. AI_AUTO_REVIEW=0 turns it off, AI_REVIEWS_PER_HOUR=12 caps the cost, AI_REVIEW_TELEGRAM=0 skips the Telegram follow-up.

Rules the code enforces after Gemini answers: TAKE only for coins igniting right now with reward:risk of at least 1.2, never for coins that already ran; plans must fit the real levels or the screener's own +6% / -3% plan is shown instead; confidence is lowered for early signals, demo data, weak markets and 4h downtrends. Long only, no leverage, risk at most 1% of your account. Each analysis is one Gemini request (two with risk review) and is reused for 3 minutes. It is an AI opinion on data, not financial advice.

9. Early 2x Movers (research screen)
Open http://localhost:3000/screener#early2x. It looks for low- and mid-cap Binance spot USDT tokens that show measurable signs of a possible large move up before price expands. +100% within 1-14 days is the research target, with a second 15-42 day horizon. A 2x move is a target to measure against, not a prediction, and an empty list is a valid answer.

Universe: Binance USDT pairs with a verified market cap of $10M-$1B ($10M-$500M preferred, $500M-$1B extended), at least $1M of 24h volume and a spread of 0.30% or less. Market cap = Binance's own circulating supply × price, cross-checked with CoinGecko when it can be reached. A coin with no verified market cap is never listed; nothing is estimated. Stablecoins, wrapped and staked tokens, gold, tokenized stocks and leveraged tokens are left out, and coins with under 14 days of history are flagged.

Two independent models, on finished candles only:
- Model A, quiet accumulation: 24h volume at least 2× its 7-day baseline, with more trades, held over several hours, while price stays within a band set by the coin's own daily range. Pre-breakout = the same, pressing a 7-day high that has been tested before (or with compressed volatility).
- Model B, early ignition: the last 3+ five-minute candles each at 2×+ the normal volume for that hour of day, accelerating, with 55%+ aggressive buying and price rising.

Evidence is grouped into five independent families: volume and trade activity, executed buying (buy share, CVD, large trades), price structure, order-book support, and strength vs BTC. Indicators that measure overlapping things count once. High priority needs 3+ families, a score of 50+ and passing liquidity, data-quality, extension, BTC and supply checks. A market cap where Binance and CoinGecko are more than 25% apart counts as not verified, and so does less than 40% of max supply circulating; either one blocks high priority. Coins stretched beyond limits that scale with their own volatility go to "Already moved — do not chase"; momentum alone is not rejected.

Score out of 100, every point shown in the coin's detail view: spot volume anomaly and persistence 20, buying pressure and trade flow 20, price structure and breakout readiness 15, liquidity and execution 10, relative strength and market regime 10, volatility compression 10, tokenomics and verified catalysts 10, data reliability 5. Missing data earns no points. The score is not a probability of doubling.

Futures (open interest over 1h / 24h / 48h, funding and its changes, crowded positioning) and on-chain flows (the whale and DEX trackers) are shown as context only. They never count as a confirmation or as proof of whale buying.

Token unlocks and catalysts come only from data/early2x-events.json, which you keep, and only entries with an https source count. A verified unlock of 2%+ of circulating supply within 30 days is flagged and blocks high priority. A dated unlock check showing nothing major earns tokenomics points for 30 days. The file explains the format.

Tracking: every listed coin is saved as an unchangeable snapshot before its move, then measured from the snapshot price at 1h, 6h, 12h, 24h, 3d, 7d, 14d, 21d and 42d. Each check records the return, the best and worst point, whether it reached +25%, +50% and +100%, how long that took, and how far it fell first. Price is read on 5-minute candles for the first day and hourly after that, with 1-minute candles to settle any candle that touched both a target and the -20% reference stop; if that cannot be settled, the stop counts first. Coins that stop trading keep their last price in the results instead of disappearing. The results panel shows sample sizes, fees (0.2%) and slippage (0.3%), false positives (never reached +25% in 14 days), and splits by state, priority, market-cap range and score. An older-vs-newer split shows whether results hold on later signals. "Already moved" coins are tracked too, as a control group. Nothing is called profitable until at least 30 signals have had 14 days to play out and the result is positive in both halves.

Settings (optional, in .env): EARLY2X_MCAP_MIN=10000000 · EARLY2X_MCAP_PREFERRED_MAX=500000000 · EARLY2X_MCAP_MAX=1000000000 · EARLY2X_MIN_QUOTE_VOLUME=1000000 · EARLY2X_MAX_SPREAD_PCT=0.3 · EARLY2X_MIN_DEPTH_USD=10000 · EARLY2X_A_VOLUME_RATIO=2 · EARLY2X_B_RVOL_5M=2 · EARLY2X_B_CANDLES=3 · EARLY2X_MIN_CONFIRMATIONS=3 · EARLY2X_HIGH_MIN_SCORE=50 · EARLY2X_EXT_24H_MIN_PCT=15 · EARLY2X_EXT_24H_RANGE_MULT=2 · EARLY2X_MIN_CIRCULATING_PCT=40 · EARLY2X_MCAP_TOLERANCE_PCT=25 · EARLY2X_STOP_PCT=20 · EARLY2X_SLIPPAGE_PCT=0.3 · EARLY2X_COOLDOWN_HOURS=24 · EARLY2X_SCAN_MINUTES=5 · score weights EARLY2X_W_VOLUME=20 (also _FLOW, _STRUCTURE, _LIQUIDITY, _STRENGTH, _COMPRESSION, _TOKENOMICS, _DATA) · COINGECKO_API_KEY=your free demo key (optional, faster supply data) · EARLY2X_COINGECKO=0 to skip CoinGecko · EARLY2X=0 to switch the screen off. Every other threshold is listed at the top of early2x.js.

Telegram: off until you set EARLY2X_ALERTS=1. Then only new high-priority candidates are sent, once per coin per 24 hours unless the state improves. No trades are ever placed.

Data and storage: snapshots and tracking live in early2x_state.json (kept out of git). The file carries a version number and is upgraded automatically when the format changes, so there is no database or migration to run; delete the file to start the record again. GET /api/early2x/signals returns every snapshot with its tracking, for your own analysis. CoinGecko's free API is slow, so supply data arrives a few minutes after the first start (until then it earns no points).

⚠️ Disclaimer
The scores and AI analyses are tools for research, not financial advice. A high score means buyers are currently aggressive, but it does not guarantee the price will continue to go up. Always check the charts before making a trade. This app does not place trades for you.


<FollowUp> Does this user guide cover the dashboard features in a way that is easy for non-technical users to understand?</FollowUp>

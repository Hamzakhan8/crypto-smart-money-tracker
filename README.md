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
   | Binance Alpha ignition | http://localhost:3000/screener#alpha |
   | AI trade desk | http://localhost:3000/ai |

3. Optional settings go in a `.env` file in the project folder; it is loaded automatically, no `--env-file` needed. For example `GEMINI_API_KEY=your_key` for the AI analysis, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for alerts, or `PORT=3005` if port 3000 is taken.

Telegram (needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env): only ignition alerts (early and confirmed) and AI messages are sent: the AI's verdict on each new alert and results you send from the AI desk. Everything else stays on screen. To also send them: RADAR_TELEGRAM=1 (Market Flow Radar "Strong flow"), WHALES_TELEGRAM=1 (whale transfers), FLOWS_TELEGRAM=1 (DEX rotations). AI_REVIEW_TELEGRAM=0 stops the AI follow-ups.

Not receiving messages? When `node server.js` starts it prints a "Telegram:" line: "bot @yourbot, sending to chat ..." means the token works; anything else says what is wrong. The screener's Data health panel shows the status, the last message and the last error, and has a "Send test message" button. Common fixes: a wrong token (copy it again from @BotFather); "chat not found" (open your bot in Telegram and press Start, check TELEGRAM_CHAT_ID; a group id starts with -100 and the bot must be in the group); a blocked bot (press Start / Unblock). Restart the server after editing .env. Also remember that ignition alerts are rare (often one or two a day across all coins), AI follow-ups need GEMINI_API_KEY and arrive only after an ignition alert, and big-move alerts reach Telegram only with SCREENER_BIGMOVE_ALERTS=1.

Tests: `npm test` checks the signal, outcome-tracking, AI safety, big-move tier, Early 2x scoring / tracking, BTC rotation and Binance Alpha logic (no internet or API key needed).

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

In a 60-day replay of 47 crypto tokens to Oct 28 2026 (node screener-backtest.js), the confirmed tier hit the target 30% of the time, hit the stop 21% of the time (the rest ended flat) and averaged +0.93% per trade after costs; early alerts hit the target 25% of the time and averaged +0.55%. Past results do not guarantee future results. Settings (optional): SCREENER_TARGET_PCT=6 · SCREENER_STOP_PCT=3 · SCREENER_OUTCOME_HOURS=12 · SCREENER_SLIPPAGE_PCT=0.1 · SCREENER_EARLY_RVOL=3 · SCREENER_MAX_DAILY_RSI=65 · SCREENER_BTC_4H_MIN=-0.1 · SCREENER_EARLY_ALERTS=0 to keep only confirmed alerts · SCREENER_IGNITE_MIN_SCORE=65.

Big-move tier (+40% before -10%): the same kind of 5-minute ignition (two finished 5m candles at 2× and 2.5× normal volume, price up, 52%+ aggressive buying), on a smaller coin ($1M-$10M of 24h volume) whose daily volume is already 1.5× or more its 20-day average. It has its own exit rule, +40% before -10% within 7 days, its own row in the performance panel and its own "Big-move watch" table: green = the 5m ignition fired (an alert), amber = waking up, waiting for the trigger. For this tier only, the screener also scans coins with $1M-$5M of daily volume; the quick tiers above never see them and work exactly as before.

What the data says (node bigmove-backtest.js: 90 days of 5m candles for every Binance USDT pair, a signal counted only if the coin had $1M+ of volume at that moment, 0.3% costs): about 1 in 10 of these ignitions reached +40% before -10% within a week. They made money in the August-September altcoin rally (+2.5% per trade on average, about 9.5% hit the target) and lost in October (-1.8% per trade, 7.9% hit), though less than 5m ignitions in general (-3.5%). No other filter tested held up in both periods: the quick tiers' gates did worse for moves this size, and market-trend filters flipped between months. So it is a research tier, not a proven edge, and its Telegram alerts are off until you set SCREENER_BIGMOVE_ALERTS=1. Re-run node bigmove-backtest.js every month (the first run downloads 500+ coins and takes 30-60 minutes; then it is cached): it shows each month separately, so you can see when the market starts paying this kind of move again.

Settings (optional): SCREENER_BIGMOVE_ALERTS=1 (Telegram) · SCREENER_BIGMOVE_TARGET_PCT=40 · SCREENER_BIGMOVE_STOP_PCT=10 · SCREENER_BIGMOVE_OUTCOME_HOURS=168 · SCREENER_BIGMOVE_MIN_VOLUME=1000000 · SCREENER_BIGMOVE_MAX_VOLUME=10000000 · SCREENER_BIGMOVE_MIN_DAILY_RVOL=1.5 · SCREENER_BIGMOVE_COOLDOWN_HOURS=24 · SCREENER_BIGMOVE=0 to switch the tier off. The AI desk keeps reviewing the quick tiers only.

8. AI Trade Desk (Gemini)
Open http://localhost:3000/ai (needs GEMINI_API_KEY in .env). It lists the coins the screener flags as igniting or heating up.

Analyze: the desk gathers everything that matters about the coin and asks Gemini whether to take the trade: the screener's signal and what it still lacks, the 15-minute / 1-hour / 4-hour chart (trend, momentum, typical move, VWAP), support and resistance, the order book, futures positioning (funding, open interest, long/short ratio), the Market Flow Radar's live numbers for the coin (flow score, 5-minute buyers vs sellers, net flow, volume surge, and how many coins are seeing buyers right now), smart-money wallet signals, whale transfers and exchange flows, DEX buying and selling, BTC, and how often this kind of signal won in the past. The answer is TAKE, WAIT or SKIP with a plan: entry zone, stop loss, targets, reward:risk and how long to hold, plus the reasons for and against and what would invalidate it.

Analyze all: one request triages every igniting coin at once and ranks them; open "Full analysis" on any of them for a trade plan. "Data only" shows all the facts without calling Gemini (free). Tick "risk review" for a second, stronger model to double-check the call, and "send to Telegram" to get every coin's decision (TAKE / WAIT / NO TRADE) on your phone.

Automatic review: with a Gemini key set, every new ignition alert gets one AI analysis (TAKE / WAIT / NO TRADE) that is saved with the alert, shown in the alert history, sent to Telegram as a follow-up, and used by the performance panel ("AI said TAKE / WAIT / SKIP") so you can see after a few weeks whether the AI's calls really do better. AI_AUTO_REVIEW=0 turns it off, AI_REVIEWS_PER_HOUR=12 caps the cost, AI_REVIEW_TELEGRAM=0 skips the Telegram follow-up.

How the AI decides: no trade is the default and TAKE has to be earned. Gemini works through fixed steps and shows them: (1) hard stops, any of which means no trade: the coin already ran, BTC down more than 1% in 1h or 2% in 4h, aggressive selling right now, a spread above 30 bps or under $20k of bids within 1%; (2) a checklist (trigger, executed buying, trend, room to resistance, liquidity, futures and whale positioning, market breadth, the live track record of this alert type and of its own past calls), each with the number that decides it; (3) the chance of hitting the target and the stop, starting from how often this kind of alert actually did (confirmed ignitions: 30% target / 21% stop in the replay; early: 25% / 29%; big-move: 8.5% / 39%; live results take over after 30 resolved alerts) and moved by at most 15 points with evidence; (4) the expected value per trade after costs. WAIT must name a price, a condition and a time limit.

Rules the code enforces after Gemini answers: it recomputes the expected value and keeps the chances within 15 points of the base rate; TAKE needs no hard stop, +0.5% or more expected per trade (AI_MIN_EV_PCT) and reward:risk of at least 1.5, only for coins igniting right now and never for coins that already ran; plans must fit the real levels or the alert's own plan (+6% / -3%, or +40% / -10% for big-move alerts) is shown instead; confidence is lowered for early signals, demo data, weak markets and 4h downtrends. Long only, no leverage, risk at most 1% of your account. Each analysis is one Gemini request (two with risk review) and is reused for 3 minutes. It is an AI opinion on data, not financial advice.

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

10. BTC rotation (narratives by BTC regime)
Open http://localhost:3000/screener#rotation. Every day BTC's daily chart is put into one of six regimes (breaking out, calm uptrend, uptrend, sideways, downtrend, falling hard). Each narrative is an equal-weight index of the largest coins carrying one of Binance's sector tags (AI, Meme, RWA, Gaming and so on), and is ranked by how it did against BTC in past weeks with the same regime (50%), its 14-day strength vs BTC now (30%) and the share of its coins above their 20-day average (20%). The rule holds the top 2 narratives in an uptrend (or up to 5 coins scoring 65+ inside them), re-decided every 7 days, and cash while BTC is in a downtrend.

This week: what the rule holds, the coins, the next decision date, the last time the holdings changed, the BTC regime with how many days it has lasted, how long it usually lasts and where BTC was 7 days later in past days like this.

Alt season meter: is money moving from BTC into altcoins? Three signals vote: the ETH/BTC trend (above its 50-day average with a rising 20-day average, or the opposite), the typical narrative's 30-day return vs BTC (up from +2%, down from -2%) and the share of all narrative coins above their 20-day average (up from 55%, down from 35%). Two votes the same way give "Alts leading" or "BTC leading", otherwise "Mixed". The last 120 days are shown as a strip.

Money flow and stage: each narrative's share of all altcoin trading volume over 7 days, with an arrow comparing it to its 30-day share, and a life-cycle stage: early (more coins turning up, few at 30-day highs yet, volume following), running, late (most coins at 30-day highs, or money leaving a strong run), cooling, quiet. Both are shown for context; neither is part of the score (see below).

How BTC regimes behave: how long each regime usually lasts (median days) and which regimes usually came right after it.

Forward record: every 7 days the screener saves what the rule holds with that day's prices and judges it 7 days later with prices that came afterwards, after fees. Unlike the backtest it cannot be fitted to the past, and a coin that is later delisted keeps its last price instead of vanishing. It also saves the coins in each narrative every day, so later backtests can use the lists as they really were (today's lists leave out coins that died, which flatters every narrative). Both live in rotation_record.json (kept out of git); demo mode does not record.

Backtest (node rotation-backtest.js, or the Backtest panel): each strategy is also shown on the older and the newer half of the weeks, because a change is only worth making if it wins in both. On real Binance data from Oct 2024 to Oct 2026 (107 weekly decisions, 11 narratives, 99 coins, 0.2% per round trip):
- Rotation ranking (top 2 narratives): +28% (older half +45%, newer half -12%); Hold BTC: +28% (+83% / -30%); token picks: +136% (+50% / +57%).
- Variant, hold BTC while the alt season meter says "BTC leading": +37% (+53% / -11%), better in both halves but by only 1 point in the newer half, so it is shown next to the rule ("Variant that holds BTC...") and not used.
- Variant, money flow as a fifth of the score: +4% (+27% / -18%), worse in both halves, so money flow is shown but not scored.
- Variant, token picks with the same BTC-leading filter: +113% (+36% / +57%), worse.
- One week decides most of it: token picks made +159% in a single week of a meme pump in April 2026 (币安人生 2.5×, ORDI 1.9×) and are -9% without that week; the rotation ranking is -5% without its best week. So none of these is a proven edge.
Narrative lists are today's, so these numbers are also flattered by survivorship; the forward record is the honest test.

Settings (optional, in .env): ROTATION_TELEGRAM=1 sends a message when the BTC regime or the holdings change (off by default; ignition and AI stay the only default Telegram messages) · ROTATION_HOLD_DAYS=7 · ROTATION_DAYS=1000 (days of history) · ROTATION_NARRATIVES=AI,Meme (only these).

11. Binance Alpha ignition (Binance Wallet tokens)
Open http://localhost:3000/screener#alpha. Binance Alpha tokens (the early on-chain tokens in Binance Wallet, like EVAA) are not Binance spot pairs, so the Ignition tab never sees them. This tab scans them every 5 minutes, about 25 seconds after each candle closes, with the same idea: volume igniting on 5-minute candles before price runs.

Tokens scanned: still trading on Alpha, not on Binance spot (the Ignition tab covers those), $50k+ of pool liquidity and 1,000+ holders (about 250 tokens). Data: the public endpoints Binance's own Alpha pages use (token list, 5-minute candles; no API key, not documented, so they can change), and DexScreener for buys vs sells, because Alpha trades carry no buyer/seller side.

Two tiers, like the Ignition tab:
- Early ignition: two finished 5-minute candles in a row, each at 5x the token's normal 5-minute volume (median of the last 24 hours) and $1,000+ with 10+ trades, price up over those 10 minutes (not more than 20%), and not already up 30% in 24 hours.
- Confirmed: the same with $1M+ traded in the last 24 hours.
Heating up (volume rising, not confirmed) and Already moved (up 30%+ in 24 hours, do not chase) are shown too. Every alert is tracked: +40% target before -10% stop within 7 days, after 1% costs.

What the replay says (node alpha-backtest.js: 5-minute candles of every Alpha token not on spot, Aug 29 to Oct 28 2026, 325 tokens that traded, 47 of them delisted since; Binance no longer serves candles for most long-delisted tokens, so those are missing, which flatters everything a little):
- Early tier: 2,839 alerts (about 50 a day), 11.2% hit +40% first, -1.2% per trade. Buying any active token at a random time: 9.7% and -1.3%. So no real edge: on tokens with tiny volume, "5x normal" happens all the time.
- Confirmed tier: 468 alerts (about 8 a day), 16.7% hit +40% first, +0.6% per trade (older two thirds +1.1%, newest third -0.8%). The same kind of tokens bought at a random time: 13.8% and -1.2%. Better than random in both halves, but close to break-even, and the $1M rule was picked after seeing these results, so the record may be flattered. The live tracking on the tab is the honest test.
- EVAA: the early tier caught its Oct 26-27 start (alert at $0.515, +40% reached the next day), but it also flagged EVAA 34 times in 60 days: 6 hit +40%, 23 were stopped, 5 timed out. The confirmed tier flagged EVAA 3 times (1 win, 2 stops) and missed the Oct 27 start, because by the time $1M had traded EVAA was already up more than 30%.

Telegram: off by default. ALPHA_TELEGRAM=1 sends confirmed alerts, ALPHA_TELEGRAM=all sends early ones too. Settings (optional, in .env): ALPHA_VOL_MULT=5 · ALPHA_MIN_5M_USD=1000 · ALPHA_MIN_TRADES=10 · ALPHA_MIN_24H_USD=1000000 · ALPHA_MIN_LIQUIDITY=50000 · ALPHA_MIN_HOLDERS=1000 · ALPHA_TARGET_PCT=40 · ALPHA_STOP_PCT=10 · ALPHA_OUTCOME_DAYS=7 · ALPHA_COST_PCT=1 · ALPHA=0 turns the tab off. Alerts live in alpha_state.json; run node alpha-backtest.js once to fill the tab's Replay panel (20-40 minutes the first time, cached in ./alpha_cache). All kept out of git.

Before trading one: pools are often a few hundred thousand dollars, so a market order moves the price; tokens can be delisted from Alpha; and the AI desk does not analyse Alpha tokens (it needs Binance spot data).

⚠️ Disclaimer
The scores and AI analyses are tools for research, not financial advice. A high score means buyers are currently aggressive, but it does not guarantee the price will continue to go up. Always check the charts before making a trade. This app does not place trades for you.


<FollowUp> Does this user guide cover the dashboard features in a way that is easy for non-technical users to understand?</FollowUp>

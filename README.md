# Smart Money Tracker

A free, self-hosted crypto research dashboard for Binance. It watches the whole market in real time, spots volume "ignitions" before price runs, follows whale wallets, ranks narratives by what Bitcoin is doing, and asks an AI to judge each setup. Then it tracks every alert so you can see what actually works.

- **One command** starts everything on one web address.
- **No exchange account or API key needed** (only Gemini, if you want the AI).
- **Alerts on screen and on Telegram.**
- **Honest numbers:** every signal is tracked after costs, and each tool has a replay test.

> **Research tool, not financial advice.** It never places trades. Most early signals fail; the numbers below show how often.

---

## Contents

1. [What is inside](#1-what-is-inside)
2. [Quick start (5 minutes)](#2-quick-start-5-minutes)
3. [Set up Telegram alerts](#3-set-up-telegram-alerts)
4. [Set up the AI (Gemini)](#4-set-up-the-ai-gemini)
5. [A simple daily routine](#5-a-simple-daily-routine)
6. [The tools, one by one](#6-the-tools-one-by-one)
   - [Learning from your live results](#68-learning-from-your-live-results)
   - [Trade journal](#69-trade-journal)
7. [What the tests say](#7-what-the-tests-say)
8. [Backtests and replays](#8-backtests-and-replays)
9. [All settings](#9-all-settings)
10. [Troubleshooting](#10-troubleshooting)
11. [Updating to a new version](#11-updating-to-a-new-version)
12. [For developers](#12-for-developers)

---

## 1. What is inside

| Tool | Address | What it does |
|---|---|---|
| **Market Flow Radar** | http://localhost:3000 | Live leaderboard of buying pressure on Binance spot coins, order books, smart-money wallet signals, AI market brief |
| **Ignition** | http://localhost:3000/screener | Alerts when a coin's volume ignites on 5-minute candles **before** price runs (early, confirmed and big-move tiers) |
| **Alpha** | http://localhost:3000/screener#alpha | The same ignition idea for **Binance Alpha / Binance Wallet** tokens (like EVAA), which are not spot pairs |
| **Early 2x** | http://localhost:3000/screener#early2x | Low- and mid-cap coins ($10M-$1B) showing early signs of a large move; every pick is tracked for 42 days |
| **Whales** | http://localhost:3000/screener#whales | Arkham-style whale tracker: big Ethereum transfers with names and learned exchange addresses, exchange inflows and outflows, where DEX money went (every Ethereum DEX, plus Base, Solana, BNB Chain), your own watchlist |
| **BTC rotation** | http://localhost:3000/screener#rotation | Which altcoin narratives (AI, Meme, RWA…) to hold for the current Bitcoin regime, alt season meter, weekly picks |
| **AI desk** | http://localhost:3000/ai | Gemini analyses a coin and answers **TAKE / WAIT / NO TRADE** with entry, stop, targets and expected value |
| **Journal** | http://localhost:3000/screener#journal | Your own trades: press **"I took it"** on an alert, enter your real fill, and compare your results with the alerts' |

**Section tags:** every page has a row of tags under its title (for example *Live watch · Big-move · Alert history · Performance* on Ignition). Click a tag to show only that part of the page; **All** shows everything. The bar stays at the top while you scroll, and each page remembers your choice.

**Filter tabs in every coin list:** each list (Market Flow leaderboard, Live ignition watch, Big-move watch, Alert history, Setup leaderboard, Alpha candidates and alerts, Early 2x candidates and snapshots, AI desk coins) has the same tabs, each with a count:

| Tab | Shows |
|---|---|
| **Strong flow** | Coins igniting now (Market Flow: flow score 75+; alert lists: confirmed and big-move alerts) |
| **Heating up** | Volume or buying building, not triggered yet (alert lists: early alerts) |
| **Already running** | Already moved, do not chase (alert lists: price already half way to the target or past it) |
| **AI: TAKE** | The AI said TAKE on that coin in the last 2 hours (an alert review, the AI desk or Ask AI) |

Hover a tab to see exactly what it means in that list. Each list remembers its tab.

---

## 2. Quick start (5 minutes)

### Step 1: Install Node.js

Download and install **Node.js 18 or newer** from https://nodejs.org (choose "LTS").
Check it in a terminal (Command Prompt / PowerShell on Windows, Terminal on Mac):

```bash
node -v
```

You should see `v18` or higher.

### Step 2: Download the project

```bash
git clone https://github.com/Hamzakhan8/crypto-smart-money-tracker.git
cd crypto-smart-money-tracker
```

No git? On GitHub click **Code → Download ZIP**, unzip it, and open a terminal in that folder.

### Step 3: Install

```bash
npm install
```

### Step 4: Add your settings (optional)

Copy the example settings file:

| Windows | Mac / Linux |
|---|---|
| `copy .env.example .env` | `cp .env.example .env` |

Open `.env` in any text editor. Everything is optional; the app works without it. The most useful lines:

```ini
GEMINI_API_KEY=your_key_here        # for the AI (step 4 below)
TELEGRAM_BOT_TOKEN=123456:ABC...    # for Telegram alerts (step 3 below)
TELEGRAM_CHAT_ID=123456789
```

### Step 5: Start

```bash
node server.js
```

(or `npm start`). Then open **http://localhost:3000** in your browser.

### Step 6: Check the startup lines

The terminal prints one line per tool. Look for:

- `Telegram: bot @yourbot, sending to chat ...` means Telegram works (anything else says what is wrong).
- `BTC rotation ... (history loads in the background)`: the first load takes a few minutes, then it is cached.
- `Binance Alpha ignition: ... scan every 5 min`.

Keep the terminal open while you use the app. Press `Ctrl + C` to stop it.

> **Want to look around first?** Put `DEMO=1` in `.env` to see the pages with simulated data (no Telegram messages; the Alpha tab needs live data). Remove the line to go live.

---

## 3. Set up Telegram alerts

1. **Create a bot.** In Telegram, open **@BotFather**, send `/newbot` and follow the steps. Copy the token it gives you (looks like `123456789:AAH...`).
2. **Start your bot.** Open the new bot in Telegram and press **Start** (a bot cannot message you before this).
3. **Find your chat id.** Send any message to your bot, then open this address in your browser (put your token in it):
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   Find `"chat":{"id":123456789` in the text. That number is your chat id. (For a group: add the bot to the group; the id starts with `-100`.)
4. **Save both** in `.env`:
   ```ini
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   TELEGRAM_CHAT_ID=123456789
   ```
5. **Restart** the app (`Ctrl + C`, then `node server.js`).
6. **Test it:** open http://localhost:3000/screener, press the **Telegram** tag at the top of the Ignition tab, and press **Send test message**. You also get a "Smart Money Tracker started" message each time the app starts.

### What is sent to Telegram

Switch each kind on or off in the **Telegram** section of the Ignition tab (press the **Telegram** tag). Your choice is saved and kept after a restart. The defaults:

| Message | Default | About how many |
|---|---|---|
| Ignition alerts (early and confirmed) | **On** | a few a day |
| Big-move ignition alerts (+40% before -10%) | **On** | a few a day (research tier, not a proven edge) |
| Binance Alpha confirmed alerts | **On** | about 8 a day |
| Early 2x high-priority candidates | **On** | a few a day |
| AI verdict on each new ignition and confirmed Alpha alert | **On** (needs Gemini) | one per alert |
| Startup message and daily check-in | **On** | one a day |
| AI desk results you choose to send | On request | tick "send to Telegram" on the AI desk |
| Binance Alpha early alerts | Off | about 50 a day, no proven edge |
| BTC rotation: regime or holdings changed | Off | a few a month |
| Whale transfers / DEX rotations | Off | many |
| Market Flow Radar "Strong flow" | Off | many |

`.env` can change a default (for example `EARLY2X_ALERTS=0` or `ALPHA_TELEGRAM=all`, see [All settings](#9-all-settings)); a switch you flip on the page wins over `.env`.

### How delivery works

- **Nothing is lost when Telegram or the network fails.** Every message goes through one queue. It is sent at Telegram's pace (about one a second), retried with growing waits when it fails (a Telegram rate limit waits exactly as long as Telegram asks), and kept in `telegram_state.json` so a restart does not lose it.
- **Late messages say so.** A message that goes out 2+ minutes late starts with "(delayed N min)". A message still not sent after 3 hours is dropped, because the alert is no longer useful; the delivery log shows it as "expired".
- **Silence never means broken.** The startup message, and a daily check-in at 08:00 UTC (`TELEGRAM_CHECKIN_HOUR`) with how many alerts went out in the last 24 hours, show the connection works on days when no coin meets the rules.
- **You can see every message.** The Telegram section shows the bot, the last message sent, anything waiting with the next try, the last error in plain words, and a delivery log (time, kind, message, status, tries, delay).

Ignition alerts are rare (often a few a day across all coins), so a quiet phone is normal: the daily check-in tells you whether alerts fired. Not receiving anything? See [Troubleshooting](#10-troubleshooting).

---

## 4. Set up the AI (Gemini)

1. Get a free API key at **https://aistudio.google.com/apikey**.
2. Add it to `.env`: `GEMINI_API_KEY=your_key`
3. Restart the app.

Now the AI desk works, the Market Flow Radar's **✨ AI Analysis** button works, and every new ignition alert gets an automatic AI verdict. To control cost: `AI_REVIEWS_PER_HOUR=12` (the default) caps automatic reviews; `AI_AUTO_REVIEW=0` turns them off.

---

## 5. A simple daily routine

| When | Where | What to look at |
|---|---|---|
| Once a day | **BTC rotation** | Is BTC in a downtrend (the rules hold cash)? Is the alt season meter "Alts leading" or "BTC leading"? This tells you whether hunting altcoins makes sense today. |
| When an alert arrives | **Ignition** → **AI desk** | Read the alert and the AI's TAKE / WAIT / NO TRADE. Check the chart yourself. Never chase coins marked "Already moved". If you trade it, press **"I took it"** and enter your real fill. |
| A few times a day | **Market Flow Radar** | Which coins have aggressive buyers right now, and is the whole market buying or selling? |
| For research | **Alpha**, **Early 2x**, **Whales** | Early on-chain tokens, possible 2x candidates, and where big money is moving. |
| Once a week | Performance panels + **Journal** | How the alerts really did (hit target, stopped, after costs), which exit and which conditions paid, whether the AI helped, and how your own trades compare. Trust live results over replays. |

---

## 6. The tools, one by one

### 6.1 Market Flow Radar

**Open:** http://localhost:3000

The main leaderboard ranks Binance spot coins by buying pressure right now.

- **Flow score (0-100):** 75+ means strong, aggressive buying; low scores mean selling pressure.
- **5m taker flow:** the share of market buys vs market sells in the last 5 minutes.
- **Relative volume:** volume now vs normal ("2.0x" = double).
- **Click a coin** (for example `SUI ↗`) to see its live order book: bids (buyers waiting) and asks (sellers waiting).
- **Filters** at the top: minimum score, minimum 24h volume, sort order, rows shown.
- **Web3 signals tab:** recent smart-money wallet activity (buying or selling) from Binance Web3.
- **✨ AI Analysis:** Gemini reads the top coins and wallet signals and writes a short market brief. Tick **risk review** for a second model to look for traps and fake-outs.

### 6.2 Ignition (the main screener)

**Open:** http://localhost:3000/screener

Watches every liquid Binance USDT pair and alerts when volume ignites before price runs.

| Tier | Rule (short) | Use it as |
|---|---|---|
| **Early ignition** | The last two finished 5-minute candles each trade 3x+ the coin's normal volume for that hour, price rises, mostly aggressive buying, and the quality checks pass | A heads-up |
| **Confirmed ignition** | The same, plus an ignition score of 65+ (volume that keeps running). Usually a few minutes later | The tier worth trading |
| **Big-move** (research) | A 5m ignition on a smaller coin ($1M-$10M daily volume) whose daily volume is already 1.5x its 20-day average. Target +40% before -10% within 7 days | A watchlist, not a proven edge |

**Quality checks** (all must pass): daily RSI 65 or lower, not an exhausted spike, not the top tick of the 2-hour range, rising 4-hour trend, BTC not falling over 1 and 4 hours, tight spread, no market-wide surge. Stablecoins, tokenized stocks and gold, wrapped tokens and coins on Binance's Monitoring list never alert. Coins that already ran are marked **Already moved — do not chase**.

**Every alert is tracked as a trade:** take profit at +6%, stop at -3%, otherwise sell after 12 hours (big-move: +40% / -10% / 7 days), judged on 1-minute candles after 0.2% fees and 0.1% slippage. The **performance panel** shows the results per tier and per AI verdict.

### 6.3 Alpha (Binance Wallet tokens)

**Open:** http://localhost:3000/screener#alpha

Binance Alpha tokens are the early on-chain tokens in Binance Wallet (for example EVAA). They are not spot pairs, so the Ignition tab cannot see them. This tab scans about 250 of them every 5 minutes (still trading, not on spot, $50k+ pool liquidity, 1,000+ holders).

| State | Meaning |
|---|---|
| **Early ignition** | Two finished 5-minute candles in a row, each at 5x the token's normal volume, $1,000+ and 10+ trades, price up (not more than 20%), not already up 30% in 24 hours |
| **Confirmed** | The same, with $1M+ traded in the last 24 hours |
| **Heating up** | Volume rising, not confirmed yet |
| **Already moved** | Up 30%+ in 24 hours: do not chase |

Each row shows volume vs normal, price change, DEX buyers vs sellers (from DexScreener, because Binance's Alpha data has no buy/sell side), liquidity, holders, market cap and links. Every alert is tracked: +40% before -10% within 7 days, after 1% costs.

> Alpha pools are thin (often a few hundred thousand dollars), so a market order moves the price, and tokens can be delisted. The AI desk does not analyse Alpha tokens.

### 6.4 Early 2x movers

**Open:** http://localhost:3000/screener#early2x

Looks for low- and mid-cap Binance coins (verified market cap $10M-$1B, $1M+ daily volume, tight spread) that show measurable signs of a possible large move **before** price expands. +100% is a research target, not a prediction; an empty list is a valid answer.

- **Model A, quiet accumulation:** volume 2x+ its 7-day baseline for hours while price stays in a tight band. *Pre-breakout* = the same while pressing a tested 7-day high.
- **Model B, early ignition:** 3+ five-minute candles in a row at 2x+ normal volume, accelerating, with 55%+ aggressive buying.
- **Score out of 100**, every point explained in the coin's detail view. High priority needs evidence from 3+ independent families (volume, buying, structure, order book, strength vs BTC) and passing supply and liquidity checks.
- **Token unlocks and catalysts** come only from `data/early2x-events.json`, which you keep (only entries with an https source count).
- **Tracking:** every listed coin is saved as a snapshot and measured at 1h, 6h, 12h, 24h, 3d, 7d, 14d, 21d and 42d (did it reach +25%, +50%, +100%, and how far did it fall first). Nothing is called profitable until 30+ signals have played out for 14 days and the result is positive in both halves.

### 6.5 Whale tracker and DEX flows

**Open:** http://localhost:3000/screener#whales (no API key needed). Use the tags at the top to jump to a part.

**Whale transfers (Ethereum)**

- **Live whale transfers:** every Ethereum transfer above $100k, read from the blockchain, with who sent it and who received it.
- **Who is who.** Four sources:
  - about 10,000 public labels (exchanges, funds, issuers, bridges, MEV bots, mixers);
  - Blockscout names for newer contracts (Uniswap pools and routers, lending markets, vaults, bridges), Safe multisigs, smart wallets and ENS names;
  - exchange addresses the tracker **learns by itself**;
  - your own labels.
- **Learned exchange addresses.** An unlabelled address that hands its tokens to one exchange's wallet is that exchange's deposit address (the way Arkham finds them). It shows as "Binance address (learned)". Later deposits into it count as exchange deposits at once, before the exchange collects them. Learned addresses are kept in `whales_names.json`, so the tracker gets better the longer it runs.
- **Transfer types:**
  - exchange deposit (often before selling) or withdrawal;
  - exchange to exchange, or an internal exchange move;
  - mint / burn, bridge, DeFi, DEX;
  - wallet ↔ contract (into or out of an unnamed contract);
  - wallet to wallet.

  DeFi plumbing (contract to contract) is hidden by default and never alerts.
- **Exchange flows:** how much of each token moved onto and off exchanges, per token and per exchange.
- **Most active entities and wallets.** Click any address for its profile, with links to Arkham, Etherscan and DeBank.
- **Watchlist:** paste a wallet (give it your own label) or a token, and get an alert on every move above your minimum.

**DEX flows: which token went where**

- **Where the money went:** a map of money swapped from one token (left) into another (right). Green bands are buying a token, red bands are selling a token for ETH / SOL / BNB / stablecoins, purple bands are token into token. Hover a band for the swaps and wallets behind it.
- **Tokens bought and sold:** per token, how much was bought and sold, by how many wallets, what it was bought with and sold for, and the biggest buy. Click a token to filter everything to it.
- **Top rotations, wallet rotations, live swaps** (with the DEX or router used), and **pair watches** (e.g. ETH-PEPE) that alert on every swap above your size.
- **Coverage:**
  - Ethereum: **every DEX and aggregator**, rebuilt from the blocks the whale tracker already reads (any token with $50k+ of DEX liquidity).
  - Base, Solana and BNB Chain: the most active pools from GeckoTerminal's free API. Pools are picked by the number of different wallets trading, so pools with fake volume and tokenized stocks are skipped.
  - For 6 hours after a Binance Alpha alert: that token's own pools, so you can see who is buying it.
- **Bots are left out:** wallets that trade in and out within minutes or 40+ times an hour. Token ↔ token loops that go both ways (typical of wash trading) are faded or left off the map.

Data: public Ethereum nodes, DexScreener prices, Blockscout names, GeckoTerminal for other networks, and an open Etherscan label snapshot (June 2023). It shows what wallets did, not why. Not financial advice.

### 6.6 BTC rotation

**Open:** http://localhost:3000/screener#rotation

Every day BTC's daily chart is put into one of six **regimes**: breaking out, calm uptrend, uptrend, sideways, downtrend, falling hard. Each **narrative** (AI, Meme, RWA, Gaming… from Binance's sector tags) is ranked by how it did against BTC in past weeks with the same regime, its 14-day strength now, and how many of its coins are above their 20-day average.

| Panel | What it tells you |
|---|---|
| **This week** | What the rule holds (top 2 narratives, or cash in a BTC downtrend), the coins, the next decision date and the last change |
| **Alt season meter** | Is money moving from BTC into altcoins? Three votes: ETH/BTC trend, the typical narrative vs BTC, coins above their 20-day average. Result: Alts leading / Mixed / BTC leading |
| **How BTC regimes behave** | How long each regime usually lasts and what usually comes next |
| **Narrative ranking** | Score, history in this regime, money flow (share of altcoin volume) and stage (early, running, late, cooling, quiet) |
| **Forward record** | Every week's real picks, saved with that day's prices and judged a week later. Cannot be fitted to the past |
| **Backtest** | The same rules replayed week by week with fees, on the older and the newer half of the history |

The first load downloads daily candles for every narrative coin (a few minutes); after that it refreshes once a day.

### 6.7 AI trade desk

**Open:** http://localhost:3000/ai (needs `GEMINI_API_KEY`)

Lists the coins the screener flags as igniting or heating up.

- **Analyze:** Gemini gets everything that matters about the coin (the signal, 15m / 1h / 4h charts, support and resistance, order book, futures positioning, Market Flow Radar numbers, whale and DEX flows, BTC, and how often this kind of alert won before) and answers **TAKE, WAIT or NO TRADE** with entry, stop, targets, reward:risk and the reasons for and against.
- **Analyze all:** ranks every igniting coin in one request. **Data only** shows the facts for free, without calling Gemini. **Risk review** adds a second model to double-check.
- **Automatic review:** every new ignition alert, and every confirmed Alpha alert, gets one AI verdict saved with the alert (verdicts also go to Telegram), so after a few weeks the performance panels show whether the AI's calls really do better.
- **Alpha tokens:** press **Ask AI** on any row of the Alpha tab. The AI gets Alpha's own 1h / 4h candles, DexScreener buyers vs sellers, pool liquidity, holders and supply, with Alpha's own rule (+40% / -10% / 7 days, 1% costs) and its replay and live results. Extra hard stops: DEX sellers in control, pool under $50k.
- **It learns from your live data:** the AI is shown how past alerts with the same conditions did (BTC trend, alt season, time of day, buyers…; groups with 10+ resolved alerts), so a condition that keeps losing lowers its chances.

**How the AI decides:** no trade is the default.
1. **Hard stops** (any one means no trade): the coin already ran, BTC down more than 1% in 1 hour or 2% in 4 hours, aggressive selling now, a wide spread or a thin order book.
2. **Checklist:** trigger, buying, trend, room to resistance, liquidity, futures and whales, market breadth, past results.
3. **Chances** of hitting the target and the stop, starting from the real base rates and moved by at most 15 points.
4. **Expected value** after costs. The code recomputes it: TAKE needs +0.5% or more per trade and reward:risk of 1.5+.

Long only, no leverage, risk at most 1% of your account per trade.

### 6.8 Learning from your live results

Replays are a starting point; your live alerts are the real test. Every alert since this update saves extra data so the app can show what works for **you**. Find it in the Ignition tab's **Alert performance** panel and the Alpha tab's **Live results in detail** panel.

| Table | What it shows | How to use it |
|---|---|---|
| **Exit rules compared** | Every alert is also followed under alternative exits on the same candles: a smaller and a bigger target, a break-even stop, two trailing stops, and quick time exits (Ignition: 1h and 4h; Alpha and big-move: 24h and 3 days) | Switch exit only when one has 30+ alerts and beats the alert's own rule in **both** the older and the newer half |
| **What separates winners from losers** | Results split by the conditions saved at alert time: BTC trend and regime, alt season meter, Market Flow buyers, time of day (Asia / Europe / US), alert delay, the AI's verdict, and for Alpha also liquidity, holders, token age and DEX buyers | A condition counts only when the last column says **Better in both** (or **Worse in both**) and it has 20+ alerts |
| **Alert speed** | How many seconds after the 5-minute candle closed the alert fired, and where price was 1, 2 and 5 minutes later (Alpha: 5 and 15 minutes) | If price usually runs away before you can act, speed is costing you money |
| **Is the AI helping?** | Results by AI verdict (TAKE / WAIT / NO TRADE), and whether its stated chance matches reality (when it says 30%, does it hit about 30%?) | If TAKE does not beat NO TRADE after 30+ alerts each, use the AI only as a trap detector (its hard stops) |

Alerts are also faster now: the Ignition screener runs an extra scan 4 seconds after every 5-minute candle closes, and the Alpha scan starts 5 seconds after the close with the hottest tokens first (it used to wait 25 seconds).

### 6.9 Trade journal

**Open:** http://localhost:3000/screener#journal

1. Press **"I took it"** on an alert (Ignition alert history, or the Alpha alerts table). The journal opens with the coin, the alert price, the stop and the target filled in.
2. Change the entry to **your real fill price**, add your size in $ (and fees if you like), and save.
3. While it is open, the journal shows the live price and your unrealized result.
4. When you sell, type your exit price and press **Close**.

The top of the page shows your closed trades, win rate, total profit or loss in $, average per trade, R multiple (when you set a stop), and **you vs the alerts**: your average result next to the same alerts' tracked results, plus how much above the alert price you usually buy. You can also add trades by hand. Saved in `journal.json` on your PC; nothing is sent to an exchange.

---

## 7. What the tests say

Every tool was replayed on past Binance data with costs included. Short version: **some tiers are slightly better than buying at random, none is a proven money machine.** Use the live performance panels as the real test.

| Tool | Test | Result |
|---|---|---|
| **Ignition, confirmed** | 60 days, 47 coins, +6% / -3% / 12h, after costs | Hit target 30%, hit stop 21%, **+0.93% per trade** on average |
| **Ignition, early** | same | Hit target 25%, **+0.55% per trade** |
| **Big-move tier** | 90 days, every Binance USDT pair, +40% / -10% / 7 days | About 1 in 10 reached +40%. **+2.5% per trade** in the Aug-Sep alt rally, **-1.8%** in October |
| **Alpha, confirmed** | 60 days, every Alpha token not on spot (delisted ones included where Binance still has data) | Hit +40% first 16.7%, **+0.6% per trade** (random entry on the same tokens: 13.8%, -1.2%). The $1M rule was picked after seeing the data, so this may be flattered |
| **Alpha, early** | same | Hit +40% first 11.2%, **-1.2% per trade**, about 50 alerts a day: no better than a random entry |
| **BTC rotation** | Oct 2024 to Oct 2026, 107 weekly decisions | Rotation ranking **+28%** (same as holding BTC, +28%); token picks +136%, but almost all of it from one meme-pump week (-9% without it) |

Two real examples:
- **EVAA (Alpha):** the early tier caught its Oct 26-27 start (+40% the next day), but it had flagged EVAA 34 times in 60 days: 6 winners, 23 stopped out. The confirmed tier missed that start.
- **BTC rotation:** the variant "hold BTC while BTC leads the alts" did slightly better in both halves of the history (+37% vs +28%), but the gain is too small to trust, so it is shown next to the rule and not used.

Past results do not guarantee future results.

---

## 8. Backtests and replays

Run these in a second terminal (the app can keep running). Each one caches its downloads, so the second run is fast.

| Command | What it tests | First run |
|---|---|---|
| `node screener-backtest.js` | Ignition tiers (early, confirmed) on 5-minute candles | a few minutes |
| `node bigmove-backtest.js` | Big-move tier (+40% before -10%) on every Binance USDT pair, month by month | 30-60 minutes |
| `node alpha-backtest.js` | Alpha tiers on every Alpha token, vs random entries; fills the Alpha tab's **Replay** panel | 20-40 minutes |
| `node rotation-backtest.js` | BTC rotation strategies and variants, older vs newer half | 5-15 minutes |

Useful options: `--days 45`, `--end 2026-10-28T08` (repeat an earlier window), `--cost 2` (alpha). Re-run them every month: a rule that only worked in one kind of market shows up as one good month and one bad one.

---

## 9. All settings

All settings go in `.env` and are optional. Restart the app after a change.

<details>
<summary><b>General</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Web address port |
| `DEMO` | off | `1` = simulated data, for a preview |
| `BINANCE_SPOT_URL` | `https://api.binance.com` | Use `https://data-api.binance.vision` if Binance is blocked in your region |
| `POLL_SECONDS` | `30` | Market Flow Radar refresh |
| `MAX_SYMBOLS` | `40` | Coins on the Market Flow Radar |
| `MIN_QUOTE_VOLUME` | `1000000` | Minimum 24h volume on the Market Flow Radar |
</details>

<details>
<summary><b>Telegram and AI</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | See [Set up Telegram](#3-set-up-telegram-alerts) |
| `GEMINI_API_KEY` | — | See [Set up the AI](#4-set-up-the-ai-gemini) |
| `GEMINI_ANALYST_MODEL` | `gemini-3.5-flash` | Model for analyses |
| `GEMINI_REVIEW_MODEL` | `gemini-3.1-pro-preview` | Model for the risk review |
| `AI_AUTO_REVIEW` | on | `0` = no automatic verdict on new alerts |
| `AI_REVIEWS_PER_HOUR` | `12` | Cost cap for automatic verdicts |
| `AI_REVIEW_TELEGRAM` | on | `0` = AI verdicts off on Telegram by default |
| `AI_MIN_EV_PCT` | `0.5` | Minimum expected value per trade for TAKE |
| `RADAR_TELEGRAM` | off | `1` = Market Flow Radar "Strong flow" messages on by default |
| `SCREENER_TELEGRAM` | on | `0` = ignition alerts off on Telegram by default |
| `TELEGRAM_CHECKIN` | on | `0` = no startup message or daily check-in by default |
| `TELEGRAM_CHECKIN_HOUR` | `8` | Hour (UTC) of the daily check-in |

The `..._TELEGRAM` and `..._ALERTS` settings only set the defaults: the switches in the screener's Telegram section win.
</details>

<details>
<summary><b>Ignition screener</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `SCREENER_TARGET_PCT` / `SCREENER_STOP_PCT` / `SCREENER_OUTCOME_HOURS` | `6` / `3` / `12` | How alerts are tracked |
| `SCREENER_EARLY_RVOL` | `3` | Volume multiple for an early ignition |
| `SCREENER_IGNITE_MIN_SCORE` | `65` | Score for a confirmed ignition |
| `SCREENER_MAX_DAILY_RSI` | `65` | Skip coins above this daily RSI |
| `SCREENER_EARLY_ALERTS` | on | `0` = only confirmed alerts |
| `SCREENER_SETUP_ALERTS` | off | `1` = alerts for daily setups (watchlist) |
| `SCREENER_REGIME_GATE` | off | `1` = hold ignition alerts while BTC is in a daily downtrend |
| `SCREENER_MIN_QUOTE_VOLUME` | `5000000` | Minimum 24h volume |
| `SCREENER_FEE_PCT` / `SCREENER_SLIPPAGE_PCT` | `0.2` / `0.1` | Costs used in the results |
| `SCREENER_BIGMOVE` | on | `0` = no big-move tier |
| `SCREENER_BIGMOVE_ALERTS` | on | `0` = big-move alerts off on Telegram by default |
| `SCREENER_BIGMOVE_TARGET_PCT` / `_STOP_PCT` / `_OUTCOME_HOURS` | `40` / `10` / `168` | Big-move tracking |
| `SCREENER_BIGMOVE_MIN_VOLUME` / `_MAX_VOLUME` | `1000000` / `10000000` | Daily volume range for big-move coins |
</details>

<details>
<summary><b>Alpha (Binance Wallet tokens)</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `ALPHA` | on | `0` = turn the Alpha tab off |
| `ALPHA_TELEGRAM` | on (confirmed) | `0` = off, `all` = early alerts too |
| `ALPHA_VOL_MULT` | `5` | Volume multiple vs normal |
| `ALPHA_MIN_5M_USD` / `ALPHA_MIN_TRADES` | `1000` / `10` | Minimum per 5-minute candle |
| `ALPHA_MIN_24H_USD` | `1000000` | 24h volume for the confirmed tier |
| `ALPHA_MIN_LIQUIDITY` / `ALPHA_MIN_HOLDERS` | `50000` / `1000` | Which tokens are scanned |
| `ALPHA_TARGET_PCT` / `ALPHA_STOP_PCT` / `ALPHA_OUTCOME_DAYS` | `40` / `10` / `7` | How alerts are tracked |
| `ALPHA_COST_PCT` | `1` | Costs per trade (fees + slippage) |
| `ALPHA_AI_REVIEW` | on (confirmed) | Automatic AI verdict on confirmed Alpha alerts; `all` = early ones too, `0` = none (shares `AI_REVIEWS_PER_HOUR`) |
</details>

<details>
<summary><b>Early 2x</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `EARLY2X` | on | `0` = turn the screen off |
| `EARLY2X_ALERTS` | on | `0` = no Telegram for new high-priority candidates by default |
| `EARLY2X_MCAP_MIN` / `_PREFERRED_MAX` / `_MAX` | `10000000` / `500000000` / `1000000000` | Market cap range |
| `EARLY2X_MIN_QUOTE_VOLUME` | `1000000` | Minimum 24h volume |
| `EARLY2X_MAX_SPREAD_PCT` | `0.3` | Maximum spread |
| `EARLY2X_MIN_CONFIRMATIONS` / `EARLY2X_HIGH_MIN_SCORE` | `3` / `50` | High priority needs |
| `EARLY2X_SCAN_MINUTES` | `5` | Scan interval |
| `COINGECKO_API_KEY` | — | Free CoinGecko demo key (faster supply data) |

Every other threshold is listed at the top of `early2x.js`.
</details>

<details>
<summary><b>Whales and DEX rotations</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `SCREENER_WHALES` | on | `0` = turn the whale tracker and DEX rotations off |
| `WHALES_MIN_USD` | `100000` | Smallest transfer shown |
| `WHALES_ALERT_USD` / `WHALES_STABLE_ALERT_USD` | `1000000` / `25000000` | Alert sizes (stablecoins separately) |
| `WHALES_EXCHANGE_ALERT_USD` / `WHALES_MINT_ALERT_USD` | `500000` / `10000000` | Exchange flow and mint / burn alerts |
| `WHALES_TELEGRAM` / `FLOWS_TELEGRAM` | off | `1` = send these alerts to Telegram by default |
| `WHALES_TELEGRAM_PER_HOUR` | `30` | Telegram cap |
| `WHALES_RPC` | 6 free public nodes | Your own Ethereum node URL(s), comma-separated, best first (a free Alchemy or Infura key is steadier; see Troubleshooting) |
| `WHALES_BLOCKSCOUT` | `https://eth.blockscout.com` | Where unknown addresses are named |
| `FLOWS_NETWORKS` | `eth,base,solana,bsc` | DEX networks (Ethereum comes from the blocks, the others from GeckoTerminal) |
| `FLOWS_MIN_TRADE_USD` | `2000` | Smallest DEX swap recorded |
| `WHALES_SWAP_MIN_LIQUIDITY_USD` | `50000` | DEX liquidity a token needs for its Ethereum swaps to count |
| `FLOWS_POOLS_PER_NETWORK` / `FLOWS_MIN_TRADERS_1H` | `6` / `20` | Pools followed per GeckoTerminal network, and the wallets trading in the last hour a pool needs |
| `FLOWS_FOLLOW_HOURS` | `6` | How long the pools of a token with a new Alpha alert are followed |
</details>

<details>
<summary><b>BTC rotation</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `ROTATION_TELEGRAM` | off | `1` = message when the regime or the holdings change, by default |
| `ROTATION_HOLD_DAYS` | `7` | Days between decisions |
| `ROTATION_DAYS` | `1000` | Days of history |
| `ROTATION_NARRATIVES` | all | For example `AI,Meme` to rank only these |
</details>

---

## 10. Troubleshooting

<details>
<summary><b>"Port 3000 is already in use"</b></summary>

Another copy of the app is still running. Close that terminal window, or set `PORT=3005` in `.env` and open http://localhost:3005.
</details>

<details>
<summary><b>Whale tracker: Ethereum nodes failing</b></summary>

The Whales tab reads Ethereum from free public nodes. Open **Whales › Data health**: the table shows each node, what it served, its status and why it last failed.

- **Some errors are normal.** Free nodes rate-limit ("429", "rate limit exceeded", "compute units") or refuse some requests. The tracker switches to another node at once and tries the failing one again later, waiting longer each time (30 seconds up to 30 minutes). Nothing is lost.
- **"Not used for block-wide log queries"** means that node refuses the big query the tracker needs (publicnode does). The tracker uses it only for other requests, so it does not count as failing.
- **A node that always fails** on your connection (blocked by your provider, firewall or country) just stays resting. The others carry on.
- **For a steady feed, add your own free node.** Create a free account at Alchemy (alchemy.com) or Infura (infura.io), make an Ethereum Mainnet app or key, and copy its HTTPS URL. Put it first in `.env` and keep the free ones after it as backups:
  ```ini
  WHALES_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY,https://eth-mainnet.public.blastapi.io,https://rpc.mevblocker.io,https://eth.drpc.org
  ```
  Restart the app. Your key is never shown on the page or in the terminal. If the key's free monthly allowance runs out, the free nodes take over.
</details>

<details>
<summary><b>No Telegram messages</b></summary>

1. Look at the `Telegram:` line when the app starts. "bot @yourbot, sending to chat …" means the token is right; "PROBLEM: …" says what is wrong. It also lists which kinds are on.
2. Open the screener, press the **Telegram** tag and press **Send test message**. The red "Not working" line explains any failure in plain words, and the delivery log shows every message.
3. Common fixes:
   - **Wrong token:** copy it again from @BotFather.
   - **"chat not found":** open your bot and press **Start**, and check `TELEGRAM_CHAT_ID` (a group id starts with `-100` and the bot must be in the group).
   - **Blocked bot:** open it and press **Start** / **Unblock**.
   - **Cannot reach api.telegram.org:** check the internet connection, firewall, VPN or proxy.
4. Restart the app after every change to `.env`. Messages that failed are still waiting and go out once it works (up to 3 hours old).
5. Check the switches: a kind that is off sends nothing. If the test message arrives but alerts do not, no coin met the rules: the daily check-in says how many alerts fired, and the Ignition, Alpha and Early 2x tabs show every alert on screen.
6. AI verdicts need `GEMINI_API_KEY`. The app must keep running: a closed terminal or a sleeping computer sends nothing.
</details>

<details>
<summary><b>Binance errors (403 / 451, "blocked in this region")</b></summary>

Add `BINANCE_SPOT_URL=https://data-api.binance.vision` to `.env` and restart. Futures data (shown as context only) may still be unavailable.
</details>

<details>
<summary><b>A page says "Loading history…" for a long time</b></summary>

The BTC rotation downloads daily candles for every narrative coin on the first start (a few minutes) and Early 2x waits for CoinGecko supply data. Later starts use the cache.
</details>

<details>
<summary><b>The AI desk says the key is missing</b></summary>

Check that `.env` is in the project folder (next to `server.js`), that the line is `GEMINI_API_KEY=...` with no spaces or quotes, and restart.
</details>

---

## 11. Updating to a new version

New versions are pushed to a work branch first. To bring them into your `main` branch and your PC:

```bash
git fetch origin
git checkout main
git merge --ff-only origin/claude/trusting-gauss-i4wkla
git push origin main
npm install
```

Then restart the app. Your settings (`.env`), alert history and caches are not in git, so an update never touches them.

If git says *"Your local changes to the following files would be overwritten"*, those are usually files the app writes while it runs. They are ignored by git now; move or delete the files git lists and run the merge again.

---

## 12. For developers

**Tests** (no internet or API key needed):

```bash
npm test
```

They cover the signal rules, outcome tracking, AI safety rules, the big-move tier, Early 2x scoring and tracking, BTC rotation, Binance Alpha, the alternative exit rules and the trade journal.

**Run the screener alone:** `node screener.js` (port 3001).

**Project files:**

| File | What it is |
|---|---|
| `server.js` | Starts everything; Market Flow Radar and the web pages |
| `screener.js` | Ignition screener, big-move tier, BTC rotation wiring, shared helpers |
| `alpha.js` | Binance Alpha ignition |
| `exits.js` | Alternative exit rules, alert speed, condition groups and AI checks on live alerts |
| `journal.js` | Your trade journal ("I took it") |
| `early2x.js` | Early 2x movers |
| `whales.js`, `flows.js` | Whale tracker (transfers, names, learned exchange addresses, Ethereum DEX swaps) and DEX flows |
| `rotation.js` | BTC regimes, narratives, alt season meter, forward record |
| `ai-trade.js`, `agent.js` | AI desk and the AI market brief (Gemini) |
| `telegram.js` | Telegram delivery queue (retries, switches, daily check-in) and diagnostics |
| `public/` | The web pages (`index.html`, `screener.html`, `ai.html`) |
| `*-backtest.js` | Replay tests (see [Backtests](#8-backtests-and-replays)) |
| `data/` | Wallet labels and your token unlock / catalyst list |

Files the app writes while running (`*_state.json`, `*_cache/`, `*_report.json`, `rotation_record.json`, `journal.json`, `whales_names.json`) are kept out of git.

---

## Disclaimer

The scores, alerts and AI analyses are tools for research, not financial advice. A high score means buyers are aggressive right now; it does not mean the price will keep rising. Always check the chart, size your position so a loss is small, and decide for yourself. This app never places trades.

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
4. [Set up the AI (Gemini, or a free open-source model)](#4-set-up-the-ai-gemini-or-a-free-open-source-model)
5. [A simple daily routine](#5-a-simple-daily-routine)
6. [The tools, one by one](#6-the-tools-one-by-one)
   - [Learning from your live results](#68-learning-from-your-live-results)
   - [Trade journal](#69-trade-journal)
   - [Perps swing signals (futures)](#610-perps-swing-signals-futures)
   - [Perps scalp signals (5 minutes to 1 hour)](#611-perps-scalp-signals-5-minutes-to-1-hour)
   - [Spot plan (BTC + ETH, and every coin)](#612-spot-plan-btc--eth-and-every-coin)
   - [News (bullish or bearish)](#613-news-bullish-or-bearish)
   - [On-chain: crowd vs smart money (Whales tab)](#614-on-chain-crowd-vs-smart-money-whales-tab)
   - [Whale signals: TAKE / LEAVE from whale wallets](#615-whale-signals-take--leave-from-whale-wallets)
   - [Liquidity: order-book heatmap and 5-exchange screener](#616-liquidity-order-book-heatmap-and-5-exchange-screener)
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
| **Ignition** | http://localhost:3000/screener | Alerts when a coin's volume ignites on 5-minute candles **before** price runs (early, confirmed and big-move tiers), plus the **Spot plan** (the best spot strategy in a 6-year test: BTC + ETH only above their 50-day average, and the same check on every liquid coin) and the daily **Pump watch** list of coins that could pump hard |
| **News** | http://localhost:3000/screener#news | The most important crypto market news of the last 48 hours, each marked **bullish, bearish or neutral** for the market, and the overall news mood of the last 24 hours (Google News, Binance announcements, CoinDesk with a free key) |
| **Alpha** | http://localhost:3000/screener#alpha | The same ignition idea for **Binance Alpha / Binance Wallet** tokens (like EVAA), which are not spot pairs |
| **Early 2x** | http://localhost:3000/screener#early2x | Low- and mid-cap coins ($10M-$1B) showing early signs of a large move; every pick is tracked for 42 days |
| **Perps** | http://localhost:3000/screener#perps | Swing trades on Binance USDⓈ-M perpetuals, long and short: the setups that held up in a 4.8-year backtest, found live after each 4h close, each with **TAKE / WAIT / SKIP**, a size and liquidation check for your account, and its tracked result. Check your own trade ideas the same way. Its **Scalp** section: 5-minute flush-bounce trades (5 minutes to 1 hour), the only one of seven tested scalp setups that made money after fees |
| **Whales** | http://localhost:3000/screener#whales | **Whale signals:** TAKE LONG / TAKE SHORT / LEAVE from the positions of Hyperliquid's biggest profitable wallets, Ethereum exchange flows, DEX flows and Binance's crowd vs top traders (the former On-chain tab, now the "Crowd vs smart money" tag here). Below: the Arkham-style whale tracker: big Ethereum transfers with names and learned exchange addresses, exchange inflows and outflows, where DEX money went (every Ethereum DEX, plus Base, Solana, BNB Chain), your own watchlist |
| **Liquidity** | http://localhost:3000/screener#liquidity | Where the buy and sell orders sit: a live **order-book heatmap** for one Binance pair, and a **5-exchange screener** (Binance, Bybit, OKX, Coinbase, Kraken) with a 0-100 hotness score and signal checks. Ported from the open-source crypto-liquidity-terminal (MIT) |
| **BTC rotation** | http://localhost:3000/screener#rotation | Which altcoin narratives (AI, Meme, RWA…) to hold for the current Bitcoin regime, alt season meter, weekly picks |
| **AI desk** | http://localhost:3000/ai | An AI committee (data analyst, news researcher, bull vs bear debate, trader, Final Boss) answers **YES / WATCH / NO** with entry, stop, targets, expected value and position size |
| **Journal** | http://localhost:3000/screener#journal | Your own trades: press **"I took it"** on an alert, enter your real fill, and compare your results with the alerts' |

**System status bar:** under the title of the screener page, one dot for each part of the app: the Spot scanner, Perps swing signals, the Scalp scanner, Whale signals, the paper bot, the Spot plan, Pump watch, News, the AI (Gemini) and Telegram. **Green** = working, **amber** = a warning (or still starting), **red** = not working, **grey** = switched off. Click it to see each part's last update and its exact error in plain words (for example "the Gemini key is not valid: create one at aistudio.google.com/apikey..."). When a part has been red for 30 minutes, Telegram sends one warning, and one "OK again" message when it recovers (switch "Warnings" in Ignition › Telegram). At start the app sends Gemini one tiny test request, so a wrong key or model name shows at once.

**Section tags:** every page has a row of tags under its title (for example *Live watch · Pump watch · Big-move · Alert history · Performance* on Ignition). Click a tag to show only that part of the page; **All** shows everything. The bar stays at the top while you scroll, and each page remembers your choice.

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

Download and install **Node.js 22 or newer** from https://nodejs.org (choose "LTS").
Check it in a terminal (Command Prompt / PowerShell on Windows, Terminal on Mac):

```bash
node -v
```

You should see `v22.6` or higher (the app is a Next.js + TypeScript app since Nov 2026; the classic pages, `npm run start:classic`, still run on Node 18).

### Step 2: Download the project

```bash
git clone https://github.com/Hamzakhan8/crypto-smart-money-tracker.git
cd crypto-smart-money-tracker
```

No git? On GitHub click **Code → Download ZIP**, unzip it, and open a terminal in that folder.

### Step 3: Install and build

```bash
npm install
```

```bash
npm run build
```

The build makes the web pages (React + TypeScript, Next.js). It takes about a minute; run it again after every update.

### Step 4: Add your settings (optional)

Copy the example settings file:

| Windows | Mac / Linux |
|---|---|
| `copy .env.example .env` | `cp .env.example .env` |

Open `.env` in any text editor. Everything is optional; the app works without it. The most useful lines:

```ini
GEMINI_API_KEY=your_key_here        # for the AI (step 4 below), or instead a free open-source model:
# AI_PROVIDER=ollama                # Ollama on this PC (ollama.com), or GROQ_API_KEY=... (free key, open models)
ETHERSCAN_API_KEY=your_key_here     # optional: names whale contracts when Blockscout fails (free key at etherscan.io/myapikey)
COINDESK_API_KEY=your_key_here      # optional: CoinDesk news in the News tab (free key at developers.coindesk.com)
TELEGRAM_BOT_TOKEN=123456:ABC...    # for Telegram alerts (step 3 below)
TELEGRAM_CHAT_ID=123456789
```

### Step 5: Start

```bash
npm start
```

Then open **http://localhost:3000** in your browser. (`npm run dev` starts it with live reload while you change the code. `npm run start:classic` runs the classic HTML pages instead, without Next.js, as before.)

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
5. **Restart** the app (`Ctrl + C`, then `npm start`).
6. **Test it:** open http://localhost:3000/screener, press the **Telegram** tag at the top of the Ignition tab, and press **Send test message**. You also get a "Smart Money Tracker started" message each time the app starts.

### What is sent to Telegram

Switch each kind on or off in the **Telegram** section of the Ignition tab (press the **Telegram** tag). Your choice is saved and kept after a restart. The defaults:

| Message | Default | About how many |
|---|---|---|
| Ignition alerts (confirmed, and early ones with 3+ quality signs) that also pass the **quality gate** | **On** | about one every two days |
| Pump watch: the daily list (coins near the 90-day high on 2x+ volume) | **On** | one message a day, a few minutes after 00:00 UTC, only when there are new picks **and market mood is OK** (40%+ of coins up over 30 days) |
| Big-move ignition alerts (+40% before -10%) | Off (since Nov 2026) | about 30 a day; lost money live (0 of 14 won) and in the October replay |
| Binance Alpha confirmed alerts | Off (since Nov 2026) | about 8 a day; lost money live (2 of 15 won) |
| Early 2x high-priority candidates | **On** | a few a day |
| Perps swing signals (TAKE only: the A+ setups that passed the test) | **On** | a few a month, after 4h closes |
| Perps scalp signals (flush bounce, 5 minutes) | **On** | about 20 a month; act within minutes |
| On-chain: crowd vs smart money (long and short, 4h) | **On** | about 25 a month, after 4h closes |
| Spot plan: BTC or ETH switches (50-day trend) | **On** | about 3 a month, after the 00:00 UTC close |
| AI verdict on each new ignition and confirmed Alpha alert | **On** (needs Gemini) | one per alert |
| Startup message and daily check-in | **On** | one a day |
| AI desk results you choose to send | On request | tick "send to Telegram" on the AI desk |
| Binance Alpha early alerts | Off | about 50 a day, no proven edge |
| BTC rotation: regime or holdings changed | Off | a few a month |
| Whale signals: TAKE LONG / TAKE SHORT / LEAVE (new, not tested yet) | Off | a few a day; switch on in Ignition › Telegram, or `WHALESIG_TELEGRAM=1` |
| Whale transfers / DEX rotations | Off | many |
| Market Flow Radar "Strong flow" | Off | many |

`.env` can change a default (for example `EARLY2X_ALERTS=0` or `ALPHA_TELEGRAM=1`, see [All settings](#9-all-settings)); a switch you flip on the page wins over `.env`.

**Why big-move and Alpha alerts are off by default (Nov 2026):** in the first live days (Oct 30 to Nov 2), all 14 resolved big-move alerts hit the -10% stop (91 alerts in 3 days), and only 5 of 36 closed Alpha alerts won (confirmed -4.3%, early -3.9% per trade). A rerun of the big-move replay agreed: +2.7% per trade in August and September, -2.8% in October, and the market mood did not explain it (October lost money even while 70-90% of coins were up). Both still run and are tracked on the page, so you can see if they recover; switch their Telegram back on in the Telegram section if they do. Their automatic AI reviews only run while their Telegram is on, which keeps the AI budget for the alerts that matter.

### How delivery works

- **Nothing is lost when Telegram or the network fails.** Every message goes through one queue. It is sent at Telegram's pace (about one a second), retried with growing waits when it fails (a Telegram rate limit waits exactly as long as Telegram asks), and kept in `telegram_state.json` so a restart does not lose it.
- **Late messages say so.** A message that goes out 2+ minutes late starts with "(delayed N min)". A message still not sent after 3 hours is dropped, because the alert is no longer useful; the delivery log shows it as "expired".
- **Silence never means broken.** The startup message, and a daily check-in at 08:00 UTC (`TELEGRAM_CHECKIN_HOUR`) with how many alerts went out in the last 24 hours, show the connection works on days when no coin meets the rules.
- **You can see every message.** The Telegram section shows the bot, the last message sent, anything waiting with the next try, the last error in plain words, and a delivery log (time, kind, message, status, tries, delay).

Signals are rare by design. Ignition sends about one alert every two days (only alerts that pass the quality gate), and none at all while most coins are below their 20-day average (a falling market). Perps sends TAKE signals only (a few a month), and Pump watch only when the market mood is OK. A quiet phone is normal: the Telegram section lists every signal that was **held back** and why, and the daily check-in (08:00 UTC) says what was sent, what was held back and why Ignition is quiet. Not receiving anything? See [Troubleshooting](#10-troubleshooting).

---

## 4. Set up the AI (Gemini, or a free open-source model)

1. Get a free API key at **https://aistudio.google.com/apikey**.
2. Add it to `.env`: `GEMINI_API_KEY=your_key`
3. Restart the app.

Now the AI desk works, the Market Flow Radar's **✨ AI Analysis** button works, and every new ignition alert gets an automatic AI verdict. To control cost: `AI_REVIEWS_PER_HOUR=12` (the default) caps automatic reviews; `AI_AUTO_REVIEW=0` turns them off.

**Cost per analysis:** the AI committee makes 6 Gemini requests (data analyst, news researcher, bull, bear, trader, and the Final Boss with the stronger model). The Final Boss runs on every analysis. **Fast NO** (off by default, `AI_FAST_NO=1` to turn on): a coin you check by hand that has no alert signal skips the debate, and when the trader and the code both say no trade, the Final Boss too; alert reviews and trigger re-checks always get the full committee. If the news researcher answers without searching, it is asked once more (one extra request). The trader and the Final Boss think deeply (more "thinking" tokens, billed as output); the others think quickly. The news search uses Google Search grounding, which has its own free daily allowance in Gemini; news is kept for 30 minutes per coin, so repeat checks do not search again. To spend less: `AI_DEBATE=0` (no bull and bear, 2 requests fewer), `AI_NEWS=0` (no web search, 1 fewer), `AI_DEEP_THINKING=0` (everyone thinks quickly). The page shows the requests and tokens of each analysis and of the day.

**Daily limit:** `AI_DAILY_REQUESTS=400` (the default) caps Gemini requests per day (UTC). Telegram warns at 80% and at 100%. At the limit, automatic alert reviews and WAIT-trigger re-checks pause until midnight UTC; your own analyses still run. `AI_DAILY_REQUESTS=0` = no limit.

### Free open-source AI instead of Gemini

No Gemini key? The app can use a free, open-source model instead (`ai-provider.js`). Every AI part works the same way: the AI desk committee, alert reviews, the Market Flow brief and the News labels. Pick one:

| Option | Cost | Set in `.env` | Good to know |
|---|---|---|---|
| **Ollama** on your own PC (ollama.com) | free, nothing leaves your PC | `AI_PROVIDER=ollama` and `AI_MODEL=qwen3:4b` (or any model you pulled) | Install Ollama, then run `ollama pull qwen3:4b`. Without a graphics card it runs on the processor: fine for News labels, but one full AI committee analysis can take several minutes. Each request gets 6x longer before it times out (`AI_TIMEOUT_FACTOR`). |
| **Groq** (console.groq.com/keys) | free key, open models (Llama, Qwen, gpt-oss) | `GROQ_API_KEY=...` | Fast. Default models `llama-3.3-70b-versatile` and `openai/gpt-oss-120b` for the Final Boss; change with `AI_MODEL` / `AI_REVIEW_MODEL`. Free limits are per account and change often. |
| **OpenRouter** (openrouter.ai/keys) | free models with a free key | `OPENROUTER_API_KEY=...` | Use a model name ending in `:free` in `AI_MODEL`. |
| **Cerebras** (cloud.cerebras.ai) | free tier | `CEREBRAS_API_KEY=...` | |
| Any other server that speaks the OpenAI chat API (LM Studio, vLLM, llama.cpp) | — | `AI_PROVIDER=custom`, `AI_BASE_URL=http://.../v1`, `AI_API_KEY` if needed | |

**Which one is used:** `GEMINI_API_KEY` wins when it is set, unless `AI_PROVIDER` names another. Otherwise the first free key found (Groq, then OpenRouter, then Cerebras), else Ollama if it is running on this PC. The startup line `AI (...)` and the status bar say which one, and whether its test request worked.

**What is different from Gemini:** open models have no Google Search, so the news researcher works only from the app's own search (Google News and Binance announcements, which it always does first). Gemini's thinking settings are ignored. Answers in JSON use the server's JSON-schema mode when it has one, else plain JSON mode with the schema written into the instructions. Smaller models make more mistakes than Gemini's: watch the AI track record before you trust their calls.

---

## 5. A simple daily routine

| When | Where | What to look at |
|---|---|---|
| Once a day | **BTC rotation** | Is BTC in a downtrend (the rules hold cash)? Is the alt season meter "Alts leading" or "BTC leading"? This tells you whether hunting altcoins makes sense today. |
| When an alert arrives | **Ignition** → **AI desk** | Read the alert and the AI's TAKE / WAIT / NO TRADE. Check the chart yourself. Never chase coins marked "Already moved". If you trade it, press **"I took it"** and enter your real fill. |
| A few times a day | **Market Flow Radar** | Which coins have aggressive buyers right now, and is the whole market buying or selling? |
| After a 4h close (00, 04, 08, 12, 16, 20 UTC) | **Perps** | New swing signals with TAKE / WAIT / SKIP. Before any futures trade of your own, use **Check a trade**. Take at most your maximum open positions, size from your risk, and press **"I took it"**. |
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
| **Early ignition A+** | An early ignition with 3 or 4 of the **quality signs**: buyers in control (65%+ aggressive buying), a fresh start (daily volume under 1.5x normal), a strong close (top 30% of the last 5-minute candle), not stretched (under 1.5% above the 4-hour average) | The early alerts worth acting on: only these go to Telegram by default |
| **Confirmed ignition** | The same, plus an ignition score of 65+ (volume that keeps running). Usually a few minutes later | The tier worth trading |
| **Big-move** (research) | A 5m ignition on a smaller coin ($1M-$10M daily volume) whose daily volume is already 1.5x its 20-day average. Target +40% before -10% within 7 days | A watchlist, not a proven edge |

**Quality checks** (all must pass): daily RSI 65 or lower, price above its 20-day average, room above (not less than 1% under its 12-hour high or 1.5% under its 24-hour high: it waits for the break), not an exhausted spike, not the top tick of the 2-hour range, rising 4-hour trend, BTC not falling over 1 and 4 hours, tight spread, no market-wide surge. Stablecoins, tokenized stocks and gold, wrapped tokens and coins on Binance's Monitoring list never alert. Coins that already ran are marked **Already moved — do not chase**.

#### Ignition quality gate (what goes to Telegram)

Since November 2026 a confirmed or Early A+ alert only goes to Telegram (and gets an AI review) when it also passes the **quality gate**:

- **Normal-sized trades:** the average trade size in the alert candle is at most **1.5x** the coin's normal trade size for that hour. A move pushed by a few big orders fades more often than one with many ordinary buyers.
- **Calm 24 hours before:** the coin's high-low range over the 24 hours before the alert candle is at most **13%**. A coin that is already swinging hard has usually had its move.

Every alert still shows on the page and is still tracked. Alerts that fail the gate say why, for example "gate: big trades (2.3x the normal trade size)". The performance panel has "Quality gate passed" and "Quality gate failed" groups, so your live results can confirm it or prove it wrong.

**How it was found, honestly:** a large study tested about 40 ideas on 405 coins (July to October 2026) against random entries. Ideas included buyer share over 24h, sector leaders, crowd size, 3-day highs, BTC mood, other exits and standalone triggers. Most looked good on the tuning months and then **failed** on an older period nobody had tuned on (April to July 2026, 139 coins). The gate was the only one that held in all periods. In the app's own replay:

| Period | Telegram before the gate | Telegram now (with the gate) | Held back by the gate |
|---|---|---|---|
| Jul-Oct 2026 (tuning) | 132 alerts, +0.75% per trade | 66, **+0.76%** | 66, +0.73% |
| Apr-Jul 2026 (never tuned on) | 125, -0.51% | 51, **+0.16%** | 74, **-0.98%** |
| Oct 29 - Nov 3 2026 (fresh days) | 2, both stopped out | 0 (both held back) | 2 |

All alerts that passed the gate beat all alerts that failed it in both periods (+0.43% vs +0.13%, and +0.04% vs -0.88%). **What this means:** the gate mostly removes the worst alerts. It does not turn Ignition into a strong edge. In the older period even the gated alerts only about break even after fees. Keep sizes small and let the live panel decide. Settings: `SCREENER_IGNITION_GATE`, `SCREENER_GATE_MAX_TICKET`, `SCREENER_GATE_MAX_RANGE24`.

**Every alert is tracked as a trade:** take profit at +6%, stop at -3%, otherwise sell after 12 hours (big-move: +40% / -10% / 7 days), judged on 1-minute candles after 0.2% fees and 0.1% slippage. The **performance panel** shows the results per tier and per AI verdict.

#### Pump watch: coins that could pump hard

Press the **Pump watch** tag on the Ignition tab. Once a day, a few minutes after the daily close (00:00 UTC), the app reads the daily candles of every Binance USDT pair with $0.5M+ of volume and lists the coins where **all** of this is true on the day that just closed:

- the close is **within 15% of its 90-day high** (strong coins break out; coins far below their high rarely pump),
- the day's volume is **2x or more** its 20-day average (new money coming in),
- the day rose **less than 15%** (it has not already run: chasing coins that are already up a lot lost money in the test),
- **$1M+** was traded that day.

Stablecoins, tokenized stocks and gold, wrapped tokens and coins on Binance's Monitoring list are left out. A coin is listed at most once every 14 days.

**The plan that was tested:** buy near the daily close, sell at **+100%** or at **-25%**, otherwise sell after **14 days**. Each pick is followed on daily candles with exactly that plan, and the page shows its result.

**Market mood** = the share of coins whose price is up over the last 30 days. In the test, picks made money on average when it was 40% or more and lost money when it was under 40%. The page says **OK** or **WEAK**, and the Telegram message is only sent when it is OK (`PUMP_TELEGRAM=all` sends it anyway). When it says WEAK, skip the picks or use a very small size.

**Be honest with yourself about what it does:** it roughly **doubles the odds** of a big pump. It does not make a pump likely. About 9 in 10 picks do **not** rise 50%, and about 1 in 5 hit the -25% stop. The money comes from the few that double. It also made money only in strong altcoin markets (see [What the tests say](#7-what-the-tests-say)). Use small sizes, and never more than you can lose.

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

> Alpha pools are thin (often a few hundred thousand dollars), so a market order moves the price, and tokens can be delisted. Press **Ask AI** on a row for the AI committee's YES / WATCH / NO (see [AI trade desk](#67-ai-trade-desk)).

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

Data: public Ethereum nodes, DexScreener prices, Blockscout names (Etherscan names when Blockscout fails and `ETHERSCAN_API_KEY` is set), GeckoTerminal for other networks, and an open Etherscan label snapshot (June 2023). It shows what wallets did, not why. Not financial advice.

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

- **Analyze:** the code gathers everything that matters about the coin (the signal, 15m / 1h / 4h charts, support and resistance, order book, futures positioning, Market Flow Radar numbers, whale and DEX flows, BTC, and how often this kind of alert won before) and hands it to the **AI committee**, which answers **YES or NO** (TAKE, WAIT or NO TRADE) with entry, stop, targets, reward:risk and the reasons for and against.
- **Analyze all:** ranks every igniting coin in one quick request. **Data only** shows the facts for free, without calling Gemini. **News search** and **bull vs bear debate** (both on by default) can be switched off per analysis.
- **Automatic review:** every new ignition alert, and every confirmed Alpha alert, gets the full committee's verdict saved with the alert (verdicts also go to Telegram, with each member's vote), so after a few weeks the performance panels show whether the AI's calls really do better.
- **Alpha tokens:** press **Ask AI** on any row of the Alpha tab. The AI gets Alpha's own 1h / 4h candles, DexScreener buyers vs sellers, pool liquidity, holders and supply, with Alpha's own rule (+40% / -10% / 7 days, 1% costs) and its replay and live results. Extra hard stops: DEX sellers in control, pool under $50k.
- **It learns from your live data:** the AI is shown how past alerts with the same conditions did (BTC trend, alt season, time of day, buyers…; groups with 10+ resolved alerts), so a condition that keeps losing lowers its chances.

**The AI committee:** six AI members, each with one job, its own carefully written instructions and its own thinking depth (`ai-committee.js`). The page shows one card per member.

| # | Member | Model · thinking | Job |
|---|---|---|---|
| 1 | **Data analyst** | `GEMINI_ANALYST_MODEL` · quick | Reads the data only. Rates its quality (good / partial / poor), lists the evidence for and against in each area with the exact numbers, conflicts (e.g. strong 5-minute buying inside a 4h downtrend), red flags and the 3-5 numbers that matter most. It does not decide. |
| 2 | **News researcher** | `GEMINI_ANALYST_MODEL` + Google Search · quick | **The app searches first**, because Gemini often skips its own search: Google News (last 7 days) for the coin's name and ticker, and Binance's own announcements (delistings and Binance news of the last 14 days) that name the ticker. Gemini then judges those results, and every item it reports must point to one of them, with the real title, date, source and link (or come from Gemini's own Google Search). It looks for the last 7 days and the next 14: delistings and Binance monitoring tags, deposit / withdrawal halts, hacks, token unlocks, listings, lawsuits, launches. Checks that each item is about this coin, says whether it is already priced in, and rates the risk. The sources come from Google's own search data, so the links are real. "No relevant news" is a normal answer. A search counts when Google sends back any search data (links, queries, or tokens spent reading search results). If neither the app nor Gemini could search, it is asked once more. **News rule:** if there is still no search, the news is **unknown**: no headlines, dates, figures or sources from memory are shown or passed on, and nothing is saved. |
| 3 | **Bull** | `GEMINI_ANALYST_MODEL` · quick | Makes the strongest honest case **for** buying now: 3-5 reasons with the exact numbers, answers to every red flag (or admits it stands), the path to the target, its own weakest point, and a strength score (most setups are 3-6 out of 10). |
| 4 | **Bear** | `GEMINI_ANALYST_MODEL` · quick | Reads the bull's case and answers each point (holds / overstated / wrong, with the number), then makes the strongest honest case **against**: fake-outs, sellers, resistance, BTC, crowded futures, thin liquidity, the base rate, news, and the most likely path to the stop. |
| 5 | **Trader** | the model you pick · deep | Decides TAKE / WAIT / NO TRADE as the referee of the debate, following the rules below: only arguments with a number count, a bear point the bull could not answer stands, tone and self-given scores are ignored, and if the bear's path to the stop is more likely than the bull's path to the target there is no TAKE. Names the winner, answers every red flag, and adds a "news" line to its checklist. |
| 6 | **Final Boss** | `GEMINI_REVIEW_MODEL` (stronger) · deep | Runs on **every** analysis, whatever the trader decided, with the full report and the raw data. Audits the committee: hard stops; reward:risk recomputed to the **tested target** (levels above are hurdles it must judge, not caps); expected value with the chance of a time-out; whether the probability changes from the base rate are backed by evidence; contradictions between and within members; missing data; whether the bull argued its strongest case. Names the single deciding factor and answers **YES** (hard stops pass, realistic R:R 2:1 or better, positive EV), **WATCH** (not valid now but could be: measurable triggers and an expiry) or **NO** (structurally broken or no path to positive EV), with a corrected plan and a position size as % of normal. It can overturn the trader **either way**, and rates each member ok / weak. If its model fails (not available on your API key, over its quota, too slow), `GEMINI_ANALYST_MODEL` answers instead, and the page says so. It gets the complete list of hard stops (nothing else counts as one) and a list of issues the code found for it to audit one by one; its confidence is capped by the data rating (partial = medium at most, poor = low) and lowered one step when it audits nothing. |

Members 1 and 2 work at the same time; then the bull, the bear, the trader and the boss in turn (about 1-2 minutes in all). **While it works, the page shows each member live:** waiting, working (with what it is doing, e.g. "12 results found; Gemini is judging them"), done (with its answer, e.g. "against 7/10") or skipped, with a timer for each; afterwards the timeline stays folded under the answer. The Alpha tab's "Ask AI" box shows the same steps. If a member fails, the others are told that part is unknown (never "fine"). If the Final Boss cannot answer, the code's own call on the trader's plan is shown, and never a YES.

**Model settings per member:** Gemini 3 models get a thinking level (quick for checking, searching and arguing; deep for deciding and approving) and keep their default temperature, as Google advises for Gemini 3. Gemini 2.5 models get a thinking budget and a low temperature; other models a low temperature. Deep members get up to 2 minutes per request.

**How the trader decides:** no trade is the default.
1. **Hard stops** (any one means no trade): the coin already ran, BTC down more than 1% in 1 hour or 2% in 4 hours, aggressive selling now, a spread above 30 bps or less than $20k of bids within 1% of the price (a thin 0.1% band is normal for small coins and does not count), a Binance monitoring tag, or a confirmed bad news item from a real search (delisting, hack, deposit / withdrawal halt, an unlock above 2% of the supply during the trade).
2. **Checklist:** trigger, buying, trend, room above, liquidity, futures and whales, market breadth, past results, news. The levels above are the 24h / 7-day / 15-day highs, 1h swing highs and the 1h / 4h EMA20 and EMA50 (the page shows the nearest one as a **hurdle**); support is the nearest low or 1h swing low. Binance's Seed tag is shown as a risk, not a hard stop.
3. **Chances** of hitting the target and the stop, starting from the real base rates and moved by at most 15 points. All base rates are measured: each alert tier from its replay; a coin with no signal from random moments (13% hit +6% first, 33% the stop); a coin that already ran but still has surging volume, like a parabolic mover, from 1,215 such moments (31% hit +6% first, **60% the stop**, -0.16% per trade). **Track record rule:** only results of the alert's own tier are used (its live results, past alerts of that tier with the same conditions, the committee's calls on that tier). With none: "no track record for this tier", and the base rate only.
4. **Expected value**, written out in full on the page and in Telegram: P(target) × target% − P(stop) × stop% + P(time-out) × average time-out% − costs. The average time-out move comes from this tier's live alerts that ended at the time limit (10+), else from the AI's own calls on the tier (5+), else it counts as 0. TAKE needs +0.5% or more per trade and reward:risk of 1.5+.
5. **Plan rule:** target 1 is the alert's **tested target** (+6% for ignitions, +40% for big-move and Alpha), and the target shown is the one used for reward:risk and expected value; a higher target from the AI is kept as target 2. It is **not** capped at the nearest resistance: in the 90-day replay, capping the target at the next high cut the result from +0.36% to +0.13% per trade, and how close that high was did not predict the result (the screener already skips alerts right under the 12h / 24h high). The stop sits just below the nearest real support (the nearest low or 1h swing low, or the 24h low) that is at least half a normal 1h move under the entry, never at a fixed percentage.
6. **The Final Boss** audits it all and gives the final call. **Code still checks every YES** and turns it into WATCH unless there is no hard stop (the code's own, confirmed bad news, or one the boss listed), the coin is igniting now and has not already run, the boss's plan fits the price, the reward:risk to the tested target is 2 or more, and the expected value after costs is +0.5% or more with the boss's chances held within 15 points of the base rate. YES = take it with the boss's plan and size; WATCH = wait for the triggers; NO = no trade.

**WATCH triggers (watching):** a WATCH comes with the Final Boss's triggers and an expiry. Its first price trigger (e.g. "15m close above 1.245" or "dips to 1.19") is watched by the code; if there is none, the trader's own price event is used: a **breakout** (a 5m / 15m / 1h candle closes above a level) or a **pullback** (the price dips to a level), within 10 minutes to 24 hours. The other conditions (buyers %, funding, news) are checked by the whole committee when it looks again. The code watches every minute. When the price trigger hits, the full committee checks the coin again with fresh data and Telegram gets "⏰ AI TRIGGER HIT" with the new YES / WATCH / NO. The **Watching** list on the AI desk shows what is being watched, with a "Stop watching" button. One watched event per coin (the newest), up to 30 at a time; a re-check can set one more trigger, not an endless chain.

**AI track record:** every AI answer (your analyses, automatic alert reviews, Alpha checks, trigger re-checks) is followed like a trade with its own plan: bought at the price of the answer, closed at its stop or target (the stop counts first if a candle touches both) or at the end of its holding time, after costs. WATCH and NO answers are followed too, "if bought anyway". The same coin is counted once per 30 minutes. The **AI track record** section shows:
- **Final YES** vs **WATCH / NO, if bought** and the **edge** between them: above 0 means the committee picks better than what it rejects.
- **Boss stopped a TAKE:** how the trader's TAKEs that the Final Boss did not approve would have done (below 0 = the boss saved money); also the trades it turned into YES, and when it agreed with or overturned the trader.
- Results by member: trader TAKE / WAIT / NO TRADE, bull or bear won, news risk, data quality, your analyses vs alert reviews vs trigger re-checks, spot vs Alpha.
- **Said vs real chance** of the target (calibration), and the latest answers with their results.

**It learns from its own record:** the committee sees a summary of it in every analysis (groups with 5+ resolved calls): if its YES calls have been losing, or its target chances ran above what happened, the trader and the final boss are told to be stricter; if its WATCH / NO calls did better than its YES calls, to weigh the data more than vague doubts; and if a recent losing YES looks like the new setup, to name the difference or not take it. Saved in `ai_calls.json`.

Long only, no leverage, risk at most 1% of your account per trade.

### 6.8 Learning from your live results

Replays are a starting point; your live alerts are the real test. Every alert since this update saves extra data so the app can show what works for **you**. Find it in the Ignition tab's **Alert performance** panel and the Alpha tab's **Live results in detail** panel.

| Table | What it shows | How to use it |
|---|---|---|
| **Exit rules compared** | Every alert is also followed under alternative exits on the same candles: a smaller and a bigger target, a break-even stop, two trailing stops, and quick time exits (Ignition: 1h and 4h; Alpha and big-move: 24h and 3 days) | Switch exit only when one has 30+ alerts and beats the alert's own rule in **both** the older and the newer half |
| **What separates winners from losers** | Results split by the conditions saved at alert time: BTC trend and regime, alt season meter, Market Flow buyers, time of day (Asia / Europe / US), alert delay, the AI's verdict, and for Alpha also liquidity, holders, token age and DEX buyers | A condition counts only when the last column says **Better in both** (or **Worse in both**) and it has 20+ alerts |
| **Alert speed** | How many seconds after the 5-minute candle closed the alert fired, and where price was 1, 2 and 5 minutes later (Alpha: 5 and 15 minutes) | If price usually runs away before you can act, speed is costing you money |
| **Is the AI helping?** | Results by AI verdict (TAKE / WAIT / NO TRADE), and whether its stated chance matches reality (when it says 30%, does it hit about 30%?) | If TAKE does not beat NO TRADE after 30+ alerts each, use the AI only as a trap detector (its hard stops) |

**What your first live results changed (v7, Oct 29 2026).** In the first two days of v6, 17 quick alerts resolved: 1 hit the target, 10 hit the stop. The AI said SKIP to 7 of them and all 7 lost, mostly because price sat right under a recent high. A 90-day replay agreed: alerts less than 1% under the 12-hour high (or 1.5% under the 24-hour high) and alerts below the coin's 20-day average lost money. v7 skips both, which turned the replay's confirmed tier from -0.12% to +0.49% per trade with about 40% fewer alerts. Other ideas were tested and **not** used because they did not help in both halves of the 90 days: other targets and stops, break-even and trailing stops, 1-4 hour time exits, and holding alerts while BTC is in a downtrend. Big-move alerts no longer go out for coins on Binance's Monitoring list (all three such live alerts hit -10%). The performance panel starts counting v7 alerts from zero; switch to **All alerts** to see the older ones.

**Live candles (Nov 2026).** The Ignition screener follows every coin it scans on Binance's live candle stream (a WebSocket, no key). Closed 5-minute candles arrive within about 0.2 seconds of the close, so the scan starts as soon as 80% of them are in (it used to wait 4 seconds), and it reads the candles from memory instead of downloading 290 of them per hot coin again. Measured: the scan starts 0.2 s after the close instead of 4 s, and takes about 1.8 s instead of 3 s, so an alert is out about 2 seconds after the close instead of about 7. If the stream drops, the old timer (4 seconds after the close) and the downloads take over by themselves. **Ignition › Data health** shows the stream. Needs Node 22 or newer; `SCREENER_STREAM=0` turns it off.

**Replay of the latest weeks (Nov 3 2026).** The v7 rules were replayed on Sep 19 to Nov 3 (132 coins with $5M+ volume), split in two halves, plus Aug 5 to Sep 19:

| Tier (alerts, avg per trade after costs) | Sep 19 - Oct 12 | Oct 12 - Nov 3 | Aug 5 - Sep 19 |
|---|---|---|---|
| Early (all) | 86, +0.58% | 57, -0.22% | 168, -0.04% |
| Confirmed | 43, +1.60% | 24, -0.29% | 68, -0.24% |
| What goes to Telegram now (with the gate) | 28, +2.01% | 9, +0.64% | 36, -0.54% |

In the newest half about half of all alerts hit the stop (the 90-day replay above: 37-41%), and the quality gate did not help in Aug-Sep. Two more ideas were tested and **not** used: "the volume also surged on Bybit or OKX" (worse in the first half at 2x and 3x) and BTC trend, time of day or weekday filters (none held in every period). So the rules are unchanged; trade Ignition alerts small and let the live panel decide.

Alerts are also faster now: the Ignition screener runs an extra scan 4 seconds after every 5-minute candle closes (or sooner with the live candles above), and the Alpha scan starts 5 seconds after the close with the hottest tokens first (it used to wait 25 seconds).

### 6.9 Trade journal

**Open:** http://localhost:3000/screener#journal

1. Press **"I took it"** on an alert (Ignition alert history, the Alpha alerts table, or a Perps signal card). The journal opens with the coin, the side (long or short), the alert price, the stop and the target filled in.
2. Change the entry to **your real fill price**, add your size in $ (and fees if you like), and save.
3. While it is open, the journal shows the live price and your unrealized result.
4. When you sell, type your exit price and press **Close**.

The top of the page shows your closed trades, win rate, total profit or loss in $, average per trade, R multiple (when you set a stop), and **you vs the alerts**: your average result next to the same alerts' tracked results, plus how much worse (or better) than the alert price you usually get filled. Short trades (Perps) count as profit when the price falls. You can also add trades by hand. Saved in `journal.json` on your PC; nothing is sent to an exchange.

### 6.10 Perps swing signals (futures)

**Open:** http://localhost:3000/screener#perps (no API key; uses Binance's futures data, fapi.binance.com)

Swing trades (held up to 14 days) on Binance USDⓈ-M perpetuals, **long and short**, using the setups tested by `node perps-backtest.js` (see [Backtests](#8-backtests-and-replays)), with exactly the same code.

**The tested record:** the app ships with the results of a full run (Dec 2021 to Sep 2026) in `data/perps-report.json`, so verdicts work from the first start. Run `node perps-backtest.js` yourself (1-2 hours the first time) to refresh them with the newest months: your own `perps_report.json` then replaces the shipped copy automatically. Re-run it every month or so.

- **Signals:** after every 4h close (00, 04, 08, 12, 16, 20 UTC), the 50 most liquid perpetuals (by 30-day volume, without stablecoins or perpetuals on stocks, ETFs and commodities) are checked for the two setups worth watching:
  - **20-day breakout / breakdown on volume**, long and short;
  - **crowded fade**: funding at an extreme while open interest piles in and price stalls.
- **A+ setups** (the versions that held up in the test, see [What the tests say](#7-what-the-tests-say)):
  - **Weak-coin breakdown short:** a 20-day breakdown on volume while the coin is in its own daily downtrend **and BTC is in a daily uptrend** (the coin is falling on its own). +0.73R per trade over 334 trades, positive in every year 2022-2026. Passes every test.
  - **Short-squeeze breakout long:** a 20-day breakout on volume while funding is negative (shorts crowded and paying). +0.48R per trade, but not proven yet (in 2025-26 most of its profit came from 3 coins).
  - Both use a wider exit: **target 4x the risk, or the stop, or 14 days** (better than 2.5R in both test periods).
- **TAKE / WAIT / SKIP** for every signal:
  - **TAKE:** an A+ setup whose own record passed every test (made money before 2025 and in 2025-26, 100+ trades, not from 2-3 coins), on a coin that is not wildly volatile (4h ATR under 5% of the price). Today: the weak-coin breakdown short.
  - **WAIT:** a tested setup fired, but it has not passed every test (the other signals, and the short-squeeze long for now).
  - **SKIP:** it lost money in the test, or two conditions that hurt are met.
- **Signal card** (click a row):
  - entry, stop and target (4x the risk and 14 days for A+, else 2.5x and 10 days);
  - **position size** for your account and risk, **margin**, the **liquidation price** at your leverage (flagged when it is not well beyond the stop, with the safe leverage);
  - the **funding** you would pay or receive over 10 days;
  - the setup's tested record and its last tested trades;
  - an **"I took it"** button.
- **Check a trade:** type any coin, long or short, and optionally your entry and stop. You get:
  - **TAKE / WAIT** if a tested setup fired now or in the last 12 hours;
  - **SKIP** if it is a kind of trade that lost money in the test (buying a dip in an uptrend, or buying right after a crash);
  - **WAIT** with what to wait for (e.g. "a 4h close above 94.58 on 1.5x volume") when nothing tested applies.
- **Your risk settings** (account, risk per trade, leverage, maintenance margin, maximum open positions) are saved in your browser only.
- **Coins scanned:** price, funding (and where it sits in the coin's own 90 days), open interest change, top traders vs everyone, daily trend, strength vs BTC, distance to the 20-day high and low, and which setups fired, marked when they lost money in the test.
- **Live results:** every signal is followed with the tested exit after fees and funding, by setup and by verdict, next to the backtest average. That is the real test; give it 4-8 weeks before trading size.
- **Telegram:** TAKE signals only, so a phone alert means an A+ setup (switch "Perps swing signals" in Ignition › Telegram). WAIT signals stay on the page.

Leverage can lose you more than a spot trade, fast. Use isolated margin, size from your risk, and keep the liquidation price well beyond the stop. Research signals, not financial advice.

### 6.11 Perps scalp signals (5 minutes to 1 hour)

**Open:** the **Perps** tab, **Scalp** tag (http://localhost:3000/screener#scalp opens it there). Signals only: the app never places orders.

**What was tested first.** Seven common scalp strategies were run on every 5-minute candle of the 50 most liquid Binance USDⓈ-M perpetuals of each month, July 2024 to September 2026, long and short, with entry at the next candle and 0.12% fees per trade (taker in and out):

| Strategy | Result after fees (avg per trade) |
|---|---|
| Breakout of the 4-hour range on 3x volume | -0.12% to -0.15% |
| Pullback to the 20 EMA in a 5-minute trend | -0.10% to -0.14% |
| Snapback after 2.5 standard deviations (RSI extreme) | -0.05% to -0.12% |
| Bollinger squeeze breakout | -0.10% to -0.17% |
| Follow a BTC jump on coins that have not moved yet | about -0.05% |
| Fade a spike up (short) | about 0% |
| **Flush bounce (long)** | **+0.97%** on volatile coins |

Most of them break even **before** fees, so fees turn them into losses. That is normal for 5-minute trading on liquid coins. Only one held up, so the tab uses only that one.

**The flush bounce (the tab's only setup, long only):**
1. **A flush:** one 5-minute candle falls at least **2.5x** the coin's normal 5-minute range (ATR), on at least **4x** its normal volume. That is forced selling, often liquidations.
2. **The bounce:** the next candle closes **green** and **above the middle** of the flush candle (buyers stepped back in).
3. **A volatile coin:** its normal 5-minute range is at least **0.6%** of the price. On calm coins the same pattern made about 0%, because the bounce is too small to beat the fees.

**The plan:** buy right away (near the next candle's open), **stop** just under the lower of the two candles' lows, **target 1.5x the risk**, and **close after 1 hour** if neither is hit. One signal per coin per hour.

**Is it working?** The Scalp section's "Last scan" time changes every 5 minutes, and "Scalp: coins scanned" lists about 50 coins with each one's **biggest 5-minute drop of the last 2 hours** (a signal needs 2.5x+ the normal range on 4x+ volume, then a green candle back above its middle). If the scan fails, the error shows at the top of the section and in the terminal. No signal for a few days is normal: from Oct 28 to Oct 31, 2026 the rule found none on the top 50. When a coin has just had a flush (half the setup), the section shows **"Watching for a bounce"** with the price the next candle must close above for a signal.

**What the page shows:** each signal with its entry, stop and target, the **position size for your risk** (from your Perps › Risk settings: account, risk %, leverage) and whether the liquidation price is safely beyond the stop, the price now, and the result once closed. Below: the test results, every month of the test, and the coins scanned (with which ones are volatile enough to signal). Telegram sends each new signal (switch "Perps scalp signals" in Ignition › Telegram).

**Liquidation label:** each scalp signal shows how open interest changed over the 15 minutes of the flush. When it fell 2% or more (positions forced out, a liquidation flush), the signal says **liquidations confirmed**: in the test those bounced a little better in both periods (+0.84% vs +0.59% per trade before Oct 2025, +1.51% vs +1.09% after), but on only 76 trades, so it is a label, not a filter. Flushes that hit many coins in the same candle (market-wide) did not bounce better.

**Paper bot** (Perps tab, **Paper bot** tag): a pretend account that starts with **$100** and takes **every** scalp signal **and every Perps A+ TAKE trade** (long or short; target 4x the risk, the stop, or 14 days, with the tracked fees and real funding) on its own, so you can see what the signals would really have done with an account, without money or an API key.
- It buys at the signal's entry, uses the signal's stop and target, sells after 1 hour if neither is hit, and pays the same 0.12% fees as the test.
- Each trade risks **1%** of the balance (about $1 with $100): the size comes from the stop, so a wide stop means a small position. At most **5x** leverage (the position can never be bigger than balance x 5) and at most **3** scalp and **3** perps trades at once; a signal that comes while its strategy is full is skipped.
- The page shows the balance, the return since the start, the win rate, the worst drop, open trades with their live profit, and every closed trade with the balance after it. Telegram sends each closed trade and the new balance (switch "Scalp paper bot" in Ignition › Telegram).
- **Settings and reset:** change the start, the risk per trade, the leverage and the maximum open trades, and start again from zero.
- What to expect: in the test, 1% risk per trade made about **+90% over 27 months**, with a worst drop of 12% and a losing run of 17 trades. So with $100 the gains are small (cents to about $1.50 a trade) and slow. Let it run for a few weeks before deciding anything.
- **Real account later:** the bot sends every trade through one "broker" part (`paper-bot.js`). Trading a real Binance account means replacing that part with one that places the real orders (entry, stop and take-profit), using an API key that cannot withdraw, an IP whitelist, a daily loss limit and a stop switch. Do this only after the paper bot has made money for several weeks.

**Be ready for this:**
- It is **rare**: about 20 signals a month across 50 coins, mostly when the market drops fast. Many days have none.
- The stop is **wide for a scalp**: about 3% below entry on a typical trade, and 10%+ on 1 in 10 (deep wicks). Always size from the stop, never a fixed amount: with a 3% stop and 1% account risk, the position is about a third of the account.
- **Act fast:** entering one candle (5 minutes) late cut the result from +0.97% to +0.60% per trade in the test.
- **Losing runs happen:** the test once had 17 losses in a row. Risking 1% per trade, the worst drop was 12% of the account.

### 6.12 Spot plan (BTC + ETH, and every coin)

**Open:** the Ignition tab, **Spot plan** tag.

**The rule:** hold BTC and ETH, half each, but only while each one's **daily close is above its 50-day average**. When a coin closes below it, sell that half to USDT; buy back when it closes above again. Check once a day after the 00:00 UTC close; it switches about 3 times a month for the two coins together.

**What was tested (Nov 2026):** spot strategies on the daily candles of every Binance USDT pair, delisted coins included, January 2021 to October 2026, after 0.15% cost per trade:

| Strategy | Total | Worst drop |
|---|---|---|
| **BTC + ETH, each only above its 50-day average** | **+702%** | **-56%** |
| Holding BTC + ETH, never selling | +190% | -77% |
| Holding BTC | +167% | -77% |
| The same rule on BTC only / ETH only | +437% / +832% | -58% / -55% |
| Breakouts of the 20-day high on the top 30 (BTC filter) | +216% | -62% |
| The top 4 coins by volume at the time, each above its 50-day average | +236% | -64% |
| Each top-20 coin above its 50-day average | +41% | -80% |
| Holding the 10 most traded coins | -62% | -91% |
| Rotation into the 5 strongest coins of the top 50 | -97% | -100% |
| Dip buying (RSI(2) under 10, or -20% from the 30-day high) | -73% / -95% | -77% / -98% |

Most altcoins kept falling against BTC over these years, so strategies that hold altcoins lost money. The BTC + ETH rule held up with other average lengths (40 days +715%, 60 days +612%), in both halves (2021-22 +65% vs +10% for holding; 2023-26 +387% vs +231%), and with double the fees (+576%).

**What to expect:** it **trails simply holding in strong bull years** (2021: +178% vs +231%; 2024: +49% vs +70%), because it sells on dips that recover, and it **loses much less in bad years** (2022: -41% vs -67%; 2025: +42% vs -9%; 2026 so far: +19% vs -18%). The worst drop was still -56% (2021-22): use money you can leave for years.

**The page:** each coin's state (HOLD or CASH), its close and 50-day average, since when, and the close that would flip it; the plan in percent; every switch; the full test. `node spot-backtest.js` refreshes the test with the newest days.

**All coins: trend check.** The same idea for every spot coin trading $2M+ a day (up to 100), checked after each daily close. For each coin: how far it is above or below its own 50-day average, whether it has been **stronger than BTC** over the same 50 days (its price in BTC above its average), and its 30-day change. **BUY OK** needs all three: above its own average, stronger than BTC, and BTC above its own average. Filter the list by BUY OK, above or under the average.

Tested on every Binance coin, 2021-2026, holding each altcoin only while it was BUY OK:

| Coins | BUY OK only | Simply above its own average |
|---|---|---|
| Top 20 by volume | +125% (worst drop -54%) | +66% (-76%) |
| Top 50 | +48% (-62%) | +1% (-78%) |
| Top 100 | +78% (-68%) | +41% (-79%) |

So the BUY OK filter makes altcoin buys much safer, but every version did far worse than the BTC + ETH plan (+692%) and lost money in 2025 and 2026. Use it to choose **which** altcoin to buy if you want one, with small size; keep the main money in the BTC + ETH plan.

### 6.13 News (bullish or bearish)

**Open:** http://localhost:3000/screener#news (the **News** tab).

- **Sources** (refreshed every 10 minutes): Google News searches for the crypto market, Bitcoin, Ethereum, regulation and the SEC, ETFs and the Fed (no key needed); Binance's own announcements (news, new listings, delistings); and **CoinDesk's news feed** when you add a free key: get one at developers.coindesk.com and put `COINDESK_API_KEY=your_key` in `.env`. Price pages, predictions and guides are left out.
- **Top stories:** the same story from several sites is shown once, with how many sites ran it. Importance comes from the source (Reuters, Bloomberg, CoinDesk, The Block, Binance... count more), the topic (Fed, ETFs, hacks, regulation, big exchanges), how many sites ran it, and how fresh it is.
- **Bullish / bearish / neutral** for the whole crypto market, with the reason: from **Gemini** when your AI works (it reads the new headlines once, at most one request every 30 minutes, and also rates the impact high / medium / low and names the coins); else CoinDesk's own sentiment label; else **keyword rules** (hack, lawsuit, outflows = bearish; ETF inflows, rate cut, listing = bullish). The rules miss context: "Bitcoin steadies after a hack" still reads as bearish, so the AI labels are better.
- **News mood (24h):** the stories of the last 24 hours weighed by importance, from -1 (all bearish) to +1 (all bullish): Bullish above +0.15, Bearish below -0.15, else Mixed.
- Filter by bullish, bearish, neutral or Binance announcements, and search (for example "ETF").

News is context, not a trade signal: big news is often priced in within minutes. Use it to understand why the market moves and to avoid buying into bad news.

### 6.14 On-chain: crowd vs smart money (Whales tab)

**Open:** the **Whales** tab, **Crowd vs smart money** tag (http://localhost:3000/screener#onchain still opens it there). It was its own tab until Nov 2026; its score also feeds the [Whale signals](#615-whale-signals-take--leave-from-whale-wallets).

**Where the idea comes from:** the posts of @ArslanOnChain on X. He has not published a full method; only a few of his posts are public. The one with real analysis is a "crowd vs smart money" call. On Binance, retail accounts were heavily short (long/short account ratio **0.397**) while the top traders were long (top-trader position ratio **1.31**). In his words, the crowd was shorting the exact move that hurts them. This tab turns that idea into exact rules and tests them. The numbers are ours, not his.

**The two numbers**, from Binance's own futures data, for the 50 most liquid perpetuals, every 4 hours (no API key):
- **Crowd** = the long/short **account** ratio of everyone with a position. 0.5 means two accounts are short for every one that is long.
- **Smart money** = the long/short **position** ratio of Binance's top traders (the top 20% of accounts by margin). Above 1 means more of their money is long than short.

**The signals** (checked after each 4-hour close):

| Signal | Rule | Exit (tested) |
|---|---|---|
| **LONG** (his setup) | crowd at **0.5 or less** and top traders at **1.2 or more** | stop 2x the coin's normal 4-hour range (ATR), no target, close after 3 days |
| **SHORT** (the mirror) | the crowd's ratio is in the **top 10% of its own last 30 days**, top traders at **1.0 or less**, and price makes **lower highs** | same |

**The table** shows every coin: both ratios, the gap between them (smart money ÷ crowd), the reading, the 24h price change, open interest over 3 days, and the price structure. Each signal is followed to its stop or its 3-day close, and the live record is shown.

**The backtest** (`node onchain-backtest.js`, using the tab's own code): Binance's archive from December 2021 to October 2026, the 50 most liquid perpetuals of each month (412 coins, delisted ones included), entry at the next 4-hour open, 0.16% fees in and out:

| Rule | Before 2025 | 2025-26 | Random trades, same coins (before · after) |
|---|---|---|---|
| LONG: crowd short, top traders long | +1.27% per trade (37 signals) | **+0.96%** (345) | -0.08% · -0.71% |
| SHORT: crowd long at a 30-day extreme, top traders not long, lower highs | +0.73% (818) | **+0.95%** (175) | -0.32% · +0.35% |
| Looser long (crowd 0.7 or less, top traders 1 or more) | +1.84% (366) | -0.76% (1,143) | does not hold |

**Be honest with yourself about it:**
- The 3-day exit was chosen after a first look at the same history. With a 2R target and 7 days instead, the long lost money in 2025-26 (-0.38%).
- The long had only 37 signals before 2025, and funding payments are not counted. In these setups funding usually goes to your side, but not always.
- It wins less than half the time. The profit comes from the size of the winners.
- This is Binance positioning data, not wallet tracking. For whale wallets and exchange flows, see the Whales tab.

Size every trade from your risk (the stop is often 4-8% away), and let the live record decide. Research signals, not financial advice. Settings: `ONCHAIN`, `ONCHAIN_TELEGRAM`, `ONCHAIN_SIDES`, `ONCHAIN_CROWD_SHORT`, `ONCHAIN_SMART_LONG`, `ONCHAIN_CROWD_LONG_PCT`, `ONCHAIN_SMART_SHORT`. **Needs Binance futures**, which some countries and networks block (error 451). It works from most home connections.

### 6.15 Whale signals: TAKE / LEAVE from whale wallets

**Open:** the **Whales** tab, **Whale signals** tag (no API key).

**The idea:** follow what the biggest, most profitable wallets do with their own money, as it happens, and say per coin whether to take a trade or leave it.

**Where the data comes from:**
- **Hyperliquid**, an on-chain futures exchange where every wallet's open positions are public. From its leaderboard, the app follows the 200 largest accounts that are in profit all-time and over the last 30 days (account $1M+; market makers, which trade 300x+ their account in a month, are left out). Their positions are read every 2 minutes. Per coin the app knows how much whale money is long and short, and what they opened or closed in the last hour. That last-hour number is counted in coins, so a price move alone does not look like buying.
- **Ethereum** exchange deposits and withdrawals over 24 hours (the whale tracker in the same tab).
- **DEX** buying and selling over 24 hours.
- Binance's **crowd vs top traders** ([6.14](#614-on-chain-crowd-vs-smart-money-whales-tab)).

**The score** runs from -100 (whales selling) to +100 (whales buying):

| Part | Points | When it counts |
|---|---|---|
| Whales' long/short balance | up to ±60 | 5+ whales and $2M+ in the coin |
| Their last hour (opened minus closed) | ±20 | at least $500k and 5% of their position |
| Ethereum exchange flow, 24h | ±10 | $1M+ net withdrawn (+) or deposited (-) |
| DEX flow, 24h | ±5 | $250k+ net bought or sold by 5+ wallets |
| Binance crowd vs top traders | ±10 | crowd short and top traders long (+), or the mirror (-) |

**The calls:**

| Call | Means |
|---|---|
| **TAKE LONG** | score 60+, the whales added longs in the last hour, 3+ whales long |
| **TAKE SHORT** | score -60 or less, the whales added shorts in the last hour, 3+ whales short (futures only) |
| **LEAVE** | the whales cut 30%+ of their net long in the last hour, or $5M+ of an ERC-20 token went onto exchanges in 24h: sell, or do not buy |
| watch | anything else |

The first call can come an hour after the start (the app needs an hour of positions to see what was added). One call per coin and kind every 12 hours. Every call is followed: the price 4 hours, 24 hours and 3 days later, and whether it moved the called way. The **Calls and their results** table shows that record. **Followed whales** lists the wallets, with a link to each one's positions on Hyperliquid.

**Be honest with yourself about it:**
- It is **new and not backtested**. Hyperliquid shows positions now, not a history of them, so the live record is the only test. Give it a few weeks before you trade on it.
- **Many whales hedge.** A fund that is long BTC often shorts altcoins against it, so "whales short SOL" is not always a view on SOL. On Nov 3 2026 the followed whales were heavily short almost every altcoin (SOL: $173M short vs $4M long).
- Following the wallets that did best so far also means following some that were lucky.
- Telegram is **off** by default for these calls (switch "Whale signals" in Ignition › Telegram, or `WHALESIG_TELEGRAM=1`).

Settings: `WHALESIG` (`0` = off), `WHALESIG_TELEGRAM`, `WHALESIG_WALLETS` (200), `WHALESIG_MIN_ACCOUNT` (1000000), `WHALESIG_MAX_TURNOVER` (300). Research signals, not financial advice.

### 6.16 Liquidity: order-book heatmap and 5-exchange screener

**Open:** http://localhost:3000/screener#liquidity (the **Liquidity** tab, no API key). Ported from the open-source [crypto-liquidity-terminal](https://github.com/AIUngated/crypto-liquidity-terminal) (MIT License; its copyright notice is kept in `liquidity.js`).

- **Order-book heatmap:** where buy and sell orders sit for one Binance spot pair (BTCUSDT by default; type another symbol). The app rebuilds the live order book from Binance's depth stream, by Binance's documented procedure: stale updates are dropped and a missed update forces a fresh snapshot. Every second it cuts the book into price bands and keeps about 2 hours. Brighter = more money waiting at that price. The volume bars below come from the trade stream. Next to it: the order book now. Without a WebSocket it reads the order book every 2 seconds instead.
- **5-exchange screener:** spot prices from Binance, Bybit, OKX, Coinbase and Kraken, merged per coin. For each exchange's 15 most traded coins it also reads the last hour of 1-minute candles and the top 20 order-book levels. From those: a **0-100 hotness score** and the signal checks (volume spike, pump, dump, volatility, wide spread, book imbalance, breakout, hot market). Refreshed every 15 seconds, a few coins per exchange at a time. An exchange that fails shows its error and the others carry on. Stablecoins, tokenized stocks and coins on Binance's Monitoring list are left out.
- **What it is not:** orders can be pulled at any moment, so a "wall" is not a promise, and large players place fake walls on purpose. The hotness score ranks what is happening now. It was **not backtested** and does not predict a move. Use it to see where liquidity is, next to the tested signals in the other tabs.

Settings: `LIQUIDITY` (`0` = off), `LIQ_SYMBOL` (the heatmap's first pair, `BTCUSDT`), `LIQ_REFRESH_MS` (15000).

---

## 7. What the tests say

Every tool was replayed on past Binance data with costs included. Short version: **some tiers are slightly better than buying at random, none is a proven money machine.** Use the live performance panels as the real test.

| Tool | Test | Result |
|---|---|---|
| **Ignition, confirmed** | 90 days (Aug-Oct 2026), 139 coins, each counted only while it had $5M+ daily volume (as live), +6% / -3% / 12h, after costs | Hit target 23%, hit stop 37%, **+0.17% per trade**. Without the v7 room and 20-day checks: -0.27%. (On the 96 most traded coins: +0.49%) |
| **Ignition, early (all)** | same | Hit target 26%, hit stop 41%, **+0.26% per trade** (without the v7 checks: -0.01%) |
| **Ignition, Early A+** (early alerts with 3+ quality signs) | same | 44 alerts: hit target 36%, hit stop **27%**, **+1.59% per trade** (first two months +1.49%, last month +1.89%). Early alerts without them: hit stop 46%, +0.23%. The same pattern held on two other versions of the replay. A small sample: the live results decide |
| **Big-move tier** | 90 days, every Binance USDT pair, +40% / -10% / 7 days | About 1 in 10 reached +40%. **+2.5% per trade** in the Aug-Sep alt rally, **-1.8%** in October |
| **Pump watch** (daily list) | Jan 2021 to Oct 2026, every Binance USDT pair (577 coins, delisted ones too), daily candles, +100% / -25% / 14 days, 0.3% costs | 4,726 picks (about 15 a week). **Rose +50% within 7 days: 9.4%** (any coin on any day: 4.7%). **Doubled within 14 days: 5.2%** (2.6%). **+5.25% per trade** (any coin: -0.33%). With market mood 40%+: +6.00%; under 40%: +0.20%. **The years not used to find the rule** (2021 to Feb 2024): +50% odds 11.5% vs 5.9%, +8.05% per trade. **But it made money in only 5 of 12 half-years**: big gains in alt rallies (2021 H1 +21.5%, 2024 +8% to +10%, 2026 H2 +6.5%), losses of 5-10% per trade in weak markets (2022, 2025, 2026 H1) |
| **Alpha, confirmed** | 60 days, every Alpha token not on spot (delisted ones included where Binance still has data) | Hit +40% first 16.7%, **+0.6% per trade** (random entry on the same tokens: 13.8%, -1.2%). The $1M rule was picked after seeing the data, so this may be flattered |
| **Alpha, early** | same | Hit +40% first 11.2%, **-1.2% per trade**, about 50 alerts a day: no better than a random entry |
| **BTC rotation** | Oct 2024 to Oct 2026, 107 weekly decisions | Rotation ranking **+28%** (same as holding BTC, +28%); token picks +136%, but almost all of it from one meme-pump week (-9% without it) |
| **Perps A+: weak-coin breakdown short** | Dec 2021 to Sep 2026, 50 most liquid perps of each month, 0.08% per side + every funding payment, target 4R / stop / 14 days | 334 trades, 51% won, **+0.73R per trade**, profit factor 2.5 (before 2025 +0.92R, 2025-26 +0.54R), **positive in every year 2022-2026**, not from a few coins. **Passes every test.** One account (5 open, 1% risk each): +159%, worst drawdown 15.7% |
| **Perps A+: short-squeeze breakout long** | same | 258 trades, 34% won, +0.48R per trade (+0.53R / +0.36R), but in 2025-26 most of the profit came from 3 coins and 2024 lost a little: **not proven yet** (WAIT) |
| **Perps: 20-day breakdown short** | Dec 2021 to Sep 2026, the 50 most liquid USDⓈ-M perps of each month (406 coins), 0.08% per side + every funding payment, target 2.5R / stop / 10 days | 1,976 trades, 41% won, **+0.15R per trade** (before 2025 +0.20R, 2025-26 +0.07R). Holds with a 2R target. Still positive with higher costs (+0.14R) and with the top 30 coins only (+0.13R). Not yet "proven": the newer period is thin |
| **Perps scalp: flush bounce** (Perps tab, Scalp section) | Jul 2024 to Sep 2026, every 5-minute candle of the 50 most liquid perps of each month, 0.12% fees per trade, target 1.5R / stop / 1 hour | 541 trades on 180 coins (about 20 a month), 60% won, **+0.97% per trade (+0.17R)**. Before Oct 2025 (where the filters were picked) +0.47%; from Oct 2025 (never seen) +1.30%. Entering 5 minutes late: +0.60%. Worse fill and 0.2% fees: +0.60%. 20 of 27 months in profit; top 3 coins 24% of the profit. Risking 1% a trade: +90% in total, worst drop 12%, longest losing run 17. The same setup on calm coins about 0%, the short version about 0% |
| **Spot plan: BTC + ETH 50-day trend** (Ignition tab) | Jan 2021 to Oct 2026, Binance daily candles, 0.15% cost per switch | **+702%** (43% a year), worst drop -56%, Sharpe 1.13, about 3 switches a month; holding BTC + ETH: +190%, -77%. Ahead in both halves and with double fees; 40-60-day averages all +600-715%. Trails holding in bull years, loses much less in bad ones. Altcoin strategies (rotation, breakouts, dip buying, top-10 basket) lost money |
| **Spot plan: the same check on all coins** | same years, every Binance USDT coin, held only while above its 50-day average, stronger than BTC and BTC up | Top 20 +125%, top 50 +48%, top 100 +78% (worst drops -54% to -68%); without the BTC filters +66%, +1%, +41%. Every version lost money in 2025 and 2026 |
| **Perps scalp: six other 5-minute setups** | same | **All lose after fees** (-0.05% to -0.17% per trade): range breakouts, EMA pullbacks, snapbacks, squeezes, BTC lead-lag, fading spikes |
| **Perps: professional-style strategies** (Nov 2026) | top 50 perps, daily, Dec 2021 to Sep 2026, fees and real funding | Holding BTC +60% (worst drop -68%). Trend following long and short +35% (-66%; 2022 and 2024 lost). **Funding carry** (short the 5 highest-funding coins, long the 5 lowest) +158% (-67%; 2025 -33%). Carry with a trend filter +182% (-71%; 2023 -50%). Long the most negative-funding coins -68%. Money overall, but deep drops and bad years: the A+ weak-coin short stays the main perps trade |
| **Perps: the other setups** | same | **Lose after costs:** buying the dip in an uptrend (pullback long, -0.07R) and buying a flush (-0.20R). **Thin:** breakout long, pullback short, crowded fade (+0.03 to +0.09R). The plain-trend benchmark is about zero (longs paid ~0.19% funding per trade) |

**How the A+ setups were found (Oct 2026):** every perps signal of the 4.8 years was saved with 40 market conditions. Conditions were picked on the years **before 2025 only**, then checked on 2025-26, which they never saw. Two survived with a clear reason: a breakdown short works when the coin falls **on its own** (its own daily downtrend while BTC is in a daily uptrend: without the coin's downtrend it made about 0R), and a breakout long works when **shorts are crowded** (funding negative). A wider 4R target did better for both in both periods. Very volatile coins (4h ATR 5%+ of the price) lost money in both periods in almost every setup, so they never get TAKE. The live results are still the real test.

**How the pump watch was found (Oct 2026):** every coin-day of every Binance USDT pair was saved with 30 measures, and we checked what came before +50% moves within 7 days. Most "obvious" signs were traps: coins that already rose 10-25% in a day, or ran for several days on big volume, had 2-5 times the normal odds of another +50%, but **lost money** as trades, because they also crashed more often. Tight, quiet ranges did not help. What held up was a breakout near the 90-day high on 2x+ volume while the day was still calm. It was found on March 2024 to October 2026, then checked on 2021 to February 2024, which it never saw: it held there too (the odds doubled again). Its results swing with the market, and no filter we tried (market mood, BTC above its 50-day average, the list's own recent results) stopped the losses in bear markets.

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
| `node perps-backtest.js` | Swing setups on Binance USDⓈ-M perpetuals, long and short, since Dec 2021, with fees and every funding payment (see below) | 1-2 hours, about 1-2 GB |
| `node spot-backtest.js` | The Spot plan's BTC + ETH 50-day trend rule since 2021, vs holding, by year and half, other average lengths, double fees; writes `spot_report.json`, which the Spot plan shows (until then it shows `data/spot-report.json`) | under a minute |
| `node scalp-backtest.js` | The Scalp section's flush bounce on every 5-minute candle of the top-50 perps since July 2024 (delisted coins included), with late-entry and worse-fill checks, calm coins and the short version for comparison; writes `scalp_report.json`, which the Scalp section shows (until then it shows `data/scalp-report.json`) | 20-40 minutes, about 650 MB |
| `node pump-backtest.js` | Pump watch on the daily candles of every Binance USDT pair since 2021 (delisted ones too), vs any coin on any day, by half-year; writes `pump_report.json`, which the Pump watch panel shows (until then it shows the copy shipped in `data/pump-report.json`) | 5-30 minutes |

Useful options: `--days 45`, `--end 2026-10-28T08` (repeat an earlier window), `--cost 2` (alpha). Re-run them every month: a rule that only worked in one kind of market shows up as one good month and one bad one.

### Perpetual futures swing backtest

`node perps-backtest.js` tests swing-trade setups (held 2-20 days) on Binance USDⓈ-M perpetuals, long and short. It reads Binance's public history archive (data.binance.vision), so no API key is needed, and it works even where the futures API is blocked.

- **Data:**
  - 4h and daily candles;
  - every funding payment;
  - open interest, top-trader and account long/short and taker buy/sell ratios, every 5 minutes since Dec 2021.

  The live API keeps only 30 days of open interest.
- **Coins:** the 50 most liquid perpetuals **at the start of each month** (by the 30 days before), delisted coins included, so today's winners don't flatter the past. Gold, silver, tokenized stocks and index contracts are left out.
- **Setups:**
  - trend pullback;
  - 20-day breakout on volume;
  - flush reversal (a fast drop or spike that cuts open interest);
  - crowded fade (extreme funding while open interest piles in and price stalls);
  - relative strength vs BTC.

  A **plain-trend benchmark** shows what any trend entry would have made; a setup has to beat it.
- **Honest rules:**
  - signals on closed 4h candles, entry at the next candle's open;
  - fees and slippage (0.08% per side by default) and every funding payment counted;
  - a candle that touches both stop and target counts as a loss;
  - a coin delisted while in a trade closes at its last price.
- **Verdict:** each setup is judged on the years before 2025 and on 2025-2026 separately. It **holds** only if it made money in both, with 100+ trades, not mostly from 2-3 coins. Results are also shown by year, by BTC trend, for 5 exit rules, for conditions (open interest, funding, top traders vs everyone), and as one account with at most 5 positions at 1% risk each.

Options: `--top 30` (fewer coins), `--cost 0.1` (fee + slippage per side in %), `--split 2025-01` (where the newer period starts), `--max-open 5`, `--no-oi` (a quick first look without open interest). The download is cached in `perps_cache/` and the result goes to `perps_report.json`.

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
| `GEMINI_API_KEY` | — | See [Set up the AI](#4-set-up-the-ai-gemini-or-a-free-open-source-model) |
| `AI_PROVIDER` | auto | `ollama`, `groq`, `openrouter`, `cerebras` or `custom` for a free open-source model instead of Gemini; `gemini` = Gemini only. See [Free open-source AI](#free-open-source-ai-instead-of-gemini) |
| `AI_MODEL` / `AI_REVIEW_MODEL` | per provider | The open model for every member / for the Final Boss and the risk review |
| `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY` | — | Free keys for open models |
| `AI_BASE_URL`, `AI_API_KEY` | — | Any OpenAI-compatible server (`AI_PROVIDER=custom`) |
| `AI_TIMEOUT_FACTOR` | `6` for Ollama, else `1` | How many times longer each AI request may take |
| `GEMINI_ANALYST_MODEL` | `gemini-3.5-flash` | Model for analyses: the AI desk's data analyst, news researcher and (by default) the trader |
| `GEMINI_REVIEW_MODEL` | `gemini-3.1-pro-preview` | Model for the Final Boss (AI desk, every analysis) and the risk review (Market Flow brief) |
| `AI_NEWS` | on | `0` = no web news search by the AI committee |
| `AI_DEBATE` | on | `0` = no bull vs bear debate (2 requests fewer per analysis) |
| `AI_FAST_NO` | off | `1` = coins you check by hand with no alert signal skip the debate, and the Final Boss when the trader and the code both say no trade |
| `AI_DAILY_REQUESTS` | `400` | Gemini requests per day (UTC) for automatic reviews and trigger re-checks; `0` = no limit |
| `AI_DEEP_THINKING` | on | `0` = the trader and the Final Boss think quickly too (faster, cheaper) |
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
| `SCREENER_ROOM_12H` / `SCREENER_ROOM_24H` | `1` / `1.5` | No ignition while price sits less than this % under its 12h / 24h high (`0` = off) |
| `SCREENER_DAILY_TREND` | on | `0` = also alert coins below their 20-day average |
| `SCREENER_EARLY_ALERTS` | on | `0` = only confirmed alerts |
| `SCREENER_EARLY_MIN_SIGNS` | `3` | Early alerts go to Telegram (and get an AI review) with at least this many of the 4 quality signs; `0` = all early alerts |
| `SCREENER_IGNITION_GATE` | `1` | Quality gate for Ignition Telegram alerts and AI reviews (small trades + calm 24h); `0` = off (send as before) |
| `SCREENER_GATE_MAX_TICKET` | `1.5` | Gate: the alert candle's average trade size may be at most this many times the normal size for that hour |
| `SCREENER_GATE_MAX_RANGE24` | `13` | Gate: the 24h high-low range before the alert may be at most this many % |
| `SCREENER_SETUP_ALERTS` | off | `1` = alerts for daily setups (watchlist) |
| `SCREENER_REGIME_GATE` | off | `1` = hold ignition alerts while BTC is in a daily downtrend |
| `SCREENER_MIN_QUOTE_VOLUME` | `5000000` | Minimum 24h volume |
| `SCREENER_STREAM` | on | `0` = no live candle stream (poll as before) |
| `SCREENER_FEE_PCT` / `SCREENER_SLIPPAGE_PCT` | `0.2` / `0.1` | Costs used in the results |
| `SCREENER_BIGMOVE` | on | `0` = no big-move tier |
| `SCREENER_BIGMOVE_ALERTS` | off | `1` = big-move alerts on Telegram by default |
| `SCREENER_BIGMOVE_TARGET_PCT` / `_STOP_PCT` / `_OUTCOME_HOURS` | `40` / `10` / `168` | Big-move tracking |
| `SCREENER_BIGMOVE_MIN_VOLUME` / `_MAX_VOLUME` | `1000000` / `10000000` | Daily volume range for big-move coins |
| `PUMP` | on | `0` = no Pump watch list |
| `PUMP_TELEGRAM` | on | `0` = the daily Pump watch message off on Telegram by default; `all` = send it even when market mood is weak |
| `PUMP_NEAR_HIGH_PCT` / `PUMP_MIN_VOLUME_RATIO` / `PUMP_MAX_DAY_PCT` | `15` / `2` / `15` | The Pump watch rule (the test only speaks for these defaults) |
| `PUMP_MIN_QUOTE_VOLUME` | `1000000` | USDT traded on the day |
| `PUMP_MOOD_MIN` | `40` | Market mood (% of coins up over 30 days) below which the list says WEAK |
</details>

<details>
<summary><b>Alpha (Binance Wallet tokens)</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `ALPHA` | on | `0` = turn the Alpha tab off |
| `ALPHA_TELEGRAM` | off | `1` = confirmed alerts on Telegram, `all` = early alerts too |
| `ALPHA_VOL_MULT` | `5` | Volume multiple vs normal |
| `ALPHA_MIN_5M_USD` / `ALPHA_MIN_TRADES` | `1000` / `10` | Minimum per 5-minute candle |
| `ALPHA_MIN_24H_USD` | `1000000` | 24h volume for the confirmed tier |
| `ALPHA_MIN_LIQUIDITY` / `ALPHA_MIN_HOLDERS` | `50000` / `1000` | Which tokens are scanned |
| `ALPHA_TARGET_PCT` / `ALPHA_STOP_PCT` / `ALPHA_OUTCOME_DAYS` | `40` / `10` / `7` | How alerts are tracked |
| `ALPHA_COST_PCT` | `1` | Costs per trade (fees + slippage) |
| `ALPHA_AI_REVIEW` | on (confirmed) | Automatic AI verdict on confirmed Alpha alerts; `all` = early ones too, `0` = none (shares `AI_REVIEWS_PER_HOUR`) |
</details>

<details>
<summary><b>Perps (futures swing signals)</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `PERPS` | on | `0` = turn the Perps tab's live scan off |
| `PERPS_TOP` | `50` | How many of the most liquid perpetuals are scanned (the backtest used 50) |
| `PERPS_COST_PCT` | `0.08` | Fee + slippage per side, in %, for the tracked results |
| `PERPS_TELEGRAM` | on | `0` = Perps signals off on Telegram by default |
| `BINANCE_FUTURES_URL` | `https://fapi.binance.com` | Another address for Binance's futures data (e.g. a proxy you run) |
</details>

<details>
<summary><b>News</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `NEWS` | on | `0` = turn the News tab off |
| `COINDESK_API_KEY` | none | Your free CoinDesk key: adds CoinDesk's news feed and its sentiment labels |
| `NEWS_AI` | on | `0` = never use Gemini for the labels (keyword rules only) |
</details>

<details>
<summary><b>Spot trend plan</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `SPOT` | on | `0` = turn the Spot plan off |
| `SPOT_TELEGRAM` | on | `0` = the switch messages off on Telegram by default |
| `SPOT_AVG_DAYS` | `50` | The average length (the test only speaks for 40-60) |
</details>

<details>
<summary><b>Scalp (perps, 5 minutes)</b></summary>

| Setting | Default | Meaning |
|---|---|---|
| `SCALP` | on | `0` = turn the Scalp section's live scan off |
| `SCALP_TELEGRAM` | on | `0` = scalp signals off on Telegram by default |
| `ONCHAIN` | on | `0` = turn the On-chain tab's live scan off |
| `ONCHAIN_TELEGRAM` | on | `0` = On-chain signals off on Telegram by default |
| `ONCHAIN_SIDES` | `long,short` | Which On-chain setups are signals (`long` = only his setup) |
| `ONCHAIN_CROWD_SHORT` / `ONCHAIN_SMART_LONG` | `0.5` / `1.2` | The long setup: crowd account ratio at or under, top-trader position ratio at or over (the test only speaks for these defaults) |
| `ONCHAIN_CROWD_LONG_PCT` / `ONCHAIN_SMART_SHORT` | `90` / `1` | The short setup: the crowd's 30-day percentile at or over, top-trader ratio at or under |
| `SCALP_MIN_DROP_ATR` / `SCALP_MIN_VOLUME_RATIO` / `SCALP_MIN_ATR_PCT` | `2.5` / `4` / `0.6` | The flush bounce rule (the test only speaks for these defaults) |
| `SCALP_COST_PCT` | `0.12` | Fees + slippage per trade (in and out), in %, for the tracked results |
| `SCALP_PAPER_START` / `SCALP_PAPER_RISK_PCT` / `SCALP_PAPER_LEVERAGE` / `SCALP_PAPER_MAX_OPEN` | `100` / `1` / `5` / `3` | The paper bot's first account (change them later on the page with "Reset paper account") |
| `HEALTH_TELEGRAM` | on | `0` = no Telegram warning when a part stops working |
| `SCALP_BOT_TELEGRAM` | on | `0` = the paper bot's closed-trade messages off on Telegram by default |
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
| `WHALES_RPC` | 8 free public nodes (the ones that worked in Nov 2026 first) | Your own Ethereum node URL(s), comma-separated, best first (a free Alchemy or Infura key is steadier; see Troubleshooting) |
| `WHALES_BLOCKSCOUT` | `https://eth.blockscout.com` | Where unknown addresses are named |
| `ETHERSCAN_API_KEY` | — | Free key (etherscan.io/myapikey): when Blockscout fails or is blocked, contracts are named from Etherscan's verified contract names |
| `WHALESIG` / `WHALESIG_TELEGRAM` | on / off | Whale signals (see [6.15](#615-whale-signals-take--leave-from-whale-wallets)) |
| `WHALESIG_WALLETS` / `WHALESIG_MIN_ACCOUNT` / `WHALESIG_MAX_TURNOVER` | `200` / `1000000` / `300` | How many Hyperliquid accounts are followed, their smallest account in $, and the 30-day volume / account above which an account counts as a market maker |
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
<summary><b>Telegram: the test message arrives, but no signals</b></summary>

Telegram works; the rules are holding the signals back. Open the Ignition tab and press the **Telegram** tag:
- The status line says why Ignition is quiet now, for example "0 coins ignited, 3 heating up; most are waiting for: price above its 20-day average". In a falling market, Ignition waits on purpose (those moves lost money in the tests).
- The **delivery log** lists every signal that was found but **held back**, with the reason: "quality gate failed: big trades", "only TAKE goes to Telegram (this one is WAIT)", "market mood is WEAK", or "this kind is switched off".
- Check that the kind you want is ticked in the list of switches (your choice is saved).
</details>

<details>
<summary><b>Telegram: nothing arrives, not even the test message</b></summary>

The Telegram section and the status bar say what is wrong in plain words. The usual causes:
- **Token or chat id:** the token looks like `123456789:AAH...`, with nothing before or after it. Open your bot in Telegram and press **Start** once. A group id starts with `-100`; if your group was upgraded, Telegram gives it a new id and the app tells you which one to use.
- **.env:** if a `TELEGRAM_` line appears twice, the last one is used. Quotes are fine: `TELEGRAM_BOT_TOKEN="123:abc"  # my bot`.
- **VPN or proxy:** Node.js does not use the Windows proxy setting. Switch the VPN to full-tunnel (TUN) mode, or run `set HTTPS_PROXY=http://127.0.0.1:PORT` and start with `node --use-env-proxy server.js`.
- **Antivirus HTTPS scanning or a wrong PC clock** ("certificate" in the error): fix the clock, exclude api.telegram.org from scanning, or start with `node --use-system-ca server.js`.
</details>

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
<summary><b>Perps tab (swing or scalp): "HTTP 451" or "access blocked"</b></summary>

Binance blocks its futures API in some countries. The Perps tab (swing signals and the Scalp section) then shows the error and no signals, but the backtest table still works (it uses Binance's public archive, which is not blocked).

- Use a VPN on the computer that runs the app, then restart it.
- Or point `BINANCE_FUTURES_URL` in `.env` to a proxy you run in an allowed country.
- Spot-based tabs (Ignition, Early 2x…) are not affected.
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

Check that `.env` is in the project folder (next to `server.js`), that the line is `GEMINI_API_KEY=...` with no spaces or quotes and **a key after the `=`** (an empty `GEMINI_API_KEY=` line means no AI), and restart. No Gemini key? Use a [free open-source model](#free-open-source-ai-instead-of-gemini) instead.
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
npm run build
```

Then restart the app (`npm start`). Your settings (`.env`), alert history and caches are not in git, so an update never touches them.

If git says *"Your local changes to the following files would be overwritten"*, those are usually files the app writes while it runs. They are ignored by git now; move or delete the files git lists and run the merge again.

---

## 12. For developers

**Tests** (no internet or API key needed):

```bash
npm test
```

They cover the signal rules, outcome tracking, AI safety rules, the AI committee (with a fake Gemini: who is asked and in what order, what each member sees, thinking settings per model, the debate, the Final Boss overturning either way and the code turning an unsafe YES into WATCH, news hard stops, unverified news, the fast NO, the boss's confidence cap and audit list, the 1% liquidity test, resistance from swing highs and EMAs), the AI track record (following answers with their plans, the scorecard, WAIT triggers, the daily limit), the big-move tier, the Pump watch (the rule, its exit, market mood, and the daily list end to end with a fake Binance), the Scalp section (the flush bounce, its exit, and the live scan end to end with a fake Binance futures API), the Scalp paper bot (position size, margin cap, opening and closing trades after fees), the Spot plan (the trend rule, the simulation, the daily plan with its switch messages, and the all-coins check), the News tab (the sources, merging one story from several sites, the labels and the mood), Early 2x scoring and tracking, BTC rotation, Binance Alpha, perps, the alternative exit rules and the trade journal.

**Run the screener alone:** `node screener.js` (port 3001).

**Next.js + TypeScript (Nov 2026).** Every page is React + TypeScript, served by Next.js (App Router):

| Command | What it runs |
|---|---|
| `npm run build`, then `npm start` | The app (production): the engine and every page on one port |
| `npm run dev` | The same with live reload while you change the pages |
| `npm run start:classic` (`node server.js`) | The classic HTML pages without Next.js (a fallback for now; Node 18+) |
| `npm run typecheck` | TypeScript check of the pages and `next-server.ts` |

How it fits together: `next-server.ts` runs one Node server on one port. Every `/api` route and every scanner come from the engine in `server.js` (`createHandler()` and `startServices()`). The pages are in `src/app`: `/` (Market Flow, `src/components/market-flow/`), `/screener` (`src/components/screener/`: `ScreenerShell.tsx` is the page around the tabs: the tab bar, the status bar, the section tags, the alert popups and the setup detail window; each tab is its own folder, loaded when it is opened) and `/ai` (`src/components/ai-desk/`). The tab is picked by the address (`/screener#perps`), as before, so old links still work. The API is typed in `src/lib/api.ts` and the tabs' own files. The classic HTML pages in `public/` are kept as a fallback (`/screener-classic` shows the classic screener next to the React one) and can be removed once the React pages have proven themselves.

Next.js needs a server that runs all the time (the scanners never stop), so it cannot run on Vercel-style serverless hosting. Binance also blocks US servers (error 451): host it on a VPS or container outside the US.

**graphify (fewer tokens for Claude Code).** [graphify](https://github.com/Graphify-Labs/graphify) keeps a knowledge graph of the code in `graphify-out/` (functions, imports and calls, from the code itself, no API cost). `CLAUDE.md` tells Claude Code to ask the graph (`graphify query`, `explain`, `path`) before reading source files, which cuts the tokens a codebase question costs (measured here: about 19x fewer for a question about the Liquidity heatmap). Set it up once per PC: `pip install graphifyy`, `graphify install` (the `/graphify` skill for Claude Code), and in this repo `graphify hook install` (rebuilds the graph after every commit, checkout, merge and rebase) and `graphify update .` (the first build, about 10 seconds). `graphify-out/` is not committed.

**Project files:**

| File | What it is |
|---|---|
| `server.js` | Starts everything; Market Flow Radar and the web pages; exports the handler and start-up for `next-server.ts` |
| `next-server.ts`, `src/` | The Next.js + TypeScript server and every page in React (see above) |
| `live-klines.js` | Live 5-minute candles from Binance's WebSocket stream for the Ignition scanner |
| `whale-signals.js` | Whale signals: Hyperliquid whales' positions + Ethereum / DEX flows + Binance crowd -> TAKE / LEAVE |
| `ai-provider.js` | Free open-source AI (Ollama, Groq, OpenRouter, Cerebras, any OpenAI-compatible server) behind the same call as Gemini |
| `screener.js` | Ignition screener, big-move tier, BTC rotation wiring, shared helpers |
| `alpha.js` | Binance Alpha ignition |
| `exits.js` | Alternative exit rules, alert speed, condition groups and AI checks on live alerts |
| `journal.js` | Your trade journal ("I took it") |
| `early2x.js` | Early 2x movers |
| `whales.js`, `flows.js` | Whale tracker (transfers, names, learned exchange addresses, Ethereum DEX swaps) and DEX flows |
| `rotation.js` | BTC regimes, narratives, alt season meter, forward record |
| `perps.js`, `perps-history.js` | Perpetual futures swing setups, exits with fees and funding, verdicts (shared by the backtest and the Perps tab), and the Binance archive downloader |
| `perps-live.js` | The Perps tab: live scan after each 4h close, TAKE / WAIT / SKIP, tracking, check a trade |
| `health.js` | The system status bar: each part working / warning / not working / off, and the Telegram warnings |
| `news.js` | News tab: Google News, Binance announcements and CoinDesk, merged and ranked, labelled bullish / bearish / neutral, and the news mood |
| `spot-trend.js` | Spot plan: the BTC + ETH 50-day trend rule and its simulation (shared with `spot-backtest.js`), the daily plan and the all-coins check |
| `paper-bot.js` | The Scalp paper bot: account, position size from the risk, margin check, trades from the scalp signals, and the broker part a real account would replace |
| `scalp.js` | Scalp (in the Perps tab): the flush bounce on 5-minute candles and its exit (shared with `scalp-backtest.js`), and the live scan after each 5-minute close |
| `pump.js` | Pump watch: the daily rule, its exit and market mood (shared with `pump-backtest.js`), and the live daily list |
| `ai-trade.js`, `ai-committee.js`, `ai-tracker.js`, `agent.js` | AI desk (data, the committee's prompts, code checks, track record, WAIT triggers, daily limit) and the AI market brief (Gemini) |
| `telegram.js` | Telegram delivery queue (retries, switches, daily check-in) and diagnostics |
| `public/` | The classic web pages (`index.html`, `screener.html`, `ai.html`, `liquidity-tab.js`): the fallback for `npm run start:classic` |
| `*-backtest.js` | Replay tests (see [Backtests](#8-backtests-and-replays)) |
| `data/` | Wallet labels and your token unlock / catalyst list |

Files the app writes while running (`*_state.json`, `*_cache/`, `*_report.json`, `rotation_record.json`, `journal.json`, `whales_names.json`, `perps_state.json`, `scalp_state.json`, `spot_state.json`, `pump_state.json`, `whalesig_state.json`, `ai_calls.json`, and Next.js's `.next/`) are kept out of git.

---

## Disclaimer

The scores, alerts and AI analyses are tools for research, not financial advice. A high score means buyers are aggressive right now; it does not mean the price will keep rising. Always check the chart, size your position so a loss is small, and decide for yourself. This app never places trades.

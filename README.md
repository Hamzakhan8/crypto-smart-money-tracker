# Market Flow Radar

A no-dependency Node.js dashboard that ranks liquid Binance USDT spot pairs using transparent market-flow heuristics.

## Run

Requires Node.js 18+.

```bash
node server.js
```

Open http://localhost:3000

Optional environment variables:

- `PORT=3000`
- `HOST=127.0.0.1` (use `0.0.0.0` only when you intentionally want external access)
- `POLL_SECONDS=30` (minimum 15 seconds)
- `MAX_SYMBOLS=40` (10–60)
- `MIN_QUOTE_VOLUME=1000000`
- `DEMO=1` (simulated data only; dashboard labels it as demo)
- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_CHAT_ID=...`

## What the score means

The score is a transparent heuristic based on 5-minute taker-buy imbalance, latest 1-minute volume relative to up to 20 prior closed 1-minute candles, short-term price response, trade count, and 24-hour liquidity. It is not machine learning, not proof of whale identity, and not a guaranteed predictive signal. Use it to prioritize further investigation, not as an automatic buy signal.

## Data caveats

- Binance kline taker-buy quote volume is used to estimate aggressive buyer activity; it is not a complete tick-level CVD feed.
- The latest 1-minute candle may still be forming.
- The public Binance Web3 endpoint is unofficial/undocumented from this code's perspective and may be blocked, change schema, or return fields that cannot be reliably normalized. The app surfaces errors instead of silently pretending the feed is valid.
- This is a read-only research dashboard; it does not place orders.
- Telegram alerts are optional and fire when a symbol crosses into score >= 75, with a 15-minute per-symbol cooldown.

## Endpoints

- `/api/signals` current dashboard payload
- `/api/health` status and errors

package com.smartmoney.engine.exchange

import com.smartmoney.engine.model.BookLevel
import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.Instrument
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.OpenInterestPoint
import com.smartmoney.engine.model.OrderBook
import com.smartmoney.engine.model.Ticker
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.net.ExchangeException
import com.smartmoney.engine.net.HttpGet
import com.smartmoney.engine.net.RateLimitedException
import com.smartmoney.engine.net.RateLimiter
import com.smartmoney.engine.stream.StreamEvent
import com.smartmoney.engine.stream.StreamProtocol
import com.smartmoney.engine.util.J
import com.smartmoney.engine.util.get
import kotlinx.serialization.json.JsonElement
import java.net.URLEncoder

/**
 * Bybit V5, public endpoints (docs read 2026-11-12: bybit-exchange.github.io/docs/v5/market pages, v5/ws/connect,
 * v5/websocket/public/kline, v5/rate-limit). Spot = category spot; perps = category linear, LinearPerpetual settled in
 * USDT, crypto only (symbolType "" or "innovation"; stocks, ETFs, commodities and forex are left out).
 * Limits: 600 requests / 5 s per IP; a breach returns HTTP 403 and blocks the IP for 10 minutes.
 */
class BybitAdapter(
    private val http: HttpGet,
    private val baseUrl: String = "https://api.bybit.com",
    private val limiter: RateLimiter = RateLimiter(minIntervalMs = 25),
) : ExchangeAdapter {
    override val exchange = Exchange.BYBIT
    override val maxCandlesPerRequest = 1000

    private suspend fun call(path: String): JsonElement {
        val r = fetch(http, limiter, baseUrl + path, exchange)
        if (r.code == 403) {
            limiter.pause(BAN_MS)
            throw RateLimitedException("Bybit: HTTP 403 (too many requests, or Bybit is blocked in this region); waiting 10 min", BAN_MS, 403)
        }
        val j = try {
            J.parse(r.body)
        } catch (e: Exception) {
            throw ExchangeException("Bybit: unreadable response (HTTP ${r.code})", r.code)
        }
        val code = J.long(j["retCode"]) ?: throw ExchangeException("Bybit: HTTP ${r.code}", r.code)
        if (code != 0L) {
            if (code == 10006L || code == 10018L) {
                limiter.pause(60_000)
                throw RateLimitedException("Bybit: rate limit (retCode $code), pausing 60 s", 60_000, r.code)
            }
            throw ExchangeException("Bybit: ${J.str(j["retMsg"]) ?: "error"} (retCode $code)", r.code, code.toString())
        }
        return j
    }

    override suspend fun instruments(market: Market): List<Instrument> {
        if (market == Market.SPOT) return Parse.instruments(call("/v5/market/instruments-info?category=spot"), market)
        val out = ArrayList<Instrument>()
        var cursor: String? = null
        repeat(10) {
            val q = "/v5/market/instruments-info?category=linear&limit=1000" + (cursor?.let { "&cursor=" + enc(it) } ?: "")
            val j = call(q)
            out += Parse.instruments(j, market)
            cursor = J.str(j["result"]["nextPageCursor"])
            if (cursor == null) return out
        }
        return out
    }

    override suspend fun tickers(market: Market): List<Ticker> = Parse.tickers(call("/v5/market/tickers?category=${cat(market)}"))

    override suspend fun candles(instrument: Instrument, timeframe: Timeframe, limit: Int, endTime: Long?): List<Candle> {
        val q = "/v5/market/kline?category=${cat(instrument.market)}&symbol=${instrument.nativeSymbol}&interval=${interval(timeframe)}" +
            "&limit=${limit.coerceIn(1, maxCandlesPerRequest)}" + (endTime?.let { "&end=$it" } ?: "")
        return Parse.candles(call(q), timeframe)
    }

    override suspend fun openInterestHistory(instrument: Instrument, limit: Int): List<OpenInterestPoint> =
        Parse.openInterest(call("/v5/market/open-interest?category=linear&symbol=${instrument.nativeSymbol}&intervalTime=5min&limit=${limit.coerceIn(1, 200)}"))

    override suspend fun orderBook(instrument: Instrument): OrderBook =
        Parse.orderBook(call("/v5/market/orderbook?category=${cat(instrument.market)}&symbol=${instrument.nativeSymbol}&limit=200"))

    override fun streamProtocol(market: Market): StreamProtocol = Stream(market)

    class Stream(private val market: Market) : StreamProtocol {
        override val url = "wss://stream.bybit.com/v5/public/${cat(market)}"
        override val topicsPerRequest = 10 // spot rejects more than 10 args per request
        override val maxTopicsPerConnection = 50 // docs: "up to 100 args for a single connection (TBD)"
        override val minSendIntervalMs = 100L
        override val pingIntervalMs: Long? = 20_000L // docs recommend a ping every 20 s
        override fun pingMessage() = """{"op":"ping"}"""
        override val idleTimeoutMs = 60_000L
        override val maxConnectionAgeMs: Long? = null

        override fun subscribeMessages(nativeSymbols: List<String>, timeframe: Timeframe): List<String> =
            nativeSymbols.chunked(topicsPerRequest).mapIndexed { i, chunk ->
                val args = chunk.joinToString(",") { "\"kline.${interval(timeframe)}.$it\"" }
                """{"req_id":"sub$i","op":"subscribe","args":[$args]}"""
            }

        override fun parse(text: String): StreamEvent = Parse.stream(text)
    }

    /** Pure parsers, tested on recorded Bybit responses. */
    object Parse {
        fun instruments(j: JsonElement, market: Market): List<Instrument> = J.arr(j["result"]["list"]).orEmpty().mapNotNull { e ->
            val sym = J.str(e["symbol"]) ?: return@mapNotNull null
            val rawBase = J.str(e["baseCoin"]) ?: return@mapNotNull null
            val quote = J.str(e["quoteCoin"]) ?: return@mapNotNull null
            val type = J.str(e["symbolType"]) ?: ""
            val trading = J.str(e["status"]) == "Trading"
            if (market == Market.SPOT) {
                if (type == "xstocks") return@mapNotNull null
                Instrument(Exchange.BYBIT, market, sym, rawBase, quote, trading)
            } else {
                if (J.str(e["contractType"]) != "LinearPerpetual" || J.str(e["settleCoin"]) != "USDT") return@mapNotNull null
                if (type != "" && type != "innovation") return@mapNotNull null
                val (base, mult) = Symbols.perpBase(rawBase)
                Instrument(Exchange.BYBIT, market, sym, base, quote, trading, priceMultiplier = mult)
            }
        }

        fun tickers(j: JsonElement): List<Ticker> {
            val time = J.long(j["time"]) ?: 0L
            return J.arr(j["result"]["list"]).orEmpty().mapNotNull { e ->
                val sym = J.str(e["symbol"]) ?: return@mapNotNull null
                val last = J.num(e["lastPrice"]) ?: return@mapNotNull null
                Ticker(
                    nativeSymbol = sym, last = last, bid = J.num(e["bid1Price"]), ask = J.num(e["ask1Price"]),
                    quoteVolume24h = J.num(e["turnover24h"]), change24hPct = J.num(e["price24hPcnt"]),
                    markPrice = J.num(e["markPrice"]), fundingRate = J.num(e["fundingRate"]),
                    nextFundingTime = J.long(e["nextFundingTime"])?.takeIf { it > 0 },
                    // Since 2026-06 "openInterest" counts both sides; "singleOpenInterest" is one side, like other exchanges.
                    openInterest = J.num(e["singleOpenInterest"]) ?: J.num(e["openInterest"]),
                    time = time,
                )
            }
        }

        /** Bybit lists newest first and includes the candle in progress without a flag: it is closed once its period has ended. */
        fun candles(j: JsonElement, timeframe: Timeframe): List<Candle> {
            val serverTime = J.long(j["time"]) ?: System.currentTimeMillis()
            return J.arr(j["result"]["list"]).orEmpty().mapNotNull { r ->
                val t = J.long(r[0]) ?: return@mapNotNull null
                Candle(
                    openTime = t, open = J.num(r[1]) ?: return@mapNotNull null, high = J.num(r[2]) ?: return@mapNotNull null,
                    low = J.num(r[3]) ?: return@mapNotNull null, close = J.num(r[4]) ?: return@mapNotNull null,
                    baseVolume = J.num(r[5]) ?: 0.0, quoteVolume = J.num(r[6]),
                    closed = t + timeframe.millis <= serverTime,
                )
            }.sortedBy { it.openTime }
        }

        fun openInterest(j: JsonElement): List<OpenInterestPoint> = J.arr(j["result"]["list"]).orEmpty().mapNotNull { e ->
            val t = J.long(e["timestamp"]) ?: return@mapNotNull null
            val v = J.num(e["singleOpenInterest"]) ?: J.num(e["openInterest"]) ?: return@mapNotNull null
            OpenInterestPoint(t, v)
        }.sortedBy { it.time }

        fun orderBook(j: JsonElement): OrderBook {
            val r = j["result"]
            fun side(k: String) = J.arr(r[k]).orEmpty().mapNotNull { l ->
                val p = J.num(l[0]) ?: return@mapNotNull null
                val q = J.num(l[1]) ?: return@mapNotNull null
                BookLevel(p, q)
            }
            return OrderBook(side("b"), side("a"), J.long(r["ts"]) ?: J.long(j["time"]) ?: 0L)
        }

        fun stream(text: String): StreamEvent {
            val j = J.parse(text)
            val op = J.str(j["op"])
            if (op != null) {
                val ok = J.bool(j["success"]) ?: true
                val msg = J.str(j["ret_msg"]) ?: ""
                return when {
                    op == "pong" || msg == "pong" -> StreamEvent.Pong
                    !ok -> StreamEvent.Error(msg)
                    op == "subscribe" -> StreamEvent.Ack("subscribed")
                    else -> StreamEvent.Ignored
                }
            }
            val topic = J.str(j["topic"]) ?: return StreamEvent.Ignored
            if (!topic.startsWith("kline.")) return StreamEvent.Ignored
            val parts = topic.split(".")
            if (parts.size != 3) throw IllegalArgumentException("bad topic $topic")
            val tf = timeframeOf(parts[1]) ?: return StreamEvent.Ignored
            val candles = J.arr(j["data"]) ?: throw IllegalArgumentException("kline without data")
            val list = candles.map { d ->
                Candle(
                    openTime = J.long(d["start"]) ?: throw IllegalArgumentException("no start"),
                    open = J.num(d["open"]) ?: throw IllegalArgumentException("no open"),
                    high = J.num(d["high"]) ?: throw IllegalArgumentException("no high"),
                    low = J.num(d["low"]) ?: throw IllegalArgumentException("no low"),
                    close = J.num(d["close"]) ?: throw IllegalArgumentException("no close"),
                    baseVolume = J.num(d["volume"]) ?: 0.0, quoteVolume = J.num(d["turnover"]),
                    closed = J.bool(d["confirm"]) ?: false,
                )
            }
            return StreamEvent.CandleUpdate(parts[2], tf, list, J.long(j["ts"]))
        }
    }

    companion object {
        const val BAN_MS = 10 * 60_000L
        fun cat(m: Market) = if (m == Market.SPOT) "spot" else "linear"
        fun interval(tf: Timeframe) = when (tf) {
            Timeframe.M1 -> "1"
            Timeframe.M5 -> "5"
            Timeframe.M15 -> "15"
            Timeframe.H1 -> "60"
        }

        fun timeframeOf(interval: String): Timeframe? = Timeframe.entries.firstOrNull { interval(it) == interval }
        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
    }
}

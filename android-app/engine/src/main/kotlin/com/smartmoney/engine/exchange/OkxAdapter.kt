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
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement

/**
 * OKX API v5, public endpoints (docs read 2026-11-12: www.okx.com/docs-v5/en/). Spot = instType SPOT quoted in USDT;
 * perps = instType SWAP, linear, settled in USDT, crypto only (instCategory 1; stocks and commodities left out).
 * Candles stream on the "business" WebSocket endpoint, not "public". Each REST endpoint has its own limit per 2 s per
 * IP, so each gets its own pacing below.
 */
class OkxAdapter(
    private val http: HttpGet,
    private val baseUrl: String = "https://www.okx.com",
) : ExchangeAdapter {
    override val exchange = Exchange.OKX
    override val maxCandlesPerRequest = 300

    // Pacing per endpoint, under the documented "N requests per 2 seconds" limits.
    private val fast = RateLimiter(60) // candles, books: 40 / 2 s
    private val normal = RateLimiter(110) // instruments, tickers, open-interest: 20 / 2 s
    private val slow = RateLimiter(220) // mark-price, funding-rate, rubik OI history: 10 / 2 s

    private suspend fun call(path: String, limiter: RateLimiter): JsonElement {
        val r = fetch(http, limiter, baseUrl + path, exchange)
        val j = try {
            J.parse(r.body)
        } catch (e: Exception) {
            throw ExchangeException("OKX: unreadable response (HTTP ${r.code})", r.code)
        }
        val code = J.str(j["code"]) ?: throw ExchangeException("OKX: HTTP ${r.code}", r.code)
        if (code != "0") {
            if (code == "50011" || code == "50013") {
                limiter.pause(5_000)
                throw RateLimitedException("OKX: rate limit (code $code), pausing 5 s", 5_000, r.code)
            }
            throw ExchangeException("OKX: ${J.str(j["msg"]) ?: "error"} (code $code)", r.code, code)
        }
        return j
    }

    override suspend fun instruments(market: Market): List<Instrument> =
        Parse.instruments(call("/api/v5/public/instruments?instType=${type(market)}", normal), market)

    override suspend fun tickers(market: Market): List<Ticker> {
        val tickers = Parse.tickers(call("/api/v5/market/tickers?instType=${type(market)}", normal), market)
        if (market == Market.SPOT) return tickers
        // Perps: mark price, funding and open interest come from three more bulk endpoints. A failing one leaves its
        // field null (shown as n/a) instead of failing the tickers.
        val marks = optional { Parse.markPrices(call("/api/v5/public/mark-price?instType=SWAP", slow)) } ?: emptyMap()
        val funding = optional { Parse.funding(call("/api/v5/public/funding-rate?instId=ANY", slow)) } ?: emptyMap()
        val oi = optional { Parse.openInterestNow(call("/api/v5/public/open-interest?instType=SWAP", normal)) } ?: emptyMap()
        return tickers.map { t ->
            val f = funding[t.nativeSymbol]
            t.copy(markPrice = marks[t.nativeSymbol], fundingRate = f?.first, nextFundingTime = f?.second, openInterest = oi[t.nativeSymbol])
        }
    }

    override suspend fun candles(instrument: Instrument, timeframe: Timeframe, limit: Int, endTime: Long?): List<Candle> {
        val q = "/api/v5/market/candles?instId=${instrument.nativeSymbol}&bar=${bar(timeframe)}&limit=${limit.coerceIn(1, maxCandlesPerRequest)}" +
            (endTime?.let { "&after=${it + 1}" } ?: "")
        return Parse.candles(call(q, fast), instrument.market)
    }

    override suspend fun openInterestHistory(instrument: Instrument, limit: Int): List<OpenInterestPoint> =
        Parse.openInterestHistory(
            call("/api/v5/rubik/stat/contracts/open-interest-history?instId=${instrument.nativeSymbol}&period=5m&limit=${limit.coerceIn(1, 100)}", slow),
        )

    override suspend fun orderBook(instrument: Instrument): OrderBook =
        Parse.orderBook(call("/api/v5/market/books?instId=${instrument.nativeSymbol}&sz=400", fast), instrument.contractValue)

    override fun streamProtocol(market: Market): StreamProtocol = Stream

    private suspend fun <T> optional(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: RateLimitedException) {
        throw e
    } catch (e: Exception) {
        null
    }

    object Stream : StreamProtocol {
        override val url = "wss://ws.okx.com/ws/v5/business" // candle channels live on "business" (port 443)
        override val topicsPerRequest = 20
        override val maxTopicsPerConnection = 50
        override val minSendIntervalMs = 200L // 480 subscribe requests per hour per connection
        override val pingIntervalMs: Long? = 20_000L // server drops a connection idle for 30 s
        override fun pingMessage() = "ping"
        override val idleTimeoutMs = 40_000L
        override val maxConnectionAgeMs: Long? = null

        override fun subscribeMessages(nativeSymbols: List<String>, timeframe: Timeframe): List<String> =
            nativeSymbols.chunked(topicsPerRequest).mapIndexed { i, chunk ->
                val args = chunk.joinToString(",") { """{"channel":"candle${bar(timeframe)}","instId":"$it"}""" }
                """{"id":"sub$i","op":"subscribe","args":[$args]}"""
            }

        override fun parse(text: String): StreamEvent = Parse.stream(text)
    }

    /** Pure parsers, tested on recorded OKX responses. */
    object Parse {
        fun instruments(j: JsonElement, market: Market): List<Instrument> = J.arr(j["data"]).orEmpty().mapNotNull { e ->
            val id = J.str(e["instId"]) ?: return@mapNotNull null
            val category = J.str(e["instCategory"])
            if (category != null && category != "1") return@mapNotNull null // 1 = crypto; 3 = stocks, 4 = commodities
            val trading = J.str(e["state"]) == "live" && J.str(e["ruleType"]).let { it == null || it == "normal" }
            if (market == Market.SPOT) {
                val base = J.str(e["baseCcy"]) ?: return@mapNotNull null
                val quote = J.str(e["quoteCcy"]) ?: return@mapNotNull null
                Instrument(Exchange.OKX, market, id, base, quote, trading)
            } else {
                if (J.str(e["ctType"]) != "linear" || J.str(e["settleCcy"]) != "USDT") return@mapNotNull null
                val rawBase = J.str(e["ctValCcy"]) ?: J.str(e["uly"])?.substringBefore("-") ?: return@mapNotNull null
                val quote = J.str(e["uly"])?.substringAfter("-", "USDT") ?: "USDT"
                val (base, mult) = Symbols.perpBase(rawBase)
                Instrument(Exchange.OKX, market, id, base, quote, trading, contractValue = J.num(e["ctVal"]), priceMultiplier = mult)
            }
        }

        fun tickers(j: JsonElement, market: Market): List<Ticker> = J.arr(j["data"]).orEmpty().mapNotNull { e ->
            val id = J.str(e["instId"]) ?: return@mapNotNull null
            val last = J.num(e["last"]) ?: return@mapNotNull null
            val open = J.num(e["open24h"])
            val volCcy = J.num(e["volCcy24h"])
            Ticker(
                nativeSymbol = id, last = last, bid = J.num(e["bidPx"]), ask = J.num(e["askPx"]),
                // SPOT volCcy24h is quote (USDT); SWAP volCcy24h is the base coin, so USDT volume is approximated x last.
                quoteVolume24h = if (market == Market.SPOT) volCcy else volCcy?.let { it * last },
                change24hPct = open?.takeIf { it > 0 }?.let { last / it - 1 },
                time = J.long(e["ts"]) ?: 0L,
            )
        }

        fun markPrices(j: JsonElement): Map<String, Double> = J.arr(j["data"]).orEmpty().mapNotNull { e ->
            val id = J.str(e["instId"]) ?: return@mapNotNull null
            val p = J.num(e["markPx"]) ?: return@mapNotNull null
            id to p
        }.toMap()

        /** instId -> (current funding rate, time it settles). Only SWAP rows (ANY also returns X-Perp futures). */
        fun funding(j: JsonElement): Map<String, Pair<Double, Long?>> = J.arr(j["data"]).orEmpty().mapNotNull { e ->
            if (J.str(e["instType"]) != "SWAP") return@mapNotNull null
            val id = J.str(e["instId"]) ?: return@mapNotNull null
            val rate = J.num(e["fundingRate"]) ?: return@mapNotNull null
            id to (rate to J.long(e["fundingTime"]))
        }.toMap()

        /** instId -> open interest in coins (oiCcy). */
        fun openInterestNow(j: JsonElement): Map<String, Double> = J.arr(j["data"]).orEmpty().mapNotNull { e ->
            val id = J.str(e["instId"]) ?: return@mapNotNull null
            val v = J.num(e["oiCcy"]) ?: return@mapNotNull null
            id to v
        }.toMap()

        /** Rows [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm], newest first; confirm "1" = closed. */
        fun candles(j: JsonElement, market: Market): List<Candle> = J.arr(j["data"]).orEmpty().mapNotNull { row(it, market) }.sortedBy { it.openTime }

        private fun row(r: JsonElement, market: Market): Candle? {
            val t = J.long(r[0]) ?: return null
            return Candle(
                openTime = t, open = J.num(r[1]) ?: return null, high = J.num(r[2]) ?: return null,
                low = J.num(r[3]) ?: return null, close = J.num(r[4]) ?: return null,
                // SPOT vol is in the base coin; SWAP vol is in contracts and volCcy is the base coin.
                baseVolume = (if (market == Market.SPOT) J.num(r[5]) else J.num(r[6])) ?: 0.0,
                quoteVolume = J.num(r[7]),
                closed = J.str(r[8]) == "1",
            )
        }

        /** Rubik rows [ts, oi (contracts), oiCcy (coins), oiUsd], newest first. */
        fun openInterestHistory(j: JsonElement): List<OpenInterestPoint> = J.arr(j["data"]).orEmpty().mapNotNull { r ->
            val t = J.long(r[0]) ?: return@mapNotNull null
            val v = J.num(r[2]) ?: return@mapNotNull null
            OpenInterestPoint(t, v)
        }.sortedBy { it.time }

        /** Levels [px, sz, "0", orders]; swap sizes are contracts, converted to coins with ctVal. */
        fun orderBook(j: JsonElement, contractValue: Double?): OrderBook {
            val d = J.arr(j["data"])?.firstOrNull()
            val mult = contractValue ?: 1.0
            fun side(k: String) = J.arr(d[k]).orEmpty().mapNotNull { l ->
                val p = J.num(l[0]) ?: return@mapNotNull null
                val q = J.num(l[1]) ?: return@mapNotNull null
                BookLevel(p, q * mult)
            }
            return OrderBook(side("bids"), side("asks"), J.long(d["ts"]) ?: 0L)
        }

        fun stream(text: String): StreamEvent {
            if (text == "pong") return StreamEvent.Pong
            val j = J.parse(text)
            when (J.str(j["event"])) {
                "subscribe" -> return StreamEvent.Ack("subscribed")
                "error" -> return StreamEvent.Error("${J.str(j["code"]) ?: ""} ${J.str(j["msg"]) ?: ""}".trim())
                null -> Unit
                else -> return StreamEvent.Ignored // notices (e.g. 64010 port retirement), unsubscribe, ...
            }
            val channel = J.str(j["arg"]["channel"]) ?: return StreamEvent.Ignored
            if (!channel.startsWith("candle")) return StreamEvent.Ignored
            val tf = Timeframe.entries.firstOrNull { "candle${bar(it)}" == channel } ?: return StreamEvent.Ignored
            val inst = J.str(j["arg"]["instId"]) ?: throw IllegalArgumentException("candle without instId")
            val market = if (inst.endsWith("-SWAP")) Market.PERP else Market.SPOT
            val data = J.arr(j["data"]) ?: throw IllegalArgumentException("candle without data")
            val list = data.map { row(it, market) ?: throw IllegalArgumentException("bad candle row") }
            return StreamEvent.CandleUpdate(inst, tf, list, null)
        }
    }

    companion object {
        fun type(m: Market) = if (m == Market.SPOT) "SPOT" else "SWAP"
        fun bar(tf: Timeframe) = when (tf) {
            Timeframe.M1 -> "1m"
            Timeframe.M5 -> "5m"
            Timeframe.M15 -> "15m"
            Timeframe.H1 -> "1H"
        }
    }
}

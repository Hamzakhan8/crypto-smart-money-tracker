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
import com.smartmoney.engine.net.HttpResponse
import com.smartmoney.engine.net.RateLimiter
import com.smartmoney.engine.stream.StreamEvent
import com.smartmoney.engine.stream.StreamProtocol
import com.smartmoney.engine.util.J
import com.smartmoney.engine.util.get
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Binance spot (api.binance.com) and USD-M futures (fapi.binance.com), public endpoints. Docs read 2026-11-12 at
 * developers.binance.com (spot rest-api market data and ws-streams; USD-M rest-api, websocket-market-streams,
 * change-log). Perps = PERPETUAL contracts quoted in USDT (TRADIFI_PERPETUAL stock / commodity contracts left out).
 * Futures candle streams moved to the routed path /market in 2026. Limits: spot 6000 weight/min, futures 2400/min;
 * HTTP 429 = slow down, 418 = IP banned, 451 = not available in this location.
 */
class BinanceAdapter(
    private val http: HttpGet,
    private val spotUrl: String = "https://api.binance.com",
    private val futuresUrl: String = "https://fapi.binance.com",
    private val spotLimiter: RateLimiter = RateLimiter(minIntervalMs = 60),
    private val futuresLimiter: RateLimiter = RateLimiter(minIntervalMs = 80),
) : ExchangeAdapter {
    override val exchange = Exchange.BINANCE
    override val maxCandlesPerRequest = 1000 // spot max; futures allows 1500

    private suspend fun call(market: Market, path: String): Pair<JsonElement, HttpResponse> {
        val spot = market == Market.SPOT
        val r = fetch(http, if (spot) spotLimiter else futuresLimiter, (if (spot) spotUrl else futuresUrl) + path, exchange)
        val j = try {
            J.parse(r.body)
        } catch (e: Exception) {
            throw ExchangeException("Binance: unreadable response (HTTP ${r.code})", r.code)
        }
        if (r.code == 451) throw ExchangeException("Binance is not available in this location", 451)
        if (r.code != 200) {
            val code = J.long(j["code"])
            throw ExchangeException("Binance: ${J.str(j["msg"]) ?: "HTTP ${r.code}"}${code?.let { " ($it)" } ?: ""}", r.code, code?.toString())
        }
        return j to r
    }

    override suspend fun instruments(market: Market): List<Instrument> = if (market == Market.SPOT) {
        Parse.spotInstruments(call(market, "/api/v3/exchangeInfo?symbolStatus=TRADING").first)
    } else {
        Parse.futuresInstruments(call(market, "/fapi/v1/exchangeInfo").first)
    }

    override suspend fun tickers(market: Market): List<Ticker> {
        if (market == Market.SPOT) return Parse.spotTickers(call(market, "/api/v3/ticker/24hr").first)
        // Futures 24hr tickers carry no bid/ask; book tickers and premium index (mark, funding) fill them in.
        val base = Parse.futuresTickers(call(market, "/fapi/v1/ticker/24hr").first)
        val books = optional { Parse.bookTickers(call(market, "/fapi/v1/ticker/bookTicker").first) } ?: emptyMap()
        val premium = optional { Parse.premiumIndex(call(market, "/fapi/v1/premiumIndex").first) } ?: emptyMap()
        return base.map { t ->
            val b = books[t.nativeSymbol]
            val p = premium[t.nativeSymbol]
            t.copy(bid = b?.first, ask = b?.second, markPrice = p?.mark, fundingRate = p?.funding, nextFundingTime = p?.nextFunding)
        }
    }

    override suspend fun candles(instrument: Instrument, timeframe: Timeframe, limit: Int, endTime: Long?): List<Candle> {
        val path = (if (instrument.market == Market.SPOT) "/api/v3/klines" else "/fapi/v1/klines") +
            "?symbol=${instrument.nativeSymbol}&interval=${interval(timeframe)}&limit=${limit.coerceIn(1, maxCandlesPerRequest)}" +
            (endTime?.let { "&endTime=${it + timeframe.millis - 1}" } ?: "")
        val (j, r) = call(instrument.market, path)
        return Parse.klines(j, timeframe, serverTime(r))
    }

    override suspend fun openInterestHistory(instrument: Instrument, limit: Int): List<OpenInterestPoint> =
        Parse.openInterestHist(call(Market.PERP, "/futures/data/openInterestHist?symbol=${instrument.nativeSymbol}&period=5m&limit=${limit.coerceIn(1, 500)}").first)

    override suspend fun orderBook(instrument: Instrument): OrderBook {
        val path = (if (instrument.market == Market.SPOT) "/api/v3/depth" else "/fapi/v1/depth") + "?symbol=${instrument.nativeSymbol}&limit=100"
        val (j, r) = call(instrument.market, path)
        return Parse.depth(j, serverTime(r))
    }

    override fun streamProtocol(market: Market): StreamProtocol = Stream(market)

    private suspend fun <T> optional(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: com.smartmoney.engine.net.RateLimitedException) {
        throw e
    } catch (e: Exception) {
        null
    }

    class Stream(private val market: Market) : StreamProtocol {
        override val url = if (market == Market.SPOT) "wss://stream.binance.com:9443/stream" else "wss://fstream.binance.com/market/stream"
        override val topicsPerRequest = 50
        override val maxTopicsPerConnection = 200 // docs allow 1024 streams per connection
        override val minSendIntervalMs = if (market == Market.SPOT) 250L else 120L // 5 / 10 incoming messages per second
        override val pingIntervalMs: Long? = null // the server pings; OkHttp answers with pongs
        override fun pingMessage(): String? = null
        override val idleTimeoutMs = 60_000L
        override val maxConnectionAgeMs: Long? = 23 * 3_600_000L // Binance closes connections after 24 h

        override fun subscribeMessages(nativeSymbols: List<String>, timeframe: Timeframe): List<String> =
            nativeSymbols.chunked(topicsPerRequest).mapIndexed { i, chunk ->
                val params = chunk.joinToString(",") { "\"${it.lowercase()}@kline_${interval(timeframe)}\"" }
                """{"method":"SUBSCRIBE","params":[$params],"id":${i + 1}}"""
            }

        override fun parse(text: String): StreamEvent = Parse.stream(text)
    }

    data class Premium(val mark: Double?, val funding: Double?, val nextFunding: Long?)

    /** Pure parsers, tested on recorded Binance responses. */
    object Parse {
        fun spotInstruments(j: JsonElement): List<Instrument> = J.arr(j["symbols"]).orEmpty().mapNotNull { e ->
            val sym = J.str(e["symbol"]) ?: return@mapNotNull null
            Instrument(
                Exchange.BINANCE, Market.SPOT, sym, J.str(e["baseAsset"]) ?: return@mapNotNull null,
                J.str(e["quoteAsset"]) ?: return@mapNotNull null, J.str(e["status"]) == "TRADING",
            )
        }

        fun futuresInstruments(j: JsonElement): List<Instrument> = J.arr(j["symbols"]).orEmpty().mapNotNull { e ->
            if (J.str(e["contractType"]) != "PERPETUAL") return@mapNotNull null // TRADIFI_PERPETUAL and dated futures left out
            val sym = J.str(e["symbol"]) ?: return@mapNotNull null
            val (base, mult) = Symbols.perpBase(J.str(e["baseAsset"]) ?: return@mapNotNull null)
            Instrument(
                Exchange.BINANCE, Market.PERP, sym, base, J.str(e["quoteAsset"]) ?: return@mapNotNull null,
                J.str(e["status"]) == "TRADING", priceMultiplier = mult,
            )
        }

        fun spotTickers(j: JsonElement): List<Ticker> = J.arr(j).orEmpty().mapNotNull { e ->
            val sym = J.str(e["symbol"]) ?: return@mapNotNull null
            val last = J.num(e["lastPrice"])?.takeIf { it > 0 } ?: return@mapNotNull null
            Ticker(
                nativeSymbol = sym, last = last, bid = J.num(e["bidPrice"])?.takeIf { it > 0 }, ask = J.num(e["askPrice"])?.takeIf { it > 0 },
                quoteVolume24h = J.num(e["quoteVolume"]), change24hPct = J.num(e["priceChangePercent"])?.let { it / 100 },
                time = J.long(e["closeTime"]) ?: 0L,
            )
        }

        fun futuresTickers(j: JsonElement): List<Ticker> = J.arr(j).orEmpty().mapNotNull { e ->
            val sym = J.str(e["symbol"]) ?: return@mapNotNull null
            val last = J.num(e["lastPrice"])?.takeIf { it > 0 } ?: return@mapNotNull null
            Ticker(
                nativeSymbol = sym, last = last, bid = null, ask = null, quoteVolume24h = J.num(e["quoteVolume"]),
                change24hPct = J.num(e["priceChangePercent"])?.let { it / 100 }, time = J.long(e["closeTime"]) ?: 0L,
            )
        }

        fun bookTickers(j: JsonElement): Map<String, Pair<Double?, Double?>> = J.arr(j).orEmpty().mapNotNull { e ->
            val sym = J.str(e["symbol"]) ?: return@mapNotNull null
            sym to (J.num(e["bidPrice"])?.takeIf { it > 0 } to J.num(e["askPrice"])?.takeIf { it > 0 })
        }.toMap()

        fun premiumIndex(j: JsonElement): Map<String, Premium> = J.arr(j).orEmpty().mapNotNull { e ->
            val sym = J.str(e["symbol"]) ?: return@mapNotNull null
            sym to Premium(J.num(e["markPrice"])?.takeIf { it > 0 }, J.num(e["lastFundingRate"]), J.long(e["nextFundingTime"])?.takeIf { it > 0 })
        }.toMap()

        /**
         * Rows [openTime, o, h, l, c, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore],
         * oldest first. The newest row can be the candle in progress: closed once its period ended by server time.
         */
        fun klines(j: JsonElement, timeframe: Timeframe, serverTime: Long): List<Candle> = J.arr(j).orEmpty().mapNotNull { r ->
            val t = J.long(r[0]) ?: return@mapNotNull null
            Candle(
                openTime = t, open = J.num(r[1]) ?: return@mapNotNull null, high = J.num(r[2]) ?: return@mapNotNull null,
                low = J.num(r[3]) ?: return@mapNotNull null, close = J.num(r[4]) ?: return@mapNotNull null,
                baseVolume = J.num(r[5]) ?: 0.0, quoteVolume = J.num(r[7]), takerBuyQuote = J.num(r[10]), trades = J.long(r[8]),
                closed = t + timeframe.millis <= serverTime,
            )
        }.sortedBy { it.openTime }

        fun openInterestHist(j: JsonElement): List<OpenInterestPoint> = J.arr(j).orEmpty().mapNotNull { e ->
            val t = J.long(e["timestamp"]) ?: return@mapNotNull null
            OpenInterestPoint(t, J.num(e["sumOpenInterest"]) ?: return@mapNotNull null)
        }.sortedBy { it.time }

        fun depth(j: JsonElement, fallbackTime: Long): OrderBook {
            fun side(k: String) = J.arr(j[k]).orEmpty().mapNotNull { l ->
                val p = J.num(l[0]) ?: return@mapNotNull null
                val q = J.num(l[1]) ?: return@mapNotNull null
                BookLevel(p, q)
            }
            return OrderBook(side("bids"), side("asks"), J.long(j["E"]) ?: fallbackTime)
        }

        fun stream(text: String): StreamEvent {
            val j = J.parse(text)
            if (j["stream"] == null) {
                if (j["id"] != null && j["result"] != null) return StreamEvent.Ack("subscribed")
                if (j["error"] != null || j["code"] != null) return StreamEvent.Error(J.str(j["error"]["msg"]) ?: J.str(j["msg"]) ?: text.take(200))
                if (j["id"] != null) return StreamEvent.Ack("ok")
                return StreamEvent.Ignored
            }
            val d = j["data"]
            if (J.str(d["e"]) != "kline") return StreamEvent.Ignored
            val k = d["k"] ?: throw IllegalArgumentException("kline without k")
            val tf = Timeframe.entries.firstOrNull { interval(it) == J.str(k["i"]) } ?: return StreamEvent.Ignored
            val c = Candle(
                openTime = J.long(k["t"]) ?: throw IllegalArgumentException("no t"),
                open = J.num(k["o"]) ?: throw IllegalArgumentException("no o"),
                high = J.num(k["h"]) ?: throw IllegalArgumentException("no h"),
                low = J.num(k["l"]) ?: throw IllegalArgumentException("no l"),
                close = J.num(k["c"]) ?: throw IllegalArgumentException("no c"),
                baseVolume = J.num(k["v"]) ?: 0.0, quoteVolume = J.num(k["q"]), takerBuyQuote = J.num(k["Q"]), trades = J.long(k["n"]),
                closed = J.bool(k["x"]) ?: false,
            )
            val sym = J.str(k["s"]) ?: J.str(d["s"]) ?: throw IllegalArgumentException("no symbol")
            return StreamEvent.CandleUpdate(sym, tf, listOf(c), J.long(d["E"]))
        }
    }

    companion object {
        fun interval(tf: Timeframe) = tf.label

        private fun httpDate(): SimpleDateFormat = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).apply { timeZone = TimeZone.getTimeZone("GMT") }

        /** Server time from the HTTP Date header (second precision), else this device's clock. */
        fun serverTime(r: HttpResponse): Long = r.header("Date")?.let {
            try {
                httpDate().parse(it)?.time
            } catch (e: Exception) {
                null
            }
        } ?: System.currentTimeMillis()
    }
}

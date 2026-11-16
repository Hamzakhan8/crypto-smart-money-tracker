package com.smartmoney.engine.exchange

import com.smartmoney.engine.FakeHttp
import com.smartmoney.engine.Fixtures
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.net.ExchangeException
import com.smartmoney.engine.net.HttpResponse
import com.smartmoney.engine.net.RateLimitedException
import com.smartmoney.engine.net.RateLimiter
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Exchange errors, rate limits and blocked regions turn into typed exceptions the feed can show and wait out. */
class AdapterErrorTest {

    @Test
    fun binanceInvalidSymbolKeepsItsCode() = runTest {
        val http = FakeHttp(listOf("klines" to HttpResponse(400, Fixtures.text("binance/spot_error_invalid_symbol.json"), emptyMap())))
        val e = assertFailsWith<ExchangeException> { BinanceAdapter(http).candles(inst(), com.smartmoney.engine.model.Timeframe.M5, 10) }
        assertEquals("-1121", e.exchangeCode)
        assertEquals(400, e.httpCode)
    }

    @Test
    fun binance429PausesWithRetryAfter() = runTest {
        var t = 1_000_000L
        val limiter = RateLimiter(0, now = { t })
        val http = FakeHttp(listOf("ticker" to HttpResponse(429, """{"code":-1003,"msg":"Too many requests"}""", mapOf("Retry-After" to "7"))))
        val e = assertFailsWith<RateLimitedException> { BinanceAdapter(http, spotLimiter = limiter).tickers(Market.SPOT) }
        assertEquals(7_000L, e.retryAfterMs)
        assertEquals(t + 7_000L, limiter.pausedUntilMillis)
    }

    @Test
    fun binanceBlockedRegion() = runTest {
        val http = FakeHttp(listOf("exchangeInfo" to HttpResponse(451, """{"code":0,"msg":"Service unavailable from a restricted location"}""", emptyMap())))
        val e = assertFailsWith<ExchangeException> { BinanceAdapter(http).instruments(Market.SPOT) }
        assertEquals(451, e.httpCode)
    }

    @Test
    fun bybitErrorIsHttp200WithRetCode() = runTest {
        val http = FakeHttp(listOf("kline" to FakeHttp.ok(Fixtures.text("bybit/error_invalid_symbol.json"))))
        val e = assertFailsWith<ExchangeException> { BybitAdapter(http).candles(inst(), com.smartmoney.engine.model.Timeframe.M5, 10) }
        assertEquals("10001", e.exchangeCode)
    }

    @Test
    fun bybit403MeansWaitTenMinutes() = runTest {
        val http = FakeHttp(listOf("tickers" to HttpResponse(403, "access too frequent", emptyMap())))
        val e = assertFailsWith<RateLimitedException> { BybitAdapter(http).tickers(Market.SPOT) }
        assertEquals(10 * 60_000L, e.retryAfterMs)
    }

    @Test
    fun bybitRateLimitRetCode() = runTest {
        val http = FakeHttp(listOf("tickers" to FakeHttp.ok("""{"retCode":10006,"retMsg":"Too many visits!","result":{},"time":1}""")))
        assertFailsWith<RateLimitedException> { BybitAdapter(http).tickers(Market.SPOT) }
    }

    @Test
    fun okxInvalidInstrumentAndRateLimit() = runTest {
        val bad = FakeHttp(listOf("candles" to FakeHttp.ok(Fixtures.text("okx/error_invalid_inst.json"))))
        val e = assertFailsWith<ExchangeException> { OkxAdapter(bad).candles(inst(), com.smartmoney.engine.model.Timeframe.M5, 10) }
        assertEquals("51001", e.exchangeCode)
        val limited = FakeHttp(listOf("tickers" to HttpResponse(429, """{"code":"50011","msg":"Too Many Requests","data":[]}""", emptyMap())))
        assertFailsWith<RateLimitedException> { OkxAdapter(limited).tickers(Market.SPOT) }
    }

    @Test
    fun unreadableBodyIsAnError() = runTest {
        val http = FakeHttp(listOf("instruments" to HttpResponse(502, "<html>Bad gateway</html>", emptyMap())))
        val e = assertFailsWith<ExchangeException> { OkxAdapter(http).instruments(Market.SPOT) }
        assertTrue(e.message!!.contains("unreadable"))
    }

    @Test
    fun okxPerpTickersSurviveAFailingExtraEndpoint() = runTest {
        // Mark price fails; tickers still come back, with mark price null (n/a), never 0.
        val http = FakeHttp(
            listOf(
                "market/tickers" to FakeHttp.ok(Fixtures.text("okx/swap_tickers.json")),
                "mark-price" to HttpResponse(500, """{"code":"50001","msg":"Service temporarily unavailable","data":[]}""", emptyMap()),
                "funding-rate" to FakeHttp.ok(Fixtures.text("okx/swap_funding_rate_ANY.json")),
                "open-interest" to FakeHttp.ok(Fixtures.text("okx/swap_open_interest.json")),
            ),
        )
        val t = OkxAdapter(http).tickers(Market.PERP).first { it.nativeSymbol == "BTC-USDT-SWAP" }
        assertEquals(null, t.markPrice)
        assertEquals(0.0001, t.fundingRate)
    }

    private fun inst() = com.smartmoney.engine.model.Instrument(
        com.smartmoney.engine.model.Exchange.BINANCE, Market.SPOT, "NOPEUSDT", "NOPE", "USDT", true,
    )
}

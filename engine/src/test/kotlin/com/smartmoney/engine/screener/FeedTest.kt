package com.smartmoney.engine.screener

import com.smartmoney.engine.exchange.ExchangeAdapter
import com.smartmoney.engine.model.BookLevel
import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.FeedId
import com.smartmoney.engine.model.Instrument
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.OpenInterestPoint
import com.smartmoney.engine.model.OrderBook
import com.smartmoney.engine.model.Ticker
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.net.ExchangeException
import com.smartmoney.engine.stream.FakeTransport
import com.smartmoney.engine.stream.StreamProtocol
import com.smartmoney.engine.stream.TestProtocol
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import java.io.IOException
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** SYNTHETIC DATA (unit test only): a scripted exchange that serves flat candles up to "now". */
open class FakeAdapter(private val now: () -> Long) : ExchangeAdapter {
    override val exchange = Exchange.BINANCE
    override val maxCandlesPerRequest = 1000
    val candleCalls = ArrayList<Pair<String, Int>>()

    override suspend fun instruments(market: Market) = listOf(
        Instrument(exchange, market, "BTCUSDT", "BTC", "USDT", true),
        Instrument(exchange, market, "ETHUSDT", "ETH", "USDT", true),
        Instrument(exchange, market, "USDCUSDT", "USDC", "USDT", true),
        Instrument(exchange, market, "DEADUSDT", "DEAD", "USDT", false),
    )

    override suspend fun tickers(market: Market) = listOf(
        Ticker("BTCUSDT", 100.0, 99.99, 100.01, 9e9, 0.01, time = now()),
        Ticker("ETHUSDT", 10.0, 9.999, 10.001, 5e9, 0.02, time = now()),
        Ticker("USDCUSDT", 1.0001, 1.0, 1.0002, 2e10, 0.0001, time = now()),
        Ticker("DEADUSDT", 3.0, null, null, 1e11, 0.0, time = now()),
    )

    override suspend fun candles(instrument: Instrument, timeframe: Timeframe, limit: Int, endTime: Long?): List<Candle> {
        candleCalls += instrument.nativeSymbol to limit
        val t = now()
        val current = timeframe.floor(t)
        return (limit - 1 downTo 0).map { k ->
            val open = current - k * timeframe.millis
            Candle(open, 1.0, 1.01, 0.99, 1.0, 1.0, 1.0, closed = open + timeframe.millis <= t)
        }
    }

    override suspend fun openInterestHistory(instrument: Instrument, limit: Int) = emptyList<OpenInterestPoint>()
    override suspend fun orderBook(instrument: Instrument) = OrderBook(listOf(BookLevel(0.99, 1e6)), listOf(BookLevel(1.01, 1e6)), now())
    override fun streamProtocol(market: Market): StreamProtocol = TestProtocol
}

@OptIn(ExperimentalCoroutinesApi::class)
class FeedTest {
    private val base = 1_794_000_000_000L // a whole 5-minute boundary

    @Test
    fun picksTheUniverseAndBackfillsTheGapAfterAnOutage() = runTest {
        val now = { base + testScheduler.currentTime }
        val transport = FakeTransport(now).apply { autoOpen = true }
        val adapter = FakeAdapter(now)
        val gaps = ArrayList<GapRecord>()
        val feed = Feed(
            FeedId(Exchange.BINANCE, Market.SPOT), adapter, transport, backgroundScope, now,
            EngineConfig(timeframe = Timeframe.M1, universeSize = 10), onGap = { gaps += it }, random = Random(3),
        )
        feed.start()
        runCurrent()

        assertEquals(setOf("BTCUSDT", "ETHUSDT"), feed.data().universe.map { it.nativeSymbol }.toSet(), "stablecoin and halted market left out")
        assertEquals(2, adapter.candleCalls.count { it.second == Feed.INITIAL_CANDLES })
        assertEquals(1, transport.conns.size)

        advanceTimeBy(20_000)
        transport.conns[0].listener.onMessage("c|BTCUSDT|$base|1.0|0")
        runCurrent()
        val lastMessageAt = now()

        // The exchange is unreachable for 10 minutes.
        transport.refuse = true
        transport.conns[0].listener.onFailure(IOException("network lost"))
        runCurrent()
        advanceTimeBy(10 * 60_000L)
        transport.refuse = false
        advanceTimeBy(75_000) // the next retry (delays are capped at 60 s +- 20%)
        runCurrent()

        assertEquals(1, gaps.size)
        assertEquals(lastMessageAt, gaps[0].from)
        assertTrue(gaps[0].to - gaps[0].from >= 10 * 60_000L)
        assertEquals("network lost", gaps[0].reason)
        val gapLimit = adapter.candleCalls.last().second
        assertTrue(gapLimit >= 13, "asked for at least the 10+ missed candles, got $gapLimit")
        val candles = feed.data().series.getValue("BTCUSDT").candles
        assertTrue(candles.zipWithNext().all { (a, b) -> b.openTime - a.openTime == 60_000L }, "no hole left after the backfill")
        assertEquals(Timeframe.M1.floor(gaps[0].to), candles.last().openTime, "filled up to the reconnect")
        assertTrue(candles.first { it.openTime == base }.closed, "the REST backfill closed the candle the stream left open")
    }

    @Test
    fun blockedExchangeShowsOfflineWithTheReason() = runTest {
        val now = { base + testScheduler.currentTime }
        val adapter = object : FakeAdapter(now) {
            override suspend fun instruments(market: Market): List<Instrument> =
                throw ExchangeException("Binance is not available in this location", 451)
        }
        val feed = Feed(FeedId(Exchange.BINANCE, Market.SPOT), adapter, FakeTransport(now), backgroundScope, now, EngineConfig(), onGap = {})
        feed.start()
        advanceTimeBy(1_500)
        val s = feed.status.value
        assertEquals(FeedPhase.OFFLINE, s.phase)
        assertTrue(s.message!!.contains("blocked"), s.message)
    }
}

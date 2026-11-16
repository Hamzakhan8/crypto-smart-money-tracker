package com.smartmoney.engine.exchange

import com.smartmoney.engine.Fixtures
import com.smartmoney.engine.exchange.BybitAdapter.Parse
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Timeframe
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Bybit V5 spot and linear, on responses recorded 2026-11-12. */
class BybitRecordedTest {

    @Test
    fun spotInstrumentsLeaveOutTokenizedStocks() {
        val list = Parse.instruments(Fixtures.json("bybit/spot_instruments.json"), Market.SPOT)
        assertEquals(listOf("BTCUSDT", "ETHUSDT", "SOLUSDT"), list.map { it.nativeSymbol }, "AAPLXUSDT (xstocks) left out")
        assertTrue(list.all { it.trading })
    }

    @Test
    fun linearInstrumentsAreUsdtCryptoPerpetuals() {
        val list = Parse.instruments(Fixtures.json("bybit/linear_instruments.json"), Market.PERP)
        // Left out: BTCPERP (USDC), BTCUSDT-25DEC26 (dated future), NVDAUSDT (stock).
        assertEquals(setOf("1000PEPEUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT"), list.map { it.nativeSymbol }.toSet())
        val pepe = list.first { it.nativeSymbol == "1000PEPEUSDT" }
        assertEquals("PEPE/USDT", pepe.canonical)
        assertEquals(1000.0, pepe.priceMultiplier)
    }

    @Test
    fun closedInstrumentsAreNotTrading() {
        val list = Parse.instruments(Fixtures.json("bybit/linear_instruments_status_Closed.json"), Market.PERP)
        assertTrue(list.isNotEmpty())
        assertTrue(list.none { it.trading })
    }

    @Test
    fun restKlinesNewestFirstAreSortedAndClosedByServerTime() {
        val c = Parse.candles(Fixtures.json("bybit/linear_kline_BTCUSDT_5.json"), Timeframe.M5)
        assertEquals(100, c.size)
        assertEquals(1794434400000L, c.first().openTime)
        assertEquals(1794464100000L, c.last().openTime)
        assertTrue(c.zipWithNext().all { (a, b) -> b.openTime - a.openTime == 300_000L })
        // Server time 1794464351091 is inside the last period (ends 1794464400000): still open, no flag from Bybit.
        assertFalse(c.last().closed)
        assertTrue(c.dropLast(1).all { it.closed })
        assertEquals(73642.3, c.last().close)
        assertTrue(c.all { it.trades == null && it.takerBuyQuote == null }, "Bybit klines have no trade count or taker split: null")
    }

    @Test
    fun linearTickersUseOneSidedOpenInterest() {
        val t = Parse.tickers(Fixtures.json("bybit/linear_tickers.json")).first { it.nativeSymbol == "BTCUSDT" }
        assertEquals(34320.906, t.openInterest)
        assertEquals(0.00006697, t.fundingRate)
        assertEquals(1794470400000L, t.nextFundingTime)
        assertEquals(73642.34, t.markPrice)
        assertEquals(3813044157.6612, t.quoteVolume24h!!, 1e-4)
        assertEquals(-0.002466, t.change24hPct!!, 1e-12)
        val spot = Parse.tickers(Fixtures.json("bybit/spot_tickers.json"))
        assertTrue(spot.all { it.markPrice == null && it.fundingRate == null && it.openInterest == null })
    }

    @Test
    fun spotStreamReplay() {
        val r = Fixtures.replay("bybit/spot_ws_kline_1.jsonl", BybitAdapter.Stream(Market.SPOT)::parse)
        assertEquals(0, r.malformed)
        assertEquals(46, r.events.size)
        assertEquals(3, r.pongs)
        assertEquals(1, r.acks)
        val btc = r.series().getValue("BTCUSDT").candles.first { it.openTime == 1794464400000L }
        assertTrue(btc.closed)
        assertEquals(73687.2, btc.close)
        assertEquals(108000.8957766, btc.quoteVolume!!, 1e-6)
    }

    @Test
    fun linearStreamCarriesClosedAndNewCandleInOneMessage() {
        val r = Fixtures.replay("bybit/linear_ws_kline_1.jsonl", BybitAdapter.Stream(Market.PERP)::parse)
        assertEquals(0, r.malformed)
        assertEquals(3, r.pongs)
        assertTrue(r.candles.any { it.candles.size == 2 && it.candles[0].closed && !it.candles[1].closed })
        val btc = r.series().getValue("BTCUSDT").candles
        val closed = btc.first { it.openTime == 1794464400000L }
        assertTrue(closed.closed)
        assertEquals(73655.2, closed.close)
        assertTrue(btc.any { it.openTime == 1794464460000L && !it.closed }, "the next candle started")
    }

    @Test
    fun failedSubscriptionsAreErrors() {
        for (f in listOf("bybit/ws_subscribe_error.jsonl", "bybit/ws_subscribe_error_spot.jsonl", "bybit/ws_subscribe_error_spot_args_over_10.jsonl")) {
            val r = Fixtures.replay(f, BybitAdapter.Stream(Market.SPOT)::parse)
            assertEquals(0, r.malformed, f)
            assertTrue(r.errors.isNotEmpty(), f)
        }
    }

    @Test
    fun spotSubscribeRequestsStayWithinTenArgs() {
        val syms = (1..23).map { "C${it}USDT" }
        val msgs = BybitAdapter.Stream(Market.SPOT).subscribeMessages(syms, Timeframe.M5)
        assertEquals(3, msgs.size)
        assertTrue(msgs.first().contains("\"kline.5.C1USDT\""))
    }

    @Test
    fun openInterestHistoryOldestFirst() {
        val pts = Parse.openInterest(Fixtures.json("bybit/linear_open_interest_BTCUSDT_5min.json"))
        assertEquals(100, pts.size)
        assertTrue(pts.zipWithNext().all { (a, b) -> a.time < b.time })
        assertEquals(34299.183, pts.last().openInterest, "single-side open interest")
    }

    @Test
    fun orderBookParses() {
        val b = Parse.orderBook(Fixtures.json("bybit/spot_orderbook_BTCUSDT.json"))
        assertEquals(50, b.asks.size)
        assertEquals(73683.4, b.asks.first().price)
        assertTrue(b.bids.isNotEmpty())
    }
}

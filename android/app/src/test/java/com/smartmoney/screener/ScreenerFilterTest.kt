package com.smartmoney.screener

import com.smartmoney.engine.features.CandleSeries
import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.Instrument
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.Ticker
import com.smartmoney.engine.model.Timeframe
import com.smartmoney.engine.screener.EngineConfig
import com.smartmoney.engine.screener.RowBuilder
import com.smartmoney.engine.screener.ScreenerRow
import com.smartmoney.engine.screener.Tier
import com.smartmoney.screener.ui.screener.ScreenerFilter
import com.smartmoney.screener.ui.screener.SortBy
import com.smartmoney.screener.ui.screener.TierFilter
import com.smartmoney.screener.ui.screener.TypeFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** SYNTHETIC DATA (unit test only): screen filters and sorting on hand-built rows. */
class ScreenerFilterTest {
    private val tf = Timeframe.M5
    private val period = 1_794_000_000_000L
    private val now = period + 10_000
    private val cfg = EngineConfig(timeframe = tf)

    private fun row(base: String, move: Double, ex: Exchange = Exchange.BINANCE, market: Market = Market.SPOT, vol24h: Double = 50e6): ScreenerRow {
        val first = period - 60 * tf.millis
        val list = (0 until 59).map { Candle(first + it * tf.millis, 100.0, 100.5, 99.5, 100.0, 10.0, 1_000.0, closed = true) }
        val c = 100.0 * (1 + move)
        val last = Candle(period - tf.millis, 100.0, maxOf(c, 100.0) * 1.001, minOf(c, 100.0) * 0.999, c, 30.0, 3_000.0, closed = true)
        val inst = Instrument(ex, market, "${base}USDT", base, "USDT", true)
        return RowBuilder.build(inst, CandleSeries().merge(list + last), null, Ticker("${base}USDT", c, c * 0.9999, c * 1.0001, vol24h, 0.0, time = now), null, null, cfg, now)
    }

    private val rows = listOf(
        row("AAA", 0.05),
        row("BBB", -0.03),
        row("CCC", 0.001),
        row("DDD", 0.02, ex = Exchange.OKX, vol24h = 2e6),
        row("EEE", 0.04, market = Market.PERP),
    )

    @Test
    fun spotTabSortedByBiggestMoveFirst() {
        val out = ScreenerFilter().apply(rows)
        assertEquals(listOf("AAA", "BBB", "DDD", "CCC"), out.map { it.instrument.base })
    }

    @Test
    fun movingOnlyAndDirection() {
        val moving = ScreenerFilter(tier = TierFilter.MOVING).apply(rows)
        assertTrue(moving.none { it.tier == Tier.NONE })
        assertEquals(listOf("AAA", "BBB", "DDD"), moving.map { it.instrument.base })
        assertEquals(listOf("BBB"), ScreenerFilter(type = TypeFilter.DUMP).apply(rows).map { it.instrument.base })
    }

    @Test
    fun exchangeVolumeSearchAndMarket() {
        assertEquals(listOf("DDD"), ScreenerFilter(exchanges = setOf(Exchange.OKX)).apply(rows).map { it.instrument.base })
        assertEquals(listOf("AAA", "BBB", "CCC"), ScreenerFilter(minVolume24h = 5e6).apply(rows).map { it.instrument.base })
        assertEquals(listOf("BBB"), ScreenerFilter(query = "bb").apply(rows).map { it.instrument.base })
        assertEquals(listOf("EEE"), ScreenerFilter(market = Market.PERP).apply(rows).map { it.instrument.base })
    }

    @Test
    fun signalsOnlyKeepsConfirmedRowsWithAnAction() {
        fun confirmed(base: String, move: Double, market: Market): ScreenerRow {
            val r = row(base, move, market = market)
            val c = r.price!!
            val book = com.smartmoney.engine.features.Liquidity.analyze(
                com.smartmoney.engine.model.OrderBook(
                    listOf(com.smartmoney.engine.model.BookLevel(c * 0.9999, 1e6)),
                    listOf(com.smartmoney.engine.model.BookLevel(c * 1.0001, 1e6)), now,
                ),
                cfg.tradeSizes,
            )
            val first = period - 60 * tf.millis
            val list = (0 until 59).map { Candle(first + it * tf.millis, 100.0, 100.5, 99.5, 100.0, 10.0, 1_000.0, closed = true) }
            val last = Candle(period - tf.millis, 100.0, maxOf(c, 100.0) * 1.001, minOf(c, 100.0) * 0.999, c, 30.0, 3_000.0, closed = true)
            // v0.3: trend and BTC agree with the move, so at least 4 checks are known and all known ones pass.
            val sign = if (move > 0) 1 else -1
            return RowBuilder.build(
                r.instrument, CandleSeries().merge(list + last), null, r.ticker, null, book, cfg, now,
                htf = (c - sign * 5) to (c - sign * 5), btcMove15 = sign * 0.001,
            )
        }
        val rows = listOf(
            confirmed("LNG", 0.05, Market.PERP), confirmed("SHT", -0.05, Market.PERP),
            confirmed("BUY", 0.05, Market.SPOT), confirmed("DWN", -0.05, Market.SPOT),
        )
        assertEquals(listOf("LONG", "SHORT"), ScreenerFilter(market = Market.PERP, tier = TierFilter.SIGNALS).apply(rows).map { it.label?.text })
        val spot = ScreenerFilter(market = Market.SPOT, tier = TierFilter.SIGNALS).apply(rows)
        assertEquals("a falling spot coin is not a signal", listOf("BUY"), spot.map { it.label?.text })
    }

    @Test
    fun minMoveInAtrs() {
        val out = ScreenerFilter(minZ = 3.0, sort = SortBy.VOLUME).apply(rows)
        assertEquals(listOf("AAA", "BBB"), out.map { it.instrument.base })
    }
}

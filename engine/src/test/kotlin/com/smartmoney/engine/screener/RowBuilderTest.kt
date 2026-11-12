package com.smartmoney.engine.screener

import com.smartmoney.engine.features.CandleSeries
import com.smartmoney.engine.features.Liquidity
import com.smartmoney.engine.model.BookLevel
import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Exchange
import com.smartmoney.engine.model.Instrument
import com.smartmoney.engine.model.Market
import com.smartmoney.engine.model.OpenInterestPoint
import com.smartmoney.engine.model.OrderBook
import com.smartmoney.engine.model.Ticker
import com.smartmoney.engine.model.Timeframe
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** SYNTHETIC DATA (unit test only): tier, gate, label and cross-exchange rules on hand-built candles. */
class RowBuilderTest {
    private val tf = Timeframe.M5
    private val period = 1_794_000_000_000L // start of the current 5-minute period
    private val now = period + 10_000
    private val cfg = EngineConfig(timeframe = tf)

    /** 60 calm candles (1% range) up to the previous period; the last one moves [lastMove]. */
    private fun series(lastMove: Double, live: Candle? = null): CandleSeries {
        val n = 60
        val first = period - n * tf.millis
        val list = ArrayList<Candle>()
        for (i in 0 until n - 1) list += Candle(first + i * tf.millis, 100.0, 100.5, 99.5, 100.0, 10.0, 1_000.0, closed = true)
        val c = 100.0 * (1 + lastMove)
        list += Candle(period - tf.millis, 100.0, maxOf(c, 100.0) * 1.001, minOf(c, 100.0) * 0.999, c, 40.0, 4_000.0, closed = true)
        if (live != null) list += live
        return CandleSeries().merge(list)
    }

    private fun inst(ex: Exchange = Exchange.BINANCE, market: Market = Market.SPOT, native: String = "XUSDT", mult: Double = 1.0) =
        Instrument(ex, market, native, "X", "USDT", true, priceMultiplier = mult)

    private fun ticker(last: Double, native: String = "XUSDT") = Ticker(native, last, last * 0.9999, last * 1.0001, 50e6, 0.03, time = now)

    private fun deepBook(mid: Double) = Liquidity.analyze(
        OrderBook(listOf(BookLevel(mid * 0.9999, 1e6)), listOf(BookLevel(mid * 1.0001, 1e6)), now),
        cfg.tradeSizes,
    )

    @Test
    fun closedBigMoveWithAllGatesIsConfirmed() {
        val row = RowBuilder.build(inst(), series(0.03), null, ticker(103.0), null, deepBook(103.0), cfg, now)
        assertEquals(Tier.CONFIRMED, row.tier, row.gates.toString())
        assertEquals(SignalLabel.BUY, row.label, "spot up move = BUY")
        assertEquals(Direction.UP, row.direction)
        assertEquals(100.0 * 0.999, row.invalidation!!, 1e-9, "invalidation = low of the signal candle")
        val plan = row.plan!!
        assertEquals(103.0, plan.entry)
        assertEquals(103.0 + 0.01 * 103.0, plan.target, 1e-9, "target 1 ATR above the entry")
        assertEquals(103.0 - 0.01 * 103.0, plan.stop, 1e-9, "stop 1 ATR below")
        assertEquals(30, plan.horizonMinutes)
        assertTrue(row.gates.all { it.passed == true })
        assertTrue(row.reason.startsWith("5m candle closed +3.00%"), row.reason)
        assertTrue(row.unproven)
    }

    @Test
    fun withoutAnOrderBookCheckItIsRejectedNotConfirmed() {
        val row = RowBuilder.build(inst(), series(0.03), null, ticker(103.0), null, null, cfg, now)
        assertEquals(Tier.REJECTED, row.tier)
        assertNull(row.gates.first { it.name == "Depth" }.passed)
        assertTrue(row.mainRisk.startsWith("Rejected: "))
    }

    @Test
    fun perpsGoLongOrShortSpotOnlyBuys() {
        val perp = inst(market = Market.PERP)
        val up = RowBuilder.build(perp, series(0.03), null, ticker(103.0), null, deepBook(103.0), cfg, now)
        assertEquals(SignalLabel.LONG, up.label)
        val down = RowBuilder.build(perp, series(-0.03), null, ticker(97.0), null, deepBook(97.0), cfg, now)
        assertEquals(Tier.CONFIRMED, down.tier)
        assertEquals(SignalLabel.SHORT, down.label)
        assertEquals(100.0 * 1.001, down.invalidation!!, 1e-9, "invalidation = high of the signal candle")
        assertTrue(down.plan!!.target < down.plan!!.entry && down.plan!!.stop > down.plan!!.entry, "a short's target is below")
        val noShorts = RowBuilder.build(perp, series(-0.03), null, ticker(97.0), null, deepBook(97.0), cfg.copy(canShort = false), now)
        assertNull(noShorts.label)
        assertNull(noShorts.plan)
        val spotDown = RowBuilder.build(inst(), series(-0.03), null, ticker(97.0), null, deepBook(97.0), cfg, now)
        assertEquals(Tier.CONFIRMED, spotDown.tier, "still a confirmed move, shown without an action")
        assertNull(spotDown.label, "spot never shorts")
        assertNull(spotDown.plan)
    }

    @Test
    fun aCandleInProgressIsOnlyWatch() {
        val live = Candle(period, 100.0, 103.2, 99.9, 103.0, 30.0, 3_000.0, closed = false)
        val row = RowBuilder.build(inst(), series(0.0, live), null, ticker(103.0), null, deepBook(103.0), cfg, now)
        assertEquals(Tier.WATCH, row.tier)
        assertTrue(row.reason.contains("in progress"), row.reason)
    }

    @Test
    fun anOldClosedCandleDoesNotCount() {
        val later = now + tf.millis // the signal candle is now two periods old and its successor is missing
        val row = RowBuilder.build(inst(), series(0.03), null, ticker(103.0), null, deepBook(103.0), cfg, later)
        assertEquals(Tier.NONE, row.tier)
        assertNull(row.closed)
    }

    @Test
    fun perpCauseFromOpenInterest() {
        val oi = (0..12).map { OpenInterestPoint(period - 60 * 60_000L + it * 5 * 60_000L, 1_000.0 + if (it == 12) 30.0 else 0.0) }
        val p = inst(market = Market.PERP)
        val t = ticker(103.0).copy(markPrice = 103.0, fundingRate = 0.0001)
        val row = RowBuilder.build(p, series(0.03), null, t, oi, deepBook(103.0), cfg, now)
        assertEquals(Cause.NEW_LONGS, row.perp!!.cause)
        assertEquals(0.03, row.perp!!.oiChange!!, 1e-12)
        assertTrue(row.reason.contains("open interest +3.00%"), row.reason)
    }

    @Test
    fun crossExchangeConfirmationIsolationAndPriceScale() {
        val a = RowBuilder.build(inst(Exchange.BINANCE), series(0.03), null, ticker(103.0), null, deepBook(103.0), cfg, now)
        val b = RowBuilder.build(inst(Exchange.BYBIT), series(0.03), null, ticker(103.0), null, deepBook(103.0), cfg, now)
        val both = RowBuilder.applyCross(listOf(a, b))
        assertTrue(both.all { it.cross.confirmations == 2 && !it.cross.isolated })

        val quiet = RowBuilder.build(inst(Exchange.OKX), series(0.0), null, ticker(103.0), null, deepBook(103.0), cfg, now)
        val alone = RowBuilder.applyCross(listOf(a, quiet)).first { it.instrument.exchange == Exchange.BINANCE }
        assertTrue(alone.cross.isolated)
        assertTrue(alone.flags.any { it.code == "ISOLATED" })

        // A 1000X contract priced 1000x higher is the same per-coin price: no mismatch.
        val scaled = RowBuilder.build(inst(Exchange.BYBIT, native = "1000XUSDT", mult = 1000.0), series(0.03), null, ticker(103_000.0, "1000XUSDT"), null, null, cfg, now)
        val checked = RowBuilder.applyCross(listOf(a, scaled))
        assertTrue(checked.none { r -> r.flags.any { it.code == "PRICE_MISMATCH" } })
        val off = RowBuilder.build(inst(Exchange.OKX), series(0.03), null, ticker(106.0), null, null, cfg, now)
        assertTrue(RowBuilder.applyCross(listOf(a, off)).first { it.instrument.exchange == Exchange.OKX }.flags.any { it.code == "PRICE_MISMATCH" })
    }

    @Test
    fun configHashChangesWithSettings() {
        assertEquals(EngineConfig().hash, EngineConfig().hash)
        assertTrue(EngineConfig().hash != EngineConfig(moveThresholdZ = 2.5).hash)
        assertEquals(12, EngineConfig().hash.length)
    }
}

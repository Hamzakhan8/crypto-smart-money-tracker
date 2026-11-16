package com.smartmoney.engine.features

import com.smartmoney.engine.model.Candle
import com.smartmoney.engine.model.Timeframe
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** SYNTHETIC DATA (unit test only): hand-built candles with known answers. Never used for any result. */
class FeaturesTest {
    private val tf = Timeframe.M5
    private val t0 = 1_794_000_000_000L - Math.floorMod(1_794_000_000_000L, tf.millis)

    private fun flat(n: Int, price: Double = 100.0, vol: Double = 1000.0, start: Long = t0) = (0 until n).map { i ->
        Candle(start + i * tf.millis, price, price * 1.001, price * 0.999, price, vol / price, vol, closed = true)
    }

    private fun bigUp(prev: List<Candle>, close: Double, vol: Double) = prev.last().let { p ->
        Candle(p.openTime + tf.millis, p.close, close * 1.0005, p.close * 0.9995, close, vol / close, vol, closed = true)
    }

    @Test
    fun moveAtrAndRelativeVolume() {
        val base = flat(100)
        val all = base + bigUp(base, 102.0, 5000.0)
        val f = Features.compute(all, all.size - 1, tf, btc = null)!!
        assertEquals(0.02, f.move!!, 1e-12)
        assertEquals(0.002, f.atrPct!!, 1e-12) // true range 0.2 on a 100 price
        assertEquals(10.0, f.zMove!!, 1e-9)
        assertEquals(5.0, f.relVolume!!, 1e-12)
        assertEquals(Breakout.UP, f.breakout)
        assertTrue(f.dataIssues.isEmpty(), f.dataIssues.toString())
        assertNull(f.residual, "no BTC series given")
    }

    @Test
    fun residualRemovesBtcPart() {
        // Coin returns are exactly 2x BTC's, so beta = 2. On the signal candle BTC +0.5%, coin +3%: residual = +2%.
        val n = 60
        val btc = ArrayList<Candle>()
        val coin = ArrayList<Candle>()
        var bp = 50_000.0
        var cp = 10.0
        for (i in 0 until n) {
            val r = if (i % 2 == 0) 0.001 else -0.0008
            if (i > 0) {
                bp *= 1 + r
                cp *= 1 + 2 * r
            }
            btc += Candle(t0 + i * tf.millis, bp, bp * 1.001, bp * 0.999, bp, 1.0, 1000.0, closed = true)
            coin += Candle(t0 + i * tf.millis, cp, cp * 1.001, cp * 0.999, cp, 1.0, 1000.0, closed = true)
        }
        val tLast = t0 + n * tf.millis
        btc += Candle(tLast, bp, bp * 1.006, bp, bp * 1.005, 1.0, 1000.0, closed = true)
        coin += Candle(tLast, cp, cp * 1.031, cp, cp * 1.03, 1.0, 1000.0, closed = true)
        val f = Features.compute(coin, coin.size - 1, tf, btc.associateBy { it.openTime })!!
        assertEquals(2.0, f.beta!!, 1e-6)
        assertEquals(0.02, f.residual!!, 1e-6)
    }

    @Test
    fun noLookAhead() {
        val base = flat(80)
        val all = base + bigUp(base, 101.0, 3000.0)
        val before = Features.compute(all, all.size - 1, tf, null)
        val later = all + flat(30, price = 150.0, vol = 99_999.0, start = all.last().openTime + tf.millis)
        val after = Features.compute(later, all.size - 1, tf, null)
        assertEquals(before, after, "adding later candles must not change a past candle's features")
    }

    @Test
    fun notEnoughHistoryIsNullNotZero() {
        val few = flat(10)
        val f = Features.compute(few, few.size - 1, tf, null)!!
        assertNull(f.atrPct)
        assertNull(f.zMove)
        assertNull(f.relVolume)
        assertNull(f.breakout)
    }

    @Test
    fun dataProblemsAreReported() {
        val base = flat(60)
        val gap = base.filterIndexed { i, _ -> i != 40 }
        assertTrue(Features.compute(gap, gap.size - 1, tf, null)!!.dataIssues.any { it.startsWith("gap: 1 missing") })

        val shifted = base.toMutableList().also { it[50] = it[50].copy(openTime = it[50].openTime + 7) }
        assertTrue(Features.compute(shifted, shifted.size - 1, tf, null)!!.dataIssues.contains("bad timestamp"))

        val invalid = base.toMutableList().also { it[55] = it[55].copy(high = it[55].close * 0.5) }
        assertTrue(Features.compute(invalid, invalid.size - 1, tf, null)!!.dataIssues.contains("invalid candle"))

        val spike = base.toMutableList().also { val c = it.last(); it[it.size - 1] = c.copy(high = c.close * 1.5) }
        assertTrue(Features.compute(spike, spike.size - 1, tf, null)!!.dataIssues.any { it.startsWith("spike wick") })
    }

    @Test
    fun takerImbalanceOnlyWhenGiven() {
        val base = flat(30)
        val c = base.last().copy(takerBuyQuote = 750.0)
        val all = base.dropLast(1) + c
        assertEquals(0.5, Features.compute(all, all.size - 1, tf, null)!!.takerImbalance!!, 1e-12) // 75% buys
        assertNull(Features.compute(base, base.size - 1, tf, null)!!.takerImbalance)
    }

    @Test
    fun seriesNeverReopensAClosedCandle() {
        val c = Candle(t0, 1.0, 2.0, 0.5, 1.5, 1.0, 1.0, closed = true)
        val s = CandleSeries().merge(c).merge(c.copy(close = 9.0, closed = false))
        assertEquals(1.5, s.last!!.close)
        assertTrue(s.last!!.closed)
        val s2 = s.merge(c.copy(openTime = t0 + tf.millis, closed = false)).merge(c.copy(openTime = t0 + tf.millis, close = 1.7, closed = true))
        assertEquals(2, s2.size)
        assertEquals(1.7, s2.lastClosed!!.close)
    }
}
